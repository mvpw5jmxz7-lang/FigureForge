/**
 * Lifecycle management for the Python sidecar.
 *
 * In the browser build the API is a service the user already started; on the
 * desktop it is a child process this app owns from spawn to reap. CLAUDE.md's
 * risk table calls this out specifically — "Python bundled as a sidecar process
 * with lifecycle management — real work, not a wrapper" — and the work is
 * almost entirely in the failure paths:
 *
 *   * **Ready means ready.** `start()` resolves only once `/health` has
 *     actually answered. Sleeping a fixed interval and hoping is the classic
 *     way to ship a race that reproduces only on a slow machine.
 *   * **A crash is visible.** An unexpected exit restarts the process with a
 *     backoff and, once the attempts are spent, reports `failed` rather than
 *     leaving a dead API behind a live window — every statistics run and every
 *     export would fail one by one with no stated cause.
 *   * **Startup failure fails fast.** If the child exits *during* the health
 *     poll there is nothing left to become healthy, so the poll stops there
 *     instead of waiting out the full timeout.
 *   * **An intentional stop never restarts.** Quitting the app must not race
 *     the supervisor into spawning a replacement.
 *   * **Nothing is left running.** `stop()` escalates SIGTERM to SIGKILL after
 *     a grace period. That covers a *cooperative* exit; it cannot cover this
 *     process being SIGKILLed itself, which is why the Python side carries its
 *     own parent watchdog (`figureforge.sidecar`). The two are deliberately
 *     independent: either one alone leaves a hole.
 *
 * This module imports nothing — every effect (spawning, probing, allocating a
 * port, waiting) arrives as an injected function. That is the same discipline
 * `ProjectFileSystem` already follows in the web app, and for the same reason:
 * the interesting behaviour here is a state machine over failures that are
 * awkward to provoke with a real Python process, and a test that cannot
 * provoke them is not testing the part that matters.
 */

/** A spawned child, narrowed to what the supervisor actually uses. */
export interface SpawnedProcess {
  readonly pid: number | undefined;
  /** Fired once, when the process has exited. */
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  /** Diagnostic output, kept so a startup failure can say what Python said. */
  onStderr(listener: (chunk: string) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export type SpawnFn = (port: number) => SpawnedProcess;

/** Resolves true when the service answers its health endpoint. */
export type ProbeFn = (baseUrl: string) => Promise<boolean>;

export interface SidecarDeps {
  spawn: SpawnFn;
  probe: ProbeFn;
  /** An unused TCP port. Re-requested only when a previous one stops working. */
  allocatePort: () => Promise<number>;
  delay: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface SidecarOptions {
  /** How long a spawn has to answer `/health` before it counts as failed. */
  readyTimeoutMs?: number;
  probeIntervalMs?: number;
  /** Unexpected exits to absorb before giving up. */
  maxRestarts?: number;
  restartDelayMs?: number;
  /** Grace between SIGTERM and SIGKILL when stopping. */
  stopGraceMs?: number;
}

export type SidecarStatus =
  | { state: 'stopped' }
  | { state: 'starting'; attempt: number }
  | { state: 'ready'; baseUrl: string; port: number }
  | { state: 'failed'; reason: string };

const DEFAULTS = {
  readyTimeoutMs: 30_000,
  probeIntervalMs: 150,
  maxRestarts: 3,
  restartDelayMs: 500,
  stopGraceMs: 3_000,
} as const;

/** Keep only the tail: a Python traceback is useful, megabytes of it are not. */
const STDERR_KEEP = 4_000;

export const baseUrlFor = (port: number): string => `http://127.0.0.1:${port}`;

export class PythonSidecar {
  private readonly deps: SidecarDeps;
  private readonly options: Required<SidecarOptions>;

  private child: SpawnedProcess | null = null;
  private childExit: { code: number | null; signal: string | null } | null = null;
  private stderr = '';

  /** Reused across restarts: a port this process already owned is very likely
   *  still free, and holding it steady keeps the renderer's API base valid. */
  private port: number | null = null;

  private state: SidecarStatus = { state: 'stopped' };
  private readonly listeners = new Set<(status: SidecarStatus) => void>();

  /** Set by `stop()`, and the one thing that suppresses the restart path. */
  private stopping = false;
  private restarts = 0;

  constructor(deps: SidecarDeps, options: SidecarOptions = {}) {
    this.deps = deps;
    this.options = { ...DEFAULTS, ...options };
  }

  get status(): SidecarStatus {
    return this.state;
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  onStatus(listener: (status: SidecarStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Spawn the service and resolve its base URL once it answers.
   *
   * Rejects if the process cannot be brought up; it does *not* fall back to a
   * degraded mode, because every caller of this URL needs a real service and a
   * silent half-start would surface later as unexplained per-feature failures.
   */
  async start(): Promise<string> {
    this.stopping = false;
    this.restarts = 0;
    return this.launch(1);
  }

  private async launch(attempt: number): Promise<string> {
    this.setStatus({ state: 'starting', attempt });

    const port = this.port ?? (await this.deps.allocatePort());
    this.port = port;
    const baseUrl = baseUrlFor(port);

    this.stderr = '';
    this.childExit = null;

    const child = this.deps.spawn(port);
    this.child = child;
    child.onStderr((chunk) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    child.onExit((code, signal) => {
      this.childExit = { code, signal };
      this.handleExit(child, code, signal);
    });

    try {
      await this.waitForReady(baseUrl);
    } catch (caught) {
      // The port is the prime suspect when a spawn never becomes healthy —
      // something else may have taken it between allocation and bind. Drop it
      // so the next attempt asks for a fresh one.
      this.port = null;
      // `killChild`, not `killNow`: this is cleaning up one failed attempt,
      // not deciding the supervisor is done. Marking `stopping` here would
      // silently suppress both the remaining restart budget and the report
      // that the budget had been spent.
      this.killChild(child);
      throw caught;
    }

    this.setStatus({ state: 'ready', baseUrl, port });
    return baseUrl;
  }

  private async waitForReady(baseUrl: string): Promise<void> {
    const { readyTimeoutMs, probeIntervalMs } = this.options;
    const attempts = Math.max(1, Math.ceil(readyTimeoutMs / probeIntervalMs));

    for (let i = 0; i < attempts; i++) {
      // Checked before probing as well as after waiting: a process that failed
      // to bind its port is usually gone before the first probe is even sent.
      if (this.childExit) {
        throw new Error(this.exitMessage(this.childExit));
      }
      if (await this.probeQuietly(baseUrl)) return;
      await this.deps.delay(probeIntervalMs);
    }

    if (this.childExit) throw new Error(this.exitMessage(this.childExit));
    throw new Error(
      `The analysis service did not respond within ${Math.round(readyTimeoutMs / 1000)}s.` +
        this.stderrSuffix(),
    );
  }

  /** A probe that throws is just a service that is not up yet. */
  private async probeQuietly(baseUrl: string): Promise<boolean> {
    try {
      return await this.deps.probe(baseUrl);
    } catch {
      return false;
    }
  }

  private exitMessage(exit: { code: number | null; signal: string | null }): string {
    const how =
      exit.signal !== null ? `signal ${exit.signal}` : `exit code ${exit.code ?? 'unknown'}`;
    return `The analysis service stopped during startup (${how}).` + this.stderrSuffix();
  }

  private stderrSuffix(): string {
    const trimmed = this.stderr.trim();
    return trimmed ? `\n\n${trimmed}` : '';
  }

  /**
   * An exit we did not ask for. Restart with a backoff, and once the budget is
   * spent say so — the alternative is a window whose every server-backed
   * feature fails separately with no shared explanation.
   */
  private handleExit(child: SpawnedProcess, code: number | null, signal: string | null): void {
    // A process we already replaced; its exit says nothing about the current one.
    if (this.child !== child) return;
    this.child = null;

    if (this.stopping) {
      this.setStatus({ state: 'stopped' });
      return;
    }
    // Startup failures are reported by `launch`, which is still awaiting.
    if (this.state.state === 'starting') return;

    const how = signal !== null ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    this.deps.log?.(`sidecar exited unexpectedly (${how})`);
    this.scheduleRestart(`The analysis service stopped unexpectedly (${how}).`);
  }

  /**
   * Try again, or report that we are out of tries.
   *
   * Recursive through its own catch so that a restart which *fails to come
   * up* consumes the budget too. Counting only crash-after-ready would let a
   * service that dies on every spawn report failure after a single attempt
   * while claiming a budget of three.
   */
  private scheduleRestart(reason: string): void {
    if (this.stopping) return;

    if (this.restarts >= this.options.maxRestarts) {
      this.setStatus({
        state: 'failed',
        reason:
          `${reason} It could not be restarted after ${this.options.maxRestarts} attempts.` +
          this.stderrSuffix(),
      });
      return;
    }

    this.restarts += 1;
    const attempt = this.restarts + 1;
    void this.deps
      .delay(this.options.restartDelayMs)
      .then(() => {
        // `stop()` may have arrived while we were waiting out the backoff.
        if (this.stopping) return;
        return this.launch(attempt).then(() => undefined);
      })
      .catch((caught: unknown) => {
        this.scheduleRestart(caught instanceof Error ? caught.message : String(caught));
      });
  }

  /**
   * Terminate the service and stay terminated. Safe to call more than once and
   * safe to call when nothing is running, because it is wired to several
   * shutdown signals that do not all fire in every exit path.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) {
      this.setStatus({ state: 'stopped' });
      return;
    }

    child.kill('SIGTERM');

    const { stopGraceMs, probeIntervalMs } = this.options;
    const attempts = Math.max(1, Math.ceil(stopGraceMs / probeIntervalMs));
    for (let i = 0; i < attempts; i++) {
      if (this.childExit) break;
      await this.deps.delay(probeIntervalMs);
    }

    if (!this.childExit) {
      this.deps.log?.('sidecar ignored SIGTERM; sending SIGKILL');
      child.kill('SIGKILL');
    }

    this.child = null;
    this.setStatus({ state: 'stopped' });
  }

  /**
   * Best-effort synchronous teardown, for exit paths that cannot await —
   * `process.on('exit')` is the one that matters. Unlike `killChild` this
   * *does* latch `stopping`, because it means the app is going away.
   */
  killNow(): void {
    this.stopping = true;
    this.killChild(this.child);
  }

  private killChild(child: SpawnedProcess | null): void {
    if (!child) return;
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone; nothing to clean up.
    }
    if (this.child === child) this.child = null;
  }

  private setStatus(status: SidecarStatus): void {
    this.state = status;
    for (const listener of this.listeners) listener(status);
  }
}
