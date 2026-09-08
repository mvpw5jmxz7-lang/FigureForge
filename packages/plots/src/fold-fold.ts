/**
 * Fold-vs-fold classification: where a point sits against a cutoff on *each*
 * of two effect-size axes.
 *
 * Its own module rather than an addition to `volcano.ts`, which is about
 * significance measured against effect. Here both axes are effects and there
 * is no significance value at all — what counts as notable is entirely the
 * author's stated cutoff, which is why this is comparison maths and nothing
 * more. No colour and no rendering: `packages/render` resolves category to
 * colour, in one place, for both the vector and the rasterised point-cloud
 * paths.
 */

import type { FoldFoldCategory, FoldFoldThresholds } from '@figureforge/doc-model';

export type { FoldFoldCategory, FoldFoldThresholds };
export { DEFAULT_FOLD_FOLD_THRESHOLDS } from '@figureforge/doc-model';

/**
 * Classify a point against both cutoffs.
 *
 * A non-finite value on either axis reads as `'ns'` rather than being sorted
 * by a comparison that would silently be `false` whichever way it went — the
 * stance `volcanoCategory` already takes, and the reason it is stated here
 * rather than left to the caller: a NaN must not become "not significant" by
 * accident when it could equally have become significant by accident.
 *
 * `colorBy` decides what a significant point is *called*, never whether it is
 * significant — with one deliberate exception, stated below.
 */
export function foldFoldCategory(
  x: number,
  y: number,
  thresholds: FoldFoldThresholds,
  colorBy: 'significant' | 'quadrant' = 'significant',
): FoldFoldCategory {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'ns';

  // Inclusive, matching `volcanoCategory`: a cutoff is the value at which a
  // point counts, not the value it must beat.
  const xPasses = Math.abs(x) >= thresholds.x;
  const yPasses = Math.abs(y) >= thresholds.y;

  if (colorBy === 'quadrant') {
    /*
     * The exception. Quadrant colouring requires both cutoffs cleared, and
     * that is a construction rather than a policy: a point clearing x but not
     * y is in no quadrant — it has a direction on one axis and none on the
     * other — so there is no class to colour it. The `rule` field is
     * therefore not read here, and the Inspector hides its control rather
     * than offering one that does nothing.
     *
     * A fold change of exactly zero has no direction either, and cannot reach
     * this branch: `|0| >= thresholds.x` is false for any positive cutoff,
     * and a cutoff of zero passes every point but is then caught here.
     */
    if (!xPasses || !yPasses) return 'ns';
    if (x === 0 || y === 0) return 'ns';
    if (x > 0) return y > 0 ? 'up-up' : 'up-down';
    return y > 0 ? 'down-up' : 'down-down';
  }

  const significant = (thresholds.rule ?? 'both') === 'either' ? xPasses || yPasses : xPasses && yPasses;
  return significant ? 'sig' : 'ns';
}
