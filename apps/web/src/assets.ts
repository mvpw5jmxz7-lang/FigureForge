/**
 * The session's image bytes.
 *
 * Binaries deliberately live outside the FigureDocument. `store.ts` records
 * every edit as an Immer patch *and* its inverse, so a micrograph held in the
 * document would be cloned into the undo history on every unrelated edit. The
 * document keeps the `Asset` metadata — which is undoable, and should be — and
 * this store keeps the bytes, exactly as parsed rows live in the document while
 * the verbatim CSV lives in the archive.
 *
 * Two representations per asset:
 *
 *   original  the imported file, byte for byte. This is what the archive
 *             writes, and it is what makes the reproducibility claim true for
 *             binaries as well as for data.
 *   display   something a browser can actually draw. Identical to `original`
 *             for PNG, JPEG and SVG; a decoded PNG proxy for TIFF.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AssetId, FigureDocument } from '@figureforge/doc-model';

export interface AssetBytes {
  /** Exactly as imported. Never re-encoded. */
  original: Uint8Array;
  mimeType: string;
  /** Displayable proxy. Same object as `original` unless decoding was needed. */
  display: Uint8Array;
  displayMimeType: string;
}

interface Entry extends AssetBytes {
  /** Created on first use; revoked only by clear(). See the note there. */
  objectUrl?: string;
}

/**
 * `btoa` takes a binary string, and building one with
 * `String.fromCharCode(...bytes)` spreads the whole array into an argument
 * list — which overflows the call stack somewhere around a hundred kilobytes,
 * i.e. on every real micrograph. Chunked, it is bounded.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

export class AssetStore {
  private readonly entries = new Map<AssetId, Entry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  add(id: AssetId, bytes: AssetBytes): void {
    this.entries.set(id, { ...bytes });
    this.emit();
  }

  has(id: AssetId): boolean {
    return this.entries.has(id);
  }

  size(): number {
    return this.entries.size;
  }

  /** Total bytes held, so the UI can warn before the archive gets unopenable. */
  totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.original.length;
    return total;
  }

  originalBytes(id: AssetId): Uint8Array | undefined {
    return this.entries.get(id)?.original;
  }

  /**
   * The bytes a browser can decode, with their type.
   *
   * The export-time crop re-encode needs both, and it needs the *display*
   * representation: the original may be a TIFF, which `createImageBitmap`
   * cannot open. Returns a snapshot rather than the entry, so a caller cannot
   * reach the cached object URL and revoke it.
   */
  displayBytes(id: AssetId): { bytes: Uint8Array; mimeType: string } | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return { bytes: entry.display, mimeType: entry.displayMimeType };
  }

  /** Blob URL for the canvas. Created once per asset and cached. */
  urlFor(id: AssetId): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.objectUrl ??= URL.createObjectURL(
      new Blob([new Uint8Array(entry.display)], { type: entry.displayMimeType }),
    );
    return entry.objectUrl;
  }

  /**
   * Self-contained data URI, for the export path.
   *
   * Built from the *display* bytes: a TIFF data URI renders as nothing in
   * Chromium, so an export carrying one would be silently blank. Not cached —
   * a base64 string is a third larger again than the bytes, and holding both
   * doubles peak memory for an operation that happens rarely and slowly.
   */
  dataUriFor(id: AssetId): string | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return `data:${entry.displayMimeType};base64,${bytesToBase64(entry.display)}`;
  }

  /** Every asset's original bytes keyed by archive path, ready for saving. */
  archiveMap(document: FigureDocument): Map<string, Uint8Array> {
    const map = new Map<string, Uint8Array>();
    for (const asset of document.assets) {
      const bytes = this.entries.get(asset.id)?.original;
      if (bytes) map.set(asset.path, bytes);
    }
    return map;
  }

  /**
   * Drop everything and revoke every URL.
   *
   * The *only* place a blob URL is revoked, along with the hook's unmount.
   * Deleting an image node must not free its bytes: `deleteNode` never touches
   * `draft.assets`, so the Asset record survives, and undo can bring the node
   * back — a revoke on delete is precisely what would leave the resurrected
   * node pointing at a dead URL. Unreferenced assets are surfaced in the UI as
   * removable instead, which is a decision for the author rather than a
   * cleanup this store performs behind them.
   */
  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    }
    this.entries.clear();
    this.emit();
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

export interface AssetsApi {
  store: AssetStore;
  /** Blob URLs keyed by asset id, for the canvas renderer. */
  urls: Record<AssetId, string>;
  /** Resolver for the export path: self-contained data URIs. */
  resolveForExport: (assetId: AssetId) => string | undefined;
}

export function useAssets(document: FigureDocument): AssetsApi {
  const storeRef = useRef<AssetStore | null>(null);
  storeRef.current ??= new AssetStore();
  const store = storeRef.current;

  const subscribe = useMemo(() => (listener: () => void) => store.subscribe(listener), [store]);
  const version = useSyncExternalStore(
    subscribe,
    () => store.version(),
    () => store.version(),
  );

  // Rebuilt whenever the store changes or an asset is added to the document, so
  // a decode that finishes later still reaches the canvas.
  const urls = useMemo(() => {
    const map: Record<AssetId, string> = {};
    for (const asset of document.assets) {
      const url = store.urlFor(asset.id);
      if (url) map[asset.id] = url;
    }
    return map;
    // `version` is in the dependency list on purpose even though the body does
    // not name it: it is the signal that the store's contents changed, which is
    // what makes a decode that finishes after render reach the canvas.
  }, [store, document.assets, version]);

  const resolveForExport = useMemo(
    () => (assetId: AssetId) => store.dataUriFor(assetId),
    [store],
  );

  useEffect(() => () => store.clear(), [store]);

  return { store, urls, resolveForExport };
}
