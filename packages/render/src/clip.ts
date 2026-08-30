/**
 * Clipping a polyline to the plot area.
 *
 * Pure, deterministic and DOM-free, like everything else in this package —
 * it takes millimetres already placed by a scale and returns millimetres, so
 * the canvas and the headless exporter reach the identical answer. It has no
 * imports at all.
 *
 * This exists for the Perseus-style volcano boundary, whose points are not
 * bounded by the data the axes were sized from: each one is a protein's own
 * boundary fold change at its own standard error, and as that error shrinks
 * the boundary p-value tends to zero, so `-log10(p)` runs off the top of any
 * axis resolved from the plotted points. Dropping the out-of-bounds vertices
 * would visibly shorten the curve and leave it stopping at whichever protein
 * happened to be last inside; interpolating the crossing makes it reach the
 * boundary exactly, which is what the axis is claiming to show.
 */

export interface PointMm {
  x: number;
  y: number;
}

/**
 * Clip a polyline to `[0, width] x [0, height]`, returning the runs that
 * survive.
 *
 * Several runs, not one: a curve may leave the box and come back, and joining
 * the two surviving pieces into a single path would draw a chord across the
 * panel that the data never took. Consecutive kept segments are merged, so an
 * entirely-inside polyline comes back as one run with its own vertices
 * untouched.
 *
 * Liang-Barsky per segment. A segment crossing an edge contributes the
 * interpolated crossing point, so an endpoint always lands *on* the boundary
 * rather than at the last vertex inside it.
 */
export function clipPolylineToRect(
  points: readonly PointMm[],
  width: number,
  height: number,
): PointMm[][] {
  const runs: PointMm[][] = [];
  let current: PointMm[] = [];

  const flush = (): void => {
    // A single point is not a line and draws nothing; dropping it here keeps
    // the caller from having to filter degenerate runs out again.
    if (current.length >= 2) runs.push(current);
    current = [];
  };

  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const segment = clipSegment(a, b, width, height);
    if (segment === null) {
      flush();
      continue;
    }
    const [from, to] = segment;
    // `from` continues the run only if it is where the previous segment
    // ended. A segment re-entering the box after one outside it starts a new
    // run instead, or the join would be that false chord.
    if (current.length > 0 && samePoint(current[current.length - 1]!, from)) {
      current.push(to);
    } else {
      flush();
      current = [from, to];
    }
  }
  flush();

  return runs;
}

/** Millimetre tolerance for "these two placed points are the same point". */
const EPSILON_MM = 1e-9;

function samePoint(a: PointMm, b: PointMm): boolean {
  return Math.abs(a.x - b.x) <= EPSILON_MM && Math.abs(a.y - b.y) <= EPSILON_MM;
}

/**
 * Liang-Barsky. Returns the visible portion of `a`->`b`, or null if the
 * segment misses the box entirely.
 *
 * A zero-length segment has no direction to clip along, so it is answered by
 * a containment test rather than by the parametric loop, which would divide
 * by zero on every axis.
 */
function clipSegment(
  a: PointMm,
  b: PointMm,
  width: number,
  height: number,
): [PointMm, PointMm] | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (dx === 0 && dy === 0) {
    return inside(a, width, height) ? [a, b] : null;
  }

  let t0 = 0;
  let t1 = 1;

  // p/q pairs for the four half-planes, in the order left, right, top, bottom.
  const tests: [number, number][] = [
    [-dx, a.x],
    [dx, width - a.x],
    [-dy, a.y],
    [dy, height - a.y],
  ];

  for (const [p, q] of tests) {
    if (p === 0) {
      // Parallel to this edge: outside it means the whole segment is out.
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  return [
    { x: a.x + t0 * dx, y: a.y + t0 * dy },
    { x: a.x + t1 * dx, y: a.y + t1 * dy },
  ];
}

function inside(p: PointMm, width: number, height: number): boolean {
  return p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height;
}
