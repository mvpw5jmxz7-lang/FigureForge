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

/** Largest rect of the given aspect ratio (w/h) that fits inside `r`, centred. */
export function fitAspect(r: RectMm, aspect: number): RectMm {
  if (aspect <= 0) return r;
  let width = r.width;
  let height = width / aspect;
  if (height > r.height) {
    height = r.height;
    width = height * aspect;
  }
  return {
    x: r.x + (r.width - width) / 2,
    y: r.y + (r.height - height) / 2,
    width,
    height,
  };
}

export const translate = (r: RectMm, dx: number, dy: number): RectMm => ({
  ...r,
  x: r.x + dx,
  y: r.y + dy,
});
