/**
 * `PythonSidecar`'s failure paths.
 *
 * The happy path is the least interesting thing here — a service that starts
 * is a service nobody notices. What earns the tests is everything after: an
 * exit during startup, a health check that never passes, a crash mid-session,
 * a restart budget running out, and a stop that races a restart. Those are all
 * awkward to provoke against a real Python process and trivial against the
 * injected `spawn`/`probe`/`delay` this module is built to take, which is the
 * whole reason it takes them.
 */

import { describe, expect, it } from 'vitest';

import {
  PythonSidecar,
  baseUrlFor,
  type SidecarStatus,
  type SpawnedProcess,
} from './sidecar.js';

class FakeChild implements SpawnedProcess {
  readonly pid = 4242;
  readonly signals: string[] = [];
  private exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  private stderrListeners: ((chunk: string) => void)[] = [];
  /**
   * An exit that happened before anyone was listening.
   *
   * `child_process.spawn` returns before it can emit anything, so a real
   * supervisor always gets its listener attached in time — even for a process
   * that dies instantly. Replaying a buffered exit is what makes this fake
   * carry that same guarantee instead of silently dropping the event and
   * turning an immediate crash into a spurious timeout.
   */
  private pendingExit: { code: number | null; signal: string | null } | null = null;
  private pendingStderr = '';

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
    const pending = this.pendingExit;
    if (pending) listener(pending.code, pending.signal);
  }
  onStderr(listener: (chunk: string) => void): void {
    this.stderrListeners.push(listener);
    // Buffered for the same reason as `pendingExit`: a real child's stderr
    // arrives on the event loop, never inside the spawn call itself, so
    // output produced "before" the listener must still reach it.
    const buffered = this.pendingStderr;
    this.pendingStderr = '';
    if (buffered) listener(buffered);
  }
  kill(signal: 'SIGTERM' | 'SIGKILL'): void {
    this.signals.push(signal);
  }

  /** Test-side triggers. */
  emitStderr(text: string): void {
    if (this.stderrListeners.length === 0) {
      this.pendingStderr += text;
      return;
    }
    for (const listener of this.stderrListeners) listener(text);
  }
  emitExit(code: number | null, signal: string | null = null): void {
    if (this.exitListeners.length === 0) {
      this.pendingExit = { code, signal };
      return;
    }
    for (const listener of this.exitListeners) listener(code, signal);
  }
}

interface Harness {
  sidecar: PythonSidecar;
  children: FakeChild[];
  ports: number[];
  statuses: SidecarStatus[];
  /** Flip to make every subsequent health probe succeed (or fail). */
  setHealthy(value: boolean): void;
}

function harness(
  options: {
    healthy?: boolean;
    maxRestarts?: number;
    onSpawn?: (child: FakeChild, index: number) => void;
  } = {},
): Harness {
  const children: FakeChild[] = [];
  const ports: number[] = [];
  const statuses: SidecarStatus[] = [];
  let healthy = options.healthy ?? true;
  let nextPort = 45000;

  const sidecar = new PythonSidecar(
    {
      spawn: (port) => {
        ports.push(port);
        const child = new FakeChild();
        children.push(child);
        options.onSpawn?.(child, children.length - 1);
        return child;
      },
      probe: () => Promise.resolve(healthy),
      allocatePort: () => Promise.resolve(nextPort++),
      // Resolving immediately keeps the poll loops instant: the logic counts
      // attempts, it does not measure wall time.
      delay: () => Promise.resolve(),
    },
    {
      readyTimeoutMs: 100,
      probeIntervalMs: 10,
      restartDelayMs: 0,
      stopGraceMs: 30,
      maxRestarts: options.maxRestarts ?? 3,
    },
  );

  sidecar.onStatus((status) => statuses.push(status));
  return {
    sidecar,
    children,
    ports,
    statuses,
    setHealthy: (value) => {
      healthy = value;
    },
  };
}

/** Let queued microtasks and immediate timers settle. */
async function flush(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('PythonSidecar', () => {
  describe('starting', () => {
    it('resolves the loopback base URL once health answers', async () => {
      const { sidecar, ports } = harness();
      const url = await sidecar.start();

      expect(url).toBe(baseUrlFor(ports[0]!));
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(sidecar.status).toEqual({ state: 'ready', baseUrl: url, port: ports[0] });
    });

    it('waits for health rather than assuming a spawn is a service', async () => {
      let probes = 0;
      const sidecar = new PythonSidecar(
        {
          spawn: () => new FakeChild(),
          // Unhealthy for the first three polls: a fixed sleep would either
          // resolve too early here or waste time in the common case.
          probe: () => Promise.resolve(++probes > 3),
          allocatePort: () => Promise.resolve(51000),
          delay: () => Promise.resolve(),
        },
        { readyTimeoutMs: 100, probeIntervalMs: 10 },
      );

      await expect(sidecar.start()).resolves.toBe(baseUrlFor(51000));
      expect(probes).toBe(4);
    });

    it('fails fast when the child exits during startup, quoting its stderr', async () => {
      const { sidecar, children } = harness({
        healthy: false,
        onSpawn: (child) => {
          child.emitStderr("ModuleNotFoundError: No module named 'scipy'");
          child.emitExit(1);
        },
      });

      await expect(sidecar.start()).rejects.toThrow(/stopped during startup \(exit code 1\)/);
      // Reported, not swallowed: without it the user sees a generic timeout for
      // a problem Python already explained precisely.
      await expect(sidecar.start()).rejects.toThrow(/No module named 'scipy'/);
      expect(children).toHaveLength(2);
    });

    it('gives up after the ready timeout and kills what it spawned', async () => {
      const { sidecar, children } = harness({ healthy: false });

      await expect(sidecar.start()).rejects.toThrow(/did not respond within/);
      // Leaving it running is how a failed start becomes an orphan holding a port.
      expect(children[0]!.signals).toContain('SIGKILL');
    });

    it('asks for a fresh port after a failed start', async () => {
      const { sidecar, ports, setHealthy } = harness({ healthy: false });

      await expect(sidecar.start()).rejects.toThrow();
      setHealthy(true);
      await sidecar.start();

      // A port that never produced a healthy service is the prime suspect for
      // why, so it is not reused.
      expect(ports[1]).not.toBe(ports[0]);
    });
  });

  describe('crash recovery', () => {
    it('restarts an unexpected exit and comes back ready', async () => {
      const { sidecar, children, statuses } = harness();
      await sidecar.start();

      children[0]!.emitExit(null, 'SIGSEGV');
      await flush();

      expect(children).toHaveLength(2);
      expect(sidecar.status.state).toBe('ready');
      expect(statuses.some((s) => s.state === 'failed')).toBe(false);
    });

    it('reuses the port across a restart so the renderer stays pointed at it', async () => {
      const { sidecar, children, ports } = harness();
      await sidecar.start();

      children[0]!.emitExit(0);
      await flush();

      expect(ports[1]).toBe(ports[0]);
    });

    it('reports failure once the restart budget is spent', async () => {
      const { sidecar, children, setHealthy } = harness({ maxRestarts: 2 });
      await sidecar.start();

      setHealthy(false);
      children[0]!.emitExit(1);
      await flush(40);

      const status = sidecar.status;
      expect(status.state).toBe('failed');
      // The count in the message has to match the attempts actually made, or
      // it is a claim nothing backs.
      expect(status.state === 'failed' && status.reason).toMatch(/after 2 attempts/);
      expect(children.length).toBe(3);
    });

    it('counts a restart that never becomes healthy against the budget', async () => {
      // The distinction that matters: a service dying on every spawn must not
      // report "could not be restarted after 3 attempts" having tried once.
      const { sidecar, children, setHealthy } = harness({ maxRestarts: 3 });
      await sidecar.start();
      setHealthy(false);

      children[0]!.emitExit(1);
      await flush(60);

      expect(sidecar.status.state).toBe('failed');
      expect(children).toHaveLength(4);
    });
  });

  describe('stopping', () => {
    it('escalates to SIGKILL when SIGTERM is ignored', async () => {
      const { sidecar, children } = harness();
      await sidecar.start();

      await sidecar.stop();

      expect(children[0]!.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(sidecar.status).toEqual({ state: 'stopped' });
    });

    it('does not escalate when the process goes on SIGTERM', async () => {
      const { sidecar, children } = harness();
      await sidecar.start();

      const child = children[0]!;
      child.onExit(() => undefined);
      // Exit as soon as the term arrives, the way a healthy process does.
      const originalKill = child.kill.bind(child);
      child.kill = (signal) => {
        originalKill(signal);
        if (signal === 'SIGTERM') child.emitExit(0, 'SIGTERM');
      };

      await sidecar.stop();
      expect(child.signals).toEqual(['SIGTERM']);
    });

    it('never restarts after an intentional stop', async () => {
      const { sidecar, children } = harness();
      await sidecar.start();

      await sidecar.stop();
      // A crash notification arriving after the stop must not resurrect it —
      // quitting the app would otherwise race the supervisor.
      children[0]!.emitExit(null, 'SIGKILL');
      await flush();

      expect(children).toHaveLength(1);
      expect(sidecar.status).toEqual({ state: 'stopped' });
    });

    it('is safe to call with nothing running, more than once', async () => {
      const { sidecar } = harness();
      await expect(sidecar.stop()).resolves.toBeUndefined();
      await expect(sidecar.stop()).resolves.toBeUndefined();
      // Wired to several shutdown signals that do not all fire in every path,
      // so being called twice is the normal case, not the edge case.
      expect(() => sidecar.killNow()).not.toThrow();
    });

    it('killNow suppresses the restart path', async () => {
      const { sidecar, children } = harness();
      await sidecar.start();

      sidecar.killNow();
      children[0]!.emitExit(null, 'SIGKILL');
      await flush();

      expect(children).toHaveLength(1);
    });
  });

  describe('status reporting', () => {
    it('announces starting then ready, and unsubscribes cleanly', async () => {
      const { sidecar, statuses } = harness();
      await sidecar.start();

      expect(statuses.map((s) => s.state)).toEqual(['starting', 'ready']);

      const seen: SidecarStatus[] = [];
      const off = sidecar.onStatus((s) => seen.push(s));
      off();
      await sidecar.stop();
      expect(seen).toEqual([]);
    });
  });
});
