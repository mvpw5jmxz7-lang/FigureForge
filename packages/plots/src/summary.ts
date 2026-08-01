/**
 * Descriptive statistics for plot marks.
 *
 * These drive what is *drawn* — bar heights, error bar extents, box hinges.
 * Inferential statistics (p-values, effect sizes) come from the Python service;
 * nothing here decides significance.
 */

import { deviation, max, mean, median, min, quantile } from 'd3-array';

export type ErrorBarKind = 'none' | 'sd' | 'sem' | 'ci95' | 'range' | 'iqr';
export type CenterKind = 'mean' | 'median';

export interface SeriesSummary {
  n: number;
  mean: number;
  median: number;
  /** Sample standard deviation (n−1 denominator). */
  sd: number;
  /** Standard error of the mean. */
  sem: number;
  q1: number;
  q3: number;
  min: number;
  max: number;
  /** Tukey whisker ends: furthest points within 1.5 × IQR of the hinges. */
  lowerWhisker: number;
  upperWhisker: number;
  outliers: number[];
}

/**
 * Two-sided 95% t multiplier by degrees of freedom. Using 1.96 for small n —
 * the common shortcut — understates the interval badly at the sample sizes
 * biology actually runs (n = 3 needs 4.303, not 1.96).
 */
const T_95: Record<number, number> = {
  1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365,
  8: 2.306, 9: 2.262, 10: 2.228, 11: 2.201, 12: 2.179, 13: 2.16, 14: 2.145,
  15: 2.131, 16: 2.12, 17: 2.11, 18: 2.101, 19: 2.093, 20: 2.086, 21: 2.08,
  22: 2.074, 23: 2.069, 24: 2.064, 25: 2.06, 26: 2.056, 27: 2.052, 28: 2.048,
  29: 2.045, 30: 2.042, 40: 2.021, 50: 2.009, 60: 2.0, 80: 1.99, 100: 1.984,
};

export function tCritical95(df: number): number {
  if (df <= 0) return Number.NaN;
  const exact = T_95[df];
  if (exact !== undefined) return exact;
  if (df > 100) return 1.96;
  // Interpolate between the nearest tabulated degrees of freedom.
  const keys = Object.keys(T_95).map(Number).sort((a, b) => a - b);
  let lower = keys[0]!;
  let upper = keys[keys.length - 1]!;
  for (const k of keys) {
    if (k <= df) lower = k;
    if (k >= df) {
      upper = k;
      break;
    }
  }
  if (lower === upper) return T_95[lower]!;
  const t = (df - lower) / (upper - lower);
  return T_95[lower]! + t * (T_95[upper]! - T_95[lower]!);
}

export function summarize(values: readonly number[]): SeriesSummary {
  const clean = values.filter((v) => Number.isFinite(v));
  const n = clean.length;

  if (n === 0) {
    return {
      n: 0, mean: Number.NaN, median: Number.NaN, sd: Number.NaN, sem: Number.NaN,
      q1: Number.NaN, q3: Number.NaN, min: Number.NaN, max: Number.NaN,
      lowerWhisker: Number.NaN, upperWhisker: Number.NaN, outliers: [],
    };
  }

  const sorted = [...clean].sort((a, b) => a - b);
  const m = mean(clean)!;
  const sd = n > 1 ? (deviation(clean) ?? 0) : 0;
  const q1 = quantile(sorted, 0.25)!;
  const q3 = quantile(sorted, 0.75)!;
  const iqr = q3 - q1;

  const fenceLow = q1 - 1.5 * iqr;
  const fenceHigh = q3 + 1.5 * iqr;
  const inFence = sorted.filter((v) => v >= fenceLow && v <= fenceHigh);

  return {
    n,
    mean: m,
    median: median(sorted)!,
    sd,
    sem: n > 1 ? sd / Math.sqrt(n) : 0,
    q1,
    q3,
    min: min(sorted)!,
    max: max(sorted)!,
    lowerWhisker: inFence.length > 0 ? inFence[0]! : sorted[0]!,
    upperWhisker: inFence.length > 0 ? inFence[inFence.length - 1]! : sorted[sorted.length - 1]!,
    outliers: sorted.filter((v) => v < fenceLow || v > fenceHigh),
  };
}

export interface ErrorInterval {
  center: number;
  low: number;
  high: number;
  /** Legend-ready description, e.g. "mean ± s.e.m.". */
  label: string;
}

/**
 * Resolve the centre and error extent to draw.
 *
 * Note SD and SEM answer different questions — SD describes the spread of the
 * data, SEM the precision of the mean — so the label is generated alongside the
 * numbers to push authors toward stating which they plotted.
 */
export function errorInterval(
  summary: SeriesSummary,
  center: CenterKind,
  kind: ErrorBarKind,
): ErrorInterval {
  const c = center === 'mean' ? summary.mean : summary.median;
  const centerLabel = center === 'mean' ? 'mean' : 'median';

  switch (kind) {
    case 'sd':
      return { center: c, low: c - summary.sd, high: c + summary.sd, label: `${centerLabel} ± s.d.` };
    case 'sem':
      return { center: c, low: c - summary.sem, high: c + summary.sem, label: `${centerLabel} ± s.e.m.` };
    case 'ci95': {
      const half = tCritical95(summary.n - 1) * summary.sem;
      return { center: c, low: c - half, high: c + half, label: `${centerLabel} with 95% CI` };
    }
    case 'range':
      return { center: c, low: summary.min, high: summary.max, label: `${centerLabel} with range` };
    case 'iqr':
      return { center: c, low: summary.q1, high: summary.q3, label: `${centerLabel} with IQR` };
    case 'none':
    default:
      return { center: c, low: c, high: c, label: centerLabel };
  }
}
