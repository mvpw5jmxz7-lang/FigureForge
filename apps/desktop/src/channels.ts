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

/** Renderer → main, `invoke`. Show a dialog and return the chosen path. */
export const PROJECT_PICK_SAVE = 'figureforge:project-pick-save';
export const PROJECT_PICK_OPEN = 'figureforge:project-pick-open';
/**
 * Authorise a path the user pointed at some other way.
 *
 * Two channels, not one, because the two carry different trust. A recent entry
 * is a string the renderer names, so main accepts it only if it is already in
 * the shell's own recent list. A dropped file's path is derived in the
 * *preload* by `webUtils.getPathForFile`, which returns empty for anything the
 * page fabricated — so arriving on this second channel is itself the evidence
 * that a real file was dropped.
 */
export const PROJECT_RESOLVE = 'figureforge:project-resolve';
export const PROJECT_RESOLVE_DROPPED = 'figureforge:project-resolve-dropped';

/**
 * Chunked project I/O.
 *
 * A project is a zip of micrographs and can run to hundreds of megabytes, so
 * it moves a chunk at a time rather than as one message: the archive is never
 * held whole on either side of the boundary, which is the point of this stage.
 * Reads are *pulled* — the renderer asks for the next chunk when it is ready —
 * so the disk cannot outrun it.
 */
export const PROJECT_BEGIN_READ = 'figureforge:project-begin-read';
export const PROJECT_READ_CHUNK = 'figureforge:project-read-chunk';
export const PROJECT_END_READ = 'figureforge:project-end-read';
export const PROJECT_BEGIN_WRITE = 'figureforge:project-begin-write';
export const PROJECT_WRITE_CHUNK = 'figureforge:project-write-chunk';
export const PROJECT_FINISH_WRITE = 'figureforge:project-finish-write';
export const PROJECT_ABORT_WRITE = 'figureforge:project-abort-write';

/**
 * The working directory: the folder both dialogs start in.
 *
 * Three channels, and note which one is missing. There is no "set" — the pick
 * channel takes no argument, so the value can only ever originate in
 * Electron's own folder dialog, and a compromised renderer has no way to name
 * a path. The directory is composed into a `defaultPath` and nothing else: it
 * is never opened, never read, never written, and never passed through
 * `AuthorisedPaths` (which would refuse it anyway, having no project
 * extension). The trust boundary is unchanged — the *file* a dialog returns is
 * authorised exactly as it was before.
 */
export const PROJECT_WORKING_DIRECTORY = 'figureforge:project-working-directory';
export const PROJECT_PICK_WORKING_DIRECTORY = 'figureforge:project-pick-working-directory';
export const PROJECT_CLEAR_WORKING_DIRECTORY = 'figureforge:project-clear-working-directory';

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
  | { type: 'close-file' }
  | { type: 'set-working-directory' }
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
