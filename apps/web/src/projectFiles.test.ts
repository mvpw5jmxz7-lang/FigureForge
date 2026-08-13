/**
 * `browserProjectFileSystem`'s contract against the File System Access API.
 *
 * The suite runs under vitest's `environment: 'node'` (see `vitest.config.ts`
 * — deliberately not jsdom, so an accidental DOM import in `packages/render`
 * fails loudly here rather than breaking export fidelity later). That means
 * `window` does not exist unless a test stubs it, which is exactly the
 * feature-detect this module has to get right: `supported()` must come back
 * `false`, not throw, in the plain-Node case every other test in this repo
 * already runs in.
 *
 * What is deliberately NOT covered here: `App`'s own save/saveAs orchestration
 * (a second Save reusing a held target, a denied write falling back to
 * `download`, Save as… always re-picking). That is `App` component behaviour
 * over React state, and this project's vitest config has no jsdom/React
 * Testing Library harness — the same reason `bakePointCloud` has no unit test
 * (`OffscreenCanvas` is absent from this environment on purpose). It is
 * verified by hand in a real browser instead, per the plan's stage-1
 * verification list.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHIVE_FILE_TYPE } from '@figureforge/doc-model';
import { buildArchiveContents, createDocument, loadArchive } from '@figureforge/doc-model';

import { browserProjectFileSystem } from './projectFiles.js';

/** A minimal but real project, so `write` exercises the actual archive writer. */
const someProject = () => buildArchiveContents(createDocument(), new Map(), new Map());

/**
 * Collect what a writable stream was given.
 *
 * `write` streams now, so a test can no longer assert "was called with these
 * exact bytes" — it asserts the joined result is a readable archive, which is
 * the property that actually matters.
 */
function collectingStream() {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    write: vi.fn(async (chunk: Uint8Array) => {
      chunks.push(chunk.slice());
    }),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    joined(): Uint8Array {
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('supported()', () => {
  it('is false with no window at all — the plain-Node case this suite itself runs in', () => {
    expect(browserProjectFileSystem.supported()).toBe(false);
  });

  it('is false when window exists but lacks the picker functions', () => {
    vi.stubGlobal('window', {});
    expect(browserProjectFileSystem.supported()).toBe(false);
  });

  it('is true when both pickers exist and the frame is not cross-origin', () => {
    const frame = {};
    vi.stubGlobal('window', {
      showSaveFilePicker: async () => {},
      showOpenFilePicker: async () => {},
    });
    vi.stubGlobal('self', frame);
    vi.stubGlobal('top', frame);
    expect(browserProjectFileSystem.supported()).toBe(true);
  });

  it('is false inside a cross-origin frame even with both pickers present', () => {
    vi.stubGlobal('window', {
      showSaveFilePicker: async () => {},
      showOpenFilePicker: async () => {},
    });
    vi.stubGlobal('self', {});
    vi.stubGlobal('top', {});
    expect(browserProjectFileSystem.supported()).toBe(false);
  });
});

function fakeHandle(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: 'figure.ffg',
    queryPermission: vi.fn(async () => 'granted' as const),
    requestPermission: vi.fn(async () => 'granted' as const),
    createWritable: vi.fn(async () => ({
      write: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    })),
    getFile: vi.fn(async () => new File([], 'figure.ffg')),
    ...overrides,
  };
}

describe('pickSave', () => {
  it('resolves the picked handle, passing the archive file type through', async () => {
    const handle = fakeHandle();
    const showSaveFilePicker = vi.fn(async () => handle);
    vi.stubGlobal('window', { showSaveFilePicker });

    const target = await browserProjectFileSystem.pickSave('my figure.ffg');

    expect(target).toEqual({ name: 'figure.ffg', handle });
    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'my figure.ffg', types: [ARCHIVE_FILE_TYPE] }),
    );
  });

  it('returns null, not an error, when the user cancels the picker', async () => {
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn(async () => {
        throw new DOMException('cancelled', 'AbortError');
      }),
    });

    await expect(browserProjectFileSystem.pickSave('figure.ffg')).resolves.toBeNull();
  });

  it('lets a non-cancellation error propagate', async () => {
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });

    await expect(browserProjectFileSystem.pickSave('figure.ffg')).rejects.toThrow('disk full');
  });
});

describe('pickOpen', () => {
  it('parses the picked file and builds a target from the same handle', async () => {
    // Streamed through `File.stream()`, so the archive is never held whole —
    // the returned project is already parsed rather than a File to read again.
    const stream = collectingStream();
    const written = fakeHandle({
      queryPermission: vi.fn(async () => 'granted' as const),
      createWritable: vi.fn(async () => stream),
    });
    await browserProjectFileSystem.write({ name: written.name, handle: written }, someProject());

    const file = new File([new Uint8Array(stream.joined())], 'figure.ffg');
    const handle = fakeHandle({ getFile: vi.fn(async () => file) });
    vi.stubGlobal('window', { showOpenFilePicker: vi.fn(async () => [handle]) });

    const result = await browserProjectFileSystem.pickOpen();

    expect(result?.target).toEqual({ name: 'figure.ffg', handle });
    expect(result?.result.document.schemaVersion).toBe(createDocument().schemaVersion);
  });

  it('returns null on cancellation', async () => {
    vi.stubGlobal('window', {
      showOpenFilePicker: vi.fn(async () => {
        throw new DOMException('cancelled', 'AbortError');
      }),
    });

    await expect(browserProjectFileSystem.pickOpen()).resolves.toBeNull();
  });
});

describe('write', () => {
  it('writes and closes when permission is already granted', async () => {
    const stream = collectingStream();
    const handle = fakeHandle({
      queryPermission: vi.fn(async () => 'granted' as const),
      createWritable: vi.fn(async () => stream),
    });

    const result = await browserProjectFileSystem.write(
      { name: handle.name, handle },
      someProject(),
    );

    expect(result).toBe('written');
    // Several chunks, not one buffer: that is the whole point of streaming.
    expect(stream.write.mock.calls.length).toBeGreaterThan(1);
    expect(loadArchive(stream.joined()).document.schemaVersion).toBe(
      createDocument().schemaVersion,
    );
    expect(stream.close).toHaveBeenCalled();
    // Never asked twice: a permission already granted must not re-prompt.
    expect(handle.requestPermission).not.toHaveBeenCalled();
  });

  it('is denied outright without prompting again', async () => {
    const handle = fakeHandle({ queryPermission: vi.fn(async () => 'denied' as const) });

    const result = await browserProjectFileSystem.write(
      { name: handle.name, handle },
      someProject(),
    );

    expect(result).toBe('denied');
    expect(handle.requestPermission).not.toHaveBeenCalled();
    expect(handle.createWritable).not.toHaveBeenCalled();
  });

  it('requests permission on "prompt" and writes if granted', async () => {
    const handle = fakeHandle({
      queryPermission: vi.fn(async () => 'prompt' as const),
      requestPermission: vi.fn(async () => 'granted' as const),
    });

    const result = await browserProjectFileSystem.write(
      { name: handle.name, handle },
      someProject(),
    );

    expect(result).toBe('written');
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('is denied when the requested permission is refused', async () => {
    const handle = fakeHandle({
      queryPermission: vi.fn(async () => 'prompt' as const),
      requestPermission: vi.fn(async () => 'denied' as const),
    });

    const result = await browserProjectFileSystem.write(
      { name: handle.name, handle },
      someProject(),
    );

    expect(result).toBe('denied');
    expect(handle.createWritable).not.toHaveBeenCalled();
  });
});
