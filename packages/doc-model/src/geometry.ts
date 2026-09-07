/** Geometry primitives. All coordinates are millimetres. */

export interface PointMm {
  x: number;
  y: number;
}

export interface SizeMm {
  width: number;
  height: number;
}

export interface RectMm extends PointMm, SizeMm {}

export const rect = (x: number, y: number, width: number, height: number): RectMm => ({
  x,
  y,
  width,
  height,
});

export const right = (r: RectMm): number => r.x + r.width;
export const bottom = (r: RectMm): number => r.y + r.height;
export const centerX = (r: RectMm): number => r.x + r.width / 2;
export const centerY = (r: RectMm): number => r.y + r.height / 2;

export const contains = (r: RectMm, p: PointMm): boolean =>
  p.x >= r.x && p.x <= right(r) && p.y >= r.y && p.y <= bottom(r);

export const intersects = (a: RectMm, b: RectMm): boolean =>
  a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y;

export function union(rects: readonly RectMm[]): RectMm | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, right(r));
    maxY = Math.max(maxY, bottom(r));
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Inset by per-side amounts (used for plot margins inside a panel). */
export interface InsetsMm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const insets = (top: number, r: number, b: number, left: number): InsetsMm => ({
  top,
  right: r,
  bottom: b,
  left,
});

export const uniformInsets = (v: number): InsetsMm => ({ top: v, right: v, bottom: v, left: v });

export function inset(r: RectMm, i: InsetsMm): RectMm {
  return {
    x: r.x + i.left,
    y: r.y + i.top,
    width: Math.max(0, r.width - i.left - i.right),
    height: Math.max(0, r.height - i.top - i.bottom),
  };
}

/**
 * Where content sits along one axis of a box it does not fill.
 *
 * Named for the SVG `preserveAspectRatio` alignments the renderer emits in
 * the uncropped case (`xMinYMin`/`xMidYMid`/`xMaxYMax`), so the stored value
 * and the attribute it becomes cannot drift apart in meaning.
 */
export type FitAlign = 'start' | 'middle' | 'end';

/** How much of the free space sits *ahead* of the content, for one axis. */
function alignOffset(free: number, align: FitAlign): number {
  if (align === 'start') return 0;
  if (align === 'end') return free;
  return free / 2;
}

/**
 * The shapes a panel can take: height is **affine** in width, not a ratio of
 * it.
 *
 * A montage's frame is its cells plus bands that do not scale with them —
 * gutters, padding, a group-label strip, a scale-bar strip. Only the cells
 * block has a true aspect; the bands are constant offsets. So
 *
 *   height(w) = fixedHeightMm + (w − fixedWidthMm) / contentAspect
 *
 * and the *panel*'s own width/height ratio is a different number at every
 * size. `montagePanelAspect` used to return one such number and the solver
 * locked panels to it: measured on a 1 × 3 montage of 4:3 tiles under one
 * group title (`fixedWidth` 2.00, `fixedHeight` 3.54), the panel's ratio runs
 * 2.5761 at a 5 mm cell to 3.7207 at 40 mm, and the 2.5761 it picked left
 * 21 mm of dead page under every picture at 175 mm of width.
 *
 * `contentAspect: null` is "fill the cell"; the fixed terms are then ignored,
 * so a free-height panel is exactly what it always was.
 */
export interface ShapeMm {
  readonly contentAspect: number | null;
  readonly fixedWidthMm: number;
  readonly fixedHeightMm: number;
}

/** A panel with no shape constraint at all. */
export const FREE_SHAPE: ShapeMm = {
  contentAspect: null,
  fixedWidthMm: 0,
  fixedHeightMm: 0,
};

/** A plain ratio as a shape: the degenerate case with no fixed bands. */
export const aspectShape = (aspect: number | null): ShapeMm => ({
  contentAspect: aspect,
  fixedWidthMm: 0,
  fixedHeightMm: 0,
});

/**
 * The height a shape implies at a given width — 0 for a free panel, so a
 * caller can `Math.max(minHeightMm, …)` unconditionally.
 */
export function heightForWidth(shape: ShapeMm, widthMm: number): number {
  if (!shape.contentAspect || shape.contentAspect <= 0) return 0;
  return shape.fixedHeightMm + Math.max(0, widthMm - shape.fixedWidthMm) / shape.contentAspect;
}

/**
 * The exact inverse of `heightForWidth` for any height at or above the bands.
 *
 * Below `fixedHeightMm` there is no width that produces that height — the
 * bands alone are already taller — so it clamps at `fixedWidthMm` and the
 * round trip overshoots. Callers relying on the round trip must know their
 * height is at least `fixedHeightMm`; `refineBandWidths` says why its is.
 */
export function widthForHeight(shape: ShapeMm, heightMm: number): number {
  if (!shape.contentAspect || shape.contentAspect <= 0) return 0;
  return shape.fixedWidthMm + Math.max(0, heightMm - shape.fixedHeightMm) * shape.contentAspect;
}

/**
 * Largest correctly-*shaped* rect inside `r`, placed by `alignX`/`alignY`.
 *
 * The generalisation of `fitAspectAligned`, which is now one case of it — with
 * both bands zero every expression below is the one it used to evaluate, so
 * the two cannot drift and no figure without bands moves.
 */
export function fitShape(
  r: RectMm,
  shape: ShapeMm,
  alignX: FitAlign,
  alignY: FitAlign,
): RectMm {
  if (!shape.contentAspect || shape.contentAspect <= 0) return r;
  let width = r.width;
  let height = heightForWidth(shape, width);
  if (height > r.height) {
    height = r.height;
    // Never wider than the rect: reached only when the rect is proportionally
    // wider than the shape, so the inverse is already inside it.
    width = Math.min(r.width, widthForHeight(shape, height));
  }
  return {
    x: r.x + alignOffset(r.width - width, alignX),
    y: r.y + alignOffset(r.height - height, alignY),
    width,
    height,
  };
}

/**
 * Largest rect of the given aspect ratio (w/h) that fits inside `r`, placed
 * by `alignX`/`alignY` rather than always centred.
 *
 * The single implementation of "where does a letterboxed image sit inside
 * its frame", read by the renderer *and* by the canvas's crop overlay. Two
 * copies of this arithmetic is precisely how round 6's crop bug happened —
 * the window outlined was not the region drawn.
 */
export function fitAspectAligned(
  r: RectMm,
  aspect: number,
  alignX: FitAlign,
  alignY: FitAlign,
): RectMm {
  return fitShape(r, aspectShape(aspect), alignX, alignY);
}

/** Largest rect of the given aspect ratio (w/h) that fits inside `r`, centred. */
export function fitAspect(r: RectMm, aspect: number): RectMm {
  return fitAspectAligned(r, aspect, 'middle', 'middle');
}

export const translate = (r: RectMm, dx: number, dy: number): RectMm => ({
  ...r,
  x: r.x + dx,
  y: r.y + dy,
});

/**
 * Rotate a point about a centre, clockwise, in degrees.
 *
 * Clockwise because that is what SVG's `rotate(a cx cy)` does in a y-down
 * coordinate system, and `NodeBase.rotation` is defined as the angle handed to
 * exactly that transform. Sharing the convention is what lets the canvas
 * compute where a rotated node's corner *appears* without re-deriving the
 * renderer's own maths in the opposite direction.
 */
export function rotatePoint(p: PointMm, centre: PointMm, deg: number): PointMm {
  if (deg === 0) return { x: p.x, y: p.y };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  return {
    x: centre.x + dx * cos - dy * sin,
    y: centre.y + dx * sin + dy * cos,
  };
}

/**
 * Move `point` onto the nearest ray of `stepDeg` from `anchor`, keeping how far
 * out it was dragged.
 *
 * The distance is preserved rather than projected onto the ray, because this
 * drives a live drag: projecting shortens the line as the cursor leaves the
 * snapped direction, so the arrow appears to shrink while the author is trying
 * to aim it. Keeping the radius means the cursor's distance is always honoured
 * and only its bearing is constrained.
 *
 * A zero-length drag has no direction to snap, so it is returned untouched
 * rather than being forced onto 0°.
 */
export function snapAngle(anchor: PointMm, point: PointMm, stepDeg = 45): PointMm {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0 || stepDeg <= 0) return { x: point.x, y: point.y };

  const step = (stepDeg * Math.PI) / 180;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: anchor.x + distance * Math.cos(snapped),
    y: anchor.y + distance * Math.sin(snapped),
  };
}

/** Snap a rotation in degrees to the nearest `stepDeg`, normalised to [0, 360). */
export function snapRotation(deg: number, stepDeg = 45): number {
  if (stepDeg <= 0) return deg;
  const snapped = Math.round(deg / stepDeg) * stepDeg;
  return ((snapped % 360) + 360) % 360;
}
