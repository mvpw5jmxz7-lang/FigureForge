/**
 * Asset store lifecycle.
 *
 * The interesting behaviour here is all about *when bytes are freed*, which is
 * exactly what a rendering test cannot see: a leak looks fine until the tab
 * runs out of memory, and an early revoke looks fine until someone presses
 * undo.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAsset,
  addImage,
  createDocument,
  createIdFactory,
  deleteNode,
  editDocument,
} from '@figureforge/doc-model';
import { AssetStore, bytesToBase64 } from './assets.js';

/** Node has no URL.createObjectURL; the store's contract is what is tested. */
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  let counter = 0;
  vi.stubGlobal('URL', {
    createObjectURL: () => {
      const url = `blob:test/${++counter}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  // Node 22 has Blob and btoa globally; assert rather than assume.
  expect(typeof Blob).toBe('function');
});

const BYTES = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xff, 0xfe]);

function storeWithOne(id = 'a1'): AssetStore {
  const store = new AssetStore();
  store.add(id, {
    original: BYTES,
    mimeType: 'image/tiff',
    display: new Uint8Array([1, 2, 3]),
    displayMimeType: 'image/png',
  });
  return store;
}

describe('blob URL lifecycle', () => {
  it('creates one URL per asset and reuses it', () => {
    const store = storeWithOne();
    const first = store.urlFor('a1');

    expect(store.urlFor('a1')).toBe(first);
    // A URL per render would leak one object per frame.
    expect(created).toHaveLength(1);
  });

  it('revokes every URL exactly once on clear', () => {
    const store = storeWithOne();
    store.urlFor('a1');
    store.clear();
    store.clear();

    expect(revoked).toEqual(created);
    expect(revoked).toHaveLength(1);
  });

  it('never revokes a URL for an asset that was merely unused', () => {
    const store = storeWithOne();
    store.urlFor('a1');
    // Nothing but clear() frees anything. This is the property that keeps undo
    // working after an image node is deleted.
    expect(revoked).toEqual([]);
  });

  it('returns nothing for an unknown asset instead of inventing a URL', () => {
    expect(new AssetStore().urlFor('missing')).toBeUndefined();
  });
});

describe('surviving a deleted node', () => {
  it('keeps the bytes when the image node using them is deleted', () => {
    // Undo can bring the node straight back, so freeing on delete would leave
    // the resurrected image pointing at nothing.
    const newId = createIdFactory();
    const store = storeWithOne('a1');

    const doc = editDocument(createDocument({ idFactory: newId }), (draft) => {
      addAsset(draft, {
        id: 'a1',
        filename: 'cells.tif',
        mimeType: 'image/tiff',
        byteLength: BYTES.length,
        naturalPx: { width: 10, height: 10 },
      });
      addImage(draft, newId, {
        assetId: 'a1',
        frame: { x: 0, y: 0, width: 10, height: 10 },
        naturalPx: { width: 10, height: 10 },
      });
    });

    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    const after = editDocument(doc, (draft) => deleteNode(draft, image.id));

    expect(store.has('a1')).toBe(true);
    expect(store.originalBytes('a1')).toEqual(BYTES);
    // The record survives too, which is what keeps the document loadable.
    expect(after.assets).toHaveLength(1);
  });
});

describe('archive map', () => {
  it('keys the original bytes by archive path', () => {
    const store = storeWithOne('a1');
    const doc = editDocument(createDocument(), (draft) => {
      addAsset(draft, {
        id: 'a1',
        filename: 'cells.tif',
        mimeType: 'image/tiff',
        byteLength: BYTES.length,
        naturalPx: null,
      });
    });

    const map = store.archiveMap(doc);
    // The *original*, never the display proxy: the archive is what makes the
    // reproducibility claim, and a decoded PNG is not what was imported.
    expect(map.get('assets/a1.tif')).toEqual(BYTES);
  });

  it('omits assets whose bytes this session never saw', () => {
    const doc = editDocument(createDocument(), (draft) => {
      addAsset(draft, {
        id: 'ghost',
        filename: 'gone.png',
        mimeType: 'image/png',
        byteLength: 4,
        naturalPx: null,
      });
    });
    expect(new AssetStore().archiveMap(doc).size).toBe(0);
  });

  it('totals the original bytes, not the proxies', () => {
    expect(storeWithOne().totalBytes()).toBe(BYTES.length);
  });
});

describe('data URIs', () => {
  it('encodes from the display bytes, which a browser can actually draw', () => {
    // A TIFF data URI renders as nothing in Chromium, so an export built from
    // the original bytes would be silently blank.
    const uri = storeWithOne().dataUriFor('a1');
    expect(uri).toBe(`data:image/png;base64,${btoa('\x01\x02\x03')}`);
  });

  it('matches a hand-computed encoding', () => {
    // "Man" is the canonical RFC 4648 example: three bytes to four characters
    // with no padding.
    expect(bytesToBase64(new Uint8Array([0x4d, 0x61, 0x6e]))).toBe('TWFu');
    expect(bytesToBase64(new Uint8Array([0x4d]))).toBe('TQ==');
    expect(bytesToBase64(new Uint8Array([]))).toBe('');
  });

  it('encodes a payload past the argument-spreading limit', () => {
    // `String.fromCharCode(...bytes)` overflows the call stack somewhere around
    // 100 kB, i.e. on every real micrograph. The chunked loop must not.
    const large = new Uint8Array(300_000).fill(0x41);
    const encoded = bytesToBase64(large);

    expect(encoded).toHaveLength(Math.ceil(300_000 / 3) * 4);
    expect(atob(encoded)).toHaveLength(300_000);
  });
});

describe('change notification', () => {
  it('bumps the version so a late decode reaches the canvas', () => {
    const store = new AssetStore();
    const before = store.version();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.add('a1', {
      original: BYTES,
      mimeType: 'image/png',
      display: BYTES,
      displayMimeType: 'image/png',
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.version()).toBeGreaterThan(before);

    unsubscribe();
    store.clear();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
