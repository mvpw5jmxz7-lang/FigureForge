/**
 * Demo figure used as the app's starting document.
 *
 * Seven panels of deliberately unlike kinds — a categorical bar-dot, a
 * three-tile micrograph montage, a SAM/S0 volcano, a heatmap, a Kaplan-Meier
 * curve, a timecourse and a violin. Two reasons for the spread. It shows what
 * the app can actually draw, which two panels never did; and it gives Smart
 * layout something real to solve, since panels of unlike demand are exactly
 * the case an evenly divided page gets wrong.
 *
 * The data is shaped like what comes out of a plate reader or an image
 * quantification, which is what most authors will paste in.
 *
 * Asset *bytes* are not here: `createSampleDocument` is called from Node by
 * `scripts/archive-memory.ts`, so it declares the `Asset` records and
 * `sampleMicrographs.ts` supplies what they point at.
 */

import {
  addAsset,
  addPanelWithImages,
  addPanelWithPlot,
  addScaleBar,
  applyAutoLayout,
  blocksOfSize,
  createDocument,
  couldHaveRowNames,
  createIdFactory,
  dataColumnOffset,
  editDocument,
  GROUPED_FORMATS,
  inferFormat,
  parseDelimited,
  relabelPanels,
  reflowGroupLabels,
  updateNode,
  type DataFormat,
  type Dataset,
  type ParseOptions,
  type FigureDocument,
  type PlotNode,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { SAMPLE_MICROGRAPHS } from './sampleMicrographs.js';
import {
  SAMPLE_TZ_CURVE_DOWN,
  SAMPLE_TZ_CURVE_UP,
  SAMPLE_TZ_VOLCANO_ROWS,
  SAMPLE_TZ_VOLCANO_TEST,
} from './sampleVolcanoTest.js';

export const SAMPLE_EXPRESSION = `Genotype,Rep1,Rep2,Rep3
WT,1.02,0.98,1.00
KO,2.41,2.68,2.55
Rescue,1.18,1.09,1.24`;

/**
 * Real (gene, log2 fold change, p-value) triples from
 * `reference-and-test-files/Proteomic data analysis 24Oct25.prism`'s own
 * "Data 1" table (a real HTT-interactome pulldown experiment) — 20 rows
 * chosen to span that file's actual shape: strong up hits (PSMD8, CCAR1,
 * POLR2A), down hits (SARS1, SLC25A4), moderate hits (FADS1, TOP2A,
 * ZNF512, CBX5, TPT1, TP53BP1), seven unflagged/null rows, and two vivid
 * real discordant cases. `qValue` is a genuine Benjamini-Hochberg
 * adjustment computed over this 20-row slice (not copied from Prism's own
 * verdict, which uses a different, S0-regularized statistic — see
 * `SAMPLE_REPLICATE_INTENSITIES` below for that comparison).
 *
 * The two discordant rows, both real: `GLUD2;GLUD1` has a huge, noisy-
 * looking fold change (5.80) with a weak p (0.163, q = 0.25 here — `'ns'`
 * under this plain reading) — yet Prism's own file flags it significant,
 * because S0-regularization rewards a fold change this large even at a
 * middling p (confirmed by actually running the SAM/S0 test on the
 * replicates below — see that constant's own comment).
 * `ACTC1;ACTG2;ACTA1;ACTA2` has a strong, clean p (0.0002) and is `'up'`
 * here — but Prism's file does *not* flag it, almost certainly because
 * shared-peptide actin isoforms are excluded as an ambiguous protein group
 * by a curation step outside the volcano statistic itself, which neither
 * this dataset nor the SAM/S0 tool claims to reproduce.
 */
export const SAMPLE_DIFFERENTIAL = `Gene,log2FoldChange,pValue,qValue
PSMD8,5.6170,3.36601e-05,0.000673201
CCAR1,3.7546,8.71489e-05,0.000871489
POLR2A,5.1951,0.000133079,0.000887191
ACTC1;ACTG2;ACTA1;ACTA2,1.3710,0.000202579,0.00101289
SARS1,-1.3221,0.00473124,0.0189249
SLC25A4,-1.0286,0.0292935,0.0488225
FADS1,3.0984,0.0100457,0.0226229
TOP2A,2.4260,0.0101495,0.0226229
ZNF512,6.7596,0.0101803,0.0226229
CBX5,1.0559,0.0101755,0.0226229
TP53BP1,3.1106,0.0201561,0.0387764
TPT1,3.5386,0.021327,0.0387764
GLUD2;GLUD1,5.7968,0.162845,0.250531
VPS13D,-1.8952,0.336284,0.480406
CCN1,-1.2788,0.365203,0.486938
SUCLG1,0.4910,0.714913,0.843944
GET3,-0.1987,0.717352,0.843944
DNPEP,0.2178,0.824032,0.87723
FHL1,-0.2936,0.87723,0.87723
RBMX2,-0.1731,0.866336,0.87723`;

/**
 * Raw per-replicate LFQ log2 intensities (3 control, 3 treated) for the
 * same 20 real genes — the shape Perseus's own "Misc > Volcano plot" tool
 * (S0 + permutation-based FDR) actually needs, and the shape a real
 * two-group proteomics export paste auto-detects as (`'replicate'`, never
 * `'matrix'`). Not attached to any panel: it exists so "Run volcano test
 * (Perseus-style) →" is visible and ready to click in the Data tab from
 * the very first launch, with no import step required.
 *
 * Simulated, not invented independently: each row's six numbers are three
 * points symmetric about `baseline - fc/2` (control) and three about
 * `baseline + fc/2` (treated), spaced so a plain two-sample t-test (df = 4)
 * reproduces the real log2FoldChange and p-value from `SAMPLE_DIFFERENTIAL`
 * to full floating-point precision — verified directly, not assumed.
 *
 * Running the real SAM/S0 test on these replicates (default s0 = 0.1, FDR
 * 5%) calls `GLUD2;GLUD1` **"up"** — unlike the plain p/q reading above,
 * and matching Prism's own real "Significant" flag for that row — because
 * S0 rewards its unusually large fold change even at a middling p. That
 * flip is the real reason Perseus uses S0 rather than a plain BH cutoff,
 * demonstrated here with real data rather than a hand-tuned example.
 */
export const SAMPLE_REPLICATE_INTENSITIES = `Gene,Control_1,Control_2,Control_3,Treated_1,Treated_2,Treated_3
PSMD8,4.855,5.191,5.528,10.472,10.809,11.145
CCAR1,5.837,6.123,6.408,9.592,9.877,10.163
POLR2A,4.962,5.402,5.843,10.157,10.598,11.038
ACTC1;ACTG2;ACTA1;ACTA2,7.185,7.315,7.444,8.556,8.685,8.815
SARS1,8.376,8.661,8.946,7.054,7.339,7.624
SLC25A4,8.135,8.514,8.893,7.107,7.486,7.865
FADS1,5.625,6.451,7.276,8.724,9.549,10.375
TOP2A,6.139,6.787,7.435,8.565,9.213,9.861
ZNF512,2.813,4.620,6.428,9.572,11.380,13.187
CBX5,7.190,7.472,7.754,8.246,8.528,8.810
TP53BP1,5.425,6.445,7.464,8.536,9.555,10.575
TPT1,5.051,6.231,7.410,8.590,9.769,10.949
GLUD2;GLUD1,0.945,5.102,9.259,6.741,10.898,15.055
VPS13D,6.822,8.948,11.074,4.926,7.052,9.178
CCN1,7.105,8.639,10.174,5.826,7.361,8.895
SUCLG1,6.221,7.755,9.288,6.712,8.245,9.779
GET3,7.473,8.099,8.726,7.274,7.901,8.527
DNPEP,6.767,7.891,9.015,6.985,8.109,9.233
FHL1,5.963,8.147,10.331,5.669,7.853,10.037
RBMX2,6.905,8.087,9.268,6.732,7.913,9.095`;

/**
 * Real per-replicate LFQ intensities for 100 proteins, columns T-Z of
 * `reference-and-test-files/Data samples.xlsx` (three control replicates,
 * three treatment replicates), used to build the figure's own "Proteomic
 * hits" panel below — a genuine SAM/S0 run, not the simulated flip
 * `SAMPLE_REPLICATE_INTENSITIES` above demonstrates. Also declared
 * `'proteomics'`, and also never attached to a panel itself: only its
 * *derived* volcano-test result (`tzVolcano` in `createSampleDocument`) is,
 * for the same reason every other volcano test's input table stays a plain
 * data row in the Data tab.
 */
export const SAMPLE_TZ_PROTEOMICS = `protein,control_replicate1,control_replicate2,control_replicate3,treatment_replicate1,treatment_replicate2,treatment_replicate3
Protein_001,24.31,24.18,24.27,27.14,27.02,27.21
Protein_002,19.84,19.92,19.77,21.7,21.79,21.62
Protein_003,27.42,27.55,27.38,30.83,30.96,30.79
Protein_004,22.17,22.29,22.11,23.04,23.16,22.98
Protein_005,25.63,25.71,25.58,23.87,23.99,23.81
Protein_006,21.46,21.53,21.39,22.89,23.02,22.84
Protein_007,18.72,18.81,18.66,22.47,22.58,22.4
Protein_008,26.15,26.28,26.09,26.72,26.88,26.61
Protein_009,23.87,23.95,23.79,26.46,26.61,26.37
Protein_010,20.53,20.61,20.47,21.73,21.82,21.65
Protein_011,24.72,24.81,24.65,26.81,26.93,26.72
Protein_012,19.31,19.42,19.25,20.04,20.18,19.93
Protein_013,28.13,28.24,28.06,32.2,32.38,32.11
Protein_014,22.84,22.76,22.91,22.32,22.51,22.39
Protein_015,21.92,22.04,21.86,22.78,22.91,22.66
Protein_016,25.17,25.26,25.09,23.94,24.1,23.87
Protein_017,18.93,19.02,18.87,19.15,19.27,18.99
Protein_018,26.73,26.84,26.66,28.7,28.86,28.57
Protein_019,23.46,23.55,23.38,24.39,24.56,24.27
Protein_020,20.84,20.76,20.91,21.35,21.52,21.22
Protein_021,25.92,26.04,25.85,24.38,24.57,24.25
Protein_022,22.38,22.47,22.31,23.77,23.91,23.61
Protein_023,19.67,19.75,19.59,19.98,20.12,19.85
Protein_024,27.61,27.73,27.54,30.37,30.53,30.24
Protein_025,21.14,21.26,21.07,20.49,20.66,20.36
Protein_026,23.78,23.86,23.69,24.6,24.78,24.52
Protein_027,24.46,24.54,24.39,23.34,23.52,23.21
Protein_028,26.48,26.57,26.41,28.08,28.22,27.95
Protein_029,18.41,18.52,18.35,18.6,18.75,18.48
Protein_030,21.73,21.82,21.66,22.37,22.51,22.25
Protein_031,24.91,25.03,24.84,26.27,26.41,26.16
Protein_032,26.02,26.11,25.95,24.15,24.3,24.02
Protein_033,22.51,22.43,22.58,23.01,23.15,22.89
Protein_034,20.18,20.27,20.11,19.42,19.58,19.32
Protein_035,27.03,27.14,26.96,30.15,30.31,29.98
Protein_036,23.19,23.27,23.11,22.67,22.82,22.54
Protein_037,25.48,25.57,25.41,27.05,27.2,26.92
Protein_038,24.76,24.85,24.68,22.44,22.59,22.31
Protein_039,19.26,19.34,19.18,19.49,19.67,19.34
Protein_040,21.89,21.98,21.82,22.91,23.04,22.78
Protein_041,25.31,25.42,25.24,23.99,24.14,23.82
Protein_042,26.87,26.96,26.79,28.62,28.77,28.49
Protein_043,22.06,22.15,21.98,21.72,21.9,21.57
Protein_044,20.92,21.01,20.85,21.64,21.78,21.52
Protein_045,23.63,23.72,23.55,24.47,24.63,24.32
Protein_046,27.28,27.39,27.21,29.57,29.71,29.44
Protein_047,18.84,18.93,18.76,18.6,18.76,18.47
Protein_048,24.15,24.24,24.08,25.29,25.43,25.17
Protein_049,25.74,25.83,25.66,24.17,24.34,24.02
Protein_050,21.37,21.45,21.29,21.86,22.01,21.72
Protein_051,26.41,26.53,26.34,28.34,28.49,28.2
Protein_052,20.06,20.15,19.98,19.43,19.59,19.29
Protein_053,22.73,22.81,22.65,23.09,23.23,22.99
Protein_054,24.98,25.07,24.91,23.54,23.7,23.42
Protein_055,23.84,23.92,23.76,25.08,25.21,24.95
Protein_056,21.58,21.67,21.51,21.04,21.19,20.92
Protein_057,28.04,28.16,27.96,30.65,30.81,30.53
Protein_058,23.25,23.34,23.18,22.34,22.49,22.19
Protein_059,22.14,22.25,22.07,23.08,23.24,22.94
Protein_060,25.56,25.65,25.49,24.4,24.56,24.26
Protein_061,24.63,24.72,24.55,26.1,26.24,25.98
Protein_062,19.92,20.01,19.84,19.62,19.78,19.48
Protein_063,21.28,21.36,21.2,21.98,22.15,21.84
Protein_064,26.17,26.29,26.08,24.47,24.62,24.32
Protein_065,27.51,27.63,27.43,29.69,29.85,29.56
Protein_066,20.71,20.79,20.63,20.22,20.38,20.08
Protein_067,23.42,23.51,23.35,24.54,24.68,24.41
Protein_068,18.56,18.65,18.49,18.41,18.57,18.27
Protein_069,26.22,26.34,26.13,27.99,28.15,27.86
Protein_070,24.08,24.17,24,23.05,23.2,22.91
Protein_071,22.67,22.76,22.59,23.19,23.34,23.04
Protein_072,27.16,27.27,27.08,29.13,29.28,28.99
Protein_073,20.43,20.52,20.36,19.7,19.86,19.56
Protein_074,23.91,24.02,23.84,24.8,24.95,24.67
Protein_075,25.08,25.19,25.01,23.73,23.89,23.58
Protein_076,28.31,28.42,28.23,30.76,30.91,30.63
Protein_077,21.04,21.13,20.97,20.61,20.78,20.46
Protein_078,24.37,24.46,24.29,25.72,25.87,25.57
Protein_079,22.89,22.98,22.82,22.26,22.41,22.11
Protein_080,20.26,20.35,20.18,20.86,21.02,20.72
Protein_081,26.61,26.72,26.53,28.43,28.58,28.29
Protein_082,25.37,25.48,25.29,23.44,23.6,23.3
Protein_083,19.14,19.23,19.06,19.29,19.43,19.17
Protein_084,23.56,23.65,23.49,24.72,24.87,24.61
Protein_085,21.81,21.9,21.74,20.99,21.14,20.83
Protein_086,27.84,27.95,27.75,30.3,30.46,30.17
Protein_087,22.32,22.41,22.25,22.08,22.23,21.94
Protein_088,24.01,24.1,23.94,24.88,25.03,24.76
Protein_089,25.21,25.32,25.13,23.93,24.09,23.79
Protein_090,26.74,26.84,26.66,28.47,28.62,28.34
Protein_091,20.89,20.98,20.82,20.39,20.54,20.23
Protein_092,27.39,27.5,27.3,29.32,29.48,29.19
Protein_093,23.73,23.82,23.65,22.8,22.96,22.66
Protein_094,21.65,21.74,21.58,22.1,22.24,21.98
Protein_095,25.49,25.6,25.41,23.79,23.95,23.67
Protein_096,24.28,24.38,24.19,25.63,25.78,25.5
Protein_097,19.58,19.67,19.51,19.4,19.56,19.24
Protein_098,27.67,27.78,27.58,29.83,30,29.71
Protein_099,23.14,23.23,23.07,22.33,22.49,22.19
Protein_100,21.97,22.06,21.89,22.68,22.83,22.54`;

/** Build a Dataset from pasted or imported delimited text. */
/**
 * A correlation matrix over pathway scores — the heatmap panel.
 *
 * `matrix` is never auto-inferred (nothing in a rectangle of numbers says
 * whether it is a grid to colour or replicates to pool), so the sample declares
 * it, exactly as the differential and proteomics tables above declare theirs.
 */
export const SAMPLE_PATHWAY_MATRIX = `Pathway,Ctrl 0 h,Ctrl 6 h,Cmpd 6 h,Cmpd 24 h
Autophagy,0.12,0.31,1.42,2.08
Lysosome,0.08,0.44,1.61,2.35
Proteasome,-0.21,-0.34,-0.88,-1.27
Oxid. stress,0.45,0.72,1.05,0.94
Cell cycle,-0.05,-0.42,-1.35,-1.92
Translation,0.02,-0.18,-0.61,-0.83`;

/**
 * Time-to-event data for the survival panel: one row per subject, an event
 * flag, and the arm. Declared `survival` — a bare three-numeric-column table
 * reads just as plausibly as three repeated measurements.
 */
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
16,1,Compound X
20,1,Compound X
27,1,Compound X
31,0,Compound X
43,1,Compound X
45,1,Compound X
53,1,Compound X
58,0,Compound X
66,1,Compound X
75,0,Compound X`;

/** Shared time axis, one column per arm — the timecourse line panel. */
export const SAMPLE_TIMECOURSE = `Hours,Vehicle,Compound X
0,1.00,1.02
2,1.08,1.44
4,1.15,2.31
8,1.21,3.68
12,1.18,4.42
24,1.24,4.85`;

/**
 * Twelve replicates per genotype for the distribution panel.
 *
 * n = 12 deliberately: `checkDistributionSampleSize` warns on a violin below
 * ten, and the figure the app opens with should not itself be an example of
 * the thing the quality checker exists to catch.
 */
export const SAMPLE_MARKER_DISTRIBUTION = `Genotype,R1,R2,R3,R4,R5,R6,R7,R8,R9,R10,R11,R12
WT,4.1,4.4,3.9,4.6,4.2,4.0,4.5,4.3,3.8,4.7,4.1,4.4
KO,7.2,6.8,7.9,7.1,6.5,8.2,7.4,7.7,6.9,8.0,7.3,7.6
Rescue,4.8,5.2,4.5,5.0,4.9,5.4,4.6,5.1,4.7,5.3,4.4,5.0`;

export interface ImportOptions extends ParseOptions {
  /**
   * Override the inferred layout.
   *
   * Detection is a heuristic on column shapes and names, and a wrong guess
   * silently changes what every series *is* — `prism` reads column 0 as one
   * shared x, `sigmaplot` reads the columns as independent pairs. The author is
   * the only one who actually knows, so they get the last word.
   */
  format?: DataFormat;
  /**
   * Override whether column 0 holds row labels rather than data.
   *
   * Same reason as `format`: "text column, then numbers" is both a row-labelled
   * xy table and a replicate table, and only the author knows which.
   */
  hasRowNames?: boolean;
  /**
   * Split the data columns into equal blocks of this size, for a grouped
   * layout whose file carries no group header row.
   *
   * The manual route: an author who knows their six columns are two groups of
   * three can say so. Nothing infers it — six columns are as plausibly six
   * groups of one, and a wrong split averages the wrong numbers together into
   * a mean that looks entirely reasonable.
   */
  replicatesPerGroup?: number;
}

export function datasetFromText(
  text: string,
  name: string,
  id: string,
  filename: string | null = null,
  options: ImportOptions = {},
): Dataset {
  const parsed = parseDelimited(text, options);
  /*
   * Never inferred: see `couldHaveRowNames`. Absent means "column 0 is data",
   * which is how every table has been read until now, so no existing import
   * changes meaning.
   *
   * Gated on the reading being *available*, not merely requested. The importer
   * keeps its overrides between pastes, so a table where column 0 really was a
   * label can be followed by one where it is the x values — and the setting
   * would otherwise still be applied, with the control that set it no longer
   * on screen to explain why.
   */
  const hasRowNames = (options.hasRowNames ?? false) && couldHaveRowNames(parsed.columns);

  const detected =
    options.format ??
    inferFormat(parsed.columns, { hasRowNames, columnGroups: parsed.columnGroups });

  /*
   * Saying "three columns per group" about a table *is* the statement that its
   * columns block into groups, so it is taken as one — for the shared-x shape
   * (which becomes XY+replicates) and for the labelled-rows shape (which becomes
   * Prism's Grouped).
   *
   * Without this the author has to say the same thing twice — pick the layout
   * from a dropdown that only lists it under a Prism name, *then* type the
   * count — and the control that takes the count is hidden until they have. A
   * count of 1 is not a claim about groups, so it changes nothing.
   */
  const format =
    (options.replicatesPerGroup ?? 0) >= 2
      ? detected === 'prism'
        ? 'xy-replicates'
        : detected === 'replicate'
          ? 'grouped-replicates'
          : detected
      : detected;

  const base: Dataset = {
    id,
    name,
    format,
    columns: parsed.columns,
    rows: parsed.rows,
    // Written only when true: absent is the shape every existing file has, and
    // an explicit `false` everywhere would be noise in every saved document.
    ...(hasRowNames ? { hasRowNames: true } : {}),
    ...(parsed.columnGroups.length > 0 ? { columnGroups: parsed.columnGroups } : {}),
    sourcePath: `data/${id}.csv`,
    sourceFilename: filename,
    importedAt: new Date().toISOString(),
  };

  /*
   * An explicit block size wins over whatever the header declared: the author
   * is looking at the preview and the file is not. Only for the layouts that
   * read blocks at all — setting it on a replicate table would store a reading
   * nothing consults, which is worse than storing nothing.
   */
  if (options.replicatesPerGroup && GROUPED_FORMATS.has(format)) {
    const blocks = blocksOfSize(base, options.replicatesPerGroup);
    if (blocks.length > 0) return { ...base, columnGroups: blocks };
  }
  return base;
}

/**
 * Axis titles a dataset's own header row already supplies.
 *
 * The header names were parsed, stored as `Column.name` and then ignored: every
 * imported panel got `yTitle: 'Value'` and no x title at all, so an author who
 * had already labelled their columns had to type both again. Only offered for
 * the layouts where a column *is* an axis — on a replicate table column 0 names
 * the groups, which the band labels already show.
 */
export function axisTitlesFor(dataset: Dataset): { x?: string; y?: string } {
  // `usable` is declared below and used by both paths; hoisted in reading order
  // only, since a function declaration is available throughout.
  /*
   * A fold-vs-fold table is the one shape where each axis is fed by exactly
   * one named column, so the "every column feeding this axis agrees" rule
   * below has nothing to decide and would reject the honest answer: it reads
   * `names.slice(1)` as the y candidates and finds two different names.
   *
   * Which makes it the opposite case to a volcano's, where `addPlot`
   * hardcodes the titles because neither header names what is drawn. Here the
   * headers are exactly the axis names an author wants — "97Q/25Q fold
   * enrichment" — and neither column is transformed on the way to the page.
   */
  if (dataset.format === 'fold-fold') {
    const x = usableAxisName(dataset.columns[1]?.name.trim());
    const y = usableAxisName(dataset.columns[2]?.name.trim());
    return { ...(x ? { x } : {}), ...(y ? { y } : {}) };
  }

  if (!CONTINUOUS_X_FORMATS.has(dataset.format)) return {};

  const first = dataColumnOffset(dataset);
  const names = dataset.columns.slice(first).map((c) => c.name.trim());

  /*
   * A column name titles an axis only when *every* column feeding that axis
   * carries it. Otherwise the name belongs to one series, the legend already
   * shows it, and putting it on the axis labels the whole quantity after a
   * third of it — `X1,Y1,X2,Y2,X3,Y3` was titling its axes "X1" and "Y1" while
   * "Y1" sat in the legend beside "Y2" and "Y3".
   *
   * The same rule reads the honest case correctly: a sedimentation export
   * headed `Radius,C(s)_run1,Radius,C(s)_run2` really does measure every run
   * against a radius, so "Radius" is the x axis.
   */
  const agreed = (values: readonly string[]): string | undefined =>
    values.length > 0 && values.every((v) => v === values[0]) ? values[0] : undefined;

  const isPaired = dataset.format === 'sigmaplot';
  const x = agreed(isPaired ? names.filter((_, i) => i % 2 === 0) : names.slice(0, 1));
  /*
   * Only where the y columns really are one quantity. On a replicate-blocked
   * table the second column is `A:Y1` — one replicate of one group — and on a
   * shared-x table the y columns are the series names.
   */
  const y =
    dataset.format === 'xy-replicates'
      ? undefined
      : agreed(isPaired ? names.filter((_, i) => i % 2 === 1) : names.slice(1));

  return {
    ...(usableAxisName(x) ? { x: usableAxisName(x)! } : {}),
    ...(usableAxisName(y) ? { y: usableAxisName(y)! } : {}),
  };
}

/**
 * `defaultColumnName` produces A, B, C… when there was no header row. Those are
 * placeholders, not labels, and putting one on an axis is worse than leaving it
 * blank for the author to fill.
 *
 * Lifted out of `axisTitlesFor` so the fold-vs-fold branch above applies the
 * identical rule rather than a second, drifting copy of it.
 */
function usableAxisName(name: string | undefined): string | undefined {
  return name !== undefined && name !== '' && !/^[A-Z]{1,2}$/.test(name) ? name : undefined;
}

/** Layouts whose column 0 (or 1) is an x axis rather than a group label. */
const CONTINUOUS_X_FORMATS: ReadonlySet<DataFormat> = new Set<DataFormat>([
  'simple-xy',
  'prism',
  'sigmaplot',
  // Column 0 is the shared x here too; the y columns are named by their groups,
  // so only the x title is worth taking.
  'xy-replicates',
]);

export function createSampleDocument(): FigureDocument {
  const newId = createIdFactory();

  const base = createDocument({
    title: 'Compound X induces target expression and shifts the proteome',
    presetId: 'nature-double',
    widthMm: 183,
    // Seven panels on a 3 x 3 grid. Deliberately merely *adequate*: the plain
    // Auto Layout this ships with divides it evenly, and turning that into a
    // figure is exactly what the Layout tab is for.
    heightMm: 180,
    idFactory: newId,
  });

  return editDocument(base, (draft) => {
    const expression = datasetFromText(SAMPLE_EXPRESSION, 'Target expression', newId());
    // Never auto-inferred — see the `'differential'` format's own doc
    // comment — so the layout is stated explicitly rather than detected.
    // Kept in the Data tab but not attached to any panel: the figure's own
    // "Proteomic hits" panel now shows a real SAM/S0 run (`tzVolcano`
    // below) rather than this plain p/q reading, but the comparison between
    // the two is still worth having on hand — see
    // `SAMPLE_REPLICATE_INTENSITIES`'s own comment, which depends on it.
    const differential = datasetFromText(
      SAMPLE_DIFFERENTIAL,
      'Proteomic differential expression',
      newId(),
      null,
      { format: 'differential' },
    );
    /*
     * Not attached to any panel — demonstrates the S0 fold-change flip
     * against a real Prism reference (see this constant's own comment).
     *
     * Declared `'proteomics'`, and never inferred as one: nothing in these
     * numbers separates them from any other replicate table, which is exactly
     * why the button is gated on the declaration rather than on the shape. It
     * is what keeps the button off `Target expression` above, which is the
     * same shape and means something else entirely.
     */
    const replicates = datasetFromText(
      SAMPLE_REPLICATE_INTENSITIES,
      'Proteomic replicate intensities',
      newId(),
      null,
      { format: 'proteomics' },
    );
    // The real input table behind the figure's own "Proteomic hits" panel.
    // Also unattached, for the same reason `replicates` above is: a
    // proteomics-format table is the input to a test, not a figure.
    const tzProteomics = datasetFromText(
      SAMPLE_TZ_PROTEOMICS,
      'Control vs. treatment intensities (n = 100)',
      newId(),
      null,
      { format: 'proteomics' },
    );
    // The panel's actual dataset: `tzProteomics` run through the real
    // Perseus-style SAM/S0 test (s0 = 0.5, target FDR = 5%), precomputed by
    // `sampleVolcanoTest.ts` — see that file's own comment for why this is
    // pinned data rather than a live call. `derivedFrom` links it back to
    // `tzProteomics` exactly as `runSamVolcanoOn` would after a real run, so
    // a re-run from the Data tab replaces this in place rather than adding a
    // second copy.
    const tzVolcano: Dataset = {
      id: newId(),
      name: `${tzProteomics.name} — volcano test`,
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
      importedAt: new Date().toISOString(),
      derivedFrom: { datasetId: tzProteomics.id, kind: 'volcano-test' },
    };
    const pathways = datasetFromText(SAMPLE_PATHWAY_MATRIX, 'Pathway scores', newId(), null, {
      format: 'matrix',
    });
    const survival = datasetFromText(SAMPLE_SURVIVAL, 'Survival by arm', newId(), null, {
      format: 'survival',
    });
    const timecourse = datasetFromText(SAMPLE_TIMECOURSE, 'Reporter timecourse', newId());
    const markers = datasetFromText(SAMPLE_MARKER_DISTRIBUTION, 'Marker distribution', newId());

    draft.datasets = [
      expression,
      differential,
      replicates,
      tzProteomics,
      tzVolcano,
      pathways,
      survival,
      timecourse,
      markers,
    ];

    // a — the smallest demand on the page. Three categories and no legend, so
    // it reads perfectly well in a narrow column, which is what Smart layout
    // should discover rather than be told.
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Expression',
      datasetId: expression.id,
      plotType: 'bar-dot',
      yTitle: 'Relative expression',
      xTitle: 'Genotype',
    });

    // b — the largest demand. Three 800 px tiles, so the panel keeps gaining
    // real detail right up to the full page width; `autoFit` lets the montage
    // take the shape its pictures actually want.
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
    const { images } = addPanelWithImages(draft, newId, {
      frame: { x: 0, y: 0, width: 90, height: 30 },
      name: 'Micrographs',
      gutterMm: 1,
      images: SAMPLE_MICROGRAPHS.map((m) => ({
        assetId: m.id,
        naturalPx: m.naturalPx,
        name: m.filename.replace('.jpg', ''),
      })),
    });
    /*
     * Calibrated, not left to be filled in. `checkScaleBarCalibration` treats
     * an unknown calibration as an *error* weighted 25 — the app would open on
     * a visibly poor readiness score, and the first thing a new user saw would
     * be a defect in the example.
     */
    const firstTile = images[0];
    if (firstTile) {
      addScaleBar(draft, newId, {
        imageId: firstTile.id,
        length: 20,
        pixelsPerUnit: 5.2,
        unitLabel: 'µm',
        calibrationSource: 'manual',
      });
    }

    // c — a real SAM/S0 boundary from the start, not a plain fold-change and
    // p-value cutoff. See `sampleVolcanoTest.ts` for where the numbers are from.
    const { plot: volcano } = addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Proteomic hits',
      datasetId: tzVolcano.id,
      plotType: 'volcano',
      yTitle: '-Log10 p-value',
      xTitle: 'Log2 fold change',
    });
    updateNode<PlotNode>(draft, volcano.id, {
      volcanoThresholds: {
        foldChange: 1,
        pValue: 0.05,
        fdr: SAMPLE_TZ_VOLCANO_TEST.fdrAchieved,
        significanceBy: 'fdr',
      },
      volcanoSamCurve: { up: SAMPLE_TZ_CURVE_UP, down: SAMPLE_TZ_CURVE_DOWN },
      volcanoTest: { ...SAMPLE_TZ_VOLCANO_TEST },
    });

    // d — six rows of row labels and a colourbar, so this one wants width.
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Pathway scores',
      datasetId: pathways.id,
      plotType: 'heatmap',
    });

    // e — the opposite shape to the heatmap: a probability axis fixed at 0..1.
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Survival',
      datasetId: survival.id,
      plotType: 'survival',
      yTitle: 'Survival probability',
      xTitle: 'Days',
    });

    // f — continuous x with a two-entry legend, which is what makes its
    // measured bottom margin larger than the bar chart's.
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Reporter timecourse',
      datasetId: timecourse.id,
      plotType: 'line',
      yTitle: 'Fold induction',
      xTitle: 'Hours',
    });

    // g — n = 12 per group, deliberately: `checkDistributionSampleSize` warns
    // on a violin below ten, and the example should not demonstrate the defect.
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Marker distribution',
      datasetId: markers.id,
      plotType: 'violin',
      yTitle: 'Marker intensity',
      xTitle: 'Genotype',
    });

    applyAutoLayout(draft, {
      marginMm: NATURE_THEME.spacing.marginMm,
      gutterMm: NATURE_THEME.spacing.panelGutterMm,
      labelGutterMm: 4,
    });
    reflowGroupLabels(draft);

    relabelPanels(draft, newId, {
      fontSizePt: NATURE_THEME.type.panelLabelPt,
      offsetMm: 4,
    });
  });
}
