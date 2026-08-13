/**
 * IPC channel names, shared by the main process and the preload.
 *
 * Its own module because it has to be importable from *both* sides, and the
 * two sides run in different worlds: `preload.ts` calls `ipcRenderer` at module
 * scope, which exists only in a preload context. Importing the constant from
 * there made the main process load the preload as an ordinary CommonJS module
 * and throw on `ipcRenderer.sendSync` of `undefined` before a window was ever
 * created — the app died at startup with every unit test still green.
 *
 * So the rule this file encodes: anything both sides need lives somewhere that
 * touches no Electron API at all.
 */

/**
 * Where the Python sidecar is listening.
 *
 * Carries a synchronous request from the preload (`sendSync`, once, at load)
 * and an asynchronous push from the main process whenever a restart changes
 * the port.
 */
export const API_BASE_CHANNEL = 'figureforge:api-base';

/** Renderer → main, `invoke`. Show a dialog, or read/write an authorised path. */
export const PROJECT_PICK_SAVE = 'figureforge:project-pick-save';
export const PROJECT_PICK_OPEN = 'figureforge:project-pick-open';
export const PROJECT_OPEN_PATH = 'figureforge:project-open-path';
export const PROJECT_WRITE = 'figureforge:project-write';

/** Main → renderer. A menu item was chosen. */
export const MENU_COMMAND = 'figureforge:menu-command';

/**
 * Renderer → main. What the menu needs to know to enable or disable itself,
 * and what the quit guard needs to know before letting the app close.
 *
 * Pushed rather than pulled: the main process cannot read React state, and a
 * request/response on every menu open would make opening a menu wait on the
 * renderer's event loop.
 */
export const SHELL_STATE = 'figureforge:shell-state';

/**
 * Renderer → main. A save the *shell* asked for has finished.
 *
 * Only the quit guard uses this: having offered "Save", it has to know the
 * bytes reached disk before it lets the process exit.
 */
export const PROJECT_SAVED = 'figureforge:project-saved';

/**
 * What a menu item asks the renderer to do.
 *
 * Every one of these is a command the app already had; the menu is a second
 * way to reach them, never a second implementation. `open-path` is the one
 * that carries data — the recent entry that was clicked.
 */
export type MenuCommand =
  | { type: 'new' }
  | { type: 'open' }
  | { type: 'open-path'; path: string }
  | { type: 'save' }
  | { type: 'save-as' }
  | { type: 'export'; format: 'svg' | 'pdf' | 'eps' | 'png' | 'tiff' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'duplicate' }
  | { type: 'delete' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'zoom-reset' }
  | { type: 'zoom-fit' }
  | { type: 'toggle-grid' };

/** What the renderer tells the shell about itself. */
export interface ShellState {
  /** Unsaved edits exist. Drives the quit guard and the title bar's dot. */
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Enables Duplicate and Delete, which act on the canvas selection. */
  hasSelection: boolean;
  /** Drives the View menu's checkbox, so it shows the real state, not a guess. */
  showGrid: boolean;
  /** Shown in the window title; null before the first save. */
  savedPath: string | null;
  title: string;
}
