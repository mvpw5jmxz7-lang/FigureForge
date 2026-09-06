/**
 * Arrangements: the shapes a page of panels can take, and where the frames land.
 *
 * Round 35's smart layout could only offer a uniform `rows × columns` grid,
 * because a candidate was a `GridSpec` and one `GridSpec` has one set of column
 * boundaries shared by every row. Seven panels therefore came out as a 2 × 4 —
 * eight cells for seven panels, with **one cell simply empty**. That hole is the
 * wasted strip a real figure never has.
 *
 * What published figures do instead is give each row the full page width and
 * divide it independently: three across the top, four across the bottom, the
 * detailed one of the four wide and its neighbours narrow. This module is that
 * structure.
 *
 * ## Why frames rather than a finer grid with spans
 *
 * Expressing ragged rows through a shared column grid plus `colSpan` was worked
 * out and rejected on arithmetic, not taste. A shared grid forces the *gutter
 * positions* to be global; row 1's gutters and row 2's fall in different places,
 * so the grid needs a boundary at the union of both — but a boundary interior to
 * a row's panel makes that panel absorb an extra gutter, which shifts every
 * position after it, which moves the boundaries being placed. It terminates only
 * by iterating, and layout here refuses convergence loops (`requiredMargin`'s
 * "exactly two passes", `montagePanelAspect`'s closed form). Solving each band on
 * its own is exact and terminates by construction.
 *
 * ## Pure geometry
 *
 * Nothing here knows what a panel *is* — a band is sized from `PanelSizeDemand`,
 * a four-number structural type, so this module can be tested against exact
 * millimetres with no document, no theme and no measurement. `smart-layout.ts`
 * owns everything that decides what those numbers should be.
 */

import type { RectMm } from './geometry.js';
import { fitAspectAligned } from './geometry.js';
import type { NodeId } from './nodes.js';

// ---------------------------------------------------------------------------
// The structure
// ---------------------------------------------------------------------------

/**
 * One column of a band: a single panel, or a vertical stack of them.
 *
 * `count` is 1 or 2 and nothing else — see `enumerateArrangements` for why a
 * deeper stack is refused rather than merely unimplemented.
 */
export interface ArrangementColumn {
  readonly count: number;
}

/** A full-width horizontal strip of the page, divided into columns. */
export interface ArrangementBand {
  readonly columns: readonly ArrangementColumn[];
}

export interface Arrangement {
  readonly bands: readonly ArrangementBand[];
  /**
   * Every band divides the width at the *same* boundaries.
   *
   * Only reachable when the bands have identical column structure, and offered
   * as a separate candidate rather than imposed: independently-solved rows fit
   * the content better, aligned ones read as tidier, and which matters is the
   * author's call. Nothing in the score prefers either.
   */
  readonly aligned: boolean;
}

/** How many panels an arrangement holds. */
export function arrangementSize(arrangement: Arrangement): number {
  let total = 0;
  for (const band of arrangement.bands) {
    for (const column of band.columns) total += column.count;
  }
  return total;
}

/**
 * A stable identity for "this is the same shape", used to keep the offered list
 * from filling up with one arrangement at three page heights.
 */
export function arrangementSignature(arrangement: Arrangement): string {
  const bands = arrangement.bands
    .map((band) => band.columns.map((c) => c.count).join(','))
    .join('|');
  return arrangement.aligned ? `${bands}#aligned` : bands;
}

/**
 * A coarser identity than `arrangementSignature`: the panels per row, whether
 * anything is stacked, and whether the columns line up.
 *
 * What an author is actually choosing between. Two arrangements differing only
 * in which end of a row the stack sits at are, to someone comparing figures,
 * the same offer — and letting both into the list crowds out the shapes that
 * really are different.
 */
export function figureSignature(arrangement: Arrangement): string {
  const rows = bandCounts(arrangement).join('+');
  return `${rows}${hasStack(arrangement) ? '#L' : ''}${arrangement.aligned ? '#A' : ''}`;
}

/** Panels per band, which is what the label quotes. */
function bandCounts(arrangement: Arrangement): number[] {
  return arrangement.bands.map((band) =>
    band.columns.reduce((sum, column) => sum + column.count, 0),
  );
}

/** Whether any band holds a stacked column — the L-shape. */
export function hasStack(arrangement: Arrangement): boolean {
  return arrangement.bands.some((band) => band.columns.some((column) => column.count > 1));
}

/**
 * A short name for an arrangement, for the candidate list.
 *
 * Generated from the structure rather than written, for the same reason
 * `explainCandidate` is: a hand-kept label can describe a shape the candidate
 * does not have.
 */
export function describeArrangement(arrangement: Arrangement): string {
  const counts = bandCounts(arrangement);
  const rows = counts.join(' + ');
  const parts = [counts.length === 1 ? `${rows} across` : rows];
  if (hasStack(arrangement)) parts.push('one tall panel beside a stack');
  else if (arrangement.aligned && counts.length > 1) parts.push('aligned columns');
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export interface ArrangementLimits {
  /** Most panels one band may hold, from the narrowest panel's own minimum. */
  maxColumns: number;
  /** Most bands, from the tallest panel's minimum against the page ceiling. */
  maxRows: number;
}

/** Most shapes any one solve considers. Pinned by a test. */
export const MAX_ARRANGEMENTS = 30;

/**
 * Band panel-counts worth trying for `n` panels.
 *
 * Not every composition of `n` — most of them are not figures anyone would
 * publish. Three rules cut it to the plausible ones:
 *
 *   - at most **two distinct** band counts, differing by at most 2, so a page
 *     does not mix a row of one with a row of five;
 *   - the sequence is **monotone**, so `3, 4` and `1, 3, 3` are offered (a
 *     widening figure, and a full-width panel over two rows of three) while
 *     `2, 3, 2` is not — an hourglass reads as a mistake;
 *   - no band wider than `maxColumns`, which comes from the narrowest panel's
 *     own measured minimum.
 *
 * For seven panels that leaves about eleven genuinely different figures.
 */
function bandCompositions(n: number, limits: ArrangementLimits): number[][] {
  const out: number[][] = [];
  const maxColumns = Math.max(1, limits.maxColumns);
  const maxRows = Math.max(1, Math.min(n, limits.maxRows));

  const walk = (remaining: number, rowsLeft: number, acc: number[]): void => {
    if (rowsLeft === 0) {
      if (remaining === 0) out.push([...acc]);
      return;
    }
    for (let count = 1; count <= Math.min(maxColumns, remaining); count++) {
      // Prune as we go rather than filtering at the end: the two-distinct-values
      // and spread rules are prefix-monotone, so a partial run that breaks them
      // can never be rescued by what follows.
      const next = [...acc, count];
      const distinct = new Set(next);
      if (distinct.size > 2) continue;
      if (Math.max(...next) - Math.min(...next) > 2) continue;
      if (remaining - count > (rowsLeft - 1) * maxColumns) continue;
      walk(remaining - count, rowsLeft - 1, next);
    }
  };

  for (let rows = 1; rows <= maxRows; rows++) walk(n, rows, []);

  const monotone = (counts: readonly number[]): boolean => {
    let up = true;
    let down = true;
    for (let i = 1; i < counts.length; i++) {
      if (counts[i]! < counts[i - 1]!) up = false;
      if (counts[i]! > counts[i - 1]!) down = false;
    }
    return up || down;
  };

  return out.filter(monotone);
}

/** A band of `k` single-panel columns. */
const plainBand = (k: number): ArrangementBand => ({
  columns: Array.from({ length: k }, () => ({ count: 1 })),
});

/**
 * A band of `k` panels where one column holds two of them stacked, at either
 * the left or right edge — the L-shape.
 *
 * Only the two edge positions, and only ever a stack of two. Both restrictions
 * exist to keep reading order derivable: with a stack in the middle, or two
 * stacks in one band, which lower panel comes first depends on the heights the
 * demands happen to produce, so the order could not be known before solving.
 * Returns null where the shape is degenerate (a band that would be one stacked
 * column is just a band of two).
 */
function stackedBand(k: number, side: 'left' | 'right'): ArrangementBand | null {
  if (k < 3) return null;
  const singles = k - 2;
  const stack: ArrangementColumn = { count: 2 };
  const rest = Array.from({ length: singles }, () => ({ count: 1 }));
  return { columns: side === 'left' ? [stack, ...rest] : [...rest, stack] };
}

/**
 * Every arrangement worth scoring for `n` panels.
 *
 * Ordered nearest-square-first, the same ordering `gridShapes` used, so when the
 * cap bites it drops the least plausible shapes rather than an arbitrary tail.
 */
export function enumerateArrangements(n: number, limits: ArrangementLimits): Arrangement[] {
  if (n <= 0) return [];

  const out: Arrangement[] = [];
  const seen = new Set<string>();
  const push = (arrangement: Arrangement): void => {
    if (arrangementSize(arrangement) !== n) return;
    const key = arrangementSignature(arrangement);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(arrangement);
  };

  for (const counts of bandCompositions(n, limits)) {
    push({ bands: counts.map(plainBand), aligned: false });

    // Aligned only means anything when the bands really do have the same
    // structure; offering it otherwise would be a control that does nothing.
    if (counts.length > 1 && counts.every((c) => c === counts[0])) {
      push({ bands: counts.map(plainBand), aligned: true });
    }

    // One stacked band per arrangement, per the rule in `stackedBand`.
    for (let b = 0; b < counts.length; b++) {
      for (const side of ['left', 'right'] as const) {
        const stacked = stackedBand(counts[b]!, side);
        if (!stacked) continue;
        const bands = counts.map((c, i) => (i === b ? stacked : plainBand(c)));
        push({ bands, aligned: false });
      }
    }
  }

  const ideal = Math.sqrt(n);
  const distance = (arrangement: Arrangement): number => {
    const counts = bandCounts(arrangement);
    const widest = Math.max(...counts);
    return Math.abs(counts.length - ideal) + Math.abs(widest - ideal);
  };
  // Plain rows before L-shapes at equal distance, so when the cap bites it
  // drops the more exotic shapes rather than an arbitrary tail — an L-shape is
  // a stronger claim on the reader and should have to earn its place.
  out.sort(
    (a, b) =>
      distance(a) - distance(b) ||
      Number(hasStack(a)) - Number(hasStack(b)) ||
      a.bands.length - b.bands.length ||
      (arrangementSignature(a) < arrangementSignature(b) ? -1 : 1),
  );

  return out.slice(0, MAX_ARRANGEMENTS);
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * What one panel needs along each axis.
 *
 * Structural rather than the full `PanelDemand`, so this module stays testable
 * against exact numbers with no document behind them.
 */
export interface PanelSizeDemand {
  minWidthMm: number;
  minHeightMm: number;
  wantWidthMm: number;
  wantHeightMm: number;
  /** Width/height the panel must keep, or null to fill its cell. */
  aspect: number | null;
}

export interface ArrangementLayoutOptions {
  pageWidthMm: number;
  pageHeightMm: number;
  marginMm: number;
  gutterMm: number;
  labelGutterMm: number;
}

/**
 * Share `total` between tracks: everyone's minimum first, then the surplus in
 * proportion to what each still wants on top of it.
 *
 * The minimum-first half is load-bearing and was missing from the first version
 * of the solver, which divided purely in proportion to `want`. Measured on the
 * sample figure, a three-tile micrograph montage wants 175 mm — honestly, it
 * really does keep gaining detail that far — and in a three-column row that took
 * 109 mm and left the heatmap 28 mm against a 49 mm minimum. Every multi-column
 * arrangement was then rejected and the only surviving answer was a single
 * 247 mm column. Nothing in the score could have caught it: those candidates
 * never got as far as being scored.
 *
 * Returns null when even the minimums do not fit, which is a genuine "this shape
 * cannot work" rather than a preference.
 */
export function shareOut(
  total: number,
  mins: readonly number[],
  wants: readonly number[],
): number[] | null {
  if (mins.length === 0) return [];
  const minSum = mins.reduce((a, b) => a + b, 0);
  if (minSum > total + 0.01) return null;

  const hunger = wants.map((want, i) => Math.max(0, want - mins[i]!));
  const hungerSum = hunger.reduce((a, b) => a + b, 0);
  const surplus = total - minSum;

  // Nobody wants more than their minimum: spread the surplus evenly rather than
  // dividing by zero, so a set of fully-satisfied panels still fills the page
  // instead of huddling at its minimums with a band of white beside it.
  if (hungerSum <= 1e-6) return mins.map((m) => m + surplus / mins.length);
  return mins.map((m, i) => m + (surplus * hunger[i]!) / hungerSum);
}

/**
 * Panels in the order an arrangement's positions will be read.
 *
 * Bands top to bottom; within a band every column's *first* panel left to right
 * — they all start at the band's top edge, so `readingOrder`'s 5 mm y-band
 * groups them — and then the stacked column's lower panel, which sits below all
 * of them whichever column it belongs to.
 *
 * That is the whole reason a stack is limited to one per band: with two, the
 * relative y of their lower panels depends on the heights the demands produce,
 * so the order could not be derived from the structure alone. `smart-layout.ts`
 * then verifies the claim by sorting the frames this produces and discarding any
 * candidate that disagrees, rather than trusting the argument above.
 */
export function arrangementOrder(arrangement: Arrangement): { band: number; column: number; row: number }[] {
  const out: { band: number; column: number; row: number }[] = [];
  arrangement.bands.forEach((band, b) => {
    band.columns.forEach((column, c) => {
      if (column.count > 0) out.push({ band: b, column: c, row: 0 });
    });
    band.columns.forEach((column, c) => {
      for (let r = 1; r < column.count; r++) out.push({ band: b, column: c, row: r });
    });
  });
  return out;
}

const demandsFor = (
  demands: readonly PanelSizeDemand[],
  indices: readonly number[],
): PanelSizeDemand[] => indices.map((i) => demands[i]!).filter(Boolean);

/**
 * Where every panel lands, for one arrangement at one page height.
 *
 * Two passes, forward only, exactly as the grid solver did. Widths first, from
 * what the panels in each column need and then want; then heights, because a
 * panel holding an aspect implies a height only once its width is known. The
 * coupling really is one-way — a wider column implies a taller band and nothing
 * flows back — so a single pass is the whole answer and there is no loop to
 * oscillate.
 *
 * The per-band width solve is the feature: row 2's panels divide the full page
 * width by their own demands with no reference to row 1's.
 *
 * Returns null when the arrangement cannot be realised at this page size.
 */
export function arrangementFrames(
  arrangement: Arrangement,
  order: readonly NodeId[],
  demands: readonly PanelSizeDemand[],
  options: ArrangementLayoutOptions,
): Map<NodeId, RectMm> | null {
  const solved = solveBands(arrangement, order, demands, options);
  if (!solved) return null;
  const { cells, bandWidths, bandMin, bandWant } = solved;

  const { marginMm, gutterMm, labelGutterMm } = options;
  const usableHeightTotal =
    options.pageHeightMm - 2 * marginMm - gutterMm * (arrangement.bands.length - 1);

  const bandHeights = shareOut(usableHeightTotal, bandMin, bandWant);
  if (!bandHeights) return null;

  const frames = new Map<NodeId, RectMm>();
  let y = marginMm;
  arrangement.bands.forEach((band, b) => {
    const widths = bandWidths[b]!;
    const height = bandHeights[b]!;
    let x = marginMm;

    band.columns.forEach((column, c) => {
      const width = widths[c]!;
      const stacked = cells[b]![c]!;

      // Split the band between a stack's panels by the same rule, so a stacked
      // column behaves like a one-column band of its own.
      const inner = Math.max(0, width - labelGutterMm);
      const gutters = gutterMm * (stacked.length - 1);
      const mins = stacked.map((index) => impliedMinHeight(demands[index]!, inner));
      const wants = stacked.map((index, i) =>
        Math.max(mins[i]!, demands[index]!.wantHeightMm),
      );
      const heights = shareOut(height - gutters, mins, wants);
      if (!heights) return;

      let cellY = y;
      stacked.forEach((index, i) => {
        const cell: RectMm = {
          x: x + labelGutterMm,
          y: cellY,
          width: inner,
          height: heights[i]!,
        };
        const demand = demands[index]!;
        // Top-left, never centred — `autoLayout`'s own rule, and for its stated
        // reason: `readingOrder` bands rows on `frame.y`, so a centred panel
        // sorts into the wrong row and takes the wrong letter.
        frames.set(
          order[index]!,
          demand.aspect && demand.aspect > 0
            ? fitAspectAligned(cell, demand.aspect, 'start', 'start')
            : cell,
        );
        cellY += heights[i]! + gutterMm;
      });

      x += width + gutterMm;
    });

    y += height + gutterMm;
  });

  return frames.size === order.length ? frames : null;
}

/**
 * The page height at which every band gets exactly what it wants, and the
 * shortest page the arrangement can be realised on at all.
 *
 * Read off the same band solve `arrangementFrames` uses, never re-derived — two
 * derivations of one quantity is how a reported height and a produced one come
 * to disagree. Band *widths* depend only on the page width, so this is knowable
 * before any page height is chosen, which is what keeps the search a plain
 * enumeration rather than a fixed point.
 */
export function arrangementHeightDemand(
  arrangement: Arrangement,
  order: readonly NodeId[],
  demands: readonly PanelSizeDemand[],
  options: Omit<ArrangementLayoutOptions, 'pageHeightMm'>,
): { minMm: number; wantMm: number } | null {
  const solved = solveBands(arrangement, order, demands, { ...options, pageHeightMm: 0 });
  if (!solved) return null;
  const fixed = options.gutterMm * (arrangement.bands.length - 1) + 2 * options.marginMm;
  const total = (sizes: readonly number[]): number =>
    Math.ceil((sizes.reduce((a, b) => a + b, 0) + fixed) * 2) / 2;
  return { minMm: total(solved.bandMin), wantMm: total(solved.bandWant) };
}

/** A panel's least acceptable height at a given width, aspect included. */
function impliedMinHeight(demand: PanelSizeDemand, widthMm: number): number {
  const implied = demand.aspect && demand.aspect > 0 ? widthMm / demand.aspect : 0;
  return Math.max(demand.minHeightMm, implied);
}

interface SolvedBands {
  /** Panel indices, by band then column. A stacked column holds two. */
  cells: number[][][];
  /** Column widths per band — one shared array per band when aligned. */
  bandWidths: number[][];
  bandMin: number[];
  bandWant: number[];
}

/**
 * Widths per band, then each band's height demand given those widths.
 *
 * Two passes, forward only. Widths first, from what the panels in each column
 * need and then want; then heights, because a panel holding an aspect implies a
 * height only once its width is known. The coupling really is one-way — a wider
 * column implies a taller band and nothing flows back — so a single pass is the
 * whole answer and there is no loop to oscillate, the same
 * termination-by-construction argument `montagePanelAspect` and the two-pass
 * margin rule already rest on.
 *
 * The per-band width solve is the feature: row 2's panels divide the full page
 * width by their own demands with no reference to row 1's.
 */
function solveBands(
  arrangement: Arrangement,
  order: readonly NodeId[],
  demands: readonly PanelSizeDemand[],
  options: ArrangementLayoutOptions,
): SolvedBands | null {
  const positions = arrangementOrder(arrangement);
  if (positions.length !== order.length || demands.length !== order.length) return null;

  const { marginMm, gutterMm, labelGutterMm } = options;
  const usableWidth = options.pageWidthMm - 2 * marginMm;

  // Panel indices grouped by where they sit, so each band can be solved alone.
  const cells: number[][][] = arrangement.bands.map((band) =>
    band.columns.map(() => [] as number[]),
  );
  positions.forEach((position, index) => {
    cells[position.band]![position.column]!.push(index);
  });

  // --- Pass 1: column widths, per band -------------------------------------

  const widthsFor = (band: number): number[] | null => {
    const columns = cells[band]!;
    const available = usableWidth - gutterMm * (columns.length - 1);
    const mins = columns.map((indices) =>
      Math.max(
        ...demandsFor(demands, indices).map((d) => d.minWidthMm + labelGutterMm),
        labelGutterMm,
      ),
    );
    const wants = columns.map((indices) =>
      Math.max(
        ...demandsFor(demands, indices).map((d) => Math.max(d.minWidthMm, d.wantWidthMm) + labelGutterMm),
        labelGutterMm,
      ),
    );
    return shareOut(available, mins, wants);
  };

  let bandWidths: (number[] | null)[];
  if (arrangement.aligned) {
    /*
     * One division for every band. Reachable only when the bands have identical
     * column structure, so taking the strongest demand per column index is the
     * exact analogue of the old shared-grid solve rather than an approximation
     * of it.
     */
    const columnCount = arrangement.bands[0]?.columns.length ?? 0;
    const available = usableWidth - gutterMm * (columnCount - 1);
    const mins = new Array<number>(columnCount).fill(labelGutterMm);
    const wants = new Array<number>(columnCount).fill(labelGutterMm);
    for (let b = 0; b < arrangement.bands.length; b++) {
      for (let c = 0; c < columnCount; c++) {
        for (const demand of demandsFor(demands, cells[b]![c] ?? [])) {
          mins[c] = Math.max(mins[c]!, demand.minWidthMm + labelGutterMm);
          wants[c] = Math.max(
            wants[c]!,
            Math.max(demand.minWidthMm, demand.wantWidthMm) + labelGutterMm,
          );
        }
      }
    }
    const shared = shareOut(available, mins, wants);
    if (!shared) return null;
    bandWidths = arrangement.bands.map(() => shared);
  } else {
    bandWidths = arrangement.bands.map((_, b) => widthsFor(b));
  }
  if (bandWidths.some((w) => w === null)) return null;

  // --- Pass 2: band heights, now that widths are known ---------------------

  const bandMin: number[] = [];
  const bandWant: number[] = [];
  arrangement.bands.forEach((band, b) => {
    const widths = bandWidths[b]!;
    let min = 0;
    let want = 0;
    band.columns.forEach((column, c) => {
      const inner = Math.max(0, widths[c]! - labelGutterMm);
      const stacked = cells[b]![c]!;
      // A stacked column's two panels share the band's height, so the column
      // needs the sum of what they need plus the gutter between them.
      const gutters = gutterMm * (stacked.length - 1);
      let columnMin = gutters;
      let columnWant = gutters;
      for (const index of stacked) {
        const demand = demands[index]!;
        /*
         * A panel holding an aspect needs *exactly* the height that aspect
         * implies at the width it was just given, and it is a requirement
         * rather than a wish: the fit below shrinks it inside its cell, so a
         * shorter band does not squash the panel, it narrows it — throwing away
         * the very width that was allocated to it.
         *
         * Measured before this was a minimum: a three-tile montage allotted a
         * full 175 mm column came out 74.6 mm wide, because its height minimum
         * was the mechanical tile floor and minimum-first sharing therefore
         * handed the hungriest panel the shortest row.
         */
        columnMin += impliedMinHeight(demand, inner);
        columnWant += Math.max(impliedMinHeight(demand, inner), demand.wantHeightMm);
      }
      min = Math.max(min, columnMin);
      want = Math.max(want, columnWant);
    });
    bandMin.push(min);
    bandWant.push(want);
  });

  return { cells, bandWidths: bandWidths as number[][], bandMin, bandWant };
}
