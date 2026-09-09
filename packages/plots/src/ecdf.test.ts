/**
 * The empirical CDF, against hand-worked values.
 *
 * There is no external reference to cite for a definition this simple, so the
 * arithmetic is written out in each test rather than compared against another
 * implementation's output — the same honest fallback `test_pca.py`'s docstring
 * already models on the Python side. The one place an external check *does*
 * exist is the KS statistic these curves are the input to, and that is
 * asserted here directly: on the repo's `SLEEP` fixture, SciPy's
 * `ks_2samp` reports D = 0.4 at x = 0.0, and that value was hand-verified
 * independently of SciPy — at x = 0, F1 = 5/10 and F2 = 1/10.
 */

import { describe, expect, it } from 'vitest';
import { ecdfAt, ecdfSteps } from './ecdf.js';

/** Student's 1908 sleep data, the same two groups the stats suite uses. */
const SLEEP_1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0];
const SLEEP_2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4];

describe('ecdfSteps', () => {
  it('rises by 1/n at each distinct observation and ends at exactly 1', () => {
    const steps = ecdfSteps([3, 1, 2, 4]);
    expect(steps.map((s) => s.x)).toEqual([1, 2, 3, 4]);
    expect(steps.map((s) => s.y)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(steps[steps.length - 1]!.y).toBe(1);
  });

  it('collapses ties into one step rather than several of zero width', () => {
    /*
     * Four observations, two of them equal: the curve has three risers, and
     * the one at 2 is twice the height of its neighbours. Emitting one step
     * per observation would draw the same picture while making every consumer
     * iterate a duplicate that can never differ.
     */
    const steps = ecdfSteps([1, 2, 2, 3]);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.x)).toEqual([1, 2, 3]);
    expect(steps.map((s) => s.y)).toEqual([0.25, 0.75, 1]);
    expect(steps[1]!.count).toBe(2);
  });

  it('divides by what it could read, not by the length of the column', () => {
    /*
     * A blank cell is a missing observation, not an observation of zero.
     * Dividing by the raw length would leave the curve short of 1 by exactly
     * the number of holes in the table — a curve that visibly never completes.
     */
    const steps = ecdfSteps([1, Number.NaN, 2, Number.POSITIVE_INFINITY, 3]);
    expect(steps.map((s) => s.y)).toEqual([1 / 3, 2 / 3, 1]);
  });

  it('returns nothing for a column with no finite value in it', () => {
    expect(ecdfSteps([])).toEqual([]);
    expect(ecdfSteps([Number.NaN])).toEqual([]);
  });
});

describe('ecdfAt', () => {
  it('is right-continuous: F(x) counts the observations at x too', () => {
    const steps = ecdfSteps([1, 2, 3, 4]);
    expect(ecdfAt(steps, 0.9)).toBe(0);
    // Exactly on an observation, the step has already risen — the convention
    // `scipy.stats.ks_2samp` evaluates against.
    expect(ecdfAt(steps, 1)).toBe(0.25);
    expect(ecdfAt(steps, 1.5)).toBe(0.25);
    expect(ecdfAt(steps, 4)).toBe(1);
    expect(ecdfAt(steps, 100)).toBe(1);
  });

  it('reproduces the Kolmogorov–Smirnov statistic SciPy reports for SLEEP', () => {
    /*
     * D = sup|F1(x) - F2(x)|, and the supremum of a difference of two step
     * functions is always attained at one of their own observations — so
     * scanning the pooled sample finds it exactly, with no grid.
     *
     * SciPy's `ks_2samp(SLEEP_1, SLEEP_2)` gives D = 0.4 with
     * `statistic_location = 0.0`. Hand-checked at that x: five of group 1's
     * ten values are ≤ 0 (-1.6, -1.2, -0.2, -0.1, 0.0) and one of group 2's
     * (-0.1), so |0.5 - 0.1| = 0.4 — which is what makes this a real external
     * reference rather than agreement with ourselves.
     */
    const a = ecdfSteps(SLEEP_1);
    const b = ecdfSteps(SLEEP_2);

    let best = 0;
    let at = Number.NaN;
    for (const x of [...SLEEP_1, ...SLEEP_2]) {
      const gap = Math.abs(ecdfAt(a, x) - ecdfAt(b, x));
      if (gap > best) {
        best = gap;
        at = x;
      }
    }

    expect(best).toBeCloseTo(0.4, 12);
    expect(at).toBe(0.0);
  });
});
