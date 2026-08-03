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
import { toSeries } from './data.js';
import type { Asset, FigureDocument } from './document.js';
import { layerByName, nextZ } from './document.js';
import type { PointMm, RectMm } from './geometry.js';
import { union } from './geometry.js';
import {
  autoLayout,
  gridCells,
  readingOrder,
  suggestGrid,
  type GridSpec,
  type LayoutOptions,
} from './layout.js';
import type { LayoutTemplate } from './templates.js';
import { CONTINUOUS_X_PLOT_TYPES } from './nodes.js';
import type {
  ArrowNode,
  AssetId,
  AxisSpec,
  BracketNode,
  CalibrationSource,
  DatasetId,
  Fill,
  FigureNode,
  GroupNode,
  ImageNode,
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
    default:
      return 'bar-dot';
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
    panels.map((p, index) => ({
      id: p.id,
      aspectLock: p.aspectLock,
      slot: template ? (template.slots[index] ?? null) : null,
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

    // Cleared with the arrangement it belonged to, so the next plain layout
    // cannot resurrect it against a differently shaped grid.
    panel.slot = template ? (template.slots[index] ?? null) : null;

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

  // An image that changed size changes what a millimetre on it means.
  resyncScaleBars(draft);
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
 * and must not move.
 */
function fillPanelChildren(draft: FigureDocument, panelId: NodeId, frame: RectMm): void {
  const panel = draft.nodes[panelId];
  const grid = panel?.type === 'panel' ? panel.contentGrid : undefined;

  const children = Object.values(draft.nodes)
    .filter((c) => c.parentId === panelId && (c.type === 'plot' || c.type === 'image'))
    // Cells in z order — what the Layers list shows, and what `reorderNode`
    // already lets an author rearrange. `Object.values` order is not a
    // guarantee, and a montage that reshuffled itself on every layout would be
    // unusable.
    .sort((a, b) => a.z - b.z);

  if (!grid || grid.rows < 1 || grid.cols < 1 || children.length <= 1) {
    for (const child of children) {
      child.frame = { x: 0, y: 0, width: frame.width, height: frame.height };
    }
    return;
  }

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
    },
  );

  children.forEach((child, index) => {
    const cell = cells[index];
    // More children than cells: the extras keep their size rather than being
    // stacked at the origin, where they would be invisible under a tile.
    if (cell) child.frame = { ...cell };
  });
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

  fillPanelChildren(draft, panel.id, frame);

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
 * `aspectLock` is deliberately null: it is derived from a single image's ratio,
 * and a montage of differently shaped micrographs has no one honest ratio. The
 * tiles letterbox inside their own cells instead, which is where the
 * `preserveAspect` rule already puts them.
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
    panel.contentGrid = { rows: grid.rows, cols: grid.columns, gutterMm: options.gutterMm ?? 1 };
  }

  const images = options.images.map((image) =>
    addImage(draft, newId, {
      ...image,
      parentId: panel.id,
      // Provisional: `fillPanelChildren` assigns the real cells immediately
      // after, and every caller runs a layout before anything is drawn.
      frame: { x: 0, y: 0, width: panel.frame.width, height: panel.frame.height },
    }),
  );

  fillPanelChildren(draft, panel.id, panel.frame);
  return { panel, images };
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
  if (visiblePx <= 0 || parent.frame.width <= 0) return null;

  const mmPerPixel = parent.frame.width / visiblePx;
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
export function resyncScaleBars(draft: FigureDocument): void {
  for (const node of Object.values(draft.nodes)) {
    if (node.type !== 'scale-bar') continue;
    const width = scaleBarWidthMm(draft.nodes, node.id);
    if (width !== null && width > 0) node.frame = { ...node.frame, width };
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

  const inset = options.insetMm ?? 2;
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

  const width = scaleBarWidthMm(draft.nodes, id);
  if (width !== null && width > 0) {
    // Bottom-right, the conventional corner, once the true width is known.
    node.frame = { ...node.frame, x: Math.max(0, image.frame.width - inset - width), width };
  }

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
  // Up and to the right: an arrow's default job is to point at a feature.
  const fallback: PointMm[] = [
    { x: 0, y: frame.height },
    { x: frame.width, y: 0 },
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
    }
  }

  for (const doomedId of doomed) delete draft.nodes[doomedId];
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
const DERIVED_NODE_TYPES = new Set(['bracket', 'panel-label', 'scale-bar']);

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
        (node.type === 'bracket' && node.plotId != null && members.has(node.plotId));
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

    draft.nodes[copy.id] = copy;
  }

  return remap.get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Draw order
// ---------------------------------------------------------------------------

/**
 * Move a node within its siblings' draw order.
 *
 * Draw order is `layer.z` then node `z` among siblings sharing a `parentId`.
 * `nextZ` only ever appends, so until now the only way to change what covered
 * what was to delete a node and add it again. Every sibling is renumbered
 * `0..n-1` on each call, which keeps the values readable and means repeated
 * "forward" steps cannot drift apart.
 */
export function reorderNode(
  draft: FigureDocument,
  id: NodeId,
  where: 'front' | 'back' | 'forward' | 'backward',
): void {
  const node = draft.nodes[id];
  if (!node) return;

  const siblings = Object.values(draft.nodes)
    .filter((n) => n.parentId === node.parentId)
    .sort((a, b) => a.z - b.z);
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
