/**
 * Which crops can be baked into their own pixels before export, and what the
 * result must preserve.
 *
 * Only `planCropReencode` is covered: it is the half that decides, and it is
 * pure. `encodeCrop` needs `createImageBitmap` and `OffscreenCanvas`, so it is
 * driven in the real browser instead — the vitest config runs in
 * `environment: 'node'` on purpose, because a jsdom default would let an
 * accidental DOM import into `packages/render` pass, which is the one thing
 * that breaks export fidelity invisibly.
 */

import { describe, expect, it } from 'vitest';
import {
  addAsset,
  addImage,
  createDocument,
  createIdFactory,
  editDocument,
  effectiveDpi,
  type FigureDocument,
  type ImageNode,
} from '@figureforge/doc-model';
import { planCropReencode } from './exportImages.js';

interface Options {
  crop?: { x?: number; y?: number; width?: number; height?: number };
  preserveAspect?: boolean;
  mimeType?: string;
  naturalPx?: { width: number; height: number };
  /** Frame, in mm. Defaults to the same aspect as the cropped source. */
  frame?: { width: number; height: number };
  /** Add a second node over the same asset, cropped differently. */
  second?: { x?: number; y?: number; width?: number; height?: number };
}

function makeDocument(options: Options = {}): FigureDocument {
  const newId = createIdFactory();
  const naturalPx = options.naturalPx ?? { width: 1000, height: 800 };
  const crop = { x: 0, y: 0, width: 1, height: 1, ...options.crop };
  const frame = options.frame ?? {
    width: 50,
    height: (50 * (naturalPx.height * crop.height)) / (naturalPx.width * crop.width),
  };

  return editDocument(
    createDocument({
      widthMm: 183,
      heightMm: 120,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    }),
    (draft) => {
      addAsset(draft, {
        id: 'asset-1',
        filename: 'cells.png',
        mimeType: options.mimeType ?? 'image/png',
        byteLength: 4096,
        naturalPx,
      });
      addImage(draft, newId, {
        assetId: 'asset-1',
        frame: { x: 2, y: 2, ...frame },
        naturalPx,
        crop,
        preserveAspect: options.preserveAspect ?? true,
      });
      if (options.second) {
        addImage(draft, newId, {
          assetId: 'asset-1',
          frame: { x: 80, y: 2, ...frame },
          naturalPx,
          crop: options.second,
          preserveAspect: false,
        });
      }
    },
  );
}

describe('choosing which crops to bake in', () => {
  it('plans nothing for an uncropped image', () => {
    // Re-encoding a full image buys nothing and costs a lossy decode.
    expect(planCropReencode(makeDocument())).toEqual([]);
  });

  it('plans the crop when the source and frame share an aspect', () => {
    const doc = makeDocument({ crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } });
    const plans = planCropReencode(doc);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.rect).toEqual({ x: 250, y: 400, width: 500, height: 200 });
  });

  it('skips a vector asset, which has no pixel grid to crop', () => {
    const doc = makeDocument({
      mimeType: 'image/svg+xml',
      crop: { width: 0.5, height: 0.5 },
    });
    expect(planCropReencode(doc)).toEqual([]);
  });

  it('bakes a letterboxed crop, which it used to refuse', () => {
    /*
     * This was skipped while `renderImage` centred the source inside the
     * *oversized* box: under an aspect mismatch the drawn window was not the
     * crop the document named, so baking the nominal rect would have changed
     * the picture. The renderer now fits the cropped aspect to the frame, and
     * the baked form — an uncropped image of just those pixels — letterboxes
     * into the very same rectangle. Same picture, without shipping the
     * discarded pixels.
     *
     * A montage tile is this case by construction: `addPanelWithImages` sets
     * `aspectLock: null`, so its cells never match the micrograph.
     */
    const doc = makeDocument({
      crop: { width: 0.5, height: 0.5 },
      preserveAspect: true,
      frame: { width: 50, height: 10 },
    });
    expect(planCropReencode(doc)).toHaveLength(1);
  });

  it('bakes a stretched image too', () => {
    // With `preserveAspect: false` the source fills the box, so the window is
    // exactly the crop rect whatever the aspects are.
    const doc = makeDocument({
      crop: { width: 0.5, height: 0.5 },
      preserveAspect: false,
      frame: { width: 50, height: 10 },
    });
    expect(planCropReencode(doc)).toHaveLength(1);
  });

  it('keys the synthetic asset by node, so two crops of one source do not collide', () => {
    // `imagesUsingAsset` exists because one asset placed twice is a real case.
    // Keyed by asset, the second crop would overwrite the first.
    const doc = makeDocument({
      crop: { width: 0.5, height: 0.5 },
      preserveAspect: false,
      frame: { width: 50, height: 40 },
      second: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    });
    const plans = planCropReencode(doc);
    expect(plans).toHaveLength(2);
    expect(new Set(plans.map((p) => p.cropAssetId)).size).toBe(2);
    expect(plans.every((p) => p.assetId === 'asset-1')).toBe(true);
  });
});

describe('what the transform must preserve', () => {
  /**
   * The value claim, stated as an equality rather than described.
   *
   * `checkImageResolution`, `scaleBarWidthMm` and the Inspector all compute
   * `naturalPx.width * crop.width` — the pixels actually on show. If the
   * transform changed that number it would change the reported dpi and every
   * calibrated length with it, which is the opposite of value-preserving.
   */
  it('holds the visible pixel count exactly invariant', () => {
    for (const crop of [
      { x: 0.25, y: 0.5, width: 0.5, height: 0.25 },
      { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      { x: 0, y: 0, width: 0.333, height: 0.333 },
    ]) {
      const doc = makeDocument({ crop });
      const before = Object.values(doc.nodes).find((n) => n.type === 'image') as ImageNode;
      const plan = planCropReencode(doc)[0]!;

      expect(plan.naturalPx.width).toBe(
        Math.round(before.naturalPx.width * before.crop.width),
      );
      expect(plan.naturalPx.height).toBe(
        Math.round(before.naturalPx.height * before.crop.height),
      );
    }
  });

  it('leaves the effective dpi unchanged', () => {
    const doc = makeDocument({ crop: { x: 0.25, width: 0.5, height: 0.25, y: 0.5 } });
    const before = Object.values(doc.nodes).find((n) => n.type === 'image') as ImageNode;
    const plan = planCropReencode(doc)[0]!;

    const dpiBefore = effectiveDpi(before.naturalPx.width * before.crop.width, before.frame.width);
    const dpiAfter = effectiveDpi(plan.naturalPx.width, before.frame.width);
    expect(dpiAfter).toBeCloseTo(dpiBefore, 6);
  });

  it('never plans a zero-pixel region', () => {
    // `MIN_CROP` bounds the crop away from zero, but rounding a sliver of a
    // small source could still land on 0 — an image of no pixels at all.
    const doc = makeDocument({
      naturalPx: { width: 20, height: 20 },
      crop: { width: 0.01, height: 0.01 },
      preserveAspect: false,
    });
    const plan = planCropReencode(doc)[0];
    if (plan) {
      expect(plan.rect.width).toBeGreaterThan(0);
      expect(plan.rect.height).toBeGreaterThan(0);
    }
  });
});
