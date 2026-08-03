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
  | 'contingency'
  /**
   * Prism's *Grouped*: RowLabel, then one block of replicate columns per group.
   *
   *     Table format   Group A          Group B
   *     Grouped        A:Y1  A:Y2  A:Y3 B:Y1  B:Y2  B:Y3
   *     WT             0.08  -0.25 …    0.06  0.006 …
   *     Q331K          -0.18 0.12  …    -0.59 -0.66 …
   *
   * Two factors at once — the row is one category, the column block is
   * another — which nothing in the model could express before. It is what makes
   * a bar per (row, group) with a legend possible instead of one bar per row.
   */
  | 'grouped-replicates'
  /**
   * Prism's *XY* with replicate subcolumns: a shared x, then one block of
   * replicate y columns per group.
   *
   *     X       Group A (Control)      Group B (Treated)
   *     Hours   A:Y1  A:Y2  A:Y3       B:Y1  B:Y2  B:Y3
   *     0       45    34    20         34    31    29
   *
   * Read as `prism` this draws six independent lines; read this way it draws
   * two, each a mean over its replicates with an error band or bars.
   */
  | 'xy-replicates'
  /**
   * Prism's *Nested*: one block of subcolumns per group, no row-label column.
   *
   *     Group A (Control)     Group B (Treated)
   *     Rat 1  Rat 2  Rat 3   Rat 4  Rat 5  Rat 6
   *
   * The same column blocking as `grouped-replicates`, but the subcolumns are
   * *subjects* rather than replicates of one measurement, so the points are
   * drawn clustered per group rather than pooled. See the note on nested
   * statistics in the stats gate: they plot, they are not tested.
   */
  | 'nested';

/**
 * Layouts whose columns are blocked into groups by a second header row.
 *
 * One place that says which formats read `columnGroups`, so the parser, the
 * series reader and the importer cannot disagree about it.
 */
export const GROUPED_FORMATS: ReadonlySet<DataFormat> = new Set<DataFormat>([
  'grouped-replicates',
  'xy-replicates',
  'nested',
]);

export interface Column {
  name: string;
  kind: ColumnKind;
}

/**
 * A block of columns that belong to one group, as a second header row declares.
 *
 * `from`/`to` are inclusive column indices into `Dataset.columns`. Held as
 * ranges rather than as a name per column because that is what the file
 * actually says — Prism writes the group name once over a merged span — and
 * because a range cannot come apart into two columns claiming different groups.
 */
export interface ColumnGroup {
  name: string;
  from: number;
  to: number;
}

export interface Dataset {
  id: DatasetId;
  name: string;
  format: DataFormat;
  columns: readonly Column[];
  rows: readonly (readonly CellValue[])[];
  /**
   * Column 0 holds row labels rather than data, so the x values start in
   * column 1.
   *
   * Only meaningful for the xy layouts (`simple-xy`, `prism`, `sigmaplot`).
   * `grouped`, `replicate` and `contingency` already read column 0 as a label
   * by definition, and a second way of saying the same thing is a second thing
   * that can disagree.
   *
   * A *reading* of the rows, like `format` — nothing is dropped and toggling it
   * is lossless, which is what lets it be corrected after import.
   */
  hasRowNames?: boolean;
  /**
   * How the columns block into groups, for the layouts in `GROUPED_FORMATS`.
   *
   * Read from a second header row on import, or derived from a "replicates per
   * group" count the author sets. Optional, so files written before it load
   * unchanged; a grouped format with no blocks reads as one group, which draws
   * exactly what the single-factor path already drew.
   */
  columnGroups?: readonly ColumnGroup[];
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
  /** How many rows were consumed as header. 0, 1, or 2. */
  headerRows: number;
  /**
   * Column blocks read from a *second* header row, when there was one.
   *
   * Empty for an ordinary table. Non-empty is the signal that the file declares
   * two factors — which is what makes Prism's Grouped and Nested layouts
   * readable at all rather than guessable.
   */
  columnGroups: ColumnGroup[];
}

export interface ParseOptions {
  /** Override the detected delimiter. */
  delimiter?: Delimiter;
  /** Override the header-row guess. */
  hasHeader?: boolean;
  /**
   * How many leading rows are header. Overrides `hasHeader` when given.
   *
   * Prism writes two: the group name once over its block of replicate columns,
   * then the replicate names beneath. Reading only the first row leaves the
   * group names as column names and loses the blocking; reading only the second
   * loses the group names entirely.
   */
  headerRows?: number;
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
 * Column blocks from a group-name header row.
 *
 * The row is sparse by construction: a spreadsheet writes a merged group title
 * in the first cell of its span and leaves the rest blank, and a CSV export of
 * that is `,,Group A,,,Group B,,`. So a name *starts* a block and blanks
 * continue it — which is also why the leading blanks before the first name are
 * not a group: those are the row-label and x columns, which belong to no group.
 */
export function columnGroupsFromHeader(header: readonly string[], width: number): ColumnGroup[] {
  const groups: ColumnGroup[] = [];
  for (let i = 0; i < width; i++) {
    const name = (header[i] ?? '').trim();
    if (name === '') {
      // Continues the block already open, or is an ungrouped leading column.
      const open = groups[groups.length - 1];
      if (open && open.to === i - 1) open.to = i;
      continue;
    }
    groups.push({ name, from: i, to: i });
  }
  return groups;
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
    return {
      columns: [],
      rows: [],
      delimiter: delim,
      hasHeader: false,
      headerRows: 0,
      columnGroups: [],
    };
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

  const headerRows = clampHeaderRows(options.headerRows, hasHeader, cells);

  /*
   * With two header rows the *upper* one carries the group names and the lower
   * one the column names. That is the order a spreadsheet writes them in, and
   * getting it the other way round would name every column after its group.
   */
  const groupRow = headerRows >= 2 ? cells[headerRows - 2]! : [];
  const headerNames = headerRows >= 1 ? cells[headerRows - 1]! : [];
  const columnGroups = headerRows >= 2 ? columnGroupsFromHeader(groupRow, width) : [];

  const bodyRows = cells.slice(headerRows).map((row) => {
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

  return { columns, rows: bodyRows, delimiter: delim, hasHeader: headerRows > 0, headerRows, columnGroups };
}

/**
 * How many leading rows to treat as header.
 *
 * Detects a second header row rather than requiring it to be declared: a row
 * that is sparse, wholly non-numeric, and sits above another non-numeric row is
 * a group-title row and nothing else. Being sparse is the load-bearing part —
 * an ordinary single header names *every* column, while a merged group title
 * names one cell per block. Without that test a plain two-header-row file (say
 * a units row) would be read as declaring groups.
 *
 * Never consumes so many rows that no data is left; a table that is all header
 * is a mis-detection, not an empty dataset.
 */
function clampHeaderRows(
  requested: number | undefined,
  hasHeader: boolean,
  cells: readonly (readonly string[])[],
): number {
  const maxRows = Math.max(0, cells.length - 1);
  if (requested !== undefined) {
    return Math.min(Math.max(0, Math.trunc(requested)), maxRows);
  }
  if (!hasHeader) return 0;

  const second = cells[1];
  if (maxRows >= 2 && second !== undefined) {
    const filled = second.filter((c) => c.trim() !== '');
    const secondIsHeader =
      filled.length > 0 && second.every((c) => typeof parseCell(c) !== 'number');
    const firstIsSparse = cells[0]!.filter((c) => c.trim() !== '').length < filled.length;
    if (secondIsHeader && firstIsSparse) return 2;
  }
  return 1;
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
 * Whether column 0 could be row labels in front of xy data.
 *
 * There is deliberately **no guess here** — it reports only that the question
 * is open, so the importer can offer the choice.
 *
 * A text column 0 followed by numbers is the `replicate` signature too, and the
 * two readings are indistinguishable from the cells:
 *
 *     Treatment,R1,R2,R3      Sample,Dose,Alive,Dead
 *     Vehicle,10,11,12        a,10,11,12
 *
 * The first is four groups of replicates, the second is one x and two y series,
 * and they are the same rectangle of numbers. A heuristic was tried — unique
 * labels plus a strictly ascending first numeric column, on the theory that a
 * dose or time axis ascends and replicate measurements do not — and it
 * immediately misread a real dose-response table, whose group means ascend by
 * construction. That is precisely the class of silent misreading this round
 * exists to remove, so the ambiguity is handed to the author instead of being
 * resolved wrongly on their behalf.
 */
export function couldHaveRowNames(columns: readonly Column[]): boolean {
  return (
    columns.length >= 3 &&
    columns[0]?.kind === 'text' &&
    columns.slice(1).every((c) => c.kind === 'number')
  );
}

/**
 * Guess the layout from the column shape. The importer shows this as a
 * pre-selected suggestion in the live preview, never as a silent decision.
 *
 * With `hasRowNames`, column 0 is a label rather than data and the shape is
 * read from what follows it — otherwise every row-labelled xy table infers as
 * `replicate`, since a text column in front of numbers is that signature.
 */
export function inferFormat(
  columns: readonly Column[],
  options: { hasRowNames?: boolean; columnGroups?: readonly ColumnGroup[] } = {},
): DataFormat {
  /*
   * Declared column blocks settle the layout outright — a second header row is
   * the file *stating* it has two factors, which is stronger than any inference
   * from column shapes. Which of the three grouped layouts it is then follows
   * from what sits in front of the first block: a text column labels the rows
   * (Prism's Grouped), a numeric one is a shared x (Prism's XY), and nothing at
   * all means the blocks are the whole table (Prism's Nested).
   */
  const blocks = options.columnGroups ?? [];
  if (blocks.length >= 1) {
    const firstGrouped = blocks[0]!.from;
    if (firstGrouped === 0) return 'nested';
    return columns[0]?.kind === 'text' ? 'grouped-replicates' : 'xy-replicates';
  }

  if (options.hasRowNames) return inferFormat(columns.slice(1));
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
  /**
   * Unique across the dataset, and the key everything downstream joins on:
   * `AnalysisSpec.groups`, `Comparison.groupA`/`groupB`,
   * `PlotMeasurements.categoryX` and `bracketFrame` all look series up by name.
   *
   * For a two-factor table it is `"category — group"`, which is what keeps
   * every one of those unchanged: the second factor arrives without any of
   * them learning about it.
   */
  name: string;
  values: number[];
  /** Paired x values, when the format supplies them. */
  x?: number[];
  /**
   * Position along the *first* factor — the outer band a mark sits over, and
   * what the category axis labels. Absent on a single-factor table, where the
   * series name is the category.
   */
  category?: string;
  /**
   * Position along the *second* factor — the sub-band within the outer band.
   * Absent on a single-factor table.
   */
  group?: string;
  /**
   * What the colour means, and what the legend lists.
   *
   * Separate from `group` because on nested data they genuinely differ: the
   * sub-bands are *subjects* (Rat 1, Rat 2, …) but the reading is Control
   * versus Treated, so the points cluster by subject and colour by group. Six
   * colours for six rats would key the legend on the one factor a nested design
   * is explicitly not comparing. Defaults to `group` where they coincide.
   */
  legendKey?: string;
}

/** How a two-factor series is named, so nothing composes it a second way. */
export const compositeSeriesName = (category: string, group: string): string =>
  `${category} — ${group}`;

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

    case 'contingency': {
      /*
       * One series per *cell*, not per row.
       *
       * Read as replicates — which is what happened until now — a `Smoked` row
       * of [80, 20] became a single bar at its mean, 50. That is not a number
       * in the table, and it is not a number about the experiment: the mean of
       * a count of cases and a count of controls means nothing at all. Each
       * count is its own bar, positioned by its row and coloured by its column,
       * which is the figure the table describes.
       */
      const categories = ds.columns.slice(1);
      const out: Series[] = [];
      for (const row of ds.rows) {
        const rowName = row[0] === null ? '' : String(row[0]);
        if (rowName === '') continue;
        categories.forEach((col, i) => {
          const count = row[i + 1];
          if (typeof count !== 'number') return;
          out.push({
            name: compositeSeriesName(rowName, col.name),
            values: [count],
            category: rowName,
            group: col.name,
          });
        });
      }
      return out;
    }

    case 'replicate': {
      // Row-per-treatment; the replicate columns collapse into one series.
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

    case 'grouped-replicates': {
      // Row label, then one block of replicate columns per group: a value for
      // every (row, group) pair, which is the two-factor figure Prism draws.
      const blocks = dataBlocks(ds);
      const out: Series[] = [];
      for (const row of ds.rows) {
        const rowName = row[0] === null ? '' : String(row[0]);
        if (rowName === '') continue;
        for (const block of blocks) {
          const values: number[] = [];
          for (let i = block.from; i <= block.to; i++) {
            const v = row[i];
            if (typeof v === 'number') values.push(v);
          }
          if (values.length === 0) continue;
          out.push({
            name: compositeSeriesName(rowName, block.name),
            values,
            category: rowName,
            group: block.name,
          });
        }
      }
      return out;
    }

    case 'xy-replicates': {
      /*
       * A shared x, then one block of replicate y columns per group.
       *
       * The replicates are flattened into repeated x values rather than kept in
       * a nested shape: a scatter of every replicate is then already correct,
       * and the mean-with-error reading is a grouping by x that `xyMarks` does
       * when the plot asks for it. A nested shape would need every consumer —
       * marks, statistics, the input hash — to learn about it.
       */
      const blocks = dataBlocks(ds);
      const xIndex = blocks.length > 0 ? Math.max(0, blocks[0]!.from - 1) : 0;
      return blocks.map((block) => {
        const values: number[] = [];
        const x: number[] = [];
        for (const row of ds.rows) {
          const xValue = row[xIndex];
          if (typeof xValue !== 'number') continue;
          for (let i = block.from; i <= block.to; i++) {
            const v = row[i];
            if (typeof v !== 'number') continue;
            values.push(v);
            x.push(xValue);
          }
        }
        return { name: block.name, values, x, group: block.name, legendKey: block.name };
      });
    }

    case 'nested': {
      /*
       * One block of subcolumns per group, each subcolumn a subject.
       *
       * Position clusters by subject inside the group's band; colour keys on
       * the group. Pooling the subjects into one series instead would throw
       * away the structure that makes the design nested — the whole point is
       * that the observations within a subject are not independent.
       */
      const blocks = dataBlocks(ds);
      const out: Series[] = [];
      for (const block of blocks) {
        for (let i = block.from; i <= block.to; i++) {
          const values: number[] = [];
          for (const row of ds.rows) {
            const v = row[i];
            if (typeof v === 'number') values.push(v);
          }
          if (values.length === 0) continue;
          const subject = ds.columns[i]?.name ?? `Column ${i + 1}`;
          out.push({
            name: compositeSeriesName(block.name, subject),
            values,
            category: block.name,
            group: subject,
            legendKey: block.name,
          });
        }
      }
      return out;
    }

    case 'prism': {
      // Column 0 is x — or the row labels, with x in column 1.
      const first = dataColumnOffset(ds);
      return ds.columns.slice(first + 1).map((col, i) => ({
        name: col.name,
        ...numericPairsAt(ds, first, first + 1 + i),
      }));
    }

    case 'sigmaplot': {
      const first = dataColumnOffset(ds);
      const out: Series[] = [];
      for (let i = first; i + 1 < ds.columns.length; i += 2) {
        out.push({ name: ds.columns[i + 1]!.name, ...numericPairsAt(ds, i, i + 1) });
      }
      return out;
    }

    case 'simple-xy':
    default: {
      const first = dataColumnOffset(ds);
      const name = ds.columns[first + 1]?.name ?? 'Y';
      return [{ name, ...numericPairsAt(ds, first, first + 1) }];
    }
  }
}

/**
 * Index of the first *data* column: 1 when column 0 holds row labels.
 *
 * Applies to the xy layouts only — see `Dataset.hasRowNames`.
 */
export function dataColumnOffset(ds: Dataset): number {
  return ds.hasRowNames ? 1 : 0;
}

/**
 * The column blocks a grouped layout reads, clamped to the columns that exist.
 *
 * Falls back to one block over every data column when nothing declared them.
 * That is the honest degenerate reading — one group, which draws exactly what
 * the single-factor path draws — rather than an invented split: guessing that
 * six columns are two groups of three would silently assert a design the file
 * never stated, and the mean of the wrong three numbers looks entirely
 * plausible on the page.
 */
export function dataBlocks(ds: Dataset): ColumnGroup[] {
  const width = ds.columns.length;
  const declared = (ds.columnGroups ?? [])
    .map((g) => ({ name: g.name, from: Math.max(0, g.from), to: Math.min(width - 1, g.to) }))
    .filter((g) => g.to >= g.from);
  if (declared.length > 0) return declared;

  // `nested` has no leading label or x column; the others carry exactly one.
  const first = ds.format === 'nested' ? 0 : 1;
  if (width <= first) return [];
  return [{ name: ds.columns[first]?.name ?? 'Group 1', from: first, to: width - 1 }];
}

/**
 * Split a dataset's data columns into equal blocks of `size`.
 *
 * The manual route when a file carries no group header row — an author who
 * knows their six columns are two groups of three can say so. Names come from
 * the first column of each block, which is what a spreadsheet user would have
 * called it anyway.
 */
export function blocksOfSize(ds: Dataset, size: number): ColumnGroup[] {
  const width = ds.columns.length;
  const first = ds.format === 'nested' ? 0 : 1;
  if (size < 1 || width <= first) return [];

  const out: ColumnGroup[] = [];
  for (let from = first; from < width; from += size) {
    const to = Math.min(from + size - 1, width - 1);
    out.push({ name: ds.columns[from]?.name ?? `Group ${out.length + 1}`, from, to });
  }
  return out;
}

/**
 * The row labels, when column 0 carries them. Empty for a table without.
 *
 * Nothing plots these — they name the rows for the author, in the data grid and
 * in a point's identity. Exposed so a caller does not re-derive "column 0 when
 * the flag is set" and get the format exceptions wrong.
 */
export function rowNames(ds: Dataset): string[] {
  if (!ds.hasRowNames) return [];
  return ds.rows.map((r) => (r[0] === null ? '' : String(r[0])));
}

/**
 * Paired (x, y) values read by *row index*, keeping only rows where both are
 * numbers.
 *
 * Reading the two columns independently and filtering each is what this
 * replaced, and it silently misplotted data: a blank y in the middle of a
 * column shortened that series by one, and the shared x was then truncated
 * from its *end* — so every point after the gap was drawn against the x of the
 * row before it. The gap was invisible and the resulting curve entirely
 * plausible. Dropping the whole pair is the only reading that cannot move a
 * point onto an x it was never measured at; `xyMarks` already applies exactly
 * this rule downstream, too late to help.
 */
function numericPairsAt(
  ds: Dataset,
  xIndex: number,
  yIndex: number,
): { values: number[]; x: number[] } {
  const values: number[] = [];
  const x: number[] = [];
  for (const row of ds.rows) {
    const xValue = row[xIndex];
    const yValue = row[yIndex];
    if (typeof xValue !== 'number' || typeof yValue !== 'number') continue;
    x.push(xValue);
    values.push(yValue);
  }
  return { values, x };
}
