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
  PROJECT_ABORT_WRITE,
  PROJECT_CLEAR_WORKING_DIRECTORY,
  PROJECT_PICK_WORKING_DIRECTORY,
  PROJECT_WORKING_DIRECTORY,
  PROJECT_BEGIN_READ,
  PROJECT_BEGIN_WRITE,
  PROJECT_END_READ,
  PROJECT_FINISH_WRITE,
  PROJECT_PICK_OPEN,
  PROJECT_PICK_SAVE,
  PROJECT_READ_CHUNK,
  PROJECT_RESOLVE,
  PROJECT_RESOLVE_DROPPED,
  PROJECT_SAVED,
  PROJECT_WRITE_CHUNK,
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
    /** Authorise a path the user chose from the recent list. */
    resolve: (path: string) => ipcRenderer.invoke(PROJECT_RESOLVE, path),

    /**
     * Authorise a file the user dropped on the window.
     *
     * The path resolution has to happen here: `webUtils` is a main-world
     * Electron module the sandboxed page cannot reach, and without a path a
     * dropped project could be read but never saved back to.
     */
    resolveDropped: (file: File) =>
      ipcRenderer.invoke(PROJECT_RESOLVE_DROPPED, webUtils.getPathForFile(file)),

    /*
     * The folder both dialogs start in.
     *
     * Note that `pickWorkingDirectory` takes no argument: there is no bridge
     * member by which the page can name a path, so the value can only ever
     * come from Electron's own folder dialog. These live inside `project`
     * rather than as new top-level keys, which also leaves the smoke run's
     * exact top-level surface assertion untouched.
     */
    workingDirectory: () => ipcRenderer.invoke(PROJECT_WORKING_DIRECTORY),
    pickWorkingDirectory: () => ipcRenderer.invoke(PROJECT_PICK_WORKING_DIRECTORY),
    clearWorkingDirectory: () => ipcRenderer.invoke(PROJECT_CLEAR_WORKING_DIRECTORY),

    // Chunked I/O. A project runs to hundreds of megabytes, so it never
    // crosses this boundary as a single message.
    beginRead: (path: string) => ipcRenderer.invoke(PROJECT_BEGIN_READ, path),
    readChunk: (id: string) => ipcRenderer.invoke(PROJECT_READ_CHUNK, id),
    endRead: (id: string) => ipcRenderer.invoke(PROJECT_END_READ, id),
    beginWrite: (path: string) => ipcRenderer.invoke(PROJECT_BEGIN_WRITE, path),
    writeChunk: (id: string, chunk: Uint8Array) =>
      ipcRenderer.invoke(PROJECT_WRITE_CHUNK, id, chunk),
    finishWrite: (id: string) => ipcRenderer.invoke(PROJECT_FINISH_WRITE, id),
    abortWrite: (id: string) => ipcRenderer.invoke(PROJECT_ABORT_WRITE, id),

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
