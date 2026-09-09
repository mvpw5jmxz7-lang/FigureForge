/**
 * Chunked project I/O against a real filesystem.
 *
 * The behaviour worth pinning is what happens when a write does *not* finish.
 * Streaming makes that a live concern rather than a theoretical one: bytes now
 * reach the disk long before the archive is complete, so a crash part-way
 * through would leave a truncated file that still ends in `.ffg` and still
 * looks like a project — and opens with an image missing. Writing to a temp
 * file and renaming on success is what makes the target either the previous
 * save or the complete new one, never half of either.
 *
 * `projects.node.ts` imports Electron for its dialogs, which does not exist
 * outside the shell; only `dialog` is used and no test here touches it, so it
 * is stubbed rather than the whole module being restructured to avoid it.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() } }));

const { ProjectFiles } = await import('./projects.node.js');
/** The stubbed dialogs, hoisted: `await import` is legal only at module top. */
const { dialog } = (await import('electron')) as unknown as {
  dialog: { showSaveDialog: ReturnType<typeof vi.fn>; showOpenDialog: ReturnType<typeof vi.fn> };
};

let directory: string;
let files: InstanceType<typeof ProjectFiles>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'figureforge-projects-'));
  files = new ProjectFiles();
});

afterEach(async () => {
  await files.closeAll();
  await rm(directory, { recursive: true, force: true });
});

const target = (name = 'figure.ffg'): string => join(directory, name);

/** Write bytes through the chunked API, as the renderer does. */
async function writeThrough(path: string, chunks: Uint8Array[]): Promise<'written' | 'denied'> {
  const id = await files.beginWrite(path);
  if (id === 'denied') return 'denied';
  for (const chunk of chunks) await files.writeChunk(id, chunk);
  return files.finishWrite(id);
}

async function readThrough(path: string): Promise<Uint8Array> {
  const { id } = await files.beginRead(path);
  const parts: Uint8Array[] = [];
  for (;;) {
    const chunk = await files.readChunk(id);
    if (chunk === null) break;
    parts.push(chunk);
  }
  await files.endRead(id);

  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('writing', () => {
  it('lands the bytes at the target once finished', async () => {
    const path = files.grant(target());
    const result = await writeThrough(path, [new Uint8Array([1, 2]), new Uint8Array([3])]);

    expect(result).toBe('written');
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('leaves nothing at the target until it is finished', async () => {
    const path = files.grant(target());
    const id = await files.beginWrite(path);
    if (id === 'denied') throw new Error('unexpectedly denied');
    await files.writeChunk(id, new Uint8Array([1, 2, 3]));

    // A reader arriving mid-save must not find a half-written project.
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    await files.finishWrite(id);
    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('an aborted write leaves the previous save untouched', async () => {
    const path = files.grant(target());
    await writeFile(path, new Uint8Array([9, 9, 9]));

    const id = await files.beginWrite(path);
    if (id === 'denied') throw new Error('unexpectedly denied');
    await files.writeChunk(id, new Uint8Array([1]));
    await files.abortWrite(id);

    expect(new Uint8Array(await readFile(path))).toEqual(new Uint8Array([9, 9, 9]));
  });

  it('an aborted write leaves no temp file behind', async () => {
    const path = files.grant(target());
    const id = await files.beginWrite(path);
    if (id === 'denied') throw new Error('unexpectedly denied');
    await files.writeChunk(id, new Uint8Array([1]));
    await files.abortWrite(id);

    // A stray `.part` beside every failed save would accumulate silently.
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses a path this session never produced', async () => {
    await expect(files.beginWrite(target('never-granted.ffg'))).rejects.toThrow(
      /did not open or save/,
    );
  });

  it('refuses a granted path that is not a project file', async () => {
    files.grant(join(directory, 'notes.txt'));
    await expect(files.beginWrite(join(directory, 'notes.txt'))).rejects.toThrow(
      /not a FigureForge project/,
    );
  });

  it('rejects a chunk for a session that has finished', async () => {
    const path = files.grant(target());
    const id = await files.beginWrite(path);
    if (id === 'denied') throw new Error('unexpectedly denied');
    await files.finishWrite(id);

    await expect(files.writeChunk(id, new Uint8Array([1]))).rejects.toThrow(/no longer open/);
  });

  it('closeAll abandons an unfinished write rather than committing it', async () => {
    // The window going away mid-save must not publish a partial archive.
    const path = files.grant(target());
    const id = await files.beginWrite(path);
    if (id === 'denied') throw new Error('unexpectedly denied');
    await files.writeChunk(id, new Uint8Array([1, 2]));

    await files.closeAll();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('reading', () => {
  it('round-trips through chunks', async () => {
    const path = files.grant(target());
    // Larger than one 4 MB chunk, so the read loop genuinely runs more than
    // once. Built by tiling a pattern rather than `TypedArray.map`, which
    // takes tens of seconds at this size and made the suite unusable.
    const pattern = Uint8Array.from({ length: 256 }, (_, i) => (i * 31) % 251);
    const payload = new Uint8Array(9 * 1024 * 1024);
    for (let at = 0; at < payload.length; at += pattern.length) payload.set(pattern, at);
    await writeThrough(path, [payload]);

    const read = await readThrough(path);
    expect(read.length).toBe(payload.length);
    // `toEqual` on nine million elements is a deep per-element walk and takes
    // over twenty seconds; the native comparison is the same assertion.
    expect(Buffer.compare(Buffer.from(read), Buffer.from(payload))).toBe(0);
  });

  it('reports end of file as null rather than an empty chunk', async () => {
    const path = files.grant(target());
    await writeThrough(path, [new Uint8Array([1])]);

    const { id } = await files.beginRead(path);
    expect(await files.readChunk(id)).toEqual(new Uint8Array([1]));
    // An empty Uint8Array would be indistinguishable from a short read.
    expect(await files.readChunk(id)).toBeNull();
    await files.endRead(id);
  });

  it('refuses a path this session never produced', async () => {
    await expect(files.beginRead(target('never-granted.ffg'))).rejects.toThrow(
      /did not open or save/,
    );
  });

  it('rejects a chunk request for a closed session', async () => {
    const path = files.grant(target());
    await writeThrough(path, [new Uint8Array([1])]);
    const { id } = await files.beginRead(path);
    await files.endRead(id);

    await expect(files.readChunk(id)).rejects.toThrow(/no longer open/);
  });
});

/**
 * What the dialogs are actually told.
 *
 * None of this was pinned before — neither `pickSave` nor `pickOpen` had any
 * test, so the options were free to drift. The working directory reaches the
 * user through exactly these three option objects, so they are the behaviour.
 */
describe('dialogs', () => {
  // A window is only ever forwarded to Electron, never read here.
  const window = {} as never;

  beforeEach(() => {
    dialog.showSaveDialog.mockReset();
    dialog.showOpenDialog.mockReset();
  });

  describe('pickSave', () => {
    it('starts wherever the OS last was when no folder is set', async () => {
      dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target() });

      await files.pickSave(window, 'figure.ffg');

      expect(dialog.showSaveDialog.mock.calls[0]![1]).toStrictEqual({
        title: 'Save figure',
        defaultPath: 'figure.ffg',
        filters: [{ name: 'FigureForge project', extensions: ['ffg', 'figureforge'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
    });

    it('starts in the working folder when there is one', async () => {
      dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target() });

      await files.pickSave(window, 'figure.ffg', '/home/a/Figures');

      expect(dialog.showSaveDialog.mock.calls[0]![1].defaultPath).toBe(
        join('/home/a/Figures', 'figure.ffg'),
      );
    });

    it('takes only the filename from the renderer, never a path', async () => {
      dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target() });

      // The suggested name comes from the renderer, so without `basename` a
      // compromised one could steer the dialog out of the working folder.
      // Not an authorisation hole — the user still confirms and only the
      // result is granted — but there is no reason to allow it.
      await files.pickSave(window, '../../../etc/evil.ffg', '/home/a/Figures');

      expect(dialog.showSaveDialog.mock.calls[0]![1].defaultPath).toBe(
        join('/home/a/Figures', 'evil.ffg'),
      );
    });

    it('authorises what it returns, and nothing when cancelled', async () => {
      dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
      await expect(files.pickSave(window, 'figure.ffg')).resolves.toBeNull();
      await expect(files.beginWrite(target())).rejects.toThrow(/did not open or save/);

      dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target() });
      await expect(files.pickSave(window, 'figure.ffg')).resolves.toEqual({
        path: target(),
        name: 'figure.ffg',
      });
      await expect(files.beginWrite(target())).resolves.toEqual(expect.any(String));
    });
  });

  describe('pickOpen', () => {
    it('passes no defaultPath at all when no folder is set', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [target()] });

      await files.pickOpen(window);

      const [, options] = dialog.showOpenDialog.mock.calls[0]!;
      // Absence, not `undefined`: with no working folder the options must be
      // exactly what they were before this feature existed.
      expect(Object.hasOwn(options, 'defaultPath')).toBe(false);
      expect(options.properties).toEqual(['openFile']);
    });

    it('starts in the working folder when there is one', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [target()] });

      await files.pickOpen(window, '/home/a/Figures');

      expect(dialog.showOpenDialog.mock.calls[0]![1].defaultPath).toBe('/home/a/Figures');
    });
  });

  describe('pickDirectory', () => {
    it('asks for a folder, with no file-type filter', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/home/a/Figures'] });

      const picked = await files.pickDirectory(window);

      const [, options] = dialog.showOpenDialog.mock.calls[0]!;
      expect(options.properties).toEqual(['openDirectory', 'createDirectory']);
      // `filters` is meaningless for a folder chooser and on GTK renders as a
      // file-type dropdown over a dialog that cannot select files.
      expect(Object.hasOwn(options, 'filters')).toBe(false);
      expect(picked).toEqual({ path: '/home/a/Figures', name: 'Figures' });
    });

    it('returns null when cancelled', async () => {
      dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
      await expect(files.pickDirectory(window)).resolves.toBeNull();
    });

    it('does NOT authorise the folder it returns', async () => {
      // The security argument in executable form. A working directory is only
      // ever composed into a `defaultPath`; nothing opens, reads or writes it,
      // so granting it would widen the renderer's reach for no purpose. It
      // could not be granted anyway — a folder has no project extension.
      dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [directory] });

      await files.pickDirectory(window);

      await expect(files.beginRead(directory)).rejects.toThrow(/not a FigureForge project/);
      await expect(files.beginRead(join(directory, 'anything.ffg'))).rejects.toThrow(
        /did not open or save/,
      );
    });
  });
});
