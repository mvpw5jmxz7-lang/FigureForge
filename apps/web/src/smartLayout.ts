/**
 * Driving the smart-layout solver from the app.
 *
 * Three jobs the solver deliberately does not do for itself, because each needs
 * something only this layer has:
 *
 *   - assembling its input, which needs `measurePanelDemands` from
 *     `packages/render` (the solver lives in `doc-model`, which may not import
 *     it — the `PlotMeasurements`/`measureAllPlots` split all over again);
 *   - re-scoring the finalists against a document the candidate was actually
 *     applied to, because `reserveSpaceForGroupLabels` moves panels *after* the
 *     grid is solved and a predicted score would otherwise describe a layout
 *     slightly different from the one Apply produces;
 *   - applying, which finishes with `reflowBrackets` — also in `render`.
 */

import type { FigureDocument, NodeId, SmartLayoutCandidate, SmartLayoutResult } from '@figureforge/doc-model';
import {
  absoluteFrame,
  applySmartLayout,
  editDocument,
  readingOrder,
  relabelPanels,
  reflowGroupLabels,
  rescoreCandidate,
  solveSmartLayout,
  type RectMm,
} from '@figureforge/doc-model';
import {
  measurePanelDemands,
  measureScaleInputs,
  reflowBrackets,
  type PanelDemandOptions,
} from '@figureforge/render';
import { findPreset, resolveTheme, type Theme } from '@figureforge/theme';

/**
 * The narrowest and shortest cell a panel might be asked to fit, as a grid
 * shape. Only the probe frames depend on this — the arrangements themselves are
 * bounded by each panel's own measured minimum.
 */
const PROBE_MAX_COLUMNS = 4;
const PROBE_MAX_ROWS = 4;

/** The left inset every cell reserves for a panel letter, as the Toolbar sets it. */
export const LABEL_GUTTER_MM = 4;

/** Shortest page worth offering, and the floor the height term measures from. */
const MIN_PAGE_HEIGHT_MM = 40;

function layoutBasics(doc: FigureDocument, theme: Theme) {
  const preset = doc.page.presetId ? findPreset(doc.page.presetId) : undefined;
  return {
    marginMm: theme.spacing.marginMm,
    gutterMm: theme.spacing.panelGutterMm,
    labelGutterMm: LABEL_GUTTER_MM,
    pageWidthMm: doc.page.widthMm,
    currentPageHeightMm: doc.page.heightMm,
    // Without a preset there is no journal ceiling to respect, so the page may
    // grow to A4-ish and no further — a figure taller than that is not a page.
    maxPageHeightMm: preset?.maxHeightMm ?? 297,
    minPageHeightMm: MIN_PAGE_HEIGHT_MM,
  };
}

/**
 * Solve, then re-score the handful of finalists against what applying each one
 * really produces.
 *
 * The extra work is one document clone per offered candidate — eight of them.
 * That buys the property the preview depends on: the score beside a candidate
 * is the score of the figure the author gets, not of the arrangement the solver
 * imagined. Each clone re-measures the panels at that candidate's own font
 * scale, which is the same work one Quality report does, so the tab stays
 * responsive; it is memoised on the document identity either way.
 */
export function solveForDocument(
  doc: FigureDocument,
  theme: Theme,
  exportDpi: number,
): SmartLayoutResult {
  const basics = layoutBasics(doc, theme);
  const demandOptions: PanelDemandOptions = {
    ...basics,
    exportDpi,
    maxColumns: PROBE_MAX_COLUMNS,
    maxRows: PROBE_MAX_ROWS,
  };

  const panels = readingOrder(doc.nodes).filter((n) => n.type === 'panel');
  const currentFrames = new Map<NodeId, RectMm>();
  for (const panel of panels) {
    const frame = absoluteFrame(doc.nodes, panel.id);
    if (frame) currentFrames.set(panel.id, frame);
  }

  const scales = measureScaleInputs(
    doc,
    theme,
    (typeScale) => resolveTheme(doc.themeId, { ...doc.themeOverrides, type: typeScale }),
    demandOptions,
  );

  const solved = solveSmartLayout({
    order: panels.map((p) => p.id),
    scales,
    options: basics,
    currentFrames,
  });

  const rescored = solved.candidates.map((candidate) => {
    const applied = editDocument(doc, (draft) => {
      applySmartLayout(draft, candidate);
    });
    const nextTheme = resolveTheme(doc.themeId, applied.themeOverrides);
    const demands = measurePanelDemands(applied, nextTheme, demandOptions, candidate.fontScale);

    const frames = new Map<NodeId, RectMm>();
    for (const id of candidate.order) {
      const frame = absoluteFrame(applied.nodes, id);
      if (frame) frames.set(id, frame);
    }
    return rescoreCandidate(candidate, frames, [...demands.values()], basics);
  });

  // Re-scoring can reorder them, and the list must be shown best-first.
  rescored.sort((a, b) => b.score - a.score || a.pageHeightMm - b.pageHeightMm);

  return { ...solved, candidates: rescored };
}

/**
 * Everything applying a candidate touches, as one draft mutation.
 *
 * The caller wraps this in a single `commit`, so page height, type, aspect
 * locks, every frame and every letter move together — a half-applied
 * rearrangement would be worse than none, and worse to undo.
 *
 * `nextTheme` is resolved from the overrides this function has just written,
 * never passed in by the caller — the component's own `theme` was resolved
 * before the transaction opened. Relettering and bracket pitch both read a
 * point size, and using the stale one would leave the figure disagreeing with
 * the type reduction the candidate reports having made. Taking no theme
 * parameter at all is what makes that mistake unavailable rather than merely
 * documented.
 */
export function applyCandidate(
  draft: FigureDocument,
  candidate: SmartLayoutCandidate,
  newId: () => string,
): boolean {
  if (!applySmartLayout(draft, candidate)) return false;

  const nextTheme = resolveTheme(draft.themeId, draft.themeOverrides);
  relabelPanels(draft, newId, {
    uppercase: nextTheme.panelLabelCase === 'upper',
    fontSizePt: nextTheme.type.panelLabelPt,
    offsetMm: LABEL_GUTTER_MM,
  });
  reflowGroupLabels(draft);
  reflowBrackets(draft, nextTheme);
  return true;
}
