/**
 * Drive the real Electron shell and assert on it.
 *
 * The unit tests cover the sidecar's state machine against injected doubles;
 * this covers everything those cannot reach — that Electron actually boots,
 * that the preload's narrow bridge arrives in a renderer with Node switched
 * off, that the port in the renderer belongs to a Python process that really
 * is answering, and that quitting leaves nothing behind.
 *
 * Driven over the Chrome DevTools Protocol rather than through Playwright:
 * Electron already speaks CDP with `--remote-debugging-port`, and Node 22 has
 * both `fetch` and `WebSocket` built in, so the alternative was a new
 * JavaScript dependency for a websocket and a wrapper this file uses four
 * methods of. The same "avoid the dependency where the protocol is small and
 * published" stance already on record for log-rank and PCA.
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const ELECTRON = process.env.FIGUREFORGE_ELECTRON_BIN;
const DEBUG_PORT = 9222;
const MAIN = 'apps/desktop/dist/main.js';

let failures = 0;
let checks = 0;
let threw = false;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

/** Every live process whose command line mentions the sidecar module. */
function sidecarPids() {
  const pids = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (cmdline.includes('figureforge.sidecar')) pids.push(Number(entry));
    } catch {
      // The process exited while we were reading it; it is not running now,
      // which is the only thing this function is asked about.
    }
  }
  return pids;
}

// --- a minimal CDP client -------------------------------------------------

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async attach(port) {
    const targets = await waitFor('a debuggable page', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      return page ?? null;
    });

    const client = new Cdp();
    await client.#connect(targets.webSocketDebuggerUrl);
    return client;
  }

  #connect(url) {
    return new Promise((resolve, reject) => {
      this.#socket = new WebSocket(url);
      this.#socket.addEventListener('open', () => resolve());
      this.#socket.addEventListener('error', () => reject(new Error('CDP socket failed')));
      this.#socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        pending(message);
      });
    });
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate in the page and return the value, or throw what the page threw. */
  async evaluate(expression) {
    const message = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const result = message.result;
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
    }
    return result?.result?.value;
  }

  close() {
    this.#socket?.close();
  }
}

/**
 * The bridge widened in stage 2 to reach real files. This is the check that it
 * did not widen into an arbitrary file reader.
 *
 * `projects.test.ts` asserts the rule itself; this asserts the *wiring* — that
 * a renderer really is refused across the IPC boundary, which is the only
 * place the two halves meet. Both halves matter: a correct rule that nothing
 * calls protects nothing.
 */
async function checkFileAccessIsFenced(cdp) {
  const refused = async (label, expression) => {
    const answer = await cdp.evaluate(
      `${expression}.then((r) => 'ALLOWED:' + JSON.stringify(r)).catch((e) => String(e.message ?? e))`,
    );
    check(label, !String(answer).includes('ALLOWED'), String(answer).slice(0, 90));
  };

  // Reads a path the shell never handed out. A renderer that could do this
  // could read anything the user can.
  await refused(
    'reading an arbitrary path is refused',
    `window.figureforge.project.beginRead('/etc/passwd')`,
  );

  // Right extension, still never authorised — the case the extension check
  // alone would let through.
  await refused(
    'reading an unauthorised project path is refused',
    `window.figureforge.project.beginRead('/tmp/not-mine.ffg')`,
  );

  await refused(
    'writing to an unauthorised path is refused',
    `window.figureforge.project.beginWrite('/tmp/not-mine.ffg')`,
  );

  // `resolve` is the recent-list entry point. Naming a path the shell has
  // never heard of must not authorise it, or the fence has a gate in it.
  await refused(
    'resolving an unknown path is refused',
    `window.figureforge.project.resolve('/tmp/not-mine.ffg')`,
  );

  // A fabricated File yields an empty path from `webUtils`, which is how the
  // shell tells a real drop from a renderer pretending to have had one.
  await refused(
    'a fabricated drop is refused',
    `window.figureforge.project.resolveDropped(new File([], 'x.ffg'))`,
  );

  // The renderer pushing its state must not throw; the menu and the quit guard
  // both read it, and a throw here would break every later state change.
  const pushed = await cdp.evaluate(
    `(() => { try { window.figureforge.setShellState({ dirty: false, canUndo: true,` +
      ` canRedo: false, hasSelection: false, showGrid: false, savedPath: null,` +
      ` title: 'smoke' }); return 'ok'; } catch (e) { return String(e); } })()`,
  );
  check('the renderer can push shell state', pushed === 'ok', String(pushed).slice(0, 80));
}

/**
 * The case the supervisor cannot cover.
 *
 * A SIGTERM lets the main process run its teardown, which is what the first
 * phase exercises. SIGKILL runs nothing at all — so if the sidecar still goes
 * away, that can only be the Python-side parent watchdog doing it. Without
 * that watchdog this is exactly how a crashed session leaves a few hundred
 * megabytes of SciPy holding a port until the machine is rebooted.
 */
async function hardKillLeavesNoOrphan() {
  const child = spawn(ELECTRON, ['--no-sandbox', MAIN], { stdio: 'ignore' });

  const before = await waitFor(
    'a sidecar to be running',
    () => (sidecarPids().length === 1 ? sidecarPids()[0] : null),
    { timeoutMs: 60_000 },
  );

  child.kill('SIGKILL');
  await waitFor('electron to die', () => child.exitCode !== null || child.signalCode !== null);
  check('SIGKILL leaves the sidecar momentarily orphaned', sidecarPids().includes(before));

  const reaped = await waitFor(
    'the watchdog to reap the orphan',
    () => (sidecarPids().length === 0 ? 'gone' : null),
    // Generous against the watchdog's 1s poll: the assertion is that it
    // happens at all, not that it happens on a particular tick.
    { timeoutMs: 20_000, intervalMs: 500 },
  ).catch(() => null);

  check(
    'the parent watchdog reaps the sidecar after an uncatchable kill',
    reaped === 'gone',
    `pids ${sidecarPids()}`,
  );
}

// --- the run --------------------------------------------------------------

async function main() {
  if (!ELECTRON) throw new Error('FIGUREFORGE_ELECTRON_BIN is not set');

  check('no sidecar is running before launch', sidecarPids().length === 0);

  const child = spawn(
    ELECTRON,
    ['--no-sandbox', `--remote-debugging-port=${DEBUG_PORT}`, MAIN],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  child.stdout.on('data', (b) => process.stdout.write(`  [main] ${b}`));
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });

  let cdp;
  try {
    try {
      cdp = await Cdp.attach(DEBUG_PORT);
    } catch (error) {
      threw = true;
      throw error;
    }

    // The window is created only after the sidecar answers, so a page
    // existing at all is already evidence the supervisor got that far.
    check('a renderer window exists', true);

    await waitFor('the app to mount', () =>
      cdp.evaluate("document.querySelector('.canvas-page') !== null"),
    );
    check('the React app mounted', true);

    const bridge = await cdp.evaluate(
      'JSON.stringify({ isDesktop: window.figureforge?.isDesktop,' +
        ' base: window.figureforge?.apiBase?.(),' +
        ' keys: Object.keys(window.figureforge ?? {}).sort(),' +
        ' hasRequire: typeof window.require,' +
        ' hasProcess: typeof window.process })',
    );
    const info = JSON.parse(bridge);

    check('the preload bridge reached the renderer', info.isDesktop === true);
    check(
      'the API base is a loopback URL with a real port',
      /^http:\/\/127\.0\.0\.1:\d+$/.test(info.base ?? ''),
      info.base,
    );
    // Node must not be reachable from the page: contextIsolation and sandbox
    // are the only things standing between an imported figure and the shell.
    check('nodeIntegration is off', info.hasRequire === 'undefined');
    check('the renderer has no process global', info.hasProcess === 'undefined');
    check(
      'the bridge exposes only what it means to',
      JSON.stringify(info.keys) ===
        JSON.stringify([
          'apiBase',
          'isDesktop',
          'onMenuCommand',
          'platform',
          'project',
          'setShellState',
        ]),
      info.keys?.join(', '),
    );

    await checkFileAccessIsFenced(cdp);

    // The port is meaningless unless something is actually behind it.
    const health = await fetch(`${info.base}/health`);
    const payload = await health.json();
    check('the sidecar answers /health on that port', health.ok && payload.status === 'ok');
    check(
      'it is the real service, not a stub',
      typeof payload.versions?.scipy === 'string',
      `scipy ${payload.versions?.scipy}`,
    );

    // The renderer reaching the service cross-origin is the thing the web
    // build never exercises, because Vite proxies it same-origin.
    const fromRenderer = await cdp.evaluate(
      `fetch(window.figureforge.apiBase() + '/health').then(r => r.ok)`,
    );
    check('the renderer can reach the sidecar cross-origin', fromRenderer === true);

    const running = sidecarPids();
    check('exactly one sidecar process is running', running.length === 1, `pids ${running}`);

    // --- teardown -------------------------------------------------------
    cdp.close();
    child.kill('SIGTERM');
    await waitFor('electron to exit', () => child.exitCode !== null || child.signalCode !== null);

    const orphans = await waitFor(
      'the sidecar to be reaped',
      () => (sidecarPids().length === 0 ? 'gone' : null),
      { timeoutMs: 15_000 },
    ).catch(() => null);
    check('no orphaned Python process survives the shell', orphans === 'gone', `pids ${sidecarPids()}`);

    await hardKillLeavesNoOrphan();
  } finally {
    cdp?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    // Printed whenever anything at all went wrong, including a thrown timeout
    // rather than only a failed check. Gating this on the check count once hid
    // a main-process stack trace behind "timed out waiting for a debuggable
    // page", which named the symptom and none of the cause.
    if ((failures > 0 || threw) && stderr.trim()) {
      const noise = /dbus|Failed to call method|GLib|libva/;
      const interesting = stderr
        .split('\n')
        .filter((line) => line.trim() && !noise.test(line))
        .join('\n');
      if (interesting) console.log(`\n--- electron stderr ---\n${interesting}`);
    }
  }
}

main()
  .then(() => {
    console.log(`\n${checks - failures}/${checks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(`\nsmoke run failed: ${error.message}`);
    process.exit(1);
  });
