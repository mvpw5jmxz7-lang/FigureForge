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
import {
  arrangementFrames,
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
    aspect: null,
    ...over,
  };
}

/** Panels per band — how these tests name a shape. */
const shapeOf = (a: Arrangement): string =>
  a.bands.map((b) => b.columns.reduce((s, c) => s + c.count, 0)).join('+');

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
    const frames = arrangementFrames(plain(3, 4), order, order.map(() => size()), OPTIONS)!;
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
    const frames = arrangementFrames(plain(3, 4), order, demands, OPTIONS)!;

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
    const frames = arrangementFrames(
      { ...plain(2, 2), aligned: true },
      order,
      demands,
      OPTIONS,
    )!;
    expect(frames.get('p0')!.x).toBeCloseTo(frames.get('p2')!.x, 6);
    expect(frames.get('p0')!.width).toBeCloseTo(frames.get('p2')!.width, 6);
    expect(frames.get('p1')!.x).toBeCloseTo(frames.get('p3')!.x, 6);
  });

  it('refuses a band whose panels cannot all meet their minimum', () => {
    const order = ids(4);
    // Four panels each needing 60 mm is 240 mm of content on a 179 mm page.
    const frames = arrangementFrames(
      plain(4),
      order,
      order.map(() => size({ minWidthMm: 60 })),
      OPTIONS,
    );
    expect(frames).toBeNull();
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
    const frames = arrangementFrames(arrangement, order, order.map(() => size()), OPTIONS)!;

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
        const frames = arrangementFrames(arrangement, order, demands, {
          ...OPTIONS,
          pageHeightMm: 240,
        });
        if (!frames) continue;
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
      [size({ aspect: 4, minHeightMm: 5 })],
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
