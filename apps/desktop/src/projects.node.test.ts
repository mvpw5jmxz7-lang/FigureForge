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
