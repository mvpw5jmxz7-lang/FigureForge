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

export type ErrorBarKind = 'none' | 'sd' | 'sem' | 'ci95' | 'range' | 'iqr';

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
  /** Displayed annotation: 'ns', '*', '**', … or an explicit p-value string. */
  label: string;
  style: TextStyle;
  stroke: Stroke;
  /** Height of the downward ticks at each end. */
  tickMm: number;
}

export interface ScaleBarNode extends NodeBase {
  type: 'scale-bar';
  /** Bar length in real-world units, e.g. 10 (µm). */
  length: number;
  unitLabel: string;
  /** Image pixels per real-world unit; ties the bar to the micrograph. */
  pixelsPerUnit: number;
  showLabel: boolean;
  style: TextStyle;
  fill: Fill;
  barHeightMm: number;
  labelPosition: 'above' | 'below' | 'none';
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
