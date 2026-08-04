/**
 * Volcano-plot classification: which side of a significance threshold a
 * point falls on. Pure comparison math, no colour and no rendering —
 * `packages/render` resolves category to colour, in one place, for both the
 * vector and the rasterised point-cloud paths.
 */

import type { VolcanoCategory, VolcanoThresholds } from '@figureforge/doc-model';

export type { VolcanoCategory, VolcanoThresholds };
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
 */
export function volcanoCategory(
  log2FoldChange: number,
  negLog10PValue: number,
  thresholds: VolcanoThresholds,
): VolcanoCategory {
  if (!Number.isFinite(log2FoldChange) || Number.isNaN(negLog10PValue)) return 'ns';
  if (negLog10PValue < negLog10(thresholds.pValue)) return 'ns';
  if (log2FoldChange >= thresholds.foldChange) return 'up';
  if (log2FoldChange <= -thresholds.foldChange) return 'down';
  return 'ns';
}
