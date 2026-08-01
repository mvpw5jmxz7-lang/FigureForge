/**
 * The figure canvas.
 *
 * Renders the document through the shared scene tree, so what appears here is
 * the same geometry the exporter will serialise. Zoom, selection and drag are
 * canvas concerns only — none of them touch the scene.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  absoluteFrame,
  isEffectivelyLocked,
  snapFrame,
  type AlignmentGuide,
  type FigureDocument,
  type NodeId,
  type RectMm,
} from '@figureforge/doc-model';
import { renderDocument, toReact } from '@figureforge/render';
import type { Theme } from '@figureforge/theme';
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
}

interface DragState {
  nodeId: NodeId;
  startClientX: number;
  startClientY: number;
  originalFrames: Map<NodeId, RectMm>;
}

export function Canvas({
  api,
  theme,
  selectedIds,
  onSelectionChange,
  zoom,
  showGrid,
  assetUrls,
}: CanvasProps) {
  const { document: doc } = api;
  const [guides, setGuides] = useState<AlignmentGuide[]>([]);
  const dragRef = useRef<DragState | null>(null);

  const resolveAsset = useCallback((assetId: string) => assetUrls[assetId], [assetUrls]);

  const scene = renderDocument(doc, {
    theme,
    resolveAsset,
    chrome: { selectedIds, showGrid },
  });

  // --- selection ----------------------------------------------------------

  const handlePointerDown = useCallback(
    (nodeId: NodeId, event: React.PointerEvent) => {
      const additive = event.shiftKey || event.metaKey;
      const next = additive
        ? selectedIds.includes(nodeId)
          ? selectedIds.filter((id) => id !== nodeId)
          : [...selectedIds, nodeId]
        : [nodeId];

      onSelectionChange(next);

      if (isEffectivelyLocked(doc.nodes, nodeId)) return;

      const frames = new Map<NodeId, RectMm>();
      for (const id of next) {
        const node = doc.nodes[id];
        if (node) frames.set(id, node.frame);
      }

      dragRef.current = {
        nodeId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        originalFrames: frames,
      };
      (event.target as Element).setPointerCapture?.(event.pointerId);
    },
    [doc, selectedIds, onSelectionChange],
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

      const snapped = snapFrame(moved, {
        others: siblings,
        pageWidthMm: doc.page.widthMm,
        pageHeightMm: doc.page.heightMm,
        gridSpacingMm: doc.grid.spacingMm,
        snapToGrid: doc.grid.snap && !event.altKey,
        smartGuides: doc.grid.smartGuides && !event.altKey,
        toleranceMm: doc.grid.toleranceMm / zoom,
      });

      setGuides(snapped.guides);

      const appliedDx = snapped.frame.x - primaryOriginal.x;
      const appliedDy = snapped.frame.y - primaryOriginal.y;

      api.commit('Move', (draft) => {
        for (const [id, original] of drag.originalFrames) {
          const node = draft.nodes[id];
          if (!node || isEffectivelyLocked(draft.nodes, id)) continue;
          node.frame = { ...original, x: original.x + appliedDx, y: original.y + appliedDy };
        }
      });
    },
    [api, doc, zoom],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setGuides([]);
  }, []);

  // --- keyboard nudging ---------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (selectedIds.length === 0) return;

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
          if (!node || isEffectivelyLocked(draft.nodes, id)) continue;
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
  }, [api, doc.grid.spacingMm, selectedIds]);

  // --- rendering ----------------------------------------------------------

  const widthPx = doc.page.widthMm * PX_PER_MM * zoom;
  const heightPx = doc.page.heightMm * PX_PER_MM * zoom;

  return (
    <div className="canvas-scroll" onPointerDown={() => onSelectionChange([])}>
      <div
        className="canvas-page"
        style={{ width: widthPx, height: heightPx }}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {toReact(scene, {
          onNodePointerDown: handlePointerDown,
          selectedIds: new Set(selectedIds),
        })}
        <GuideOverlay guides={guides} doc={doc} zoom={zoom} />
      </div>
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
