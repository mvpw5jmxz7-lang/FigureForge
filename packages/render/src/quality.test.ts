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
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  setImageCrop,
  type CalibrationSource,
  type Dataset,
  type FigureDocument,
  type PlotType,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument } from './render-document.js';
import { checkFigure } from './quality.js';

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
