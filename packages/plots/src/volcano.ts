/**
 * Volcano-plot classification: which side of a significance threshold a
 * point falls on. Pure comparison math, no colour and no rendering —
 * `packages/render` resolves category to colour, in one place, for both the
 * vector and the rasterised point-cloud paths.
 */

import type { VolcanoCategory, VolcanoSamCurve, VolcanoThresholds } from '@figureforge/doc-model';

export type { VolcanoCategory, VolcanoSamCurve, VolcanoThresholds };
export { DEFAULT_VOLCANO_THRESHOLDS } from '@figureforge/doc-model';

export const negLog10 = (p: number): number => -Math.log10(p);

/**
 * Classify against fold-change and an already -log10-transformed p-value —
 * the same transformed space the y axis is built in, so this compares once
 * rather than comparing p, then un-transforming to compare again.
 *
 * A p of exactly 0 transforms to `Infinity`, which is a legitimate "as
 * significant as it gets" reading, not an error, so it is not rejected here.
 * A non-finite fold change, or a `NaN` transformed p-value (from a negative
 * or otherwise invalid raw p), reads as not-significant rather than
 * mis-sorted into 'up' or 'down' by a comparison that would silently be
 * `false` either way.
 *
 * `qValue` is read instead of `negLog10PValue` for the significance gate only
 * when `thresholds.significanceBy === 'fdr'` and both `thresholds.fdr` and
 * `qValue` are present and finite — otherwise the gate is exactly what it was
 * before this parameter existed. The fold-change comparison that decides up
 * vs. down never changes: an FDR mode still needs an effect-size direction.
 */
export function volcanoCategory(
  log2FoldChange: number,
  negLog10PValue: number,
  thresholds: VolcanoThresholds,
  qValue?: number,
): VolcanoCategory {
  if (!Number.isFinite(log2FoldChange)) return 'ns';

  const useFdr =
    thresholds.significanceBy === 'fdr' &&
    thresholds.fdr !== undefined &&
    qValue !== undefined &&
    Number.isFinite(qValue);
  const significant = useFdr
    ? qValue! <= thresholds.fdr!
    : !Number.isNaN(negLog10PValue) && negLog10PValue >= negLog10(thresholds.pValue);
  if (!significant) return 'ns';

  if (log2FoldChange >= thresholds.foldChange) return 'up';
  if (log2FoldChange <= -thresholds.foldChange) return 'down';
  return 'ns';
}

/**
 * Tolerance on "at or above the boundary", in −log10(p).
 *
 * Two reasons a bare `>=` is wrong here, and they compound. SAM's own rule is
 * inclusive (`d >= cut`), and `cut` is *set to* the `d` of the least extreme
 * protein it calls — so that protein sits exactly on the boundary. And the
 * boundary reaching this function is a sampled polyline, whose chords lie
 * slightly *above* the convex curve they approximate, so interpolation
 * systematically over-states it and under-calls significance. Measured on a
 * real 100-protein export, the two boundary-defining proteins missed by
 * 3.1e-4 and 1.9e-4 against a 256-sample curve; `CURVE_SAMPLE_POINTS` is now
 * 1024, which brings the worst interpolation error to 1.6e-5.
 *
 * 1e-4 is set from the science rather than from that measurement, so it does
 * not quietly depend on one dataset: it is a factor of 1.00023 in p — a 0.02%
 * difference, far below any distinction a significance call can meaningfully
 * make — and it still clears the residual interpolation error six times over.
 */
const BOUNDARY_EPSILON = 1e-4;

/** One branch, normalised to ascending |x| so both sides share one lookup. */
interface Branch {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
}

function prepareBranch(points: readonly { x: number; y: number }[], sign: 1 | -1): Branch {
  const usable = points
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: sign * p.x, y: p.y }))
    .filter((p) => p.x > 0)
    .sort((a, b) => a.x - b.x);
  return { xs: usable.map((p) => p.x), ys: usable.map((p) => p.y) };
}

/** The boundary's own y at |x|, or null where the boundary does not reach. */
function branchYAt(branch: Branch, absX: number): number | null {
  const { xs, ys } = branch;
  if (xs.length === 0) return null;
  /*
   * Inside the vertical asymptote (`cut * s0`): no standard error makes the
   * boundary fold change this small, so no protein here is ever called,
   * however significant its p-value. Withheld rather than extrapolated — the
   * same stance every other refusal in this codebase takes.
   */
  if (absX < xs[0]!) return null;
  // Past the far end the boundary flattens toward its floor. Unreachable in
  // practice (the service sweeps a thousandfold past the observed spread), but
  // reading an enormous fold change as *not* significant would be the wrong
  // way to fail, so it clamps rather than refusing.
  if (absX >= xs[xs.length - 1]!) return ys[ys.length - 1]!;

  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= absX) lo = mid;
    else hi = mid;
  }
  const span = xs[hi]! - xs[lo]!;
  if (span === 0) return ys[lo]!;
  return ys[lo]! + ((absX - xs[lo]!) / span) * (ys[hi]! - ys[lo]!);
}

/**
 * Classify against a drawn SAM boundary rather than against fixed cutoffs.
 *
 * **"Above this curve" is the test's own verdict, not a proxy for it.** For a
 * protein with effect `fc` and standard error `s`, SAM calls it up when
 * `fc >= cut·(s + s0)`. The curve is the locus `X(s) = cut·(s + s0)`,
 * `Y(s) = -log10(2·sf(X(s)/s, df))`, with `X` strictly increasing in `s` and
 * `Y` strictly decreasing. Writing `s*` for the `s` at which `X(s*) = fc`:
 * `fc >= cut·(s + s0)` ⟺ `s <= s*` ⟺ `fc/s >= fc/s*` ⟺ `y >= Y(s*)`. Every
 * step is an equivalence, so the two rules agree exactly.
 *
 * Which is why colouring from `volcanoThresholds` instead was not merely a
 * second opinion but a wrong one: it adds a `|fc| >= foldChange` gate the
 * boundary does not have. Measured against the service's own per-protein
 * verdict on a real export, that rule disagreed on **47 of 100** proteins
 * while this one disagrees on none.
 *
 * A factory, not a per-point function: the branches have to be sorted before
 * they can be interpolated, and a real gene list is 10-20k points, so sorting
 * inside the callback would be O(n·m log m). Prepared once here, the per-point
 * cost is one binary search.
 */
export function volcanoCurveClassifier(
  curve: VolcanoSamCurve,
): (log2FoldChange: number, negLog10PValue: number) => VolcanoCategory {
  const up = prepareBranch(curve.up, 1);
  const down = prepareBranch(curve.down, -1);

  return (log2FoldChange, negLog10PValue) => {
    // A non-finite effect or an invalid p reads as not-significant rather than
    // being mis-sorted by a comparison that would silently be false either
    // way — the same stance `volcanoCategory` above takes. A fold change of
    // exactly zero belongs to neither branch.
    if (!Number.isFinite(log2FoldChange) || log2FoldChange === 0) return 'ns';
    if (Number.isNaN(negLog10PValue)) return 'ns';

    const branch = log2FoldChange > 0 ? up : down;
    const boundary = branchYAt(branch, Math.abs(log2FoldChange));
    if (boundary === null) return 'ns';
    if (negLog10PValue < boundary - BOUNDARY_EPSILON) return 'ns';
    return log2FoldChange > 0 ? 'up' : 'down';
  };
}
