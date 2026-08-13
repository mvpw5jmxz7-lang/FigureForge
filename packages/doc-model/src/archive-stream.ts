/**
 * Reading and writing a project archive without holding it whole.
 *
 * `saveArchive` returns one `Uint8Array`, which for an image-heavy project is
 * a second copy of every micrograph — images go in at `level: 0`, so the zip
 * does not shrink. Measured on a 200 MB payload, peak resident memory ran to
 * 723 MB: 200 for the assets, another 200 for the archive on save, and another
 * 200 for the extracted entries on open. That is the ceiling the risk table
 * has recorded since phase 1, and this module is what removes it.
 *
 * Both functions are **DOM-free and Node-free**: they move bytes between an
 * iterable and a callback and know nothing about files. That is what lets the
 * same implementation serve the browser's `FileSystemWritableFileStream` and
 * the desktop shell's IPC chunks, so there is exactly one streaming writer to
 * be right about. It also keeps `apps/desktop` free of internal dependencies —
 * the zipping happens in the renderer either way and the shell is a byte sink.
 *
 * `archive.ts` stays synchronous and unchanged; these are additions beside it,
 * built on the same `archiveEntries`/`readArchiveEntries` definitions, so the
 * two writers cannot disagree about what an archive is.
 */

import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough } from 'fflate';

import {
  ArchiveError,
  MANIFEST_PATH,
  readArchiveEntries,
  type ArchiveEntry,
  type LoadResult,
  type Manifest,
} from './archive.js';

/**
 * The entry sizes the manifest declares, or null if it does not.
 *
 * Deliberately forgiving: this is an optimisation, and a manifest that cannot
 * be read here is still validated properly by `readArchiveEntries` afterwards.
 * Throwing would turn "we could not pre-allocate" into "the project will not
 * open".
 */
function readEntrySizes(manifestBytes: Uint8Array): Record<string, number> | null {
  try {
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
    return manifest.entrySizes ?? null;
  } catch {
    return null;
  }
}

/** Where a chunk of the finished archive goes. May apply backpressure. */
export type ChunkSink = (chunk: Uint8Array) => void | Promise<void>;

/**
 * Write entries as a zip, handing each chunk to `sink` as it is produced.
 *
 * Peak footprint is one entry plus fflate's own window, rather than the whole
 * archive — the caller's bytes are pushed through and never accumulated.
 *
 * `sink` is awaited between entries rather than on every chunk: fflate's
 * callback is synchronous, so chunks are buffered per entry and flushed at the
 * entry boundary. That bounds the buffer by the largest single file rather
 * than by the archive, which is the distinction that matters — a project is
 * many megabytes because it has many images, not because one is enormous.
 */
export async function writeArchiveStream(
  entries: Iterable<ArchiveEntry>,
  sink: ChunkSink,
): Promise<void> {
  let pending: Uint8Array[] = [];
  let failure: unknown = null;

  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure ??= error;
      return;
    }
    if (chunk.length > 0) pending.push(chunk);
    void final;
  });

  const flush = async (): Promise<void> => {
    if (failure) throw failure;
    const chunks = pending;
    pending = [];
    for (const chunk of chunks) await sink(chunk);
  };

  for (const entry of entries) {
    // `level: 0` means "store"; ZipPassThrough writes the bytes verbatim and
    // skips the deflate machinery entirely, which is the whole point of
    // storing already-compressed images.
    const file =
      entry.level === 0
        ? new ZipPassThrough(entry.path)
        : new ZipDeflate(entry.path, { level: entry.level as 1 });
    zip.add(file);
    file.push(entry.bytes, true);
    await flush();
  }

  zip.end();
  await flush();
  if (failure) throw failure;
}

/**
 * Reassemble an archive from a stream of its bytes.
 *
 * Returns the same `{ path: bytes }` shape `unzipSync` produces, then runs it
 * through the one validator `loadArchive` uses, so a streamed open and a
 * whole-buffer open accept and reject exactly the same files.
 *
 * The compressed bytes are never held whole: each chunk is pushed into fflate
 * and dropped. What remains is the extracted entries, which the caller needs
 * anyway.
 */
export async function readArchiveStream(source: AsyncIterable<Uint8Array>): Promise<LoadResult> {
  const entries: Record<string, Uint8Array> = {};
  const open = new Set<string>();
  let failure: unknown = null;
  /** Filled in as soon as the manifest — always the first entry — arrives. */
  let declaredSizes: Record<string, number> | null = null;

  const unzip = new Unzip((file) => {
    open.add(file.name);

    // Allocate once and copy each chunk straight in. Collecting an entry's
    // pieces and joining them at the end was the obvious first version and
    // measurably the wrong one: it holds the pieces *and* the result at the
    // same time, i.e. two copies of the largest micrograph. Measured on a
    // single 200 MB asset it peaked at 765 MB against the whole-buffer
    // reader's 722 MB — worse than the thing it replaces.
    //
    // `file.originalSize` is only present when the archive was written with
    // sizes in its local headers, which fflate's *streaming* writer never does
    // (it emits data descriptors instead). So the manifest carries the sizes
    // as well, and this prefers that.
    const expected = declaredSizes?.[file.name] ?? file.originalSize;
    let out = expected !== undefined ? new Uint8Array(expected) : null;
    let at = 0;
    let spill: Uint8Array[] | null = expected === undefined ? [] : null;

    file.ondata = (error, chunk, final) => {
      if (error) {
        failure ??= error;
        return;
      }
      if (chunk.length > 0) {
        if (out && at + chunk.length <= out.length) {
          out.set(chunk, at);
          at += chunk.length;
        } else {
          // A header that lied about the size, or no size at all. Fall back to
          // collecting rather than truncating what we were given.
          spill ??= out ? [out.subarray(0, at)] : [];
          spill.push(chunk);
          out = null;
        }
      }
      if (final) {
        entries[file.name] = spill ? concat(spill) : out!.subarray(0, at);
        open.delete(file.name);
        // The manifest is written first, so its sizes are known before any of
        // the files it describes start arriving.
        if (file.name === MANIFEST_PATH) declaredSizes = readEntrySizes(entries[file.name]!);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    for await (const chunk of source) {
      unzip.push(chunk, false);
      if (failure) throw failure;
    }
    // The final push is what makes fflate emit each entry's last chunk; without
    // it a stream that ended cleanly still yields truncated files.
    unzip.push(new Uint8Array(0), true);
  } catch (cause) {
    throw new ArchiveError(
      `Not a readable FigureForge project (zip could not be opened): ${String(cause)}`,
    );
  }
  if (failure) {
    throw new ArchiveError(
      `Not a readable FigureForge project (zip could not be opened): ${String(failure)}`,
    );
  }

  // An entry that opened but never completed means the stream stopped early.
  // Reporting it as a truncated file beats returning a half-archive that
  // validates and is quietly missing an image.
  for (const name of open) {
    throw new ArchiveError(
      `Project file ended in the middle of "${name}"; it is incomplete or truncated.`,
    );
  }

  return readArchiveEntries(entries);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
