/**
 * The folder Open and Save dialogs start in.
 *
 * The pure half — a tolerant parser and a serialiser — so the interesting
 * behaviour is testable without touching disk. `main.ts` owns the value and
 * persists it beside the recent list, exactly as it does for `recent.ts`.
 *
 * Stored as `{ "path": "…" }` rather than a bare string. A wrapping object
 * costs nothing, makes the corrupt-file cases meaningful (a bare `"/x"` is
 * a valid JSON string, so a bare-string format could not tell a real value
 * from a mangled file), and leaves room for a sibling field later without a
 * migration.
 */

import { isAbsolute } from 'node:path';

/**
 * Read the stored directory, surviving anything the file might contain.
 *
 * A working directory is a convenience: a malformed or hand-edited file must
 * degrade to "no working directory" rather than stop the app from starting,
 * which is what an uncaught parse error during `startUp` would do. Same stance
 * as `parseRecent`.
 *
 * The absolute-path test is a cheap guard on a hand-edited file, not a
 * security control — the value is composed into a dialog's `defaultPath` and
 * is never opened, read or authorised, so a wrong one is at worst a dialog
 * that starts somewhere unhelpful. Deliberately *not* checked for existence:
 * a folder on a network share that is temporarily unmounted must not silently
 * forget itself.
 */
export function parseWorkingDirectory(json: string): string | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const path = (parsed as { path?: unknown }).path;
    if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return null;
    return path;
  } catch {
    return null;
  }
}

export function serialiseWorkingDirectory(path: string | null): string {
  return JSON.stringify({ path }, null, 2);
}
