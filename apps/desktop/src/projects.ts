/**
 * Which paths the renderer is allowed to touch.
 *
 * Stage 1's bridge was three keys and reached no filesystem at all. Stage 2
 * has to hand the renderer real file access, and the honest way to do that is
 * *not* a `readFile(path)` the renderer can aim anywhere: `contextIsolation`
 * and `sandbox` exist because a figure document carries author-supplied text
 * and imported files, and a renderer that can read any path is one bug away
 * from reading `~/.ssh/id_rsa`.
 *
 * So the main process only ever acts on a path **it produced itself** — a save
 * or open dialog it showed, an entry from its own recent list, or a file the
 * user physically dropped on the window. Those are recorded here, and every
 * read and write is checked against the record. The renderer can ask to reopen
 * something it was already given; it cannot invent a path.
 *
 * This module is pure so the rule can be tested directly. The `fs` calls live
 * in `projects.node.ts`, the same split `sidecar.ts`/`sidecar.node.ts` uses.
 */

/**
 * Extensions this app will open or overwrite.
 *
 * Hardcoded here rather than imported from `@figureforge/doc-model` on
 * purpose: this is the process that *validates* the renderer, so taking its
 * word for what counts as a project file would defeat the check. `apps/desktop`
 * also depends on nothing internal at runtime, which is what keeps the browser
 * build a first-class target. `projects.test.ts` imports the doc-model
 * constant at test time only, so the two cannot drift apart unnoticed.
 */
export const PROJECT_EXTENSIONS: readonly string[] = ['.ffg', '.figureforge'];

export function hasProjectExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return PROJECT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** The last path segment, for either separator. */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The set of paths this session has legitimately produced.
 *
 * Deliberately per-session and in memory. Persisting it would mean a path
 * authorised months ago still counts today, which is exactly the standing
 * grant this exists to avoid — the recent-files list re-authorises an entry at
 * the moment the user picks it, so nothing is lost by forgetting.
 */
export class AuthorisedPaths {
  private readonly paths = new Set<string>();

  /** Record a path the main process itself chose or was handed by the user. */
  grant(path: string): string {
    this.paths.add(path);
    return path;
  }

  has(path: string): boolean {
    return this.paths.has(path);
  }

  /**
   * Both checks, in the order that gives the more specific complaint first.
   *
   * Returns null when the path is fine, or a reason when it is not — a string
   * rather than a throw because every caller turns it into an IPC error
   * response, and an unauthorised path is an expected answer to a hostile
   * question, not an exceptional one.
   */
  refuse(path: string): string | null {
    if (!hasProjectExtension(path)) {
      return `Refusing a file that is not a FigureForge project: ${basename(path)}`;
    }
    if (!this.has(path)) {
      return 'Refusing a path this session did not open or save.';
    }
    return null;
  }

  /** Test seam; nothing in the app clears these. */
  clear(): void {
    this.paths.clear();
  }
}
