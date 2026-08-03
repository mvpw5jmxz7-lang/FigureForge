/**
 * Ship only the pixels a cropped image actually shows.
 *
 * `renderImage` implements a crop geometrically: it draws the image oversized
 * and offset, then confines it with a `clipPath`. That is the right thing for
 * the canvas — every retained pixel keeps the resolution it was captured at,
 * which is why `parity.test.tsx` pins it — but it means an export embeds the
 * whole asset and throws 90% of it away at the far end. A 100 MP micrograph
 * cropped to a tenth still base64s 100 MP into the POST body.
 *
 * The repair is deliberately *outside* the renderer. `packages/render` must
 * stay a synchronous, DOM-free pure function of the document; re-encoding
 * pixels is neither. So the app builds a throwaway document in which each
 * cropped raster node points at a synthetic asset holding just its crop, with
 * `crop` reset and `naturalPx` restated. The renderer sees an ordinary
 * uncropped image and needs no knowledge of any of this.
 *
 * The transform is value-preserving, not lossy: `naturalPx.width * crop.width`
 * — the quantity `checkImageResolution` and `scaleBarWidthMm` both compute — is
 * held exactly invariant, so the effective dpi and every calibrated length are
 * the same before and after.
 */

import {
  FULL_CROP,
  editDocument,
  type AssetId,
  type FigureDocument,
  type ImageNode,
} from '@figureforge/doc-model';
import { bytesToBase64, type AssetStore } from './assets.js';

/** MIME types with no pixel grid, so nothing to crop. Mirrors the checker's. */
const VECTOR_MIME_TYPES = new Set(['image/svg+xml', 'application/pdf', 'application/postscript']);

/**
 * How far the cropped source's aspect may differ from the frame's before the
 * re-encode stops being exact. Half a percent is well inside a rounding error
 * on a real micrograph and well outside a genuine letterbox.
 */
const ASPECT_TOLERANCE = 0.005;

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropPlan {
  nodeId: string;
  assetId: AssetId;
  /** Synthetic asset the throwaway document will point this node at. */
  cropAssetId: AssetId;
  /** Region of the source to keep, in source pixels. */
  rect: PixelRect;
  /** What `naturalPx` becomes — exactly the pixels retained. */
  naturalPx: { width: number; height: number };
}

/**
 * Which image nodes can have their crop baked in, and to what.
 *
 * Pure and synchronous so the geometry is testable without a DOM — the vitest
 * config runs in `environment: 'node'` on purpose, and that default is the
 * guard that stops an accidental DOM import into `packages/render` passing.
 */
export function planCropReencode(doc: FigureDocument): CropPlan[] {
  const plans: CropPlan[] = [];

  for (const node of Object.values(doc.nodes)) {
    if (node.type !== 'image') continue;
    const image = node as ImageNode;

    const asset = doc.assets.find((a) => a.id === image.assetId);
    // A vector asset has no pixel grid; rasterising it here would throw away
    // the one property that makes it worth placing.
    if (!asset || VECTOR_MIME_TYPES.has(asset.mimeType)) continue;

    const { x, y, width, height } = image.crop;
    if (x === 0 && y === 0 && width === 1 && height === 1) continue;
    if (width <= 0 || height <= 0) continue;

    const { width: nw, height: nh } = image.naturalPx;
    if (nw <= 0 || nh <= 0) continue;

    /*
     * The one case where the nominal crop is not what the reader sees.
     *
     * In the cropped branch `preserveAspectRatio="xMidYMid meet"` applies to
     * the *oversized* box, not to the frame. When the cropped source and the
     * frame share an aspect, `meet` is a no-op and the visible window is
     * exactly the crop rect. When they do not, the source is letterboxed inside
     * that oversized box and the window shows a different region — so baking
     * the nominal crop would change what is drawn. Ship it as today instead.
     *
     * (With `preserveAspect` false the source is stretched to fill the box and
     * the mapping is exact either way.) The exact generalisation is to compute
     * the letterboxed sub-rect and require the window to be fully covered by
     * drawn pixels; that is more code for a case "Fit frame to image" already
     * resolves, so it is noted rather than built.
     */
    if (image.preserveAspect) {
      const croppedAspect = (nw * width) / (nh * height);
      const frameAspect = image.frame.width / image.frame.height;
      if (frameAspect <= 0 || Math.abs(croppedAspect / frameAspect - 1) > ASPECT_TOLERANCE) {
        continue;
      }
    }

    const rect: PixelRect = {
      x: Math.round(x * nw),
      y: Math.round(y * nh),
      width: Math.max(1, Math.round(width * nw)),
      height: Math.max(1, Math.round(height * nh)),
    };

    plans.push({
      nodeId: image.id,
      assetId: image.assetId,
      // Keyed by *node*, not by asset: two nodes may crop one asset
      // differently, which is exactly why `imagesUsingAsset` exists.
      cropAssetId: `${image.assetId}-crop-${image.id}` as AssetId,
      rect,
      naturalPx: { width: rect.width, height: rect.height },
    });
  }

  return plans;
}

/**
 * Re-encode a region of an image as PNG.
 *
 * PNG always. The browser only ever holds the *display* bytes — already an
 * 8-bit PNG proxy for TIFF, the original file otherwise — and a canvas decodes
 * to 8-bit RGBA regardless, so PNG is lossless with respect to what was going
 * to be exported anyway. Re-encoding a JPEG as JPEG would be a second lossy
 * generation over an already-lossy source, visible as ringing on the
 * high-contrast edges micrographs are full of, to save bytes the crop has
 * already saved. Where PNG does come out larger, the caller keeps the original.
 */
export async function encodeCrop(
  bytes: Uint8Array,
  mimeType: string,
  rect: PixelRect,
): Promise<Uint8Array> {
  // The crop rect is positional on `createImageBitmap`; there is no options
  // form of it, and passing one silently decodes the whole image instead.
  const bitmap = await createImageBitmap(
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');
    context.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

export interface FlattenedExport {
  document: FigureDocument;
  resolve: (assetId: AssetId) => string | undefined;
  /** Bytes saved, for the caller to report. Zero when nothing was re-encoded. */
  savedBytes: number;
}

/**
 * Build the document that is actually exported.
 *
 * Never `api.commit`: this document must not enter the undo history and must
 * never be saved. And never `AssetStore.add`, because `archiveMap` iterates
 * `document.assets` and pulls store entries — a synthetic asset placed in the
 * store would be written into every save from then on. The data URIs travel in
 * an override map instead, composed over the ordinary resolver.
 *
 * A failure to re-encode one image is not a failure to export: that node keeps
 * its original bytes and its geometric crop, which is what the app did before
 * this existed.
 */
export async function flattenCropsForExport(
  doc: FigureDocument,
  store: AssetStore,
  fallbackResolve: (assetId: AssetId) => string | undefined,
  onWarn?: (message: string) => void,
): Promise<FlattenedExport> {
  const plans = planCropReencode(doc);
  if (plans.length === 0) return { document: doc, resolve: fallbackResolve, savedBytes: 0 };

  const overrides = new Map<AssetId, string>();
  const applied: CropPlan[] = [];
  let savedBytes = 0;

  for (const plan of plans) {
    const source = store.displayBytes(plan.assetId);
    if (!source) continue;
    try {
      const cropped = await encodeCrop(source.bytes, source.mimeType, plan.rect);
      // A photographic crop can encode larger as PNG than the whole JPEG did.
      // Both are correct — the clip path still shows the same pixels — so keep
      // whichever is smaller.
      if (cropped.length >= source.bytes.length) continue;
      overrides.set(plan.cropAssetId, `data:image/png;base64,${bytesToBase64(cropped)}`);
      savedBytes += source.bytes.length - cropped.length;
      applied.push(plan);
    } catch (caught) {
      onWarn?.(
        `Could not shrink the cropped image "${plan.nodeId}": ${String(caught)}. ` +
          'Exporting it at full size instead.',
      );
    }
  }

  if (applied.length === 0) return { document: doc, resolve: fallbackResolve, savedBytes: 0 };

  const document = editDocument(doc, (draft) => {
    for (const plan of applied) {
      const node = draft.nodes[plan.nodeId];
      if (!node || node.type !== 'image') continue;
      const source = draft.assets.find((a) => a.id === plan.assetId);

      // A synthetic Asset record, so `findAsset` stays truthful — both
      // `renderImage` and `checkImageResolution` resolve the MIME type through
      // it, and a node pointing at an asset that is not there renders as a
      // placeholder.
      draft.assets = [
        ...draft.assets,
        {
          id: plan.cropAssetId,
          filename: source?.filename ?? 'crop.png',
          mimeType: 'image/png',
          path: `data/${plan.cropAssetId}.png`,
          byteLength: 0,
          naturalPx: plan.naturalPx,
        },
      ];

      node.assetId = plan.cropAssetId;
      node.crop = { ...FULL_CROP };
      node.naturalPx = plan.naturalPx;
    }
  });

  return {
    document,
    resolve: (assetId) => overrides.get(assetId) ?? fallbackResolve(assetId),
    savedBytes,
  };
}
