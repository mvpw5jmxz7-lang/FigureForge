/**
 * Panel layout: the auto-arrangement engine and the snapping rules.
 *
 * Auto Layout solves a rows × columns grid with uniform gutters that fills the
 * page, honouring any per-panel aspect-ratio lock. Manual Layout leaves frames
 * alone and only supplies snap targets. Both produce plain frames, so switching
 * between them never destroys work.
 */

import type { PointMm, RectMm } from './geometry.js';
import {
  fitAspectAligned,
  right,
  bottom,
  centerX,
  centerY,
  rotatePoint,
  snapAngle,
} from './geometry.js';
import type { FigureNode, NodeId, NodeMap } from './nodes.js';

export interface GridSpec {
  rows: number;
  columns: number;
  /**
   * Relative widths of the columns / heights of the rows. Absent means equal,
   * which is what every grid was before templates existed — so the unweighted
   * path must keep producing byte-identical frames.
   */
  columnWeights?: readonly number[];
  rowWeights?: readonly number[];
}

/** Where a panel sits in a template's grid, and how many cells it covers. */
export interface GridSlot {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
}

export interface LayoutOptions {
  pageWidthMm: number;
  pageHeightMm: number;
  marginMm: number;
  gutterMm: number;
  /** Extra left inset per panel for its label, so labels never overlap axes. */
  labelGutterMm?: number;
  /**
   * Extra clearance at specific column/row boundaries, on top of the uniform
   * `gutterMm` — the room a group-label heading needs. Indexed by boundary,
   * not track: index 0 is *before* the first column/row, index `columns`/
   * `rows` is *after* the last, so a heading over the very first or very
   * last row/column still has a boundary to grow. Absent, or a boundary past
   * the array's length, means 0 — additive, so every caller that never sets
   * these produces byte-identical frames to before this existed.
   */
  columnGutterExtraMm?: readonly number[];
  rowGutterExtraMm?: readonly number[];
}

/**
 * Choose a near-square grid for n panels, biased to landscape because journal
 * columns are wider than they are tall.
 */
export function suggestGrid(panelCount: number): GridSpec {
  if (panelCount <= 0) return { rows: 0, columns: 0 };
  if (panelCount <= 3) return { rows: 1, columns: panelCount };
  const columns = Math.ceil(Math.sqrt(panelCount));
  const rows = Math.ceil(panelCount / columns);
  return { rows, columns };
}

/**
 * Sizes along one axis, divided by weight. Equal weights give the same result
 * as dividing evenly, so the unweighted path is unchanged.
 */
function tracks(count: number, total: number, weights: readonly number[] | undefined): number[] {
  if (count <= 0) return [];
  const usable = Math.max(0, total);

  const valid =
    weights !== undefined &&
    weights.length === count &&
    weights.every((w) => Number.isFinite(w) && w > 0);
  if (!valid) return Array.from({ length: count }, () => usable / count);

  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (usable * w) / sum);
}

/** Sum of a boundary-extras array over boundaries 0..count inclusive. */
function extraSum(extra: readonly number[] | undefined, count: number): number {
  if (!extra) return 0;
  let sum = 0;
  for (let i = 0; i <= count; i++) sum += extra[i] ?? 0;
  return sum;
}

/**
 * Start offset of each track, given the sizes, the uniform gutter between
 * them, and any per-boundary extra clearance (index 0 before the first
 * track, index `sizes.length` after the last).
 */
function offsets(
  sizes: readonly number[],
  start: number,
  gutterMm: number,
  extra?: readonly number[],
): number[] {
  const out: number[] = [];
  let cursor = start + (extra?.[0] ?? 0);
  for (let i = 0; i < sizes.length; i++) {
    out.push(cursor);
    cursor += sizes[i]! + gutterMm + (extra?.[i + 1] ?? 0);
  }
  return out;
}

/**
 * Divide the page into cells. Returns one rect per grid slot, in row-major
 * order; callers take as many as they have panels.
 *
 * With `columnWeights`/`rowWeights` the tracks are proportional instead of
 * equal, which is what lets one panel take two thirds of a row.
 */
export function gridCells(spec: GridSpec, options: LayoutOptions): RectMm[] {
  const { rows, columns } = spec;
  if (rows <= 0 || columns <= 0) return [];

  const { pageWidthMm, pageHeightMm, marginMm, gutterMm } = options;
  const columnExtra = options.columnGutterExtraMm;
  const rowExtra = options.rowGutterExtraMm;

  const usableWidth =
    pageWidthMm - 2 * marginMm - gutterMm * (columns - 1) - extraSum(columnExtra, columns);
  const usableHeight =
    pageHeightMm - 2 * marginMm - gutterMm * (rows - 1) - extraSum(rowExtra, rows);

  const widths = tracks(columns, usableWidth, spec.columnWeights);
  const heights = tracks(rows, usableHeight, spec.rowWeights);
  const xs = offsets(widths, marginMm, gutterMm, columnExtra);
  const ys = offsets(heights, marginMm, gutterMm, rowExtra);

  const cells: RectMm[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      cells.push({
        x: xs[c]!,
        y: ys[r]!,
        width: Math.max(0, widths[c]!),
        height: Math.max(0, heights[r]!),
      });
    }
  }
  return cells;
}

/**
 * The rect covering a span of cells, gutters included.
 *
 * A panel spanning two columns occupies both cells *and* the gutter between
 * them; leaving the gutter out would draw it narrower than the space it owns.
 */
export function spanCell(spec: GridSpec, slot: GridSlot, options: LayoutOptions): RectMm | null {
  const cells = gridCells(spec, options);
  if (cells.length === 0) return null;

  const colSpan = Math.max(1, slot.colSpan ?? 1);
  const rowSpan = Math.max(1, slot.rowSpan ?? 1);

  const first = cells[slot.row * spec.columns + slot.col];
  const lastCol = Math.min(spec.columns - 1, slot.col + colSpan - 1);
  const lastRow = Math.min(spec.rows - 1, slot.row + rowSpan - 1);
  const last = cells[lastRow * spec.columns + lastCol];
  if (!first || !last) return null;

  return {
    x: first.x,
    y: first.y,
    width: Math.max(0, right(last) - first.x),
    height: Math.max(0, bottom(last) - first.y),
  };
}

export interface PanelLayoutInput {
  id: NodeId;
  /** Width/height the panel must keep, or null to fill its cell. */
  aspectLock: number | null;
  /** Explicit grid placement. Absent means "next cell in reading order". */
  slot?: GridSlot | null;
}

/**
 * Assign frames to panels. A panel with an aspect lock takes the largest rect
 * of that shape that fits its cell, against the cell's **top-left corner**;
 * unlocked panels fill the cell outright.
 *
 * Top-left rather than centred, which is what this did until a figure actually
 * contained an aspect-locked panel. Two things were wrong with centring, and
 * the first is not cosmetic:
 *
 *   - `readingOrder` bands rows with a 5 mm tolerance on `frame.y`. A wide
 *     montage centred in a square cell sits ~22 mm below the cell's top, so it
 *     sorted as though it were on the next row down and `relabelPanels` gave it
 *     the wrong letter — a figure whose legend then describes the wrong panel.
 *   - A panel's letter is placed at `frame.x - offset`, so a horizontally
 *     centred panel leaves its letter floating in the middle of the page
 *     instead of at the column edge.
 *
 * It is also the convention the published figures follow, and the one round 33
 * already chose for the tiles *inside* a montage: a row of differently
 * proportioned micrographs lines up along its top edge.
 */
export function autoLayout(
  panels: readonly PanelLayoutInput[],
  spec: GridSpec,
  options: LayoutOptions,
): Map<NodeId, RectMm> {
  const cells = gridCells(spec, options);
  const frames = new Map<NodeId, RectMm>();
  const labelGutter = options.labelGutterMm ?? 0;

  panels.forEach((panel, index) => {
    const cell = panel.slot ? spanCell(spec, panel.slot, options) : cells[index];
    if (!cell) return;

    const inner: RectMm = {
      x: cell.x + labelGutter,
      y: cell.y,
      width: Math.max(0, cell.width - labelGutter),
      height: cell.height,
    };

    frames.set(
      panel.id,
      panel.aspectLock ? fitAspectAligned(inner, panel.aspectLock, 'start', 'start') : inner,
    );
  });

  return frames;
}

/** Uniform gutters between adjacent panels, as the checker measures them. */
export function measureGutters(frames: readonly RectMm[]): {
  horizontal: number[];
  vertical: number[];
} {
  const horizontal: number[] = [];
  const vertical: number[] = [];

  const sortedByX = [...frames].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sortedByX.length; i++) {
    const prev = sortedByX[i - 1]!;
    const cur = sortedByX[i]!;
    // Only count pairs that actually sit side by side.
    const overlapsVertically = cur.y < bottom(prev) && bottom(cur) > prev.y;
    if (overlapsVertically) horizontal.push(cur.x - right(prev));
  }

  const sortedByY = [...frames].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sortedByY.length; i++) {
    const prev = sortedByY[i - 1]!;
    const cur = sortedByY[i]!;
    const overlapsHorizontally = cur.x < right(prev) && right(cur) > prev.x;
    if (overlapsHorizontally) vertical.push(cur.y - bottom(prev));
  }

  return { horizontal, vertical };
}

// ---------------------------------------------------------------------------
// Snapping and alignment guides
// ---------------------------------------------------------------------------

export type GuideAxis = 'x' | 'y';

export interface AlignmentGuide {
  axis: GuideAxis;
  /** Page-space position of the guide line. */
  position: number;
  /** Which nodes generated it, for highlighting. */
  sourceIds: NodeId[];
  kind: 'edge' | 'center' | 'page';
}

/** Candidate snap positions contributed by one rect. */
function candidatesFor(frame: RectMm, axis: GuideAxis): { value: number; kind: 'edge' | 'center' }[] {
  return axis === 'x'
    ? [
        { value: frame.x, kind: 'edge' },
        { value: centerX(frame), kind: 'center' },
        { value: right(frame), kind: 'edge' },
      ]
    : [
        { value: frame.y, kind: 'edge' },
        { value: centerY(frame), kind: 'center' },
        { value: bottom(frame), kind: 'edge' },
      ];
}

export interface SnapResult {
  /** Adjusted frame after snapping. */
  frame: RectMm;
  guides: AlignmentGuide[];
}

export interface SnapContext {
  /** Frames to align against — normally the moving node's siblings. */
  others: { id: NodeId; frame: RectMm }[];
  pageWidthMm: number;
  pageHeightMm: number;
  gridSpacingMm: number;
  snapToGrid: boolean;
  smartGuides: boolean;
  toleranceMm: number;
}

/**
 * Snap a dragged frame. Smart guides take precedence over the grid: aligning
 * with a neighbouring panel matters more than landing on a round number, and
 * applying both would fight each other.
 */
export function snapFrame(frame: RectMm, context: SnapContext): SnapResult {
  const guides: AlignmentGuide[] = [];
  let { x, y } = frame;

  const snapAxis = (axis: GuideAxis): number | null => {
    if (!context.smartGuides) return null;

    const moving = candidatesFor({ ...frame, x, y }, axis);
    const pageEdges =
      axis === 'x'
        ? [0, context.pageWidthMm / 2, context.pageWidthMm]
        : [0, context.pageHeightMm / 2, context.pageHeightMm];

    let best: { delta: number; guide: AlignmentGuide } | null = null;

    const consider = (target: number, sourceIds: NodeId[], kind: AlignmentGuide['kind']): void => {
      for (const candidate of moving) {
        const delta = target - candidate.value;
        if (Math.abs(delta) > context.toleranceMm) continue;
        if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
          best = { delta, guide: { axis, position: target, sourceIds, kind } };
        }
      }
    };

    for (const other of context.others) {
      for (const candidate of candidatesFor(other.frame, axis)) {
        consider(candidate.value, [other.id], candidate.kind);
      }
    }
    for (const edge of pageEdges) consider(edge, [], 'page');

    if (best === null) return null;
    const resolved = best as { delta: number; guide: AlignmentGuide };
    guides.push(resolved.guide);
    return resolved.delta;
  };

  const dx = snapAxis('x');
  const dy = snapAxis('y');

  if (dx !== null) x += dx;
  else if (context.snapToGrid) x = Math.round(x / context.gridSpacingMm) * context.gridSpacingMm;

  if (dy !== null) y += dy;
  else if (context.snapToGrid) y = Math.round(y / context.gridSpacingMm) * context.gridSpacingMm;

  return { frame: { ...frame, x, y }, guides };
}

// ---------------------------------------------------------------------------
// Interactive resize
// ---------------------------------------------------------------------------

/** Which grab handle a resize drag started from. */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface ResizeOptions {
  /** Width/height the panel must keep, or null to resize freely. */
  aspectLock?: number | null;
  /**
   * Snap the frame's own diagonal angle to the nearest 45° step instead of
   * enforcing `aspectLock`. Built for `shape: 'line'`, whose rendered angle
   * *is* its frame's aspect ratio (`renderShape` draws it corner-to-corner)
   * — mirrors the arrow endpoint drag's own `snapAngle` use (`Canvas.tsx`),
   * just applied to a frame's width/height instead of a point.
   */
  angleSnap?: boolean;
  /** Floor on either dimension, so a panel cannot be dragged to nothing. */
  minMm?: number;
  /**
   * Per-axis floor, overriding `minMm` on that axis only. Absent means
   * "use `minMm`" — additive, so every existing caller is unaffected.
   *
   * A tiled panel's own children need more than the generic 5 mm floor: once
   * the panel is smaller than its grid needs, a cell collapses toward 0×0 and
   * that tile's resize handles collapse to an ungrabbable point. The caller
   * (`Canvas.tsx`) computes the grid's own minimum and passes it here rather
   * than this function knowing anything about `contentGrid` — `resizeFrame`
   * stays pure geometry either way.
   */
  minWidthMm?: number;
  minHeightMm?: number;
  /**
   * The node's own `rotation`, in degrees clockwise about its frame centre.
   *
   * Absent or `0` leaves every line of arithmetic below exactly as it was, so
   * no existing caller changes behaviour. Non-zero does two things: the drag
   * delta is rotated into the frame's own axes before any width is computed
   * (dragging the `e` grip of a shape turned 90° must widen it along the
   * direction the author sees as its side, not along the page's x), and the
   * origin is corrected afterwards so the anchored corner stays put *on the
   * page*. Without that second step the frame's unrotated origin is held fixed
   * while the rotation swings the visible corner away from it, and the node
   * slides across the canvas as it is resized.
   */
  rotationDeg?: number;
}

const HANDLE_X: Record<ResizeHandle, -1 | 0 | 1> = {
  nw: -1, w: -1, sw: -1,
  n: 0, s: 0,
  ne: 1, e: 1, se: 1,
};

const HANDLE_Y: Record<ResizeHandle, -1 | 0 | 1> = {
  nw: -1, n: -1, ne: -1,
  w: 0, e: 0,
  sw: 1, s: 1, se: 1,
};

/**
 * Resize a frame by dragging one handle.
 *
 * The opposite edge is the anchor and never moves — that is what makes a resize
 * feel like a resize rather than a move. Pure arithmetic so it is testable
 * without a DOM; the canvas supplies the millimetre delta.
 */
export function resizeFrame(
  original: RectMm,
  handle: ResizeHandle,
  dxMm: number,
  dyMm: number,
  options: ResizeOptions = {},
): RectMm {
  const min = Math.max(0.1, options.minMm ?? 5);
  const minWidth = Math.max(0.1, options.minWidthMm ?? min);
  const minHeight = Math.max(0.1, options.minHeightMm ?? min);
  const dirX = HANDLE_X[handle];
  const dirY = HANDLE_Y[handle];
  const rotation = options.rotationDeg ?? 0;

  // Into the frame's own axes. Rotating the *delta* rather than the frame keeps
  // every line below identical to the unrotated case.
  const local =
    rotation === 0
      ? { x: dxMm, y: dyMm }
      : rotatePoint({ x: dxMm, y: dyMm }, { x: 0, y: 0 }, -rotation);

  let width = original.width + local.x * dirX;
  let height = original.height + local.y * dirY;

  const aspect = options.aspectLock ?? null;
  if (options.angleSnap) {
    // Treated as a point relative to the origin: atan2(height, width) is
    // always in [0°, 90°] since both are non-negative, so rounding to the
    // nearest 45° step can only land on 0°, 45° or 90° — the three angles a
    // corner-to-corner line can express.
    const snapped = snapAngle({ x: 0, y: 0 }, { x: width, y: height }, 45);
    // Math.cos(Math.PI / 2) is ~6e-17, not exactly 0 — flatten anything this
    // close to zero, or the 90° case would never actually reach the literal
    // zero the floor-skip below depends on.
    const flatten = (v: number): number => (v < 1e-6 ? 0 : v);
    width = flatten(snapped.x);
    height = flatten(snapped.y);
  } else if (aspect && aspect > 0) {
    // Corner drags follow the dominant axis; edge drags derive the other side.
    if (dirX !== 0 && dirY !== 0) {
      if (Math.abs(local.x) >= Math.abs(local.y)) height = width / aspect;
      else width = height * aspect;
    } else if (dirX !== 0) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
  }

  if (options.angleSnap) {
    // A snapped 0°/90° result is a deliberate zero, not a degenerate one —
    // only the *other* axis (still a full line, still easy to grab) honours
    // the floor.
    width = width === 0 ? 0 : Math.max(minWidth, width);
    height = height === 0 ? 0 : Math.max(minHeight, height);
  } else {
    width = Math.max(minWidth, width);
    height = Math.max(minHeight, height);

    if (aspect && aspect > 0) {
      // Re-derive after clamping, or the floor would break the locked ratio.
      if (width / height > aspect) width = height * aspect;
      else height = width / aspect;
      width = Math.max(minWidth, width);
      height = Math.max(minHeight, height);
    }
  }

  // Anchor the edge opposite the handle. Handles on an axis' centre leave that
  // axis' origin alone.
  const x = dirX < 0 ? right(original) - width : original.x;
  const y = dirY < 0 ? bottom(original) - height : original.y;

  const resized = { x, y, width, height };
  if (rotation === 0) return resized;

  /*
   * Hold the anchored corner still *on the page*.
   *
   * The arithmetic above anchors it in the frame's own coordinates, which is
   * the whole answer while the frame is axis-aligned. Once it is rotated, both
   * frames are drawn about their own centres — and the centre moved when the
   * size changed — so the corner the author is anchoring against lands
   * somewhere else, and the shape drifts under the cursor.
   *
   * Fractions rather than a switch: 0, 0.5 and 1 cover the corner handles and
   * the edge handles (whose anchor is the midpoint of the opposite edge) in one
   * expression.
   */
  const anchorFx = dirX < 0 ? 1 : dirX > 0 ? 0 : 0.5;
  const anchorFy = dirY < 0 ? 1 : dirY > 0 ? 0 : 0.5;

  const pageAnchor = (r: RectMm): PointMm =>
    rotatePoint(
      { x: r.x + r.width * anchorFx, y: r.y + r.height * anchorFy },
      { x: centerX(r), y: centerY(r) },
      rotation,
    );

  const before = pageAnchor(original);
  const after = pageAnchor(resized);

  return {
    x: resized.x + (before.x - after.x),
    y: resized.y + (before.y - after.y),
    width,
    height,
  };
}

/**
 * Snap the edge being dragged during a resize.
 *
 * `snapFrame` snaps a whole frame by translating it, which is wrong mid-resize:
 * it would drag the anchored edge along too. This moves only the live edge,
 * against the same sibling edges, centres and page edges.
 */
export function snapResize(
  frame: RectMm,
  handle: ResizeHandle,
  context: SnapContext,
): SnapResult {
  if (!context.smartGuides && !context.snapToGrid) return { frame, guides: [] };

  const guides: AlignmentGuide[] = [];
  let { x, y, width, height } = frame;

  const snapEdge = (axis: GuideAxis, dir: -1 | 0 | 1): void => {
    if (dir === 0) return;

    const live =
      axis === 'x' ? (dir < 0 ? x : x + width) : dir < 0 ? y : y + height;

    let best: { delta: number; guide: AlignmentGuide } | null = null;

    const consider = (target: number, sourceIds: NodeId[], kind: AlignmentGuide['kind']): void => {
      const delta = target - live;
      if (Math.abs(delta) > context.toleranceMm) return;
      if (best === null || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, guide: { axis, position: target, sourceIds, kind } };
      }
    };

    if (context.smartGuides) {
      for (const other of context.others) {
        for (const candidate of candidatesFor(other.frame, axis)) {
          consider(candidate.value, [other.id], candidate.kind);
        }
      }
      const pageEdges =
        axis === 'x'
          ? [0, context.pageWidthMm / 2, context.pageWidthMm]
          : [0, context.pageHeightMm / 2, context.pageHeightMm];
      for (const edge of pageEdges) consider(edge, [], 'page');
    }

    let delta: number;
    if (best !== null) {
      const resolved = best as { delta: number; guide: AlignmentGuide };
      guides.push(resolved.guide);
      delta = resolved.delta;
    } else if (context.snapToGrid) {
      const snapped = Math.round(live / context.gridSpacingMm) * context.gridSpacingMm;
      delta = snapped - live;
    } else {
      return;
    }

    // Growing the leading edge moves the origin; the trailing edge only resizes.
    if (axis === 'x') {
      if (dir < 0) {
        x += delta;
        width -= delta;
      } else {
        width += delta;
      }
    } else if (dir < 0) {
      y += delta;
      height -= delta;
    } else {
      height += delta;
    }
  };

  snapEdge('x', HANDLE_X[handle]);
  snapEdge('y', HANDLE_Y[handle]);

  return { frame: { x, y, width: Math.max(0, width), height: Math.max(0, height) }, guides };
}

// ---------------------------------------------------------------------------
// Alignment and distribution commands
// ---------------------------------------------------------------------------

export type AlignMode = 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v';

/** Align frames to the bounding box of the selection. */
export function alignFrames(frames: Map<NodeId, RectMm>, mode: AlignMode): Map<NodeId, RectMm> {
  const list = [...frames.values()];
  if (list.length < 2) return frames;

  const minX = Math.min(...list.map((f) => f.x));
  const maxX = Math.max(...list.map(right));
  const minY = Math.min(...list.map((f) => f.y));
  const maxY = Math.max(...list.map(bottom));

  const out = new Map<NodeId, RectMm>();
  for (const [id, frame] of frames) {
    switch (mode) {
      case 'left':
        out.set(id, { ...frame, x: minX });
        break;
      case 'right':
        out.set(id, { ...frame, x: maxX - frame.width });
        break;
      case 'top':
        out.set(id, { ...frame, y: minY });
        break;
      case 'bottom':
        out.set(id, { ...frame, y: maxY - frame.height });
        break;
      case 'center-h':
        out.set(id, { ...frame, x: (minX + maxX) / 2 - frame.width / 2 });
        break;
      case 'center-v':
        out.set(id, { ...frame, y: (minY + maxY) / 2 - frame.height / 2 });
        break;
    }
  }
  return out;
}

/** Equalise the gaps between frames along one axis. */
export function distributeFrames(
  frames: Map<NodeId, RectMm>,
  axis: GuideAxis,
): Map<NodeId, RectMm> {
  const entries = [...frames.entries()];
  if (entries.length < 3) return frames;

  entries.sort((a, b) => (axis === 'x' ? a[1].x - b[1].x : a[1].y - b[1].y));

  const first = entries[0]![1];
  const last = entries[entries.length - 1]![1];

  const span =
    axis === 'x' ? right(last) - first.x : bottom(last) - first.y;
  const totalSize = entries.reduce(
    (sum, [, f]) => sum + (axis === 'x' ? f.width : f.height),
    0,
  );
  const gap = (span - totalSize) / (entries.length - 1);

  const out = new Map<NodeId, RectMm>();
  let cursor = axis === 'x' ? first.x : first.y;
  for (const [id, frame] of entries) {
    out.set(id, axis === 'x' ? { ...frame, x: cursor } : { ...frame, y: cursor });
    cursor += (axis === 'x' ? frame.width : frame.height) + gap;
  }
  return out;
}

/** Panels in reading order, which is the order panel letters are assigned. */
export function readingOrder(nodes: NodeMap, rowToleranceMm = 5): FigureNode[] {
  const panels = Object.values(nodes).filter((n) => n.type === 'panel');
  return panels.sort((a, b) => {
    // Treat panels within a row band as the same row, then order left to right.
    const sameRow = Math.abs(a.frame.y - b.frame.y) <= rowToleranceMm;
    return sameRow ? a.frame.x - b.frame.x : a.frame.y - b.frame.y;
  });
}
