/**
 * Runtime validation for documents read from disk.
 *
 * A .figureforge file is untrusted input — it may have been written by an older
 * build, hand-edited, or truncated. Everything entering the app through
 * `loadArchive` passes through here first, so the rest of the codebase can rely
 * on the static types actually holding at runtime.
 */

import { z } from 'zod';
import { SCHEMA_VERSION } from './document.js';

const finite = z.number().finite();
const nonNeg = finite.nonnegative();

const rectSchema = z.object({
  x: finite,
  y: finite,
  width: nonNeg,
  height: nonNeg,
});

const pointSchema = z.object({ x: finite, y: finite });

const strokeSchema = z.object({
  color: z.string(),
  widthMm: nonNeg,
  dash: z.array(nonNeg).optional(),
  cap: z.enum(['butt', 'round', 'square']).optional(),
});

const fillSchema = z.object({
  color: z.string(),
  opacity: finite.min(0).max(1).optional(),
});

const textStyleSchema = z.object({
  fontFamily: z.string().optional(),
  fontSizePt: finite.positive().optional(),
  fontWeight: z.enum(['normal', 'bold']).optional(),
  fontStyle: z.enum(['normal', 'italic']).optional(),
  color: z.string().optional(),
  lineHeight: finite.positive().optional(),
  align: z.enum(['start', 'middle', 'end']).optional(),
  baseline: z.enum(['top', 'middle', 'bottom', 'alphabetic']).optional(),
  letterSpacingPt: finite.optional(),
});

const nodeBaseShape = {
  id: z.string().min(1),
  name: z.string(),
  parentId: z.string().nullable(),
  layerId: z.string(),
  frame: rectSchema,
  rotation: finite,
  opacity: finite.min(0).max(1),
  locked: z.boolean(),
  hidden: z.boolean(),
  z: finite,
};

const axisSchema = z.object({
  title: z.string(),
  min: finite.nullable(),
  max: finite.nullable(),
  tickStep: finite.positive().nullable(),
  scale: z.enum(['linear', 'log10']),
  showLine: z.boolean(),
  showTicks: z.boolean(),
  showLabels: z.boolean(),
  trimToData: z.boolean(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  minorTicks: z.number().int().min(0).max(20).optional(),
  tickDirection: z.enum(['out', 'in']).optional(),
  breaks: z.array(z.object({ from: finite, to: finite })).optional(),
});

const panelSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('panel'),
  label: z.string().nullable(),
  aspectLock: finite.positive().nullable(),
  background: fillSchema.nullable(),
  border: strokeSchema.nullable(),
  paddingMm: nonNeg,
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  slot: z
    .object({
      row: z.number().int().min(0),
      col: z.number().int().min(0),
      rowSpan: z.number().int().positive().optional(),
      colSpan: z.number().int().positive().optional(),
    })
    .nullable()
    .optional(),
  contentGrid: z
    .object({
      rows: z.number().int().positive(),
      cols: z.number().int().positive(),
      gutterMm: finite.min(0),
    })
    .optional(),
});

const plotSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('plot'),
  plotType: z.enum([
    'bar',
    'dot',
    'bar-dot',
    'scatter',
    'line',
    'box',
    'violin',
    'beeswarm',
    'histogram',
  ]),
  datasetId: z.string(),
  encoding: z.object({
    x: z.string().optional(),
    y: z.string().optional(),
    group: z.string().optional(),
    valueColumns: z.array(z.string()).optional(),
  }),
  x: axisSchema,
  y: axisSchema,
  center: z.enum(['mean', 'median']),
  errorBars: z.enum(['none', 'sd', 'sem', 'ci95', 'range', 'iqr']),
  showPoints: z.boolean(),
  pointSizeMm: nonNeg,
  jitterMm: nonNeg,
  barWidthFraction: finite.min(0).max(1),
  palette: z.union([z.string(), z.array(z.string())]),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  pointsUseSeriesColor: z.boolean().optional(),
  histogramBins: z.number().int().positive().optional(),
  errorBarDirection: z.enum(['both', 'up']).optional(),
  pointShape: z.enum(['circle', 'square', 'triangle', 'diamond']).optional(),
  pointShapes: z
    .array(z.enum(['circle', 'square', 'triangle', 'diamond']).nullable())
    .optional(),
  pointFill: z.string().optional(),
  pointStroke: strokeSchema.optional(),
  y2: axisSchema.optional(),
  seriesAxis: z.array(z.enum(['y', 'y2'])).optional(),
  legend: z.enum(['auto', 'right', 'bottom', 'none']).optional(),
  errorDisplay: z.enum(['bars', 'band']).optional(),
  showReplicates: z.boolean().optional(),
  // Capped below 1 rather than at it: d3's band scale gives zero bandwidth at a
  // padding of 1, which is a plot of invisible bars.
  barGapFraction: finite.min(0).max(0.9).optional(),
  groupGapFraction: finite.min(0).max(0.9).optional(),
});

const imageSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('image'),
  assetId: z.string(),
  naturalPx: z.object({ width: nonNeg, height: nonNeg }),
  /**
   * Normalised source coordinates. The extents are `.gt(0)` rather than merely
   * non-negative because zero divides by zero in `renderImage` (`width /
   * crop.width`) while reading as a *full* frame in `checkImageResolution`,
   * which uses `crop.width || 1` — the same document giving two different
   * answers. `normaliseCrop` in operations.ts is the writer that enforces it.
   *
   * Narrowing a schema can reject a previously valid file, which would normally
   * force a SCHEMA_VERSION bump. It cannot here: nothing could create an image
   * node before this change, so no file in existence contains one.
   */
  crop: z.object({
    x: finite.min(0).max(1),
    y: finite.min(0).max(1),
    width: finite.gt(0).max(1),
    height: finite.gt(0).max(1),
  }),
  preserveAspect: z.boolean(),
});

const textSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('text'),
  text: z.string(),
  style: textStyleSchema,
});

const panelLabelSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('panel-label'),
  text: z.string(),
  style: textStyleSchema,
  panelId: z.string(),
});

const shapeSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line']),
  fill: fillSchema.nullable(),
  stroke: strokeSchema.nullable(),
  cornerRadiusMm: nonNeg.optional(),
});

const arrowSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('arrow'),
  points: z.array(pointSchema).min(2),
  stroke: strokeSchema,
  head: z.enum(['none', 'triangle', 'open']),
  headSizeMm: nonNeg,
  tail: z.enum(['none', 'triangle', 'open']),
});

const bracketSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('bracket'),
  analysisId: z.string().nullable(),
  // Optional throughout: these post-date SCHEMA_VERSION 1, and zod strips
  // unknown keys, so a field missing here would be silently lost on save.
  plotId: z.string().nullable().optional(),
  userOffsetMm: z.object({ x: finite, y: finite }).optional(),
  comparisonIndex: z.number().int().min(0).optional(),
  gapMm: nonNeg.optional(),
  label: z.string(),
  style: textStyleSchema,
  stroke: strokeSchema,
  tickMm: nonNeg,
});

const scaleBarSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('scale-bar'),
  length: finite.positive(),
  unitLabel: z.string(),
  pixelsPerUnit: finite.positive(),
  /** Deprecated in the drawing path; `labelPosition` decides. See nodes.ts. */
  showLabel: z.boolean(),
  style: textStyleSchema,
  fill: fillSchema,
  barHeightMm: nonNeg,
  labelPosition: z.enum(['above', 'below', 'none']),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  calibrationSource: z.enum(['metadata', 'manual', 'measured', 'unknown']).optional(),
});

const groupSchema = z.object({ ...nodeBaseShape, type: z.literal('group') });

export const nodeSchema = z.discriminatedUnion('type', [
  panelSchema,
  plotSchema,
  imageSchema,
  textSchema,
  panelLabelSchema,
  shapeSchema,
  arrowSchema,
  bracketSchema,
  scaleBarSchema,
  groupSchema,
]);

const cellSchema = z.union([finite, z.string(), z.null()]);

const datasetSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Loosening an enum is backward-compatible: an older build cannot read a
  // contingency dataset, but every file it *has* still validates here.
  format: z.enum([
    'simple-xy',
    'prism',
    'sigmaplot',
    'grouped',
    'replicate',
    'contingency',
    'grouped-replicates',
    'xy-replicates',
    'nested',
  ]),
  columns: z.array(z.object({ name: z.string(), kind: z.enum(['number', 'text']) })),
  rows: z.array(z.array(cellSchema)),
  // Optional, so files written before it still load. zod strips unknown keys,
  // so a field present only on the TS type is dropped on save — this is the
  // half that makes it survive.
  hasRowNames: z.boolean().optional(),
  columnGroups: z
    .array(z.object({ name: z.string(), from: z.number().int().min(0), to: z.number().int().min(0) }))
    .optional(),
  editedAt: z.string().optional(),
  sourcePath: z.string().nullable(),
  sourceFilename: z.string().nullable(),
  importedAt: z.string(),
});

const comparisonSchema = z.object({
  groupA: z.string(),
  groupB: z.string(),
  statistic: finite,
  p: finite,
  pAdjusted: finite,
  df: finite.nullable(),
  ci: z.tuple([finite, finite]).nullable(),
  effectSize: finite.nullable(),
  effectSizeName: z.string().nullable(),
  n: z.array(nonNeg),
});

const statResultSchema = z.object({
  test: z.string(),
  omnibus: z
    .object({ statistic: finite, p: finite, df: z.array(finite).nullable() })
    .nullable(),
  comparisons: z.array(comparisonSchema),
  methodsSentence: z.string(),
  warnings: z.array(z.string()),
  softwareVersions: z.record(z.string()),
});

const analysisSchema = z.object({
  id: z.string(),
  name: z.string(),
  test: z.string(),
  spec: z.object({ datasetId: z.string(), groups: z.array(z.string()) }),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  plotId: z.string().nullable().optional(),
  options: z.object({
    alternative: z.enum(['two-sided', 'less', 'greater']),
    correction: z.enum(['none', 'bonferroni', 'holm', 'benjamini-hochberg', 'tukey', 'dunn']),
    alpha: finite.positive().max(1),
    welch: z.boolean(),
  }),
  inputHash: z.string(),
  result: statResultSchema.nullable(),
  computedAt: z.string().nullable(),
});

const layerSchema = z.object({
  id: z.string(),
  name: z.string(),
  locked: z.boolean(),
  hidden: z.boolean(),
  z: finite,
});

const assetSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  path: z.string(),
  byteLength: nonNeg,
  naturalPx: z.object({ width: nonNeg, height: nonNeg }).nullable(),
});

export const documentSchema = z.object({
  schemaVersion: z.number().int().positive(),
  id: z.string(),
  title: z.string(),
  page: z.object({
    widthMm: finite.positive(),
    heightMm: finite.positive(),
    presetId: z.string().nullable(),
    displayUnit: z.enum(['mm', 'cm', 'in', 'px']),
    background: z.string(),
  }),
  themeId: z.string(),
  themeOverrides: z.record(z.unknown()),
  datasets: z.array(datasetSchema),
  analyses: z.array(analysisSchema),
  assets: z.array(assetSchema),
  layers: z.array(layerSchema),
  nodes: z.record(nodeSchema),
  grid: z.object({
    spacingMm: finite.positive(),
    snap: z.boolean(),
    visible: z.boolean(),
    smartGuides: z.boolean(),
    toleranceMm: nonNeg,
  }),
  createdAt: z.string(),
  modifiedAt: z.string(),
});

export type ValidationIssue = { path: string; message: string };

export interface ValidationResult<T> {
  ok: boolean;
  value: T | null;
  issues: ValidationIssue[];
}

export function validateDocument(input: unknown): ValidationResult<unknown> {
  const parsed = documentSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data, issues: [] };
  }
  return {
    ok: false,
    value: null,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}

/**
 * Structural checks the type system cannot express: dangling references and
 * parent cycles. A cycle here would hang the renderer's depth-first walk, so it
 * is worth catching at load rather than at draw.
 */
export function checkReferentialIntegrity(doc: {
  nodes: Record<string, { id: string; parentId: string | null; layerId: string; type: string }>;
  layers: readonly { id: string }[];
  datasets: readonly { id: string }[];
  assets: readonly { id: string }[];
  analyses: readonly { id: string }[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const layerIds = new Set(doc.layers.map((l) => l.id));
  const datasetIds = new Set(doc.datasets.map((d) => d.id));
  const assetIds = new Set(doc.assets.map((a) => a.id));
  const analysisIds = new Set(doc.analyses.map((a) => a.id));

  for (const [key, node] of Object.entries(doc.nodes)) {
    if (key !== node.id) {
      issues.push({ path: `nodes.${key}`, message: `map key does not match node id "${node.id}"` });
    }
    if (node.parentId !== null && !doc.nodes[node.parentId]) {
      issues.push({ path: `nodes.${key}.parentId`, message: `unknown parent "${node.parentId}"` });
    }
    if (!layerIds.has(node.layerId)) {
      issues.push({ path: `nodes.${key}.layerId`, message: `unknown layer "${node.layerId}"` });
    }

    const anyNode = node as Record<string, unknown>;
    if (node.type === 'plot' && !datasetIds.has(String(anyNode['datasetId']))) {
      issues.push({ path: `nodes.${key}.datasetId`, message: 'unknown dataset' });
    }
    if (node.type === 'image' && !assetIds.has(String(anyNode['assetId']))) {
      issues.push({ path: `nodes.${key}.assetId`, message: 'unknown asset' });
    }
    if (node.type === 'panel-label' && !doc.nodes[String(anyNode['panelId'])]) {
      issues.push({ path: `nodes.${key}.panelId`, message: 'unknown panel' });
    }
    if (node.type === 'bracket') {
      const analysisId = anyNode['analysisId'];
      if (analysisId !== null && !analysisIds.has(String(analysisId))) {
        issues.push({ path: `nodes.${key}.analysisId`, message: 'unknown analysis' });
      }
    }

    // Walk to root; a cycle is detectable by exceeding the node count.
    let hops = 0;
    let cursor = node.parentId;
    const limit = Object.keys(doc.nodes).length + 1;
    while (cursor !== null && hops <= limit) {
      cursor = doc.nodes[cursor]?.parentId ?? null;
      hops++;
    }
    if (hops > limit) {
      issues.push({ path: `nodes.${key}.parentId`, message: 'parent chain contains a cycle' });
    }
  }

  for (const analysis of doc.analyses) {
    const spec = (analysis as unknown as { spec?: { datasetId?: string } }).spec;
    if (spec?.datasetId && !datasetIds.has(spec.datasetId)) {
      issues.push({ path: `analyses.${analysis.id}.spec.datasetId`, message: 'unknown dataset' });
    }
  }

  return issues;
}

export const isSupportedVersion = (version: number): boolean =>
  Number.isInteger(version) && version >= 1 && version <= SCHEMA_VERSION;
