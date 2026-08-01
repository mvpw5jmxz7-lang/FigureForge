/**
 * FigureDocument → scene tree.
 *
 * A pure function. Given the same document and theme it produces the same tree,
 * every time, in any environment — that determinism is what lets the export
 * path reuse this code instead of reimplementing it.
 */

import {
  absoluteFrame,
  childrenOf,
  findAsset,
  findDataset,
  findLayer,
  ptToMm,
  toSeries,
  type ArrowNode,
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
  makeBandScale,
  makeScale,
  resolveDomain,
  type NumericScale,
} from '@figureforge/plots';
import { el, group, round, text, translate, type SceneNode } from './scene.js';

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

  if (!href) {
    // Placeholder keeps layout honest when an asset is missing or still loading.
    return group({}, [
      el('rect', {
        x: 0, y: 0, width, height,
        fill: '#f2f2f2', stroke: '#bbbbbb', 'stroke-width': 0.2,
        'stroke-dasharray': '1 1',
      }),
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

  if (!isCropped) return image;

  const clipId = `clip-${node.id}`;
  return group({ 'clip-path': `url(#${clipId})` }, [
    el('defs', {}, [
      el('clipPath', { id: clipId }, [el('rect', { x: 0, y: 0, width, height })]),
    ]),
    image,
  ]);
}

/**
 * Scale bar. Its physical length is derived from the parent image's on-page
 * size and the micrograph's calibration, so resizing the image rescales the bar
 * automatically — a bar that keeps a fixed length while its image is resized is
 * a data integrity problem, not a cosmetic one.
 */
function renderScaleBar(node: ScaleBarNode, doc: FigureDocument, theme: Theme): SceneNode {
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;

  let barWidthMm = node.frame.width;
  if (parent?.type === 'image') {
    const image = parent;
    const visiblePx = image.naturalPx.width * (image.crop.width || 1);
    if (visiblePx > 0) {
      const mmPerPixel = image.frame.width / visiblePx;
      barWidthMm = node.length * node.pixelsPerUnit * mmPerPixel;
    }
  }

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

  if (node.showLabel && node.labelPosition !== 'none') {
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
export interface PlotGeometry {
  margin: { top: number; right: number; bottom: number; left: number };
  plotWidth: number;
  plotHeight: number;
  band: ReturnType<typeof makeBandScale>;
  yScale: NumericScale;
  marks: ReturnType<typeof categoricalMarks>;
  categories: string[];
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

  const margin = theme.spacing.plotMarginMm;
  const plotWidth = Math.max(0, node.frame.width - margin.left - margin.right);
  const plotHeight = Math.max(0, node.frame.height - margin.top - margin.bottom);
  if (plotWidth <= 0 || plotHeight <= 0) return null;

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
  });

  const band = makeBandScale(series.map((s) => s.name), [0, plotWidth]);

  const marks = categoricalMarks(series, {
    band,
    y: yScale,
    center: node.center,
    errorBars: node.errorBars,
    barWidthFraction: node.barWidthFraction,
    showBar: node.plotType === 'bar' || node.plotType === 'bar-dot',
    showPoints: node.showPoints || node.plotType === 'dot' || node.plotType === 'beeswarm',
    pointSizeMm: node.pointSizeMm,
    jitterMm: node.jitterMm,
    pointLayout: node.plotType === 'beeswarm' ? 'beeswarm' : 'jitter',
    colors: paletteColors(node.palette, series.length),
    // Seeded from the node id so jitter is identical on screen and in export.
    seed: hashString(node.id),
  });

  return {
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
 * Where a plot's categories actually sit, in coordinates relative to the plot
 * node's own frame. `topMm` is the highest drawn feature of each category, so
 * an annotation can clear the data rather than overlap it.
 */
export function measurePlot(
  doc: FigureDocument,
  plot: PlotNode,
  theme: Theme,
): { categoryX: Map<string, number>; categoryTop: Map<string, number> } | null {
  const geometry = computePlotGeometry(plot, doc, theme);
  if (!geometry) return null;

  const categoryX = new Map<string, number>();
  const categoryTop = new Map<string, number>();

  geometry.categories.forEach((name, index) => {
    const mark = geometry.marks[index];
    categoryX.set(name, geometry.margin.left + geometry.band.center(name));
    categoryTop.set(name, geometry.margin.top + (mark?.topMm ?? 0));
  });

  return { categoryX, categoryTop };
}

function renderPlot(node: PlotNode, doc: FigureDocument, options: RenderOptions): SceneNode | null {
  const { theme } = options;
  const geometry = computePlotGeometry(node, doc, theme);
  if (!geometry) return null;

  const { margin, plotWidth, plotHeight, band, yScale, marks } = geometry;
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

    if (mark.errorBar) {
      const eb = mark.errorBar;
      const lower = eb.lowerInsideBar ? mark.centerMm : eb.bottomMm;
      markChildren.push(
        el('path', {
          d:
            `M${round(eb.x - eb.capHalfWidthMm)} ${round(eb.topMm)} L${round(eb.x + eb.capHalfWidthMm)} ${round(eb.topMm)} ` +
            `M${round(eb.x)} ${round(eb.topMm)} L${round(eb.x)} ${round(lower)}` +
            (eb.lowerInsideBar
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
        el('circle', {
          cx: point.x,
          cy: point.y,
          r: node.pointSizeMm / 2,
          fill: mark.bar ? theme.foreground : mark.color,
          'fill-opacity': mark.bar ? 0.85 : 1,
          stroke: 'none',
        }, undefined, { role: 'point' }),
      );
    }

    content.push(group({}, markChildren));
  }

  const axes = renderAxes(node, theme, yScale, band, plotWidth, plotHeight, geometry.categories);

  return group({ transform: translate(margin.left, margin.top) }, [...axes, ...content], {
    role: 'plot-area',
  });
}

function renderAxes(
  node: PlotNode,
  theme: Theme,
  yScale: NumericScale,
  band: ReturnType<typeof makeBandScale>,
  plotWidth: number,
  plotHeight: number,
  categories: readonly string[],
): SceneNode[] {
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

  if (node.y.showTicks || node.y.showLabels) {
    for (const tick of yScale.ticks) {
      const y = yScale.scale(tick);
      if (y < -0.01 || y > plotHeight + 0.01) continue;

      if (node.y.showTicks) {
        out.push(
          el('path', { d: `M${round(-tickLen)} ${round(y)} L0 ${round(y)}`, ...axisStroke }, undefined, { role: 'tick' }),
        );
      }
      if (node.y.showLabels) {
        out.push(
          text(yScale.format(tick), {
            x: -(tickLen + theme.spacing.tickLabelGapMm),
            y,
            'font-family': theme.fontFamily,
            'font-size': ptToMm(theme.type.tickLabelPt),
            fill: theme.foreground,
            'text-anchor': 'end',
            'dominant-baseline': 'central',
          }, { role: 'tick-label' }),
        );
      }
    }
  }

  if (node.y.title) {
    const x = -(tickLen + theme.spacing.tickLabelGapMm + theme.spacing.axisTitleGapMm + 2);
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

  // --- x axis (categorical) ----------------------------------------------
  if (node.x.showLine) {
    out.push(
      el('path', { d: `M0 ${round(plotHeight)} L${round(plotWidth)} ${round(plotHeight)}`, ...axisStroke }, undefined, { role: 'axis' }),
    );
  }

  if (node.x.showLabels) {
    for (const name of categories) {
      out.push(
        text(name, {
          x: band.center(name),
          y: plotHeight + tickLen + theme.spacing.tickLabelGapMm + ptToMm(theme.type.tickLabelPt) * 0.8,
          'font-family': theme.fontFamily,
          'font-size': ptToMm(theme.type.tickLabelPt),
          fill: theme.foreground,
          'text-anchor': 'middle',
        }, { role: 'tick-label' }),
      );
    }
  }

  if (node.x.title) {
    out.push(
      text(node.x.title, {
        x: plotWidth / 2,
        y: plotHeight + theme.spacing.plotMarginMm.bottom - theme.spacing.axisTitleGapMm,
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
