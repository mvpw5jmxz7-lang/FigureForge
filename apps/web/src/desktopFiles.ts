/**
 * `ProjectFileSystem` over the Electron shell's native dialogs.
 *
 * The interface was built in round 7 so the picker/fallback choice would be
 * testable; it turns out to be exactly the seam a desktop shell needs, and
 * this file is the whole of the adaptation. `App.tsx` is unchanged by it —
 * `main.tsx` picks which implementation to hand over, and everything
 * downstream keeps treating a save target as opaque.
 *
 * The one visible difference is `SaveTarget.location`: a real path, which the
 * browser deliberately has no way to supply, so the status bar and the save
 * confirmation can say where the file went.
 */

import type { ProjectFileSystem, SaveTarget } from './projectFiles.js';
import { isDesktop, type DesktopOpened, type DesktopProject } from './shell.js';

const project = (): DesktopProject => {
  const bridge = window.figureforge?.project;
  if (!bridge) throw new Error('The desktop bridge is unavailable.');
  return bridge;
};

/** A target whose `handle` is the path string the main process authorised. */
const targetFor = (path: string, name: string): SaveTarget => ({
  name,
  location: path,
  handle: path,
});

/** Shared by every open route: dialog, recent entry and drop all land here. */
export function openedToResult(opened: DesktopOpened): { file: File; target: SaveTarget } {
  // `App.openFromFile` only ever calls `.arrayBuffer()` on this, but building
  // a real `File` keeps that path identical to the browser's rather than
  // introducing a desktop-only branch through the open flow.
  // Re-wrapped rather than passed straight in: the same idiom `downloadArchive`
  // already uses, because a `Uint8Array` may be a view into a larger pooled
  // buffer and `BlobPart` wants one that owns its bytes.
  const file = new File([new Uint8Array(opened.bytes)], opened.name, {
    type: 'application/vnd.figureforge.project+zip',
  });
  return { file, target: targetFor(opened.path, opened.name) };
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
    const opened = await project().pickOpen();
    return opened ? openedToResult(opened) : null;
  },

  async write(target, bytes) {
    return project().write(target.handle as string, bytes);
  },
};
