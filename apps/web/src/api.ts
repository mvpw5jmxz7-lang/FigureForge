/** Client for the Python service. Vite proxies /api to it in development. */

import type { Alternative, Correction, StatResult, StatTest } from '@figureforge/doc-model';

// Type-only, for the ambient `window.figureforge` declaration; emits nothing,
// so a browser build carries no trace of the shell.
import type {} from './shell.js';

/**
 * Where the service is.
 *
 * In the browser this is the same-origin path Vite proxies, and always was.
 * The desktop shell owns the service as a child process on a port chosen at
 * runtime, so the base cannot be a constant there — and it is read per call
 * rather than captured once because a sidecar that crashes and restarts may
 * come back on a different port.
 *
 * Guarded for a missing `window` because the test suite runs in Node.
 */
const base = (): string => {
  if (typeof window === 'undefined') return '/api';
  return window.figureforge?.apiBase?.() || '/api';
};

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
  const response = await fetch(`${base()}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as StatResult;
}

export interface PcaRequest {
  rowLabels: string[];
  values: (number | null)[][];
  /** Divide each feature by its own sample SD after centering. Default false. */
  standardize?: boolean;
}

export interface PcaComponent {
  label: string;
  explainedVarianceRatio: number;
}

export interface PcaResult {
  /** Same order as `scores`; excludes any sample dropped for a missing value. */
  sampleLabels: string[];
  /** `scores[i]` are sample `sampleLabels[i]`'s component values, PC1 first. */
  scores: number[][];
  components: PcaComponent[];
  droppedSamples: string[];
  warnings: string[];
}

export async function runPca(request: PcaRequest): Promise<PcaResult> {
  const response = await fetch(`${base()}/pca`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as PcaResult;
}

export interface UmapRequest {
  rowLabels: string[];
  values: (number | null)[][];
  /** Divide each feature by its own sample SD after centering. Default false. */
  standardize?: boolean;
}

export interface UmapResult {
  /** Same order as `coords`; excludes any sample dropped for a missing value. */
  sampleLabels: string[];
  /** `coords[i]` are sample `sampleLabels[i]`'s [UMAP1, UMAP2]. */
  coords: number[][];
  droppedSamples: string[];
  warnings: string[];
  /** The neighbour count actually used, after clamping to `n_samples - 1`. */
  nNeighborsUsed: number;
}

export async function runUmap(request: UmapRequest): Promise<UmapResult> {
  const response = await fetch(`${base()}/umap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as UmapResult;
}

/**
 * A panel as the AI layout assistant is told about it — metadata only, never
 * pixel data or the dataset's own values. See `aiLayoutAssistant.ts`, which
 * builds this from the document and is the only caller of the two functions
 * below.
 */
export interface AiPanelSummary {
  panelId: string;
  letter: string;
  plotType?: string;
  axisTitles?: string[];
  datasetName?: string;
  captionText?: string;
}

export interface SuggestPanelGroupingRequest {
  panels: AiPanelSummary[];
  /** A user's own Anthropic key, if they have set one. See `apiKeyStore.ts`. */
  apiKey?: string;
}

export interface AiGroupSuggestion {
  panelIds: string[];
  rationale: string;
}

export interface SuggestPanelGroupingResult {
  groups: AiGroupSuggestion[];
}

export async function suggestPanelGrouping(
  request: SuggestPanelGroupingRequest,
): Promise<SuggestPanelGroupingResult> {
  const response = await fetch(`${base()}/layout/suggest-grouping`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as SuggestPanelGroupingResult;
}

export interface InterpretLayoutInstructionRequest {
  instruction: string;
  panels: AiPanelSummary[];
  /** A user's own Anthropic key, if they have set one. See `apiKeyStore.ts`. */
  apiKey?: string;
}

/**
 * A closed shape, not free text — only the fields `kind` names are ever
 * populated. See `aiLayoutAssistant.ts`'s `LayoutInstruction`, which turns
 * this wire shape into a real discriminated union and re-validates every id
 * against the panels the request actually sent.
 */
export interface LayoutInstructionResult {
  kind: 'group' | 'resize' | 'unsupported';
  reason: string;
  panelIds?: string[] | null;
  panelId?: string | null;
  direction?: 'bigger' | 'smaller' | null;
}

export async function interpretLayoutInstruction(
  request: InterpretLayoutInstructionRequest,
): Promise<LayoutInstructionResult> {
  const response = await fetch(`${base()}/layout/interpret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as LayoutInstructionResult;
}

/**
 * Verifies a user-supplied Anthropic key with one cheap, minimal call —
 * distinct from `suggestPanelGrouping`/`interpretLayoutInstruction` so a bad
 * key is reported plainly (401) rather than conflated with "the model
 * declined this request" (422/500).
 */
export async function testApiKey(apiKey: string): Promise<{ ok: true }> {
  const response = await fetch(`${base()}/layout/test-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as { ok: true };
}

export interface VolcanoTestRequest {
  rowLabels: string[];
  values: (number | null)[][];
  /** Absent means 'two-sample', matching the server's own default. */
  mode?: 'two-sample' | 'one-sample';
  groupAIndices?: number[];
  groupBIndices?: number[];
  /** One-sample mode only: the replicate value columns, tested against zero. */
  valueIndices?: number[];
  s0: number;
  fdrPercent: number;
}

export interface SamVolcanoRow {
  label: string;
  log2FoldChange: number;
  pValue: number;
  qValue: number;
  category: 'up' | 'down' | 'ns';
}

export interface VolcanoTestResult {
  rows: SamVolcanoRow[];
  /** [log2FoldChange, -log10 p] points sampled along each branch, unsorted. */
  curveUp: [number, number][];
  curveDown: [number, number][];
  droppedRows: string[];
  warnings: string[];
  deltaUsed: number;
  fdrAchieved: number;
  /** The two resolved cutoffs on `d`; independent, so not mirror images. */
  cutUp: number;
  cutLow: number;
  permutations: number;
  permutationsExhaustive: boolean;
  /** Ready-to-paste manuscript sentence, composed by the service. */
  methodsSentence: string;
}

export async function runVolcanoTest(request: VolcanoTestRequest): Promise<VolcanoTestResult> {
  const response = await fetch(`${base()}/volcano-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as VolcanoTestResult;
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
  const response = await fetch(`${base()}/export`, {
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

  const response = await fetch(`${base()}/decode-image`, { method: 'POST', body });
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
    const response = await fetch(`${base()}/health`);
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
