/**
 * Arrangements, tested against exact millimetres.
 *
 * This module is pure geometry over four numbers per panel, so nothing here
 * needs a document, a theme or a measurement — the expected widths are worked
 * out by hand in the comments and asserted to six decimal places. The one
 * exception is the reading-order suite, which asserts a *property* over the
 * whole enumeration rather than one shape, because that is the claim the
 * lettering rests on.
 */

import { describe, expect, it } from 'vitest';
import { FREE_SHAPE, heightForWidth, widthForHeight, type ShapeMm } from './geometry.js';
import {
  arrangementLayout,
  arrangementHeightDemand,
  arrangementOrder,
  arrangementSignature,
  arrangementSize,
  describeArrangement,
  enumerateArrangements,
  figureSignature,
  hasStack,
  shareOut,
  MAX_ARRANGEMENTS,
  type Arrangement,
  type PanelSizeDemand,
} from './arrangement.js';

const OPTIONS = {
  pageWidthMm: 183,
  pageHeightMm: 120,
  marginMm: 2,
  gutterMm: 5,
  labelGutterMm: 0,
};

function size(over: Partial<PanelSizeDemand> = {}): PanelSizeDemand {
  return {
    minWidthMm: 20,
    minHeightMm: 20,
    wantWidthMm: 50,
    wantHeightMm: 40,
    shape: FREE_SHAPE,
    ...over,
  };
}

/** Panels per band — how these tests name a shape. */
const shapeOf = (a: Arrangement): string =>
  a.bands.map((b) => b.columns.reduce((s, c) => s + c.count, 0)).join('+');

/**
 * A montage's shape: its cells' combined aspect, plus the bands that do not
 * scale with them. Both bands zero is the lone-picture case, which is what a
 * bare aspect used to mean everywhere.
 */
const montage = (contentAspect: number, fixedWidthMm = 0, fixedHeightMm = 0): ShapeMm => ({
  contentAspect,
  fixedWidthMm,
  fixedHeightMm,
});

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);

const plain = (...counts: number[]): Arrangement => ({
  bands: counts.map((k) => ({ columns: Array.from({ length: k }, () => ({ count: 1 })) })),
  aligned: false,
});

// ---------------------------------------------------------------------------

describe('enumeration', () => {
  it('offers the ragged rows a holed grid used to waste a cell on', () => {
    /*
     * The defect the whole round exists to remove. Seven panels could only be
     * a uniform grid before, so the best on offer was a 2 × 4 — eight cells for
     * seven panels, one of them simply empty.
     */
    const shapes = enumerateArrangements(7, { maxColumns: 4, maxRows: 4 }).map(shapeOf);
    expect(shapes).toContain('3+4');
    expect(shapes).toContain('4+3');
  });

  it('never leaves a position with no panel in it', () => {
    // The hole, stated as a property: an arrangement's positions and its panel
    // count are the same number by construction, so a cell cannot go unfilled.
    for (const n of [2, 3, 5, 7, 9]) {
      for (const arrangement of enumerateArrangements(n, { maxColumns: 4, maxRows: 4 })) {
        expect(arrangementSize(arrangement)).toBe(n);
        expect(arrangementOrder(arrangement)).toHaveLength(n);
      }
    }
  });

  it('refuses an hourglass, and rows that differ by too much', () => {
    const shapes = enumerateArrangements(7, { maxColumns: 5, maxRows: 4 }).map(shapeOf);
    // Not monotone — a narrow row between two wide ones reads as a mistake.
    expect(shapes).not.toContain('2+3+2');
    // Three distinct row counts, and a spread of four.
    expect(shapes).not.toContain('1+1+5');
    expect(shapes).not.toContain('1+2+4');
  });

  it('honours the column limit the narrowest panel implies', () => {
    for (const arrangement of enumerateArrangements(8, { maxColumns: 3, maxRows: 4 })) {
      for (const band of arrangement.bands) {
        const panels = band.columns.reduce((s, c) => s + c.count, 0);
        expect(panels).toBeLessThanOrEqual(3);
      }
    }
  });

  it('includes L-shapes, and only ever a stack of two, one band at a time', () => {
    const all = enumerateArrangements(7, { maxColumns: 4, maxRows: 4 });
    expect(all.some(hasStack)).toBe(true);
    for (const arrangement of all) {
      let stackedBands = 0;
      for (const band of arrangement.bands) {
        const stacks = band.columns.filter((c) => c.count > 1);
        expect(stacks.every((c) => c.count === 2)).toBe(true);
        if (stacks.length > 0) stackedBands++;
        // Two stacks in one band would make the reading order depend on the
        // heights the demands produce, which is why it is refused.
        expect(stacks.length).toBeLessThanOrEqual(1);
      }
      expect(stackedBands).toBeLessThanOrEqual(1);
    }
  });

  it('offers an aligned variant only where the bands really match', () => {
    const six = enumerateArrangements(6, { maxColumns: 3, maxRows: 3 });
    expect(six.some((a) => a.aligned && shapeOf(a) === '3+3')).toBe(true);
    for (const arrangement of six.filter((a) => a.aligned)) {
      const counts = arrangement.bands.map((b) => b.columns.length);
      expect(new Set(counts).size).toBe(1);
    }
  });

  it('is deterministic and stays inside its own cap', () => {
    for (const n of [4, 7, 10]) {
      const a = enumerateArrangements(n, { maxColumns: 4, maxRows: 4 });
      const b = enumerateArrangements(n, { maxColumns: 4, maxRows: 4 });
      expect(a).toEqual(b);
      expect(a.length).toBeLessThanOrEqual(MAX_ARRANGEMENTS);
    }
  });

  it('names a shape the way an author would', () => {
    expect(describeArrangement(plain(3))).toBe('3 across');
    expect(describeArrangement(plain(3, 4))).toBe('3 + 4');
    expect(describeArrangement({ ...plain(3, 3), aligned: true })).toBe('3 + 3 · aligned columns');
    expect(
      describeArrangement({
        bands: [{ columns: [{ count: 2 }, { count: 1 }] }, { columns: [{ count: 1 }] }],
        aligned: false,
      }),
    ).toBe('3 + 1 · one tall panel beside a stack');
  });

  it('distinguishes two figures but not two spellings of one', () => {
    const left: Arrangement = {
      bands: [{ columns: [{ count: 2 }, { count: 1 }] }],
      aligned: false,
    };
    const right: Arrangement = {
      bands: [{ columns: [{ count: 1 }, { count: 2 }] }],
      aligned: false,
    };
    // Different structures, but the same offer to someone comparing figures —
    // which is what keeps four near-identical L-shapes out of the shown list.
    expect(arrangementSignature(left)).not.toBe(arrangementSignature(right));
    expect(figureSignature(left)).toBe(figureSignature(right));
    expect(figureSignature(plain(3))).not.toBe(figureSignature(left));
  });
});

// ---------------------------------------------------------------------------

describe('per-band widths', () => {
  it('gives every band the full page width, however many panels it holds', () => {
    /*
     * The property that proves no row is left as a hole: a band's panels plus
     * its own gutters fill the usable width exactly, whether the band holds
     * three panels or four.
     *
     *   usable = 183 − 2*2 = 179
     */
    const order = ids(7);
    const frames = arrangementLayout(plain(3, 4), order, order.map(() => size()), OPTIONS)!.frames;
    expect(frames).not.toBeNull();

    for (const band of [order.slice(0, 3), order.slice(3)]) {
      const widths = band.map((id) => frames.get(id)!.width);
      const gutters = OPTIONS.gutterMm * (band.length - 1);
      expect(widths.reduce((a, b) => a + b, 0) + gutters).toBeCloseTo(179, 6);
    }
  });

  it('solves each band from its own panels, not from the band above', () => {
    /*
     * The feature itself. Band 1 wants 100 / 50 / 50 and band 2 wants four
     * equal 30s, on a 183 mm page:
     *
     *   band 1: usable 179 − 5*2 = 169, minimums 3*20 = 60 → surplus 109
     *           hunger 80 / 30 / 30 = 140
     *           widths 20 + 109*80/140 = 82.286, 20 + 109*30/140 = 43.357 (×2)
     *   band 2: usable 179 − 5*3 = 164, minimums 4*20 = 80 → surplus 84
     *           hunger equal → 21 each → 41 each
     */
    const order = ids(7);
    const demands = [
      size({ wantWidthMm: 100 }),
      size({ wantWidthMm: 50 }),
      size({ wantWidthMm: 50 }),
      ...Array.from({ length: 4 }, () => size({ wantWidthMm: 30 })),
    ];
    const frames = arrangementLayout(plain(3, 4), order, demands, OPTIONS)!.frames;

    expect(frames.get('p0')!.width).toBeCloseTo(82.286, 3);
    expect(frames.get('p1')!.width).toBeCloseTo(43.357, 3);
    expect(frames.get('p2')!.width).toBeCloseTo(43.357, 3);
    for (const id of order.slice(3)) expect(frames.get(id)!.width).toBeCloseTo(41, 6);
  });

  it('lines the bands up when asked, even though their panels differ', () => {
    /*
     * Aligned mode takes the strongest demand per column index and applies one
     * division to every band — which is what makes the columns share edges, and
     * what an author picks it for.
     */
    const order = ids(4);
    const demands = [
      size({ wantWidthMm: 100 }),
      size({ wantWidthMm: 30 }),
      size({ wantWidthMm: 30 }),
      size({ wantWidthMm: 100 }),
    ];
    const frames = arrangementLayout(
      { ...plain(2, 2), aligned: true },
      order,
      demands,
      OPTIONS,
    )!.frames;
    expect(frames.get('p0')!.x).toBeCloseTo(frames.get('p2')!.x, 6);
    expect(frames.get('p0')!.width).toBeCloseTo(frames.get('p2')!.width, 6);
    expect(frames.get('p1')!.x).toBeCloseTo(frames.get('p3')!.x, 6);
  });

  it('refuses a band whose panels cannot all meet their minimum', () => {
    const order = ids(4);
    // Four panels each needing 60 mm is 240 mm of content on a 179 mm page.
    const frames = arrangementLayout(
      plain(4),
      order,
      order.map(() => size({ minWidthMm: 60 })),
      OPTIONS,
    );
    expect(frames).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('affine shapes', () => {
  it('gives the height a banded panel really takes, where a ratio cannot', () => {
    /*
     * The reported montage: 1 × 3 of 4:3 tiles under one group title.
     *   contentAspect = 3 * (4/3) / 1        = 4
     *   fixedWidth    = 2 gutters × 1 mm     = 2.00
     *   fixedHeight   = the group-label band = 3.54
     *
     *   h(60)  = 3.54 + 58/4  = 18.04
     *   h(120) = 3.54 + 118/4 = 33.04
     *   h(175) = 3.54 + 173/4 = 46.79
     *
     * The single ratio this replaces was 2.5761 — the panel's ratio at a 5 mm
     * cell, which is where `montagePanelAspect` happened to probe — and it gave
     * 23.29 / 46.60 / 67.92 instead. The difference was drawn as dead page
     * under every picture: 1219 mm² per tile at 175 mm of width.
     */
    const shape = montage(4, 2, 3.54);
    expect(heightForWidth(shape, 60)).toBeCloseTo(18.04, 6);
    expect(heightForWidth(shape, 120)).toBeCloseTo(33.04, 6);
    expect(heightForWidth(shape, 175)).toBeCloseTo(46.79, 6);

    // The panel's own ratio really does move with its size — this is the
    // quantity a single `aspectLock` cannot express.
    expect(60 / heightForWidth(shape, 60)).toBeCloseTo(3.325942, 6);
    expect(175 / heightForWidth(shape, 175)).toBeCloseTo(3.740115, 6);
  });

  it('inverts exactly, which is what the one-pass proof rests on', () => {
    const shape = montage(4, 2, 3.54);
    for (const w of [60, 120, 175]) {
      expect(widthForHeight(shape, heightForWidth(shape, w))).toBeCloseTo(w, 6);
    }
    // Below its own bands a shape has no width that produces that height, so
    // the inverse clamps rather than going negative. `refineBandWidths` only
    // ever asks at or above them — see the precondition in its docstring.
    expect(widthForHeight(shape, 1)).toBeCloseTo(2, 6);
  });

  it('leaves a free panel and a bare ratio exactly as they were', () => {
    expect(heightForWidth(FREE_SHAPE, 100)).toBe(0);
    expect(widthForHeight(FREE_SHAPE, 100)).toBe(0);
    // No bands is the lone-picture case, and must still be plain division.
    expect(heightForWidth(montage(4), 100)).toBeCloseTo(25, 6);
  });
});

describe('band refinement', () => {
  it('spends a band’s leftover height on the picture’s width, and reclaims the rest', () => {
    /*
     * The reported defect, in pure arithmetic: a 4:1 picture beside a plot that
     * wants 42 mm of height. The picture cannot get taller without getting
     * wider, so the band's spare height is spendable rather than merely wasted.
     *
     *   pass 1  available 179 − 5 = 174, minimums 20 + 20, surplus 134
     *           hunger 159 / 30 = 189
     *           picture 20 + 134*159/189 = 132.730 ; plot 20 + 134*30/189 = 41.270
     *   H0      max(132.730/4 = 33.183 , 42) = 42            ← the plot sets it
     *   need    4*42 − 132.730 = 35.270 ; slack 41.270 − 20 = 21.270
     *   moved   min(35.270, 21.270) = 21.270                  ← donor-limited
     *   pass 1b picture 154.000 ; plot 20.000                 (sum still 174)
     *   heights picture 154/4 = 38.5 ; plot 42 ; page 2 + 42 + 2 = 46
     *
     * Before this existed the same input gave picture 132.730 × 33.183 and a
     * plot stretched to 116 on a 120 mm page — an 82.8 mm dead strip.
     */
    const order = ids(2);
    const demands = [
      size({ minWidthMm: 20, minHeightMm: 20, wantWidthMm: 179, wantHeightMm: 20, shape: montage(4) }),
      size({ minWidthMm: 20, minHeightMm: 20, wantWidthMm: 50, wantHeightMm: 42 }),
    ];
    const layout = arrangementLayout(plain(2), order, demands, OPTIONS)!;
    const picture = layout.frames.get('p0')!;
    const plot = layout.frames.get('p1')!;

    expect(picture.width).toBeCloseTo(154, 6);
    expect(picture.height).toBeCloseTo(38.5, 6);
    expect(plot.width).toBeCloseTo(20, 6);
    expect(plot.height).toBeCloseTo(42, 6);
    expect(layout.pageHeightMm).toBeCloseTo(46, 6);
    // The band still fills the page: width is moved, never created.
    expect(picture.width + plot.width + OPTIONS.gutterMm).toBeCloseTo(179, 6);
  });

  it('asks only for the height a picture can use at the width it gets', () => {
    /*
     * A picture's `wantHeightMm` is measured at full page width, so one placed
     * narrow still asked for height `fitAspectAligned` immediately throws away.
     * Here the want is a deliberately inflated 90 mm against the 44.75 mm a
     * 4:1 picture can use across 179 mm — the band must ask for the latter.
     */
    const order = ids(1);
    const demands = [size({ minWidthMm: 20, wantWidthMm: 179, wantHeightMm: 90, shape: montage(4) })];
    const options = { pageWidthMm: 183, marginMm: 2, gutterMm: 5, labelGutterMm: 0 };

    const demand = arrangementHeightDemand(plain(1), order, demands, options)!;
    // 44.75 + 4 of margin, rounded up to the half millimetre — not 90 + 4.
    expect(demand.wantMm).toBeCloseTo(49, 6);

    const layout = arrangementLayout(plain(1), order, demands, OPTIONS)!;
    expect(layout.frames.get('p0')!.height).toBeCloseTo(44.75, 6);
    expect(layout.pageHeightMm).toBeCloseTo(48.75, 6);
  });

  it('never returns a page taller than the height it said it wanted', () => {
    /*
     * The guard on the two functions agreeing. `arrangementHeightDemand` and
     * `arrangementLayout` are read off one band solve precisely so a reported
     * height and a produced one cannot disagree; before the clamp the produced
     * one was simply whatever page it was handed.
     */
    const options = { pageWidthMm: 183, marginMm: 2, gutterMm: 5, labelGutterMm: 0 };
    const uneven = [30, 90, 45, 120, 60];
    for (const n of [3, 5, 7]) {
      const order = ids(n);
      const demands = order.map((_, i) =>
        size({
          wantWidthMm: uneven[i % uneven.length]!,
          wantHeightMm: 20 + (i % 3) * 15,
          shape: i % 3 === 0 ? montage(2.5) : FREE_SHAPE,
        }),
      );
      for (const arrangement of enumerateArrangements(n, { maxColumns: 4, maxRows: 4 })) {
        const want = arrangementHeightDemand(arrangement, order, demands, options);
        if (!want) continue;
        for (const pageHeightMm of [want.minMm, want.wantMm, want.wantMm + 60, 297]) {
          const layout = arrangementLayout(arrangement, order, demands, {
            ...options,
            pageHeightMm,
          });
          if (!layout) continue;
          expect(layout.pageHeightMm).toBeLessThanOrEqual(want.wantMm + 1e-6);
          /*
           * At or above its want the clamp is a no-op, so the two agree — to
           * within the half millimetre `arrangementHeightDemand` rounds its own
           * answer *up* by, which is the only slack between them.
           */
          if (pageHeightMm >= want.wantMm) {
            expect(layout.pageHeightMm).toBeGreaterThanOrEqual(want.wantMm - 0.5);
          }
        }
      }
    }
  });

  it('moves no width when the band has no free-height neighbour to take it from', () => {
    /*
     * An aspect-locked donor would shrink its own implied height, lowering the
     * target and moving the dead strip to another column rather than removing
     * it — which is also what the one-pass proof rests on.
     */
    const order = ids(2);
    const demands = [
      size({ minWidthMm: 20, wantWidthMm: 179, wantHeightMm: 20, shape: montage(4) }),
      size({ minWidthMm: 20, wantWidthMm: 179, wantHeightMm: 20, shape: montage(1) }),
    ];
    const layout = arrangementLayout(plain(2), order, demands, OPTIONS)!;
    // Pass 1 splits the surplus equally between two identical width demands.
    expect(layout.frames.get('p0')!.width).toBeCloseTo(87, 6);
    expect(layout.frames.get('p1')!.width).toBeCloseTo(87, 6);
  });

  it('leaves an aligned arrangement’s shared columns aligned', () => {
    /*
     * Reallocating per band is exactly the property `aligned` exists to
     * prevent, so the width lever is skipped there — even with a picture in one
     * band that would otherwise be a receiver.
     */
    const order = ids(4);
    const demands = [
      size({ minWidthMm: 20, wantWidthMm: 179, wantHeightMm: 20, shape: montage(4) }),
      size({ wantWidthMm: 50, wantHeightMm: 60 }),
      size({ wantWidthMm: 100 }),
      size({ wantWidthMm: 50 }),
    ];
    const frames = arrangementLayout(
      { ...plain(2, 2), aligned: true },
      order,
      demands,
      OPTIONS,
    )!.frames;
    expect(frames.get('p0')!.x).toBeCloseTo(frames.get('p2')!.x, 6);
    expect(frames.get('p0')!.width).toBeCloseTo(frames.get('p2')!.width, 6);
    expect(frames.get('p1')!.x).toBeCloseTo(frames.get('p3')!.x, 6);
  });

  it('sizes a banded montage from its cells, not from a ratio of the whole panel', () => {
    /*
     * The reported figure in pure arithmetic: the 1 × 3 captioned montage above
     * beside a bar chart wanting 42 mm. Its own minimums are the tiler's:
     * 3*5 + 2 = 17 wide, 1*5 + 3.54 = 8.54 tall.
     *
     *   pass 1  available 179 − 5 = 174, minimums 17 + 20, surplus 137
     *           hunger 162 / 30 = 192
     *           montage 17 + 137*162/192 = 132.59375 ; plot 20 + 137*30/192 = 41.40625
     *   H0      max(3.54 + 130.59375/4 = 36.188438 , 42) = 42     <- the plot sets it
     *   need    widthForHeight(shape, 42) = 2 + 38.46*4 = 155.84
     *           155.84 − 132.59375 = 23.24625 ; slack 41.40625 − 20 = 21.40625
     *   moved   min(23.24625, 21.40625) = 21.40625                <- donor-limited
     *   pass 1b montage 154.000 ; plot 20.000                     (sum still 174)
     *   heights montage 3.54 + 152/4 = 41.54 ; plot 42 ; page 2 + 42 + 2 = 46
     *
     * Expressed the old way — one ratio of 2.576112 and no bands — the montage
     * *sets* the target instead of receiving from it, so pass 1b moves nothing
     * and it comes out 132.59375 wide on a taller page. Substituting
     * `montage(2.576112412)`, which is exactly what the solver saw before,
     * fails this test.
     */
    const order = ids(2);
    const demands = [
      size({ minWidthMm: 17, minHeightMm: 8.54, wantWidthMm: 179, wantHeightMm: 8.54,
             shape: montage(4, 2, 3.54) }),
      size({ minWidthMm: 20, minHeightMm: 20, wantWidthMm: 50, wantHeightMm: 42 }),
    ];
    const layout = arrangementLayout(plain(2), order, demands, OPTIONS)!;
    const m = layout.frames.get('p0')!;
    const p = layout.frames.get('p1')!;

    expect(m.width).toBeCloseTo(154, 6);
    expect(m.height).toBeCloseTo(41.54, 6);
    expect(p.width).toBeCloseTo(20, 6);
    expect(p.height).toBeCloseTo(42, 6);
    expect(layout.pageHeightMm).toBeCloseTo(46, 6);
    // The point of the whole change: the cells block is 38 mm and the pictures
    // fill it exactly, with only the honest 3.54 mm caption band above them.
    expect(m.height - 3.54).toBeCloseTo((m.width - 2) / 4, 6);
    expect(m.width + p.width + OPTIONS.gutterMm).toBeCloseTo(179, 6);
  });

  it('never widens a picture past the width its own pixels support', () => {
    /*
     * `wantWidthMm` for a picture is its dpi-derived ceiling clamped to the
     * page, so the refinement growing to it can never make `overResolution`
     * fire.
     *
     *   pass 1  hunger 40 / 159 = 199 → picture 20 + 134*40/199 = 46.930
     *   H0      max(46.930/4, 20) = 20 vs the plot's 42 → 42
     *   need    min(4*42 − 46.930 = 121.070, ceiling 60 − 46.930 = 13.070)
     *   moved   13.070, so the picture lands on the ceiling exactly
     *
     * The refinement is the only thing under test here: pass 1's own division
     * also spends its whole surplus, which is a separate matter and
     * `overResolution`'s to police.
     */
    const order = ids(2);
    const demands = [
      size({ minWidthMm: 20, minHeightMm: 5, wantWidthMm: 60, wantHeightMm: 20, shape: montage(4) }),
      size({ minWidthMm: 20, minHeightMm: 20, wantWidthMm: 179, wantHeightMm: 42 }),
    ];
    const picture = arrangementLayout(plain(2), order, demands, OPTIONS)!.frames.get('p0')!;
    expect(picture.width).toBeCloseTo(60, 6);
  });
});

// ---------------------------------------------------------------------------

describe('stacked columns', () => {
  it('splits the band between the stack and leaves the tall panel full height', () => {
    const arrangement: Arrangement = {
      bands: [{ columns: [{ count: 1 }, { count: 2 }] }],
      aligned: false,
    };
    const order = ids(3);
    const frames = arrangementLayout(arrangement, order, order.map(() => size()), OPTIONS)!.frames;

    const tall = frames.get('p0')!;
    const upper = frames.get('p1')!;
    const lower = frames.get('p2')!;

    // The stack's two panels plus the gutter between them are the tall one.
    expect(upper.height + lower.height + OPTIONS.gutterMm).toBeCloseTo(tall.height, 6);
    // They sit in the same column, one under the other.
    expect(upper.x).toBeCloseTo(lower.x, 6);
    expect(lower.y).toBeCloseTo(upper.y + upper.height + OPTIONS.gutterMm, 6);
    // And the tall one starts level with the upper one, which is what keeps it
    // first in reading order.
    expect(tall.y).toBeCloseTo(upper.y, 6);
  });
});

// ---------------------------------------------------------------------------

describe('reading order', () => {
  it('is what the page will actually be read in, for every shape offered', () => {
    /*
     * `relabelPanels` letters whatever `readingOrder` returns, so a shape whose
     * frames sort differently from the order its panels were assigned would
     * letter the figure wrongly — a legend then describes the wrong panel.
     *
     * Ragged bands and L-shapes make "row-major, therefore in order" no longer
     * a one-line argument, so the property is checked across the whole
     * enumeration at deliberately uneven demands, rather than argued for one
     * example.
     */
    const uneven = [100, 30, 60, 45, 80, 25, 55, 70];
    for (const n of [2, 3, 5, 7, 8]) {
      const order = ids(n);
      const demands = order.map((_, i) =>
        size({ wantWidthMm: uneven[i % uneven.length]!, wantHeightMm: 20 + (i % 3) * 15 }),
      );
      for (const arrangement of enumerateArrangements(n, { maxColumns: 4, maxRows: 4 })) {
        const layout = arrangementLayout(arrangement, order, demands, {
          ...OPTIONS,
          pageHeightMm: 240,
        });
        if (!layout) continue;
        const frames = layout.frames;
        const sorted = [...order].sort((a, b) => {
          const fa = frames.get(a)!;
          const fb = frames.get(b)!;
          // `readingOrder`'s own comparator, 5 mm row band included.
          return Math.abs(fa.y - fb.y) <= 5 ? fa.x - fb.x : fa.y - fb.y;
        });
        expect({ shape: arrangementSignature(arrangement), sorted }).toEqual({
          shape: arrangementSignature(arrangement),
          sorted: order,
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('height demand', () => {
  it('reports what the bands add up to, gutters and margins included', () => {
    /*
     * Two bands of one panel each, wanting 40 mm tall apiece:
     *   40 + 40 + one 5 mm gutter + two 2 mm margins = 89
     */
    const order = ids(2);
    const demand = arrangementHeightDemand(plain(1, 1), order, order.map(() => size()), {
      pageWidthMm: 183,
      marginMm: 2,
      gutterMm: 5,
      labelGutterMm: 0,
    })!;
    expect(demand.wantMm).toBeCloseTo(89, 6);
    // And the floor, from the same solve: 20 + 20 + 5 + 4.
    expect(demand.minMm).toBeCloseTo(49, 6);
  });

  it('counts an aspect-locked panel’s implied height as a requirement', () => {
    /*
     * The bug this rule exists for: a wide montage's own height minimum is the
     * mechanical tile floor, so minimum-first sharing handed the hungriest
     * panel the shortest band — and fitting it inside threw away the width it
     * had just been granted.
     *
     * One band, one 4:1 panel across the full 179 mm: 179/4 = 44.75, plus two
     * 2 mm margins = 48.75 — reported as 49, since a page height is rounded up
     * to the half millimetre rather than quoted to four decimal places.
     */
    const demand = arrangementHeightDemand(
      plain(1),
      ['p0'],
      [size({ shape: montage(4), minHeightMm: 5 })],
      { pageWidthMm: 183, marginMm: 2, gutterMm: 5, labelGutterMm: 0 },
    )!;
    expect(demand.minMm).toBeCloseTo(49, 6);
  });
});

// ---------------------------------------------------------------------------

describe('shareOut', () => {
  it('meets every minimum before it feeds anyone’s appetite', () => {
    // 100 to share, minimums 60, so 40 of surplus. Both still hungry by 30 and
    // 10 — a 3:1 split of the surplus, landing on 50 / 50.
    expect(shareOut(100, [20, 40], [50, 50])).toEqual([50, 50]);
    // The second is already at its want, so its hunger is zero and the whole
    // surplus goes to the first. Satisfied is satisfied: it gets no share for
    // merely being large.
    expect(shareOut(100, [20, 40], [80, 40])).toEqual([60, 40]);
  });

  it('spreads the surplus evenly when nobody wants more', () => {
    expect(shareOut(100, [20, 20], [20, 20])).toEqual([50, 50]);
  });

  it('refuses rather than starve someone below their minimum', () => {
    expect(shareOut(50, [40, 40], [40, 40])).toBeNull();
  });
});
