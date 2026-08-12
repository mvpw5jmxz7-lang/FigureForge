/**
 * The entire surface the renderer gets from the desktop shell.
 *
 * Deliberately tiny. `contextIsolation` and `sandbox` are both on, so this is
 * the only channel between the web app and Node, and every addition to it is a
 * permanent widening of what a compromised renderer can reach. Today it says
 * where the API is and nothing else — no filesystem, no process, no shell.
 *
 * Sandboxed preloads must be CommonJS, which is why this package compiles to
 * CJS rather than following the ESM the rest of the repo uses. They also get a
 * `require` that resolves only a short allow-list of Electron's own modules —
 * never a relative path — so this file is *bundled* by esbuild rather than
 * shipped as tsc's output. Without that, the `./channels` import below throws
 * at load and the bridge silently never installs: the window still opens and
 * the app still mounts, so nothing looks wrong until the first API call finds
 * no base URL. Keeping the bundle is what lets the channel name have exactly
 * one definition instead of a literal duplicated on both sides of the IPC.
 */

import { contextBridge, ipcRenderer } from 'electron';

import { API_BASE_CHANNEL } from './channels';

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
});
