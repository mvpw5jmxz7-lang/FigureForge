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
  absoluteFrame,
  isLocked,
  childrenOf,
  findAsset,
  findDataset,
  findLayer,
  ptToMm,
  repositionBrackets,
  scaleBarWidthMm,
  toSeries,
  type ArrowNode,
  type AxisSpec,
  type BracketNode,
  type FigureDocument,
  type FigureNode,
  type ImageNode,
  type PanelLabelNode,
  type PanelNode,
  type PlotNode,
  type ScaleBarNode,
  type ShapeNode,
  type Stroke,
  type TextNode,
  type TextStyle,
} from '@figureforge/doc-model';
import { paletteColors, type Theme } from '@figureforge/theme';
import {
  categoricalMarks,
  histogramBins,
  histogramMarks,
  makeBandScale,
  makeScale,
  resolveDomain,
  tickCountForLength,
  xyMarks,
  type NumericScale,
} from '@figureforge/plots';
import { el, group, round, text, translate, type SceneNode } from './scene.js';
import { estimateTextHeightMm, estimateTextWidthMm, truncateToWidth } from './text-width.js';

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

  const image = el('image', {
    href,
    x: isCropped ? -(crop.x / crop.width) * width : 0,
    y: isCropped ? -(crop.y / crop.height) * height : 0,
    width: isCropped ? width / crop.width : width,
    height: isCropped ? height / crop.height : height,
    preserveAspectRatio: node.preserveAspect ? 'xMidYMid meet' : 'none',
    // Micrographs must not be smoothed; interpolation invents detail.
    'image-rendering': 'pixelated',
  }, undefined, { role: 'image' });

  // The wrapper carries no role: the <image> element inside already has it, and
  // counting the role twice would make "how many images are there" wrong.
  if (!isCropped) {
    return overlays.length === 0 ? image : group({}, [image, ...overlays]);
  }

  const clipId = `clip-${node.id}`;
  // The clip is the image's own frame, so overlays sit inside it too — a scale
  // bar that overhung the micrograph it measures would be nonsense.
  return group({ 'clip-path': `url(#${clipId})` }, [
    el('defs', {}, [
      el('clipPath', { id: clipId }, [el('rect', { x: 0, y: 0, width, height })]),
    ]),
    image,
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
  yScale: NumericScale;
}

/** Band-scaled x: bar, dot, bar-dot, beeswarm, box, violin. */
export interface CategoricalPlotGeometry extends PlotGeometryBase {
  kind: 'categorical';
  band: ReturnType<typeof makeBandScale>;
  marks: ReturnType<typeof categoricalMarks>;
  categories: string[];
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

export type PlotGeometry = CategoricalPlotGeometry | ContinuousPlotGeometry;


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

  // scatter and line: every series must carry its own paired x values.
  const xValues = series.flatMap((s) => [...(s.x ?? [])]).filter(Number.isFinite);
  if (xValues.length === 0) return null;

  const xScale = makeScale({
    domain: resolveDomain(xValues, {
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
  });

  const yScale = makeScale({
    domain: resolveDomain(series.flatMap((s) => s.values), {
      min: node.y.min,
      max: node.y.max,
      includeZero: false,
      padFraction: 0.08,
      kind: node.y.scale,
    }),
    rangeMm: [plotHeight, 0],
    tickStep: node.y.tickStep,
    kind: node.y.scale,
    ...(node.y.breaks ? { breaks: node.y.breaks } : {}),
  });

  /*
   * The secondary axis is offered on continuous plots only. On a categorical
   * plot the bands, not the values, carry the reading, and two bar series drawn
   * against different scales in one band group cannot be compared by length —
   * which is the only thing a bar chart is for. Withheld rather than
   * approximated, and the Inspector says so.
   */
  const axisFor = node.seriesAxis ?? [];
  const usesY2 = node.y2 !== undefined && series.some((_, i) => axisFor[i] === 'y2');
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
): PlotGeometry | null {
  const plotWidth = Math.max(0, node.frame.width - margin.left - margin.right);
  const plotHeight = Math.max(0, node.frame.height - margin.top - margin.bottom);
  if (plotWidth <= 0 || plotHeight <= 0) return null;

  if (CONTINUOUS_X_PLOT_TYPES.has(node.plotType)) {
    return continuousGeometry(node, series, { margin, plotWidth, plotHeight });
  }

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
    // Inverted: SVG y grows downward, data grows upward.
    rangeMm: [plotHeight, 0],
    tickStep: node.y.tickStep,
    kind: node.y.scale,
    ...(node.y.breaks ? { breaks: node.y.breaks } : {}),
  });

  const band = makeBandScale(series.map((s) => s.name), [0, plotWidth]);

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
    colors: paletteColors(node.palette, series.length),
    // Seeded from the node id so jitter is identical on screen and in export.
    seed: hashString(node.id),
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
  };
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
  geometry: PlotGeometry,
  reserveTopMm = 0,
): { left: number; bottom: number; right: number; top: number } {
  const titleHeight = estimateTextHeightMm(theme.type.axisTitlePt);

  // An inward tick takes no gutter at all, so it must not reserve any.
  const yTickGutter =
    node.y.showTicks && node.y.tickDirection !== 'in' ? theme.spacing.tickLengthMm : 0;
  const xTickGutter =
    node.x.showTicks && node.x.tickDirection !== 'in' ? theme.spacing.tickLengthMm : 0;

  const yLabels = node.y.showLabels ? yTickLayout(node, theme, geometry).maxLabelWidth : 0;
  const left =
    yTickGutter +
    (node.y.showLabels ? theme.spacing.tickLabelGapMm + yLabels : 0) +
    (node.y.title ? theme.spacing.axisTitleGapMm + titleHeight : 0);

  const bottom =
    xTickGutter +
    theme.spacing.tickLabelGapMm +
    xLabelLayout(node, theme, geometry).depth +
    (node.x.title ? theme.spacing.axisTitleGapMm + titleHeight : 0);

  // A secondary axis puts the same furniture on the right, where the theme
  // reserves 2 mm — enough for a label overhanging the last x tick and nothing
  // more.
  let right = theme.spacing.plotMarginMm.right;
  if (geometry.kind === 'continuous' && geometry.y2Scale && node.y2) {
    const spec = node.y2;
    const labels = spec.showLabels
      ? geometry.y2Scale.ticks.reduce(
          (max, t) => Math.max(max, estimateTextWidthMm(geometry.y2Scale!.format(t), theme.type.tickLabelPt)),
          0,
        )
      : 0;
    right = Math.max(
      right,
      (spec.showTicks && spec.tickDirection !== 'in' ? theme.spacing.tickLengthMm : 0) +
        (spec.showLabels ? theme.spacing.tickLabelGapMm + labels : 0) +
        (spec.title ? theme.spacing.axisTitleGapMm + titleHeight : 0),
    );
  }

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

function computePlotGeometry(
  node: PlotNode,
  doc: FigureDocument,
  theme: Theme,
): PlotGeometry | null {
  const dataset = findDataset(doc, node.datasetId);
  if (!dataset) return null;

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

  // A continuous plot has no categories to anchor a bracket to. Empty
  // measurements are the honest answer: `addBracket` then has nothing to place
  // against, and the Stats tab refuses group comparisons on these plots.
  if (geometry.kind !== 'categorical') {
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

function renderPlot(node: PlotNode, doc: FigureDocument, options: RenderOptions): SceneNode | null {
  const { theme } = options;
  const geometry = computePlotGeometry(node, doc, theme);
  if (!geometry) return null;

  const { margin } = geometry;

  if (geometry.kind === 'continuous') {
    return group(
      { transform: translate(margin.left, margin.top) },
      [
        ...renderAxes(node, theme, geometry),
        ...renderContinuousMarks(node, theme, geometry),
        // Break marks last: the gap is painted in the page colour, so it has to
        // land over the marks it interrupts rather than under them.
        ...renderAxisBreaks(node, theme, geometry),
      ],
      { role: 'plot-area' },
    );
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
      // Up the right flank, then back down the left, mirrored about the centre.
      const right = v.profile.map(
        (p, i) => `${i === 0 ? 'M' : 'L'}${round(v.centerX + p.halfWidthMm)} ${round(p.yMm)}`,
      );
      const left = [...v.profile]
        .reverse()
        .map((p) => `L${round(v.centerX - p.halfWidthMm)} ${round(p.yMm)}`);
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
      markChildren.push(
        el('path', {
          d:
            `M${round(b.x + b.width / 2)} ${round(b.q3Mm)} L${round(b.x + b.width / 2)} ${round(b.upperWhiskerMm)} ` +
            `M${round(b.x + b.width / 2 - b.capHalfWidthMm)} ${round(b.upperWhiskerMm)} L${round(b.x + b.width / 2 + b.capHalfWidthMm)} ${round(b.upperWhiskerMm)} ` +
            `M${round(b.x + b.width / 2)} ${round(b.q1Mm)} L${round(b.x + b.width / 2)} ${round(b.lowerWhiskerMm)} ` +
            `M${round(b.x + b.width / 2 - b.capHalfWidthMm)} ${round(b.lowerWhiskerMm)} L${round(b.x + b.width / 2 + b.capHalfWidthMm)} ${round(b.lowerWhiskerMm)}`,
          fill: 'none',
          stroke: theme.foreground,
          'stroke-width': theme.stroke.errorBarMm,
          'stroke-linecap': 'butt',
        }, undefined, { role: 'whisker' }),
      );
      markChildren.push(
        el('rect', {
          x: b.x,
          // y is inverted, so q3 is the top edge and the height is the IQR.
          y: b.q3Mm,
          width: b.width,
          height: Math.abs(b.q1Mm - b.q3Mm),
          fill: mark.color,
          'fill-opacity': 0.55,
          stroke: theme.foreground,
          'stroke-width': theme.stroke.dataMm,
        }, undefined, { role: 'box' }),
      );
      markChildren.push(
        el('path', {
          d: `M${round(b.x)} ${round(b.medianMm)} L${round(b.x + b.width)} ${round(b.medianMm)}`,
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
      const lower = eb.upperOnly ? mark.centerMm : eb.bottomMm;
      markChildren.push(
        el('path', {
          d:
            `M${round(eb.x - eb.capHalfWidthMm)} ${round(eb.topMm)} L${round(eb.x + eb.capHalfWidthMm)} ${round(eb.topMm)} ` +
            `M${round(eb.x)} ${round(eb.topMm)} L${round(eb.x)} ${round(lower)}` +
            (eb.upperOnly
              ? ''
              : ` M${round(eb.x - eb.capHalfWidthMm)} ${round(eb.bottomMm)} L${round(eb.x + eb.capHalfWidthMm)} ${round(eb.bottomMm)}`),
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

  const axes = renderAxes(node, theme, geometry);

  return group(
    { transform: translate(margin.left, margin.top) },
    [...axes, ...content, ...renderAxisBreaks(node, theme, geometry)],
    { role: 'plot-area' },
  );
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
function markerNode(
  node: PlotNode,
  theme: Theme,
  cx: number,
  cy: number,
  style: { fill: string; fillOpacity?: number; forceStroke?: { color: string; widthMm: number } },
): SceneNode {
  const r = node.pointSizeMm / 2;
  const stroke = style.forceStroke ?? node.pointStroke;
  const strokeAttrs = stroke
    ? { stroke: stroke.color, 'stroke-width': stroke.widthMm }
    : { stroke: 'none' };
  const common = {
    fill: style.fill,
    ...(style.fillOpacity !== undefined ? { 'fill-opacity': style.fillOpacity } : {}),
    ...strokeAttrs,
  };

  switch (node.pointShape ?? 'circle') {
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
        undefined,
        { role: 'point' },
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
      return el('path', { d, ...common }, undefined, { role: 'point' });
    }
    case 'diamond': {
      const half = r * Math.sqrt(Math.PI / 2);
      const d =
        `M${round(cx)} ${round(cy - half)} L${round(cx + half)} ${round(cy)} ` +
        `L${round(cx)} ${round(cy + half)} L${round(cx - half)} ${round(cy)} Z`;
      return el('path', { d, ...common }, undefined, { role: 'point' });
    }
    default:
      return el('circle', { cx, cy, r, ...common }, undefined, { role: 'point' });
  }
}

/** Scatter points, line paths and histogram bars. */
function renderContinuousMarks(
  node: PlotNode,
  theme: Theme,
  geometry: ContinuousPlotGeometry,
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

  for (const s of geometry.series) {
    const markChildren: SceneNode[] = [];

    if (s.linePath && s.linePath.length > 1) {
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
        }, undefined, { role: 'line' }),
      );
    }

    for (const point of s.points) {
      markChildren.push(
        markerNode(node, theme, point.x, point.y, { fill: node.pointFill ?? s.color }),
      );
    }

    content.push(group({}, markChildren));
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
      const label = scale.format(tick);
      widest = Math.max(widest, estimateTextWidthMm(label, tickLabelPt));
      out.push(
        text(label, {
          x: plotWidth + tickLen + theme.spacing.tickLabelGapMm,
          y,
          'font-family': theme.fontFamily,
          'font-size': ptToMm(tickLabelPt),
          fill: theme.foreground,
          'text-anchor': 'start',
          'dominant-baseline': 'central',
        }, { role: 'tick-label' }),
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
      }, { role: 'axis-title' }),
    );
  }

  return out;
}

/** Break marks for whichever of a plot's axes carry them. */
function renderAxisBreaks(node: PlotNode, theme: Theme, geometry: PlotGeometry): SceneNode[] {
  const out = breakMarks(geometry.yScale, theme, 'y', geometry.plotWidth);
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
 * Values between the major ticks, for the minor divisions.
 *
 * Derived from the majors rather than from the domain, so they line up with the
 * grid the reader is already using and cannot drift out of phase with it.
 */
function minorTickValues(majors: readonly number[], divisions: number | undefined): number[] {
  if (!divisions || divisions < 2 || majors.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < majors.length; i++) {
    const from = majors[i - 1]!;
    const step = (majors[i]! - from) / divisions;
    for (let k = 1; k < divisions; k++) out.push(from + step * k);
  }
  return out;
}

function renderNumericXTicks(
  node: PlotNode,
  theme: Theme,
  geometry: ContinuousPlotGeometry,
): SceneNode[] {
  const { xScale, plotWidth, plotHeight } = geometry;
  const out: SceneNode[] = [];
  const tickLen = theme.spacing.tickLengthMm;
  const tickLabelPt = theme.type.tickLabelPt;
  const axisStroke = { stroke: theme.foreground, 'stroke-width': theme.stroke.axisMm, fill: 'none' };

  const visible = xScale.ticks.filter(
    (tick) => xScale.scale(tick) >= -0.01 && xScale.scale(tick) <= plotWidth + 0.01,
  );
  if (visible.length === 0) return out;

  const widest = visible.reduce(
    (max, tick) => Math.max(max, estimateTextWidthMm(xScale.format(tick), tickLabelPt)),
    0,
  );
  // A gap of a quarter of the widest label keeps neighbours from touching.
  const maxLabels = widest > 0 ? Math.max(2, Math.floor(plotWidth / (widest * 1.25))) : visible.length;
  const stride = visible.length > maxLabels ? Math.ceil(visible.length / maxLabels) : 1;

  if (node.x.showTicks) {
    // Minor ticks first, so a major tick is never drawn over by one.
    for (const value of minorTickValues(visible, node.x.minorTicks)) {
      const x = xScale.scale(value);
      if (x < -0.01 || x > plotWidth + 0.01) continue;
      out.push(
        el('path', {
          d: `M${round(x)} ${round(plotHeight)} L${round(x)} ${round(plotHeight + tickOffset(node.x, tickLen) * 0.55)}`,
          ...axisStroke,
        }, undefined, { role: 'tick' }),
      );
    }
  }

  visible.forEach((tick, index) => {
    const x = xScale.scale(tick);

    if (node.x.showTicks) {
      out.push(
        el('path', {
          d: `M${round(x)} ${round(plotHeight)} L${round(x)} ${round(plotHeight + tickOffset(node.x, tickLen))}`,
          ...axisStroke,
        }, undefined, { role: 'tick' }),
      );
    }

    // Ticks stay put; only their labels thin out, so the scale still reads.
    if (!node.x.showLabels || index % stride !== 0) return;

    /*
     * Anchor the end labels inward. The theme reserves only 2 mm to the right of
     * the plot, so a centred label on the last tick overhangs the panel and, on
     * the rightmost panel of a figure, the page itself.
     */
    const isFirst = index === 0;
    const isLast = index === visible.length - 1;
    const anchor = isFirst ? 'start' : isLast ? 'end' : 'middle';

    out.push(
      text(xScale.format(tick), {
        x,
        y: plotHeight + tickLen + theme.spacing.tickLabelGapMm + ptToMm(tickLabelPt) * 0.8,
        'font-family': theme.fontFamily,
        'font-size': ptToMm(tickLabelPt),
        fill: theme.foreground,
        'text-anchor': anchor,
      }, { role: 'tick-label' }),
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
  geometry: PlotGeometry,
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
    maxLabelWidth = Math.max(maxLabelWidth, estimateTextWidthMm(yScale.format(tick), tickLabelPt));
  });

  return { visibleTicks, stride, maxLabelWidth };
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
  geometry: PlotGeometry,
): { angle: 0 | 45 | 90; budget: number; depth: number } {
  const tickLabelPt = theme.type.tickLabelPt;
  const oneLine = estimateTextHeightMm(tickLabelPt);

  if (geometry.kind !== 'categorical' || !node.x.showLabels) {
    return { angle: 0, budget: Infinity, depth: node.x.showLabels ? oneLine : 0 };
  }

  const { band, categories } = geometry;
  // Adding a dataset re-runs auto-layout and narrows every panel, so the slot
  // a category label has to fit in shrinks. Measure before drawing.
  const slot = band.step;
  const widest = categories.reduce(
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

  const longest = categories.reduce(
    (max, name) =>
      Math.max(max, estimateTextWidthMm(truncateToWidth(name, tickLabelPt, budget), tickLabelPt)),
    0,
  );
  // Angled text descends by its own length × sin(angle), plus a line.
  const sin = angle === 90 ? 1 : Math.SQRT1_2;
  return { angle, budget, depth: longest * sin + oneLine };
}

function renderAxes(node: PlotNode, theme: Theme, geometry: PlotGeometry): SceneNode[] {
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
    for (const value of minorTickValues(visibleTicks, node.y.minorTicks)) {
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
        const label = yScale.format(tick);
        out.push(
          text(label, {
            x: -(tickLen + theme.spacing.tickLabelGapMm),
            y,
            'font-family': theme.fontFamily,
            'font-size': ptToMm(tickLabelPt),
            fill: theme.foreground,
            'text-anchor': 'end',
            'dominant-baseline': 'central',
          }, { role: 'tick-label' }),
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
      }, { role: 'axis-title' }),
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

  // How far below the axis the labels reach, so the title clears them.
  const { angle, budget, depth: xLabelDepth } = xLabelLayout(node, theme, geometry);

  if (geometry.kind === 'continuous') {
    out.push(...renderNumericXTicks(node, theme, geometry));
  } else if (node.x.showLabels) {
    const { categories, band } = geometry;
    const baseY = plotHeight + tickLen + theme.spacing.tickLabelGapMm;

    for (const name of categories) {
      const x = band.center(name);
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
      }, { role: 'axis-title' }),
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

/**
 * Selection outline and resize handles.
 *
 * Editor chrome: only ever rendered when `chrome.selectedIds` is passed, which
 * the export path never does. Both adapters read this same tree, so the handles
 * cost nothing in parity terms.
 */
function renderSelection(doc: FigureDocument, selectedIds: readonly string[]): SceneNode {
  const outlines: SceneNode[] = [];
  for (const id of selectedIds) {
    const frame = absoluteFrame(doc.nodes, id);
    if (!frame) continue;
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
    if (isLocked(doc, id)) continue;

    for (const handle of RESIZE_HANDLES) {
      outlines.push(
        el(
          'rect',
          {
            x: frame.x + frame.width * handle.fx - HANDLE_HALF_MM,
            y: frame.y + frame.height * handle.fy - HANDLE_HALF_MM,
            width: HANDLE_HALF_MM * 2,
            height: HANDLE_HALF_MM * 2,
            fill: '#ffffff',
            stroke: '#0a84ff',
            'stroke-width': 0.2,
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
  }
  return group({}, outlines);
}

/** Stable 32-bit hash, used to seed per-node deterministic jitter. */
function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}
