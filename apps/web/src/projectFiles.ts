/**
 * Save/open through the File System Access API, with an injectable interface
 * so the choice between it and the anonymous-download fallback is testable.
 *
 * The API is Chromium-only — Firefox and Safari have neither
 * `showSaveFilePicker` nor `showOpenFilePicker` — so every caller must keep
 * the existing `SaveDialog` + `download()` path working. This module only
 * decides, at the moment it is needed, whether that fallback is the one to
 * use; it never sniffs at import time, which is what would make the choice
 * untestable.
 */

import {
  ARCHIVE_FILE_TYPE,
  archiveEntries,
  readArchiveStream,
  writeArchiveStream,
  type ArchiveContents,
  type LoadResult,
} from '@figureforge/doc-model';
import {
  indexedDbDirectoryStore,
  type DirectoryStore,
  type StoredDirectory,
} from './directoryStore.js';

/**
 * Minimal ambient shapes for the File System Access API.
 *
 * Not yet part of TypeScript's `lib.dom.d.ts` — the spec is still WICG — and
 * this project avoids a dependency for a handful of method signatures, the
 * same stance already on record for log-rank vs. `lifelines` and for PCA/
 * UMAP's own hand-rolled linear algebra. Scoped to exactly what is called
 * below.
 */
interface FileSystemWritableFileStream {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  /** Discards the swap file. Absent on older implementations. */
  abort?(): Promise<void>;
}
interface FileSystemFileHandle {
  readonly name: string;
  queryPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  createWritable(): Promise<FileSystemWritableFileStream>;
  getFile(): Promise<File>;
}
interface FilePickerAcceptType {
  description: string;
  accept: Record<string, readonly string[]>;
}
interface SaveFilePickerOptions {
  suggestedName?: string;
  id?: string;
  /**
   * A well-known folder, or a directory the user has handed us.
   *
   * The handle arm is what a working directory travels on. Nothing here reads
   * anything off it — see `StoredDirectory` — so `{ readonly name }` is the
   * whole shape.
   */
  startIn?: 'documents' | 'desktop' | 'downloads' | StoredDirectory;
  types?: readonly FilePickerAcceptType[];
}
interface OpenFilePickerOptions extends SaveFilePickerOptions {
  multiple?: boolean;
}
interface DirectoryPickerOptions {
  /** `'read'` is the least privilege the API offers; we never use even that. */
  mode?: 'read' | 'readwrite';
  id?: string;
  startIn?: 'documents' | 'desktop' | 'downloads' | StoredDirectory;
}
declare global {
  interface Window {
    showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
    showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
    showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<StoredDirectory>;
  }
}

/** One `{ id: 'figureforge-project' }` shared by both pickers is the actual
 *  mechanism by which Chromium remembers one directory between Open and Save. */
const PICKER_ID = 'figureforge-project';

/**
 * The `id`/`startIn` pair for a picker, given the working directory or none.
 *
 * Composed once and read by both pickers, so they cannot start in different
 * places. The rule is the whole of this feature's browser half:
 *
 * With a directory set, pass it as `startIn` and **omit `id` entirely**. The
 * spec resolves a starting directory by taking a `startIn` *handle* first, a
 * directory remembered against `id` second, and a `startIn` *well-known
 * string* last — so on paper the handle already wins and the id could stay.
 * But that ordering is unobservable from JavaScript (a picker will not tell
 * you where it opened) and untestable in Node, so the code does not depend on
 * it: with no `id` there is nothing for the handle to lose to, under either
 * reading of the spec.
 *
 * Two consequences worth stating rather than discovering. Omitting `id` also
 * stops Chromium *recording* the pick against it, so while a working directory
 * is set the dialog no longer drifts to wherever you last saved — it returns
 * to the fixed folder every time, which is what a working directory should
 * mean. And clearing one resumes `PICKER_ID` with whatever was remembered
 * before the button was first used.
 *
 * With no directory set this is byte-identical to what both pickers passed
 * before the feature existed, which is the property the tests fence.
 */
function startingDirectory(
  directory: StoredDirectory | null,
): { id: string; startIn: 'documents' } | { startIn: StoredDirectory } {
  return directory ? { startIn: directory } : { id: PICKER_ID, startIn: 'documents' };
}

/** A file the app has permission to overwrite directly, no dialog needed. */
export interface SaveTarget {
  name: string;
  /**
   * A user-meaningful location, where the platform has one to give.
   *
   * The browser deliberately exposes no path — a `FileSystemFileHandle` is an
   * opaque capability — so this is absent there and the UI falls back to the
   * name. The desktop shell has a real path and says so. Keeping it as *data*
   * on the target rather than a platform check in the app is what stops the
   * status bar and the save confirmation from growing an `isDesktop` branch.
   */
  location?: string;
  /**
   * Opaque to everything except the `ProjectFileSystem` that produced it.
   *
   * A browser handle and a filesystem path have nothing in common, and no
   * caller has ever needed to know which it is holding: outside this module
   * only `.name` is ever read, and the target is passed straight back to
   * `write`. Typing it as the browser's handle would force the desktop
   * implementation to lie about what it stores.
   */
  handle: unknown;
}

/**
 * The folder Open and Save dialogs start in.
 *
 * Deliberately carries no handle, unlike `SaveTarget`. The app only ever
 * *displays* this — the handle itself stays inside the implementation that
 * loaded it, a few lines from where the picker options are built, rather than
 * living as a capability in the React tree. `location` follows `SaveTarget`'s
 * own idiom: a real path where the platform has one, absent in the browser.
 */
export interface WorkingDirectory {
  name: string;
  location?: string;
}

export interface ProjectFileSystem {
  /** Re-evaluated at call time, not cached — a cached feature-detect is the
   *  classic way to make this untestable. */
  supported(): boolean;
  /**
   * Whether a working directory can be offered at all.
   *
   * Separate from `supported()` because the two genuinely differ: Chromium has
   * all three pickers, the desktop shell has a native folder dialog, and a
   * browser with the file pickers but no `showDirectoryPicker` would otherwise
   * be offered a button that cannot work. Sync, so the UI can hide the control
   * rather than render it and find out.
   */
  supportsWorkingDirectory(): boolean;
  /**
   * The directory in force, or null. Async because the browser has to read it
   * back from storage; the app loads it once into state rather than awaiting
   * it per render.
   */
  workingDirectory(): Promise<WorkingDirectory | null>;
  /**
   * Ask the user for one.
   *
   * **Null means the user cancelled**, exactly as it does for `pickSave` and
   * `pickOpen` — never "clear it". A caller that treats null as a value will
   * wipe the setting every time someone changes their mind.
   */
  pickWorkingDirectory(): Promise<WorkingDirectory | null>;
  /** Forget it; both dialogs go back to the platform's own default. */
  clearWorkingDirectory(): Promise<void>;
  /** Null means the user cancelled the picker; not an error. */
  pickSave(suggestedName: string): Promise<SaveTarget | null>;
  /**
   * Open a project, already parsed.
   *
   * Returns a `LoadResult` rather than bytes so each implementation can choose
   * how to get there: the browser reads the `File` as a stream, and the
   * desktop shell pulls it from disk in chunks. Handing back a whole buffer
   * would force both to hold the compressed archive, which is half of what
   * `archive-stream.ts` exists to avoid.
   */
  pickOpen(): Promise<{ result: LoadResult; target: SaveTarget } | null>;
  /**
   * Write a project to an already-picked file.
   *
   * Takes the *contents* rather than serialised bytes for the same reason:
   * `saveArchive` would materialise a second copy of every image before a
   * single byte reached the disk.
   */
  write(target: SaveTarget, contents: ArchiveContents): Promise<'written' | 'denied'>;
}

async function ensureWritable(handle: FileSystemFileHandle): Promise<boolean> {
  const query = await handle.queryPermission({ mode: 'readwrite' });
  if (query === 'granted') return true;
  if (query === 'denied') return false;
  const request = await handle.requestPermission({ mode: 'readwrite' });
  return request === 'granted';
}

function isCancellation(caught: unknown): boolean {
  return caught instanceof DOMException && caught.name === 'AbortError';
}

/**
 * The browser implementation, over a store it does not choose for itself.
 *
 * A factory rather than the object literal this used to be, because holding a
 * working directory makes it stateful and the state has to be swappable for a
 * test. The exported const below closes over the real store, so `main.tsx` and
 * `App.tsx`'s default prop are unchanged.
 */
export function createBrowserProjectFileSystem(
  store: DirectoryStore = indexedDbDirectoryStore(),
): ProjectFileSystem {
  /**
   * The working directory, once loaded. `undefined` means "not read yet".
   *
   * Two jobs. It keeps every save off IndexedDB, and it keeps the session
   * working when the *write* failed — private browsing, a quota, denied site
   * data — where the directory is still in force for as long as the tab lives
   * and simply will not survive a reload.
   */
  let cached: StoredDirectory | null | undefined;

  const current = async (): Promise<StoredDirectory | null> => {
    if (cached === undefined) cached = await store.load();
    return cached;
  };

  return {
    supported(): boolean {
      // A cross-origin frame has the function but the picker always rejects
      // there, so the app would offer a control that fails on every click.
      return (
        typeof window !== 'undefined' &&
        typeof window.showSaveFilePicker === 'function' &&
        typeof window.showOpenFilePicker === 'function' &&
        globalThis.self === globalThis.top
      );
    },

    supportsWorkingDirectory(): boolean {
      return this.supported() && typeof window.showDirectoryPicker === 'function';
    },

    async workingDirectory() {
      const directory = await current();
      // Only `.name` is read, and reading it is a plain attribute get: no
      // permission query, no prompt. A stored handle is deliberately never
      // inspected beyond this — `queryPermission` would not prompt either, but
      // it reports `'prompt'` for a perfectly good folder after every browser
      // restart, so using it to detect staleness would silently drop the
      // user's setting on day two. A folder that has been deleted or renamed
      // simply stops steering the dialog, which still opens; the clear button
      // is the recourse.
      return directory ? { name: directory.name } : null;
    },

    async pickWorkingDirectory() {
      try {
        // `mode: 'read'` is the least privilege the API offers. This is the
        // one prompt in the whole feature: Chromium shows the folder chooser
        // and usually a confirmation, once. Nothing afterwards reads or writes
        // anything inside the folder.
        const handle = await window.showDirectoryPicker!({ mode: 'read' });
        cached = handle;
        await store.save(handle);
        return { name: handle.name };
      } catch (caught) {
        if (isCancellation(caught)) return null;
        throw caught;
      }
    },

    async clearWorkingDirectory() {
      // `null`, not `undefined`: leaving it unloaded would send the very next
      // picker back to the store and resurrect what was just cleared.
      cached = null;
      await store.clear();
    },

    async pickSave(suggestedName) {
      try {
        const handle = await window.showSaveFilePicker!({
          suggestedName,
          ...startingDirectory(await current()),
          types: [ARCHIVE_FILE_TYPE],
        });
        return { name: handle.name, handle };
      } catch (caught) {
        if (isCancellation(caught)) return null;
        throw caught;
      }
    },

    async pickOpen() {
      try {
        const [handle] = await window.showOpenFilePicker!({
          multiple: false,
          ...startingDirectory(await current()),
          types: [ARCHIVE_FILE_TYPE],
        });
        if (!handle) return null;
        const file = await handle.getFile();
        // `File.stream()` reads lazily, so the compressed archive is never held
        // whole — only the entries it decodes to, which the app needs anyway.
        const result = await readArchiveStream(streamOf(file));
        return { result, target: { name: handle.name, handle } };
      } catch (caught) {
        if (isCancellation(caught)) return null;
        throw caught;
      }
    },

    async write(target, contents) {
      // Narrowed here, once, because this implementation is the only thing that
      // knows what it put in `handle`.
      const handle = target.handle as FileSystemFileHandle;
      if (!(await ensureWritable(handle))) return 'denied';

      // `createWritable` is a real stream and always was — this used to write a
      // single buffer into it, which meant `saveArchive` had to build the whole
      // archive first. Feeding it chunk by chunk keeps the peak at one entry.
      // The API writes to a swap file and commits on `close`, so a failure
      // part-way through leaves the original file untouched.
      const stream = await handle.createWritable();
      try {
        await writeArchiveStream(archiveEntries(contents), (chunk) => stream.write(chunk));
      } catch (caught) {
        await stream.abort?.();
        throw caught;
      }
      await stream.close();
      return 'written';
    },
  };
}

export const browserProjectFileSystem: ProjectFileSystem = createBrowserProjectFileSystem();

/** A `File` as an async iterable of chunks, for `readArchiveStream`. */
async function* streamOf(file: File): AsyncIterable<Uint8Array> {
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
