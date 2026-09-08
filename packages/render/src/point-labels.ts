/**
 * Placement for drawn point identities — a handful of gene names on a
 * volcano plot, called out beside their points.
 *
 * Pure, deterministic and DOM-free, like everything else in this package: the
 * canvas and the headless exporter must reach the identical layout from the
 * identical input. It computes numbers only — `render-document.ts` is what
 * turns a `PlacedLabel` into scene nodes.
 *
 * The only import is `text-width.ts`'s static metrics, so this stays within
 * the same DOM-free discipline that measures every other label in this
 * package. Complexity is bounded by the number of LABELS (at most
 * `MAX_POINT_LABEL_CEILING`), never by the number of points a plot carries: a
 * real gene list is 10,000+ rows, and this module never iterates it — the
 * caller has already reduced that to the set of points asked to be labelled
 * before calling in here.
 */

import { estimateTextHeightMm, estimateTextWidthMm } from './text-width.js';

/** How many points a plot labels when its author has not said otherwise.
 *
 *  A default, not a limit, since round 46: `PlotNode.pointLabelLimit` raises
 *  it per plot. See `nodes.ts`'s `PlotNode.volcanoLabels` doc comment for why
 *  neither number is a schema limit. */
export const MAX_POINT_LABELS = 25;

/**
 * The most a plot may be asked to label, however high its own limit is set.
 *
 * This exists for render cost, not taste — the readability argument is what
 * makes 25 a sensible *default*, but it is the author's call, and a figure
 * naming an entire regulated pathway is legitimate. What is not the author's
 * call is making the canvas unresponsive, so the override is clamped here.
 *
 * MEASURED, not chosen — `scripts/point-label-cost.ts`, a 10,000-row gene list
 * on an 80x60 mm plot. The budget is ~100 ms, the same interactivity threshold
 * `MAX_VECTOR_POINTS` was measured against, and it is spent roughly *twice*
 * per interaction frame: `Canvas.tsx` renders the document unmemoised, and
 * `placedPointLabelsForPlot` resolves the same placement again for drag
 * hit-testing.
 *
 *     labels   engine   end to end   drawn
 *        100     12.9         15.8      32
 *        200     25.0         37.7      43
 *        400     67.9         36.6      60
 *        600    118.6         38.2      60
 *
 * "engine" is `layoutPointLabels` handed the *whole* cloud as obstacles;
 * "end to end" is the real path, where `resolvePointLabels` first filters the
 * cloud to a box around the candidates. The engine column is the number this
 * ceiling rests on, because that filter stops helping exactly when an author
 * labels points spread across the whole plot — which is the case that has to
 * survive. At 200 that is ~25 ms, so ~50 ms a frame, with real headroom; at
 * 400 it is ~68 ms, so ~136 ms, and a drag would visibly stutter.
 *
 * The second column of the argument is that a higher ceiling buys nothing:
 * `drawn` saturates at 60 by 300 labels and does not move again through 1200.
 * Past a few hundred names a plot is simply full, and further labels cost time
 * to reject and draw nothing.
 */
export const MAX_POINT_LABEL_CEILING = 200;

/** Gap between a marker's own edge and an adjacent label. */
const GAP_MM = 0.6;
/** Inflation applied to an already-placed label when testing a new one against it. */
const PAD_MM = 0.3;
/** Inset from the plot bounds a label may not cross. */
const EDGE_MM = 0.2;
/** Distance added per push-out step, beyond the adjacent-placement ring. */
const PUSH_STEP_MM = 1.5;
/** How many push-out rings are tried before a label is given up on. */
const PUSH_STEPS = 8;
/** Default ceiling on how far a label may be pushed from its point. */
const DEFAULT_MAX_PUSH_MM = 12;

export interface LabelCandidate {
  /** Plot-area-local millimetres — the same space `PointGeometry.x/y` use. */
  x: number;
  y: number;
  text: string;
  color: string;
}

export interface PlacedLabel {
  text: string;
  color: string;
  /** Text anchor position, plot-area-local mm. */
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
  /** A dotted leader from the point to the label, or null when adjacent. */
  leader: { x1: number; y1: number; x2: number; y2: number } | null;
  /** The bounding box actually reserved for this label, plot-area-local mm —
   *  exactly the rect collision was checked against. Exposed so a caller
   *  doing hit-testing (dragging) never re-derives text metrics. */
  rect: { x0: number; x1: number; y0: number; y1: number };
}

export interface LabelLayoutOptions {
  fontSizePt: number;
  plotWidth: number;
  plotHeight: number;
  /** Marker radius, so a label never sits on top of its own point. */
  pointRadiusMm: number;
  /** Default `MAX_POINT_LABELS`. */
  maxLabels?: number;
  /** Default `DEFAULT_MAX_PUSH_MM`, further clamped to a share of the plot. */
  maxPushMm?: number;
  /**
   * Extra marker positions to treat as obstacles that are not themselves
   * label candidates — every other point on the same plot, so a label never
   * lands on top of a point it isn't naming. Additive: default `[]` keeps
   * every existing call byte-identical. The caller is expected to have
   * already reduced this to points near the candidates (this module's own
   * complexity is bounded by the number of labels, never by plot size, and
   * an unfiltered gene list would break that).
   */
  otherPointsMm?: readonly { x: number; y: number }[];
}

/** Exported alongside `nearestRectPoint`/`PlacedLabel.rect`, which use this
 *  shape in their public signatures. */
export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

function inflate(r: Rect, pad: number): Rect {
  return { x0: r.x0 - pad, x1: r.x1 + pad, y0: r.y0 - pad, y1: r.y1 + pad };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1;
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** Proper segment/segment intersection (shared endpoints don't count — the
 *  leaders this module draws never legitimately touch a label's own edge). */
function segmentsIntersect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  x4: number,
  y4: number,
): boolean {
  const d1 = cross(x4 - x3, y4 - y3, x1 - x3, y1 - y3);
  const d2 = cross(x4 - x3, y4 - y3, x2 - x3, y2 - y3);
  const d3 = cross(x2 - x1, y2 - y1, x3 - x1, y3 - y1);
  const d4 = cross(x2 - x1, y2 - y1, x4 - x1, y4 - y1);
  return (d1 > 0 !== d2 > 0) && (d1 !== 0 && d2 !== 0) && (d3 > 0 !== d4 > 0) && (d3 !== 0 && d4 !== 0);
}

function segmentIntersectsRect(x1: number, y1: number, x2: number, y2: number, r: Rect): boolean {
  if (pointInRect(x1, y1, r) || pointInRect(x2, y2, r)) return true;
  const edges: readonly [number, number, number, number][] = [
    [r.x0, r.y0, r.x1, r.y0],
    [r.x1, r.y0, r.x1, r.y1],
    [r.x1, r.y1, r.x0, r.y1],
    [r.x0, r.y1, r.x0, r.y0],
  ];
  return edges.some(([ex1, ey1, ex2, ey2]) => segmentsIntersect(x1, y1, x2, y2, ex1, ey1, ex2, ey2));
}

/** Exported so a caller resolving a manually-dragged label (`render-document.ts`)
 *  can recompute its leader against the same geometry, rather than
 *  reimplementing "nearest point on a rect" a second time. */
export function nearestRectPoint(r: Rect, px: number, py: number): { x: number; y: number } {
  return { x: Math.max(r.x0, Math.min(px, r.x1)), y: Math.max(r.y0, Math.min(py, r.y1)) };
}

function unitTowards(fromX: number, fromY: number, toX: number, toY: number): { x: number; y: number } {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

type Direction = 'E' | 'W' | 'N' | 'S' | 'NE' | 'NW' | 'SE' | 'SW';

/**
 * Fixed trial order: E/W first — horizontal beside the point reads best and
 * costs the least vertical room — then the diagonals, then N/S last, which
 * cost a full label height of clearance either way.
 */
const DIRECTIONS: readonly Direction[] = ['E', 'W', 'NE', 'NW', 'SE', 'SW', 'N', 'S'];
const DIAG = Math.SQRT1_2;

interface Placement {
  rect: Rect;
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}

/** Every case anchors so the label reads *away* from the point, and is drawn
 *  through `dominant-baseline: central`, so a rect centred on `y` matches
 *  what the renderer actually paints. */
function placementFor(dir: Direction, px: number, py: number, d: number, w: number, h: number): Placement {
  switch (dir) {
    case 'E': {
      const x = px + d;
      return { rect: { x0: x, x1: x + w, y0: py - h / 2, y1: py + h / 2 }, x, y: py, anchor: 'start' };
    }
    case 'W': {
      const x = px - d;
      return { rect: { x0: x - w, x1: x, y0: py - h / 2, y1: py + h / 2 }, x, y: py, anchor: 'end' };
    }
    case 'N': {
      const y = py - d;
      return { rect: { x0: px - w / 2, x1: px + w / 2, y0: y - h / 2, y1: y + h / 2 }, x: px, y, anchor: 'middle' };
    }
    case 'S': {
      const y = py + d;
      return { rect: { x0: px - w / 2, x1: px + w / 2, y0: y - h / 2, y1: y + h / 2 }, x: px, y, anchor: 'middle' };
    }
    case 'NE': {
      const x = px + d * DIAG;
      const y = py - d * DIAG;
      return { rect: { x0: x, x1: x + w, y0: y - h / 2, y1: y + h / 2 }, x, y, anchor: 'start' };
    }
    case 'NW': {
      const x = px - d * DIAG;
      const y = py - d * DIAG;
      return { rect: { x0: x - w, x1: x, y0: y - h / 2, y1: y + h / 2 }, x, y, anchor: 'end' };
    }
    case 'SE': {
      const x = px + d * DIAG;
      const y = py + d * DIAG;
      return { rect: { x0: x, x1: x + w, y0: y - h / 2, y1: y + h / 2 }, x, y, anchor: 'start' };
    }
    case 'SW': {
      const x = px - d * DIAG;
      const y = py + d * DIAG;
      return { rect: { x0: x - w, x1: x, y0: y - h / 2, y1: y + h / 2 }, x, y, anchor: 'end' };
    }
  }
}

/**
 * Places as many candidates as fit without overlapping, in the order given.
 *
 * The caller decides that order — most significant first, typically — and
 * this function never re-sorts, so the ordering decision lives in exactly
 * one place. A push-out placement gets a dotted leader from the marker edge
 * to the label; an adjacent one gets none. A candidate that fits nowhere,
 * even pushed out to `maxPushMm`, is dropped into `unplaced` rather than
 * drawn overlapping something — an overprinted name is unreadable *and*
 * misattributable, strictly worse than absent.
 */
export function layoutPointLabels(
  candidates: readonly LabelCandidate[],
  options: LabelLayoutOptions,
): { placed: PlacedLabel[]; unplaced: LabelCandidate[] } {
  const maxLabels = options.maxLabels ?? MAX_POINT_LABELS;
  const truncated = candidates.slice(0, maxLabels);
  const { fontSizePt, plotWidth, plotHeight, pointRadiusMm } = options;
  const maxPushMm = Math.min(
    options.maxPushMm ?? DEFAULT_MAX_PUSH_MM,
    0.4 * Math.min(plotWidth, plotHeight),
  );

  const squareAt = (x: number, y: number): Rect => ({
    x0: x - pointRadiusMm,
    x1: x + pointRadiusMm,
    y0: y - pointRadiusMm,
    y1: y + pointRadiusMm,
  });

  // Every candidate's own marker is an obstacle for every label, not only for
  // its own — avoiding the general n-body "find empty space" problem is
  // exactly what the push-out ladder below is for instead. `otherPointsMm`
  // extends this to points that aren't being labelled at all, so a label
  // never lands on top of a point it isn't naming either.
  const markerSquares: Rect[] = [
    ...truncated.map((c) => squareAt(c.x, c.y)),
    ...(options.otherPointsMm ?? []).map((p) => squareAt(p.x, p.y)),
  ];

  const placed: PlacedLabel[] = [];
  const placedRects: Rect[] = [];
  const leaders: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const unplaced: LabelCandidate[] = [];

  const fits = (rect: Rect): boolean => {
    if (
      rect.x0 < EDGE_MM ||
      rect.x1 > plotWidth - EDGE_MM ||
      rect.y0 < EDGE_MM ||
      rect.y1 > plotHeight - EDGE_MM
    ) {
      return false;
    }
    if (placedRects.some((r) => rectsOverlap(rect, inflate(r, PAD_MM)))) return false;
    if (leaders.some((l) => segmentIntersectsRect(l.x1, l.y1, l.x2, l.y2, rect))) return false;
    if (markerSquares.some((m) => rectsOverlap(rect, m))) return false;
    return true;
  };

  // Distances tried past the adjacent ring: monotonically increasing,
  // deduplicated at the clamp, at most `PUSH_STEPS` entries — bounded and
  // independent of anything about the candidates themselves.
  const pushDistances: number[] = [];
  for (let step = 1; step <= PUSH_STEPS; step++) {
    const d = Math.min(pointRadiusMm + GAP_MM + step * PUSH_STEP_MM, maxPushMm);
    if (pushDistances[pushDistances.length - 1] !== d) pushDistances.push(d);
    if (d >= maxPushMm) break;
  }

  for (const candidate of truncated) {
    const w = estimateTextWidthMm(candidate.text, fontSizePt);
    const h = estimateTextHeightMm(fontSizePt);
    let found: (Placement & { leader: PlacedLabel['leader'] }) | null = null;

    const adjacentD = pointRadiusMm + GAP_MM;
    for (const dir of DIRECTIONS) {
      const p = placementFor(dir, candidate.x, candidate.y, adjacentD, w, h);
      if (fits(p.rect)) {
        found = { ...p, leader: null };
        break;
      }
    }

    if (!found) {
      outer: for (const d of pushDistances) {
        for (const dir of DIRECTIONS) {
          const p = placementFor(dir, candidate.x, candidate.y, d, w, h);
          if (!fits(p.rect)) continue;
          const edgePoint = nearestRectPoint(p.rect, candidate.x, candidate.y);
          const unit = unitTowards(candidate.x, candidate.y, edgePoint.x, edgePoint.y);
          found = {
            ...p,
            leader: {
              x1: candidate.x + unit.x * pointRadiusMm,
              y1: candidate.y + unit.y * pointRadiusMm,
              x2: edgePoint.x,
              y2: edgePoint.y,
            },
          };
          break outer;
        }
      }
    }

    if (!found) {
      unplaced.push(candidate);
      continue;
    }

    placed.push({
      text: candidate.text,
      color: candidate.color,
      x: found.x,
      y: found.y,
      anchor: found.anchor,
      leader: found.leader,
      rect: found.rect,
    });
    placedRects.push(found.rect);
    if (found.leader) leaders.push(found.leader);
  }

  return { placed, unplaced };
}
