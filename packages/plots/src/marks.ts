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

export interface BarGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Baseline the bar grows from, in mm. */
  baselineMm: number;
}

export interface ErrorBarGeometry {
  x: number;
  /** Upper end (smaller mm value, since y is inverted). */
  topMm: number;
  bottomMm: number;
  capHalfWidthMm: number;
  /**
   * True when only the upper half is drawn.
   *
   * Bar charts conventionally hide the lower cap under the bar, and the
   * renderer used to go further and drop the whole lower segment — so a figure
   * showed half of the spread that was measured. It is now an explicit choice
   * on the plot (`errorBarDirection`), defaulting to both directions.
   */
  upperOnly: boolean;
}

export interface PointGeometry {
  x: number;
  y: number;
  value: number;
}

export interface BoxGeometry {
  /** Left edge of the box. */
  x: number;
  width: number;
  /** Hinges in mm. y is inverted, so q3Mm is the visual top of the box. */
  q1Mm: number;
  q3Mm: number;
  medianMm: number;
  lowerWhiskerMm: number;
  upperWhiskerMm: number;
  capHalfWidthMm: number;
}

export interface ViolinGeometry {
  centerX: number;
  /**
   * Half-width in mm at each grid position, ordered by increasing mm (visually
   * top to bottom). The renderer mirrors this about `centerX` to close the path.
   */
  profile: { yMm: number; halfWidthMm: number }[];
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
  /** Highest drawn feature in mm — where a significance bracket must clear. */
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

/** Build the marks for one categorical series (bar / dot / bar+dot plots). */
export function categoricalMarks(
  series: readonly { name: string; values: readonly number[] }[],
  options: MarkOptions,
): SeriesMarks[] {
  const random = mulberry32(options.seed ?? 0x5eed);
  // A broken axis maps a value inside a gap to NaN, and zero can land in one.
  // The range start is the honest fallback: it is where the axis begins.
  const rawBaseline = options.y.scale(clampToDomain(0, options.y));
  const baselineMm = Number.isFinite(rawBaseline) ? rawBaseline : options.y.range[0];

  return series.map((s, index) => {
    const stats = summarize(s.values);
    const interval = errorInterval(stats, options.center, options.errorBars);
    const color = options.colors[index % Math.max(1, options.colors.length)] ?? '#000000';

    const centerX = options.band.center(s.name);
    const barWidth = options.band.bandwidth * options.barWidthFraction;
    const centerMm = options.y.scale(interval.center);

    const bar: BarGeometry | null = options.showBar
      ? {
          x: centerX - barWidth / 2,
          y: Math.min(centerMm, baselineMm),
          width: barWidth,
          height: Math.abs(baselineMm - centerMm),
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
            x: centerX,
            topMm: options.y.scale(interval.high),
            bottomMm: options.y.scale(interval.low),
            capHalfWidthMm: Math.max(0.5, barWidth * 0.25),
            // Both directions unless the plot explicitly asks for the bar-chart
            // convention: an error bar states a spread, and drawing half of it
            // states half of what was measured.
            upperOnly: options.showBar && options.errorBarDirection === 'up',
          };

    const box: BoxGeometry | null =
      options.showBox && stats.n > 0
        ? {
            x: centerX - barWidth / 2,
            width: barWidth,
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
          centerX,
          // Scaled so the widest point of each violin fills its band. Widths are
          // therefore comparable *within* a series, not across them — the same
          // convention as every violin implementation.
          profile: density.map((d) => ({
            yMm: options.y.scale(d.value),
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
            .map((value) => ({ x: centerX, y: options.y.scale(value), value }))
            // Dropped, not clamped: an axis that says it does not show a range
            // must not show a mark there.
            .filter((p) => Number.isFinite(p.y))
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
        .map((value, i) => ({ x: centerX + (offsets[i] ?? 0), y: ys[i]!, value }))
        .filter((p) => Number.isFinite(p.y));
    }

    const candidates = [centerMm].filter(Number.isFinite);
    if (bar) candidates.push(bar.y);
    if (errorBar) candidates.push(errorBar.topMm);
    // The whisker cap, not the hinge — a bracket placed off q3 sits inside the plot.
    if (box) candidates.push(box.upperWhiskerMm);
    if (violin) for (const p of violin.profile) candidates.push(p.yMm);
    for (const p of [...points, ...outliers]) candidates.push(p.y - options.pointSizeMm / 2);

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

/**
 * Where a bracket end should land, whichever mark family the plot uses. Every
 * variant is centred on its band slot, so this is the one place that has to know
 * which geometry is present.
 */
function markCenterX(mark: SeriesMarks): number {
  if (mark.bar) return mark.bar.x + mark.bar.width / 2;
  if (mark.box) return mark.box.x + mark.box.width / 2;
  if (mark.violin) return mark.violin.centerX;
  return mark.errorBar?.x ?? 0;
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
  n: number;
  topMm: number;
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
}

/** Paired (x, y) marks for scatter and line plots. */
export function xyMarks(
  series: readonly { name: string; values: readonly number[]; x?: readonly number[] }[],
  options: XyMarkOptions,
): XySeriesMarks[] {
  return series.map((s, index) => {
    const color = options.colors[index % Math.max(1, options.colors.length)] ?? '#000000';
    const y = options.ySeries?.[index] ?? options.y;

    // Only pairs where both coordinates are real. Dropping the pair rather than
    // the value keeps x and y aligned; dropping one side would shift every
    // subsequent point onto the wrong x.
    const pairs: { xValue: number; yValue: number }[] = [];
    for (let i = 0; i < s.values.length; i++) {
      const xValue = s.x?.[i];
      const yValue = s.values[i];
      if (xValue === undefined || yValue === undefined) continue;
      if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) continue;
      pairs.push({ xValue, yValue });
    }

    /*
     * A broken axis maps values inside a gap to NaN, so the drawn position has
     * to be checked as well as the value. Dropping the pair is the whole point:
     * an axis that says it does not show a range must not show a mark there.
     */
    const points: PointGeometry[] = pairs
      .map((p) => ({ x: options.x.scale(p.xValue), y: y.scale(p.yValue), value: p.yValue }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

    const linePath = options.showLine
      ? [...pairs]
          .sort((a, b) => a.xValue - b.xValue)
          .map((p) => ({ x: options.x.scale(p.xValue), y: y.scale(p.yValue) }))
          .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      : null;

    const tops = points.map((p) => p.y - (options.showPoints ? options.pointSizeMm / 2 : 0));

    return {
      name: s.name,
      color,
      points: options.showPoints ? points : [],
      linePath,
      n: pairs.length,
      // y is inverted, so the visual top is the minimum.
      topMm: tops.length > 0 ? Math.min(...tops) : 0,
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

// ---------------------------------------------------------------------------
// Significance brackets
// ---------------------------------------------------------------------------

export interface BracketGeometry {
  xA: number;
  xB: number;
  /** Horizontal span of the bracket, in mm. */
  yMm: number;
  tickMm: number;
  labelX: number;
  labelY: number;
}

/**
 * Stack brackets so that overlapping comparisons never collide. Each bracket is
 * lifted above both the data it spans and any bracket already placed beneath it.
 */
export function stackBrackets(
  comparisons: readonly { indexA: number; indexB: number }[],
  marks: readonly SeriesMarks[],
  options: { gapMm: number; stepMm: number; tickMm: number; labelOffsetMm: number },
): BracketGeometry[] {
  const placed: BracketGeometry[] = [];

  // Short spans first, so nested comparisons sit below wider ones.
  const ordered = comparisons
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => Math.abs(a.indexA - b.indexA) - Math.abs(b.indexB - b.indexA));

  const result = new Array<BracketGeometry>(comparisons.length);

  for (const comparison of ordered) {
    const a = marks[comparison.indexA];
    const b = marks[comparison.indexB];
    if (!a || !b) continue;

    const xA = markCenterX(a);
    const xB = markCenterX(b);

    const spanned = marks.slice(
      Math.min(comparison.indexA, comparison.indexB),
      Math.max(comparison.indexA, comparison.indexB) + 1,
    );

    // y is inverted: "above" means a smaller value.
    let y = Math.min(...spanned.map((m) => m.topMm)) - options.gapMm;

    for (const existing of placed) {
      const overlaps =
        Math.min(xA, xB) <= Math.max(existing.xA, existing.xB) &&
        Math.max(xA, xB) >= Math.min(existing.xA, existing.xB);
      if (overlaps) y = Math.min(y, existing.yMm - options.stepMm);
    }

    const geometry: BracketGeometry = {
      xA,
      xB,
      yMm: y,
      tickMm: options.tickMm,
      labelX: (xA + xB) / 2,
      labelY: y - options.labelOffsetMm,
    };

    placed.push(geometry);
    result[comparison.i] = geometry;
  }

  return result.filter(Boolean);
}
