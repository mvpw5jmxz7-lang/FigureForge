/**
 * The built-in sample figure — what "Open sample" loads.
 *
 * Eight panels of deliberately unlike kinds, each showing a feature in use:
 *
 *   a  bar + dot          one-way ANOVA (Holm) → three significance brackets
 *   b  scatter            Pearson correlation → a fitted line + confidence band,
 *                         with large hollow red markers and a leader-arrow callout
 *   c  line / timecourse  two series, a legend
 *   d  violin (n = 12)    Kruskal-Wallis (Holm) → three brackets
 *   e  Kaplan-Meier       log-rank → a methods sentence, no bracket
 *   f  volcano            a real Perseus-style SAM/S0 boundary, eight point labels
 *   g  heatmap            a diverging colour scale and a colourbar
 *   h  montage            three confocal channels, per-tile captions, a scale bar
 *                         below the picture
 *
 * plus automatic panel letters, a group title over f + g, a heading across the
 * top of the whole figure and one rotated down its left side, and — applied
 * last — the Smart layout solver's best arrangement.
 *
 * It is **not** the launch document — the app opens blank (round 51). This is
 * reached only by the Open sample button, and it loads with no save target, so
 * a plain Save is already a Save As: the sample cannot be overwritten, only
 * copied into a figure of the user's own. `App.tsx` seeds the micrograph bytes
 * (`seedSampleAssets`) alongside this document.
 *
 * Synchronous and DOM-free — no API call. The statistics ship as pinned
 * constants (`./sampleStats.js`, `./sampleVolcanoTest.js`); each analysis's
 * `inputHash` is recomputed here from its dataset through `analysisInputHash`,
 * the same helper `checkStaleAnalyses` uses, so a pinned result never reads as
 * stale. Regenerate the pinned results with `scripts/build-sample-stats.ts`.
 */
import {
  addArrow,
  addAsset,
  addBracket,
  addGroupLabel,
  addPanelWithImages,
  addPanelWithPlot,
  addScaleBar,
  addText,
  analysisInputHash,
  applyAutoLayout,
  createDocument,
  defaultAnalysisOptions,
  editDocument,
  eventsForHash,
  reflowGroupLabels,
  relabelPanels,
  reserveLayoutSpace,
  toSeries,
  updateNode,
  xForHash,
  type Analysis,
  type Dataset,
  type FigureDocument,
  type PlotNode,
  type ScaleBarNode,
  type StatResult,
} from '@figureforge/doc-model';
import { measurePlot, reflowBrackets } from '@figureforge/render';
import { NATURE_THEME } from '@figureforge/theme';
import { datasetFromText } from './sample.js';
import { SAMPLE_MICROGRAPHS } from './sampleMicrographs.js';
import { solveForDocument, applyCandidate } from './smartLayout.js';
import {
  SAMPLE_ANOVA_RESULT,
  SAMPLE_KRUSKAL_RESULT,
  SAMPLE_LOGRANK_RESULT,
  SAMPLE_PEARSON_RESULT,
} from './sampleStats.js';
import {
  SAMPLE_TZ_CURVE_DOWN,
  SAMPLE_TZ_CURVE_UP,
  SAMPLE_TZ_VOLCANO_ROWS,
  SAMPLE_TZ_VOLCANO_TEST,
} from './sampleVolcanoTest.js';

const EXPORT_DPI = 300;
const ISO = '2026-01-01T00:00:00.000Z';

// ---------------------------------------------------------------------------
// The data. Kept here as the single source of truth; scripts/build-sample-stats.ts
// imports these verbatim so the pinned statistics cannot drift from them.
// ---------------------------------------------------------------------------

/** Panel a — three genotypes, five replicates. One-way ANOVA. */
export const SAMPLE_EXPRESSION = `Genotype,Rep1,Rep2,Rep3,Rep4,Rep5
WT,1.02,0.95,1.08,0.98,1.04
KO,2.45,2.61,2.38,2.55,2.49
Rescue,1.28,1.35,1.19,1.31,1.24`;

/** Panel b — a dose-response series. Pearson correlation + fitted line. */
export const SAMPLE_DOSE_RESPONSE = `Dose (uM),Response (AU)
0,3.6
0.5,8.9
1,10.4
1.5,17.1
2,18.3
2.5,25.0
3,26.2
3.5,33.4
4,34.7`;

/** Panel c — a shared time axis, one column per arm. Line plot with a legend. */
export const SAMPLE_TIMECOURSE = `Hours,Vehicle,Compound X
0,1.00,1.02
2,1.08,1.44
4,1.15,2.31
8,1.21,3.68
12,1.18,4.42
24,1.24,4.85`;

/**
 * Panel d — twelve replicates per genotype. n = 12 deliberately:
 * `checkDistributionSampleSize` warns on a violin below ten, and the sample
 * should not itself demonstrate the thing the quality checker exists to flag.
 */
export const SAMPLE_MARKERS = `Genotype,R1,R2,R3,R4,R5,R6,R7,R8,R9,R10,R11,R12
WT,4.1,4.4,3.9,4.6,4.2,4.0,4.5,4.3,3.8,4.7,4.1,4.4
KO,7.2,6.8,7.9,7.1,6.5,8.2,7.4,7.7,6.9,8.0,7.3,7.6
Rescue,4.8,5.2,4.5,5.0,4.9,5.4,4.6,5.1,4.7,5.3,4.4,5.0`;

/** Panel e — one row per subject, an event flag, and the arm. Log-rank. */
export const SAMPLE_SURVIVAL = `Time,Event,Arm
9,1,Vehicle
13,1,Vehicle
13,0,Vehicle
18,1,Vehicle
23,1,Vehicle
28,0,Vehicle
31,1,Vehicle
34,1,Vehicle
45,0,Vehicle
48,1,Vehicle
22,0,Compound X
28,1,Compound X
34,1,Compound X
39,0,Compound X
44,1,Compound X
52,0,Compound X
57,1,Compound X
61,0,Compound X
68,1,Compound X
80,0,Compound X`;

/** Panel g — a small pathway-score matrix. Heatmap, diverging scale. */
export const SAMPLE_PATHWAY_MATRIX = `Pathway,Ctrl 0 h,Ctrl 6 h,Cmpd 6 h,Cmpd 24 h
Autophagy,0.12,0.31,1.42,2.08
Lysosome,0.08,0.44,1.61,2.35
Proteasome,-0.21,-0.34,-0.88,-1.27
Oxid. stress,0.45,0.72,1.05,0.94
Cell cycle,-0.05,-0.42,-1.35,-1.92
Translation,0.02,-0.18,-0.61,-0.83`;

/** Panel f — eight features called out on the volcano, a spread of up and down. */
const SAMPLE_VOLCANO_LABELS = [
  'Protein_007',
  'Protein_003',
  'Protein_013',
  'Protein_001',
  'Protein_009',
  'Protein_035',
  'Protein_057',
  'Protein_005',
];

/** Panel h — the three confocal channels, captioned above each tile. */
const SAMPLE_TILE_CAPTIONS = ['MAP1LC3B', 'LAMP1', 'Merge'];

// ---------------------------------------------------------------------------

/** The volcano panel's differential table, from the pinned SAM test rows. */
function volcanoDataset(id: string): Dataset {
  return {
    id,
    name: 'Proteomic differential expression',
    format: 'differential',
    columns: [
      { name: 'Feature', kind: 'text' },
      { name: 'log2FoldChange', kind: 'number' },
      { name: 'pValue', kind: 'number' },
      { name: 'qValue', kind: 'number' },
    ],
    rows: SAMPLE_TZ_VOLCANO_ROWS.map((r) => [r.label, r.log2FoldChange, r.pValue, r.qValue]),
    sourcePath: null,
    sourceFilename: null,
    importedAt: ISO,
  };
}

/** One group-comparison analysis (ANOVA / Kruskal-Wallis / log-rank). */
function groupAnalysis(
  newId: () => string,
  dataset: Dataset,
  plotId: string,
  test: Analysis['test'],
  correction: 'none' | 'holm',
  result: StatResult,
): Analysis {
  const series = toSeries(dataset);
  return {
    id: newId(),
    name: `${test} on ${dataset.name}`,
    test,
    spec: { datasetId: dataset.id, groups: series.map((s) => s.name) },
    plotId,
    options: { ...defaultAnalysisOptions(), correction },
    // Exactly the four arguments the Stats tab and the staleness checker use,
    // so the stored hash matches what `checkStaleAnalyses` recomputes.
    inputHash: analysisInputHash(
      { test, correction },
      series.map((s) => s.values),
      xForHash(series),
      eventsForHash(test, dataset),
    ),
    result,
    computedAt: ISO,
  };
}

export function sampleDocument(): FigureDocument {
  // One id factory across every edit below — Smart layout needs its own commit,
  // and a factory scoped to one `editDocument` closure could not span them.
  // Monotonic and prefixed, so saved ids stay readable.
  let counter = 0;
  const newId = (): string => `s${(++counter).toString(36)}`;

  let doc = createDocument({
    title: 'FigureForge sample figure',
    presetId: 'nature-double',
    widthMm: 183,
    heightMm: 150,
    now: () => ISO,
  });

  // Ids captured here so the post-layout edits can reach the same nodes.
  let plotAId = '';
  let plotBId = '';
  let panelBId = '';
  let plotDId = '';
  let plotEId = '';
  let panelFId = '';
  let panelGId = '';

  doc = editDocument(doc, (draft) => {
    const expression = datasetFromText(SAMPLE_EXPRESSION, 'Target expression', newId());
    const doseResponse = datasetFromText(SAMPLE_DOSE_RESPONSE, 'Dose response', newId());
    const timecourse = datasetFromText(SAMPLE_TIMECOURSE, 'Reporter timecourse', newId());
    const markers = datasetFromText(SAMPLE_MARKERS, 'Marker distribution', newId());
    const survival = datasetFromText(SAMPLE_SURVIVAL, 'Survival by arm', newId(), null, {
      format: 'survival',
    });
    const volcano = volcanoDataset(newId());
    const pathways = datasetFromText(SAMPLE_PATHWAY_MATRIX, 'Pathway scores', newId(), null, {
      format: 'matrix',
    });

    draft.datasets = [expression, doseResponse, timecourse, markers, survival, volcano, pathways];

    const frame = { x: 0, y: 0, width: 80, height: 60 };

    const a = addPanelWithPlot(draft, newId, {
      frame,
      name: 'Target expression',
      datasetId: expression.id,
      plotType: 'bar-dot',
      yTitle: 'Relative expression',
      xTitle: 'Genotype',
    });
    plotAId = a.plot.id;

    // simple-xy defaults to a line; a correlation wants the raw points.
    const b = addPanelWithPlot(draft, newId, {
      frame,
      name: 'Dose response',
      datasetId: doseResponse.id,
      plotType: 'scatter',
      yTitle: 'Response (AU)',
      xTitle: 'Dose (µM)',
    });
    plotBId = b.plot.id;
    panelBId = b.panel.id;
    updateNode<PlotNode>(draft, b.plot.id, {
      // The confidence band, so the panel shows it rather than the bare line.
      trendInterval: 'confidence',
      // Large hollow red circles — an open-symbol style, and a demonstration of
      // the fill/outline controls (round 53).
      pointSizeMm: 2.6,
      pointShape: 'circle',
      pointFill: 'none',
      pointStroke: { color: '#d62728', widthMm: 0.4 },
    });

    addPanelWithPlot(draft, newId, {
      frame,
      name: 'Reporter timecourse',
      datasetId: timecourse.id,
      plotType: 'line',
      yTitle: 'Fold induction',
      xTitle: 'Hours',
    });

    const d = addPanelWithPlot(draft, newId, {
      frame,
      name: 'Marker distribution',
      datasetId: markers.id,
      plotType: 'violin',
      yTitle: 'Marker intensity',
      xTitle: 'Genotype',
    });
    plotDId = d.plot.id;

    const e = addPanelWithPlot(draft, newId, {
      frame,
      name: 'Survival',
      datasetId: survival.id,
      plotType: 'survival',
      yTitle: 'Survival probability',
      xTitle: 'Days',
    });
    plotEId = e.plot.id;

    const f = addPanelWithPlot(draft, newId, {
      frame,
      name: 'Proteomic hits',
      datasetId: volcano.id,
      plotType: 'volcano',
      yTitle: '−Log10 p-value',
      xTitle: 'Log2 fold change',
    });
    updateNode<PlotNode>(draft, f.plot.id, {
      volcanoThresholds: {
        foldChange: 1,
        pValue: 0.05,
        fdr: SAMPLE_TZ_VOLCANO_TEST.fdrAchieved,
        significanceBy: 'fdr',
      },
      volcanoSamCurve: { up: SAMPLE_TZ_CURVE_UP, down: SAMPLE_TZ_CURVE_DOWN },
      volcanoTest: { ...SAMPLE_TZ_VOLCANO_TEST },
      volcanoLabels: SAMPLE_VOLCANO_LABELS,
    });
    panelFId = f.panel.id;

    const g = addPanelWithPlot(draft, newId, {
      frame,
      name: 'Pathway scores',
      datasetId: pathways.id,
      plotType: 'heatmap',
    });
    panelGId = g.panel.id;

    // -- h: the confocal montage -----------------------------------------------
    for (const micrograph of SAMPLE_MICROGRAPHS) {
      addAsset(draft, {
        id: micrograph.id,
        filename: micrograph.filename,
        mimeType: micrograph.mimeType,
        path: micrograph.path,
        byteLength: micrograph.byteLength,
        naturalPx: micrograph.naturalPx,
      });
    }
    const montage = addPanelWithImages(draft, newId, {
      frame: { x: 0, y: 0, width: 120, height: 42 },
      name: 'Confocal channels',
      gutterMm: 1.5,
      images: SAMPLE_MICROGRAPHS.map((m) => ({
        assetId: m.id,
        naturalPx: m.naturalPx,
        name: m.filename.replace('.jpg', ''),
      })),
    });
    // A caption above every tile.
    montage.images.forEach((tile, index) => {
      addGroupLabel(draft, newId, {
        memberIds: [tile.id],
        edge: 'top',
        title: SAMPLE_TILE_CAPTIONS[index] ?? tile.name ?? `Channel ${index + 1}`,
      });
    });
    // One scale bar, below the last picture rather than inset over it.
    const lastTile = montage.images[montage.images.length - 1];
    if (lastTile) {
      const bar = addScaleBar(draft, newId, {
        imageId: lastTile.id,
        length: 20,
        pixelsPerUnit: 5.2,
        unitLabel: 'µm',
        calibrationSource: 'manual',
        labelPosition: 'below',
      });
      if (bar) updateNode<ScaleBarNode>(draft, bar.id, { placement: 'below' });
    }

    // -- statistics (pinned; brackets placed after layout) --------------------
    const pearsonSeries = toSeries(doseResponse)[0];
    const pearson: Analysis = {
      id: newId(),
      name: 'Pearson correlation on Dose response',
      test: 'pearson',
      spec: {
        datasetId: doseResponse.id,
        groups: pearsonSeries ? [pearsonSeries.name] : [],
        ...(pearsonSeries ? { seriesName: pearsonSeries.name } : {}),
      },
      plotId: plotBId,
      options: { ...defaultAnalysisOptions(), correction: 'none' },
      inputHash: analysisInputHash(
        { test: 'pearson', correction: 'none' },
        [pearsonSeries?.values ?? []],
        pearsonSeries?.x,
      ),
      result: SAMPLE_PEARSON_RESULT,
      computedAt: ISO,
    };

    draft.analyses = [
      groupAnalysis(newId, expression, plotAId, 'anova-one-way', 'holm', SAMPLE_ANOVA_RESULT),
      pearson,
      groupAnalysis(newId, markers, plotDId, 'kruskal-wallis', 'holm', SAMPLE_KRUSKAL_RESULT),
      groupAnalysis(newId, survival, plotEId, 'log-rank', 'none', SAMPLE_LOGRANK_RESULT),
    ];

    // -- an even first pass, real enough to measure brackets against --------
    // The group headings wait until after Smart layout: a heading's letter-lift
    // only reads correctly when its members are the panels it is actually
    // drawn above, which this pass's frames do not yet reliably reflect.
    applyAutoLayout(draft, {
      marginMm: NATURE_THEME.spacing.marginMm,
      gutterMm: NATURE_THEME.spacing.panelGutterMm,
      labelGutterMm: 4,
    });
    relabelPanels(draft, newId, {
      uppercase: NATURE_THEME.panelLabelCase === 'upper',
      fontSizePt: NATURE_THEME.type.panelLabelPt,
      offsetMm: 4,
    });

    // -- significance brackets on the two omnibus panels -------------------
    for (const { plotId, result } of [
      { plotId: plotAId, result: SAMPLE_ANOVA_RESULT },
      { plotId: plotDId, result: SAMPLE_KRUSKAL_RESULT },
    ]) {
      const analysis = draft.analyses.find((an) => an.plotId === plotId);
      if (!analysis) continue;
      const plot = draft.nodes[plotId];
      const measurements =
        plot && plot.type === 'plot'
          ? (measurePlot(draft, plot, NATURE_THEME) ?? undefined)
          : undefined;
      result.comparisons.forEach((comparison, index) => {
        if (comparison.pAdjusted > 0.05) return;
        addBracket(draft, newId, { plotId, analysis, comparisonIndex: index, measurements });
      });
    }
    reflowBrackets(draft, NATURE_THEME);
  });

  // -- Smart layout: the solver's best arrangement, applied ------------------
  const solved = solveForDocument(doc, NATURE_THEME, EXPORT_DPI);
  const best = solved.candidates[0];
  if (best) {
    doc = editDocument(doc, (draft) => {
      applyCandidate(draft, best, newId);
    });
  }

  // -- the group headings, over the final arrangement ------------------------
  // Added after Smart layout, and built from the panels' *real* final
  // positions rather than a semantic pairing decided in advance: a top-edge
  // heading lifts the letter of every member it is above (`reflowGroupLabels`),
  // and that only reads correctly for members that genuinely share the row it
  // is drawn over — the whole reason this waits until the arrangement is known.
  doc = editDocument(doc, (draft) => {
    const panels = Object.values(draft.nodes).filter((n) => n.type === 'panel');
    const ROW_TOLERANCE_MM = 5; // the same banding `readingOrder` uses.

    const topY = Math.min(...panels.map((p) => p.frame.y));
    const topRowIds = panels.filter((p) => p.frame.y - topY < ROW_TOLERANCE_MM).map((p) => p.id);

    const leftX = Math.min(...panels.map((p) => p.frame.x));
    const leftColumnIds = panels
      .filter((p) => p.frame.x - leftX < ROW_TOLERANCE_MM)
      .map((p) => p.id);

    // A heading above the whole figure, and one down its left side.
    addGroupLabel(draft, newId, {
      memberIds: topRowIds,
      edge: 'top',
      title: 'Compound X remodels the HEK293 proteome',
    });
    addGroupLabel(draft, newId, {
      memberIds: leftColumnIds,
      edge: 'left',
      title: 'Biological triplicate',
    });

    // The omics pairing only if the volcano and heatmap actually ended up
    // sharing a row — otherwise a caption over one alone is closer to true
    // than a heading that visually sits nowhere near the panel it names.
    const fPanel = draft.nodes[panelFId];
    const gPanel = draft.nodes[panelGId];
    if (fPanel?.type === 'panel' && gPanel?.type === 'panel') {
      const sameRow = Math.abs(fPanel.frame.y - gPanel.frame.y) < ROW_TOLERANCE_MM;
      addGroupLabel(draft, newId, {
        memberIds: sameRow ? [panelFId, panelGId] : [panelGId],
        edge: 'top',
        title: 'Compound X proteomics',
      });
    }

    reserveLayoutSpace(draft);
    reflowGroupLabels(draft);
    relabelPanels(draft, newId, {
      uppercase: NATURE_THEME.panelLabelCase === 'upper',
      fontSizePt: NATURE_THEME.type.panelLabelPt,
      offsetMm: 4,
    });
    reflowBrackets(draft, NATURE_THEME);
  });

  // -- the panel-b callout, positioned against the final layout -------------
  doc = editDocument(doc, (draft) => {
    const panelB = draft.nodes[panelBId];
    if (!panelB) return;
    const { x, y, width, height } = panelB.frame;
    // Upper-left of the plot interior — clear of the y-axis furniture on the
    // left and of the rising fitted line, which climbs from the bottom-left.
    const tx = x + width * 0.32;
    const ty = y + height * 0.1;
    addText(draft, newId, {
      frame: { x: tx, y: ty, width: width * 0.5, height: 5 },
      text: 'Pearson r² = 0.98',
      fontSizePt: NATURE_THEME.type.tickLabelPt,
    });
    addArrow(draft, newId, {
      frame: { x: tx + width * 0.06, y: ty + 5, width: width * 0.2, height: height * 0.32 },
      points: [
        { x: 0, y: 0 },
        { x: width * 0.2, y: height * 0.32 },
      ],
      head: 'triangle',
    });
  });

  return doc;
}
