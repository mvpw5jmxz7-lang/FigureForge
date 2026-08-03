/**
 * Demo figure used as the app's starting document.
 *
 * Shaped like real experimental data: a treatment column plus replicate
 * columns, which is what comes out of a plate reader or an image quantification
 * and is the format most authors will paste in.
 */

import {
  addPanelWithPlot,
  applyAutoLayout,
  blocksOfSize,
  createDocument,
  couldHaveRowNames,
  createIdFactory,
  dataColumnOffset,
  editDocument,
  GROUPED_FORMATS,
  inferFormat,
  parseDelimited,
  relabelPanels,
  type DataFormat,
  type Dataset,
  type ParseOptions,
  type FigureDocument,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';

export const SAMPLE_VIABILITY = `Treatment,Rep1,Rep2,Rep3,Rep4
Vehicle,98.2,95.4,101.3,97.8
10 µM,74.5,71.2,78.9,73.1
50 µM,42.1,38.7,45.3,40.2
100 µM,18.4,21.9,16.2,19.7`;

export const SAMPLE_EXPRESSION = `Genotype,Rep1,Rep2,Rep3
WT,1.02,0.98,1.00
KO,2.41,2.68,2.55
Rescue,1.18,1.09,1.24`;

/** Build a Dataset from pasted or imported delimited text. */
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

  // `defaultColumnName` produces A, B, C… when there was no header row. Those
  // are placeholders, not labels, and putting one on an axis is worse than
  // leaving it blank for the author to fill.
  const usable = (name: string | undefined): string | undefined =>
    name !== undefined && name !== '' && !/^[A-Z]{1,2}$/.test(name) ? name : undefined;

  return {
    ...(usable(x) ? { x: usable(x)! } : {}),
    ...(usable(y) ? { y: usable(y)! } : {}),
  };
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

export function createSampleDocument(): FigureDocument {
  const newId = createIdFactory();

  const base = createDocument({
    title: 'Compound X reduces viability and induces target expression',
    presetId: 'nature-double',
    widthMm: 183,
    heightMm: 75,
    idFactory: newId,
  });

  return editDocument(base, (draft) => {
    const viability = datasetFromText(SAMPLE_VIABILITY, 'Cell viability', newId());
    const expression = datasetFromText(SAMPLE_EXPRESSION, 'Target expression', newId());
    draft.datasets = [viability, expression];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Viability',
      datasetId: viability.id,
      plotType: 'bar-dot',
      yTitle: 'Cell viability (%)',
      xTitle: 'Compound X',
    });

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Expression',
      datasetId: expression.id,
      plotType: 'bar-dot',
      yTitle: 'Relative expression',
      xTitle: 'Genotype',
    });

    applyAutoLayout(draft, {
      marginMm: NATURE_THEME.spacing.marginMm,
      gutterMm: NATURE_THEME.spacing.panelGutterMm,
      labelGutterMm: 4,
    });

    relabelPanels(draft, newId, {
      fontSizePt: NATURE_THEME.type.panelLabelPt,
      offsetMm: 4,
    });
  });
}
