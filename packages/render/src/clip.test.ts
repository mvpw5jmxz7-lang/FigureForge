import { describe, expect, it } from 'vitest';

import { clipPolylineToRect } from './clip.js';

const W = 100;
const H = 50;

describe('clipPolylineToRect', () => {
  it('returns a wholly-inside polyline untouched, as one run', () => {
    const points = [
      { x: 10, y: 10 },
      { x: 40, y: 25 },
      { x: 80, y: 5 },
    ];
    expect(clipPolylineToRect(points, W, H)).toEqual([points]);
  });

  it('returns nothing for a polyline entirely outside', () => {
    const points = [
      { x: -50, y: 10 },
      { x: -20, y: 25 },
    ];
    expect(clipPolylineToRect(points, W, H)).toEqual([]);
  });

  it('ends exactly on the boundary rather than at the last inside vertex', () => {
    // Horizontal, leaving through the right edge halfway along the second
    // segment. Truncating would end at x=80; interpolating ends at x=100.
    const runs = clipPolylineToRect(
      [
        { x: 80, y: 20 },
        { x: 120, y: 20 },
      ],
      W,
      H,
    );
    expect(runs).toEqual([
      [
        { x: 80, y: 20 },
        { x: 100, y: 20 },
      ],
    ]);
  });

  it('interpolates y at the crossing, not just x', () => {
    // From (0,0) heading down-right at 45 degrees: it leaves through the
    // bottom edge (y = 50) at x = 50, well before the right edge.
    const runs = clipPolylineToRect(
      [
        { x: 0, y: 0 },
        { x: 200, y: 200 },
      ],
      W,
      H,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ]);
  });

  it('clips both ends of a segment that crosses the box entirely', () => {
    const runs = clipPolylineToRect(
      [
        { x: -20, y: 25 },
        { x: 120, y: 25 },
      ],
      W,
      H,
    );
    expect(runs).toEqual([
      [
        { x: 0, y: 25 },
        { x: 100, y: 25 },
      ],
    ]);
  });

  it('yields two runs when the line leaves and re-enters, never one chord', () => {
    // Out through the top, back in again. Joining the survivors would draw a
    // straight chord across the panel the data never took.
    const runs = clipPolylineToRect(
      [
        { x: 10, y: 10 },
        { x: 30, y: -30 },
        { x: 70, y: -30 },
        { x: 90, y: 10 },
      ],
      W,
      H,
    );
    expect(runs).toHaveLength(2);
    // Each run ends on the boundary it left through / entered from.
    expect(runs[0]![0]).toEqual({ x: 10, y: 10 });
    expect(runs[0]![runs[0]!.length - 1]!.y).toBeCloseTo(0, 10);
    expect(runs[1]![0]!.y).toBeCloseTo(0, 10);
    expect(runs[1]![runs[1]!.length - 1]).toEqual({ x: 90, y: 10 });
  });

  it('draws nothing for a single point or an empty list', () => {
    expect(clipPolylineToRect([{ x: 10, y: 10 }], W, H)).toEqual([]);
    expect(clipPolylineToRect([], W, H)).toEqual([]);
  });

  it('drops a degenerate zero-length segment outside and keeps one inside', () => {
    expect(
      clipPolylineToRect(
        [
          { x: -5, y: -5 },
          { x: -5, y: -5 },
        ],
        W,
        H,
      ),
    ).toEqual([]);
    expect(
      clipPolylineToRect(
        [
          { x: 5, y: 5 },
          { x: 5, y: 5 },
        ],
        W,
        H,
      ),
    ).toHaveLength(1);
  });

  it('keeps every returned coordinate within the box', () => {
    const points = Array.from({ length: 40 }, (_, i) => ({
      x: -20 + i * 4,
      y: 60 * Math.sin(i / 3),
    }));
    for (const run of clipPolylineToRect(points, W, H)) {
      for (const p of run) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(W);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(H);
      }
    }
  });
});
