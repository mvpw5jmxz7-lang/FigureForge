/**
 * Datasets and tabular import.
 *
 * The verbatim import survives in the project file exactly as it arrived —
 * `buildArchiveContents` writes it at `sourcePath` — and that is what the
 * reproducibility claim rests on. Plots read through the accessors below rather
 * than transforming in place.
 *
 * A table may also be *edited*, in the data grid; the edited cells travel in
 * `document.json` beside the untouched original, and `editedAt` says so. Both
 * are kept, and they are distinguishable, which is the property that matters.
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
   * Y1,Y2,Y3,… — one *column* per group, each holding that group's own stack
   * of observations. Prism calls this a Column table.
   *
   * This is `replicate` read down the columns instead of across the rows, and
   * it is a separate member for the same reason `contingency` and `proteomics`
   * are: the numbers mean something different, so a different set of tests
   * applies. A replicate row is several measurements of *one* thing, and its
   * mean and SEM are the reading. A column here is a *sample from a
   * distribution* — its shape is the reading, its n is routinely hundreds, and
   * what one asks of it is whether two such samples were drawn from the same
   * distribution (Kolmogorov–Smirnov and its relatives), not whether two means
   * differ.
   *
   * Columns are also allowed to be **ragged** — groups genuinely differ in
   * size, unlike replicates of a single measurement, which come in matched
   * sets. That needs no special handling: `parseDelimited` pads short rows
   * with nulls, `columnKindFor` still reports `'number'` for an all-null-or-
   * number column, and `toSeries` drops the non-numbers per column.
   *
   * Never auto-inferred, the same stance every declared format takes. Nothing
   * at the cell level separates a table of observation columns from a shared-x
   * table with several y series — which is exactly what `inferFormat` would
   * otherwise call it, silently consuming the first group as an axis.
   */
  | 'distribution'
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
   * ProteinID,Sample1,Sample2,… — per-sample intensities (LFQ and the like),
   * one row per protein.
   *
   * Structurally identical to `replicate`, and deliberately a separate member
   * for exactly the reason `contingency` above is: the numbers mean something
   * different, and a different set of tests applies. A replicate table's rows
   * are treatment groups to compare against each other; these rows are
   * *features*, and comparing one protein against another is not a question
   * anyone is asking. The comparison runs down the columns instead — which is
   * what the Perseus-style S0/FDR permutation volcano test does, and it is
   * the only test offered here.
   *
   * Never auto-inferred, the same stance `contingency`, `matrix`,
   * `differential` and `survival` all take: nothing at the cell level
   * separates this from any other table of replicate measurements, so the
   * author declares it. That declaration is also what keeps the volcano test
   * from being offered beside every unrelated table in the document.
   */
  | 'proteomics'
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
  | 'nested'
  /**
   * Feature, log2FoldChange, pValue — one row per gene/feature, exactly three
   * columns in this order.
   *
   * Structurally identical to `replicate` (a text column followed by numeric
   * columns) and deliberately a separate member anyway, for the same reason
   * `contingency` is: the two numeric columns mean specific, fixed things — an
   * effect size and a significance value, not interchangeable replicate
   * measurements — and nothing in the cells can tell the two readings apart.
   * Never auto-inferred, for the same reason `contingency` never is: guessing
   * wrong would draw meaningless bars off frequencies there, or a meaningless
   * volcano off two columns that were actually replicates here. The author
   * states it.
   *
   * A raw DESeq2/edgeR/limma export has more columns than this (baseMean,
   * lfcSE, stat, padj, …) in a different order. This format does not guess
   * which two matter — trim and reorder to this shape first, with the column
   * tools the data grid already has, the same "reshape before declaring the
   * layout" convention every other format already follows.
   */
  | 'differential'
  /**
   * Feature, log2FC (x), log2FC (y) — one row per protein or gene, carrying
   * the same feature's effect size in *two* comparisons: 97Q/25Q against
   * 97Q/APEX, treated against control in two cell lines, and so on. Drawn as
   * a fold-vs-fold scatter, where the question is whether the two contrasts
   * agree.
   *
   * Exactly the same three-column shape as `differential`, and a separate
   * member for exactly the reason `pca` and `umap` are separate from it and
   * from each other: nothing at the cell level distinguishes two effect sizes
   * from an effect size and a significance value, and reading one as the
   * other is not a near miss. A `differential` table drawn this way would
   * plot a p-value as a fold change; a fold-fold table drawn as a volcano
   * would take −log10 of a negative number and silently drop every
   * down-regulated protein. Never auto-inferred; the author states it.
   */
  | 'fold-fold'
  /**
   * RowLabel,Col1,Col2,… — a dense matrix, one continuous numeric value per
   * (row, column) cell: a gene-expression table, a correlation matrix, a
   * distance matrix.
   *
   * Structurally identical to `contingency` — same header shape, same "text
   * column then numbers" cells — and deliberately a separate member for the
   * same reason `contingency` is separate from `replicate`: the numbers mean
   * something different. A matrix cell is not a count to test, it is a value
   * to colour, and nothing in the cells says which reading is meant. Never
   * auto-inferred; the author states it.
   */
  | 'matrix'
  /**
   * Time, Event, Group? — one row per subject: a time to an event or to
   * censoring, a 1/0 event flag (1 = the event happened, 0 = the subject was
   * censored — lost to follow-up, or still event-free when the study ended),
   * and an optional treatment/arm column.
   *
   * Never auto-inferred, for the same reason `differential` and `matrix`
   * never are: a bare three-numeric-column table reads just as plausibly as
   * `replicate` (three repeated measurements) as it does as a survival time
   * plus a 0/1 flag, and guessing wrong draws a Kaplan–Meier curve off
   * numbers that were never a time-to-event at all. The author states it.
   */
  | 'survival'
  /**
   * SampleLabel, PC1, PC2 — the first two principal components of a sample
   * scatter, one row per original sample. Exactly three columns, fixed
   * order, the same shape `differential` uses and deliberately a separate
   * member for the same reason: the numbers mean something specific — two
   * component scores computed once, server side — not interchangeable
   * replicate measurements.
   *
   * Unlike every other format, this one is never something a pasted file
   * arrives shaped as — it is produced only by the "Run PCA" action, never
   * offered as an import layout. It still gets the ordinary `inferFormat`
   * exclusion below, since its shape is identical to `differential`'s and
   * guessing wrong would misread one as the other.
   */
  | 'pca'
  /**
   * SampleLabel, UMAP1, UMAP2 — a 2D UMAP embedding, one row per original
   * sample. Same three-column shape as `pca` and produced the same way, by
   * an action rather than an import (`inferFormat` never returns it, for the
   * identical reason). Kept as its own member rather than reusing `pca`
   * outright because the axes mean something different: there is no
   * per-axis percentage-of-variance-explained concept for a nonlinear
   * embedding, so nothing here should imply one the way a `pca` axis title
   * does.
   */
  | 'umap';

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
  /**
   * When the table was last edited in the data grid, if it ever was.
   *
   * The reproducibility claim survives editing without weakening: the verbatim
   * import stays at `sourcePath` in the archive and the edited table travels in
   * `document.json`, so both are kept. What was missing was any way to *tell*,
   * and a figure whose numbers no longer match the file beside them is exactly
   * the thing that claim exists to prevent. Analyses go stale on their own —
   * `analysisInputHash` reads the rows.
   */
  editedAt?: string;
  /**
   * The dataset this one was computed from, when it is an analysis output
   * rather than something imported.
   *
   * Stored rather than re-derived from the generated name: a name is editable
   * in the dataset list, and two derivations of one fact are how the two come
   * to disagree — the same discipline `analysisInputHash` and
   * `scaleBarWidthMm` are each held to.
   *
   * What it buys is that re-running an analysis can *replace* its previous
   * output instead of appending a second copy of it, the same stance
   * `replaceAnalysisForPlot` already takes for statistical tests. Only the
   * volcano test writes it today; PCA and UMAP deliberately still append,
   * since neither was reported as a problem and changing them would alter
   * behaviour nobody asked about.
   */
  derivedFrom?: { datasetId: DatasetId; kind: 'volcano-test' };
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
 * Column blocks from a *single* header row whose group titles were merged cells.
 *
 * A spreadsheet can declare its blocks in one row rather than two: Excel merges
 * `B1:D1` into "Control" and `E1:G1` into "Treated", and a copy of that table
 * arrives as `Hours\tControl\t\t\tTreated\t\t`. That is the same declaration
 * `columnGroupsFromHeader` already reads from a two-row Prism header — the only
 * difference being that here the x column's own title shares the row with the
 * group titles, instead of sitting in a second row beneath them.
 *
 * Which is why this cannot simply call that function: `Hours` at index 0 would
 * become a block of its own, and `inferFormat` reads a block starting at column
 * 0 as Prism's Nested layout.
 *
 * So the reading is *offered only for the shape it describes* — a table of equal
 * replicate blocks, which is the one thing Prism's `replicatesCount` can mean:
 *
 * - at most one leading single-column block, the x or row-label column;
 * - every block after it the same width, of at least two columns;
 * - at least one such block.
 *
 * Anything else returns nothing and the table parses exactly as it did before.
 * The guards are load-bearing rather than defensive: without the equal-width
 * test a stray trailing delimiter (`A,B,C,` parses four columns wide) declares
 * `C` a two-column group, and without the leading-singleton limit any partly
 * filled header row starts inventing blocks. A header that names every column is
 * not sparse, produces nothing here, and so cannot change meaning.
 */
export function mergedHeaderGroups(header: readonly string[], width: number): ColumnGroup[] {
  const all = columnGroupsFromHeader(header, width);

  const leading = all.findIndex((g) => g.to > g.from);
  if (leading < 0 || leading > 1) return [];

  const blocks = all.slice(leading);
  const size = blocks[0]!.to - blocks[0]!.from + 1;
  if (blocks.some((g) => g.to - g.from + 1 !== size)) return [];

  return blocks;
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
  /*
   * With one header row the blocks can still be declared, by merged cells — see
   * `mergedHeaderGroups`, which refuses every shape but the replicate table this
   * reading exists for.
   */
  const columnGroups =
    headerRows >= 2
      ? columnGroupsFromHeader(groupRow, width)
      : headerRows === 1
        ? mergedHeaderGroups(headerNames, width)
        : [];

  const bodyRows = cells.slice(headerRows).map((row) => {
    const padded: CellValue[] = [];
    for (let i = 0; i < width; i++) padded.push(parseCell(row[i] ?? ''));
    return padded;
  });

  const columns: Column[] = [];
  for (let i = 0; i < width; i++) {
    const name = (headerNames[i] ?? '').trim() || defaultColumnName(i);
    columns.push({ name, kind: columnKindFor(bodyRows.map((r) => r[i] ?? null)) });
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

/**
 * Whether a column of cells reads as numbers or as text.
 *
 * A column with nothing but blanks is a numeric column with missing data far
 * more often than it is a text column. Typing it as text would change the
 * inferred layout of the whole file and silently drop the other replicates
 * along with it.
 *
 * The one implementation, shared by the parser and by every edit made in the
 * data grid — a cell edited from `12` to `n/a` retypes its column, and two
 * derivations of that rule would eventually disagree about the same table.
 */
export function columnKindFor(values: readonly CellValue[]): ColumnKind {
  const present = values.filter((v) => v !== null);
  return present.length === 0 || present.every((v) => typeof v === 'number') ? 'number' : 'text';
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
  /**
   * Per-point identity, parallel to `x` — one label per (x, value) pair, in
   * the same order. Only `'differential'` populates it today.
   *
   * A parallel array rather than a richer point object, mirroring `x` itself:
   * every existing consumer (`hasReplicatesAtX`, the Stats tab, `xyMarks`)
   * already reads `.values`/`.x` as flat number arrays, and a point-object
   * shape would force all of them to change for a feature only one plot type
   * needs.
   */
  pointLabels?: readonly string[];
  /**
   * Per-point FDR/q-value, parallel to `x`/`pointLabels` — a 4th column,
   * present only when a `'differential'` dataset supplies one. Unlike
   * `x`/`values`/`pointLabels`, a blank cell does **not** drop the row: a
   * missing q-value means "no FDR call for this point," not "this point
   * does not exist" (a real per-protein output — Perseus's own "Significant"
   * columns are exactly this sparse). Recorded as `NaN` at that index.
   */
  qValues?: number[];
}

/** How a two-factor series is named, so nothing composes it a second way. */
export const compositeSeriesName = (category: string, group: string): string =>
  `${category} — ${group}`;

/**
 * Whether these series position their marks by two factors.
 *
 * The renderer decides which band scale to build on this, and the Inspector
 * decides whether there is a within-group gap to offer. Spelling it twice is
 * how the two come to disagree about what a grouped plot is, which would show
 * up as a control that adjusts nothing.
 */
export function isTwoFactor(series: readonly Series[]): boolean {
  return (
    series.length > 0 && series.every((s) => s.category !== undefined && s.group !== undefined)
  );
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

    // A proteomics intensity table reads structurally exactly as a replicate
    // one — a label column then numbers — so the generic reading is shared.
    // What differs is which *tests* apply to it, which is settled in the
    // Stats tab, not here.
    case 'proteomics':
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

    // The transpose of the arm above: a group per *column*, named by its own
    // header, holding that column's stack of observations.
    //
    // Columns are read independently rather than by row, which is what lets
    // them be ragged — a shorter group is simply a column with fewer numbers
    // in it, not a row that has to be padded to match its neighbours. A text
    // column declared into this layout by mistake filters down to no numbers
    // and drops out here, rather than drawing an empty group.
    case 'distribution': {
      return ds.columns
        .map((column, index) => ({
          name: column.name,
          values: ds.rows
            .map((row) => row[index])
            .filter((v): v is number => typeof v === 'number'),
        }))
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

    case 'differential': {
      // A 4th column, when present, is an FDR/q-value per point — detected
      // purely by column count, the same convention `toSurvivalGroups`
      // already uses for its optional trailing `Group` column.
      const [labelCol, fcCol, pCol] = ds.columns;
      if (!labelCol || !fcCol || !pCol) return [];
      const qIndex = ds.columns.length >= 4 ? 3 : undefined;
      return [{ name: ds.name, ...numericPairsAt(ds, 1, 2, 0, qIndex) }];
    }

    case 'fold-fold': {
      // The same read as `differential` above — a label and two numbers per
      // row — with no q-value column: both numbers here are effect sizes, so
      // there is no significance value to carry. What separates the two
      // formats is what the second number *means*, which is why they are
      // separate members and why this arm cannot simply be merged into that
      // one: `differential` would offer an FDR column this shape never has.
      const [labelCol, xCol, yCol] = ds.columns;
      if (!labelCol || !xCol || !yCol) return [];
      return [{ name: ds.name, ...numericPairsAt(ds, 1, 2, 0) }];
    }

    case 'matrix': {
      /*
       * One series per cell, mirroring `contingency`'s reading — but this
       * exists only so generic UI that calls `toSeries` for display (the
       * dataset list's "N series" count) reads sensibly. The heatmap itself
       * reads through `toMatrix`, never this: a dense grid has no use for
       * `category`/`group` two-factor band clustering, and this shape would
       * pull it into machinery built for pairwise group comparison.
       */
      const cols = ds.columns.slice(1);
      const out: Series[] = [];
      for (const row of ds.rows) {
        const rowName = row[0] === null ? '' : String(row[0]);
        if (rowName === '') continue;
        cols.forEach((col, i) => {
          const value = row[i + 1];
          if (typeof value !== 'number') return;
          out.push({
            name: compositeSeriesName(rowName, col.name),
            values: [value],
            category: rowName,
            group: col.name,
          });
        });
      }
      return out;
    }

    case 'survival': {
      /*
       * One series per group, times only — exists purely so generic UI that
       * calls `toSeries` for display (the dataset list's "N series" count)
       * reads sensibly. The plot itself reads through `toSurvivalGroups`,
       * never this: a subject row is not a replicate to pool, and this shape
       * has nowhere to carry the event/censoring flag `toSurvivalGroups`
       * keeps.
       */
      return toSurvivalGroups(ds).map((g) => ({ name: g.name, values: g.times }));
    }

    case 'pca':
    case 'umap': {
      const [labelCol, c1Col, c2Col] = ds.columns;
      if (!labelCol || !c1Col || !c2Col) return [];
      return [{ name: ds.name, ...numericPairsAt(ds, 1, 2, 0) }];
    }

    case 'simple-xy':
    default: {
      const first = dataColumnOffset(ds);
      const name = ds.columns[first + 1]?.name ?? 'Y';
      return [{ name, ...numericPairsAt(ds, first, first + 1) }];
    }
  }
}

export interface Matrix {
  rowLabels: string[];
  colLabels: string[];
  /** `cells[row][col]`. `null` is a distinct "no data" cell, not an absence. */
  cells: (number | null)[][];
}

/**
 * Read a `'matrix'` dataset as a dense grid, bypassing `Series` entirely.
 *
 * A heatmap cell is not a replicate to pool and not a group to compare —
 * `Series.category`/`.group` exist for pairwise band clustering and a
 * discrete legend, neither of which a dense N×M grid wants, and `Series.name`
 * is a join key for brackets and stats this plot never uses. A dedicated
 * accessor keeps the grid's own shape instead of forcing it through one built
 * for something else.
 *
 * Every (row, col) position is kept, `null` where the cell was blank or
 * non-numeric — `toSeries`'s per-cell formats silently drop such a cell
 * instead, which is right for a bar (nothing to draw) and wrong for a grid
 * (a position with no data is still a position; a reader has to be able to
 * tell it apart from a cell that was never looked at).
 */
export function toMatrix(ds: Dataset): Matrix {
  const colLabels = ds.columns.slice(1).map((c) => c.name);
  const rowLabels: string[] = [];
  const cells: (number | null)[][] = [];

  for (const row of ds.rows) {
    const rowName = row[0] === null ? '' : String(row[0]);
    if (rowName === '') continue;
    rowLabels.push(rowName);
    cells.push(colLabels.map((_, i) => {
      const value = row[i + 1];
      return typeof value === 'number' ? value : null;
    }));
  }

  return { rowLabels, colLabels, cells };
}

/** One arm's subject-level follow-up data, ready for the Kaplan–Meier estimator. */
export interface SurvivalGroup {
  name: string;
  times: number[];
  /** `true` = the event happened at this subject's time; `false` = censored. */
  events: boolean[];
}

/**
 * Read a `'survival'` dataset as one or more arms, bypassing `Series` entirely.
 *
 * A subject row is not a replicate to pool — `Series.values`/`.category`/
 * `.group` exist for pairwise band clustering and averaging, neither of which
 * a time-to-event curve wants, and there is nowhere in `Series` to carry the
 * event/censoring flag every KM point needs. A dedicated accessor keeps the
 * subject-level shape instead of forcing it through machinery built for
 * something else — the same call `toMatrix` made for heatmaps.
 *
 * Column 0 is time, column 1 is the 0/1 event flag, column 2 (if present) is
 * the arm. Absent, every subject is one implicit group named for the dataset
 * — `toSurvivalGroups` is what a single-arm curve and a multi-arm one both
 * read through, so nothing downstream needs to special-case the ungrouped
 * case.
 */
export function toSurvivalGroups(ds: Dataset): SurvivalGroup[] {
  const hasGroupColumn = ds.columns.length >= 3;
  const byGroup = new Map<string, { times: number[]; events: boolean[] }>();

  for (const row of ds.rows) {
    const time = row[0];
    const eventFlag = row[1];
    if (typeof time !== 'number' || typeof eventFlag !== 'number') continue;
    const groupValue = hasGroupColumn ? row[2] : null;
    const groupName = groupValue === null ? ds.name : String(groupValue);
    let bucket = byGroup.get(groupName);
    if (!bucket) {
      bucket = { times: [], events: [] };
      byGroup.set(groupName, bucket);
    }
    bucket.times.push(time);
    bucket.events.push(eventFlag !== 0);
  }

  return [...byGroup.entries()].map(([name, g]) => ({ name, ...g }));
}

/**
 * Whether any series measures the same x more than once.
 *
 * The question that decides whether a centre and an error interval mean
 * anything on a continuous plot: with one y per x there is nothing to summarise
 * and the interval would be a zero-width hairline asserting a precision the data
 * never had. Asked of the *series* rather than of the format, so a table that
 * carries repeats without declaring itself a replicate layout is read honestly.
 *
 * The renderer makes the same decision again, downstream and on scaled
 * positions, because by then a broken axis may have removed points this cannot
 * know about. This one exists to decide what the Inspector *offers*.
 */
export function hasReplicatesAtX(ds: Dataset): boolean {
  return toSeries(ds).some((s) => {
    if (!s.x) return false;
    const seen = new Set<number>();
    return s.x.some((v) => (seen.has(v) ? true : (seen.add(v), false)));
  });
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
 *
 * Unless the parser invented those names. A table pasted with no header row at
 * all has columns called `A`, `B`, `C`, and naming the blocks after them puts a
 * legend reading "B, E, H" on the figure — labels that name nothing in the
 * author's data and read as though they did. `Group 1` at least says what it is.
 * The test is that *every* column carries its positional name, which a real
 * header cannot manage past the first column or two, so a spreadsheet with a
 * column genuinely titled "B" keeps it.
 */
export function blocksOfSize(ds: Dataset, size: number): ColumnGroup[] {
  const width = ds.columns.length;
  const first = ds.format === 'nested' ? 0 : 1;
  if (size < 1 || width <= first) return [];

  const unnamed = ds.columns.every((c, i) => c.name === defaultColumnName(i));

  const out: ColumnGroup[] = [];
  for (let from = first; from < width; from += size) {
    const to = Math.min(from + size - 1, width - 1);
    const header = ds.columns[from]?.name;
    out.push({
      name: !unnamed && header !== undefined ? header : `Group ${out.length + 1}`,
      from,
      to,
    });
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
/**
 * Which column carries a row's point-label identity, for a format that has
 * one — `null` otherwise.
 *
 * Spelled once here rather than left implicit in each `toSeries` case's own
 * `numericPairsAt(ds, 1, 2, 0)` call, so a caller that needs to map a row
 * back to the label `Series.pointLabels` would carry (the data grid's
 * row-to-label lookup for volcano point selection) reads the same fact
 * `toSeries` itself acts on, rather than a second guess at it.
 */
export function pointLabelColumnIndex(ds: Dataset): number | null {
  switch (ds.format) {
    case 'differential':
    case 'fold-fold':
    case 'pca':
    case 'umap':
      return 0;
    default:
      return null;
  }
}

function numericPairsAt(
  ds: Dataset,
  xIndex: number,
  yIndex: number,
  /**
   * Column holding a per-point identity, e.g. a gene name. When given, a row
   * whose label is null is dropped along with a row whose x or y is missing —
   * a point with no identity is not a point `pointLabels`' callers can use.
   */
  labelIndex?: number,
  /**
   * Column holding a per-point FDR/q-value, e.g. a differential table's
   * optional 4th column. Unlike `labelIndex`, a missing or non-numeric cell
   * does NOT drop the row — it is recorded as `NaN`, meaning "no FDR call for
   * this point," which is a different fact from "this point does not exist."
   */
  qIndex?: number,
): { values: number[]; x: number[]; pointLabels?: string[]; qValues?: number[] } {
  const values: number[] = [];
  const x: number[] = [];
  const pointLabels: string[] | undefined = labelIndex === undefined ? undefined : [];
  const qValues: number[] | undefined = qIndex === undefined ? undefined : [];
  for (const row of ds.rows) {
    const xValue = row[xIndex];
    const yValue = row[yIndex];
    if (typeof xValue !== 'number' || typeof yValue !== 'number') continue;
    if (labelIndex !== undefined) {
      const label = row[labelIndex];
      if (label === null) continue;
      pointLabels!.push(String(label));
    }
    x.push(xValue);
    values.push(yValue);
    if (qIndex !== undefined) {
      const q = row[qIndex];
      qValues!.push(typeof q === 'number' ? q : NaN);
    }
  }
  return { values, x, ...(pointLabels ? { pointLabels } : {}), ...(qValues ? { qValues } : {}) };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Pure transforms over a dataset's cells, for the data grid.
 *
 * Imported data was previously immutable — the comment at the top of this file
 * still says the numbers survive in the project file exactly as they arrived,
 * and they do: `buildArchiveContents` writes the *verbatim* import at
 * `sourcePath` and the edited table travels in `document.json`, so both are
 * kept and they are distinguishable. `editedAt` is what says which is which.
 *
 * Every transform re-derives the affected column kinds, because a cell edited
 * from `12` to `n/a` retypes its column and the layout is inferred from those
 * types. Skipping it leaves a table whose declared shape no longer matches its
 * contents, which is the same class of silent misreading as the import bugs.
 */
function retyped(ds: Dataset, rows: CellValue[][], columns: Column[]): Dataset {
  return {
    ...ds,
    columns: columns.map((c, i) => ({ ...c, kind: columnKindFor(rows.map((r) => r[i] ?? null)) })),
    rows,
    editedAt: new Date().toISOString(),
  };
}

const copyRows = (ds: Dataset): CellValue[][] => ds.rows.map((r) => [...r]);

/** Set one cell from raw text, parsed exactly as an import would parse it. */
export function setCell(ds: Dataset, row: number, col: number, raw: string): Dataset {
  if (row < 0 || row >= ds.rows.length || col < 0 || col >= ds.columns.length) return ds;
  const rows = copyRows(ds);
  rows[row]![col] = parseCell(raw);
  return retyped(ds, rows, [...ds.columns]);
}

/** Insert a blank row at `at`; `at === rows.length` appends. */
export function insertRow(ds: Dataset, at: number): Dataset {
  const index = Math.min(Math.max(at, 0), ds.rows.length);
  const rows = copyRows(ds);
  rows.splice(index, 0, ds.columns.map(() => null));
  return retyped(ds, rows, [...ds.columns]);
}

export function removeRow(ds: Dataset, at: number): Dataset {
  if (at < 0 || at >= ds.rows.length) return ds;
  const rows = copyRows(ds);
  rows.splice(at, 1);
  return retyped(ds, rows, [...ds.columns]);
}

/**
 * Insert a blank column at `at`, shifting the group blocks around it.
 *
 * The blocks are column *indices*, so leaving them alone would silently
 * repoint every one after the insertion at its neighbour — a group would
 * quietly acquire a column belonging to the next group, and its mean would
 * change without anything on screen saying so.
 */
export function insertColumn(ds: Dataset, at: number, name?: string): Dataset {
  const index = Math.min(Math.max(at, 0), ds.columns.length);
  const rows = copyRows(ds).map((r) => {
    const next = [...r];
    next.splice(index, 0, null);
    return next;
  });
  const columns = [...ds.columns];
  columns.splice(index, 0, { name: name ?? defaultColumnName(index), kind: 'number' });

  const groups = ds.columnGroups?.map((g) => ({
    name: g.name,
    from: g.from >= index ? g.from + 1 : g.from,
    // A column inserted *inside* a block extends it; one inserted before it
    // moves the whole block along.
    to: g.to >= index ? g.to + 1 : g.to,
  }));

  return { ...retyped(ds, rows, columns), ...(groups ? { columnGroups: groups } : {}) };
}

export function removeColumn(ds: Dataset, at: number): Dataset {
  if (at < 0 || at >= ds.columns.length) return ds;
  const rows = copyRows(ds).map((r) => {
    const next = [...r];
    next.splice(at, 1);
    return next;
  });
  const columns = [...ds.columns];
  columns.splice(at, 1);

  const groups = ds.columnGroups
    ?.map((g) => ({
      name: g.name,
      from: g.from > at ? g.from - 1 : g.from,
      to: g.to >= at ? g.to - 1 : g.to,
    }))
    // A block whose every column has gone is not an empty group, it is no group.
    .filter((g) => g.to >= g.from);

  return { ...retyped(ds, rows, columns), ...(groups ? { columnGroups: groups } : {}) };
}

/**
 * Swap column `at` with its left (`'left'`) or right (`'right'`) neighbour —
 * metadata and every row's cell together, so a moved column keeps its data.
 *
 * A no-op at either boundary, and a no-op whenever `columnGroups` is
 * declared: a block is a contiguous *range* of indices, and swapping two
 * columns can move one across a block boundary without there being a
 * sensible new contiguous range to describe it — the same reasoning
 * `insertColumn`/`removeColumn` apply to *shifting* a range does not extend
 * to *swapping within* one. This is for the ungrouped shapes
 * (`differential`, `pca`, `umap`, `simple-xy`, `survival`, `matrix`), which
 * is also where a raw export's column order most often needs correcting
 * before choosing a layout.
 */
export function moveColumn(ds: Dataset, at: number, direction: 'left' | 'right'): Dataset {
  if (ds.columnGroups && ds.columnGroups.length > 0) return ds;
  const other = direction === 'left' ? at - 1 : at + 1;
  if (at < 0 || at >= ds.columns.length || other < 0 || other >= ds.columns.length) return ds;

  const rows = copyRows(ds).map((r) => {
    const next = [...r];
    const a = next[at]!;
    next[at] = next[other]!;
    next[other] = a;
    return next;
  });
  const columns = [...ds.columns];
  const a = columns[at]!;
  columns[at] = columns[other]!;
  columns[other] = a;

  return retyped(ds, rows, columns);
}

export function renameColumn(ds: Dataset, at: number, name: string): Dataset {
  if (at < 0 || at >= ds.columns.length) return ds;
  const columns = ds.columns.map((c, i) => (i === at ? { ...c, name } : { ...c }));
  return { ...ds, columns, editedAt: new Date().toISOString() };
}

/**
 * Paste a block of delimited text with its top-left cell at (row, col).
 *
 * Runs through `parseDelimited` with the header row forced off, so an Excel
 * paste — which is tab-delimited — lands exactly as it looks, and a block whose
 * first row happens to be non-numeric is not silently eaten as a header.
 *
 * Grows the table to fit rather than clipping: a paste that lost its last two
 * rows without saying so is the kind of quiet truncation that ends up in a
 * figure.
 */
export function pasteBlock(ds: Dataset, row: number, col: number, text: string): Dataset {
  const block = parseDelimited(text, { hasHeader: false });
  if (block.rows.length === 0) return ds;

  const neededRows = row + block.rows.length;
  const neededCols = col + (block.columns.length || 1);

  const columns = [...ds.columns];
  while (columns.length < neededCols) {
    columns.push({ name: defaultColumnName(columns.length), kind: 'number' });
  }

  const rows = copyRows(ds).map((r) => {
    const next = [...r];
    while (next.length < columns.length) next.push(null);
    return next;
  });
  while (rows.length < neededRows) rows.push(columns.map(() => null));

  block.rows.forEach((source, dy) => {
    source.forEach((value, dx) => {
      const target = rows[row + dy];
      if (target) target[col + dx] = value;
    });
  });

  return retyped(ds, rows, columns);
}

/**
 * Blank every cell in a rectangle, leaving the table's shape alone.
 *
 * Clearing contents is not the same operation as removing rows or columns —
 * those already have their own `×` buttons, and a Delete key that silently
 * restructured the table would be a much bigger action than the one the author
 * asked for. Positions are kept and set to `null`, the same value the parser
 * writes for a blank cell, so a cleared cell is indistinguishable from one that
 * arrived empty.
 *
 * Clamped rather than bounds-rejected, because the caller is a selection
 * rectangle: dragging past the last row is an ordinary thing to do, and
 * refusing the whole clear over it would be surprising.
 *
 * Note this cannot silently retype a numeric column: `columnKindFor` reports an
 * entirely blank column as `'number'`, so clearing every value in one leaves
 * the inferred layout exactly where it was.
 */
export function clearBlock(ds: Dataset, r0: number, c0: number, r1: number, c1: number): Dataset {
  const rowStart = Math.max(0, Math.min(r0, r1));
  const rowEnd = Math.min(ds.rows.length - 1, Math.max(r0, r1));
  const colStart = Math.max(0, Math.min(c0, c1));
  const colEnd = Math.min(ds.columns.length - 1, Math.max(c0, c1));
  if (rowStart > rowEnd || colStart > colEnd) return ds;

  const rows = copyRows(ds);
  let changed = false;
  for (let r = rowStart; r <= rowEnd; r++) {
    const target = rows[r];
    if (!target) continue;
    for (let c = colStart; c <= colEnd; c++) {
      if (target[c] === null) continue;
      target[c] = null;
      changed = true;
    }
  }
  // An all-blank selection would otherwise stamp `editedAt` and land an undo
  // entry for a keystroke that changed nothing.
  if (!changed) return ds;

  return retyped(ds, rows, [...ds.columns]);
}

/**
 * Serialise a rectangular block of cells as tab/newline-delimited text — the
 * inverse of `pasteBlock`, and the same shape Excel puts on the clipboard, so
 * a copied block round-trips through a real spreadsheet and back.
 */
export function copyBlock(ds: Dataset, r0: number, c0: number, r1: number, c1: number): string {
  const rows: string[] = [];
  for (let r = r0; r <= r1; r++) {
    const cells: string[] = [];
    for (let c = c0; c <= c1; c++) {
      const value = ds.rows[r]?.[c] ?? null;
      cells.push(value === null ? '' : String(value));
    }
    rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}
