/**
 * Electron main process.
 *
 * Two jobs: own the Python sidecar's lifetime, and host the renderer with a
 * posture that assumes the renderer could be compromised.
 *
 * The ordering is the load-bearing part. The sidecar is started and *awaited*
 * before any window exists, so the preload can hand the renderer a working API
 * base synchronously and `api.ts` needs no promise, no retry and no "service
 * not ready yet" state. The cost is a slower first paint; the alternative is
 * that same delay redistributed across every early request as a race.
 */

import { app, BrowserWindow, Menu, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  API_BASE_CHANNEL,
  MENU_COMMAND,
  PROJECT_ABORT_WRITE,
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
import { buildMenuTemplate, toElectronTemplate } from './menu';
import { basename } from './projects';
import { ProjectFiles } from './projects.node';
import { addRecent, parseRecent, removeRecent, serialiseRecent } from './recent';
import { PythonSidecar, type SidecarStatus } from './sidecar';
import { allocatePort, delay, makeSpawn, probe, resolvePythonLaunch } from './sidecar.node';

/** Repo root in development: this file runs from apps/desktop/dist. */
const APP_ROOT = join(__dirname, '..', '..', '..');

const DEV_URL = process.env['FIGUREFORGE_DEV_URL'] ?? 'http://localhost:5173';

/** Set once the app is genuinely on its way out, to break the quit cycle. */
let teardownStarted = false;
let mainWindow: BrowserWindow | null = null;

const projects = new ProjectFiles();

/**
 * The renderer's last word about itself.
 *
 * Starts pessimistic-but-quiet: nothing is dirty before the app has loaded,
 * and every command that acts on a selection is disabled until the renderer
 * says there is one.
 */
let shellState: ShellState = {
  dirty: false,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  showGrid: false,
  savedPath: null,
  title: 'FigureForge',
};

let recentPaths: string[] = [];

/** Where the recent list is kept. Per-user, and not inside the checkout. */
const recentFile = (): string => join(app.getPath('userData'), 'recent.json');

/** GUIDE.md ships with the checkout; a packaged build may not carry it. */
const guidePath = (): string => join(APP_ROOT, 'GUIDE.md');

const sidecar = new PythonSidecar(
  {
    spawn: makeSpawn(resolvePythonLaunch(APP_ROOT)),
    probe,
    allocatePort,
    delay,
    log: (message) => console.log(`[sidecar] ${message}`),
  },
  {},
);

/**
 * Where the renderer comes from.
 *
 * A packaged build loads the built assets off disk; development loads the Vite
 * dev server so hot reload still works, which is the only way the desktop
 * shell is usable to develop against at all.
 */
function rendererUrl(): string {
  if (process.env['FIGUREFORGE_DEV_URL'] || !app.isPackaged) return DEV_URL;
  return pathToFileURL(join(__dirname, '..', '..', 'web', 'dist', 'index.html')).toString();
}

/**
 * Refuse everything the app does not need.
 *
 * This mirrors the stance already taken on the export renderer's browser
 * context, which blocks every scheme but `data:`/`about:`/`blob:`: a figure
 * document can contain author-supplied text and imported files, so the window
 * showing it is treated as untrusted rather than assumed safe.
 */
function lockDown(): void {
  app.on('web-contents-created', (_event, contents) => {
    // Anything wanting a new window is either a mistake or an attack; genuine
    // outbound links go to the user's real browser instead.
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url);
      return { action: 'deny' };
    });

    contents.on('will-navigate', (event, url) => {
      // The renderer is a single-page app: it never legitimately navigates
      // away from where it was loaded.
      if (!url.startsWith(rendererUrl().replace(/\/index\.html$/, ''))) {
        event.preventDefault();
        if (url.startsWith('https://')) void shell.openExternal(url);
      }
    });

    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // Shown on ready-to-show, so the first thing the user sees is the app
    // rather than a white rectangle the size of the window.
    show: false,
    title: 'FigureForge',
    backgroundColor: '#16181c',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.once('ready-to-show', () => window.show());
  void window.loadURL(rendererUrl());
  return window;
}

/** Keep the renderer's API base current across a sidecar restart. */
function publishStatus(status: SidecarStatus): void {
  if (status.state === 'ready') {
    mainWindow?.webContents.send(API_BASE_CHANNEL, status.baseUrl);
    return;
  }
  if (status.state === 'failed') {
    dialog.showErrorBox('The analysis service stopped', status.reason);
  }
}

// --- the menu ------------------------------------------------------------

function sendCommand(command: MenuCommand): void {
  mainWindow?.webContents.send(MENU_COMMAND, command);
}

function applyMenu(): void {
  const template = buildMenuTemplate({
    state: shellState,
    recent: recentPaths,
    isMac: process.platform === 'darwin',
    hasGuide: existsSync(guidePath()),
  });
  // The conversion is pure and lives in `menu.ts`; this supplies only the
  // three effects it cannot have.
  const converted = toElectronTemplate(template, {
    onCommand: sendCommand,
    onAbout: showAbout,
    onGuide: () => void shell.openPath(guidePath()),
  }) as Electron.MenuItemConstructorOptions[];
  Menu.setApplicationMenu(Menu.buildFromTemplate(converted));
}

function showAbout(): void {
  const status = sidecar.status;
  void dialog.showMessageBox({
    type: 'info',
    title: 'About FigureForge',
    message: 'FigureForge',
    detail: [
      'Publication-ready multi-panel figure assembly.',
      '',
      `Electron ${process.versions.electron}`,
      `Chromium ${process.versions.chrome}`,
      `Node ${process.versions.node}`,
      `Analysis service: ${status.state === 'ready' ? status.baseUrl : status.state}`,
    ].join('\n'),
  });
}

/** The window title is the one place the shell states what is unsaved. */
function applyTitle(): void {
  const mark = shellState.dirty ? ' •' : '';
  const where = shellState.savedPath ? ` — ${shellState.savedPath}` : '';
  mainWindow?.setTitle(`${shellState.title}${mark}${where}`);
}

// --- recent files --------------------------------------------------------

async function loadRecent(): Promise<void> {
  try {
    recentPaths = parseRecent(await readFile(recentFile(), 'utf8'));
  } catch {
    // No list yet, which is the normal first-run state.
    recentPaths = [];
  }
  // Every remembered path is re-authorised for this session at load, because
  // the user choosing it from the menu is the same act of pointing at a file
  // that a dialog would be.
  for (const path of recentPaths) projects.grant(path);
}

async function rememberRecent(path: string): Promise<void> {
  recentPaths = addRecent(recentPaths, path);
  applyMenu();
  await writeFile(recentFile(), serialiseRecent(recentPaths)).catch(() => {
    // A recent list that cannot be written is a lost convenience, never a
    // reason to fail the save the user actually asked for.
  });
}

async function forgetRecent(path: string): Promise<void> {
  recentPaths = removeRecent(recentPaths, path);
  applyMenu();
  await writeFile(recentFile(), serialiseRecent(recentPaths)).catch(() => undefined);
}

// --- project IPC ---------------------------------------------------------

function registerProjectHandlers(): void {
  ipcMain.handle(PROJECT_PICK_SAVE, async (_event, suggestedName: string) => {
    if (!mainWindow) return null;
    const picked = await projects.pickSave(mainWindow, suggestedName);
    if (picked) await rememberRecent(picked.path);
    return picked;
  });

  ipcMain.handle(PROJECT_PICK_OPEN, async () => {
    if (!mainWindow) return null;
    const opened = await projects.pickOpen(mainWindow);
    if (opened) await rememberRecent(opened.path);
    return opened;
  });

  // Authorise a path the user pointed at some other way — a recent entry, or a
  // file dropped on the window. No bytes move here; the renderer then streams
  // it through the same beginRead/readChunk pair a dialog result uses.
  //
  // A path the renderer simply names is **not** enough. Granting whatever it
  // asks for would let a compromised renderer read any project file on the
  // disk, which is most of what stage 2's authorisation set exists to prevent.
  // So this accepts only what the shell already knows about: an entry in its
  // own recent list, or a path the preload resolved from a real dropped file
  // via `webUtils` — the latter arrives pre-granted below.
  ipcMain.handle(PROJECT_RESOLVE, (_event, path: string) => {
    if (!recentPaths.includes(path)) {
      throw new Error('Refusing a path this session did not open or save.');
    }
    projects.grant(path);
    return { path, name: basename(path) };
  });

  // A real dropped file. The preload resolved this through `webUtils`, which
  // yields an empty string for anything the page made up, so a non-empty path
  // here means the user genuinely dropped a file on the window.
  ipcMain.handle(PROJECT_RESOLVE_DROPPED, (_event, path: string) => {
    if (!path) throw new Error('That drop did not carry a real file.');
    projects.grant(path);
    return { path, name: basename(path) };
  });

  ipcMain.handle(PROJECT_BEGIN_READ, async (_event, path: string) => {
    try {
      const session = await projects.beginRead(path);
      await rememberRecent(path);
      return session;
    } catch (caught) {
      // A recent entry the user has since moved or deleted should quietly
      // leave the list rather than sit there failing every time it is clicked.
      if ((caught as NodeJS.ErrnoException).code === 'ENOENT') await forgetRecent(path);
      throw caught;
    }
  });
  ipcMain.handle(PROJECT_READ_CHUNK, (_event, id: string) => projects.readChunk(id));
  ipcMain.handle(PROJECT_END_READ, (_event, id: string) => projects.endRead(id));

  ipcMain.handle(PROJECT_BEGIN_WRITE, (_event, path: string) => projects.beginWrite(path));
  ipcMain.handle(PROJECT_WRITE_CHUNK, (_event, id: string, chunk: Uint8Array) =>
    // Re-wrapped: the value arriving from structured clone may be a view onto
    // a larger buffer, and `write` would otherwise send the whole thing.
    projects.writeChunk(id, new Uint8Array(chunk)),
  );
  ipcMain.handle(PROJECT_FINISH_WRITE, async (_event, id: string) => {
    const result = await projects.finishWrite(id);
    return result;
  });
  ipcMain.handle(PROJECT_ABORT_WRITE, (_event, id: string) => projects.abortWrite(id));

  ipcMain.on(SHELL_STATE, (_event, state: ShellState) => {
    const before = shellState;
    shellState = state;
    // Rebuilding a menu is cheap but not free, and this fires on every
    // selection change; only the fields the menu reads justify a rebuild.
    if (
      before.canUndo !== state.canUndo ||
      before.canRedo !== state.canRedo ||
      before.hasSelection !== state.hasSelection ||
      before.showGrid !== state.showGrid
    ) {
      applyMenu();
    }
    if (
      before.dirty !== state.dirty ||
      before.savedPath !== state.savedPath ||
      before.title !== state.title
    ) {
      applyTitle();
    }
  });
}

async function startUp(): Promise<void> {
  ipcMain.on(API_BASE_CHANNEL, (event) => {
    const status = sidecar.status;
    // Synchronous by contract with the preload; the window is only created
    // after the sidecar is ready, so this is never the empty string in
    // practice — but a restart-in-progress reload should not deadlock either.
    event.returnValue = status.state === 'ready' ? status.baseUrl : '';
  });

  sidecar.onStatus(publishStatus);

  try {
    await sidecar.start();
  } catch (caught) {
    const reason = caught instanceof Error ? caught.message : String(caught);
    dialog.showErrorBox('FigureForge could not start', reason);
    app.exit(1);
    return;
  }

  await loadRecent();
  registerProjectHandlers();
  applyMenu();

  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Ask before throwing away unsaved work.
 *
 * The web build has had a `beforeunload` guard since round 51, but it can only
 * ever be a generic, unstyled prompt that cannot save on the user's behalf
 * afterwards — the browser writes the wording and offers two outcomes. A shell
 * can name the figure and run the save, so it does.
 *
 * This is the *quit* guard specifically. Closing a figure without quitting is
 * the renderer's own `requestClose`, which draws the same three choices in the
 * app itself and is what the File ▸ Close File item reaches; it deliberately
 * does not come through here, or a close-triggered save would land on the same
 * one-shot `PROJECT_SAVED` channel `saveBeforeQuit` waits on.
 *
 * Returns true when the caller may proceed with quitting.
 */
async function confirmDiscard(): Promise<boolean> {
  if (!shellState.dirty || !mainWindow) return true;

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Save', "Don't Save", 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved changes',
    message: `Save changes to "${shellState.title}" before closing?`,
    detail: 'Your changes will be lost if you don’t save them.',
  });

  if (response === 1) return true; // Don't Save
  if (response === 2) return false; // Cancel

  return saveBeforeQuit();
}

/**
 * Run the renderer's own save and wait for it to land.
 *
 * The shell cannot serialise the document itself — the archive is built by the
 * renderer from state only it holds — so "Save" here means asking the app to
 * do exactly what its own Save does, then waiting for the answer. The timeout
 * exists because a hung renderer must not make the app unquittable; it resolves
 * false, which cancels the quit and leaves the user in charge rather than
 * discarding their work on a guess.
 */
function saveBeforeQuit(): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ipcMain.removeListener(PROJECT_SAVED, onSaved);
      resolve(false);
    }, 30_000);

    function onSaved(_event: unknown, ok: boolean): void {
      clearTimeout(timer);
      ipcMain.removeListener(PROJECT_SAVED, onSaved);
      // A save the user cancelled at the dialog is not permission to quit.
      resolve(ok);
    }

    ipcMain.on(PROJECT_SAVED, onSaved);
    sendCommand({ type: 'save' });
  });
}

/**
 * Teardown, wired to every path out.
 *
 * `before-quit` is the cooperative one and gets to await a graceful stop.
 * `process.on('exit')` cannot await anything, so it is a synchronous kill —
 * the last chance to avoid an orphaned Python holding a port and several
 * hundred megabytes of SciPy. Neither covers this process being SIGKILLed,
 * which is the hole the Python-side parent watchdog exists to close.
 */
function wireTeardown(): void {
  app.on('before-quit', (event) => {
    if (teardownStarted) return;
    // Always preventDefault first: both the unsaved-changes prompt and the
    // sidecar's graceful stop are asynchronous, and Electron would otherwise
    // tear the process down underneath them.
    event.preventDefault();
    void confirmDiscard().then((mayQuit) => {
      if (!mayQuit) return; // the user cancelled; the app stays up
      teardownStarted = true;
      void sidecar.stop().finally(() => app.quit());
    });
  });

  app.on('window-all-closed', () => {
    // macOS convention keeps the app alive with no windows; every other
    // platform quits, which routes through `before-quit` above.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && sidecar.status.state === 'ready') {
      mainWindow = createWindow();
    }
  });

  process.on('exit', () => sidecar.killNow());
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      sidecar.killNow();
      app.exit(0);
    });
  }
}

// A second instance would spawn a second sidecar and a second export browser
// pool, and the two would fight over the same project files.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  lockDown();
  wireTeardown();
  void app.whenReady().then(startUp);
}
