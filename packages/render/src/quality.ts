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
  LABELLED_POINT_PLOT_TYPES,
  analysisInputHash,
  effectiveDpi,
  eventsForHash,
  findAsset,
  findDataset,
  isStale,
  mmToPt,
  measureGutters,
  scaleBarWidthMm,
  toSeries,
  xForHash,
  type FigureDocument,
  type ImageNode,
  type ScaleBarNode,
} from '@figureforge/doc-model';
import {
  deltaE2000,
  findColorConflicts,
  findPreset,
  MIN_SERIES_DELTA_E,
  simulateCvd,
  type CvdType,
  type Theme,
} from '@figureforge/theme';
import {
  clampFontSize,
  dropFontOverrides,
  equaliseGutters,
  matchPresetWidth,
  relabelAllPanels,
  type Fix,
} from './fixes.js';
import {
  hasCascadeOffset,
  MAX_VECTOR_POINTS,
  planPointClouds,
  pointLabelLimit,
} from './render-document.js';
import { walkScene, walkWithOwner, type SceneNode } from './scene.js';
import { SUPERSCRIPT_MIN_PT } from './text-width.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  /** Document nodes involved, so the UI can select them. */
  nodeIds: string[];
  /**
   * Present exactly when this can be repaired without a decision from the
   * author. Replaces an `autoFixable` boolean, which was set on ten findings
   * and honoured by none: a boolean can claim a fix that does not exist,
   * whereas a closure either repairs the figure or is absent.
   *
   * Findings are transient — never persisted, never structured-cloned — which
   * is what makes carrying a function here free. If one ever has to cross a
   * worker or file boundary, this is the field that breaks.
   */
  fix?: Fix;
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

/**
 * Which theme size a scene element was drawn at, for the findings that name it.
 *
 * Only needed for text the author did not size themselves — everything else is
 * reported against the node the author can see in the Inspector.
 */
const THEME_SIZE_KEYS: Partial<Record<string, keyof Theme['type']>> = {
  'tick-label': 'tickLabelPt',
  'tick-label-sup': 'tickLabelPt',
  'axis-title': 'axisTitlePt',
  'panel-label': 'panelLabelPt',
  'bracket-label': 'statisticPt',
  // The same size as a bracket's own label, because it is the same kind of
  // thing: a test's answer annotated onto the plot it was run on.
  'ks-gap-label': 'statisticPt',
  'scale-bar-label': 'scaleBarPt',
  'point-label': 'annotationPt',
  'cascade-axis-label': 'tickLabelPt',
  'cascade-axis-title': 'axisTitlePt',
  legend: 'legendPt',
};

interface SizedText {
  pt: number;
  role: string;
  /** Document node that owns this element, when it has one. */
  ownerId?: string;
}

/**
 * Text outside the journal's size range.
 *
 * Split into two findings, because there are two defects here with two
 * different repairs and only one of them is mechanical:
 *
 *   override  the node's own `style.fontSizePt` is out of range. The Inspector
 *             accepts 4 pt while the Nature preset's floor is 5, so this is
 *             reachable in one click. Clamping honours the author's intent as
 *             far as the journal permits, and the alternative is rejection.
 *   theme     a tick label or axis title drawn at the theme's size. Raising
 *             that re-flows every gutter — `requiredMargin` sizes them from
 *             exactly these numbers — and can push a plot out of its panel. The
 *             other repair is a bigger panel. Both are the author's call, so
 *             this arm offers no fix and names the theme key instead.
 *
 * Reporting them as one finding with one button is what made the old
 * `autoFixable: true` a claim that could not be honoured.
 */
const checkTextSize: Rule = ({ scene, theme, document }) => {
  const findings: Finding[] = [];
  const small: SizedText[] = [];
  const large: SizedText[] = [];

  walkWithOwner(scene, (node, ownerId) => {
    const raw = node.attrs?.['font-size'];
    if (typeof raw !== 'number') return;
    const pt = mmToPt(raw);
    const entry: SizedText = { pt, role: node.role ?? 'text', ownerId };
    // Panel labels are legitimately larger than body text.
    const isPanelLabel = node.role === 'panel-label';
    /*
     * A superscript/subscript run — a tick label's computed exponent, or a
     * user-authored run in a text box — is not body text: it is set at
     * `superscriptSizePt`, deliberately below the journal's reading-text
     * floor, the same way a footnote mark is smaller than the sentence it
     * marks. Flagging it here would report a defect the renderer creates on
     * purpose, so it is held to `SUPERSCRIPT_MIN_PT` instead of
     * `theme.type.minimumPt`.
     */
    const isSuperscript = node.role === 'tick-label-sup' || node.role === 'text-sup' || node.role === 'text-sub';
    if (isSuperscript ? pt < SUPERSCRIPT_MIN_PT - 0.01 : pt < theme.type.minimumPt - 0.01) {
      small.push(entry);
    } else if (!isPanelLabel && !isSuperscript && pt > theme.type.maximumPt + 0.01) {
      large.push(entry);
    }
  });

  /**
   * The font size an owning node claims for `role`, if any. Generalises
   * `'style' in owner` to the one role — a volcano's point labels — whose
   * override lives on a field of its own (`PlotNode.pointLabelSizePt`) rather
   * than inside a shared `style` object, the same way `PlotNode` has no
   * `style` at all for `checkTextSize`'s other roles to read.
   */
  const ownFontSizePt = (owner: FigureDocument['nodes'][string], role: string): number | undefined => {
    if ('style' in owner) return owner.style?.fontSizePt;
    if (role === 'point-label' && owner.type === 'plot') return owner.pointLabelSizePt;
    return undefined;
  };

  /**
   * Does this element's size come from its own node, or from the theme?
   *
   * Exact rather than inferred: the owner is the document node the element was
   * rendered from, so the question is simply whether that node's own style
   * carries the offending number.
   */
  const overriddenIds = (entries: SizedText[]): string[] => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.ownerId) continue;
      const owner = document.nodes[entry.ownerId];
      if (!owner) continue;
      const own = ownFontSizePt(owner, entry.role);
      if (own !== undefined && Math.abs(own - entry.pt) < 0.01) ids.add(entry.ownerId);
    }
    return [...ids];
  };

  const themeKeys = (entries: SizedText[], overridden: Set<string>): string[] => {
    const keys = new Set<string>();
    for (const entry of entries) {
      if (entry.ownerId && overridden.has(entry.ownerId)) continue;
      keys.add(THEME_SIZE_KEYS[entry.role] ?? entry.role);
    }
    return [...keys];
  };

  if (small.length > 0) {
    const smallest = Math.min(...small.map((t) => t.pt));
    const ids = overriddenIds(small);
    const owned = new Set(ids);
    const themed = themeKeys(small, owned);
    const floor =
      `Journals reject figures with text under ${theme.type.minimumPt} pt at final ` +
      `printed size, because it is unreadable in print.`;

    if (ids.length > 0) {
      findings.push({
        id: 'text-below-minimum-override',
        severity: 'error',
        title: `${ids.length} label(s) set below ${theme.type.minimumPt} pt`,
        detail: `Smallest is ${smallest.toFixed(1)} pt. ${floor}`,
        nodeIds: ids,
        fix: {
          label: `Raise to ${theme.type.minimumPt} pt`,
          apply: clampFontSize(ids, theme.type.minimumPt),
        },
      });
    }

    if (themed.length > 0) {
      findings.push({
        id: 'text-below-minimum-theme',
        severity: 'error',
        title: `Theme text below ${theme.type.minimumPt} pt (${themed.join(', ')})`,
        detail:
          `${floor} These sizes come from the ${theme.name} preset rather than from any ` +
          'one label, so raising them re-flows every plot gutter. Enlarge the panels, or ' +
          'raise the type scale in the theme and re-check the layout.',
        nodeIds: [],
      });
    }
  }

  if (large.length > 0) {
    const ids = overriddenIds(large);
    const owned = new Set(ids);
    const themed = themeKeys(large, owned);

    if (ids.length > 0) {
      findings.push({
        id: 'text-above-maximum-override',
        severity: 'warning',
        title: `${ids.length} label(s) set above ${theme.type.maximumPt} pt`,
        detail: 'Oversized text unbalances the figure against the printed page.',
        nodeIds: ids,
        fix: {
          label: `Reduce to ${theme.type.maximumPt} pt`,
          apply: clampFontSize(ids, theme.type.maximumPt),
        },
      });
    }

    if (themed.length > 0) {
      findings.push({
        id: 'text-above-maximum-theme',
        severity: 'warning',
        title: `Theme text above ${theme.type.maximumPt} pt (${themed.join(', ')})`,
        detail:
          'Oversized text unbalances the figure against the printed page. These sizes come ' +
          `from the ${theme.name} preset, so the change belongs in the type scale.`,
        nodeIds: [],
      });
    }
  }

  return findings;
};

const checkFontConsistency: Rule = ({ scene, theme, document }) => {
  const families = new Set<string>();
  walkScene(scene, (node) => {
    const family = node.attrs?.['font-family'];
    if (typeof family === 'string') families.add(family);
  });

  if (families.size <= 1) return [];

  // Nothing in the app writes `style.fontFamily`, so the only way a figure
  // acquires a second family is by opening a file that already had one. Where
  // that is what happened, clearing the overrides is the whole repair. Where it
  // is not — a family set in `themeOverrides` — clearing them fixes nothing, so
  // no fix is offered rather than a button that appears to do nothing.
  const overridden = Object.values(document.nodes)
    .filter((node) => 'style' in node && node.style?.fontFamily !== undefined)
    .map((node) => node.id);

  return [
    {
      id: 'mixed-fonts',
      severity: 'warning',
      title: `${families.size} different font stacks in one figure`,
      detail:
        `Found: ${[...families].join(' / ')}. The ${theme.name} preset expects a single ` +
        `family throughout.` +
        (overridden.length === 0
          ? ' None of it comes from an individual label, so the odd family is in the theme itself.'
          : ''),
      nodeIds: overridden,
      ...(overridden.length > 0
        ? {
            fix: {
              label: `Use the ${theme.name} font throughout`,
              apply: dropFontOverrides(overridden),
            },
          }
        : {}),
    },
  ];
};

const checkPanelLabels: Rule = ({ document, scene }) => {
  const findings: Finding[] = [];
  const panels = Object.values(document.nodes).filter((n) => n.type === 'panel');
  if (panels.length <= 1) return findings;

  // Read from the scene rather than the document so a label on a hidden layer
  // counts as missing — which is what a reader of the exported figure sees.
  // `walkWithOwner` supplies the document node behind each one, so the
  // duplicates can be selected as well as counted.
  const labels: { text: string; ownerId?: string }[] = [];
  walkWithOwner(scene, (node, ownerId) => {
    if (node.role === 'panel-label') labels.push({ text: node.text ?? '', ownerId });
  });

  const relabel = {
    label: 'Letter panels in reading order',
    apply: relabelAllPanels(),
  };

  if (labels.length < panels.length) {
    findings.push({
      id: 'missing-panel-labels',
      severity: 'error',
      title: `${panels.length - labels.length} panel(s) have no label`,
      detail: 'Every panel in a multi-panel figure needs a letter so the legend can refer to it.',
      nodeIds: panels.map((p) => p.id),
      fix: relabel,
    });
  }

  const texts = labels.map((l) => l.text);
  const duplicates = texts.filter((t, i) => texts.indexOf(t) !== i);
  if (duplicates.length > 0) {
    const clashing = new Set(duplicates);
    findings.push({
      id: 'duplicate-panel-labels',
      severity: 'error',
      title: `Duplicate panel label(s): ${[...clashing].join(', ')}`,
      detail: 'Two panels share a letter, so the legend cannot address them unambiguously.',
      nodeIds: labels
        .filter((l) => clashing.has(l.text) && l.ownerId !== undefined)
        .map((l) => l.ownerId as string),
      fix: relabel,
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
      });
    }
  }

  return findings;
};

const checkColorAccessibility: Rule = ({ scene, document }) => {
  // Every role that carries a *series* colour. A new mark family left off this
  // list still renders, but drops silently out of the colour-vision check.
  // 'histogram-outline' belongs here for the same reason 'bar' does: it is one
  // group's data drawn in that group's own series colour, so two groups that a
  // reader cannot tell apart is exactly the defect this rule reports. Left out,
  // switching a multi-group histogram from bars to outlines would silently
  // withdraw it from the colour check.
  const MARK_ROLES = new Set([
    'bar',
    'point',
    'line',
    'box',
    'violin',
    'outlier',
    'histogram-outline',
  ]);
  const seriesColors = new Set<string>();
  /** Which plot each colour came from, so the finding can select them. */
  const plotsByColor = new Map<string, Set<string>>();

  walkWithOwner(scene, (node, ownerId) => {
    if (!node.role || !MARK_ROLES.has(node.role)) return;
    for (const value of [node.attrs?.['fill'], node.attrs?.['stroke']]) {
      if (typeof value !== 'string' || !value.startsWith('#')) continue;
      seriesColors.add(value);
      // The owner of a mark is the plot; a mark inside an unowned group is
      // ignored rather than attributed to whatever is above it.
      if (ownerId && document.nodes[ownerId]?.type === 'plot') {
        (plotsByColor.get(value) ?? plotsByColor.set(value, new Set()).get(value)!).add(ownerId);
      }
    }
  });

  const colors = [...seriesColors];
  if (colors.length < 2) return [];

  const conflicts = findColorConflicts(colors);
  if (conflicts.length === 0) return [];

  const cvdConflicts = conflicts.filter((c) => c.condition !== 'grayscale' && c.condition !== 'normal');

  const findings: Finding[] = [];

  if (cvdConflicts.length > 0) {
    const first = cvdConflicts[0]!;
    // Deliberately no fix. Remapping to a safe palette is two authorial
    // decisions at once — which of the two plots to recolour, and what the
    // colours *mean* to a reader who has already keyed red = treated, or to a
    // companion figure being matched. The Inspector's palette control states
    // that choice properly, so the useful thing to offer here is the way to it.
    findings.push({
      id: 'colour-blind-conflict',
      severity: 'warning',
      title: `${first.colorA} and ${first.colorB} are hard to tell apart under ${first.condition}`,
      detail:
        `Perceptual difference ΔE ${first.deltaE.toFixed(1)} once simulated. Around 8% of male ` +
        `readers have some colour vision deficiency; the Okabe–Ito palette avoids this. ` +
        `Change it in the Inspector's Palette control.`,
      nodeIds: [
        ...new Set([
          ...(plotsByColor.get(first.colorA) ?? []),
          ...(plotsByColor.get(first.colorB) ?? []),
        ]),
      ],
    });
  }

  const grayConflicts = conflicts.filter((c) => c.condition === 'grayscale');
  if (grayConflicts.length > 0) {
    // The worst *greyscale* pair, not `conflicts[0]` — that is the closest pair
    // under any simulation, which need not be the one that merges in print, and
    // the finding names a specific ΔE "in greyscale".
    const gray = grayConflicts[0]!;
    findings.push({
      id: 'grayscale-conflict',
      severity: 'info',
      title: `${gray.colorA} and ${gray.colorB} merge when printed in greyscale`,
      detail:
        `ΔE ${gray.deltaE.toFixed(1)} in greyscale. Consider differing marker shapes or fill ` +
        `patterns as a redundant channel.`,
      nodeIds: [
        ...new Set([
          ...(plotsByColor.get(gray.colorA) ?? []),
          ...(plotsByColor.get(gray.colorB) ?? []),
        ]),
      ],
    });
  }

  return findings;
};

const checkPageDimensions: Rule = ({ document }) => {
  const preset = document.page.presetId ? findPreset(document.page.presetId) : undefined;
  if (!preset) return [];

  const findings: Finding[] = [];

  if (Math.abs(document.page.widthMm - preset.widthMm) > 0.5) {
    // Setting the width is only a *fix* when nothing has to move to accommodate
    // it. Narrowing a page whose panels overhang pushes them off it, and the
    // repair for that is a re-layout that discards the arrangement the author
    // built — so where the change is not pure, the finding says what to do
    // rather than offering a button that rearranges the figure.
    const rightmost = Math.max(
      0,
      ...Object.values(document.nodes)
        .filter((n) => n.parentId === null)
        .map((n) => absoluteFrame(document.nodes, n.id))
        .filter((f): f is NonNullable<typeof f> => f !== null)
        .map((f) => f.x + f.width),
    );
    const fits = rightmost <= preset.widthMm + 0.01;

    findings.push({
      id: 'page-width-mismatch',
      severity: 'warning',
      title: `Width is ${document.page.widthMm.toFixed(1)} mm, not the ${preset.label} ${preset.widthMm} mm`,
      detail:
        'The figure will be rescaled at typesetting, shrinking every font with it.' +
        (fits
          ? ''
          : ` The content reaches ${rightmost.toFixed(1)} mm, so setting the width alone would ` +
            'push it off the page: set the width, then re-run Auto Layout.'),
      nodeIds: [],
      ...(fits
        ? { fix: { label: `Set width to ${preset.widthMm} mm`, apply: matchPresetWidth(preset.widthMm) } }
        : {}),
    });
  }

  if (document.page.heightMm > preset.maxHeightMm) {
    findings.push({
      id: 'page-too-tall',
      severity: 'error',
      title: `Height ${document.page.heightMm.toFixed(1)} mm exceeds the ${preset.maxHeightMm} mm limit`,
      detail: `${preset.journal} needs the figure and its legend to fit one page.`,
      nodeIds: [],
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
        fix: {
          // The label is the disclosure. Auto Layout resizes every panel and
          // everything in it, so a deliberately asymmetric arrangement does not
          // survive — that is worth saying on the button rather than in a
          // dialog the author reads after the fact. Undo is one keystroke.
          label: 'Re-run Auto Layout (rearranges every panel)',
          apply: equaliseGutters(),
          rearranges: true,
        },
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

    // A per-series correlation hashed only its own series (`spec.seriesName`);
    // rehash that same slice so a sibling column's edit does not falsely mark
    // it stale.
    const allSeries = toSeries(dataset);
    const series =
      analysis.spec.seriesName !== undefined
        ? allSeries.filter((s) => s.name === analysis.spec.seriesName)
        : allSeries;
    const current = analysisInputHash(
      { test: analysis.test, correction: analysis.options.correction },
      series.map((s) => s.values),
      xForHash(series),
      eventsForHash(analysis.test, dataset),
    );
    if (!isStale(analysis, current)) continue;

    const brackets = Object.values(document.nodes).filter(
      (n) => n.type === 'bracket' && n.analysisId === analysis.id,
    );
    /*
     * The plot as well as its brackets. A correlation never gets a bracket — a
     * numeric x axis has no categories to span — so this finding used to carry
     * an empty `nodeIds` and its "Select N affected" button selected nothing at
     * all. It matters more now that a correlation draws a fitted line: the plot
     * IS the thing showing the stale result, and it has to be reachable from
     * the finding that says so.
     */
    const plotId = analysis.plotId ?? null;
    const affectsPlot = plotId !== null && document.nodes[plotId] !== undefined;

    findings.push({
      id: `stale-analysis-${analysis.id}`,
      severity: 'error',
      title: `"${analysis.name}" no longer matches its data`,
      detail:
        'The values feeding this test have changed since it was run, so the ' +
        'annotated p-values may not reflect what is plotted. Re-run the test.',
      nodeIds: [...brackets.map((b) => b.id), ...(affectsPlot ? [plotId] : [])],
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

// Deliberately not widened to `histogram`/`ecdf` (round 50). Both draw a
// distribution too, but neither manufactures a shape the data cannot
// support the way a violin's kernel density or a box's quartiles do: a
// histogram of n = 4 draws four bars at their own true counts, and an ECDF
// of n = 4 draws four true steps. Small-n here is a legibility problem —
// few bars, a blocky staircase — not a false-confidence one, so it earns no
// finding.
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
    });
  }

  return findings;
};

/**
 * A plot whose point count crossed `MAX_VECTOR_POINTS` renders as one raster
 * image rather than individually editable marks — see `planPointClouds`.
 *
 * Disclosure, not a defect: every value is still drawn, none dropped or
 * sampled, so this is `severity: 'info'`, same stance as
 * `checkDistributionSampleSize` — surfaced for the author to see, never
 * blocking and never costing score (`checkFigure` gives an info-only
 * category full credit).
 */
const checkPointCloudRasterization: Rule = ({ document, theme }) => {
  return planPointClouds(document, theme).map(
    (plan): Finding => ({
      id: `point-cloud-raster-${plan.nodeId}`,
      severity: 'info',
      title: `${plan.count.toLocaleString()} points rendered as a raster image`,
      detail:
        `Above ${MAX_VECTOR_POINTS.toLocaleString()} points, every value is still drawn — ` +
        'none are dropped or sampled — but as one embedded image rather than individually ' +
        'editable marks, to keep the figure responsive to edit and reasonable to export.',
      nodeIds: [plan.nodeId],
    }),
  );
};

/**
 * A labelled-point plot's rows dropped for a missing/non-numeric label or
 * either coordinate — a volcano's fold change and p-value, a fold-vs-fold
 * plot's two fold changes.
 *
 * Disclosure, not a defect — the same stance as `checkPointCloudRasterization`
 * and `checkDistributionSampleSize`: nothing is silently miscounted, the
 * author just could not otherwise tell that some rows in the table never made
 * it onto the plot. `severity: 'info'`, never costing score.
 */
const checkVolcanoDroppedPoints: Rule = ({ document }) => {
  const findings: Finding[] = [];

  for (const node of Object.values(document.nodes)) {
    if (node.type !== 'plot' || !LABELLED_POINT_PLOT_TYPES.has(node.plotType)) continue;
    const dataset = findDataset(document, node.datasetId);
    if (!dataset) continue;

    const drawn = toSeries(dataset)[0]?.values.length ?? 0;
    const dropped = dataset.rows.length - drawn;
    if (dropped <= 0) continue;

    findings.push({
      id: `points-dropped-${node.id}`,
      severity: 'info',
      title: `${dropped.toLocaleString()} row${dropped === 1 ? '' : 's'} not plotted`,
      detail:
        `${dropped.toLocaleString()} of ${dataset.rows.length.toLocaleString()} rows had a ` +
        'missing or non-numeric label or coordinate and were left off the plot ' +
        'rather than placed at a position they were never measured at.',
      nodeIds: [node.id],
    });
  }

  return findings;
};

/**
 * A selected point label that did not make it onto the plot — the row no
 * longer has a valid label/fold change/p-value, the plot was too dense to fit
 * it even pushed out, or the plot's own label limit was reached.
 *
 * Disclosure, not a defect — the same stance as `checkPointCloudRasterization`:
 * every value is still drawn, only the *name* beside it is missing, and the
 * author could not otherwise tell. Read from the rendered scene rather than
 * recomputing `layoutPointLabels`, so this can never disagree with what was
 * actually drawn — the same reasoning `checkPanelLabels` already documents
 * for reading panel labels off the scene instead of the document.
 */
const checkPointLabelPlacement: Rule = ({ document, scene }) => {
  const drawnByOwner = new Map<string, number>();
  walkWithOwner(scene, (node, ownerId) => {
    if (node.role !== 'point-label' || !ownerId) return;
    drawnByOwner.set(ownerId, (drawnByOwner.get(ownerId) ?? 0) + 1);
  });

  const findings: Finding[] = [];
  for (const node of Object.values(document.nodes)) {
    if (node.type !== 'plot' || !LABELLED_POINT_PLOT_TYPES.has(node.plotType)) continue;
    const requested = node.volcanoLabels?.length ?? 0;
    if (requested === 0) continue;

    const drawn = drawnByOwner.get(node.id) ?? 0;
    if (drawn >= requested) continue;

    const missing = requested - drawn;
    findings.push({
      id: `point-label-missing-${node.id}`,
      severity: 'info',
      title: `${missing} of ${requested} point label${requested === 1 ? '' : 's'} not shown`,
      detail:
        `${missing} selected label${missing === 1 ? '' : 's'} ${missing === 1 ? 'is' : 'are'} not ` +
        'drawn — the row may no longer have a valid label, fold change or p-value, the plot may ' +
        `be too dense to fit it even pushed out, or this plot's ${pointLabelLimit(node)}-label ` +
        'maximum was reached. Every value is still drawn; only the name beside it is missing.',
      nodeIds: [node.id],
    });
  }
  return findings;
};

/**
 * A selected label that names more than one point.
 *
 * Not a defect: a differential table can legitimately repeat a feature name
 * (two probes for one gene), and `renderPointLabels` labels every match on
 * purpose — labelling only one would draw a name beside a point a reader
 * cannot tell apart from the unlabelled duplicate. Disclosed so the author
 * knows why a name appears to sit beside more than one marker.
 */
const checkDuplicatePointLabels: Rule = ({ document }) => {
  const findings: Finding[] = [];

  for (const node of Object.values(document.nodes)) {
    if (node.type !== 'plot' || !LABELLED_POINT_PLOT_TYPES.has(node.plotType)) continue;
    const wanted = node.volcanoLabels;
    if (!wanted || wanted.length === 0) continue;
    const dataset = findDataset(document, node.datasetId);
    if (!dataset) continue;

    const wantedSet = new Set(wanted);
    const pointLabels = toSeries(dataset)[0]?.pointLabels;
    if (!pointLabels) continue;

    const counts = new Map<string, number>();
    for (const label of pointLabels) {
      if (!wantedSet.has(label)) continue;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
    if (duplicated.length === 0) continue;

    findings.push({
      id: `point-label-duplicate-${node.id}`,
      severity: 'info',
      title: `${duplicated.length} selected label${duplicated.length === 1 ? '' : 's'} name more than one point`,
      detail:
        `${duplicated.map(([label, n]) => `"${label}" (${n})`).join(', ')} match more than one row ` +
        '— every matching point is labelled, since labelling only one would draw a name beside a ' +
        'point indistinguishable from the unlabelled duplicate.',
      nodeIds: [node.id],
    });
  }
  return findings;
};

/**
 * A cascaded line plot spends its y axis on separation, not just value — a
 * legitimate, common presentation (sedimentation runs, spectra), but one a
 * reader can misjudge if they assume every trace shares the axis the way an
 * ordinary overlay would. Disclosure, not a defect, the same stance as
 * `checkPointCloudRasterization`: nothing is hidden or distorted, only
 * repositioned by a fixed amount stated here.
 */
const checkCascadeOffset: Rule = ({ document }) => {
  const findings: Finding[] = [];

  for (const node of Object.values(document.nodes)) {
    if (node.type !== 'plot') continue;
    const dataset = findDataset(document, node.datasetId);
    if (!dataset) continue;
    const seriesCount = toSeries(dataset).length;
    if (!hasCascadeOffset(node, seriesCount)) continue;

    const first = toSeries(dataset)[0]?.name ?? 'the first series';
    findings.push({
      id: `cascade-offset-${node.id}`,
      severity: 'info',
      title: `${seriesCount} traces are offset for display`,
      detail:
        `Each series is shifted ${node.offsetStepMm ?? 0} mm from the next for readability — the ` +
        `y axis reads only for "${first}"; every other trace's true position is displaced by its ` +
        'own offset, which a legend or label should make clear rather than the axis alone.',
      nodeIds: [node.id],
    });
  }
  return findings;
};

/**
 * A heatmap's colour scale is hard to read once its two (or three, for a
 * diverging scale) extremes fall too close together under a colour-vision
 * simulation.
 *
 * Deliberately not an extension of `checkColorAccessibility`: that rule does
 * an O(n²) pairwise comparison meant for a handful of *discrete* series
 * colours, and hundreds of adjacent ramp strips are *supposed* to be close —
 * pairwise-comparing all of them would be both semantically wrong and a
 * performance problem. This samples only the ramp's own endpoints, read
 * straight off the rendered colourbar so it can never disagree with what was
 * actually drawn.
 */
const checkHeatmapColorContrast: Rule = ({ scene }) => {
  const stripsByOwner = new Map<string, string[]>();
  walkWithOwner(scene, (node, ownerId) => {
    if (node.role !== 'colorbar' || !ownerId) return;
    const fill = node.attrs?.['fill'];
    if (typeof fill !== 'string' || !fill.startsWith('#')) return;
    const strips = stripsByOwner.get(ownerId) ?? [];
    strips.push(fill);
    stripsByOwner.set(ownerId, strips);
  });

  const findings: Finding[] = [];
  const conditions: CvdType[] = ['deuteranopia', 'protanopia', 'tritanopia'];

  for (const [nodeId, strips] of stripsByOwner) {
    // The two ends of the ramp. Which strip is the minimum depends on the
    // colourbar's placement (a right-hand bar is drawn low-at-the-bottom, so
    // reversed), so these are named as "the two ends", not low/high.
    const endA = strips[0];
    const endB = strips[strips.length - 1];
    if (!endA || !endB || endA === endB) continue;

    const worst = conditions
      .map((condition) => ({
        condition,
        deltaE: deltaE2000(simulateCvd(endA, condition), simulateCvd(endB, condition)),
      }))
      .sort((a, b) => a.deltaE - b.deltaE)[0]!;
    if (worst.deltaE >= MIN_SERIES_DELTA_E) continue;

    findings.push({
      id: `heatmap-cvd-${nodeId}`,
      severity: 'info',
      title: `Colour scale is hard to read under ${worst.condition}`,
      detail:
        `The scale's two ends (${endA} and ${endB}) are close together for a reader with ` +
        `${worst.condition} (ΔE ${worst.deltaE.toFixed(1)} once simulated). A perceptually distinct ` +
        `sequential or diverging ramp would keep the extremes tellable apart.`,
      nodeIds: [nodeId],
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
  { category: 'Point cloud rendering', rule: checkPointCloudRasterization },
  { category: 'Volcano plot coverage', rule: checkVolcanoDroppedPoints },
  { category: 'Point label placement', rule: checkPointLabelPlacement },
  { category: 'Point label duplicates', rule: checkDuplicatePointLabels },
  { category: 'Heatmap colour contrast', rule: checkHeatmapColorContrast },
  { category: 'Cascade offset', rule: checkCascadeOffset },
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
