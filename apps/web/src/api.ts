/** Client for the Python service. Vite proxies /api to it in development. */

import type { Alternative, Correction, StatResult, StatTest } from '@figureforge/doc-model';

const BASE = '/api';

export interface AnalyzeRequest {
  test: StatTest;
  groups: { name: string; values: number[] }[];
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

export async function health(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
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
