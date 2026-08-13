/**
 * `ProjectFileSystem` over the Electron shell's native dialogs and chunked
 * file I/O.
 *
 * The interface was built in round 7 so the picker/fallback choice would be
 * testable; it turns out to be exactly the seam a desktop shell needs, and
 * this file is the whole of the adaptation. `App.tsx` is unchanged by it —
 * `main.tsx` picks which implementation to hand over, and everything
 * downstream keeps treating a save target as opaque.
 *
 * Nothing here ever holds the archive whole. `writeArchiveStream` produces
 * chunks and each one is handed straight to the shell; a read pulls chunks
 * back and feeds them to `readArchiveStream`. The zipping happens on this side
 * for both platforms, which is what keeps `apps/desktop` free of internal
 * dependencies and leaves the shell a byte sink.
 *
 * The one visible difference from the browser is `SaveTarget.location`: a real
 * path, which the File System Access API deliberately has no way to supply.
 */

import {
  archiveEntries,
  readArchiveStream,
  writeArchiveStream,
  type ArchiveContents,
  type LoadResult,
} from '@figureforge/doc-model';

import type { ProjectFileSystem, SaveTarget } from './projectFiles.js';
import { isDesktop, type DesktopProject } from './shell.js';

const project = (): DesktopProject => {
  const bridge = window.figureforge?.project;
  if (!bridge) throw new Error('The desktop bridge is unavailable.');
  return bridge;
};

/** A target whose `handle` is the path string the main process authorised. */
export const targetFor = (path: string, name: string): SaveTarget => ({
  name,
  location: path,
  handle: path,
});

/** Pull the file back a chunk at a time; the shell reads no faster than this. */
async function* chunksOf(path: string): AsyncIterable<Uint8Array> {
  const bridge = project();
  const { id } = await bridge.beginRead(path);
  try {
    for (;;) {
      const chunk = await bridge.readChunk(id);
      if (chunk === null) return;
      yield chunk;
    }
  } finally {
    await bridge.endRead(id);
  }
}

/**
 * Open an authorised path.
 *
 * Shared by the Open dialog, the recent list and a dropped file — all three
 * are the user pointing at a project, and they differ only in how the path was
 * obtained.
 */
export async function openAuthorisedPath(
  path: string,
  name: string,
): Promise<{ result: LoadResult; target: SaveTarget }> {
  const result = await readArchiveStream(chunksOf(path));
  return { result, target: targetFor(path, name) };
}

export const desktopProjectFileSystem: ProjectFileSystem = {
  supported: isDesktop,

  async pickSave(suggestedName) {
    const picked = await project().pickSave(suggestedName);
    // Null is a cancelled dialog, which is not an error — the same contract
    // the browser implementation already keeps for an AbortError.
    return picked ? targetFor(picked.path, picked.name) : null;
  },

  async pickOpen() {
    const picked = await project().pickOpen();
    if (!picked) return null;
    return openAuthorisedPath(picked.path, picked.name);
  },

  async write(target, contents: ArchiveContents) {
    const bridge = project();
    const path = target.handle as string;

    const session = await bridge.beginWrite(path);
    if (session === 'denied') return 'denied';

    try {
      await writeArchiveStream(archiveEntries(contents), (chunk) =>
        bridge.writeChunk(session, chunk),
      );
    } catch (caught) {
      // The shell writes to a temp file and only renames it into place on
      // finish, so abandoning here leaves the previous save untouched rather
      // than a truncated file that still looks like a project.
      await bridge.abortWrite(session);
      throw caught;
    }
    return bridge.finishWrite(session);
  },
};
