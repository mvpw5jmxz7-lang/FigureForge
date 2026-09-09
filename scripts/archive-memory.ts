/**
 * Peak memory of writing and reading a project archive.
 *
 * The risk table's claim — "the archive is built whole in memory… an OOM and a
 * lost session" — is a memory claim, so it wants a measurement rather than an
 * adjective. This reports `VmHWM` (peak resident set) from
 * `/proc/self/status`: the high-water mark the kernel actually observed, not a
 * sampled guess.
 *
 * Peak RSS only ever rises, so the two strategies cannot share a process.
 * Run it twice and compare:
 *
 *   podman exec -w /app -e MODE=whole  figureforge-web npx vite-node scripts/archive-memory.ts
 *   podman exec -w /app -e MODE=stream figureforge-web npx vite-node scripts/archive-memory.ts
 *
 * The synthetic asset is incompressible on purpose. Images are stored at
 * `level: 0` anyway, and compressible filler would make the archive smaller
 * than its input and flatter the result.
 */

import { createReadStream, readFileSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  archiveEntries,
  buildArchiveContents,
  createDocument,
  loadArchive,
  readArchiveStream,
  saveArchive,
  writeArchiveStream,
  type FigureDocument,
} from '../packages/doc-model/src/index.js';

const MB = 1024 * 1024;
const ASSET_MB = Number(process.env['ASSET_MB'] ?? 200);
const MODE = process.env['MODE'] ?? 'whole';
const ASSET_COUNT = Number(process.env['ASSET_COUNT'] ?? 1);
const ARCHIVE = join(tmpdir(), `figureforge-memory-${process.pid}.ffg`);

/** Peak resident set since the process started, in MB. */
function peakRssMb(): number {
  const status = readFileSync('/proc/self/status', 'utf8');
  const line = /VmHWM:\s+(\d+) kB/.exec(status);
  return line ? Number(line[1]) / 1024 : NaN;
}

const report = (label: string): void =>
  console.log(`  ${label.padEnd(34)} ${peakRssMb().toFixed(1)} MB`);

/**
 * `count` micrographs totalling `sizeMb`.
 *
 * The shape matters as much as the total. A streaming reader drops each
 * entry's pieces once it has joined them, so its overhead is the *largest
 * single file*, not the archive — which makes one enormous asset the worst
 * case and a realistic multi-panel figure the common one.
 */
function syntheticProject(
  sizeMb: number,
  count: number,
): { document: FigureDocument; assets: Map<string, Uint8Array> } {
  // A bare document, since only the assets are being weighed: this used to be
  // the app's seven-panel sample, whose node JSON was a few kB against 200 MB
  // of images. Round 51 removed it; the measured figures are unaffected.
  const document = createDocument();
  const assets = new Map<string, Uint8Array>();
  const records = [];
  const each = Math.floor((sizeMb * MB) / count);

  for (let i = 0; i < count; i++) {
    const bytes = new Uint8Array(each);
    // Random rather than zeroes: a zero-filled page may not even be committed,
    // so both the archive size and the RSS would measure nothing.
    for (let b = 0; b < bytes.length; b += 4096) bytes[b] = (Math.random() * 256) | 0;
    const path = `assets/large${i}.tif`;
    assets.set(path, bytes);
    records.push({
      id: `large-asset-${i}`,
      path,
      filename: `large${i}.tif`,
      mimeType: 'image/tiff',
      byteLength: bytes.length,
      naturalPx: { width: 4096, height: 4096 },
    });
  }

  const withAssets = { ...document, assets: [...document.assets, ...records] } as FigureDocument;
  return { document: withAssets, assets };
}

async function* fileChunks(path: string): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * MB })) {
    yield new Uint8Array(chunk as Buffer);
  }
}

async function main(): Promise<void> {
  console.log(`\n${MODE} — ${ASSET_MB} MB across ${ASSET_COUNT} asset(s)`);
  report('start');

  const { document, assets } = syntheticProject(ASSET_MB, ASSET_COUNT);
  report('asset allocated');

  const contents = buildArchiveContents(document, new Map(), assets);

  if (MODE === 'whole') {
    const bytes = saveArchive(contents);
    report('after saveArchive');
    const loaded = loadArchive(bytes);
    report('after loadArchive');
    console.log(`  archive ${(bytes.length / MB).toFixed(1)} MB, ${loaded.assets.size} asset(s)`);
  } else {
    const handle = await open(ARCHIVE, 'w');
    try {
      await writeArchiveStream(archiveEntries(contents), async (chunk) => {
        await handle.write(chunk);
      });
    } finally {
      await handle.close();
    }
    report('after writeArchiveStream');

    const loaded = await readArchiveStream(fileChunks(ARCHIVE));
    report('after readArchiveStream');
    const size = (await readFile(ARCHIVE)).length;
    await rm(ARCHIVE, { force: true });
    console.log(`  archive ${(size / MB).toFixed(1)} MB, ${loaded.assets.size} asset(s)`);
  }
}

void main();
