/**
 * Document store: immutable edits, undo/redo, autosave hooks.
 *
 * Every mutation goes through `commit`, which produces the next document plus
 * a forward and inverse patch set. Undo/redo, version history and incremental
 * autosave are then all the same mechanism rather than three separate ones.
 */

import { applyPatches, enablePatches, produce, produceWithPatches, type Patch } from 'immer';
import type { FigureDocument } from './document.js';

enablePatches();

export interface Commit {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  timestamp: string;
}

export type Recipe = (draft: FigureDocument) => void;

/**
 * Apply a recipe outside the store, e.g. when building a document from scratch.
 *
 * The cast is deliberate: the document exposes its collections as `readonly` so
 * that ordinary code cannot mutate them by accident, but inside a `produce`
 * recipe mutation is exactly the point. Confining the cast here keeps every
 * call site honest.
 */
export function editDocument(doc: FigureDocument, recipe: Recipe): FigureDocument {
  return produce(doc, (draft) => {
    recipe(draft as FigureDocument);
  });
}

export interface StoreOptions {
  /** Cap on retained history. Older commits are dropped from the bottom. */
  historyLimit?: number;
  now?: () => string;
}

export type Listener = (doc: FigureDocument, commit: Commit | null) => void;

export class DocumentStore {
  private doc: FigureDocument;
  private undoStack: Commit[] = [];
  private redoStack: Commit[] = [];
  private listeners = new Set<Listener>();
  private readonly historyLimit: number;
  private readonly now: () => string;

  /** Depth of the open `transaction`, so nested calls collapse into one commit. */
  private txDepth = 0;
  private txPatches: Patch[] = [];
  private txInverse: Patch[] = [];
  private txLabel = '';

  constructor(initial: FigureDocument, options: StoreOptions = {}) {
    this.doc = initial;
    this.historyLimit = options.historyLimit ?? 200;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getDocument(): FigureDocument {
    return this.doc;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(commit: Commit | null): void {
    for (const listener of this.listeners) listener(this.doc, commit);
  }

  /**
   * Apply a mutation. Returns the commit, or null when the recipe changed
   * nothing — no-op edits must not consume an undo slot.
   */
  commit(label: string, recipe: Recipe): Commit | null {
    const [next, patches, inverse] = produceWithPatches(this.doc, (draft) => {
      recipe(draft as FigureDocument);
    });

    if (patches.length === 0) return null;

    this.doc = next;

    if (this.txDepth > 0) {
      this.txPatches.push(...patches);
      // Inverses must be replayed newest-first, so build the list in reverse.
      this.txInverse.unshift(...inverse);
      if (this.txLabel === '') this.txLabel = label;
      this.emit(null);
      return null;
    }

    const commit: Commit = { label, patches, inverse, timestamp: this.now() };
    this.pushUndo(commit);
    this.touchModified();
    this.emit(commit);
    return commit;
  }

  /**
   * Group several mutations into one undo step — a drag that moves five nodes
   * should undo as one action, not five.
   */
  transaction<T>(label: string, body: () => T): T {
    this.txDepth++;
    if (this.txDepth === 1) {
      this.txPatches = [];
      this.txInverse = [];
      this.txLabel = label;
    }

    try {
      return body();
    } finally {
      this.txDepth--;
      if (this.txDepth === 0 && this.txPatches.length > 0) {
        const commit: Commit = {
          label: this.txLabel || label,
          patches: this.txPatches,
          inverse: this.txInverse,
          timestamp: this.now(),
        };
        this.txPatches = [];
        this.txInverse = [];
        this.pushUndo(commit);
        this.touchModified();
        this.emit(commit);
      }
    }
  }

  private pushUndo(commit: Commit): void {
    this.undoStack.push(commit);
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    // Any new edit invalidates the redo branch.
    this.redoStack = [];
  }

  private touchModified(): void {
    this.doc = { ...this.doc, modifiedAt: this.now() };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): Commit | null {
    const commit = this.undoStack.pop();
    if (!commit) return null;
    this.doc = applyPatches(this.doc, commit.inverse);
    this.redoStack.push(commit);
    this.emit(commit);
    return commit;
  }

  redo(): Commit | null {
    const commit = this.redoStack.pop();
    if (!commit) return null;
    this.doc = applyPatches(this.doc, commit.patches);
    this.undoStack.push(commit);
    this.emit(commit);
    return commit;
  }

  /** Labels of undoable actions, oldest first — drives the history panel. */
  history(): readonly Commit[] {
    return this.undoStack;
  }

  /** Replace the whole document, e.g. on file open. Clears history. */
  reset(doc: FigureDocument): void {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.emit(null);
  }
}
