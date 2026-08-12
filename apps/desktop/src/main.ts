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

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { API_BASE_CHANNEL } from './channels';
import { PythonSidecar, type SidecarStatus } from './sidecar';
import { allocatePort, delay, makeSpawn, probe, resolvePythonLaunch } from './sidecar.node';

/** Repo root in development: this file runs from apps/desktop/dist. */
const APP_ROOT = join(__dirname, '..', '..', '..');

const DEV_URL = process.env['FIGUREFORGE_DEV_URL'] ?? 'http://localhost:5173';

/** Set once the app is genuinely on its way out, to break the quit cycle. */
let teardownStarted = false;
let mainWindow: BrowserWindow | null = null;

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

  mainWindow = createWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
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
    event.preventDefault();
    teardownStarted = true;
    void sidecar.stop().finally(() => app.quit());
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
