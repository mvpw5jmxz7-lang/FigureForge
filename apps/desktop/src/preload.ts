/**
 * The entire surface the renderer gets from the desktop shell.
 *
 * Still deliberately small. `contextIsolation` and `sandbox` are both on, so
 * this is the only channel between the web app and Node, and every addition is
 * a permanent widening of what a compromised renderer can reach. Stage 1 was
 * three keys; stage 2 adds file access, which is the first thing that has
 * genuinely justified more.
 *
 * **None of the file methods take a path the renderer invented.** `pickSave`
 * and `pickOpen` show a dialog the main process owns; `openPath` and `write`
 * work only on paths the main process previously produced (see
 * `projects.ts`). `openDropped` resolves a real dropped `File` to its path
 * here, in the preload, because `File.path` was removed in Electron 32 and
 * `webUtils.getPathForFile` is not available to the page.
 *
 * Sandboxed preloads must be CommonJS, which is why this package compiles to
 * CJS rather than following the ESM the rest of the repo uses. They also get a
 * `require` that resolves only a short allow-list of Electron's own modules —
 * never a relative path — so this file is *bundled* by esbuild rather than
 * shipped as tsc's output. Without that, the `./channels` import below throws
 * at load and the bridge silently never installs: the window still opens and
 * the app still mounts, so nothing looks wrong until the first API call finds
 * no base URL. Keeping the bundle is what lets the channel names have exactly
 * one definition instead of literals duplicated on both sides of the IPC.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import {
  API_BASE_CHANNEL,
  MENU_COMMAND,
  PROJECT_OPEN_PATH,
  PROJECT_PICK_OPEN,
  PROJECT_PICK_SAVE,
  PROJECT_SAVED,
  PROJECT_WRITE,
  SHELL_STATE,
  type MenuCommand,
  type ShellState,
} from './channels';

/**
 * Fetched synchronously, once, at preload time.
 *
 * The alternative — an async getter — would make `apiBase()` a promise at
 * all seven call sites in `api.ts` for a value that is known before the
 * renderer's first line runs, since the main process does not create the
 * window until the sidecar is answering.
 */
let apiBase = ipcRenderer.sendSync(API_BASE_CHANNEL) as string;

// The port can change if the sidecar crashes and its old port is no longer
// free, so the renderer reads through a function rather than capturing a
// constant it would then hold stale for the rest of the session.
ipcRenderer.on(API_BASE_CHANNEL, (_event, next: string) => {
  apiBase = next;
});

contextBridge.exposeInMainWorld('figureforge', {
  isDesktop: true,
  platform: process.platform,
  apiBase: () => apiBase,

  project: {
    pickSave: (suggestedName: string) => ipcRenderer.invoke(PROJECT_PICK_SAVE, suggestedName),
    pickOpen: () => ipcRenderer.invoke(PROJECT_PICK_OPEN),
    openPath: (path: string) => ipcRenderer.invoke(PROJECT_OPEN_PATH, path),
    write: (path: string, bytes: Uint8Array) => ipcRenderer.invoke(PROJECT_WRITE, path, bytes),

    /**
     * Open a file the user dropped on the window.
     *
     * The path resolution has to happen here: `webUtils` is a main-world
     * Electron module the sandboxed page cannot reach, and without a path a
     * dropped project could be read but never saved back to.
     */
    openDropped: (file: File) => ipcRenderer.invoke(PROJECT_OPEN_PATH, webUtils.getPathForFile(file)),

    /** Tell the shell a save it asked for has landed. Used by the quit guard. */
    reportSaved: (ok: boolean) => ipcRenderer.send(PROJECT_SAVED, ok),
  },

  /** Push what the menu and the quit guard need; see `ShellState`. */
  setShellState: (state: ShellState) => ipcRenderer.send(SHELL_STATE, state),

  /**
   * Subscribe to menu commands. Returns an unsubscribe function, so a React
   * effect can clean up rather than stacking a listener per render.
   */
  onMenuCommand: (listener: (command: MenuCommand) => void) => {
    const handler = (_event: unknown, command: MenuCommand) => listener(command);
    ipcRenderer.on(MENU_COMMAND, handler);
    return () => {
      ipcRenderer.removeListener(MENU_COMMAND, handler);
    };
  },
});
