/**
 * Smart layout: choosing a page arrangement from what each panel actually needs.
 *
 * `autoLayout` divides the page evenly. That is the right answer only when
 * every panel wants the same room, which is almost never true of a real figure:
 * a two-bar chart is legible at 35 mm and a 2000 px micrograph is still gaining
 * detail at 170 mm. This module measures the difference and searches a bounded
 * set of arrangements for the one that wastes least.
 *
 * Four levers, and no others (see `applySmartLayout`):
 *   - unequal columns and rows, via `GridSpec`'s weights;
 *   - the page height, up to the journal preset's own ceiling;
 *   - the document's type sizes, down to `theme.type.minimumPt`;
 *   - `PanelNode.aspectLock`, taken from the pictures' own shape.
 * Every one of them is an existing, already-schema'd field, so this adds
 * nothing to the document format.
 *
 * Deterministic and pure. Nothing here reads the DOM, calls a service or
 * consults a random source: the same document must produce the same candidates
 * in the same order every time, or the preview would not describe what Apply
 * does. `Object.values` order is never relied on — the panel order arrives as a
 * parameter, from `readingOrder`.
 *
 * ## Why the demands arrive as a parameter
 *
 * A plot's real demand is its measured axis furniture, which only
 * `computePlotGeometry` in `packages/render` can supply, and `doc-model`
 * imports nothing internal. So `PanelDemand` is declared here as plain data and
 * `measurePanelDemands` in `packages/render/src/panel-demand.ts` produces it —
 * exactly the relationship `PlotMeasurements`/`measureAllPlots` already has, for
 * exactly the same reason.
 */

import type { RectMm, ShapeMm } from './geometry.js';
import { FREE_SHAPE, heightForWidth } from './geometry.js';
import type { NodeId, PanelNode } from './nodes.js';
import type { FigureDocument } from './document.js';
import { compareReadingOrder, layoutUnits, measureGutters, rowBands } from './layout.js';
import type { LayoutUnit } from './layout.js';
import type { Arrangement, PanelSizeDemand } from './arrangement.js';
import {
  arrangementLayout,
  arrangementHeightDemand,
  arrangementSignature,
  enumerateArrangements,
  figureSignature,
  hasStack,
  MAX_ARRANGEMENTS,
} from './arrangement.js';
import {
  MIN_TILE_MM,
  imageContentRect,
  imageScaleBarBelowExtentMm,
  unitLayoutShape,
  montageFixedExtentMm,
  montageShape,
  placeUnits,
} from './operations.js';
import { MM_PER_INCH } from './units.js';

// ---------------------------------------------------------------------------
// What a panel needs
// ---------------------------------------------------------------------------

export type PanelDemandKind = 'plot' | 'image' | 'montage' | 'other';

/**
 * What one panel needs from the page, in millimetres.
 *
 * `min*` is a wall: a candidate that gives the panel less is discarded, never
 * scored badly, because below it the panel does not render at all (a plot whose
 * margins exceed its frame draws nothing; a montage whose cells fall under
 * `MIN_TILE_MM` silently leaves its tiles where they were). `comfort*` is the
 * size at which nothing is compromised, and the shortfall against it is what
 * the score actually trades.
 */
export interface PanelDemand {
  panelId: NodeId;
  kind: PanelDemandKind;
  /** Below this the panel cannot be drawn; breaching it rejects the candidate. */
  minWidthMm: number;
  minHeightMm: number;
  /** The size at which nothing is compromised. Never smaller than `min`. */
  comfortWidthMm: number;
  comfortHeightMm: number;
  /**
   * Width/height of the panel's *content block*, or null to fill its cell.
   *
   * Not the panel's own ratio once `fixedWidthMm`/`fixedHeightMm` are non-zero
   * — those bands do not scale, so the panel's ratio differs at every size.
   * `sizeDemand` composes all three into a `ShapeMm`.
   */
  aspect: number | null;
  /**
   * The panel's extent that is *not* content: gutters, padding, a group-label
   * band, a scale-bar band. Zero for a plot and for a lone uncaptioned image.
   */
  fixedWidthMm: number;
  fixedHeightMm: number;
  /** True when `aspect` was measured from content and may be written to `aspectLock`. */
  aspectFromContent: boolean;
  /** 0..1. A measured claim on page area — see `imagePanelDemand`. */
  priority: number;
  /**
   * Width past which the export dpi becomes an error-level finding. `Infinity`
   * for anything with no pixel grid: only a raster can be enlarged past its
   * own detail.
   */
  rejectAboveWidthMm: number;
  /** True when `comfortWidthMm` was clipped by the page rather than by content. */
  cappedByPage: boolean;
  /** The font scale these numbers were measured at. A candidate cannot mix scales. */
  fontScale: number;
}

// ---------------------------------------------------------------------------
// Input and output
// ---------------------------------------------------------------------------

/**
 * One font scale's worth of measurements.
 *
 * `typeScale` is a bare record rather than the theme package's `TypeScale`
 * because `doc-model` may not import `theme`. It is written verbatim into
 * `themeOverrides.type`, which is `Record<string, unknown>` anyway, so nothing
 * is lost by keeping the structural type here.
 */
export interface SmartLayoutScaleInput {
  /** 1 is the theme's own sizes; below 1 is a reduction the author is shown. */
  fontScale: number;
  typeScale: Readonly<Record<string, number>>;
  /** The smallest size in `typeScale`, quoted in the explanation. */
  minPt: number;
  demands: readonly PanelDemand[];
}

export interface SmartLayoutOptions {
  pageWidthMm: number;
  currentPageHeightMm: number;
  /** The journal preset's own ceiling. Never exceeded. */
  maxPageHeightMm: number;
  minPageHeightMm: number;
  marginMm: number;
  gutterMm: number;
  labelGutterMm: number;
}

export interface SmartLayoutInput {
  /**
   * What the layout positions, in reading order — from `layoutUnits`, never
   * `Object.values`. A group is one unit, not one per member panel.
   */
  units: readonly LayoutUnit[];
  /**
   * The document, so a group's demand can be rolled up from its members and
   * its shape constraint read off them.
   */
  doc: FigureDocument;
  scales: readonly SmartLayoutScaleInput[];
  options: SmartLayoutOptions;
  /**
   * Where the panels sit right now, so the baseline is a real scored layout
   * rather than a stub. Every explanation quotes a *difference*, and a
   * difference against an invented reference would be a fabricated number.
   */
  currentFrames: ReadonlyMap<NodeId, RectMm>;
}

/** The six things the score trades, each normalised to 0..1 where 0 is best. */
export interface SmartLayoutTerms {
  unmetDemand: number;
  overResolution: number;
  whitespace: number;
  bandWaste: number;
  pageHeight: number;
  fontReduction: number;
  gutterEvenness: number;
}

export interface SmartLayoutCandidate {
  id: string;
  /** The shape: bands of columns, each column one panel or a stack of two. */
  arrangement: Arrangement;
  /** The panel order the arrangement's positions are indexed by. */
  order: readonly NodeId[];
  pageHeightMm: number;
  fontScale: number;
  typeScale: Readonly<Record<string, number>>;
  minPt: number;
  aspectLocks: Readonly<Record<NodeId, number | null>>;
  /** Where each panel lands. Predicted, then re-measured for the finalists. */
  frames: ReadonlyMap<NodeId, RectMm>;
  /** 0..100, higher is better, so `scoreTone` can colour it. */
  score: number;
  terms: SmartLayoutTerms;
}

export interface SmartLayoutResult {
  candidates: readonly SmartLayoutCandidate[];
  /** How the layout stands now, scored identically, for the explanations. */
  baseline: SmartLayoutCandidate | null;
  candidatesEvaluated: number;
  /**
   * Why nothing fits, when `candidates` is empty. Names the binding panel and
   * the number it needed, because "no arrangement found" is not actionable.
   */
  blockedBy: string | null;
}

// ---------------------------------------------------------------------------
// Tunables — all of them, in one place
// ---------------------------------------------------------------------------

/**
 * What the score trades against what.
 *
 * Deliberately one exported block rather than constants scattered through the
 * scoring function: the balance between "the micrograph is too small" and "the
 * page grew 40 mm" is a judgement, and a judgement that is spread over five
 * call sites cannot be revised coherently.
 */
export const SMART_LAYOUT_WEIGHTS = {
  /** Priority-weighted shortfall against comfort size. The point of the feature. */
  unmetDemand: 1.0,
  /**
   * Pictures drawn past the width their own pixels support.
   *
   * Weighted level with `unmetDemand` because it is the same kind of defect
   * seen from the other side, and it has to outweigh `whitespace` outright:
   * filling the page with an enlarged 400 px inset removes whitespace and
   * makes the figure worse.
   */
  overResolution: 1.0,
  /** Usable page area no panel frame covers. */
  whitespace: 0.6,
  /**
   * Dead height *inside* a row: a panel that stops short of its neighbours'
   * bottom edge, which is the strip under a picture that cannot be as tall as
   * the plot beside it.
   *
   * Overlaps `whitespace` deliberately — a dead strip is also uncovered page —
   * but measures a different thing. `whitespace` is a fraction of the *page*,
   * so it is confounded with page height (both divide by `usableArea`) and a
   * ragged row scored barely a point on it. This is a fraction of the *rows*,
   * so it is the term that can tell a tight figure from a ragged one at the
   * same page height, which is mostly how it earns its keep: a wide montage in
   * a band of its own scores zero here, the same montage beside a plot does
   * not, and that is a structural difference nothing could previously see.
   *
   * Below `unmetDemand` on purpose. The two can only conflict through the width
   * a picture takes from a plot, and squeezing a plot to align a picture must
   * lose while a small trade that buys alignment wins.
   */
  bandWaste: 0.5,
  /** Journals cap page height; using more of it is a real cost, not free. */
  pageHeight: 0.25,
  /** The author's type, spent to buy plot area. */
  fontReduction: 0.8,
  /** Uneven gutters, measured the way `checkPanelSpacing` measures them. */
  gutterEvenness: 0.15,
} as const;

/** Font scales offered, largest first. Three, fixed — never a search. */
export const FONT_SCALES: readonly number[] = [1.0, 0.92, 0.85];

/**
 * Most candidates any single solve will score: `MAX_ARRANGEMENTS` shapes × three
 * page heights × three font scales. Pinned by a test.
 */
export const MAX_CANDIDATES = MAX_ARRANGEMENTS * FONT_SCALES.length * 3;

/**
 * How many arrangements the author is offered.
 *
 * Eight rather than four, because ragged rows and L-shapes make the shapes
 * genuinely different from one another rather than the same grid at three page
 * heights — there is now enough real variety to be worth showing.
 */
export const OFFERED_CANDIDATES = 8;

/** Smallest picture worth drawing at all, regardless of its pixel count. */
export const IMAGE_LEGIBILITY_MM = 15;

/**
 * The dpi at which `checkImageResolution` escalates a warning to an error.
 * Kept in step with that rule's own `exportDpi * 0.66`.
 */
const DPI_ERROR_FRACTION = 0.66;

// ---------------------------------------------------------------------------
// Demands this package can measure on its own
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * How strong a claim a picture has on page area, from its own pixel count.
 *
 * Monotone in resolution and nothing else, so it stays a measurement rather
 * than a preference: a 600 px inset scores 0.5, a 4000 px micrograph 1.0. The
 * log makes the middle of that range behave — pixel count grows quadratically
 * with linear detail, and a plain ratio would put everything under 2000 px at
 * effectively zero.
 */
function detailPriority(visiblePx: number): number {
  if (visiblePx <= 0) return 0.5;
  const detail = clamp(Math.log10(visiblePx / 600) / Math.log10(4000 / 600), 0, 1);
  return 0.5 + 0.5 * detail;
}

/**
 * The demand of a panel whose content is pictures, or nothing this module can
 * measure. Plots are measured in `packages/render` instead.
 *
 * The size arithmetic is `checkImageResolution`'s, read in the direction it
 * actually points. Effective dpi *falls* as a panel grows, so
 * `visiblePx / (dpi / 25.4)` — the width that rule prints as the one to scale
 * down to — is a **maximum useful width**, not a minimum. That single number is
 * the whole "detailed micrographs large, simple graphs small" mechanism, and it
 * is measured rather than asserted: a 4000 px micrograph wants 338.7 mm and so
 * claims the whole page, while a 400 px inset caps at 33.9 mm and anything
 * larger buys nothing but a low-dpi finding.
 *
 * The cap at the usable page width is load-bearing. Uncapped, one oversized
 * import would demand twice the page and swamp every other panel's weight,
 * making the ratios between the rest meaningless.
 */
export function imagePanelDemand(
  doc: FigureDocument,
  panel: PanelNode,
  options: { usableWidthMm: number; exportDpi: number; fontScale: number },
): PanelDemand {
  const { usableWidthMm, exportDpi, fontScale } = options;
  const children = Object.values(doc.nodes).filter((n) => n.parentId === panel.id);
  const images = children.filter((n) => n.type === 'image');

  const base: PanelDemand = {
    panelId: panel.id,
    kind: 'other',
    minWidthMm: MIN_TILE_MM,
    minHeightMm: MIN_TILE_MM,
    comfortWidthMm: Math.max(MIN_TILE_MM, panel.frame.width),
    comfortHeightMm: Math.max(MIN_TILE_MM, panel.frame.height),
    aspect: null,
    fixedWidthMm: 0,
    fixedHeightMm: 0,
    aspectFromContent: false,
    priority: 0.3,
    rejectAboveWidthMm: Number.POSITIVE_INFINITY,
    cappedByPage: false,
    fontScale,
  };
  if (images.length === 0) return base;

  const montage = montageFixedExtentMm(doc, panel.id);
  const isMontage = montage !== null && images.length > 1;

  // Widest *visible* pixel run across the tiles: the montage is only as
  // detailed as its best tile, and it is that tile which sets how large the
  // panel can usefully be drawn.
  let visiblePx = 0;
  for (const image of images) {
    if (image.type !== 'image') continue;
    visiblePx = Math.max(visiblePx, image.naturalPx.width * (image.crop.width || 1));
  }
  const perTilePx = isMontage && montage ? visiblePx * montage.cols : visiblePx;

  const maxUsefulWidthMm = perTilePx > 0 ? perTilePx / (exportDpi / MM_PER_INCH) : usableWidthMm;
  const rejectAboveWidthMm =
    perTilePx > 0
      ? perTilePx / ((exportDpi * DPI_ERROR_FRACTION) / MM_PER_INCH)
      : Number.POSITIVE_INFINITY;

  /*
   * The panel's shape: the aspect of its *content*, plus the bands that do not
   * scale with it. A montage solves both in closed form; a lone picture is
   * where its ink lands, with a band under it only if it carries a
   * below-placed scale bar.
   *
   * Keeping the bands separate is the whole point — a single ratio is wrong at
   * every size but one, which is what left 21 mm of dead page under each
   * picture of a captioned montage. See `ShapeMm`.
   */
  let aspect: number | null = null;
  let fixedWidthMm = 0;
  let fixedHeightMm = 0;
  if (isMontage) {
    const shape = montageShape(doc, panel.id);
    if (shape) {
      aspect = shape.contentAspect;
      fixedWidthMm = shape.fixedWidthMm;
      fixedHeightMm = shape.fixedHeightMm;
    }
  } else {
    const only = images[0];
    if (only && only.type === 'image') {
      const content = imageContentRect(only);
      if (content.height > 0) aspect = content.width / content.height;
      fixedHeightMm = imageScaleBarBelowExtentMm(doc.nodes, only.id);
    }
  }
  if (aspect !== null && (!Number.isFinite(aspect) || aspect <= 0)) aspect = null;
  const shape: ShapeMm = aspect === null ? FREE_SHAPE : { contentAspect: aspect, fixedWidthMm, fixedHeightMm };

  /*
   * An author-set lock is a constraint, not a suggestion: only rewrite one the
   * author never chose, or one they explicitly delegated with `autoFit`. Same
   * stance `autoGridForMontage` takes toward a declared grid.
   */
  const mayWriteAspect =
    aspect !== null && (panel.aspectLock === null || panel.contentGrid?.autoFit === true);

  // The smallest frame at which `montageCellRects` still returns cells. Derived
  // from its own null condition rather than guessed, so the solver can never
  // declare a frame usable that the tiler then refuses to fill.
  const minWidthMm = isMontage && montage
    ? montage.cols * MIN_TILE_MM + montage.fixedWidthMm
    : Math.max(MIN_TILE_MM, IMAGE_LEGIBILITY_MM);
  const minHeightMm = isMontage && montage
    ? montage.rows * MIN_TILE_MM + montage.fixedHeightMm
    : Math.max(
        MIN_TILE_MM,
        (aspect ? IMAGE_LEGIBILITY_MM / aspect : IMAGE_LEGIBILITY_MM) + fixedHeightMm,
      );

  const comfortWidthMm = Math.max(minWidthMm, Math.min(maxUsefulWidthMm, usableWidthMm));
  const comfortHeightMm = Math.max(
    minHeightMm,
    aspect ? heightForWidth(shape, comfortWidthMm) : comfortWidthMm,
  );

  return {
    ...base,
    kind: isMontage ? 'montage' : 'image',
    minWidthMm,
    minHeightMm,
    fixedWidthMm,
    fixedHeightMm,
    comfortWidthMm,
    comfortHeightMm,
    aspect,
    aspectFromContent: mayWriteAspect,
    priority: detailPriority(visiblePx),
    rejectAboveWidthMm,
    cappedByPage: maxUsefulWidthMm > usableWidthMm,
  };
}

/**
 * What one *layout unit* needs — structurally a `PanelDemand` keyed by the unit
 * rather than by a panel, because that is exactly what a group's aggregate is:
 * the same numbers, derived from its members' own.
 *
 * A separate type rather than a redefinition, so the measurement half stays
 * per-panel and `packages/render` does not have to learn what a group is.
 */
export interface UnitDemand extends Omit<PanelDemand, 'panelId'> {
  unitId: NodeId;
  panelIds: readonly NodeId[];
  /**
   * The shape the layout must hold this unit to.
   *
   * On the demand rather than re-derived at the call site, because the two
   * kinds answer it from different places: a panel's comes from its *measured*
   * content — `imagePanelDemand` has already applied the "an author-set lock is
   * a constraint" rule — while a group's comes from its members' locks.
   */
  shape: ShapeMm;
}

/**
 * Roll each unit's members up into one demand.
 *
 * A panel unit is its own demand, re-keyed. A group is scaled by exactly one
 * `(sx, sy)` at every depth — `resizeGroupGeometry` recurses with
 * `sx' = target.width / old.width` and `target.width = child.frame.width * sx`,
 * so `sx' === sx` — which means a member's realised width is exactly `sx·wᵢ`
 * and these bounds are exact rather than estimates.
 *
 * `max` for comfort because comfort is "the size at which *nothing* is
 * compromised", so the hungriest member sets it. `max` for priority and never a
 * sum: priority is a measured claim on page area, and summing would let five
 * plots outrank one 4000 px micrograph, inverting what the measurement says.
 *
 * Every ratio is dimensionless, so the aggregate is **scale-invariant** — for a
 * group already resized by `s` both `G` and `wᵢ` carry the `s` and it cancels.
 * That is what keeps `rescoreCandidate` reporting the same numbers the solve
 * did, which is the property four document clones were spent on in round 35.
 */
export function unitDemands(
  doc: FigureDocument,
  units: readonly LayoutUnit[],
  panelDemands: readonly PanelDemand[],
): UnitDemand[] {
  const byPanel = new Map(panelDemands.map((d) => [d.panelId, d]));

  return units.map((unit) => {
    const own = byPanel.get(unit.id);
    if (unit.kind === 'panel' && own) {
      const { panelId: _panelId, ...rest } = own;
      return {
        ...rest,
        unitId: unit.id,
        panelIds: unit.panelIds,
        shape:
          own.aspectFromContent && own.aspect
            ? {
                contentAspect: own.aspect,
                fixedWidthMm: own.fixedWidthMm,
                fixedHeightMm: own.fixedHeightMm,
              }
            : FREE_SHAPE,
      };
    }

    const members = unit.panelIds
      .map((id) => ({ demand: byPanel.get(id), frame: doc.nodes[id]?.frame }))
      .filter((m): m is { demand: PanelDemand; frame: RectMm } => !!m.demand && !!m.frame);

    const { width: gw, height: gh } = unit.frame;
    // A member with no positive extent contributes no ratio: no finite scale
    // satisfies it, and an Infinity here would reject every candidate.
    const ratio = (
      pick: (d: PanelDemand) => number,
      size: (f: RectMm) => number,
      extent: number,
    ): number => {
      let worst = 0;
      for (const m of members) {
        const s = size(m.frame);
        if (s > 0) worst = Math.max(worst, pick(m.demand) / s);
      }
      return worst > 0 ? extent * worst : extent;
    };

    let rejectAboveWidthMm = Number.POSITIVE_INFINITY;
    for (const m of members) {
      if (m.frame.width > 0 && Number.isFinite(m.demand.rejectAboveWidthMm)) {
        rejectAboveWidthMm = Math.min(
          rejectAboveWidthMm,
          gw * (m.demand.rejectAboveWidthMm / m.frame.width),
        );
      }
    }

    return {
      unitId: unit.id,
      panelIds: unit.panelIds,
      kind: 'other',
      minWidthMm: ratio((d) => d.minWidthMm, (f) => f.width, gw),
      minHeightMm: ratio((d) => d.minHeightMm, (f) => f.height, gh),
      comfortWidthMm: ratio((d) => d.comfortWidthMm, (f) => f.width, gw),
      comfortHeightMm: ratio((d) => d.comfortHeightMm, (f) => f.height, gh),
      // A group has no `aspectLock` field to write, and writing one onto a
      // member the solver never sized individually would be a fabricated
      // number — exactly what round 41 removed. Its shape constraint is decided
      // by `unitLayoutShape` from the members instead.
      aspect: null,
      fixedWidthMm: 0,
      fixedHeightMm: 0,
      aspectFromContent: false,
      priority: members.reduce((worst, m) => Math.max(worst, m.demand.priority), 0.3),
      rejectAboveWidthMm,
      cappedByPage: members.some((m) => m.demand.cappedByPage),
      fontScale: members[0]?.demand.fontScale ?? 1,
      shape: unitLayoutShape(doc, unit).shape ?? FREE_SHAPE,
    };
  });
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

/** What a panel wants along each axis: comfort, but never below the wall. */
const wantWidth = (d: { minWidthMm: number; comfortWidthMm: number }): number =>
  Math.max(d.minWidthMm, d.comfortWidthMm);
const wantHeight = (d: { minHeightMm: number; comfortHeightMm: number }): number =>
  Math.max(d.minHeightMm, d.comfortHeightMm);

/**
 * A `PanelDemand` reduced to what `arrangement.ts` needs.
 *
 * That module is pure geometry with no notion of priority, resolution limits or
 * where a demand came from, which is what lets it be tested against exact
 * millimetres with no document behind it.
 *
 * The shape is emitted whole or not at all. `contentAspect` without its bands
 * is meaningless — it would describe a panel with no gutters, no padding and no
 * caption — so a half-applied constraint is made unrepresentable rather than
 * merely avoided.
 */
const sizeDemand = (d: UnitDemand): PanelSizeDemand => ({
  minWidthMm: Math.max(MIN_TILE_MM, d.minWidthMm),
  minHeightMm: Math.max(MIN_TILE_MM, d.minHeightMm),
  wantWidthMm: wantWidth(d),
  wantHeightMm: wantHeight(d),
  shape: d.shape,
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * How much of each row's own box no panel covers, averaged over the rows.
 *
 * Derived from the frames rather than from the band structure, deliberately:
 * the finalists are re-scored against a document each candidate was actually
 * applied to — after `reserveLayoutSpace` has moved panels for a group heading
 * — and a term computed from the arrangement could not be recomputed there. The
 * property the re-scoring pass exists to buy, that the score beside a candidate
 * is the score of the figure the author gets, has to hold for every term. It is
 * also what lets the current layout be scored as a baseline at all, since that
 * has no arrangement behind it.
 *
 * Width-weighted inside a row, because a 3 mm strip under a 170 mm montage is a
 * visible dead band and the same strip under a 20 mm inset is nothing; and
 * height-weighted across rows, so a tall ragged row counts for more than a short
 * one. Already 0..1 by construction.
 *
 * The obvious `wastedArea / usableArea` was tried on paper first and is too
 * blunt: the reported figure's 8.6 mm strip under a 126 mm montage comes to
 * 0.043 of the page, well under one point of score, where arrangements here are
 * separated by a couple of points. As a fraction of its own row it is 0.165 —
 * and that is also the quantity an author is actually looking at.
 */
function bandWaste(frames: ReadonlyMap<NodeId, RectMm>): number {
  let weighted = 0;
  let heightSum = 0;

  for (const row of rowBands([...frames.values()], (f) => f.y)) {
    const top = Math.min(...row.map((f) => f.y));
    const bottom = Math.max(...row.map((f) => f.y + f.height));
    const rowHeight = bottom - top;
    const box = row.reduce((sum, f) => sum + f.width, 0) * rowHeight;
    if (box <= 1e-6) continue;
    const ink = row.reduce((sum, f) => sum + f.width * f.height, 0);
    weighted += rowHeight * (1 - ink / box);
    heightSum += rowHeight;
  }

  return heightSum > 0 ? clamp(weighted / heightSum, 0, 1) : 0;
}

/**
 * Score a set of frames against what the panels wanted, 0..100, higher better.
 *
 * `whitespace` counts each panel's **fitted** frame, not its cell. `autoLayout`
 * centres an aspect-locked panel inside its cell and shrinks it to fit, so a
 * cell of the wrong shape leaves real dead space on the page — and that is
 * precisely the waste unequal weights exist to remove. Counting the cell would
 * score a badly-shaped grid as though it were full.
 */
export function scoreCandidate(
  frames: ReadonlyMap<NodeId, RectMm>,
  demands: readonly UnitDemand[],
  pageHeightMm: number,
  fontScale: number,
  options: SmartLayoutOptions,
): { score: number; terms: SmartLayoutTerms } {
  let prioritySum = 0;
  let unmetSum = 0;
  let overSum = 0;
  let coveredArea = 0;

  for (const demand of demands) {
    const frame = frames.get(demand.unitId);
    if (!frame) continue;
    const satisfaction = Math.min(
      1,
      frame.width / Math.max(1e-6, demand.comfortWidthMm),
      frame.height / Math.max(1e-6, demand.comfortHeightMm),
    );
    prioritySum += demand.priority;
    unmetSum += demand.priority * (1 - satisfaction);

    /*
     * Enlarging a picture past its own detail is invisible to `unmetDemand`,
     * which caps satisfaction at 1 — so it needs its own term or the solver
     * would read "blow the inset up to fill the page" as a free win against
     * whitespace. Measured against `comfortWidthMm`, the width at which the
     * export dpi target is exactly met.
     */
    if (Number.isFinite(demand.rejectAboveWidthMm)) {
      const over = (frame.width - demand.comfortWidthMm) / Math.max(1e-6, demand.comfortWidthMm);
      overSum += demand.priority * clamp(over, 0, 1);
    }
    coveredArea += frame.width * frame.height;
  }

  const usableArea =
    Math.max(0, options.pageWidthMm - 2 * options.marginMm) *
    Math.max(0, pageHeightMm - 2 * options.marginMm);

  const gutters = measureGutters([...frames.values()]);
  const all = [...gutters.horizontal, ...gutters.vertical];

  const heightSpan = Math.max(1e-6, options.maxPageHeightMm - options.minPageHeightMm);
  const smallestScale = FONT_SCALES[FONT_SCALES.length - 1] ?? 1;

  const terms: SmartLayoutTerms = {
    unmetDemand: prioritySum > 0 ? clamp(unmetSum / prioritySum, 0, 1) : 0,
    overResolution: prioritySum > 0 ? clamp(overSum / prioritySum, 0, 1) : 0,
    whitespace: usableArea > 0 ? clamp(1 - coveredArea / usableArea, 0, 1) : 1,
    bandWaste: bandWaste(frames),
    pageHeight: clamp((pageHeightMm - options.minPageHeightMm) / heightSpan, 0, 1),
    fontReduction: clamp((1 - fontScale) / Math.max(1e-6, 1 - smallestScale), 0, 1),
    gutterEvenness: clamp(stdev(all) / Math.max(1e-6, options.gutterMm), 0, 1),
  };

  const weightSum = Object.values(SMART_LAYOUT_WEIGHTS).reduce((a, b) => a + b, 0);
  const penalty =
    (SMART_LAYOUT_WEIGHTS.unmetDemand * terms.unmetDemand +
      SMART_LAYOUT_WEIGHTS.overResolution * terms.overResolution +
      SMART_LAYOUT_WEIGHTS.whitespace * terms.whitespace +
      SMART_LAYOUT_WEIGHTS.bandWaste * terms.bandWaste +
      SMART_LAYOUT_WEIGHTS.pageHeight * terms.pageHeight +
      SMART_LAYOUT_WEIGHTS.fontReduction * terms.fontReduction +
      SMART_LAYOUT_WEIGHTS.gutterEvenness * terms.gutterEvenness) /
    weightSum;

  return { score: Math.round(100 * (1 - clamp(penalty, 0, 1))), terms };
}

/**
 * Why a set of frames is unusable, or null when it is fine.
 *
 * A wall, not a penalty. Each of these is a state in which something on the
 * page silently fails to draw, and a candidate that merely scores badly would
 * still be offered.
 *
 * Deliberately stricter than `checkPlotSize`, which tests against the *raw*
 * theme margin: a plot demand's `minWidthMm` is built from its **measured**
 * margin, which is the number that actually decides whether the geometry comes
 * back null. The two are not meant to agree.
 */
function rejectionFor(
  frames: ReadonlyMap<NodeId, RectMm>,
  demands: readonly UnitDemand[],
  nameOf: (id: NodeId) => string,
): string | null {
  for (const demand of demands) {
    const frame = frames.get(demand.unitId);
    if (!frame) return `${nameOf(demand.unitId)} was given no cell`;
    if (frame.width < MIN_TILE_MM || frame.height < MIN_TILE_MM) {
      return `${nameOf(demand.unitId)} collapses below ${MIN_TILE_MM} mm`;
    }
    if (frame.width + 0.01 < demand.minWidthMm) {
      return `${nameOf(demand.unitId)} needs ${demand.minWidthMm.toFixed(1)} mm of width and this arrangement offers ${frame.width.toFixed(1)} mm`;
    }
    if (frame.height + 0.01 < demand.minHeightMm) {
      return `${nameOf(demand.unitId)} needs ${demand.minHeightMm.toFixed(1)} mm of height and this arrangement offers ${frame.height.toFixed(1)} mm`;
    }
  }
  return null;
}

/*
 * Deliberately *not* a rejection: a picture drawn wider than its pixels
 * support. A panel always fills the cell it is given, so a lone low-resolution
 * image has no way to comply — rejecting it discards every arrangement and
 * leaves the author with nothing rather than with an informed choice. It is a
 * real defect, so it is scored heavily (`overResolution`) and named in the
 * explanation; the remedy — crop less, supply a better original, or accept it —
 * belongs to the author. Found by probing the solver rather than by reading it:
 * the first version rejected, and the test that was supposed to cover the case
 * passed over an empty result.
 */

// ---------------------------------------------------------------------------
// The solve
// ---------------------------------------------------------------------------

function layoutOptionsFor(options: SmartLayoutOptions, pageHeightMm: number) {
  return {
    pageWidthMm: options.pageWidthMm,
    pageHeightMm,
    marginMm: options.marginMm,
    gutterMm: options.gutterMm,
    labelGutterMm: options.labelGutterMm,
  };
}

/**
 * Whether an arrangement's frames really are read in the order its panels were
 * assigned to them.
 *
 * `arrangementOrder` derives the order from the structure, which is sound for
 * every shape the enumeration produces (see its own comment for the argument,
 * and for why a second stack in one band would break it). This checks the
 * argument against the frames rather than trusting it: any candidate whose
 * frames sort differently is dropped at generation time, so `applySmartLayout`'s
 * own assertion can never be the thing that fires — a refusal at Apply reads to
 * the author as a button that does nothing.
 */
/**
 * The most panels that could ever share one band (or one column), from the
 * *smallest* minimums rather than the largest.
 *
 * The bound this replaces asked how many columns would fit if every one of them
 * were as wide as the widest panel needs, and it was badly wrong in the
 * direction that matters. On the seven-panel sample the widest minimum is
 * 42.4 mm, giving `floor(184 / 47.4) = 3` — so a row of four was never
 * enumerated, even though the four narrowest panels need 136 mm of the 179 mm
 * available and fit comfortably. That single number is why the two-row `3 + 4`
 * this round is about could not be offered however the ranking was tuned.
 *
 * Taking the k smallest is the true ceiling: nothing wider than that can ever
 * be packed, and whether a *particular* set of k panels fits is `shareOut`'s
 * question, asked per band a few lines later. A loose bound that the real test
 * then tightens is the right shape here; a tight bound applied before the real
 * test can only ever discard arrangements that would have worked.
 */
function mostThatFit(
  minimums: readonly number[],
  availableMm: number,
  gutterMm: number,
): number {
  const sorted = [...minimums].map((m) => Math.max(MIN_TILE_MM, m)).sort((a, b) => a - b);
  let used = 0;
  let count = 0;
  for (const minimum of sorted) {
    const next = used + minimum + (count > 0 ? gutterMm : 0);
    if (next > availableMm + 0.01) break;
    used = next;
    count++;
  }
  return Math.max(1, count);
}

function readsInOrder(order: readonly NodeId[], frames: ReadonlyMap<NodeId, RectMm>): boolean {
  const sorted = [...order].sort((a, b) => {
    const fa = frames.get(a);
    const fb = frames.get(b);
    if (!fa || !fb) return 0;
    return compareReadingOrder(fa, fb);
  });
  return sorted.every((id, index) => id === order[index]);
}

/**
 * Search the arrangements and return the best few.
 *
 * Bounded by construction: at most `MAX_ARRANGEMENTS` shapes × 3 page heights ×
 * 3 font scales, every one of them pure arithmetic over demands that were
 * measured once. Nothing here re-measures a plot.
 */
export function solveSmartLayout(input: SmartLayoutInput): SmartLayoutResult {
  const { units, doc, scales, options } = input;
  const order = units.map((u) => u.id);
  const n = order.length;
  if (n === 0 || scales.length === 0) {
    return { candidates: [], baseline: null, candidatesEvaluated: 0, blockedBy: null };
  }

  const nameOf = (id: NodeId): string => `Panel ${order.indexOf(id) + 1}`;

  const usableWidth = options.pageWidthMm - 2 * options.marginMm;
  const scored: SmartLayoutCandidate[] = [];
  const seenIds = new Set<string>();
  let evaluated = 0;
  let firstRejection: string | null = null;

  for (const scale of scales) {
    // Demands must arrive in the unit order the slots are indexed by, so a
    // mismatched measurement can never be silently paired with the wrong unit.
    const byId = new Map(unitDemands(doc, units, scale.demands).map((d) => [d.unitId, d]));
    const demands = order.map((id) => byId.get(id)).filter((d): d is UnitDemand => d !== undefined);
    if (demands.length !== n) continue;

    /*
     * A panel too wide for the page itself blocks every arrangement, so say so
     * precisely here rather than letting the generic "no N-column arrangement
     * fits" stand in. Naming the panel and its number is the difference
     * between a message an author can act on and one they cannot.
     */
    const tooWide = demands.find((d) => d.minWidthMm > usableWidth - options.labelGutterMm + 0.01);
    if (tooWide) {
      firstRejection ??= `${nameOf(tooWide.unitId)} needs ${tooWide.minWidthMm.toFixed(1)} mm of width and the page offers ${(usableWidth - options.labelGutterMm).toFixed(1)} mm`;
      continue;
    }
    const maxCols = mostThatFit(
      demands.map((d) => d.minWidthMm + options.labelGutterMm),
      usableWidth,
      options.gutterMm,
    );
    const maxRows = mostThatFit(
      demands.map((d) => d.minHeightMm),
      options.maxPageHeightMm - 2 * options.marginMm,
      options.gutterMm,
    );

    const sizes = demands.map(sizeDemand);

    for (const arrangement of enumerateArrangements(n, { maxColumns: maxCols, maxRows })) {
      const shape = arrangementSignature(arrangement);

      // The height at which every band gets exactly what it asked for, which is
      // the one page height worth offering besides the current one and the cap.
      const heightDemand = arrangementHeightDemand(arrangement, order, sizes, {
        pageWidthMm: options.pageWidthMm,
        marginMm: options.marginMm,
        gutterMm: options.gutterMm,
        labelGutterMm: options.labelGutterMm,
      });
      if (!heightDemand) {
        firstRejection ??= `no ${shape} arrangement leaves every panel its minimum width`;
        continue;
      }

      const heights = [...new Set([
        options.currentPageHeightMm,
        clamp(heightDemand.wantMm, options.minPageHeightMm, options.maxPageHeightMm),
        options.maxPageHeightMm,
      ])].sort((a, b) => a - b);

      for (const pageHeightMm of heights) {
        evaluated++;
        // Solved at *this* height, so a short page tightens every band toward
        // its minimum rather than scaling the wants down uniformly and pushing
        // one panel under its own floor.
        const layout = arrangementLayout(
          arrangement,
          order,
          sizes,
          layoutOptionsFor(options, pageHeightMm),
        );
        if (!layout) {
          firstRejection ??= `no ${shape} arrangement fits in ${pageHeightMm.toFixed(0)} mm of page`;
          continue;
        }
        const { frames } = layout;
        /*
         * The height the bands actually used, not the one we asked for. Every
         * enumerated height at or above the arrangement's own `wantMm` now
         * realises as exactly `wantMm`, so scoring the *requested* height would
         * report a page taller than the one applying it produces.
         */
        const realisedHeightMm = Math.max(options.minPageHeightMm, layout.pageHeightMm);

        const rejection = rejectionFor(frames, demands, nameOf);
        if (rejection) {
          firstRejection ??= rejection;
          continue;
        }

        // The structural reading-order argument, checked rather than trusted.
        if (!readsInOrder(order, frames)) continue;

        /*
         * Two enumerated heights can now collapse onto one realised page, which
         * would otherwise put two identical candidates in the list under
         * different ids — and `id` is the React key the offered list renders on.
         */
        const id = `${shape}-h${realisedHeightMm.toFixed(1)}-f${scale.fontScale}`;
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        /*
         * The ratio the panel really got, read off the frames rather than
         * predicted from the demand.
         *
         * A montage's height is affine in its width, so no single ratio is
         * right at more than one size — the old code took the demand's nominal
         * aspect, computed at a 5 mm cell, and locked panels to a shape no
         * candidate ever produced. This one is exact at the size the author is
         * about to see, the same reason the page height is scored at its
         * realised value rather than the enumerated one.
         *
         * `aspectFromContent` still decides whether a lock is written at all:
         * an author-set lock is a constraint, not a suggestion.
         */
        const aspectLocks: Record<NodeId, number | null> = {};
        for (const demand of demands) {
          const frame = frames.get(demand.unitId);
          aspectLocks[demand.unitId] =
            demand.aspectFromContent && frame && frame.height > 0
              ? frame.width / frame.height
              : null;
        }

        const { score, terms } = scoreCandidate(
          frames,
          demands,
          realisedHeightMm,
          scale.fontScale,
          options,
        );
        scored.push({
          id,
          arrangement,
          order,
          pageHeightMm: realisedHeightMm,
          fontScale: scale.fontScale,
          typeScale: scale.typeScale,
          minPt: scale.minPt,
          aspectLocks,
          frames,
          score,
          terms,
        });
      }
    }
  }

  /*
   * Deterministic all the way down. Score first, then the levers in the order
   * an author would rather not spend them: keep their type, keep their page
   * short, prefer plain rows to an L-shape (a stack is a stronger claim on the
   * reader, so it should only rank above a plain row when it genuinely scores
   * better), then fewer bands. The final lexicographic comparison means two
   * candidates can never swap places between runs.
   */
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.fontScale - a.fontScale ||
      a.pageHeightMm - b.pageHeightMm ||
      Number(hasStack(a.arrangement)) - Number(hasStack(b.arrangement)) ||
      a.arrangement.bands.length - b.arrangement.bands.length ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  /*
   * At most one candidate per *figure*, which is a coarser thing than per
   * arrangement.
   *
   * Deduping on the exact structure was not enough: for seven equal panels the
   * top eight came back as four all-but-identical L-shapes (the stack at the
   * left or the right of either band, scoring within nothing of each other)
   * plus four three-band shapes, and the plain `3 + 4` the whole round is about
   * never appeared at all. What an author is choosing between is the panels per
   * row and whether anything is stacked, not which end the stack sits at — so
   * that is the key, and the sort above has already put each figure's best
   * variant first.
   */
  const bestPerShape: SmartLayoutCandidate[] = [];
  const shapesSeen = new Set<string>();
  for (const candidate of scored) {
    const shape = figureSignature(candidate.arrangement);
    if (shapesSeen.has(shape)) continue;
    shapesSeen.add(shape);
    bestPerShape.push(candidate);
  }

  /*
   * Every row count gets a plain entry and an L-shaped one before any gets a
   * second of either.
   *
   * Ranking the offered list purely by score turned out to bunch it. On the
   * seven-panel sample all eight came back at three, four or five bands —
   * `2 + 2 + 3`, `3 + 2 + 2`, `1 + 2 + 2 + 2` and so on — with no two-row split
   * at all, because four panels across a 183 mm page is genuinely a little
   * tight and it scored a couple of points lower. Honest, and a poor offer: the
   * author is choosing a *figure*, and eight variations on one row count is a
   * narrower choice than eight slots can afford.
   *
   * Bucketing on the row count alone was not enough either — the best two-row
   * entry was an L-shape, so the plain `3 + 4` stayed out. The stack has to be
   * part of the key, or the two kinds compete for one slot and the more exotic
   * one wins it on a point of score.
   *
   * Nothing is reordered by this: the highest-scoring candidate is still first,
   * and each bucket's own representative is its best. Only what makes the cut
   * changes.
   */
  const buckets = new Map<string, SmartLayoutCandidate>();
  for (const candidate of bestPerShape) {
    /*
     * `A` is in the key for the same reason `L` is. An aligned arrangement is a
     * distinct offer — tidy columns across every band — and it now scores
     * honestly worse on `bandWaste`, because sharing one width division across
     * bands is exactly what leaves a row ragged. Without its own bucket it would
     * lose its slot to the plain variant on a point of score, quietly removing a
     * shipped option.
     */
    const key = [
      candidate.arrangement.bands.length,
      hasStack(candidate.arrangement) ? 'L' : '',
      candidate.arrangement.aligned ? 'A' : '',
    ].join('');
    if (!buckets.has(key)) buckets.set(key, candidate);
  }
  const representatives = new Set(buckets.values());
  const offered = [
    ...bestPerShape.filter((c) => representatives.has(c)),
    ...bestPerShape.filter((c) => !representatives.has(c)),
  ]
    .slice(0, OFFERED_CANDIDATES)
    .sort((a, b) => bestPerShape.indexOf(a) - bestPerShape.indexOf(b));

  const baseScale = scales[0]!;
  const baselineByUnit = new Map(
    unitDemands(doc, units, baseScale.demands).map((d) => [d.unitId, d]),
  );
  const baselineDemands = order
    .map((id) => baselineByUnit.get(id))
    .filter((d): d is UnitDemand => d !== undefined);

  return {
    candidates: offered,
    baseline: baselineDemands.length === n ? currentAsCandidate(input, baselineDemands) : null,
    candidatesEvaluated: evaluated,
    blockedBy: scored.length === 0 ? firstRejection : null,
  };
}

/**
 * The layout as it stands, scored by exactly the same function, so the
 * explanations can quote a real difference. Scoring the baseline any other way
 * would let a candidate claim an improvement over a reference that was never
 * measured the same as it.
 */
function currentAsCandidate(
  input: SmartLayoutInput,
  demands: readonly UnitDemand[],
): SmartLayoutCandidate {
  const { options, currentFrames } = input;
  const order = input.units.map((u) => u.id);
  const scale = input.scales[0]!;
  const { score, terms } = scoreCandidate(
    currentFrames,
    demands,
    options.currentPageHeightMm,
    1,
    options,
  );
  return {
    id: 'current',
    // A placeholder shape: the baseline exists to be scored and differenced
    // against, never drawn, and the panels are wherever the author left them
    // rather than in any arrangement this module would produce.
    arrangement: { bands: [{ columns: order.map(() => ({ count: 1 })) }], aligned: false },
    order,
    pageHeightMm: options.currentPageHeightMm,
    fontScale: 1,
    typeScale: scale.typeScale,
    minPt: scale.minPt,
    aspectLocks: {},
    frames: currentFrames,
    score,
    terms,
  };
}

/**
 * Replace a candidate's predicted frames and score with measured ones.
 *
 * `reserveSpaceForGroupLabels` translates panels *after* the grid is solved, so
 * a candidate's own prediction is not necessarily where the panels land. The
 * app re-runs this against a scratch document for the handful of finalists it
 * actually shows, which is what makes the previewed score the score of what
 * Apply produces rather than a close relative of it.
 */
export function rescoreCandidate(
  candidate: SmartLayoutCandidate,
  frames: ReadonlyMap<NodeId, RectMm>,
  demands: readonly UnitDemand[],
  options: SmartLayoutOptions,
): SmartLayoutCandidate {
  const { score, terms } = scoreCandidate(
    frames,
    demands,
    candidate.pageHeightMm,
    candidate.fontScale,
    options,
  );
  return { ...candidate, frames, score, terms };
}

// ---------------------------------------------------------------------------
// Explaining a candidate
// ---------------------------------------------------------------------------

const pct = (v: number): string => `${Math.round(v * 100)} %`;

/**
 * One sentence naming the largest gain and the largest cost.
 *
 * Generated rather than written, and from the score's own terms, so it cannot
 * describe a trade the score did not actually make. At most one of each: a list
 * of five small differences is not an explanation.
 */
export function explainCandidate(
  candidate: SmartLayoutCandidate,
  baseline: SmartLayoutCandidate | null,
): string {
  const parts: string[] = [];

  const biggest = (): { label: string; delta: number } | null => {
    if (!baseline) return null;
    const diffs: { label: string; delta: number }[] = [
      { label: 'unmet demand', delta: baseline.terms.unmetDemand - candidate.terms.unmetDemand },
      { label: 'whitespace', delta: baseline.terms.whitespace - candidate.terms.whitespace },
      // Named, or a term that reorders the list would never be visible to the
      // author — the other half of "the explanation is generated from the
      // score's own terms, so it cannot describe a trade the score did not make".
      { label: 'dead space', delta: baseline.terms.bandWaste - candidate.terms.bandWaste },
    ];
    diffs.sort((a, b) => b.delta - a.delta);
    const best = diffs[0];
    return best && best.delta > 0.02 ? best : null;
  };

  const gain = biggest();
  if (gain?.label === 'whitespace') {
    parts.push(`Removes ${pct(gain.delta)} of the whitespace.`);
  } else if (gain?.label === 'dead space') {
    parts.push(`Removes ${pct(gain.delta)} of the dead space under the shorter panels.`);
  } else if (gain?.label === 'unmet demand') {
    parts.push(`Closes ${pct(gain.delta)} of the size shortfall.`);
  } else {
    parts.push(`Fits every panel at ${pct(1 - candidate.terms.unmetDemand)} of its comfortable size.`);
  }

  // Always named, never traded away silently: an enlarged picture looks fine on
  // screen and prints soft, which is exactly the failure an author cannot see
  // coming.
  if (candidate.terms.overResolution > 0.02) {
    parts.push('Some pictures are drawn wider than their pixels support.');
  }

  if (baseline && candidate.pageHeightMm > baseline.pageHeightMm + 0.05) {
    parts.push(
      `Costs ${(candidate.pageHeightMm - baseline.pageHeightMm).toFixed(1)} mm of page height.`,
    );
  }
  if (candidate.fontScale < 1) {
    parts.push(`Type reduced to ${pct(candidate.fontScale)} (floor ${candidate.minPt} pt).`);
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Realise a candidate on the document.
 *
 * Ordering is load-bearing at three points and each is commented below. The
 * caller wraps this in one transaction so the whole rearrangement — page,
 * type, locks, frames, letters — is a single undo entry; a partially applied
 * smart layout is worse than none.
 *
 * It takes no margin or gutter: the candidate's frames were solved against
 * those already, and a second set passed in here could only ever disagree with
 * the ones the score was computed from.
 *
 * `reflowBrackets` is deliberately *not* done here: it lives in
 * `packages/render`, which `doc-model` may not import. The app runs it, and
 * `applyAutoLayout`'s own contract already says brackets are the caller's job.
 */
export function applySmartLayout(
  draft: FigureDocument,
  candidate: SmartLayoutCandidate,
): boolean {
  /*
   * The frames are keyed by the panel order captured at solve time, and the
   * arrangement's shape was chosen for the panels in *that* order. Nothing
   * between then and here moves a panel, so they agree — but that is an
   * invariant, not a guarantee, and placing a panel in another's position would
   * silently transpose the figure. Refuse instead.
   */
  const units = layoutUnits(draft.nodes);
  if (units.length !== candidate.order.length) return false;
  if (units.some((unit, index) => unit.id !== candidate.order[index])) return false;

  // 1. Page height first, so the document and the frames below agree about the
  //    page they were solved for.
  draft.page.heightMm = candidate.pageHeightMm;

  // 2. Type next, so the caller's `relabelPanels` letters at the new size.
  if (candidate.fontScale < 1) {
    draft.themeOverrides = {
      ...draft.themeOverrides,
      type: { ...(draft.themeOverrides.type as object | undefined), ...candidate.typeScale },
    };
  }

  // 3. Aspect locks: the frames were already fitted against them, and a panel
  //    keeps the lock so a later manual resize honours the picture's shape.
  for (const [panelId, lock] of Object.entries(candidate.aspectLocks)) {
    const panel = draft.nodes[panelId];
    if (panel?.type !== 'panel') continue;
    panel.aspectLock = lock;
  }

  /*
   * 4. The frames themselves.
   *
   * Not through `applyAutoLayout`: a smart arrangement gives each band its own
   * column boundaries, which one `GridSpec` cannot express (see
   * `arrangement.ts` for the arithmetic that rules the shared-grid route out).
   * `placePanels` is the post-move work factored out of `applyAutoLayout`, so
   * re-tiling, panel-label translation and scale-bar re-sync stay one
   * implementation shared by both callers rather than two that can drift.
   *
   * Every `slot` is cleared: this arrangement is not a template grid, and
   * `applyAutoLayout`'s own comment already says a slot replayed against a
   * differently-shaped grid silently reinterprets itself.
   */
  placeUnits(
    draft,
    units,
    candidate.frames,
    units.map(() => null),
  );

  return true;
}
