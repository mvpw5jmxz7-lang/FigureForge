/**
 * The filesystem and dialog half of project I/O.
 *
 * Split from `projects.ts` for the reason `sidecar.node.ts` is split from
 * `sidecar.ts`: the rule about which paths may be touched is worth testing on
 * its own, and it cannot be tested through a native file dialog.
 */

import { dialog, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';

import { AuthorisedPaths, PROJECT_EXTENSIONS, basename } from './projects';

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

export interface OpenedProject {
  path: string;
  name: string;
  bytes: Uint8Array;
}

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

  async pickOpen(window: BrowserWindow): Promise<OpenedProject | null> {
    const result = await dialog.showOpenDialog(window, {
      title: 'Open figure',
      filters: FILTERS,
      properties: ['openFile'],
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    this.grant(path);
    return this.read(path);
  }

  /**
   * Read a path the user has already pointed at — a recent entry, or a file
   * dropped on the window. Refused unless this session produced it.
   */
  async read(path: string): Promise<OpenedProject> {
    const refusal = this.authorised.refuse(path);
    if (refusal) throw new Error(refusal);
    const bytes = await readFile(path);
    return { path, name: basename(path), bytes: new Uint8Array(bytes) };
  }

  /**
   * Overwrite an authorised path.
   *
   * Returns `'denied'` rather than throwing for a permission failure, matching
   * `ProjectFileSystem.write`'s contract in the renderer — the app already has
   * a "the file was downloaded instead" recovery for exactly that answer.
   */
  async write(path: string, bytes: Uint8Array): Promise<'written' | 'denied'> {
    const refusal = this.authorised.refuse(path);
    if (refusal) throw new Error(refusal);
    try {
      await writeFile(path, bytes);
      return 'written';
    } catch (caught) {
      const code = (caught as NodeJS.ErrnoException).code;
      // Only a permissions answer is 'denied'; a full disk or a vanished
      // directory is a real error the user needs to see stated.
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'denied';
      throw caught;
    }
  }
}
