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

import { ARCHIVE_FILE_TYPE } from '@figureforge/doc-model';

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
  handle: FileSystemFileHandle;
}

export interface ProjectFileSystem {
  /** Re-evaluated at call time, not cached — a cached feature-detect is the
   *  classic way to make this untestable. */
  supported(): boolean;
  /** Null means the user cancelled the picker; not an error. */
  pickSave(suggestedName: string): Promise<SaveTarget | null>;
  pickOpen(): Promise<{ file: File; target: SaveTarget } | null>;
  write(target: SaveTarget, bytes: Uint8Array): Promise<'written' | 'denied'>;
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
      return { file, target: { name: handle.name, handle } };
    } catch (caught) {
      if (isCancellation(caught)) return null;
      throw caught;
    }
  },

  async write(target, bytes) {
    if (!(await ensureWritable(target.handle))) return 'denied';
    const stream = await target.handle.createWritable();
    await stream.write(bytes);
    await stream.close();
    return 'written';
  },
};
