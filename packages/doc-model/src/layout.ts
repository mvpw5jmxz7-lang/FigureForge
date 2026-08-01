/**
 * Panel layout: the auto-arrangement engine and the snapping rules.
 *
 * Auto Layout solves a rows × columns grid with uniform gutters that fills the
 * page, honouring any per-panel aspect-ratio lock. Manual Layout leaves frames
 * alone and only supplies snap targets. Both produce plain frames, so switching
 * between them never destroys work.
 */

import type { RectMm } from './geometry.js';
import { fitAspect, right, bottom, centerX, centerY } from './geometry.js';
import type { FigureNode, NodeId, NodeMap } from './nodes.js';

export interface GridSpec {
  rows: number;
  columns: number;
}

export interface LayoutOptions {
  pageWidthMm: number;
  pageHeightMm: number;
  marginMm: number;
  gutterMm: number;
  /** Extra left inset per panel for its label, so labels never overlap axes. */
  labelGutterMm?: number;
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
 * Divide the page into equal cells. Returns one rect per grid slot, in
 * row-major order; callers take as many as they have panels.
 */
export function gridCells(spec: GridSpec, options: LayoutOptions): RectMm[] {
  const { rows, columns } = spec;
  if (rows <= 0 || columns <= 0) return [];

  const { pageWidthMm, pageHeightMm, marginMm, gutterMm } = options;

  const usableWidth = pageWidthMm - 2 * marginMm - gutterMm * (columns - 1);
  const usableHeight = pageHeightMm - 2 * marginMm - gutterMm * (rows - 1);

  const cellWidth = Math.max(0, usableWidth / columns);
  const cellHeight = Math.max(0, usableHeight / rows);

  const cells: RectMm[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      cells.push({
        x: marginMm + c * (cellWidth + gutterMm),
        y: marginMm + r * (cellHeight + gutterMm),
        width: cellWidth,
        height: cellHeight,
      });
    }
  }
  return cells;
}

export interface PanelLayoutInput {
  id: NodeId;
  /** Width/height the panel must keep, or null to fill its cell. */
  aspectLock: number | null;
}

/**
 * Assign frames to panels. Panels with an aspect lock are centred inside their
 * cell at the largest size that fits; unlocked panels fill the cell outright.
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
    const cell = cells[index];
    if (!cell) return;

    const inner: RectMm = {
      x: cell.x + labelGutter,
      y: cell.y,
      width: Math.max(0, cell.width - labelGutter),
      height: cell.height,
    };

    frames.set(panel.id, panel.aspectLock ? fitAspect(inner, panel.aspectLock) : inner);
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
