/**
 * Mark geometry.
 *
 * Every function here returns plain millimetre coordinates. Nothing draws, and
 * nothing knows about SVG — the renderer turns these into scene nodes. Keeping
 * the split lets the geometry be unit-tested against exact numbers.
 */

import type { BandScale, NumericScale } from './scales.js';
import {
  errorInterval,
  kernelDensity,
  summarize,
  type CenterKind,
  type ErrorBarKind,
} from './summary.js';

/**
 * Which physical edge the band (category) axis runs along. `'vertical'` is
 * every plot before this existed: categories along the bottom, bars growing
 * up. `'horizontal'` runs categories down the left, bars growing right.
 *
 * `BandScale`/`NumericScale` are already axis-agnostic — `options.band` and
 * `options.y` below are configured by the caller with whichever physical
 * range matches the orientation, so every `scale()`/`center()` call already
 * returns the correct physical mm. This flag only decides which *field*
 * (`x` vs `y`, `width` vs `height`) each already-correct number is written
 * into for `BarGeometry`/`PointGeometry` — the one seam where that decision
 * can be made once and the renderer needs no orientation awareness at all.
 */
export type MarkOrientation = 'vertical' | 'horizontal';

export interface BarGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Baseline the bar grows from, in mm. */
  baselineMm: number;
}

export interface ErrorBarGeometry {
  /** Position along the band (category) axis. */
  bandMm: number;
  /** Value-axis position of the statistically low end of the interval. */
  lowMm: number;
  /** Value-axis position of the statistically high end. */
  highMm: number;
  capHalfWidthMm: number;
  /**
   * True when only the high-value end is drawn.
   *
   * Bar charts conventionally hide the low-value cap, which normally sits
   * inside the bar's own extent — the renderer used to go further and drop
   * the whole lower segment, so a figure showed half of the spread that was
   * measured. It is now an explicit choice on the plot (`errorBarDirection`),
   * defaulting to both directions. Orientation-agnostic: it always means
   * "hide the low value," not "hide whichever end is physically upper."
   */
  upperOnly: boolean;
}

export interface PointGeometry {
  x: number;
  y: number;
  value: number;
  /** Per-point identity, e.g. a gene name. Only `xyMarks` given `pointLabels` sets this. */
  label?: string;
  /** Per-point classification, e.g. a volcano significance category. Only `xyMarks` given `classify` sets this. */
  category?: string;
}

export interface BoxGeometry {
  /** Edge of the box nearer the band scale's start (band centre minus half width). */
  bandMm: number;
  /** Extent of the box along the band (category) axis. */
  bandWidthMm: number;
  /** Hinges/whiskers along the value axis, in data-statistical (not physical-screen) order. */
  q1Mm: number;
  q3Mm: number;
  medianMm: number;
  lowerWhiskerMm: number;
  upperWhiskerMm: number;
  capHalfWidthMm: number;
}

export interface ViolinGeometry {
  /** Centre of the violin along the band (category) axis. */
  bandCenterMm: number;
  /**
   * Half-width in mm at each value-axis position, ordered by increasing
   * value. The renderer mirrors this about `bandCenterMm` to close the path.
   */
  profile: { valueMm: number; halfWidthMm: number }[];
}

export interface SeriesMarks {
  name: string;
  color: string;
  bar: BarGeometry | null;
  errorBar: ErrorBarGeometry | null;
  box: BoxGeometry | null;
  violin: ViolinGeometry | null;
  points: PointGeometry[];
  /** Tukey outliers, drawn only by box plots — empty for every other type. */
  outliers: PointGeometry[];
  centerMm: number;
  /**
   * Value-axis position of the highest (statistically extreme) drawn
   * feature — where a significance bracket must clear on a vertical plot.
   * Only meaningful for `'vertical'` orientation: a horizontal plot refuses
   * brackets entirely (`measurePlot` returns empty measurements before this
   * is ever read), so the number is computed the same way regardless of
   * orientation but is unused when horizontal.
   */
  topMm: number;
  n: number;
  errorLabel: string;
}

export interface MarkOptions {
  band: BandScale;
  y: NumericScale;
  center: CenterKind;
  errorBars: ErrorBarKind;
  /** 'both' draws the full symmetric whisker; 'up' keeps the bar convention. */
  errorBarDirection?: 'both' | 'up';
  barWidthFraction: number;
  showBar: boolean;
  showBox: boolean;
  showViolin: boolean;
  showPoints: boolean;
  pointSizeMm: number;
  jitterMm: number;
  /** 'jitter' scatters randomly; 'beeswarm' packs without overlap. */
  pointLayout: 'jitter' | 'beeswarm';
  colors: readonly string[];
  /** Seeded so jitter is stable across re-renders and identical on export. */
  seed?: number;
  /** Absent means `'vertical'`, today's only behaviour. */
  orientation?: MarkOrientation;
}

/**
 * Deterministic PRNG (mulberry32). Jitter must not move between the screen and
 * the exported PDF, so Math.random is not an option anywhere in the render path.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pack points into a swarm: walk outward from the centre line and take the
 * first offset that clears every point already placed within one diameter
 * vertically.
 */
export function beeswarmOffsets(
  positionsMm: readonly number[],
  diameterMm: number,
): number[] {
  const order = positionsMm
    .map((y, i) => ({ y, i }))
    .sort((a, b) => a.y - b.y);

  const offsets = new Array<number>(positionsMm.length).fill(0);
  const placed: { y: number; x: number }[] = [];

  for (const { y, i } of order) {
    const neighbours = placed.filter((p) => Math.abs(p.y - y) < diameterMm);

    let offset = 0;
    if (neighbours.length > 0) {
      const step = diameterMm;
      let found = false;
      for (let k = 0; k <= neighbours.length + 1 && !found; k++) {
        for (const candidate of k === 0 ? [0] : [k * step, -k * step]) {
          const clear = neighbours.every(
            (p) => Math.hypot(candidate - p.x, y - p.y) >= diameterMm * 0.98,
          );
          if (clear) {
            offset = candidate;
            found = true;
            break;
          }
        }
      }
    }

    offsets[i] = offset;
    placed.push({ y, x: offset });
  }

  return offsets;
}

/**
 * Place a band-axis extent and a value-axis extent into physical `x/y/
 * width/height`. `options.band`/`options.y` are already configured by the
 * caller with the physical range matching the orientation, so the two
 * extents passed in are already correct mm — this only decides which
 * struct field each goes into.
 */
function placeRect(
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

/** Place a band-axis position and a value-axis position into physical `x/y`. */
function placePoint(
  orientation: MarkOrientation,
  bandMm: number,
  valueMm: number,
): { x: number; y: number } {
  return orientation === 'horizontal' ? { x: valueMm, y: bandMm } : { x: bandMm, y: valueMm };
}

/** Build the marks for one categorical series (bar / dot / bar+dot plots). */
export function categoricalMarks(
  series: readonly { name: string; values: readonly number[] }[],
  options: MarkOptions,
): SeriesMarks[] {
  const orientation = options.orientation ?? 'vertical';
  const random = mulberry32(options.seed ?? 0x5eed);
  // A broken axis maps a value inside a gap to NaN, and zero can land in one.
  // The range start is the honest fallback: it is where the axis begins.
  const rawBaseline = options.y.scale(clampToDomain(0, options.y));
  const baselineMm = Number.isFinite(rawBaseline) ? rawBaseline : options.y.range[0];

  return series.map((s, index) => {
    const stats = summarize(s.values);
    const interval = errorInterval(stats, options.center, options.errorBars);
    const color = options.colors[index % Math.max(1, options.colors.length)] ?? '#000000';

    const bandCenterMm = options.band.center(s.name);
    const barWidth = options.band.bandwidth * options.barWidthFraction;
    const centerMm = options.y.scale(interval.center);

    const bar: BarGeometry | null = options.showBar
      ? {
          ...placeRect(
            orientation,
            bandCenterMm - barWidth / 2,
            barWidth,
            Math.min(centerMm, baselineMm),
            Math.abs(baselineMm - centerMm),
          ),
          baselineMm,
        }
      : null;

    // A box or violin already shows the whole distribution; an SEM bar drawn
    // through one states the precision of a centre the reader cannot see, so the
    // error bar is suppressed rather than layered on.
    const distributionShown = options.showBox || options.showViolin;

    const errorBar: ErrorBarGeometry | null =
      distributionShown || options.errorBars === 'none' || !Number.isFinite(interval.low)
        ? null
        : {
            bandMm: bandCenterMm,
            lowMm: options.y.scale(interval.low),
            highMm: options.y.scale(interval.high),
            capHalfWidthMm: Math.max(0.5, barWidth * 0.25),
            // Both directions unless the plot explicitly asks for the bar-chart
            // convention: an error bar states a spread, and drawing half of it
            // states half of what was measured.
            upperOnly: options.showBar && options.errorBarDirection === 'up',
          };

    const box: BoxGeometry | null =
      options.showBox && stats.n > 0
        ? {
            bandMm: bandCenterMm - barWidth / 2,
            bandWidthMm: barWidth,
            q1Mm: options.y.scale(stats.q1),
            q3Mm: options.y.scale(stats.q3),
            medianMm: options.y.scale(stats.median),
            lowerWhiskerMm: options.y.scale(stats.lowerWhisker),
            upperWhiskerMm: options.y.scale(stats.upperWhisker),
            capHalfWidthMm: Math.max(0.5, barWidth * 0.25),
          }
        : null;

    let violin: ViolinGeometry | null = null;
    if (options.showViolin) {
      const density = kernelDensity(s.values, stats);
      const peak = Math.max(...density.map((d) => d.density), 0);
      if (density.length > 0 && peak > 0) {
        const halfMax = barWidth / 2;
        violin = {
          bandCenterMm,
          // Scaled so the widest point of each violin fills its band. Widths are
          // therefore comparable *within* a series, not across them — the same
          // convention as every violin implementation.
          profile: density.map((d) => ({
            valueMm: options.y.scale(d.value),
            halfWidthMm: (d.density / peak) * halfMax,
          })),
        };
      }
    }

    // Outliers are the box plot's points — but only when the plot is not already
    // showing every point, or each outlier would be drawn twice, once here and
    // once in the overlay.
    const outliers: PointGeometry[] =
      box && !options.showPoints
        ? stats.outliers
            .map((value) => ({ value, valueMm: options.y.scale(value) }))
            // Dropped, not clamped: an axis that says it does not show a range
            // must not show a mark there.
            .filter((p) => Number.isFinite(p.valueMm))
            .map((p) => ({ ...placePoint(orientation, bandCenterMm, p.valueMm), value: p.value }))
        : [];

    let points: PointGeometry[] = [];
    if (options.showPoints) {
      const finite = s.values.filter((v) => Number.isFinite(v));
      const ys = finite.map((v) => options.y.scale(v));
      const spread = Math.min(options.jitterMm, barWidth / 2);

      const offsets =
        options.pointLayout === 'beeswarm'
          ? clampOffsets(beeswarmOffsets(ys, options.pointSizeMm), spread)
          : ys.map(() => (random() * 2 - 1) * spread);

      points = finite
        .map((value, i) => ({ value, valueMm: ys[i]!, offset: offsets[i] ?? 0 }))
        .filter((p) => Number.isFinite(p.valueMm))
        .map((p) => ({
          ...placePoint(orientation, bandCenterMm + p.offset, p.valueMm),
          value: p.value,
        }));
    }

    // Bracket clearance is always computed in value-axis terms — the same
    // numbers regardless of orientation — since only a vertical plot ever
    // reads this (a horizontal plot refuses brackets before this is used).
    const candidates = [centerMm].filter(Number.isFinite);
    if (bar) candidates.push(Math.min(centerMm, baselineMm));
    if (errorBar) candidates.push(errorBar.highMm);
    // The whisker cap, not the hinge — a bracket placed off q3 sits inside the plot.
    if (box) candidates.push(box.upperWhiskerMm);
    if (violin) for (const p of violin.profile) candidates.push(p.valueMm);
    // Mirrors exactly which values `points`/`outliers` above actually draw —
    // outliers only when box is shown and points are not (or they'd double
    // count), points only when shown at all.
    const clearanceValues = [
      ...(box && !options.showPoints ? stats.outliers : []),
      ...(options.showPoints ? s.values : []),
    ];
    for (const value of clearanceValues) {
      const valueMm = options.y.scale(value);
      if (Number.isFinite(valueMm)) candidates.push(valueMm - options.pointSizeMm / 2);
    }

    return {
      name: s.name,
      color,
      bar,
      errorBar,
      box,
      violin,
      points,
      outliers,
      centerMm,
      // y is inverted, so the visual top is the minimum. Empty only when every
      // mark fell inside an axis break, in which case there is nothing to clear.
      topMm: candidates.length > 0 ? Math.min(...candidates) : 0,
      n: stats.n,
      errorLabel: interval.label,
    };
  });
}

/** Keep a swarm inside its slot rather than letting it bleed into the neighbour. */
function clampOffsets(offsets: readonly number[], limitMm: number): number[] {
  const widest = Math.max(...offsets.map(Math.abs), 0);
  if (widest <= limitMm || widest === 0) return [...offsets];
  const factor = limitMm / widest;
  return offsets.map((o) => o * factor);
}

function clampToDomain(value: number, scale: NumericScale): number {
  return Math.max(scale.domain.min, Math.min(scale.domain.max, value));
}

// ---------------------------------------------------------------------------
// Continuous x: scatter, line, histogram
// ---------------------------------------------------------------------------

export interface XySeriesMarks {
  name: string;
  color: string;
  points: PointGeometry[];
  /**
   * Vertices of the connecting line in mm, already ordered by x — or null when
   * the plot draws no line. Sorting is not cosmetic: a line drawn in row order
   * over unsorted x values is a scribble, not a trend.
   */
  linePath: { x: number; y: number }[] | null;
  /**
   * Upper and lower edge of the error interval at each x, ordered by x — or
   * null when the series carries no replicates to compute one from.
   *
   * The renderer closes it into a polygon. Held as two ordered edges rather
   * than as a path so the renderer decides how to close it, and so a caller
   * that wants whiskers instead can read the same numbers.
   */
  band: { x: number; lowY: number; highY: number }[] | null;
  /**
   * Half-width of an error bar's cap, for a renderer drawing `band` as whiskers
   * rather than as a polygon.
   *
   * Sized here rather than in the renderer because it is a number about the
   * data's spacing: a fixed extent, clamped so a cap can never reach its
   * neighbour on a series whose timepoints bunch up. The categorical path takes
   * its cap from the bar width for the same reason; an xy plot has no band to
   * measure, so the gap between adjacent x is what stands in for one.
   */
  capHalfWidthMm: number;
  /**
   * Every replicate, when the series was summarised and the plot asked to show
   * them. Empty otherwise.
   *
   * Kept apart from `points` so that stays exactly what it always was — what the
   * plot draws a marker at, the centres once a series is summarised. Folding the
   * replicates into it would silently change the meaning of a field the line
   * path, the bracket clearance and the legend all read.
   */
  replicatePoints: PointGeometry[];
  /**
   * Where a censored subject leaves the curve, for a small tick mark at the
   * curve's current height. Empty except on a survival plot — `xyMarks` never
   * populates it; only `render-document.ts`'s dedicated survival geometry
   * builder does, since censoring is a concept `xyMarks`'s generic pairing has
   * no reason to know about.
   */
  censorPoints: PointGeometry[];
  /** What the band or the bars represent, e.g. "mean ± s.d.". */
  errorLabel: string;
  n: number;
  topMm: number;
  /**
   * This series' own zero line in mm, offset included. `null` only where a
   * geometry builder assembles `XySeriesMarks` by hand and zero has no
   * meaning — survival's Kaplan–Meier curve, whose y is a probability, not a
   * quantity with a baseline. The renderer needs this rather than
   * re-deriving it: once an offset is baked into `points`/`linePath`, the
   * "which value is zero" fact is gone unless it travels with the series.
   */
  baselineMm: number | null;
  /**
   * This series' own x=0 line in mm, offset included — the horizontal-lean
   * counterpart to `baselineMm`, for a cascade whose `offsetStepXMm` is
   * nonzero. `null` under the same conditions `baselineMm` is.
   */
  baselineXMm: number | null;
  /**
   * The cascade offset actually baked into this series' coordinates, `{x:0,
   * y:0}` when none was requested. Kept alongside the offset numbers rather
   * than requiring a caller to recompute it from `PlotNode.offsetStepMm` and
   * the series index — the same "compose it once" discipline
   * `analysisInputHash`/`scaleBarWidthMm` already follow.
   */
  offsetMm: { x: number; y: number };
  /**
   * This series' own `Series.category`, carried alongside the geometry
   * rather than requiring a caller to re-zip it back in from the original
   * `series` array by index — the same "compose it once, travel with the
   * series" discipline `offsetMm`/`baselineMm` already follow. Used by the
   * cascade depth axis to group contiguous series sharing one category;
   * `undefined` for a series with no category, or wherever this type is
   * built by hand rather than through `xyMarks` (survival's curves have no
   * comparable data-source concept).
   */
  category?: string;
}

export interface XyMarkOptions {
  x: NumericScale;
  y: NumericScale;
  /**
   * Per-series y scale, for a plot with a second axis on the right. Indexed by
   * series order — the same key the palette uses, so it needs no names and
   * cannot go stale when a series is renamed. A missing entry means `y`.
   */
  ySeries?: readonly (NumericScale | undefined)[];
  showLine: boolean;
  showPoints: boolean;
  pointSizeMm: number;
  colors: readonly string[];
  /**
   * Collapse replicates sharing an x to their centre, and return the error
   * interval around it.
   *
   * Only meaningful for a table that carries several y at one x — Prism's XY
   * with replicate subcolumns. Absent, every replicate stays its own point,
   * which is what a scatter of the raw data should be.
   */
  summariseAtX?: { center: CenterKind; errorBars: ErrorBarKind };
  /**
   * Also return every replicate, for a plot that draws them behind its means.
   * Only meaningful alongside `summariseAtX`; without it the points already are
   * the replicates.
   */
  showReplicates?: boolean;
  /**
   * Per-point classification, e.g. a volcano plot's up/down/not-significant
   * call — computed from the *raw* (unscaled) pair, before it is placed on the
   * page, so the classification never depends on axis geometry.
   *
   * Only meaningful without `summariseAtX`: a category classifies one
   * measurement, and a summarised point is several.
   */
  classify?: (xValue: number, yValue: number) => string;
  /**
   * A cascade/ridgeline offset in mm, indexed by series order — the same key
   * `ySeries`/`pointShapes`/`seriesAxis` already use, so it needs no names
   * and cannot go stale when a series is renamed. Baked into every scaled
   * coordinate this function produces (points, line, band, tops) rather than
   * left for the renderer to apply as a transform: the point-cloud raster
   * path reads `points` directly with no transform anywhere on it, so a
   * transform would move the vectors and leave the raster behind. Absent or
   * `{x:0, y:0}` for a series leaves it byte-identical to no offset at all.
   */
  offsets?: readonly { x: number; y: number }[];
  /**
   * Drop a mark whose SCALED position falls outside the x scale's own range
   * bounds, the same "check the drawn position, not the raw value" rule a
   * broken axis's NaN already follows — a value outside the domain does not
   * itself become NaN (d3 extrapolates), so this is an explicit bound check
   * rather than a `Number.isFinite` reuse. There is only one x axis, so this
   * applies to every series alike. Absent is today's behaviour: a scale
   * extrapolates for an out-of-domain input, so such a point currently
   * overflows the plot rectangle uncontained.
   */
  clipToXRange?: boolean;
  /**
   * The y equivalent, but per series (indexed like `ySeries`/`offsets`):
   * a series on the secondary axis is clipped against `node.y2`'s own
   * range, never `node.y`'s, since they can disagree about whether to clip
   * at all. Checked against the *already-offset* position on a cascaded
   * plot, so a point pushed out of range by its own offset is dropped
   * rather than shown floating past the axis.
   */
  clipToYRange?: readonly boolean[];
  /**
   * Each series' `Series.category`, indexed by series order like `ySeries`/
   * `offsets` — copied straight onto `XySeriesMarks.category` for the
   * cascade depth axis to read, since `xyMarks` otherwise has no reason to
   * carry this data-source concept through its geometry.
   */
  categories?: readonly (string | undefined)[];
}

function withinRange(v: number, range: readonly [number, number]): boolean {
  const lo = Math.min(range[0], range[1]) - 1e-9;
  const hi = Math.max(range[0], range[1]) + 1e-9;
  return v >= lo && v <= hi;
}

/**
 * Nominal half-width of an error bar cap on a continuous axis, before the
 * clamp against neighbouring points. Matches the visual weight of the
 * categorical path's `barWidth * 0.25` at the default panel size.
 */
const CAP_HALF_WIDTH_MM = 0.7;

/** Paired (x, y) marks for scatter and line plots. */
export function xyMarks(
  series: readonly {
    name: string;
    values: readonly number[];
    x?: readonly number[];
    pointLabels?: readonly string[];
  }[],
  options: XyMarkOptions,
): XySeriesMarks[] {
  return series.map((s, index) => {
    const color = options.colors[index % Math.max(1, options.colors.length)] ?? '#000000';
    const y = options.ySeries?.[index] ?? options.y;
    const off = options.offsets?.[index];
    const xScale = off ? (v: number) => options.x.scale(v) + off.x : (v: number) => options.x.scale(v);
    const yScale = off ? (v: number) => y.scale(v) + off.y : (v: number) => y.scale(v);
    const clipY = options.clipToYRange?.[index] ?? false;
    const inRange = (px: number, py: number): boolean =>
      (!options.clipToXRange || withinRange(px, options.x.range)) && (!clipY || withinRange(py, y.range));

    // Only pairs where both coordinates are real. Dropping the pair rather than
    // the value keeps x and y aligned; dropping one side would shift every
    // subsequent point onto the wrong x.
    const pairs: { xValue: number; yValue: number; label?: string }[] = [];
    for (let i = 0; i < s.values.length; i++) {
      const xValue = s.x?.[i];
      const yValue = s.values[i];
      if (xValue === undefined || yValue === undefined) continue;
      if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) continue;
      pairs.push({ xValue, yValue, label: s.pointLabels?.[i] });
    }

    /*
     * A broken axis maps values inside a gap to NaN, so the drawn position has
     * to be checked as well as the value. Dropping the pair is the whole point:
     * an axis that says it does not show a range must not show a mark there.
     */
    const points: PointGeometry[] = pairs
      .map((p) => ({
        x: xScale(p.xValue),
        y: yScale(p.yValue),
        value: p.yValue,
        ...(p.label !== undefined ? { label: p.label } : {}),
        ...(options.classify ? { category: options.classify(p.xValue, p.yValue) } : {}),
      }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && inRange(p.x, p.y));

    /*
     * Replicates at one x, summarised.
     *
     * A table with three y columns per group arrives here as three pairs
     * sharing each x, so the "line" through them zig-zags between replicates
     * rather than tracing the trend. Grouping by x is what turns that into one
     * point per timepoint with an interval around it.
     */
    const summary = options.summariseAtX;
    let band: XySeriesMarks['band'] = null;
    let errorLabel = '';
    let centres = pairs;

    if (summary) {
      const byX = new Map<number, number[]>();
      for (const p of pairs) {
        const bucket = byX.get(p.xValue);
        if (bucket) bucket.push(p.yValue);
        else byX.set(p.xValue, [p.yValue]);
      }
      const ordered = [...byX.entries()].sort((a, b) => a[0] - b[0]);
      // Only worth summarising if some x actually carries replicates; with one
      // value each the "interval" is zero-width and the band a hairline.
      if (ordered.some(([, vs]) => vs.length > 1)) {
        const intervals = ordered.map(([xValue, values]) => ({
          xValue,
          interval: errorInterval(summarize(values), summary.center, summary.errorBars),
        }));
        errorLabel = intervals[0]?.interval.label ?? '';
        centres = intervals.map((i) => ({ xValue: i.xValue, yValue: i.interval.center }));
        band = intervals
          .map((i) => ({
            x: xScale(i.xValue),
            lowY: yScale(i.interval.low),
            highY: yScale(i.interval.high),
          }))
          .filter(
            (p) =>
              Number.isFinite(p.x) &&
              Number.isFinite(p.lowY) &&
              Number.isFinite(p.highY) &&
              inRange(p.x, p.lowY) &&
              inRange(p.x, p.highY),
          );
        if (band.length < 2) band = null;
      }
    }

    const linePath = options.showLine
      ? [...centres]
          .sort((a, b) => a.xValue - b.xValue)
          .map((p) => ({ x: xScale(p.xValue), y: yScale(p.yValue) }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && inRange(p.x, p.y))
      : null;

    // Summarised, the drawn points are the centres, not every replicate.
    const summarised = summary !== undefined && band !== null;
    const drawnPoints: PointGeometry[] = summarised
      ? centres
          .map((p) => ({ x: xScale(p.xValue), y: yScale(p.yValue), value: p.yValue }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && inRange(p.x, p.y))
      : points;

    /*
     * A cap must not reach its neighbour, so the nominal width is clamped to a
     * share of the smallest gap between adjacent drawn positions. Below two
     * points there is no neighbour and nothing to clamp against.
     */
    const xs = [...(band ?? []).map((p) => p.x)].sort((a, b) => a - b);
    const gaps = xs.slice(1).map((v, i) => v - xs[i]!);
    const capHalfWidthMm =
      gaps.length > 0
        ? Math.min(CAP_HALF_WIDTH_MM, Math.max(0.15, Math.min(...gaps) * 0.25))
        : CAP_HALF_WIDTH_MM;

    const tops = drawnPoints.map((p) => p.y - (options.showPoints ? options.pointSizeMm / 2 : 0));
    // The band reaches above the centres, so a bracket has to clear it too.
    const bandTop = band ? Math.min(...band.map((p) => Math.min(p.lowY, p.highY))) : Infinity;

    return {
      name: s.name,
      color,
      points: options.showPoints ? drawnPoints : [],
      linePath,
      band,
      capHalfWidthMm,
      // Only where they are not already the drawn points; `points` holds the
      // raw pairs when nothing was summarised.
      replicatePoints: summarised && options.showReplicates ? points : [],
      censorPoints: [],
      errorLabel,
      n: pairs.length,
      // y is inverted, so the visual top is the minimum.
      topMm: Math.min(tops.length > 0 ? Math.min(...tops) : 0, bandTop),
      baselineMm: y.scale(clampToDomain(0, y)) + (off?.y ?? 0),
      baselineXMm: options.x.scale(clampToDomain(0, options.x)) + (off?.x ?? 0),
      offsetMm: { x: off?.x ?? 0, y: off?.y ?? 0 },
      ...(options.categories?.[index] !== undefined ? { category: options.categories[index] } : {}),
    };
  });
}

export interface HistogramBin {
  /** Bin bounds in data units, half-open [x0, x1). */
  x0: number;
  x1: number;
  count: number;
  /** Bar geometry in mm. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Freedman–Diaconis bin count, falling back to Sturges.
 *
 * FD keys the bin width off the IQR rather than the range, so a single extreme
 * value cannot collapse the whole histogram into one tall bar — which is exactly
 * what Sturges does on skewed data. When the IQR is zero FD has no width to
 * offer and Sturges takes over.
 */
export function binCountFor(values: readonly number[]): number {
  const stats = summarize(values);
  if (stats.n < 2 || stats.max <= stats.min) return 1;

  const iqr = stats.q3 - stats.q1;
  const width = iqr > 0 ? 2 * iqr * Math.pow(stats.n, -1 / 3) : 0;

  const count =
    width > 0
      ? Math.ceil((stats.max - stats.min) / width)
      : Math.ceil(Math.log2(stats.n)) + 1;

  // A histogram with more bins than points says nothing; one with hundreds of
  // bars is unreadable at journal column width.
  return Math.max(1, Math.min(count, 50, Math.max(1, stats.n)));
}

export interface HistogramMarkOptions {
  x: NumericScale;
  y: NumericScale;
  bins: readonly { x0: number; x1: number; count: number }[];
  /** Fraction of the bin width the bar fills; 1 leaves no gap, as is conventional. */
  barWidthFraction: number;
}

/** Uniform-width bins over the observed range. */
export function histogramBins(
  values: readonly number[],
  binCount?: number | null,
): { x0: number; x1: number; count: number }[] {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return [];

  const stats = summarize(clean);
  const count = Math.max(1, Math.floor(binCount ?? binCountFor(clean)));
  const step = (stats.max - stats.min) / count || 1;

  const bins = Array.from({ length: count }, (_, i) => ({
    x0: stats.min + i * step,
    x1: stats.min + (i + 1) * step,
    count: 0,
  }));

  for (const v of clean) {
    // Half-open bins, except the last: without this the maximum value falls
    // outside every bin and silently vanishes from its own histogram.
    let index = Math.floor((v - stats.min) / step);
    if (index >= count) index = count - 1;
    if (index < 0) index = 0;
    bins[index]!.count++;
  }

  return bins;
}

/** Bar geometry for a histogram, against a numeric x scale. */
export function histogramMarks(options: HistogramMarkOptions): HistogramBin[] {
  const baseline = options.y.scale(clampToDomain(0, options.y));

  return options.bins.map((b) => {
    const left = options.x.scale(b.x0);
    const right = options.x.scale(b.x1);
    const full = Math.abs(right - left);
    const width = full * options.barWidthFraction;
    const top = options.y.scale(b.count);

    return {
      x0: b.x0,
      x1: b.x1,
      count: b.count,
      x: Math.min(left, right) + (full - width) / 2,
      y: Math.min(top, baseline),
      width,
      height: Math.abs(baseline - top),
    };
  });
}
