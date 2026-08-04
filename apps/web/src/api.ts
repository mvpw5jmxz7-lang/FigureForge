/** Client for the Python service. Vite proxies /api to it in development. */

import type { Alternative, Correction, StatResult, StatTest } from '@figureforge/doc-model';

const BASE = '/api';

export interface AnalyzeRequest {
  test: StatTest;
  groups: { name: string; values: number[] }[];
  /** Paired x-values, for correlating a single series against its own x axis. */
  x?: { name: string; values: number[] };
  /** Per-subject 0/1 event flags, one entry per `groups` entry, matched by name — log-rank only. */
  events?: { name: string; values: number[] }[];
  alternative?: Alternative;
  correction?: Correction;
  alpha?: number;
  welch?: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function failure(response: Response): Promise<ApiError> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') detail = body.detail;
    else if (Array.isArray(body.detail)) detail = JSON.stringify(body.detail);
  } catch {
    // Non-JSON error body; the status text will have to do.
  }
  return new ApiError(detail, response.status);
}

export async function analyze(request: AnalyzeRequest): Promise<StatResult> {
  const response = await fetch(`${BASE}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as StatResult;
}

export type ExportFormat = 'svg' | 'pdf' | 'eps' | 'png' | 'tiff';

export interface ExportRequest {
  svg: string;
  widthMm: number;
  heightMm: number;
  format: ExportFormat;
  dpi?: 150 | 300 | 450 | 600;
  filename?: string;
}

export async function exportFigure(request: ExportRequest): Promise<Blob> {
  const response = await fetch(`${BASE}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return response.blob();
}

export interface DecodedImage {
  png: Uint8Array;
  width: number;
  height: number;
  sourceFormat: string;
  frames: number;
  /** Present only when the file states one; never defaulted. */
  calibration?: { pixelsPerUnit: number; unitLabel: string };
  notes: string[];
}

/**
 * Decode a format the browser cannot open (TIFF) into a PNG display proxy.
 *
 * Multipart out, raw PNG back — base64 in JSON would inflate a 200 MB
 * micrograph by a third and hold it whole as a string at both ends.
 */
export async function decodeImage(file: File): Promise<DecodedImage> {
  const body = new FormData();
  body.append('file', file);

  const response = await fetch(`${BASE}/decode-image`, { method: 'POST', body });
  if (!response.ok) throw await failure(response);

  const header = (name: string): string | null => response.headers.get(name);
  const pixelsPerUnit = Number(header('X-Image-Pixels-Per-Unit'));
  const unitLabel = header('X-Image-Unit-Label');
  const notes = header('X-Image-Notes');

  const decoded: DecodedImage = {
    png: new Uint8Array(await response.arrayBuffer()),
    width: Number(header('X-Image-Width') ?? 0),
    height: Number(header('X-Image-Height') ?? 0),
    sourceFormat: header('X-Image-Source-Format') ?? 'unknown',
    frames: Number(header('X-Image-Frames') ?? 1),
    notes: notes ? [notes] : [],
  };

  // Both or neither: a half-read calibration is indistinguishable from a
  // measured one everywhere downstream.
  if (unitLabel && Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0) {
    decoded.calibration = { pixelsPerUnit, unitLabel };
  }
  return decoded;
}

export async function health(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * A filename a filesystem will accept, derived from the figure's title.
 *
 * The title is the default rather than the answer — every save offers it for
 * editing. It used to be neither: the title was never exposed in the UI, so
 * every figure saved itself under whatever the sample document was called.
 */
export function safeFilename(title: string, fallback = 'figure'): string {
  const cleaned = title
    .replace(/[/\\?%*:|"<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned === '' ? fallback : cleaned;
}

/** Trigger a browser download of an exported blob. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
