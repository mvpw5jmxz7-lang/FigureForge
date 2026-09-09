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

/** Matches `FitAlign` in geometry.ts — where letterboxed content sits. */
const fitAlignSchema = z.enum(['start', 'middle', 'end']);

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

const textRunSchema = z.object({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  script: z.enum(['sup', 'sub']).optional(),
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
  scale: z.enum(['linear', 'log10', 'symlog']),
  showLine: z.boolean(),
  showTicks: z.boolean(),
  showLabels: z.boolean(),
  trimToData: z.boolean(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  minorTicks: z.number().int().min(0).max(20).optional(),
  tickDirection: z.enum(['out', 'in']).optional(),
  breaks: z.array(z.object({ from: finite, to: finite })).optional(),
  labelFormat: z.enum(['auto', 'plain', 'scientific', 'power10']).optional(),
  labelDecimals: z.number().int().min(0).max(6).optional(),
  linthresh: finite.positive().optional(),
  clipToRange: z.boolean().optional(),
  richText: z.array(textRunSchema).optional(),
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
      // Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note.
      autoFit: z.boolean().optional(),
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
    'ecdf',
    'volcano',
    'fold-fold',
    'heatmap',
    'survival',
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
  histogramStyle: z.enum(['overlay', 'step']).optional(),
  histogramCumulative: z.boolean().optional(),
  histogramNormalize: z.enum(['count', 'frequency', 'density']).optional(),
  // Absent reads as on, so this line exists to carry an explicit `false` —
  // without it, turning the marker off would not survive a save.
  ksGapMarker: z.boolean().optional(),
  errorBarDirection: z.enum(['both', 'up']).optional(),
  pointShape: z
    .enum(['circle', 'square', 'triangle', 'triangle-down', 'diamond', 'pentagon', 'cross', 'star'])
    .optional(),
  pointShapes: z
    .array(
      z
        .enum(['circle', 'square', 'triangle', 'triangle-down', 'diamond', 'pentagon', 'cross', 'star'])
        .nullable(),
    )
    .optional(),
  pointFill: z.string().optional(),
  pointStroke: strokeSchema.optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  lineStyle: z.enum(['solid', 'dashed', 'dotted', 'dash-dot']).optional(),
  lineStyles: z.array(z.enum(['solid', 'dashed', 'dotted', 'dash-dot']).nullable()).optional(),
  y2: axisSchema.optional(),
  seriesAxis: z.array(z.enum(['y', 'y2'])).optional(),
  legend: z.enum(['auto', 'right', 'bottom', 'none']).optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  orientation: z.enum(['vertical', 'horizontal']).optional(),
  errorDisplay: z.enum(['bars', 'band']).optional(),
  showReplicates: z.boolean().optional(),
  // Capped below 1 rather than at it: d3's band scale gives zero bandwidth at a
  // padding of 1, which is a plot of invisible bars.
  barGapFraction: finite.min(0).max(0.9).optional(),
  groupGapFraction: finite.min(0).max(0.9).optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  volcanoThresholds: z
    .object({
      foldChange: nonNeg,
      pValue: finite.gt(0).max(1),
      fdr: finite.gt(0).max(1).optional(),
      significanceBy: z.enum(['p-value', 'fdr']).optional(),
    })
    .optional(),
  volcanoColors: z
    .object({ down: z.string(), ns: z.string(), up: z.string() })
    .optional(),
  volcanoThresholdLines: z.enum(['show', 'hide']).optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  foldFoldThresholds: z
    .object({ x: nonNeg, y: nonNeg, rule: z.enum(['both', 'either']).optional() })
    .optional(),
  foldFoldColorBy: z.enum(['significant', 'quadrant']).optional(),
  // Every category required once the field is present, exactly as
  // `volcanoColors` is: the Inspector writes the merged record, so a document
  // either carries the whole set or none of it.
  foldFoldColors: z
    .object({
      ns: z.string(),
      sig: z.string(),
      'up-up': z.string(),
      'down-down': z.string(),
      'up-down': z.string(),
      'down-up': z.string(),
    })
    .optional(),
  foldFoldZeroLines: z.enum(['show', 'hide']).optional(),
  foldFoldCutoffLines: z.enum(['show', 'hide']).optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  trendLine: z.enum(['show', 'hide']).optional(),
  trendInterval: z.enum(['none', 'confidence', 'prediction']).optional(),
  trendExtent: z.enum(['data', 'axis']).optional(),
  // Deliberately no `.max()` — see the field's own doc comment in nodes.ts.
  volcanoLabels: z.array(z.string()).optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  volcanoPValueIsNegLog10: z.boolean().optional(),
  volcanoSamCurve: z
    .object({ up: z.array(pointSchema), down: z.array(pointSchema) })
    .optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  volcanoTest: z
    .object({
      s0: finite,
      fdrPercent: finite,
      fdrAchieved: finite,
      deltaUsed: finite,
      cutUp: finite,
      cutLow: finite,
      mode: z.enum(['two-sample', 'one-sample']),
      nTested: z.number().int().min(0),
      nUp: z.number().int().min(0),
      nDown: z.number().int().min(0),
      methodsSentence: z.string(),
    })
    .optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  pointLabelOffsets: z.record(z.string(), pointSchema).optional(),
  pointLabelSizePt: finite.positive().optional(),
  // Deliberately no `.max()`, for the reason `volcanoLabels` has none: a bound
  // here would make a hand-edited file unopenable. The ceiling is applied when
  // the value is read. See the field's own doc comment in nodes.ts.
  pointLabelLimit: z.number().int().positive().optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  heatmapScale: z.enum(['sequential', 'diverging']).optional(),
  heatmapStops: z.array(z.string()).optional(),
  heatmapMissingColor: z.string().optional(),
  showCellValues: z.boolean().optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  showCensorMarks: z.boolean().optional(),
  showSurvivalCI: z.boolean().optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  offsetStepMm: finite.optional(),
  offsetStepXMm: finite.optional(),
  offsetFill: z.enum(['none', 'tint', 'solid']).optional(),
  showCascadeAxis: z.boolean().optional(),
  cascadeAxisTitle: z.string().optional(),
  cascadeAxisTitleRichText: z.array(textRunSchema).optional(),
  boxed: z.boolean().optional(),
  showGridlines: z.boolean().optional(),
  gridlineColor: z.enum(['grey', 'black']).optional(),
  gridlineStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
  reverseLegend: z.boolean().optional(),
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
  // Optional: post-date SCHEMA_VERSION 1. See the bracket schema's note.
  alignX: fitAlignSchema.optional(),
  alignY: fitAlignSchema.optional(),
});

const textSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('text'),
  text: z.string(),
  // Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note.
  richText: z.array(textRunSchema).optional(),
  style: textStyleSchema,
});

const panelLabelSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('panel-label'),
  text: z.string(),
  style: textStyleSchema,
  panelId: z.string(),
  liftMm: z.number().optional(),
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
  /** Optional: post-dates SCHEMA_VERSION 1. Absent reads as 'inside'. */
  placement: z.enum(['inside', 'below']).optional(),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  calibrationSource: z.enum(['metadata', 'manual', 'measured', 'unknown']).optional(),
});

const groupSchema = z.object({ ...nodeBaseShape, type: z.literal('group') });

const groupLabelSchema = z.object({
  ...nodeBaseShape,
  type: z.literal('group-label'),
  memberIds: z.array(z.string()).min(1),
  edge: z.enum(['top', 'left', 'right']),
  title: z.string(),
  richText: z.array(textRunSchema).optional(),
  showRule: z.boolean().optional(),
  gapMm: nonNeg.optional(),
  placement: z.enum(['outside', 'overlay']).optional(),
  labelColor: z.string().optional(),
  stroke: strokeSchema.optional(),
  style: textStyleSchema.optional(),
  userOffsetMm: pointSchema.optional(),
});

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
  groupLabelSchema,
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
    'differential',
    'fold-fold',
    'matrix',
    'survival',
    'pca',
    'umap',
    'proteomics',
    'distribution',
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
  derivedFrom: z
    .object({ datasetId: z.string(), kind: z.literal('volcano-test') })
    .optional(),
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
  /**
   * Optional: post-dates SCHEMA_VERSION 1. Not cosmetic — without this line
   * zod would strip the bracket on save, so a stored Anderson–Darling result
   * would reopen reporting its clamped 0.001 as a point value.
   */
  pBound: z.enum(['below', 'above']).nullable().optional(),
  /**
   * Also optional and post-SCHEMA_VERSION-1, and load-bearing for the same
   * reason: without these two lines zod strips them on save, and a saved
   * figure reopens with its KS gap marker silently gone from a plot that was
   * drawing one when it was saved.
   */
  statisticLocation: finite.nullable().optional(),
  statisticSign: finite.nullable().optional(),
});

/**
 * Every term required, once the object is present at all: the service drops a
 * fit whole rather than emitting a partial one, so a document either carries
 * the complete set or none of it — the same all-or-nothing rule
 * `foldFoldColors` follows for the same reason.
 */
const regressionFitSchema = z.object({
  slope: finite,
  intercept: finite,
  n: z.number().int().positive(),
  meanX: finite,
  sumSquaredDevX: finite.positive(),
  residualSe: finite.nonnegative(),
  tMultiplier: finite,
  confidenceLevel: finite.positive().max(1),
  xMin: finite,
  xMax: finite,
});

const statResultSchema = z.object({
  test: z.string(),
  omnibus: z
    .object({
      statistic: finite,
      p: finite,
      df: z.array(finite).nullable(),
      /** As the comparison's own `pBound`. */
      pBound: z.enum(['below', 'above']).nullable().optional(),
    })
    .nullable(),
  comparisons: z.array(comparisonSchema),
  /** Optional: post-dates SCHEMA_VERSION 1. See the bracket schema's note. */
  fit: regressionFitSchema.nullable().optional(),
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
    if (node.type === 'group-label') {
      const memberIds = Array.isArray(anyNode['memberIds']) ? (anyNode['memberIds'] as unknown[]) : [];
      if (memberIds.length === 0) {
        issues.push({ path: `nodes.${key}.memberIds`, message: 'a group-label needs at least one member' });
      }
      for (const memberId of memberIds) {
        if (!doc.nodes[String(memberId)]) {
          issues.push({ path: `nodes.${key}.memberIds`, message: `unknown member "${String(memberId)}"` });
        }
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
