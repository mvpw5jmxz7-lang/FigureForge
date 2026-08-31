/**
 * The figure canvas.
 *
 * Renders the document through the shared scene tree, so what appears here is
 * the same geometry the exporter will serialise. Zoom, selection and drag are
 * canvas concerns only — none of them touch the scene.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  absoluteFrame,
  ancestorsOf,
  childrenOf,
  duplicateNode,
  fitAspect,
  isDerivedNode,
  isLocked,
  MIN_TILE_MM,
  normaliseCrop,
  recordBracketOffset,
  rescaleArrowPoints,
  resizeFrame,
  resizeGroup,
  resizePanel,
  resyncScaleBars,
  setArrowPoint,
  setImageCrop,
  snapAngle,
  snapFrame,
  snapResize,
  snapRotation,
  snapshotPanelAbsolutePositions,
  syncPanelLabelsFromSnapshot,
  type AlignmentGuide,
  type Crop01,
  type FigureDocument,
  type FigureNode,
  type NodeId,
  type PlotNode,
  type PointMm,
  type RectMm,
  type ResizeHandle,
} from '@figureforge/doc-model';
import {
  MAX_POINT_LABELS,
  measureAllPlots,
  pickablePointsForPlot,
  placedPointLabelsForPlot,
  reflowBrackets,
  renderDocument,
  toReact,
  type PickablePoint,
  type PlacedPointLabel,
} from '@figureforge/render';
import type { Theme } from '@figureforge/theme';
import { deleteNodesWithLayout } from '../deleteNodes.js';
import type { DocumentApi } from '../useDocument.js';

/** CSS reference pixels per millimetre at 100% zoom. */
const PX_PER_MM = 96 / 25.4;

export interface CanvasProps {
  api: DocumentApi;
  theme: Theme;
  selectedIds: NodeId[];
  onSelectionChange: (ids: NodeId[]) => void;
  zoom: number;
  showGrid: boolean;
  assetUrls: Record<string, string>;
  /** Baked rasters for plots over `MAX_VECTOR_POINTS`, keyed by plot node id. */
  pointRasters: ReadonlyMap<string, string>;
  /** Image being cropped on canvas, or null. Owned by the Inspector's toggle. */
  cropNodeId: NodeId | null;
  /** Scale bar being calibrated by measuring a feature, or null. */
  measureNodeId: NodeId | null;
  onMeasured: (imagePixels: number) => void;
  /** Volcano plot whose points are being picked directly on the canvas. */
  labelPickNodeId: NodeId | null;
}

interface DragState {
  nodeId: NodeId;
  startClientX: number;
  startClientY: number;
  originalFrames: Map<NodeId, RectMm>;
  /** Set when the drag started on a resize grip rather than the node body. */
  handle?: ResizeHandle;
  /** Set when the drag started on an arrow endpoint grip. */
  pointIndex?: number;
  /** The dragged point's start position, in page space. */
  pointOrigin?: { x: number; y: number };
  /** Set when the drag started on the rotate grip. */
  rotate?: {
    /** Page-space centre the node turns about. */
    centre: { x: number; y: number };
    /** Bearing from that centre to the pointer when the drag began. */
    startAngleDeg: number;
    /** The node's rotation at that moment, which the drag is a delta on. */
    startRotation: number;
  };
}

/**
 * Node types that may be rotated.
 *
 * Deliberately only the leaf annotations. `absoluteFrame` sums ancestor origins
 * and ignores rotation entirely, and it is what every canvas overlay, the crop
 * and measure chrome, and `Toolbar`'s insert position all read; `autoLayout`,
 * `snapFrame`, `alignFrames` and `resizePanel` likewise assume axis-aligned
 * frames. Restricting rotation to nodes that never have children means no
 * rotated node ever has a descendant, so all of that stays correct by
 * construction rather than by a cascade of fixes.
 */
const ROTATABLE_TYPES = new Set(['shape', 'arrow', 'text']);

export const isRotatable = (node: FigureNode): boolean => ROTATABLE_TYPES.has(node.type);

/** Degrees, clockwise from the page's +x axis, from `centre` to a page point. */
const bearingDeg = (centre: { x: number; y: number }, x: number, y: number): number =>
  (Math.atan2(y - centre.y, x - centre.x) * 180) / Math.PI;

/** How far a pasted copy sits from its original, in millimetres. */
const PASTE_OFFSET_MM = 3;

/** Arrow endpoint grips carry `data-handle="point-0"`, `"point-1"`, … */
const POINT_HANDLE = /^point-(\d+)$/;

/**
 * Ratio a resize must preserve, or null for free resize.
 *
 * Images join panels here. An image without it does not distort — the renderer
 * emits `preserveAspectRatio` — but it letterboxes inside its frame, leaving
 * white space the author cannot account for while the dpi readout, which
 * divides by the *frame* width, quietly overstates the resolution.
 */
function aspectLockFor(node: FigureDocument['nodes'][string]): number | null {
  if (node.type === 'panel') return node.aspectLock;
  if (node.type === 'image' && node.preserveAspect && node.naturalPx.height > 0) {
    return node.naturalPx.width / node.naturalPx.height;
  }
  // Vector assets carry {0, 0} and fall through to free resize, which is
  // correct: they have no intrinsic proportions to preserve.
  return null;
}

/**
 * The smallest a panel's own frame can be before its `contentGrid` can no
 * longer give every tile a usable, grabbable size.
 *
 * Absent a grid, this is just the generic 5 mm floor every node already gets.
 * With one, `resizeFrame`'s `minWidthMm`/`minHeightMm` read this instead, so
 * a montage panel refuses to shrink into the state where `fillPanelChildren`
 * would otherwise have to hand a tile a near-zero frame — the panel simply
 * cannot reach that state, rather than reaching it and papering over it.
 * `MIN_TILE_MM` is the same constant `fillPanelChildren`'s own backstop reads,
 * so the two cannot quietly disagree about what "too small" means.
 */
function panelGridMinimumMm(node: FigureDocument['nodes'][string]): { width: number; height: number } {
  const grid = node.type === 'panel' ? node.contentGrid : undefined;
  if (!grid) return { width: MIN_TILE_MM, height: MIN_TILE_MM };
  const padding = node.type === 'panel' ? node.paddingMm : 0;
  return {
    width: grid.cols * MIN_TILE_MM + (grid.cols - 1) * grid.gutterMm + 2 * padding,
    height: grid.rows * MIN_TILE_MM + (grid.rows - 1) * grid.gutterMm + 2 * padding,
  };
}

/** Node types a click groups into rather than through. */
const CONTAINER_TYPES = new Set(['panel', 'group', 'image']);

/**
 * A panel whose only purpose is holding tiled content — a montage.
 *
 * A single-plot panel, a panel carrying a caption or annotation alongside its
 * plot, and every other container still resolve to the panel first (see
 * `selectionTarget`'s own history below) — this is deliberately narrow.
 */
function isPureMontagePanel(doc: FigureDocument, panelId: NodeId): boolean {
  const panel = doc.nodes[panelId];
  if (!panel || panel.type !== 'panel' || !panel.contentGrid) return false;
  const children = childrenOf(doc.nodes, panelId);
  return children.length > 1 && children.every((c) => c.type === 'plot' || c.type === 'image');
}

/**
 * The node a click on `id` should actually select.
 *
 * Every scene node stops pointer propagation before reporting itself, so the
 * renderer always names the *deepest* thing under the cursor. Taken literally
 * that meant clicking a bar selected the plot and never the panel around it,
 * and a group could not be selected on the canvas at all — the two together
 * read as "Delete doesn't remove panels" and "Group doesn't group".
 *
 * So a click selects the outermost container by default, and double-clicking a
 * container steps inside it, which is how every other layout editor behaves.
 * `enteredId` is the container the user has stepped into; clicks within it
 * select one level deeper.
 *
 * One exception: a pure montage panel (`isPureMontagePanel`) has nothing to
 * select *but* its tiles — resolving to the panel first buys nothing the way
 * it does for a single-plot panel (which still needs a plain click to reach
 * for moving/deleting/grouping) and only costs an extra double-click before
 * every tile move or resize. Confirmed live: a fresh click on any tile of a
 * multi-image import selected and dragged the whole panel instead of that
 * tile, symmetrically across all four positions — reported as "the image
 * doesn't move." Skip straight to the tile here, exactly as if the panel
 * were already entered.
 */
function selectionTarget(doc: FigureDocument, id: NodeId, enteredId: NodeId | null): NodeId {
  // ancestorsOf is nearest-first; outermost-first is what a click walks down.
  const chain = [...ancestorsOf(doc.nodes, id)].reverse();
  if (chain.length === 0) return id;

  if (enteredId !== null) {
    const index = chain.findIndex((n) => n.id === enteredId);
    if (index >= 0) return chain[index + 1]?.id ?? id;
    // Clicked outside the container being edited; the entry is dropped by the
    // caller and this click behaves like any other.
  }

  const outer = chain[0]!;
  if (outer.type === 'panel' && isPureMontagePanel(doc, outer.id)) {
    return chain[1]?.id ?? id;
  }
  return outer.id;
}

/** A text node being edited in place. */
interface TextEdit {
  nodeId: NodeId;
  value: string;
  /** Screen-space box of the node, so the input sits over it. */
  rect: { left: number; top: number; width: number; height: number };
  /**
   * Which field of the node is being edited, when it is not the node's own
   * single string — an axis title, say, of which a plot has several. Absent
   * means the node's own `text`/`label`, exactly as before this existed.
   */
  target?: EditTarget;
}

/**
 * Fields a canvas double-click can open, keyed by the `editTarget` the renderer
 * stamps on the element that draws them.
 *
 * Only freeform strings the author owns. Tick labels are deliberately absent:
 * they are computed from the data, and an editable one would let a figure
 * display a number its data does not support.
 */
const EDIT_TARGETS = ['x.title', 'y.title', 'y2.title', 'cascadeAxisTitle'] as const;
type EditTarget = (typeof EDIT_TARGETS)[number];

const isEditTarget = (value: string): value is EditTarget =>
  (EDIT_TARGETS as readonly string[]).includes(value);

/** Read the string an `EditTarget` names off a plot node. */
function readEditTarget(node: FigureNode, target: EditTarget): string | null {
  if (node.type !== 'plot') return null;
  if (target === 'cascadeAxisTitle') return node.cascadeAxisTitle ?? '';
  if (target === 'x.title') return node.x.title;
  if (target === 'y.title') return node.y.title;
  return node.y2?.title ?? null;
}

export function Canvas({
  api,
  theme,
  selectedIds,
  onSelectionChange,
  zoom,
  showGrid,
  assetUrls,
  pointRasters,
  cropNodeId,
  measureNodeId,
  onMeasured,
  labelPickNodeId,
}: CanvasProps) {
  const { document: doc } = api;
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  /** Container the user has double-clicked into; null means top level. */
  const [enteredId, setEnteredId] = useState<NodeId | null>(null);
  const dragRef = useRef<DragState | null>(null);
  /*
   * The page element itself, so a rotate drag can convert client pixels into
   * page millimetres. A resize or move only ever needs the *delta* between two
   * client positions, which is origin-independent; an angle is measured about a
   * fixed centre, so it needs to know where the page starts.
   */
  const pageRef = useRef<HTMLDivElement | null>(null);
  /** Ids last copied. Cleared only by another copy — pasting is repeatable. */
  const clipboardRef = useRef<NodeId[]>([]);

  const cropCandidate = cropNodeId ? doc.nodes[cropNodeId] : undefined;
  const cropTarget = cropCandidate?.type === 'image' ? cropCandidate : null;

  // The measuring ruler is drawn over the bar's parent image, since what is
  // being measured is a feature of the micrograph, not of the bar.
  const measureBar = measureNodeId ? doc.nodes[measureNodeId] : undefined;
  const measureImage =
    measureBar?.type === 'scale-bar' && measureBar.parentId
      ? doc.nodes[measureBar.parentId]
      : undefined;
  const measureTarget = measureImage?.type === 'image' ? measureImage : null;

  const labelPickCandidate = labelPickNodeId ? doc.nodes[labelPickNodeId] : undefined;
  const labelPickTarget =
    labelPickCandidate?.type === 'plot' && labelPickCandidate.plotType === 'volcano'
      ? labelPickCandidate
      : null;

  const resolveAsset = useCallback((assetId: string) => assetUrls[assetId], [assetUrls]);

  const scene = renderDocument(doc, {
    theme,
    resolveAsset,
    chrome: { selectedIds, showGrid },
    pointRasters,
  });

  // --- selection ----------------------------------------------------------

  const handlePointerDown = useCallback(
    (nodeId: NodeId, event: React.PointerEvent) => {
      // Stepping outside the container being edited leaves it.
      const inside =
        enteredId !== null &&
        (nodeId === enteredId || ancestorsOf(doc.nodes, nodeId).some((n) => n.id === enteredId));
      if (enteredId !== null && !inside) setEnteredId(null);

      const targetId = selectionTarget(doc, nodeId, inside ? enteredId : null);

      const additive = event.shiftKey || event.metaKey;
      const next = additive
        ? selectedIds.includes(targetId)
          ? selectedIds.filter((id) => id !== targetId)
          : [...selectedIds, targetId]
        : [targetId];

      onSelectionChange(next);

      if (isLocked(doc, targetId)) return;

      const frames = new Map<NodeId, RectMm>();
      for (const id of next) {
        const node = doc.nodes[id];
        if (node) frames.set(id, node.frame);
      }

      dragRef.current = {
        nodeId: targetId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originalFrames: frames,
      };
      (event.target as Element).setPointerCapture?.(event.pointerId);
    },
    [doc, enteredId, selectedIds, onSelectionChange],
  );

  // --- resize -------------------------------------------------------------

  const handleHandlePointerDown = useCallback(
    (nodeId: NodeId, handle: string, event: React.PointerEvent) => {
      const node = doc.nodes[nodeId];
      if (!node || isLocked(doc, nodeId)) return;

      const point = POINT_HANDLE.exec(handle);
      if (point && node.type === 'arrow') {
        const index = Number(point[1]);
        const origin = node.points[index];
        if (!origin) return;
        dragRef.current = {
          nodeId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          originalFrames: new Map([[nodeId, node.frame]]),
          pointIndex: index,
          // Page space, so the drag maths does not have to track the frame
          // being rebased under it as the point crosses the origin.
          pointOrigin: { x: node.frame.x + origin.x, y: node.frame.y + origin.y },
        };
        (event.target as Element).setPointerCapture?.(event.pointerId);
        return;
      }

      if (handle === 'rotate') {
        const abs = absoluteFrame(doc.nodes, nodeId);
        if (!abs) return;
        // Client pixels → page millimetres, so the bearing is measured in the
        // same space the stored rotation is defined in.
        const page = pageRef.current?.getBoundingClientRect();
        if (!page) return;
        const pxPerMm = PX_PER_MM * zoom;
        const centre = { x: abs.x + abs.width / 2, y: abs.y + abs.height / 2 };
        dragRef.current = {
          nodeId,
          startClientX: event.clientX,
          startClientY: event.clientY,
          originalFrames: new Map([[nodeId, node.frame]]),
          rotate: {
            centre,
            startAngleDeg: bearingDeg(
              centre,
              (event.clientX - page.left) / pxPerMm,
              (event.clientY - page.top) / pxPerMm,
            ),
            startRotation: node.rotation,
          },
        };
        (event.target as Element).setPointerCapture?.(event.pointerId);
        return;
      }

      dragRef.current = {
        nodeId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originalFrames: new Map([[nodeId, node.frame]]),
        handle: handle as ResizeHandle,
      };
      (event.target as Element).setPointerCapture?.(event.pointerId);
    },
    [doc, zoom],
  );

  // --- dragging -----------------------------------------------------------

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const pxPerMm = PX_PER_MM * zoom;
      const dxMm = (event.clientX - drag.startClientX) / pxPerMm;
      const dyMm = (event.clientY - drag.startClientY) / pxPerMm;

      const primary = doc.nodes[drag.nodeId];
      const primaryOriginal = drag.originalFrames.get(drag.nodeId);
      if (!primary || !primaryOriginal) return;

      // --- rotating ---------------------------------------------------------
      if (drag.rotate) {
        const { centre, startAngleDeg, startRotation } = drag.rotate;
        const page = pageRef.current?.getBoundingClientRect();
        if (!page) return;
        const bearing = bearingDeg(
          centre,
          (event.clientX - page.left) / pxPerMm,
          (event.clientY - page.top) / pxPerMm,
        );
        // A delta on the rotation the drag started from, not an absolute
        // bearing: grabbing the grip anywhere along its reach must not snap the
        // node round to point at the cursor before the author has moved.
        const next = startRotation + (bearing - startAngleDeg);
        api.commit('Rotate', (draft) => {
          const node = draft.nodes[drag.nodeId];
          if (!node || isLocked(draft, drag.nodeId)) return;
          node.rotation = event.shiftKey
            ? snapRotation(next)
            : ((next % 360) + 360) % 360;
        });
        return;
      }

      // --- arrow endpoint ---------------------------------------------------
      if (drag.pointIndex !== undefined && drag.pointOrigin) {
        const { pointIndex, pointOrigin } = drag;
        api.commit('Aim arrow', (draft) => {
          const node = draft.nodes[drag.nodeId];
          if (node?.type !== 'arrow' || isLocked(draft, drag.nodeId)) return;
          // The point is held in page space through the drag and converted
          // back at the end, because normaliseArrowFrame moves the frame
          // origin underneath a frame-relative delta.
          let target = { x: pointOrigin.x + dxMm, y: pointOrigin.y + dyMm };

          /*
           * Shift constrains the heading to 45° steps.
           *
           * Measured from the *adjacent* point, which is the one the segment
           * being aimed actually runs from — for a two-point arrow that is the
           * other end, and for a bent one it is the neighbour on the tail side.
           * Read live from the event rather than from `DragState`, so the
           * author can press and release Shift mid-drag.
           */
          if (event.shiftKey && node.points.length > 1) {
            const neighbour = node.points[pointIndex === 0 ? 1 : pointIndex - 1];
            if (neighbour) {
              target = snapAngle(
                { x: node.frame.x + neighbour.x, y: node.frame.y + neighbour.y },
                target,
              );
            }
          }

          setArrowPoint(draft, drag.nodeId, pointIndex, {
            x: target.x - node.frame.x,
            y: target.y - node.frame.y,
          });
        });
        return;
      }

      // --- resizing ---------------------------------------------------------
      if (drag.handle) {
        /*
         * Shift locks the proportion to a square.
         *
         * Read live off the event rather than from `DragState`, so pressing and
         * releasing Shift part-way through a drag takes effect immediately. It
         * overrides an image's or panel's own aspect lock, which is what makes
         * it a deliberate constraint rather than a suggestion.
         *
         * There is no drag-to-draw tool here — shapes and arrows are
         * insert-then-drag — so this same path is what "draw a square" means.
         */
        const aspect = event.shiftKey ? 1 : aspectLockFor(primary);
        const gridMin = panelGridMinimumMm(primary);
        const resized = resizeFrame(primaryOriginal, drag.handle, dxMm, dyMm, {
          aspectLock: aspect,
          minMm: 5,
          minWidthMm: gridMin.width,
          minHeightMm: gridMin.height,
          rotationDeg: primary.rotation,
        });

        const siblings = Object.values(doc.nodes)
          .filter((n) => n.parentId === primary.parentId && n.id !== primary.id)
          .map((n) => ({ id: n.id, frame: n.frame }));

        /*
         * Snapping is suspended in three cases, all for the same reason — it
         * would contradict something the author asked for or something they can
         * see:
         *
         *  - Alt, which has always meant "suspend snapping".
         *  - Shift, because `snapResize` moves each axis' live edge
         *    independently and would immediately break the ratio `resizeFrame`
         *    just enforced.
         *  - A rotated node, because the guides are computed from the
         *    axis-aligned `frame`, which is not where a rotated shape appears —
         *    a guide drawn there would be pointing at nothing.
         */
        const freeform = event.altKey || event.shiftKey || primary.rotation !== 0;

        const snapped = snapResize(resized, drag.handle, {
          others: siblings,
          pageWidthMm: doc.page.widthMm,
          pageHeightMm: doc.page.heightMm,
          gridSpacingMm: doc.grid.spacingMm,
          snapToGrid: doc.grid.snap && !freeform,
          smartGuides: doc.grid.smartGuides && !freeform,
          toleranceMm: doc.grid.toleranceMm / zoom,
        });

        setGuides(snapped.guides);

        api.commit('Resize', (draft) => {
          const node = draft.nodes[drag.nodeId];
          if (!node || isLocked(draft, drag.nodeId)) return;

          // Panels carry a plot and a page-space label that must follow, or the
          // panel letter is left behind and the plot keeps its old size.
          if (node.type === 'panel') resizePanel(draft, drag.nodeId, snapped.frame);
          // An arrow's points are frame-relative, so stretching the box has to
          // stretch the line inside it or the grips drift off the arrow.
          else if (node.type === 'arrow') rescaleArrowPoints(draft, drag.nodeId, snapped.frame);
          // A group's own frame used to be the only thing a handle touched —
          // nothing scales a node by its frame, only translates it, so the
          // group's bounding box changed while its members visibly did not.
          else if (node.type === 'group') resizeGroup(draft, drag.nodeId, snapped.frame);
          else node.frame = snapped.frame;

          // A resized image changes what a millimetre on it represents.
          resyncScaleBars(draft);
          // The direct fix for stranded significance brackets: their geometry
          // is absolute, so nothing else would move them with the bars.
          reflowBrackets(draft, theme);
        });
        return;
      }

      // Snap the node under the cursor, then move the rest of the selection by
      // the same delta so relative positions inside a selection are preserved.
      const moved: RectMm = {
        ...primaryOriginal,
        x: primaryOriginal.x + dxMm,
        y: primaryOriginal.y + dyMm,
      };

      const siblings = Object.values(doc.nodes)
        .filter((n) => n.parentId === primary.parentId && !drag.originalFrames.has(n.id))
        .map((n) => ({ id: n.id, frame: n.frame }));

      // A rotated node's `frame` is not the rectangle the author sees, so
      // snapping its edges would align it to something invisible. Same reasoning
      // as the resize branch above.
      const freeform = event.altKey || primary.rotation !== 0;

      const snapped = snapFrame(moved, {
        others: siblings,
        pageWidthMm: doc.page.widthMm,
        pageHeightMm: doc.page.heightMm,
        gridSpacingMm: doc.grid.spacingMm,
        snapToGrid: doc.grid.snap && !freeform,
        smartGuides: doc.grid.smartGuides && !freeform,
        toleranceMm: doc.grid.toleranceMm / zoom,
      });

      setGuides(snapped.guides);

      const appliedDx = snapped.frame.x - primaryOriginal.x;
      const appliedDy = snapped.frame.y - primaryOriginal.y;

      api.commit('Move', (draft) => {
        // A panel-label is a top-level node with no parent of its own, so
        // moving a panel — directly, or as part of a dragged group — leaves
        // its letter behind unless something explicitly tells the label to
        // follow. Snapshot every panel under every dragged node first, move
        // everything, then reconcile from the absolute-position delta.
        const before = new Map<NodeId, PointMm>();
        for (const id of drag.originalFrames.keys()) {
          for (const [panelId, abs] of snapshotPanelAbsolutePositions(draft.nodes, id)) {
            before.set(panelId, abs);
          }
        }

        for (const [id, original] of drag.originalFrames) {
          const node = draft.nodes[id];
          if (!node || isLocked(draft, id)) continue;
          node.frame = { ...original, x: original.x + appliedDx, y: original.y + appliedDy };
        }

        syncPanelLabelsFromSnapshot(draft, before);
      });
    },
    [api, doc, theme, zoom],
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    setGuides([]);
    // A rotate drag can only have touched a rotatable leaf, never a bracket, so
    // there is nothing below for it to do.
    if (!drag || drag.handle || drag.rotate) return;

    // Remember how far a bracket was dragged from where the geometry puts it,
    // so repositioning re-applies the adjustment instead of discarding it.
    const moved = [...drag.originalFrames.keys()].filter(
      (id) => doc.nodes[id]?.type === 'bracket',
    );
    if (moved.length === 0) return;

    api.commit('Adjust bracket', (draft) => {
      const measurements = measureAllPlots(draft, theme);
      for (const id of moved) recordBracketOffset(draft, id, measurements);
    });
  }, [api, doc, theme]);

  // --- keyboard nudging ---------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      /*
       * Nor when the focus is in the side panel at all.
       *
       * The tag test above was the whole guard, and a data-grid cell is a
       * `<button>` — so Ctrl+V while a cell was selected fell through to the
       * paste branch below and duplicated figure elements onto the canvas,
       * instead of pasting the author's spreadsheet block into the table.
       * Canvas shortcuts belong to the canvas.
       */
      if (target?.closest('.side-panel')) return;

      // Step back out of a container. Checked before the selection guard, since
      // leaving one is meaningful even with nothing selected.
      if (event.key === 'Escape' && enteredId !== null) {
        setEnteredId(null);
        return;
      }

      /*
       * Copy and paste through an in-app clipboard rather than the OS one. The
       * payload is a set of node ids, not serialised nodes: pasting has to run
       * against the *current* document anyway, and routing figure geometry
       * through `navigator.clipboard` would mean a permissions prompt and a
       * round trip for no gain. Derived nodes cannot be copied alone — see
       * `isDerivedNode`.
       */
      const accel = event.ctrlKey || event.metaKey;
      if (accel && (event.key === 'c' || event.key === 'C')) {
        const copyable = selectedIds.filter((id) => {
          const node = doc.nodes[id];
          return node !== undefined && !isDerivedNode(node);
        });
        clipboardRef.current = copyable;
        return;
      }

      if (accel && (event.key === 'v' || event.key === 'V' || event.key === 'd' || event.key === 'D')) {
        // Ctrl+D duplicates the selection in place of the clipboard's contents.
        const source =
          event.key === 'd' || event.key === 'D'
            ? selectedIds.filter((id) => {
                const node = doc.nodes[id];
                return node !== undefined && !isDerivedNode(node);
              })
            : clipboardRef.current;
        if (source.length === 0) return;
        event.preventDefault();

        const created: NodeId[] = [];
        api.commit('Paste', (draft) => {
          for (const id of source) {
            // Offset so the copy is visible rather than exactly covering its
            // original, which reads as nothing having happened.
            const copy = duplicateNode(draft, api.newId, id, { x: PASTE_OFFSET_MM, y: PASTE_OFFSET_MM });
            if (copy) created.push(copy);
          }
        });
        if (created.length > 0) onSelectionChange(created);
        return;
      }

      if (selectedIds.length === 0) return;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const doomed = selectedIds.filter((id) => !isLocked(doc, id));
        if (doomed.length === 0) return;

        deleteNodesWithLayout(api, theme, doomed);
        onSelectionChange([]);
        return;
      }

      const arrows: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const direction = arrows[event.key];
      if (!direction) return;

      event.preventDefault();

      // Shift nudges by a full grid step; Alt drops to 0.1 mm for fine work.
      const step = event.shiftKey
        ? doc.grid.spacingMm * 5
        : event.altKey
          ? 0.1
          : doc.grid.spacingMm;

      api.commit('Nudge', (draft) => {
        for (const id of selectedIds) {
          const node = draft.nodes[id];
          if (!node || isLocked(draft, id)) continue;
          node.frame = {
            ...node.frame,
            x: node.frame.x + direction[0] * step,
            y: node.frame.y + direction[1] * step,
          };
        }
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [api, doc, enteredId, onSelectionChange, selectedIds]);

  // --- entering a container, or editing text in place ----------------------

  const handleDoubleClick = useCallback(
    (nodeId: NodeId, event: React.MouseEvent) => {
      const node = doc.nodes[nodeId];
      if (!node) return;

      /*
       * An axis title, before anything else.
       *
       * Ordering is load-bearing: a plot's ancestor is a panel, which *is* a
       * container, so the step-in branch below would otherwise swallow the
       * double-click and merely enter the panel — the title would never open,
       * however many times it was clicked.
       *
       * The element is found by the `data-edit-target` the renderer stamps on
       * it. `nodeId` alone names the plot, and a plot draws several titles.
       */
      const titleEl = (event.target as Element | null)?.closest<SVGElement>('[data-edit-target]');
      const rawTarget = titleEl?.dataset['editTarget'];
      if (titleEl && rawTarget && isEditTarget(rawTarget) && !isLocked(doc, nodeId)) {
        const current = readEditTarget(node, rawTarget);
        const page = pageRef.current?.getBoundingClientRect();
        if (current !== null && page) {
          // Measured off the DOM rather than from `absoluteFrame`, which only
          // knows whole document nodes and has nothing to say about a `<text>`
          // two levels inside one. Legal here — only `packages/render` has to
          // stay DOM-free.
          const box = titleEl.getBoundingClientRect();
          setTextEdit({
            nodeId,
            value: current,
            target: rawTarget,
            rect: {
              left: box.left - page.left,
              top: box.top - page.top,
              // A rotated y title's box is tall and narrow, so the horizontal
              // field needs its own minimum rather than the label's width.
              width: Math.max(box.width, 80),
              height: Math.max(box.height, 22),
            },
          });
          return;
        }
      }

      /*
       * Double-click steps into whatever the single click just selected, so a
       * panel's plot, a group's members and a micrograph's scale bar are all
       * reachable without giving up panel- and group-level selection. Text
       * nodes are never containers, so the in-place editor below is unaffected.
       */
      const outer = selectionTarget(doc, nodeId, enteredId);
      const outerNode = doc.nodes[outer];
      if (outer !== nodeId && outerNode && CONTAINER_TYPES.has(outerNode.type)) {
        setEnteredId(outer);
        onSelectionChange([selectionTarget(doc, nodeId, outer)]);
        return;
      }

      // Only nodes that own their string. Tick labels come from the data and
      // axis titles live on the plot, so both are edited in the Inspector.
      const current =
        node.type === 'text' || node.type === 'panel-label'
          ? node.text
          : node.type === 'bracket'
            ? node.label
            : null;
      if (current === null || isLocked(doc, nodeId)) return;

      const frame = absoluteFrame(doc.nodes, nodeId);
      if (!frame) return;

      const pxPerMm = PX_PER_MM * zoom;
      setTextEdit({
        nodeId,
        value: current,
        rect: {
          left: frame.x * pxPerMm,
          top: frame.y * pxPerMm,
          // A panel letter's frame is tiny; give the field a usable minimum.
          width: Math.max(frame.width * pxPerMm, 80),
          height: Math.max(frame.height * pxPerMm, 22),
        },
      });
    },
    [doc, enteredId, onSelectionChange, zoom],
  );

  const commitTextEdit = useCallback(() => {
    const edit = textEdit;
    setTextEdit(null);
    if (!edit) return;

    api.commit(edit.target ? 'Edit axis title' : 'Edit text', (draft) => {
      const node = draft.nodes[edit.nodeId];
      if (!node) return;

      // An axis title writes exactly the field `AxisFields` writes in the
      // Inspector, so the two surfaces cannot disagree about what was edited.
      if (edit.target) {
        if (node.type !== 'plot') return;
        if (edit.target === 'cascadeAxisTitle') node.cascadeAxisTitle = edit.value;
        else if (edit.target === 'x.title') node.x = { ...node.x, title: edit.value };
        else if (edit.target === 'y.title') node.y = { ...node.y, title: edit.value };
        else if (node.y2) node.y2 = { ...node.y2, title: edit.value };
        return;
      }

      if (node.type === 'text' || node.type === 'panel-label') node.text = edit.value;
      else if (node.type === 'bracket') node.label = edit.value;
    });
  }, [api, textEdit]);

  // --- rendering ----------------------------------------------------------

  const widthPx = doc.page.widthMm * PX_PER_MM * zoom;
  const heightPx = doc.page.heightMm * PX_PER_MM * zoom;

  return (
    <div
      className="canvas-scroll"
      onPointerDown={() => {
        onSelectionChange([]);
        setEnteredId(null);
      }}
    >
      <div
        ref={pageRef}
        className="canvas-page"
        style={{ width: widthPx, height: heightPx }}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {toReact(scene, {
          onNodePointerDown: handlePointerDown,
          onHandlePointerDown: handleHandlePointerDown,
          onNodeDoubleClick: handleDoubleClick,
          selectedIds: new Set(selectedIds),
        })}
        <GuideOverlay guides={guides} doc={doc} zoom={zoom} />

        {/* Crop chrome, like the text editor, is HTML above the SVG and never
            a scene node. Resize handles are proven not to leak into an export
            by the parity test; crop chrome would have no such guard, and it is
            editor state rather than part of the drawing. */}
        {cropTarget && (
          // Keyed by node so switching images remounts: the in-flight crop is
          // component state, and carrying one image's dragged rectangle onto
          // the next would apply it to a picture it was never drawn against.
          <CropOverlay
            key={cropTarget.id}
            api={api}
            node={cropTarget}
            zoom={zoom}
            theme={theme}
            assetUrls={assetUrls}
          />
        )}

        {measureTarget && (
          <MeasureOverlay doc={doc} node={measureTarget} zoom={zoom} onMeasured={onMeasured} />
        )}

        {labelPickTarget && (
          <PointPickOverlay
            key={labelPickTarget.id}
            api={api}
            theme={theme}
            node={labelPickTarget}
            zoom={zoom}
          />
        )}

        {/* Editing overlay: an HTML input above the SVG, never in the scene. */}
        {textEdit && (
          <input
            className="text-edit-overlay"
            autoFocus
            value={textEdit.value}
            style={{
              left: textEdit.rect.left,
              top: textEdit.rect.top,
              width: textEdit.rect.width,
              height: textEdit.rect.height,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
            onBlur={commitTextEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitTextEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setTextEdit(null);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

/** The eight grips on the crop window, as fractions of its box. */
const CROP_GRIPS: readonly { id: string; fx: number; fy: number }[] = [
  { id: 'nw', fx: 0, fy: 0 },
  { id: 'n', fx: 0.5, fy: 0 },
  { id: 'ne', fx: 1, fy: 0 },
  { id: 'e', fx: 1, fy: 0.5 },
  { id: 'se', fx: 1, fy: 1 },
  { id: 's', fx: 0.5, fy: 1 },
  { id: 'sw', fx: 0, fy: 1 },
  { id: 'w', fx: 0, fy: 0.5 },
];

/**
 * Direct-manipulation crop.
 *
 * The numeric fields in the Inspector are precise and reproducible; they are
 * useless for the actual job, which is "cut the burned-in scale bar off the
 * bottom of this micrograph". That needs to be done by eye, against the image.
 *
 * Positioned over the image's `absoluteFrame`, exactly as the text editor is —
 * HTML above the SVG, so none of this can reach an export.
 */
function CropOverlay({
  api,
  node,
  zoom,
  theme,
  assetUrls,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'image' }>;
  zoom: number;
  theme: Theme;
  assetUrls: Record<string, string>;
}) {
  const { document: doc } = api;
  const dragRef = useRef<{
    grip: string | null;
    startX: number;
    startY: number;
    crop: Crop01;
  } | null>(null);

  /*
   * The crop being dragged, or null when nothing is in flight.
   *
   * Held here and committed once, on release. Every pointer-move used to be its
   * own `api.commit`, so a single crop wrote a hundred entries into the undo
   * history and one Ctrl+Z moved the window by a pixel.
   */
  const [pending, setPending] = useState<Crop01 | null>(null);

  const frame = absoluteFrame(doc.nodes, node.id);
  if (!frame) return null;

  const pxPerMm = PX_PER_MM * zoom;
  const box = {
    left: frame.x * pxPerMm,
    top: frame.y * pxPerMm,
    width: frame.width * pxPerMm,
    height: frame.height * pxPerMm,
  };

  /*
   * Where the *whole* source image sits inside the frame, in overlay pixels.
   *
   * This is the fix for a crop that cut somewhere other than the outline. The
   * window is stored in normalised *source* coordinates, but it used to be
   * drawn as a fraction of the panel frame — and the renderer scales the kept
   * region up to fill that frame, so the two spaces stop agreeing the moment
   * anything is cropped. The picture zoomed, the outline shrank into a corner,
   * and the next drag applied frame fractions as source fractions.
   *
   * So crop mode shows the entire picture instead, letterboxed exactly as
   * `preserveAspectRatio="xMidYMid meet"` would. The window is then genuinely
   * in source space: what is outlined is what is kept.
   */
  const fullBox = { x: 0, y: 0, width: box.width, height: box.height };
  const imageRect =
    node.preserveAspect && node.naturalPx.height > 0
      ? // `fitAspect` is the same centred fit the renderer's "xMidYMid meet"
        // performs, and already carries the layout tests. A second copy of the
        // arithmetic here is a second thing that can disagree with the drawing.
        fitAspect(fullBox, node.naturalPx.width / node.naturalPx.height)
      : fullBox;

  const crop = pending ?? node.crop;
  const window = {
    left: imageRect.x + crop.x * imageRect.width,
    top: imageRect.y + crop.y * imageRect.height,
    width: crop.width * imageRect.width,
    height: crop.height * imageRect.height,
  };

  const onGripDown = (grip: string | null) => (event: React.PointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    dragRef.current = { grip, startX: event.clientX, startY: event.clientY, crop: { ...crop } };
    (event.target as Element).setPointerCapture?.(event.pointerId);
  };

  const onMove = (event: React.PointerEvent): void => {
    const drag = dragRef.current;
    if (!drag) return;
    if (imageRect.width <= 0 || imageRect.height <= 0) return;

    // Against the drawn image, not the frame: they differ whenever the picture
    // is letterboxed inside its panel.
    const dx = (event.clientX - drag.startX) / imageRect.width;
    const dy = (event.clientY - drag.startY) / imageRect.height;
    const start = drag.crop;

    let next = { ...start };
    if (drag.grip === null) {
      // Moving the window, not resizing it: the extent is fixed and only the
      // origin travels, so the framing changes without the magnification.
      next = { ...start, x: start.x + dx, y: start.y + dy };
    } else {
      if (drag.grip.includes('w')) {
        next.x = start.x + dx;
        next.width = start.width - dx;
      }
      if (drag.grip.includes('e')) next.width = start.width + dx;
      if (drag.grip.includes('n')) {
        next.y = start.y + dy;
        next.height = start.height - dy;
      }
      if (drag.grip.includes('s')) next.height = start.height + dy;
    }

    // Normalised as it is dragged, so the outline can never show a rectangle
    // the model would refuse — what is on screen is what will be committed.
    setPending(normaliseCrop(next));
  };

  const endDrag = (): void => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !pending) return;

    setPending(null);
    // setImageCrop re-derives the scale bars: cropping changes how many source
    // pixels span the frame, which is the ratio a bar's length comes from.
    api.commit('Crop image', (draft) => {
      setImageCrop(draft, node.id, pending);
      reflowBrackets(draft, theme);
    });
  };

  const href = assetUrls[node.assetId];

  return (
    <div
      className="crop-overlay"
      style={box}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* The uncropped picture, covering whatever the SVG has drawn beneath.
          Without it the author would be outlining a region of the *result*
          while the model records a region of the *source*. */}
      {href && (
        <img
          className="crop-source"
          src={href}
          alt=""
          draggable={false}
          style={{
            left: imageRect.x,
            top: imageRect.y,
            width: imageRect.width,
            height: imageRect.height,
          }}
        />
      )}

      {/* Four dimmed bands rather than one box with a hole: a single element
          cannot both darken the discarded region and leave the kept region
          untinted, and tinting what is kept misrepresents the result. */}
      <div className="crop-shade" style={{ left: 0, top: 0, width: '100%', height: window.top }} />
      <div
        className="crop-shade"
        style={{
          left: 0,
          top: window.top + window.height,
          width: '100%',
          height: box.height - window.top - window.height,
        }}
      />
      <div
        className="crop-shade"
        style={{ left: 0, top: window.top, width: window.left, height: window.height }}
      />
      <div
        className="crop-shade"
        style={{
          left: window.left + window.width,
          top: window.top,
          width: box.width - window.left - window.width,
          height: window.height,
        }}
      />

      <div className="crop-window" style={window} onPointerDown={onGripDown(null)}>
        {CROP_GRIPS.map((grip) => (
          <div
            key={grip.id}
            className="crop-grip"
            data-grip={grip.id}
            style={{ left: `${grip.fx * 100}%`, top: `${grip.fy * 100}%` }}
            onPointerDown={onGripDown(grip.id)}
          />
        ))}
      </div>
    </div>
  );
}


/**
 * Drag a ruler across a feature of known length to calibrate the image.
 *
 * The workflow for every legacy micrograph: no metadata, but a scale bar
 * burned into the pixels by whatever software exported it. Measuring that bar
 * is the only way to recover the pixel size, and it is why an uncalibrated bar
 * does not have to stay uncalibrated.
 *
 * Reports the distance in *source image pixels*, so the answer is a property
 * of the micrograph and survives the panel being resized afterwards.
 */
function MeasureOverlay({
  doc,
  node,
  zoom,
  onMeasured,
}: {
  doc: FigureDocument;
  node: Extract<FigureNode, { type: 'image' }>;
  zoom: number;
  onMeasured: (imagePixels: number) => void;
}) {
  const [line, setLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const dragRef = useRef(false);

  const frame = absoluteFrame(doc.nodes, node.id);
  if (!frame) return null;

  const pxPerMm = PX_PER_MM * zoom;
  const box = {
    left: frame.x * pxPerMm,
    top: frame.y * pxPerMm,
    width: frame.width * pxPerMm,
    height: frame.height * pxPerMm,
  };

  // Screen pixels → source pixels. The visible span is what the crop retained,
  // so a measurement on a cropped image still refers to the original grid.
  const visiblePx = node.naturalPx.width * (node.crop.width || 1);
  const sourcePxPerScreenPx = box.width > 0 ? visiblePx / box.width : 0;

  const local = (event: React.PointerEvent): { x: number; y: number } => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const lengthPx = line
    ? Math.hypot(line.x2 - line.x1, line.y2 - line.y1) * sourcePxPerScreenPx
    : 0;

  return (
    <div
      className="measure-overlay"
      style={box}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        const point = local(e);
        dragRef.current = true;
        setLine({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!dragRef.current || !line) return;
        const point = local(e);
        setLine({ ...line, x2: point.x, y2: point.y });
      }}
      onPointerUp={() => {
        dragRef.current = false;
        if (lengthPx > 0) onMeasured(lengthPx);
      }}
    >
      <svg width={box.width} height={box.height}>
        {line && (
          <>
            <line
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="#ff2d55"
              strokeWidth={2}
            />
            {/* End caps, so the exact endpoints are visible against a busy
                micrograph rather than lost in it. */}
            {[
              [line.x1, line.y1],
              [line.x2, line.y2],
            ].map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r={4} fill="#fff" stroke="#ff2d55" strokeWidth={2} />
            ))}
          </>
        )}
      </svg>
      <span className="measure-readout">
        {line ? `${Math.round(lengthPx)} px` : 'Drag across a feature of known length'}
      </span>
    </div>
  );
}

/**
 * Millimetre side of the grid cell used to bucket points for hit-testing.
 *
 * A real gene list is 10,000+ rows; testing every one on every pointermove
 * would be the same DOM/CPU-volume problem `MAX_VECTOR_POINTS` rasterization
 * exists to avoid on the drawing side. Bucketing once per mount and touching
 * only the neighbouring cells on a move keeps picking cheap without that.
 */
const PICK_BUCKET_MM = 2;

/**
 * Direct point-picking for a volcano plot's labels.
 *
 * HTML above the SVG, never scene nodes — the crop/measure precedent: this is
 * editor state, not part of the drawing, and picking chrome would have no
 * parity guard against leaking into an export the way scene-node chrome does.
 *
 * Deliberately renders no per-point DOM at all below the hover ring and its
 * tooltip — a real gene list would otherwise put exactly the volume of nodes
 * on screen that the bake-to-raster mechanism exists to prevent.
 */
function PointPickOverlay({
  api,
  theme,
  node,
  zoom,
}: {
  api: DocumentApi;
  theme: Theme;
  node: PlotNode;
  zoom: number;
}) {
  const { document: doc } = api;
  const [hovered, setHovered] = useState<PickablePoint | null>(null);

  const points = useMemo(() => pickablePointsForPlot(node, doc, theme), [node, doc, theme]);
  const placedLabels = useMemo(() => placedPointLabelsForPlot(node, doc, theme), [node, doc, theme]);
  /**
   * A drag in progress on a placed label, or null. Dragging only ever makes
   * sense while this plot's picking mode is already open — the label isn't
   * an interactive target otherwise — so it's handled here rather than as a
   * second overlay/mode. `suppressClickRef` swallows the `click` a browser
   * fires right after the `pointerup` that ends a drag, or releasing the
   * label over a point would also toggle that point's own label.
   */
  const dragRef = useRef<{ text: string; startXmm: number; startYmm: number; base: { x: number; y: number } } | null>(
    null,
  );
  const suppressClickRef = useRef(false);
  const buckets = useMemo(() => {
    const map = new Map<string, PickablePoint[]>();
    for (const p of points) {
      const key = `${Math.floor(p.xMm / PICK_BUCKET_MM)}:${Math.floor(p.yMm / PICK_BUCKET_MM)}`;
      const bucket = map.get(key);
      if (bucket) bucket.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [points]);

  const frame = absoluteFrame(doc.nodes, node.id);
  if (!frame) return null;

  const pxPerMm = PX_PER_MM * zoom;
  const box = {
    left: frame.x * pxPerMm,
    top: frame.y * pxPerMm,
    width: frame.width * pxPerMm,
    height: frame.height * pxPerMm,
  };

  const atCap = (node.volcanoLabels?.length ?? 0) >= MAX_POINT_LABELS;

  const nearest = (event: {
    clientX: number;
    clientY: number;
    currentTarget: EventTarget & HTMLDivElement;
  }): PickablePoint | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const xMm = (event.clientX - rect.left) / pxPerMm;
    const yMm = (event.clientY - rect.top) / pxPerMm;
    const cx = Math.floor(xMm / PICK_BUCKET_MM);
    const cy = Math.floor(yMm / PICK_BUCKET_MM);
    let best: PickablePoint | null = null;
    let bestDist = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const p of buckets.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const dist = Math.hypot(p.xMm - xMm, p.yMm - yMm);
          if (dist <= Math.max(p.radiusMm, 1.2) && dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
      }
    }
    return best;
  };

  const labelAt = (event: {
    clientX: number;
    clientY: number;
    currentTarget: EventTarget & HTMLDivElement;
  }): PlacedPointLabel | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const xMm = (event.clientX - rect.left) / pxPerMm;
    const yMm = (event.clientY - rect.top) / pxPerMm;
    return (
      placedLabels.find(
        (l) => xMm >= l.rectMm.x0 && xMm <= l.rectMm.x1 && yMm >= l.rectMm.y0 && yMm <= l.rectMm.y1,
      ) ?? null
    );
  };

  // Cap enforced here too, not just in the Inspector's list: a click at the
  // cap is a no-op, and the tooltip already states why before the click.
  const toggle = (point: PickablePoint): void => {
    if (!point.labelled && atCap) return;
    api.commit(point.labelled ? 'Unlabel point' : 'Label point', (draft) => {
      const target = draft.nodes[node.id];
      if (target?.type !== 'plot') return;
      const current = target.volcanoLabels ?? [];
      target.volcanoLabels = point.labelled
        ? current.filter((l) => l !== point.label)
        : [...current, point.label];
    });
  };

  return (
    <div
      className="point-pick-overlay"
      style={box}
      onPointerDown={(e) => {
        const label = labelAt(e);
        if (label) {
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          const rect = e.currentTarget.getBoundingClientRect();
          dragRef.current = {
            text: label.text,
            startXmm: (e.clientX - rect.left) / pxPerMm,
            startYmm: (e.clientY - rect.top) / pxPerMm,
            base: node.pointLabelOffsets?.[label.text] ?? { x: 0, y: 0 },
          };
          suppressClickRef.current = true;
          return;
        }
        e.stopPropagation();
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current;
        if (drag) {
          const rect = e.currentTarget.getBoundingClientRect();
          const xMm = (e.clientX - rect.left) / pxPerMm;
          const yMm = (e.clientY - rect.top) / pxPerMm;
          const x = drag.base.x + (xMm - drag.startXmm);
          const y = drag.base.y + (yMm - drag.startYmm);
          // Committed every frame, matching how an ordinary node drag already
          // commits every pointermove — the offset is a plain accumulator
          // field, not an absolute frame needing a single final commit.
          api.commit('Move label', (draft) => {
            const target = draft.nodes[node.id];
            if (target?.type !== 'plot') return;
            target.pointLabelOffsets = { ...(target.pointLabelOffsets ?? {}), [drag.text]: { x, y } };
          });
          return;
        }
        setHovered(nearest(e));
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      onPointerLeave={() => {
        if (!dragRef.current) setHovered(null);
      }}
      onClick={(e) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        const point = nearest(e);
        if (point) toggle(point);
      }}
    >
      {hovered && (
        <>
          <div
            className={`point-pick-ring${hovered.labelled ? ' labelled' : ''}`}
            style={{
              left: hovered.xMm * pxPerMm - hovered.radiusMm * pxPerMm,
              top: hovered.yMm * pxPerMm - hovered.radiusMm * pxPerMm,
              width: hovered.radiusMm * 2 * pxPerMm,
              height: hovered.radiusMm * 2 * pxPerMm,
            }}
          />
          <div
            className="point-pick-tooltip"
            style={{ left: hovered.xMm * pxPerMm, top: hovered.yMm * pxPerMm }}
          >
            {!hovered.labelled && atCap
              ? '25 labels is the maximum — past that a key stops being readable and the leaders cross.'
              : hovered.label}
          </div>
        </>
      )}
    </div>
  );
}

/** Alignment guides drawn above the figure, never part of the document. */
function GuideOverlay({
  guides,
  doc,
  zoom,
}: {
  guides: AlignmentGuide[];
  doc: FigureDocument;
  zoom: number;
}) {
  if (guides.length === 0) return null;
  const pxPerMm = PX_PER_MM * zoom;

  return (
    <svg
      className="guide-overlay"
      width={doc.page.widthMm * pxPerMm}
      height={doc.page.heightMm * pxPerMm}
    >
      {guides.map((guide, i) => (
        <line
          key={i}
          x1={guide.axis === 'x' ? guide.position * pxPerMm : 0}
          x2={guide.axis === 'x' ? guide.position * pxPerMm : doc.page.widthMm * pxPerMm}
          y1={guide.axis === 'y' ? guide.position * pxPerMm : 0}
          y2={guide.axis === 'y' ? guide.position * pxPerMm : doc.page.heightMm * pxPerMm}
          stroke={guide.kind === 'page' ? '#ff9500' : '#ff2d55'}
          strokeWidth={1}
          strokeDasharray="3 2"
        />
      ))}
    </svg>
  );
}

/** Absolute frame of a node, for the dimension readout. */
export function frameOf(doc: FigureDocument, id: NodeId): RectMm | null {
  return absoluteFrame(doc.nodes, id);
}
