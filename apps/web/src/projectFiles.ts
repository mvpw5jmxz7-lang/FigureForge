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
  startIn?: 'documents' | 'desktop' | 'downloads';
  types?: readonly FilePickerAcceptType[];
}
interface OpenFilePickerOptions extends SaveFilePickerOptions {
  multiple?: boolean;
}
declare global {
  interface Window {
    showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
    showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  }
}

/** One `{ id: 'figureforge-project' }` shared by both pickers is the actual
 *  mechanism by which Chromium remembers one directory between Open and Save. */
const PICKER_ID = 'figureforge-project';

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

export interface ProjectFileSystem {
  /** Re-evaluated at call time, not cached — a cached feature-detect is the
   *  classic way to make this untestable. */
  supported(): boolean;
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

export const browserProjectFileSystem: ProjectFileSystem = {
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

  async pickSave(suggestedName) {
    try {
      const handle = await window.showSaveFilePicker!({
        suggestedName,
        id: PICKER_ID,
        startIn: 'documents',
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
        id: PICKER_ID,
        startIn: 'documents',
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
