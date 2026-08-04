/**
 * Scene nodes.
 *
 * Nodes live in a FLAT map keyed by id, each carrying a `parentId`, rather than
 * in a nested tree. Immutable updates then touch exactly one entry, and
 * reparenting or z-reordering never has to restructure anything.
 *
 * Every frame is in millimetres and relative to the parent's frame (or to the
 * page, for top-level nodes).
 */

import type { PointMm, RectMm } from './geometry.js';

export type NodeId = string;
export type LayerId = string;
export type DatasetId = string;
export type AnalysisId = string;
export type AssetId = string;

export interface NodeBase {
  id: NodeId;
  name: string;
  parentId: NodeId | null;
  layerId: LayerId;
  /** Relative to the parent node's frame, or to the page when parentId is null. */
  frame: RectMm;
  /** Degrees clockwise about the frame centre. */
  rotation: number;
  opacity: number;
  locked: boolean;
  hidden: boolean;
  /** Sort order among siblings; low draws first. */
  z: number;
}

// ---------------------------------------------------------------------------
// Presentation primitives
// ---------------------------------------------------------------------------

export interface Stroke {
  color: string;
  /** Millimetres. Journals specify hairlines in pt, so convert on the way in. */
  widthMm: number;
  dash?: readonly number[];
  cap?: 'butt' | 'round' | 'square';
}

export interface Fill {
  color: string;
  opacity?: number;
}

export interface TextStyle {
  fontFamily?: string;
  /** Points — journal-native. Converted to mm at render time. */
  fontSizePt?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  color?: string;
  /** Multiple of font size. */
  lineHeight?: number;
  align?: 'start' | 'middle' | 'end';
  baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
  letterSpacingPt?: number;
}

// ---------------------------------------------------------------------------
// Node variants
// ---------------------------------------------------------------------------

/** A figure panel: the container that holds a plot or an image. */
export interface PanelNode extends NodeBase {
  type: 'panel';
  /** Panel letter ('a', 'b', …). Null suppresses the label. */
  label: string | null;
  /** Aspect ratio (w/h) the auto-layout engine must preserve, if any. */
  aspectLock: number | null;
  background: Fill | null;
  border: Stroke | null;
  /** Space between the panel frame and its plot area. */
  paddingMm: number;
  /**
   * Placement within a layout template's grid, when one is applied. Persisted
   * so re-running the layout keeps the arrangement instead of falling back to
   * an equal grid. Optional: it post-dates SCHEMA_VERSION 1.
   */
  slot?: { row: number; col: number; rowSpan?: number; colSpan?: number } | null;
  /**
   * Tile this panel's content children into a grid instead of stacking them.
   *
   * Absent means the single-child rule every panel has always had: each plot or
   * image fills the whole frame. That was not a rule so much as an assumption —
   * two images in one panel came out perfectly coincident, with only the
   * highest z visible — and it is what a montage needs replaced.
   *
   * Children take cells in `z` order, which is the order the Layers list shows
   * and the order `reorderNode` already lets an author change.
   */
  contentGrid?: { rows: number; cols: number; gutterMm: number };
}

export type PlotType =
  | 'bar'
  | 'dot'
  | 'bar-dot'
  | 'scatter'
  | 'line'
  | 'box'
  | 'violin'
  | 'beeswarm'
  | 'histogram'
  | 'volcano'
  | 'heatmap'
  | 'survival';

/**
 * The plot types whose x axis is a numeric scale rather than a band of
 * categories. Kept here beside the union so the renderer, the model defaults and
 * the UI cannot drift on which is which.
 *
 * `survival` belongs here on the same grounds as `volcano`: time is a real
 * numeric axis with ticks to draw, even though — like volcano's differential
 * data — its geometry is built through a dedicated path
 * (`toSurvivalGroups`/`kaplanMeier`) rather than the generic `toSeries`+
 * `xyMarks` route `continuousGeometry` uses for scatter/line/histogram.
 * Membership here is what gives it numeric x ticks by default (`addPlot`) and
 * what blocks ordinary group-comparison tests in the Stats tab in favour of
 * the log-rank allow-list, for free, through the same mechanism volcano
 * already relies on.
 */
export const CONTINUOUS_X_PLOT_TYPES: ReadonlySet<PlotType> = new Set<PlotType>([
  'scatter',
  'line',
  'histogram',
  'volcano',
  'survival',
]);

/**
 * The plot types drawn as a dense row×column grid rather than marks against
 * an axis — neither dimension is a value axis, so these are excluded from
 * `CONTINUOUS_X_PLOT_TYPES` and from the categorical band-scale path both.
 * Kept as its own registry for the same reason `CONTINUOUS_X_PLOT_TYPES` is:
 * one place that says which types are which.
 */
export const GRID_PLOT_TYPES: ReadonlySet<PlotType> = new Set<PlotType>(['heatmap']);

/** Which side of a significance threshold a volcano point falls on. */
export type VolcanoCategory = 'up' | 'down' | 'ns';

export interface VolcanoThresholds {
  /** |log2 fold change| at or above which a point counts as up/down. */
  foldChange: number;
  /** p-value at or below which a point counts as significant. */
  pValue: number;
}

/**
 * Declared here, beside the type, rather than in `packages/plots`: `doc-model`
 * imports nothing internal, so `operations.ts`'s `addPlot` — which sets this as
 * a new volcano plot's starting point — cannot reach across to `plots` for it.
 * `packages/plots/src/volcano.ts` imports this one rather than declaring a
 * second copy.
 */
export const DEFAULT_VOLCANO_THRESHOLDS: VolcanoThresholds = { foldChange: 1, pValue: 0.05 };

/**
 * Whether a heatmap's colour domain is the raw `[min, max]` of its cells, or
 * symmetric around zero (`[-max(|min|,|max|), max(|min|,|max|)]`) — the
 * standard reading for a correlation matrix or a log-fold-change matrix,
 * where zero is a meaningful midpoint rather than an arbitrary one.
 *
 * `'sequential'` is the default: it is the safer reading when the author
 * hasn't said whether zero means anything, the same reasoning that leaves
 * every other optional on/off field in this file defaulting to the more
 * literal behaviour.
 */
export type HeatmapScaleMode = 'sequential' | 'diverging';

export type ErrorBarKind = 'none' | 'sd' | 'sem' | 'ci95' | 'range' | 'iqr';

/** Marker shapes. Enough to tell four series apart in greyscale. */
export type PointShape = 'circle' | 'square' | 'triangle' | 'diamond';

export const POINT_SHAPES: readonly PointShape[] = ['circle', 'square', 'triangle', 'diamond'];

export type CenterKind = 'mean' | 'median';

export interface AxisSpec {
  title: string;
  /** Null on either bound means "derive from data". */
  min: number | null;
  max: number | null;
  /** Null means "choose a readable tick step". */
  tickStep: number | null;
  scale: 'linear' | 'log10';
  showLine: boolean;
  showTicks: boolean;
  showLabels: boolean;
  /** Draw the axis line only across the data range, Tufte-style. */
  trimToData: boolean;
  /**
   * Unlabelled subdivisions between major ticks, or 0/undefined for none.
   * The count is *divisions*, so 5 draws four minor ticks per interval.
   */
  minorTicks?: number;
  /** Ticks point away from the plot by default, as most journals draw them. */
  tickDirection?: 'out' | 'in';
  /**
   * Ranges cut out of the axis, drawn with the conventional break marks.
   *
   * Linear scales only: a broken log axis compounds two different kinds of
   * compression in one line, and there is no honest way to read it. Values
   * falling inside a break are *dropped*, never clamped to its edge — a mark
   * pinned to the break would be read as data at that value.
   */
  breaks?: readonly { from: number; to: number }[];
}

export interface PlotNode extends NodeBase {
  type: 'plot';
  plotType: PlotType;
  datasetId: DatasetId;
  /** Column names from the dataset; meaning depends on plotType. */
  encoding: {
    x?: string;
    y?: string;
    group?: string;
    /** Replicate columns collapsed into a single series. */
    valueColumns?: readonly string[];
  };
  x: AxisSpec;
  y: AxisSpec;
  center: CenterKind;
  errorBars: ErrorBarKind;
  /** Overlay individual replicate points on summary plots. */
  showPoints: boolean;
  pointSizeMm: number;
  jitterMm: number;
  barWidthFraction: number;
  /** Palette id from the theme, or explicit per-series colours. */
  palette: string | readonly string[];
  /**
   * Draw replicate points in their series colour rather than the theme's
   * foreground.
   *
   * Bars default to dark points over a coloured bar, which is conventional and
   * legible — but it means recolouring a series visibly changes the bar and not
   * the dots. Opt-in rather than default, so existing figures do not change.
   */
  pointsUseSeriesColor?: boolean;
  /**
   * Histogram bin count. Unset means Freedman–Diaconis chooses, which is the
   * right default at the sample sizes this tool sees — but bin count changes
   * the shape a reader takes away, so it has to be overridable.
   */
  histogramBins?: number;
  /**
   * Whether an error bar is drawn on both sides of the centre.
   *
   * `'up'` reproduces the bar-chart convention of hiding the lower half under
   * the bar. It reads cleanly and states half of what was measured, so `'both'`
   * is the default and `'up'` is the deliberate choice.
   */
  errorBarDirection?: 'both' | 'up';
  /** Replicate marker shape. Circles unless asked otherwise. */
  pointShape?: PointShape;
  /**
   * Marker shape per series, overriding `pointShape` for the ones it names.
   *
   * Indexed by series *order*, the same key `seriesAxis` and the palette array
   * use — so it needs no names and cannot go stale when a series is renamed. A
   * missing or empty entry falls back to `pointShape`, which keeps a plot that
   * sets only the plot-wide shape rendering exactly as it did.
   *
   * Distinct symbols are what carries the series identity when colour cannot:
   * in greyscale print, and for a reader with a colour-vision deficiency. That
   * makes this redundant encoding rather than decoration, which is why the
   * legend draws the shape rather than a plain swatch once it is set.
   */
  pointShapes?: readonly (PointShape | null)[];
  /** Marker interior. Unset keeps the series/foreground rule in the renderer. */
  pointFill?: string;
  /** Marker outline. Unset draws no outline, as before. */
  pointStroke?: Stroke;
  /**
   * A second y axis on the right, and which series read it.
   *
   * `seriesAxis` is indexed the same way as the palette — by series order — so
   * it needs no names and cannot go stale when a series is renamed. Absent or
   * `'y'` means the left axis, which is what every existing figure has.
   */
  y2?: AxisSpec;
  seriesAxis?: readonly ('y' | 'y2')[];
  /**
   * Where the series key is drawn, or `'none'`.
   *
   * Absent means `'auto'`: shown when there is a second factor to name and
   * withheld otherwise. A single-series plot needs no legend — the axis title
   * already says what is plotted — and a key repeating what the category labels
   * spell out underneath is furniture, not information.
   */
  legend?: 'auto' | 'right' | 'bottom' | 'none';
  /**
   * Draw the error interval as a filled band rather than as bars.
   *
   * Line plots only, and only where a series carries several y values at one x
   * to compute an interval from. On anything else there is no band to draw and
   * the setting is ignored rather than approximated.
   */
  errorDisplay?: 'bars' | 'band';
  /**
   * Draw every replicate behind the summarised means.
   *
   * Only where replicates were collapsed in the first place — a plot showing one
   * point per observation is already showing them. Prism's own advice for this
   * table shape is to plot each replicate as a first step, because a mean with
   * an interval hides how many measurements it rests on and whether they agree.
   */
  showReplicates?: boolean;
  /**
   * Gap between the bars within one group, as a fraction of the sub-band pitch.
   *
   * Two-factor plots only — a single-factor one has nothing inside a category to
   * space. Absent is `DEFAULT_BAR_GAP_FRACTION`, the literal this replaced, so
   * every existing figure draws exactly as it did.
   */
  barGapFraction?: number;
  /**
   * Gap between one category slot and the next. On a single-factor plot that is
   * the gap between the bars themselves, since there each bar owns a category.
   *
   * Absent is `DEFAULT_GROUP_GAP_FRACTION`. Note this changes the slot a
   * category label has to fit in, so widening it can stand a rotated label back
   * upright — correct, and safe because the geometry is built in exactly two
   * passes rather than converged to.
   */
  groupGapFraction?: number;
  /**
   * Fold-change and p-value cutoffs a volcano plot classifies points against.
   *
   * Absent is `DEFAULT_VOLCANO_THRESHOLDS` (see `packages/plots`). Volcano
   * only — every other plot type ignores it.
   */
  volcanoThresholds?: VolcanoThresholds;
  /** Colour per significance category. Absent falls back to the renderer's default. */
  volcanoColors?: Record<VolcanoCategory, string>;
  /**
   * Whether the fold-change/p-value cutoff lines are drawn.
   *
   * Absent is `'show'` — a string enum rather than a boolean, matching every
   * other optional on/off field on this node (`errorDisplay`, `legend`), since
   * no optional boolean here defaults to `true` when absent.
   */
  volcanoThresholdLines?: 'show' | 'hide';
  /** How a heatmap's colour domain is built. Absent is `'sequential'`. Heatmap only. */
  heatmapScale?: HeatmapScaleMode;
  /**
   * Colour stops the domain interpolates between: two for `'sequential'`
   * (low, high), three for `'diverging'` (low, mid, high). Absent uses the
   * renderer's themed default for the chosen mode.
   */
  heatmapStops?: readonly string[];
  /** Fill for a cell whose value is missing. Absent is a themed neutral grey. */
  heatmapMissingColor?: string;
  /**
   * Draw each cell's value centred in it. Skipped where the cell is too
   * small to hold the text legibly rather than overprinting it.
   */
  showCellValues?: boolean;
  /**
   * Draw a tick at each censored subject's point on the curve. Absent is
   * `true` — the opposite default from `showCellValues`/`showReplicates`,
   * since a censoring mark is what makes a Kaplan–Meier curve honest about
   * follow-up loss rather than a source of clutter to opt into. Survival only.
   */
  showCensorMarks?: boolean;
  /**
   * Draw a shaded confidence band around each survival curve. Absent is
   * `false` — with three or more arms, overlapping bands read as clutter
   * before they read as data, the same opt-in stance `showReplicates` takes.
   * Survival only.
   */
  showSurvivalCI?: boolean;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  assetId: AssetId;
  /** Intrinsic pixel size, used for the export resolution check. */
  naturalPx: { width: number; height: number };
  /** Crop in normalised source coordinates (0–1). */
  crop: { x: number; y: number; width: number; height: number };
  preserveAspect: boolean;
}

export interface TextNode extends NodeBase {
  type: 'text';
  text: string;
  style: TextStyle;
}

/** Panel letter. Kept distinct from TextNode so the checker can audit it. */
export interface PanelLabelNode extends NodeBase {
  type: 'panel-label';
  text: string;
  style: TextStyle;
  /** Which panel this labels; drives auto-relettering. */
  panelId: NodeId;
}

export interface ShapeNode extends NodeBase {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'line';
  fill: Fill | null;
  stroke: Stroke | null;
  cornerRadiusMm?: number;
}

export interface ArrowNode extends NodeBase {
  type: 'arrow';
  /** Relative to this node's frame origin. */
  points: readonly PointMm[];
  stroke: Stroke;
  head: 'none' | 'triangle' | 'open';
  headSizeMm: number;
  tail: 'none' | 'triangle' | 'open';
}

/** Significance bracket linking two x positions above a plot. */
export interface BracketNode extends NodeBase {
  type: 'bracket';
  /** Set when generated from a statistical test; drives staleness checks. */
  analysisId: AnalysisId | null;
  /**
   * The plot this annotates. Held directly rather than joined through the
   * analysis, because re-running a test replaces the analysis record while the
   * bracket must still be findable by the plot it belongs to.
   *
   * Optional: documents written before this field existed simply lack it, which
   * keeps them loadable without a schema migration.
   */
  plotId?: NodeId | null;
  /**
   * How far the user dragged this bracket from its computed position.
   *
   * Stored as an offset rather than a "pinned" flag so a hand-adjusted bracket
   * still follows its bars when the plot is resized — pinning in absolute page
   * space would strand it exactly as an unrepositioned bracket is stranded.
   */
  userOffsetMm?: { x: number; y: number };
  /** Which comparison of the analysis this annotates, for repositioning. */
  comparisonIndex?: number;
  /** Clearance above the tallest datum this bracket was placed with. */
  gapMm?: number;
  /** Displayed annotation: 'ns', '*', '**', … or an explicit p-value string. */
  label: string;
  style: TextStyle;
  stroke: Stroke;
  /** Height of the downward ticks at each end. */
  tickMm: number;
}

/**
 * Where a scale bar's calibration came from.
 *
 * Provenance, not decoration: a bar drawn from a number the user guessed is a
 * false measurement in a published figure, and the quality checker has to be
 * able to tell that apart from one read out of the micrograph's own metadata.
 * `pixelsPerUnit` alone cannot say which it is.
 */
export type CalibrationSource = 'metadata' | 'manual' | 'measured' | 'unknown';

export interface ScaleBarNode extends NodeBase {
  type: 'scale-bar';
  /** Bar length in real-world units, e.g. 10 (µm). */
  length: number;
  unitLabel: string;
  /** Image pixels per real-world unit; ties the bar to the micrograph. */
  pixelsPerUnit: number;
  /**
   * Deprecated in the drawing path: `labelPosition: 'none'` is the single
   * authority on whether a label is drawn. Two fields meaning the same thing is
   * how a control ends up doing nothing because the *other* field is still off.
   * Kept because it is required in the schema, and removing it would be a
   * breaking change to save one boolean. `addScaleBar` keeps the two in step.
   */
  showLabel: boolean;
  style: TextStyle;
  fill: Fill;
  barHeightMm: number;
  labelPosition: 'above' | 'below' | 'none';
  /** Optional: post-dates SCHEMA_VERSION 1. Absent reads as 'unknown'. */
  calibrationSource?: CalibrationSource;
}

export interface GroupNode extends NodeBase {
  type: 'group';
}

export type FigureNode =
  | PanelNode
  | PlotNode
  | ImageNode
  | TextNode
  | PanelLabelNode
  | ShapeNode
  | ArrowNode
  | BracketNode
  | ScaleBarNode
  | GroupNode;

export type FigureNodeType = FigureNode['type'];

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

export type NodeMap = Record<NodeId, FigureNode>;

/** Direct children of `parentId`, in draw order. */
export function childrenOf(nodes: NodeMap, parentId: NodeId | null): FigureNode[] {
  return Object.values(nodes)
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.z - b.z);
}

/** Depth-first walk in draw order, starting from the roots. */
export function walk(
  nodes: NodeMap,
  visit: (node: FigureNode, depth: number) => void,
  parentId: NodeId | null = null,
  depth = 0,
): void {
  for (const child of childrenOf(nodes, parentId)) {
    visit(child, depth);
    walk(nodes, visit, child.id, depth + 1);
  }
}

export function ancestorsOf(nodes: NodeMap, id: NodeId): FigureNode[] {
  const chain: FigureNode[] = [];
  let current = nodes[id]?.parentId ?? null;
  // Guard against a cycle introduced by a malformed document.
  const seen = new Set<NodeId>([id]);
  while (current !== null && !seen.has(current)) {
    const node = nodes[current];
    if (!node) break;
    chain.push(node);
    seen.add(current);
    current = node.parentId;
  }
  return chain;
}

export function descendantsOf(nodes: NodeMap, id: NodeId): FigureNode[] {
  const out: FigureNode[] = [];
  walk(nodes, (n) => out.push(n), id);
  return out;
}

/** Absolute page-space frame, accumulating every ancestor's origin. */
export function absoluteFrame(nodes: NodeMap, id: NodeId): RectMm | null {
  const node = nodes[id];
  if (!node) return null;
  let { x, y } = node.frame;
  for (const ancestor of ancestorsOf(nodes, id)) {
    x += ancestor.frame.x;
    y += ancestor.frame.y;
  }
  return { x, y, width: node.frame.width, height: node.frame.height };
}

/** A node is effectively hidden if it or any ancestor is hidden. */
export function isEffectivelyHidden(nodes: NodeMap, id: NodeId): boolean {
  const node = nodes[id];
  if (!node) return true;
  return node.hidden || ancestorsOf(nodes, id).some((n) => n.hidden);
}

export function isEffectivelyLocked(nodes: NodeMap, id: NodeId): boolean {
  const node = nodes[id];
  if (!node) return true;
  return node.locked || ancestorsOf(nodes, id).some((n) => n.locked);
}
