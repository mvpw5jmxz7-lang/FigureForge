/**
 * Figure quality checker and Publication Readiness Score.
 *
 * The checks run against the rendered scene tree rather than the document,
 * because what a journal receives is the rendered output — a font size that
 * looks fine in the inspector but resolves to 4 pt after a panel is scaled is
 * exactly the class of defect this is meant to catch.
 */

import {
  absoluteFrame,
  analysisInputHash,
  effectiveDpi,
  findAsset,
  findDataset,
  isStale,
  mmToPt,
  measureGutters,
  scaleBarWidthMm,
  toSeries,
  type FigureDocument,
  type ImageNode,
  type ScaleBarNode,
} from '@figureforge/doc-model';
import { findColorConflicts, findPreset, type Theme } from '@figureforge/theme';
import { collectByRole, walkScene, type SceneNode } from './scene.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Document nodes involved, so the UI can select them. */
  nodeIds: string[];
  /** True when the app can fix this without a decision from the user. */
  autoFixable: boolean;
}

export interface QualityReport {
  score: number;
  findings: Finding[];
  /** Per-category pass state, for the readiness panel. */
  categories: { name: string; passed: boolean; weight: number }[];
}

export interface CheckContext {
  document: FigureDocument;
  theme: Theme;
  scene: SceneNode;
  /** Target export resolution, for the image resolution check. */
  exportDpi?: number;
}

type Rule = (context: CheckContext) => Finding[];

/**
 * Weights reflect how likely a defect is to get a figure sent back. Text below
 * the minimum size and under-resolution images are the two that reliably do.
 */
const CATEGORY_WEIGHTS: Record<string, number> = {
  'Text size': 25,
  'Image resolution': 25,
  // A scale bar drawn from a guessed calibration is a false measurement, not a
  // presentation defect — strictly worse than an under-resolution image, and
  // undetectable by eye, so it carries the same weight.
  'Scale bar calibration': 25,
  // A figure annotated with p-values its data no longer supports is worse than
  // any typographic defect, and it is invisible without this check.
  'Statistics currency': 25,
  'Panel labelling': 15,
  'Colour accessibility': 15,
  // A violin over three replicates is a figure-level overclaim, not a cosmetic
  // defect — weighted alongside the other things that get a figure sent back.
  'Distribution sample size': 15,
  'Font consistency': 10,
  'Plot size': 10,
  'Page dimensions': 5,
  'Panel spacing': 5,
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const checkTextSize: Rule = ({ scene, theme }) => {
  const findings: Finding[] = [];
  const tooSmall: { size: number; role: string }[] = [];
  const tooLarge: { size: number; role: string }[] = [];

  walkScene(scene, (node) => {
    const raw = node.attrs?.['font-size'];
    if (typeof raw !== 'number') return;
    const pt = mmToPt(raw);
    // Panel labels are legitimately larger than body text.
    const isPanelLabel = node.role === 'panel-label';
    if (pt < theme.type.minimumPt - 0.01) tooSmall.push({ size: pt, role: node.role ?? 'text' });
    else if (!isPanelLabel && pt > theme.type.maximumPt + 0.01) {
      tooLarge.push({ size: pt, role: node.role ?? 'text' });
    }
  });

  if (tooSmall.length > 0) {
    const smallest = Math.min(...tooSmall.map((t) => t.size));
    findings.push({
      id: 'text-below-minimum',
      severity: 'error',
      title: `${tooSmall.length} text element(s) below ${theme.type.minimumPt} pt`,
      detail:
        `Smallest is ${smallest.toFixed(1)} pt. Journals reject figures with text under ` +
        `${theme.type.minimumPt} pt at final printed size, because it is unreadable in print.`,
      nodeIds: [],
      autoFixable: true,
    });
  }

  if (tooLarge.length > 0) {
    findings.push({
      id: 'text-above-maximum',
      severity: 'warning',
      title: `${tooLarge.length} text element(s) above ${theme.type.maximumPt} pt`,
      detail: `Oversized text unbalances the figure against the printed page.`,
      nodeIds: [],
      autoFixable: true,
    });
  }

  return findings;
};

const checkFontConsistency: Rule = ({ scene, theme }) => {
  const families = new Set<string>();
  walkScene(scene, (node) => {
    const family = node.attrs?.['font-family'];
    if (typeof family === 'string') families.add(family);
  });

  if (families.size <= 1) return [];

  return [
    {
      id: 'mixed-fonts',
      severity: 'warning',
      title: `${families.size} different font stacks in one figure`,
      detail:
        `Found: ${[...families].join(' / ')}. The ${theme.name} preset expects a single ` +
        `family throughout.`,
      nodeIds: [],
      autoFixable: true,
    },
  ];
};

const checkPanelLabels: Rule = ({ document, scene }) => {
  const findings: Finding[] = [];
  const panels = Object.values(document.nodes).filter((n) => n.type === 'panel');
  if (panels.length <= 1) return findings;

  const labels = collectByRole(scene, 'panel-label');
  const labelTexts = labels.map((l) => l.text ?? '');

  if (labels.length < panels.length) {
    findings.push({
      id: 'missing-panel-labels',
      severity: 'error',
      title: `${panels.length - labels.length} panel(s) have no label`,
      detail: 'Every panel in a multi-panel figure needs a letter so the legend can refer to it.',
      nodeIds: panels.map((p) => p.id),
      autoFixable: true,
    });
  }

  const duplicates = labelTexts.filter((t, i) => labelTexts.indexOf(t) !== i);
  if (duplicates.length > 0) {
    findings.push({
      id: 'duplicate-panel-labels',
      severity: 'error',
      title: `Duplicate panel label(s): ${[...new Set(duplicates)].join(', ')}`,
      detail: 'Two panels share a letter, so the legend cannot address them unambiguously.',
      nodeIds: [],
      autoFixable: true,
    });
  }

  return findings;
};

/** MIME types with no intrinsic pixel grid, so no resolution to be short of. */
const VECTOR_MIME_TYPES = new Set(['image/svg+xml', 'application/pdf', 'application/postscript']);

const checkImageResolution: Rule = ({ document, exportDpi = 300 }) => {
  const findings: Finding[] = [];
  const images = Object.values(document.nodes).filter(
    (n): n is ImageNode => n.type === 'image',
  );

  for (const image of images) {
    const frame = absoluteFrame(document.nodes, image.id);
    if (!frame || frame.width <= 0) continue;

    // A vector asset resolves at whatever the output device offers, so the
    // question this rule asks does not apply. The answer comes from the asset's
    // MIME type rather than a sentinel on the node: a magic pixel count would
    // be an implicit contract, and this is the kind that rots quietly.
    const asset = findAsset(document, image.assetId);
    if (asset && VECTOR_MIME_TYPES.has(asset.mimeType)) continue;

    const visiblePx = image.naturalPx.width * (image.crop.width || 1);
    if (visiblePx <= 0) continue;
    const dpi = effectiveDpi(visiblePx, frame.width);

    if (dpi < exportDpi) {
      findings.push({
        id: `image-low-dpi-${image.id}`,
        severity: dpi < exportDpi * 0.66 ? 'error' : 'warning',
        title: `"${image.name}" is ${Math.round(dpi)} dpi at its current size`,
        detail:
          `Below the ${exportDpi} dpi target. Scale the panel down to ` +
          `${(visiblePx / (exportDpi / 25.4)).toFixed(1)} mm wide, or supply a higher-resolution ` +
          `original. Upscaling cannot recover detail that was never captured.`,
        nodeIds: [image.id],
        autoFixable: false,
      });
    }
  }

  return findings;
};

/**
 * Scale bars that assert a measurement nobody supplied.
 *
 * An error rather than a warning, and weighted alongside image resolution: a
 * low-resolution micrograph looks bad, whereas a bar drawn from a guessed
 * calibration is a false quantitative claim in a published figure. Nothing else
 * in the figure can reveal it — the bar looks identical either way.
 *
 * Deliberately *not* marked in the scene. The renderer is shared with the
 * exporter, so a warning stripe drawn here would be submitted to the journal.
 */
const checkScaleBarCalibration: Rule = ({ document }) => {
  const findings: Finding[] = [];
  const bars = Object.values(document.nodes).filter(
    (n): n is ScaleBarNode => n.type === 'scale-bar',
  );

  for (const bar of bars) {
    const parent = bar.parentId ? document.nodes[bar.parentId] : undefined;

    if (parent?.type !== 'image') {
      findings.push({
        id: `scale-bar-unparented-${bar.id}`,
        severity: 'error',
        title: `"${bar.name}" is not attached to an image`,
        detail:
          'A scale bar takes its length from the image it sits on. Detached, it ' +
          'is drawn at whatever width it happens to have, which states a ' +
          'measurement no image supports. Drag it onto the micrograph.',
        nodeIds: [bar.id],
        autoFixable: false,
      });
      continue;
    }

    if ((bar.calibrationSource ?? 'unknown') === 'unknown') {
      findings.push({
        id: `scale-bar-uncalibrated-${bar.id}`,
        severity: 'error',
        title: `"${bar.name}" has no calibration`,
        detail:
          'The bar is drawn from a placeholder, not from a known pixel size. ' +
          'Set the image scale in the Inspector — from the microscope metadata, ' +
          'or by measuring a feature of known length.',
        nodeIds: [bar.id],
        autoFixable: false,
      });
    }

    // Off by a factor of a thousand — nm typed where µm was meant — is the
    // classic calibration error, and it shows up as a bar wider than the image.
    const width = scaleBarWidthMm(document.nodes, bar.id);
    if (width !== null && width > parent.frame.width) {
      findings.push({
        id: `scale-bar-oversized-${bar.id}`,
        severity: 'error',
        title: `"${bar.name}" is wider than the image it measures`,
        detail:
          `The bar works out at ${width.toFixed(1)} mm across a ` +
          `${parent.frame.width.toFixed(1)} mm image. Check the units — a factor of ` +
          '1000 here usually means nm was entered where µm was meant.',
        nodeIds: [bar.id, parent.id],
        autoFixable: false,
      });
    }
  }

  return findings;
};

const checkColorAccessibility: Rule = ({ scene }) => {
  const seriesColors = new Set<string>();
  // Every role that carries a *series* colour. A new mark family left off this
  // list still renders, but drops silently out of the colour-vision check.
  for (const role of ['bar', 'point', 'line', 'box', 'violin', 'outlier'] as const) {
    for (const node of collectByRole(scene, role)) {
      const fill = node.attrs?.['fill'];
      const stroke = node.attrs?.['stroke'];
      for (const value of [fill, stroke]) {
        if (typeof value === 'string' && value.startsWith('#')) seriesColors.add(value);
      }
    }
  }

  const colors = [...seriesColors];
  if (colors.length < 2) return [];

  const conflicts = findColorConflicts(colors);
  if (conflicts.length === 0) return [];

  const worst = conflicts[0]!;
  const cvdConflicts = conflicts.filter((c) => c.condition !== 'grayscale' && c.condition !== 'normal');

  const findings: Finding[] = [];

  if (cvdConflicts.length > 0) {
    const first = cvdConflicts[0]!;
    findings.push({
      id: 'colour-blind-conflict',
      severity: 'warning',
      title: `${first.colorA} and ${first.colorB} are hard to tell apart under ${first.condition}`,
      detail:
        `Perceptual difference ΔE ${first.deltaE.toFixed(1)} once simulated. Around 8% of male ` +
        `readers have some colour vision deficiency; the Okabe–Ito palette avoids this.`,
      nodeIds: [],
      autoFixable: true,
    });
  }

  const grayConflicts = conflicts.filter((c) => c.condition === 'grayscale');
  if (grayConflicts.length > 0) {
    findings.push({
      id: 'grayscale-conflict',
      severity: 'info',
      title: 'Series colours merge when printed in greyscale',
      detail:
        `ΔE ${worst.deltaE.toFixed(1)} in greyscale. Consider differing marker shapes or fill ` +
        `patterns as a redundant channel.`,
      nodeIds: [],
      autoFixable: false,
    });
  }

  return findings;
};

const checkPageDimensions: Rule = ({ document }) => {
  const preset = document.page.presetId ? findPreset(document.page.presetId) : undefined;
  if (!preset) return [];

  const findings: Finding[] = [];

  if (Math.abs(document.page.widthMm - preset.widthMm) > 0.5) {
    findings.push({
      id: 'page-width-mismatch',
      severity: 'warning',
      title: `Width is ${document.page.widthMm.toFixed(1)} mm, not the ${preset.label} ${preset.widthMm} mm`,
      detail: 'The figure will be rescaled at typesetting, shrinking every font with it.',
      nodeIds: [],
      autoFixable: true,
    });
  }

  if (document.page.heightMm > preset.maxHeightMm) {
    findings.push({
      id: 'page-too-tall',
      severity: 'error',
      title: `Height ${document.page.heightMm.toFixed(1)} mm exceeds the ${preset.maxHeightMm} mm limit`,
      detail: `${preset.journal} needs the figure and its legend to fit one page.`,
      nodeIds: [],
      autoFixable: false,
    });
  }

  return findings;
};

const checkPanelSpacing: Rule = ({ document }) => {
  const panels = Object.values(document.nodes).filter((n) => n.type === 'panel');
  if (panels.length < 3) return [];

  const frames = panels
    .map((p) => absoluteFrame(document.nodes, p.id))
    .filter((f): f is NonNullable<typeof f> => f !== null);

  const { horizontal, vertical } = measureGutters(frames);
  const findings: Finding[] = [];

  for (const [axis, gaps] of [['horizontal', horizontal], ['vertical', vertical]] as const) {
    if (gaps.length < 2) continue;
    const spread = Math.max(...gaps) - Math.min(...gaps);
    if (spread > 0.5) {
      findings.push({
        id: `uneven-gutters-${axis}`,
        severity: 'warning',
        title: `Uneven ${axis} panel spacing (varies by ${spread.toFixed(1)} mm)`,
        detail: 'Unequal gutters read as misalignment. Auto Layout equalises them.',
        nodeIds: panels.map((p) => p.id),
        autoFixable: true,
      });
    }
  }

  return findings;
};

/**
 * Analyses whose data has changed since they were computed.
 *
 * The document stores the input hash precisely so this can be detected, and
 * until now nothing compared it. A figure showing a p-value its data no longer
 * supports is the most serious defect this checker can find.
 */
const checkStaleAnalyses: Rule = ({ document }) => {
  const findings: Finding[] = [];

  for (const analysis of document.analyses) {
    if (analysis.result === null) continue;

    const dataset = findDataset(document, analysis.spec.datasetId);
    if (!dataset) continue;

    const series = toSeries(dataset);
    const current = analysisInputHash(
      { test: analysis.test, correction: analysis.options.correction },
      series.map((s) => s.values),
    );
    if (!isStale(analysis, current)) continue;

    const brackets = Object.values(document.nodes).filter(
      (n) => n.type === 'bracket' && n.analysisId === analysis.id,
    );

    findings.push({
      id: `stale-analysis-${analysis.id}`,
      severity: 'error',
      title: `"${analysis.name}" no longer matches its data`,
      detail:
        'The values feeding this test have changed since it was run, so the ' +
        'annotated p-values may not reflect what is plotted. Re-run the test.',
      nodeIds: brackets.map((b) => b.id),
      autoFixable: false,
    });
  }

  return findings;
};

/**
 * Panels too narrow for their own axis gutters.
 *
 * `computePlotGeometry` returns null once the plot margins exceed the frame, so
 * the plot renders as nothing at all — a blank panel with no error anywhere.
 * Easy to reach by importing enough datasets, since each import re-runs the
 * layout and narrows every panel.
 */
const checkPlotSize: Rule = ({ document, theme }) => {
  const margin = theme.spacing.plotMarginMm;
  const findings: Finding[] = [];

  for (const node of Object.values(document.nodes)) {
    if (node.type !== 'plot') continue;

    const width = node.frame.width - margin.left - margin.right;
    const height = node.frame.height - margin.top - margin.bottom;
    if (width > 0 && height > 0) continue;

    findings.push({
      id: `plot-too-small-${node.id}`,
      severity: 'error',
      title: `"${node.name}" is too small to draw`,
      detail:
        `The panel leaves no room for the plot once its axis gutters ` +
        `(${margin.left + margin.right} × ${margin.top + margin.bottom} mm) are taken. ` +
        'Enlarge the panel, reduce the panel count, or use a taller page.',
      nodeIds: [node.id],
      autoFixable: false,
    });
  }

  return findings;
};

/**
 * A violin drawn over a handful of replicates.
 *
 * Kernel density at n = 3 produces a smooth, confident-looking shape from three
 * numbers — the reader sees a distribution, the data supports nothing of the
 * kind. Box plots are milder but share the problem: quartiles and Tukey fences
 * are not meaningful below about n = 5. Both are common enough in submitted
 * figures to be worth naming, and neither is fixable without a decision from the
 * author, so this warns rather than offering to change anything.
 */
const MIN_VIOLIN_N = 10;
const MIN_BOX_N = 5;

const checkDistributionSampleSize: Rule = ({ document }) => {
  const findings: Finding[] = [];

  for (const node of Object.values(document.nodes)) {
    if (node.type !== 'plot') continue;
    if (node.plotType !== 'violin' && node.plotType !== 'box') continue;

    const dataset = findDataset(document, node.datasetId);
    if (!dataset) continue;

    const counts = toSeries(dataset).map((s) => s.values.filter(Number.isFinite).length);
    if (counts.length === 0) continue;

    const smallest = Math.min(...counts);
    const threshold = node.plotType === 'violin' ? MIN_VIOLIN_N : MIN_BOX_N;
    if (smallest >= threshold) continue;

    findings.push({
      id: `distribution-n-${node.id}`,
      severity: 'warning',
      title: `${node.plotType === 'violin' ? 'Violin' : 'Box'} plot with n = ${smallest}`,
      detail:
        node.plotType === 'violin'
          ? `A violin implies a distribution shape, and ${smallest} replicates cannot support one. A dot or beeswarm plot shows the same data without the implication.`
          : `Quartiles and whiskers are unstable at n = ${smallest}. Consider a dot or bar+points plot, which shows every replicate.`,
      nodeIds: [node.id],
      autoFixable: false,
    });
  }

  return findings;
};

const RULES: { category: string; rule: Rule }[] = [
  { category: 'Text size', rule: checkTextSize },
  { category: 'Image resolution', rule: checkImageResolution },
  { category: 'Scale bar calibration', rule: checkScaleBarCalibration },
  { category: 'Statistics currency', rule: checkStaleAnalyses },
  { category: 'Panel labelling', rule: checkPanelLabels },
  { category: 'Colour accessibility', rule: checkColorAccessibility },
  { category: 'Distribution sample size', rule: checkDistributionSampleSize },
  { category: 'Font consistency', rule: checkFontConsistency },
  { category: 'Plot size', rule: checkPlotSize },
  { category: 'Page dimensions', rule: checkPageDimensions },
  { category: 'Panel spacing', rule: checkPanelSpacing },
];

// ---------------------------------------------------------------------------

export function checkFigure(context: CheckContext): QualityReport {
  const findings: Finding[] = [];
  const categories: QualityReport['categories'] = [];

  let earned = 0;
  let total = 0;

  for (const { category, rule } of RULES) {
    const weight = CATEGORY_WEIGHTS[category] ?? 5;
    total += weight;

    const categoryFindings = rule(context);
    findings.push(...categoryFindings);

    // Errors forfeit the category; warnings cost half; info is free.
    const hasError = categoryFindings.some((f) => f.severity === 'error');
    const hasWarning = categoryFindings.some((f) => f.severity === 'warning');
    const credit = hasError ? 0 : hasWarning ? weight * 0.5 : weight;

    earned += credit;
    categories.push({ name: category, passed: categoryFindings.length === 0, weight });
  }

  const severityRank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    score: total === 0 ? 100 : Math.round((earned / total) * 100),
    findings,
    categories,
  };
}
