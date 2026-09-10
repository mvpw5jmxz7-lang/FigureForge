/**
 * Pixels for a plot whose point count exceeds `MAX_VECTOR_POINTS`.
 *
 * `packages/render` must stay a synchronous, DOM-free pure function of the
 * document — `planPointClouds` there only says what a raster needs to be.
 * Turning that into actual pixels needs `OffscreenCanvas`, which is neither,
 * so it happens here, the same split `exportImages.ts` already uses for
 * cropped micrographs.
 *
 * Unlike a crop, a point cloud's volume is a problem on the *live* canvas
 * too — a 100k-point scatter would already choke `toReact`'s DOM before
 * export is ever clicked — so this bakes once and is read by both paths
 * from one shared store, rather than baking only at export time.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { findDataset, type FigureDocument, type PlotNode } from '@figureforge/doc-model';
import { planPointClouds, type PointCloudPlan, type PointCloudSeries } from '@figureforge/render';
import type { Theme } from '@figureforge/theme';
import { bytesToBase64 } from './assets.js';

/**
 * A fixed, generous resolution rather than the live export-dpi dropdown.
 * Ghostscript's `eps2write` resamples an embedded raster to the export
 * device resolution regardless (see CLAUDE.md's export traps), so
 * downsampling a raster baked at the dropdown's ceiling is always safe and
 * upsampling a thinner one would not be — baking once here avoids threading
 * `dpi` into the cache key for no benefit.
 */
export const POINT_RASTER_DPI = 600;

const MM_PER_INCH = 25.4;

function drawPoint(
  ctx: OffscreenCanvasRenderingContext2D,
  series: PointCloudSeries,
  x: number,
  y: number,
  /** Per-point override, e.g. a volcano plot's significance category colour — resolved once in `packages/render`. */
  color?: string,
): void {
  // Every shape is area-matched to the circle of the same nominal size, the
  // same formulas `markerNode` uses, so switching shape does not silently
  // change how heavy a series looks against the vector path it stands in for.
  const r = series.sizeMm / 2;
  ctx.beginPath();
  switch (series.shape) {
    case 'square': {
      const side = r * Math.sqrt(Math.PI);
      ctx.rect(x - side / 2, y - side / 2, side, side);
      break;
    }
    case 'triangle': {
      const side = r * Math.sqrt((4 * Math.PI) / Math.sqrt(3));
      const height = (side * Math.sqrt(3)) / 2;
      ctx.moveTo(x, y - (2 / 3) * height);
      ctx.lineTo(x + side / 2, y + height / 3);
      ctx.lineTo(x - side / 2, y + height / 3);
      ctx.closePath();
      break;
    }
    case 'triangle-down': {
      const side = r * Math.sqrt((4 * Math.PI) / Math.sqrt(3));
      const height = (side * Math.sqrt(3)) / 2;
      ctx.moveTo(x, y + (2 / 3) * height);
      ctx.lineTo(x + side / 2, y - height / 3);
      ctx.lineTo(x - side / 2, y - height / 3);
      ctx.closePath();
      break;
    }
    case 'diamond': {
      const half = r * Math.sqrt(Math.PI / 2);
      ctx.moveTo(x, y - half);
      ctx.lineTo(x + half, y);
      ctx.lineTo(x, y + half);
      ctx.lineTo(x - half, y);
      ctx.closePath();
      break;
    }
    case 'pentagon': {
      const rPent = r * Math.sqrt((2 * Math.PI) / (5 * Math.sin((2 * Math.PI) / 5)));
      for (let k = 0; k < 5; k++) {
        const angle = ((-90 + k * 72) * Math.PI) / 180;
        const px = x + rPent * Math.cos(angle);
        const py = y + rPent * Math.sin(angle);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'cross': {
      const span = 3 * r * Math.sqrt(Math.PI / 5);
      const half = span / 2;
      const armHalf = span / 6;
      ctx.moveTo(x + armHalf, y - half);
      ctx.lineTo(x + armHalf, y - armHalf);
      ctx.lineTo(x + half, y - armHalf);
      ctx.lineTo(x + half, y + armHalf);
      ctx.lineTo(x + armHalf, y + armHalf);
      ctx.lineTo(x + armHalf, y + half);
      ctx.lineTo(x - armHalf, y + half);
      ctx.lineTo(x - armHalf, y + armHalf);
      ctx.lineTo(x - half, y + armHalf);
      ctx.lineTo(x - half, y - armHalf);
      ctx.lineTo(x - armHalf, y - armHalf);
      ctx.lineTo(x - armHalf, y - half);
      ctx.closePath();
      break;
    }
    case 'star': {
      const innerRatio = (3 - Math.sqrt(5)) / 2;
      const outerR = r * Math.sqrt(Math.PI / (5 * innerRatio * Math.sin(Math.PI / 5)));
      const innerR = outerR * innerRatio;
      for (let k = 0; k < 10; k++) {
        const radius = k % 2 === 0 ? outerR : innerR;
        const angle = ((-90 + k * 36) * Math.PI) / 180;
        const px = x + radius * Math.cos(angle);
        const py = y + radius * Math.sin(angle);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    default:
      ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  // `'none'` is a hollow marker — `ctx.fillStyle = 'none'` is invalid and would
  // silently keep the previous colour. `planPointClouds` supplies `series.stroke`
  // for the visible edge in that case.
  if ((color ?? series.color) !== 'none') {
    ctx.fillStyle = color ?? series.color;
    ctx.fill();
  }
  if (series.stroke) {
    ctx.strokeStyle = series.stroke.color;
    ctx.lineWidth = series.stroke.widthMm;
    ctx.stroke();
  }
}

/** Draws every series' points into one PNG, at `dpi`, as a self-contained data URI. */
export async function bakePointCloud(
  plan: PointCloudPlan,
  dpi: number = POINT_RASTER_DPI,
): Promise<string> {
  const scale = dpi / MM_PER_INCH;
  const width = Math.max(1, Math.round(plan.widthMm * scale));
  const height = Math.max(1, Math.round(plan.heightMm * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.scale(scale, scale);

  for (const series of plan.series) {
    for (const point of series.points) drawPoint(ctx, series, point.x, point.y, point.color);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

interface Entry {
  /** Staleness key: the exact objects this href was baked from. */
  node: PlotNode;
  dataset: unknown;
  theme: Theme;
  href?: string;
  pending?: Promise<string>;
}

/**
 * Cache of baked rasters, one entry per plot node id.
 *
 * Keyed on object identity — sound for the same reason `measurePlot`'s cache
 * is: edits go through Immer, so a plot, its dataset or the theme changing
 * produces a new object, and a stale entry simply misses and rebakes.
 *
 * A single instance is shared by the live canvas and by export (both read it
 * through the hook/functions below), so the identical base64 PNG lands in
 * both the on-screen `<image href>` and the exported one — a stronger
 * WYSIWYG guarantee than keeping two live drawing paths in sync.
 */
export class PointRasterStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  private isCurrent(entry: Entry | undefined, node: PlotNode, dataset: unknown, theme: Theme): entry is Entry {
    return !!entry && entry.node === node && entry.dataset === dataset && entry.theme === theme;
  }

  /** Whatever href is ready right now for this node; undefined if stale, pending or never baked. */
  get(nodeId: string, node: PlotNode, dataset: unknown, theme: Theme): string | undefined {
    const entry = this.entries.get(nodeId);
    return this.isCurrent(entry, node, dataset, theme) ? entry.href : undefined;
  }

  /** Bake if needed, dedupe concurrent callers for the same node, resolve once ready. */
  async ensure(
    plan: PointCloudPlan,
    node: PlotNode,
    dataset: unknown,
    theme: Theme,
    dpi: number = POINT_RASTER_DPI,
  ): Promise<string> {
    const existing = this.entries.get(plan.nodeId);
    if (this.isCurrent(existing, node, dataset, theme)) {
      if (existing.href) return existing.href;
      if (existing.pending) return existing.pending;
    }

    const pending = bakePointCloud(plan, dpi);
    this.entries.set(plan.nodeId, { node, dataset, theme, pending });
    const href = await pending;
    this.entries.set(plan.nodeId, { node, dataset, theme, href });
    this.emit();
    return href;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Monotonic; the snapshot `useSyncExternalStore` compares. */
  version(): number {
    return this.revision;
  }

  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

/** Bake every plan for `doc` and resolve only once all are ready — the export path's entry point. */
export async function bakeAllPointClouds(
  doc: FigureDocument,
  theme: Theme,
  store: PointRasterStore,
): Promise<ReadonlyMap<string, string>> {
  const map = new Map<string, string>();
  for (const plan of planPointClouds(doc, theme)) {
    const node = doc.nodes[plan.nodeId];
    if (!node || node.type !== 'plot') continue;
    const dataset = findDataset(doc, node.datasetId);
    map.set(plan.nodeId, await store.ensure(plan, node, dataset, theme));
  }
  return map;
}

export interface PointCloudRastersApi {
  /** Whatever hrefs are ready now, keyed by plot node id — for the live canvas. */
  rasters: ReadonlyMap<string, string>;
  /** Bake every plan for `doc` and resolve once all are ready — for export. */
  bakeAll: (doc: FigureDocument) => Promise<ReadonlyMap<string, string>>;
}

export function usePointCloudRasters(doc: FigureDocument, theme: Theme): PointCloudRastersApi {
  const storeRef = useRef<PointRasterStore | null>(null);
  storeRef.current ??= new PointRasterStore();
  const store = storeRef.current;

  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const version = useSyncExternalStore(
    subscribe,
    () => store.version(),
    () => store.version(),
  );

  const plans = useMemo(() => planPointClouds(doc, theme), [doc, theme]);

  // Never during render: baking is async, and firing it from a useMemo would
  // run it again on every render that recomputes `plans` speculatively.
  useEffect(() => {
    for (const plan of plans) {
      const node = doc.nodes[plan.nodeId];
      if (!node || node.type !== 'plot') continue;
      const dataset = findDataset(doc, node.datasetId);
      void store.ensure(plan, node, dataset, theme);
    }
  }, [plans, doc, theme, store]);

  const rasters = useMemo(() => {
    const map = new Map<string, string>();
    for (const plan of plans) {
      const node = doc.nodes[plan.nodeId];
      if (!node || node.type !== 'plot') continue;
      const dataset = findDataset(doc, node.datasetId);
      const href = store.get(plan.nodeId, node, dataset, theme);
      if (href) map.set(plan.nodeId, href);
    }
    return map;
    // `version` drives this even though the body does not name it: it is the
    // signal that the store gained a href a bake finished after this render.
  }, [plans, doc, theme, store, version]);

  const bakeAll = useCallback(
    (target: FigureDocument) => bakeAllPointClouds(target, theme, store),
    [store, theme],
  );

  return { rasters, bakeAll };
}
