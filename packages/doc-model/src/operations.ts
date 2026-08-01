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

import type { Analysis } from './analysis.js';
import { significanceStars } from './analysis.js';
import type { Dataset } from './data.js';
import { toSeries } from './data.js';
import type { FigureDocument } from './document.js';
import { layerByName, nextZ } from './document.js';
import type { RectMm } from './geometry.js';
import {
  autoLayout,
  readingOrder,
  suggestGrid,
  type GridSpec,
  type LayoutOptions,
} from './layout.js';
import type {
  AxisSpec,
  BracketNode,
  FigureNode,
  NodeId,
  PanelLabelNode,
  PanelNode,
  PlotNode,
  PlotType,
  TextNode,
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

export function addPlot(
  draft: FigureDocument,
  newId: () => string,
  options: AddPlotOptions,
): PlotNode {
  const panel = draft.nodes[options.panelId];
  if (!panel) throw new Error(`No such panel: ${options.panelId}`);

  const id = newId();
  const plot: PlotNode = {
    ...baseNode(
      id,
      'Plot',
      layerId(draft, 'Graphs'),
      // Fills its panel; the theme's plot margins carve out the axis gutters.
      { x: 0, y: 0, width: panel.frame.width, height: panel.frame.height },
      panel.id,
      nextZ(draft.nodes, panel.id),
    ),
    type: 'plot',
    plotType: options.plotType ?? 'bar-dot',
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

  // A categorical x axis needs no line of its own; the bars carry the reading.
  plot.x.showTicks = false;

  draft.nodes[id] = plot;
  return plot;
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
      return;
    }

    const id = newId();
    const node: PanelLabelNode = {
      ...baseNode(
        id,
        `Label ${letter}`,
        labelLayer,
        // Positioned in page space, just outside the panel's top-left corner.
        { x: panel.frame.x - offset, y: panel.frame.y, width: 5, height: 5 },
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

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Arrange every panel on a grid and move its labels to match. */
export function applyAutoLayout(
  draft: FigureDocument,
  options: Omit<LayoutOptions, 'pageWidthMm' | 'pageHeightMm'> & { grid?: GridSpec },
): void {
  const panels = readingOrder(draft.nodes) as PanelNode[];
  if (panels.length === 0) return;

  const grid = options.grid ?? suggestGrid(panels.length);

  const frames = autoLayout(
    panels.map((p) => ({ id: p.id, aspectLock: p.aspectLock })),
    grid,
    {
      ...options,
      pageWidthMm: draft.page.widthMm,
      pageHeightMm: draft.page.heightMm,
    },
  );

  for (const panel of panels) {
    const frame = frames.get(panel.id);
    if (!frame) continue;

    const dx = frame.x - panel.frame.x;
    const dy = frame.y - panel.frame.y;
    panel.frame = frame;

    // Plots fill their panel, so they follow the panel's new size.
    for (const child of Object.values(draft.nodes)) {
      if (child.parentId === panel.id && child.type === 'plot') {
        child.frame = { x: 0, y: 0, width: frame.width, height: frame.height };
      }
    }

    // Labels live in page space, so they must be translated by hand.
    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'panel-label' && node.panelId === panel.id) {
        node.frame = { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy };
      }
    }
  }
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
 */
export interface PlotMeasurements {
  categoryX: Map<string, number>;
  categoryTop: Map<string, number>;
}

/** Height of a bracket's tick descent; the span sits at the frame top. */
const BRACKET_HEIGHT_MM = 1.2;

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

  const panel = plot.parentId ? draft.nodes[plot.parentId] : null;
  if (!panel) return null;

  const result = options.analysis.result;
  const comparison = result?.comparisons[options.comparisonIndex ?? 0];
  if (!comparison) return null;

  const dataset = draft.datasets.find((d) => d.id === options.analysis.spec.datasetId);
  if (!dataset) return null;

  const seriesNames = toSeries(dataset).map((s) => s.name);
  const indexA = seriesNames.indexOf(comparison.groupA);
  const indexB = seriesNames.indexOf(comparison.groupB);
  if (indexA < 0 || indexB < 0) return null;

  const leftName = seriesNames[Math.min(indexA, indexB)]!;
  const rightName = seriesNames[Math.max(indexA, indexB)]!;

  let xA: number;
  let xB: number;
  let contentTop = 0;

  if (options.measurements) {
    xA = options.measurements.categoryX.get(leftName) ?? 0;
    xB = options.measurements.categoryX.get(rightName) ?? plot.frame.width;
    // Clear the tallest feature anywhere under the bracket's span.
    const spanned = seriesNames.slice(Math.min(indexA, indexB), Math.max(indexA, indexB) + 1);
    contentTop = Math.min(
      ...spanned.map((name) => options.measurements!.categoryTop.get(name) ?? Infinity),
    );
  } else {
    // Fallback: even spacing across the plot. Approximate, but the bracket is
    // a normal draggable object, so the user can correct it.
    const slot = plot.frame.width / Math.max(1, seriesNames.length);
    xA = slot * (Math.min(indexA, indexB) + 0.5);
    xB = slot * (Math.max(indexA, indexB) + 0.5);
  }

  const gap = options.gapMm ?? 4;
  const id = newId();

  const bracket: BracketNode = {
    ...baseNode(
      id,
      `${comparison.groupA} vs ${comparison.groupB}`,
      layerId(draft, 'Statistics'),
      {
        x: panel.frame.x + xA,
        // The tick ends are the bottom of the frame, so position the frame so
        // they stop `gap` above the tallest datum rather than overlapping it.
        y: panel.frame.y + Math.max(0, contentTop - gap - BRACKET_HEIGHT_MM),
        width: Math.max(1, xB - xA),
        height: BRACKET_HEIGHT_MM,
      },
      null,
      nextZ(draft.nodes, null),
    ),
    type: 'bracket',
    analysisId: options.analysis.id,
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

const formatBracketP = (p: number): string =>
  p < 0.001 ? 'P < 0.001' : `P = ${p < 0.01 ? p.toFixed(3) : p.toFixed(2)}`;

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

export function addDataset(draft: FigureDocument, dataset: Dataset): void {
  draft.datasets = [...draft.datasets, dataset];
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
    }
  }

  for (const doomedId of doomed) delete draft.nodes[doomedId];
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
