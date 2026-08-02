/**
 * Turning a file the user picked into an asset the model can reference.
 *
 * Lives in `apps/web` because it needs the DOM — `createImageBitmap` and
 * `DOMParser`. The render package must never reach for either, which is what
 * keeps the canvas and the headless exporter producing the same drawing.
 */

import type { AssetBytes } from './assets.js';
import { decodeImage } from './api.js';

/** What the file picker offers, and what `importImage` will actually accept. */
export const ACCEPTED_IMAGE_TYPES = '.png,.jpg,.jpeg,.tif,.tiff,.svg,image/png,image/jpeg,image/tiff,image/svg+xml';

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
};

/** Formats the browser can draw unaided. Anything else needs the API. */
const BROWSER_NATIVE = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);

export interface ImportedImage {
  bytes: AssetBytes;
  filename: string;
  /** Null for vector sources, which have no intrinsic pixel grid. */
  naturalPx: { width: number; height: number } | null;
  /** Aspect ratio (w/h) for sizing the initial frame. */
  aspect: number;
  /** Calibration read from the file, when it states one. */
  calibration?: { pixelsPerUnit: number; unitLabel: string };
  /** Anything the author should know, e.g. a bit-depth reduction. */
  notes: string[];
}

/**
 * The file's MIME type, falling back to its extension.
 *
 * Browsers routinely report `''` for `.tif`, and some report
 * `application/octet-stream`, so trusting `file.type` alone rejects exactly the
 * format microscopy uses most.
 */
export function mimeTypeOf(file: File): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[extension] ?? (file.type || 'application/octet-stream');
}

/**
 * Intrinsic size of an SVG, from its own viewBox or width/height.
 *
 * Used *only* to shape the initial frame, and deliberately not stored: writing
 * it to `naturalPx` would make the resolution check fire on vector content, so
 * a 100×100 logo placed 40 mm wide would be reported as 63 dpi and the author
 * told to shrink it. Confidently wrong advice is worse than no advice.
 */
export function svgAspect(source: string): number {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  const svg = parsed.querySelector('svg');
  if (!svg) return 1;

  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2]! > 0 && parts[3]! > 0) return parts[2]! / parts[3]!;
  }

  const width = Number.parseFloat(svg.getAttribute('width') ?? '');
  const height = Number.parseFloat(svg.getAttribute('height') ?? '');
  return Number.isFinite(width) && Number.isFinite(height) && height > 0 ? width / height : 1;
}

async function measureRaster(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ width: number; height: number }> {
  const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    // Bitmaps hold decoded pixels; without this a montage import keeps every
    // one of them alive until the collector happens to run.
    bitmap.close();
  }
}

export class UnsupportedImageError extends Error {
  constructor(mimeType: string, filename: string) {
    super(
      `${filename} is not a supported image (${mimeType}). ` +
        'Use PNG, JPEG, TIFF or SVG — PDF and EPS must be converted first.',
    );
    this.name = 'UnsupportedImageError';
  }
}

/**
 * Read a picked file into everything needed to register an asset.
 *
 * The original bytes are kept verbatim in every case. For TIFF the API returns
 * a PNG proxy for display and export; the archive still stores the TIFF.
 */
export async function importImage(file: File): Promise<ImportedImage> {
  const mimeType = mimeTypeOf(file);
  const original = new Uint8Array(await file.arrayBuffer());

  if (!BROWSER_NATIVE.has(mimeType) && mimeType !== 'image/tiff') {
    throw new UnsupportedImageError(mimeType, file.name);
  }

  if (mimeType === 'image/svg+xml') {
    return {
      bytes: { original, mimeType, display: original, displayMimeType: mimeType },
      filename: file.name,
      // Vector: no pixel grid, so no resolution the checker could judge.
      naturalPx: null,
      aspect: svgAspect(new TextDecoder().decode(original)),
      notes: [],
    };
  }

  if (mimeType === 'image/tiff') {
    // Browsers do not decode TIFF. The proxy is for drawing only — `original`
    // is what reaches the archive, so the 16-bit data is not lost even though
    // the figure ships an 8-bit rendering of it.
    const decoded = await decodeImage(file);
    return {
      bytes: {
        original,
        mimeType,
        display: decoded.png,
        displayMimeType: 'image/png',
      },
      filename: file.name,
      naturalPx: { width: decoded.width, height: decoded.height },
      aspect: decoded.height > 0 ? decoded.width / decoded.height : 1,
      ...(decoded.calibration ? { calibration: decoded.calibration } : {}),
      notes: decoded.notes,
    };
  }

  const naturalPx = await measureRaster(original, mimeType);
  return {
    bytes: { original, mimeType, display: original, displayMimeType: mimeType },
    filename: file.name,
    naturalPx,
    aspect: naturalPx.height > 0 ? naturalPx.width / naturalPx.height : 1,
    notes: [],
  };
}

/**
 * Frame for a newly inserted image, fitted to the page.
 *
 * Sized from the aspect ratio rather than dropped in at a fixed rectangle: an
 * image inserted at the wrong shape either letterboxes or has to be corrected
 * by hand before anything else can be judged.
 */
export function initialImageFrame(
  aspect: number,
  pageWidthMm: number,
  pageHeightMm: number,
): { x: number; y: number; width: number; height: number } {
  const maxWidth = Math.min(80, pageWidthMm - 8);
  const maxHeight = Math.min(70, pageHeightMm - 8);

  let width = maxWidth;
  let height = width / (aspect > 0 ? aspect : 1);
  if (height > maxHeight) {
    height = maxHeight;
    width = height * (aspect > 0 ? aspect : 1);
  }
  return { x: 4, y: 4, width, height };
}
