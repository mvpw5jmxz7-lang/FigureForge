/**
 * The recent-projects list.
 *
 * Pure list arithmetic plus a tolerant parser, so the interesting behaviour —
 * most-recent-first, no duplicates, bounded length, and a corrupt file that
 * does not take the menu down with it — is testable without touching disk.
 * The main process owns the array and persists it; `recent.node.ts` is the
 * two-line filesystem half.
 */

/**
 * Ten is the conventional depth, and this list is drawn as a submenu — a
 * longer one stops being scannable, which is the only thing it is for.
 */
export const MAX_RECENT = 10;

/** Most recent first, de-duplicated, bounded. */
export function addRecent(
  list: readonly string[],
  path: string,
  max: number = MAX_RECENT,
): string[] {
  // Re-opening a file already in the list should move it to the top rather
  // than add a second entry, so the filter runs before the unshift.
  return [path, ...list.filter((entry) => entry !== path)].slice(0, max);
}

export function removeRecent(list: readonly string[], path: string): string[] {
  return list.filter((entry) => entry !== path);
}

/**
 * Read the stored list, surviving anything the file might actually contain.
 *
 * A recent-files list is a convenience: a malformed or hand-edited file must
 * degrade to "no recents" rather than stop the app from starting, which is
 * what an uncaught parse error in menu construction would do.
 */
export function parseRecent(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function serialiseRecent(list: readonly string[]): string {
  return JSON.stringify(list, null, 2);
}
