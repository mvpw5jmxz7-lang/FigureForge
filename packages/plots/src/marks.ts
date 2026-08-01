/**
 * Mark geometry.
 *
 * Every function here returns plain millimetre coordinates. Nothing draws, and
 * nothing knows about SVG — the renderer turns these into scene nodes. Keeping
 * the split lets the geometry be unit-tested against exact numbers.
 */

import type { BandScale, NumericScale } from './scales.js';
import { errorInterval, summarize, type CenterKind, type ErrorBarKind } from './summary.js';

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
  /** True when the lower cap falls inside the bar and should be suppressed. */
  lowerInsideBar: boolean;
}

export interface PointGeometry {
  x: number;
  y: number;
  value: number;
}

export interface SeriesMarks {
  name: string;
  color: string;
  bar: BarGeometry | null;
  errorBar: ErrorBarGeometry | null;
  points: PointGeometry[];
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
  barWidthFraction: number;
  showBar: boolean;
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
  const baselineMm = options.y.scale(clampToDomain(0, options.y));

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

    const errorBar: ErrorBarGeometry | null =
      options.errorBars === 'none' || !Number.isFinite(interval.low)
        ? null
        : {
            x: centerX,
            topMm: options.y.scale(interval.high),
            bottomMm: options.y.scale(interval.low),
            capHalfWidthMm: Math.max(0.5, barWidth * 0.25),
            // Hiding the lower cap under a bar is the standard convention.
            lowerInsideBar: options.showBar,
          };

    let points: PointGeometry[] = [];
    if (options.showPoints) {
      const finite = s.values.filter((v) => Number.isFinite(v));
      const ys = finite.map((v) => options.y.scale(v));
      const spread = Math.min(options.jitterMm, barWidth / 2);

      const offsets =
        options.pointLayout === 'beeswarm'
          ? clampOffsets(beeswarmOffsets(ys, options.pointSizeMm), spread)
          : ys.map(() => (random() * 2 - 1) * spread);

      points = finite.map((value, i) => ({
        x: centerX + (offsets[i] ?? 0),
        y: ys[i]!,
        value,
      }));
    }

    const candidates = [centerMm];
    if (bar) candidates.push(bar.y);
    if (errorBar) candidates.push(errorBar.topMm);
    for (const p of points) candidates.push(p.y - options.pointSizeMm / 2);

    return {
      name: s.name,
      color,
      bar,
      errorBar,
      points,
      centerMm,
      // y is inverted, so the visual top is the minimum.
      topMm: Math.min(...candidates),
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

    const xA = a.bar ? a.bar.x + a.bar.width / 2 : a.errorBar?.x ?? 0;
    const xB = b.bar ? b.bar.x + b.bar.width / 2 : b.errorBar?.x ?? 0;

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
