/**
 * The streaming archive writer and reader.
 *
 * The failure mode worth fearing here is silent: a chunk boundary landing
 * mid-entry produces a zip that still opens and has a corrupt or truncated
 * file inside it. So the reader is deliberately fed pathological chunkings —
 * one byte at a time, and splits chosen to fall inside an entry's compressed
 * data — rather than the tidy chunks a real stream would happen to give.
 */

import { describe, expect, it } from 'vitest';

import {
  ArchiveError,
  archiveEntries,
  buildArchiveContents,
  loadArchive,
  saveArchive,
  type ArchiveContents,
} from './archive.js';
import { readArchiveStream, writeArchiveStream } from './archive-stream.js';
import { createDocument } from './document.js';
import type { FigureDocument } from './document.js';

function projectWithAssets(count: number, size: number): ArchiveContents {
  const base = createDocument();
  const assets = new Map<string, Uint8Array>();
  const records = [];

  for (let i = 0; i < count; i++) {
    const path = `assets/a${i}.bin`;
    // Varied bytes, so a mis-stitched entry cannot coincidentally match.
    const bytes = new Uint8Array(size);
    for (let b = 0; b < size; b++) bytes[b] = (b * 31 + i * 7) % 256;
    assets.set(path, bytes);
    records.push({
      id: `a${i}`,
      path,
      filename: `a${i}.bin`,
      mimeType: 'image/png',
      byteLength: size,
      naturalPx: { width: 10, height: 10 },
    });
  }

  const document = { ...base, assets: records } as FigureDocument;
  return buildArchiveContents(document, new Map(), assets);
}

/** Collect a stream write into one buffer, for comparison purposes only. */
async function writeToBuffer(contents: ArchiveContents): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await writeArchiveStream(archiveEntries(contents), (chunk) => {
    chunks.push(chunk);
  });
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Feed bytes in fixed-size pieces, regardless of entry boundaries. */
async function* inChunksOf(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) {
    yield bytes.subarray(at, Math.min(at + size, bytes.length));
  }
}

describe('archiveEntries', () => {
  it('puts the manifest and document first, in that order', () => {
    const entries = archiveEntries(projectWithAssets(2, 16));
    expect(entries[0]?.path).toBe('MANIFEST.json');
    expect(entries[1]?.path).toBe('document.json');
  });

  it('stores images rather than deflating them', () => {
    // Already-compressed bytes; recompressing costs time and saves nothing,
    // and this is the level the streaming writer keys its passthrough off.
    const entries = archiveEntries(projectWithAssets(2, 16));
    for (const entry of entries.filter((e) => e.path.startsWith('assets/'))) {
      expect(entry.level).toBe(0);
    }
  });

  it('deflates the model and the data files', () => {
    const entries = archiveEntries(projectWithAssets(1, 16));
    for (const entry of entries.filter((e) => !e.path.startsWith('assets/'))) {
      expect(entry.level).toBeGreaterThan(0);
    }
  });

  it('references the caller´s bytes rather than copying them', () => {
    // This is what makes the streaming writer bounded: if the layout copied,
    // building the entry list would already cost a second archive.
    const contents = projectWithAssets(1, 32);
    const original = contents.assets.get('assets/a0.bin')!;
    const entry = archiveEntries(contents).find((e) => e.path === 'assets/a0.bin');
    expect(entry?.bytes).toBe(original);
  });
});

describe('writeArchiveStream', () => {
  it('produces an archive the ordinary reader accepts', async () => {
    const contents = projectWithAssets(3, 1024);
    const streamed = await writeToBuffer(contents);

    const loaded = loadArchive(streamed);
    expect(loaded.document.id).toBe(contents.document.id);
    expect(loaded.assets.size).toBe(3);
    expect(loaded.assets.get('assets/a1.bin')).toEqual(contents.assets.get('assets/a1.bin'));
  });

  it('agrees with saveArchive on contents, though not on bytes', async () => {
    // The two writers legitimately differ in the zip's framing — a streaming
    // writer emits data descriptors a whole-buffer one has no need for — so
    // equality is asserted where it is real: the files that come back out.
    const contents = projectWithAssets(2, 512);
    const whole = loadArchive(saveArchive(contents));
    const streamed = loadArchive(await writeToBuffer(contents));

    expect(streamed.assets).toEqual(whole.assets);
    expect(streamed.dataFiles).toEqual(whole.dataFiles);
    expect(streamed.document).toEqual(whole.document);
  });

  it('hands the caller every byte through the sink', async () => {
    const contents = projectWithAssets(1, 4096);
    let sunk = 0;
    await writeArchiveStream(archiveEntries(contents), (chunk) => {
      sunk += chunk.length;
    });
    expect(sunk).toBeGreaterThan(4096);
  });

  it('awaits a sink that applies backpressure', async () => {
    const order: string[] = [];
    const contents = projectWithAssets(2, 256);
    await writeArchiveStream(archiveEntries(contents), async () => {
      order.push('start');
      await Promise.resolve();
      order.push('end');
    });
    // Never two starts in a row: each write completed before the next began.
    for (let i = 0; i < order.length - 1; i++) {
      if (order[i] === 'start') expect(order[i + 1]).toBe('end');
    }
  });

  it('propagates a sink failure rather than finishing quietly', async () => {
    const contents = projectWithAssets(2, 256);
    await expect(
      writeArchiveStream(archiveEntries(contents), () => {
        throw new Error('disk full');
      }),
    ).rejects.toThrow('disk full');
  });
});

describe('readArchiveStream', () => {
  it('round-trips a project written by the streaming writer', async () => {
    const contents = projectWithAssets(3, 2048);
    const bytes = await writeToBuffer(contents);

    const loaded = await readArchiveStream(inChunksOf(bytes, 64 * 1024));
    expect(loaded.assets.size).toBe(3);
    expect(loaded.assets.get('assets/a2.bin')).toEqual(contents.assets.get('assets/a2.bin'));
  });

  it('reads an archive written by saveArchive', async () => {
    // The two halves are independent: a file saved before this change must
    // still open through the streaming path.
    const contents = projectWithAssets(2, 1024);
    const loaded = await readArchiveStream(inChunksOf(saveArchive(contents), 1024));
    expect(loaded.assets.get('assets/a0.bin')).toEqual(contents.assets.get('assets/a0.bin'));
  });

  it.each([1, 7, 64, 997, 8192])(
    'reassembles correctly with %i-byte chunks',
    async (size) => {
      // Boundaries land inside compressed data, inside the central directory
      // and inside file headers — the split a real stream would only hit
      // occasionally, and the one that corrupts an entry silently.
      const contents = projectWithAssets(2, 3000);
      const bytes = await writeToBuffer(contents);

      const loaded = await readArchiveStream(inChunksOf(bytes, size));
      expect(loaded.assets.get('assets/a0.bin')).toEqual(contents.assets.get('assets/a0.bin'));
      expect(loaded.assets.get('assets/a1.bin')).toEqual(contents.assets.get('assets/a1.bin'));
    },
  );

  it('refuses a truncated stream instead of returning a partial project', async () => {
    const contents = projectWithAssets(2, 4096);
    const bytes = await writeToBuffer(contents);
    const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));

    // The dangerous outcome is a project that opens with an image missing.
    await expect(readArchiveStream(inChunksOf(cut, 512))).rejects.toBeInstanceOf(ArchiveError);
  });

  it('refuses bytes that are not a zip at all', async () => {
    const rubbish = new Uint8Array(1024).fill(7);
    await expect(readArchiveStream(inChunksOf(rubbish, 128))).rejects.toBeInstanceOf(ArchiveError);
  });

  it('applies the same validation as loadArchive', async () => {
    // Both paths go through `readArchiveEntries`, so a file missing its
    // manifest must be refused identically however it was read.
    const contents = projectWithAssets(1, 64);
    const bytes = await writeToBuffer(contents);
    const damaged = bytes.slice();
    // Corrupt the manifest's stored name so the entry lands under another key.
    const marker = new TextEncoder().encode('MANIFEST.json');
    const at = damaged.findIndex((_, i) =>
      marker.every((byte, j) => damaged[i + j] === byte),
    );
    if (at >= 0) damaged[at] = 'X'.charCodeAt(0);

    await expect(readArchiveStream(inChunksOf(damaged, 256))).rejects.toBeInstanceOf(ArchiveError);
  });
});
