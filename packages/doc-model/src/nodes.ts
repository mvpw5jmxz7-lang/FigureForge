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
  | 'histogram';

/**
 * The plot types whose x axis is a numeric scale rather than a band of
 * categories. Kept here beside the union so the renderer, the model defaults and
 * the UI cannot drift on which is which.
 */
export const CONTINUOUS_X_PLOT_TYPES: ReadonlySet<PlotType> = new Set<PlotType>([
  'scatter',
  'line',
  'histogram',
]);

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
