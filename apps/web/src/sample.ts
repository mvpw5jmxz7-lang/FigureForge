/**
 * Turning pasted or dropped text into a `Dataset`, and naming its axes.
 *
 * The file is named for what it used to hold: a seven-panel demo figure the
 * app opened with, built in round 35 to show what the renderer could draw and
 * to give Smart layout unlike panel demands to solve. Round 51 removed it —
 * the app now opens blank — along with the eight `SAMPLE_*` tables that only
 * existed to build it. What is left is the import path `SidePanel.tsx` calls
 * on every paste, which was always the load-bearing half of this module.
 */

import {
  blocksOfSize,
  couldHaveRowNames,
  dataColumnOffset,
  GROUPED_FORMATS,
  inferFormat,
  parseDelimited,
  type DataFormat,
  type Dataset,
  type ParseOptions,
} from '@figureforge/doc-model';

export interface ImportOptions extends ParseOptions {
  /**
   * Override the inferred layout.
   *
   * Detection is a heuristic on column shapes and names, and a wrong guess
   * silently changes what every series *is* — `prism` reads column 0 as one
   * shared x, `sigmaplot` reads the columns as independent pairs. The author is
   * the only one who actually knows, so they get the last word.
   */
  format?: DataFormat;
  /**
   * Override whether column 0 holds row labels rather than data.
   *
   * Same reason as `format`: "text column, then numbers" is both a row-labelled
   * xy table and a replicate table, and only the author knows which.
   */
  hasRowNames?: boolean;
  /**
   * Split the data columns into equal blocks of this size, for a grouped
   * layout whose file carries no group header row.
   *
   * The manual route: an author who knows their six columns are two groups of
   * three can say so. Nothing infers it — six columns are as plausibly six
   * groups of one, and a wrong split averages the wrong numbers together into
   * a mean that looks entirely reasonable.
   */
  replicatesPerGroup?: number;
}

export function datasetFromText(
  text: string,
  name: string,
  id: string,
  filename: string | null = null,
  options: ImportOptions = {},
): Dataset {
  const parsed = parseDelimited(text, options);
  /*
   * Never inferred: see `couldHaveRowNames`. Absent means "column 0 is data",
   * which is how every table has been read until now, so no existing import
   * changes meaning.
   *
   * Gated on the reading being *available*, not merely requested. The importer
   * keeps its overrides between pastes, so a table where column 0 really was a
   * label can be followed by one where it is the x values — and the setting
   * would otherwise still be applied, with the control that set it no longer
   * on screen to explain why.
   */
  const hasRowNames = (options.hasRowNames ?? false) && couldHaveRowNames(parsed.columns);

  const detected =
    options.format ??
    inferFormat(parsed.columns, { hasRowNames, columnGroups: parsed.columnGroups });

  /*
   * Saying "three columns per group" about a table *is* the statement that its
   * columns block into groups, so it is taken as one — for the shared-x shape
   * (which becomes XY+replicates) and for the labelled-rows shape (which becomes
   * Prism's Grouped).
   *
   * Without this the author has to say the same thing twice — pick the layout
   * from a dropdown that only lists it under a Prism name, *then* type the
   * count — and the control that takes the count is hidden until they have. A
   * count of 1 is not a claim about groups, so it changes nothing.
   */
  const format =
    (options.replicatesPerGroup ?? 0) >= 2
      ? detected === 'prism'
        ? 'xy-replicates'
        : detected === 'replicate'
          ? 'grouped-replicates'
          : detected
      : detected;

  const base: Dataset = {
    id,
    name,
    format,
    columns: parsed.columns,
    rows: parsed.rows,
    // Written only when true: absent is the shape every existing file has, and
    // an explicit `false` everywhere would be noise in every saved document.
    ...(hasRowNames ? { hasRowNames: true } : {}),
    ...(parsed.columnGroups.length > 0 ? { columnGroups: parsed.columnGroups } : {}),
    sourcePath: `data/${id}.csv`,
    sourceFilename: filename,
    importedAt: new Date().toISOString(),
  };

  /*
   * An explicit block size wins over whatever the header declared: the author
   * is looking at the preview and the file is not. Only for the layouts that
   * read blocks at all — setting it on a replicate table would store a reading
   * nothing consults, which is worse than storing nothing.
   */
  if (options.replicatesPerGroup && GROUPED_FORMATS.has(format)) {
    const blocks = blocksOfSize(base, options.replicatesPerGroup);
    if (blocks.length > 0) return { ...base, columnGroups: blocks };
  }
  return base;
}

/**
 * Axis titles a dataset's own header row already supplies.
 *
 * The header names were parsed, stored as `Column.name` and then ignored: every
 * imported panel got `yTitle: 'Value'` and no x title at all, so an author who
 * had already labelled their columns had to type both again. Only offered for
 * the layouts where a column *is* an axis — on a replicate table column 0 names
 * the groups, which the band labels already show.
 */
export function axisTitlesFor(dataset: Dataset): { x?: string; y?: string } {
  // `usable` is declared below and used by both paths; hoisted in reading order
  // only, since a function declaration is available throughout.
  /*
   * A fold-vs-fold table is the one shape where each axis is fed by exactly
   * one named column, so the "every column feeding this axis agrees" rule
   * below has nothing to decide and would reject the honest answer: it reads
   * `names.slice(1)` as the y candidates and finds two different names.
   *
   * Which makes it the opposite case to a volcano's, where `addPlot`
   * hardcodes the titles because neither header names what is drawn. Here the
   * headers are exactly the axis names an author wants — "97Q/25Q fold
   * enrichment" — and neither column is transformed on the way to the page.
   */
  if (dataset.format === 'fold-fold') {
    const x = usableAxisName(dataset.columns[1]?.name.trim());
    const y = usableAxisName(dataset.columns[2]?.name.trim());
    return { ...(x ? { x } : {}), ...(y ? { y } : {}) };
  }

  if (!CONTINUOUS_X_FORMATS.has(dataset.format)) return {};

  const first = dataColumnOffset(dataset);
  const names = dataset.columns.slice(first).map((c) => c.name.trim());

  /*
   * A column name titles an axis only when *every* column feeding that axis
   * carries it. Otherwise the name belongs to one series, the legend already
   * shows it, and putting it on the axis labels the whole quantity after a
   * third of it — `X1,Y1,X2,Y2,X3,Y3` was titling its axes "X1" and "Y1" while
   * "Y1" sat in the legend beside "Y2" and "Y3".
   *
   * The same rule reads the honest case correctly: a sedimentation export
   * headed `Radius,C(s)_run1,Radius,C(s)_run2` really does measure every run
   * against a radius, so "Radius" is the x axis.
   */
  const agreed = (values: readonly string[]): string | undefined =>
    values.length > 0 && values.every((v) => v === values[0]) ? values[0] : undefined;

  const isPaired = dataset.format === 'sigmaplot';
  const x = agreed(isPaired ? names.filter((_, i) => i % 2 === 0) : names.slice(0, 1));
  /*
   * Only where the y columns really are one quantity. On a replicate-blocked
   * table the second column is `A:Y1` — one replicate of one group — and on a
   * shared-x table the y columns are the series names.
   */
  const y =
    dataset.format === 'xy-replicates'
      ? undefined
      : agreed(isPaired ? names.filter((_, i) => i % 2 === 1) : names.slice(1));

  return {
    ...(usableAxisName(x) ? { x: usableAxisName(x)! } : {}),
    ...(usableAxisName(y) ? { y: usableAxisName(y)! } : {}),
  };
}

/**
 * `defaultColumnName` produces A, B, C… when there was no header row. Those are
 * placeholders, not labels, and putting one on an axis is worse than leaving it
 * blank for the author to fill.
 *
 * Lifted out of `axisTitlesFor` so the fold-vs-fold branch above applies the
 * identical rule rather than a second, drifting copy of it.
 */
function usableAxisName(name: string | undefined): string | undefined {
  return name !== undefined && name !== '' && !/^[A-Z]{1,2}$/.test(name) ? name : undefined;
}

/** Layouts whose column 0 (or 1) is an x axis rather than a group label. */
const CONTINUOUS_X_FORMATS: ReadonlySet<DataFormat> = new Set<DataFormat>([
  'simple-xy',
  'prism',
  'sigmaplot',
  // Column 0 is the shared x here too; the y columns are named by their groups,
  // so only the x title is worth taking.
  'xy-replicates',
]);
