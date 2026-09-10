/**
 * High-level document operations.
 *
 * Node factories and composite edits, kept in the model rather than the UI so
 * that tests, the export service and any future desktop shell all build figures
 * through exactly the same code path the interface uses.
 *
 * Every function here mutates an Immer draft; callers wrap them in
 * `store.commit`, which turns them into undoable patches.
 */

import { current, isDraft } from 'immer';
import type { Analysis } from './analysis.js';
import { significanceStars } from './analysis.js';
import type { DataFormat, Dataset } from './data.js';
import { isTwoFactor, toSeries } from './data.js';
import type { Asset, FigureDocument } from './document.js';
import { compareDrawOrder, layerByName, nextZ } from './document.js';
import type { FitAlign, PointMm, RectMm } from './geometry.js';
import { aspectShape, fitAspectAligned, fitShape, union } from './geometry.js';
import type { ShapeMm } from './geometry.js';
import {
  alignFrames,
  autoLayout,
  distributeFrames,
  gridCells,
  layoutUnits,
  readingOrder,
  rowBands,
  suggestGrid,
  type AlignMode,
  type GridSlot,
  type LayoutUnit,
  type GridSpec,
  type GuideAxis,
  type LayoutOptions,
} from './layout.js';
import type { LayoutTemplate } from './templates.js';
import {
  clearanceForLabel,
  DEFAULT_GROUP_LABEL_PT,
  GROUP_LABEL_OVERLAY_PAD_MM,
  panelLetterHeightMm,
} from './grouplabel.js';
import { ptToMm } from './units.js';
import {
  absoluteFrame,
  childrenOf,
  CONTINUOUS_X_PLOT_TYPES,
  DEFAULT_FOLD_FOLD_THRESHOLDS,
  DEFAULT_VOLCANO_THRESHOLDS,
  descendantsOf,
  isEffectivelyLocked,
} from './nodes.js';
import type {
  ArrowNode,
  AssetId,
  AxisSpec,
  BracketNode,
  CalibrationSource,
  DatasetId,
  Fill,
  FigureNode,
  GroupLabelNode,
  GroupNode,
  ImageNode,
  LayerId,
  NodeId,
  NodeMap,
  PanelLabelNode,
  PanelNode,
  PlotNode,
  PlotType,
  ScaleBarNode,
  ShapeNode,
  Stroke,
  TextNode,
  TextStyle,
} from './nodes.js';

export interface NodeFactoryContext {
  newId: () => string;
  document: FigureDocument;
}

const defaultAxis = (title = ''): AxisSpec => ({
  title,
  min: null,
  max: null,
  tickStep: null,
  scale: 'linear',
  showLine: true,
  showTicks: true,
  showLabels: true,
  trimToData: false,
});

function baseNode(
  id: NodeId,
  name: string,
  layerId: string,
  frame: RectMm,
  parentId: NodeId | null,
  z: number,
) {
  return {
    id,
    name,
    parentId,
    layerId,
    frame,
    rotation: 0,
    opacity: 1,
    locked: false,
    hidden: false,
    z,
  };
}

/** Resolve a layer by name, falling back to the first layer if it is missing. */
function layerId(doc: FigureDocument, name: string): string {
  return layerByName(doc, name)?.id ?? doc.layers[0]?.id ?? '';
}

// ---------------------------------------------------------------------------
// Panels and plots
// ---------------------------------------------------------------------------

export interface AddPanelOptions {
  frame: RectMm;
  name?: string;
  aspectLock?: number | null;
}

export function addPanel(
  draft: FigureDocument,
  newId: () => string,
  options: AddPanelOptions,
): PanelNode {
  const id = newId();
  const panel: PanelNode = {
    ...baseNode(
      id,
      options.name ?? `Panel ${Object.values(draft.nodes).filter((n) => n.type === 'panel').length + 1}`,
      layerId(draft, 'Graphs'),
      options.frame,
      null,
      nextZ(draft.nodes, null),
    ),
    type: 'panel',
    label: null,
    aspectLock: options.aspectLock ?? null,
    background: null,
    border: null,
    paddingMm: 0,
  };
  draft.nodes[id] = panel;
  return panel;
}

export interface AddPlotOptions {
  panelId: NodeId;
  datasetId: string;
  plotType?: PlotType;
  xTitle?: string;
  yTitle?: string;
  palette?: string;
}

/**
 * What a layout opens as, before the author changes it.
 *
 * One place, because every import path was passing `'bar-dot'` explicitly and
 * so the format-aware defaults below never fired — a replicate-per-timepoint
 * table opened as bars over its timepoints, which is the figure the layout
 * exists to avoid. A caller that genuinely wants a type still passes one.
 */
export function defaultPlotTypeFor(format: DataFormat | undefined): PlotType {
  switch (format) {
    /*
     * Every layout that carries an x per y is an xy graph, and opens as one —
     * a trend, with its spread where there are replicates.
     *
     * Read as bars instead, the x columns are simply discarded and each series
     * collapses to the mean of its y column: one number that is nowhere in the
     * table, drawn over a category axis the data never had. Only
     * `xy-replicates` was covered before, so a plain `X1,Y1,X2,Y2` export came
     * in correctly detected and then drew three bars over its runs.
     */
    case 'simple-xy':
    case 'prism':
    case 'sigmaplot':
    case 'xy-replicates':
      return 'line';
    // Nested data is drawn as its observations: a bar over subjects averages
    // away the structure that makes the design nested in the first place.
    case 'nested':
      return 'dot';
    // Counts are magnitudes; a dot over a single frequency says nothing extra.
    case 'contingency':
      return 'bar';
    // A table of effect sizes and significance values exists to be read as a
    // volcano plot, not as a trend or a bar over features.
    case 'differential':
      return 'volcano';
    // Two effect sizes for the same feature exist to be read against each
    // other, not pooled into a bar over features or joined into a trend.
    case 'fold-fold':
      return 'fold-fold';
    // A dense matrix of values exists to be coloured, not to be pooled into
    // bars over its rows.
    case 'matrix':
      return 'heatmap';
    // Subject-level time-to-event data exists to be drawn as a Kaplan–Meier
    // curve, not pooled into bars over subjects.
    case 'survival':
      return 'survival';
    // Independent projected points, not a continuum — nothing about a PCA
    // or UMAP scatter has a natural ordering to trend a line through.
    case 'pca':
    case 'umap':
      return 'scatter';
    /*
     * Columns of observations open as a histogram: the shape of each sample is
     * the reading, and a bar over its mean throws exactly that away.
     *
     * The groups are drawn over one shared set of bin edges rather than pooled
     * — pooling really would invent a shape belonging to no group, which is
     * why a histogram refused more than one series before this. Violin, box
     * and beeswarm are the categorical readings of the same columns and stay
     * on the menu for a table with too many groups to overlay legibly.
     */
    case 'distribution':
      return 'histogram';
    default:
      return 'bar-dot';
  }
}

/**
 * The y-axis title a distribution plot writes for itself.
 *
 * Composed in exactly one place because four separate controls change the
 * answer — the plot type, the normalisation, the cumulative toggle, and the
 * import that creates the plot at all. Left to each of them, an axis ends up
 * labelled "Count" over densities, which is a figure stating something false
 * about its own numbers. Same discipline as `scaleBarWidthMm` and
 * `analysisInputHash`.
 */
export function distributionYTitle(
  node: Pick<PlotNode, 'plotType' | 'histogramNormalize' | 'histogramCumulative'>,
): string {
  if (node.plotType === 'ecdf') return 'Cumulative probability';

  const normalize = node.histogramNormalize ?? 'count';
  if (node.histogramCumulative) {
    // A cumulative density is not a density — the running total of
    // density x width is a proportion — so it is named as one.
    return normalize === 'count' ? 'Cumulative count' : 'Cumulative probability';
  }
  if (normalize === 'frequency') return 'Relative frequency';
  if (normalize === 'density') return 'Density';
  return 'Count';
}

/**
 * Every title `distributionYTitle` can produce — the set that may be
 * overwritten when the answer changes. A title the author typed is never one
 * of these, so their wording survives every control on the panel.
 */
export const DISTRIBUTION_Y_TITLES: ReadonlySet<string> = new Set([
  'Count',
  'Relative frequency',
  'Density',
  'Cumulative count',
  'Cumulative probability',
]);

/** Re-title a distribution plot's y axis, leaving a hand-written one alone. */
export function retitleDistributionY(plot: PlotNode): void {
  const current = plot.y.title;
  if (current === '' || DISTRIBUTION_Y_TITLES.has(current)) {
    plot.y.title = distributionYTitle(plot);
  }
}

export function addPlot(
  draft: FigureDocument,
  newId: () => string,
  options: AddPlotOptions,
): PlotNode {
  const panel = draft.nodes[options.panelId];
  if (!panel) throw new Error(`No such panel: ${options.panelId}`);

  const id = newId();
  const dataset = draft.datasets.find((d) => d.id === options.datasetId);
  const plot: PlotNode = {
    ...baseNode(
      id,
      // Named after its data: every plot being called "Plot" is what makes the
      // Layers list unreadable once there is more than one panel.
      dataset ? `Plot — ${dataset.name}` : 'Plot',
      layerId(draft, 'Graphs'),
      // Fills its panel; the theme's plot margins carve out the axis gutters.
      { x: 0, y: 0, width: panel.frame.width, height: panel.frame.height },
      panel.id,
      nextZ(draft.nodes, panel.id),
    ),
    type: 'plot',
    plotType: options.plotType ?? defaultPlotTypeFor(dataset?.format),
    datasetId: options.datasetId,
    encoding: {},
    x: defaultAxis(options.xTitle ?? ''),
    y: defaultAxis(options.yTitle ?? ''),
    center: 'mean',
    errorBars: 'sem',
    showPoints: true,
    pointSizeMm: 0.9,
    jitterMm: 0.8,
    barWidthFraction: 0.8,
    palette: options.palette ?? 'okabe-ito',
  };

  // A categorical x axis needs no ticks of its own; the category labels sit
  // under their bands and the bars carry the reading. A numeric x axis is the
  // opposite: without ticks there is nothing to read a position against.
  plot.x.showTicks = CONTINUOUS_X_PLOT_TYPES.has(plot.plotType);

  /*
   * A contingency cell is one count, not a set of replicates. Its mean is
   * itself and an SEM over it is a standard error of nothing, so a count table
   * gets plain bars — the alternative is a figure that draws error bars on
   * frequencies and looks entirely convincing.
   */
  if (dataset && dataset.format === 'contingency') {
    plot.plotType = 'bar';
    plot.errorBars = 'none';
    plot.showPoints = false;
    if (plot.y.title === '') plot.y.title = 'Count';
  }

  /*
   * A column of observations is a distribution, and its violin already draws
   * the shape. The individual points stay *off* by default here, unlike every
   * other categorical plot, for a reason that is about volume rather than
   * taste: `categoricalMarks` emits one marker per observation
   * (`marks.ts`, `showPoints ? s.values : []`), and categorical plots have no
   * equivalent of `planPointClouds`' rasterization — so a table with a few
   * hundred rows across a few columns would put tens of thousands of markers
   * in the DOM and choke every interaction frame.
   *
   * Off by default, never unavailable: the Inspector's own checkbox turns them
   * back on, and at the small n where individual points are worth seeing that
   * is a deliberate choice rather than an accident of the table's size.
   */
  if (dataset && dataset.format === 'distribution') {
    plot.showPoints = false;
    /*
     * The measured quantity runs along x on a histogram or an ECDF, and
     * nothing in the table names it — the headers name the *groups*, which is
     * why `axisTitlesFor` deliberately offers nothing for this format. The
     * same generic placeholder the Data tab already falls back to elsewhere.
     */
    if (plot.x.title === '') plot.x.title = 'Value';
    /*
     * The Data tab fills an axis it cannot name with a generic `?? 'Value'`.
     * For this format that placeholder is right for x — the measured quantity
     * really does run along it — and exactly wrong for y, which counts
     * observations rather than measuring anything. Cleared so the derived title
     * wins, rather than adding 'Value' to `DISTRIBUTION_Y_TITLES`, which is the
     * set that decides whether the *author* wrote a title and must keep meaning
     * only that.
     *
     * Found by running the app: every unit test called `addPlot` with no
     * `yTitle` at all, so the placeholder never arrived and both axes shipped
     * reading "Value".
     */
    if (plot.y.title === 'Value') plot.y.title = '';
    retitleDistributionY(plot);
  }

  /*
   * A replicate-per-x table exists to be drawn as a trend with its spread, so
   * that is what it opens as. Read as one point per replicate the line zig-zags
   * between the three measurements at each timepoint, which is the figure
   * nobody wants and the reason this layout is a separate format at all.
   */
  if (dataset && dataset.format === 'xy-replicates' && plot.plotType === 'line') {
    plot.errorDisplay = 'band';
    plot.errorBars = 'sd';
  }

  /*
   * Nested data is drawn as its observations. A bar over subjects would average
   * away the very structure that makes the design nested, and it is the
   * clustering — not the summary — that shows how much of the spread is between
   * subjects rather than within them.
   */
  if (dataset && dataset.format === 'nested' && plot.plotType === 'dot') {
    plot.showPoints = true;
  }

  /*
   * Axis titles are hardcoded rather than read from the dataset's own column
   * headers (as most other formats do): real files spell the fold-change
   * column inconsistently (`log2FC`/`logFC`/`L2FC`), and the y axis is a
   * -log10 transform of the raw p-value column, which never shares its header
   * either way. Both stay editable afterward through the ordinary axis UI.
   */
  if (dataset && dataset.format === 'differential') {
    plot.plotType = 'volcano';
    plot.errorBars = 'none';
    plot.showPoints = true;
    if (plot.x.title === '') plot.x.title = 'log2 fold change';
    if (plot.y.title === '') plot.y.title = '-log10(p-value)';
    plot.volcanoThresholds = DEFAULT_VOLCANO_THRESHOLDS;
  }

  /*
   * The opposite choice to volcano's above, and for the opposite reason. A
   * volcano's titles are hardcoded because the fold-change column is spelled
   * inconsistently and the y axis is a transform of the p-value column, so
   * neither header names what is drawn. Here both columns are plotted exactly
   * as they arrive, and their headers are precisely the axis names an author
   * wants ("97Q/25Q fold enrichment") — so the caller passes them, via
   * `axisTitlesFor`, and these generic fallbacks fill in only where the header
   * was a placeholder that function already refuses.
   */
  if (dataset && dataset.format === 'fold-fold') {
    plot.plotType = 'fold-fold';
    plot.errorBars = 'none';
    plot.showPoints = true;
    if (plot.x.title === '') plot.x.title = 'log2 fold change (x)';
    if (plot.y.title === '') plot.y.title = 'log2 fold change (y)';
    plot.foldFoldThresholds = DEFAULT_FOLD_FOLD_THRESHOLDS;
  }

  /*
   * A dense matrix exists to be coloured, not pooled into bars — forced the
   * same way contingency/differential are, so an explicit plot type passed by
   * a caller can't leave a matrix dataset drawn as something that reads its
   * cells as replicates or counts.
   */
  if (dataset && dataset.format === 'matrix') {
    plot.plotType = 'heatmap';
    plot.errorBars = 'none';
    plot.showPoints = false;
  }

  /*
   * A subject-level time-to-event table exists to be drawn as a stepped
   * Kaplan–Meier curve, not pooled into bars over subjects or trended as an
   * ordinary line — forced the same way matrix/differential are, so an
   * explicit plot type passed by a caller can't leave a survival dataset
   * drawn as something that reads its rows as replicates.
   */
  if (dataset && dataset.format === 'survival') {
    plot.plotType = 'survival';
    plot.errorBars = 'none';
    plot.showPoints = false;
    plot.x.showTicks = true;
    if (plot.x.title === '') plot.x.title = 'Time';
    if (plot.y.title === '') plot.y.title = 'Survival probability';
  }

  /*
   * A PCA scatter is a set of independent projected points, not a
   * continuum — connecting them with a line would imply an ordering the
   * data doesn't have, so this is forced the same defensive way
   * matrix/differential/survival are: an explicit plot type passed by a
   * caller can't leave a PCA dataset drawn as a trend.
   */
  if (dataset && dataset.format === 'pca') {
    plot.plotType = 'scatter';
    plot.showPoints = true;
    if (plot.x.title === '') plot.x.title = 'PC1';
    if (plot.y.title === '') plot.y.title = 'PC2';
  }

  /*
   * A UMAP embedding is the same kind of independent projected-point set a
   * PCA scatter is, forced the same defensive way. Unlike PCA's axis titles,
   * these carry no percentage annotation — there is no per-axis
   * variance-explained concept for a nonlinear embedding to state.
   */
  if (dataset && dataset.format === 'umap') {
    plot.plotType = 'scatter';
    plot.showPoints = true;
    if (plot.x.title === '') plot.x.title = 'UMAP1';
    if (plot.y.title === '') plot.y.title = 'UMAP2';
  }

  /*
   * A plain bar graph reads conventionally in one flat colour, not the
   * eight-colour Okabe-Ito set built to separate several groups at once —
   * so 'bar'/'bar-dot' (the only plot types that draw a `BarGeometry` at
   * all, via `options.showBar` in `categoricalMarks`) get a single light
   * red instead. Only applies when the caller left `palette` unset, the
   * same guard the `okabe-ito` default above uses, and runs last so it
   * also sees the contingency-format override, which forces `'bar'` after
   * this node was constructed.
   *
   * A *two-factor* table is the deliberate exception, contingency included:
   * there, colour is what carries the second factor (WT vs KO, or a
   * contingency table's Yes vs No column) across categories, so flattening
   * it to one colour would erase the exact distinction the grouping exists
   * to show. `isTwoFactor` is the same single spelling of that question the
   * renderer and Inspector already use, so this cannot drift from what they
   * decide — a contingency table reads as two-factor under it exactly as a
   * `grouped` table does, since both set `category`/`group` per series.
   */
  if (
    !options.palette &&
    (plot.plotType === 'bar' || plot.plotType === 'bar-dot') &&
    !(dataset && isTwoFactor(toSeries(dataset)))
  ) {
    plot.palette = 'bar-red';
  }

  draft.nodes[id] = plot;
  return plot;
}

/**
 * Where to put a panel that is about to be created, before layout runs.
 *
 * Every import path used to drop its new panel at a fixed `(4, 4)`. Layout runs
 * straight afterwards and assigns cells by `readingOrder`, which sorts on
 * `frame.y` then `frame.x` — so the brand new panel sorted *first* and took
 * panel a's cell, displacing every existing panel by one. Placing it below
 * everything already on the page makes it sort last, which is where an author
 * expects a freshly imported panel to appear.
 */
export function nextPanelFrame(
  draft: FigureDocument,
  size: { width: number; height: number },
  marginMm = 4,
): RectMm {
  let bottom = marginMm;
  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'panel') continue;
    bottom = Math.max(bottom, node.frame.y + node.frame.height + marginMm);
  }
  return { x: marginMm, y: bottom, width: size.width, height: size.height };
}

/** Add a panel with a plot inside it, the common case. */
export function addPanelWithPlot(
  draft: FigureDocument,
  newId: () => string,
  options: AddPanelOptions & Omit<AddPlotOptions, 'panelId'>,
): { panel: PanelNode; plot: PlotNode } {
  const panel = addPanel(draft, newId, options);
  const plot = addPlot(draft, newId, { ...options, panelId: panel.id });
  return { panel, plot };
}

// ---------------------------------------------------------------------------
// Panel labels
// ---------------------------------------------------------------------------

/**
 * Assign panel letters in reading order and create any missing label nodes.
 *
 * Relettering after every layout change is deliberate: a figure whose panels
 * have been rearranged but whose letters have not is a figure whose legend now
 * describes the wrong images.
 */
export function relabelPanels(
  draft: FigureDocument,
  newId: () => string,
  options: { uppercase?: boolean; fontSizePt?: number; offsetMm?: number } = {},
): void {
  const panels = readingOrder(draft.nodes) as PanelNode[];
  const labelLayer = layerId(draft, 'Labels');
  const offset = options.offsetMm ?? 0;

  const existing = new Map<NodeId, PanelLabelNode>();
  for (const node of Object.values(draft.nodes)) {
    if (node.type === 'panel-label') existing.set(node.panelId, node);
  }

  panels.forEach((panel, index) => {
    // Page space, because a `panel-label` is a top-level node. `panel.frame` is
    // only page space for a top-level panel — for a grouped one it is relative
    // to the group, so the letter used to land in the group's local space.
    const page = absoluteFrame(draft.nodes, panel.id) ?? panel.frame;
    let letters = '';
    let n = index;
    do {
      letters = String.fromCharCode(97 + (n % 26)) + letters;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    const letter = options.uppercase ? letters.toUpperCase() : letters;

    panel.label = letter;

    const label = existing.get(panel.id);
    if (label) {
      label.text = letter;
      label.name = `Label ${letter}`;
      renameBracketsForPanel(draft, panel.id, letter);
      return;
    }

    renameBracketsForPanel(draft, panel.id, letter);

    const id = newId();
    const node: PanelLabelNode = {
      ...baseNode(
        id,
        `Label ${letter}`,
        labelLayer,
        // Positioned in page space, just outside the panel's top-left corner.
        { x: page.x - offset, y: page.y, width: 5, height: 5 },
        null,
        nextZ(draft.nodes, null),
      ),
      type: 'panel-label',
      text: letter,
      style: {
        fontWeight: 'bold',
        ...(options.fontSizePt !== undefined ? { fontSizePt: options.fontSizePt } : {}),
      },
      panelId: panel.id,
    };
    draft.nodes[id] = node;
  });
}

/**
 * Re-prefix a panel's brackets with its (possibly new) letter.
 *
 * Same argument as relettering the panels themselves: a bracket whose name says
 * panel b when it now annotates panel c is a caption waiting to be got wrong.
 */
function renameBracketsForPanel(draft: FigureDocument, panelId: NodeId, letter: string): void {
  const plotIds = new Set(
    Object.values(draft.nodes)
      .filter((n) => n.type === 'plot' && n.parentId === panelId)
      .map((n) => n.id),
  );
  if (plotIds.size === 0) return;

  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'bracket') continue;
    if (node.plotId == null || !plotIds.has(node.plotId)) continue;
    // Strip any existing "x: " prefix before applying the current letter.
    const bare = node.name.replace(/^[^:]{1,3}:\s*/, '');
    node.name = `${letter}: ${bare}`;
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Arrange every panel on a grid and move its labels to match.
 *
 * With a `template` the grid is weighted and panels take their declared slots,
 * so panels need not be the same size. Without one the behaviour is the equal
 * grid it has always been.
 *
 * Brackets are *not* moved here: they need measured plot geometry, which lives
 * in the render package. Callers follow this with `repositionBrackets`.
 */
export function applyAutoLayout(
  draft: FigureDocument,
  options: Omit<LayoutOptions, 'pageWidthMm' | 'pageHeightMm'> & {
    grid?: GridSpec;
    template?: LayoutTemplate | null;
  },
): void {
  const units = layoutUnits(draft.nodes);
  if (units.length === 0) return;

  /*
   * Units, not panels. A group is laid out as one thing and its members scale
   * with it — grouping panels is specifically for moving and resizing them
   * together, so pulling a group apart would undo what the author asked for.
   *
   * It is also what stops a grouped panel being teleported: `placeUnits` writes
   * a page-space frame, and only a *top-level* node's `frame` is page space.
   * Measured before this, on three panels with two of them grouped: one landed
   * with its right edge at 186 mm on a 183 mm page.
   */
  // A template that does not fit the unit count would silently drop units
  // (autoLayout skips any unit with no cell), so fall back to the even grid.
  // `panelCount` is really a slot count, and a group occupies one slot.
  const template =
    options.template && options.template.panelCount === units.length ? options.template : null;

  const grid = template?.grid ?? options.grid ?? suggestGrid(units.length);

  /*
   * A slot is only meaningful against the grid it was authored for. Replaying
   * one from an earlier template against a freshly suggested grid silently
   * reinterprets its row/col — a 2-column template's `{row:0,col:0,rowSpan:2}`
   * becomes a whole column of a 3-column grid — and the panel then covers the
   * cell a newly imported panel was assigned, which is how an import came to
   * land on top of an existing panel. A plain auto-layout is by definition not
   * a template arrangement, so the stale slot is dropped rather than reused.
   */
  const frames = autoLayout(
    units.map((unit, index) => ({
      id: unit.id,
      ...unitLayoutShape(draft, unit),
      slot: template ? (template.slots[index] ?? null) : null,
    })),
    grid,
    {
      ...options,
      pageWidthMm: draft.page.widthMm,
      pageHeightMm: draft.page.heightMm,
    },
  );

  placeUnits(
    draft,
    units,
    frames,
    units.map((_, index) => (template ? (template.slots[index] ?? null) : null)),
  );
}

/**
 * The shape constraint a layout unit carries.
 *
 * For a panel: its own lock, plus an auto-fitting montage's full shape, because
 * a stored ratio cannot express one — a montage's height is affine in its
 * width, so the lock is exact only at the size it was written at.
 *
 * For a group: a plain ratio, and **only** when something inside it needs one.
 * `resizeGroupGeometry` scales `sx` and `sy` independently and
 * `resizePanelGeometry` does not enforce a member's `aspectLock` — it assigns
 * the frame and re-tiles. So a non-uniform group scale does not bend a lock, it
 * hands a montage a wrong-shaped frame that `fillPanelChildren` then fills,
 * which is round 41's dead strip per tile with the group as the cause. Pinning
 * the group to its own current ratio is what forces `sx === sy`.
 *
 * The group's fixed bands are zero, and that is not an oversight. Under a
 * uniform scale every extent inside scales together — gutters, label bands,
 * scale-bar bands — because `resizeGroupGeometry` scales frames and nothing
 * else. So round 41's "affine, not a ratio" lesson inverts here: this is the one
 * place a single ratio really is exact at every size.
 */
export function unitLayoutShape(
  draft: FigureDocument,
  unit: LayoutUnit,
): { aspectLock: number | null; shape: ShapeMm | null } {
  if (unit.kind === 'panel') {
    const panel = draft.nodes[unit.id];
    if (panel?.type !== 'panel') return { aspectLock: null, shape: null };
    return {
      aspectLock: panel.aspectLock,
      shape: panel.contentGrid?.autoFit === true ? montageShape(draft, unit.id) : null,
    };
  }

  const bound = unit.panelIds.some((id) => {
    const panel = draft.nodes[id];
    if (panel?.type !== 'panel') return false;
    // An `autoFit` montage carries no stored lock — round 41 demoted it — and
    // is distorted by a non-uniform scale just the same, so its shape counts.
    return panel.aspectLock !== null || montageShape(draft, id) !== null;
  });
  if (!bound || unit.frame.width <= 0 || unit.frame.height <= 0) {
    return { aspectLock: null, shape: null };
  }
  return { aspectLock: null, shape: aspectShape(unit.frame.width / unit.frame.height) };
}

/**
 * Move a set of panels onto new frames, and everything that has to follow them.
 *
 * Factored out of `applyAutoLayout` so smart layout can reuse it. Smart layout
 * gives each band its own column boundaries, which one `GridSpec` cannot
 * express, so it computes frames itself — but the *consequences* of a panel
 * moving are identical either way, and a second copy of them is how one caller
 * comes to re-tile its montages while the other forgets to.
 *
 * `slots[i]` is the slot to record against `panels[i]`, or null to clear it. A
 * slot is only meaningful against the grid it was authored for, so anything that
 * is not a template arrangement must pass null rather than leave a stale one.
 */
export function placeUnits(
  draft: FigureDocument,
  units: readonly LayoutUnit[],
  frames: ReadonlyMap<NodeId, RectMm>,
  slots: readonly (GridSlot | null)[],
): void {
  for (const [index, unit] of units.entries()) {
    const frame = frames.get(unit.id);
    if (!frame) continue;

    if (unit.kind === 'group') {
      /*
       * `resizeGroup` is the whole placement. It scales panels, shapes, arrows
       * and nested groups about the group's own origin, assigns the group's own
       * frame — which is what "a group's box goes stale after a layout" was —
       * and brackets the lot with the panel-position snapshot and
       * `resyncScaleBars`, so every descendant panel's letter follows its new
       * absolute position however deeply nested it is.
       *
       * Repositioning needs no work of its own: every member's frame is already
       * relative to the group. And no `dx`/`dy` translation here — the snapshot
       * has already moved the letters, and doing both would move them twice.
       */
      resizeGroup(draft, unit.id, frame);
      // Cleared with the arrangement it belonged to, exactly as for a panel.
      for (const panelId of unit.panelIds) {
        const member = draft.nodes[panelId];
        if (member?.type === 'panel') member.slot = null;
      }
      continue;
    }

    const panel = draft.nodes[unit.id];
    if (panel?.type !== 'panel') continue;

    // Cleared with the arrangement it belonged to, so the next plain layout
    // cannot resurrect it against a differently shaped grid.
    panel.slot = slots[index] ?? null;

    // Sound because a panel unit is top-level by construction, so its `frame`
    // *is* page space — which is precisely what was not true of a grouped panel.
    const dx = frame.x - panel.frame.x;
    const dy = frame.y - panel.frame.y;
    panel.frame = frame;

    fillPanelChildren(draft, panel.id, frame);

    // Labels live in page space, so they must be translated by hand.
    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'panel-label' && node.panelId === panel.id) {
        node.frame = { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy };
      }
    }
  }

  // An image that changed size changes what a millimetre on it means. Harmless
  // after `resizeGroup` has already done it: this is a re-derivation from
  // current geometry, never a delta.
  resyncScaleBars(draft);
}

/**
 * A tile below this size has no usable resize handle left to grab — see
 * `panelGridMinimumMm` in `apps/web/src/components/Canvas.tsx`, which reads
 * the same constant to stop a panel resize from ever reaching this state in
 * the first place. This export is the backstop for every other path that
 * can still call `resizePanel`/`applyAutoLayout` against a too-small frame
 * (a template application, or a document imported already too small).
 */
export const MIN_TILE_MM = 5;

/** Gap between a scale bar and the corner of the picture it sits on. */
export const DEFAULT_SCALE_BAR_INSET_MM = 2;

/**
 * Extra clearance to fold into a montage panel's own internal gutters, one
 * per grid boundary: a group-label band above the row it heads, and a
 * scale-bar band below the row whose picture carries one.
 *
 * This is the "always live" half of the two group-label mechanisms: because
 * `fillPanelChildren` already re-tiles on every resize, folding the
 * clearance in here means it stays correct automatically, with no separate
 * reflow step and no risk of fighting a manual drag the way translating a
 * *sibling* panel would (see `reserveSpaceForGroupLabels`, the other half,
 * for why that one is deliberately not live).
 *
 * A below-placed scale bar has to be here rather than merely in the solver's
 * demand, and that is the load-bearing part. The bar is drawn outside its
 * tile's own frame, so unless the *grid* holds the room open the tiler simply
 * fills the space with picture and the bar lands on the panel below. Stated
 * only in the demand it would be worse than useless: the demand would claim a
 * taller panel while `fillPanelChildren` gave the height back to the tiles,
 * and the two would disagree — the exact failure `montageFixedExtentMm`'s own
 * docstring exists to prevent.
 */
function montageGutterExtras(
  doc: FigureDocument,
  panelId: NodeId,
  children: readonly FigureNode[],
  grid: { rows: number; cols: number },
): { rowExtra: number[]; columnExtra: number[] } {
  const rowExtra = new Array<number>(grid.rows + 1).fill(0);
  const columnExtra = new Array<number>(grid.cols + 1).fill(0);

  const indexOf = new Map<NodeId, number>();
  children.forEach((child, index) => indexOf.set(child.id, index));

  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'group-label') continue;
    const parents = new Set(node.memberIds.map((memberId) => doc.nodes[memberId]?.parentId ?? null));
    if (parents.size !== 1 || [...parents][0] !== panelId) continue;

    const indices = node.memberIds
      .map((memberId) => indexOf.get(memberId))
      .filter((i): i is number => i !== undefined);
    if (indices.length === 0) continue;

    // The heading's own clearance *plus* anything wider stacked outside it,
    // so a row carrying both a spanning heading and a caption per tile is
    // given room for both rather than for whichever happens to be taller.
    const extent = groupLabelExtentMm(doc.nodes, node);

    if (node.edge === 'top') {
      const row = Math.min(...indices.map((i) => Math.floor(i / grid.cols)));
      rowExtra[row] = Math.max(rowExtra[row]!, extent);
    } else if (node.edge === 'left') {
      const col = Math.min(...indices.map((i) => i % grid.cols));
      columnExtra[col] = Math.max(columnExtra[col]!, extent);
    } else {
      const col = Math.max(...indices.map((i) => i % grid.cols));
      columnExtra[col + 1] = Math.max(columnExtra[col + 1]!, extent);
    }
  }

  /*
   * A bar below its picture reserves the strip under its own row. The extent
   * depends only on the bar's own fields — its gap, its thickness and its
   * label's point size — never on any geometry, so this stays closed form and
   * cannot feed back into the layout it is part of.
   *
   * `gridCells`' boundary extras run 0..rows inclusive, so a bar in the last
   * row reserves its strip between that row and the panel's own bottom
   * padding rather than falling off the end.
   */
  children.forEach((child, index) => {
    const extent = imageScaleBarBelowExtentMm(doc.nodes, child.id);
    if (extent <= 0) return;
    const row = Math.floor(index / grid.cols);
    rowExtra[row + 1] = Math.max(rowExtra[row + 1]!, extent);
  });

  return { rowExtra, columnExtra };
}

/**
 * The part of a montage panel's extent that is *not* cells: gutters, padding,
 * group-label bands and scale-bar bands, on each axis.
 *
 * `montageShape` reads these to state the panel's shape and smart layout reads
 * them for the smallest frame at which every cell still clears `MIN_TILE_MM`,
 * which is exactly the condition `montageCellRects` returns null on. One
 * definition, so the two cannot disagree — reimplementing this arithmetic
 * beside the solver is how a panel comes to be declared layout-able at a frame
 * the tiler then refuses to fill, and the function this replaced did exactly
 * that.
 */
export function montageFixedExtentMm(
  doc: FigureDocument,
  panelId: NodeId,
): { rows: number; cols: number; fixedWidthMm: number; fixedHeightMm: number } | null {
  const panel = doc.nodes[panelId];
  const grid = panel?.type === 'panel' ? panel.contentGrid : undefined;
  if (!grid || grid.rows < 1 || grid.cols < 1) return null;

  const { rowExtra, columnExtra } = montageGutterExtras(
    doc,
    panelId,
    montageTiles(doc.nodes, panelId),
    { rows: grid.rows, cols: grid.cols },
  );
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  const padding = panel?.type === 'panel' ? panel.paddingMm : 0;

  return {
    rows: grid.rows,
    cols: grid.cols,
    fixedWidthMm: (grid.cols - 1) * grid.gutterMm + sum(columnExtra) + 2 * padding,
    fixedHeightMm: (grid.rows - 1) * grid.gutterMm + sum(rowExtra) + 2 * padding,
  };
}

/**
 * Size a panel's content children to it — filling it, or tiled into its grid.
 *
 * One implementation shared by `applyAutoLayout` and `resizePanel`. They had
 * drifted — auto-layout resized only plots while resize handled images too, so
 * a micrograph kept its old size the moment the layout was re-run.
 *
 * Without a `contentGrid` this is exactly what it always was, byte for byte,
 * which a regression test pins: every existing figure has one child per panel
 * and must not move. Exported so `setMontageCellImage` can re-tile a panel
 * whose child count just changed without duplicating this function.
 */
export function fillPanelChildren(draft: FigureDocument, panelId: NodeId, frame: RectMm): void {
  const panel = draft.nodes[panelId];
  const grid = panel?.type === 'panel' ? panel.contentGrid : undefined;
  const children = montageTiles(draft.nodes, panelId);

  /*
   * No declared grid: every child fills the panel, exactly as it always has.
   *
   * The child *count* is deliberately not part of this test any more. It used
   * to bail out at one child too, which was harmless while a `contentGrid`
   * could only ever be created alongside two or more images — but an empty
   * montage can now be created first and filled a cell at a time, and under
   * the old rule its first tile stretched across the whole panel instead of
   * taking cell 1, then snapped back into the grid the moment a second
   * arrived. A declared grid is a declared grid at any occupancy.
   */
  if (!grid || grid.rows < 1 || grid.cols < 1) {
    for (const child of children) {
      /*
       * The same band a montage row reserves, for the same reason: a bar below
       * the picture is outside the picture, so the room has to be held open
       * here or the tile takes it. Without this the lone-image case is the one
       * that double-counts — `imageContentRect` centres by default, so half the
       * band would land above the picture and `reserveSpaceForScaleBars` would
       * shrink the panel on the bottom row anyway.
       *
       * Zero for every bar left `'inside'`, which is every figure saved before
       * round 38 — so this is additive and the byte-identical case stays so.
       */
      const band = imageScaleBarBelowExtentMm(draft.nodes, child.id);
      child.frame = {
        x: 0,
        y: 0,
        width: frame.width,
        height: Math.max(0, frame.height - band),
      };
    }
    return;
  }

  const cells = montageCellRects(draft, panelId, frame);
  // A frame too small for its own grid (a template applied onto a
  // too-small panel, or an already-too-small imported document — the live
  // drag path can no longer reach this, see `panelGridMinimumMm`) leaves
  // every child exactly where it was rather than handing it a degenerate,
  // ungrabbable frame. The same "extras keep their size" stance the
  // more-children-than-cells case below already takes.
  if (!cells) return;

  children.forEach((child, index) => {
    const cell = cells[index];
    // More children than cells: the extras keep their size rather than being
    // stacked at the origin, where they would be invisible under a tile.
    if (cell) child.frame = { ...cell };
  });
}

/**
 * A montage panel's tiles, in the z order `fillPanelChildren` fills cells in.
 *
 * `Object.values` order is not a guarantee, and a montage that reshuffled
 * itself on every layout would be unusable — so this is the one place that
 * order is decided, shared by the tiler, `setMontageCellImage`'s cell
 * addressing, and the renderer's empty-cell placeholders.
 */
export function montageTiles(nodes: NodeMap, panelId: NodeId): FigureNode[] {
  return Object.values(nodes)
    .filter((c) => c.parentId === panelId && (c.type === 'plot' || c.type === 'image'))
    .sort((a, b) => a.z - b.z);
}

/**
 * Where a montage panel's cells sit, in the panel's own local coordinates.
 *
 * Null when the panel has no grid, or when the grid cannot be given usable
 * cells at this frame — the caller decides what that means (the tiler leaves
 * children alone; the renderer draws no placeholders).
 *
 * Exported because the renderer draws a dashed outline in every cell no tile
 * has reached yet, and deriving those rectangles a second time there is
 * exactly how an outline comes to sit somewhere other than where the tile
 * will actually land.
 */
export function montageCellRects(
  doc: FigureDocument,
  panelId: NodeId,
  frame: RectMm,
): RectMm[] | null {
  const panel = doc.nodes[panelId];
  const grid = panel?.type === 'panel' ? panel.contentGrid : undefined;
  if (!grid || grid.rows < 1 || grid.cols < 1) return null;

  const { rowExtra, columnExtra } = montageGutterExtras(
    doc,
    panelId,
    montageTiles(doc.nodes, panelId),
    { rows: grid.rows, cols: grid.cols },
  );

  /*
   * `gridCells` tiles a page into panels; here it tiles a panel into tiles.
   * Its only page-specific inputs are the extent and the margin, so passing the
   * panel's own frame and padding reuses it unchanged rather than growing a
   * second implementation of the same arithmetic.
   */
  const cells = gridCells(
    { rows: grid.rows, columns: grid.cols },
    {
      pageWidthMm: frame.width,
      pageHeightMm: frame.height,
      marginMm: panel?.type === 'panel' ? panel.paddingMm : 0,
      gutterMm: grid.gutterMm,
      rowGutterExtraMm: rowExtra,
      columnGutterExtraMm: columnExtra,
    },
  );

  if (cells.some((cell) => cell.width < MIN_TILE_MM || cell.height < MIN_TILE_MM)) return null;
  return cells;
}

// ---------------------------------------------------------------------------
// Fitting a montage to its images
// ---------------------------------------------------------------------------

/**
 * The aspect (w/h) of one tile's picture, after its crop.
 *
 * Null where there is nothing to measure — a plot, or a vector asset, which
 * carries `{0, 0}` and has no intrinsic proportions.
 */
function tileAspect(node: FigureNode): number | null {
  if (node.type !== 'image') return null;
  if (node.naturalPx.height <= 0 || node.naturalPx.width <= 0) return null;
  const aspect = node.naturalPx.width / node.naturalPx.height;
  const cropped = (aspect * node.crop.width) / node.crop.height;
  return Number.isFinite(cropped) && cropped > 0 ? cropped : null;
}

/**
 * One representative aspect for a montage's tiles.
 *
 * The **median**, not the mean: a single panorama among otherwise square
 * micrographs should not drag every cell wide. Null when no tile has a
 * measurable aspect, which is what tells the caller there is nothing to fit.
 */
export function montageTileAspect(nodes: NodeMap, panelId: NodeId): number | null {
  const aspects = montageTiles(nodes, panelId)
    .map(tileAspect)
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  if (aspects.length === 0) return null;
  const mid = Math.floor(aspects.length / 2);
  return aspects.length % 2 === 1 ? aspects[mid]! : (aspects[mid - 1]! + aspects[mid]!) / 2;
}

/**
 * The shapes a montage panel can take: its cells' combined aspect, plus the
 * bands that do not scale with them.
 *
 * Replaces `montagePanelAspect`, which returned a single ratio and was wrong
 * whenever `fixedWidth / fixedHeight != cols * tileAspect / rows`. Its comment
 * claimed "any positive cell height gives the same ratio" — true of the cells
 * block, and false of the panel, which is the cells block *plus* constant
 * bands. Measured on a 1 × 3 montage of 4:3 tiles under one group title, the
 * ratio it returned (2.5761, at its own `max(MIN_TILE_MM, fixedHeight)` probe)
 * against the truth at the sizes the solver actually used: 3.3259 at 60 mm,
 * 3.6320 at 120 mm, 3.7401 at 175 mm. Panels were locked far too tall and
 * every tile lost the difference as dead space under its picture — 1219 mm²
 * per tile at 175 mm of width, which is the whitespace this replaced.
 *
 * Still closed form, and more strictly so than what it replaces: there is no
 * probe height to pick, because `heightForWidth` is the answer at every width
 * rather than at one.
 *
 * The fixed extents come from `montageFixedExtentMm` rather than being
 * recomposed here. Recomposing them is what let the old function drift from
 * the tiler it was supposed to agree with.
 *
 * Returns null when the panel has no grid or no measurable tile.
 */
export function montageShape(doc: FigureDocument, panelId: NodeId): ShapeMm | null {
  const fixed = montageFixedExtentMm(doc, panelId);
  if (!fixed) return null;
  const tile = montageTileAspect(doc.nodes, panelId);
  if (tile === null || !(tile > 0)) return null;

  const contentAspect = (fixed.cols * tile) / fixed.rows;
  if (!Number.isFinite(contentAspect) || contentAspect <= 0) return null;
  return {
    contentAspect,
    fixedWidthMm: fixed.fixedWidthMm,
    fixedHeightMm: fixed.fixedHeightMm,
  };
}

/**
 * Rows × columns for `count` tiles of a given aspect, filling a cell of the
 * given aspect as fully as possible.
 *
 * `suggestGrid` answers the same question for *panels on a page*, where every
 * panel is roughly square and near-square grids are right. A montage of wide
 * micrographs wants fewer, wider columns; a montage of tall ones the reverse.
 * This is the honest lever behind "use the page space well": the panel then
 * claims the largest rect of that shape in the cell auto-layout gives it,
 * rather than letterboxing inside it.
 *
 * `cellAspect` <= 0 (an unknown or degenerate target) falls back to
 * `suggestGrid`, so a caller with no cell to aim at behaves exactly as before.
 */
export function suggestMontageGrid(
  count: number,
  tileAspectRatio: number,
  cellAspect: number,
): { rows: number; cols: number } {
  if (count <= 0) return { rows: 1, cols: 1 };
  if (!(tileAspectRatio > 0) || !(cellAspect > 0)) {
    const fallback = suggestGrid(Math.max(1, count));
    return { rows: fallback.rows, cols: fallback.columns };
  }

  let best = { rows: 1, cols: count };
  let bestScore = Infinity;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const holes = rows * cols - count;

    /*
     * Only "tight" grids: at most a partly-filled last row, never a wholly
     * empty row or column. Without this, four images in a wide panel scored
     * best as 2 × 3 — a better *shape*, but with two empty cells, and an empty
     * cell in a published montage is a hole in the figure, not a saving. The
     * shape is a preference; leaving cells unfilled is a defect.
     */
    if (holes >= Math.min(rows, cols)) continue;

    // The grid's own aspect, ignoring gutters and labels: they are a small,
    // roughly symmetric correction, and including them here would make this
    // depend on the very layout it is choosing.
    const gridAspect = (cols * tileAspectRatio) / rows;
    /*
     * Compare in log space so "twice as wide" and "half as wide" score equally
     * badly — a plain difference would always prefer the narrower option.
     *
     * The balance term breaks the ties that leaves. Four 2:1 tiles in a square
     * cell score identically as 4 × 1 (aspect 0.5) and 2 × 2 (aspect 2.0) —
     * equally far off in opposite directions — and without this the first one
     * tried won, turning a montage of wide images into a tall single column.
     * A squarer arrangement is the conventional montage shape, so it takes the
     * tie; the weight is small enough never to outvote the shape itself.
     */
    const balance = Math.abs(Math.log(cols / rows)) * 0.01;
    const score = Math.abs(Math.log(gridAspect / cellAspect)) + holes * 0.15 + balance;
    if (score < bestScore) {
      bestScore = score;
      best = { rows, cols };
    }
  }
  return best;
}

/**
 * Re-shape a montage so its pictures fill their cells.
 *
 * Sets `aspectLock` to the ratio the panel's own frame takes at its current
 * width, which `autoLayout` honours — so the next layout pass gives the panel
 * a correctly-shaped rect inside its page cell and `fillPanelChildren` fills
 * every cell edge to edge. `addPanelWithImages` set `aspectLock: null` for the
 * stated reason that differently-shaped micrographs have "no one honest
 * ratio".
 *
 * **The lock is exact only at this width**, because a montage's height is
 * affine in its width rather than proportional to it — see `ShapeMm`. That is
 * why `applyAutoLayout` passes the *shape* for an auto-fitting montage instead
 * of relying on the stored ratio, and why the lock survives here as the
 * manual-resize fallback rather than as the whole answer.
 *
 * The frame itself is deliberately not reshaped. This runs from
 * `addPanelWithImages`, `setMontageCellImage`, `deleteNodesWithLayout` and
 * three Inspector controls, and silently changing a panel's height on each is
 * a larger behaviour change than the defect; the next layout pass gets the
 * shape right regardless.
 *
 * A no-op unless `contentGrid.autoFit` is on, which is off for every figure
 * saved before this existed.
 */
export function fitMontageToImages(draft: FigureDocument, panelId: NodeId): void {
  const panel = draft.nodes[panelId];
  if (panel?.type !== 'panel' || !panel.contentGrid?.autoFit) return;

  const shape = montageShape(draft, panelId);
  if (!shape) return;

  const fitted = fitShape(panel.frame, shape, 'start', 'start');
  if (!(fitted.width > 0) || !(fitted.height > 0)) return;

  panel.aspectLock = fitted.width / fitted.height;
  // Re-tile immediately so the frames on the children match the new shape
  // even if the caller never runs a full layout pass.
  fillPanelChildren(draft, panelId, panel.frame);
}

/**
 * Choose the grid for an auto-fitting montage from its tile count and shape.
 *
 * Kept separate from `fitMontageToImages` because the two answer different
 * questions and a caller may want only one: this decides how many rows and
 * columns, that decides what shape the panel should be. Respects a grid the
 * author set by hand — `autoFit` fits the *shape*, it does not overrule a
 * declared arrangement.
 */
export function autoGridForMontage(draft: FigureDocument, panelId: NodeId): void {
  const panel = draft.nodes[panelId];
  if (panel?.type !== 'panel' || !panel.contentGrid?.autoFit) return;

  const tiles = montageTiles(draft.nodes, panelId);
  if (tiles.length === 0) return;
  const aspect = montageTileAspect(draft.nodes, panelId);
  if (aspect === null) return;

  const cellAspect = panel.frame.height > 0 ? panel.frame.width / panel.frame.height : 0;
  const next = suggestMontageGrid(tiles.length, aspect, cellAspect);
  panel.contentGrid = { ...panel.contentGrid, rows: next.rows, cols: next.cols };
}

/**
 * The frame half of `resizePanel`, without its label shim.
 *
 * Split out so `resizeGroup` can reuse the plot/tile re-fill without also
 * running the label shim below — which assumes the panel's *parent* didn't
 * itself move, untrue inside a group being scaled. `resizeGroup` reconciles
 * every descendant panel's label once, correctly, from a before/after
 * absolute-position snapshot instead.
 */
function resizePanelGeometry(draft: FigureDocument, panelId: NodeId, frame: RectMm): void {
  const panel = draft.nodes[panelId];
  if (!panel) return;
  panel.frame = frame;
  fillPanelChildren(draft, panel.id, frame);
}

/**
 * Resize one panel, keeping everything that depends on its frame in step.
 *
 * A panel's plot is its child and so follows automatically in page space, but
 * its *label* is a top-level node positioned beside the panel — without this it
 * would be left behind, which reads as the letter drifting off the figure.
 */
export function resizePanel(draft: FigureDocument, panelId: NodeId, frame: RectMm): void {
  const panel = draft.nodes[panelId];
  if (!panel) return;

  const dx = frame.x - panel.frame.x;
  const dy = frame.y - panel.frame.y;
  resizePanelGeometry(draft, panelId, frame);

  for (const node of Object.values(draft.nodes)) {
    if (node.type === 'panel-label' && node.panelId === panel.id) {
      node.frame = { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy };
    }
  }

  resyncScaleBars(draft);
}

// ---------------------------------------------------------------------------
// Assets and image panels
// ---------------------------------------------------------------------------

export interface AddAssetOptions {
  id: AssetId;
  filename: string;
  mimeType: string;
  byteLength: number;
  /** Null for vector sources, which have no intrinsic pixel size. */
  naturalPx: { width: number; height: number } | null;
  /** Defaults to `assets/<id>` with the filename's extension. */
  path?: string;
}

/** File extension including the dot, or '' when there is none. */
function extensionOf(filename: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(filename);
  return match ? match[0].toLowerCase() : '';
}

/**
 * Register a binary attachment.
 *
 * Only the *metadata* lives in the document. The bytes are held outside it, by
 * the app's asset store: `store.ts` records every edit as an Immer patch plus
 * its inverse, so a megabyte of micrograph in the document would be cloned into
 * the undo history on every unrelated edit.
 *
 * Idempotent on id, so re-importing the same file does not duplicate the entry.
 */
export function addAsset(draft: FigureDocument, options: AddAssetOptions): Asset {
  const existing = draft.assets.find((a) => a.id === options.id);
  if (existing) return existing;

  const asset: Asset = {
    id: options.id,
    filename: options.filename,
    mimeType: options.mimeType,
    path: options.path ?? `assets/${options.id}${extensionOf(options.filename)}`,
    byteLength: options.byteLength,
    naturalPx: options.naturalPx,
  };
  draft.assets = [...draft.assets, asset];
  return asset;
}

/** Drop an asset record. The bytes are the caller's to forget, or not. */
export function removeAsset(draft: FigureDocument, assetId: AssetId): void {
  draft.assets = draft.assets.filter((a) => a.id !== assetId);
}

/** Image nodes referencing an asset. Empty means the asset is an orphan. */
export function imagesUsingAsset(nodes: NodeMap, assetId: AssetId): ImageNode[] {
  return Object.values(nodes).filter(
    (n): n is ImageNode => n.type === 'image' && n.assetId === assetId,
  );
}

/**
 * Smallest crop extent. Below 1% the image is magnified a hundredfold and the
 * resolution check is already shouting; the floor exists to keep the extent off
 * zero, which is a division, not a very small picture.
 */
export const MIN_CROP = 0.01;

export type Crop01 = { x: number; y: number; width: number; height: number };

export const FULL_CROP: Crop01 = { x: 0, y: 0, width: 1, height: 1 };

/**
 * Clamp a crop into the unit square with a non-zero extent.
 *
 * The renderer divides by `crop.width`, so zero yields an image of infinite
 * width; the quality checker reads the same zero as `crop.width || 1` and
 * reports the picture as uncropped. One document, two answers — so the crop is
 * normalised on the way in rather than defended against three times over.
 */
export function normaliseCrop(crop: Partial<Crop01> | null | undefined): Crop01 {
  const finiteOr = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  const x = Math.min(Math.max(finiteOr(crop?.x, 0), 0), 1 - MIN_CROP);
  const y = Math.min(Math.max(finiteOr(crop?.y, 0), 0), 1 - MIN_CROP);
  const width = Math.min(Math.max(finiteOr(crop?.width, 1), MIN_CROP), 1 - x);
  const height = Math.min(Math.max(finiteOr(crop?.height, 1), MIN_CROP), 1 - y);

  return { x, y, width, height };
}

export function setImageCrop(
  draft: FigureDocument,
  id: NodeId,
  crop: Partial<Crop01>,
): void {
  const node = draft.nodes[id];
  if (!node || node.type !== 'image') return;
  node.crop = normaliseCrop({ ...node.crop, ...crop });
  // Cropping changes how many source pixels span the frame, which is exactly
  // the ratio a scale bar's length is derived from.
  resyncScaleBars(draft);
}

export interface AddImageOptions {
  assetId: AssetId;
  frame: RectMm;
  naturalPx: { width: number; height: number };
  name?: string;
  parentId?: NodeId | null;
  crop?: Partial<Crop01>;
  preserveAspect?: boolean;
  alignX?: FitAlign;
  alignY?: FitAlign;
}

/**
 * Add an image node.
 *
 * Throws when the asset is not registered. `checkReferentialIntegrity` rejects
 * a document whose image points at an unknown asset, so the alternative is a
 * figure that edits perfectly and then cannot be saved — the mistake is made
 * loud here instead. Register the asset and the node in the *same* commit.
 */
export function addImage(
  draft: FigureDocument,
  newId: () => string,
  options: AddImageOptions,
): ImageNode {
  const asset = draft.assets.find((a) => a.id === options.assetId);
  if (!asset) {
    throw new Error(
      `No such asset: ${options.assetId}. Register it with addAsset in the same commit.`,
    );
  }

  const parentId = options.parentId ?? null;
  const id = newId();
  const node: ImageNode = {
    ...baseNode(
      id,
      // The filename is what the author recognises in the Layers list; "Image 4"
      // is the unreadability the provenance column exists to fix.
      options.name ?? asset.filename,
      layerId(draft, 'Images'),
      options.frame,
      parentId,
      nextZ(draft.nodes, parentId),
    ),
    type: 'image',
    assetId: options.assetId,
    naturalPx: options.naturalPx,
    crop: normaliseCrop(options.crop),
    // A stretched micrograph misstates distances measured on it, which is a
    // data problem rather than a cosmetic one. Opt out, never opt in.
    preserveAspect: options.preserveAspect ?? true,
    ...(options.alignX ? { alignX: options.alignX } : {}),
    ...(options.alignY ? { alignY: options.alignY } : {}),
  };
  draft.nodes[id] = node;
  return node;
}

/** Add a panel with an image inside it, the common case. */
export function addPanelWithImage(
  draft: FigureDocument,
  newId: () => string,
  options: AddPanelOptions & Omit<AddImageOptions, 'parentId'>,
): { panel: PanelNode; image: ImageNode } {
  const preserveAspect = options.preserveAspect ?? true;
  const ratio =
    preserveAspect && options.naturalPx.height > 0
      ? options.naturalPx.width / options.naturalPx.height
      : null;

  // Give auto-layout the image's shape so it reserves a correctly proportioned
  // cell; without it the panel is a generic rectangle and the image letterboxes
  // inside it, which reads as unexplained white space.
  const panel = addPanel(draft, newId, { ...options, aspectLock: options.aspectLock ?? ratio });
  const image = addImage(draft, newId, {
    ...options,
    parentId: panel.id,
    frame: { x: 0, y: 0, width: panel.frame.width, height: panel.frame.height },
  });
  return { panel, image };
}

/**
 * One panel holding several images, tiled into a grid — a montage.
 *
 * Each tile stays its own `ImageNode`, so it keeps its own crop, scale bar and
 * annotations, and `selectionTarget`'s double-click-to-enter already reaches
 * one. Pooling them into a single image would throw all of that away.
 *
 * `aspectLock` starts null — it is derived from a single image's ratio, and a
 * montage of differently shaped micrographs has no one honest ratio to take
 * from any one of them. `fitMontageToImages` then computes the ratio that
 * *does* exist for the set: the one at which every cell matches the tiles'
 * median aspect, so nothing letterboxes. New montages fit automatically;
 * existing figures, which carry no `autoFit`, are untouched.
 */
export function addPanelWithImages(
  draft: FigureDocument,
  newId: () => string,
  options: AddPanelOptions & {
    images: readonly Omit<AddImageOptions, 'parentId' | 'frame'>[];
    gutterMm?: number;
  },
): { panel: PanelNode; images: ImageNode[] } {
  const count = options.images.length;
  const grid = suggestGrid(Math.max(1, count));

  const panel = addPanel(draft, newId, { ...options, aspectLock: null });
  if (count > 1) {
    panel.contentGrid = {
      rows: grid.rows,
      cols: grid.columns,
      gutterMm: options.gutterMm ?? 1,
      autoFit: true,
    };
  }

  const images = options.images.map((image) =>
    addImage(draft, newId, {
      // A tile's frame comes from `gridCells` and has nothing to do with the
      // micrograph's own shape, so an aspect-preserved image genuinely has
      // spare room in its cell. Top-align it: a row of differently-shaped
      // micrographs only reads as a row when their tops line up, where
      // centring leaves each one floating at its own height. Only for a real
      // montage — a lone image fills its panel and has nothing to align.
      ...(count > 1 ? { alignY: 'start' as const } : {}),
      ...image,
      parentId: panel.id,
      // Provisional: `fillPanelChildren` assigns the real cells immediately
      // after, and every caller runs a layout before anything is drawn.
      frame: { x: 0, y: 0, width: panel.frame.width, height: panel.frame.height },
    }),
  );

  // Pick the grid from the images' own shape, then shape the panel so they
  // fill it. Order matters: the aspect is computed from the grid.
  autoGridForMontage(draft, panel.id);
  fitMontageToImages(draft, panel.id);
  fillPanelChildren(draft, panel.id, panel.frame);
  return { panel, images };
}

/**
 * A montage panel with no images yet — a thin sibling of `addPanelWithImages`
 * with zero children, so a cell can be filled in one at a time afterward via
 * `setMontageCellImage` rather than only ever arriving in one bulk import.
 *
 * `fillPanelChildren` already tolerates a `contentGrid` with more cells than
 * children (the extras stay unused, invisible, exactly the "more children
 * than cells" case documented on it already, just at the opposite extreme —
 * zero children), so nothing about "an empty cell" is a new concept here.
 */
export function addEmptyMontagePanel(
  draft: FigureDocument,
  newId: () => string,
  options: AddPanelOptions & {
    rows: number;
    cols: number;
    gutterMm?: number;
    /** Off only where a caller wants the grid it asked for held exactly. */
    autoFit?: boolean;
  },
): PanelNode {
  const panel = addPanel(draft, newId, { ...options, aspectLock: null });
  panel.contentGrid = {
    rows: Math.max(1, options.rows),
    cols: Math.max(1, options.cols),
    gutterMm: options.gutterMm ?? 1,
    autoFit: options.autoFit ?? true,
  };
  return panel;
}

/**
 * Put an image into a specific cell of a montage panel, replacing whatever
 * was there or inserting a new tile if the cell was empty.
 *
 * Cells are addressed by their z-order index — the same order
 * `fillPanelChildren` already tiles children into — so this needs an
 * explicit z-insert/renumber for the empty-cell case rather than the plain
 * append `nextZ` gives every other new child, or the new image would land in
 * the *last* cell regardless of which one the author clicked.
 *
 * A previously-filled cell is retargeted **in place** — the existing
 * `ImageNode`'s `assetId`/`naturalPx`/`crop` are overwritten rather than the
 * node being deleted and a fresh one inserted — because its `id` is what a
 * scale bar's `parentId` and a group-label's `memberIds` are still pointing
 * at. Deleting it would either orphan those references or, via `deleteNode`'s
 * cascade, take an unrelated caption down with it; retargeting keeps both
 * intact, the same way changing an image's *crop* already does not disturb
 * what points at the node. `resyncScaleBars` (already run globally on
 * layout) is what invalidates the scale bar's calibration for the new
 * pixels, rather than a second reset rule being invented for it.
 */
export function setMontageCellImage(
  draft: FigureDocument,
  newId: () => string,
  panelId: NodeId,
  cellIndex: number,
  image: Omit<AddImageOptions, 'parentId' | 'frame'>,
): ImageNode | null {
  const panel = draft.nodes[panelId];
  if (!panel || panel.type !== 'panel' || !panel.contentGrid) return null;
  if (cellIndex < 0 || cellIndex >= panel.contentGrid.rows * panel.contentGrid.cols) return null;

  const asset = draft.assets.find((a) => a.id === image.assetId);
  if (!asset) return null;

  const children = Object.values(draft.nodes)
    .filter((c) => c.parentId === panelId && (c.type === 'plot' || c.type === 'image'))
    .sort((a, b) => a.z - b.z);

  const existing = children[cellIndex];
  if (existing && existing.type === 'image') {
    existing.assetId = image.assetId;
    existing.naturalPx = image.naturalPx;
    existing.crop = normaliseCrop(image.crop);
    existing.preserveAspect = image.preserveAspect ?? existing.preserveAspect;
    existing.name = image.name ?? asset.filename;
    // A replacement keeps whatever alignment the author had already chosen
    // for this cell; only a genuinely new tile takes the top-aligned default.
    if (image.alignX) existing.alignX = image.alignX;
    if (image.alignY) existing.alignY = image.alignY;
    // A different picture can change the set's median aspect, so re-fit before
    // re-tiling. `fitMontageToImages` calls `fillPanelChildren` itself.
    fitMontageToImages(draft, panelId);
    fillPanelChildren(draft, panelId, panel.frame);
    resyncScaleBars(draft);
    return existing;
  }

  const node = addImage(draft, newId, {
    // Tops line up across a row of differently-shaped micrographs — see
    // `addPanelWithImages`, which takes the same default for the same reason.
    alignY: 'start',
    ...image,
    parentId: panelId,
    frame: { x: 0, y: 0, width: panel.frame.width, height: panel.frame.height },
  });

  // Inserting into a previously-empty cell must place the new node's z
  // between its neighbours rather than after all of them, or it would tile
  // into the *last* cell regardless of which empty one was targeted.
  const ordered = [...children];
  ordered.splice(cellIndex, 0, node);
  ordered.forEach((child, index) => {
    const target = draft.nodes[child.id];
    if (target) target.z = index;
  });

  // The grid is deliberately *not* re-chosen here: the author declared these
  // rows and columns when they made the montage, and silently rearranging them
  // the moment a picture lands would overrule that. `autoFit` fits the panel's
  // shape to the tiles; it does not overrule a declared arrangement.
  fitMontageToImages(draft, panelId);
  fillPanelChildren(draft, panelId, panel.frame);
  resyncScaleBars(draft);
  return node;
}

// ---------------------------------------------------------------------------
// Scale bars
// ---------------------------------------------------------------------------

/**
 * On-page width of a scale bar, derived from its parent image's calibration and
 * current size.
 *
 * The single implementation: `renderScaleBar` calls this rather than repeating
 * the arithmetic. Two copies would drift, and the symptom is a bar that is
 * correct when placed and quietly wrong ever after — the worst possible failure
 * for the one object in a figure that claims to be a measurement.
 *
 * Returns null when the bar is not parented to an image, in which case its own
 * frame width stands.
 */
export function scaleBarWidthMm(nodes: NodeMap, id: NodeId): number | null {
  const bar = nodes[id];
  if (!bar || bar.type !== 'scale-bar') return null;

  const parent = bar.parentId ? nodes[bar.parentId] : undefined;
  if (!parent || parent.type !== 'image') return null;

  const visiblePx = parent.naturalPx.width * (parent.crop.width || 1);
  /*
   * The *picture's* width, not the frame's.
   *
   * Those `visiblePx` source pixels are drawn across the picture, and on a
   * letterboxed image the picture is narrower than the frame it sits in — so
   * dividing by the frame overstates how far a pixel reaches and the bar is
   * drawn longer than the distance it claims. That is a false measurement in a
   * published figure, exactly what `checkScaleBarCalibration` exists to keep
   * out, and the same class of defect as a bar that sits off its own image.
   * For a picture that fills its frame the two are the same number.
   */
  const drawnWidth = imageContentRect(parent).width;
  if (visiblePx <= 0 || drawnWidth <= 0) return null;

  const mmPerPixel = drawnWidth / visiblePx;
  return bar.length * bar.pixelsPerUnit * mmPerPixel;
}

/**
 * Re-derive every scale bar's frame width from its image.
 *
 * The drawn bar is computed, but the selection outline and the eight resize
 * grips come from `frame` — so without this the chrome sits somewhere the bar
 * is not. The direct parallel is `repositionBrackets`, and it is called from
 * the same places for the same reason.
 */
/**
 * Where a scale bar belongs on its image: the bottom-right corner of the
 * **picture**, not of the image node's frame.
 *
 * The two are the same only when the picture fills its frame exactly. An
 * aspect-preserved micrograph in a cell of a different shape letterboxes, and
 * a bar placed against the frame then floats in the empty margin — measured on
 * the sample figure's montage, 100 px clear of the micrograph it was supposed
 * to be measuring, and horizontally under the *next* tile along. A bar that is
 * not on its own image is a measurement of nothing, which is precisely the
 * failure `checkScaleBarCalibration` exists to keep out of a published figure.
 *
 * Composed once and read by both `addScaleBar` and `resyncScaleBars`, the same
 * discipline `scaleBarWidthMm` itself is held to — the placement and the
 * re-placement cannot then disagree.
 */
export function scaleBarFrame(
  nodes: NodeMap,
  barId: NodeId,
  insetMm = DEFAULT_SCALE_BAR_INSET_MM,
): RectMm | null {
  const bar = nodes[barId];
  if (bar?.type !== 'scale-bar') return null;
  const image = bar.parentId ? nodes[bar.parentId] : undefined;
  if (image?.type !== 'image') return null;

  const width = scaleBarWidthMm(nodes, barId) ?? bar.frame.width;
  // Local to the image node's own frame, which is what a child frame is
  // relative to — so the content rect is used as an offset, not as a position.
  const content = imageContentRect(image);

  /*
   * Below the picture rather than on it: still bottom-right, but clear of the
   * image data entirely. The x is aligned to the picture's right edge with no
   * inset — the bar is outside the picture now, so insetting it would pull it
   * away from the edge it is meant to line up with.
   *
   * This frame can land outside the image node's own frame, which is fine and
   * intended: `reserveSpaceForScaleBars` makes the room, and `renderImage`
   * widens its clip so a cropped image does not cut the bar off.
   */
  if (bar.placement === 'below') {
    return {
      x: Math.max(0, content.x + content.width - width),
      y: content.y + content.height + SCALE_BAR_BELOW_GAP_MM,
      width,
      height: bar.barHeightMm,
    };
  }

  return {
    x: Math.max(0, content.x + content.width - insetMm - width),
    y: Math.max(0, content.y + content.height - insetMm - bar.barHeightMm),
    width,
    height: bar.barHeightMm,
  };
}

/** Gap between the picture's bottom edge and a bar placed below it. */
export const SCALE_BAR_BELOW_GAP_MM = 1;

/**
 * How much room a below-placed bar needs beneath the picture.
 *
 * One line of the label's own size whenever a label is drawn, whichever side of
 * the bar `labelPosition` puts it — reserving for either keeps that control
 * working unchanged, and the difference is well under a millimetre.
 *
 * Zero for a bar drawn on the picture, which is what makes this safe to call
 * unconditionally.
 */
export function scaleBarBelowExtentMm(bar: ScaleBarNode): number {
  if (bar.placement !== 'below') return 0;
  const label =
    bar.labelPosition === 'none' ? 0 : ptToMm(bar.style.fontSizePt ?? SCALE_BAR_FALLBACK_PT) * 1.2;
  return SCALE_BAR_BELOW_GAP_MM + bar.barHeightMm + label;
}

/**
 * Label size for a bar that never had one written onto it. Matches every
 * journal preset's `scaleBarPt`; `doc-model` may not import `theme`.
 */
const SCALE_BAR_FALLBACK_PT = 6;

/** The band any of an image's own bars need below it, for the clip and the reserve. */
export function imageScaleBarBelowExtentMm(nodes: NodeMap, imageId: NodeId): number {
  let extent = 0;
  for (const node of Object.values(nodes)) {
    if (node.type !== 'scale-bar' || node.parentId !== imageId) continue;
    extent = Math.max(extent, scaleBarBelowExtentMm(node));
  }
  return extent;
}

/**
 * Put every scale bar back on its picture, at its true calibrated width.
 *
 * Previously this rewrote the width alone, so a bar kept its old `y` when its
 * image was resized or re-tiled — the selection chrome and the drawn bar then
 * sat somewhere the picture no longer was.
 */
export function resyncScaleBars(draft: FigureDocument): void {
  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'scale-bar') continue;
    const frame = scaleBarFrame(draft.nodes, node.id);
    if (frame && frame.width > 0) node.frame = frame;
  }
}

export interface AddScaleBarOptions {
  /** Must be an image: the bar takes its length from that image's calibration. */
  imageId: NodeId;
  length: number;
  pixelsPerUnit: number;
  unitLabel?: string;
  calibrationSource?: CalibrationSource;
  labelPosition?: 'above' | 'below' | 'none';
  fill?: Fill;
  barHeightMm?: number;
  /** Inset from the image's bottom-right corner. */
  insetMm?: number;
  fontSizePt?: number;
}

/**
 * Add a scale bar over an image.
 *
 * Returns null for a non-image target rather than placing an uncalibrated bar
 * somewhere arbitrary — the renderer would fall back to the node's own frame
 * width, which is a bar of no particular length asserting a measurement.
 */
export function addScaleBar(
  draft: FigureDocument,
  newId: () => string,
  options: AddScaleBarOptions,
): ScaleBarNode | null {
  const image = draft.nodes[options.imageId];
  if (!image || image.type !== 'image') return null;

  const inset = options.insetMm ?? DEFAULT_SCALE_BAR_INSET_MM;
  const barHeightMm = options.barHeightMm ?? 0.6;
  const labelPosition = options.labelPosition ?? 'above';
  const id = newId();

  const node: ScaleBarNode = {
    ...baseNode(
      id,
      `Scale bar — ${options.length} ${options.unitLabel ?? 'µm'}`,
      layerId(draft, 'Annotations'),
      // Provisional; resyncScaleBars derives the real width below.
      { x: inset, y: image.frame.height - inset - barHeightMm, width: 10, height: barHeightMm },
      image.id,
      nextZ(draft.nodes, image.id),
    ),
    type: 'scale-bar',
    length: options.length,
    unitLabel: options.unitLabel ?? 'µm',
    pixelsPerUnit: options.pixelsPerUnit,
    // Kept in step with labelPosition, which is what the renderer reads.
    showLabel: labelPosition !== 'none',
    style: options.fontSizePt !== undefined ? { fontSizePt: options.fontSizePt } : {},
    // Black by default. A white bar is right only over a dark micrograph, and
    // it is invisible everywhere else — including on the white page a bar
    // dropped outside an image sits on.
    fill: options.fill ?? { color: '#000000' },
    barHeightMm,
    labelPosition,
    calibrationSource: options.calibrationSource ?? 'unknown',
  };

  draft.nodes[id] = node;

  // Bottom-right of the picture, the conventional corner, once the true width
  // is known. One derivation, shared with `resyncScaleBars`.
  const placed = scaleBarFrame(draft.nodes, id, inset);
  if (placed && placed.width > 0) node.frame = placed;

  return node;
}

/**
 * Set a bar's calibration, keeping `calibrationSource` honest.
 *
 * Provenance that is not updated alongside the number it describes is worse
 * than no provenance, so the two only move together.
 */
export function setScaleBarCalibration(
  draft: FigureDocument,
  id: NodeId,
  pixelsPerUnit: number,
  source: CalibrationSource,
): void {
  const node = draft.nodes[id];
  if (node?.type !== 'scale-bar') return;
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) return;
  node.pixelsPerUnit = pixelsPerUnit;
  node.calibrationSource = source;
  resyncScaleBars(draft);
}

// ---------------------------------------------------------------------------
// Statistical annotation
// ---------------------------------------------------------------------------

/**
 * Where a plot's categories are drawn, relative to the plot node's frame.
 *
 * Supplied by `measurePlot` in the render package, which owns the band scale.
 * Reimplementing that scale here would duplicate the layout maths and drift
 * out of step, putting bracket ends visibly off the bars they refer to.
 *
 * Note this is a *parameter*, never an import: `doc-model` depends on nothing
 * internal, and `render` depends on `doc-model`, so reaching for `measurePlot`
 * from here would close a dependency cycle. Everything that needs measurements
 * takes them as an argument.
 */
export interface PlotMeasurements {
  categoryX: Map<string, number>;
  categoryTop: Map<string, number>;
}

/** Measurements for many plots at once, keyed by plot node id. */
export type PlotMeasurementMap = ReadonlyMap<NodeId, PlotMeasurements>;

/**
 * Height of a bracket's tick descent; the span sits at the frame top.
 *
 * Not the height of what a bracket *draws*: the label is rendered above the
 * frame at negative y. Anything spacing two brackets apart wants
 * `bracketStepMm` in the render package, which adds the label.
 */
export const BRACKET_HEIGHT_MM = 1.2;

export interface AddBracketOptions {
  plotId: NodeId;
  analysis: Analysis;
  comparisonIndex?: number;
  /** Show the exact p-value instead of asterisks. */
  showExactP?: boolean;
  /** Vertical clearance above the plot content, in mm. */
  gapMm?: number;
  /** Measured positions. Without them the bracket falls back to even spacing. */
  measurements?: PlotMeasurements;
}

/**
 * Where one bracket's span sits horizontally, and what it has to clear.
 *
 * Split out from `bracketFrame` so that the *vertical* decision can be taken
 * for a plot's brackets together — see `layoutBracketsForPlot`. Positions are
 * relative to the plot's own frame; the panel offset is added by the caller.
 */
interface BracketSpan {
  indexA: number;
  indexB: number;
  xA: number;
  xB: number;
  /** Top of the tallest drawn feature anywhere under the span, in mm. */
  contentTop: number;
}

function bracketSpan(
  draft: FigureDocument,
  options: {
    plotId: NodeId;
    datasetId: string;
    groupA: string;
    groupB: string;
    measurements?: PlotMeasurements;
  },
): BracketSpan | null {
  const plot = draft.nodes[options.plotId];
  if (!plot || plot.type !== 'plot') return null;

  const dataset = draft.datasets.find((d) => d.id === options.datasetId);
  if (!dataset) return null;

  const seriesNames = toSeries(dataset).map((s) => s.name);
  const indexA = seriesNames.indexOf(options.groupA);
  const indexB = seriesNames.indexOf(options.groupB);
  if (indexA < 0 || indexB < 0) return null;

  const leftName = seriesNames[Math.min(indexA, indexB)]!;
  const rightName = seriesNames[Math.max(indexA, indexB)]!;

  if (options.measurements) {
    const measurements = options.measurements;
    // Clear the tallest feature anywhere under the bracket's span.
    const spanned = seriesNames.slice(Math.min(indexA, indexB), Math.max(indexA, indexB) + 1);
    const top = Math.min(...spanned.map((name) => measurements.categoryTop.get(name) ?? Infinity));
    return {
      indexA,
      indexB,
      xA: measurements.categoryX.get(leftName) ?? 0,
      xB: measurements.categoryX.get(rightName) ?? plot.frame.width,
      contentTop: Number.isFinite(top) ? top : 0,
    };
  }

  // Fallback: even spacing across the plot. Approximate, but the bracket is
  // a normal draggable object, so the user can correct it.
  const slot = plot.frame.width / Math.max(1, seriesNames.length);
  return {
    indexA,
    indexB,
    xA: slot * (Math.min(indexA, indexB) + 0.5),
    xB: slot * (Math.max(indexA, indexB) + 0.5),
    contentTop: 0,
  };
}

/**
 * Page-space frame for a bracket spanning two categories of a plot.
 *
 * Provisional placement for a bracket being created: it clears the data it
 * spans but knows nothing about its neighbours, because at creation time they
 * may not exist yet. `layoutBracketsForPlot` is what settles the stack, and
 * every creation path runs it immediately afterwards — so this position is
 * never what the author sees.
 */
export function bracketFrame(
  draft: FigureDocument,
  options: {
    plotId: NodeId;
    datasetId: string;
    groupA: string;
    groupB: string;
    gapMm?: number;
    measurements?: PlotMeasurements;
  },
): RectMm | null {
  const plot = draft.nodes[options.plotId];
  if (!plot || plot.type !== 'plot') return null;

  const panel = plot.parentId ? draft.nodes[plot.parentId] : null;
  if (!panel) return null;

  const span = bracketSpan(draft, options);
  if (!span) return null;

  const gap = options.gapMm ?? DEFAULT_BRACKET_GAP_MM;
  const left = Math.min(span.xA, span.xB);
  const right = Math.max(span.xA, span.xB);

  return {
    x: panel.frame.x + left,
    // The tick ends are the bottom of the frame, so position the frame so
    // they stop `gap` above the tallest datum rather than overlapping it.
    y: panel.frame.y + span.contentTop - gap - BRACKET_HEIGHT_MM,
    width: Math.max(1, right - left),
    height: BRACKET_HEIGHT_MM,
  };
}

/** Clearance between the tallest mark and the lowest bracket over it. */
export const DEFAULT_BRACKET_GAP_MM = 2;

/**
 * Vertical pitch between two brackets that overlap horizontally.
 *
 * A bracket's *node* is 1.2 mm tall, but its label is drawn above the frame at
 * negative y, so its real ink is roughly 3 mm at the default 6 pt. Callers with
 * a theme should measure it (`bracketStepMm` in the render package) rather than
 * inherit this; the constant exists so a headless caller still gets a stack
 * that does not collide.
 */
export const DEFAULT_BRACKET_STEP_MM = 3.6;

export interface BracketLayoutOptions {
  gapMm?: number;
  stepMm?: number;
}

/**
 * Place every bracket on one plot, together.
 *
 * This has to be one pass over the whole set, because where a bracket goes
 * depends on what is already above the bars it spans. Placing each one alone —
 * which is what happened until now, with the caller passing an increasing
 * `gapMm` per bracket — fails four ways, all reachable with default settings:
 *
 *   - the per-bracket clamp at the panel top collapsed every bracket past the
 *     second onto the same line, pixel for pixel;
 *   - the increment was a fixed 3.5 mm against a frame declared 1.2 mm tall,
 *     leaving half a millimetre of real clearance for a ~3 mm label;
 *   - comparisons that do not overlap horizontally were still stacked, which
 *     spent the vertical budget that then triggered the clamp;
 *   - and a later bracket over short bars could end up below an earlier one
 *     over tall bars, crossing it.
 *
 * So: shortest span first, so nested comparisons sit below the wider ones that
 * contain them, and each bracket rises above both the data under it and any
 * *horizontally overlapping* bracket already placed. Disjoint comparisons share
 * a height, which is both correct and what a reader expects.
 *
 * Returns base frames by node id — before `userOffsetMm`, which callers apply.
 */
export function layoutBracketsForPlot(
  draft: FigureDocument,
  plotId: NodeId,
  measurements: PlotMeasurements | undefined,
  options: BracketLayoutOptions = {},
): Map<NodeId, RectMm> {
  const frames = new Map<NodeId, RectMm>();

  const plot = draft.nodes[plotId];
  if (!plot || plot.type !== 'plot') return frames;
  const panel = plot.parentId ? draft.nodes[plot.parentId] : null;
  if (!panel) return frames;

  const gapMm = options.gapMm ?? DEFAULT_BRACKET_GAP_MM;
  const stepMm = options.stepMm ?? DEFAULT_BRACKET_STEP_MM;

  const entries: (BracketSpan & { id: NodeId })[] = [];
  for (const node of bracketsForPlot(draft, plotId)) {
    const analysis = node.analysisId
      ? draft.analyses.find((a) => a.id === node.analysisId)
      : undefined;
    const comparison = analysis?.result?.comparisons[node.comparisonIndex ?? 0];
    if (!analysis || !comparison) continue;

    const span = bracketSpan(draft, {
      plotId,
      datasetId: analysis.spec.datasetId,
      groupA: comparison.groupA,
      groupB: comparison.groupB,
      ...(measurements ? { measurements } : {}),
    });
    if (span) entries.push({ ...span, id: node.id });
  }
  if (entries.length === 0) return frames;

  entries.sort((a, b) => {
    const spanA = Math.abs(a.indexB - a.indexA);
    const spanB = Math.abs(b.indexB - b.indexA);
    // Ties broken by position so the order is stable across renders — two
    // brackets swapping heights between two identical documents would make the
    // canvas and the export disagree.
    return spanA !== spanB ? spanA - spanB : Math.min(a.xA, a.xB) - Math.min(b.xA, b.xB);
  });

  const placed: { left: number; right: number; y: number }[] = [];
  for (const entry of entries) {
    const left = Math.min(entry.xA, entry.xB);
    const right = Math.max(entry.xA, entry.xB);

    // y is inverted: "above" is a smaller number.
    let y = entry.contentTop - gapMm - BRACKET_HEIGHT_MM;
    for (const existing of placed) {
      if (left <= existing.right && right >= existing.left) {
        y = Math.min(y, existing.y - stepMm);
      }
    }

    placed.push({ left, right, y });
    frames.set(entry.id, {
      x: panel.frame.x + left,
      y: panel.frame.y + y,
      width: Math.max(1, right - left),
      height: BRACKET_HEIGHT_MM,
    });
  }

  /*
   * A panel too short for the stack pushes it above its own top edge, where it
   * would overprint the panel above. Shift the *whole* stack down by the
   * shortfall rather than clamping each bracket, which is precisely how they
   * came to pile up on one line before: clamping individually destroys the
   * separation this function exists to produce, while shifting preserves both
   * the order and the spacing and merely crowds the tallest bar — visible, and
   * an obvious "this panel needs to be taller".
   *
   * `computePlotGeometry` reserves headroom from the bracket count, so this is
   * a backstop rather than the normal path.
   */
  const highest = Math.min(...[...frames.values()].map((f) => f.y - panel.frame.y));
  if (highest < 0) {
    for (const [id, frame] of frames) frames.set(id, { ...frame, y: frame.y - highest });
  }

  return frames;
}

/**
 * Create a significance bracket from a computed analysis.
 *
 * The label reads the *adjusted* p-value. Annotating uncorrected p-values on a
 * multi-comparison figure is one of the most common statistical errors in
 * published figures, so the adjusted value is not optional here.
 */
export function addBracket(
  draft: FigureDocument,
  newId: () => string,
  options: AddBracketOptions,
): BracketNode | null {
  const plot = draft.nodes[options.plotId];
  if (!plot || plot.type !== 'plot') return null;

  const result = options.analysis.result;
  const comparisonIndex = options.comparisonIndex ?? 0;
  const comparison = result?.comparisons[comparisonIndex];
  if (!comparison) return null;

  const gapMm = options.gapMm ?? 4;

  const frame = bracketFrame(draft, {
    plotId: options.plotId,
    datasetId: options.analysis.spec.datasetId,
    groupA: comparison.groupA,
    groupB: comparison.groupB,
    gapMm,
    ...(options.measurements ? { measurements: options.measurements } : {}),
  });
  if (!frame) return null;

  const id = newId();
  const panelLabel = panelLetterForPlot(draft, options.plotId);

  const bracket: BracketNode = {
    ...baseNode(
      id,
      // Named with its panel so two panels' brackets are tellable apart in the
      // Layers list, where otherwise both read "Vehicle vs Treated".
      panelLabel
        ? `${panelLabel}: ${comparison.groupA} vs ${comparison.groupB}`
        : `${comparison.groupA} vs ${comparison.groupB}`,
      layerId(draft, 'Statistics'),
      frame,
      null,
      nextZ(draft.nodes, null),
    ),
    type: 'bracket',
    analysisId: options.analysis.id,
    plotId: options.plotId,
    comparisonIndex,
    gapMm,
    label: options.showExactP
      ? formatBracketP(comparison.pAdjusted)
      : significanceStars(comparison.pAdjusted),
    style: { align: 'middle' },
    stroke: { color: '#000000', widthMm: 0.18, cap: 'butt' },
    tickMm: 0.8,
  };

  draft.nodes[id] = bracket;
  return bracket;
}

/** Panel letter for the panel a plot sits in, for naming annotations. */
function panelLetterForPlot(draft: FigureDocument, plotId: NodeId): string | null {
  const plot = draft.nodes[plotId];
  if (!plot || plot.type !== 'plot' || !plot.parentId) return null;
  const panel = draft.nodes[plot.parentId];
  return panel && panel.type === 'panel' ? panel.label : null;
}

/** Every bracket annotating a given plot. */
function bracketsForPlot(draft: FigureDocument, plotId: NodeId): BracketNode[] {
  return Object.values(draft.nodes).filter(
    (n): n is BracketNode => n.type === 'bracket' && n.plotId === plotId,
  );
}

/**
 * Drop the brackets annotating a plot.
 *
 * Called before annotating a fresh run: without it a re-run stacks new brackets
 * on the old ones at the same heights, because the placement gap restarts from
 * the same base each time.
 */
export function removeBracketsForPlot(draft: FigureDocument, plotId: NodeId): void {
  for (const bracket of bracketsForPlot(draft, plotId)) {
    delete draft.nodes[bracket.id];
  }
}

/**
 * Store an analysis as *the* analysis for its plot, replacing any previous one.
 *
 * A panel carries at most one result: running Welch's and then Mann-Whitney on
 * the same plot should leave the second, not both. Analyses with no plot (e.g.
 * built headlessly) are appended untouched.
 */
export function replaceAnalysisForPlot(draft: FigureDocument, analysis: Analysis): void {
  const plotId = analysis.plotId ?? null;
  const kept =
    plotId === null
      ? draft.analyses.filter((a) => a.id !== analysis.id)
      : draft.analyses.filter((a) => a.id !== analysis.id && (a.plotId ?? null) !== plotId);
  draft.analyses = [...kept, analysis];
}

/**
 * Store a batch of per-series correlation/regression analyses as *the* set for
 * a plot: one per fitted series, keyed by `spec.seriesName`.
 *
 * Unlike `replaceAnalysisForPlot` this keeps a plot's several results side by
 * side — a multi-series line plot fits each line the author picks. Any
 * previous per-series analysis for the plot whose series is not in the new
 * batch is dropped, so unpicking a series and re-running removes its result
 * and its drawn line. A group comparison on the same plot (no `seriesName`)
 * is left untouched.
 */
export function replaceSeriesAnalysesForPlot(
  draft: FigureDocument,
  plotId: NodeId,
  analyses: readonly Analysis[],
): void {
  const kept = draft.analyses.filter(
    (a) => (a.plotId ?? null) !== plotId || a.spec.seriesName === undefined,
  );
  draft.analyses = [...kept, ...analyses];
}

/**
 * Re-measure every bracket against its plot's current geometry.
 *
 * Brackets are top-level nodes in absolute page space, deliberately, so they
 * stay draggable — which also means nothing moves them when their plot is
 * resized or re-laid-out. This puts them back on their bars, re-applying any
 * offset the user dragged in so a hand-adjusted bracket keeps its adjustment
 * instead of being either stranded or reset.
 *
 * Measurements come from `measureAllPlots` in the render package; plots absent
 * from the map (unmeasurable, e.g. collapsed to zero width) are left alone.
 */
export function repositionBrackets(
  draft: FigureDocument,
  measurements: PlotMeasurementMap,
  options: BracketLayoutOptions = {},
): void {
  // Grouped by plot, because the placement of any one bracket depends on the
  // others over the same bars — see `layoutBracketsForPlot`.
  const plotIds = new Set<NodeId>();
  for (const node of Object.values(draft.nodes)) {
    if (node.type === 'bracket' && node.plotId) plotIds.add(node.plotId);
  }

  for (const plotId of plotIds) {
    const measured = measurements.get(plotId);
    // Plots absent from the map are unmeasurable (collapsed to zero width);
    // leaving their brackets alone is better than moving them somewhere wrong.
    if (!measured) continue;

    const frames = layoutBracketsForPlot(draft, plotId, measured, options);
    for (const [id, frame] of frames) {
      const node = draft.nodes[id];
      if (!node || node.type !== 'bracket') continue;
      const offset = node.userOffsetMm;
      node.frame = offset ? { ...frame, x: frame.x + offset.x, y: frame.y + offset.y } : frame;
    }
  }
}

/**
 * Record a bracket's manual displacement from where the geometry would put it.
 *
 * Called after a drag, so the next reposition can re-apply the same offset.
 * The baseline is the *collective* placement, the same one `repositionBrackets`
 * will compute next time — deriving it from a single-bracket rule would make
 * the offset a difference against a position nothing else agrees with, and the
 * bracket would jump the first time anything re-laid it out.
 */
export function recordBracketOffset(
  draft: FigureDocument,
  bracketId: NodeId,
  measurements: PlotMeasurementMap,
  options: BracketLayoutOptions = {},
): void {
  const node = draft.nodes[bracketId];
  if (!node || node.type !== 'bracket') return;

  const plotId = node.plotId ?? null;
  if (plotId === null) return;

  const measured = measurements.get(plotId);
  if (!measured) return;

  // The layout returns base frames with no offset applied, so the difference
  // against the dragged frame is the whole displacement, not an increment.
  const base = layoutBracketsForPlot(draft, plotId, measured, options).get(bracketId);
  if (!base) return;

  node.userOffsetMm = { x: node.frame.x - base.x, y: node.frame.y - base.y };
}

const formatBracketP = (p: number): string =>
  p < 0.001 ? 'P < 0.001' : `P = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;

// ---------------------------------------------------------------------------
// Group labels
// ---------------------------------------------------------------------------

const DEFAULT_GROUP_LABEL_STROKE: Stroke = { color: '#000000', widthMm: 0.35, cap: 'butt' };

/**
 * Where the picture is actually drawn inside an image node's frame, in the
 * node's own local coordinates.
 *
 * A montage tile's frame comes from `gridCells` and has nothing to do with the
 * micrograph's shape, so an aspect-preserved picture letterboxes inside it and
 * the frame is emphatically *not* where the ink is. Anything positioning
 * itself against the picture — a heading's rule, which was overshooting to the
 * cell edge, or the heading itself, which was floating a letterbox's worth too
 * high — has to read this instead.
 *
 * One formula covers both branches of `renderImage`: uncropped is simply the
 * crop-1 case, and `renderImage`'s cropped path calls this rather than
 * repeating it, so the drawing and the geometry cannot disagree.
 */
export function imageContentRect(node: ImageNode): RectMm {
  const local: RectMm = { x: 0, y: 0, width: node.frame.width, height: node.frame.height };
  const aspect = node.naturalPx.height > 0 ? node.naturalPx.width / node.naturalPx.height : 0;
  // A stretched image fills its frame exactly; a vector asset carries {0, 0}
  // and has no intrinsic proportions to letterbox against.
  if (!node.preserveAspect || aspect <= 0) return local;
  return fitAspectAligned(
    local,
    (aspect * node.crop.width) / node.crop.height,
    node.alignX ?? 'middle',
    node.alignY ?? 'middle',
  );
}

/**
 * The page-space rectangle a group-label should measure itself against: the
 * drawn picture for an image, and the plain frame for anything else.
 */
export function memberContentRect(nodes: NodeMap, id: NodeId): RectMm | null {
  const frame = absoluteFrame(nodes, id);
  if (!frame) return null;
  const node = nodes[id];
  if (node?.type !== 'image') return frame;
  const content = imageContentRect(node);
  return {
    x: frame.x + content.x,
    y: frame.y + content.y,
    width: content.width,
    height: content.height,
  };
}

/** True when every member shares one parent panel that tiles them into a
 *  `contentGrid` — the case `fillPanelChildren`'s own gutter growth already
 *  covers live, on every resize, with no reflow of its own needed. */
/**
 * Whether every member of a heading is a picture.
 *
 * What `placement: 'overlay'` is offered against. Overlaying a heading draws it
 * *on* the content in white with a dark outline — a micrograph convention that
 * over a plot paints a white caption across the axes. So the control is shown
 * only where the option means something, the standing "a control that visibly
 * does nothing is a defect" rule in its sharper form: here it does something,
 * and that something is wrong.
 *
 * A member is a picture if it is an `image` node, or a panel whose own content
 * children are images. A panel holding a plot is not, and neither is an empty
 * one — there is nothing to overlay a heading onto.
 */
export function groupLabelMembersAreImages(
  nodes: NodeMap,
  memberIds: readonly NodeId[],
): boolean {
  if (memberIds.length === 0) return false;
  return memberIds.every((id) => {
    const node = nodes[id];
    if (!node) return false;
    if (node.type === 'image') return true;
    if (node.type !== 'panel') return false;
    const children = Object.values(nodes).filter((n) => n.parentId === id);
    const images = children.filter((n) => n.type === 'image');
    return images.length > 0 && images.length === children.length;
  });
}

function isSameMontageGroup(nodes: NodeMap, memberIds: readonly NodeId[]): boolean {
  if (memberIds.length === 0) return false;
  const parents = new Set(memberIds.map((id) => nodes[id]?.parentId ?? null));
  if (parents.size !== 1) return false;
  const parentId = [...parents][0]!;
  if (parentId === null) return false;
  const parent = nodes[parentId];
  return parent?.type === 'panel' && parent.contentGrid !== undefined;
}

/** The top-level ancestor of a node — itself, if it has no parent. */
function topLevelOwner(nodes: NodeMap, id: NodeId): NodeId | null {
  let current: NodeId | null = id;
  const seen = new Set<NodeId>();
  while (current !== null) {
    if (seen.has(current)) return null; // a cyclic parentId chain; give up rather than loop forever
    seen.add(current);
    const node: FigureNode | undefined = nodes[current];
    if (!node) return null;
    if (node.parentId === null) return current;
    current = node.parentId;
  }
  return null;
}

/**
 * Page-space frame for a group-label, from the current union of its members'
 * absolute frames plus its own manual nudge — the same "auto base + stored
 * delta" shape `BracketNode.userOffsetMm` already uses.
 *
 * Returns null when no member still resolves (every member gone is
 * `deleteNode`'s job to catch first, so this is a defensive fallback, not the
 * normal path).
 */
function groupLabelBounds(nodes: NodeMap, node: GroupLabelNode): RectMm | null {
  // The drawn picture, not the cell it sits in — see `memberContentRect`.
  const memberRects = node.memberIds
    .map((id) => memberContentRect(nodes, id))
    .filter((r): r is RectMm => r !== null);
  if (memberRects.length === 0) return null;
  return union(memberRects)!;
}

/** Which coordinate a heading's own side of its members sits on. */
function groupLabelBoundary(edge: GroupLabelNode['edge'], bounds: RectMm): number {
  if (edge === 'top') return bounds.y;
  if (edge === 'left') return bounds.x;
  return bounds.x + bounds.width;
}

const GROUP_LABEL_EPS = 1e-6;

/**
 * How far *beyond* its own clearance a heading has to sit, because wider
 * headings on the same line take the space nearer the content.
 *
 * This is what makes "a per-tile caption sits under the group heading"
 * true — the requested behaviour, and the only thing that stops the two
 * from being drawn in the same millimetres. The narrower heading is the
 * inner one: a caption belongs against the tile it names, and the heading
 * spanning the whole row belongs above it. So the rule is simply: anything
 * on this same edge, on this same line, overlapping this heading's span,
 * and covering strictly *fewer* members, takes the space nearer the content
 * and pushes this one further out by its own clearance.
 *
 * Labels covering the *same* number of members share one level — three
 * captions across a row of three tiles sit side by side, not in a
 * staircase — so a level costs the widest clearance among its members once,
 * not once per label.
 *
 * The alternative, a stored explicit "row" or z-level per heading, was not
 * built: it is a second source of truth for something the member sets
 * already say unambiguously, and it would go stale the moment a heading's
 * members changed.
 */
function groupLabelStackOffsetMm(nodes: NodeMap, node: GroupLabelNode): number {
  // An overlaid label is drawn on the picture and reserves nothing, so it
  // neither stacks nor is stacked against.
  if (node.placement === 'overlay') return 0;
  const bounds = groupLabelBounds(nodes, node);
  if (!bounds) return 0;
  const boundary = groupLabelBoundary(node.edge, bounds);
  // 'top' stacks along y and the span runs along x; 'left'/'right' the reverse.
  const spanStart = node.edge === 'top' ? bounds.x : bounds.y;
  const spanEnd = node.edge === 'top' ? bounds.x + bounds.width : bounds.y + bounds.height;

  // Widest clearance at each distinct member count *below* this one's — the
  // levels that sit between this heading and the content it labels.
  const byCount = new Map<number, number>();
  for (const other of Object.values(nodes)) {
    if (other.type !== 'group-label' || other.id === node.id) continue;
    if (other.edge !== node.edge) continue;
    if (other.placement === 'overlay') continue; // takes no space to stack over
    if (other.memberIds.length >= node.memberIds.length) continue;

    const otherBounds = groupLabelBounds(nodes, other);
    if (!otherBounds) continue;
    if (Math.abs(groupLabelBoundary(other.edge, otherBounds) - boundary) > GROUP_LABEL_EPS) continue;

    const oStart = node.edge === 'top' ? otherBounds.x : otherBounds.y;
    const oEnd =
      node.edge === 'top' ? otherBounds.x + otherBounds.width : otherBounds.y + otherBounds.height;
    if (oEnd <= spanStart + GROUP_LABEL_EPS || oStart >= spanEnd - GROUP_LABEL_EPS) continue;

    const clearance = clearanceForLabel(other);
    byCount.set(
      other.memberIds.length,
      Math.max(byCount.get(other.memberIds.length) ?? 0, clearance),
    );
  }

  let offset = 0;
  for (const clearance of byCount.values()) offset += clearance;
  return offset;
}

/**
 * Total extent a heading occupies measured out from its members — its own
 * clearance plus the room taken by any wider heading stacked outside it.
 *
 * Composed once here and read by `groupLabelFrame`, by
 * `montageGutterExtras` (the same-panel gutter) and by
 * `reserveSpaceForGroupLabels` (the cross-panel push), so the space a
 * heading is *given* and the space it is *drawn in* cannot disagree.
 */
export function groupLabelExtentMm(nodes: NodeMap, node: GroupLabelNode): number {
  return clearanceForLabel(node) + groupLabelStackOffsetMm(nodes, node);
}

export function groupLabelFrame(nodes: NodeMap, node: GroupLabelNode): RectMm | null {
  const bounds = groupLabelBounds(nodes, node);
  if (!bounds) return null;

  /*
   * An overlaid label sits *inside* the picture, inset from its top-left — the
   * convention the csLFM and VSCyto reference figures use for channel names
   * and timestamps. Its frame is a band across the top of the content rather
   * than a reserved strip beside it, so nothing on the page moves to make room
   * and `clearanceForLabel` returns 0 for it.
   */
  if (node.placement === 'overlay') {
    const pad = GROUP_LABEL_OVERLAY_PAD_MM;
    const lineMm = ptToMm(node.style?.fontSizePt ?? DEFAULT_GROUP_LABEL_PT) * 1.2;
    const overlay: RectMm = {
      x: bounds.x + pad,
      y: bounds.y + pad,
      width: Math.max(0, bounds.width - 2 * pad),
      height: Math.min(lineMm, Math.max(0, bounds.height - 2 * pad)),
    };
    const nudge = node.userOffsetMm;
    return nudge ? { ...overlay, x: overlay.x + nudge.x, y: overlay.y + nudge.y } : overlay;
  }

  const clearance = clearanceForLabel(node);
  // Sit outside anything wider on the same line, so a caption tucks under
  // the heading that spans it rather than colliding with it.
  const stack = groupLabelStackOffsetMm(nodes, node);

  const base: RectMm =
    node.edge === 'top'
      ? {
          x: bounds.x,
          y: bounds.y - clearance - stack,
          width: bounds.width,
          height: clearance,
        }
      : node.edge === 'left'
        ? {
            x: bounds.x - clearance - stack,
            y: bounds.y,
            width: clearance,
            height: bounds.height,
          }
        : {
            x: bounds.x + bounds.width + stack,
            y: bounds.y,
            width: clearance,
            height: bounds.height,
          };

  const offset = node.userOffsetMm;
  return offset ? { ...base, x: base.x + offset.x, y: base.y + offset.y } : base;
}

/**
 * Reposition every group-label from its members' current positions.
 *
 * Never touches any other node's frame — the direct parallel to
 * `repositionBrackets`, and wired into the same call sites: anything that
 * moves a panel or an image already needs to follow up with this, the same
 * way it already follows up with `reflowBrackets`.
 */
export function reflowGroupLabels(draft: FigureDocument): void {
  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'group-label') continue;
    const frame = groupLabelFrame(draft.nodes, node);
    if (frame) node.frame = frame;
  }
  reflowPanelLetterLifts(draft);
}

/**
 * Lift each panel letter clear of any heading drawn above its panel.
 *
 * A panel letter identifies the panel and belongs outside everything else, so
 * the order down the page is letter, then heading, then the graph. The heading's
 * own geometry is untouched — it still sits in the band immediately above its
 * members — and it is the letter that moves up to make way. Doing it the other
 * way round (insetting the panel's content so the heading fits inside the frame)
 * would mean changing `groupLabelFrame` and `fillPanelChildren` for every
 * heading, including the montage and single-image cases, to fix something that
 * only arises for panels.
 *
 * The lift is *stored* and applied as a difference. Setting `frame.y` outright
 * would be simpler and wrong: this runs after every canvas drag, so an absolute
 * recompute would snap a hand-nudged letter back to its panel on the author's
 * next move. Adjusting by `next - previous` leaves any manual nudge intact and
 * puts the letter back exactly when the heading is resized or deleted.
 *
 * Called from `reflowGroupLabels` rather than exported separately, so every one
 * of that function's existing call sites settles the letters too.
 */
function reflowPanelLetterLifts(draft: FigureDocument): void {
  /*
   * A heading lifts a letter only when it is really drawn *above the panel's own
   * top edge*. That is what separates a heading over the panel from a montage
   * cell caption, which lives inside the panel's grid and must move nothing:
   * the cell caption's frame starts below the panel top, so it fails this test
   * without needing to know anything about montages.
   */
  const liftByPanel = new Map<NodeId, number>();

  for (const label of Object.values(draft.nodes)) {
    if (label.type !== 'group-label') continue;
    if (label.edge !== 'top' || label.placement === 'overlay') continue;

    for (const memberId of label.memberIds) {
      const ownerId = topLevelOwner(draft.nodes, memberId);
      if (!ownerId) continue;
      const owner = draft.nodes[ownerId];
      if (owner?.type !== 'panel') continue;

      const gap = owner.frame.y - label.frame.y;
      if (gap <= 1e-6) continue;
      liftByPanel.set(ownerId, Math.max(liftByPanel.get(ownerId) ?? 0, gap));
    }
  }

  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'panel-label') continue;
    const panel = draft.nodes[node.panelId];
    if (panel?.type !== 'panel') continue;

    const heading = liftByPanel.get(node.panelId) ?? 0;
    // Sit the letter immediately above the heading, not merely clear of the
    // panel — the heading occupies the whole band the lift measures.
    const next = heading > 0 ? heading + panelLetterHeightMm(node.style.fontSizePt) : 0;
    const previous = node.liftMm ?? 0;
    if (Math.abs(next - previous) <= 1e-6) continue;

    node.frame = { ...node.frame, y: node.frame.y - (next - previous) };
    node.liftMm = next > 0 ? next : undefined;
  }
}

/**
 * Grow the gap on one side of a group-label's members so the heading has
 * room to draw, by translating whatever panel sits beyond it.
 *
 * Deliberately **not** live during a manual drag, resize, align or
 * distribute — this codebase's manual-layout contract leaves frames alone
 * except for snapping, and fighting that live would read as the editor
 * overriding the user (see `GroupLabelNode`'s own doc comment). Called only
 * from creating/editing a heading, and from the handful of places that
 * already run `applyAutoLayout` from scratch.
 *
 * Same-panel headings (`isSameMontageGroup`) need none of this: their
 * clearance is already a live grid gutter, folded into `fillPanelChildren`.
 * This function only ever moves top-level `panel` nodes — a heading's own
 * frame is corrected afterwards by `reflowGroupLabels`, which every caller
 * of this function also calls.
 */
export function reserveSpaceForGroupLabels(draft: FigureDocument): void {
  const EPS = 1e-6;

  for (const label of Object.values(draft.nodes)) {
    if (label.type !== 'group-label') continue;
    if (isSameMontageGroup(draft.nodes, label.memberIds)) continue;

    const ownerIds = new Set<NodeId>();
    for (const memberId of label.memberIds) {
      const owner = topLevelOwner(draft.nodes, memberId);
      if (owner) ownerIds.add(owner);
    }
    const ownerRects = [...ownerIds]
      .map((id) => absoluteFrame(draft.nodes, id))
      .filter((r): r is RectMm => r !== null);
    if (ownerRects.length === 0) continue;
    const bounds = union(ownerRects)!;

    /*
     * A `'top'` heading over a panel is drawn below that panel's letter, so the
     * band it needs is its own extent plus the letter's line height. Without
     * this the two land on the same line and the letter has nowhere to go.
     * Only panels have letters, and only a heading above the panel's own top
     * edge displaces one — a montage cell caption sits inside the frame.
     */
    const letterMm =
      label.edge === 'top' && label.placement !== 'overlay'
        ? Math.max(
            0,
            ...[...ownerIds].map((id) => {
              const owner = draft.nodes[id];
              if (owner?.type !== 'panel') return 0;
              const letter = Object.values(draft.nodes).find(
                (n) => n.type === 'panel-label' && n.panelId === id,
              );
              return letter?.type === 'panel-label'
                ? panelLetterHeightMm(letter.style.fontSizePt)
                : 0;
            }),
          )
        : 0;

    const clearance = groupLabelExtentMm(draft.nodes, label) + letterMm;

    const axis: 'x' | 'y' = label.edge === 'top' ? 'y' : 'x';
    const boundary =
      label.edge === 'top' ? bounds.y : label.edge === 'left' ? bounds.x : bounds.x + bounds.width;
    const spanStart = axis === 'y' ? bounds.x : bounds.y;
    const spanEnd = axis === 'y' ? bounds.x + bounds.width : bounds.y + bounds.height;

    const panels = Object.values(draft.nodes).filter(
      (n): n is PanelNode => n.type === 'panel' && n.parentId === null,
    );

    const overlaps = (rect: RectMm): boolean => {
      const rStart = axis === 'y' ? rect.x : rect.y;
      const rEnd = axis === 'y' ? rect.x + rect.width : rect.y + rect.height;
      return rEnd > spanStart + EPS && rStart < spanEnd - EPS;
    };

    // The nearest neighbour on the side the heading actually draws into: for
    // 'top'/'left', the panel immediately before the members; for 'right',
    // the panel immediately after them (the heading's own space is beyond
    // the members either way, so "before"/"after" flips with `boundary`).
    let neighborEdge: number | null = null;
    for (const panel of panels) {
      if (ownerIds.has(panel.id)) continue;
      const rect = absoluteFrame(draft.nodes, panel.id);
      if (!rect || !overlaps(rect)) continue;
      const near = axis === 'y' ? rect.y : rect.x;
      const far = axis === 'y' ? rect.y + rect.height : rect.x + rect.width;

      if (label.edge === 'right') {
        if (near < boundary - EPS) continue;
        if (neighborEdge === null || near < neighborEdge) neighborEdge = near;
      } else {
        if (far > boundary + EPS) continue;
        if (neighborEdge === null || far > neighborEdge) neighborEdge = far;
      }
    }
    /*
     * No panel on that side means the heading is drawing into the page's own
     * margin, so the *page edge* is what the gap is measured against.
     *
     * This is the whole defect the top row suffered from: the branch used to
     * `continue` here, so the one case that most needs space reserved — a
     * heading on the top row, with nothing above it to push against — reserved
     * none, and the heading was drawn above the page's top edge and over the
     * panel letter. Measured on the sample figure before the fix: y = -1.27 mm.
     */
    const pageEdge =
      label.edge === 'right'
        ? draft.page.widthMm - marginMm(draft)
        : marginMm(draft);
    if (neighborEdge === null) neighborEdge = pageEdge;

    const currentGap = label.edge === 'right' ? neighborEdge - boundary : boundary - neighborEdge;
    const shortfall = clearance - currentGap;
    if (shortfall <= EPS) continue;

    pushPanelsFrom(draft, panels, axis, boundary, shortfall);
  }
}

/**
 * Make room beneath every picture whose scale bar is drawn below it.
 *
 * The sibling of `reserveSpaceForGroupLabels`, sharing its `pushPanelsFrom` so
 * there is one implementation of push-then-shrink rather than two that can
 * drift. Same contract, and for the same reason: **not** live during a manual
 * drag, resize, align or distribute — it moves other panels, which the
 * manual-layout contract forbids — so it is called only from deliberate actions
 * and from the paths that already lay the page out from scratch.
 *
 * Needed at all because a picture routinely fills its frame exactly: measured
 * on the sample, the montage's tiles are 16.78 x 11.89 mm pictures in 16.78 x
 * 11.89 mm frames, so there is no spare strip beneath one to drop a bar into.
 */
export function reserveSpaceForScaleBars(draft: FigureDocument): void {
  const EPS = 1e-6;

  const panels = Object.values(draft.nodes).filter(
    (n): n is PanelNode => n.type === 'panel' && n.parentId === null,
  );

  for (const bar of Object.values(draft.nodes)) {
    if (bar.type !== 'scale-bar' || bar.placement !== 'below') continue;

    const image = bar.parentId ? draft.nodes[bar.parentId] : undefined;
    if (image?.type !== 'image') continue;
    const imageFrame = absoluteFrame(draft.nodes, image.id);
    if (!imageFrame) continue;

    const content = imageContentRect(image);
    const pictureBottom = imageFrame.y + content.y + content.height;
    const pictureLeft = imageFrame.x + content.x;
    const pictureRight = pictureLeft + content.width;

    const required = scaleBarBelowExtentMm(bar);
    if (required <= EPS) continue;

    const ownerId = topLevelOwner(draft.nodes, image.id);
    const owner = ownerId ? draft.nodes[ownerId] : undefined;
    if (owner?.type !== 'panel') continue;
    const ownerFrame = absoluteFrame(draft.nodes, owner.id);
    if (!ownerFrame) continue;

    // The nearest panel below that actually sits under this picture. A panel
    // off to one side is not in the bar's way.
    let below: number | null = null;
    for (const panel of panels) {
      if (panel.id === owner.id) continue;
      const rect = absoluteFrame(draft.nodes, panel.id);
      if (!rect) continue;
      if (rect.x + rect.width <= pictureLeft + EPS || rect.x >= pictureRight - EPS) continue;
      if (rect.y < pictureBottom - EPS) continue;
      if (below === null || rect.y < below) below = rect.y;
    }

    const limit = below ?? draft.page.heightMm - marginMm(draft);
    const shortfall = required - (limit - pictureBottom);
    if (shortfall <= EPS) continue;

    if (below !== null) {
      pushPanelsFrom(draft, panels, 'y', ownerFrame.y + ownerFrame.height, shortfall);
      continue;
    }

    /*
     * Nothing below to push — the bottom row — so the panel that gained the bar
     * pays for it out of its own height. The picture shrinks with the panel, so
     * the band opens up inside the panel's own frame and the page is untouched.
     */
    const height = Math.max(MIN_TILE_MM, owner.frame.height - shortfall);
    if (height >= owner.frame.height - EPS) continue;
    const snapshot = snapshotPanelAbsolutePositions(draft.nodes, owner.id);
    resizePanel(draft, owner.id, { ...owner.frame, height });
    syncPanelLabelsFromSnapshot(draft, snapshot);
  }

  // The bars themselves follow whatever just moved.
  resyncScaleBars(draft);
}

/**
 * Every reservation the page needs, in one call.
 *
 * There are two — headings above their members and scale bars below their
 * pictures — and roughly ten call sites that must run both. One name is what
 * stops a new call site remembering one and forgetting the other; the halves
 * stay exported so each can be tested on its own.
 */
export function reserveLayoutSpace(draft: FigureDocument): void {
  reserveSpaceForGroupLabels(draft);
  reserveSpaceForScaleBars(draft);
}

/**
 * The page margin, which `reserveSpaceForGroupLabels` needs and the document
 * does not store.
 *
 * `theme.spacing.marginMm` is the real source and `doc-model` may not import
 * `theme`, so this reads the margin the page is *actually laid out with*: the
 * smallest inset any top-level panel sits at. A figure whose panels have been
 * dragged inward simply reports a larger margin, which is the honest answer —
 * the question being asked is "how much room is there above the top row", not
 * "what does the theme nominally reserve".
 */
function marginMm(draft: FigureDocument): number {
  let smallest = Number.POSITIVE_INFINITY;
  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'panel') continue;
    // Page space, and every panel rather than only the top-level ones: a figure
    // whose panels are all inside groups used to match nothing here and report
    // a 0 mm margin, which let a heading be pushed into the bleed.
    const page = absoluteFrame(draft.nodes, node.id) ?? node.frame;
    smallest = Math.min(smallest, page.x, page.y);
  }
  return Number.isFinite(smallest) ? Math.max(0, smallest) : 0;
}

/**
 * Push every panel at or beyond a boundary, then take back whatever no longer
 * fits on the page.
 *
 * Pushing alone would walk the bottom row off the page — on the sample figure
 * the required band is about 6.4 mm against 3.6 mm of slack, so the shrink is
 * the common path rather than a rare branch. Growing the page instead was
 * considered and refused: a caption silently making a figure taller can breach
 * a journal's maximum height, and the page is not this function's to spend.
 *
 * Panels are shrunk by *row*, banded on `y` with the same 5 mm tolerance
 * `readingOrder` uses to decide what a row is, so a row's panels keep their
 * shared top and bottom edges.
 */
function pushPanelsFrom(
  draft: FigureDocument,
  panels: readonly PanelNode[],
  axis: 'x' | 'y',
  boundary: number,
  shortfall: number,
): void {
  const EPS = 1e-6;
  const moved: PanelNode[] = [];

  for (const panel of panels) {
    const rect = absoluteFrame(draft.nodes, panel.id);
    if (!rect) continue;
    const coord = axis === 'y' ? rect.y : rect.x;
    if (coord < boundary - EPS) continue;

    const before = snapshotPanelAbsolutePositions(draft.nodes, panel.id);
    panel.frame =
      axis === 'y'
        ? { ...panel.frame, y: panel.frame.y + shortfall }
        : { ...panel.frame, x: panel.frame.x + shortfall };
    syncPanelLabelsFromSnapshot(draft, before);
    moved.push(panel);
  }

  // Only a downward push can run off the page; a `left`/`right` heading moves
  // panels sideways within a width this function never changes.
  if (axis !== 'y' || moved.length === 0) return;

  const margin = marginMm(draft);
  const limit = draft.page.heightMm - margin;
  const lowest = Math.max(...moved.map((p) => p.frame.y + p.frame.height));
  const overflow = lowest - limit;
  if (overflow <= EPS) return;

  // Rows, by the rule `readingOrder` already uses to decide what a row is.
  const rows = rowBands(moved, (panel) => panel.frame.y);

  const rowHeight = (row: readonly PanelNode[]): number =>
    Math.max(...row.map((p) => p.frame.height));
  const totalHeight = rows.reduce((sum, row) => sum + rowHeight(row), 0);
  if (totalHeight <= EPS) return;

  let shift = 0;
  for (const row of rows) {
    const height = rowHeight(row);
    /*
     * Never below the floor a panel needs to stay usable. Where the overflow
     * cannot be fully absorbed the rows take what they can and the remainder is
     * left on the page — a figure slightly over its page is recoverable, a row
     * of panels collapsed to nothing is not.
     */
    const wanted = (overflow * height) / totalHeight;
    const take = Math.max(0, Math.min(wanted, height - MIN_TILE_MM));

    for (const panel of row) {
      const next: RectMm = {
        ...panel.frame,
        y: panel.frame.y - shift,
        height: Math.max(MIN_TILE_MM, panel.frame.height - take),
      };
      const before = snapshotPanelAbsolutePositions(draft.nodes, panel.id);
      resizePanel(draft, panel.id, next);
      syncPanelLabelsFromSnapshot(draft, before);
    }
    shift += take;
  }
}

export interface AddGroupLabelOptions {
  memberIds: readonly NodeId[];
  edge: GroupLabelNode['edge'];
  title?: string;
  fontSizePt?: number;
}

/**
 * Create a heading over a row/column of panels or images, or a caption on a
 * single one — the same mechanism at both granularities, since a caption is
 * simply a group of one member.
 *
 * Positioned once against the members' *current* frames; the caller runs
 * `reserveSpaceForGroupLabels` (cross-panel case) or relies on the next
 * `fillPanelChildren` re-tile (same-panel case) to make room, then
 * `reflowGroupLabels` to land the heading in its final spot.
 */
export function addGroupLabel(
  draft: FigureDocument,
  newId: () => string,
  options: AddGroupLabelOptions,
): GroupLabelNode | null {
  if (options.memberIds.length === 0) return null;
  const memberRects = options.memberIds
    .map((id) => absoluteFrame(draft.nodes, id))
    .filter((r): r is RectMm => r !== null);
  if (memberRects.length === 0) return null;
  const bounds = union(memberRects)!;

  const id = newId();
  const title = options.title ?? '';
  /*
   * No `fontWeight` and no `showRule`: both are left absent so the *defaults*
   * apply — 6 pt non-bold text with no rule, matching the type around it.
   * Writing them here is what made every heading arrive bold-and-ruled no
   * matter what the defaults said, since an explicit value always wins.
   * `stroke` is still stored so turning the rule on later has something
   * sensible to draw with.
   */
  const style: TextStyle = {
    ...(options.fontSizePt !== undefined ? { fontSizePt: options.fontSizePt } : {}),
  };

  const node: GroupLabelNode = {
    ...baseNode(
      id,
      title || 'Group title',
      layerId(draft, 'Labels'),
      bounds, // provisional; reflowGroupLabels below settles the real frame
      null,
      nextZ(draft.nodes, null),
    ),
    type: 'group-label',
    memberIds: options.memberIds,
    edge: options.edge,
    title,
    stroke: DEFAULT_GROUP_LABEL_STROKE,
    style,
  };
  draft.nodes[id] = node;

  const frame = groupLabelFrame(draft.nodes, node);
  if (frame) node.frame = frame;

  return node;
}

// ---------------------------------------------------------------------------
// Text, datasets and deletion
// ---------------------------------------------------------------------------

export function addText(
  draft: FigureDocument,
  newId: () => string,
  options: { frame: RectMm; text: string; fontSizePt?: number },
): TextNode {
  const id = newId();
  const node: TextNode = {
    ...baseNode(
      id,
      options.text.slice(0, 24) || 'Text',
      layerId(draft, 'Annotations'),
      options.frame,
      null,
      nextZ(draft.nodes, null),
    ),
    type: 'text',
    text: options.text,
    style: options.fontSizePt !== undefined ? { fontSizePt: options.fontSizePt } : {},
  };
  draft.nodes[id] = node;
  return node;
}

// ---------------------------------------------------------------------------
// Annotations: arrows, shapes, groups
// ---------------------------------------------------------------------------

const DEFAULT_ANNOTATION_STROKE: Stroke = { color: '#000000', widthMm: 0.35, cap: 'round' };

export interface AddArrowOptions {
  frame?: RectMm;
  /** Relative to the frame origin. Fewer than two falls back to the default. */
  points?: readonly PointMm[];
  stroke?: Stroke;
  head?: 'none' | 'triangle' | 'open';
  tail?: 'none' | 'triangle' | 'open';
  headSizeMm?: number;
  parentId?: NodeId | null;
}

export function addArrow(
  draft: FigureDocument,
  newId: () => string,
  options: AddArrowOptions = {},
): ArrowNode {
  const frame = options.frame ?? { x: 10, y: 10, width: 20, height: 10 };
  // Horizontal: a clean starting line an author can re-aim from either end
  // (Shift-drag an endpoint snaps it to 45° steps, so any orientation is
  // one drag away) rather than a diagonal they have to fight first.
  const fallback: PointMm[] = [
    { x: 0, y: frame.height / 2 },
    { x: frame.width, y: frame.height / 2 },
  ];
  // The schema requires at least two points; a shorter list would validate on
  // screen and make the saved project unloadable.
  const points =
    options.points && options.points.length >= 2 ? [...options.points] : fallback;

  const parentId = options.parentId ?? null;
  const id = newId();
  const node: ArrowNode = {
    ...baseNode(id, 'Arrow', layerId(draft, 'Annotations'), frame, parentId, nextZ(draft.nodes, parentId)),
    type: 'arrow',
    points,
    stroke: options.stroke ?? DEFAULT_ANNOTATION_STROKE,
    head: options.head ?? 'triangle',
    headSizeMm: options.headSizeMm ?? 1.6,
    tail: options.tail ?? 'none',
  };
  draft.nodes[id] = node;
  return node;
}

/**
 * Re-fit an arrow's frame around its points.
 *
 * Points are frame-relative, so dragging one past the origin would put it at a
 * negative coordinate and leave the selection outline behind. Rebasing keeps
 * the chrome on the arrow.
 */
export function normaliseArrowFrame(draft: FigureDocument, id: NodeId): void {
  const node = draft.nodes[id];
  if (node?.type !== 'arrow' || node.points.length === 0) return;

  const xs = node.points.map((p) => p.x);
  const ys = node.points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  node.points = node.points.map((p) => ({ x: p.x - minX, y: p.y - minY }));
  node.frame = {
    x: node.frame.x + minX,
    y: node.frame.y + minY,
    width: Math.max(...xs) - minX,
    height: Math.max(...ys) - minY,
  };
}

export function setArrowPoint(
  draft: FigureDocument,
  id: NodeId,
  index: number,
  point: PointMm,
): void {
  const node = draft.nodes[id];
  if (node?.type !== 'arrow') return;
  if (index < 0 || index >= node.points.length) return;
  node.points = node.points.map((p, i) => (i === index ? point : p));
  normaliseArrowFrame(draft, id);
}

/** Scale an arrow's points into a resized frame, so a drag stretches the line. */
export function rescaleArrowPoints(draft: FigureDocument, id: NodeId, frame: RectMm): void {
  const node = draft.nodes[id];
  if (node?.type !== 'arrow') return;
  const sx = node.frame.width > 0 ? frame.width / node.frame.width : 1;
  const sy = node.frame.height > 0 ? frame.height / node.frame.height : 1;
  node.points = node.points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  node.frame = frame;
}

export interface AddShapeOptions {
  shape: 'rect' | 'ellipse' | 'line';
  frame: RectMm;
  fill?: Fill | null;
  stroke?: Stroke | null;
  cornerRadiusMm?: number;
  parentId?: NodeId | null;
}

export function addShape(
  draft: FigureDocument,
  newId: () => string,
  options: AddShapeOptions,
): ShapeNode {
  const parentId = options.parentId ?? null;
  const id = newId();
  const name = options.shape === 'rect' ? 'Rectangle' : options.shape === 'ellipse' ? 'Ellipse' : 'Line';

  const node: ShapeNode = {
    ...baseNode(id, name, layerId(draft, 'Annotations'), options.frame, parentId, nextZ(draft.nodes, parentId)),
    type: 'shape',
    shape: options.shape,
    // Unfilled by default: a shape over a micrograph is nearly always an
    // outline drawing attention to something, not a patch hiding it.
    fill: options.fill ?? null,
    stroke: options.stroke === undefined ? DEFAULT_ANNOTATION_STROKE : options.stroke,
    ...(options.cornerRadiusMm !== undefined ? { cornerRadiusMm: options.cornerRadiusMm } : {}),
  };
  draft.nodes[id] = node;
  return node;
}

/**
 * Wrap nodes in a group, preserving every member's position on the page.
 *
 * Refuses a selection whose members do not share a parent: regrouping across
 * panels would silently reparent geometry the user never touched.
 */
export function addGroup(
  draft: FigureDocument,
  newId: () => string,
  ids: readonly NodeId[],
  name?: string,
): GroupNode | null {
  const members = ids.map((id) => draft.nodes[id]).filter((n): n is FigureNode => n !== undefined);
  if (members.length < 2) return null;

  const parentId = members[0]!.parentId;
  if (members.some((n) => n.parentId !== parentId)) return null;

  const bounds = union(members.map((n) => n.frame));
  if (!bounds) return null;

  const id = newId();
  const group: GroupNode = {
    ...baseNode(
      id,
      name ?? `Group of ${members.length}`,
      members[0]!.layerId,
      bounds,
      parentId,
      nextZ(draft.nodes, parentId),
    ),
    type: 'group',
  };
  draft.nodes[id] = group;

  // reparentNode already compensates for the new origin, so the members do not
  // move on the page — which is the whole contract of grouping.
  for (const member of members) reparentNode(draft, member.id, id);
  return group;
}

/** Dissolve a group, reparenting its children to the group's own parent. */
export function ungroup(draft: FigureDocument, groupId: NodeId): NodeId[] {
  const group = draft.nodes[groupId];
  if (group?.type !== 'group') return [];

  const children = Object.values(draft.nodes).filter((n) => n.parentId === groupId);
  for (const child of children) reparentNode(draft, child.id, group.parentId);

  delete draft.nodes[groupId];
  return children.map((c) => c.id);
}

/**
 * Every panel's absolute page position, for `rootId` and everything under it.
 *
 * Read before a move or a group resize touches any frame, and compared
 * against the same read taken after, by `syncPanelLabelsFromSnapshot`. A
 * panel-label is a top-level node with no parent of its own, so nothing
 * about *how* a panel's absolute position changed — a plain translate, a
 * proportional scale nested three groups deep, anything — needs to be
 * tracked; only that it did.
 */
export function snapshotPanelAbsolutePositions(nodes: NodeMap, rootId: NodeId): Map<NodeId, PointMm> {
  const snapshot = new Map<NodeId, PointMm>();
  const record = (id: NodeId): void => {
    if (nodes[id]?.type !== 'panel') return;
    const frame = absoluteFrame(nodes, id);
    if (frame) snapshot.set(id, { x: frame.x, y: frame.y });
  };
  record(rootId);
  for (const descendant of descendantsOf(nodes, rootId)) record(descendant.id);
  return snapshot;
}

/**
 * Shift every panel-label whose panel's absolute position moved since
 * `before` was captured, by exactly that delta.
 *
 * The panel's own frame is not touched here — only its top-level, page-space
 * label sibling, which `resizePanel`'s own `dx/dy` shim cannot reach
 * correctly once the panel's *parent* (a group) has also moved or scaled.
 */
export function syncPanelLabelsFromSnapshot(draft: FigureDocument, before: ReadonlyMap<NodeId, PointMm>): void {
  for (const [panelId, prev] of before) {
    const frame = absoluteFrame(draft.nodes, panelId);
    if (!frame) continue;
    const dx = frame.x - prev.x;
    const dy = frame.y - prev.y;
    if (dx === 0 && dy === 0) continue;
    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'panel-label' && node.panelId === panelId) {
        node.frame = { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy };
      }
    }
  }
}

/**
 * Node types a plain frame align/distribute may reposition.
 *
 * Deliberately excludes `bracket` (sits in absolute page space, positioned
 * by `layoutBracketsForPlot`/`userOffsetMm`, and reflowed at the app layer
 * after any panel move — see `alignSelection`'s own doc comment) and
 * `scale-bar` (its `frame.width` is derived by `scaleBarWidthMm` and owned
 * by `resyncScaleBars`). A plain align would fight both.
 */
export const ALIGNABLE_NODE_TYPES = new Set<FigureNode['type']>([
  'panel',
  'image',
  'shape',
  'arrow',
  'text',
  'panel-label',
  'group',
]);

/**
 * Every alignable, unlocked target's absolute frame and its ancestor
 * origin, captured before any mutation.
 *
 * Reading the origin now — rather than re-deriving it after some targets
 * have already moved — is what keeps a selection that happens to include
 * both a container and one of its own descendants from compounding a
 * double move: every target's starting point is fixed before the first
 * write happens.
 */
function alignableSnapshot(
  nodes: NodeMap,
  ids: readonly NodeId[],
): Map<NodeId, { abs: RectMm; originX: number; originY: number }> {
  const out = new Map<NodeId, { abs: RectMm; originX: number; originY: number }>();
  for (const id of ids) {
    const node = nodes[id];
    if (!node || !ALIGNABLE_NODE_TYPES.has(node.type) || isEffectivelyLocked(nodes, id)) continue;
    const abs = absoluteFrame(nodes, id);
    if (!abs) continue;
    out.set(id, { abs, originX: abs.x - node.frame.x, originY: abs.y - node.frame.y });
  }
  return out;
}

/**
 * Every panel among `targets`' absolute position, for reconciling their
 * labels once alignment/distribution has moved them.
 *
 * Must be read before any frame is mutated — `syncPanelLabelsFromSnapshot`
 * computes each label's shift as the *difference* between this snapshot and
 * the panel's position afterward, so a snapshot taken even one write late
 * would already equal the new position and compute a zero delta.
 */
function panelLabelSnapshotFor(nodes: NodeMap, targets: ReadonlySet<NodeId>): Map<NodeId, PointMm> {
  const before = new Map<NodeId, PointMm>();
  for (const id of targets) {
    if (nodes[id]?.type !== 'panel') continue;
    for (const [panelId, pt] of snapshotPanelAbsolutePositions(nodes, id)) before.set(panelId, pt);
  }
  return before;
}

/**
 * Align a selection to its own bounding box — left/right/top/bottom edges
 * or horizontal/vertical centring.
 *
 * `alignFrames` (`layout.ts`) is pure geometry over `Map<NodeId, RectMm>`
 * with no notion of parent; this is the document-aware wrapper that
 * converts each target to page-absolute space (frames can come from
 * different parents — a shape inside one panel, a top-level text, a
 * parentless panel-label), aligns, and converts back. Brackets are never
 * targets (see `ALIGNABLE_NODE_TYPES`) because they sit in absolute page
 * space and do not move with the panel they annotate — callers that may
 * have aligned a panel should follow this with `reflowBrackets` (in
 * `packages/render`, so it cannot be called from here) the same way
 * `applyPreset`/`arrange` already do after any other panel reposition.
 */
export function alignSelection(draft: FigureDocument, ids: readonly NodeId[], mode: AlignMode): void {
  const snapshot = alignableSnapshot(draft.nodes, ids);
  if (snapshot.size < 2) return;

  const labelsBefore = panelLabelSnapshotFor(draft.nodes, new Set(snapshot.keys()));

  const absFrames = new Map<NodeId, RectMm>();
  for (const [id, o] of snapshot) absFrames.set(id, o.abs);
  const aligned = alignFrames(absFrames, mode);

  for (const [id, o] of snapshot) {
    const newAbs = aligned.get(id);
    if (!newAbs) continue;
    draft.nodes[id]!.frame = { ...draft.nodes[id]!.frame, x: newAbs.x - o.originX, y: newAbs.y - o.originY };
  }

  syncPanelLabelsFromSnapshot(draft, labelsBefore);
}

/**
 * Equalise the gaps between three or more selected objects along one axis.
 *
 * Same document-aware wrapper as `alignSelection`, over `distributeFrames`.
 */
export function distributeSelection(draft: FigureDocument, ids: readonly NodeId[], axis: GuideAxis): void {
  const snapshot = alignableSnapshot(draft.nodes, ids);
  if (snapshot.size < 3) return;

  const labelsBefore = panelLabelSnapshotFor(draft.nodes, new Set(snapshot.keys()));

  const absFrames = new Map<NodeId, RectMm>();
  for (const [id, o] of snapshot) absFrames.set(id, o.abs);
  const distributed = distributeFrames(absFrames, axis);

  for (const [id, o] of snapshot) {
    const newAbs = distributed.get(id);
    if (!newAbs) continue;
    draft.nodes[id]!.frame = { ...draft.nodes[id]!.frame, x: newAbs.x - o.originX, y: newAbs.y - o.originY };
  }

  syncPanelLabelsFromSnapshot(draft, labelsBefore);
}

/**
 * A per-child size floor during a group scale, purely against numerical
 * degeneracy (a child never reaches this from a live drag: the group's own
 * frame is already floored at 5 mm by `panelGridMinimumMm` in `Canvas.tsx`,
 * so no proportional share of it can hit zero). Not a usability floor the
 * way `MIN_TILE_MM` is for a panel's own tiles — a free-form group has no
 * grid to reason about, and every member already carries its own size floor
 * from whenever it was last resized directly.
 */
const MIN_GROUP_MEMBER_MM = 0.01;

/**
 * The frame half of `resizeGroup`, recursing into nested groups and reusing
 * each member type's own resize primitive.
 *
 * Every child's frame is already relative to the group's own origin (see
 * `reparentNode`), so scaling each child's local `x/y/width/height` by the
 * same factor the group's own frame just scaled by reproduces an ordinary
 * "resize group" — Illustrator, Figma — without needing any extra offset
 * math per level of nesting.
 */
function resizeGroupGeometry(draft: FigureDocument, groupId: NodeId, frame: RectMm): void {
  const group = draft.nodes[groupId];
  if (group?.type !== 'group') return;

  const old = group.frame;
  const sx = old.width > 0 ? frame.width / old.width : 1;
  const sy = old.height > 0 ? frame.height / old.height : 1;
  group.frame = frame;

  for (const child of childrenOf(draft.nodes, groupId)) {
    const target: RectMm = {
      x: child.frame.x * sx,
      y: child.frame.y * sy,
      width: Math.max(child.frame.width * sx, MIN_GROUP_MEMBER_MM),
      height: Math.max(child.frame.height * sy, MIN_GROUP_MEMBER_MM),
    };
    if (child.type === 'panel') resizePanelGeometry(draft, child.id, target);
    else if (child.type === 'arrow') rescaleArrowPoints(draft, child.id, target);
    else if (child.type === 'group') resizeGroupGeometry(draft, child.id, target);
    else draft.nodes[child.id]!.frame = target;
  }
}

/**
 * Resize a group, scaling every member proportionally — panels, shapes,
 * arrows, nested groups — the way a group resize behaves everywhere else.
 *
 * Before this, a group's own frame was the only thing a resize handle
 * touched: nothing under `packages/render` ever scales a node by its
 * `frame.width/height`, only translates it, so the group's bounding box
 * changed while its members visibly did not move at all.
 *
 * Individual member `rotation` and text `fontSizePt`/stroke widths are
 * deliberately left untouched — only position and size scale, matching
 * standard group-resize behaviour, and this codebase already keeps type
 * sizes independent of frame geometry everywhere else.
 */
export function resizeGroup(draft: FigureDocument, groupId: NodeId, frame: RectMm): void {
  if (draft.nodes[groupId]?.type !== 'group') return;

  const before = snapshotPanelAbsolutePositions(draft.nodes, groupId);
  resizeGroupGeometry(draft, groupId, frame);
  syncPanelLabelsFromSnapshot(draft, before);
  resyncScaleBars(draft);
}

export function addDataset(draft: FigureDocument, dataset: Dataset): void {
  draft.datasets = [...draft.datasets, dataset];
}

/**
 * Rename a dataset, and everything that took its name from it.
 *
 * Panels and plots copy the dataset name when they are created, so renaming
 * only the dataset would leave the Layers list and the panel still showing the
 * old one — which is the confusion the rename is meant to remove.
 */
export function renameDataset(draft: FigureDocument, datasetId: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed === '') return;

  const index = draft.datasets.findIndex((d) => d.id === datasetId);
  if (index < 0) return;

  const previous = draft.datasets[index]!;
  if (previous.name === trimmed) return;

  const next = [...draft.datasets];
  next[index] = { ...previous, name: trimmed };
  draft.datasets = next;

  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'plot' || node.datasetId !== datasetId) continue;
    node.name = `Plot — ${trimmed}`;
    // The panel took the dataset's name at import; keep them in step unless the
    // user has renamed the panel to something of their own.
    const panel = node.parentId ? draft.nodes[node.parentId] : undefined;
    if (panel && panel.type === 'panel' && panel.name === previous.name) {
      panel.name = trimmed;
    }
  }

  for (const analysis of draft.analyses) {
    if (analysis.spec.datasetId !== datasetId) continue;
    const renamed = { ...analysis, name: `${analysis.test} on ${trimmed}` };
    draft.analyses = draft.analyses.map((a) => (a.id === analysis.id ? renamed : a));
  }
}

/** Plot nodes reading a dataset. Empty means nothing on the page needs it. */
export function plotsUsingDataset(nodes: NodeMap, datasetId: DatasetId): PlotNode[] {
  return Object.values(nodes).filter(
    (n): n is PlotNode => n.type === 'plot' && n.datasetId === datasetId,
  );
}

/**
 * Drop a dataset, and the analyses computed from it.
 *
 * Refuses while any plot still reads it: `checkReferentialIntegrity` rejects a
 * document whose plot points at a missing dataset, so removing it anyway would
 * produce a figure that edits perfectly and then cannot be saved. Returns
 * whether it went, so the caller can say why not.
 *
 * The analyses have to go with it. A result card citing a dataset the document
 * no longer contains cannot be checked against its data, and `analysisInputHash`
 * has nothing left to re-hash — the staleness warning that exists to catch
 * exactly this would be reporting on numbers that are gone.
 *
 * Deliberately *not* automatic when the last plot is deleted, for the same
 * reason orphan image assets are kept: undo has to be able to bring the plot
 * back, and collecting its data on the way out is what would strand it.
 */
export function removeDataset(draft: FigureDocument, datasetId: DatasetId): boolean {
  if (plotsUsingDataset(draft.nodes, datasetId).length > 0) return false;
  if (!draft.datasets.some((d) => d.id === datasetId)) return false;

  const orphaned = new Set(
    draft.analyses.filter((a) => a.spec.datasetId === datasetId).map((a) => a.id),
  );

  draft.datasets = draft.datasets.filter((d) => d.id !== datasetId);
  draft.analyses = draft.analyses.filter((a) => !orphaned.has(a.id));

  // A bracket whose analysis is gone can never be repositioned again —
  // `repositionBrackets` looks the analysis up and skips it — so it would sit
  // frozen at its last position, labelled with a p-value nothing can verify.
  for (const node of Object.values(draft.nodes)) {
    if (node.type === 'bracket' && node.analysisId !== null && orphaned.has(node.analysisId)) {
      delete draft.nodes[node.id];
    }
  }

  return true;
}

/**
 * Change how a dataset's columns are read, without touching the rows.
 *
 * `format` and `hasRowNames` are both *readings* of the same cells, so changing
 * either is lossless and reversible — which is what makes correcting a
 * mis-detected layout after import safe. The plot follows automatically:
 * `toSeries` is the only consumer of both fields.
 */
export function setDatasetReading(
  draft: FigureDocument,
  datasetId: DatasetId,
  reading: { format?: DataFormat; hasRowNames?: boolean },
): void {
  draft.datasets = draft.datasets.map((d) =>
    d.id === datasetId
      ? {
          ...d,
          ...(reading.format !== undefined ? { format: reading.format } : {}),
          ...(reading.hasRowNames !== undefined ? { hasRowNames: reading.hasRowNames } : {}),
        }
      : d,
  );
}

/**
 * Apply a cell-level edit to one dataset.
 *
 * The transforms themselves are pure and live in `data.ts`; this is the one
 * place they are written back, so every grid edit is an ordinary commit and
 * undo, redo, version history and the staleness warning all come free.
 */
export function editDataset(
  draft: FigureDocument,
  datasetId: DatasetId,
  edit: (dataset: Dataset) => Dataset,
): void {
  const index = draft.datasets.findIndex((d) => d.id === datasetId);
  if (index < 0) return;
  const next = edit(draft.datasets[index]!);
  const datasets = [...draft.datasets];
  datasets[index] = next;
  draft.datasets = datasets;
}

/**
 * Shallow field update on a node, for inspector edits.
 *
 * Typed per node variant so a patch cannot move a node between types or touch
 * its identity, which the flat node map relies on staying stable.
 */
export function updateNode<T extends FigureNode>(
  draft: FigureDocument,
  id: NodeId,
  patch: Partial<Omit<T, 'id' | 'type' | 'parentId'>>,
): void {
  const node = draft.nodes[id];
  if (!node) return;
  Object.assign(node, patch);
}

export function upsertAnalysis(draft: FigureDocument, analysis: Analysis): void {
  const index = draft.analyses.findIndex((a) => a.id === analysis.id);
  if (index >= 0) {
    const next = [...draft.analyses];
    next[index] = analysis;
    draft.analyses = next;
  } else {
    draft.analyses = [...draft.analyses, analysis];
  }
}

/** Delete a node and everything beneath it, plus any labels that referenced it. */
export function deleteNode(draft: FigureDocument, id: NodeId): void {
  const doomed = new Set<NodeId>([id]);

  let grew = true;
  while (grew) {
    grew = false;
    for (const node of Object.values(draft.nodes)) {
      if (node.parentId && doomed.has(node.parentId) && !doomed.has(node.id)) {
        doomed.add(node.id);
        grew = true;
      }
      // A panel label is not a child of its panel, so it needs its own sweep.
      if (node.type === 'panel-label' && doomed.has(node.panelId) && !doomed.has(node.id)) {
        doomed.add(node.id);
        grew = true;
      }
      // A group-label breaks the instant any one member is gone — a heading
      // over a partial row it no longer fully spans would misdescribe what
      // remains, which is worse than no heading at all.
      if (
        node.type === 'group-label' &&
        !doomed.has(node.id) &&
        node.memberIds.some((memberId) => doomed.has(memberId))
      ) {
        doomed.add(node.id);
        grew = true;
      }
      // A bracket is top-level too, joined to its plot only by `plotId` — the
      // missing sibling of the panel-label rule above. Without it a deleted
      // plot left its own significance brackets on the page (only the web
      // app's `deleteNodesWithLayout` swept them, so a direct caller did not),
      // and dropping the analysis below would strand their `analysisId`
      // against `checkReferentialIntegrity`.
      if (
        node.type === 'bracket' &&
        node.plotId != null &&
        doomed.has(node.plotId) &&
        !doomed.has(node.id)
      ) {
        doomed.add(node.id);
        grew = true;
      }
    }
  }

  for (const doomedId of doomed) delete draft.nodes[doomedId];

  /*
   * An analysis is a statement about one plot, so it goes when that plot does.
   *
   * Left behind it is a record naming a node that no longer exists: invisible
   * in the Stats tab, which shows the selected panel's result, unre-runnable
   * (`run()` always targets the selected plot), still written into the `.ffg`,
   * and still able to raise a stale-analysis error in the Quality tab that the
   * author cannot navigate to or act on.
   *
   * An analysis carrying no `plotId` is named by nothing here and is never
   * doomed — the field is optional only so pre-`plotId` documents load
   * unmigrated.
   */
  const orphaned = new Set(
    draft.analyses.filter((a) => a.plotId != null && doomed.has(a.plotId)).map((a) => a.id),
  );
  if (orphaned.size === 0) return;
  draft.analyses = draft.analyses.filter((a) => !orphaned.has(a.id));

  /*
   * And a bracket that named one of them from *another* plot.
   *
   * Not a defensive duplicate of the rule above — it reaches a case that one
   * cannot. `duplicateNode` remaps a copied bracket's `plotId` to the copy but
   * deliberately shares its `analysisId` with the original, since copying a
   * figure element must not fork its data. So deleting the original panel
   * orphans an analysis the *copy's* bracket still names, and the copy's plot
   * is not doomed. `checkReferentialIntegrity` runs on **load**, not on save,
   * so left alone this writes a `.ffg` without complaint that then cannot be
   * opened at all.
   *
   * Same sweep, and the same reasoning, as `removeDataset` above.
   */
  for (const node of Object.values(draft.nodes)) {
    if (node.type === 'bracket' && node.analysisId !== null && orphaned.has(node.analysisId)) {
      delete draft.nodes[node.id];
    }
  }
}

/**
 * Node types that describe another node rather than standing on their own.
 *
 * A bracket is a statement about a plot's data and a panel letter is a
 * statement about a panel. Copied on their own they would carry a reference to
 * a node the copy is not about — a second "P < 0.001" over a plot whose test
 * never produced it — so they are copied only as part of the thing they
 * annotate, with their references remapped.
 */
const DERIVED_NODE_TYPES = new Set(['bracket', 'panel-label', 'scale-bar', 'group-label']);

export const isDerivedNode = (node: FigureNode): boolean => DERIVED_NODE_TYPES.has(node.type);

/**
 * Copy a node and everything under it, with fresh ids.
 *
 * The inverse of `deleteNode`'s descendant sweep, including its panel-label
 * special case: a label is not a child of its panel but belongs to it. Every
 * reference *within* the copied set is remapped to the copy, so duplicating a
 * panel gives a panel whose brackets annotate the new plot rather than the old
 * one. References *out* of the set (an `assetId`, a `datasetId`, the
 * `analysisId` a bracket reads its p-value from) are shared, which is correct:
 * those are inputs, and copying a figure element must not fork its data.
 *
 * Returns the new id of `id` itself, or null if there was nothing to copy.
 */
export function duplicateNode(
  draft: FigureDocument,
  newId: () => string,
  id: NodeId,
  offsetMm: PointMm = { x: 0, y: 0 },
): NodeId | null {
  const root = draft.nodes[id];
  if (!root) return null;

  const members = new Set<NodeId>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of Object.values(draft.nodes)) {
      if (members.has(node.id)) continue;
      const belongs =
        (node.parentId !== null && members.has(node.parentId)) ||
        (node.type === 'panel-label' && members.has(node.panelId)) ||
        (node.type === 'bracket' && node.plotId != null && members.has(node.plotId)) ||
        // A group-label copies only when EVERY one of its own members is
        // already being copied — duplicating a lone panel out of a headed
        // row leaves the duplicate un-captioned rather than either silently
        // joining the original heading or refusing the duplicate outright.
        (node.type === 'group-label' && node.memberIds.every((memberId) => members.has(memberId)));
      if (belongs) {
        members.add(node.id);
        grew = true;
      }
    }
  }

  const remap = new Map<NodeId, NodeId>();
  for (const memberId of members) remap.set(memberId, newId());

  for (const memberId of members) {
    const source = draft.nodes[memberId]!;
    // `current` first: `structuredClone` cannot clone an Immer proxy, and every
    // node reached through a draft is one.
    const plain = isDraft(source) ? (current(source) as FigureNode) : source;
    const copy = structuredClone(plain) as FigureNode;
    copy.id = remap.get(memberId)!;
    copy.parentId = source.parentId !== null ? (remap.get(source.parentId) ?? null) : null;

    // Only the top of the copied subtree moves; everything below it is
    // positioned relative to a parent that has already been offset.
    if (memberId === id || copy.parentId === null) {
      copy.frame = { ...copy.frame, x: copy.frame.x + offsetMm.x, y: copy.frame.y + offsetMm.y };
    }
    copy.z = nextZ(draft.nodes, copy.parentId);

    if (copy.type === 'panel-label') copy.panelId = remap.get(copy.panelId) ?? copy.panelId;
    if (copy.type === 'bracket' && copy.plotId != null) {
      copy.plotId = remap.get(copy.plotId) ?? copy.plotId;
    }
    if (copy.type === 'group-label') {
      copy.memberIds = copy.memberIds.map((memberId) => remap.get(memberId) ?? memberId);
    }

    draft.nodes[copy.id] = copy;
  }

  return remap.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Draw order
// ---------------------------------------------------------------------------

/**
 * The layer a reordered top-level node lands in: the one belonging to whatever
 * it now sits against, so "send to back" can take an annotation past a graph.
 *
 * It stops at the last visible, unlocked layer on the way rather than stepping
 * into a hidden or locked one — a draw-order command must not make an object
 * invisible or unselectable as a side effect. Stopping short leaves the node in
 * the lowest (or highest) layer it may legally reach, which is as far as the
 * request can honestly be taken; where nothing is in the way that is the
 * neighbour's own layer.
 */
function destinationLayer(draft: FigureDocument, fromId: LayerId, toId: LayerId): LayerId {
  if (toId === fromId) return fromId;

  const byZ = [...draft.layers].sort((a, b) => a.z - b.z);
  const start = byZ.findIndex((l) => l.id === fromId);
  const end = byZ.findIndex((l) => l.id === toId);
  if (start < 0 || end < 0) return fromId;

  const step = end > start ? 1 : -1;
  let landed = fromId;
  for (let i = start + step; i !== end + step; i += step) {
    const layer = byZ[i]!;
    if (layer.hidden || layer.locked) break;
    landed = layer.id;
  }
  return landed;
}

/**
 * Move a node within its siblings' draw order.
 *
 * Draw order is `layer.z` then node `z` among top-level nodes, and plain `z`
 * among a parent's children — `rootNodesInDrawOrder` in the renderer is the
 * authority and this sorts the same way, or "send to back" moves a node
 * somewhere other than the back of the page the author is looking at.
 *
 * That layer term is why a top-level node may also **change layer** here.
 * Layer z leads the sort, so no amount of renumbering `z` can put a rectangle
 * (created in Annotations) under a graph (in Graphs): a shape sent to the back
 * reached the bottom of its own layer and stopped, still covering the figure.
 * It now adopts the layer of whatever it comes to rest against, which is what
 * the button says it does and what every other editor does at a layer
 * boundary. A figure whose top-level nodes all share one layer is unaffected.
 *
 * `nextZ` only ever appends, so before this existed the only way to change what
 * covered what was to delete a node and add it again. Every sibling is
 * renumbered `0..n-1` on each call, which keeps the values readable and means
 * repeated "forward" steps cannot drift apart. Renumbering across layers is
 * safe because each layer's nodes are contiguous under the `(layer, z)` sort,
 * so no other node's position relative to its own layer-mates changes.
 */
export function reorderNode(
  draft: FigureDocument,
  id: NodeId,
  where: 'front' | 'back' | 'forward' | 'backward',
): void {
  const node = draft.nodes[id];
  if (!node) return;

  const topLevel = node.parentId === null;
  const siblings = Object.values(draft.nodes)
    .filter((n) => n.parentId === node.parentId)
    .sort((a, b) => compareDrawOrder(draft, a, b));
  if (siblings.length < 2) return;

  const from = siblings.findIndex((n) => n.id === id);
  const to =
    where === 'front'
      ? siblings.length - 1
      : where === 'back'
        ? 0
        : Math.min(siblings.length - 1, Math.max(0, from + (where === 'forward' ? 1 : -1)));
  if (to === from) return;

  const ordered = [...siblings];
  ordered.splice(to, 0, ...ordered.splice(from, 1));

  if (topLevel) {
    // Moving up, the node comes to rest immediately above `to - 1`; moving
    // down, immediately below `to + 1`. Both exist: the node moved, and there
    // are at least two siblings.
    const neighbour = to > from ? ordered[to - 1]! : ordered[to + 1]!;
    draft.nodes[id]!.layerId = destinationLayer(draft, node.layerId, neighbour.layerId);
  }

  ordered.forEach((sibling, index) => {
    draft.nodes[sibling.id]!.z = index;
  });
}

/** Move a node to a new parent, preserving its position on the page. */
export function reparentNode(
  draft: FigureDocument,
  id: NodeId,
  newParentId: NodeId | null,
): void {
  const node = draft.nodes[id];
  if (!node) return;

  const absoluteOffset = (target: FigureNode | undefined): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    let cursor = target;
    const seen = new Set<NodeId>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      x += cursor.frame.x;
      y += cursor.frame.y;
      cursor = cursor.parentId ? draft.nodes[cursor.parentId] : undefined;
    }
    return { x, y };
  };

  const oldParent = node.parentId ? draft.nodes[node.parentId] : undefined;
  const newParent = newParentId ? draft.nodes[newParentId] : undefined;

  const oldOrigin = absoluteOffset(oldParent);
  const newOrigin = absoluteOffset(newParent);

  node.frame = {
    ...node.frame,
    x: node.frame.x + oldOrigin.x - newOrigin.x,
    y: node.frame.y + oldOrigin.y - newOrigin.y,
  };
  node.parentId = newParentId;
  node.z = nextZ(draft.nodes, newParentId);
}
