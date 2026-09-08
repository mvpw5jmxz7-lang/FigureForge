/**
 * Evaluating a stored least-squares fit.
 *
 * The fit itself is computed by the Python service and arrives as a
 * `RegressionFit` — see its own doc comment for why ten sufficient statistics
 * travel instead of a sampled curve. Nothing here fits anything: this module
 * only reads that record, which is the same split `summary.ts`'s header states
 * for the whole package ("inferential statistics come from the Python service;
 * nothing here decides significance"). A second fit computed on this side is
 * exactly how a drawn line and the slope printed beside it come to disagree.
 *
 * Pure arithmetic on plain numbers, with no notion of millimetres, colour or
 * scales — the caller places the results, the same division `volcano.ts` and
 * `fold-fold.ts` already keep.
 */

import type { RegressionFit } from '@figureforge/doc-model';

/** Which of the two intervals a band represents. */
export type IntervalKind = 'confidence' | 'prediction';

/** The fitted value at `x`. */
export function fitYAt(fit: RegressionFit, x: number): number {
  return fit.intercept + fit.slope * x;
}

/**
 * Half the width of the interval at `x`.
 *
 *     t * s * sqrt(k + 1/n + (x - meanX)^2 / sumSquaredDevX)
 *
 * `k = 0` gives the confidence interval on the *fitted line* — how well the
 * line's position is known. `k = 1` adds the variance of a single new
 * observation about that line, giving the prediction interval, which is why it
 * is always the wider of the two and why it does not narrow towards zero as n
 * grows.
 *
 * The `(x - meanX)^2` term is what makes both bands hyperbolic: the fit is
 * pinned most tightly at the mean of x and fans out either side, so a band
 * drawn as a constant-width ribbon would understate the uncertainty at exactly
 * the ends a reader extrapolates from.
 */
export function fitHalfWidthAt(fit: RegressionFit, x: number, kind: IntervalKind): number {
  const leverage = (x - fit.meanX) ** 2 / fit.sumSquaredDevX;
  const base = kind === 'prediction' ? 1 : 0;
  return fit.tMultiplier * fit.residualSe * Math.sqrt(base + 1 / fit.n + leverage);
}

/** The fitted value at `x` with the interval's lower and upper edge. */
export function fitIntervalAt(
  fit: RegressionFit,
  x: number,
  kind: IntervalKind,
): { y: number; low: number; high: number } {
  const y = fitYAt(fit, x);
  const half = fitHalfWidthAt(fit, x, kind);
  return { y, low: y - half, high: y + half };
}
