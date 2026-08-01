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
import type { LayoutTemplate } from './templates.js';
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
  const panels = readingOrder(draft.nodes) as PanelNode[];
  if (panels.length === 0) return;

  // A template that does not fit the panel count would silently drop panels
  // (autoLayout skips any panel with no cell), so fall back to the even grid.
  const template =
    options.template && options.template.panelCount === panels.length ? options.template : null;

  const grid = template?.grid ?? options.grid ?? suggestGrid(panels.length);

  const frames = autoLayout(
    panels.map((p, index) => ({
      id: p.id,
      aspectLock: p.aspectLock,
      slot: template ? (template.slots[index] ?? null) : (p.slot ?? null),
    })),
    grid,
    {
      ...options,
      pageWidthMm: draft.page.widthMm,
      pageHeightMm: draft.page.heightMm,
    },
  );

  for (const [index, panel] of panels.entries()) {
    const frame = frames.get(panel.id);
    if (!frame) continue;

    if (template) panel.slot = template.slots[index] ?? null;

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
  panel.frame = frame;

  for (const child of Object.values(draft.nodes)) {
    if (child.parentId === panel.id && (child.type === 'plot' || child.type === 'image')) {
      child.frame = { x: 0, y: 0, width: frame.width, height: frame.height };
    }
  }

  for (const node of Object.values(draft.nodes)) {
    if (node.type === 'panel-label' && node.panelId === panel.id) {
      node.frame = { ...node.frame, x: node.frame.x + dx, y: node.frame.y + dy };
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
 * Page-space frame for a bracket spanning two categories of a plot.
 *
 * Shared by creation and repositioning. Keeping one implementation is the
 * point: two copies of this arithmetic would drift, and the symptom would be
 * brackets that sit correctly when first placed and wrongly ever after.
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

  const dataset = draft.datasets.find((d) => d.id === options.datasetId);
  if (!dataset) return null;

  const seriesNames = toSeries(dataset).map((s) => s.name);
  const indexA = seriesNames.indexOf(options.groupA);
  const indexB = seriesNames.indexOf(options.groupB);
  if (indexA < 0 || indexB < 0) return null;

  const leftName = seriesNames[Math.min(indexA, indexB)]!;
  const rightName = seriesNames[Math.max(indexA, indexB)]!;

  let xA: number;
  let xB: number;
  let contentTop = 0;

  if (options.measurements) {
    const measurements = options.measurements;
    xA = measurements.categoryX.get(leftName) ?? 0;
    xB = measurements.categoryX.get(rightName) ?? plot.frame.width;
    // Clear the tallest feature anywhere under the bracket's span.
    const spanned = seriesNames.slice(Math.min(indexA, indexB), Math.max(indexA, indexB) + 1);
    contentTop = Math.min(
      ...spanned.map((name) => measurements.categoryTop.get(name) ?? Infinity),
    );
    if (!Number.isFinite(contentTop)) contentTop = 0;
  } else {
    // Fallback: even spacing across the plot. Approximate, but the bracket is
    // a normal draggable object, so the user can correct it.
    const slot = plot.frame.width / Math.max(1, seriesNames.length);
    xA = slot * (Math.min(indexA, indexB) + 0.5);
    xB = slot * (Math.max(indexA, indexB) + 0.5);
  }

  const gap = options.gapMm ?? 4;

  return {
    x: panel.frame.x + xA,
    // The tick ends are the bottom of the frame, so position the frame so
    // they stop `gap` above the tallest datum rather than overlapping it.
    y: panel.frame.y + Math.max(0, contentTop - gap - BRACKET_HEIGHT_MM),
    width: Math.max(1, xB - xA),
    height: BRACKET_HEIGHT_MM,
  };
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
): void {
  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'bracket') continue;
    const plotId = node.plotId ?? null;
    if (plotId === null) continue;

    const analysis = node.analysisId
      ? draft.analyses.find((a) => a.id === node.analysisId)
      : undefined;
    const comparison = analysis?.result?.comparisons[node.comparisonIndex ?? 0];
    if (!analysis || !comparison) continue;

    const measured = measurements.get(plotId);
    if (!measured) continue;

    const frame = bracketFrame(draft, {
      plotId,
      datasetId: analysis.spec.datasetId,
      groupA: comparison.groupA,
      groupB: comparison.groupB,
      ...(node.gapMm !== undefined ? { gapMm: node.gapMm } : {}),
      measurements: measured,
    });
    if (!frame) continue;

    const offset = node.userOffsetMm;
    node.frame = offset
      ? { ...frame, x: frame.x + offset.x, y: frame.y + offset.y }
      : frame;
  }
}

/**
 * Record a bracket's manual displacement from where the geometry would put it.
 *
 * Called after a drag, so the next reposition can re-apply the same offset.
 */
export function recordBracketOffset(
  draft: FigureDocument,
  bracketId: NodeId,
  measurements: PlotMeasurementMap,
): void {
  const node = draft.nodes[bracketId];
  if (!node || node.type !== 'bracket') return;

  const plotId = node.plotId ?? null;
  if (plotId === null) return;

  const analysis = node.analysisId
    ? draft.analyses.find((a) => a.id === node.analysisId)
    : undefined;
  const comparison = analysis?.result?.comparisons[node.comparisonIndex ?? 0];
  if (!analysis || !comparison) return;

  const measured = measurements.get(plotId);
  if (!measured) return;

  const base = bracketFrame(draft, {
    plotId,
    datasetId: analysis.spec.datasetId,
    groupA: comparison.groupA,
    groupB: comparison.groupB,
    ...(node.gapMm !== undefined ? { gapMm: node.gapMm } : {}),
    measurements: measured,
  });
  if (!base) return;

  node.userOffsetMm = { x: node.frame.x - base.x, y: node.frame.y - base.y };
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
