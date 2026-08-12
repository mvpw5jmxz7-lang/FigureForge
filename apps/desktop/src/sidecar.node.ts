/**
 * Real implementations of the effects `sidecar.ts` declares.
 *
 * Kept apart from the state machine so that file can stay import-free and
 * fully unit-testable — the same split as `ProjectFileSystem` (an interface
 * plus one real implementation) in the web app.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { SidecarDeps, SpawnedProcess } from './sidecar';

/** Health probes must not inherit a default that outlives the poll interval. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Ask the OS for a free port, then immediately give it back.
 *
 * There is an unavoidable race here: the port is free when we look and could
 * be taken before Python binds it. It is not worth engineering away — the
 * window is sub-millisecond, and it is already *covered*, because a sidecar
 * that never becomes healthy makes `PythonSidecar` discard the port and ask
 * for a new one. Passing an inherited file descriptor instead would remove the
 * race and cost a platform-specific launch path on every OS.
 *
 * Bound to 127.0.0.1 rather than 0.0.0.0 deliberately, and Python is told the
 * same: this service must not be reachable from the network. On a shared lab
 * machine a 0.0.0.0 bind would expose an unauthenticated export and image
 * decoder to anyone who could route to it.
 */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine a free port for the analysis service.'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export async function probe(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/health`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return response.ok;
}

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface PythonLaunch {
  command: string;
  args: readonly string[];
  cwd: string;
}

/**
 * Where the interpreter and the service live.
 *
 * Development runs the checked-out source through whatever Python is on PATH;
 * a packaged build will point at a bundled interpreter instead, which is why
 * this is one function rather than a literal at the spawn site. Both are
 * overridable by environment variable so the desktop shell can be pointed at
 * an arbitrary checkout without a rebuild.
 */
export function resolvePythonLaunch(appRoot: string): PythonLaunch {
  const cwd = process.env['FIGUREFORGE_API_DIR'] ?? join(appRoot, 'services', 'api');
  const command = process.env['FIGUREFORGE_PYTHON'] ?? 'python3';

  if (!existsSync(cwd)) {
    throw new Error(
      `Cannot find the analysis service at ${cwd}. ` +
        'Set FIGUREFORGE_API_DIR to the directory containing the figureforge package.',
    );
  }

  return { command, args: ['-m', 'figureforge.sidecar'], cwd };
}

/**
 * Spawn the service on `port`.
 *
 * The child is told our pid so it can terminate itself if we die without
 * getting the chance to kill it — a SIGKILL of this process runs no exit
 * handler, so the supervisor's own teardown cannot cover that case.
 */
export function makeSpawn(launch: PythonLaunch): SidecarDeps['spawn'] {
  return (port: number): SpawnedProcess => {
    const child = nodeSpawn(
      launch.command,
      [
        ...launch.args,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--parent-pid',
        String(process.pid),
      ],
      {
        cwd: launch.cwd,
        // Inheriting the parent's group is what lets a group kill reach the
        // child; a detached child would survive one.
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      },
    );

    return {
      get pid() {
        return child.pid;
      },
      onExit(listener) {
        child.once('exit', (code, signal) => listener(code, signal));
        // A command that does not exist never emits 'exit', only 'error'.
        child.once('error', (error) => listener(null, error.message));
      },
      onStderr(listener) {
        child.stderr?.on('data', (chunk: Buffer) => listener(chunk.toString('utf8')));
      },
      kill(signal) {
        child.kill(signal);
      },
    };
  };
}
