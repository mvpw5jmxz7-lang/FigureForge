/**
 * Measuring what each panel needs, for the smart-layout solver.
 *
 * The bridge `doc-model` cannot build for itself. A plot's real demand is its
 * axis furniture — tick labels, titles, legend rows, bracket headroom — and
 * only `computePlotGeometry` knows how wide any of that prints. `doc-model`
 * imports nothing internal, so `PanelDemand` is declared there as plain data
 * and produced here, exactly as `PlotMeasurements`/`measureAllPlots` already
 * split the same problem.
 *
 * Nothing here draws. It reads geometry and returns millimetres.
 */

import type {
  FigureDocument,
  NodeId,
  PanelDemand,
  PanelNode,
  PlotNode,
  SmartLayoutScaleInput,
} from '@figureforge/doc-model';
import { FONT_SCALES, imagePanelDemand, readingOrder } from '@figureforge/doc-model';
import type { Theme, TypeScale } from '@figureforge/theme';
import { bracketStepMm, computePlotGeometry } from './render-document.js';

/**
 * Plot area a plot must keep once its margins are taken.
 *
 * Below this a plot technically renders and tells the reader nothing. The
 * *hard* floor is zero — `computePlotGeometry` returns null at that point and
 * the panel draws blank — so this is deliberately above it: the solver's job is
 * to avoid the useless outcome, not merely the broken one.
 */
export const MIN_PLOT_AREA_MM = 15;

/** Below this a plot is cramped even though it draws. */
const COMFORT_PLOT_AREA_MM = 30;

/** Room one categorical mark wants along the band axis. */
const BAR_PITCH_MM = 4;
/** Room between two adjacent categories. */
const GROUP_GAP_MM = 2;
/** Room one heatmap column wants. */
const CELL_COMFORT_MM = 3;
/**
 * Plot-area height at which a plot stops feeling squashed.
 *
 * Level with `COMFORT_PLOT_AREA_MM`, so a comfortable plot is roughly square —
 * which is what a published panel usually is. Set to 22 mm first, and the
 * solver promptly drove a two-plot figure's page down to a 36 mm-tall strip
 * and scored it 99: shrinking the page is rewarded, and nothing else objected,
 * because a plot declares no aspect preference of its own. The floor is what
 * stands in for one.
 */
const COMFORT_PLOT_HEIGHT_MM = 30;

export interface PanelDemandOptions {
  pageWidthMm: number;
  maxPageHeightMm: number;
  marginMm: number;
  gutterMm: number;
  labelGutterMm: number;
  exportDpi: number;
  /** Widest grid the solver will try, so the narrow probe matches it. */
  maxColumns: number;
  maxRows: number;
}

/**
 * Measure a plot against a hypothetical frame.
 *
 * The clone is a fresh object, so `measurePlot`'s WeakMap misses by
 * construction and the probe can never leave a cached geometry behind that the
 * real render would then pick up — the cache is keyed on the node's identity
 * precisely because Immer gives a new object on every edit, and this exploits
 * the same property deliberately.
 */
function geometryAt(
  doc: FigureDocument,
  plot: PlotNode,
  theme: Theme,
  frame: { width: number; height: number },
): ReturnType<typeof computePlotGeometry> {
  const probe: PlotNode = { ...plot, frame: { ...plot.frame, ...frame } };
  const probeDoc: FigureDocument = { ...doc, nodes: { ...doc.nodes, [probe.id]: probe } };
  return computePlotGeometry(probe, probeDoc, theme);
}

/**
 * What a plot panel needs.
 *
 * Measured at **exactly two** probe frames, never converged to — this
 * codebase's two-pass rule, applied one level up. `requiredMargin` reads the
 * frame it is given (for its own 60/60/30/35 % caps, and to decide how many
 * rows a bottom legend wraps to), so a single probe cannot answer the question:
 *
 *   - the **wide** probe is where nothing clamps, giving the true furniture;
 *   - the **narrow** probe is the tightest column the search can produce, which
 *     is where a legend gains rows and the bottom margin grows.
 *
 * Taking the per-side maximum of the two is what stops the solver proposing a
 * column that measured fine at full width and then blows its own margin budget
 * once the panel is actually narrow.
 */
function plotPanelDemand(
  doc: FigureDocument,
  panel: PanelNode,
  plot: PlotNode,
  theme: Theme,
  options: PanelDemandOptions,
  fontScale: number,
): PanelDemand {
  const usableWidth = options.pageWidthMm - 2 * options.marginMm;
  const usableHeight = options.maxPageHeightMm - 2 * options.marginMm;

  const wide = {
    width: Math.max(1, usableWidth - options.labelGutterMm),
    height: Math.max(1, usableHeight),
  };
  const narrow = {
    width: Math.max(
      1,
      (usableWidth - (options.maxColumns - 1) * options.gutterMm) / Math.max(1, options.maxColumns) -
        options.labelGutterMm,
    ),
    height: Math.max(
      1,
      (usableHeight - (options.maxRows - 1) * options.gutterMm) / Math.max(1, options.maxRows),
    ),
  };

  const a = geometryAt(doc, plot, theme, wide);
  const b = geometryAt(doc, plot, theme, narrow);
  const geometry = a ?? b;

  const side = (pick: (m: { top: number; right: number; bottom: number; left: number }) => number): number =>
    Math.max(a ? pick(a.margin) : 0, b ? pick(b.margin) : 0);

  const marginX = side((m) => m.left) + side((m) => m.right);
  const marginY = side((m) => m.top) + side((m) => m.bottom);

  // Comfort along the data axis, from what the geometry itself carries. A plot
  // with twelve categories and a three-key legend genuinely needs more room
  // than one with two bars, and this is the number that says so.
  let comfortAreaW = COMFORT_PLOT_AREA_MM;
  let markCount = 1;
  if (geometry?.kind === 'categorical') {
    const marks = Math.max(1, geometry.categories.length);
    const keys = Math.max(1, geometry.legend.length);
    markCount = marks;
    comfortAreaW = Math.max(
      COMFORT_PLOT_AREA_MM,
      marks * keys * BAR_PITCH_MM + (marks - 1) * GROUP_GAP_MM,
    );
  } else if (geometry?.kind === 'grid') {
    const cols = new Set(geometry.cells.map((c) => c.col)).size;
    markCount = Math.max(1, geometry.cells.length);
    comfortAreaW = Math.max(COMFORT_PLOT_AREA_MM, cols * CELL_COMFORT_MM);
  } else if (geometry?.kind === 'continuous') {
    markCount = Math.max(1, geometry.series.reduce((sum, s) => sum + s.points.length, 0));
  }

  // Bracket headroom from the *count*, never their placement — the same
  // termination argument `annotationReserveMm` already rests on.
  const brackets = Object.values(doc.nodes).filter(
    (n) => n.type === 'bracket' && n.plotId === plot.id,
  ).length;
  const comfortAreaH = Math.max(
    COMFORT_PLOT_HEIGHT_MM,
    brackets * bracketStepMm(theme) + COMFORT_PLOT_HEIGHT_MM,
  );

  const minWidthMm = marginX + MIN_PLOT_AREA_MM;
  const minHeightMm = marginY + MIN_PLOT_AREA_MM;

  return {
    panelId: panel.id,
    kind: 'plot',
    minWidthMm,
    minHeightMm,
    comfortWidthMm: Math.max(minWidthMm, marginX + comfortAreaW),
    comfortHeightMm: Math.max(minHeightMm, marginY + comfortAreaH),
    aspect: null,
    aspectFromContent: false,
    // A dense scatter is doing more work than a two-bar chart and should
    // outrank it, but no plot outranks a detailed micrograph: the ceiling here
    // sits below `imagePanelDemand`'s own floor for a real picture.
    priority: Math.min(0.8, Math.max(0.3, 0.3 + 0.05 * Math.log2(1 + markCount))),
    rejectAboveWidthMm: Number.POSITIVE_INFINITY,
    cappedByPage: false,
    fontScale,
  };
}

/** Every panel's demand at one font scale. */
export function measurePanelDemands(
  doc: FigureDocument,
  theme: Theme,
  options: PanelDemandOptions,
  fontScale = 1,
): Map<NodeId, PanelDemand> {
  const out = new Map<NodeId, PanelDemand>();
  const usableWidthMm = options.pageWidthMm - 2 * options.marginMm - options.labelGutterMm;

  for (const node of readingOrder(doc.nodes)) {
    if (node.type !== 'panel') continue;
    const panel = node;
    const plot = Object.values(doc.nodes).find(
      (child): child is PlotNode => child.parentId === panel.id && child.type === 'plot',
    );

    out.set(
      panel.id,
      plot
        ? plotPanelDemand(doc, panel, plot, theme, options, fontScale)
        : imagePanelDemand(doc, panel, {
            usableWidthMm,
            exportDpi: options.exportDpi,
            fontScale,
          }),
    );
  }
  return out;
}

/**
 * Scale a theme's type sizes, clamped to its own floor and ceiling.
 *
 * The floor is the whole point: journals state a minimum body size and
 * `checkTextSize` enforces exactly this number, so a layout that buys space by
 * going under it has bought a rejection. Rounded to 0.1 pt so the figure
 * reported to the author is the figure that is set.
 */
export function scaledTypeScale(theme: Theme, scale: number): Record<string, number> {
  const out: Record<string, number> = {};
  const keys: (keyof TypeScale)[] = [
    'panelLabelPt',
    'axisTitlePt',
    'tickLabelPt',
    'legendPt',
    'annotationPt',
    'statisticPt',
    'scaleBarPt',
  ];
  for (const key of keys) {
    const raw = theme.type[key] * scale;
    const clamped = Math.min(theme.type.maximumPt, Math.max(theme.type.minimumPt, raw));
    out[key] = Math.round(clamped * 10) / 10;
  }
  return out;
}

/**
 * Measure every font scale the solver may choose between.
 *
 * Scales whose clamped sizes come out identical are collapsed, so a theme
 * already sitting on its own floor offers one option rather than three that do
 * the same thing and differ only in what they claim to have cost.
 */
export function measureScaleInputs(
  doc: FigureDocument,
  theme: Theme,
  resolveScaled: (typeScale: Record<string, number>) => Theme,
  options: PanelDemandOptions,
): SmartLayoutScaleInput[] {
  const seen = new Set<string>();
  const scales: SmartLayoutScaleInput[] = [];

  for (const fontScale of FONT_SCALES) {
    const typeScale = scaledTypeScale(theme, fontScale);
    const key = JSON.stringify(typeScale);
    if (seen.has(key)) continue;
    seen.add(key);

    const scaledTheme = fontScale === 1 ? theme : resolveScaled(typeScale);
    const demands = measurePanelDemands(doc, scaledTheme, options, fontScale);
    scales.push({
      fontScale,
      typeScale,
      minPt: Math.min(...Object.values(typeScale)),
      demands: [...demands.values()],
    });
  }

  return scales;
}
