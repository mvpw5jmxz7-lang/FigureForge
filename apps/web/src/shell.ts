/**
 * The desktop shell's side of `window.figureforge`, declared once.
 *
 * Two modules need to know this exists — `api.ts` reads `apiBase()`, and
 * `desktopFiles.ts` uses the rest — and TypeScript will not merge two
 * `declare global` blocks that describe the same property differently. So the
 * declaration lives here and both import it.
 *
 * These shapes are duplicated from `apps/desktop/src/channels.ts` deliberately.
 * `apps/web` must not depend on `apps/desktop`, or the browser build would
 * inherit the shell and stop being a first-class target; the IPC channel
 * strings are the real contract between them, and the CDP smoke run is what
 * proves the two sides still agree. Everything here is optional, so a browser
 * build simply finds `window.figureforge` undefined and takes its own paths.
 */

/** A path the shell has authorised this session. */
export interface DesktopPath {
  path: string;
  name: string;
}

export interface DesktopProject {
  pickSave(suggestedName: string): Promise<DesktopPath | null>;
  pickOpen(): Promise<DesktopPath | null>;
  /** Authorise a recent entry, without moving any bytes. */
  resolve(path: string): Promise<DesktopPath>;
  /** Authorise a dropped file, resolving its path via `webUtils`. */
  resolveDropped(file: File): Promise<DesktopPath>;

  // Chunked I/O. A project runs to hundreds of megabytes, so it never crosses
  // the IPC boundary as one message; see `archive-stream.ts` for why.
  beginRead(path: string): Promise<{ id: string; name: string }>;
  /** Null at end of file. */
  readChunk(id: string): Promise<Uint8Array | null>;
  endRead(id: string): Promise<void>;
  beginWrite(path: string): Promise<string | 'denied'>;
  writeChunk(id: string, chunk: Uint8Array): Promise<void>;
  finishWrite(id: string): Promise<'written' | 'denied'>;
  abortWrite(id: string): Promise<void>;

  /** Only the shell's quit guard listens for this. */
  reportSaved(ok: boolean): void;
}

/** What the menu and the quit guard need to know about the renderer. */
export interface DesktopShellState {
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  showGrid: boolean;
  savedPath: string | null;
  title: string;
}

export type DesktopMenuCommand =
  | { type: 'new' }
  | { type: 'open' }
  | { type: 'open-path'; path: string }
  | { type: 'save' }
  | { type: 'save-as' }
  | { type: 'export'; format: 'svg' | 'pdf' | 'eps' | 'png' | 'tiff' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'duplicate' }
  | { type: 'delete' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'zoom-reset' }
  | { type: 'zoom-fit' }
  | { type: 'toggle-grid' };

declare global {
  interface Window {
    /** Injected by the Electron preload; absent in every browser build. */
    figureforge?: {
      readonly apiBase?: () => string;
      readonly isDesktop?: boolean;
      readonly platform?: string;
      readonly project?: DesktopProject;
      readonly setShellState?: (state: DesktopShellState) => void;
      /** Returns an unsubscribe function, so a React effect can clean up. */
      readonly onMenuCommand?: (listener: (command: DesktopMenuCommand) => void) => () => void;
    };
  }
}

/**
 * True only inside the shell.
 *
 * Re-evaluated per call rather than captured, the same discipline
 * `ProjectFileSystem.supported()` already follows: a cached feature detect is
 * what makes this untestable.
 */
export const isDesktop = (): boolean =>
  typeof window !== 'undefined' && window.figureforge?.isDesktop === true;
