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

import { browserProjectFileSystem, createBrowserProjectFileSystem } from './projectFiles.js';
import { memoryDirectoryStore } from './directoryStore.js';

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
    // The whole options object, not `objectContaining`: this is the fence that
    // says an author who never sets a working directory sees exactly what they
    // saw before the feature existed, and a partial match cannot say that.
    expect(showSaveFilePicker).toHaveBeenCalledWith({
      suggestedName: 'my figure.ffg',
      id: 'figureforge-project',
      startIn: 'documents',
      types: [ARCHIVE_FILE_TYPE],
    });
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

/**
 * The working directory: the folder both dialogs start in.
 *
 * Every test here builds its own instance over a memory store rather than
 * using the shared `browserProjectFileSystem`, which caches — a directory set
 * in one test would otherwise leak into the next.
 *
 * `indexedDbDirectoryStore` itself has no test. It *is* the untestable half
 * this seam exists to isolate (no `indexedDB` in a Node environment, and no
 * structured clone of a directory handle), the same standing `bakePointCloud`'s
 * `OffscreenCanvas` dependency already has. It is driven in a real browser.
 */
describe('working directory', () => {
  const someFolder = { name: 'Figures' };

  const fs = (initial: { name: string } | null = null) =>
    createBrowserProjectFileSystem(memoryDirectoryStore(initial));

  /** A window carrying all three pickers, same-frame. */
  const windowWith = (extra: Record<string, unknown> = {}) => {
    const frame = {};
    vi.stubGlobal('self', frame);
    vi.stubGlobal('top', frame);
    vi.stubGlobal('window', {
      showSaveFilePicker: vi.fn(async () => fakeHandle()),
      showOpenFilePicker: vi.fn(async () => [fakeHandle()]),
      showDirectoryPicker: vi.fn(async () => someFolder),
      ...extra,
    });
    return window as unknown as Record<string, ReturnType<typeof vi.fn>>;
  };

  describe('supportsWorkingDirectory', () => {
    it('is false in plain Node, where there is no window at all', () => {
      expect(fs().supportsWorkingDirectory()).toBe(false);
    });

    it('is false when the file pickers exist but the directory picker does not', () => {
      // Firefox and Safari have neither, but a browser could ship one and not
      // the other; offering a button that cannot work is the defect this
      // separate feature-detect exists to avoid.
      const frame = {};
      vi.stubGlobal('self', frame);
      vi.stubGlobal('top', frame);
      vi.stubGlobal('window', {
        showSaveFilePicker: vi.fn(),
        showOpenFilePicker: vi.fn(),
      });

      expect(fs().supported()).toBe(true);
      expect(fs().supportsWorkingDirectory()).toBe(false);
    });

    it('is true with all three, in the top frame', () => {
      windowWith();
      expect(fs().supportsWorkingDirectory()).toBe(true);
    });

    it('is false in a cross-origin frame, where every picker rejects', () => {
      vi.stubGlobal('self', {});
      vi.stubGlobal('top', {});
      vi.stubGlobal('window', {
        showSaveFilePicker: vi.fn(),
        showOpenFilePicker: vi.fn(),
        showDirectoryPicker: vi.fn(),
      });

      expect(fs().supportsWorkingDirectory()).toBe(false);
    });
  });

  describe('choosing and clearing', () => {
    it('returns the chosen folder and remembers it', async () => {
      const store = memoryDirectoryStore();
      windowWith();
      const files = createBrowserProjectFileSystem(store);

      await expect(files.pickWorkingDirectory()).resolves.toEqual({ name: 'Figures' });
      await expect(store.load()).resolves.toEqual(someFolder);
    });

    it('returns null on cancellation and leaves the previous folder in force', async () => {
      const store = memoryDirectoryStore(someFolder);
      windowWith({
        showDirectoryPicker: vi.fn(async () => {
          throw new DOMException('cancelled', 'AbortError');
        }),
      });
      const files = createBrowserProjectFileSystem(store);

      // Null means cancelled, never "clear it" — a caller that took it as a
      // value would wipe the setting every time someone changed their mind.
      await expect(files.pickWorkingDirectory()).resolves.toBeNull();
      await expect(store.load()).resolves.toEqual(someFolder);
    });

    it('lets a non-cancellation error propagate', async () => {
      windowWith({
        showDirectoryPicker: vi.fn(async () => {
          throw new Error('no such device');
        }),
      });

      await expect(fs().pickWorkingDirectory()).rejects.toThrow('no such device');
    });

    it('reads a stored folder back without ever asking for permission', async () => {
      const handle = { name: 'Figures', queryPermission: vi.fn(), requestPermission: vi.fn() };
      windowWith();
      const files = createBrowserProjectFileSystem(memoryDirectoryStore(handle));

      await expect(files.workingDirectory()).resolves.toEqual({ name: 'Figures' });
      // The executable form of the promise that setting a folder is the only
      // prompt there ever is. `queryPermission` would not prompt either, but it
      // reports 'prompt' for a good folder after every browser restart, so
      // using it to detect staleness would drop the setting on day two.
      expect(handle.queryPermission).not.toHaveBeenCalled();
      expect(handle.requestPermission).not.toHaveBeenCalled();
    });

    it('reports none when nothing is stored', async () => {
      windowWith();
      await expect(fs().workingDirectory()).resolves.toBeNull();
    });
  });

  describe('what the pickers are told', () => {
    it('passes the folder as startIn and omits id entirely', async () => {
      const win = windowWith();
      const files = createBrowserProjectFileSystem(memoryDirectoryStore(someFolder));

      await files.pickSave('figure.ffg');

      const [options] = win['showSaveFilePicker']!.mock.calls[0] as [Record<string, unknown>];
      // Absence is the assertion. `objectContaining` cannot express it and
      // `toEqual` treats `{ id: undefined }` as equal to `{}`, so this is
      // stated twice: readably, and then structurally.
      expect(Object.hasOwn(options, 'id')).toBe(false);
      expect(options['startIn']).toBe(someFolder);
      expect(options).toStrictEqual({
        suggestedName: 'figure.ffg',
        startIn: someFolder,
        types: [ARCHIVE_FILE_TYPE],
      });
    });

    it('tells the open picker the same thing', async () => {
      const win = windowWith();
      const files = createBrowserProjectFileSystem(memoryDirectoryStore(someFolder));

      // The picked file is empty, so the archive reader rejects — irrelevant
      // here, where the assertion is about what the picker was *told*.
      await files.pickOpen().catch(() => undefined);

      const [options] = win['showOpenFilePicker']!.mock.calls[0] as [Record<string, unknown>];
      expect(Object.hasOwn(options, 'id')).toBe(false);
      expect(options).toStrictEqual({
        multiple: false,
        startIn: someFolder,
        types: [ARCHIVE_FILE_TYPE],
      });
    });

    it('falls back to the shared picker id when no folder is set', async () => {
      const win = windowWith();

      await fs().pickOpen().catch(() => undefined);

      expect(win['showOpenFilePicker']!.mock.calls[0]![0]).toStrictEqual({
        multiple: false,
        id: 'figureforge-project',
        startIn: 'documents',
        types: [ARCHIVE_FILE_TYPE],
      });
    });

    it('goes back to the id once the folder is cleared, in the same instance', async () => {
      const win = windowWith();
      const files = createBrowserProjectFileSystem(memoryDirectoryStore(someFolder));

      await files.pickSave('figure.ffg');
      await files.clearWorkingDirectory();
      await files.pickSave('figure.ffg');

      // Pins cache invalidation: clearing has to record "none", not "unread",
      // or the next picker would go back to the store and resurrect it.
      const second = win['showSaveFilePicker']!.mock.calls[1]![0] as Record<string, unknown>;
      expect(second['id']).toBe('figureforge-project');
      expect(second['startIn']).toBe('documents');
      await expect(files.workingDirectory()).resolves.toBeNull();
    });
  });

  describe('when storage misbehaves', () => {
    it('still uses a folder this session when it cannot be written', async () => {
      const store = {
        ...memoryDirectoryStore(),
        save: vi.fn(async () => {
          throw new Error('quota exceeded');
        }),
      };
      windowWith();
      const files = createBrowserProjectFileSystem(store);

      // Private browsing, a quota, denied site data. The real store swallows
      // this itself; a throwing one must not lose the pick either.
      await expect(files.pickWorkingDirectory()).rejects.toThrow('quota exceeded');
      await expect(files.workingDirectory()).resolves.toEqual({ name: 'Figures' });
    });

    it('falls back to the id path when the folder cannot be read', async () => {
      const store = {
        ...memoryDirectoryStore(),
        load: vi.fn(async () => {
          throw new Error('storage unavailable');
        }),
      };
      const win = windowWith();

      await expect(createBrowserProjectFileSystem(store).pickSave('figure.ffg')).rejects.toThrow(
        'storage unavailable',
      );
      expect(win['showSaveFilePicker']).not.toHaveBeenCalled();
    });
  });
});
