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

import { useEffect, useRef, useState } from 'react';
import {
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

const cellText = (value: CellValue): string => (value === null ? '' : String(value));

export function DataGrid({
  api,
  dataset,
  onClose,
}: {
  api: DocumentApi;
  dataset: Dataset;
  onClose: () => void;
}) {
  const { commit } = api;
  const [cursor, setCursor] = useState<Cursor | null>(null);
  /** The text being typed, so a half-finished number is not parsed mid-keystroke. */
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (cursor) inputRef.current?.focus();
  }, [cursor]);

  const edit = (label: string, fn: (ds: Dataset) => Dataset): void => {
    commit(label, (d) => editDataset(d, dataset.id, fn));
  };

  const open = (row: number, col: number): void => {
    setCursor({ row, col });
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
   * A multi-cell paste.
   *
   * Excel puts tab-delimited text on the clipboard, so a block pasted into a
   * cell fills the block *from* that cell rather than dropping the whole thing
   * into it. A single value with no tab or newline is left to the input.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    if (!cursor) return;
    const text = event.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;

    event.preventDefault();
    const { row, col } = cursor;
    edit('Paste cells', (ds) => pasteBlock(ds, row, col, text));
    setCursor(null);
  };

  return (
    <div className="data-grid">
      <div className="field-row">
        <strong>{dataset.name}</strong>
        <span className="muted">
          {dataset.rows.length} rows × {dataset.columns.length} columns
        </span>
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
                  return (
                    <td key={c} className={editing ? 'editing' : ''}>
                      {editing ? (
                        <input
                          ref={inputRef}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={onKeyDown}
                          onPaste={onPaste}
                          onBlur={() => commitCell(null)}
                        />
                      ) : (
                        <button className="cell" onClick={() => open(r, c)}>
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
