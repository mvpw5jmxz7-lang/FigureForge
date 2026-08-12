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
