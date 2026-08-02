/**
 * Datasets and tabular import.
 *
 * Imported data is stored verbatim and never mutated — reproducibility depends
 * on the original numbers surviving in the project file exactly as they arrived.
 * Plots read through the accessors below rather than transforming in place.
 */

import type { DatasetId } from './nodes.js';

export type CellValue = number | string | null;

export type ColumnKind = 'number' | 'text';

/**
 * How the columns should be read. These mirror the layouts biologists actually
 * paste out of Excel, Prism and SigmaPlot.
 */
export type DataFormat =
  /** X,Y */
  | 'simple-xy'
  /** X,Y1,Y2,Y3 — shared x, several series */
  | 'prism'
  /** X1,Y1,X2,Y2,… — independent xy pairs */
  | 'sigmaplot'
  /** Group,Value — long form */
  | 'grouped'
  /** Treatment,Replicate1,Replicate2,… */
  | 'replicate'
  /**
   * RowLabel,CategoryA,CategoryB,… — a table of *counts*, not measurements.
   *
   * Structurally identical to `replicate`, and deliberately a separate member
   * anyway: the numbers mean something different. A count table's rows are not
   * replicates of one another, its mean is meaningless, and the tests that
   * apply to it (chi-square, Fisher) are exactly the ones that do not apply to
   * measurements. Without the distinction a user can run a t-test on
   * frequencies and get a confident, wrong answer.
   */
  | 'contingency';

export interface Column {
  name: string;
  kind: ColumnKind;
}

export interface Dataset {
  id: DatasetId;
  name: string;
  format: DataFormat;
  columns: readonly Column[];
  rows: readonly (readonly CellValue[])[];
  /** Path inside the .figureforge archive holding the verbatim original. */
  sourcePath: string | null;
  sourceFilename: string | null;
  importedAt: string;
}

// ---------------------------------------------------------------------------
// Delimited text parsing
// ---------------------------------------------------------------------------

export type Delimiter = ',' | '\t' | ';' | '|';

/** Pick the delimiter that yields the most consistent column count. */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 20);
  if (sample.length === 0) return ',';

  let best: Delimiter = ',';
  let bestScore = -Infinity;
  for (const delim of [',', '\t', ';', '|'] as const) {
    const counts = sample.map((line) => splitLine(line, delim).length);
    const first = counts[0] ?? 0;
    if (first < 2) continue;
    // Reward many columns, punish rows that disagree on the count.
    const inconsistency = counts.filter((c) => c !== first).length;
    const score = first - inconsistency * 10;
    if (score > bestScore) {
      bestScore = score;
      best = delim;
    }
  }
  return best;
}

/** Split one line, honouring RFC 4180 double-quoting. */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseCell(raw: string): CellValue {
  const t = raw.trim();
  if (t === '' || t === 'NA' || t === 'NaN' || t === 'null' || t === '-') return null;
  return NUMERIC.test(t) ? Number(t) : t;
}

export interface ParsedTable {
  columns: Column[];
  rows: CellValue[][];
  delimiter: Delimiter;
  hasHeader: boolean;
}

export interface ParseOptions {
  /** Override the detected delimiter. */
  delimiter?: Delimiter;
  /** Override the header-row guess. */
  hasHeader?: boolean;
  /**
   * Swap rows and columns before anything else is decided.
   *
   * Plate readers and image quantification tools routinely emit the transpose
   * of what the plot wants, and re-pasting a table by hand to fix that is
   * exactly the drudgery this importer exists to remove.
   */
  transpose?: boolean;
}

/**
 * Parse delimited text into a table. Used for CSV/TSV/TXT files and for
 * clipboard pastes out of Excel (which are tab-delimited).
 *
 * Every option defaults to the detected value, so a caller that passes nothing
 * gets exactly the behaviour every existing call site already relied on.
 */
export function parseDelimited(
  text: string,
  delimiterOrOptions?: Delimiter | ParseOptions,
): ParsedTable {
  const options: ParseOptions =
    typeof delimiterOrOptions === 'string'
      ? { delimiter: delimiterOrOptions }
      : (delimiterOrOptions ?? {});

  const delim = options.delimiter ?? detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    return { columns: [], rows: [], delimiter: delim, hasHeader: false };
  }

  let cells = lines.map((line) => splitLine(line, delim));
  if (options.transpose) {
    const width = Math.max(...cells.map((r) => r.length));
    cells = Array.from({ length: width }, (_, col) => cells.map((row) => row[col] ?? ''));
  }
  const width = Math.max(...cells.map((r) => r.length));

  // A first row with no numbers in it, above rows that do have numbers, is a header.
  const firstRow = cells[0]!;
  const bodyHasNumbers = cells
    .slice(1)
    .some((row) => row.some((c) => typeof parseCell(c) === 'number'));
  const hasHeader =
    options.hasHeader ??
    (bodyHasNumbers && firstRow.every((c) => typeof parseCell(c) !== 'number'));

  const headerNames = hasHeader ? firstRow : [];
  const bodyRows = (hasHeader ? cells.slice(1) : cells).map((row) => {
    const padded: CellValue[] = [];
    for (let i = 0; i < width; i++) padded.push(parseCell(row[i] ?? ''));
    return padded;
  });

  const columns: Column[] = [];
  for (let i = 0; i < width; i++) {
    const name = (headerNames[i] ?? '').trim() || defaultColumnName(i);
    const values = bodyRows.map((r) => r[i]).filter((v) => v !== null);
    // A column with nothing but blanks is a numeric column with missing data
    // far more often than it is a text column. Typing it as text would change
    // the inferred layout of the whole file and silently drop the other
    // replicates along with it.
    const numeric = values.length === 0 || values.every((v) => typeof v === 'number');
    columns.push({ name, kind: numeric ? 'number' : 'text' });
  }

  return { columns, rows: bodyRows, delimiter: delim, hasHeader };
}

function defaultColumnName(index: number): string {
  let n = index;
  let name = '';
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/**
 * Guess the layout from the column shape. The importer shows this as a
 * pre-selected suggestion in the live preview, never as a silent decision.
 */
export function inferFormat(columns: readonly Column[]): DataFormat {
  const kinds = columns.map((c) => c.kind);
  const numericCount = kinds.filter((k) => k === 'number').length;

  if (columns.length === 2 && kinds[0] === 'text' && kinds[1] === 'number') return 'grouped';
  if (columns.length === 2 && numericCount === 2) return 'simple-xy';
  if (kinds[0] === 'text' && numericCount === columns.length - 1) return 'replicate';
  /*
   * Alternating x/y pairs is the SigmaPlot signature. The old rule demanded
   * headers literally starting with x and y, so a sedimentation-velocity export
   * headed `Radius,C(s)_run1,Radius,C(s)_run2` was read as `prism` — one shared
   * x for every series, silently plotting run 2 against run 1's radii. Repeated
   * first-of-pair names are the stronger signal, since a shared-x table cannot
   * have them.
   */
  if (columns.length >= 4 && columns.length % 2 === 0 && numericCount === columns.length) {
    const named = columns.every((c, i) => (i % 2 === 0 ? /^x/i.test(c.name) : /^y/i.test(c.name)));
    const firsts = columns.filter((_, i) => i % 2 === 0).map((c) => c.name.toLowerCase());
    const repeatedFirsts = new Set(firsts).size < firsts.length;
    if (named || repeatedFirsts) return 'sigmaplot';
  }
  if (numericCount >= 3) return 'prism';
  return 'simple-xy';
}

/**
 * Whether a dataset holds counts rather than measurements.
 *
 * The one thing every caller needs to know about `'contingency'`, in one place
 * so the stats UI, the plot-type gate and the quality checker cannot disagree.
 */
export const isContingency = (ds: Dataset): boolean => ds.format === 'contingency';

/** Category (column) labels of a contingency table. */
export const contingencyCategories = (ds: Dataset): string[] =>
  ds.format === 'contingency' ? ds.columns.slice(1).map((c) => c.name) : [];

// ---------------------------------------------------------------------------
// Series extraction
// ---------------------------------------------------------------------------

/** A named group of values ready for plotting or for a statistical test. */
export interface Series {
  name: string;
  values: number[];
  /** Paired x values, when the format supplies them. */
  x?: number[];
}

export const columnIndex = (ds: Dataset, name: string): number =>
  ds.columns.findIndex((c) => c.name === name);

export function columnValues(ds: Dataset, name: string): CellValue[] {
  const idx = columnIndex(ds, name);
  if (idx < 0) return [];
  return ds.rows.map((r) => r[idx] ?? null);
}

export function numericColumn(ds: Dataset, name: string): number[] {
  return columnValues(ds, name).filter((v): v is number => typeof v === 'number');
}

/**
 * Split a dataset into plottable series according to its declared format.
 * This is the single place layout-to-series interpretation happens.
 */
export function toSeries(ds: Dataset): Series[] {
  switch (ds.format) {
    case 'grouped': {
      const [labelCol, valueCol] = ds.columns;
      if (!labelCol || !valueCol) return [];
      const li = 0;
      const vi = 1;
      const byGroup = new Map<string, number[]>();
      for (const row of ds.rows) {
        const label = row[li];
        const value = row[vi];
        if (label === null || typeof value !== 'number') continue;
        const key = String(label);
        const bucket = byGroup.get(key);
        if (bucket) bucket.push(value);
        else byGroup.set(key, [value]);
      }
      return [...byGroup].map(([name, values]) => ({ name, values }));
    }

    case 'contingency':
    case 'replicate': {
      // Row-per-treatment; the replicate columns collapse into one series.
      // A contingency table has the same shape — one row of counts per group —
      // so it reads the same way. What differs is what may be *done* with the
      // numbers, which `isContingency` gates rather than this.
      const valueCols = ds.columns.slice(1);
      return ds.rows
        .map((row) => {
          const name = row[0] === null ? '' : String(row[0]);
          const values = valueCols
            .map((_, i) => row[i + 1])
            .filter((v): v is number => typeof v === 'number');
          return { name, values };
        })
        .filter((s) => s.name !== '' && s.values.length > 0);
    }

    case 'prism': {
      const xValues = numericColumnAt(ds, 0);
      return ds.columns.slice(1).map((col, i) => {
        const values = numericColumnAt(ds, i + 1);
        return { name: col.name, values, x: xValues.slice(0, values.length) };
      });
    }

    case 'sigmaplot': {
      const out: Series[] = [];
      for (let i = 0; i + 1 < ds.columns.length; i += 2) {
        const xs = numericColumnAt(ds, i);
        const ys = numericColumnAt(ds, i + 1);
        out.push({ name: ds.columns[i + 1]!.name, values: ys, x: xs });
      }
      return out;
    }

    case 'simple-xy':
    default: {
      const xs = numericColumnAt(ds, 0);
      const ys = numericColumnAt(ds, 1);
      const name = ds.columns[1]?.name ?? 'Y';
      return [{ name, values: ys, x: xs }];
    }
  }
}

function numericColumnAt(ds: Dataset, index: number): number[] {
  return ds.rows
    .map((r) => r[index] ?? null)
    .filter((v): v is number => typeof v === 'number');
}
