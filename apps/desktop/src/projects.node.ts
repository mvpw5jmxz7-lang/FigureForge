/**
 * The filesystem and dialog half of project I/O.
 *
 * Split from `projects.ts` for the reason `sidecar.node.ts` is split from
 * `sidecar.ts`: the rule about which paths may be touched is worth testing on
 * its own, and it cannot be tested through a native file dialog.
 */

import { dialog, type BrowserWindow } from 'electron';
import { open, rename, rm, type FileHandle } from 'node:fs/promises';

import { AuthorisedPaths, PROJECT_EXTENSIONS, basename } from './projects';

/**
 * How much of a project file crosses the IPC boundary at a time.
 *
 * Reads are *pulled* — the renderer asks for the next chunk — so this is also
 * the backpressure window. 4 MB makes a 300 MB project about 75 round trips,
 * which is nothing, while keeping each message small enough that the copy
 * structured cloning makes is not itself the problem.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Electron wants extensions without the leading dot, and a display name.
 * Derived from the one list rather than written out twice.
 */
const FILTERS = [
  {
    name: 'FigureForge project',
    extensions: PROJECT_EXTENSIONS.map((extension) => extension.replace(/^\./, '')),
  },
];

export interface SaveLocation {
  path: string;
  name: string;
}

export class ProjectFiles {
  private readonly authorised = new AuthorisedPaths();

  /** Recording a path is what later lets the renderer read or write it. */
  grant(path: string): string {
    return this.authorised.grant(path);
  }

  async pickSave(window: BrowserWindow, suggestedName: string): Promise<SaveLocation | null> {
    const result = await dialog.showSaveDialog(window, {
      title: 'Save figure',
      defaultPath: suggestedName,
      filters: FILTERS,
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) return null;
    this.grant(result.filePath);
    return { path: result.filePath, name: basename(result.filePath) };
  }

  async pickOpen(window: BrowserWindow): Promise<SaveLocation | null> {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open figure',
      filters: FILTERS,
      properties: ['openFile'],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    this.grant(path);
    // The bytes are not read here: the renderer streams them through
    // `beginRead`/`readChunk`, so nothing ever holds the whole archive.
    return { path, name: basename(path) };
  }

  // --- reading, a chunk at a time ---------------------------------------

  /**
   * Open an authorised path for chunked reading.
   *
   * The renderer pulls: it asks for the next chunk when it is ready for one.
   * Pushing would be fewer round trips and would buffer without bound in the
   * renderer if it fell behind the disk, which is the failure this whole
   * stage exists to remove.
   */
  async beginRead(path: string): Promise<{ id: string; name: string }> {
    const refusal = this.authorised.refuse(path);
    if (refusal) throw new Error(refusal);

    const handle = await open(path, 'r');
    const id = `r${this.nextId++}`;
    this.reads.set(id, handle);
    return { id, name: basename(path) };
  }

  /** The next chunk, or null at end of file. */
  async readChunk(id: string): Promise<Uint8Array | null> {
    const handle = this.reads.get(id);
    if (!handle) throw new Error('That project is no longer open for reading.');

    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
    if (bytesRead === 0) return null;
    // Copied out of the reusable buffer: the Uint8Array crosses the IPC
    // boundary and must not alias storage the next read will overwrite.
    return new Uint8Array(buffer.subarray(0, bytesRead));
  }

  async endRead(id: string): Promise<void> {
    const handle = this.reads.get(id);
    this.reads.delete(id);
    await handle?.close();
  }

  // --- writing, through a temp file --------------------------------------

  /**
   * Open an authorised path for chunked writing.
   *
   * Writes land in a sibling temp file and are renamed over the target on
   * `finishWrite`. Streaming makes this necessary rather than merely tidy:
   * a write that fails part-way would otherwise leave a truncated file that
   * still looks like a project and opens to a missing image. The rename is
   * atomic within a filesystem, so the target is either the old file or the
   * complete new one, never half of either.
   */
  async beginWrite(path: string): Promise<string | 'denied'> {
    const refusal = this.authorised.refuse(path);
    if (refusal) throw new Error(refusal);

    const id = `w${this.nextId++}`;
    const temporary = `${path}.${process.pid}-${id}.part`;
    try {
      const handle = await open(temporary, 'w');
      this.writes.set(id, { handle, temporary, target: path });
      return id;
    } catch (caught) {
      // 'denied' is a value, not an exception: the renderer's `write`
      // contract already has a recovery for it, and an Error crossing IPC
      // arrives as a string with its type lost.
      if (isPermissionError(caught)) return 'denied';
      throw caught;
    }
  }

  async writeChunk(id: string, bytes: Uint8Array): Promise<void> {
    const session = this.writes.get(id);
    if (!session) throw new Error('That project is no longer open for writing.');
    await session.handle.write(bytes);
  }

  /** Flush, close and move the temp file into place. */
  async finishWrite(id: string): Promise<'written' | 'denied'> {
    const session = this.writes.get(id);
    if (!session) throw new Error('That project is no longer open for writing.');
    this.writes.delete(id);

    try {
      await session.handle.close();
      await rename(session.temporary, session.target);
      return 'written';
    } catch (caught) {
      await rm(session.temporary, { force: true });
      if (isPermissionError(caught)) return 'denied';
      throw caught;
    }
  }

  /** Abandon a write, leaving the target untouched. */
  async abortWrite(id: string): Promise<void> {
    const session = this.writes.get(id);
    if (!session) return;
    this.writes.delete(id);
    await session.handle.close().catch(() => undefined);
    await rm(session.temporary, { force: true });
  }

  /** Called when the window goes away, so nothing is left half-written. */
  async closeAll(): Promise<void> {
    for (const id of [...this.writes.keys()]) await this.abortWrite(id);
    for (const id of [...this.reads.keys()]) await this.endRead(id);
  }

  private readonly reads = new Map<string, FileHandle>();
  private readonly writes = new Map<
    string,
    { handle: FileHandle; temporary: string; target: string }
  >();
  private nextId = 1;
}

function isPermissionError(caught: unknown): boolean {
  const code = (caught as NodeJS.ErrnoException).code;
  // Only a permissions answer is 'denied'; a full disk or a vanished
  // directory is a real error the user needs to see stated.
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}
