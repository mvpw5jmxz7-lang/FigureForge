/**
 * FigureDocument → scene tree.
 *
 * A pure function. Given the same document and theme it produces the same tree,
 * every time, in any environment — that determinism is what lets the export
 * path reuse this code instead of reimplementing it.
 */

import {
  BRACKET_HEIGHT_MM,
  CONTINUOUS_X_PLOT_TYPES,
  DEFAULT_BRACKET_GAP_MM,
  DEFAULT_VOLCANO_THRESHOLDS,
  GRID_PLOT_TYPES,
  absoluteFrame,
  isLocked,
  childrenOf,
  findAsset,
  findDataset,
  findLayer,
  fitAspect,
  isTwoFactor,
  ptToMm,
  repositionBrackets,
  scaleBarWidthMm,
  toMatrix,
  toSeries,
  toSurvivalGroups,
  type ArrowNode,
  type AxisSpec,
  type BracketNode,
  type Dataset,
  type FigureDocument,
  type FigureNode,
  type GridlineStyle,
  type HeatmapScaleMode,
  type ImageNode,
  type LineStyle,
  type Matrix,
  type PanelLabelNode,
  type PanelNode,
  type PlotNode,
  type PointShape,
  type ScaleBarNode,
  type ShapeNode,
  type Stroke,
  type SurvivalGroup,
  type TextNode,
  type TextStyle,
  type VolcanoCategory,
} from '@figureforge/doc-model';
import { paletteColors, parseHex, toHex, type Theme } from '@figureforge/theme';
import {
  DEFAULT_BAR_GAP_FRACTION,
  DEFAULT_GROUP_GAP_FRACTION,
  categoricalMarks,
  formatTick,
  histogramBins,
  histogramMarks,
  kaplanMeier,
  makeBandScale,
  makeGroupedBandScale,
  makeScale,
  minorTickValues,
  negLog10,
  normalizeCellValue,
  resolveDomain,
  resolveHeatmapDomain,
  tickCountForLength,
  tickLabelRuns,
  volcanoCategory,
  xyMarks,
  type LinearScaleOptions,
  type MarkOrientation,
  type NumericScale,
  type PointGeometry,
  type SurvivalStep,
  type TickLabelRun,
  type XySeriesMarks,
} from '@figureforge/plots';
import { el, group, round, text, translate, type SceneAttrs, type SceneNode, type SceneRole } from './scene.js';
import {
  estimateRunsWidthMm,
  estimateTextHeightMm,
  estimateTextWidthMm,
  leadingSignWidthMm,
  superscriptRiseMm,
  superscriptSizePt,
  truncateToWidth,
} from './text-width.js';
import { layoutPointLabels, nearestRectPoint, type LabelCandidate, type Rect } from './point-labels.js';

/**
 * Above this many points, a continuous plot's marks are drawn as one raster
 * image instead of one SceneNode per point — see `planPointClouds`.
 *
 * Measured, not guessed. `Canvas.tsx` calls `renderDocument`+`toReact`
 * unmemoised on every render, and a resize/crop drag commits on every
 * `pointermove` — so the real cost of a large point cloud is not "does it
 * paint once" but "does every interaction frame rebuild all N points".
 * Forcing that same full-document re-render repeatedly (toggling an
 * unrelated chrome flag, so only reconciliation cost is measured) against a
 * running instance of this app, before this change existed, measured:
 *
 *   points   avg re-render
 *      500   55 ms
 *    2,000   104 ms
 *    5,000   160 ms
 *   20,000   707 ms
 *   50,000   895 ms
 *  100,000   1,726 ms
 *
 * 2,000 is the largest candidate that still lands under ~100 ms — the
 * threshold at which a UI response stops reading as immediate (Nielsen/RAIL
 * guidance) — while every candidate above it degrades into a genuinely
 * stalled drag well before a document this size ever reaches export.
 */
export const MAX_VECTOR_POINTS = 2000;

export interface RenderOptions {
  theme: Theme;
  /**
   * Resolve an asset to something an <image> can reference. The browser hands
   * back a blob URL; the exporter hands back a data URI, because an exported
   * SVG must not depend on anything outside itself.
   */
  resolveAsset?: (assetId: string) => string | undefined;
  /** Draw selection outlines and grid. Never enabled on the export path. */
  chrome?: {
    selectedIds?: readonly string[];
    showGrid?: boolean;
  };
  /**
   * Pre-baked raster for a plot whose point count exceeds
   * `MAX_VECTOR_POINTS`, keyed by plot node id. Same live/export duality as
   * `resolveAsset` — a blob URL on screen, a data URI at export — except
   * there is no backing `Asset`, so this travels directly rather than
   * through a resolver. Baking happens outside this package (`apps/web`,
   * via `OffscreenCanvas`) for the same reason `flattenCropsForExport`
   * bakes crops outside it: re-encoding pixels is neither synchronous nor
   * DOM-free. A plot over threshold with no entry here draws its pending
   * placeholder instead — see `renderContinuousMarks`.
   */
  pointRasters?: ReadonlyMap<string, string>;
}

export function renderDocument(doc: FigureDocument, options: RenderOptions): SceneNode {
  const { theme } = options;
  const { widthMm, heightMm } = doc.page;

  const children: SceneNode[] = [
    el('rect', {
      x: 0,
      y: 0,
      width: widthMm,
      height: heightMm,
      fill: doc.page.background,
    }, undefined, { role: 'page' }),
  ];

  if (options.chrome?.showGrid) children.push(renderGrid(doc));

  for (const node of rootNodesInDrawOrder(doc)) {
    const rendered = renderNode(node, doc, options);
    if (rendered) children.push(rendered);
  }

  if (options.chrome?.selectedIds?.length) {
    children.push(renderSelection(doc, options.chrome.selectedIds));
  }

  return el(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      // Physical size on the outside, millimetre user units on the inside.
      width: `${round(widthMm)}mm`,
      height: `${round(heightMm)}mm`,
      viewBox: `0 0 ${round(widthMm)} ${round(heightMm)}`,
      'font-family': theme.fontFamily,
      'shape-rendering': 'geometricPrecision',
    },
    children,
  );
}

/**
 * Top-level nodes ordered by layer first, then by their own z. Layers give the
 * Illustrator-style global stacking (all labels above all graphs); z orders
 * siblings within that.
 */
function rootNodesInDrawOrder(doc: FigureDocument): FigureNode[] {
  return childrenOf(doc.nodes, null).sort((a, b) => {
    const za = findLayer(doc, a.layerId)?.z ?? 0;
    const zb = findLayer(doc, b.layerId)?.z ?? 0;
    return za - zb || a.z - b.z;
  });
}

function renderNode(node: FigureNode, doc: FigureDocument, options: RenderOptions): SceneNode | null {
  if (node.hidden) return null;
  const layer = findLayer(doc, node.layerId);
  if (layer?.hidden) return null;

  const body = renderNodeBody(node, doc, options);
  if (!body) return null;

  const transforms = [translate(node.frame.x, node.frame.y)];
  if (node.rotation !== 0) {
    transforms.push(
      `rotate(${round(node.rotation)} ${round(node.frame.width / 2)} ${round(node.frame.height / 2)})`,
    );
  }

  return group(
    {
      transform: transforms.join(' '),
      opacity: node.opacity === 1 ? undefined : node.opacity,
    },
    [body],
    { nodeId: node.id },
  );
}

function renderChildren(node: FigureNode, doc: FigureDocument, options: RenderOptions): SceneNode[] {
  return childrenOf(doc.nodes, node.id)
    .map((child) => renderNode(child, doc, options))
    .filter((n): n is SceneNode => n !== null);
}

function renderNodeBody(
  node: FigureNode,
  doc: FigureDocument,
  options: RenderOptions,
): SceneNode | null {
  switch (node.type) {
    case 'panel':
      return renderPanel(node, doc, options);
    case 'plot':
      return renderPlot(node, doc, options);
    case 'image':
      return renderImage(node, doc, options);
    case 'text':
      return renderText(node, options.theme);
    case 'panel-label':
      return renderPanelLabel(node, options.theme);
    case 'shape':
      return renderShape(node);
    case 'arrow':
      return renderArrow(node);
    case 'bracket':
      return renderBracket(node, options.theme);
    case 'scale-bar':
      return renderScaleBar(node, doc, options.theme);
    case 'group':
      return group({}, renderChildren(node, doc, options));
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Styling helpers
// ---------------------------------------------------------------------------

function strokeAttrs(stroke: Stroke | null): Record<string, string | number | undefined> {
  if (!stroke) return { stroke: 'none' };
  return {
    stroke: stroke.color,
    'stroke-width': stroke.widthMm,
    'stroke-linecap': stroke.cap,
    'stroke-dasharray': stroke.dash?.map(round).join(' '),
  };
}

const BASELINES: Record<string, string> = {
  top: 'hanging',
  middle: 'central',
  bottom: 'alphabetic',
  alphabetic: 'alphabetic',
};

function textAttrs(style: TextStyle, theme: Theme): Record<string, string | number | undefined> {
  const sizePt = style.fontSizePt ?? theme.type.annotationPt;
  return {
    'font-family': style.fontFamily ?? theme.fontFamily,
    // Points on the way in, millimetres on the way out.
    'font-size': ptToMm(sizePt),
    'font-weight': style.fontWeight === 'bold' ? 'bold' : undefined,
    'font-style': style.fontStyle === 'italic' ? 'italic' : undefined,
    fill: style.color ?? theme.foreground,
    'text-anchor': style.align,
    'dominant-baseline': style.baseline ? BASELINES[style.baseline] : undefined,
    'letter-spacing': style.letterSpacingPt ? ptToMm(style.letterSpacingPt) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Node renderers
// ---------------------------------------------------------------------------

function renderPanel(node: PanelNode, doc: FigureDocument, options: RenderOptions): SceneNode {
  const children: SceneNode[] = [];

  if (node.background) {
    children.push(
      el('rect', {
        x: 0,
        y: 0,
        width: node.frame.width,
        height: node.frame.height,
        fill: node.background.color,
        'fill-opacity': node.background.opacity,
      }),
    );
  }
  if (node.border) {
    children.push(
      el('rect', {
        x: 0,
        y: 0,
        width: node.frame.width,
        height: node.frame.height,
        fill: 'none',
        ...strokeAttrs(node.border),
      }),
    );
  }

  children.push(...renderChildren(node, doc, options));
  return group({}, children, { role: 'panel' });
}

function renderText(node: TextNode, theme: Theme): SceneNode {
  const style = node.style;
  const lines = node.text.split('\n');
  const sizeMm = ptToMm(style.fontSizePt ?? theme.type.annotationPt);
  const lineHeight = sizeMm * (style.lineHeight ?? 1.2);

  const anchorX = style.align === 'middle' ? node.frame.width / 2 : style.align === 'end' ? node.frame.width : 0;

  if (lines.length === 1) {
    return text(node.text, { x: anchorX, y: sizeMm, ...textAttrs(style, theme) }, { role: 'text' });
  }

  // Multi-line text stays one <text> element with <tspan> children so it
  // remains a single editable object in Illustrator after export.
  return el(
    'text',
    { x: anchorX, y: sizeMm, ...textAttrs(style, theme) },
    lines.map((line, i) =>
      el('tspan', { x: anchorX, dy: i === 0 ? 0 : lineHeight }, undefined, { text: line }),
    ),
    { role: 'text' },
  );
}

function renderPanelLabel(node: PanelLabelNode, theme: Theme): SceneNode {
  return text(
    node.text,
    {
      x: 0,
      y: ptToMm(node.style.fontSizePt ?? theme.type.panelLabelPt),
      ...textAttrs(
        { fontWeight: theme.panelLabelWeight, fontSizePt: theme.type.panelLabelPt, ...node.style },
        theme,
      ),
    },
    { role: 'panel-label' },
  );
}

function renderShape(node: ShapeNode): SceneNode {
  const { width, height } = node.frame;
  const common = {
    fill: node.fill?.color ?? 'none',
    'fill-opacity': node.fill?.opacity,
    ...strokeAttrs(node.stroke),
  };

  switch (node.shape) {
    case 'ellipse':
      return el('ellipse', { cx: width / 2, cy: height / 2, rx: width / 2, ry: height / 2, ...common }, undefined, { role: 'shape' });
    case 'line':
      return el('line', { x1: 0, y1: 0, x2: width, y2: height, ...common, fill: 'none' }, undefined, { role: 'shape' });
    case 'rect':
    default:
      return el('rect', { x: 0, y: 0, width, height, rx: node.cornerRadiusMm, ...common }, undefined, { role: 'shape' });
  }
}

function renderArrow(node: ArrowNode): SceneNode {
  const points = node.points;
  if (points.length < 2) return group();

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
    .join(' ');

  const children: SceneNode[] = [
    el('path', { d: path, fill: 'none', ...strokeAttrs(node.stroke) }),
  ];

  const head = points[points.length - 1]!;
  const beforeHead = points[points.length - 2]!;
  if (node.head !== 'none') {
    children.push(arrowHead(beforeHead, head, node.headSizeMm, node.head, node.stroke));
  }
  if (node.tail !== 'none') {
    children.push(arrowHead(points[1]!, points[0]!, node.headSizeMm, node.tail, node.stroke));
  }

  return group({}, children, { role: 'arrow' });
}

/**
 * Arrowheads are drawn as explicit geometry rather than SVG markers: markers
 * scale with stroke-width and several vector editors drop or flatten them on
 * import, which would silently change the figure after export.
 */
function arrowHead(
  from: { x: number; y: number },
  to: { x: number; y: number },
  sizeMm: number,
  kind: 'triangle' | 'open',
  stroke: Stroke,
): SceneNode {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;

  const p1 = {
    x: to.x - sizeMm * Math.cos(angle - spread),
    y: to.y - sizeMm * Math.sin(angle - spread),
  };
  const p2 = {
    x: to.x - sizeMm * Math.cos(angle + spread),
    y: to.y - sizeMm * Math.sin(angle + spread),
  };

  if (kind === 'open') {
    return el('path', {
      d: `M${round(p1.x)} ${round(p1.y)} L${round(to.x)} ${round(to.y)} L${round(p2.x)} ${round(p2.y)}`,
      fill: 'none',
      ...strokeAttrs(stroke),
    });
  }

  return el('path', {
    d: `M${round(to.x)} ${round(to.y)} L${round(p1.x)} ${round(p1.y)} L${round(p2.x)} ${round(p2.y)} Z`,
    fill: stroke.color,
    stroke: 'none',
  });
}

/**
 * Significance bracket. Geometry lives in the node's own frame, so a user can
 * drag it anywhere — the brief requires annotation placement to be editable,
 * and pinning brackets to computed positions would take that away.
 */
function renderBracket(node: BracketNode, theme: Theme): SceneNode {
  const { width, height } = node.frame;
  const tick = Math.min(node.tickMm, height);
  // Horizontal span sits above, with ticks descending toward the two groups —
  // the conventional orientation. The label goes above the span.
  const barY = Math.max(0, height - tick);

  const path =
    `M0 ${round(height)} L0 ${round(barY)} ` +
    `L${round(width)} ${round(barY)} L${round(width)} ${round(height)}`;

  const labelSizePt = node.style.fontSizePt ?? theme.type.statisticPt;

  return group({}, [
    el('path', { d: path, fill: 'none', ...strokeAttrs(node.stroke) }, undefined, { role: 'bracket' }),
    text(
      node.label,
      {
        x: width / 2,
        y: barY - ptToMm(labelSizePt) * 0.35,
        ...textAttrs({ align: 'middle', fontSizePt: labelSizePt, ...node.style }, theme),
      },
      { role: 'bracket-label' },
    ),
  ]);
}

function renderImage(node: ImageNode, doc: FigureDocument, options: RenderOptions): SceneNode {
  const asset = findAsset(doc, node.assetId);
  const href = asset ? options.resolveAsset?.(node.assetId) : undefined;
  const { width, height } = node.frame;

  // Scale bars and annotations are parented to the image — `renderScaleBar`
  // reads its parent's calibration — so an image that dropped its children
  // would silently omit the one object claiming to be a measurement.
  const overlays = renderChildren(node, doc, options);

  if (!href) {
    // Placeholder keeps layout honest when an asset is missing or still loading.
    return group({}, [
      el('rect', {
        x: 0, y: 0, width, height,
        fill: '#f2f2f2', stroke: '#bbbbbb', 'stroke-width': 0.2,
        'stroke-dasharray': '1 1',
      }),
      ...overlays,
    ], { role: 'image' });
  }

  const crop = node.crop;
  const isCropped = crop.x !== 0 || crop.y !== 0 || crop.width !== 1 || crop.height !== 1;

  if (!isCropped) {
    const whole = el('image', {
      href,
      x: 0,
      y: 0,
      width,
      height,
      preserveAspectRatio: node.preserveAspect ? 'xMidYMid meet' : 'none',
      // Micrographs must not be smoothed; interpolation invents detail.
      'image-rendering': 'pixelated',
    }, undefined, { role: 'image' });
    // The wrapper carries no role: the <image> element inside already has it,
    // and counting the role twice would make "how many images are there" wrong.
    return overlays.length === 0 ? whole : group({}, [whole, ...overlays]);
  }

  /*
   * Where the kept region lands inside the frame.
   *
   * `preserveAspectRatio="xMidYMid meet"` centres the source inside the element
   * box — and the cropped box is the *oversized* one, whose aspect the crop has
   * already changed. So `meet` letterboxed against the wrong rectangle and the
   * region drawn was not the region outlined: cropping to half the width of an
   * aspect-locked image moved nothing at all, and on a montage tile, whose
   * frame comes from `gridCells` and has nothing to do with the micrograph's
   * shape, every crop landed somewhere else.
   *
   * Fitting the *cropped* aspect to the frame here answers that directly, and
   * the box built from it already carries the source's own aspect — so
   * `preserveAspectRatio="none"` cannot stretch anything, it just stops a
   * second centring rule from moving what this one placed.
   */
  const aspect = node.naturalPx.height > 0 ? node.naturalPx.width / node.naturalPx.height : 0;
  const frameRect = { x: 0, y: 0, width, height };
  const kept =
    node.preserveAspect && aspect > 0
      ? fitAspect(frameRect, (aspect * crop.width) / crop.height)
      : frameRect;

  const image = el('image', {
    href,
    x: kept.x - (crop.x / crop.width) * kept.width,
    y: kept.y - (crop.y / crop.height) * kept.height,
    width: kept.width / crop.width,
    height: kept.height / crop.height,
    preserveAspectRatio: 'none',
    'image-rendering': 'pixelated',
  }, undefined, { role: 'image' });

  const clipId = `clip-${node.id}`;
  const letterboxed = kept.width < width - 0.0001 || kept.height < height - 0.0001;

  /*
   * The image is clipped to the kept region and the overlays to the frame.
   *
   * They differ only when the crop letterboxes, and there they must: clipping
   * the picture at the frame would show the source either side of the region
   * the author kept, and clipping an *annotation* to the picture would delete
   * an arrow the author placed in the margin. Emitted only when the two really
   * differ, so an aspect-preserving crop — the case that already worked — keeps
   * the markup it had.
   */
  const drawn = letterboxed
    ? group({ 'clip-path': `url(#${clipId}-kept)` }, [image])
    : image;

  return group({ 'clip-path': `url(#${clipId})` }, [
    el('defs', {}, [
      el('clipPath', { id: clipId }, [el('rect', { x: 0, y: 0, width, height })]),
      ...(letterboxed
        ? [
            el('clipPath', { id: `${clipId}-kept` }, [
              el('rect', { x: kept.x, y: kept.y, width: kept.width, height: kept.height }),
            ]),
          ]
        : []),
    ]),
    drawn,
    ...overlays,
  ]);
}

/**
 * Scale bar. Its physical length is derived from the parent image's on-page
 * size and the micrograph's calibration, so resizing the image rescales the bar
 * automatically — a bar that keeps a fixed length while its image is resized is
 * a data integrity problem, not a cosmetic one.
 */
function renderScaleBar(node: ScaleBarNode, doc: FigureDocument, theme: Theme): SceneNode {
  // The arithmetic lives in doc-model so that `resyncScaleBars` — which keeps
  // the selection chrome on the bar — and this, which draws it, cannot disagree.
  const barWidthMm = scaleBarWidthMm(doc.nodes, node.id) ?? node.frame.width;

  const children: SceneNode[] = [
    el('rect', {
      x: 0,
      y: node.frame.height - node.barHeightMm,
      width: barWidthMm,
      height: node.barHeightMm,
      fill: node.fill.color,
      'fill-opacity': node.fill.opacity,
    }, undefined, { role: 'scale-bar' }),
  ];

  // `labelPosition` is the single authority. `showLabel` says the same thing a
  // second time, and reading both is how a control ends up doing nothing
  // because the *other* field is still off.
  if (node.labelPosition !== 'none') {
    const sizePt = node.style.fontSizePt ?? theme.type.scaleBarPt;
    const sizeMm = ptToMm(sizePt);
    const above = node.labelPosition === 'above';
    children.push(
      text(
        `${node.length} ${node.unitLabel}`,
        {
          x: barWidthMm / 2,
          y: above ? node.frame.height - node.barHeightMm - sizeMm * 0.4 : node.frame.height + sizeMm,
          ...textAttrs({ align: 'middle', fontSizePt: sizePt, ...node.style }, theme),
        },
        { role: 'scale-bar-label' },
      ),
    );
  }

  return group({}, children);
}

// ---------------------------------------------------------------------------
// Plot rendering
// ---------------------------------------------------------------------------

/**
 * Everything needed to draw a plot, or to place an annotation over one.
 *
 * Exposed via `measurePlot` so that callers positioning a significance bracket
 * use the renderer's own band scale rather than approximating it — an
 * approximation puts the bracket ends visibly off the bars it refers to.
 */
interface PlotGeometryBase {
  margin: { top: number; right: number; bottom: number; left: number };
  plotWidth: number;
  plotHeight: number;
}

/** Band-scaled x: bar, dot, bar-dot, beeswarm, box, violin. */
export interface CategoricalPlotGeometry extends PlotGeometryBase {
  kind: 'categorical';
  yScale: NumericScale;
  /**
   * One slot per *mark*, addressed by series name. On a two-factor table these
   * are sub-bands inside a category; on a single-factor one they are the
   * categories themselves. Either way every existing reader — `measurePlot`,
   * and `bracketFrame` through it — is unchanged.
   */
  band: ReturnType<typeof makeBandScale>;
  marks: ReturnType<typeof categoricalMarks>;
  /** Series names, parallel to `marks`. */
  categories: string[];
  /**
   * The band the x axis is *labelled* against, and its labels.
   *
   * The same as `band`/`categories` for a single-factor plot, so nothing about
   * an existing figure moves. For a two-factor one these are the outer bands —
   * four variants, not sixteen variant×group combinations — and the groups are
   * named by the legend instead.
   */
  axisBand: ReturnType<typeof makeBandScale>;
  axisCategories: string[];
  /** Distinct legend keys in draw order, with the colour each one carries. */
  legend: { label: string; color: string }[];
  /**
   * Which physical edge the band (category) axis runs against. Absent reads
   * as `'vertical'`, today's only behaviour — see `PlotNode.orientation`.
   */
  orientation: MarkOrientation;
}

/**
 * Numeric x: scatter, line, histogram.
 *
 * A separate arm rather than optional fields on one shape, because almost
 * nothing is shared — there is no band, no category list, and the marks are a
 * different type. Optional fields would push a null check onto every reader and
 * let a categorical-only assumption compile against a continuous plot.
 */
export interface ContinuousPlotGeometry extends PlotGeometryBase {
  kind: 'continuous';
  yScale: NumericScale;
  xScale: NumericScale;
  series: ReturnType<typeof xyMarks>;
  bins: ReturnType<typeof histogramMarks>;
  /**
   * Right-hand axis, present only when a plot declares `y2` *and* some series
   * reads it. Built from those series alone: a second axis whose domain came
   * from all the data would be a second copy of the first.
   */
  y2Scale?: NumericScale;
}

/**
 * A dense row×column grid: heatmap.
 *
 * No numeric axis on either side — both dimensions are categorical row/column
 * labels — so this cannot honestly carry a `yScale: NumericScale` the way the
 * other two arms do. `renderAxes`/`renderAxisBreaks` are typed against
 * `CategoricalPlotGeometry | ContinuousPlotGeometry` rather than the full
 * union for exactly this reason: a heatmap has no axis breaks and draws its
 * own row/column labels rather than sharing either function.
 */
export interface GridPlotGeometry extends PlotGeometryBase {
  kind: 'grid';
  rowScale: ReturnType<typeof makeBandScale>;
  colScale: ReturnType<typeof makeBandScale>;
  cells: { row: string; col: string; value: number | null; color: string }[];
  domain: { min: number; max: number; mode: HeatmapScaleMode };
}

export type PlotGeometry = CategoricalPlotGeometry | ContinuousPlotGeometry | GridPlotGeometry;


/**
 * Geometry for the numeric-x types.
 *
 * Returns null rather than approximating when the data cannot support the mark —
 * a scatter needs paired x values, a histogram needs a single distribution. The
 * Inspector only offers a type its dataset supports, so this is the guard for a
 * type set some other way (a loaded file, a dataset swapped underneath a plot).
 * Drawing *something* here is how the five unimplemented types shipped wrong
 * output for two phases.
 */
/**
 * `LinearScaleOptions`'s number-format fields, read from an `AxisSpec` and
 * spread in beside `tickStep`/`kind`/`breaks` at every `makeScale` call —
 * composed once so passing `labelFormat` and forgetting `labelDecimals` (or
 * the reverse) can't happen at one call site and not another.
 */
function labelFormatOptions(
  axis: AxisSpec,
): Pick<LinearScaleOptions, 'labelFormat' | 'labelDecimals'> {
  return axis.labelFormat ? { labelFormat: axis.labelFormat, labelDecimals: axis.labelDecimals } : {};
}

/** See `AxisSpec.linthresh`. Ignored by `makeScale` on anything but symlog. */
function linthreshOptions(axis: AxisSpec): Pick<LinearScaleOptions, 'linthresh'> {
  return axis.linthresh !== undefined ? { linthresh: axis.linthresh } : {};
}

/**
 * Whether this axis's `clipToRange` should actually take effect. Meaningless
 * with neither bound set — there is no range to clip to — so a hand-edited
 * file that sets the flag with no bounds clips against nothing rather than
 * the auto-derived, padded domain, the same defence-in-depth the Inspector's
 * own gating already provides on the honest path.
 */
function clipsToRange(axis: AxisSpec): boolean {
  return Boolean(axis.clipToRange) && (axis.min !== null || axis.max !== null);
}

/**
 * Whether a plot's cascade/ridgeline offset can apply at all — a line plot
 * with more than one series and no second y axis, since a cascade already
 * spends the vertical axis on separation and a second axis would spend it on
 * something else at the same time.
 */
export function isCascadable(node: Pick<PlotNode, 'plotType' | 'y2' | 'seriesAxis'>, seriesCount: number): boolean {
  if (node.plotType !== 'line' || seriesCount <= 1) return false;
  const axisFor = node.seriesAxis ?? [];
  const usesY2 = node.y2 !== undefined && axisFor.some((a) => a === 'y2');
  return !usesY2;
}

/**
 * Whether a cascade offset is actually in effect — `isCascadable` plus a
 * non-zero step. Composed once and read by both `continuousGeometry` (to
 * shrink the ranges and bake the offsets) and `renderContinuousMarks` (to
 * reverse paint order and draw the fill), the same "one place" discipline
 * `y2WidthMm`/`scaleBarWidthMm` already follow — two derivations of this fact
 * could otherwise disagree about whether a plot is cascading at all.
 */
export function hasCascadeOffset(
  node: Pick<PlotNode, 'plotType' | 'y2' | 'seriesAxis' | 'offsetStepMm' | 'offsetStepXMm'>,
  seriesCount: number,
): boolean {
  return (
    isCascadable(node, seriesCount) &&
    ((node.offsetStepMm ?? 0) !== 0 || (node.offsetStepXMm ?? 0) !== 0)
  );
}

/**
 * Millimetres of headroom/sideroom a cascade needs, derived from the *count*
 * of series and the requested step — never from a measured position, so it
 * cannot depend on the geometry it is itself used to build (the same
 * termination argument `annotationReserveMm` rests on).
 *
 * Clamped well short of the full plot area: a large step over many series
 * compresses the cascade's actual pitch (see `effectiveOffsetStepsMm`) rather
 * than collapsing the usable range to zero and drawing every trace on one
 * line. Exported so the Inspector can show the same number it is about to
 * spend.
 */
export function offsetReserveMm(
  node: Pick<PlotNode, 'offsetStepMm' | 'offsetStepXMm'>,
  seriesCount: number,
  plotWidth: number,
  plotHeight: number,
): { x: number; y: number } {
  if (seriesCount <= 1) return { x: 0, y: 0 };
  const steps = seriesCount - 1;
  const rawY = Math.abs(node.offsetStepMm ?? 0) * steps;
  const rawX = Math.abs(node.offsetStepXMm ?? 0) * steps;
  return {
    y: Math.min(rawY, plotHeight * 0.7),
    x: Math.min(rawX, plotWidth * 0.5),
  };
}

function signOf(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/**
 * The per-series step actually applied, after `offsetReserveMm`'s clamp has
 * possibly compressed it — direction preserved from the requested step, only
 * the magnitude ever shrinks.
 */
function effectiveOffsetStepsMm(
  node: Pick<PlotNode, 'offsetStepMm' | 'offsetStepXMm'>,
  seriesCount: number,
  reserve: { x: number; y: number },
): { x: number; y: number } {
  const steps = Math.max(1, seriesCount - 1);
  return {
    x: (reserve.x / steps) * signOf(node.offsetStepXMm ?? 0),
    y: (reserve.y / steps) * signOf(node.offsetStepMm ?? 0),
  };
}

/** Small fixed layout constants for the cascade depth axis — shared between
 *  `cascadeAxisReserveMm` (which must reserve exactly what gets drawn) and
 *  `renderCascadeAxis` (which draws it), the same one-place discipline every
 *  other margin/geometry pairing in this file follows. */
const CASCADE_AXIS_TICK_MM = 1.5;
const CASCADE_AXIS_GAP_MM = 2;
const CASCADE_AXIS_LABEL_GAP_MM = 1;
const CASCADE_AXIS_BRACKET_GAP_MM = 1.5;
const CASCADE_AXIS_BRACKET_MM = 1.5;
/**
 * Total sideways drift the depth axis leans across every series when the
 * cascade has a sideways (`offsetStepXMm`) component — a small FIXED budget,
 * never proportional to plotHeight or series count, so it can be reserved
 * once by `cascadeAxisReserveMm` and then simply divided evenly across steps
 * at draw time. This schematic axis is a legend-like device, not a literal
 * continuation of the real cascade's (already-clamped) offset angle: keeping
 * its own lean fixed is what keeps its reserved width a pure function of
 * label text and series count, preserving the two-pass margin termination
 * argument every other reserve in this file already rests on.
 */
const CASCADE_AXIS_LEAN_MM = 6;

export interface CascadeAxisGroup {
  seriesIndices: number[];
  category: string | undefined;
}

/**
 * Partitions cascaded series into contiguous runs sharing a `category`, for
 * the depth axis's end brackets.
 *
 * No series carrying a category at all is one implicit group covering
 * everything, so the common single-group case needs no per-series setup —
 * captioned by `PlotNode.cascadeAxisTitle` in that case. Once any series
 * does carry one, a run of series with none of their own (in an otherwise
 * categorised list) still gets its own group — its ticks and names still
 * draw — but is never captioned: inventing a caption for data that doesn't
 * have one is exactly the kind of approximation this codebase refuses
 * elsewhere (see `PlotType` choices in CLAUDE.md).
 */
export function cascadeAxisGroups(series: readonly { category?: string }[]): CascadeAxisGroup[] {
  if (!series.some((s) => s.category !== undefined)) {
    return [{ seriesIndices: series.map((_, i) => i), category: undefined }];
  }
  const groups: CascadeAxisGroup[] = [];
  series.forEach((s, i) => {
    const current = groups[groups.length - 1];
    if (current && current.category === s.category) current.seriesIndices.push(i);
    else groups.push({ seriesIndices: [i], category: s.category });
  });
  return groups;
}

/**
 * Whether any group drawn from `cascadeAxisGroups` will actually carry a
 * caption — composed once so the reserve and the draw function agree on
 * whether the caption's depth needs reserving/drawing at all.
 */
function cascadeAxisHasCaption(
  node: Pick<PlotNode, 'cascadeAxisTitle'>,
  groups: readonly CascadeAxisGroup[],
  hasAnyCategory: boolean,
): boolean {
  return groups.some((g) => g.category !== undefined || (!hasAnyCategory && node.cascadeAxisTitle));
}

/**
 * Width the cascade depth axis needs to the right of the plot: one tick
 * label per series (its name) plus, if any group ends up captioned, an end
 * bracket and a caption's depth.
 *
 * A pure function of counts, text and the fixed `CASCADE_AXIS_LEAN_MM`
 * budget — never of the diagonal's actual drawn position — so it terminates
 * the same two-pass margin loop `y2WidthMm` already relies on.
 */
export function cascadeAxisReserveMm(
  node: Pick<PlotNode, 'showCascadeAxis' | 'cascadeAxisTitle' | 'offsetStepXMm'>,
  theme: Theme,
  series: readonly { name: string; category?: string }[],
): number {
  if (!node.showCascadeAxis || series.length < 2) return 0;

  const tickLabelWidth = series.reduce(
    (max, s) => Math.max(max, estimateTextWidthMm(s.name, theme.type.tickLabelPt)),
    0,
  );
  const lean = (node.offsetStepXMm ?? 0) !== 0 ? CASCADE_AXIS_LEAN_MM : 0;
  const hasAnyCategory = series.some((s) => s.category !== undefined);
  const hasCaption = cascadeAxisHasCaption(node, cascadeAxisGroups(series), hasAnyCategory);
  const captionDepth = hasCaption
    ? CASCADE_AXIS_BRACKET_GAP_MM +
      CASCADE_AXIS_BRACKET_MM +
      theme.spacing.axisTitleGapMm +
      estimateTextHeightMm(theme.type.axisTitlePt)
    : 0;

  return (
    CASCADE_AXIS_GAP_MM +
    CASCADE_AXIS_TICK_MM +
    CASCADE_AXIS_LABEL_GAP_MM +
    tickLabelWidth +
    lean +
    captionDepth
  );
}

/**
 * Draws the cascade depth axis: a spine through one tick per series
 * (labelled with the series name in that series' own colour), and, per
 * captioned group from `cascadeAxisGroups`, an end bracket and a rotated
 * caption — the same `rotate(-90)` convention the ordinary y-axis title
 * already uses.
 *
 * The spine's positions are schematic, not the real (already-clamped)
 * cascade geometry: a fixed pitch derived from `plotHeight`/series count,
 * and — only when the cascade leans sideways at all — a lean distributed
 * evenly across steps from the same fixed `CASCADE_AXIS_LEAN_MM` budget
 * `cascadeAxisReserveMm` reserved. That is what keeps this function's
 * horizontal extent bounded by the same reserve regardless of how large the
 * plot's own (separately clamped) `offsetStepMm`/`offsetStepXMm` are.
 */
export function renderCascadeAxis(node: PlotNode, theme: Theme, geometry: ContinuousPlotGeometry): SceneNode[] {
  const series = geometry.series;
  const n = series.length;
  if (!node.showCascadeAxis || !hasCascadeOffset(node, n) || n < 2) return [];

  const steps = n - 1;
  const pitchMm = (geometry.plotHeight * 0.6) / steps;
  const leanSign = signOf(node.offsetStepXMm ?? 0);
  const leanPerStep = leanSign !== 0 ? (CASCADE_AXIS_LEAN_MM / steps) * leanSign : 0;

  const baseX = geometry.plotWidth + CASCADE_AXIS_GAP_MM;
  const baseY = geometry.plotHeight;
  const ticks = series.map((_, i) => ({ x: baseX + i * leanPerStep, y: baseY - i * pitchMm }));

  const dx = ticks[n - 1]!.x - ticks[0]!.x;
  const dy = ticks[n - 1]!.y - ticks[0]!.y;
  const len = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / len, y: dy / len };
  // Rotated 90°, then flipped if necessary so it always points away from the
  // plot (+x-ish) — ticks, labels and brackets read outward into the margin.
  const perpRaw = { x: -dir.y, y: dir.x };
  const perp = perpRaw.x < 0 ? { x: -perpRaw.x, y: -perpRaw.y } : perpRaw;

  const out: SceneNode[] = [];
  const axisStroke = { stroke: theme.foreground, 'stroke-width': theme.stroke.axisMm, fill: 'none' };

  out.push(
    el(
      'path',
      { d: ticks.map((t, i) => `${i === 0 ? 'M' : 'L'}${round(t.x)} ${round(t.y)}`).join(' '), ...axisStroke },
      undefined,
      { role: 'cascade-axis' },
    ),
  );

  const labelOffset = CASCADE_AXIS_TICK_MM + CASCADE_AXIS_LABEL_GAP_MM;
  series.forEach((s, i) => {
    const t = ticks[i]!;
    const tickEnd = { x: t.x + perp.x * CASCADE_AXIS_TICK_MM, y: t.y + perp.y * CASCADE_AXIS_TICK_MM };
    out.push(
      el(
        'path',
        { d: `M${round(t.x)} ${round(t.y)} L${round(tickEnd.x)} ${round(tickEnd.y)}`, ...axisStroke },
        undefined,
        { role: 'cascade-axis' },
      ),
    );
    out.push(
      text(
        s.name,
        {
          x: t.x + perp.x * labelOffset,
          y: t.y + perp.y * labelOffset,
          'font-family': theme.fontFamily,
          'font-size': ptToMm(theme.type.tickLabelPt),
          fill: s.color,
          'text-anchor': 'start',
          'dominant-baseline': 'central',
        },
        { role: 'cascade-axis-label' },
      ),
    );
  });

  const tickLabelWidth = series.reduce(
    (max, s) => Math.max(max, estimateTextWidthMm(s.name, theme.type.tickLabelPt)),
    0,
  );
  const bracketOffset = labelOffset + tickLabelWidth + CASCADE_AXIS_BRACKET_GAP_MM;
  const hasAnyCategory = series.some((s) => s.category !== undefined);

  for (const group of cascadeAxisGroups(series)) {
    const caption = group.category ?? (hasAnyCategory ? undefined : node.cascadeAxisTitle);
    if (!caption) continue;

    const first = ticks[group.seriesIndices[0]!]!;
    const last = ticks[group.seriesIndices[group.seriesIndices.length - 1]!]!;
    const p0 = { x: first.x + perp.x * bracketOffset, y: first.y + perp.y * bracketOffset };
    const p1 = { x: last.x + perp.x * bracketOffset, y: last.y + perp.y * bracketOffset };
    out.push(
      el('path', { d: `M${round(p0.x)} ${round(p0.y)} L${round(p1.x)} ${round(p1.y)}`, ...axisStroke }, undefined, {
        role: 'cascade-axis',
      }),
    );

    const mid = {
      x: (p0.x + p1.x) / 2 + perp.x * CASCADE_AXIS_BRACKET_MM,
      y: (p0.y + p1.y) / 2 + perp.y * CASCADE_AXIS_BRACKET_MM,
    };
    out.push(
      text(
        caption,
        {
          x: 0,
          y: 0,
          transform: `translate(${round(mid.x)} ${round(mid.y)}) rotate(-90)`,
          'font-family': theme.fontFamily,
          'font-size': ptToMm(theme.type.axisTitlePt),
          fill: theme.foreground,
          'text-anchor': 'middle',
          'dominant-baseline': 'alphabetic',
        },
        // Editable only when the caption really is `cascadeAxisTitle`. Where it
        // came from a series' own `category`, the renderer ignores that field
        // entirely, so offering to edit it would be a control that silently
        // does nothing — the caption's source is the data, and the data grid is
        // where it changes.
        {
          role: 'cascade-axis-title',
          ...(group.category === undefined ? { editTarget: 'cascadeAxisTitle' } : {}),
        },
      ),
    );
  }

  return out;
}

function continuousGeometry(
  node: PlotNode,
  series: ReturnType<typeof toSeries>,
  frame: { margin: PlotGeometryBase['margin']; plotWidth: number; plotHeight: number },
): ContinuousPlotGeometry | null {
  const { margin, plotWidth, plotHeight } = frame;
  const colors = paletteColors(node.palette, series.length);

  if (node.plotType === 'histogram') {
    // One distribution only. Pooling several groups into one histogram invents a
    // bimodal shape that belongs to neither of them.
    if (series.length !== 1) return null;
    const values = series[0]!.values.filter(Number.isFinite);
    if (values.length === 0) return null;

    const rawBins = histogramBins(values, node.histogramBins ?? null);
    if (rawBins.length === 0) return null;

    // The x domain comes from the bin edges, not the raw values: a domain padded
    // past the outermost edge would leave the end bars floating off the axis.
    const xScale = makeScale({
      domain: { min: rawBins[0]!.x0, max: rawBins[rawBins.length - 1]!.x1 },
      rangeMm: [0, plotWidth],
      tickStep: node.x.tickStep,
      kind: 'linear',
      ...labelFormatOptions(node.x),
      ...linthreshOptions(node.x),
    });

    /*
     * A count axis is discrete. Left to the generic tick chooser a histogram
     * peaking at 3 gets labelled 0, 0.5, 1, 1.5 … — half an observation, which
     * is not a thing. Step by whole counts instead, chosen so the tick density
     * still suits the axis length.
     */
    const maxCount = Math.max(...rawBins.map((b) => b.count), 1);
    const countStep = Math.max(1, Math.ceil(maxCount / tickCountForLength(plotHeight)));

    const yScale = makeScale({
      domain: resolveDomain(rawBins.map((b) => b.count), {
        min: node.y.min,
        max: node.y.max,
        // Counts are magnitudes drawn as bars; a truncated baseline misleads.
        includeZero: true,
        padFraction: 0.08,
        kind: node.y.scale,
      }),
      rangeMm: [plotHeight, 0],
      tickStep: node.y.tickStep ?? countStep,
      kind: node.y.scale,
      ...(node.y.breaks ? { breaks: node.y.breaks } : {}),
      ...labelFormatOptions(node.y),
      ...linthreshOptions(node.y),
    });

    return {
      kind: 'continuous',
      margin,
      plotWidth,
      plotHeight,
      xScale,
      yScale,
      series: [],
      bins: histogramMarks({ x: xScale, y: yScale, bins: rawBins, barWidthFraction: 1 }),
    };
  }

  if (node.plotType === 'volcano') {
    // One set of (feature, fold change, p-value) triples — pooling several
    // groups would mix significance calls that were never computed together.
    if (series.length !== 1) return null;
    const raw = series[0]!;
    if (!raw.x || raw.x.length === 0 || !raw.pointLabels || raw.pointLabels.length === 0) {
      return null;
    }

    const thresholds = node.volcanoThresholds ?? DEFAULT_VOLCANO_THRESHOLDS;
    /*
     * The y axis is -log10(p), not the raw p-value read from the table —
     * transformed here, once, before geometry or classification sees it, so
     * both are built from the same numbers the axis actually shows.
     *
     * A p of exactly 0 is a floating-point underflow in the upstream test,
     * not a claim of infinite significance, and -log10(0) is Infinity — a y
     * position no finite axis can place. Substituting the smallest
     * representable positive double keeps the point on the chart, at its
     * extreme top, rather than silently dropping the most significant row in
     * the table.
     */
    const transformed = {
      ...raw,
      values: raw.values.map((p) => negLog10(p > 0 ? p : Number.MIN_VALUE)),
    };

    const xScale = makeScale({
      domain: resolveDomain(transformed.x ?? [], {
        min: node.x.min,
        max: node.x.max,
        includeZero: false,
        padFraction: 0.08,
        kind: node.x.scale,
      }),
      rangeMm: [0, plotWidth],
      tickStep: node.x.tickStep,
      kind: node.x.scale,
      ...(node.x.breaks ? { breaks: node.x.breaks } : {}),
      ...labelFormatOptions(node.x),
      ...linthreshOptions(node.x),
    });

    const yScale = makeScale({
      domain: resolveDomain(transformed.values, {
        min: node.y.min,
        max: node.y.max,
        // -log10(p) is a magnitude — more significant is further from zero —
        // so a truncated baseline would misread the same way a count axis's
        // would.
        includeZero: true,
        padFraction: 0.08,
        kind: node.y.scale,
      }),
      rangeMm: [plotHeight, 0],
      tickStep: node.y.tickStep,
      kind: node.y.scale,
      ...(node.y.breaks ? { breaks: node.y.breaks } : {}),
      ...labelFormatOptions(node.y),
      ...linthreshOptions(node.y),
    });

    return {
      kind: 'continuous',
      margin,
      plotWidth,
      plotHeight,
      xScale,
      yScale,
      series: xyMarks([transformed], {
        x: xScale,
        y: yScale,
        showLine: false,
        showPoints: true,
        pointSizeMm: node.pointSizeMm,
        colors,
        classify: (xValue, yValue) => volcanoCategory(xValue, yValue, thresholds),
        clipToXRange: clipsToRange(node.x),
        clipToYRange: [clipsToRange(node.y)],
      }),
      bins: [],
    };
  }

  // scatter and line: every series must carry its own paired x values.
  const xValues = series.flatMap((s) => [...(s.x ?? [])]).filter(Number.isFinite);
  if (xValues.length === 0) return null;

  /*
   * The secondary axis is offered on continuous plots only. On a categorical
   * plot the bands, not the values, carry the reading, and two bar series drawn
   * against different scales in one band group cannot be compared by length —
   * which is the only thing a bar chart is for. Withheld rather than
   * approximated, and the Inspector says so.
   */
  const axisFor = node.seriesAxis ?? [];
  const usesY2 = node.y2 !== undefined && series.some((_, i) => axisFor[i] === 'y2');

  /*
   * Cascade / offset line plots. `reserve` is {0,0} whenever `cascading` is
   * false, so the range bounds below are exactly `[0, plotWidth]`/
   * `[plotHeight, 0]` on every figure that does not use this — the same
   * "absent draws exactly as today" guarantee every optional field here
   * carries.
   */
  const cascading = hasCascadeOffset(node, series.length);
  const reserve = cascading
    ? offsetReserveMm(node, series.length, plotWidth, plotHeight)
    : { x: 0, y: 0 };
  const effSteps = cascading ? effectiveOffsetStepsMm(node, series.length, reserve) : { x: 0, y: 0 };
  // Later series cascade up (negative pixel y) and right (positive pixel x);
  // a negative requested step reverses the direction via `effSteps`' own sign.
  const offsets = cascading
    ? series.map((_, i) => ({ x: i * effSteps.x, y: -i * effSteps.y }))
    : undefined;

  const xScale = makeScale({
    domain: resolveDomain(xValues, {
      min: node.x.min,
      max: node.x.max,
      includeZero: false,
      padFraction: 0.08,
      kind: node.x.scale,
    }),
    rangeMm: [0, plotWidth - reserve.x],
    tickStep: node.x.tickStep,
    kind: node.x.scale,
    ...(node.x.breaks ? { breaks: node.x.breaks } : {}),
    ...labelFormatOptions(node.x),
    ...linthreshOptions(node.x),
  });

  const yScale = makeScale({
    domain: resolveDomain(series.flatMap((s) => s.values), {
      min: node.y.min,
      max: node.y.max,
      includeZero: false,
      padFraction: 0.08,
      kind: node.y.scale,
    }),
    rangeMm: [plotHeight, reserve.y],
    tickStep: node.y.tickStep,
    kind: node.y.scale,
    ...(node.y.breaks ? { breaks: node.y.breaks } : {}),
    ...labelFormatOptions(node.y),
    ...linthreshOptions(node.y),
  });

  const y2Scale = usesY2
    ? makeScale({
        domain: resolveDomain(
          series.filter((_, i) => axisFor[i] === 'y2').flatMap((s) => s.values),
          {
            min: node.y2!.min,
            max: node.y2!.max,
            includeZero: false,
            padFraction: 0.08,
            kind: node.y2!.scale,
          },
        ),
        rangeMm: [plotHeight, 0],
        tickStep: node.y2!.tickStep,
        kind: node.y2!.scale,
        ...(node.y2!.breaks ? { breaks: node.y2!.breaks } : {}),
        ...labelFormatOptions(node.y2!),
        ...linthreshOptions(node.y2!),
      })
    : undefined;

  return {
    kind: 'continuous',
    margin,
    plotWidth,
    plotHeight,
    xScale,
    yScale,
    ...(y2Scale ? { y2Scale } : {}),
    series: xyMarks(series, {
      x: xScale,
      y: yScale,
      ...(y2Scale
        ? { ySeries: series.map((_, i) => (axisFor[i] === 'y2' ? y2Scale : undefined)) }
        : {}),
      showLine: node.plotType === 'line',
      // A line plot hides its points by default; a scatter is nothing but points.
      showPoints: node.plotType === 'scatter' || node.showPoints,
      pointSizeMm: node.pointSizeMm,
      colors,
      ...(offsets ? { offsets } : {}),
      clipToXRange: clipsToRange(node.x),
      clipToYRange: series.map((_, i) =>
        usesY2 && axisFor[i] === 'y2' ? clipsToRange(node.y2!) : clipsToRange(node.y),
      ),
      categories: series.map((s) => s.category),
      /*
       * Replicates collapse to a centre and an interval on any line plot that
       * asks for an error interval — as bars or as a band. A scatter is the raw
       * observations by definition, so summarising one would hide the very thing
       * it is drawn to show.
       *
       * An *absent* `errorDisplay` summarises too, because "Bars at each point"
       * is what the Inspector has been showing for such a plot all along
       * (`node.errorDisplay ?? 'bars'`) while nothing drew one. That widening
       * cannot disturb an existing figure: `summariseAtX` returns the series
       * untouched unless some x actually carries more than one value, and only
       * the replicate layouts do.
       */
      ...(node.plotType === 'line' && node.errorBars !== 'none'
        ? {
            summariseAtX: { center: node.center, errorBars: node.errorBars },
            ...(node.showReplicates ? { showReplicates: true } : {}),
          }
        : {}),
    }),
    bins: [],
  };
}

/**
 * Geometry for one candidate margin. Split out so the margin can be measured
 * and the geometry rebuilt once against the answer — see `computePlotGeometry`.
 */
function geometryForMargin(
  node: PlotNode,
  series: ReturnType<typeof toSeries>,
  margin: PlotGeometryBase['margin'],
): CategoricalPlotGeometry | ContinuousPlotGeometry | null {
  const plotWidth = Math.max(0, node.frame.width - margin.left - margin.right);
  const plotHeight = Math.max(0, node.frame.height - margin.top - margin.bottom);
  if (plotWidth <= 0 || plotHeight <= 0) return null;

  if (CONTINUOUS_X_PLOT_TYPES.has(node.plotType)) {
    return continuousGeometry(node, series, { margin, plotWidth, plotHeight });
  }

  const orientation: MarkOrientation = node.orientation ?? 'vertical';

  const yDomain = resolveDomain(series.flatMap((s) => s.values), {
    min: node.y.min,
    max: node.y.max,
    // Bars encode magnitude by length, so a truncated baseline misleads.
    includeZero: node.plotType === 'bar' || node.plotType === 'bar-dot',
    padFraction: 0.08,
    kind: node.y.scale,
  });

  const yScale = makeScale({
    domain: yDomain,
    // Vertical: inverted, since SVG y grows downward and data grows upward.
    // Horizontal: the value axis is physical x, which already grows the same
    // direction as the data — the same convention `continuousGeometry`'s
    // numeric x-scale already uses.
    rangeMm: orientation === 'horizontal' ? [0, plotWidth] : [plotHeight, 0],
    tickStep: node.y.tickStep,
    kind: node.y.scale,
    ...(node.y.breaks ? { breaks: node.y.breaks } : {}),
    ...labelFormatOptions(node.y),
    ...linthreshOptions(node.y),
  });

  /*
   * Two factors when the series say so. A single-factor table takes the exact
   * path it always did — one band per series, one colour per series — so no
   * existing figure moves by a micron; `parity.test.tsx` pins that.
   */
  const twoFactor = isTwoFactor(series);

  // Absent reads as the default the literals used to hardcode, so a figure that
  // says nothing about spacing is byte-identical to one drawn before the fields
  // existed — `grouped-plots.test.ts` asserts exactly that.
  const groupGap = node.groupGapFraction ?? DEFAULT_GROUP_GAP_FRACTION;
  const barGap = node.barGapFraction ?? DEFAULT_BAR_GAP_FRACTION;

  // The band axis is physical x when vertical, physical y when horizontal —
  // `BandScale` itself is axis-agnostic, so only the output range changes.
  const bandRangeMm: [number, number] = orientation === 'horizontal' ? [0, plotHeight] : [0, plotWidth];

  const grouped = twoFactor
    ? makeGroupedBandScale(
        series.map((s) => ({ name: s.name, category: s.category!, group: s.group! })),
        bandRangeMm,
        groupGap,
        barGap,
      )
    : null;

  const band = grouped
    ? grouped.band
    : makeBandScale(series.map((s) => s.name), bandRangeMm, groupGap);

  /*
   * Colour keys on the legend factor, not on series order.
   *
   * On a two-factor plot that is what makes a group one colour across every
   * category — the thing the legend then asserts. Indexing sixteen marks into
   * the palette would give a variant's four bars four colours and repeat the
   * cycle, so nothing in the picture would carry the grouping.
   */
  const legendKeys = twoFactor ? [...new Set(series.map((s) => s.legendKey ?? s.group!))] : [];
  const legendColors = paletteColors(node.palette, Math.max(1, legendKeys.length));
  const colors = twoFactor
    ? series.map(
        (s) => legendColors[legendKeys.indexOf(s.legendKey ?? s.group!) % legendColors.length]!,
      )
    : paletteColors(node.palette, series.length);

  const marks = categoricalMarks(series, {
    band,
    y: yScale,
    center: node.center,
    errorBars: node.errorBars,
    // Absent means both directions: the field post-dates every saved figure,
    // and half a whisker is not a sane default to inherit.
    errorBarDirection: node.errorBarDirection ?? 'both',
    barWidthFraction: node.barWidthFraction,
    showBar: node.plotType === 'bar' || node.plotType === 'bar-dot',
    showBox: node.plotType === 'box',
    showViolin: node.plotType === 'violin',
    showPoints: node.showPoints || node.plotType === 'dot' || node.plotType === 'beeswarm',
    pointSizeMm: node.pointSizeMm,
    jitterMm: node.jitterMm,
    pointLayout: node.plotType === 'beeswarm' ? 'beeswarm' : 'jitter',
    colors,
    // Seeded from the node id so jitter is identical on screen and in export.
    seed: hashString(node.id),
    orientation,
  });

  return {
    kind: 'categorical',
    margin,
    plotWidth,
    plotHeight,
    band,
    yScale,
    marks,
    categories: series.map((s) => s.name),
    axisBand: grouped ? grouped.outer : band,
    axisCategories: grouped ? grouped.outer.domain : series.map((s) => s.name),
    legend: legendKeys.map((label, i) => ({
      label,
      color: legendColors[i % legendColors.length]!,
    })),
    orientation,
  };
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

/**
 * Sequential: light → dark, for plain-magnitude values with no meaningful
 * zero. Diverging: blue → white → red, matching the blue/red down/up
 * convention volcano plots already use in this codebase — kept consistent
 * rather than introducing a second colour vocabulary for "negative/positive".
 */
export const DEFAULT_HEATMAP_STOPS: Record<HeatmapScaleMode, readonly string[]> = {
  sequential: ['#f7fbff', '#08306b'],
  diverging: ['#4575b4', '#ffffff', '#d73027'],
};

export const DEFAULT_HEATMAP_MISSING_COLOR = '#e0e0e0';

/**
 * Plain sRGB interpolation between the two stops nearest `t` — the standard
 * baseline (what a naive `d3.interpolateRgb` does too), not a perceptual
 * (Lab-space) ramp. `packages/theme` has no inverse Lab→RGB transform today,
 * and building one is real added complexity this first heatmap does not need
 * to take on.
 */
function interpolateColor(t: number, stops: readonly string[]): string {
  if (stops.length === 0) return '#000000';
  if (stops.length === 1) return stops[0]!;

  const clamped = Math.max(0, Math.min(1, t));
  const segment = clamped * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(segment));
  const localT = segment - i;

  const a = parseHex(stops[i]!);
  const b = parseHex(stops[i + 1]!);
  const lerp = (x: number, y: number) => x + (y - x) * localT;
  return toHex({ r: lerp(a.r, b.r), g: lerp(a.g, b.g), b: lerp(a.b, b.b) });
}

/**
 * A cell's colour from its normalized position — called from both the cell
 * fill and the colourbar, in this one place, so they cannot disagree on what
 * a given `t` looks like. `null` (a missing cell) is a themed flat colour,
 * never a point on the ramp — it has no value to place there.
 */
function resolveHeatmapColor(node: PlotNode, t: number | null, mode: HeatmapScaleMode): string {
  if (t === null) return node.heatmapMissingColor ?? DEFAULT_HEATMAP_MISSING_COLOR;
  const stops = node.heatmapStops ?? DEFAULT_HEATMAP_STOPS[mode];
  return interpolateColor(t, stops);
}

/**
 * How a heatmap's column labels sit, mirroring `xLabelLayout`'s tilt-then-
 * truncate choice — the same "angle the whole axis or none of it" reasoning
 * and the same two-tier 45°/90° budget — computed directly from the column
 * band's own pitch rather than through `xLabelLayout`, which is tied to
 * `CategoricalPlotGeometry`'s axis-band shape.
 */
function heatmapColumnLabelLayout(
  colLabels: readonly string[],
  slot: number,
  panelHeightMm: number,
  theme: Theme,
): { angle: 0 | 45 | 90; budget: number; depth: number } {
  const tickLabelPt = theme.type.tickLabelPt;
  const oneLine = estimateTextHeightMm(tickLabelPt);
  if (colLabels.length === 0) return { angle: 0, budget: Infinity, depth: 0 };

  const widest = colLabels.reduce(
    (max, name) => Math.max(max, estimateTextWidthMm(name, tickLabelPt)),
    0,
  );
  const angle: 0 | 45 | 90 = widest > slot * Math.SQRT2 ? 90 : widest > slot ? 45 : 0;
  if (angle === 0) return { angle, budget: slot, depth: oneLine };

  const budget = angle === 90 ? Math.max(slot, panelHeightMm * 0.45) : slot * Math.SQRT2;
  const longest = colLabels.reduce(
    (max, name) =>
      Math.max(max, estimateTextWidthMm(truncateToWidth(name, tickLabelPt, budget), tickLabelPt)),
    0,
  );
  const sin = angle === 90 ? 1 : Math.SQRT1_2;
  return { angle, budget, depth: longest * sin + oneLine };
}

/** Width the row labels need, at the tick-label size. */
function heatmapRowLabelWidth(rowLabels: readonly string[], theme: Theme): number {
  const tickLabelPt = theme.type.tickLabelPt;
  return rowLabels.reduce((max, name) => Math.max(max, estimateTextWidthMm(name, tickLabelPt)), 0);
}

/** Thickness of the colourbar ramp itself, independent of its length or its tick labels. */
const COLORBAR_THICKNESS_MM = 3;

/**
 * How far the colourbar's furniture reaches beyond the plot area, in the
 * direction its placement grows — composed once and read by both the margin
 * reservation and the drawing function, the same discipline `y2WidthMm`/
 * `scaleBarWidthMm` already follow.
 */
function colorbarExtentMm(
  domain: { min: number; max: number },
  theme: Theme,
  placement: 'right' | 'bottom',
): number {
  const gap = theme.spacing.tickLabelGapMm;
  const tickLabelPt = theme.type.tickLabelPt;
  if (placement === 'bottom') {
    return COLORBAR_THICKNESS_MM + gap + estimateTextHeightMm(tickLabelPt);
  }
  const step = (domain.max - domain.min) / 4 || 1;
  const labelWidth = Math.max(
    estimateTextWidthMm(formatTick(domain.min, step), tickLabelPt),
    estimateTextWidthMm(formatTick(domain.max, step), tickLabelPt),
  );
  return COLORBAR_THICKNESS_MM + gap + labelWidth;
}

/** Geometry for one candidate margin — the grid analogue of `geometryForMargin`. */
function heatmapGeometryForMargin(
  node: PlotNode,
  matrix: Matrix,
  domain: { min: number; max: number },
  mode: HeatmapScaleMode,
  margin: PlotGeometryBase['margin'],
): GridPlotGeometry | null {
  const plotWidth = Math.max(0, node.frame.width - margin.left - margin.right);
  const plotHeight = Math.max(0, node.frame.height - margin.top - margin.bottom);
  if (plotWidth <= 0 || plotHeight <= 0) return null;

  // No padding: cells fill the grid edge to edge, the conventional heatmap
  // look, unlike a bar chart's gap-by-default.
  const rowScale = makeBandScale(matrix.rowLabels, [0, plotHeight], 0, 0);
  const colScale = makeBandScale(matrix.colLabels, [0, plotWidth], 0, 0);

  const cells: GridPlotGeometry['cells'] = [];
  matrix.rowLabels.forEach((row, r) => {
    matrix.colLabels.forEach((col, c) => {
      const value = matrix.cells[r]?.[c] ?? null;
      const t = normalizeCellValue(value, domain);
      cells.push({ row, col, value, color: resolveHeatmapColor(node, t, mode) });
    });
  });

  return { kind: 'grid', margin, plotWidth, plotHeight, rowScale, colScale, cells, domain: { ...domain, mode } };
}

/** How much gutter a heatmap's row/column labels and colourbar actually need. */
function requiredHeatmapMargin(
  node: PlotNode,
  theme: Theme,
  matrix: Matrix,
  domain: { min: number; max: number },
): { left: number; bottom: number; right: number; top: number } {
  const themeMargin = theme.spacing.plotMarginMm;
  const gap = theme.spacing.tickLabelGapMm;

  const left = heatmapRowLabelWidth(matrix.rowLabels, theme) + gap;

  // The column slot at the theme's own margin — same two-pass reasoning
  // `computePlotGeometry` uses generally: measured once against a plausible
  // width, not converged to.
  const plotWidthGuess = Math.max(0, node.frame.width - left - themeMargin.right);
  const slot = matrix.colLabels.length > 0 ? plotWidthGuess / matrix.colLabels.length : plotWidthGuess;
  const { depth } = heatmapColumnLabelLayout(matrix.colLabels, slot, node.frame.height, theme);
  const bottom = depth + gap;

  const placement: 'right' | 'bottom' | 'none' =
    node.legend === 'none' ? 'none' : node.legend === 'bottom' ? 'bottom' : 'right';
  const right =
    placement === 'right' ? gap + colorbarExtentMm(domain, theme, 'right') : themeMargin.right;
  const bottomTotal =
    placement === 'bottom' ? bottom + gap + colorbarExtentMm(domain, theme, 'bottom') : bottom;

  return { left, bottom: bottomTotal, right, top: themeMargin.top };
}

/**
 * Geometry for a heatmap. Runs its own two-pass margin growth rather than
 * sharing `geometryForMargin`/`requiredMargin` — a dense grid measures
 * row/column label widths and a colourbar, not tick counts and a discrete
 * legend, so almost nothing in that machinery applies.
 */
function heatmapGeometry(node: PlotNode, dataset: Dataset, theme: Theme): GridPlotGeometry | null {
  const matrix = toMatrix(dataset);
  if (matrix.rowLabels.length === 0 || matrix.colLabels.length === 0) return null;

  const mode = node.heatmapScale ?? 'sequential';
  const domain = resolveHeatmapDomain(matrix.cells, mode);

  const themeMargin = theme.spacing.plotMarginMm;
  const first = heatmapGeometryForMargin(node, matrix, domain, mode, themeMargin);
  if (!first) return null;

  const needed = requiredHeatmapMargin(node, theme, matrix, domain);
  if (
    needed.left <= themeMargin.left + 0.01 &&
    needed.bottom <= themeMargin.bottom + 0.01 &&
    needed.right <= themeMargin.right + 0.01 &&
    needed.top <= themeMargin.top + 0.01
  ) {
    return first;
  }

  const grown = {
    left: Math.max(themeMargin.left, needed.left),
    bottom: Math.max(themeMargin.bottom, needed.bottom),
    right: Math.max(themeMargin.right, needed.right),
    top: Math.max(themeMargin.top, needed.top),
  };
  return heatmapGeometryForMargin(node, matrix, domain, mode, grown) ?? first;
}

/** Cells, row labels and column labels — a heatmap's whole plot area. */
function renderHeatmapPlot(node: PlotNode, theme: Theme, geometry: GridPlotGeometry): SceneNode[] {
  const { rowScale, colScale, cells, plotHeight } = geometry;
  const out: SceneNode[] = [];

  for (const cell of cells) {
    const x = colScale.center(cell.col) - colScale.bandwidth / 2;
    const y = rowScale.center(cell.row) - rowScale.bandwidth / 2;
    out.push(
      el('rect', {
        x: round(x),
        y: round(y),
        width: round(colScale.bandwidth),
        height: round(rowScale.bandwidth),
        fill: cell.color,
        stroke: 'none',
      }, undefined, { role: 'heatmap-cell' }),
    );

    if (node.showCellValues && cell.value !== null) {
      const cellPt = theme.type.tickLabelPt;
      // Skipped where the cell can't hold a line of text without overprinting
      // its neighbours, rather than shrinking the text past legibility.
      if (rowScale.bandwidth >= estimateTextHeightMm(cellPt) * 1.4) {
        out.push(
          text(formatTick(cell.value, (geometry.domain.max - geometry.domain.min) / 4 || 1), {
            x: round(colScale.center(cell.col)),
            y: round(rowScale.center(cell.row)),
            'font-family': theme.fontFamily,
            'font-size': ptToMm(cellPt),
            fill: theme.foreground,
            'text-anchor': 'middle',
            'dominant-baseline': 'central',
          }, { role: 'tick-label' }),
        );
      }
    }
  }

  if (node.y.showLabels) {
    const tickLabelPt = theme.type.tickLabelPt;
    const gap = theme.spacing.tickLabelGapMm;
    for (const row of rowScale.domain) {
      out.push(
        text(row, {
          x: round(-gap),
          y: round(rowScale.center(row)),
          'font-family': theme.fontFamily,
          'font-size': ptToMm(tickLabelPt),
          fill: theme.foreground,
          'text-anchor': 'end',
          'dominant-baseline': 'central',
        }, { role: 'tick-label' }),
      );
    }
  }

  if (node.x.showLabels) {
    const tickLabelPt = theme.type.tickLabelPt;
    const gap = theme.spacing.tickLabelGapMm;
    // Same tilt-then-truncate idiom the categorical x axis renders with
    // (`renderAxes`'s x-axis half): `translate` to the tick, `rotate(-angle)`
    // about that local origin, anchor the text to end there.
    const { angle, budget } = heatmapColumnLabelLayout(
      colScale.domain,
      colScale.step,
      node.frame.height,
      theme,
    );
    const y = plotHeight + gap;
    for (const col of colScale.domain) {
      const x = colScale.center(col);
      if (angle !== 0) {
        out.push(
          text(truncateToWidth(col, tickLabelPt, budget), {
            x: 0,
            y: 0,
            transform: `translate(${round(x)} ${round(y)}) rotate(${-angle})`,
            'font-family': theme.fontFamily,
            'font-size': ptToMm(tickLabelPt),
            fill: theme.foreground,
            'text-anchor': 'end',
            'dominant-baseline': 'central',
          }, { role: 'tick-label' }),
        );
      } else {
        out.push(
          text(col, {
            x: round(x),
            y: round(y),
            'font-family': theme.fontFamily,
            'font-size': ptToMm(tickLabelPt),
            fill: theme.foreground,
            'text-anchor': 'middle',
            'dominant-baseline': 'hanging',
          }, { role: 'tick-label' }),
        );
      }
    }
  }

  return out;
}

/** The colour-scale legend: a strip of discrete rects approximating a ramp, plus a few tick labels. */
function renderColorbar(
  node: PlotNode,
  theme: Theme,
  geometry: GridPlotGeometry,
  placement: 'right' | 'bottom',
): SceneNode[] {
  const { domain, margin, plotWidth, plotHeight } = geometry;
  const mode = domain.mode;
  const stops = node.heatmapStops ?? DEFAULT_HEATMAP_STOPS[mode];
  const tickLabelPt = theme.type.tickLabelPt;
  const gap = theme.spacing.tickLabelGapMm;

  // A ramp of adjacent rects, not an SVG <linearGradient> — no <defs>, no
  // per-node id to keep unique across several heatmaps on one page, and both
  // adapters already draw plain rects identically with zero new markup shape.
  const STEPS = 64;
  const lengthMm = placement === 'right' ? plotHeight : plotWidth;
  const stepLength = lengthMm / STEPS;

  const children: SceneNode[] = [];
  for (let i = 0; i < STEPS; i++) {
    // t=0 is the domain minimum; the bar reads low→high top-to-bottom is
    // backwards for a vertical bar (low should sit at the bottom, same
    // convention the y axis itself already uses), so the right-hand ramp is
    // built bottom-up.
    const t = placement === 'right' ? 1 - i / (STEPS - 1) : i / (STEPS - 1);
    const color = interpolateColor(t, stops);
    if (placement === 'right') {
      children.push(el('rect', {
        x: 0,
        y: round(i * stepLength),
        width: COLORBAR_THICKNESS_MM,
        height: round(stepLength + 0.5),
        fill: color,
        stroke: 'none',
      }, undefined, { role: 'colorbar' }));
    } else {
      children.push(el('rect', {
        x: round(i * stepLength),
        y: 0,
        width: round(stepLength + 0.5),
        height: COLORBAR_THICKNESS_MM,
        fill: color,
        stroke: 'none',
      }, undefined, { role: 'colorbar' }));
    }
  }

  const step = (domain.max - domain.min) / 4 || 1;
  const tickValues = [0, 0.25, 0.5, 0.75, 1].map((f) => domain.min + f * (domain.max - domain.min));
  for (const value of tickValues) {
    const label = formatTick(value, step);
    if (placement === 'right') {
      const f = (value - domain.min) / (domain.max - domain.min || 1);
      const y = (1 - f) * lengthMm;
      children.push(text(label, {
        x: round(COLORBAR_THICKNESS_MM + gap),
        y: round(y),
        'font-family': theme.fontFamily,
        'font-size': ptToMm(tickLabelPt),
        fill: theme.foreground,
        'text-anchor': 'start',
        'dominant-baseline': 'central',
      }, { role: 'tick-label' }));
    } else {
      const f = (value - domain.min) / (domain.max - domain.min || 1);
      const x = f * lengthMm;
      children.push(text(label, {
        x: round(x),
        y: round(COLORBAR_THICKNESS_MM + gap),
        'font-family': theme.fontFamily,
        'font-size': ptToMm(tickLabelPt),
        fill: theme.foreground,
        'text-anchor': 'middle',
        'dominant-baseline': 'hanging',
      }, { role: 'tick-label' }));
    }
  }

  const originX = placement === 'right' ? margin.left + plotWidth + gap : margin.left;
  const originY = placement === 'right' ? margin.top : margin.top + plotHeight + gap;
  return [group({ transform: translate(originX, originY) }, children)];
}

/**
 * How much gutter this plot's axis furniture actually needs, in millimetres.
 *
 * The theme's `plotMarginMm` was applied as a constant, so a five-digit tick
 * label plus a y title simply ran out of the panel — panels do not clip, so it
 * overprinted the neighbouring panel and then the page. Both numbers are
 * measured through `text-width.ts`'s static tables, never the DOM, so the
 * canvas and the headless exporter reach the same answer.
 */
function requiredMargin(
  node: PlotNode,
  theme: Theme,
  geometry: CategoricalPlotGeometry | ContinuousPlotGeometry,
  reserveTopMm = 0,
): { left: number; bottom: number; right: number; top: number } {
  const titleHeight = estimateTextHeightMm(theme.type.axisTitlePt);
  const oneLine = estimateTextHeightMm(theme.type.tickLabelPt);

  // An inward tick takes no gutter at all, so it must not reserve any.
  const yTickGutter =
    node.y.showTicks && node.y.tickDirection !== 'in' ? theme.spacing.tickLengthMm : 0;
  const xTickGutter =
    node.x.showTicks && node.x.tickDirection !== 'in' ? theme.spacing.tickLengthMm : 0;

  /*
   * Vertical (today): the left gutter holds node.y (the value axis) and the
   * bottom gutter holds node.x (the category axis, tilt-truncated as needed).
   * Horizontal: swapped — node.x now runs down the left (one label per row,
   * never tilting — a category owns a whole row rather than a narrow
   * column) and node.y runs along the bottom (a numeric axis, which never
   * tilts either way).
   */
  const horizontal = geometry.kind === 'categorical' && geometry.orientation === 'horizontal';

  const yLabels = node.y.showLabels ? yTickLayout(node, theme, geometry).maxLabelWidth : 0;
  const xCategoryLabels = horizontal
    ? categoryLabelLayout(node, theme, geometry).maxLabelWidth
    : 0;
  /*
   * A centred numeric tick label reaches half its own width past the tick on
   * both ends of the axis; a leading sign reaches half its width further
   * still. Folded into `left`/`right` below the same way every other
   * measured quantity here is, so a wide edge label keeps fitting inside the
   * panel instead of overhanging it now that it is centred rather than
   * anchored inward.
   */
  const bottomNumeric = bottomNumericAxis(node, geometry);
  const edgeOverhang = bottomNumeric
    ? xEdgeOverhangMm(bottomNumeric.axis, bottomNumeric.scale, theme, geometry.plotWidth)
    : { left: 0, right: 0 };
  const left = Math.max(
    horizontal
      ? xTickGutter +
        (node.x.showLabels ? theme.spacing.tickLabelGapMm + xCategoryLabels : 0) +
        (node.x.title ? theme.spacing.axisTitleGapMm + titleHeight : 0)
      : yTickGutter +
        (node.y.showLabels ? theme.spacing.tickLabelGapMm + yLabels : 0) +
        (node.y.title ? theme.spacing.axisTitleGapMm + titleHeight : 0),
    edgeOverhang.left,
  );

  const placement = legendPlacement(node, geometry);
  const legendRow =
    Math.max(LEGEND_SWATCH_MM, estimateTextHeightMm(theme.type.legendPt)) + LEGEND_ROW_GAP_MM;

  /*
   * The width a legend below has to lay itself out in.
   *
   * This must be the `margin.left` the final geometry will carry, not the one
   * measured here, or the reserve budgets a different number of rows from the
   * one drawn. `computePlotGeometry` takes `max(theme, clamped)` of what this
   * function returns, in both the grown and the early-return branch, so
   * repeating that arithmetic here is what makes the two agree.
   */
  const leftUsed = Math.max(
    theme.spacing.plotMarginMm.left,
    Math.min(left, node.frame.width * 0.6),
  );
  const legendRows =
    placement === 'bottom'
      ? legendRowLayout(legendEntries(geometry), theme, Math.max(0, node.frame.width - leftUsed))
          .rows
      : 0;

  const bottom = horizontal
    ? yTickGutter +
      theme.spacing.tickLabelGapMm +
      (node.y.showLabels ? oneLine : 0) +
      (node.y.title ? theme.spacing.axisTitleGapMm + titleHeight : 0) +
      legendRows * legendRow
    : xTickGutter +
      theme.spacing.tickLabelGapMm +
      xLabelLayout(node, theme, geometry).depth +
      (node.x.title ? theme.spacing.axisTitleGapMm + titleHeight : 0) +
    // A legend below sits under the x title; without the reserve it would be
    // drawn past the panel edge onto whatever is beneath.
    legendRows * legendRow;

  /*
   * A secondary axis puts the same furniture on the right, where the theme
   * reserves 2 mm — enough for a label overhanging the last x tick and nothing
   * more. A legend on that side stacks *beyond* it rather than sharing the
   * room: these used to be combined with `Math.max`, so a plot with both drew
   * the key straight over the right-hand tick labels.
   */
  const y2 = y2WidthMm(node, theme, geometry);
  // Mutually exclusive with y2 by construction (`isCascadable` already
  // refuses a second y axis), so this never double-reserves the same room.
  const cascade = geometry.kind === 'continuous' ? cascadeAxisReserveMm(node, theme, geometry.series) : 0;
  const right = Math.max(
    theme.spacing.plotMarginMm.right,
    edgeOverhang.right,
    y2 +
      cascade +
      (placement === 'right'
        ? theme.spacing.tickLabelGapMm + legendWidthMm(legendEntries(geometry), theme)
        : 0),
  );

  // Never take so much that nothing is left to plot in: on a panel too small
  // for its own labels, a crowded axis still reads where a zero-height plot
  // does not. The annotation reserve is capped hardest — a plot squeezed to a
  // sliver so its brackets fit has lost the thing the brackets annotate.
  return {
    left: Math.min(left, node.frame.width * 0.6),
    bottom: Math.min(bottom, node.frame.height * 0.6),
    right: Math.min(right, node.frame.width * 0.3),
    top: Math.min(
      theme.spacing.plotMarginMm.top + reserveTopMm,
      Math.max(theme.spacing.plotMarginMm.top, node.frame.height * 0.35),
    ),
  };
}

/**
 * One arm's Kaplan–Meier curve, in the same `XySeriesMarks` shape every other
 * continuous plot type's series already carries — built directly from
 * `kaplanMeier`'s step output rather than through `xyMarks`, since a subject
 * row is not a pair `xyMarks`'s generic filtering/pairing logic has any
 * reason to know about.
 */
function survivalSeriesMarks(
  name: string,
  color: string,
  steps: readonly SurvivalStep[],
  xScale: NumericScale,
  yScale: NumericScale,
  showCI: boolean,
): XySeriesMarks {
  /*
   * A step function as a bare polyline: hold at the previous survival until
   * the new time, then drop — two vertices per step after the first, rather
   * than any curve/interpolation logic in the renderer. `renderContinuousMarks`
   * already builds every other line this way, from an ordered vertex array.
   */
  const linePath: { x: number; y: number }[] = [];
  steps.forEach((step, i) => {
    const x = xScale.scale(step.time);
    if (!Number.isFinite(x)) return;
    if (i > 0) {
      const holdY = yScale.scale(steps[i - 1]!.survival);
      if (Number.isFinite(holdY)) linePath.push({ x, y: holdY });
    }
    const y = yScale.scale(step.survival);
    if (Number.isFinite(y)) linePath.push({ x, y });
  });

  /*
   * One tick per censoring *time*, at the curve's height right after any
   * event at that same time has already dropped it — not one per censored
   * subject, which would draw indistinguishable overlapping ticks for
   * simultaneous censorings.
   */
  const censorPoints: PointGeometry[] = steps
    .filter((step) => step.censored > 0)
    .map((step) => ({
      x: xScale.scale(step.time),
      y: yScale.scale(step.survival),
      value: step.survival,
    }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  const band: XySeriesMarks['band'] = showCI
    ? steps
        .map((step) => ({
          x: xScale.scale(step.time),
          lowY: yScale.scale(step.lower),
          highY: yScale.scale(step.upper),
        }))
        .filter(
          (p) => Number.isFinite(p.x) && Number.isFinite(p.lowY) && Number.isFinite(p.highY),
        )
    : null;

  return {
    name,
    color,
    points: [],
    linePath: linePath.length > 1 ? linePath : null,
    band: band && band.length > 1 ? band : null,
    capHalfWidthMm: 0,
    replicatePoints: [],
    censorPoints,
    errorLabel: showCI ? '95% CI' : '',
    n: steps.reduce((sum, s) => sum + s.events + s.censored, 0),
    topMm: Math.min(
      linePath.length > 0 ? Math.min(...linePath.map((p) => p.y)) : 0,
      band && band.length > 0 ? Math.min(...band.map((p) => p.highY)) : Infinity,
    ),
    // A survival probability has no "zero" quantity a fill would close
    // against — see the field's own doc comment.
    baselineMm: null,
    baselineXMm: null,
    offsetMm: { x: 0, y: 0 },
  };
}

function survivalGeometryForMargin(
  node: PlotNode,
  groups: readonly SurvivalGroup[],
  margin: PlotGeometryBase['margin'],
): ContinuousPlotGeometry | null {
  const plotWidth = Math.max(0, node.frame.width - margin.left - margin.right);
  const plotHeight = Math.max(0, node.frame.height - margin.top - margin.bottom);
  if (plotWidth <= 0 || plotHeight <= 0) return null;

  const allTimes = groups.flatMap((g) => g.times).filter(Number.isFinite);
  if (allTimes.length === 0) return null;

  const xScale = makeScale({
    domain: resolveDomain(allTimes, {
      min: node.x.min,
      max: node.x.max,
      includeZero: true,
      padFraction: 0.08,
      kind: node.x.scale,
    }),
    rangeMm: [0, plotWidth],
    tickStep: node.x.tickStep,
    kind: node.x.scale,
    ...(node.x.breaks ? { breaks: node.x.breaks } : {}),
    ...labelFormatOptions(node.x),
    ...linthreshOptions(node.x),
  });

  /*
   * A survival probability cannot exceed 1 or fall below 0 — the y domain is
   * a hard construction choice, not a default, and ignores `node.y.min/max`
   * and `node.y.scale` entirely. The Inspector hides those controls for this
   * plot type for the same reason.
   */
  const yScale = makeScale({
    domain: { min: 0, max: 1 },
    rangeMm: [plotHeight, 0],
    tickStep: node.y.tickStep,
    kind: 'linear',
    ...labelFormatOptions(node.y),
    ...linthreshOptions(node.y),
  });

  const colors = paletteColors(node.palette, groups.length);
  const showCI = node.showSurvivalCI === true;
  const series = groups.map((g, i) =>
    survivalSeriesMarks(
      g.name,
      colors[i % Math.max(1, colors.length)] ?? '#000000',
      kaplanMeier(g.times, g.events),
      xScale,
      yScale,
      showCI,
    ),
  );

  return { kind: 'continuous', margin, plotWidth, plotHeight, xScale, yScale, series, bins: [] };
}

/**
 * Geometry for a Kaplan–Meier plot.
 *
 * A subject row is not a replicate to pool or a group to compare, so this
 * never goes through `toSeries` — it reads the dataset via
 * `toSurvivalGroups` and builds its series directly from `kaplanMeier`'s step
 * output. It still returns an ordinary `kind: 'continuous'` geometry: a time
 * axis and a probability axis are exactly what `ContinuousPlotGeometry`
 * already models, unlike a heatmap's axis-less grid, so `renderAxes`,
 * `requiredMargin` and the legend all apply completely unmodified.
 *
 * Its own two-pass margin growth, mirroring `computePlotGeometry`'s own loop
 * rather than sharing it, since that loop calls `toSeries` before this
 * function is ever reached.
 */
function survivalGeometry(
  node: PlotNode,
  dataset: Dataset,
  theme: Theme,
): ContinuousPlotGeometry | null {
  const groups = toSurvivalGroups(dataset);
  if (groups.length === 0) return null;

  const themeMargin = theme.spacing.plotMarginMm;
  const first = survivalGeometryForMargin(node, groups, themeMargin);
  if (!first) return null;

  const needed = requiredMargin(node, theme, first);
  if (
    needed.left <= themeMargin.left + 0.01 &&
    needed.bottom <= themeMargin.bottom + 0.01 &&
    needed.right <= themeMargin.right + 0.01 &&
    needed.top <= themeMargin.top + 0.01
  ) {
    return first;
  }

  const grown = {
    ...themeMargin,
    left: Math.max(themeMargin.left, needed.left),
    bottom: Math.max(themeMargin.bottom, needed.bottom),
    right: Math.max(themeMargin.right, needed.right),
    top: Math.max(themeMargin.top, needed.top),
  };
  return survivalGeometryForMargin(node, groups, grown) ?? first;
}

/**
 * Exported so the Inspector's cascade control can show the same plot area
 * `offsetReserveMm` is about to spend, rather than approximating it from the
 * panel frame and a guessed margin.
 */
export function computePlotGeometry(
  node: PlotNode,
  doc: FigureDocument,
  theme: Theme,
): PlotGeometry | null {
  const dataset = findDataset(doc, node.datasetId);
  if (!dataset) return null;

  /*
   * A grid plot never goes through `series` at all — a heatmap cell is not a
   * replicate to pool or a group to compare, so it reads the matrix directly
   * and does its own two-pass margin growth, mirroring
   * `geometryForMargin`/`requiredMargin`'s pattern rather than sharing it.
   */
  if (GRID_PLOT_TYPES.has(node.plotType)) {
    return heatmapGeometry(node, dataset, theme);
  }

  /*
   * A survival curve never goes through `toSeries` either — a subject row is
   * not a replicate to pool, and `toSeries`'s minimal `'survival'` case
   * carries no event/censoring flag at all. Unlike a heatmap this still
   * returns an ordinary `kind: 'continuous'` geometry, since a time axis and
   * a probability axis are exactly what that shape already models.
   */
  if (node.plotType === 'survival') {
    return survivalGeometry(node, dataset, theme);
  }

  const series = toSeries(dataset);
  if (series.length === 0) return null;

  const themeMargin = theme.spacing.plotMarginMm;
  const first = geometryForMargin(node, series, themeMargin);
  if (!first) return null;

  /*
   * Exactly two passes, never a loop to convergence. Tick *values* are chosen
   * from the axis length, which depends on the margin, which depends on how
   * wide those values print — so the dependency is circular and a loop could
   * oscillate between two label sets. Measuring once against the theme's margin
   * and rebuilding once against the answer terminates by construction, which is
   * what keeps the canvas and the exporter agreeing.
   */
  const needed = requiredMargin(node, theme, first, annotationReserveMm(node, doc, theme));
  if (
    needed.left <= themeMargin.left + 0.01 &&
    needed.bottom <= themeMargin.bottom + 0.01 &&
    needed.right <= themeMargin.right + 0.01 &&
    needed.top <= themeMargin.top + 0.01
  ) {
    return first;
  }

  const grown = {
    ...themeMargin,
    left: Math.max(themeMargin.left, needed.left),
    bottom: Math.max(themeMargin.bottom, needed.bottom),
    right: Math.max(themeMargin.right, needed.right),
    // Room above the marks for the brackets over them. Without it the stack
    // ran off the top of the panel and had to be shoved back down onto the data.
    top: Math.max(themeMargin.top, needed.top),
  };
  return geometryForMargin(node, series, grown) ?? first;
}

/** Style and points for one series of a plot's point cloud, in plot-area-local mm. */
export interface PointCloudSeries {
  color: string;
  shape: PointShape;
  sizeMm: number;
  stroke?: Stroke;
  /**
   * `color` overrides `series.color` per point when set — a volcano plot's
   * significance category, resolved once here rather than a second time in
   * `apps/web`'s `drawPoint`.
   */
  points: { x: number; y: number; color?: string }[];
}

export interface PointCloudPlan {
  nodeId: string;
  widthMm: number;
  heightMm: number;
  /** Sum of every series' points — what the threshold check and the disclosure finding read. */
  count: number;
  series: PointCloudSeries[];
}

/**
 * Plots whose point count exceeds `MAX_VECTOR_POINTS`, and what a raster of
 * their points needs to be.
 *
 * Built from the same `computePlotGeometry` every vector render already goes
 * through, so a baked raster can never disagree with what the vector path
 * would have drawn. Only the continuous arm carries per-point marks at all —
 * a categorical plot's marks are one per category, never one per row, so
 * there is no volume problem there to solve.
 *
 * Style is read exactly the way `renderContinuousMarks`'s `s.points` loop
 * reads it, because every point in a series shares one style — nothing here
 * is a second implementation of that resolution, just the same reads
 * gathered ahead of time for a caller that has no DOM to draw with yet.
 */
export function planPointClouds(doc: FigureDocument, theme: Theme): PointCloudPlan[] {
  const plans: PointCloudPlan[] = [];

  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'plot') continue;
    const geometry = computePlotGeometry(node, doc, theme);
    if (!geometry || geometry.kind !== 'continuous') continue;

    const count = geometry.series.reduce((sum, s) => sum + s.points.length, 0);
    if (count <= MAX_VECTOR_POINTS) continue;

    plans.push({
      nodeId: node.id,
      widthMm: geometry.plotWidth,
      heightMm: geometry.plotHeight,
      count,
      series: geometry.series.map((s, index) => ({
        color: node.pointFill ?? s.color,
        shape: shapeForSeries(node, index) ?? node.pointShape ?? 'circle',
        sizeMm: node.pointSizeMm,
        stroke: node.pointStroke,
        points: s.points.map((p) => {
          const color = resolveVolcanoColor(node, p.category);
          return { x: p.x, y: p.y, ...(color ? { color } : {}) };
        }),
      })),
    });
  }

  return plans;
}

export interface PlotMeasurements {
  categoryX: Map<string, number>;
  categoryTop: Map<string, number>;
}

/**
 * Memoisation for `measurePlot`.
 *
 * It re-runs the whole geometry pass — scales, marks, summary statistics —
 * duplicating the render path on every call. That was tolerable when brackets
 * were measured once at creation; repositioning them on every pointer-move of a
 * resize drag is not.
 *
 * Keyed on object identity, which is sound precisely because edits go through
 * Immer: any change to the plot, its dataset or the theme produces a new object,
 * so a stale entry cannot be hit — it simply misses and recomputes.
 */
const measureCache = new WeakMap<
  PlotNode,
  { dataset: unknown; theme: Theme; result: PlotMeasurements | null }
>();

/**
 * Where a plot's categories actually sit, in coordinates relative to the plot
 * node's own frame. `topMm` is the highest drawn feature of each category, so
 * an annotation can clear the data rather than overlap it.
 */
export function measurePlot(
  doc: FigureDocument,
  plot: PlotNode,
  theme: Theme,
): PlotMeasurements | null {
  const dataset = findDataset(doc, plot.datasetId);

  const cached = measureCache.get(plot);
  if (cached && cached.dataset === dataset && cached.theme === theme) return cached.result;

  const geometry = computePlotGeometry(plot, doc, theme);
  if (!geometry) {
    measureCache.set(plot, { dataset, theme, result: null });
    return null;
  }

  const categoryX = new Map<string, number>();
  const categoryTop = new Map<string, number>();

  /*
   * A continuous plot has no categories to anchor a bracket to, and a
   * horizontal categorical plot has categories running down the side
   * instead of along the bottom — nowhere flat to sit a bracket either.
   * Empty measurements are the honest answer in both cases: `addBracket`
   * then has nothing to place against, and the Stats tab refuses group
   * comparisons on these plots.
   */
  if (geometry.kind !== 'categorical' || geometry.orientation === 'horizontal') {
    const empty: PlotMeasurements = { categoryX, categoryTop };
    measureCache.set(plot, { dataset, theme, result: empty });
    return empty;
  }

  geometry.categories.forEach((name, index) => {
    const mark = geometry.marks[index];
    categoryX.set(name, geometry.margin.left + geometry.band.center(name));
    categoryTop.set(name, geometry.margin.top + (mark?.topMm ?? 0));
  });

  const result: PlotMeasurements = { categoryX, categoryTop };
  measureCache.set(plot, { dataset, theme, result });
  return result;
}

/**
 * Vertical pitch between two brackets stacked over the same bars.
 *
 * A bracket node declares itself 1.2 mm tall, but `renderBracket` draws its
 * label *above* the frame at negative y, so the ink is the frame plus a line of
 * type plus a gap. Placing on the declared height is why consecutive brackets
 * used to be drawn 3.5 mm apart with about half a millimetre between the
 * glyphs — and less than none as soon as the theme's `statisticPt` grew.
 *
 * Measured through the same static tables the axis labels use, so the canvas
 * and the headless exporter stack brackets identically.
 */
export function bracketStepMm(theme: Theme): number {
  return (
    BRACKET_HEIGHT_MM +
    estimateTextHeightMm(theme.type.statisticPt) +
    theme.spacing.bracketGapMm
  );
}

/**
 * Height a plot must keep clear above its marks for the brackets over it.
 *
 * Derived from the *count* of brackets, never from where they were placed. The
 * dependency has to be broken somewhere — placement reads the geometry, and the
 * geometry would read the placement — and a count is the one quantity that does
 * not move when the answer does, so this terminates by construction. It is the
 * same argument the two-pass margin rule rests on.
 */
function annotationReserveMm(node: PlotNode, doc: FigureDocument, theme: Theme): number {
  let count = 0;
  for (const other of Object.values(doc.nodes)) {
    if (other.type === 'bracket' && other.plotId === node.id) count++;
  }
  if (count === 0) return 0;
  return DEFAULT_BRACKET_GAP_MM + count * bracketStepMm(theme);
}

/**
 * Measure every plot in the document, keyed by node id.
 *
 * The bridge for `repositionBrackets`, which lives in `doc-model` and so cannot
 * reach the band scale itself — `doc-model` depends on nothing internal, and
 * importing the renderer there would close a cycle. Measurements travel as data
 * in this direction instead.
 */
export function measureAllPlots(doc: FigureDocument, theme: Theme): Map<string, PlotMeasurements> {
  const out = new Map<string, PlotMeasurements>();
  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'plot') continue;
    const measured = measurePlot(doc, node, theme);
    if (measured) out.set(node.id, measured);
  }
  return out;
}

/**
 * Put every bracket back on its bars, stacked by the theme's own metrics.
 *
 * Every caller wrote `repositionBrackets(draft, measureAllPlots(draft, theme))`
 * and now needs the bracket pitch as well — which only the render package can
 * measure. Nine copies of that pairing is nine places for the pitch to be
 * forgotten, and a forgotten pitch is brackets that overlap again on one screen
 * and not the next. One composition, like `scaleBarWidthMm` and
 * `analysisInputHash`.
 */
export function reflowBrackets(draft: FigureDocument, theme: Theme): void {
  repositionBrackets(draft, measureAllPlots(draft, theme), { stepMm: bracketStepMm(theme) });
}

/** Height of a legend swatch, and the gap between two entries. */
const LEGEND_SWATCH_MM = 1.4;
const LEGEND_ROW_GAP_MM = 0.8;

/** What the legend would list, in draw order. Empty means there is none. */
function legendEntries(geometry: PlotGeometry): { label: string; color: string }[] {
  if (geometry.kind === 'categorical') return geometry.legend;
  // A heatmap's colour key is the colourbar, drawn separately in
  // `renderHeatmapPlot` — it has no discrete entries for this shape at all.
  if (geometry.kind === 'grid') return [];
  // A continuous plot keys on the series themselves: two lines, two names.
  return geometry.series.length > 1
    ? geometry.series.map((s) => ({ label: s.name, color: s.color }))
    : [];
}

/**
 * Whether a legend is drawn, and where.
 *
 * `'auto'` shows one exactly when there is something it alone can say. A
 * single-factor bar chart already names every mark under its band, so a key
 * repeating those names is furniture; a two-factor chart has no other way to
 * tell a reader what the colours mean.
 */
function legendPlacement(node: PlotNode, geometry: PlotGeometry): 'right' | 'bottom' | 'none' {
  const mode = node.legend ?? 'auto';
  if (mode === 'none') return 'none';
  if (mode !== 'auto') return legendEntries(geometry).length > 0 ? mode : 'none';
  return legendEntries(geometry).length > 0 ? 'right' : 'none';
}

/** Width the legend needs when it sits beside the plot. */
function legendWidthMm(
  entries: readonly { label: string }[],
  theme: Theme,
): number {
  if (entries.length === 0) return 0;
  const widest = entries.reduce(
    (max, e) => Math.max(max, estimateTextWidthMm(e.label, theme.type.legendPt)),
    0,
  );
  return LEGEND_SWATCH_MM + theme.spacing.tickLabelGapMm + widest;
}

/**
 * How far the secondary axis's furniture reaches to the right of the plot area.
 *
 * Composed here and nowhere else, for the same reason `scaleBarWidthMm` and
 * `analysisInputHash` are: `requiredMargin` reserves this room and
 * `renderLegend` steps past it, and a second derivation is how a legend comes
 * to be drawn on top of the axis it was supposed to clear.
 *
 * Measured from where `renderSecondaryAxis` actually places things — labels sit
 * at `tickLen + gap` whether or not a tick is drawn there, so the reserve
 * counts the same, which the earlier arithmetic did not.
 */
function y2WidthMm(node: PlotNode, theme: Theme, geometry: PlotGeometry): number {
  if (geometry.kind !== 'continuous' || !geometry.y2Scale || !node.y2) return 0;

  const spec = node.y2;
  const scale = geometry.y2Scale;
  const tickLen = theme.spacing.tickLengthMm;
  const gap = theme.spacing.tickLabelGapMm;

  // Only the ticks that survive the range — an off-range value is never drawn,
  // so reserving room for its label widens the gutter for nothing.
  const widest = spec.showLabels
    ? scale.ticks.reduce((max, tick) => {
        const y = scale.scale(tick);
        if (!Number.isFinite(y) || y < -0.01 || y > geometry.plotHeight + 0.01) return max;
        return Math.max(
          max,
          estimateRunsWidthMm(tickLabelRuns(scale, tick), theme.type.tickLabelPt),
        );
      }, 0)
    : 0;

  const labelsEnd = spec.showLabels ? tickLen + gap + widest : 0;
  const ticksEnd = spec.showTicks ? Math.max(0, tickOffset(spec, tickLen)) : 0;
  const titleEnd = spec.title
    ? tickLen +
      gap +
      widest +
      theme.spacing.axisTitleGapMm +
      estimateTextHeightMm(theme.type.axisTitlePt)
    : 0;

  return Math.max(ticksEnd, labelsEnd, titleEnd);
}

/**
 * Where each entry sits when the legend runs under the plot, and how many rows
 * that takes.
 *
 * The advance is the running sum of the entries *before* each one. It used to
 * be `index * thisEntry.width`, which puts a short label after a long one back
 * on top of it — a two-entry key reading "Control" then "n" drew the second
 * over the first. Rows wrap at the panel edge rather than running off it, since
 * a legend the reader cannot see is the same defect in a different direction.
 */
function legendRowLayout(
  entries: readonly { label: string }[],
  theme: Theme,
  availableMm: number,
): { rows: number; at: { x: number; row: number }[] } {
  const gap = theme.spacing.axisTitleGapMm;
  const at: { x: number; row: number }[] = [];
  let x = 0;
  let row = 0;

  for (const entry of entries) {
    const width = legendWidthMm([entry], theme);
    // The first entry of a row never wraps: a label wider than the whole panel
    // would otherwise wrap forever and still not fit.
    if (x > 0 && x + width > availableMm) {
      row += 1;
      x = 0;
    }
    at.push({ x, row });
    x += width + gap;
  }

  return { rows: row + 1, at };
}

/**
 * The series key.
 *
 * `'legend'` has been a declared `SceneRole` since phase 1 with nothing
 * constructing one — every multi-series figure shipped with no way to tell the
 * series apart except by asking the author. Drawn from the geometry rather than
 * from the dataset so the swatch colour is the colour actually used, which is
 * the one thing a legend must not get wrong.
 */
function renderLegend(
  node: PlotNode,
  theme: Theme,
  geometry: PlotGeometry,
  placement: 'right' | 'bottom',
): SceneNode[] {
  const entries = legendEntries(geometry);
  if (entries.length === 0) return [];

  const { margin, plotWidth, plotHeight } = geometry;
  const rowHeight = Math.max(LEGEND_SWATCH_MM, estimateTextHeightMm(theme.type.legendPt));
  const pitch = rowHeight + LEGEND_ROW_GAP_MM;
  const gap = theme.spacing.tickLabelGapMm;

  // The row layout is computed against the same width `requiredMargin`
  // reserved for it, so the rows it budgeted are the rows drawn.
  const below =
    placement === 'bottom'
      ? legendRowLayout(entries, theme, Math.max(0, node.frame.width - margin.left))
      : null;

  const children: SceneNode[] = [];
  entries.forEach((entry, index) => {
    const y = placement === 'right' ? index * pitch : (below?.at[index]?.row ?? 0) * pitch;
    const x = placement === 'right' ? 0 : (below?.at[index]?.x ?? 0);

    /*
     * The swatch is the *marker* once any series carries its own shape, and a
     * plain block otherwise.
     *
     * Per-series symbols exist to carry the series identity where colour
     * cannot — greyscale print, a colour-vision deficiency — and a key of
     * identical blocks beside different symbols withholds exactly the mapping
     * the reader needs.
     *
     * "Any", not "this one": a series left on the plot-wide shape still draws a
     * marker, so a key of one block and two symbols cannot happen. That case is
     * the common one — an author sets shapes on the series they want to
     * distinguish and leaves the first alone — and it is what drew a block
     * beside a line of circles until a real browser showed it.
     */
    const shape =
      geometry.kind === 'continuous' && (node.pointShapes?.some((s) => s != null) ?? false)
        ? (shapeForSeries(node, index) ?? node.pointShape ?? 'circle')
        : undefined;
    /*
     * The same "any series carries one" rule as the shape swatch above, for
     * the same reason — but scoped to `line`, the only plot type with a
     * connecting line an author can style through the Inspector at all.
     * Composes with the marker rather than replacing it, so a series using
     * both per-series shapes and per-series line styles shows both.
     */
    const lineDash =
      node.plotType === 'line' && (node.lineStyles?.some((s) => s != null) ?? false)
        ? dashArrayFor(lineStyleForSeries(node, index) ?? node.lineStyle ?? 'solid', theme.stroke.dataMm)
        : undefined;
    const drawsLine = node.plotType === 'line' && (node.lineStyles?.some((s) => s != null) ?? false);
    const swatchMarks: SceneNode[] = [];
    if (drawsLine) {
      swatchMarks.push(
        el('path', {
          d: `M${round(x)} ${round(y + rowHeight / 2)} L${round(x + LEGEND_SWATCH_MM)} ${round(y + rowHeight / 2)}`,
          fill: 'none',
          stroke: entry.color,
          'stroke-width': theme.stroke.dataMm,
          'stroke-linecap': 'round',
          ...(lineDash ? { 'stroke-dasharray': lineDash } : {}),
        }, undefined, { role: 'legend' }),
      );
    }
    if (shape) {
      swatchMarks.push(
        markerNode(node, theme, x + LEGEND_SWATCH_MM / 2, y + rowHeight / 2, {
          fill: entry.color,
          sizeMm: LEGEND_SWATCH_MM,
          shape,
          role: 'legend',
        }),
      );
    }
    if (swatchMarks.length === 0) {
      swatchMarks.push(
        el('rect', {
          x,
          y: y + (rowHeight - LEGEND_SWATCH_MM) / 2,
          width: LEGEND_SWATCH_MM,
          height: LEGEND_SWATCH_MM,
          fill: entry.color,
          stroke: 'none',
        }, undefined, { role: 'legend' }),
      );
    }
    children.push(
      ...swatchMarks,
      text(entry.label, {
        x: x + LEGEND_SWATCH_MM + gap,
        // Baseline within the row, matching how tick labels are placed.
        y: y + rowHeight * 0.8,
        'font-family': theme.fontFamily,
        'font-size': ptToMm(theme.type.legendPt),
        fill: theme.foreground,
        'text-anchor': 'start',
      }, { role: 'legend' }),
    );
  });

  // Beside the plot area, vertically centred on it; or beneath the x labels.
  // A secondary axis stands between the plot and the legend, so the legend
  // starts past it — otherwise the key is drawn over the right-hand tick
  // labels, which is exactly what the shared reserve now budgets for.
  const originX =
    placement === 'right'
      ? margin.left + plotWidth + y2WidthMm(node, theme, geometry) + gap
      : margin.left;
  const originY =
    placement === 'right'
      ? margin.top + Math.max(0, (plotHeight - entries.length * pitch) / 2)
      : margin.top + plotHeight + margin.bottom - (below?.rows ?? 1) * pitch;

  return [group({ transform: translate(originX, originY) }, children)];
}

/**
 * Physical `"x y"` for a (band-axis, value-axis) position pair, honouring the
 * plot's orientation — vertical puts the band position in x and the value
 * position in y; horizontal swaps them. Two points that share `bandMm` and
 * differ in `valueMm` therefore draw a stem that is vertical or horizontal
 * automatically; two that share `valueMm` and differ in `bandMm` draw the
 * perpendicular cap the same way — box/violin/error-bar path construction
 * below reads entirely through this one seam.
 */
function xyPoint(orientation: MarkOrientation, bandMm: number, valueMm: number): string {
  const [x, y] = orientation === 'horizontal' ? [valueMm, bandMm] : [bandMm, valueMm];
  return `${round(x)} ${round(y)}`;
}

/** The same band/value → physical placement as `xyPoint`, for a filled rect. */
function rectXY(
  orientation: MarkOrientation,
  bandLowMm: number,
  bandExtentMm: number,
  valueLowMm: number,
  valueExtentMm: number,
): { x: number; y: number; width: number; height: number } {
  return orientation === 'horizontal'
    ? { x: valueLowMm, y: bandLowMm, width: valueExtentMm, height: bandExtentMm }
    : { x: bandLowMm, y: valueLowMm, width: bandExtentMm, height: valueExtentMm };
}

function renderPlot(node: PlotNode, doc: FigureDocument, options: RenderOptions): SceneNode | null {
  const { theme } = options;
  const geometry = computePlotGeometry(node, doc, theme);
  if (!geometry) return null;

  const { margin } = geometry;
  const placement = legendPlacement(node, geometry);
  // Outside the plot-area transform: the legend sits in the panel's margins,
  // not in the data rectangle, so it must not inherit that translation.
  const legend = placement === 'none' ? [] : renderLegend(node, theme, geometry, placement);

  if (geometry.kind === 'continuous') {
    const area = group(
      { transform: translate(margin.left, margin.top) },
      [
        ...renderAxes(node, theme, geometry),
        ...renderGridlines(node, theme, geometry),
        ...renderCascadeAxis(node, theme, geometry),
        ...renderVolcanoThresholds(node, theme, geometry),
        ...renderContinuousMarks(node, theme, geometry, options.pointRasters),
        // After every mark, including the raster: a label emitted inside a
        // series group would paint under a baked point cloud, which is the
        // case that matters most — a real gene list is routinely over
        // MAX_VECTOR_POINTS.
        ...renderPointLabels(node, theme, geometry),
        // Break marks last: the gap is painted in the page colour, so it has to
        // land over the marks it interrupts rather than under them.
        ...renderAxisBreaks(node, theme, geometry),
      ],
      { role: 'plot-area' },
    );
    // No wrapper without a legend: an extra <g> around every existing plot
    // would change markup that is asserted byte for byte.
    return legend.length === 0 ? area : group({}, [area, ...legend]);
  }

  if (geometry.kind === 'grid') {
    // A heatmap draws its own row/column labels and colourbar rather than
    // sharing `renderAxes`/`renderLegend` — neither axis is a value axis, and
    // the colour key is a ramp, not a discrete swatch list. `legend`/`placement`
    // above are always empty for a grid (`legendEntries` excludes it), so the
    // colourbar is placed independently here.
    const area = group(
      { transform: translate(margin.left, margin.top) },
      renderHeatmapPlot(node, theme, geometry),
      { role: 'plot-area' },
    );
    const colorbarPlacement: 'right' | 'bottom' | 'none' =
      node.legend === 'none' ? 'none' : node.legend === 'bottom' ? 'bottom' : 'right';
    const colorbar =
      colorbarPlacement === 'none' ? [] : renderColorbar(node, theme, geometry, colorbarPlacement);
    return colorbar.length === 0 ? area : group({}, [area, ...colorbar]);
  }

  const { marks } = geometry;
  const content: SceneNode[] = [];

  for (const mark of marks) {
    const markChildren: SceneNode[] = [];

    if (mark.bar) {
      markChildren.push(
        el('rect', {
          x: mark.bar.x,
          y: mark.bar.y,
          width: mark.bar.width,
          height: mark.bar.height,
          fill: mark.color,
          stroke: 'none',
        }, undefined, { role: 'bar' }),
      );
    }

    if (mark.violin) {
      const v = mark.violin;
      // Up the right/upper flank, then back down the left/lower, mirrored
      // about the spine — `xyPoint` maps (band, value) to physical (x, y),
      // so the same construction draws a vertical or horizontal violin.
      const right = v.profile.map(
        (p, i) =>
          `${i === 0 ? 'M' : 'L'}${xyPoint(geometry.orientation, v.bandCenterMm + p.halfWidthMm, p.valueMm)}`,
      );
      const left = [...v.profile]
        .reverse()
        .map((p) => `L${xyPoint(geometry.orientation, v.bandCenterMm - p.halfWidthMm, p.valueMm)}`);
      markChildren.push(
        el('path', {
          d: `${right.join(' ')} ${left.join(' ')} Z`,
          fill: mark.color,
          'fill-opacity': 0.55,
          stroke: mark.color,
          'stroke-width': theme.stroke.dataMm,
          'stroke-linejoin': 'round',
        }, undefined, { role: 'violin' }),
      );
    }

    if (mark.box) {
      const b = mark.box;
      const xy = (valueMm: number, bandOffsetMm = 0): string =>
        xyPoint(geometry.orientation, b.bandMm + b.bandWidthMm / 2 + bandOffsetMm, valueMm);
      markChildren.push(
        el('path', {
          d:
            `M${xy(b.q3Mm)} L${xy(b.upperWhiskerMm)} ` +
            `M${xy(b.upperWhiskerMm, -b.capHalfWidthMm)} L${xy(b.upperWhiskerMm, b.capHalfWidthMm)} ` +
            `M${xy(b.q1Mm)} L${xy(b.lowerWhiskerMm)} ` +
            `M${xy(b.lowerWhiskerMm, -b.capHalfWidthMm)} L${xy(b.lowerWhiskerMm, b.capHalfWidthMm)}`,
          fill: 'none',
          stroke: theme.foreground,
          'stroke-width': theme.stroke.errorBarMm,
          'stroke-linecap': 'butt',
        }, undefined, { role: 'whisker' }),
      );
      // The hinges are statistical low/high, not physical-screen positions —
      // min/max of the two picks the physically-lower edge regardless of
      // whether the value axis is inverted (vertical) or not (horizontal).
      markChildren.push(
        el('rect', {
          ...rectXY(
            geometry.orientation,
            b.bandMm,
            b.bandWidthMm,
            Math.min(b.q1Mm, b.q3Mm),
            Math.abs(b.q1Mm - b.q3Mm),
          ),
          fill: mark.color,
          'fill-opacity': 0.55,
          stroke: theme.foreground,
          'stroke-width': theme.stroke.dataMm,
        }, undefined, { role: 'box' }),
      );
      markChildren.push(
        el('path', {
          d: `M${xy(b.medianMm, -b.bandWidthMm / 2)} L${xy(b.medianMm, b.bandWidthMm / 2)}`,
          fill: 'none',
          stroke: theme.foreground,
          // The median is the box plot's headline number; it has to read against
          // the fill rather than disappear into the outline.
          'stroke-width': theme.stroke.dataMm * 1.6,
          'stroke-linecap': 'butt',
        }, undefined, { role: 'line' }),
      );
    }

    if (mark.errorBar) {
      const eb = mark.errorBar;
      const lower = eb.upperOnly ? mark.centerMm : eb.lowMm;
      const xy = (valueMm: number, bandOffsetMm = 0): string =>
        xyPoint(geometry.orientation, eb.bandMm + bandOffsetMm, valueMm);
      markChildren.push(
        el('path', {
          d:
            `M${xy(eb.highMm, -eb.capHalfWidthMm)} L${xy(eb.highMm, eb.capHalfWidthMm)} ` +
            `M${xy(eb.highMm)} L${xy(lower)}` +
            (eb.upperOnly ? '' : ` M${xy(eb.lowMm, -eb.capHalfWidthMm)} L${xy(eb.lowMm, eb.capHalfWidthMm)}`),
          fill: 'none',
          stroke: theme.foreground,
          'stroke-width': theme.stroke.errorBarMm,
          'stroke-linecap': 'butt',
        }, undefined, { role: 'error-bar' }),
      );
    }

    for (const point of mark.points) {
      markChildren.push(
        markerNode(node, theme, point.x, point.y, {
          // Dark points over a coloured bar by default — conventional and
          // legible, but it means recolouring a series leaves the dots alone,
          // so the plot can opt into series-coloured points instead.
          fill:
            node.pointFill ??
            (mark.bar && !node.pointsUseSeriesColor ? theme.foreground : mark.color),
          fillOpacity: mark.bar ? 0.85 : 1,
        }),
      );
    }

    for (const outlier of mark.outliers) {
      const hollow = markerNode(node, theme, outlier.x, outlier.y, {
        // Hollow, so an outlier is never mistaken for a plotted data point in
        // a box-plus-points figure. The outline is forced rather than taken
        // from `pointStroke`: without one the marker would not be there at all.
        fill: 'none',
        forceStroke: { color: theme.foreground, widthMm: theme.stroke.hairlineMinMm },
      });
      markChildren.push({ ...hollow, role: 'outlier' });
    }

    content.push(group({}, markChildren));
  }

  const axes =
    geometry.orientation === 'horizontal'
      ? renderAxesHorizontal(node, theme, geometry)
      : renderAxes(node, theme, geometry);

  const area = group(
    { transform: translate(margin.left, margin.top) },
    [...axes, ...renderGridlines(node, theme, geometry), ...content, ...renderAxisBreaks(node, theme, geometry)],
    { role: 'plot-area' },
  );
  return legend.length === 0 ? area : group({}, [area, ...legend]);
}

/**
 * One replicate marker.
 *
 * Points were always circles. Shape carries a series identity that survives
 * greyscale printing and colour-blind readers, which is exactly the population
 * the palette validator already worries about — so it is worth having, and it
 * belongs in one place rather than at each of the three call sites that draw a
 * point.
 */
/**
 * The marker shape a given series draws, in one place.
 *
 * Undefined rather than `'circle'` where nothing is set, so `markerNode` falls
 * through to `node.pointShape` and a plot that never used per-series shapes
 * emits byte-identical markup.
 */
function shapeForSeries(node: PlotNode, index: number): PointShape | undefined {
  return node.pointShapes?.[index] ?? undefined;
}

/**
 * The line style a given series draws, in one place — the line-drawing
 * counterpart to `shapeForSeries`.
 *
 * Undefined rather than `'solid'` where nothing is set, so the caller falls
 * through to `node.lineStyle` and a plot that never used per-series styles
 * emits byte-identical markup.
 */
function lineStyleForSeries(node: PlotNode, index: number): LineStyle | undefined {
  return node.lineStyles?.[index] ?? undefined;
}

/**
 * The `stroke-dasharray` for a line style, scaled to the stroke width so a
 * dash reads the same shape at any theme's data stroke weight rather than a
 * fixed millimetre literal. `undefined` for `'solid'`, so a plot that never
 * touches line style — the overwhelming majority — gets no
 * `stroke-dasharray` attribute at all, not an empty or trivial one; the
 * caller's spread pattern (`...(dashArray ? {...} : {})`) is what keeps that
 * byte-identical to today.
 *
 * Dotted reuses the round linecap every line path already draws with: a
 * zero-length dash under `stroke-linecap: round` paints as a filled circle
 * the width of the stroke, so `'0 <gap>'` is a row of round dots rather than
 * a row of literal, invisible dashes (which would need a butt cap to vanish,
 * and would vanish if it got one).
 */
function dashArrayFor(style: LineStyle, strokeWidthMm: number): string | undefined {
  switch (style) {
    case 'dashed':
      return `${round(strokeWidthMm * 3)} ${round(strokeWidthMm * 2)}`;
    case 'dotted':
      return `0 ${round(strokeWidthMm * 2.2)}`;
    case 'dash-dot':
      return `${round(strokeWidthMm * 3)} ${round(strokeWidthMm * 2)} 0 ${round(strokeWidthMm * 2)}`;
    case 'solid':
      return undefined;
  }
}

/**
 * Chosen to survive both greyscale print and the common red-green colour-vision
 * deficiency — the classic up/down convention is exactly the classic failure
 * case, so the default deliberately isn't red/green.
 */
export const DEFAULT_VOLCANO_COLORS: Record<VolcanoCategory, string> = {
  down: '#4575b4',
  ns: '#999999',
  up: '#d73027',
};

/**
 * A volcano point's colour, from its significance category — called from both
 * the vector path (`renderContinuousMarks`) and the raster path
 * (`planPointClouds`), in this one place, so the two cannot drift on what
 * colour a point gets. Only the resolved hex string crosses into `apps/web`'s
 * `pointRasters.ts`, as plain data on `PointCloudSeries.points[].color` — no
 * volcano-specific logic needs to live outside `packages/render`.
 */
function resolveVolcanoColor(node: PlotNode, category: string | undefined): string | undefined {
  if (category !== 'up' && category !== 'down' && category !== 'ns') return undefined;
  return { ...DEFAULT_VOLCANO_COLORS, ...node.volcanoColors }[category];
}

/**
 * The conventional dashed fold-change/p-value cutoff lines. In scope because
 * the cutoffs are already mandatory `PlotNode` state — needed for colouring
 * regardless — so drawing them is cheap, and it is what makes a coloured
 * scatter actually read as a volcano plot.
 */
function renderVolcanoThresholds(
  node: PlotNode,
  theme: Theme,
  geometry: PlotGeometry,
): SceneNode[] {
  if (node.plotType !== 'volcano' || geometry.kind !== 'continuous') return [];
  if (node.volcanoThresholdLines === 'hide') return [];
  const t = node.volcanoThresholds ?? DEFAULT_VOLCANO_THRESHOLDS;

  const dashAttrs = {
    fill: 'none',
    stroke: theme.foreground,
    'stroke-width': theme.stroke.hairlineMinMm,
    'stroke-dasharray': '1.5 1',
    'stroke-opacity': 0.5,
  };

  const lines: SceneNode[] = [];
  for (const fc of [-t.foldChange, t.foldChange]) {
    const x = geometry.xScale.scale(fc);
    if (!Number.isFinite(x)) continue;
    lines.push(
      el(
        'path',
        { d: `M${round(x)} 0 L${round(x)} ${round(geometry.plotHeight)}`, ...dashAttrs },
        undefined,
        { role: 'threshold-line' },
      ),
    );
  }
  const yCut = geometry.yScale.scale(negLog10(t.pValue));
  if (Number.isFinite(yCut)) {
    lines.push(
      el(
        'path',
        { d: `M0 ${round(yCut)} L${round(geometry.plotWidth)} ${round(yCut)}`, ...dashAttrs },
        undefined,
        { role: 'threshold-line' },
      ),
    );
  }
  return lines;
}

/**
 * Which points get a label, in the order `layoutPointLabels` should place
 * them — sorted by the DATA, never by the order the author clicked: most
 * significant first, so it wins the best slot and survives the cap if one
 * binds. So canvas and export agree, and re-selecting the same set in a
 * different order changes nothing on the page.
 */
function volcanoLabelCandidates(node: PlotNode, geometry: ContinuousPlotGeometry): LabelCandidate[] {
  if (node.plotType !== 'volcano') return [];
  const wanted = node.volcanoLabels;
  if (!wanted || wanted.length === 0) return [];
  const wantedSet = new Set(wanted);

  const series = geometry.series[0];
  if (!series) return [];

  const matches = series.points.filter((p) => p.label !== undefined && wantedSet.has(p.label));
  matches.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value; // descending -log10(p)
    const aFc = Math.abs(geometry.xScale.invert(a.x));
    const bFc = Math.abs(geometry.xScale.invert(b.x));
    if (bFc !== aFc) return bFc - aFc; // descending |fold change|
    return (a.label ?? '').localeCompare(b.label ?? '');
  });

  return matches.map((p) => ({
    x: p.x,
    y: p.y,
    text: p.label!,
    color: node.pointFill ?? resolveVolcanoColor(node, p.category) ?? series.color,
  }));
}

/** A placed label after any manual `pointLabelOffsets` displacement has been
 *  applied and its leader recomputed against the final position. */
interface ResolvedPointLabel {
  text: string;
  color: string;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Plot-area-local mm — the box collision was (or, for a manually-offset
   *  label, would have been) checked against. */
  rect: Rect;
}

/**
 * Auto-places this volcano plot's requested point labels, then applies any
 * manual `pointLabelOffsets` on top — the "auto base, stored delta" split
 * `BracketNode.userOffsetMm` already uses, so a later change to which labels
 * are shown re-runs the collision search cleanly and a dragged label's own
 * nudge re-applies to whatever slot it lands in.
 *
 * The single place both the drawing path (`renderPointLabels`) and the
 * canvas's drag hit-testing (`placedPointLabelsForPlot`) go through, so
 * neither can compute a different answer from the other.
 */
function resolvePointLabels(node: PlotNode, theme: Theme, geometry: ContinuousPlotGeometry): ResolvedPointLabel[] {
  const candidates = volcanoLabelCandidates(node, geometry);
  if (candidates.length === 0) return [];

  const fontSizePt = node.pointLabelSizePt ?? theme.type.annotationPt;
  const pointRadiusMm = node.pointSizeMm / 2;

  // A label can only ever land within `pointRadiusMm + GAP + maxPushMm` of its
  // own point, so pre-filter the plot's (possibly 10,000+-row) point cloud
  // down to that neighbourhood before handing it to `layoutPointLabels` as an
  // obstacle set — cheap coordinate comparisons only, preserving that
  // module's own "bounded by labels, never by plot size" invariant.
  const maxPushMm = Math.min(12, 0.4 * Math.min(geometry.plotWidth, geometry.plotHeight));
  const reach = pointRadiusMm + 0.6 + maxPushMm;
  const x0 = Math.min(...candidates.map((c) => c.x)) - reach;
  const x1 = Math.max(...candidates.map((c) => c.x)) + reach;
  const y0 = Math.min(...candidates.map((c) => c.y)) - reach;
  const y1 = Math.max(...candidates.map((c) => c.y)) + reach;
  const wantedSet = new Set(candidates.map((c) => c.text));
  const series = geometry.series[0];
  const otherPointsMm = (series?.points ?? [])
    .filter((p) => p.label === undefined || !wantedSet.has(p.label))
    .filter((p) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1)
    .map((p) => ({ x: p.x, y: p.y }));

  const { placed } = layoutPointLabels(candidates, {
    fontSizePt,
    plotWidth: geometry.plotWidth,
    plotHeight: geometry.plotHeight,
    pointRadiusMm,
    otherPointsMm,
  });

  const offsets = node.pointLabelOffsets ?? {};
  return placed.map((label): ResolvedPointLabel => {
    const off = offsets[label.text];
    if (!off) return label;
    const rect: Rect = {
      x0: label.rect.x0 + off.x,
      x1: label.rect.x1 + off.x,
      y0: label.rect.y0 + off.y,
      y1: label.rect.y1 + off.y,
    };
    const x = label.x + off.x;
    const y = label.y + off.y;
    const candidate = candidates.find((c) => c.text === label.text);
    const px = candidate?.x ?? label.x;
    const py = candidate?.y ?? label.y;
    // Never stored — always the segment from the point to the nearest edge
    // of the *offset* rect, so dragging a label always moves its leader with
    // it. Once a manual offset exists a leader always draws, regardless of
    // whether the auto layout considered this placement "adjacent": showing
    // which point a moved label belongs to matters more once it's been
    // dragged away from the auto-chosen spot next to it.
    const edge = nearestRectPoint(rect, px, py);
    return { text: label.text, color: label.color, x, y, anchor: label.anchor, leader: { x1: px, y1: py, x2: edge.x, y2: edge.y }, rect };
  });
}

/**
 * Drawn point names — currently volcano only, gated inside
 * `volcanoLabelCandidates` itself. Returns `[]` whenever `volcanoLabels` is
 * absent, so an existing figure that never used this is untouched byte for
 * byte.
 *
 * Above `MAX_VECTOR_POINTS` this still works with no extra code: rasterizing
 * only skips the per-point *marker* loop in `renderContinuousMarks` —
 * `geometry.series[].points` (and every point's `.label`) is fully populated
 * either way, which is what a real gene list needs, since it is routinely
 * well over that threshold.
 */
function renderPointLabels(node: PlotNode, theme: Theme, geometry: ContinuousPlotGeometry): SceneNode[] {
  const fontSizePt = node.pointLabelSizePt ?? theme.type.annotationPt;
  const out: SceneNode[] = [];
  for (const label of resolvePointLabels(node, theme, geometry)) {
    if (label.leader) {
      out.push(
        el(
          'path',
          {
            d: `M${round(label.leader.x1)} ${round(label.leader.y1)} L${round(label.leader.x2)} ${round(label.leader.y2)}`,
            fill: 'none',
            stroke: label.color,
            'stroke-width': theme.stroke.hairlineMinMm,
            'stroke-dasharray': '0.5 0.5',
          },
          undefined,
          { role: 'point-label-leader' },
        ),
      );
    }
    out.push(
      text(
        label.text,
        {
          x: label.x,
          y: label.y,
          'font-family': theme.fontFamily,
          'font-size': ptToMm(fontSizePt),
          fill: label.color,
          'text-anchor': label.anchor,
          'dominant-baseline': 'central',
        },
        { role: 'point-label' },
      ),
    );
  }
  return out;
}

/**
 * Every labellable point on a volcano plot, in PANEL-local millimetres — the
 * plot's own margin already added, so the app never re-derives the
 * plot-area transform, the same one-place rule `y2WidthMm`/`scaleBarWidthMm`
 * already follow. Used by the canvas's point-picking overlay, which is HTML
 * above the SVG and never scene nodes, per the crop/measure precedent.
 */
export interface PickablePoint {
  xMm: number;
  yMm: number;
  label: string;
  radiusMm: number;
  labelled: boolean;
}

export function pickablePointsForPlot(node: PlotNode, doc: FigureDocument, theme: Theme): PickablePoint[] {
  const geometry = computePlotGeometry(node, doc, theme);
  if (!geometry || geometry.kind !== 'continuous' || node.plotType !== 'volcano') return [];
  const series = geometry.series[0];
  if (!series) return [];

  const wanted = new Set(node.volcanoLabels ?? []);
  const radiusMm = node.pointSizeMm / 2;
  return series.points
    .filter((p): p is typeof p & { label: string } => p.label !== undefined)
    .map((p) => ({
      xMm: geometry.margin.left + p.x,
      yMm: geometry.margin.top + p.y,
      label: p.label,
      radiusMm,
      labelled: wanted.has(p.label),
    }));
}

/**
 * Every currently-placed point label's bounding box, in PANEL-local mm — the
 * drag analogue of `pickablePointsForPlot`. Goes through the same
 * `resolvePointLabels` the drawing path uses, so the app never re-derives
 * placement or manual-offset math, the same one-place rule
 * `y2WidthMm`/`scaleBarWidthMm` already follow.
 */
export interface PlacedPointLabel {
  text: string;
  rectMm: Rect;
  anchor: 'start' | 'middle' | 'end';
}

export function placedPointLabelsForPlot(node: PlotNode, doc: FigureDocument, theme: Theme): PlacedPointLabel[] {
  const geometry = computePlotGeometry(node, doc, theme);
  if (!geometry || geometry.kind !== 'continuous' || node.plotType !== 'volcano') return [];
  return resolvePointLabels(node, theme, geometry).map((label) => ({
    text: label.text,
    anchor: label.anchor,
    rectMm: {
      x0: geometry.margin.left + label.rect.x0,
      x1: geometry.margin.left + label.rect.x1,
      y0: geometry.margin.top + label.rect.y0,
      y1: geometry.margin.top + label.rect.y1,
    },
  }));
}

function markerNode(
  node: PlotNode,
  theme: Theme,
  cx: number,
  cy: number,
  style: {
    fill: string;
    fillOpacity?: number;
    forceStroke?: { color: string; widthMm: number };
    /**
     * Override the plot's point size — for replicates drawn behind their own
     * mean. Absent is `node.pointSizeMm`, so every existing call is unchanged,
     * and the radius stays the one input every shape is area-matched from.
     */
    sizeMm?: number;
    /**
     * Override the plot's marker shape — for a series carrying its own. Absent
     * is `node.pointShape`, so every existing call is unchanged.
     */
    shape?: PointShape;
    /**
     * What the mark *is*. `'point'` everywhere but the legend key, which draws
     * the same shapes so the swatch matches the marker it stands for — and
     * which must not be counted as a data point by anything reading roles.
     */
    role?: SceneRole;
    /**
     * Point identity, e.g. a gene name — drawn as a native SVG `<title>` child
     * rather than any app-level tooltip mechanism, so it costs nothing on
     * export and needs no DOM/interaction code in `packages/render`. Only
     * meaningful below `MAX_VECTOR_POINTS`: past it, points bake into one
     * raster with no per-point node to attach a title to.
     */
    label?: string;
  },
): SceneNode {
  const r = (style.sizeMm ?? node.pointSizeMm) / 2;
  const stroke = style.forceStroke ?? node.pointStroke;
  const strokeAttrs = stroke
    ? { stroke: stroke.color, 'stroke-width': stroke.widthMm }
    : { stroke: 'none' };
  const common = {
    fill: style.fill,
    ...(style.fillOpacity !== undefined ? { 'fill-opacity': style.fillOpacity } : {}),
    ...strokeAttrs,
  };

  const role: SceneRole = style.role ?? 'point';
  const titleChildren: SceneNode[] | undefined =
    style.label !== undefined ? [{ tag: 'title', text: style.label }] : undefined;

  switch (style.shape ?? node.pointShape ?? 'circle') {
    case 'square': {
      // Every shape is matched on *area* to the circle of the same nominal
      // size, so switching shape does not silently change how heavy a series
      // looks on the page.
      const side = r * Math.sqrt(Math.PI);
      return el(
        'rect',
        {
          x: round(cx - side / 2),
          y: round(cy - side / 2),
          width: round(side),
          height: round(side),
          ...common,
        },
        titleChildren,
        { role },
      );
    }
    case 'triangle': {
      // Equilateral, centroid on the point, area matched to the circle.
      const side = r * Math.sqrt((4 * Math.PI) / Math.sqrt(3));
      const height = (side * Math.sqrt(3)) / 2;
      const d =
        `M${round(cx)} ${round(cy - (2 / 3) * height)} ` +
        `L${round(cx + side / 2)} ${round(cy + height / 3)} ` +
        `L${round(cx - side / 2)} ${round(cy + height / 3)} Z`;
      return el('path', { d, ...common }, titleChildren, { role });
    }
    case 'triangle-down': {
      // Same formula as 'triangle', flipped so the apex points down.
      const side = r * Math.sqrt((4 * Math.PI) / Math.sqrt(3));
      const height = (side * Math.sqrt(3)) / 2;
      const d =
        `M${round(cx)} ${round(cy + (2 / 3) * height)} ` +
        `L${round(cx + side / 2)} ${round(cy - height / 3)} ` +
        `L${round(cx - side / 2)} ${round(cy - height / 3)} Z`;
      return el('path', { d, ...common }, titleChildren, { role });
    }
    case 'diamond': {
      const half = r * Math.sqrt(Math.PI / 2);
      const d =
        `M${round(cx)} ${round(cy - half)} L${round(cx + half)} ${round(cy)} ` +
        `L${round(cx)} ${round(cy + half)} L${round(cx - half)} ${round(cy)} Z`;
      return el('path', { d, ...common }, titleChildren, { role });
    }
    case 'pentagon': {
      // Regular pentagon, area-matched: for a regular n-gon with circumradius
      // R, area = (n/2) R^2 sin(2pi/n); solved for R at n=5, the same
      // area-match rule 'triangle'/'diamond' apply in closed form for n=3/n=4.
      const rPent = r * Math.sqrt((2 * Math.PI) / (5 * Math.sin((2 * Math.PI) / 5)));
      const pts: string[] = [];
      for (let k = 0; k < 5; k++) {
        const angle = ((-90 + k * 72) * Math.PI) / 180;
        pts.push(
          `${k === 0 ? 'M' : 'L'}${round(cx + rPent * Math.cos(angle))} ${round(cy + rPent * Math.sin(angle))}`,
        );
      }
      return el('path', { d: pts.join(' ') + ' Z', ...common }, titleChildren, { role });
    }
    case 'cross': {
      // A filled plus sign: 12 vertices, arm width a third of the total span
      // (the proportion a filled-plus marker conventionally uses). Two arms
      // of length L and width w=L/3 overlap in a w×w square, so
      // area = 2Lw - w^2 = 5L^2/9; solved for L at area = pi r^2.
      const span = 3 * r * Math.sqrt(Math.PI / 5);
      const half = span / 2;
      const armHalf = span / 6;
      const d =
        `M${round(cx + armHalf)} ${round(cy - half)} ` +
        `L${round(cx + armHalf)} ${round(cy - armHalf)} ` +
        `L${round(cx + half)} ${round(cy - armHalf)} ` +
        `L${round(cx + half)} ${round(cy + armHalf)} ` +
        `L${round(cx + armHalf)} ${round(cy + armHalf)} ` +
        `L${round(cx + armHalf)} ${round(cy + half)} ` +
        `L${round(cx - armHalf)} ${round(cy + half)} ` +
        `L${round(cx - armHalf)} ${round(cy + armHalf)} ` +
        `L${round(cx - half)} ${round(cy + armHalf)} ` +
        `L${round(cx - half)} ${round(cy - armHalf)} ` +
        `L${round(cx - armHalf)} ${round(cy - armHalf)} ` +
        `L${round(cx - armHalf)} ${round(cy - half)} Z`;
      return el('path', { d, ...common }, titleChildren, { role });
    }
    case 'star': {
      // Five-point star (pentagram), area-matched. Inner/outer radius ratio
      // is the classic golden-ratio pentagram construction, (3-sqrt5)/2;
      // outer radius solved from area = 5 * Ro * Ri * sin(pi/5) = pi r^2.
      const innerRatio = (3 - Math.sqrt(5)) / 2;
      const outerR = r * Math.sqrt(Math.PI / (5 * innerRatio * Math.sin(Math.PI / 5)));
      const innerR = outerR * innerRatio;
      const pts: string[] = [];
      for (let k = 0; k < 10; k++) {
        const radius = k % 2 === 0 ? outerR : innerR;
        const angle = ((-90 + k * 36) * Math.PI) / 180;
        pts.push(
          `${k === 0 ? 'M' : 'L'}${round(cx + radius * Math.cos(angle))} ${round(cy + radius * Math.sin(angle))}`,
        );
      }
      return el('path', { d: pts.join(' ') + ' Z', ...common }, titleChildren, { role });
    }
    default:
      return el('circle', { cx, cy, r, ...common }, titleChildren, { role });
  }
}

/** Scatter points, line paths and histogram bars. */
function renderContinuousMarks(
  node: PlotNode,
  theme: Theme,
  geometry: ContinuousPlotGeometry,
  pointRasters?: ReadonlyMap<string, string>,
): SceneNode[] {
  const content: SceneNode[] = [];

  for (const bin of geometry.bins) {
    content.push(
      el('rect', {
        x: bin.x,
        y: bin.y,
        width: bin.width,
        height: bin.height,
        fill: paletteColors(node.palette, 1)[0] ?? theme.foreground,
        stroke: theme.background,
        'stroke-width': theme.stroke.hairlineMinMm,
      }, undefined, { role: 'bar' }),
    );
  }

  /*
   * Above MAX_VECTOR_POINTS, every series' `s.points` loop below is skipped
   * and one pre-baked raster (or, while it is still baking, a placeholder)
   * stands in for all of them at once — see `planPointClouds`. Summed here
   * rather than by calling `planPointClouds` again: this function is already
   * handed the `geometry` that function would have to recompute, so the
   * cheaper reduce keeps the below-threshold path a true no-op.
   */
  const totalPoints = geometry.series.reduce((sum, s) => sum + s.points.length, 0);
  const rasterizePoints = totalPoints > MAX_VECTOR_POINTS;

  /*
   * A cascade paints furthest-offset first, so a nearer trace occludes the
   * ones behind it — reversed here rather than by building `geometry.series`
   * in reverse, which would misindex the palette/`seriesAxis` lookups below.
   * Guarded on `cascading`, so the emitted order — and therefore the exported
   * markup — is untouched on every figure that does not use this.
   */
  const cascading = hasCascadeOffset(node, geometry.series.length);
  const order = cascading
    ? [...geometry.series.entries()].reverse()
    : [...geometry.series.entries()];

  for (const [index, s] of order) {
    const markChildren: SceneNode[] = [];
    // Indexed by series order, the key the palette and `seriesAxis` already use.
    const shape = shapeForSeries(node, index);

    /*
     * A cascade's own fill down to its baseline, first, so the band/line/
     * points that follow paint on top of it. Opaque by construction — see
     * `PlotNode.offsetFill`'s own doc comment for why a translucent fill
     * would be self-defeating here.
     */
    if (
      cascading &&
      node.offsetFill &&
      node.offsetFill !== 'none' &&
      s.baselineMm !== null &&
      s.linePath &&
      s.linePath.length > 1
    ) {
      const fill =
        node.offsetFill === 'solid' ? s.color : interpolateColor(0.3, [theme.background, s.color]);
      const first = s.linePath[0]!;
      const last = s.linePath[s.linePath.length - 1]!;
      const d =
        `M${round(first.x)} ${round(s.baselineMm)} ` +
        s.linePath.map((p) => `L${round(p.x)} ${round(p.y)}`).join(' ') +
        ` L${round(last.x)} ${round(s.baselineMm)} Z`;
      markChildren.push(el('path', { d, fill, stroke: 'none' }, undefined, { role: 'area' }));
    }

    /*
     * The error interval, first, so the line and its points sit on top of it.
     *
     * Band and bars are two drawings of the same numbers — `XySeriesMarks.band`
     * holds the interval edges precisely so the renderer decides how to close
     * them. Only `'band'` fills; anything else, including an absent setting,
     * draws capped bars, which is what the Inspector has always said it would.
     */
    if (s.band && s.band.length > 1 && (node.errorDisplay === 'band' || node.plotType === 'survival')) {
      /*
       * One closed polygon — up the upper edge and back along the lower —
       * rather than a ribbon per segment: two adjacent translucent shapes would
       * double their alpha where they meet and print as a seam at every
       * timepoint.
       */
      const upper = s.band.map(
        (p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.highY)}`,
      );
      const lower = [...s.band].reverse().map((p) => `L${round(p.x)} ${round(p.lowY)}`);
      markChildren.push(
        el('path', {
          d: `${upper.join(' ')} ${lower.join(' ')} Z`,
          fill: s.color,
          // The same alpha the violin and box marks use, and measured through
          // EPS as pixel-identical, so the vector claim is unaffected.
          'fill-opacity': 0.25,
          stroke: 'none',
        }, undefined, { role: 'error-bar' }),
      );
    } else if (s.band && s.band.length > 0) {
      const cap = s.capHalfWidthMm;
      for (const p of s.band) {
        markChildren.push(
          el('path', {
            d:
              `M${round(p.x - cap)} ${round(p.highY)} L${round(p.x + cap)} ${round(p.highY)} ` +
              `M${round(p.x)} ${round(p.highY)} L${round(p.x)} ${round(p.lowY)} ` +
              `M${round(p.x - cap)} ${round(p.lowY)} L${round(p.x + cap)} ${round(p.lowY)}`,
            fill: 'none',
            /*
             * The series colour, not `theme.foreground`. On a bar chart the bar
             * underneath says which group a black whisker belongs to; here
             * several series share the plot area with nothing behind them, so
             * identical black bars would not say whose spread they are.
             *
             * `errorBarDirection: 'up'` is ignored for the reason already
             * recorded on the field: with no bar to hide the lower half behind,
             * half a whisker is just missing data.
             */
            stroke: s.color,
            'stroke-width': theme.stroke.errorBarMm,
            'stroke-linecap': 'butt',
          }, undefined, { role: 'error-bar' }),
        );
      }
    }

    /*
     * Every replicate, over the band rather than under it — at 0.25 alpha the
     * fill washes out anything drawn beneath — and under the line and the means,
     * which carry the reading. Smaller and part-transparent for the same reason.
     */
    for (const point of s.replicatePoints) {
      markChildren.push(
        markerNode(node, theme, point.x, point.y, {
          fill: s.color,
          fillOpacity: 0.45,
          sizeMm: node.pointSizeMm * 0.6,
          ...(shape ? { shape } : {}),
        }),
      );
    }

    if (s.linePath && s.linePath.length > 1) {
      const lineDashArray = dashArrayFor(
        lineStyleForSeries(node, index) ?? node.lineStyle ?? 'solid',
        theme.stroke.dataMm,
      );
      markChildren.push(
        el('path', {
          d: s.linePath
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${round(p.x)} ${round(p.y)}`)
            .join(' '),
          fill: 'none',
          stroke: s.color,
          'stroke-width': theme.stroke.dataMm,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
          ...(lineDashArray ? { 'stroke-dasharray': lineDashArray } : {}),
        }, undefined, { role: 'line' }),
      );
    }

    if (!rasterizePoints) {
      for (const point of s.points) {
        markChildren.push(
          markerNode(node, theme, point.x, point.y, {
            fill: node.pointFill ?? resolveVolcanoColor(node, point.category) ?? s.color,
            ...(shape ? { shape } : {}),
            ...(point.label !== undefined ? { label: point.label } : {}),
          }),
        );
      }
    }

    /*
     * A short tick where a subject left the curve without an event — what
     * makes a Kaplan–Meier curve honest about follow-up loss. Absent is
     * `true`, the opposite default from `showReplicates`/`showCellValues`:
     * this is what the mark exists to disclose, not clutter to opt into.
     */
    if (node.plotType === 'survival' && node.showCensorMarks !== false) {
      const halfHeightMm = node.pointSizeMm / 2;
      for (const point of s.censorPoints) {
        markChildren.push(
          el('path', {
            d:
              `M${round(point.x)} ${round(point.y - halfHeightMm)} ` +
              `L${round(point.x)} ${round(point.y + halfHeightMm)}`,
            fill: 'none',
            stroke: s.color,
            'stroke-width': theme.stroke.dataMm,
            'stroke-linecap': 'round',
          }, undefined, { role: 'censor-mark' }),
        );
      }
    }

    content.push(group({}, markChildren));
  }

  if (rasterizePoints) {
    const href = pointRasters?.get(node.id);
    content.push(
      href
        ? el('image', {
            href,
            x: 0,
            y: 0,
            width: geometry.plotWidth,
            height: geometry.plotHeight,
            // Unlike a micrograph, points must stay smooth under scaling —
            // 'pixelated' is deliberately not set here.
          }, undefined, { role: 'point-cloud' })
        : // Bake pending, or never requested. Mirrors `renderImage`'s "no
          // href yet" placeholder — a plot never silently shows zero points
          // while a raster is in flight. Export always awaits its bake first
          // (see `bakeAllPointClouds`), so this branch is screen-only.
          el('rect', {
            x: 0,
            y: 0,
            width: geometry.plotWidth,
            height: geometry.plotHeight,
            fill: '#f2f2f2',
            stroke: '#bbbbbb',
            'stroke-width': 0.2,
            'stroke-dasharray': '1 1',
          }, undefined, { role: 'point-cloud' }),
    );
  }

  return content;
}

/**
 * Ticks and labels for a numeric x axis.
 *
 * The mirror of the y axis's thinning rule, measured by *width* rather than
 * height — and, like it, measured through the static tables in `text-width.ts`.
 * Measuring in the browser would thin labels on screen and leave them
 * overlapping in the export, which is precisely the divergence the DOM-free
 * invariant exists to prevent.
 */
/**
 * The conventional break marks: two short parallel zig-zags across the axis,
 * with the gap between them painted in the page colour so the axis line, and
 * any bar crossing it, is visibly interrupted rather than merely covered.
 */
function breakMarks(
  scale: NumericScale,
  theme: Theme,
  axis: 'y' | 'x',
  across: number,
): SceneNode[] {
  const out: SceneNode[] = [];
  const stroke = {
    stroke: theme.foreground,
    'stroke-width': theme.stroke.axisMm,
    fill: 'none',
    'stroke-linejoin': 'round',
  };
  const zig = 1.1;

  for (const gap of scale.breaks ?? []) {
    const lo = Math.min(gap.startMm, gap.endMm);
    const hi = Math.max(gap.startMm, gap.endMm);

    if (axis === 'y') {
      out.push(
        el('rect', { x: -theme.spacing.tickLengthMm, y: round(lo), width: round(across + theme.spacing.tickLengthMm), height: round(hi - lo), fill: theme.background, stroke: 'none' }),
      );
      for (const y of [lo, hi]) {
        out.push(
          el('path', {
            d: `M${round(-theme.spacing.tickLengthMm)} ${round(y + zig / 2)} L${round(zig)} ${round(y - zig / 2)}`,
            ...stroke,
          }, undefined, { role: 'axis-break' }),
        );
      }
    } else {
      out.push(
        el('rect', { x: round(lo), y: 0, width: round(hi - lo), height: round(across + theme.spacing.tickLengthMm), fill: theme.background, stroke: 'none' }),
      );
      for (const x of [lo, hi]) {
        out.push(
          el('path', {
            d: `M${round(x - zig / 2)} ${round(across + theme.spacing.tickLengthMm)} L${round(x + zig / 2)} ${round(across - zig)}`,
            ...stroke,
          }, undefined, { role: 'axis-break' }),
        );
      }
    }
  }
  return out;
}

/**
 * The right-hand axis: the same furniture as the left, mirrored.
 *
 * Its ticks and labels sit outside the plot on the right, so `requiredMargin`
 * grows `margin.right` to hold them — the theme reserves only 2 mm there,
 * which is enough for a label overhanging the last x tick and nothing else.
 */
function renderSecondaryAxis(
  node: PlotNode,
  theme: Theme,
  scale: NumericScale,
  plotWidth: number,
  plotHeight: number,
): SceneNode[] {
  const spec = node.y2!;
  const out: SceneNode[] = [];
  const tickLen = theme.spacing.tickLengthMm;
  const tickLabelPt = theme.type.tickLabelPt;
  const axisStroke = { stroke: theme.foreground, 'stroke-width': theme.stroke.axisMm, fill: 'none' };

  if (spec.showLine) {
    out.push(
      el('path', { d: `M${round(plotWidth)} 0 L${round(plotWidth)} ${round(plotHeight)}`, ...axisStroke }, undefined, { role: 'axis' }),
    );
  }

  const visible = scale.ticks.filter((t) => {
    const y = scale.scale(t);
    return Number.isFinite(y) && y >= -0.01 && y <= plotHeight + 0.01;
  });

  let widest = 0;
  for (const tick of visible) {
    const y = scale.scale(tick);
    if (spec.showTicks) {
      out.push(
        el('path', { d: `M${round(plotWidth)} ${round(y)} L${round(plotWidth + tickOffset(spec, tickLen))} ${round(y)}`, ...axisStroke }, undefined, { role: 'tick' }),
      );
    }
    if (spec.showLabels) {
      const runs = tickLabelRuns(scale, tick);
      widest = Math.max(widest, estimateRunsWidthMm(runs, tickLabelPt));
      out.push(
        tickLabelNode(runs, tickLabelPt, {
          x: plotWidth + tickLen + theme.spacing.tickLabelGapMm,
          y,
          'font-family': theme.fontFamily,
          'font-size': ptToMm(tickLabelPt),
          fill: theme.foreground,
          'text-anchor': 'start',
          'dominant-baseline': 'central',
        }),
      );
    }
  }

  if (spec.title) {
    const x = plotWidth + tickLen + theme.spacing.tickLabelGapMm + widest + theme.spacing.axisTitleGapMm;
    out.push(
      text(spec.title, {
        x: 0,
        y: 0,
        // Rotated the other way from the left title, so it reads from the
        // outside of the page rather than upside down against it.
        transform: `translate(${round(x)} ${round(plotHeight / 2)}) rotate(90)`,
        'font-family': theme.fontFamily,
        'font-size': ptToMm(theme.type.axisTitlePt),
        fill: theme.foreground,
        'text-anchor': 'middle',
        'dominant-baseline': 'alphabetic',
      }, { role: 'axis-title', editTarget: 'y2.title' }),
    );
  }

  return out;
}

/**
 * Break marks for whichever of a plot's axes carry them.
 *
 * Typed against the two axis-bearing kinds, not the full `PlotGeometry`
 * union: a heatmap has no numeric axis to break, and is never passed here —
 * `renderPlot`'s grid branch calls `renderHeatmapPlot` instead.
 */
function renderAxisBreaks(
  node: PlotNode,
  theme: Theme,
  geometry: CategoricalPlotGeometry | ContinuousPlotGeometry,
): SceneNode[] {
  // `geometry.yScale` is always "the value axis" — physical y when vertical,
  // physical x when horizontal — so its break marks follow the same swap
  // every other value-axis draw call makes.
  const valueAxisPhysical = geometry.kind === 'categorical' && geometry.orientation === 'horizontal' ? 'x' : 'y';
  const valueAxisExtent =
    valueAxisPhysical === 'x' ? geometry.plotHeight : geometry.plotWidth;
  const out = breakMarks(geometry.yScale, theme, valueAxisPhysical, valueAxisExtent);
  if (geometry.kind === 'continuous') {
    out.push(...breakMarks(geometry.xScale, theme, 'x', geometry.plotHeight));
  }
  return out;
}

/**
 * Signed tick length. Positive points away from the plot, which is how most
 * journals draw them; `tickDirection: 'in'` reverses it, and the label offsets
 * stay outside either way so an inward tick never pushes text into the data.
 */
function tickOffset(axis: AxisSpec, tickLen: number): number {
  return axis.tickDirection === 'in' ? -tickLen : tickLen;
}

/**
 * A tick label as one `<text>` — plain when there is a single unraised run,
 * and a `<text>` with `<tspan>` children when a run needs a superscript.
 *
 * `dy` plus a reduced `font-size`, never `baseline-shift`: that attribute is
 * deprecated in SVG 2 and Firefox has never implemented it, so a figure would
 * look right in Chromium and print flat elsewhere — and the export path
 * (headless Chromium) and the canvas would then disagree, which is exactly
 * the divergence the DOM-free invariant exists to prevent. `renderText`
 * already sets the `dy` precedent for multi-line text.
 *
 * The single-run branch emits literally what `text(...)` emitted before this
 * function existed, so every label that never asks for a superscript is
 * byte-identical.
 */
function tickLabelNode(
  runs: readonly TickLabelRun[],
  fontSizePt: number,
  attrs: SceneAttrs,
  role: SceneRole = 'tick-label',
): SceneNode {
  if (runs.length <= 1 && !runs[0]?.sup) {
    return text(runs[0]?.text ?? '', attrs, { role });
  }

  const supMm = ptToMm(superscriptSizePt(fontSizePt));

  // `dy` is relative to the previous tspan's baseline, not absolute — a run
  // after a superscript has to carry a compensating positive `dy` or it
  // stays raised, and every run after that stairsteps further. `currentRise`
  // is the only state this needs to get that right.
  let currentRise = 0;
  const children = runs.map((run) => {
    const target = run.sup ? -superscriptRiseMm(runs, fontSizePt) : 0;
    const dy = target - currentRise;
    currentRise = target;
    return el(
      'tspan',
      { ...(dy !== 0 ? { dy } : {}), ...(run.sup ? { 'font-size': supMm } : {}) },
      undefined,
      { text: run.text, ...(run.sup ? { role: 'tick-label-sup' as SceneRole } : {}) },
    );
  });

  return el('text', attrs, children, { role });
}

/**
 * Which x ticks are visible, and how many of their labels actually get drawn
 * before neighbours would touch — the bottom-axis counterpart to
 * `yTickLayout`. Shared by `renderNumericBottomAxis`, which draws them, and
 * `xEdgeOverhangMm`, which sizes the margin to hold them; two copies of this
 * arithmetic would drift, and the symptom would be a label that fits the
 * margin the renderer reserved but not the one it actually drew against.
 */
function xBottomAxisLayout(
  axis: AxisSpec,
  scale: NumericScale,
  theme: Theme,
  plotWidth: number,
): { visible: number[]; stride: number } {
  const tickLabelPt = theme.type.tickLabelPt;
  const visible = scale.ticks.filter(
    (tick) => scale.scale(tick) >= -0.01 && scale.scale(tick) <= plotWidth + 0.01,
  );
  if (visible.length === 0) return { visible, stride: 1 };

  const widest = visible.reduce(
    (max, tick) => Math.max(max, estimateRunsWidthMm(tickLabelRuns(scale, tick), tickLabelPt)),
    0,
  );
  // A gap of a quarter of the widest label keeps neighbours from touching.
  const maxLabels = widest > 0 ? Math.max(2, Math.floor(plotWidth / (widest * 1.25))) : visible.length;
  const stride = visible.length > maxLabels ? Math.ceil(visible.length / maxLabels) : 1;
  return { visible, stride };
}

/**
 * How far a centred first/last x tick label would reach past the plot area's
 * left/right edge, in millimetres — `0` on each side with nothing to
 * overhang. Centering (rather than the old inward start/end anchoring) means
 * a wide edge label's *digits* reach half their own width past the tick, and
 * a leading sign reaches half its width further still; `requiredMargin` folds
 * this into the same margin it already reserves, so the label keeps fitting
 * inside the panel rather than overhanging it.
 */
function xEdgeOverhangMm(
  axis: AxisSpec,
  scale: NumericScale,
  theme: Theme,
  plotWidth: number,
): { left: number; right: number } {
  if (!axis.showLabels) return { left: 0, right: 0 };
  const { visible } = xBottomAxisLayout(axis, scale, theme, plotWidth);
  if (visible.length === 0) return { left: 0, right: 0 };
  const tickLabelPt = theme.type.tickLabelPt;
  const widthsOf = (tick: number): { sign: number; digits: number } => {
    const runs = tickLabelRuns(scale, tick);
    const full = estimateRunsWidthMm(runs, tickLabelPt);
    const sign = leadingSignWidthMm(runs, tickLabelPt);
    return { sign, digits: full - sign };
  };
  const first = widthsOf(visible[0]!);
  const last = widthsOf(visible[visible.length - 1]!);
  return { left: first.sign + first.digits / 2, right: last.digits / 2 };
}

/**
 * The bottom-drawn numeric axis for a plot geometry, if it has one — `node.x`
 * for a continuous plot, `node.y` once a horizontal categorical plot flips it
 * to the bottom, or `null` for a vertical categorical plot's band axis, which
 * has no numeric labels to overhang. Mirrors `renderAxisBreaks`'s own
 * `valueAxisPhysical` split so the two never disagree about which axis is
 * "the numeric one along the bottom" for a given geometry.
 */
function bottomNumericAxis(
  node: PlotNode,
  geometry: CategoricalPlotGeometry | ContinuousPlotGeometry,
): { axis: AxisSpec; scale: NumericScale } | null {
  if (geometry.kind === 'continuous') return { axis: node.x, scale: geometry.xScale };
  if (geometry.orientation === 'horizontal') return { axis: node.y, scale: geometry.yScale };
  return null;
}

/**
 * A numeric axis drawn along the bottom, ticks pointing down. Used by every
 * continuous plot's x axis, and by a horizontal categorical plot's value
 * axis (`node.y`, drawn along the bottom once orientation flips) — taking
 * the scale/axis/extent directly rather than a whole `ContinuousPlotGeometry`
 * is what lets both callers share this one implementation.
 */
function renderNumericBottomAxis(
  theme: Theme,
  axis: AxisSpec,
  scale: NumericScale,
  plotWidth: number,
  plotHeight: number,
): SceneNode[] {
  const out: SceneNode[] = [];
  const tickLen = theme.spacing.tickLengthMm;
  const tickLabelPt = theme.type.tickLabelPt;
  const axisStroke = { stroke: theme.foreground, 'stroke-width': theme.stroke.axisMm, fill: 'none' };

  const { visible, stride } = xBottomAxisLayout(axis, scale, theme, plotWidth);
  if (visible.length === 0) return out;

  if (axis.showTicks) {
    // Minor ticks first, so a major tick is never drawn over by one.
    for (const value of minorTickValues(scale, visible, axis.minorTicks)) {
      const x = scale.scale(value);
      if (x < -0.01 || x > plotWidth + 0.01) continue;
      out.push(
        el('path', {
          d: `M${round(x)} ${round(plotHeight)} L${round(x)} ${round(plotHeight + tickOffset(axis, tickLen) * 0.55)}`,
          ...axisStroke,
        }, undefined, { role: 'tick' }),
      );
    }
  }

  visible.forEach((tick, index) => {
    const x = scale.scale(tick);

    if (axis.showTicks) {
      out.push(
        el('path', {
          d: `M${round(x)} ${round(plotHeight)} L${round(x)} ${round(plotHeight + tickOffset(axis, tickLen))}`,
          ...axisStroke,
        }, undefined, { role: 'tick' }),
      );
    }

    // Ticks stay put; only their labels thin out, so the scale still reads.
    if (!axis.showLabels || index % stride !== 0) return;

    const runs = tickLabelRuns(scale, tick);
    // Centred on the tick, but on the *digits* alone: a leading sign hangs
    // further left, outside the centred span, rather than pulling the whole
    // label — sign included — off-centre from the tick it belongs to.
    const signShift = leadingSignWidthMm(runs, tickLabelPt) / 2;
    out.push(
      tickLabelNode(runs, tickLabelPt, {
        x: x - signShift,
        // A superscript rises *above* the label's own baseline, so without
        // this the raised exponent on a wide power10 axis would grow upward
        // into the tick gap rather than sitting inside the label's own room.
        y:
          plotHeight +
          tickLen +
          theme.spacing.tickLabelGapMm +
          ptToMm(tickLabelPt) * 0.8 +
          superscriptRiseMm(runs, tickLabelPt),
        'font-family': theme.fontFamily,
        'font-size': ptToMm(tickLabelPt),
        fill: theme.foreground,
        'text-anchor': 'middle',
      }),
    );
  });

  return out;
}

/**
 * Which y ticks get a label, and how wide the widest one prints.
 *
 * Shared by `renderAxes`, which draws them, and `requiredMargin`, which sizes
 * the gutter to hold them. Two copies of this arithmetic would drift, and the
 * symptom would be labels that fit the gutter the renderer reserved but not the
 * one the geometry was built with.
 */
function yTickLayout(
  node: PlotNode,
  theme: Theme,
  geometry: CategoricalPlotGeometry | ContinuousPlotGeometry,
): { visibleTicks: number[]; stride: number; maxLabelWidth: number } {
  const { yScale, plotHeight } = geometry;
  const tickLabelPt = theme.type.tickLabelPt;

  // Thin the ticks until their labels stop colliding vertically. The tick count
  // is chosen from the axis length alone (`tickCountForLength`), so a short axis
  // still asks for more ticks than its labels can occupy.
  const visibleTicks = yScale.ticks.filter(
    (tick) => yScale.scale(tick) >= -0.01 && yScale.scale(tick) <= plotHeight + 0.01,
  );
  const labelHeight = estimateTextHeightMm(tickLabelPt);
  const maxLabels =
    labelHeight > 0 ? Math.max(2, Math.floor(plotHeight / (labelHeight * 1.25))) : visibleTicks.length;
  const stride = visibleTicks.length > maxLabels ? Math.ceil(visibleTicks.length / maxLabels) : 1;

  let maxLabelWidth = 0;
  visibleTicks.forEach((tick, index) => {
    if (index % stride !== 0) return;
    maxLabelWidth = Math.max(
      maxLabelWidth,
      estimateRunsWidthMm(tickLabelRuns(yScale, tick), tickLabelPt),
    );
  });

  return { visibleTicks, stride, maxLabelWidth };
}

/**
 * Which category labels print down the left in horizontal orientation, and
 * how wide the widest one is. The horizontal-axis mirror of `yTickLayout`:
 * one label per row, never rotated — a category owns a full row of vertical
 * room (its band's own height) rather than a narrow column the way a
 * category under the bottom axis does, so there is no tilt-vs-truncate
 * tradeoff to make here the way `xLabelLayout` makes for the vertical case.
 * Shared by `requiredMargin`, which sizes the left gutter from it, and the
 * horizontal axis renderer, which draws them.
 */
function categoryLabelLayout(
  node: PlotNode,
  theme: Theme,
  geometry: CategoricalPlotGeometry,
): { maxLabelWidth: number } {
  if (!node.x.showLabels) return { maxLabelWidth: 0 };
  const tickLabelPt = theme.type.tickLabelPt;
  const maxLabelWidth = geometry.axisCategories.reduce(
    (max, name) => Math.max(max, estimateTextWidthMm(name, tickLabelPt)),
    0,
  );
  return { maxLabelWidth };
}

/**
 * How the x labels sit and how far below the axis they reach.
 *
 * Categorical labels tilt when they outgrow their band; numeric ones are always
 * horizontal, so their depth is one line. Shared with `requiredMargin` for the
 * same reason as `yTickLayout`.
 */
function xLabelLayout(
  node: PlotNode,
  theme: Theme,
  geometry: CategoricalPlotGeometry | ContinuousPlotGeometry,
): { angle: 0 | 45 | 90; budget: number; depth: number } {
  const tickLabelPt = theme.type.tickLabelPt;
  const oneLine = estimateTextHeightMm(tickLabelPt);

  if (geometry.kind !== 'categorical' || !node.x.showLabels) {
    // A numeric x axis's superscript (a 'scientific'/'power10' exponent)
    // grows *upward* from the label's own baseline — `renderNumericBottomAxis`
    // pushes the label down to compensate, so the gutter has to be sized for
    // that same extra reach, or the reserved room and the drawn label disagree.
    const rise =
      geometry.kind === 'continuous' && node.x.showLabels
        ? Math.max(
            0,
            ...geometry.xScale.ticks.map((t) =>
              superscriptRiseMm(tickLabelRuns(geometry.xScale, t), tickLabelPt),
            ),
          )
        : 0;
    return { angle: 0, budget: Infinity, depth: node.x.showLabels ? oneLine + rise : 0 };
  }

  // The band the labels are *drawn* against: for a two-factor plot that is the
  // outer one, whose slots are much wider than the sub-bands the marks sit in.
  // Measuring the sub-band would angle labels that comfortably fit.
  const { axisBand, axisCategories } = geometry;
  // Adding a dataset re-runs auto-layout and narrows every panel, so the slot
  // a category label has to fit in shrinks. Measure before drawing.
  const slot = axisBand.step;
  const widest = axisCategories.reduce(
    (max, name) => Math.max(max, estimateTextWidthMm(name, tickLabelPt)),
    0,
  );
  /*
   * Angle the whole axis or none of it — an axis mixing horizontal and angled
   * labels reads as a mistake even when each label individually fits.
   *
   * Two angles, because one is not enough. At 45° neighbouring baselines are
   * only slot × √2 apart, so on a really narrow panel every name would have to
   * be truncated to two or three characters — worse than the overlap it set
   * out to fix, since a cut-off category name can be genuinely ambiguous.
   * At 90° the labels are stacked side by side and the clearance stops
   * depending on the label length at all, so any name fits.
   */
  const angle: 0 | 45 | 90 = widest > slot * Math.SQRT2 ? 90 : widest > slot ? 45 : 0;

  /*
   * Upright labels are bounded by the room below the axis, not by their
   * neighbours. The theme's bottom margin is sized for horizontal labels and
   * is far too tight for these, so allow them a share of the panel instead — a
   * deep label gutter is the accepted cost of long category names, and
   * truncating the names would defeat the point.
   *
   * A share of the *panel*, not of the plot area: the plot area now shrinks to
   * make room for exactly these labels, so measuring against it would feed the
   * depth back into the budget and cut the names the second pass was meant to
   * fit.
   */
  const budget =
    angle === 90 ? Math.max(slot, node.frame.height * 0.45) : angle === 45 ? slot * Math.SQRT2 : slot;

  if (angle === 0) return { angle, budget, depth: oneLine };

  const longest = axisCategories.reduce(
    (max, name) =>
      Math.max(max, estimateTextWidthMm(truncateToWidth(name, tickLabelPt, budget), tickLabelPt)),
    0,
  );
  // Angled text descends by its own length × sin(angle), plus a line.
  const sin = angle === 90 ? 1 : Math.SQRT1_2;
  return { angle, budget, depth: longest * sin + oneLine };
}

/**
 * The front→back displacement of a cascading line plot, read directly from
 * the offset-baked `baselineMm`/`baselineXMm` already on the first and last
 * series — never re-derived from `effectiveOffsetStepsMm`/`offsetReserveMm`
 * internals, so this can't disagree with where the marks themselves drew.
 * `{0,0}` for a single series, which callers never hit anyway (guarded by
 * `hasCascadeOffset`, which already requires more than one series).
 */
function cascadeBackOffsetMm(
  series: readonly { baselineMm: number | null; baselineXMm: number | null }[],
): { x: number; y: number } {
  const first = series[0]!;
  const last = series[series.length - 1]!;
  return {
    x: (last.baselineXMm ?? 0) - (first.baselineXMm ?? 0),
    y: (last.baselineMm ?? 0) - (first.baselineMm ?? 0),
  };
}

/**
 * The top and right lines that complete `node.boxed`'s rectangle. The same
 * two segments regardless of orientation — they close the plot area, not
 * either axis specifically — so `renderAxes` and `renderAxesHorizontal`
 * share this rather than each drawing their own copy that could drift apart.
 *
 * `backOffset` shifts the box to the back plane of a cascading line plot —
 * see `cascadeBackOffsetMm` — so the box encloses the *back-most* series'
 * own window rather than the whole canvas. Defaults to `{0,0}`, which
 * reduces both lines to exactly today's formula, so every non-cascading
 * `boxed` figure is untouched.
 */
function renderBoxedBorder(
  node: PlotNode,
  plotWidth: number,
  plotHeight: number,
  axisStroke: SceneAttrs,
  backOffset: { x: number; y: number } = { x: 0, y: 0 },
): SceneNode[] {
  if (!node.boxed) return [];
  return [
    el('path', { d: `M${round(backOffset.x)} 0 L${round(plotWidth)} 0`, ...axisStroke }, undefined, { role: 'axis' }),
    el(
      'path',
      {
        d: `M${round(plotWidth)} 0 L${round(plotWidth)} ${round(plotHeight + backOffset.y)}`,
        ...axisStroke,
      },
      undefined,
      { role: 'axis' },
    ),
  ];
}

/**
 * A reference line at every visible tick of the value axis, beneath the
 * marks. Reuses `yTickLayout`/`xBottomAxisLayout`'s own tick lists verbatim,
 * the same ones `renderAxes`/`renderNumericBottomAxis` draw against, so a
 * gridline can never drift from the tick it belongs to.
 *
 * Only the value axis is ever gridded — a categorical band axis has no
 * continuous scale to grid against in either orientation, mirroring
 * `renderAxisBreaks`'s own `valueAxisPhysical` split: this reads `yScale`
 * (whichever physical direction the value axis currently maps to) and, on a
 * continuous plot, `xScale` as well.
 *
 * On a cascading line plot, each of these lines is instead drawn diagonally
 * — parallel to the cascade's own front→back offset (`cascadeBackOffsetMm`)
 * — from its front-axis tick position to the matching position on the
 * back-most series' plane. A flat line here would visibly drift from where
 * the offset actually placed the data; the reference image this feature was
 * built against (a 3D/oblique cascade chart) draws exactly this receding
 * grid, at tick density rather than series density.
 *
 * That plane is then drawn as a wall: a flat line per value tick continuing
 * each diagonal, closed along its top and right edges. The wall is grid
 * chrome and takes the gridline colour/style; the second copy of the *axes*
 * standing on it is not — see `renderCascadeBackAxes`.
 */
const GRIDLINE_BLEND = 0.15; // Lighter than offsetFill's 0.3 fill blend — a
// hairline stroke has far less retinal area than a filled region, so it
// needs a lower blend to read as equally "muted" without vanishing.

/**
 * `node.gridlineColor`'s resolved stroke. Absent/`'grey'` is exactly today's
 * blend, so an existing figure is byte-identical; `'black'` is the theme's
 * plain foreground, for a grid that reads as a firmer reference.
 */
function gridlineStrokeColor(node: Pick<PlotNode, 'gridlineColor'>, theme: Theme): string {
  return node.gridlineColor === 'black'
    ? theme.foreground
    : interpolateColor(GRIDLINE_BLEND, [theme.background, theme.foreground]);
}

/**
 * `node.gridlineStyle`'s resolved dash pattern. `'dashed'` is exactly
 * today's literal (`'1.5 1'`, independent of stroke width, unlike
 * `dashArrayFor`'s line-style formula) so the existing cascade default is
 * byte-identical. `'dotted'` needs a round linecap to paint as dots rather
 * than vanish — see `dashArrayFor`'s own note on the same idiom — added only
 * for that style, so `'solid'`/`'dashed'` gain no new attribute.
 */
function gridlineDashArray(style: GridlineStyle): { dasharray?: string; linecap?: string } {
  switch (style) {
    case 'solid':
      return {};
    case 'dashed':
      return { dasharray: '1.5 1' };
    case 'dotted':
      return { dasharray: '0 0.9', linecap: 'round' };
  }
}

function renderGridlines(
  node: PlotNode,
  theme: Theme,
  geometry: CategoricalPlotGeometry | ContinuousPlotGeometry,
): SceneNode[] {
  if (!node.showGridlines) return [];
  const { plotWidth, plotHeight, yScale } = geometry;
  const out: SceneNode[] = [];

  // On a cascading line plot, a flat tick-aligned line would visibly drift
  // from where the offset actually placed the data — see the module-level
  // note on `cascadeBackOffsetMm`. Every tick instead gets one line running
  // parallel to the cascade's own diagonal, from its front-axis position to
  // the matching position on the back-most series' plane — reference lines
  // for a 3D cascade, not a flat grid. Density follows tick count, not
  // series count: this is a receding grid, not a per-series marker. Absent
  // `gridlineStyle`, cascading defaults to dashed and an ordinary plot to
  // solid — today's automatic choice, preserved for a figure that never sets
  // the field.
  const cascading = geometry.kind === 'continuous' && hasCascadeOffset(node, geometry.series.length);
  const style = node.gridlineStyle ?? (cascading ? 'dashed' : 'solid');
  const { dasharray, linecap } = gridlineDashArray(style);
  const stroke = {
    stroke: gridlineStrokeColor(node, theme),
    'stroke-width': theme.stroke.hairlineMinMm,
    fill: 'none',
    ...(dasharray ? { 'stroke-dasharray': dasharray } : {}),
    ...(linecap ? { 'stroke-linecap': linecap } : {}),
  };
  const line = (d: string): SceneNode => el('path', { d, ...stroke }, undefined, { role: 'gridline' });

  const backOffset = cascading ? cascadeBackOffsetMm((geometry as ContinuousPlotGeometry).series) : null;

  const horizontal = geometry.kind === 'categorical' && geometry.orientation === 'horizontal';
  const { visibleTicks } = yTickLayout(node, theme, geometry);
  /*
   * Front tick positions, rounded once. The diagonals below, the back wall's
   * flat lines and `renderCascadeBackAxes`' ticks all derive their back-plane
   * coordinate from these same numbers, so the three land on each other
   * *exactly* rather than a rounding step apart: `round(round(p) + offset)`
   * and `round(p + offset)` are not the same number.
   */
  const yPos = visibleTicks.map((tick) => round(yScale.scale(tick)));
  const xPos =
    geometry.kind === 'continuous'
      ? xBottomAxisLayout(node.x, geometry.xScale, theme, plotWidth).visible.map((tick) =>
          round((geometry as ContinuousPlotGeometry).xScale.scale(tick)),
        )
      : [];

  for (const pos of yPos) {
    if (backOffset) {
      out.push(line(`M0 ${pos} L${round(backOffset.x)} ${round(pos + backOffset.y)}`));
    } else {
      out.push(
        line(
          horizontal
            ? `M${pos} 0 L${pos} ${round(plotHeight)}`
            : `M0 ${pos} L${round(plotWidth)} ${pos}`,
        ),
      );
    }
  }

  for (const x of xPos) {
    if (backOffset) {
      out.push(
        line(`M${x} ${round(plotHeight)} L${round(x + backOffset.x)} ${round(plotHeight + backOffset.y)}`),
      );
    } else {
      out.push(line(`M${x} 0 L${x} ${round(plotHeight)}`));
    }
  }

  // The back wall, and then the second axes standing on it. Automatic
  // whenever cascading, independent of `node.boxed`: that field draws its own
  // (optionally back-offset) rectangle on request, which simply overdraws the
  // frame below in the firmer axis stroke.
  if (backOffset) {
    const left = round(backOffset.x);
    const right = round(plotWidth);
    const bottom = round(plotHeight + backOffset.y);
    const yBack = yPos.map((pos) => round(pos + backOffset.y));
    const xBack = xPos.map((pos) => round(pos + backOffset.x));

    // Flat lines across the wall, one per value tick — each the continuation
    // of that tick's diagonal, which lands exactly on its left end. Only the
    // value axis is gridded, here as on a flat plot: no verticals.
    for (const y of yBack) out.push(line(`M${left} ${y} L${right} ${y}`));
    // Top and right edges close it, so the receding grid reads as a 3D box
    // rather than a loose fan of diagonals.
    out.push(line(`M${left} 0 L${right} 0`));
    out.push(line(`M${right} 0 L${right} ${bottom}`));

    // Last, so the solid pair paints over the dashed wall it closes.
    out.push(...renderCascadeBackAxes(node, theme, left, right, bottom, yBack, xBack));
  }

  return out;
}

/**
 * A second copy of the front L-axis — left value axis and bottom x axis, with
 * tick marks but no tick labels and no titles — standing on the back plane of
 * a cascading line plot, which is exactly where every diagonal reference line
 * from `renderGridlines` lands.
 *
 * Takes the already-rounded back-plane tick *positions* its caller computed
 * for the diagonals rather than re-deriving them from the scales, so a back
 * tick cannot end up anywhere other than at the far end of its own diagonal.
 * Major visible ticks only, since that is the set the diagonals were drawn
 * for: a minor tick has no diagonal, so one here would put a mark on the back
 * axis with no counterpart in the grid.
 *
 * The spans are the back *plane*'s own window, not the translated front axis
 * *lines*: those deliberately run the full canvas (`[0, plotHeight]`,
 * `[0, plotWidth]`), which shifted by the cascade offset would hang off the
 * panel. `left = backOffset.x`, `bottom = plotHeight + backOffset.y`,
 * `top = 0` and `right = plotWidth` are the back-most series' real bounds —
 * see `cascadeBackOffsetMm` — so nothing here needs a margin reservation
 * beyond the outward tick overhang the front axes already reserve for.
 */
function renderCascadeBackAxes(
  node: PlotNode,
  theme: Theme,
  left: number,
  right: number,
  bottom: number,
  yTicks: readonly number[],
  xTicks: readonly number[],
): SceneNode[] {
  const tickLen = theme.spacing.tickLengthMm;
  const axisStroke = { stroke: theme.foreground, 'stroke-width': theme.stroke.axisMm, fill: 'none' };
  // One role for the lines and their ticks, the same way 'cascade-axis' covers
  // the depth axis's spine, ticks and brackets. What matters is that it stays
  // distinct from 'axis'/'tick'/'gridline', so a role-count assertion for any
  // of those is never silently widened by this schematic second axis.
  const seg = (d: string): SceneNode =>
    el('path', { d, ...axisStroke }, undefined, { role: 'cascade-back-axis' });

  const out: SceneNode[] = [];

  // Gated per axis on the front axis's own switches: a second copy of an axis
  // the author turned off would be a control that visibly does nothing.
  if (node.y.showLine) out.push(seg(`M${left} 0 L${left} ${bottom}`));
  if (node.y.showTicks) {
    for (const y of yTicks) {
      out.push(seg(`M${round(left - tickOffset(node.y, tickLen))} ${y} L${left} ${y}`));
    }
  }
  if (node.x.showLine) out.push(seg(`M${left} ${bottom} L${right} ${bottom}`));
  if (node.x.showTicks) {
    for (const x of xTicks) {
      out.push(seg(`M${x} ${bottom} L${x} ${round(bottom + tickOffset(node.x, tickLen))}`));
    }
  }
  return out;
}

/**
 * Typed against the two axis-bearing kinds, not the full `PlotGeometry`
 * union — a heatmap draws its own row/column labels in `renderHeatmapPlot`
 * rather than sharing this function, since it has no numeric axis on either
 * side for this to draw ticks against.
 */
function renderAxes(
  node: PlotNode,
  theme: Theme,
  geometry: CategoricalPlotGeometry | ContinuousPlotGeometry,
): SceneNode[] {
  const { yScale, plotWidth, plotHeight } = geometry;
  const out: SceneNode[] = [];
  const tickLen = theme.spacing.tickLengthMm;
  const axisStroke = { stroke: theme.foreground, 'stroke-width': theme.stroke.axisMm, fill: 'none' };

  // --- y axis -------------------------------------------------------------
  if (node.y.showLine) {
    const first = yScale.ticks[0];
    const last = yScale.ticks[yScale.ticks.length - 1];
    const yTop = node.y.trimToData && last !== undefined ? yScale.scale(last) : 0;
    const yBottom = node.y.trimToData && first !== undefined ? yScale.scale(first) : plotHeight;
    out.push(
      el('path', { d: `M0 ${round(yTop)} L0 ${round(yBottom)}`, ...axisStroke }, undefined, { role: 'axis' }),
    );
  }

  const tickLabelPt = theme.type.tickLabelPt;

  const { visibleTicks, stride, maxLabelWidth: maxTickLabelWidth } = yTickLayout(
    node,
    theme,
    geometry,
  );

  if (node.y.showTicks) {
    for (const value of minorTickValues(yScale, visibleTicks, node.y.minorTicks)) {
      const y = yScale.scale(value);
      if (y < -0.01 || y > plotHeight + 0.01) continue;
      out.push(
        el('path', { d: `M${round(-tickOffset(node.y, tickLen) * 0.55)} ${round(y)} L0 ${round(y)}`, ...axisStroke }, undefined, { role: 'tick' }),
      );
    }
  }

  if (node.y.showTicks || node.y.showLabels) {
    visibleTicks.forEach((tick, index) => {
      const y = yScale.scale(tick);
      // Ticks stay put; only their labels thin out, so the scale still reads.
      const labelled = index % stride === 0;

      if (node.y.showTicks) {
        out.push(
          el('path', { d: `M${round(-tickOffset(node.y, tickLen))} ${round(y)} L0 ${round(y)}`, ...axisStroke }, undefined, { role: 'tick' }),
        );
      }
      if (node.y.showLabels && labelled) {
        out.push(
          tickLabelNode(tickLabelRuns(yScale, tick), tickLabelPt, {
            x: -(tickLen + theme.spacing.tickLabelGapMm),
            y,
            'font-family': theme.fontFamily,
            'font-size': ptToMm(tickLabelPt),
            fill: theme.foreground,
            'text-anchor': 'end',
            'dominant-baseline': 'central',
          }),
        );
      }
    });
  }

  if (node.y.title) {
    // Cleared past the widest tick label rather than a constant, which long
    // values (say 12500) would otherwise run straight into.
    const x = -(
      tickLen +
      theme.spacing.tickLabelGapMm +
      maxTickLabelWidth +
      theme.spacing.axisTitleGapMm
    );
    out.push(
      text(node.y.title, {
        x: 0,
        y: 0,
        // Rotated about the axis midpoint so the title stays centred.
        transform: `translate(${round(x)} ${round(plotHeight / 2)}) rotate(-90)`,
        'font-family': theme.fontFamily,
        'font-size': ptToMm(theme.type.axisTitlePt),
        fill: theme.foreground,
        'text-anchor': 'middle',
        'dominant-baseline': 'alphabetic',
      }, { role: 'axis-title', editTarget: 'y.title' }),
    );
  }

  // --- secondary y axis ----------------------------------------------------
  if (geometry.kind === 'continuous' && geometry.y2Scale && node.y2) {
    out.push(...renderSecondaryAxis(node, theme, geometry.y2Scale, plotWidth, plotHeight));
  }

  // --- x axis --------------------------------------------------------------
  if (node.x.showLine) {
    out.push(
      el('path', { d: `M0 ${round(plotHeight)} L${round(plotWidth)} ${round(plotHeight)}`, ...axisStroke }, undefined, { role: 'axis' }),
    );
  }
  const cascadeBoxOffset =
    geometry.kind === 'continuous' && hasCascadeOffset(node, geometry.series.length)
      ? cascadeBackOffsetMm(geometry.series)
      : { x: 0, y: 0 };
  out.push(...renderBoxedBorder(node, plotWidth, plotHeight, axisStroke, cascadeBoxOffset));

  // How far below the axis the labels reach, so the title clears them.
  const { angle, budget, depth: xLabelDepth } = xLabelLayout(node, theme, geometry);

  if (geometry.kind === 'continuous') {
    out.push(...renderNumericBottomAxis(theme, node.x, geometry.xScale, plotWidth, plotHeight));
  } else if (node.x.showLabels) {
    const { axisCategories, axisBand } = geometry;
    const baseY = plotHeight + tickLen + theme.spacing.tickLabelGapMm;

    for (const name of axisCategories) {
      const x = axisBand.center(name);
      if (angle !== 0) {
        out.push(
          text(truncateToWidth(name, tickLabelPt, budget), {
            x: 0,
            y: 0,
            transform: `translate(${round(x)} ${round(baseY)}) rotate(${-angle})`,
            'font-family': theme.fontFamily,
            'font-size': ptToMm(tickLabelPt),
            fill: theme.foreground,
            'text-anchor': 'end',
            'dominant-baseline': 'central',
          }, { role: 'tick-label' }),
        );
      } else {
        out.push(
          text(name, {
            x,
            y: baseY + ptToMm(tickLabelPt) * 0.8,
            'font-family': theme.fontFamily,
            'font-size': ptToMm(tickLabelPt),
            fill: theme.foreground,
            'text-anchor': 'middle',
          }, { role: 'tick-label' }),
        );
      }
    }
  }

  if (node.x.title) {
    // Below the labels, not at a fixed inset from the panel edge: angled labels
    // reach much further down than horizontal ones, and the title would
    // otherwise be drawn straight through them.
    const belowLabels =
      plotHeight + tickLen + theme.spacing.tickLabelGapMm + xLabelDepth + theme.spacing.axisTitleGapMm;
    // The plot's *own* bottom margin, which now grows to hold its labels rather
    // than staying at the theme's constant.
    const defaultY = plotHeight + geometry.margin.bottom - theme.spacing.axisTitleGapMm;
    // Never past the panel's own bottom edge: on a panel too small for both,
    // a title crowding the labels is still better than one off the page.
    const limit = plotHeight + geometry.margin.bottom;

    out.push(
      text(node.x.title, {
        x: plotWidth / 2,
        y: Math.min(Math.max(defaultY, belowLabels), limit),
        'font-family': theme.fontFamily,
        'font-size': ptToMm(theme.type.axisTitlePt),
        fill: theme.foreground,
        'text-anchor': 'middle',
      }, { role: 'axis-title', editTarget: 'x.title' }),
    );
  }

  return out;
}

/**
 * The axis pair for a horizontal categorical plot: `node.x` (the category
 * spec) drawn as a vertical axis down the left, `node.y` (the numeric spec)
 * drawn as a horizontal axis along the bottom via `renderNumericBottomAxis`
 * — the mirror image of `renderAxes`'s vertical layout. A sibling function
 * rather than a deeper branch inside `renderAxes`, so the existing,
 * heavily-pinned vertical path is untouched by construction and this can
 * only ever affect a plot that opts into `orientation: 'horizontal'`.
 *
 * A category axis never draws individual tick marks in either orientation —
 * `addPlot` defaults `x.showTicks` to `false` for every categorical plot
 * type, on the grounds that "the category labels sit under their bands and
 * the bars carry the reading" (see `CONTINUOUS_X_PLOT_TYPES`) — so this
 * mirrors the vertical bottom-axis code exactly in drawing labels only.
 */
function renderAxesHorizontal(
  node: PlotNode,
  theme: Theme,
  geometry: CategoricalPlotGeometry,
): SceneNode[] {
  const { yScale, plotWidth, plotHeight, axisBand, axisCategories } = geometry;
  const out: SceneNode[] = [];
  const tickLen = theme.spacing.tickLengthMm;
  const tickLabelPt = theme.type.tickLabelPt;
  const axisStroke = { stroke: theme.foreground, 'stroke-width': theme.stroke.axisMm, fill: 'none' };

  // --- left axis: node.x, the category axis --------------------------------
  if (node.x.showLine) {
    out.push(
      el('path', { d: `M0 0 L0 ${round(plotHeight)}`, ...axisStroke }, undefined, { role: 'axis' }),
    );
  }

  if (node.x.showLabels) {
    for (const name of axisCategories) {
      out.push(
        text(name, {
          x: -(tickLen + theme.spacing.tickLabelGapMm),
          y: axisBand.center(name),
          'font-family': theme.fontFamily,
          'font-size': ptToMm(tickLabelPt),
          fill: theme.foreground,
          'text-anchor': 'end',
          'dominant-baseline': 'central',
        }, { role: 'tick-label' }),
      );
    }
  }

  if (node.x.title) {
    const { maxLabelWidth } = categoryLabelLayout(node, theme, geometry);
    const x = -(
      tickLen +
      theme.spacing.tickLabelGapMm +
      maxLabelWidth +
      theme.spacing.axisTitleGapMm
    );
    out.push(
      text(node.x.title, {
        x: 0,
        y: 0,
        // Rotated about the axis midpoint so the title stays centred — the
        // exact construction `renderAxes` uses for `node.y.title`.
        transform: `translate(${round(x)} ${round(plotHeight / 2)}) rotate(-90)`,
        'font-family': theme.fontFamily,
        'font-size': ptToMm(theme.type.axisTitlePt),
        fill: theme.foreground,
        'text-anchor': 'middle',
        'dominant-baseline': 'alphabetic',
      }, { role: 'axis-title', editTarget: 'x.title' }),
    );
  }

  // --- bottom axis: node.y, the numeric axis --------------------------------
  if (node.y.showLine) {
    out.push(
      el('path', { d: `M0 ${round(plotHeight)} L${round(plotWidth)} ${round(plotHeight)}`, ...axisStroke }, undefined, { role: 'axis' }),
    );
  }
  out.push(...renderBoxedBorder(node, plotWidth, plotHeight, axisStroke));

  out.push(...renderNumericBottomAxis(theme, node.y, yScale, plotWidth, plotHeight));

  if (node.y.title) {
    out.push(
      text(node.y.title, {
        x: plotWidth / 2,
        // The plot's own bottom margin, which grows to hold the numeric
        // labels — the same construction `renderAxes` uses for `node.x.title`.
        y: plotHeight + geometry.margin.bottom - theme.spacing.axisTitleGapMm,
        'font-family': theme.fontFamily,
        'font-size': ptToMm(theme.type.axisTitlePt),
        fill: theme.foreground,
        'text-anchor': 'middle',
      }, { role: 'axis-title', editTarget: 'y.title' }),
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Editor chrome (never part of an export)
// ---------------------------------------------------------------------------

function renderGrid(doc: FigureDocument): SceneNode {
  const { spacingMm } = doc.grid;
  const { widthMm, heightMm } = doc.page;
  if (spacingMm <= 0) return group();

  const lines: SceneNode[] = [];
  for (let x = 0; x <= widthMm; x += spacingMm) {
    lines.push(el('path', { d: `M${round(x)} 0 L${round(x)} ${round(heightMm)}` }));
  }
  for (let y = 0; y <= heightMm; y += spacingMm) {
    lines.push(el('path', { d: `M0 ${round(y)} L${round(widthMm)} ${round(y)}` }));
  }

  return group({ stroke: '#e6e6e6', 'stroke-width': 0.05, fill: 'none' }, lines);
}

/**
 * Handle positions as fractions of the frame.
 *
 * The cursor is left to CSS, keyed off `data-handle`: the scene carries plain
 * SVG attributes, and React rejects a `style` string outright.
 */
const RESIZE_HANDLES: readonly { id: string; fx: number; fy: number }[] = [
  { id: 'nw', fx: 0, fy: 0 },
  { id: 'n', fx: 0.5, fy: 0 },
  { id: 'ne', fx: 1, fy: 0 },
  { id: 'e', fx: 1, fy: 0.5 },
  { id: 'se', fx: 1, fy: 1 },
  { id: 's', fx: 0.5, fy: 1 },
  { id: 'sw', fx: 0, fy: 1 },
  { id: 'w', fx: 0, fy: 0.5 },
];

/** Half-width of a grab handle, in mm. Small enough not to swamp a panel. */
const HANDLE_HALF_MM = 0.9;

/*
 * Handles are dark with a light ring, not the reverse.
 *
 * A white handle carrying a 0.2 px non-scaling border is invisible against the
 * page, which is white by definition — `.canvas-page` is paper, in both themes.
 * The ring survives the opposite case, a handle over a dark micrograph, so one
 * pair of colours covers both backgrounds rather than either alone.
 */
const HANDLE_FILL = '#111318';
const HANDLE_RING = '#ffffff';

/**
 * How far the rotate grip stands off the top edge, in mm.
 *
 * Clear of the `n` handle rather than on top of it: the two do different things
 * and a grip that turns a node when the author meant to make it shorter is the
 * kind of mistake that is only noticed after the fact.
 */
const ROTATE_HANDLE_OFFSET_MM = 4;

/**
 * Node types that offer a rotate grip.
 *
 * Only leaf annotations, mirroring `isRotatable` on the canvas side. Rotation
 * is drawn by `renderNode` onto a node's own wrapping `<g>`, so it applies to
 * children too — but `absoluteFrame`, which every overlay and the whole layout
 * engine read, sums ancestor origins and ignores rotation entirely. Keeping the
 * grip off containers is what guarantees no rotated node ever has a descendant,
 * so that gap can never be reached.
 */
const ROTATABLE_TYPES = new Set(['shape', 'arrow', 'text']);

/**
 * Selection outline and resize handles.
 *
 * Editor chrome: only ever rendered when `chrome.selectedIds` is passed, which
 * the export path never does. Both adapters read this same tree, so the handles
 * cost nothing in parity terms.
 */
function renderSelection(doc: FigureDocument, selectedIds: readonly string[]): SceneNode {
  const groups: SceneNode[] = [];
  for (const id of selectedIds) {
    const frame = absoluteFrame(doc.nodes, id);
    if (!frame) continue;

    // Chrome for one node, in that node's own (unrotated) coordinates. The
    // rotation is applied once to the whole group below, so every position
    // below is written exactly as it would be for an unrotated node.
    const outlines: SceneNode[] = [];
    outlines.push(
      el('rect', {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        fill: 'none',
        stroke: '#0a84ff',
        'stroke-width': 0.25,
        'stroke-dasharray': '1 0.6',
        'vector-effect': 'non-scaling-stroke',
      }),
    );

    // No handles on a locked node: offering a grip that cannot move is worse
    // than offering none.
    if (isLocked(doc, id)) {
      groups.push(rotatedChrome(doc, id, frame, outlines));
      continue;
    }

    for (const handle of RESIZE_HANDLES) {
      outlines.push(
        el(
          'rect',
          {
            x: frame.x + frame.width * handle.fx - HANDLE_HALF_MM,
            y: frame.y + frame.height * handle.fy - HANDLE_HALF_MM,
            width: HANDLE_HALF_MM * 2,
            height: HANDLE_HALF_MM * 2,
            fill: HANDLE_FILL,
            stroke: HANDLE_RING,
            'stroke-width': 1,
            'vector-effect': 'non-scaling-stroke',
            'data-handle': handle.id,
          },
          undefined,
          { nodeId: id, role: 'resize-handle' },
        ),
      );
    }

    // Arrow endpoints get their own grips. Without them an arrow could only be
    // scaled by its bounding box, so "point at that cell" would mean nudging a
    // rectangle until the tip happened to land — which is not an interaction.
    // Only for a lone selection: eight grips plus N more across a multi-select
    // is a field of squares with no discernible target.
    const node = doc.nodes[id];
    if (node?.type === 'arrow' && selectedIds.length === 1) {
      for (const [index, point] of node.points.entries()) {
        outlines.push(
          el(
            'circle',
            {
              cx: frame.x + point.x,
              cy: frame.y + point.y,
              r: HANDLE_HALF_MM,
              fill: '#0a84ff',
              stroke: '#ffffff',
              'stroke-width': 0.2,
              'vector-effect': 'non-scaling-stroke',
              'data-handle': `point-${index}`,
            },
            undefined,
            { nodeId: id, role: 'point-handle' },
          ),
        );
      }
    }

    // One rotate grip, and only on a lone selection: turning several nodes at
    // once would have to pick a centre for them, and the obvious candidates
    // (each node's own, or the selection's) disagree visibly.
    if (node && ROTATABLE_TYPES.has(node.type) && selectedIds.length === 1) {
      /*
       * Stem first, grip second.
       *
       * The stem ends at the grip's own centre, so drawing it afterwards paints
       * it over the grip — and since it carries no `data-handle`, a pointer-down
       * there reaches no handler at all and the drag silently starts a move of
       * whatever is behind instead. Order is the whole fix.
       */
      outlines.push(
        el('line', {
          x1: frame.x + frame.width / 2,
          y1: frame.y,
          x2: frame.x + frame.width / 2,
          y2: frame.y - ROTATE_HANDLE_OFFSET_MM,
          stroke: '#0a84ff',
          'stroke-width': 0.25,
          'vector-effect': 'non-scaling-stroke',
          // Belt and braces: even reordered, the stem must never take a click
          // that was aimed at the grip it points to.
          'pointer-events': 'none',
        }),
      );
      outlines.push(
        el(
          'circle',
          {
            cx: frame.x + frame.width / 2,
            cy: frame.y - ROTATE_HANDLE_OFFSET_MM,
            r: HANDLE_HALF_MM,
            fill: HANDLE_FILL,
            stroke: HANDLE_RING,
            'stroke-width': 1,
            'vector-effect': 'non-scaling-stroke',
            'data-handle': 'rotate',
          },
          undefined,
          { nodeId: id, role: 'rotate-handle' },
        ),
      );
    }

    groups.push(rotatedChrome(doc, id, frame, outlines));
  }
  return group({}, groups);
}

/**
 * Turn one node's chrome about its own centre, matching what `renderNode` does
 * to the node itself.
 *
 * Without this the outline and all nine grips stay axis-aligned while the shape
 * under them turns, so the grips sit off the node and the one the author grabs
 * is not the one they are pointing at. Applying the same `rotate(deg cx cy)`
 * the renderer already uses is what keeps the two in step by construction.
 */
function rotatedChrome(
  doc: FigureDocument,
  id: string,
  frame: RectMm,
  children: SceneNode[],
): SceneNode {
  const rotation = doc.nodes[id]?.rotation ?? 0;
  if (rotation === 0) return group({}, children);
  return group(
    {
      transform: `rotate(${round(rotation)} ${round(frame.x + frame.width / 2)} ${round(
        frame.y + frame.height / 2,
      )})`,
    },
    children,
  );
}

/** Stable 32-bit hash, used to seed per-node deterministic jitter. */
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}
