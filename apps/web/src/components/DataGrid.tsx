/**
 * Editable spreadsheet over one dataset.
 *
 * Imported data used to be read-only, so a single mistyped value meant
 * re-exporting from the instrument and re-importing the whole table. Every edit
 * here is an ordinary `commit`, which is what makes undo/redo, version history
 * and the analysis staleness warning apply to data edits without any of them
 * learning about this component.
 *
 * Built rather than installed: the repo carries React, d3-scale, zod and fflate
 * and nothing else, and a grid library would bring a styling system and a
 * virtualisation model for a table that is nearly always under a hundred rows.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  copyBlock,
  editDataset,
  insertColumn,
  insertRow,
  pasteBlock,
  removeColumn,
  removeRow,
  renameColumn,
  setCell,
  type CellValue,
  type Dataset,
} from '@figureforge/doc-model';
import type { DocumentApi } from '../useDocument.js';

/** Where the keyboard is. Null when nothing is being edited. */
interface Cursor {
  row: number;
  col: number;
}

/** Top-left of the last cell touched, which is where a paste lands. */
const ORIGIN: Cursor = { row: 0, col: 0 };

const cellText = (value: CellValue): string => (value === null ? '' : String(value));

export function DataGrid({
  api,
  dataset,
  onClose,
  onRowRangeChange,
  markedRows,
  rowAction,
}: {
  api: DocumentApi;
  dataset: Dataset;
  onClose: () => void;
  /** Rows the current selection covers — a single cell counts as a range of
   *  one. Fires on every change; the caller decides what, if anything, to
   *  do with it (volcano point labelling is the one consumer today). */
  onRowRangeChange?: (rows: { r0: number; r1: number } | null) => void;
  /** Rows to mark with a dot in the row header — e.g. genes already labelled
   *  on a volcano plot bound to this dataset. */
  markedRows?: ReadonlySet<number>;
  /** One caller-supplied action over the currently selected rows, rendered
   *  as a button in the grid's own header row, disabled with a stated reason
   *  the same `minGroupsMet`-style way the rest of the app already uses. */
  rowAction?: {
    label: string;
    disabledReason: string | null;
    onApply: (r0: number, r1: number) => void;
  };
}) {
  const { commit } = api;
  const [cursor, setCursor] = useState<Cursor | null>(null);
  /**
   * The selected cell, which outlives the editor.
   *
   * A spreadsheet pastes into the cell you *clicked*, not the one you are
   * mid-way through typing in, and `cursor` goes null the moment the editor
   * closes. Keeping the two apart is what lets a paste land somewhere
   * predictable when nothing is open.
   */
  const [anchor, setAnchor] = useState<Cursor>(ORIGIN);
  /**
   * The far corner of a multi-cell selection, or null for a single selected
   * cell (`anchor` alone) — today's behaviour, unchanged when this is null.
   */
  const [rangeEnd, setRangeEnd] = useState<Cursor | null>(null);
  /** The text being typed, so a half-finished number is not parsed mid-keystroke. */
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * Whether the pointer currently down started as a Shift-click. Read on
   * pointerup: a Shift-click always extends the selection and must never
   * open the editor, even when it lands back on the anchor cell.
   */
  const shiftSelectRef = useRef(false);
  /**
   * Set for the one focus event a pointerdown itself causes (clicking a
   * button focuses it natively) so `onFocus` below can ignore it — otherwise
   * a Shift-click's `rangeEnd` is set by `onPointerDown` and immediately
   * wiped by the focus event the same click produces. Left `false` the rest
   * of the time, which is what lets `onFocus` still track genuine Tab
   * navigation between cells.
   */
  const pointerSelectingRef = useRef(false);

  useEffect(() => {
    if (cursor) inputRef.current?.focus();
  }, [cursor]);

  // Focus the grid itself on open, so Ctrl+V works before anything is clicked.
  // A paste event is delivered to the focused element; with focus still on the
  // page behind, the grid never sees it and the keystroke does nothing at all.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const edit = (label: string, fn: (ds: Dataset) => Dataset): void => {
    commit(label, (d) => editDataset(d, dataset.id, fn));
  };

  const open = (row: number, col: number): void => {
    setCursor({ row, col });
    setAnchor({ row, col });
    setDraft(cellText(dataset.rows[row]?.[col] ?? null));
  };

  /** Write the in-progress text back, then optionally move on. */
  const commitCell = (next: Cursor | null): void => {
    if (cursor) {
      const current = cellText(dataset.rows[cursor.row]?.[cursor.col] ?? null);
      // Only commit a real change: stepping through cells with the arrow keys
      // would otherwise fill the undo history with entries that changed nothing.
      if (draft !== current) {
        const { row, col } = cursor;
        edit('Edit cell', (ds) => setCell(ds, row, col, draft));
      }
    }
    if (next) open(next.row, next.col);
    else setCursor(null);
  };

  const move = (dr: number, dc: number): void => {
    if (!cursor) return;
    const row = Math.min(Math.max(cursor.row + dr, 0), dataset.rows.length - 1);
    const col = Math.min(Math.max(cursor.col + dc, 0), dataset.columns.length - 1);
    commitCell({ row, col });
  };

  /** The top-left corner of the current selection — a single cell if `rangeEnd` is null. */
  const selectionTopLeft = (): Cursor => {
    const end = rangeEnd ?? anchor;
    return { row: Math.min(anchor.row, end.row), col: Math.min(anchor.col, end.col) };
  };

  /*
   * Range selection: drag across cells, or Shift-click a second cell to
   * extend from the current anchor. Mirrors the `setPointerCapture` +
   * pointerdown/move/up idiom `Canvas.tsx` already uses for its own drag
   * interactions (crop and resize handles) rather than inventing a second one.
   *
   * Pointer capture pins every subsequent move/up event to the cell that was
   * pressed, not whatever the pointer is currently over — so `onPointerMove`
   * has to hit-test for the cell under the pointer itself (`data-row`/
   * `data-col`), and `onPointerUp`'s own `row`/`col` closure arguments always
   * refer back to the *original* mousedown cell, which is exactly `anchor`.
   */
  const onCellPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    row: number,
    col: number,
  ): void => {
    if (event.button !== 0) return;
    // A button click elsewhere while a cell is open never reaches here for
    // the cell that's mid-edit — that one renders an `<input>`, not this
    // button — so `cursor` set at all means switching away from another cell.
    if (cursor) commitCell(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerSelectingRef.current = true;
    if (event.shiftKey) {
      shiftSelectRef.current = true;
      setRangeEnd({ row, col });
    } else {
      shiftSelectRef.current = false;
      setAnchor({ row, col });
      setRangeEnd(null);
    }
  };

  const onCellPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!(event.buttons & 1)) return;
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>('button[data-row]');
    if (!target) return;
    const row = Number(target.dataset['row']);
    const col = Number(target.dataset['col']);
    if (Number.isNaN(row) || Number.isNaN(col)) return;
    setRangeEnd((prev) => (prev && prev.row === row && prev.col === col ? prev : { row, col }));
  };

  const onCellPointerUp = (
    event: React.PointerEvent<HTMLButtonElement>,
    row: number,
    col: number,
  ): void => {
    event.currentTarget.releasePointerCapture(event.pointerId);
    const wasShiftSelect = shiftSelectRef.current;
    shiftSelectRef.current = false;
    // A Shift-click always leaves a selection, never opens the editor. A
    // plain click that never moved to a different cell opens it, exactly as
    // before; a real drag leaves the range selected instead.
    if (!wasShiftSelect && (rangeEnd === null || (rangeEnd.row === row && rangeEnd.col === col))) {
      open(row, col);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    /*
     * Undo, from inside a cell.
     *
     * `useUndoShortcuts` deliberately never steals Ctrl+Z from an input — a
     * user mid-typing would lose their keystrokes to a document-level undo.
     * That rule is right, and it also means a spreadsheet is unusable: after
     * Enter the cursor sits in the *next* cell, so the obvious Ctrl+Z did
     * nothing at all.
     *
     * Untouched is the distinction. With nothing typed since the cell opened
     * there are no keystrokes to lose, so the edit before it is what the author
     * means. Once they have typed, the browser's own text undo applies and this
     * stays out of the way.
     */
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      const untouched =
        cursor !== null && draft === cellText(dataset.rows[cursor.row]?.[cursor.col] ?? null);
      if (untouched) {
        event.preventDefault();
        setCursor(null);
        if (event.shiftKey) api.redo();
        else api.undo();
      }
      return;
    }

    // Everything below is a navigation key; ordinary typing falls through to
    // the input, which is what makes the grid feel like a spreadsheet.
    if (event.key === 'Enter') {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1, 0);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      move(0, event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Abandons the edit rather than writing it: Escape means "never mind".
      setCursor(null);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1, 0);
    }
  };

  /**
   * A multi-cell paste, handled for the whole grid rather than for one input.
   *
   * Excel puts tab-delimited text on the clipboard, so a block pasted into a
   * cell fills the block *from* that cell rather than dropping the whole thing
   * into it. A single value with no tab or newline is left to the input.
   *
   * This used to sit on the in-cell editor alone, which meant the paste only
   * worked once a cell had been opened by clicking it — the one state a user
   * arriving with a copied table is not in. Worse, a merely *focused* cell is a
   * `<button>`, which `Canvas`'s window-level shortcut guard let through, so
   * Ctrl+V there duplicated figure elements onto the canvas instead. One
   * handler on the container catches both, since React's synthetic paste
   * bubbles out of the editor too.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLElement>): void => {
    const text = event.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;

    event.preventDefault();
    // A selected range pastes at its top-left corner, same as a single
    // selected cell — the block paints its own size there rather than
    // repeating to fill whatever was selected.
    const { row, col } = cursor ?? selectionTopLeft();
    edit('Paste cells', (ds) => pasteBlock(ds, row, col, text));
    setCursor(null);
    setAnchor({ row, col });
    setRangeEnd(null);
  };

  /**
   * Copying leaves an in-progress edit's own text selection to the browser's
   * native copy — only a *selected range* of cells, with nothing open, goes
   * to the clipboard as a block. This is the real `copy` event, not the
   * in-app node-id clipboard `Canvas.tsx` uses for figure elements: cell data
   * has to leave the app and land in a real spreadsheet.
   */
  const onCopy = (event: React.ClipboardEvent<HTMLElement>): void => {
    if (cursor !== null) return;
    const end = rangeEnd ?? anchor;
    const r0 = Math.min(anchor.row, end.row);
    const r1 = Math.max(anchor.row, end.row);
    const c0 = Math.min(anchor.col, end.col);
    const c1 = Math.max(anchor.col, end.col);
    event.clipboardData.setData('text/plain', copyBlock(dataset, r0, c0, r1, c1));
    event.preventDefault();
  };

  const onGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    /*
     * A selected cell is a `<button>`, not a text selection — the browser has
     * nothing to act on for a bare Ctrl/Cmd+C, so no native `copy` event ever
     * fires and `onCopy` below never runs. `execCommand('copy')` forces that
     * same native event to fire (still landing on `onCopy`, still read via
     * `event.clipboardData`), rather than switching to
     * `navigator.clipboard.writeText()`'s separate, promptable permission.
     */
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && cursor === null) {
      document.execCommand('copy');
      return;
    }
    if (event.key === 'Escape' && cursor === null && rangeEnd !== null) {
      setRangeEnd(null);
    }
  };

  // Computed once per render rather than per cell — the bounds a selected
  // range covers, or just the anchor's own position when `rangeEnd` is null.
  const rangeBounds = rangeEnd && {
    r0: Math.min(anchor.row, rangeEnd.row),
    r1: Math.max(anchor.row, rangeEnd.row),
    c0: Math.min(anchor.col, rangeEnd.col),
    c1: Math.max(anchor.col, rangeEnd.col),
  };

  // A single selected cell still reports its own row — `rowAction` needs to
  // work from a plain click, not only a drag — computed here rather than at
  // each of the three places `anchor`/`rangeEnd` change, so there is exactly
  // one place that turns "what's selected" into "which rows that covers".
  const rowRange = useMemo(
    () => ({
      r0: Math.min(anchor.row, (rangeEnd ?? anchor).row),
      r1: Math.max(anchor.row, (rangeEnd ?? anchor).row),
    }),
    [anchor.row, rangeEnd],
  );
  useEffect(() => {
    onRowRangeChange?.(rowRange);
    return () => onRowRangeChange?.(null);
    // Depends on the row numbers themselves, not the freshly-built object —
    // `rowRange` would otherwise differ by reference on every render.
  }, [rowRange.r0, rowRange.r1]);

  return (
    <div
      className="data-grid"
      ref={rootRef}
      tabIndex={-1}
      onPaste={onPaste}
      onCopy={onCopy}
      onKeyDown={onGridKeyDown}
    >
      <div className="field-row">
        <strong>{dataset.name}</strong>
        <span className="muted">
          {dataset.rows.length} rows × {dataset.columns.length} columns
        </span>
        {rowAction && (
          <button
            disabled={rowAction.disabledReason !== null}
            title={rowAction.disabledReason ?? undefined}
            onClick={() => rowAction.onApply(rowRange.r0, rowRange.r1)}
          >
            {rowAction.label}
          </button>
        )}
        <button onClick={onClose}>Done</button>
      </div>

      <div className="grid-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th className="row-head" />
              {/* Keyed by position, not name: a paired-xy table legitimately
                  repeats a column name, and a duplicate key drops one. */}
              {dataset.columns.map((column, col) => (
                <th key={col}>
                  <input
                    value={column.name}
                    title={`Column ${col + 1} · ${column.kind}`}
                    onChange={(e) => {
                      const name = e.target.value;
                      edit('Rename column', (ds) => renameColumn(ds, col, name));
                    }}
                  />
                  <div className="field-row">
                    <span className="kind">{column.kind === 'number' ? '#' : 'A'}</span>
                    <button
                      title="Insert a column before this one"
                      onClick={() => edit('Insert column', (ds) => insertColumn(ds, col))}
                    >
                      +
                    </button>
                    <button
                      className="danger"
                      title="Delete this column"
                      onClick={() => edit('Delete column', (ds) => removeColumn(ds, col))}
                    >
                      ×
                    </button>
                  </div>
                </th>
              ))}
              <th className="row-head">
                <button
                  title="Add a column"
                  onClick={() =>
                    edit('Add column', (ds) => insertColumn(ds, ds.columns.length))
                  }
                >
                  +
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {dataset.rows.map((row, r) => (
              <tr key={r}>
                <th className="row-head">
                  <span>{r + 1}</span>
                  {markedRows?.has(r) && (
                    <span className="row-marker" title="Already labelled on the plot" />
                  )}
                  <button
                    className="danger"
                    title="Delete this row"
                    onClick={() => edit('Delete row', (ds) => removeRow(ds, r))}
                  >
                    ×
                  </button>
                </th>
                {dataset.columns.map((_, c) => {
                  const editing = cursor?.row === r && cursor.col === c;
                  const isAnchor = anchor.row === r && anchor.col === c;
                  const inRange =
                    !isAnchor &&
                    rangeBounds !== null &&
                    r >= rangeBounds.r0 &&
                    r <= rangeBounds.r1 &&
                    c >= rangeBounds.c0 &&
                    c <= rangeBounds.c1;
                  return (
                    <td key={c} className={editing ? 'editing' : ''}>
                      {editing ? (
                        <input
                          ref={inputRef}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={onKeyDown}
                          onBlur={() => commitCell(null)}
                        />
                      ) : (
                        <button
                          className={isAnchor ? 'cell selected' : inRange ? 'cell in-range' : 'cell'}
                          data-row={r}
                          data-col={c}
                          onPointerDown={(e) => onCellPointerDown(e, r, c)}
                          onPointerMove={onCellPointerMove}
                          onPointerUp={(e) => onCellPointerUp(e, r, c)}
                          onFocus={() => {
                            if (pointerSelectingRef.current) {
                              pointerSelectingRef.current = false;
                              return;
                            }
                            setAnchor({ row: r, col: c });
                            setRangeEnd(null);
                          }}
                        >
                          {cellText(row[c] ?? null) || ' '}
                        </button>
                      )}
                    </td>
                  );
                })}
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="field-row">
        <button onClick={() => edit('Add row', (ds) => insertRow(ds, ds.rows.length))}>
          Add row
        </button>
        <span className="muted">
          Drag or Shift-click to select a range, then Ctrl/Cmd+C to copy it — to another
          spreadsheet or back into the grid. Paste with Ctrl/Cmd+V fills from the selected cell's
          top-left corner, adding rows and columns to fit.
        </span>
        {dataset.editedAt && (
          <span className="muted">
            Edited since import. The project file still holds the original data as it arrived;
            any analysis over this dataset is now marked stale.
          </span>
        )}
      </div>
    </div>
  );
}
