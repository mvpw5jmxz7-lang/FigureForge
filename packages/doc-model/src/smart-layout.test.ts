/**
 * Smart layout, tested against exact millimetres.
 *
 * The solver's whole claim is that it computes sizes rather than guessing them,
 * so almost nothing here asserts "bigger than" — the expected numbers are
 * worked out by hand in the comments and asserted to three decimal places.
 */

import { describe, expect, it } from 'vitest';
import { createDocument, createIdFactory } from './document.js';
import { editDocument } from './store.js';
import { readingOrder } from './layout.js';
import { hasStack } from './arrangement.js';
import type { RectMm } from './geometry.js';
import { FREE_SHAPE } from './geometry.js';
import {
  addAsset,
  addPanel,
  addPanelWithImages,
  applyAutoLayout,
  montageCellRects,
} from './operations.js';
import {
  FONT_SCALES,
  IMAGE_LEGIBILITY_MM,
  MAX_CANDIDATES,
  MAX_SIZE_MULTIPLIER,
  MIN_SIZE_MULTIPLIER,
  applySmartLayout,
  explainCandidate,
  imagePanelDemand,
  scoreCandidate,
  solveSmartLayout,
  unitDemands,
  type PanelDemand,
  type SmartLayoutCandidate,
  type SmartLayoutInput,
  type SmartLayoutOptions,
  type SmartLayoutResult,
  type UnitDemand,
} from './smart-layout.js';
import type { FigureDocument, NodeId } from './index.js';

const OPTIONS: SmartLayoutOptions = {
  pageWidthMm: 183,
  currentPageHeightMm: 120,
  maxPageHeightMm: 247,
  minPageHeightMm: 40,
  marginMm: 2,
  gutterMm: 5,
  labelGutterMm: 0,
};

function demand(panelId: NodeId, over: Partial<PanelDemand> = {}): PanelDemand {
  return {
    panelId,
    kind: 'plot',
    minWidthMm: 20,
    minHeightMm: 20,
    comfortWidthMm: 50,
    comfortHeightMm: 40,
    aspect: null,
    fixedWidthMm: 0,
    fixedHeightMm: 0,
    aspectFromContent: false,
    priority: 0.5,
    rejectAboveWidthMm: Number.POSITIVE_INFINITY,
    cappedByPage: false,
    fontScale: 1,
    ...over,
  };
}

/**
 * A panel's demand as the unit it forms on its own — which is what every test
 * here means, since none of these fixtures groups anything.
 */
function unitOf(d: PanelDemand): UnitDemand {
  const { panelId, ...rest } = d;
  return {
    ...rest,
    unitId: panelId,
    panelIds: [panelId],
    shape:
      d.aspectFromContent && d.aspect
        ? { contentAspect: d.aspect, fixedWidthMm: d.fixedWidthMm, fixedHeightMm: d.fixedHeightMm }
        : FREE_SHAPE,
  };
}

/**
 * Panels per band, e.g. `'3'` for one row of three and `'3+4'` for the ragged
 * pair. The candidates are shapes now, not `rows × columns` grids, so this is
 * how a test names the one it means.
 */
function shapeOf(candidate: SmartLayoutCandidate): string {
  return candidate.arrangement.bands
    .map((band) => band.columns.reduce((sum, column) => sum + column.count, 0))
    .join('+');
}

const withShape = (result: SmartLayoutResult, shape: string): SmartLayoutCandidate | undefined =>
  result.candidates.find((c) => shapeOf(c) === shape && !hasStack(c.arrangement));

function input(demands: readonly PanelDemand[], over: Partial<SmartLayoutOptions> = {}): SmartLayoutInput {
  // A deliberately poor starting layout — every panel a 40 mm square stacked at
  // the origin — so the baseline is real and a candidate's reported gain is a
  // difference between two things scored the same way.
  const currentFrames = new Map(
    demands.map((d) => [d.panelId, { x: 0, y: 0, width: 40, height: 40 }] as const),
  );
  // A document holding one top-level panel per demand, so `layoutUnits` finds
  // exactly the units these tests are about.
  const nodes = Object.fromEntries(
    demands.map((d) => [
      d.panelId,
      { id: d.panelId, type: 'panel', parentId: null, frame: currentFrames.get(d.panelId)! },
    ]),
  ) as unknown as FigureDocument['nodes'];

  return {
    units: demands.map((d) => ({
      id: d.panelId,
      kind: 'panel' as const,
      frame: currentFrames.get(d.panelId)!,
      panelIds: [d.panelId],
    })),
    doc: { nodes } as FigureDocument,
    scales: [{ fontScale: 1, typeScale: { tickLabelPt: 6 }, minPt: 6, demands }],
    options: { ...OPTIONS, ...over },
    currentFrames,
  };
}

describe('solved column weights', () => {
  it('divides the page in the ratio of what the panels asked for', () => {
    /*
     * Three panels each needing 20 mm and wanting 100 / 50 / 50, on a 183 mm
     * page. Minimums are met first, then the surplus goes to whoever still
     * wants most — never in raw proportion to the wants, or the hungriest
     * panel starves its neighbours below their own floors:
     *
     *   usable   = 183 − 2*2 − 5*2      = 169
     *   minimums = 3 * 20               =  60   → surplus 109
     *   hunger   = 80 / 30 / 30         = 140
     *   widths   = 20 + 109*80/140      = 82.286
     *              20 + 109*30/140      = 43.357  (×2)
     */
    const result = solveSmartLayout(
      input([
        demand('a', { comfortWidthMm: 100 }),
        demand('b', { comfortWidthMm: 50 }),
        demand('c', { comfortWidthMm: 50 }),
      ]),
    );
    const oneRow = withShape(result, '3');
    expect(oneRow).toBeDefined();

    // Asserted on the frames the candidate actually carries, which is what
    // Apply writes onto the panels — a weight is an intermediate, a frame is
    // the answer.
    const widths = ['a', 'b', 'c'].map((id) => oneRow!.frames.get(id)!.width);
    expect(widths[0]).toBeCloseTo(82.286, 3);
    expect(widths[1]).toBeCloseTo(43.357, 3);
    expect(widths[2]).toBeCloseTo(43.357, 3);
    // And they still fill the page exactly, with nothing lost to rounding.
    expect(widths[0]! + widths[1]! + widths[2]!).toBeCloseTo(169, 6);
  });

  it('never starves a column below its minimum to feed a hungry neighbour', () => {
    /*
     * The bug this exists to catch, found by probing the real sample figure
     * rather than by reading: a three-tile micrograph montage honestly wants
     * 175 mm, and dividing in raw proportion to the wants handed it 109 mm of
     * a three-column grid while leaving the heatmap's column 28 mm against a
     * 49 mm minimum. Every multi-column arrangement was then rejected and the
     * solver's only answer was a 247 mm single column.
     */
    const result = solveSmartLayout(
      input([
        demand('greedy', { minWidthMm: 17, comfortWidthMm: 175 }),
        demand('heatmap', { minWidthMm: 49, comfortWidthMm: 50 }),
        demand('plot', { minWidthMm: 42, comfortWidthMm: 57 }),
      ]),
    );
    const threeUp = withShape(result, '3');
    expect(threeUp).toBeDefined();
    expect(threeUp!.frames.get('heatmap')!.width).toBeGreaterThanOrEqual(49);
    expect(threeUp!.frames.get('plot')!.width).toBeGreaterThanOrEqual(42);
    // And the greedy one still gets the lion's share of what is left over.
    expect(threeUp!.frames.get('greedy')!.width).toBeGreaterThan(
      threeUp!.frames.get('heatmap')!.width,
    );
  });

  it('gives an aspect-locked panel the row height its width implies', () => {
    /*
     * Also found by probing: a wide montage's row minimum is the mechanical
     * 5 mm tile floor, so min-first sharing gave the hungriest panel the
     * *shortest* row — and `autoLayout`, fitting it inside that row, threw
     * away the column width it had just been granted. On the sample figure a
     * montage allotted a 175 mm column came out 74.6 mm wide.
     */
    const result = solveSmartLayout(
      input([
        // `aspectFromContent` is what says the lock will actually be written,
        // and so what says the frame will be fitted to it. Without it the
        // solver quite rightly ignores the aspect — reserving height for a
        // shape it then does not enforce is how a row ends up the wrong size.
        demand('wide', {
          aspect: 4.4,
          aspectFromContent: true,
          minWidthMm: 17,
          minHeightMm: 5,
          comfortWidthMm: 175,
        }),
        demand('below', { comfortWidthMm: 50 }),
      ]),
    );
    const stacked = withShape(result, '1+1');
    expect(stacked).toBeDefined();
    const frame = stacked!.frames.get('wide')!;
    // Full column width, and a height that matches the aspect rather than a
    // width shrunk to fit a row that was too short.
    expect(frame.width).toBeCloseTo(frame.height * 4.4, 1);
    expect(frame.width).toBeGreaterThan(100);
  });

  it('gives equal columns when every panel wants the same', () => {
    const result = solveSmartLayout(
      input([demand('a'), demand('b'), demand('c')]),
    );
    const oneRow = withShape(result, '3')!;
    const widths = ['a', 'b', 'c'].map((id) => oneRow.frames.get(id)!.width);
    expect(widths[0]).toBeCloseTo(widths[1]!, 6);
    expect(widths[1]).toBeCloseTo(widths[2]!, 6);
  });
});

describe('size multipliers', () => {
  it('scales comfort demand into a genuinely bigger frame, the same as asking for more room directly', () => {
    /*
     * Three panels min 20 mm each on the same 183 mm page as "divides the page
     * in the ratio of what the panels asked for" above — usable 169, minimums
     * 60, surplus 109. Panel b's `sizeMultiplier` (2.0, the maximum) doubles
     * its comfortWidthMm from 50 to 100 — the identical want that test reaches
     * by declaring 100 directly — so the two must land on the same widths:
     *
     *   hunger   = 30 / 80 / 30       = 140
     *   widths   = 20 + 109*30/140    = 43.357  (a, c)
     *              20 + 109*80/140    = 82.286  (b)
     */
    const result = solveSmartLayout(
      input([demand('a'), demand('b'), demand('c')], {
        sizeMultipliers: new Map([['b', MAX_SIZE_MULTIPLIER]]),
      }),
    );
    const oneRow = withShape(result, '3');
    expect(oneRow).toBeDefined();
    expect(oneRow!.frames.get('a')!.width).toBeCloseTo(43.357, 3);
    expect(oneRow!.frames.get('b')!.width).toBeCloseTo(82.286, 3);
    expect(oneRow!.frames.get('c')!.width).toBeCloseTo(43.357, 3);
  });

  it('is byte-identical to a solve with no multiplier at all when the map is absent or empty', () => {
    const demands = [demand('a'), demand('b'), demand('c')];
    const withEmptyMap = solveSmartLayout(input(demands, { sizeMultipliers: new Map() }));
    const withoutMap = solveSmartLayout(input(demands));
    expect(withShape(withEmptyMap, '3')!.frames.get('a')).toEqual(
      withShape(withoutMap, '3')!.frames.get('a'),
    );
  });

  it('clamps to [MIN_SIZE_MULTIPLIER, MAX_SIZE_MULTIPLIER] and never touches the wall', () => {
    const doc = {
      nodes: {
        p: { id: 'p', type: 'panel', parentId: null, frame: { x: 0, y: 0, width: 10, height: 10 } },
      },
    } as unknown as FigureDocument;
    const units = [
      {
        id: 'p' as NodeId,
        kind: 'panel' as const,
        frame: { x: 0, y: 0, width: 10, height: 10 },
        panelIds: ['p' as NodeId],
      },
    ];
    const base = demand('p', { minWidthMm: 20, comfortWidthMm: 22, comfortHeightMm: 40 });

    // A multiplier past the ceiling behaves exactly like the ceiling itself.
    const wayOver = unitDemands(doc, units, [base], new Map([['p', 10]]))[0]!;
    const atMax = unitDemands(doc, units, [base], new Map([['p', MAX_SIZE_MULTIPLIER]]))[0]!;
    expect(wayOver.comfortWidthMm).toBeCloseTo(atMax.comfortWidthMm, 6);

    // And one past the floor behaves like the floor.
    const wayUnder = unitDemands(doc, units, [base], new Map([['p', 0.01]]))[0]!;
    const atMin = unitDemands(doc, units, [base], new Map([['p', MIN_SIZE_MULTIPLIER]]))[0]!;
    expect(wayUnder.comfortWidthMm).toBeCloseTo(atMin.comfortWidthMm, 6);

    // The wall itself — minWidthMm — is never scaled, whatever the multiplier.
    expect(wayUnder.minWidthMm).toBe(20);
    expect(atMax.minWidthMm).toBe(20);
  });
});

describe('aspect-locked panels and reading order', () => {
  it('keeps an aspect-locked panel on its own row, so the letters stay in order', () => {
    /*
     * `readingOrder` bands rows with a 5 mm tolerance on `frame.y`, and
     * `relabelPanels` letters what it returns. A wide montage *centred* in a
     * square cell sits over 20 mm below the cell top, so it read as the next
     * row down and took a letter belonging to a panel to its right — the
     * sample figure opened with its middle panel lettered `c` and the panel
     * to its right lettered `b`. Caught by looking at the rendered figure,
     * not by any test that existed at the time.
     */
    const newId = createIdFactory();
    const base = createDocument({ idFactory: newId, widthMm: 183, heightMm: 120 });
    const ids: NodeId[] = [];
    const doc = editDocument(base, (draft) => {
      for (const lock of [null, 4.4, null]) {
        const panel = addPanel(draft, newId, {
          frame: { x: 0, y: 0, width: 50, height: 50 },
          aspectLock: lock,
        });
        ids.push(panel.id);
      }
      applyAutoLayout(draft, { marginMm: 2, gutterMm: 5, labelGutterMm: 4 });
    });

    const tops = ids.map((id) => (doc.nodes[id] as { frame: RectMm }).frame.y);
    expect(new Set(tops.map((y) => y.toFixed(3))).size).toBe(1);
    expect(readingOrder(doc.nodes).map((n) => n.id)).toEqual(ids);
  });
});

describe('image demand', () => {
  const build = (naturalWidth: number) => {
    const newId = createIdFactory();
    const base = createDocument({ idFactory: newId });
    const doc = editDocument(base, (draft) => {
      addAsset(draft, {
        id: 'asset-1',
        filename: 'cells.png',
        mimeType: 'image/png',
        path: 'data/cells.png',
        byteLength: 1,
        naturalPx: { width: naturalWidth, height: 600 },
      });
      addPanelWithImages(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 45 },
        images: [{ assetId: 'asset-1', naturalPx: { width: naturalWidth, height: 600 } }],
      });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    return imagePanelDemand(doc, panel as never, {
      usableWidthMm: 1000, // deliberately unbounded, so the raw number shows
      exportDpi: 300,
      fontScale: 1,
    });
  };

  it('caps a detailed micrograph at the width where it still holds 300 dpi', () => {
    // 4000 px / (300 dpi / 25.4 mm-per-inch) = 338.667 mm
    expect(build(4000).comfortWidthMm).toBeCloseTo(338.667, 3);
  });

  it('caps a small inset far lower — enlarging it buys nothing but a dpi finding', () => {
    // 400 px / (300 / 25.4) = 33.867 mm
    expect(build(400).comfortWidthMm).toBeCloseTo(33.867, 3);
  });

  it('ranks the detailed micrograph above the small inset', () => {
    expect(build(4000).priority).toBeGreaterThan(build(400).priority);
  });

  it('never demands less than a legible picture', () => {
    expect(build(60).minWidthMm).toBe(IMAGE_LEGIBILITY_MM);
  });
});

describe('montage minimum', () => {
  /**
   * A 3 × 2 montage with a 2 mm gutter and 1 mm padding needs
   *   3*MIN_TILE_MM + 2*gutter + 2*padding = 15 + 4 + 2 = 21 mm
   * before `montageCellRects` will hand back any cells at all. The demand and
   * the tiler must agree on that number exactly, or the solver proposes frames
   * the tiler then silently refuses to fill.
   */
  const build = () => {
    const newId = createIdFactory();
    const base = createDocument({ idFactory: newId });
    return editDocument(base, (draft) => {
      for (let i = 0; i < 6; i++) {
        addAsset(draft, {
          id: `asset-${i}`,
          filename: `t${i}.png`,
          mimeType: 'image/png',
          path: `data/t${i}.png`,
          byteLength: 1,
          naturalPx: { width: 400, height: 400 },
        });
      }
      const { panel } = addPanelWithImages(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 40 },
        gutterMm: 2,
        images: Array.from({ length: 6 }, (_, i) => ({
          assetId: `asset-${i}`,
          naturalPx: { width: 400, height: 400 },
        })),
      });
      panel.paddingMm = 1;
      panel.contentGrid = { rows: 2, cols: 3, gutterMm: 2, autoFit: false };
    });
  };

  it('agrees with the tiler to a tenth of a millimetre', () => {
    const doc = build();
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const d = imagePanelDemand(doc, panel as never, {
      usableWidthMm: 179,
      exportDpi: 300,
      fontScale: 1,
    });
    expect(d.kind).toBe('montage');
    expect(d.minWidthMm).toBeCloseTo(21, 6);
    expect(d.minHeightMm).toBeCloseTo(14, 6);

    const tall = { x: 0, y: 0, width: 21, height: 14 };
    expect(montageCellRects(doc, panel.id, tall)).not.toBeNull();
    expect(montageCellRects(doc, panel.id, { ...tall, width: 20.9 })).toBeNull();
  });
});

describe('rejections', () => {
  it('refuses an arrangement that cannot give a panel its minimum width', () => {
    // 179 mm of usable width cannot hold two panels each needing 120 mm, on any
    // grid that also keeps them side by side — but stacking them is fine.
    const result = solveSmartLayout(
      input([
        demand('a', { minWidthMm: 120, comfortWidthMm: 120 }),
        demand('b', { minWidthMm: 120, comfortWidthMm: 120 }),
      ]),
    );
    // Non-empty first: a `for` over no candidates would pass this vacuously,
    // which is exactly how the over-resolution case below hid a real bug.
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      for (const band of candidate.arrangement.bands) expect(band.columns).toHaveLength(1);
    }
  });

  it('still offers a layout for an image too small for the page, and says so', () => {
    /*
     * A lone 400 px inset always receives its whole cell, so it *cannot* comply
     * with its own resolution limit. Rejecting on that basis discarded every
     * candidate and returned nothing — the author lost the feature rather than
     * being told the picture is soft. It is scored instead.
     */
    const result = solveSmartLayout(
      input([demand('a', { kind: 'image', rejectAboveWidthMm: 40, comfortWidthMm: 27 })]),
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    const candidate = result.candidates[0]!;
    expect(candidate.frames.get('a')!.width).toBeGreaterThan(27);
    expect(candidate.terms.overResolution).toBeGreaterThan(0);
    expect(explainCandidate(candidate, result.baseline)).toContain(
      'wider than their pixels support',
    );
  });

  it('gives a low-resolution picture a narrower column than a plot that wants more', () => {
    // The weight solve reads `comfortWidthMm` directly, so this holds without
    // the score being consulted at all — asserted separately from the scoring
    // test below, because an earlier version of that test relied on this
    // mechanism and therefore proved nothing about the score.
    const result = solveSmartLayout(
      input([
        demand('a', { kind: 'image', rejectAboveWidthMm: 40, comfortWidthMm: 27, priority: 0.5 }),
        demand('b', { comfortWidthMm: 70 }),
        demand('c', { comfortWidthMm: 70 }),
      ]),
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    const best = result.candidates[0]!;
    expect(best.frames.get('a')!.width).toBeLessThan(best.frames.get('b')!.width);
  });

  it('scores an enlarged picture below the same picture left at its own size', () => {
    /*
     * The discriminating test for `overResolution`. Both layouts fill the page
     * equally, so `whitespace` cannot separate them and `unmetDemand` caps at
     * full satisfaction for both — only the over-resolution term can, and with
     * its weight at zero these two scores are equal.
     */
    const image = demand('a', { kind: 'image', rejectAboveWidthMm: 40, comfortWidthMm: 27 });
    const atSize = new Map([['a', { x: 0, y: 0, width: 27, height: 40 }]]);
    const blownUp = new Map([['a', { x: 0, y: 0, width: 100, height: 40 }]]);

    const kept = scoreCandidate(atSize, [unitOf(image)], 120, 1, OPTIONS);
    const enlarged = scoreCandidate(blownUp, [unitOf(image)], 120, 1, OPTIONS);

    expect(kept.terms.overResolution).toBe(0);
    expect(enlarged.terms.overResolution).toBeGreaterThan(0);
    expect(enlarged.score).toBeLessThan(kept.score);
  });

  it('tells a flush row from a ragged one at the same page and coverage', () => {
    /*
     * The discriminating test for `bandWaste`, built so no other term can
     * separate the two: identical covered area (7920 mm²) so `whitespace` is
     * equal, both fully satisfied so `unmetDemand` is equal, no finite
     * resolution ceiling so `overResolution` is zero in both, same page, same
     * font. Only the raggedness differs.
     *
     *   ragged  row box 174 × 60 = 10440 → 1 − 7920/10440 = 0.2414
     *   flush   row box 132 × 60 =  7920 → 0
     */
    const demands = [
      demand('a', { comfortWidthMm: 90, comfortHeightMm: 60 }),
      demand('b', { comfortWidthMm: 42, comfortHeightMm: 30 }),
    ];
    const ragged = new Map<NodeId, RectMm>([
      ['a', { x: 0, y: 0, width: 90, height: 60 }],
      ['b', { x: 95, y: 0, width: 84, height: 30 }],
    ]);
    const flush = new Map<NodeId, RectMm>([
      ['a', { x: 0, y: 0, width: 90, height: 60 }],
      ['b', { x: 95, y: 0, width: 42, height: 60 }],
    ]);

    const a = scoreCandidate(ragged, demands.map(unitOf), 120, 1, OPTIONS);
    const b = scoreCandidate(flush, demands.map(unitOf), 120, 1, OPTIONS);

    expect(a.terms.bandWaste).toBeCloseTo(0.2414, 3);
    expect(b.terms.bandWaste).toBe(0);
    expect(a.terms.whitespace).toBeCloseTo(b.terms.whitespace, 6);
    expect(a.terms.unmetDemand).toBeCloseTo(b.terms.unmetDemand, 6);
    expect(b.score).toBeGreaterThan(a.score);
  });

  it('reports what blocked it rather than offering a broken best', () => {
    const result = solveSmartLayout(
      input([demand('a', { minWidthMm: 400, comfortWidthMm: 400 })]),
    );
    expect(result.candidates).toHaveLength(0);
    expect(result.blockedBy).toMatch(/needs 400\.0 mm of width and the page offers/);
  });
});

describe('determinism', () => {
  const demands = [
    demand('a', { comfortWidthMm: 90, priority: 0.9 }),
    demand('b', { comfortWidthMm: 40 }),
    demand('c', { comfortWidthMm: 40 }),
    demand('d', { comfortWidthMm: 60 }),
  ];

  it('returns the same candidates in the same order twice', () => {
    const first = solveSmartLayout(input(demands));
    const second = solveSmartLayout(input(demands));
    expect(first.candidates.map((c) => c.id)).toEqual(second.candidates.map((c) => c.id));
    expect(first.candidates.map((c) => c.score)).toEqual(second.candidates.map((c) => c.score));
  });

  it('does not depend on the order the demands happen to arrive in', () => {
    const shuffled = [...demands].reverse();
    const straight = solveSmartLayout(input(demands));
    const reversed = solveSmartLayout({
      ...input(demands),
      scales: [{ fontScale: 1, typeScale: { tickLabelPt: 6 }, minPt: 6, demands: shuffled }],
    });
    expect(reversed.candidates.map((c) => c.id)).toEqual(straight.candidates.map((c) => c.id));
  });

  it('stays inside its own candidate bound', () => {
    const result = solveSmartLayout(input(demands));
    expect(result.candidatesEvaluated).toBeLessThanOrEqual(MAX_CANDIDATES);
  });
});

describe('reading order', () => {
  it('places every panel where the page will be read, always', () => {
    /*
     * Asserted against the frames, not against the structure that produced
     * them. Ragged bands and L-shapes make "row-major, therefore in order" no
     * longer a one-line argument — a stacked column's lower panel sits below
     * every single panel beside it, whichever column holds the stack — so the
     * claim is checked the way `relabelPanels` will read it: by sorting the
     * frames with `readingOrder`'s own comparator.
     */
    const result = solveSmartLayout(
      input([demand('a'), demand('b'), demand('c'), demand('d'), demand('e')]),
    );
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      const sorted = [...candidate.order].sort((x, y) => {
        const fx = candidate.frames.get(x)!;
        const fy = candidate.frames.get(y)!;
        return Math.abs(fx.y - fy.y) <= 5 ? fx.x - fy.x : fx.y - fy.y;
      });
      expect(sorted).toEqual(['a', 'b', 'c', 'd', 'e']);
    }
  });

  it('offers ragged rows, so a short row is never left as a hole', () => {
    /*
     * The defect this round exists to remove. Seven panels used to come out as
     * a 2 × 4 — eight cells for seven panels, with the eighth simply empty and
     * a strip of the page wasted beside panel g. Every band now divides the
     * full width among however many panels it holds.
     */
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const result = solveSmartLayout(input(ids.map((id) => demand(id))));

    // A two-row split of seven is on the table — three one way, four the other.
    const twoRow = result.candidates.find(
      (c) => c.arrangement.bands.length === 2 && !hasStack(c.arrangement),
    );
    expect(twoRow).toBeDefined();
    expect(shapeOf(twoRow!)).toMatch(/^(3\+4|4\+3)$/);

    // And the property that says there is no hole anywhere: in every candidate
    // offered, every band's panels plus its own gutters fill the page exactly.
    const usable = OPTIONS.pageWidthMm - 2 * OPTIONS.marginMm;
    for (const candidate of result.candidates) {
      let index = 0;
      for (const band of candidate.arrangement.bands) {
        const inBand = band.columns.reduce((sum, column) => sum + column.count, 0);
        const panels = candidate.order.slice(index, index + inBand);
        index += inBand;
        // A stacked column contributes one width, not two, so measure the
        // distinct column positions rather than the panel count.
        const xs = new Map<number, number>();
        for (const id of panels) {
          const frame = candidate.frames.get(id)!;
          xs.set(Math.round(frame.x * 100), frame.width);
        }
        const gutters = OPTIONS.gutterMm * (xs.size - 1);
        const total = [...xs.values()].reduce((a, b) => a + b, 0) + gutters;
        expect({ shape: shapeOf(candidate), total: Math.round(total * 1e6) / 1e6 }).toEqual({
          shape: shapeOf(candidate),
          total: usable,
        });
      }
    }
  });

  it('offers eight genuinely different figures, not one shape eight ways', () => {
    /*
     * The variety is the request. Deduping on the exact structure was not
     * enough: for seven equal panels the list came back as four all-but-
     * identical L-shapes — the stack at the left or the right of either band —
     * plus four three-band shapes, and the plain `3 + 4` never appeared.
     */
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const result = solveSmartLayout(input(ids.map((id) => demand(id))));
    expect(result.candidates).toHaveLength(8);

    const shapes = result.candidates.map((c) => `${shapeOf(c)}${hasStack(c.arrangement) ? 'L' : ''}`);
    expect(new Set(shapes).size).toBe(shapes.length);
    // Both kinds are represented: rows of unequal length, and an L-shape.
    expect(result.candidates.some((c) => new Set(shapeOf(c).split('+')).size > 1)).toBe(true);
    expect(result.candidates.some((c) => hasStack(c.arrangement))).toBe(true);
  });
});

describe('explanations', () => {
  it('names the gain and the cost, and always discloses a type reduction', () => {
    const result = solveSmartLayout(input([demand('a'), demand('b'), demand('c')]));
    const candidate = { ...result.candidates[0]!, fontScale: 0.92, minPt: 5.1 };
    const text = explainCandidate(candidate, result.baseline);
    expect(text).toContain('Type reduced to 92 % (floor 5.1 pt).');
  });

  it('says nothing about type when none was spent', () => {
    const result = solveSmartLayout(input([demand('a'), demand('b'), demand('c')]));
    expect(explainCandidate(result.candidates[0]!, result.baseline)).not.toContain('Type reduced');
  });
});

describe('font scales', () => {
  it('offers the theme size first', () => {
    expect(FONT_SCALES[0]).toBe(1);
  });
});

describe('applying', () => {
  const buildDoc = (): { doc: FigureDocument; ids: NodeId[] } => {
    const newId = createIdFactory();
    const base = createDocument({ idFactory: newId, widthMm: 183, heightMm: 120 });
    const ids: NodeId[] = [];
    const doc = editDocument(base, (draft) => {
      for (let i = 0; i < 3; i++) {
        const panel = addPanel(draft, newId, {
          frame: { x: i * 60, y: 0, width: 55, height: 50 },
          name: `Panel ${i}`,
        });
        ids.push(panel.id);
      }
    });
    return { doc, ids };
  };

  it('writes the page height, the type override and the frames in one pass', () => {
    const { doc, ids } = buildDoc();
    const result = solveSmartLayout(
      input([
        demand(ids[0]!, { comfortWidthMm: 100, comfortHeightMm: 90 }),
        demand(ids[1]!, { comfortWidthMm: 40 }),
        demand(ids[2]!, { comfortWidthMm: 40 }),
      ]),
    );
    const candidate = { ...result.candidates[0]!, fontScale: 0.85, typeScale: { tickLabelPt: 5.1 } };

    const next = editDocument(doc, (draft) => {
      expect(applySmartLayout(draft, candidate)).toBe(
        true,
      );
    });

    expect(next.page.heightMm).toBe(candidate.pageHeightMm);
    expect((next.themeOverrides.type as Record<string, number>).tickLabelPt).toBe(5.1);
    // The first panel asked for more than twice the width of the other two and
    // must actually have got it, not merely been recorded as wanting it.
    const widthOf = (id: NodeId) => (next.nodes[id] as { frame: { width: number } }).frame.width;
    expect(widthOf(ids[0]!)).toBeGreaterThan(widthOf(ids[1]!) * 1.5);
  });

  it('leaves no panel carrying a slot from an arrangement that no longer exists', () => {
    /*
     * A smart arrangement is not a template grid — every band divides the width
     * on its own, which no single `GridSpec` describes. A slot left behind
     * would be replayed against the next plain auto-layout's own grid and
     * silently reinterpret itself, which is how an imported panel once landed
     * on top of an existing one.
     */
    const { doc, ids } = buildDoc();
    // Give every panel a stale slot first, so the assertion is that apply
    // *clears* them rather than that they merely happened to be absent.
    const seeded = editDocument(doc, (draft) => {
      for (const id of ids) {
        const panel = draft.nodes[id];
        if (panel?.type === 'panel') panel.slot = { row: 0, col: 0, colSpan: 2 };
      }
    });

    const result = solveSmartLayout(input(ids.map((id) => demand(id))));
    const next = editDocument(seeded, (draft) => {
      expect(applySmartLayout(draft, result.candidates[0]!)).toBe(true);
    });

    for (const id of ids) {
      expect((next.nodes[id] as { slot?: unknown }).slot).toBeNull();
    }
  });

  it('refuses rather than transposing the figure when the panel order moved', () => {
    const { doc, ids } = buildDoc();
    const result = solveSmartLayout(input([demand(ids[0]!), demand(ids[1]!), demand(ids[2]!)]));
    const candidate = { ...result.candidates[0]!, order: [ids[2]!, ids[1]!, ids[0]!] };

    let applied = true;
    const next = editDocument(doc, (draft) => {
      applied = applySmartLayout(draft, candidate);
    });
    expect(applied).toBe(false);
    expect(next.page.heightMm).toBe(120);
  });
});

// ---------------------------------------------------------------------------

describe('band refinement, through the solver', () => {
  /**
   * The reported figure in miniature: a wide micrograph montage beside a bar
   * chart. `aspectFromContent` is what makes the solver treat the aspect as its
   * own to write, which is the montage case rather than an author-set lock.
   */
  const reported = (): PanelDemand[] => [
    demand('a', { comfortWidthMm: 45, comfortHeightMm: 42, minWidthMm: 30, minHeightMm: 28 }),
    demand('b', {
      kind: 'montage',
      aspect: 4.4,
      aspectFromContent: true,
      minWidthMm: 20,
      minHeightMm: 5,
      comfortWidthMm: 177,
      comfortHeightMm: 40.2,
      priority: 0.9,
    }),
    demand('c'),
    demand('d'),
  ];

  it('either aligns the picture with its neighbour or gives it a band of its own', () => {
    /*
     * Stated as that disjunction on purpose, because measurement shows the
     * first is sometimes unreachable: to match a 42 mm plot a 4.4:1 montage
     * needs 185 mm of width, and the plot is already at its own minimum. Where
     * the width lever runs out, the answer the design intends is the *other*
     * one — an arrangement that does not pair them at all.
     *
     * A regression guard on the delivered figure, not a test of `bandWaste`:
     * on these demands the winning shape is four points clear and the term is
     * worth about one, so it is not what decides this particular solve. The
     * term itself is pinned where it can be isolated, by the two frame maps in
     * 'tells a flush row from a ragged one' above.
     */
    const best = solveSmartLayout(input(reported())).candidates[0]!;
    const montage = best.frames.get('b')!;

    const sameRow = [...best.frames.entries()].filter(
      ([id, f]) => id !== 'b' && Math.abs(f.y - montage.y) <= 5,
    );
    const worst = Math.max(
      0,
      ...sameRow.map(([, f]) => f.y + f.height - (montage.y + montage.height)),
    );
    expect(sameRow.length === 0 || worst <= 1.5).toBe(true);
  });

  it('does not shrink a page of plain plots into a strip', () => {
    /*
     * Clamping every band to its want now happens on every path, not only when
     * a short page was enumerated — so `COMFORT_PLOT_HEIGHT_MM` is the only
     * thing standing between the solver and the failure `panel-demand.ts`
     * records: "the solver promptly drove a two-plot figure's page down to a
     * 36 mm-tall strip and scored it 99".
     */
    const best = solveSmartLayout(input([demand('a'), demand('b')])).candidates[0]!;
    for (const frame of best.frames.values()) {
      expect(frame.height).toBeGreaterThanOrEqual(demand('a').comfortHeightMm - 1e-6);
    }
  });

  it('keeps an aligned figure on offer even though it now scores raggeder', () => {
    /*
     * Sharing one width division across bands is exactly what leaves a row
     * ragged, so aligned candidates lose ground on `bandWaste` — honestly. They
     * need their own bucket in the offered list, or the plain variant takes the
     * slot on a point of score and a shipped option quietly disappears.
     */
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const result = solveSmartLayout(input(ids.map((id) => demand(id))));
    expect(result.candidates.some((c) => c.arrangement.aligned)).toBe(true);
  });

  it('offers no two candidates that are the same figure at the same page', () => {
    /*
     * Two enumerated heights can now realise as one page, and `id` is the key
     * the offered list renders on.
     */
    const result = solveSmartLayout(input([demand('a'), demand('b'), demand('c'), demand('d')]));
    const ids = result.candidates.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
