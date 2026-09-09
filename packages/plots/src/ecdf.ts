/**
 * The empirical cumulative distribution function: pure numbers, no colour and
 * no rendering. `packages/render` turns these steps into a polyline, the same
 * "plots computes numbers, render draws them" split `kaplanMeier` already
 * follows.
 *
 * This is the curve a Kolmogorov–Smirnov test is defined on, which is why it
 * is worth drawing at all: the test's own statistic is the largest vertical
 * distance between two of these, so an author looking at the plot is looking
 * at the quantity the p-value came from.
 */

/**
 * One riser of the empirical CDF, at one distinct observed value.
 *
 * `y` is `F(x) = #{observations ≤ x} / n` — the height *at and after* this
 * `x`, which is what makes the function right-continuous, the standard
 * convention and the one `scipy.stats.ks_2samp` compares against. It holds
 * from this `x` up to (not including) the next step's `x`.
 */
export interface EcdfStep {
  x: number;
  y: number;
  /** Observations at exactly this `x`. Ties are one step, not several of zero width. */
  count: number;
}

/**
 * The empirical CDF of a sample, as one step per *distinct* value.
 *
 * Non-finite values are dropped, and `n` is the count of what survives — a
 * blank cell is a missing observation, not an observation of zero, and
 * dividing by the raw column length would flatten the curve below 1 by
 * exactly the number of holes in the table.
 *
 * **Ties collapse into a single step.** Emitting one step per observation
 * would put several zero-width risers at the same `x`, which draws as one
 * riser but makes every consumer — the decimator, `ecdfAt`, a KS gap search —
 * iterate duplicates that can never differ. The final step's `y` is exactly
 * `1` by construction, since the last group's cumulative count is `n`.
 *
 * Returns an empty array for a sample with nothing finite in it, rather than
 * a synthetic anchor: unlike `kaplanMeier`, whose curve begins at `(0, 1)` by
 * definition, an ECDF's flat run to the left has no natural starting `x` —
 * where it begins is a property of the *axis*, so the renderer supplies it.
 */
export function ecdfSteps(values: readonly number[]): EcdfStep[] {
  const finite = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (finite.length === 0) return [];

  const n = finite.length;
  const steps: EcdfStep[] = [];
  let i = 0;
  while (i < n) {
    const x = finite[i]!;
    let j = i;
    while (j < n && finite[j] === x) j += 1;
    steps.push({ x, y: j / n, count: j - i });
    i = j;
  }
  return steps;
}

/**
 * `F(x)` for a curve `ecdfSteps` produced: the height of the last step at or
 * below `x`, and `0` below the first observation.
 *
 * Binary search, so a KS gap scan over two large samples stays `O(m log n)`
 * rather than quadratic. Reads the same right-continuous convention the steps
 * are built under, so `ecdfAt(steps, steps[k].x)` is exactly `steps[k].y` —
 * the equality a two-sample statistic evaluated at an observation depends on.
 */
export function ecdfAt(steps: readonly EcdfStep[], x: number): number {
  let lo = 0;
  let hi = steps.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid]!.x <= x) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? 0 : steps[found]!.y;
}
