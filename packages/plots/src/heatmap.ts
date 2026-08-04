/**
 * Heatmap colour-domain math: where a cell's value sits on the colour scale.
 * Pure numbers, no colour and no rendering — `packages/render` turns a
 * normalized position into an actual colour, in one place, for both the
 * per-cell fill and the colourbar legend.
 */

import type { HeatmapScaleMode } from '@figureforge/doc-model';

export type { HeatmapScaleMode };

/**
 * The domain a heatmap's colour scale spans.
 *
 * `'diverging'` is symmetric around zero — `max(|min|, |max|)` on both sides
 * — the standard reading for a correlation matrix or a log-fold-change
 * matrix, where zero is a meaningful midpoint. `'sequential'` uses the raw
 * `[min, max]` of the data, for plain-magnitude values with no meaningful
 * zero.
 *
 * A flat matrix (every cell equal, or no cell at all) still needs a drawable
 * domain — mirrors `resolveDomain`'s "flat series" rule in `scales.ts`.
 */
export function resolveHeatmapDomain(
  cells: readonly (number | null)[][],
  mode: HeatmapScaleMode,
): { min: number; max: number } {
  const values = cells.flat().filter((v): v is number => v !== null && Number.isFinite(v));

  if (values.length === 0) return { min: 0, max: 1 };

  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);

  if (mode === 'diverging') {
    const bound = Math.max(Math.abs(dataMin), Math.abs(dataMax)) || 1;
    return { min: -bound, max: bound };
  }

  if (dataMin === dataMax) {
    const magnitude = Math.abs(dataMin) || 1;
    return { min: dataMin - magnitude * 0.1, max: dataMax + magnitude * 0.1 };
  }

  return { min: dataMin, max: dataMax };
}

/**
 * A cell's value as a fraction of the domain, clamped to `[0, 1]` — the `t`
 * both the per-cell fill and the colourbar interpolate colour at.
 *
 * `null` passes through `null`: a missing cell has no position on the ramp
 * at all, not a position at its edge — clamping it in would draw it as
 * indistinguishable from a real extreme value.
 */
export function normalizeCellValue(
  value: number | null,
  domain: { min: number; max: number },
): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (domain.max === domain.min) return 0.5;
  const t = (value - domain.min) / (domain.max - domain.min);
  return Math.max(0, Math.min(1, t));
}
