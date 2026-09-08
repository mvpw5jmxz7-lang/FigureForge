/**
 * Point-label placement.
 *
 * Pure geometry, no rendering — the goal here is the placement contract
 * itself: no two labels overlap, everything stays in bounds, a crowded
 * label gets pushed out with a leader, and an unplaceable one is dropped
 * rather than drawn on top of something.
 */

import { describe, expect, it } from 'vitest';
import {
  layoutPointLabels,
  MAX_POINT_LABELS,
  MAX_POINT_LABEL_CEILING,
  type LabelCandidate,
} from './point-labels.js';
import { estimateTextHeightMm, estimateTextWidthMm } from './text-width.js';

const OPTIONS = { fontSizePt: 6, plotWidth: 60, plotHeight: 50, pointRadiusMm: 0.45 };

function rectOf(label: { text: string; x: number; y: number; anchor: 'start' | 'middle' | 'end' }) {
  // Mirrors tickLabelNode's own metric: Helvetica-ish average advance is
  // close enough here since only relative comparisons matter.
  const w = label.text.length * 0.42 * 6 * (25.4 / 72); // rough width in mm
  const h = 6 * (25.4 / 72) * 0.928;
  const x0 = label.anchor === 'start' ? label.x : label.anchor === 'end' ? label.x - w : label.x - w / 2;
  return { x0, x1: x0 + w, y0: label.y - h / 2, y1: label.y + h / 2 };
}

function overlaps(a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

describe('layoutPointLabels', () => {
  it('places a single label adjacent to its point, with no leader', () => {
    const { placed, unplaced } = layoutPointLabels(
      [{ x: 30, y: 25, text: 'TP53', color: '#d73027' }],
      OPTIONS,
    );
    expect(unplaced).toEqual([]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.leader).toBeNull();
  });

  it('never overlaps two labels for two colliding points', () => {
    const candidates: LabelCandidate[] = [
      { x: 30, y: 25, text: 'Gene A', color: '#d73027' },
      { x: 30.5, y: 25.2, text: 'Gene B', color: '#4575b4' },
    ];
    const { placed, unplaced } = layoutPointLabels(candidates, OPTIONS);
    expect(unplaced).toEqual([]);
    expect(placed).toHaveLength(2);
    const [a, b] = placed.map(rectOf) as [ReturnType<typeof rectOf>, ReturnType<typeof rectOf>];
    expect(overlaps(a, b)).toBe(false);
  });

  it('never overlaps a dense ring of colliding points', () => {
    // Twelve points crammed inside a 4 mm circle — none of the eight adjacent
    // slots can work for most of them, so this exercises the push-out ladder.
    const candidates: LabelCandidate[] = Array.from({ length: 12 }, (_, i) => {
      const angle = (i / 12) * 2 * Math.PI;
      return {
        x: 30 + Math.cos(angle) * 2,
        y: 25 + Math.sin(angle) * 2,
        text: `Gene${i}`,
        color: '#000000',
      };
    });
    const { placed, unplaced } = layoutPointLabels(candidates, OPTIONS);
    expect(placed.length + unplaced.length).toBe(12);

    const rects = placed.map(rectOf);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it('gives a pushed-out label a dotted leader back to its point', () => {
    // Surround one point with decoys close enough that every adjacent slot
    // is blocked, forcing the real candidate out to a push-out ring.
    const target: LabelCandidate = { x: 30, y: 25, text: 'Crowded', color: '#000000' };
    const decoys: LabelCandidate[] = [
      { x: 31, y: 25, text: 'XXXXXXXXXX', color: '#000' },
      { x: 29, y: 25, text: 'XXXXXXXXXX', color: '#000' },
      { x: 30, y: 24, text: 'XXXXXXXXXX', color: '#000' },
      { x: 30, y: 26, text: 'XXXXXXXXXX', color: '#000' },
      { x: 30.7, y: 24.3, text: 'XXXXXXXXXX', color: '#000' },
      { x: 29.3, y: 24.3, text: 'XXXXXXXXXX', color: '#000' },
      { x: 30.7, y: 25.7, text: 'XXXXXXXXXX', color: '#000' },
      { x: 29.3, y: 25.7, text: 'XXXXXXXXXX', color: '#000' },
    ];
    const { placed } = layoutPointLabels([...decoys, target], OPTIONS);
    const own = placed.find((p) => p.text === 'Crowded');
    expect(own).toBeDefined();
    expect(own!.leader).not.toBeNull();

    // The leader stays within the configured push ceiling.
    const dx = own!.leader!.x1 - target.x;
    const dy = own!.leader!.y1 - target.y;
    expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(0.45 + 0.01);
    const dx2 = own!.leader!.x2 - target.x;
    const dy2 = own!.leader!.y2 - target.y;
    expect(Math.hypot(dx2, dy2)).toBeLessThanOrEqual(12 + 1e-6);
  });

  it('keeps every placed label within the plot bounds', () => {
    const candidates: LabelCandidate[] = [
      { x: 1, y: 1, text: 'CornerGeneWithALongName', color: '#000' },
      { x: 59, y: 49, text: 'AnotherLongCornerGene', color: '#000' },
    ];
    const { placed } = layoutPointLabels(candidates, OPTIONS);
    for (const label of placed) {
      const r = rectOf(label);
      expect(r.x0).toBeGreaterThanOrEqual(-0.01);
      expect(r.x1).toBeLessThanOrEqual(OPTIONS.plotWidth + 0.01);
      expect(r.y0).toBeGreaterThanOrEqual(-0.01);
      expect(r.y1).toBeLessThanOrEqual(OPTIONS.plotHeight + 0.01);
    }
  });

  it('drops an unplaceable label rather than drawing it over something', () => {
    // Pack far more colliding points into a tiny area than could ever fit —
    // some must end up unplaced rather than overlapping.
    const candidates: LabelCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      x: 30 + (i % 5) * 0.1,
      y: 25 + Math.floor(i / 5) * 0.1,
      text: `VeryLongGeneNameNumber${i}`,
      color: '#000',
    }));
    const { placed, unplaced } = layoutPointLabels(candidates, {
      ...OPTIONS,
      plotWidth: 15,
      plotHeight: 15,
    });
    expect(unplaced.length).toBeGreaterThan(0);
    const rects = placed.map(rectOf);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it('is deterministic: identical input produces identical output', () => {
    const candidates: LabelCandidate[] = Array.from({ length: 10 }, (_, i) => ({
      x: 10 + i * 4,
      y: 20 + (i % 3) * 3,
      text: `Gene${i}`,
      color: '#123456',
    }));
    const first = layoutPointLabels(candidates, OPTIONS);
    const second = layoutPointLabels(candidates, OPTIONS);
    expect(second).toEqual(first);
  });

  it('caps at MAX_POINT_LABELS, truncating rather than placing more', () => {
    const candidates: LabelCandidate[] = Array.from({ length: 26 }, (_, i) => ({
      x: 5 + (i % 13) * 4,
      y: 5 + Math.floor(i / 13) * 20,
      text: `Gene${i}`,
      color: '#000',
    }));
    expect(candidates).toHaveLength(26);
    const { placed, unplaced } = layoutPointLabels(candidates, OPTIONS);
    // The cap is applied before placement is attempted at all, so the 26th
    // candidate is truncated away — it is not merely one this dense layout
    // happened to reject for lack of room.
    expect(placed.length + unplaced.length).toBe(MAX_POINT_LABELS);
    expect(placed.some((p) => p.text === 'Gene25')).toBe(false);
    expect(unplaced.some((p) => p.text === 'Gene25')).toBe(false);
  });

  it('never touches a candidate past maxLabels, even one that would place trivially', () => {
    const candidates: LabelCandidate[] = [
      { x: 5, y: 5, text: 'A', color: '#000' },
      { x: 50, y: 45, text: 'B', color: '#000' },
    ];
    const { placed } = layoutPointLabels(candidates, { ...OPTIONS, maxLabels: 1 });
    expect(placed.map((p) => p.text)).toEqual(['A']);
  });

  it("exposes the rect placement was actually checked against", () => {
    const { placed } = layoutPointLabels([{ x: 30, y: 25, text: 'TP53', color: '#d73027' }], OPTIONS);
    // An unobstructed point places 'E' — adjacent, to the right of the point.
    const d = OPTIONS.pointRadiusMm + 0.6; // pointRadiusMm + GAP_MM
    const w = estimateTextWidthMm('TP53', OPTIONS.fontSizePt);
    const h = estimateTextHeightMm(OPTIONS.fontSizePt);
    expect(placed[0]!.rect.x0).toBeCloseTo(30 + d, 5);
    expect(placed[0]!.rect.x1).toBeCloseTo(30 + d + w, 5);
    expect(placed[0]!.rect.y0).toBeCloseTo(25 - h / 2, 5);
    expect(placed[0]!.rect.y1).toBeCloseTo(25 + h / 2, 5);
  });

  describe('otherPointsMm', () => {
    it('is byte-identical to every existing case when omitted', () => {
      const candidates: LabelCandidate[] = [
        { x: 30, y: 25, text: 'Gene A', color: '#d73027' },
        { x: 30.5, y: 25.2, text: 'Gene B', color: '#4575b4' },
      ];
      const withEmpty = layoutPointLabels(candidates, { ...OPTIONS, otherPointsMm: [] });
      const omitted = layoutPointLabels(candidates, OPTIONS);
      expect(withEmpty).toEqual(omitted);
    });

    it("pushes a label off an unlabelled point that isn't a candidate", () => {
      const candidate: LabelCandidate = { x: 30, y: 25, text: 'TP53', color: '#d73027' };
      // Occupies exactly the adjacent 'E' slot a lone candidate would
      // otherwise take (see the rect test above).
      const d = OPTIONS.pointRadiusMm + 0.6;
      const otherPointsMm = [{ x: 30 + d + 1, y: 25 }];

      const withObstacle = layoutPointLabels([candidate], { ...OPTIONS, otherPointsMm });
      const without = layoutPointLabels([candidate], OPTIONS);

      expect(without.placed[0]!.x).toBeCloseTo(30 + d, 5);
      // With the obstacle in the way, the label lands somewhere else — not
      // at the same anchor 'E' would have used.
      expect(withObstacle.placed[0]!.x).not.toBeCloseTo(30 + d, 1);
      expect(withObstacle.unplaced).toEqual([]);
    });

    it('drops a label that fits nowhere once unlabelled points are included, never overlapping one', () => {
      const plotWidth = 15;
      const plotHeight = 15;
      // A grid of obstacles spaced closer than 2*pointRadiusMm tiles the
      // entire plot solid, leaving no adjacent slot or push-out ring free.
      const spacing = 0.5;
      const otherPointsMm: { x: number; y: number }[] = [];
      for (let x = 0; x <= plotWidth; x += spacing) {
        for (let y = 0; y <= plotHeight; y += spacing) {
          otherPointsMm.push({ x, y });
        }
      }
      const candidate: LabelCandidate = { x: 7.5, y: 7.5, text: 'Crowded', color: '#000' };
      const { placed, unplaced } = layoutPointLabels([candidate], {
        ...OPTIONS,
        plotWidth,
        plotHeight,
        otherPointsMm,
      });
      expect(placed).toEqual([]);
      expect(unplaced).toEqual([candidate]);
    });
  });
});

describe('the label ceiling', () => {
  /** A plot roomy enough that placement, not collision, is what is under test. */
  const ROOMY = { fontSizePt: 6, plotWidth: 400, plotHeight: 300, pointRadiusMm: 0.45 };

  function grid(count: number): LabelCandidate[] {
    return Array.from({ length: count }, (_, i) => ({
      x: 6 + (i % 20) * 19,
      y: 6 + Math.floor(i / 20) * 19,
      text: `G${i}`,
      color: '#000',
    }));
  }

  it('places past MAX_POINT_LABELS when asked for more', () => {
    // The default is a default, not a limit — this is the whole point of
    // `PlotNode.pointLabelLimit`. Without a raised `maxLabels` the 26th
    // candidate is never even considered (see the cap test above).
    const candidates = grid(60);
    const { placed } = layoutPointLabels(candidates, { ...ROOMY, maxLabels: 60 });
    expect(placed.length).toBeGreaterThan(MAX_POINT_LABELS);
  });

  it('still truncates at whatever maxLabels says, above the default', () => {
    const candidates = grid(60);
    const { placed, unplaced } = layoutPointLabels(candidates, { ...ROOMY, maxLabels: 40 });
    expect(placed.length + unplaced.length).toBe(40);
    expect([...placed, ...unplaced].some((l) => l.text === 'G40')).toBe(false);
  });

  it('has a ceiling above the default, so the override is worth having', () => {
    expect(MAX_POINT_LABEL_CEILING).toBeGreaterThan(MAX_POINT_LABELS);
  });
});
