/**
 * The .figureforge project format.
 *
 * A zip container, following the .docx/.xlsx precedent, rather than one big
 * JSON file. Micrographs and blots are the bulk of a real figure's bytes and
 * base64-ing multi-megabyte TIFFs into JSON is untenable — so binaries stay
 * binary and only the model is JSON.
 *
 *   MANIFEST.json      format marker, schema and app version
 *   document.json      the FigureDocument
 *   data/*.csv         verbatim original imports, byte-for-byte
 *   assets/*           images, unmodified
 *   thumbnail.png      preview for file browsers (optional)
 *
 * `data/` holding the untouched originals is what makes the reproducibility
 * claim real: the numbers a reviewer extracts are the numbers that were
 * imported, not a round-tripped re-serialisation of them.
 */

import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { FigureDocument } from './document.js';
import { SCHEMA_VERSION } from './document.js';
import type { Dataset } from './data.js';
import { checkReferentialIntegrity, isSupportedVersion, validateDocument } from './schema.js';
import type { ValidationIssue } from './schema.js';

/**
 * The extension a new save writes. Short, so it is typeable and reads
 * cleanly in a file manager — `.figureforge` is kept only as something Open
 * still reads, never as something anything writes again.
 */
export const ARCHIVE_EXTENSION = '.ffg';
/** The original long form. Still opened, never written. */
export const LEGACY_ARCHIVE_EXTENSION = '.figureforge';
/** Everything Open accepts. `.ffg` first, so a picker defaults to it. */
export const ARCHIVE_EXTENSIONS: readonly string[] = [
  ARCHIVE_EXTENSION,
  LEGACY_ARCHIVE_EXTENSION,
];
/**
 * A vendor MIME for the File System Access API's picker `accept` map. A
 * `vnd.` type with a `+zip` structured suffix is the correct shape for an
 * unregistered vendor container — the archive genuinely is a zip.
 */
export const ARCHIVE_MIME = 'application/vnd.figureforge.project+zip';
/** The picker's file-type entry, shared by the save and open pickers. */
export const ARCHIVE_FILE_TYPE = {
  description: 'FigureForge project',
  accept: { [ARCHIVE_MIME]: [...ARCHIVE_EXTENSIONS] },
} as const;
export const MANIFEST_PATH = 'MANIFEST.json';
export const DOCUMENT_PATH = 'document.json';
export const THUMBNAIL_PATH = 'thumbnail.png';

export interface Manifest {
  format: 'figureforge';
  schemaVersion: number;
  appVersion: string;
  createdAt: string;
  /** Informational; the document is still the authority. */
  title: string;
}

export interface ArchiveContents {
  document: FigureDocument;
  /** Verbatim source text keyed by archive path, e.g. "data/d1.csv". */
  dataFiles: Map<string, string>;
  /** Binary attachments keyed by archive path, e.g. "assets/a1.tif". */
  assets: Map<string, Uint8Array>;
  thumbnail?: Uint8Array;
}

export interface SaveOptions {
  appVersion?: string;
  now?: () => string;
  /** zlib level 0–9. Images are already compressed, so the default is modest. */
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function saveArchive(contents: ArchiveContents, options: SaveOptions = {}): Uint8Array {
  const now = (options.now ?? (() => new Date().toISOString()))();
  const level = options.compressionLevel ?? 6;

  const manifest: Manifest = {
    format: 'figureforge',
    schemaVersion: contents.document.schemaVersion,
    appVersion: options.appVersion ?? '0.1.0',
    createdAt: now,
    title: contents.document.title,
  };

  const files: Zippable = {
    [MANIFEST_PATH]: [strToU8(JSON.stringify(manifest, null, 2)), { level }],
    [DOCUMENT_PATH]: [strToU8(JSON.stringify(contents.document, null, 2)), { level }],
  };

  for (const [path, text] of contents.dataFiles) {
    files[path] = [strToU8(text), { level }];
  }
  for (const [path, bytes] of contents.assets) {
    // Images are already compressed; recompressing costs time and saves nothing.
    files[path] = [bytes, { level: 0 }];
  }
  if (contents.thumbnail) {
    files[THUMBNAIL_PATH] = [contents.thumbnail, { level: 0 }];
  }

  return zipSync(files);
}

/** Serialise a dataset to CSV. Used only when no verbatim original exists. */
export function datasetToCsv(dataset: Dataset): string {
  const escape = (value: string | number | null): string => {
    if (value === null) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const header = dataset.columns.map((c) => escape(c.name)).join(',');
  const body = dataset.rows.map((row) => row.map(escape).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

/** Archive path for a dataset's verbatim source. */
export const dataPathFor = (dataset: Dataset): string =>
  dataset.sourcePath ?? `data/${dataset.id}.csv`;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly issues: ValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface LoadResult extends ArchiveContents {
  manifest: Manifest;
  /** Non-fatal problems worth surfacing, e.g. a missing asset file. */
  warnings: string[];
}

export function loadArchive(bytes: Uint8Array): LoadResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (cause) {
    throw new ArchiveError(
      `Not a readable FigureForge project (zip could not be opened): ${String(cause)}`,
    );
  }

  const manifestBytes = entries[MANIFEST_PATH];
  if (!manifestBytes) {
    throw new ArchiveError(`Missing ${MANIFEST_PATH}; this is not a FigureForge project.`);
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as Manifest;
  } catch (cause) {
    throw new ArchiveError(`${MANIFEST_PATH} is not valid JSON: ${String(cause)}`);
  }

  if (manifest.format !== 'figureforge') {
    throw new ArchiveError(`Unrecognised project format "${String(manifest.format)}".`);
  }
  if (!isSupportedVersion(manifest.schemaVersion)) {
    throw new ArchiveError(
      `Project schema version ${manifest.schemaVersion} is newer than this build supports ` +
        `(max ${SCHEMA_VERSION}). Update FigureForge to open it.`,
    );
  }

  const documentBytes = entries[DOCUMENT_PATH];
  if (!documentBytes) throw new ArchiveError(`Missing ${DOCUMENT_PATH}.`);

  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(documentBytes));
  } catch (cause) {
    throw new ArchiveError(`${DOCUMENT_PATH} is not valid JSON: ${String(cause)}`);
  }

  const validation = validateDocument(raw);
  if (!validation.ok || validation.value === null) {
    throw new ArchiveError('Project file failed validation.', validation.issues);
  }

  const document = validation.value as FigureDocument;

  const integrity = checkReferentialIntegrity(document);
  if (integrity.length > 0) {
    throw new ArchiveError('Project file has broken internal references.', integrity);
  }

  const dataFiles = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  const warnings: string[] = [];

  for (const [path, content] of Object.entries(entries)) {
    if (path.startsWith('data/')) dataFiles.set(path, strFromU8(content));
    else if (path.startsWith('assets/')) assets.set(path, content);
  }

  for (const asset of document.assets) {
    if (!assets.has(asset.path)) {
      warnings.push(`Asset "${asset.filename}" is referenced but missing from the archive.`);
    }
  }
  for (const dataset of document.datasets) {
    if (dataset.sourcePath && !dataFiles.has(dataset.sourcePath)) {
      warnings.push(`Source data for "${dataset.name}" is missing; using the embedded copy.`);
    }
  }

  const result: LoadResult = { manifest, document, dataFiles, assets, warnings };
  const thumbnail = entries[THUMBNAIL_PATH];
  if (thumbnail) result.thumbnail = thumbnail;
  return result;
}

/** Convenience: bundle a document with its verbatim sources for saving. */
export function buildArchiveContents(
  document: FigureDocument,
  originals: Map<string, string> = new Map(),
  assets: Map<string, Uint8Array> = new Map(),
): ArchiveContents {
  const dataFiles = new Map<string, string>();
  for (const dataset of document.datasets) {
    const path = dataPathFor(dataset);
    dataFiles.set(path, originals.get(path) ?? datasetToCsv(dataset));
  }
  return { document, dataFiles, assets };
}
