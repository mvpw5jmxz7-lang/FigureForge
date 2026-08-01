/**
 * React binding for the DocumentStore.
 *
 * The store owns the document and its undo history; React only subscribes.
 * Keeping the model outside React means the export path and the tests can drive
 * exactly the same code without rendering a component.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  createIdFactory,
  DocumentStore,
  type FigureDocument,
  type Recipe,
} from '@figureforge/doc-model';

export interface DocumentApi {
  document: FigureDocument;
  store: DocumentStore;
  commit: (label: string, recipe: Recipe) => void;
  transaction: (label: string, body: () => void) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  newId: () => string;
}

export function useDocument(initial: () => FigureDocument): DocumentApi {
  const storeRef = useRef<DocumentStore | null>(null);
  storeRef.current ??= new DocumentStore(initial());
  const store = storeRef.current;

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const document = useSyncExternalStore(
    subscribe,
    () => store.getDocument(),
    () => store.getDocument(),
  );

  const newId = useMemo(() => createIdFactory(), []);

  const commit = useCallback(
    (label: string, recipe: Recipe) => {
      store.commit(label, recipe);
    },
    [store],
  );

  const transaction = useCallback(
    (label: string, body: () => void) => {
      store.transaction(label, body);
    },
    [store],
  );

  return {
    document,
    store,
    commit,
    transaction,
    undo: useCallback(() => void store.undo(), [store]),
    redo: useCallback(() => void store.redo(), [store]),
    canUndo: store.canUndo(),
    canRedo: store.canRedo(),
    newId,
  };
}

/** Bind Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Ctrl+Y) to the store's history. */
export function useUndoShortcuts(api: DocumentApi): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;

      const target = event.target as HTMLElement | null;
      // Never steal undo from a field the user is typing in.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        api.undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        api.redo();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [api]);
}
