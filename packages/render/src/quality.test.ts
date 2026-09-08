/**
 * Quality checker rules.
 *
 * These assert the checker's *judgements*, not its plumbing — a rule that never
 * fires is worse than no rule, because the readiness score then reads as a pass.
 */

import { describe, expect, it } from 'vitest';
import {
  addAsset,
  addPanelWithImage,
  addPanelWithPlot,
  addScaleBar,
  addText,
  createDocument,
  createIdFactory,
  deleteNode,
  DocumentStore,
  editDocument,
  inferFormat,
  parseDelimited,
  relabelPanels,
  setImageCrop,
  stableStringify,
  toSeries,
  updateNode,
  analysisInputHash,
  xForHash,
  type CalibrationSource,
  type Dataset,
  type FigureDocument,
  type PlotNode,
  type PlotType,
  type TextNode,
} from '@figureforge/doc-model';
import { NATURE_THEME, resolveTheme, type Theme } from '@figureforge/theme';
import { MAX_VECTOR_POINTS, renderDocument } from './render-document.js';
import { checkFigure, type Finding } from './quality.js';

/** Paired x and y, the shape a correlation needs. */
const XY_CSV = `Dose,Response
1,2.1
2,3.9
3,6.2
4,7.8
5,10.1
6,12.4`;

/** Three replicates per group — the sample size biology actually runs. */
const SMALL = `Treatment,Rep1,Rep2,Rep3
Vehicle,98.2,95.4,101.3
Drug,42.1,38.7,45.3`;

/** Twelve replicates, enough to support a density estimate. */
const LARGE = `Treatment,R1,R2,R3,R4,R5,R6,R7,R8,R9,R10,R11,R12
Vehicle,98,95,101,97,99,96,102,94,100,98,97,103
Drug,42,39,45,41,43,40,44,38,46,42,41,47`;

function makeDocument(csv: string, plotType: PlotType): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'Quality figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const parsed = parseDelimited(csv);
    const dataset: Dataset = {
      id: newId(),
      name: 'Viability',
      format: inferFormat(parsed.columns),
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/viability.csv',
      sourceFilename: 'viability.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Viability',
      datasetId: dataset.id,
      plotType,
      yTitle: 'Cell viability (%)',
    });
  });
}

function findingsFor(csv: string, plotType: PlotType) {
  const document = makeDocument(csv, plotType);
  const scene = renderDocument(document, { theme: NATURE_THEME });
  return checkFigure({ document, theme: NATURE_THEME, scene }).findings;
}

describe('distribution sample size', () => {
  const ids = (csv: string, plotType: PlotType) =>
    findingsFor(csv, plotType)
      .filter((f) => f.id.startsWith('distribution-n-'))
      .map((f) => f.title);

  it('warns about a violin drawn over three replicates', () => {
    // Kernel density turns three numbers into a smooth, confident-looking
    // shape. The reader sees a distribution; the data supports nothing of it.
    expect(ids(SMALL, 'violin')).toEqual(['Violin plot with n = 3']);
  });

  it('warns about a box plot below the quartile threshold', () => {
    expect(ids(SMALL, 'box')).toEqual(['Box plot with n = 3']);
  });

  it('stays quiet once the sample supports the mark', () => {
    expect(ids(LARGE, 'violin')).toEqual([]);
    expect(ids(LARGE, 'box')).toEqual([]);
  });

  it('says nothing about plots that draw every replicate', () => {
    // A beeswarm at n = 3 shows three points and claims nothing more.
    for (const plotType of ['bar', 'dot', 'bar-dot', 'beeswarm'] as const) {
      expect(ids(SMALL, plotType)).toEqual([]);
    }
  });

  it('costs the readiness score when it fires', () => {
    const withWarning = makeDocument(SMALL, 'violin');
    const clean = makeDocument(LARGE, 'violin');

    const score = (doc: FigureDocument) =>
      checkFigure({
        document: doc,
        theme: NATURE_THEME,
        scene: renderDocument(doc, { theme: NATURE_THEME }),
      }).score;

    expect(score(withWarning)).toBeLessThan(score(clean));
  });
});

// ---------------------------------------------------------------------------
// Point cloud rasterization
// ---------------------------------------------------------------------------

function xyDocument(rowCount: number, plotType: PlotType): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'XY figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const rows = Array.from({ length: rowCount }, (_, i) => `${i},${Math.cos(i)}`);
    const parsed = parseDelimited(`X,Y\n${rows.join('\n')}`);
    const dataset: Dataset = {
      id: newId(),
      name: 'Cloud',
      format: inferFormat(parsed.columns),
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/cloud.csv',
      sourceFilename: 'cloud.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Cloud',
      datasetId: dataset.id,
      plotType,
      xTitle: 'X',
      yTitle: 'Y',
    });
  });
}

function reportFor(document: FigureDocument) {
  return checkFigure({
    document,
    theme: NATURE_THEME,
    scene: renderDocument(document, { theme: NATURE_THEME }),
  });
}

describe('point cloud rasterization', () => {
  it('says nothing about a plot at or under the threshold', () => {
    const findings = reportFor(xyDocument(MAX_VECTOR_POINTS, 'scatter')).findings;
    expect(findings.filter((f) => f.id.startsWith('point-cloud-raster-'))).toEqual([]);
  });

  it('discloses the count, without dropping or sampling anything, once over it', () => {
    const findings = reportFor(xyDocument(MAX_VECTOR_POINTS + 500, 'scatter')).findings;
    const finding = findings.find((f) => f.id.startsWith('point-cloud-raster-'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
    expect(finding?.title).toContain((MAX_VECTOR_POINTS + 500).toLocaleString());
    expect(finding?.detail).toMatch(/none are dropped or sampled/);
  });

  it('never costs the readiness score, unlike a warning-level finding', () => {
    const withoutCloud = reportFor(xyDocument(MAX_VECTOR_POINTS, 'scatter')).score;
    const withCloud = reportFor(xyDocument(MAX_VECTOR_POINTS + 500, 'scatter')).score;
    expect(withCloud).toBe(withoutCloud);
  });
});

// ---------------------------------------------------------------------------
// Volcano dropped points
// ---------------------------------------------------------------------------

function volcanoDocument(csv: string, patch: Partial<PlotNode> = {}): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'Volcano figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const parsed = parseDelimited(csv);
    const dataset: Dataset = {
      id: newId(),
      name: 'Differential expression',
      format: 'differential',
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/volcano.csv',
      sourceFilename: 'volcano.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Volcano',
      datasetId: dataset.id,
      plotType: 'volcano',
    });

    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') Object.assign(node, patch);
    }
  });
}

describe('volcano dropped points', () => {
  it('says nothing when every row plots', () => {
    const findings = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001\nMYC,-1.8,0.02'),
    ).findings;
    expect(findings.filter((f) => f.id.startsWith('points-dropped-'))).toEqual([]);
  });

  it('discloses rows dropped for a missing or invalid cell', () => {
    const findings = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001\n,1.0,0.01\nMYC,n/a,0.02'),
    ).findings;
    const finding = findings.find((f) => f.id.startsWith('points-dropped-'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
    expect(finding?.title).toContain('2');
    expect(finding?.detail).toMatch(/2 of 3 rows/);
  });

  it('never costs the readiness score', () => {
    const clean = reportFor(volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001')).score;
    const withDrops = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001\n,1.0,0.01'),
    ).score;
    expect(withDrops).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// Point label placement and duplicates
// ---------------------------------------------------------------------------

describe('point label placement', () => {
  it('says nothing when every requested label is drawn', () => {
    const findings = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001\nMYC,-1.8,0.02', {
        volcanoLabels: ['TP53', 'MYC'],
      }),
    ).findings;
    expect(findings.filter((f) => f.id.startsWith('point-label-missing-'))).toEqual([]);
  });

  it('discloses a requested label that matched no point', () => {
    const findings = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001', {
        volcanoLabels: ['TP53', 'DOES-NOT-EXIST'],
      }),
    ).findings;
    const finding = findings.find((f) => f.id.startsWith('point-label-missing-'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
    expect(finding?.title).toContain('1 of 2');
  });

  it('never costs the readiness score', () => {
    const clean = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001', { volcanoLabels: ['TP53'] }),
    ).score;
    const withMissing = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001', {
        volcanoLabels: ['TP53', 'DOES-NOT-EXIST'],
      }),
    ).score;
    expect(withMissing).toBe(clean);
  });
});

describe('point label duplicates', () => {
  it('says nothing when no selected label repeats', () => {
    const findings = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001\nMYC,-1.8,0.02', {
        volcanoLabels: ['TP53', 'MYC'],
      }),
    ).findings;
    expect(findings.filter((f) => f.id.startsWith('point-label-duplicate-'))).toEqual([]);
  });

  it('discloses a selected label that names more than one row', () => {
    const findings = reportFor(
      volcanoDocument('Gene,log2FC,p\nDUP,2.1,0.001\nDUP,1.5,0.02\nOther,0.1,0.9', {
        volcanoLabels: ['DUP'],
      }),
    ).findings;
    const finding = findings.find((f) => f.id.startsWith('point-label-duplicate-'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
    expect(finding?.detail).toContain('"DUP" (2)');
  });

  it('never costs the readiness score', () => {
    const clean = reportFor(
      volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001', { volcanoLabels: ['TP53'] }),
    ).score;
    const withDup = reportFor(
      volcanoDocument('Gene,log2FC,p\nDUP,2.1,0.001\nDUP,1.5,0.02', {
        volcanoLabels: ['DUP'],
      }),
    ).score;
    expect(withDup).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// Colour accessibility
// ---------------------------------------------------------------------------

/** The two-group bar chart from `SMALL`, repainted with a chosen palette. */
function paletteFindings(palette: readonly string[]) {
  const document = editDocument(makeDocument(SMALL, 'bar-dot'), (draft) => {
    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') node.palette = [...palette];
    }
  });
  return reportFor(document).findings;
}

describe('colour accessibility', () => {
  it('names both offending colours and the condition when two series collide under CVD', () => {
    // A red/green pair that `findColorConflicts` collapses under deuteranopia.
    const finding = paletteFindings(['#d62728', '#2ca02c']).find(
      (f) => f.id === 'colour-blind-conflict',
    );
    expect(finding).toBeDefined();
    expect(finding?.title).toContain('#d62728');
    expect(finding?.title).toContain('#2ca02c');
    expect(finding?.title).toMatch(/deuteranopia|protanopia|tritanopia/);
  });

  it('names both colours when two series merge in greyscale, and points at the plots', () => {
    const finding = paletteFindings(['#4575b4', '#4a78b6']).find(
      (f) => f.id === 'grayscale-conflict',
    );
    expect(finding).toBeDefined();
    expect(finding?.title).toContain('#4575b4');
    expect(finding?.title).toContain('#4a78b6');
    expect(finding?.title).toContain('greyscale');
    // Unlike before, the greyscale finding can select the plots it is about.
    expect(finding?.nodeIds.length).toBeGreaterThan(0);
  });

  it('says nothing for a colour-safe palette', () => {
    const findings = paletteFindings(['#0072b2', '#e69f00']);
    expect(findings.filter((f) => f.id === 'colour-blind-conflict')).toEqual([]);
    expect(findings.filter((f) => f.id === 'grayscale-conflict')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Heatmap colour contrast
// ---------------------------------------------------------------------------

function heatmapDocument(patch: Partial<PlotNode> = {}): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'Heatmap figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const parsed = parseDelimited('Gene,S1,S2\nTP53,0,10\nMYC,10,0');
    const dataset: Dataset = {
      id: newId(),
      name: 'Matrix',
      format: 'matrix',
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/matrix.csv',
      sourceFilename: 'matrix.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Heatmap',
      datasetId: dataset.id,
      plotType: 'heatmap',
    });

    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') Object.assign(node, patch);
    }
  });
}

describe('heatmap colour contrast', () => {
  it('says nothing about the default sequential ramp', () => {
    const findings = reportFor(heatmapDocument()).findings;
    expect(findings.filter((f) => f.id.startsWith('heatmap-cvd-'))).toEqual([]);
  });

  it('discloses a ramp whose extremes are nearly indistinguishable', () => {
    const findings = reportFor(
      heatmapDocument({ heatmapStops: ['#4575b4', '#4a78b6'] }),
    ).findings;
    const finding = findings.find((f) => f.id.startsWith('heatmap-cvd-'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
    expect(finding?.detail).toMatch(/ΔE/);
    // The two ramp ends are named, so the Quality tab can draw their swatches.
    expect(finding?.detail).toContain('#4575b4');
    expect(finding?.detail).toContain('#4a78b6');
  });

  it('never costs the readiness score', () => {
    const clean = reportFor(heatmapDocument()).score;
    const closeRamp = reportFor(heatmapDocument({ heatmapStops: ['#4575b4', '#4a78b6'] })).score;
    expect(closeRamp).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// Cascade offset
// ---------------------------------------------------------------------------

function cascadeDocument(patch: Partial<PlotNode> = {}): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'Cascade figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const parsed = parseDelimited('X1\tY1\tX2\tY2\n1\t2\t1\t2\n2\t4\t2\t4');
    const dataset: Dataset = {
      id: newId(),
      name: 'Runs',
      format: inferFormat(parsed.columns),
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/runs.csv',
      sourceFilename: 'runs.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Cascade',
      datasetId: dataset.id,
      plotType: 'line',
    });

    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') Object.assign(node, patch);
    }
  });
}

describe('cascade offset', () => {
  it('says nothing about an ordinary overlaid line plot', () => {
    const findings = reportFor(cascadeDocument()).findings;
    expect(findings.filter((f) => f.id.startsWith('cascade-offset-'))).toEqual([]);
  });

  it('discloses the offset once one is set', () => {
    const findings = reportFor(cascadeDocument({ offsetStepMm: 10 })).findings;
    const finding = findings.find((f) => f.id.startsWith('cascade-offset-'));
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('info');
    expect(finding?.title).toContain('2');
    expect(finding?.detail).toContain('10 mm');
  });

  it('never costs the readiness score', () => {
    const clean = reportFor(cascadeDocument()).score;
    const cascaded = reportFor(cascadeDocument({ offsetStepMm: 10 })).score;
    expect(cascaded).toBe(clean);
  });

  it("reports an undersized depth-axis label/title through the ordinary text-size rule", () => {
    // `THEME_SIZE_KEYS` maps 'cascade-axis-label'/'cascade-axis-title' onto
    // the theme's ordinary tickLabelPt/axisTitlePt — proving they're wired,
    // the same way every other themed role already is.
    const doc = cascadeDocument({ offsetStepMm: 10, showCascadeAxis: true, cascadeAxisTitle: 'X' });
    const theme = resolveTheme('nature', {
      type: { ...NATURE_THEME.type, tickLabelPt: 3, axisTitlePt: 3 },
    });
    const ids = report(doc, theme).findings.map((f) => f.id);
    expect(ids).toContain('text-below-minimum-theme');
  });
});

// ---------------------------------------------------------------------------
// Image resolution
// ---------------------------------------------------------------------------

/**
 * 600 px at 50.8 mm is exactly 300 dpi — 50.8 mm is two inches, so the maths is
 * exact and the boundary case does not rest on floating-point luck.
 */
const EXACT_300_DPI_MM = 50.8;

function imageDocument(options: {
  widthMm: number;
  naturalPx?: { width: number; height: number };
  mimeType?: string;
  cropWidth?: number;
}): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'Micrograph figure',
    widthMm: 183,
    heightMm: 120,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const naturalPx = options.naturalPx ?? { width: 600, height: 400 };

  return editDocument(base, (draft) => {
    addAsset(draft, {
      id: 'asset-1',
      filename: options.mimeType === 'image/svg+xml' ? 'diagram.svg' : 'cells.png',
      mimeType: options.mimeType ?? 'image/png',
      byteLength: 1024,
      naturalPx: options.mimeType === 'image/svg+xml' ? null : naturalPx,
    });

    const { image } = addPanelWithImage(draft, newId, {
      frame: { x: 2, y: 2, width: options.widthMm, height: options.widthMm * 0.66 },
      name: 'Cells',
      assetId: 'asset-1',
      naturalPx,
    });

    if (options.cropWidth !== undefined) {
      setImageCrop(draft, image.id, { width: options.cropWidth });
    }
  });
}

function imageFindings(options: Parameters<typeof imageDocument>[0]) {
  const document = imageDocument(options);
  const scene = renderDocument(document, { theme: NATURE_THEME });
  return checkFigure({ document, theme: NATURE_THEME, scene, exportDpi: 300 }).findings.filter(
    (f) => f.id.startsWith('image-low-dpi-'),
  );
}

describe('image resolution', () => {
  it('says nothing at exactly the target resolution', () => {
    // The rule tests `dpi < exportDpi`, so the boundary must pass. Warning an
    // author whose image is exactly on target is how a check loses its authority.
    expect(imageFindings({ widthMm: EXACT_300_DPI_MM })).toEqual([]);
  });

  it('errors when the image is well under target', () => {
    // 600 px across 101.6 mm is 150 dpi — half the target, and below the 0.66
    // threshold that separates "fix this" from "consider this".
    const findings = imageFindings({ widthMm: EXACT_300_DPI_MM * 2 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.title).toContain('150 dpi');
  });

  it('warns when the image is only slightly under target', () => {
    // 250 dpi: short of the target but above two thirds of it.
    const findings = imageFindings({ widthMm: 60.96 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('warning');
    expect(findings[0]!.title).toContain('250 dpi');
  });

  it('counts only the pixels the crop retains', () => {
    // The property the rule exists for: cropping to half the width throws away
    // half the pixels, so an image that was exactly on target is now at 150 dpi.
    const findings = imageFindings({ widthMm: EXACT_300_DPI_MM, cropWidth: 0.5 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('150 dpi');
  });

  it('suggests a width that would actually reach the target', () => {
    const findings = imageFindings({ widthMm: EXACT_300_DPI_MM * 2 });
    // 600 px at 300 dpi is 50.8 mm — the advice has to be arithmetically right,
    // or following it leaves the author still under target.
    expect(findings[0]!.detail).toContain('50.8 mm');
  });

  it('says nothing about vector assets, which have no resolution to be short of', () => {
    // An SVG resolves at whatever the output device offers. Telling the author
    // to shrink a logo because it "is 63 dpi" is confidently wrong advice —
    // worse than no check at all.
    expect(
      imageFindings({ widthMm: 150, mimeType: 'image/svg+xml', naturalPx: { width: 0, height: 0 } }),
    ).toEqual([]);
  });

  it('costs the readiness score when it fires', () => {
    const score = (doc: FigureDocument) =>
      checkFigure({
        document: doc,
        theme: NATURE_THEME,
        scene: renderDocument(doc, { theme: NATURE_THEME }),
        exportDpi: 300,
      }).score;

    expect(score(imageDocument({ widthMm: EXACT_300_DPI_MM * 2 }))).toBeLessThan(
      score(imageDocument({ widthMm: EXACT_300_DPI_MM })),
    );
  });
});

// ---------------------------------------------------------------------------
// Scale bar calibration
// ---------------------------------------------------------------------------

function scaleBarFindings(options: {
  calibrationSource?: CalibrationSource;
  pixelsPerUnit?: number;
  detach?: boolean;
}) {
  const newId = createIdFactory();
  const base = createDocument({
    widthMm: 183,
    heightMm: 120,
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const document = editDocument(base, (draft) => {
    addAsset(draft, {
      id: 'asset-1',
      filename: 'cells.png',
      mimeType: 'image/png',
      byteLength: 1024,
      naturalPx: { width: 1000, height: 800 },
    });
    const { image } = addPanelWithImage(draft, newId, {
      frame: { x: 2, y: 2, width: 50, height: 40 },
      assetId: 'asset-1',
      naturalPx: { width: 1000, height: 800 },
    });
    const bar = addScaleBar(draft, newId, {
      imageId: image.id,
      length: 10,
      pixelsPerUnit: options.pixelsPerUnit ?? 2,
      calibrationSource: options.calibrationSource,
    })!;
    if (options.detach) draft.nodes[bar.id]!.parentId = null;
  });

  const scene = renderDocument(document, { theme: NATURE_THEME });
  return checkFigure({ document, theme: NATURE_THEME, scene }).findings.filter((f) =>
    f.id.startsWith('scale-bar-'),
  );
}

describe('scale bar calibration', () => {
  it('errors on a bar whose calibration nobody supplied', () => {
    // A bar drawn from a placeholder is a false measurement in a published
    // figure, and nothing about the drawing reveals it.
    const findings = scaleBarFindings({ calibrationSource: 'unknown' });
    expect(findings.map((f) => f.id.split('-').slice(0, 3).join('-'))).toEqual([
      'scale-bar-uncalibrated',
    ]);
    expect(findings[0]!.severity).toBe('error');
  });

  it('treats a bar with no recorded source as uncalibrated', () => {
    expect(scaleBarFindings({})).toHaveLength(1);
  });

  it('stays quiet when the calibration came from the microscope', () => {
    expect(scaleBarFindings({ calibrationSource: 'metadata' })).toEqual([]);
    expect(scaleBarFindings({ calibrationSource: 'manual' })).toEqual([]);
    expect(scaleBarFindings({ calibrationSource: 'measured' })).toEqual([]);
  });

  it('catches a bar wider than the image it measures', () => {
    // The classic units error: nm entered where µm was meant is a factor of
    // 1000, and it shows up as a bar that cannot possibly fit.
    const findings = scaleBarFindings({ calibrationSource: 'manual', pixelsPerUnit: 2000 });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('wider than the image');
  });

  it('catches a bar detached from its image', () => {
    const findings = scaleBarFindings({ calibrationSource: 'metadata', detach: true });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.title).toContain('not attached to an image');
  });
});

// ---------------------------------------------------------------------------
// Auto-fixes
// ---------------------------------------------------------------------------

/**
 * These assert the property that matters about a fix: applying it clears the
 * finding *and introduces no new one*. The second half is the valuable one —
 * geometry here is coupled, and `requiredMargin` sizes plot gutters from the
 * very font sizes a text fix changes.
 */

function report(doc: FigureDocument, theme: Theme = NATURE_THEME) {
  return checkFigure({
    document: doc,
    theme,
    scene: renderDocument(doc, { theme }),
    exportDpi: 300,
  });
}

function findingById(doc: FigureDocument, id: string, theme: Theme = NATURE_THEME): Finding {
  const found = report(doc, theme).findings.find((f) => f.id === id);
  if (!found) {
    throw new Error(
      `expected finding "${id}"; got ${report(doc, theme)
        .findings.map((f) => f.id)
        .join(', ')}`,
    );
  }
  return found;
}

/**
 * Compare two documents ignoring `modifiedAt`.
 *
 * `stableStringify` because zod rebuilds objects in schema key order, so a
 * plain `JSON.stringify` compare reports differences that are not there.
 * `modifiedAt` is excluded because the store stamps it on commit and `undo`
 * does not roll it back — the figure genuinely was edited, even if the edit was
 * then reversed.
 */
function sameDocument(a: FigureDocument, b: FigureDocument): void {
  const strip = (doc: FigureDocument) => stableStringify({ ...doc, modifiedAt: '' });
  expect(strip(a)).toBe(strip(b));
}

/** Apply a fix through a real store, so undo is exercised rather than assumed. */
function applyThroughStore(
  doc: FigureDocument,
  finding: Finding,
  theme: Theme = NATURE_THEME,
): { store: DocumentStore; fixed: FigureDocument } {
  const store = new DocumentStore(doc);
  const fix = finding.fix;
  if (!fix) throw new Error(`finding "${finding.id}" offers no fix`);
  store.commit(fix.label, (draft) => fix.apply(draft, { newId: createIdFactory(), theme }));
  return { store, fixed: store.getDocument() };
}

/** Two panels of plots plus whatever the caller adds. */
function twoPanelDocument(extra?: (draft: FigureDocument, newId: () => string) => void) {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'Fixable figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const parsed = parseDelimited(LARGE);
    const dataset: Dataset = {
      id: newId(),
      name: 'Viability',
      format: inferFormat(parsed.columns),
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/viability.csv',
      sourceFilename: 'viability.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    for (const [index, x] of [4, 96].entries()) {
      addPanelWithPlot(draft, newId, {
        frame: { x, y: 4, width: 82, height: 60 },
        name: `Panel ${index + 1}`,
        datasetId: dataset.id,
        plotType: 'bar',
        yTitle: 'Cell viability (%)',
      });
    }
    relabelPanels(draft, newId, { fontSizePt: NATURE_THEME.type.panelLabelPt, offsetMm: 4 });
    extra?.(draft, newId);
  });
}

describe('text size fixes', () => {
  /** A label the author sized themselves, below the journal's floor. */
  const undersizedLabel = () => {
    let textId = '';
    const doc = twoPanelDocument((draft, newId) => {
      textId = addText(draft, newId, {
        frame: { x: 4, y: 68, width: 40, height: 4 },
        text: 'n = 12 per group',
        fontSizePt: 3,
      }).id;
    });
    return { doc, textId };
  };

  it('offers a fix for a label the author sized, and names it', () => {
    const { doc, textId } = undersizedLabel();
    const finding = findingById(doc, 'text-below-minimum-override');
    expect(finding.nodeIds).toEqual([textId]);
    expect(finding.fix?.label).toBe('Raise to 5 pt');
  });

  it('clears the finding without introducing another', () => {
    const { doc } = undersizedLabel();
    const before = report(doc).findings.map((f) => f.id);
    const { fixed } = applyThroughStore(doc, findingById(doc, 'text-below-minimum-override'));
    const after = report(fixed).findings.map((f) => f.id);

    expect(after).not.toContain('text-below-minimum-override');
    // Nothing new appeared. A font size feeds `requiredMargin`, so a fix here
    // can move a plot's gutters — this is the assertion that would catch it.
    expect(after.filter((id) => !before.includes(id))).toEqual([]);
  });

  it('undoes exactly', () => {
    const { doc } = undersizedLabel();
    const { store } = applyThroughStore(doc, findingById(doc, 'text-below-minimum-override'));
    store.undo();
    sameDocument(store.getDocument(), doc);
  });

  it('refuses a fix when the size comes from the theme, not the label', () => {
    // A tick label at 3 pt is repaired by raising the type scale — which
    // re-flows every gutter — or by enlarging the panel. Both are the author's
    // call, so this arm reports the defect and offers no button.
    const theme = resolveTheme('nature', { type: { ...NATURE_THEME.type, tickLabelPt: 3 } });
    const doc = twoPanelDocument();

    const finding = findingById(doc, 'text-below-minimum-theme', theme);
    expect(finding.fix).toBeUndefined();
    expect(finding.title).toContain('tickLabelPt');
    // And the override arm must not fire: no label carries its own 3 pt.
    expect(report(doc, theme).findings.map((f) => f.id)).not.toContain(
      'text-below-minimum-override',
    );
  });

  it('reports an oversized label separately from oversized theme text', () => {
    const doc = twoPanelDocument((draft, newId) => {
      addText(draft, newId, {
        frame: { x: 4, y: 68, width: 60, height: 8 },
        text: 'Figure 1',
        fontSizePt: 24,
      });
    });
    const finding = findingById(doc, 'text-above-maximum-override');
    expect(finding.severity).toBe('warning');
    const { fixed } = applyThroughStore(doc, finding);
    expect(report(fixed).findings.map((f) => f.id)).not.toContain('text-above-maximum-override');
  });

  it('does not flag a superscripted axis exponent as undersized text', () => {
    // A 65% superscript on a 6 pt tick label is 3.9 pt — genuinely below
    // `minimumPt` (5). Flagging it would report a defect the renderer creates
    // on purpose every time an axis uses scientific/power-of-ten notation.
    const doc = editDocument(
      createDocument({
        widthMm: 183,
        heightMm: 75,
        presetId: 'nature-double',
        idFactory: createIdFactory(),
        now: () => '2026-01-01T00:00:00.000Z',
      }),
      (draft) => {
        const newId = createIdFactory();
        const parsed = parseDelimited('Dose,Response\n1,100\n2,1000\n3,10000\n4,100000');
        const dataset: Dataset = {
          id: newId(),
          name: 'Dose response',
          format: inferFormat(parsed.columns),
          columns: parsed.columns,
          rows: parsed.rows,
          sourcePath: 'data/power10.csv',
          sourceFilename: 'power10.csv',
          importedAt: '2026-01-01T00:00:00.000Z',
        };
        draft.datasets = [dataset];
        addPanelWithPlot(draft, newId, {
          frame: { x: 2, y: 2, width: 80, height: 60 },
          name: 'Dose response',
          datasetId: dataset.id,
          plotType: 'scatter',
        });
        for (const node of Object.values(draft.nodes)) {
          if (node.type === 'plot') {
            node.y.scale = 'log10';
            node.y.labelFormat = 'power10';
          }
        }
      },
    );

    const ids = report(doc).findings.map((f) => f.id);
    expect(ids).not.toContain('text-below-minimum-override');
    expect(ids).not.toContain('text-below-minimum-theme');
  });

  it('still flags an ordinary 4 pt label as undersized', () => {
    // The exemption above must be specific to the superscript role, not a
    // general loosening of the floor.
    const { doc } = undersizedLabel();
    expect(report(doc).findings.map((f) => f.id)).toContain('text-below-minimum-override');
  });

  it("recognises a volcano's pointLabelSizePt as an author override, not a theme size", () => {
    // PlotNode has no `style`, unlike the other roles this rule already
    // covers — without `ownFontSizePt`'s generalisation this would silently
    // fall into the no-fix theme bucket even though the author set it.
    const doc = volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001', {
      volcanoLabels: ['TP53'],
      pointLabelSizePt: 3,
    });
    const finding = findingById(doc, 'text-below-minimum-override');
    expect(finding.fix).toBeDefined();
    const { fixed } = applyThroughStore(doc, finding);
    expect(report(fixed).findings.map((f) => f.id)).not.toContain('text-below-minimum-override');
    const plot = Object.values(fixed.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.pointLabelSizePt).toBe(NATURE_THEME.type.minimumPt);
  });

  it('still reports the theme annotation size when no volcano sets its own label size', () => {
    const doc = volcanoDocument('Gene,log2FC,p\nTP53,2.1,0.001', { volcanoLabels: ['TP53'] });
    const theme = resolveTheme('nature', { type: { ...NATURE_THEME.type, annotationPt: 3 } });
    const finding = findingById(doc, 'text-below-minimum-theme', theme);
    expect(finding.fix).toBeUndefined();
    expect(report(doc, theme).findings.map((f) => f.id)).not.toContain('text-below-minimum-override');
  });
});

describe('font consistency fix', () => {
  const mixed = () => {
    let textId = '';
    const doc = twoPanelDocument((draft, newId) => {
      const node = addText(draft, newId, {
        frame: { x: 4, y: 68, width: 40, height: 5 },
        text: 'Imported caption',
      });
      textId = node.id;
      updateNode<TextNode>(draft, node.id, {
        style: { ...node.style, fontFamily: 'Times New Roman, serif' },
      });
    });
    return { doc, textId };
  };

  it('clears the odd family off the node that carries it', () => {
    const { doc, textId } = mixed();
    const finding = findingById(doc, 'mixed-fonts');
    expect(finding.nodeIds).toEqual([textId]);

    const { fixed } = applyThroughStore(doc, finding);
    expect(report(fixed).findings.map((f) => f.id)).not.toContain('mixed-fonts');
  });

  it('offers no fix when the odd family is the theme itself', () => {
    // Clearing node overrides would repair nothing, and a button that appears
    // to do nothing is worse than no button.
    const theme = resolveTheme('nature', { fontFamily: 'Georgia, serif' });
    const doc = twoPanelDocument((draft, newId) => {
      const node = addText(draft, newId, {
        frame: { x: 4, y: 68, width: 40, height: 5 },
        text: 'Caption',
      });
      updateNode<TextNode>(draft, node.id, {
        style: { ...node.style, fontFamily: undefined },
      });
    });

    const findings = report(doc, theme).findings.filter((f) => f.id === 'mixed-fonts');
    for (const finding of findings) expect(finding.fix).toBeUndefined();
  });
});

describe('panel label fixes', () => {
  it('letters a panel whose label was deleted', () => {
    const doc = twoPanelDocument();
    const labelId = Object.values(doc.nodes).find((n) => n.type === 'panel-label')!.id;
    const stripped = editDocument(doc, (draft) => {
      deleteNode(draft, labelId);
    });

    const finding = findingById(stripped, 'missing-panel-labels');
    const { fixed } = applyThroughStore(stripped, finding);

    const letters = Object.values(fixed.nodes)
      .filter((n) => n.type === 'panel-label')
      .map((n) => (n as { text: string }).text)
      .sort();
    expect(letters).toEqual(['a', 'b']);
    expect(report(fixed).findings.map((f) => f.id)).not.toContain('missing-panel-labels');
  });

  it('selects the clashing labels, not just the panels', () => {
    const doc = twoPanelDocument();
    const labels = Object.values(doc.nodes).filter((n) => n.type === 'panel-label');
    const clashed = editDocument(doc, (draft) => {
      for (const label of labels) {
        (draft.nodes[label.id] as { text: string }).text = 'a';
      }
    });

    const finding = findingById(clashed, 'duplicate-panel-labels');
    expect(finding.nodeIds.sort()).toEqual(labels.map((l) => l.id).sort());

    const { fixed } = applyThroughStore(clashed, finding);
    expect(report(fixed).findings.map((f) => f.id)).not.toContain('duplicate-panel-labels');
  });
});

describe('fixes that rearrange the figure', () => {
  it('marks the gutter fix as rearranging, and it is not in the safe set', () => {
    // Auto Layout resizes every panel and everything inside it. That is the
    // right repair and the wrong thing to do inside a batch labelled "fix".
    // Three panels across one row with gaps of 6 mm and 14 mm. `measureGutters`
    // pairs frames in x order across the whole figure, so this has to be the
    // only row — a second row interleaves with it and the pairing breaks up.
    const newId = createIdFactory();
    const doc = editDocument(
      createDocument({
        widthMm: 183,
        heightMm: 75,
        presetId: 'nature-double',
        idFactory: newId,
        now: () => '2026-01-01T00:00:00.000Z',
      }),
      (draft) => {
        const parsed = parseDelimited(LARGE);
        draft.datasets = [
          {
            id: newId(),
            name: 'Viability',
            format: inferFormat(parsed.columns),
            columns: parsed.columns,
            rows: parsed.rows,
            sourcePath: 'data/viability.csv',
            sourceFilename: 'viability.csv',
            importedAt: '2026-01-01T00:00:00.000Z',
          },
        ];
        for (const [index, x] of [4, 60, 130].entries()) {
          addPanelWithPlot(draft, newId, {
            frame: { x, y: 4, width: 50, height: 60 },
            name: `Panel ${index + 1}`,
            datasetId: draft.datasets[0]!.id,
            plotType: 'bar',
          });
        }
        relabelPanels(draft, newId, { fontSizePt: NATURE_THEME.type.panelLabelPt, offsetMm: 4 });
      },
    );

    const uneven = report(doc).findings.filter((f) => f.id.startsWith('uneven-gutters-'));
    expect(uneven.length).toBeGreaterThan(0);
    for (const finding of uneven) {
      expect(finding.fix?.rearranges).toBe(true);
      expect(finding.fix?.label).toContain('rearranges');
    }
  });
});

describe('fixing several findings at once', () => {
  it('collapses into one undo entry', () => {
    const doc = twoPanelDocument((draft, newId) => {
      addText(draft, newId, {
        frame: { x: 4, y: 68, width: 40, height: 4 },
        text: 'n = 12',
        fontSizePt: 3,
      });
      const caption = addText(draft, newId, {
        frame: { x: 60, y: 68, width: 40, height: 5 },
        text: 'Imported caption',
      });
      updateNode<TextNode>(draft, caption.id, {
        style: { ...caption.style, fontFamily: 'Times New Roman, serif' },
      });
      const labelId = Object.values(draft.nodes).find((n) => n.type === 'panel-label')!.id;
      deleteNode(draft, labelId);
    });

    const safe = report(doc).findings.filter((f) => f.fix && !f.fix.rearranges);
    expect(safe.length).toBe(3);

    const store = new DocumentStore(doc);
    const newId = createIdFactory();
    store.transaction('Fix quality issues', () => {
      for (const finding of safe) {
        store.commit(finding.fix!.label, (draft) =>
          finding.fix!.apply(draft, { newId, theme: NATURE_THEME }),
        );
      }
    });

    expect(store.history()).toHaveLength(1);
    const fixedIds = report(store.getDocument()).findings.map((f) => f.id);
    for (const finding of safe) expect(fixedIds).not.toContain(finding.id);

    store.undo();
    sameDocument(store.getDocument(), doc);
  });

  it('tolerates a target another fix already removed', () => {
    // Recipes run in sequence against one draft. A recipe that assumed its
    // node still existed would throw here and abandon the whole batch.
    const doc = twoPanelDocument((draft, newId) => {
      addText(draft, newId, {
        frame: { x: 4, y: 68, width: 40, height: 4 },
        text: 'n = 12',
        fontSizePt: 3,
      });
    });
    const finding = findingById(doc, 'text-below-minimum-override');

    const store = new DocumentStore(doc);
    store.commit('Delete then fix', (draft) => {
      deleteNode(draft, finding.nodeIds[0]!);
      finding.fix!.apply(draft, { newId: createIdFactory(), theme: NATURE_THEME });
    });
    expect(store.getDocument().nodes[finding.nodeIds[0]!]).toBeUndefined();
  });
});

describe('what the checker claims it can fix', () => {
  /**
   * Findings that deliberately carry no fix, with the reason. An inventory
   * rather than a spot check: the previous `autoFixable` boolean drifted to ten
   * claims and zero implementations precisely because nothing counted them.
   */
  const NOT_AUTO_FIXABLE: Record<string, string> = {
    'text-below-minimum-theme': 'raising the type scale re-flows every gutter — authorial',
    'text-above-maximum-theme': 'the change belongs in the theme, not in any one label',
    'colour-blind-conflict': 'remapping changes what the colours mean to a reader',
    'grayscale-conflict': 'the redundant channel to add is a design decision',
    'page-too-tall': 'what to cut from an over-tall figure is the author’s call',
    'plot-too-small': 'enlarge, drop a panel, or use a taller page — three different figures',
    'image-low-dpi': 'upscaling cannot recover detail that was never captured',
    'scale-bar-unparented': 'only the author knows which image the bar measures',
    'scale-bar-uncalibrated': 'the pixel size is a measurement, not a default',
    'scale-bar-oversized': 'the units are wrong; guessing which way is worse than saying so',
    'stale-analysis': 're-running a test is a decision, and the result may change the figure',
    'distribution-n': 'which mark to use instead is the author’s call',
    'page-width-mismatch': 'fixable only when no content overhangs; withheld otherwise',
  };

  it('every finding either fixes itself or is listed as not fixable', () => {
    const documents = [
      twoPanelDocument((draft, newId) => {
        addText(draft, newId, {
          frame: { x: 4, y: 68, width: 40, height: 4 },
          text: 'n = 12',
          fontSizePt: 3,
        });
      }),
      makeDocument(SMALL, 'violin'),
      imageDocument({ widthMm: EXACT_300_DPI_MM * 2 }),
    ];

    for (const doc of documents) {
      for (const finding of report(doc).findings) {
        if (finding.fix) continue;
        // Ids are templated with a node id on some rules; match the stem.
        const known = Object.keys(NOT_AUTO_FIXABLE).some((stem) => finding.id.startsWith(stem));
        expect(known, `unlisted finding without a fix: ${finding.id}`).toBe(true);
      }
    }
  });
});

describe('a stale analysis', () => {
  /** A scatter with a correlation stored against it, and no bracket. */
  function withCorrelation(inputHash: string): FigureDocument {
    const doc = makeDocument(XY_CSV, 'scatter');
    return editDocument(doc, (draft) => {
      const plot = Object.values(draft.nodes).find((n) => n.type === 'plot')!;
      draft.analyses = [
        {
          id: 'analysis-1',
          name: 'Dose vs Response',
          test: 'linear-regression',
          spec: { datasetId: draft.datasets[0]!.id, groups: ['Response'] },
          plotId: plot.id,
          options: { alternative: 'two-sided', correction: 'none', alpha: 0.05, welch: true },
          inputHash,
          result: {
            test: 'linear-regression',
            omnibus: null,
            comparisons: [],
            methodsSentence: '',
            warnings: [],
            softwareVersions: {},
          },
          computedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
    });
  }

  it('names the plot, so a correlation with no bracket is still selectable', () => {
    /*
     * A correlation never gets a bracket — a numeric x axis has no categories
     * to span — so before this the finding carried an empty `nodeIds` and its
     * "Select N affected" button selected nothing at all. It matters more now
     * that a correlation draws a fitted line: the plot IS the thing showing
     * the stale result.
     */
    const doc = withCorrelation('a-hash-that-cannot-match');
    const finding = report(doc).findings.find((f) => f.id.startsWith('stale-analysis'));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('error');

    const plot = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
    expect(finding!.nodeIds).toEqual([plot.id]);
    expect(Object.values(doc.nodes).some((n) => n.type === 'bracket')).toBe(false);
  });

  it('says nothing while the analysis still matches its data', () => {
    const doc = makeDocument(XY_CSV, 'scatter');
    const dataset = doc.datasets[0]!;
    const current = analysisInputHash(
      { test: 'linear-regression', correction: 'none' },
      toSeries(dataset).map((s) => s.values),
      xForHash(toSeries(dataset)),
    );
    const fresh = withCorrelation(current);
    expect(report(fresh).findings.filter((f) => f.id.startsWith('stale-analysis'))).toEqual([]);
  });
});
