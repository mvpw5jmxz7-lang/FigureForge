/**
 * Properties of the current selection.
 *
 * Everything the figure model can express was previously unreachable once a
 * node existed — colours, text, axis titles and sizes were all fixed at import
 * and editable only by hand-editing a saved archive. This is the surface that
 * makes them editable, so it deliberately covers every node type rather than
 * just plots.
 */

import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  CONTINUOUS_X_PLOT_TYPES,
  DISTRIBUTION_Y_TITLES,
  LINE_STYLED_PLOT_TYPES,
  TREND_LINE_PLOT_TYPES,
  DEFAULT_FOLD_FOLD_THRESHOLDS,
  DEFAULT_VOLCANO_THRESHOLDS,
  GROUP_LABEL_GAP_MM,
  GROUP_LABEL_GAP_NO_RULE_MM,
  GRIDLINE_STYLES,
  LINE_STYLES,
  POINT_SHAPES,
  addAsset,
  addGroupLabel,
  childrenOf,
  distributionYTitle,
  effectiveDpi,
  fillPanelChildren,
  fitMontageToImages,
  findAsset,
  findDataset,
  formatMm,
  groupNodesByPanel,
  hasReplicatesAtX,
  isRangeFormatted,
  isTwoFactor,
  normaliseArrowFrame,
  panelTitle,
  plainTextOfRuns,
  reconcileTextEdit,
  groupLabelMembersAreImages,
  reflowGroupLabels,
  resizePanel,
  montageTiles,
  reserveLayoutSpace,
  resyncScaleBars,
  scaleBarWidthMm,
  setImageCrop,
  setMontageCellImage,
  setScaleBarCalibration,
  toggleRunFormat,
  toSeries,
  ungroup,
  updateNode,
  type CalibrationSource,
  type Dataset,
  type FigureDocument,
  type AxisSpec,
  type FigureNode,
  type GridlineStyle,
  type HeatmapScaleMode,
  type LabelFormat,
  type LineStyle,
  type NodeId,
  type PlotNode,
  type PlotType,
  type PointShape,
  type TextRun,
  type TextStyle,
  type FoldFoldCategory,
  type VolcanoCategory,
} from '@figureforge/doc-model';
import {
  DEFAULT_HEATMAP_MISSING_COLOR,
  DEFAULT_HEATMAP_STOPS,
  DEFAULT_FOLD_FOLD_COLORS,
  DEFAULT_VOLCANO_COLORS,
  MAX_POINT_LABELS,
  MAX_POINT_LABEL_CEILING,
  placedPointLabelsForPlot,
  pointLabelLimit,
  computePlotGeometry,
  hasCascadeOffset,
  isCascadable,
  offsetReserveMm,
  reflowBrackets,
} from '@figureforge/render';
import { isRotatable } from './Canvas.js';
import { ColorChip } from './ColorChip.js';
import { SymbolPicker } from './SymbolPicker.js';
import { DEFAULT_BAR_GAP_FRACTION, DEFAULT_GROUP_GAP_FRACTION } from '@figureforge/plots';
import { PALETTES, findColorConflicts, paletteColors, resolveTheme, type ColorConflict, type Theme } from '@figureforge/theme';

/**
 * The colour-conflict warning shown wherever a plot's own resolved colours
 * are checked pairwise (the volcano-colours block and the per-series palette
 * block) — one implementation so the two can't drift, and so each hex code
 * gets the same `ColorChip` the Quality tab's matching finding already draws.
 */
function ColorConflictWarning({ conflict }: { conflict: ColorConflict }) {
  return (
    <p className="warning">
      {conflict.colorA}
      <ColorChip hex={conflict.colorA} /> and {conflict.colorB}
      <ColorChip hex={conflict.colorB} /> are hard to tell apart under {conflict.condition} (ΔE{' '}
      {conflict.deltaE.toFixed(1)}).
    </p>
  );
}
import { deleteNodesWithLayout } from '../deleteNodes.js';
import { ACCEPTED_IMAGE_TYPES, importImage } from '../imageImport.js';
import { insertAtCaret } from '../textEditing.js';
import type { AssetsApi } from '../assets.js';
import type { DocumentApi } from '../useDocument.js';

/** Every plot type. All ten render distinctly since round 7. */
const OFFERED_PLOT_TYPES: { id: PlotType; label: string }[] = [
  { id: 'bar', label: 'Bar' },
  { id: 'dot', label: 'Dot' },
  { id: 'bar-dot', label: 'Bar + points' },
  { id: 'beeswarm', label: 'Beeswarm' },
  { id: 'box', label: 'Box' },
  { id: 'violin', label: 'Violin' },
  { id: 'scatter', label: 'Scatter' },
  { id: 'line', label: 'Line' },
  { id: 'histogram', label: 'Histogram' },
  { id: 'ecdf', label: 'Cumulative distribution (ECDF)' },
  { id: 'volcano', label: 'Volcano' },
  { id: 'fold-fold', label: 'Fold change vs fold change' },
  { id: 'heatmap', label: 'Heatmap' },
  { id: 'survival', label: 'Survival (Kaplan–Meier)' },
];

/**
 * Which types this particular dataset can actually support.
 *
 * Scatter and line need paired x values, which `toSeries` supplies only for the
 * xy-shaped formats; a histogram or an ECDF needs either a single distribution
 * or a table that declares its columns to be several (see below); a volcano plot
 * needs a per-point identity, which only the `differential` format supplies —
 * gated on that data shape rather than on the format's name, the same way
 * scatter/line gate on "does `.x` exist" rather than on a format list. A
 * heatmap has no equivalent per-`Series` signal to key off — a dense matrix
 * bypasses `Series` entirely — so it is gated on the dataset's format
 * directly, and survival is gated the same way for the same reason: a
 * subject-level table bypasses `Series` too, reading through
 * `toSurvivalGroups` instead. Offering a type the data cannot support is how
 * the unimplemented plot types shipped plausible-looking wrong output — so
 * they are withheld rather than approximated.
 */
function typesFor(
  series: readonly { values: number[]; x?: number[]; pointLabels?: readonly string[] }[],
  hasMatrix: boolean,
  hasSurvival: boolean,
  hasFoldFold: boolean,
  hasDistribution: boolean,
): typeof OFFERED_PLOT_TYPES {
  const hasX = series.length > 0 && series.every((s) => s.x !== undefined && s.x.length > 0);
  const single = series.length === 1;
  const hasLabels = single && (series[0]?.pointLabels?.length ?? 0) > 0;

  return OFFERED_PLOT_TYPES.filter((t) => {
    if (t.id === 'scatter' || t.id === 'line') return hasX;
    /*
     * Several groups now draw over one *shared* binning rather than being
     * pooled into a single array, so more than one series is no longer a
     * reason to withhold these — pooling was, and still would be, an invented
     * shape belonging to no group.
     *
     * Widened on the dataset's declared format rather than on series count, so
     * every existing table's dropdown is byte-identical to before. That is not
     * timidity: a `replicate` row is three measurements of one thing, and a
     * three-bar histogram of it reads as a distribution the design never
     * sampled. Declaring the `distribution` layout is precisely the statement
     * that each column *is* a sample, which is the claim these two types draw.
     */
    if (t.id === 'histogram' || t.id === 'ecdf') return single || hasDistribution;
    /*
     * A fold-fold table satisfies `hasLabels` exactly as a differential one
     * does — same three columns, same label in column 0 — so volcano has to
     * be withheld from it explicitly. Drawing one would take -log10 of a
     * log2 fold change: NaN for every down-regulated protein, which drops
     * half the data and draws the rest confidently. The standing "a plot
     * type the data cannot support is withheld, never approximated" rule.
     */
    if (t.id === 'volcano') return hasLabels && !hasFoldFold;
    if (t.id === 'fold-fold') return hasFoldFold;
    if (t.id === 'heatmap') return hasMatrix;
    if (t.id === 'survival') return hasSurvival;
    return true;
  });
}

/**
 * Marks that draw the whole distribution, so a centre and error bar say nothing
 * extra.
 *
 * Named for the *mark* rather than "distribution types" so it cannot be read as
 * `DISTRIBUTION_PLOT_TYPES`, which is a different set answering a different
 * question — histogram and ECDF, the types that read the `histogram*` fields.
 * A box and a violin are the categorical readings of the same columns and are
 * deliberately not in that set.
 */
const WHOLE_DISTRIBUTION_MARKS: ReadonlySet<PlotType> = new Set<PlotType>(['box', 'violin']);

const VOLCANO_CATEGORY_LABELS: Record<VolcanoCategory, string> = {
  down: 'Down',
  ns: 'Not significant',
  up: 'Up',
};

/**
 * Cutoffs, threshold-line toggle and per-category colours for a volcano plot —
 * in place of the ordinary per-series Colours block, which does not apply
 * here: category colour wins over the series fallback for every valid point,
 * so palette swatches and "points use series colour" would visibly do
 * nothing.
 */
function VolcanoColorControls({
  node,
  doc,
  dataset,
  theme,
  setPlot,
  picking,
  onLabelPickNodeChange,
}: {
  node: PlotNode;
  doc: FigureDocument;
  dataset: Dataset | undefined;
  theme: Theme;
  setPlot: (label: string, patch: Partial<PlotNode>) => void;
  picking: boolean;
  onLabelPickNodeChange: (id: NodeId | null) => void;
}) {
  const thresholds = node.volcanoThresholds ?? DEFAULT_VOLCANO_THRESHOLDS;
  const colors = { ...DEFAULT_VOLCANO_COLORS, ...node.volcanoColors };
  const conflicts = findColorConflicts(Object.values(colors));
  // A 4th column is an FDR/q-value per point — offering the FDR control on a
  // 3-column table would be a control that visibly does nothing, since
  // `volcanoCategory` only reads it once a q-value actually exists.
  const hasFdrColumn = (dataset?.columns.length ?? 0) >= 4;
  const significanceBy = thresholds.significanceBy ?? 'p-value';
  /*
   * A drawn permutation boundary decides significance on its own, so the
   * fixed cutoffs below are not merely unused — offering them would invite an
   * author to set a fold-change gate the boundary does not have and quietly
   * disagree with their own test. Hidden rather than shown-and-ignored, the
   * same rule the rest of this Inspector follows.
   */
  const cutoffsApply = !node.volcanoSamCurve;

  return (
    <>
      <h4>Thresholds</h4>
      {cutoffsApply && (
        <label className="field">
          |log2 fold change| ≥
          <input
            type="number"
            min={0}
            step={0.1}
            value={thresholds.foldChange}
            onChange={(e) => {
              const foldChange = Number(e.target.value);
              if (Number.isFinite(foldChange) && foldChange >= 0) {
                setPlot('Change fold-change cutoff', {
                  volcanoThresholds: { ...thresholds, foldChange },
                });
              }
            }}
          />
        </label>
      )}
      {cutoffsApply && hasFdrColumn && (
        <label className="field">
          Classify significance by
          <select
            value={significanceBy}
            onChange={(e) =>
              setPlot('Change significance basis', {
                volcanoThresholds: {
                  ...thresholds,
                  significanceBy: e.target.value as 'p-value' | 'fdr',
                },
              })
            }
          >
            <option value="p-value">p-value</option>
            <option value="fdr">FDR (q-value)</option>
          </select>
        </label>
      )}
      {!cutoffsApply ? null : significanceBy === 'fdr' ? (
        <label className="field">
          FDR ≤
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={thresholds.fdr ?? ''}
            onChange={(e) => {
              const fdr = Number(e.target.value);
              if (Number.isFinite(fdr) && fdr > 0 && fdr <= 1) {
                setPlot('Change FDR cutoff', { volcanoThresholds: { ...thresholds, fdr } });
              }
            }}
          />
        </label>
      ) : (
        <label className="field">
          p-value ≤
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={thresholds.pValue}
            onChange={(e) => {
              const pValue = Number(e.target.value);
              if (Number.isFinite(pValue) && pValue > 0 && pValue <= 1) {
                setPlot('Change p-value cutoff', { volcanoThresholds: { ...thresholds, pValue } });
              }
            }}
          />
        </label>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={node.volcanoPValueIsNegLog10 ?? false}
          onChange={(e) =>
            setPlot('Change p-value representation', {
              volcanoPValueIsNegLog10: e.target.checked,
            })
          }
        />
        P-values are already −log10 transformed
      </label>
      {node.volcanoSamCurve ? (
        <>
          <p className="hint">
            Significance is the dashed permutation boundary itself — a point is called up or
            down exactly when it sits above the curve
            {thresholds.fdr !== undefined
              ? `, which the test resolved at ${(thresholds.fdr * 100).toFixed(1)}% FDR`
              : ''}
            . That is why there are no fold-change or p-value cutoffs here: the boundary
            already carries both, and a separate fold-change gate would disagree with your own
            test. Re-run the volcano test on the source data to change it.
          </p>
          {/* Answered where it is seen, not only in the methods text: the two
              branches sitting at different distances from zero is the first
              thing a reader notices at a larger S0. */}
          {node.volcanoTest && (
            <p className="hint">
              The two branches need not mirror each other, and here they sit at d ≥{' '}
              {node.volcanoTest.cutUp.toFixed(3)} and d ≤ {node.volcanoTest.cutLow.toFixed(3)}.
              SAM resolves each tail against its own side of the permutation null, so the
              cutoffs are independent and match only when the data itself is symmetric. Each
              branch's asymptote sits at cut × S0, so raising S0 magnifies the difference
              without changing it. The full statement is in the Stats tab's methods sentence.
            </p>
          )}
        </>
      ) : (
        <label className="check">
          <input
            type="checkbox"
            checked={node.volcanoThresholdLines !== 'hide'}
            onChange={(e) =>
              setPlot('Change threshold lines', {
                volcanoThresholdLines: e.target.checked ? 'show' : 'hide',
              })
            }
          />
          Show threshold lines
        </label>
      )}
      {!node.volcanoSamCurve && (
        <p className="hint">
          For Perseus's own S0/FDR permutation boundary — not just a q-value column — paste your
          raw replicate matrix and use "Run volcano test (Perseus-style) →" in the Data tab.
        </p>
      )}

      <h4>Colours</h4>
      <div className="swatches">
        {(Object.keys(colors) as VolcanoCategory[]).map((category) => (
          <label className="swatch" key={category} title={VOLCANO_CATEGORY_LABELS[category]}>
            <input
              type="color"
              value={colors[category]}
              onChange={(e) =>
                setPlot('Change volcano colour', {
                  volcanoColors: { ...colors, [category]: e.target.value },
                })
              }
            />
            <span>{VOLCANO_CATEGORY_LABELS[category]}</span>
          </label>
        ))}
      </div>
      {conflicts.length > 0 && <ColorConflictWarning conflict={conflicts[0]!} />}

      <PointLabelControls
        node={node}
        doc={doc}
        theme={theme}
        setPlot={setPlot}
        picking={picking}
        onLabelPickNodeChange={onLabelPickNodeChange}
      />
    </>
  );
}

const FOLD_FOLD_CATEGORY_LABELS: Record<FoldFoldCategory, string> = {
  ns: 'Not significant',
  sig: 'Significant',
  'up-up': 'Up in both',
  'down-down': 'Down in both',
  'up-down': 'Up in x, down in y',
  'down-up': 'Down in x, up in y',
};

/** Only the categories the current mode can actually produce get a swatch —
 *  a colour control for a class nothing is ever classified into is the
 *  standing "a control that visibly does nothing" defect. */
const FOLD_FOLD_SWATCHES: Record<'significant' | 'quadrant', readonly FoldFoldCategory[]> = {
  significant: ['sig', 'ns'],
  quadrant: ['up-up', 'down-down', 'up-down', 'down-up', 'ns'],
};

/**
 * Cutoffs, reference lines and per-category colours for a fold-vs-fold plot —
 * in place of the ordinary per-series Colours block, for the same reason the
 * volcano block replaces it: category colour wins over the series fallback for
 * every valid point, so palette swatches would visibly do nothing.
 */
function FoldFoldControls({
  node,
  doc,
  theme,
  setPlot,
  picking,
  onLabelPickNodeChange,
}: {
  node: PlotNode;
  doc: FigureDocument;
  theme: Theme;
  setPlot: (label: string, patch: Partial<PlotNode>) => void;
  picking: boolean;
  onLabelPickNodeChange: (id: NodeId | null) => void;
}) {
  const thresholds = node.foldFoldThresholds ?? DEFAULT_FOLD_FOLD_THRESHOLDS;
  const colorBy = node.foldFoldColorBy ?? 'significant';
  const colors = { ...DEFAULT_FOLD_FOLD_COLORS, ...node.foldFoldColors };
  const shown = FOLD_FOLD_SWATCHES[colorBy];
  // Only the colours actually on the page can conflict with each other; the
  // hidden ones are not drawn, so warning about them would report a clash a
  // reader will never see.
  const conflicts = findColorConflicts(shown.map((category) => colors[category]));

  const setCutoff = (axis: 'x' | 'y', raw: string): void => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    setPlot('Change fold-change cutoff', {
      foldFoldThresholds: { ...thresholds, [axis]: value },
    });
  };

  return (
    <>
      <h4>Thresholds</h4>
      <label className="field">
        |log2 fold change| ≥ (x)
        <input
          type="number"
          min={0}
          step={0.1}
          value={thresholds.x}
          onChange={(e) => setCutoff('x', e.target.value)}
        />
      </label>
      <label className="field">
        |log2 fold change| ≥ (y)
        <input
          type="number"
          min={0}
          step={0.1}
          value={thresholds.y}
          onChange={(e) => setCutoff('y', e.target.value)}
        />
      </label>
      <label className="field">
        Colour by
        <select
          value={colorBy}
          onChange={(e) =>
            setPlot('Change fold-fold colouring', {
              foldFoldColorBy: e.target.value as 'significant' | 'quadrant',
            })
          }
        >
          <option value="significant">Significant or not</option>
          <option value="quadrant">Quadrant</option>
        </select>
      </label>
      {/* Hidden in quadrant mode rather than disabled: a quadrant needs a
          direction on both axes, so "either" has no meaning there and the
          classifier does not read it. */}
      {colorBy === 'significant' ? (
        <label className="field">
          Significant when the cutoff is met on
          <select
            value={thresholds.rule ?? 'both'}
            onChange={(e) =>
              setPlot('Change significance rule', {
                foldFoldThresholds: { ...thresholds, rule: e.target.value as 'both' | 'either' },
              })
            }
          >
            <option value="both">both axes</option>
            <option value="either">either axis</option>
          </select>
        </label>
      ) : (
        <p className="hint">
          A quadrant needs a direction on both axes, so quadrant colouring always requires both
          cutoffs to be met. A point clearing one cutoff but not the other stays grey.
        </p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={(node.foldFoldZeroLines ?? 'show') === 'show'}
          onChange={(e) =>
            setPlot('Change zero lines', { foldFoldZeroLines: e.target.checked ? 'show' : 'hide' })
          }
        />
        Show lines through zero
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={(node.foldFoldCutoffLines ?? 'hide') === 'show'}
          onChange={(e) =>
            setPlot('Change cutoff lines', {
              foldFoldCutoffLines: e.target.checked ? 'show' : 'hide',
            })
          }
        />
        Show cutoff lines
      </label>
      <p className="hint">
        A line is drawn only where the axis actually reaches it, so a cutoff wider than your data
        draws nothing rather than a line beside the panel.
      </p>

      <h4>Colours</h4>
      <div className="swatches">
        {shown.map((category) => (
          <label className="swatch" key={category} title={FOLD_FOLD_CATEGORY_LABELS[category]}>
            <input
              type="color"
              value={colors[category]}
              onChange={(e) =>
                setPlot('Change fold-fold colour', {
                  foldFoldColors: { ...colors, [category]: e.target.value },
                })
              }
            />
            <span>{FOLD_FOLD_CATEGORY_LABELS[category]}</span>
          </label>
        ))}
      </div>
      {conflicts.length > 0 && <ColorConflictWarning conflict={conflicts[0]!} />}

      <TrendLineControls node={node} doc={doc} setPlot={setPlot} />

      <PointLabelControls
        node={node}
        doc={doc}
        theme={theme}
        setPlot={setPlot}
        picking={picking}
        onLabelPickNodeChange={onLabelPickNodeChange}
      />
    </>
  );
}

/**
 * The fitted line from this plot's own correlation or regression analysis.
 *
 * Rendered nothing at all until such an analysis exists: the line is drawn from
 * a stored result, so before a test has been run every control here would move
 * a field the renderer ignores — the standing "a control that visibly does
 * nothing is a defect" rule, and the reason the heading lives inside the same
 * condition rather than standing over an explanation of its own absence.
 *
 * Shared by the scatter and fold-vs-fold blocks, the same one-component-two-
 * callers shape `PointLabelControls` has, so the two surfaces cannot drift.
 */
function TrendLineControls({
  node,
  doc,
  setPlot,
}: {
  node: PlotNode;
  doc: FigureDocument;
  setPlot: (label: string, patch: Partial<PlotNode>) => void;
}) {
  if (!TREND_LINE_PLOT_TYPES.has(node.plotType)) return null;

  // At most one analysis per plot — `replaceAnalysisForPlot` guarantees it —
  // so this is a lookup, not a choice between several.
  const analysis = doc.analyses.find((a) => (a.plotId ?? null) === node.id);
  if (!analysis?.result) return null;

  const fit = analysis.result.fit ?? null;
  if (!fit) {
    /*
     * Spearman is the one case worth explaining: it is offered on these plot
     * types, an author will run it expecting a line, and the absence is a
     * deliberate refusal rather than a gap. Any other fit-less analysis here
     * would have to be a leftover from a plot-type change, where a silent
     * nothing is the right answer.
     */
    if (analysis.test !== 'spearman') return null;
    return (
      <>
        <h4>Fitted line</h4>
        <p className="hint">
          Spearman measures how consistently the ranks move together, not how closely the points
          sit on a straight line, so no line is drawn for it. Run Pearson or linear regression for
          a fitted line.
        </p>
      </>
    );
  }

  const broken = (node.x.breaks?.length ?? 0) > 0 || (node.y.breaks?.length ?? 0) > 0;
  const interval = node.trendInterval ?? 'none';
  const level = `${(fit.confidenceLevel * 100).toFixed(0)}%`;
  const shown = (node.trendLine ?? 'show') === 'show';

  return (
    <>
      <h4>Fitted line</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={shown}
          onChange={(e) => setPlot('Toggle fitted line', { trendLine: e.target.checked ? 'show' : 'hide' })}
        />
        Show the fitted line
      </label>
      {broken ? (
        <p className="hint">
          This plot&rsquo;s axis has a break, so no line is drawn. A break says a range is not
          shown; a line running straight across the gap would claim a continuity the axis has
          already ruled out.
        </p>
      ) : (
        <>
          <div className="field-row">
            <label className="field">
              Interval
              <select
                value={interval}
                disabled={!shown}
                onChange={(e) =>
                  setPlot('Change fit interval', {
                    trendInterval: e.target.value as 'none' | 'confidence' | 'prediction',
                  })
                }
              >
                <option value="none">None</option>
                <option value="confidence">{level} confidence band</option>
                <option value="prediction">{level} prediction band</option>
              </select>
            </label>
            <label className="field">
              Line spans
              <select
                value={node.trendExtent ?? 'data'}
                disabled={!shown}
                onChange={(e) =>
                  setPlot('Change fit extent', { trendExtent: e.target.value as 'data' | 'axis' })
                }
              >
                <option value="data">The data</option>
                <option value="axis">The whole axis</option>
              </select>
            </label>
          </div>
          <p className="hint">
            {`y = ${fit.slope.toFixed(3)}x ${fit.intercept < 0 ? '−' : '+'} ` +
              `${Math.abs(fit.intercept).toFixed(3)} · n = ${fit.n}`}
            {interval === 'confidence' &&
              ` · the band covers where the fitted line itself lies, at ${level} confidence.`}
            {interval === 'prediction' &&
              ` · the band covers where a single new observation would fall, at ${level}. It is ` +
                'always the wider of the two.'}
            {interval === 'none' && '. Re-run the test in the Analysis tab if the data changes.'}
          </p>
        </>
      )}
    </>
  );
}

/**
 * Which points carry a drawn name. Selection itself happens two other ways —
 * a range in the Data tab's grid, or a click on the canvas — this is where
 * the current set is reviewed, toggled from the canvas, and pruned, since
 * every route unions into the same field rather than replacing it.
 *
 * Shared verbatim by the volcano and fold-vs-fold blocks: it was already
 * generic — `volcanoLabels`, `pointLabelLimit` and `placedPointLabelsForPlot`
 * are the same three things whichever plot type is drawing — and only its
 * name said otherwise.
 */
function PointLabelControls({
  node,
  doc,
  theme,
  setPlot,
  picking,
  onLabelPickNodeChange,
}: {
  node: PlotNode;
  doc: FigureDocument;
  theme: Theme;
  setPlot: (label: string, patch: Partial<PlotNode>) => void;
  picking: boolean;
  onLabelPickNodeChange: (id: NodeId | null) => void;
}) {
  const labels = node.volcanoLabels ?? [];
  const limit = pointLabelLimit(node);
  // How many of the selected names actually reached the page. Through the very
  // function the canvas uses for hit-testing, which is `resolvePointLabels`
  // again, so this count cannot disagree with what is drawn. Memoised because
  // it runs a full `computePlotGeometry`, exactly as `Canvas.tsx` does.
  const drawn = useMemo(() => placedPointLabelsForPlot(node, doc, theme).length, [node, doc, theme]);

  return (
    <>
      <h4>Labels</h4>
      <button
        className={picking ? 'active' : ''}
        onClick={() => onLabelPickNodeChange(picking ? null : node.id)}
      >
        {picking ? 'Done picking' : 'Pick labels on canvas…'}
      </button>
      <label className="field">
        Label size (pt)
        <input
          type="number"
          min={4}
          step={0.5}
          value={node.pointLabelSizePt ?? theme.type.annotationPt}
          onChange={(e) => {
            const pt = Number(e.target.value);
            if (Number.isFinite(pt) && pt > 0) setPlot('Change label size', { pointLabelSizePt: pt });
          }}
        />
      </label>
      <label className="field">
        Maximum labels
        <input
          type="number"
          min={1}
          max={MAX_POINT_LABEL_CEILING}
          step={1}
          value={limit}
          onChange={(e) => {
            const requested = Number(e.target.value);
            if (!Number.isFinite(requested) || requested < 1) return;
            const clamped = Math.min(MAX_POINT_LABEL_CEILING, Math.floor(requested));
            // Back at the default, drop the field rather than storing 25 — the
            // same "clearing the last override removes it entirely" rule
            // `pointShapes` already follows, so a figure only carries the field
            // if its author actually moved it.
            setPlot('Change label limit', {
              pointLabelLimit: clamped === MAX_POINT_LABELS ? undefined : clamped,
            });
          }}
        />
      </label>
      <p className="hint">
        {labels.length} of {limit} selected
        {labels.length > 0 && <> · {drawn} drawn</>}. Select rows in the Data tab's grid, or click
        points on the canvas, to add more.
        {labels.length >= limit && ' This plot’s maximum is reached — raise it above.'}
        {drawn < labels.length &&
          ` ${labels.length - drawn} selected name${labels.length - drawn === 1 ? ' has' : 's have'} nowhere to go without overprinting a neighbouring point, so ${labels.length - drawn === 1 ? 'it is' : 'they are'} left off. A bigger panel, a smaller label size or fewer names will fit more.`}
        {limit >= MAX_POINT_LABEL_CEILING &&
          ` ${MAX_POINT_LABEL_CEILING} is the ceiling — past it the placement search costs more than a drag can absorb.`}
      </p>
      {labels.length > 0 && (
        <ul className="list compact">
          {labels.map((name) => {
            const moved = node.pointLabelOffsets?.[name] !== undefined;
            return (
              <li key={name}>
                <span>{name}</span>
                {moved && (
                  <button
                    className="icon"
                    title={`Reset ${name}'s position`}
                    onClick={() => {
                      const { [name]: _dropped, ...rest } = node.pointLabelOffsets ?? {};
                      setPlot('Reset label position', {
                        pointLabelOffsets: Object.keys(rest).length > 0 ? rest : undefined,
                      });
                    }}
                  >
                    ⟲
                  </button>
                )}
                <button
                  className="icon danger"
                  title={`Remove ${name}`}
                  onClick={() =>
                    setPlot('Remove point label', {
                      volcanoLabels: labels.filter((l) => l !== name),
                    })
                  }
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

const HEATMAP_SCALE_LABELS: Record<HeatmapScaleMode, string> = {
  sequential: 'Sequential (plain magnitude)',
  diverging: 'Diverging (zero is meaningful)',
};

const HEATMAP_STOP_LABELS: Record<HeatmapScaleMode, string[]> = {
  sequential: ['Low', 'High'],
  diverging: ['Low', 'Mid', 'High'],
};

/**
 * Scale mode, colour stops, the missing-cell colour and the cell-value
 * toggle — in place of the ordinary per-series Colours block, for the same
 * reason volcano's is replaced: a heatmap's cell colour comes from the value
 * and the scale, never from a per-series palette, so palette swatches and
 * "points use series colour" would visibly do nothing.
 */
function HeatmapColorControls({
  node,
  setPlot,
}: {
  node: PlotNode;
  setPlot: (label: string, patch: Partial<PlotNode>) => void;
}) {
  const mode = node.heatmapScale ?? 'sequential';
  const stops = node.heatmapStops ?? DEFAULT_HEATMAP_STOPS[mode];
  const missingColor = node.heatmapMissingColor ?? DEFAULT_HEATMAP_MISSING_COLOR;

  const setStop = (index: number, color: string): void => {
    const next = [...stops];
    next[index] = color;
    setPlot('Change colour stop', { heatmapStops: next });
  };

  return (
    <>
      <h4>Colour scale</h4>
      <label className="field block">
        Scale
        <select
          value={mode}
          onChange={(e) => {
            const nextMode = e.target.value as HeatmapScaleMode;
            // A stop array sized for the old mode would silently apply to the
            // new one — two stops read as a two-point diverging scale with no
            // midpoint, three read as sequential with an ignored middle stop.
            setPlot('Change colour scale', { heatmapScale: nextMode, heatmapStops: undefined });
          }}
        >
          {(Object.keys(HEATMAP_SCALE_LABELS) as HeatmapScaleMode[]).map((m) => (
            <option key={m} value={m}>
              {HEATMAP_SCALE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      {mode === 'diverging' && (
        <p className="hint">
          The domain is made symmetric around zero, so equal positive and negative values read as
          equally saturated — the standard reading for a correlation or log-fold-change matrix.
        </p>
      )}

      <div className="swatches">
        {stops.map((color, index) => (
          <label className="swatch" key={index} title={HEATMAP_STOP_LABELS[mode][index]}>
            <input type="color" value={color} onChange={(e) => setStop(index, e.target.value)} />
            <span>{HEATMAP_STOP_LABELS[mode][index]}</span>
          </label>
        ))}
      </div>

      <label className="field block">
        No-data colour
        <input
          type="color"
          value={missingColor}
          onChange={(e) => setPlot('Change missing-cell colour', { heatmapMissingColor: e.target.value })}
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={node.showCellValues ?? false}
          onChange={(e) => setPlot('Toggle cell values', { showCellValues: e.target.checked })}
        />
        Show cell values
      </label>
    </>
  );
}

const ERROR_BARS = [
  { id: 'none', label: 'None' },
  { id: 'sd', label: 'SD' },
  { id: 'sem', label: 'SEM' },
  { id: 'ci95', label: '95% CI' },
  { id: 'range', label: 'Range' },
  { id: 'iqr', label: 'IQR' },
] as const;

/**
 * Jump anywhere in the figure, by panel.
 *
 * Every panel is a top-level option, so reaching one is a single pick; its own
 * contents sit under the same `<optgroup>`, so a bracket or a montage tile is
 * reachable without hunting for it on the canvas — which is what the Inspector
 * was reported for. Built from `groupNodesByPanel`, the same partition the
 * Layers list draws, so the two cannot disagree about what belongs where.
 *
 * Picking moves the *selection*, not a second notion of "current": the canvas
 * outline, the Layers highlight and the Stats tab all follow, and there is only
 * ever one answer to what is being edited.
 */
function PanelNavigator({
  doc,
  selectedId,
  onSelectionChange,
}: {
  doc: FigureDocument;
  selectedId: NodeId | null;
  onSelectionChange: (ids: NodeId[]) => void;
}) {
  const { groups, unassigned } = groupNodesByPanel(doc.nodes);
  if (groups.length === 0 && unassigned.length === 0) return null;

  const entry = (node: FigureNode, indent: boolean) => (
    <option key={node.id} value={node.id}>
      {indent ? '· ' : ''}
      {node.type === 'panel' ? panelTitle(node) : `${node.type} · ${node.name}`}
    </option>
  );

  return (
    <label className="field block">
      Go to
      <select
        value={selectedId ?? ''}
        onChange={(e) => {
          if (e.target.value) onSelectionChange([e.target.value]);
        }}
      >
        {/* Only while nothing is selected, and only then: a permanent blank
            entry would be a way to select nothing that the canvas already has
            a better one for (click the page). */}
        {selectedId === null && <option value="">Nothing selected</option>}
        {groups.map(({ panel, nodes }) => (
          <optgroup key={panel.id} label={panelTitle(panel)}>
            {entry(panel, false)}
            {nodes.map((node) => entry(node, true))}
          </optgroup>
        ))}
        {unassigned.length > 0 && (
          <optgroup label="Not in a panel">
            {unassigned.map((node) => entry(node, true))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

export interface InspectorProps {
  api: DocumentApi;
  theme: Theme;
  selectedIds: NodeId[];
  onSelectionChange: (ids: NodeId[]) => void;
  cropNodeId: NodeId | null;
  onCropNodeChange: (id: NodeId | null) => void;
  measureNodeId: NodeId | null;
  measuredPx: number | null;
  onMeasureNodeChange: (id: NodeId | null) => void;
  /** Volcano plot whose points are being picked directly on the canvas. */
  labelPickNodeId: NodeId | null;
  onLabelPickNodeChange: (id: NodeId | null) => void;
  /** For per-cell montage image upload/replace — registering a new asset
   *  needs the same store `DataTab`'s own image import already uses. */
  assets: AssetsApi;
}

export function InspectorTab({
  api,
  theme,
  selectedIds,
  onSelectionChange,
  cropNodeId,
  onCropNodeChange,
  measureNodeId,
  measuredPx,
  onMeasureNodeChange,
  labelPickNodeId,
  onLabelPickNodeChange,
  assets,
}: InspectorProps) {
  const { document: doc, commit } = api;

  const navigator = (
    <PanelNavigator doc={doc} selectedId={selectedIds[0] ?? null} onSelectionChange={onSelectionChange} />
  );

  if (selectedIds.length === 0) {
    return (
      <section>
        <h3>Inspector</h3>
        {navigator}
        <p className="hint">
          Select something on the canvas — a panel, a plot, a label or a bracket — to edit it
          here, or pick one from the list above. Double-click a label on the canvas to retype it
          directly.
        </p>
      </section>
    );
  }

  if (selectedIds.length > 1) {
    return (
      <section>
        <h3>Inspector</h3>
        {navigator}
        <p className="hint">{selectedIds.length} nodes selected.</p>
        <button
          className="danger"
          onClick={() => {
            deleteNodesWithLayout(api, theme, selectedIds);
            onSelectionChange([]);
          }}
        >
          Delete {selectedIds.length} nodes
        </button>
      </section>
    );
  }

  const node = doc.nodes[selectedIds[0]!];
  if (!node) {
    return (
      <section>
        <h3>Inspector</h3>
        {navigator}
        <p className="hint">That node no longer exists.</p>
      </section>
    );
  }

  const set = (label: string, patch: Partial<FigureNode>): void => {
    commit(label, (draft) => updateNode(draft, node.id, patch));
  };

  return (
    <section className="inspector">
      <h3>
        {node.type === 'panel' ? (
          panelTitle(node)
        ) : (
          <>
            {node.type} <span className="muted">{node.name}</span>
          </>
        )}
      </h3>

      {navigator}

      <label className="field block">
        Name
        <input value={node.name} onChange={(e) => set('Rename node', { name: e.target.value })} />
      </label>

      {node.type === 'plot' && (
        <PlotFields
          api={api}
          theme={theme}
          node={node}
          doc={doc}
          picking={labelPickNodeId === node.id}
          onLabelPickNodeChange={onLabelPickNodeChange}
        />
      )}
      {(node.type === 'text' || node.type === 'panel-label') && (
        <TextFields api={api} node={node} />
      )}
      {node.type === 'group-label' && <GroupLabelFields api={api} node={node} theme={theme} />}
      {node.type === 'bracket' && (
        <label className="field block">
          Label
          <input
            value={node.label}
            onChange={(e) => set('Edit bracket label', { label: e.target.value } as Partial<FigureNode>)}
          />
        </label>
      )}
      {node.type === 'panel' && (
        <>
          <PanelFields api={api} node={node} theme={theme} assets={assets} onSelectionChange={onSelectionChange} />
          {/* A click on the canvas selects the panel, so the plot or micrograph
              inside it needs a way in that is not "double-click and hope".
              Named, because a montage has several and "Edit the image inside"
              four times over says nothing about which one. */}
          {(() => {
            const tiles = childrenOf(doc.nodes, node.id).filter(
              (child) => child.type === 'plot' || child.type === 'image',
            );
            return tiles.map((child, index) => (
              <button key={child.id} onClick={() => onSelectionChange([child.id])}>
                {tiles.length > 1
                  ? `Edit tile ${index + 1} — ${child.name}`
                  : `Edit the ${child.type} inside`}
              </button>
            ));
          })()}
        </>
      )}
      {node.type === 'image' && (
        <ImageFields
          api={api}
          node={node}
          doc={doc}
          theme={theme}
          cropping={cropNodeId === node.id}
          onCropNodeChange={onCropNodeChange}
        />
      )}
      {node.type === 'scale-bar' && (
        <ScaleBarFields
          api={api}
          node={node}
          doc={doc}
          theme={theme}
          measuring={measureNodeId === node.id}
          measuredPx={measureNodeId === node.id ? measuredPx : null}
          onMeasureNodeChange={onMeasureNodeChange}
        />
      )}
      {node.type === 'arrow' && <ArrowFields api={api} node={node} />}
      {node.type === 'shape' && <ShapeFields api={api} node={node} />}
      {node.type === 'group' && (
        <>
          <p className="hint">
            {childrenOf(doc.nodes, node.id).length} items. Clicking any of them on the canvas
            selects the group; double-click to step inside and select one, Escape to step back out.
          </p>
          <button
            onClick={() => {
              commit('Ungroup', (draft) => ungroup(draft, node.id));
              onSelectionChange([]);
            }}
          >
            Ungroup
          </button>
        </>
      )}

      <h4>Position and size</h4>
      <div className="field-row">
        {(['x', 'y', 'width', 'height'] as const).map((key) => (
          <label className="field" key={key}>
            {key}
            <input
              type="number"
              step={0.5}
              value={Number(node.frame[key].toFixed(2))}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value)) return;
                const frame = { ...node.frame, [key]: value };

                commit('Change frame', (draft) => {
                  // Panels carry a plot and a page-space label that have to
                  // follow, exactly as a drag-resize does — setting the frame
                  // alone would leave the plot at its old size inside it.
                  if (node.type === 'panel') resizePanel(draft, node.id, frame);
                  else updateNode(draft, node.id, { frame });
                  reflowGroupLabels(draft);
                  reflowBrackets(draft, theme);
                });
              }}
            />
          </label>
        ))}
      </div>
      <p className="hint">
        {formatMm(node.frame.width, doc.page.displayUnit)} ×{' '}
        {formatMm(node.frame.height, doc.page.displayUnit)}
      </p>

      {/*
        Rotation is offered only on the leaf annotations. The renderer honours
        `rotation` on any node, but `absoluteFrame` — which every canvas overlay
        and the whole layout engine read — ignores it, so a rotated container
        would misplace its children's chrome. Withheld rather than approximated,
        and the canvas's own rotate grip follows the same set.
      */}
      {isRotatable(node) && (
        <label className="field block">
          Rotation (°)
          <input
            type="number"
            step={5}
            value={Number(node.rotation.toFixed(1))}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (!Number.isFinite(value)) return;
              set('Change rotation', { rotation: ((value % 360) + 360) % 360 });
            }}
          />
        </label>
      )}

      <div className="field-row">
        <label className="check">
          <input
            type="checkbox"
            checked={node.locked}
            onChange={(e) => set('Toggle lock', { locked: e.target.checked })}
          />
          Locked
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={node.hidden}
            onChange={(e) => set('Toggle visibility', { hidden: e.target.checked })}
          />
          Hidden
        </label>
      </div>

      <label className="field block">
        Opacity
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={node.opacity}
          onChange={(e) => set('Change opacity', { opacity: Number(e.target.value) })}
        />
      </label>

      <button
        className="danger"
        onClick={() => {
          deleteNodesWithLayout(api, theme, [node.id]);
          onSelectionChange([]);
        }}
      >
        Delete this {node.type}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------

function PlotFields({
  api,
  theme,
  node,
  doc,
  picking,
  onLabelPickNodeChange,
}: {
  api: DocumentApi;
  theme: Theme;
  node: PlotNode;
  doc: FigureDocument;
  /** True while this plot's points are being picked directly on the canvas. */
  picking: boolean;
  onLabelPickNodeChange: (id: NodeId | null) => void;
}) {
  const { commit } = api;
  const dataset = findDataset(doc, node.datasetId);
  const series = dataset ? toSeries(dataset) : [];
  const colors = paletteColors(node.palette, Math.max(1, series.length));
  const offered = typesFor(
    series,
    dataset?.format === 'matrix',
    dataset?.format === 'survival',
    dataset?.format === 'fold-fold',
    dataset?.format === 'distribution',
  );

  /*
   * Whether a continuous plot has anything to summarise.
   *
   * A line over replicates at each x is exactly that, and the controls for it
   * used to sit behind a branch a continuous plot could never enter — so
   * `errorDisplay` shipped in the Inspector with no way to reach it. A scatter
   * is excluded on purpose: it is its raw observations by definition, which is
   * the same stance the renderer takes.
   */
  const summarisable =
    node.plotType === 'line' && dataset !== undefined && hasReplicatesAtX(dataset);

  // Warn as colours are picked rather than at export: a pair that collides
  // under colour-vision deficiency is far cheaper to fix now.
  const conflicts = findColorConflicts(colors);

  const setPlot = (label: string, patch: Partial<PlotNode>): void => {
    commit(label, (draft) => updateNode<PlotNode>(draft, node.id, patch));
  };

  /*
   * Spacing moves every band centre, and a significance bracket is anchored to
   * one — so the brackets are put back on their bars inside the same commit,
   * or a figure with statistics silently detaches its annotations from the data
   * it annotates. One undo entry either way.
   *
   * `barWidthFraction` deliberately does not use this: a wider bar changes no
   * centre and no mark top, so nothing a bracket reads has moved.
   */
  const setPlotGeometry = (label: string, patch: Partial<PlotNode>): void => {
    commit(label, (draft) => {
      updateNode<PlotNode>(draft, node.id, patch);
      reflowBrackets(draft, theme);
    });
  };

  /**
   * A 0–1 model fraction edited as a percentage, which is how a bar chart's
   * spacing is described everywhere an author has met it before. 0.35 in a spin
   * box does not read as "a third of the slot".
   */
  const percentField = (
    text: string,
    value: number,
    max: number,
    apply: (fraction: number) => void,
  ): React.ReactElement => (
    <label className="field" key={text}>
      {text}
      <input
        type="number"
        min={0}
        max={max}
        step={5}
        value={Math.round(value * 100)}
        onChange={(e) => {
          const pct = Number(e.target.value);
          if (Number.isFinite(pct)) apply(Math.max(0, Math.min(max, pct)) / 100);
        }}
      />
    </label>
  );

  const setSeriesColor = (index: number, color: string): void => {
    const next = [...colors];
    next[index] = color;
    setPlot('Change series colour', { palette: next });
  };

  /*
   * Per-series marker shapes, indexed by series order — the same key the
   * palette above uses. Written as a full-length array with `null` for the
   * series that follow the plot-wide shape, so an index is never a hole and
   * setting series 3 cannot leave 1 and 2 undefined.
   */
  const setSeriesShape = (index: number, shape: PointShape | null): void => {
    const next: (PointShape | null)[] = series.map((_, i) => node.pointShapes?.[i] ?? null);
    next[index] = shape;
    // All following the plot-wide shape is the same as not saying anything, and
    // storing that would leave the field set on every figure that touched it.
    setPlot('Change series marker', {
      pointShapes: next.every((s) => s === null) ? undefined : next,
    });
  };

  /*
   * Distinct symbols carry the series identity where colour cannot, so they are
   * offered wherever several series share one plot area and are told apart by a
   * legend. On a categorical plot each series has its own band and the axis
   * already names it.
   */
  const perSeriesShapes =
    CONTINUOUS_X_PLOT_TYPES.has(node.plotType) &&
    node.plotType !== 'survival' &&
    // No markers are drawn at all on an ECDF, so a per-series shape would set
    // a field nothing reads.
    node.plotType !== 'ecdf' &&
    series.length > 1;

  /*
   * Per-series line styles, indexed by series order — the same key the
   * palette and per-series shapes above use. Written as a full-length array
   * with `null` for the series that follow the plot-wide style, mirroring
   * `setSeriesShape`.
   */
  const setSeriesLineStyle = (index: number, style: LineStyle | null): void => {
    const next: (LineStyle | null)[] = series.map((_, i) => node.lineStyles?.[i] ?? null);
    next[index] = style;
    setPlot('Change series line style', {
      lineStyles: next.every((s) => s === null) ? undefined : next,
    });
  };

  /*
   * A different dash pattern per series is a second way to carry series
   * identity where colour cannot — and on an ECDF it is the *only* one, since
   * that plot type draws no markers to vary. `LINE_STYLED_PLOT_TYPES` is
   * where the set is stated; the legend reads it too, so a dashed curve can
   * never be keyed by a plain block.
   */
  const perSeriesLineStyles =
    LINE_STYLED_PLOT_TYPES.has(node.plotType) && series.length > 1;

  /*
   * Band spacing, and what to call it. Two factors put marks inside a category,
   * so both gaps mean something; one factor gives each mark its own category,
   * where the group gap *is* the gap between the bars. `barWidthFraction` also
   * sets box and violin width and clamps the jitter spread, so calling it "bar"
   * on a violin plot would be wrong.
   */
  const twoFactor = isTwoFactor(series);
  const barLike = node.plotType === 'bar' || node.plotType === 'bar-dot';
  const markWord = barLike ? 'bars' : 'marks';

  /*
   * "Hide points outside min/max" only affects a plot whose marks `xyMarks`
   * builds — a histogram's x is bin edges and its y a derived count, and
   * survival's y is hardcoded to [0, 1] and never reads this either, since
   * neither goes through `xyMarks`. An ECDF is the same case again: it is one
   * polyline built from the sample directly, with no per-point mark for a
   * range filter to remove.
   */
  const clipToRangeRelevant =
    node.plotType === 'scatter' || node.plotType === 'line' || node.plotType === 'volcano';

  /*
   * Whether `showPoints` is read at all, checked against the renderer rather
   * than assumed. `computePlotGeometry`'s volcano branch hardcodes
   * `showPoints: true`, its scatter/line branch forces it true for a scatter,
   * and its histogram branch never reads the field — so on those three the
   * checkbox was a control that visibly did nothing. Heatmap, survival and
   * the ECDF (one polyline, `points: []`) never had it.
   */
  const showPointsRelevant =
    node.plotType !== 'heatmap' &&
    node.plotType !== 'survival' &&
    node.plotType !== 'volcano' &&
    node.plotType !== 'scatter' &&
    node.plotType !== 'ecdf' &&
    node.plotType !== 'histogram';

  /*
   * Whether a second y axis is on offer. A cascade already spends the
   * vertical axis on separation; a categorical plot's bands carry the reading
   * rather than its values; a volcano is always exactly one series; and
   * comparing survival arms against different probability scales would defeat
   * the comparison — and an ECDF's y axis is that same fixed [0, 1]
   * proportion, so a second one could only ever be the same axis twice.
   * Composed once so the heading can be hidden with the control rather than
   * left standing over nothing.
   */
  const secondAxisRelevant =
    !hasCascadeOffset(node, series.length) &&
    CONTINUOUS_X_PLOT_TYPES.has(node.plotType) &&
    node.plotType !== 'volcano' &&
    node.plotType !== 'ecdf' &&
    node.plotType !== 'survival';

  return (
    <>
      <h4>Data</h4>
      <p className="hint">{dataset ? dataset.name : 'Dataset missing'}</p>

      <label className="field block">
        Legend
        <select
          value={node.legend ?? 'auto'}
          onChange={(e) =>
            setPlot('Change legend', {
              legend: e.target.value as 'auto' | 'right' | 'bottom' | 'none',
            })
          }
        >
          <option value="auto">Automatic</option>
          <option value="right">Right of the plot</option>
          <option value="bottom">Below the plot</option>
          <option value="none">None</option>
        </select>
      </label>
      <p className="hint">
        Automatic shows a key only where there is something it alone can say — a second factor,
        or several lines. On a plain bar chart the category labels already name every mark, so a
        key repeating them is furniture.
      </p>

      {node.plotType === 'line' && series.length > 1 && (node.legend ?? 'auto') !== 'none' && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={node.reverseLegend ?? hasCascadeOffset(node, series.length)}
              onChange={(e) => setPlot('Reverse legend', { reverseLegend: e.target.checked })}
            />
            Reverse legend order
          </label>
          <p className="hint">
            A cascade stacks its last series at the top, so its key reads reversed by default to
            match. Turn this off — or on for a plain line plot — to override.
          </p>
        </>
      )}

      {!CONTINUOUS_X_PLOT_TYPES.has(node.plotType) && node.plotType !== 'heatmap' && (
        <>
          <label className="field block">
            Orientation
            <select
              value={node.orientation ?? 'vertical'}
              onChange={(e) =>
                setPlotGeometry('Change orientation', {
                  orientation: e.target.value as 'vertical' | 'horizontal',
                })
              }
            >
              <option value="vertical">Vertical — bars grow upward</option>
              <option value="horizontal">Horizontal — bars grow rightward</option>
            </select>
          </label>
          <p className="hint">
            Horizontal runs the category axis down the left instead of along the bottom — useful
            for long category names or many categories. Significance brackets need a flat place to
            sit above a bar, so they are refused on a horizontal plot; switch back to compare
            groups.
          </p>
        </>
      )}

      {node.plotType === 'volcano' ? (
        <VolcanoColorControls
          node={node}
          doc={doc}
          dataset={dataset}
          theme={theme}
          setPlot={setPlot}
          picking={picking}
          onLabelPickNodeChange={onLabelPickNodeChange}
        />
      ) : node.plotType === 'fold-fold' ? (
        <FoldFoldControls
          node={node}
          doc={doc}
          theme={theme}
          setPlot={setPlot}
          picking={picking}
          onLabelPickNodeChange={onLabelPickNodeChange}
        />
      ) : node.plotType === 'heatmap' ? (
        <HeatmapColorControls node={node} setPlot={setPlot} />
      ) : (
        <>
          <h4>Colours</h4>
          <label className="field block">
            Palette
            <select
              value={typeof node.palette === 'string' ? node.palette : ''}
              onChange={(e) => setPlot('Change palette', { palette: e.target.value })}
            >
              {typeof node.palette !== 'string' && <option value="">Custom</option>}
              {PALETTES.map((palette) => (
                <option key={palette.id} value={palette.id}>
                  {palette.name}
                </option>
              ))}
            </select>
          </label>

          {/* Keyed by index, not name: a paired-xy dataset legitimately repeats a
              column name, and a duplicate React key drops one of the swatches. */}
          <div className={perSeriesShapes ? 'swatches with-shapes' : 'swatches'}>
            {series.map((s, index) => (
              <label className="swatch" key={index} title={s.name}>
                <input
                  type="color"
                  value={colors[index] ?? '#000000'}
                  onChange={(e) => setSeriesColor(index, e.target.value)}
                />
                <span>{s.name}</span>
                {perSeriesShapes && (
                  <select
                    value={node.pointShapes?.[index] ?? ''}
                    title={`Marker for ${s.name}`}
                    onChange={(e) =>
                      setSeriesShape(index, e.target.value === '' ? null : (e.target.value as PointShape))
                    }
                  >
                    <option value="">Default</option>
                    {POINT_SHAPES.map((shape) => (
                      <option key={shape} value={shape}>
                        {shape[0]!.toUpperCase() + shape.slice(1)}
                      </option>
                    ))}
                  </select>
                )}
                {perSeriesLineStyles && (
                  <select
                    value={node.lineStyles?.[index] ?? ''}
                    title={`Line style for ${s.name}`}
                    onChange={(e) =>
                      setSeriesLineStyle(index, e.target.value === '' ? null : (e.target.value as LineStyle))
                    }
                  >
                    <option value="">Default</option>
                    {LINE_STYLES.map((style) => (
                      <option key={style} value={style}>
                        {style[0]!.toUpperCase() + style.slice(1)}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            ))}
          </div>
          {perSeriesShapes && (
            <p className="hint">
              A different symbol per series is what tells them apart in greyscale, and for a
              reader who cannot separate the colours. Once any series is given one, the legend
              draws every series' own symbol. “Default” follows the Marker setting below.
            </p>
          )}
          {perSeriesLineStyles && (
            <p className="hint">
              A different dash pattern per series is a second way to tell them apart in
              greyscale, and for a reader who cannot separate the colours. Once any series is
              given one, the legend draws a short line in every series' own pattern. “Default”
              follows the Line style setting below.
            </p>
          )}

          {typeof node.palette !== 'string' && (
            <button onClick={() => setPlot('Reset palette', { palette: theme.paletteId })}>
              Reset to palette
            </button>
          )}

          {conflicts.length > 0 && <ColorConflictWarning conflict={conflicts[0]!} />}

          <label className="check">
            <input
              type="checkbox"
              checked={node.pointsUseSeriesColor ?? false}
              onChange={(e) => setPlot('Change point colour', { pointsUseSeriesColor: e.target.checked })}
            />
            Points use series colour
          </label>
        </>
      )}

      <h4>Marks</h4>
      <label className="field block">
        Plot type
        <select
          value={node.plotType}
          onChange={(e) => {
            const plotType = e.target.value as PlotType;
            /*
             * A numeric x axis is unreadable without ticks; a categorical one
             * needs none. The default is set at creation, so switching type
             * afterwards has to carry it across too.
             *
             * The y title moves with the type for the same reason it moves with
             * the normalisation: switching a histogram to an ECDF turns the axis
             * from a count into a cumulative probability, and an axis left
             * reading "Count" beside a curve running 0 to 1 misdescribes the
             * figure. A title the author typed is not in `DISTRIBUTION_Y_TITLES`
             * and so is never touched.
             */
            const generatedTitle = DISTRIBUTION_Y_TITLES.has(node.y.title) || node.y.title === '';
            const retitles =
              generatedTitle && (plotType === 'histogram' || plotType === 'ecdf');
            setPlot('Change plot type', {
              plotType,
              x: { ...node.x, showTicks: CONTINUOUS_X_PLOT_TYPES.has(plotType) },
              ...(retitles
                ? { y: { ...node.y, title: distributionYTitle({ ...node, plotType }) } }
                : {}),
            });
          }}
        >
          {offered.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      {/*
       * The histogram's own four controls. Gated on `histogram` rather than on
       * `DISTRIBUTION_PLOT_TYPES`, because an ECDF reads none of them: it has no
       * binning to size, no bars to style, is cumulative by definition, and its
       * y axis is a probability fixed at [0, 1]. Offering them there would be
       * four controls that visibly do nothing.
       */}
      {node.plotType === 'histogram' && (
        <>
          <div className="field-row">
            <label className="field">
              Bins
              <input
                type="number"
                min={1}
                max={200}
                value={node.histogramBins ?? ''}
                placeholder="Auto"
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  setPlot(
                    'Change bin count',
                    e.target.value === '' || !Number.isFinite(raw) || raw < 1
                      ? { histogramBins: undefined }
                      : { histogramBins: Math.min(200, Math.round(raw)) },
                  );
                }}
              />
            </label>
            <label className="field">
              Bar heights
              <select
                value={node.histogramNormalize ?? 'count'}
                onChange={(e) => {
                  const histogramNormalize = e.target.value as NonNullable<
                    PlotNode['histogramNormalize']
                  >;
                  /*
                   * The y title is re-derived in the same patch, so the axis can
                   * never be left reading "Count" over a set of densities — a
                   * figure stating something false about its own numbers.
                   * `retitleDistributionY`'s rule lives in `distributionYTitle`
                   * plus `DISTRIBUTION_Y_TITLES`, so a title the author typed is
                   * left exactly as they wrote it.
                   */
                  const next = { ...node, histogramNormalize };
                  setPlot('Change bar heights', {
                    histogramNormalize,
                    ...(DISTRIBUTION_Y_TITLES.has(node.y.title) || node.y.title === ''
                      ? { y: { ...node.y, title: distributionYTitle(next) } }
                      : {}),
                  });
                }}
              >
                <option value="count">Count</option>
                <option value="frequency">Relative frequency</option>
                <option value="density">Density</option>
              </select>
            </label>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={node.histogramCumulative === true}
              onChange={(e) => {
                const histogramCumulative = e.target.checked;
                const next = { ...node, histogramCumulative };
                setPlot('Toggle cumulative', {
                  histogramCumulative,
                  /*
                   * A cumulative density is not a density — the running total of
                   * density x width is a proportion — so the combination is not
                   * offered at all rather than drawn and mislabelled. Switching
                   * it on over a density falls back to relative frequency, which
                   * is what the accumulation actually produces.
                   */
                  ...(histogramCumulative && node.histogramNormalize === 'density'
                    ? { histogramNormalize: 'frequency' as const }
                    : {}),
                  ...(DISTRIBUTION_Y_TITLES.has(node.y.title) || node.y.title === ''
                    ? {
                        y: {
                          ...node.y,
                          title: distributionYTitle(
                            histogramCumulative && node.histogramNormalize === 'density'
                              ? { ...next, histogramNormalize: 'frequency' }
                              : next,
                          ),
                        },
                      }
                    : {}),
                });
              }}
            />
            Cumulative
          </label>

          {series.length > 1 && (
            <>
              <label className="field block">
                Several groups
                <select
                  value={node.histogramStyle ?? 'overlay'}
                  onChange={(e) =>
                    setPlot('Change histogram style', {
                      histogramStyle: e.target.value as NonNullable<PlotNode['histogramStyle']>,
                    })
                  }
                >
                  <option value="overlay">Overlaid, translucent</option>
                  <option value="step">Step outlines</option>
                </select>
              </label>
              <p className="hint">
                Every group is counted into one shared set of bins, so the bars line up and the
                shapes can be compared. Translucent fills read well at two or three groups; past
                that, outlines stay legible where stacked fills do not.
                {(node.histogramNormalize ?? 'count') === 'count' &&
                  ' Groups of unequal size are hard to compare on a count axis — relative frequency or density puts them on the same footing.'}
              </p>
            </>
          )}
        </>
      )}

      {/*
       * The ECDF's one control. Offered only where it can do something: with
       * one curve there is no gap, and with three or more a KS run reports a
       * separate gap for every pair with no honest way to pick one, so the
       * marker is withheld and the reason is stated rather than a dead
       * checkbox being left on screen.
       */}
      {node.plotType === 'ecdf' &&
        (series.length === 2 ? (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={node.ksGapMarker !== false}
                onChange={(e) =>
                  setPlot('Toggle KS gap marker', { ksGapMarker: e.target.checked })
                }
              />
              Mark the Kolmogorov–Smirnov gap
            </label>
            <p className="hint">
              Draws D where the test measured it — the largest vertical distance between the two
              curves. Appears once a Kolmogorov–Smirnov test has been run on this plot from the
              Stats tab, and nothing is drawn before that.
            </p>
          </>
        ) : (
          <p className="hint">
            The Kolmogorov–Smirnov gap is marked on a plot drawing exactly two curves.{' '}
            {series.length < 2
              ? 'One sample has nothing to be compared against.'
              : `With ${series.length} groups the test reports a separate gap for every pair, and no one of them is the plot's answer.`}
          </p>
        ))}

      {node.plotType === 'heatmap' ? null : node.plotType === 'survival' ? (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={node.showCensorMarks ?? true}
              onChange={(e) => setPlot('Toggle censor marks', { showCensorMarks: e.target.checked })}
            />
            Show censoring marks
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={node.showSurvivalCI ?? false}
              onChange={(e) => setPlot('Toggle confidence band', { showSurvivalCI: e.target.checked })}
            />
            Show 95% confidence band
          </label>
          <p className="hint">
            A tick marks where a subject left the curve without an event — what makes the curve
            honest about follow-up loss. With three or more arms, overlapping bands can read as
            clutter before they read as data, so the band is off by default.
          </p>
        </>
      ) : WHOLE_DISTRIBUTION_MARKS.has(node.plotType) ? null : CONTINUOUS_X_PLOT_TYPES.has(
          node.plotType,
        ) && !summarisable ? null : (
        <>
          <label className="field block">
            Error bars
            <select
              value={node.errorBars}
              onChange={(e) =>
                setPlot('Change error bars', { errorBars: e.target.value as PlotNode['errorBars'] })
              }
            >
              {ERROR_BARS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field block">
            Centre
            <select
              value={node.center}
              onChange={(e) =>
                setPlot('Change centre', { center: e.target.value as 'mean' | 'median' })
              }
            >
              <option value="mean">Mean</option>
              <option value="median">Median</option>
            </select>
          </label>

          {/* A bar convention, and ignored where there is no bar to hide the
              lower half behind — half a whisker there is just missing data. */}
          {!CONTINUOUS_X_PLOT_TYPES.has(node.plotType) && (
            <>
              <label className="field block">
                Error bar direction
                <select
                  value={node.errorBarDirection ?? 'both'}
                  onChange={(e) =>
                    setPlot('Change error bar direction', {
                      errorBarDirection: e.target.value as 'both' | 'up',
                    })
                  }
                >
                  <option value="both">Both directions</option>
                  <option value="up">Upper half only (bar convention)</option>
                </select>
              </label>
              {node.errorBarDirection === 'up' && (
                <p className="hint">
                  Only the upper half is drawn, so the figure shows half the spread that was
                  measured. Conventional on bar charts, but state it in the legend.
                </p>
              )}
            </>
          )}

          {node.plotType === 'line' && (
            <>
              <label className="field block">
                Error display
                <select
                  value={node.errorDisplay ?? 'bars'}
                  onChange={(e) =>
                    setPlot('Change error display', {
                      errorDisplay: e.target.value as 'bars' | 'band',
                    })
                  }
                >
                  <option value="bars">Bars at each point</option>
                  {(!node.offsetFill || node.offsetFill === 'none') && (
                    <option value="band">Shaded band</option>
                  )}
                </select>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={node.showReplicates ?? false}
                  onChange={(e) =>
                    setPlot('Toggle replicates', { showReplicates: e.target.checked })
                  }
                />
                Show every replicate
              </label>
              <p className="hint">
                Either display needs several y values at each x to compute an interval from — a
                table with replicate columns per series. With one value per x there is no
                interval, so nothing is drawn rather than a hairline. Showing every replicate
                draws the individual measurements behind the means.
                {node.offsetFill && node.offsetFill !== 'none'
                  ? ' A shaded band is unavailable while a cascade fill is on — a translucent interval under a filled trace has no reading.'
                  : ''}
              </p>
            </>
          )}
        </>
      )}

      {showPointsRelevant && (
        <label className="check">
          <input
            type="checkbox"
            checked={node.showPoints}
            onChange={(e) => setPlot('Toggle points', { showPoints: e.target.checked })}
          />
          {node.plotType === 'box' ? 'Overlay all points' : 'Show replicate points'}
        </label>
      )}

      {!CONTINUOUS_X_PLOT_TYPES.has(node.plotType) && node.plotType !== 'heatmap' && (
        <>
          <div className="field-row">
            {percentField(
              `${barLike ? 'Bar' : 'Mark'} width (%)`,
              node.barWidthFraction,
              100,
              (v) => setPlot('Change bar width', { barWidthFraction: v }),
            )}
            {twoFactor &&
              percentField(
                'Gap within group (%)',
                node.barGapFraction ?? DEFAULT_BAR_GAP_FRACTION,
                90,
                (v) => setPlotGeometry('Change gap within group', { barGapFraction: v }),
              )}
            {percentField(
              twoFactor ? 'Gap between groups (%)' : `Gap between ${markWord} (%)`,
              node.groupGapFraction ?? DEFAULT_GROUP_GAP_FRACTION,
              90,
              (v) => setPlotGeometry('Change gap between groups', { groupGapFraction: v }),
            )}
          </div>
          <p className="hint">
            Shares of the slot each {markWord.slice(0, -1)} sits in, so they hold as the panel is
            resized. {barLike ? 'Bars' : 'Marks'} {twoFactor ? 'within a group ' : ''}meet at 100%
            width with no gap.
          </p>
        </>
      )}

      {/* An ECDF joins heatmap and survival here: it is one polyline with
          `points: []`, so every marker control below would adjust something
          that is never drawn. */}
      {node.plotType !== 'heatmap' &&
        node.plotType !== 'survival' &&
        node.plotType !== 'ecdf' && (
        <>
          <div className="field-row">
            <label className="field">
              Marker
              <select
                value={node.pointShape ?? 'circle'}
                onChange={(e) =>
                  setPlot('Change marker shape', { pointShape: e.target.value as PointShape })
                }
              >
                {POINT_SHAPES.map((shape) => (
                  <option key={shape} value={shape}>
                    {shape[0]!.toUpperCase() + shape.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Size (mm)
              <input
                type="number"
                min={0.1}
                max={5}
                step={0.1}
                value={node.pointSizeMm}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value > 0) {
                    setPlot('Change marker size', { pointSizeMm: value });
                  }
                }}
              />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              Marker fill
              <input
                type="color"
                // Blank means "follow the series", which is the existing rule and
                // what every figure made before this control looked like.
                value={node.pointFill ?? '#000000'}
                onChange={(e) => setPlot('Change marker fill', { pointFill: e.target.value })}
              />
            </label>
            <label className="field">
              Marker border
              <input
                type="color"
                value={node.pointStroke?.color ?? '#000000'}
                onChange={(e) =>
                  setPlot('Change marker border', {
                    pointStroke: { color: e.target.value, widthMm: node.pointStroke?.widthMm ?? 0.15 },
                  })
                }
              />
            </label>
          </div>
          {(node.pointFill !== undefined || node.pointStroke !== undefined) && (
            <button
              onClick={() =>
                setPlot('Reset marker colours', { pointFill: undefined, pointStroke: undefined })
              }
            >
              Follow the series colour
            </button>
          )}
        </>
      )}

      {LINE_STYLED_PLOT_TYPES.has(node.plotType) && (
        <label className="field block">
          Line style
          <select
            value={node.lineStyle ?? 'solid'}
            onChange={(e) => setPlot('Change line style', { lineStyle: e.target.value as LineStyle })}
          >
            {LINE_STYLES.map((style) => (
              <option key={style} value={style}>
                {style[0]!.toUpperCase() + style.slice(1)}
              </option>
            ))}
          </select>
        </label>
      )}

      {node.plotType === 'line' && series.length > 1 && (
        <CascadeControls node={node} doc={doc} theme={theme} series={series} setPlot={setPlot} />
      )}

      {/* Renders nothing until a correlation has been run on this plot, and is
          the fold-vs-fold block's own copy above for that plot type — this call
          site serves the scatter. */}
      {node.plotType !== 'fold-fold' && (
        <TrendLineControls node={node} doc={doc} setPlot={setPlot} />
      )}

      <h4>Axes</h4>
      {node.plotType !== 'heatmap' && (
        <label className="check">
          <input
            type="checkbox"
            checked={node.boxed ?? false}
            onChange={(e) => setPlot('Toggle boxed axis', { boxed: e.target.checked })}
          />
          Boxed
        </label>
      )}
      {node.plotType !== 'heatmap' && (
        <label className="check">
          <input
            type="checkbox"
            checked={node.showGridlines ?? false}
            onChange={(e) => setPlot('Toggle gridlines', { showGridlines: e.target.checked })}
          />
          Show gridlines
        </label>
      )}
      {node.plotType !== 'heatmap' && node.showGridlines && (
        <>
          <label className="field">
            Gridline colour
            <select
              value={node.gridlineColor ?? 'grey'}
              onChange={(e) =>
                setPlot('Change gridline colour', { gridlineColor: e.target.value as 'grey' | 'black' })
              }
            >
              <option value="grey">Grey</option>
              <option value="black">Black</option>
            </select>
          </label>
          <label className="field">
            Gridline style
            <select
              value={node.gridlineStyle ?? (hasCascadeOffset(node, series.length) ? 'dashed' : 'solid')}
              onChange={(e) =>
                setPlot('Change gridline style', { gridlineStyle: e.target.value as GridlineStyle })
              }
            >
              {GRIDLINE_STYLES.map((style) => (
                <option key={style} value={style}>
                  {style[0]!.toUpperCase() + style.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <AxisFields
        label="Y"
        axis={node.y}
        seriesValues={series.flatMap((s) => s.values)}
        numeric={
          node.plotType !== 'heatmap' &&
          node.plotType !== 'survival' &&
          node.plotType !== 'ecdf'
        }
        clipRelevant={clipToRangeRelevant}
        onChange={(patch, label) => setPlot(label, { y: { ...node.y, ...patch } })}
      />
      <AxisFields
        label="X"
        axis={node.x}
        seriesValues={series.flatMap((s) => [...(s.x ?? [])])}
        numeric={CONTINUOUS_X_PLOT_TYPES.has(node.plotType)}
        clipRelevant={clipToRangeRelevant}
        onChange={(patch, label) => setPlot(label, { x: { ...node.x, ...patch } })}
      />

      {/* Heading and control together: a section header standing over an
          explanation of why there is no control is furniture. */}
      {secondAxisRelevant && (
        <>
          <h4>Second y axis</h4>
          <label className="check">
            <input
              type="checkbox"
              checked={node.y2 !== undefined}
              onChange={(e) =>
                setPlot('Toggle second y axis', {
                  y2: e.target.checked ? { ...node.y, title: '' } : undefined,
                  seriesAxis: e.target.checked ? node.seriesAxis : undefined,
                })
              }
            />
            Right-hand axis
          </label>
          {node.y2 && (
            <>
              <AxisFields
                label="Y2"
                axis={node.y2}
                seriesValues={series
                  .filter((_, i) => node.seriesAxis?.[i] === 'y2')
                  .flatMap((s) => s.values)}
                clipRelevant={clipToRangeRelevant}
                onChange={(patch, label) => setPlot(label, { y2: { ...node.y2!, ...patch } })}
              />
              <div className="swatches">
                {series.map((s, index) => (
                  <label className="check" key={index}>
                    <input
                      type="checkbox"
                      checked={node.seriesAxis?.[index] === 'y2'}
                      onChange={(e) => {
                        const next = series.map(
                          (_, i) =>
                            (i === index
                              ? e.target.checked
                                ? 'y2'
                                : 'y'
                              : (node.seriesAxis?.[i] ?? 'y')) as 'y' | 'y2',
                        );
                        setPlot('Assign series axis', { seriesAxis: next });
                      }}
                    />
                    {s.name} on the right
                  </label>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * Cascade / ridgeline offset controls for a multi-series line plot.
 *
 * Reads the plot's own gross plot-area size through `computePlotGeometry`
 * rather than approximating one from the panel frame, so the live readout of
 * `offsetReserveMm` can never disagree with what the renderer is about to
 * spend.
 */
function CascadeControls({
  node,
  doc,
  theme,
  series,
  setPlot,
}: {
  node: PlotNode;
  doc: FigureDocument;
  theme: Theme;
  series: ReturnType<typeof toSeries>;
  setPlot: (label: string, patch: Partial<PlotNode>) => void;
}) {
  // Called unconditionally, before the isCascadable early return below, so
  // this component's hook count never varies between renders of the same
  // mounted instance (isCascadable can flip as offsetStepMm/offsetStepXMm
  // change while CascadeControls stays mounted at the same tree position).
  const cascadeRuns: readonly TextRun[] = node.cascadeAxisTitleRichText ?? [{ text: node.cascadeAxisTitle ?? '' }];
  const commitCascadeRuns = (nextRuns: readonly TextRun[]): void => {
    setPlot('Format depth axis title', {
      cascadeAxisTitle: plainTextOfRuns(nextRuns) || undefined,
      cascadeAxisTitleRichText: nextRuns.length > 0 ? nextRuns : undefined,
    });
  };
  const {
    textareaRef: depthTitleRef,
    onSelect: onDepthTitleSelect,
    toggle: toggleDepthTitle,
    isActive: depthTitleActive,
  } = useRichTextToggle(cascadeRuns, false, false, commitCascadeRuns);

  if (!isCascadable(node, series.length)) return null;

  const geometry = computePlotGeometry(node, doc, theme);
  const reserve = offsetReserveMm(node, series.length, geometry?.plotWidth ?? 0, geometry?.plotHeight ?? 0);
  const active = hasCascadeOffset(node, series.length);

  return (
    <>
      <h4>Cascade</h4>
      <label className="field">
        Offset per trace (mm)
        <input
          type="number"
          step={0.5}
          value={node.offsetStepMm ?? 0}
          onChange={(e) =>
            setPlot('Set cascade offset', { offsetStepMm: Number(e.target.value) || undefined })
          }
        />
      </label>
      <label className="field">
        Sideways offset (mm)
        <input
          type="number"
          step={0.5}
          value={node.offsetStepXMm ?? 0}
          onChange={(e) =>
            setPlot('Set cascade sideways offset', {
              offsetStepXMm: Number(e.target.value) || undefined,
            })
          }
        />
      </label>
      <label className="field">
        Fill
        <select
          value={node.offsetFill ?? 'none'}
          onChange={(e) =>
            setPlot('Set cascade fill', { offsetFill: e.target.value as 'none' | 'tint' | 'solid' })
          }
        >
          <option value="none">None</option>
          <option value="tint">Tint</option>
          <option value="solid">Solid</option>
        </select>
      </label>
      {active && geometry && (
        <p className="hint">
          {reserve.y > 0 && (
            <>
              Uses {formatMm(reserve.y, doc.page.displayUnit)} of the{' '}
              {formatMm(geometry.plotHeight, doc.page.displayUnit)} plot height.{' '}
            </>
          )}
          {reserve.x > 0 && (
            <>
              Uses {formatMm(reserve.x, doc.page.displayUnit)} of the{' '}
              {formatMm(geometry.plotWidth, doc.page.displayUnit)} plot width.
            </>
          )}
        </p>
      )}
      {active && (
        <>
          <label className="check">
            <input
              type="checkbox"
              checked={node.showCascadeAxis ?? false}
              onChange={(e) => setPlot('Toggle cascade depth axis', { showCascadeAxis: e.target.checked })}
            />
            Show depth axis
          </label>
          {node.showCascadeAxis &&
            (series.some((s) => s.category) ? (
              <p className="hint">
                Each group of traces sharing a category gets its own bracket and label from the
                data — no title needed here.
              </p>
            ) : (
              <>
                <label className="field block">
                  Depth axis title
                  <textarea
                    ref={depthTitleRef}
                    value={node.cascadeAxisTitle ?? ''}
                    placeholder="e.g. Concentration (mg/mL)"
                    onChange={(e) => commitCascadeRuns(reconcileTextEdit(cascadeRuns, e.target.value))}
                    onSelect={onDepthTitleSelect}
                  />
                </label>
                <FormatToggleRow
                  isActive={depthTitleActive}
                  onToggle={toggleDepthTitle}
                  onInsertSymbol={(char) => {
                    const el = depthTitleRef.current;
                    if (!el) return;
                    insertAtCaret(el, char, node.cascadeAxisTitle ?? '', (next) =>
                      commitCascadeRuns(reconcileTextEdit(cascadeRuns, next)),
                    );
                  }}
                />
              </>
            ))}
        </>
      )}
    </>
  );
}

/**
 * The controls for one axis.
 *
 * Every field here was already in the model and honoured by the renderer, with
 * nothing in the UI referring to it — a log axis, an explicit tick step and a
 * fixed min/max have all worked since phase 1 and could only be set by hand
 * editing a saved archive.
 */
function AxisFields({
  label,
  axis,
  seriesValues,
  numeric = true,
  clipRelevant = false,
  onChange,
}: {
  label: string;
  axis: AxisSpec;
  /** Values bound to this axis, for the non-positive warning on a log scale. */
  seriesValues: readonly number[];
  /** False for a categorical x axis, which has no numeric bounds to set. */
  numeric?: boolean;
  /** True on scatter/line/volcano, the plot types whose marks `xyMarks`
   *  builds — the only ones "hide points outside min/max" can affect. */
  clipRelevant?: boolean;
  onChange: (patch: Partial<AxisSpec>, undoLabel: string) => void;
}) {
  const nonPositive = seriesValues.filter((v) => Number.isFinite(v) && v <= 0).length;

  const runs: readonly TextRun[] = axis.richText ?? [{ text: axis.title }];
  const commitRuns = (nextRuns: readonly TextRun[]): void => {
    onChange(
      { title: plainTextOfRuns(nextRuns), richText: nextRuns.length > 0 ? nextRuns : undefined },
      `Format ${label} title`,
    );
  };
  // An axis title has no whole-title TextStyle, so an unformatted run always
  // inherits `false` for both bold and italic — never the tri-state a
  // TextNode allows.
  const { textareaRef: titleRef, onSelect, toggle, isActive } = useRichTextToggle(runs, false, false, commitRuns);

  const numberField = (
    key: 'min' | 'max' | 'tickStep',
    text: string,
  ): React.ReactElement => (
    <label className="field" key={key}>
      {text}
      <input
        type="number"
        step="any"
        // Blank is a real value here — it means "derive from the data" — so an
        // empty field must clear the bound rather than be ignored.
        value={axis[key] ?? ''}
        placeholder="auto"
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') return onChange({ [key]: null }, `Clear ${label} ${text}`);
          const value = Number(raw);
          if (Number.isFinite(value)) onChange({ [key]: value }, `Change ${label} ${text}`);
        }}
      />
    </label>
  );

  return (
    <div className="axis-fields">
      <label className="field block">
        {label} title
        <textarea
          ref={titleRef}
          value={axis.title}
          onChange={(e) => commitRuns(reconcileTextEdit(runs, e.target.value))}
          onSelect={onSelect}
        />
      </label>
      <FormatToggleRow
        isActive={isActive}
        onToggle={toggle}
        onInsertSymbol={(char) => {
          const el = titleRef.current;
          if (!el) return;
          insertAtCaret(el, char, axis.title, (next) => commitRuns(reconcileTextEdit(runs, next)));
        }}
      />

      {numeric && (
        <>
          <div className="field-row">
            <label className="field">
              Scale
              <select
                value={axis.scale}
                onChange={(e) => {
                  const nextScale = e.target.value as 'linear' | 'log10' | 'symlog';
                  // Written in the same patch — one undo entry — so a new
                  // symlog axis reads its powers of ten out of the box, while
                  // every existing log figure, whose labelFormat is absent,
                  // is untouched and stays on 'auto'.
                  onChange(
                    nextScale === 'symlog'
                      ? { scale: nextScale, labelFormat: 'power10' }
                      : { scale: nextScale },
                    `Change ${label} scale`,
                  );
                }}
              >
                <option value="linear">Linear</option>
                <option value="log10">Log₁₀</option>
                <option value="symlog">Symlog (linear near zero)</option>
              </select>
            </label>
            {numberField('tickStep', 'Tick step')}
          </div>

          {axis.scale === 'symlog' && (
            <label className="field block">
              Linear threshold
              <input
                type="number"
                min={0}
                step="any"
                value={axis.linthresh ?? ''}
                placeholder="auto"
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (raw === '') {
                    return onChange({ linthresh: undefined }, `Clear ${label} linear threshold`);
                  }
                  const value = Number(raw);
                  if (Number.isFinite(value) && value > 0) {
                    onChange({ linthresh: value }, `Change ${label} linear threshold`);
                  }
                }}
              />
            </label>
          )}

          {axis.scale === 'log10' && nonPositive > 0 && (
            <p className="warning">
              {nonPositive} value{nonPositive === 1 ? '' : 's'} at or below zero cannot be
              placed on a log axis. The domain is clamped to a decade below the smallest
              positive datum, so those points are not drawn. A symmetric log (Symlog) axis
              would draw them, including a true zero.
            </p>
          )}
          {axis.scale === 'symlog' && nonPositive > 0 && (
            <p className="hint">
              {nonPositive} value{nonPositive === 1 ? '' : 's'} at or below zero {nonPositive === 1 ? 'is' : 'are'}{' '}
              drawn — this axis is linear near zero and logarithmic beyond it on each side, so a
              true 0 has a real position.
            </p>
          )}

          <div className="field-row">
            <label className="field">
              Labels
              <select
                value={axis.labelFormat ?? 'auto'}
                onChange={(e) =>
                  onChange(
                    { labelFormat: e.target.value as LabelFormat },
                    `Change ${label} number format`,
                  )
                }
              >
                <option value="auto">Automatic</option>
                <option value="plain">Plain</option>
                <option value="scientific">Scientific (m×10ⁿ)</option>
                {/* Offered only where most ticks actually land on a power of
                    ten — on a linear axis nearly every one would fall through
                    to 'scientific' instead, a control that mostly does
                    something other than what it says. */}
                {axis.scale !== 'linear' && (
                  <option value="power10">Powers of ten (10ⁿ)</option>
                )}
              </select>
            </label>
            {(axis.labelFormat === 'plain' || axis.labelFormat === 'scientific') && (
              <label className="field">
                Decimals
                <input
                  type="number"
                  min={0}
                  max={6}
                  step={1}
                  value={axis.labelDecimals ?? ''}
                  placeholder="auto"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    if (raw === '') {
                      return onChange({ labelDecimals: undefined }, `Clear ${label} decimals`);
                    }
                    const value = Math.max(0, Math.min(6, Math.round(Number(raw) || 0)));
                    onChange({ labelDecimals: value }, `Change ${label} decimals`);
                  }}
                />
              </label>
            )}
          </div>

          <div className="field-row">
            {numberField('min', 'Min')}
            {numberField('max', 'Max')}
          </div>

          {/* Meaningless — and hidden — with neither bound set: there is no
              range to clip to, so a control that visibly does nothing would
              be exactly the defect this pattern already avoids elsewhere. */}
          {clipRelevant && (axis.min !== null || axis.max !== null) && (
            <label className="check">
              <input
                type="checkbox"
                checked={axis.clipToRange ?? false}
                onChange={(e) =>
                  onChange({ clipToRange: e.target.checked }, `Toggle ${label} range clipping`)
                }
              />
              Hide points outside min/max
            </label>
          )}

          <div className="field-row">
            {axis.scale === 'linear' ? (
              <label className="field">
                Minor ticks
                <input
                  type="number"
                  min={0}
                  max={20}
                  step={1}
                  value={axis.minorTicks ?? 0}
                  title="Divisions between major ticks; 0 for none"
                  onChange={(e) => {
                    const value = Math.max(0, Math.min(20, Math.round(Number(e.target.value) || 0)));
                    onChange({ minorTicks: value }, `Change ${label} minor ticks`);
                  }}
                />
              </label>
            ) : (
              // On a log axis the *count* is meaningless — a reader either
              // wants the conventional 2×..9× sub-decade ticks or does not.
              // A spinner that adjusted a number nothing read would be exactly
              // the "control that visibly does nothing" this app avoids.
              <label className="check">
                <input
                  type="checkbox"
                  checked={(axis.minorTicks ?? 0) >= 2}
                  title="Draws the conventional 2, 3, …, 9 ticks within each decade"
                  onChange={(e) =>
                    onChange(
                      { minorTicks: e.target.checked ? 9 : 0 },
                      `Change ${label} minor ticks`,
                    )
                  }
                />
                Sub-decade minor ticks (2–9)
              </label>
            )}
            <label className="field">
              Ticks
              <select
                value={axis.tickDirection ?? 'out'}
                onChange={(e) =>
                  onChange(
                    { tickDirection: e.target.value as 'out' | 'in' },
                    `Change ${label} tick direction`,
                  )
                }
              >
                <option value="out">Outwards</option>
                <option value="in">Inwards</option>
              </select>
            </label>
          </div>

          <AxisBreakFields label={label} axis={axis} onChange={onChange} />
        </>
      )}
    </div>
  );
}

/** Ranges cut out of an axis, with the conventional break marks. */
function AxisBreakFields({
  label,
  axis,
  onChange,
}: {
  label: string;
  axis: AxisSpec;
  onChange: (patch: Partial<AxisSpec>, undoLabel: string) => void;
}) {
  const breaks = axis.breaks ?? [];
  const setBreaks = (next: { from: number; to: number }[], undoLabel: string): void =>
    onChange({ breaks: next.length > 0 ? next : undefined }, undoLabel);

  if (axis.scale !== 'linear') {
    return breaks.length > 0 ? (
      <p className="hint">
        {axis.scale === 'log10'
          ? 'Breaks are ignored on a log axis: compressing a range that is already compressed leaves nothing a reader can measure against.'
          : 'Breaks are ignored on a symlog axis: it already contains one compression boundary — its linear threshold — and a second would leave nothing left to measure against.'}
      </p>
    ) : null;
  }

  return (
    <>
      {breaks.map((brk, index) => (
        <div className="field-row" key={index}>
          <label className="field">
            Break from
            <input
              type="number"
              step="any"
              value={brk.from}
              onChange={(e) =>
                setBreaks(
                  breaks.map((b, i) => (i === index ? { ...b, from: Number(e.target.value) } : b)),
                  `Change ${label} break`,
                )
              }
            />
          </label>
          <label className="field">
            to
            <input
              type="number"
              step="any"
              value={brk.to}
              onChange={(e) =>
                setBreaks(
                  breaks.map((b, i) => (i === index ? { ...b, to: Number(e.target.value) } : b)),
                  `Change ${label} break`,
                )
              }
            />
          </label>
          <button
            className="icon danger"
            title="Remove break"
            onClick={() => setBreaks(breaks.filter((_, i) => i !== index), `Remove ${label} break`)}
          >
            ×
          </button>
        </div>
      ))}
      <button onClick={() => setBreaks([...breaks, { from: 0, to: 1 }], `Add ${label} break`)}>
        Add axis break
      </button>
      {breaks.length > 0 && (
        <p className="hint">
          Values inside a break are not drawn at all. A mark pinned to the edge of the gap
          would be read as data at that value.
        </p>
      )}
    </>
  );
}

/**
 * Bundles a rich-text toolbar's textarea ref, selection tracking and the
 * toggle/pressed-state logic (`toggleRunFormat`/`isRangeFormatted`) — shared
 * by every field that carries `TextRun`s so a free-standing text box and an
 * axis title read the same selection and toggle the same way. `baseBold`/
 * `baseItalic` are what an unformatted run inherits: a `TextNode`'s own
 * whole-node style, or always `false` for an axis title, which has none.
 */
function useRichTextToggle(
  runs: readonly TextRun[],
  baseBold: boolean,
  baseItalic: boolean,
  commit: (nextRuns: readonly TextRun[]) => void,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  const onSelect = (): void => {
    const el = textareaRef.current;
    if (el) setSelection({ start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 });
  };

  const toggle = (flag: 'bold' | 'italic' | 'sup' | 'sub'): void => {
    const baseActive = flag === 'bold' ? baseBold : flag === 'italic' ? baseItalic : false;
    commit(toggleRunFormat(runs, selection.start, selection.end, flag, baseActive));
    // React clears a controlled textarea's selection across the value swap
    // the commit above triggers; put it back so the just-formatted range
    // still reads as selected.
    const el = textareaRef.current;
    const { start, end } = selection;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start, end);
    });
  };

  const isActive = (flag: 'bold' | 'italic' | 'sup' | 'sub'): boolean => {
    const baseActive = flag === 'bold' ? baseBold : flag === 'italic' ? baseItalic : false;
    return isRangeFormatted(runs, selection.start, selection.end, flag, baseActive);
  };

  return { textareaRef, onSelect, toggle, isActive };
}

/** The Bold/Italic/Superscript/Subscript toggle buttons plus a symbol picker
 *  — the toolbar every rich-text field shares, factored out of `TextFields`'s
 *  original inline JSX so `AxisFields` and the cascade depth-axis title can
 *  render the identical row rather than a second copy of it. */
function FormatToggleRow({
  isActive,
  onToggle,
  onInsertSymbol,
}: {
  isActive: (flag: 'bold' | 'italic' | 'sup' | 'sub') => boolean;
  onToggle: (flag: 'bold' | 'italic' | 'sup' | 'sub') => void;
  onInsertSymbol: (char: string) => void;
}) {
  return (
    <div className="format-toggle">
      <button type="button" className={isActive('bold') ? 'active' : ''} onClick={() => onToggle('bold')}>
        <strong>B</strong>
      </button>
      <button type="button" className={isActive('italic') ? 'active' : ''} onClick={() => onToggle('italic')}>
        <em>I</em>
      </button>
      <button type="button" className={isActive('sup') ? 'active' : ''} onClick={() => onToggle('sup')}>
        x²
      </button>
      <button type="button" className={isActive('sub') ? 'active' : ''} onClick={() => onToggle('sub')}>
        x₂
      </button>
      <SymbolPicker onInsert={onInsertSymbol} />
    </div>
  );
}

function TextFields({
  api,
  node,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'text' | 'panel-label' }>;
}) {
  const { commit } = api;

  const setStyle = (patch: Partial<TextStyle>): void => {
    commit('Change text style', (draft) => {
      const target = draft.nodes[node.id];
      if (!target || (target.type !== 'text' && target.type !== 'panel-label')) return;
      target.style = { ...target.style, ...patch };
    });
  };

  // Only a free-standing text box gets rich formatting (round 23's confirmed
  // scope) — a panel label stays the plain single-line field it always was.
  const runs: readonly TextRun[] = node.type === 'text' ? (node.richText ?? [{ text: node.text }]) : [];

  const commitRuns = (nextRuns: readonly TextRun[]): void => {
    commit('Format text', (draft) => {
      const target = draft.nodes[node.id];
      if (!target || target.type !== 'text') return;
      target.richText = nextRuns.length > 0 ? nextRuns : undefined;
      target.text = plainTextOfRuns(nextRuns);
    });
  };

  const { textareaRef, onSelect, toggle, isActive } = useRichTextToggle(
    runs,
    node.style.fontWeight === 'bold',
    node.style.fontStyle === 'italic',
    commitRuns,
  );

  return (
    <>
      <label className="field block">
        Text
        {node.type === 'text' ? (
          <textarea
            ref={textareaRef}
            value={node.text}
            onChange={(e) => commitRuns(reconcileTextEdit(runs, e.target.value))}
            onSelect={onSelect}
          />
        ) : (
          <input
            value={node.text}
            onChange={(e) =>
              commit('Edit text', (draft) => {
                const target = draft.nodes[node.id];
                if (target && target.type === 'panel-label') target.text = e.target.value;
              })
            }
          />
        )}
      </label>

      {node.type === 'text' && (
        <FormatToggleRow
          isActive={isActive}
          onToggle={toggle}
          onInsertSymbol={(char) => {
            const el = textareaRef.current;
            if (!el) return;
            insertAtCaret(el, char, node.text, (next) => commitRuns(reconcileTextEdit(runs, next)));
          }}
        />
      )}

      <div className="field-row">
        <label className="field">
          Size (pt)
          <input
            type="number"
            min={4}
            max={24}
            step={0.5}
            value={node.style.fontSizePt ?? ''}
            onChange={(e) => setStyle({ fontSizePt: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          Colour
          <input
            type="color"
            value={node.style.color ?? '#000000'}
            onChange={(e) => setStyle({ color: e.target.value })}
          />
        </label>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={node.style.fontWeight === 'bold'}
          onChange={(e) => setStyle({ fontWeight: e.target.checked ? 'bold' : 'normal' })}
        />
        Bold
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={node.style.fontStyle === 'italic'}
          onChange={(e) => setStyle({ fontStyle: e.target.checked ? 'italic' : 'normal' })}
        />
        Italic
      </label>
    </>
  );
}

/**
 * A heading over a row/column of panels/images, or a caption on one.
 *
 * Rich-text title editing mirrors `TextFields`'s free-standing `TextNode`
 * branch exactly — same `useRichTextToggle`/`FormatToggleRow`/
 * `reconcileTextEdit` pipeline — since a heading's title is the same kind of
 * short, formattable string. Every write that could change how much room the
 * heading needs (its edge, its rule, its font size) re-derives that room the
 * same way `Toolbar.tsx`'s own `addGroupTitle` does when the heading is
 * first created: a same-panel heading forces an immediate re-tile of the one
 * montage panel that owns it; a cross-panel heading calls
 * `reserveSpaceForGroupLabels`, safe here because editing a heading in the
 * Inspector is a deliberate action, never the manual drag/resize this
 * codebase otherwise never runs it after.
 */
function GroupLabelFields({
  api,
  node,
  theme,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'group-label' }>;
  theme: Theme;
}) {
  const { commit } = api;

  const applyAndReflow = (label: string, mutate: (target: Extract<FigureNode, { type: 'group-label' }>) => void): void => {
    commit(label, (draft) => {
      const target = draft.nodes[node.id];
      if (!target || target.type !== 'group-label') return;
      mutate(target);

      const parentIds = new Set(target.memberIds.map((id) => draft.nodes[id]?.parentId ?? null));
      const soleParentId = parentIds.size === 1 ? [...parentIds][0] : null;
      const soleParent = soleParentId ? draft.nodes[soleParentId] : null;
      if (soleParent?.type === 'panel' && soleParent.contentGrid) {
        fillPanelChildren(draft, soleParent.id, soleParent.frame);
      } else {
        reserveLayoutSpace(draft);
      }
      reflowGroupLabels(draft);
    });
  };

  const placementApplies = groupLabelMembersAreImages(api.document.nodes, node.memberIds);

  const runs: readonly TextRun[] = node.richText ?? [{ text: node.title }];
  const commitRuns = (nextRuns: readonly TextRun[]): void => {
    applyAndReflow('Format group title', (target) => {
      target.richText = nextRuns.length > 0 ? nextRuns : undefined;
      target.title = plainTextOfRuns(nextRuns);
    });
  };
  const { textareaRef, onSelect, toggle, isActive } = useRichTextToggle(runs, false, false, commitRuns);

  return (
    <>
      <label className="field block">
        Title
        <textarea
          ref={textareaRef}
          value={node.title}
          onChange={(e) => commitRuns(reconcileTextEdit(runs, e.target.value))}
          onSelect={onSelect}
        />
      </label>
      <FormatToggleRow
        isActive={isActive}
        onToggle={toggle}
        onInsertSymbol={(char) => {
          const el = textareaRef.current;
          if (!el) return;
          insertAtCaret(el, char, node.title, (next) => commitRuns(reconcileTextEdit(runs, next)));
        }}
      />

      <div className="field-row">
        <label className="field">
          Position
          <select
            value={node.edge}
            onChange={(e) => applyAndReflow('Change heading position', (target) => {
              target.edge = e.target.value as 'top' | 'left' | 'right';
            })}
          >
            <option value="top">Above (row heading)</option>
            <option value="left">Left (column heading)</option>
            <option value="right">Right (column heading)</option>
          </select>
        </label>
        <label className="field">
          Size (pt)
          <input
            type="number"
            min={4}
            max={24}
            step={0.5}
            value={node.style?.fontSizePt ?? theme.type.annotationPt}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value > 0) {
                applyAndReflow('Change heading size', (target) => {
                  target.style = { ...target.style, fontSizePt: value };
                });
              }
            }}
          />
        </label>
      </div>

      <div className="field-row">
        {/*
          Overlaying draws the heading *on* the content in white with a dark
          outline, which is a micrograph convention — over a plot it paints a
          white caption across the axes. So the control appears only where the
          option means something.

          The `=== 'overlay'` half keeps it reachable on a document that already
          carries the value: hiding a control is presentation, but stranding a
          stored setting behind it would leave the author no way back. Nothing
          is rewritten on load — that would be a migration, and this is not one.
        */}
        {(placementApplies || node.placement === 'overlay') && (
          <label className="field">
            Placement
            <select
              value={node.placement ?? 'outside'}
              onChange={(e) =>
                applyAndReflow('Change heading placement', (target) => {
                  target.placement = e.target.value === 'overlay' ? 'overlay' : undefined;
                })
              }
            >
              <option value="outside">Beside the image</option>
              <option value="overlay">On the image</option>
            </select>
          </label>
        )}
        <label className="field">
          Colour
          <input
            type="color"
            value={node.labelColor ?? (node.placement === 'overlay' ? '#ffffff' : theme.foreground)}
            onChange={(e) =>
              applyAndReflow('Change heading colour', (target) => {
                target.labelColor = e.target.value;
              })
            }
          />
        </label>
      </div>
      {node.placement === 'overlay' && (
        <p className="hint">
          Drawn on the picture, so it takes no space of its own and nothing on
          the page moves to make room. White with a dark outline by default, which
          reads on most micrographs; set a colour if it does not.
        </p>
      )}

      {/* A rule is never drawn over a picture and an overlay reserves no gap,
          so both controls would adjust nothing there — the standing "a control
          that visibly does nothing is a defect" rule. */}
      {node.placement !== 'overlay' && (
      <label className="check">
        <input
          type="checkbox"
          checked={node.showRule ?? false}
          onChange={(e) =>
            applyAndReflow('Toggle heading rule', (target) => {
              target.showRule = e.target.checked;
            })
          }
        />
        Show rule
      </label>
      )}

      {node.placement !== 'overlay' && (node.showRule ?? false) && (
        <div className="field-row">
          <label className="field">
            Rule colour
            <input
              type="color"
              value={node.stroke?.color ?? '#000000'}
              onChange={(e) =>
                applyAndReflow('Change rule colour', (target) => {
                  target.stroke = { widthMm: 0.35, ...target.stroke, color: e.target.value };
                })
              }
            />
          </label>
          <label className="field">
            Rule width
            <input
              type="number"
              min={0.05}
              step={0.05}
              value={node.stroke?.widthMm ?? 0.35}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isFinite(value) && value > 0) {
                  applyAndReflow('Change rule width', (target) => {
                    target.stroke = { color: '#000000', ...target.stroke, widthMm: value };
                  });
                }
              }}
            />
          </label>
        </div>
      )}

      {node.placement !== 'overlay' && (
        <>
          <label className="field">
            Gap to content
            <input
              type="number"
              min={0}
              step={0.5}
              value={
                node.gapMm ??
                ((node.showRule ?? false) ? GROUP_LABEL_GAP_MM : GROUP_LABEL_GAP_NO_RULE_MM)
              }
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isFinite(value) && value >= 0) {
                  applyAndReflow('Change heading gap', (target) => {
                    target.gapMm = value;
                  });
                }
              }}
            />
          </label>
          <p className="hint">
            Clear space in millimetres between this heading and what it labels.
            The row or column it sits against grows to hold it, so raising this
            pushes the content down rather than printing over it. Bare text
            starts tighter than a rule does, which needs room not to read as a
            border on the picture.
          </p>
        </>
      )}

      <p className="hint">
        Captions {node.memberIds.length === 1 ? 'one panel/image' : `${node.memberIds.length} panels/images`}.
        Deleting any one of them removes this heading too.
        {node.memberIds.length > 1 &&
          ' A heading over fewer of the same panels — a caption on just one — sits underneath this one rather than on top of it.'}
      </p>
    </>
  );
}

/** Crop is stored 0–1; nobody thinks in 0.317, so the UI works in percent. */
const CROP_KEYS = ['x', 'y', 'width', 'height'] as const;

function ImageFields({
  api,
  node,
  doc,
  theme,
  cropping,
  onCropNodeChange,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'image' }>;
  doc: FigureDocument;
  theme: Theme;
  cropping: boolean;
  onCropNodeChange: (id: NodeId | null) => void;
}) {
  const { commit, newId } = api;
  const asset = findAsset(doc, node.assetId);
  const isVector = asset?.mimeType === 'image/svg+xml';

  /*
   * The caption on this pane, if it has one. Editing a pane's own label from
   * the pane is what was asked for — reaching it previously meant selecting
   * the label itself, which on a tightly packed montage is a small target.
   * A caption is a `GroupLabelNode` of one member, so this is a lookup rather
   * than a second kind of label.
   */
  const ownLabel = Object.values(doc.nodes).find(
    (n): n is Extract<FigureNode, { type: 'group-label' }> =>
      n.type === 'group-label' && n.memberIds.length === 1 && n.memberIds[0] === node.id,
  );

  const addOwnLabel = (): void => {
    commit('Label image', (draft) => {
      const label = addGroupLabel(draft, newId, {
        memberIds: [node.id],
        edge: 'top',
        title: node.name,
        fontSizePt: theme.type.annotationPt,
      });
      if (!label) return;
      const parent = node.parentId ? draft.nodes[node.parentId] : null;
      if (parent?.type === 'panel' && parent.contentGrid) {
        fillPanelChildren(draft, parent.id, parent.frame);
      } else {
        reserveLayoutSpace(draft);
      }
      reflowGroupLabels(draft);
      reflowBrackets(draft, theme);
    });
  };

  const visiblePx = node.naturalPx.width * (node.crop.width || 1);
  const dpi = node.frame.width > 0 ? effectiveDpi(visiblePx, node.frame.width) : 0;

  return (
    <>
      <p className="hint">
        {asset ? asset.filename : 'asset missing'}
        {asset && !isVector && ` · ${node.naturalPx.width}×${node.naturalPx.height} px`}
      </p>

      {!isVector && node.naturalPx.width > 0 && (
        <p className={dpi < 300 ? 'warning' : 'hint'}>
          {/* Live, because the number changes with every resize and crop —
              which is exactly when the author needs to see it. */}
          {Math.round(dpi)} dpi at this size
          {dpi < 300 && ` · below the 300 dpi most journals require`}
        </p>
      )}

      {/* This pane's own caption, edited here rather than only by selecting
          the label itself — the same `GroupLabelFields` the label's own
          Inspector shows, so the two cannot drift apart. */}
      <h4>Label</h4>
      {ownLabel ? (
        <GroupLabelFields api={api} node={ownLabel} theme={theme} />
      ) : (
        <>
          <button type="button" onClick={addOwnLabel}>
            Add label
          </button>
          <p className="hint">
            A title above this image. Its size, colour and placement are edited
            here once it exists.
          </p>
        </>
      )}

      <h4>Image</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={node.preserveAspect}
          onChange={(e) =>
            commit('Toggle aspect lock', (draft) =>
              updateNode<typeof node>(draft, node.id, { preserveAspect: e.target.checked }),
            )
          }
        />
        Keep aspect ratio
      </label>

      {/* Only meaningful while the picture is letterboxed: a stretched image
          fills its frame exactly, so there is no spare space to place it in
          and a control for it would adjust nothing. The same "a control that
          visibly does nothing is a defect" rule the plot Inspector already
          follows. */}
      {node.preserveAspect && (
        <>
          <div className="field-row">
            <label className="field">
              Align across
              <select
                value={node.alignX ?? 'middle'}
                onChange={(e) =>
                  commit('Change image alignment', (draft) =>
                    updateNode<typeof node>(draft, node.id, {
                      alignX: e.target.value as 'start' | 'middle' | 'end',
                    }),
                  )
                }
              >
                <option value="start">Left</option>
                <option value="middle">Centre</option>
                <option value="end">Right</option>
              </select>
            </label>
            <label className="field">
              Align down
              <select
                value={node.alignY ?? 'middle'}
                onChange={(e) =>
                  commit('Change image alignment', (draft) =>
                    updateNode<typeof node>(draft, node.id, {
                      alignY: e.target.value as 'start' | 'middle' | 'end',
                    }),
                  )
                }
              >
                <option value="start">Top</option>
                <option value="middle">Middle</option>
                <option value="end">Bottom</option>
              </select>
            </label>
          </div>
          <p className="hint">
            Where the picture sits in its frame when it does not fill it. A tile
            uploaded into a montage starts at the top, so a row of
            differently-shaped images lines up along its top edge.
          </p>
        </>
      )}

      <h4>Crop</h4>
      <button
        className={cropping ? 'primary' : ''}
        onClick={() => onCropNodeChange(cropping ? null : node.id)}
      >
        {cropping ? 'Done cropping' : 'Crop on canvas'}
      </button>
      <p className="hint">
        {cropping
          ? 'Drag the window or its corners over the image. Escape when done.'
          : 'Percent of the source image. Cropping keeps full resolution.'}
      </p>
      <div className="field-row">
        {CROP_KEYS.map((key) => (
          <label className="field" key={key}>
            {key}
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={Number((node.crop[key] * 100).toFixed(1))}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (!Number.isFinite(value)) return;
                commit('Change crop', (draft) => {
                  // Routed through setImageCrop so the clamp and the scale-bar
                  // resync happen here exactly as they do for a drag.
                  setImageCrop(draft, node.id, { [key]: value / 100 });
                });
              }}
            />
          </label>
        ))}
      </div>

      <button
        onClick={() =>
          commit('Reset crop', (draft) =>
            setImageCrop(draft, node.id, { x: 0, y: 0, width: 1, height: 1 }),
          )
        }
      >
        Reset crop
      </button>

      {node.naturalPx.height > 0 && (
        <button
          onClick={() =>
            commit('Fit to aspect', (draft) => {
              const target = draft.nodes[node.id];
              if (target?.type !== 'image') return;
              // Height follows width, so the visible crop is drawn at its true
              // proportions instead of letterboxed inside a mismatched frame.
              const aspect =
                (target.naturalPx.width * target.crop.width) /
                (target.naturalPx.height * target.crop.height);
              target.frame = { ...target.frame, height: target.frame.width / aspect };
              resyncScaleBars(draft);
              reflowGroupLabels(draft);
              reflowBrackets(draft, theme);
            })
          }
        >
          Fit frame to image
        </button>
      )}
    </>
  );
}

/** Sub-millimetre units a micrograph is actually calibrated in. */
const CALIBRATION_UNITS: { label: string; perMicron: number }[] = [
  { label: 'nm', perMicron: 1000 },
  { label: 'µm', perMicron: 1 },
  { label: 'mm', perMicron: 0.001 },
];

const CALIBRATION_WORDING: Record<CalibrationSource, string> = {
  metadata: 'Read from the image file.',
  manual: 'You entered this.',
  measured: 'Measured from a known feature.',
  unknown: 'Not calibrated — this bar states a length nothing supports.',
};

function ScaleBarFields({
  api,
  node,
  doc,
  theme,
  measuring,
  measuredPx,
  onMeasureNodeChange,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'scale-bar' }>;
  doc: FigureDocument;
  theme: Theme;
  measuring: boolean;
  measuredPx: number | null;
  onMeasureNodeChange: (id: NodeId | null) => void;
}) {
  const { commit } = api;
  const source = node.calibrationSource ?? 'unknown';
  const drawnMm = scaleBarWidthMm(doc.nodes, node.id);
  const [knownLength, setKnownLength] = useState('');

  const applyMeasurement = (): void => {
    const known = Number(knownLength);
    if (!measuredPx || !Number.isFinite(known) || known <= 0) return;
    commit('Calibrate from measurement', (draft) =>
      // The ruler reports source pixels and the user supplies what that
      // distance is, so pixels-per-unit falls straight out.
      setScaleBarCalibration(draft, node.id, measuredPx / known, 'measured'),
    );
    onMeasureNodeChange(null);
    setKnownLength('');
  };

  const setBar = (label: string, patch: Partial<typeof node>): void => {
    commit(label, (draft) => {
      updateNode(draft, node.id, patch);
      resyncScaleBars(draft);
    });
  };

  /**
   * Placement is the one scale-bar change that moves other things.
   *
   * A bar below the picture needs a band reserved beneath it, and a picture
   * routinely fills its frame exactly — so this runs the reservation and the
   * reflows that follow panels moving. Colour and thickness move nothing, which
   * is why they keep the plain `setBar` above.
   */
  const setPlacement = (placement: 'inside' | 'below'): void => {
    const patch: Partial<typeof node> = {
      placement,
      // Outside the picture the bar sits on the white page, where white — the
      // right choice over a dark micrograph, and what an author will often have
      // set — is invisible. A starting point, not a lock: the Colour controls
      // beside this one still apply.
      ...(placement === 'below' ? { fill: { ...node.fill, color: '#000000' } } : {}),
      // The label needs the same conversion for the same reason, but only where
      // the author actually set a colour. An absent one already resolves to
      // `theme.foreground`, so writing black over it would change nothing today
      // and freeze the label against a later theme change — the fill has no
      // such option, since `Fill.color` is required and therefore always set.
      ...(placement === 'below' && node.style.color !== undefined
        ? { style: { ...node.style, color: '#000000' } }
        : {}),
    };
    commit('Change scale bar placement', (draft) => {
      updateNode(draft, node.id, patch);
      resyncScaleBars(draft);
      reserveLayoutSpace(draft);
      reflowGroupLabels(draft);
      reflowBrackets(draft, resolveTheme(draft.themeId, draft.themeOverrides));
    });
  };

  // Nobody holds the calibration as "pixels per unit" — they have µm per pixel
  // off the microscope. Present it the way the number arrives; the model keeps
  // its own form.
  const unitPerPixel = node.pixelsPerUnit > 0 ? 1 / node.pixelsPerUnit : 0;

  return (
    <>
      <p className={source === 'unknown' ? 'warning' : 'hint'}>{CALIBRATION_WORDING[source]}</p>

      <h4>Bar</h4>
      <div className="field-row">
        <label className="field">
          Length
          <input
            type="number"
            min={0}
            step={1}
            value={node.length}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value > 0) setBar('Change bar length', { length: value });
            }}
          />
        </label>
        <label className="field">
          Unit
          <select
            value={node.unitLabel}
            onChange={(e) => setBar('Change bar unit', { unitLabel: e.target.value })}
          >
            {CALIBRATION_UNITS.map((unit) => (
              <option key={unit.label} value={unit.label}>
                {unit.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h4>Image scale</h4>
      <label className="field block">
        {node.unitLabel} per pixel
        <input
          type="number"
          min={0}
          step={0.001}
          value={Number(unitPerPixel.toFixed(6))}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (!Number.isFinite(value) || value <= 0) return;
            commit('Set image scale', (draft) =>
              // Typing a number is a claim that it is right, so the provenance
              // moves with it. Leaving it 'unknown' would keep the quality
              // checker complaining about a bar the author has just calibrated.
              setScaleBarCalibration(draft, node.id, 1 / value, 'manual'),
            );
          }}
        />
      </label>
      <p className="hint">
        {node.pixelsPerUnit.toFixed(4)} px per {node.unitLabel}
        {drawnMm !== null && ` · bar draws ${drawnMm.toFixed(2)} mm`}
      </p>

      {/* The workflow for a legacy micrograph: no metadata, but a scale bar
          burned into the pixels. Measuring that bar is the only way to
          recover the pixel size. */}
      <button
        className={measuring ? 'primary' : ''}
        onClick={() => onMeasureNodeChange(measuring ? null : node.id)}
      >
        {measuring ? 'Cancel measuring' : 'Calibrate from the image'}
      </button>

      {measuring && (
        <>
          <p className="hint">
            {measuredPx
              ? `Measured ${Math.round(measuredPx)} px. How long is that?`
              : 'Drag across a feature of known length — a burned-in scale bar, usually.'}
          </p>
          {measuredPx !== null && (
            <div className="field-row measured-length">
              {/* Not "Length": the bar's own length field is a few lines up,
                  and two identically labelled numbers in one panel is how the
                  wrong one gets filled in. */}
              <label className="field">
                That distance is ({node.unitLabel})
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  autoFocus
                  value={knownLength}
                  onChange={(e) => setKnownLength(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyMeasurement();
                  }}
                />
              </label>
              <button
                className="primary"
                disabled={!(Number(knownLength) > 0)}
                onClick={applyMeasurement}
              >
                Set scale
              </button>
            </div>
          )}
        </>
      )}

      <h4>Appearance</h4>
      <div className="field-row">
        <label className="field">
          Placement
          <select
            value={node.placement ?? 'inside'}
            onChange={(e) => setPlacement(e.target.value === 'below' ? 'below' : 'inside')}
          >
            <option value="inside">On the image</option>
            <option value="below">Below the image</option>
          </select>
        </label>
        <label className="field">
          Label
          <select
            value={node.labelPosition}
            onChange={(e) => {
              const labelPosition = e.target.value as 'above' | 'below' | 'none';
              // showLabel is deprecated but still required by the schema, so
              // it is kept in step rather than left to contradict this.
              setBar('Change label position', { labelPosition, showLabel: labelPosition !== 'none' });
            }}
          >
            <option value="above">Above</option>
            <option value="below">Below</option>
            <option value="none">Hidden</option>
          </select>
        </label>
        {/* "Bar colour", not "Colour": the label has its own swatch beside
            this one, and two controls sharing a name in one row is how the
            wrong one gets set. */}
        <label className="field">
          Bar colour
          <input
            type="color"
            value={node.fill.color}
            // Spread, not replace: `fill` also carries opacity, which a bare
            // `{ color }` would silently reset to full.
            onChange={(e) =>
              setBar('Change bar colour', { fill: { ...node.fill, color: e.target.value } })
            }
          />
        </label>
        {/* Hidden with the label itself — colouring text nobody draws is the
            standing "a control that visibly does nothing is a defect" rule.
            `style.color` has been a real, rendered field since phase 1 with
            nothing in the UI setting it, so a white bar over a dark micrograph
            has always been captioned in the theme's black. */}
        {node.labelPosition !== 'none' && (
          <label className="field">
            Label colour
            <input
              type="color"
              // An absent colour draws as `theme.foreground`, so that is what
              // the swatch has to show — a colour input cannot express "unset",
              // and showing black on a light-on-dark theme would misreport what
              // is on the page.
              value={node.style.color ?? theme.foreground}
              onChange={(e) =>
                setBar('Change label colour', { style: { ...node.style, color: e.target.value } })
              }
            />
          </label>
        )}
        <label className="field">
          Thickness
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={node.barHeightMm}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value > 0) {
                setBar('Change bar thickness', { barHeightMm: value });
              }
            }}
          />
        </label>
      </div>
    </>
  );
}

const END_STYLES = [
  { id: 'none', label: 'None' },
  { id: 'triangle', label: 'Solid' },
  { id: 'open', label: 'Open' },
] as const;

function ArrowFields({
  api,
  node,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'arrow' }>;
}) {
  const { commit } = api;

  const setArrow = (label: string, patch: Partial<typeof node>): void => {
    commit(label, (draft) => updateNode(draft, node.id, patch));
  };

  return (
    <>
      <p className="hint">Drag the round grips on the canvas to aim it.</p>

      <div className="field-row">
        <label className="field">
          Head
          <select
            value={node.head}
            onChange={(e) => setArrow('Change arrowhead', { head: e.target.value as typeof node.head })}
          >
            {END_STYLES.map((style) => (
              <option key={style.id} value={style.id}>
                {style.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Tail
          <select
            value={node.tail}
            onChange={(e) => setArrow('Change arrow tail', { tail: e.target.value as typeof node.tail })}
          >
            {END_STYLES.map((style) => (
              <option key={style.id} value={style.id}>
                {style.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Head size
          <input
            type="number"
            min={0.2}
            step={0.2}
            value={node.headSizeMm}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value > 0) setArrow('Change head size', { headSizeMm: value });
            }}
          />
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          Colour
          <input
            type="color"
            value={node.stroke.color}
            onChange={(e) =>
              setArrow('Change arrow colour', { stroke: { ...node.stroke, color: e.target.value } })
            }
          />
        </label>
        <label className="field">
          Width
          <input
            type="number"
            min={0.05}
            step={0.05}
            value={node.stroke.widthMm}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value > 0) {
                setArrow('Change arrow width', { stroke: { ...node.stroke, widthMm: value } });
              }
            }}
          />
        </label>
      </div>

      <button
        onClick={() =>
          commit('Add arrow point', (draft) => {
            const target = draft.nodes[node.id];
            if (target?.type !== 'arrow') return;
            const last = target.points[target.points.length - 1]!;
            const previous = target.points[target.points.length - 2] ?? last;
            // Extend along the current heading, so the new segment continues
            // the arrow rather than doubling back on it.
            target.points = [
              ...target.points,
              { x: last.x + (last.x - previous.x || 5), y: last.y + (last.y - previous.y || 0) },
            ];
            normaliseArrowFrame(draft, node.id);
          })
        }
      >
        Add a bend
      </button>
    </>
  );
}

function ShapeFields({
  api,
  node,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'shape' }>;
}) {
  const { commit } = api;

  const setShape = (label: string, patch: Partial<typeof node>): void => {
    commit(label, (draft) => updateNode(draft, node.id, patch));
  };

  return (
    <>
      <label className="field block">
        Shape
        <select
          value={node.shape}
          onChange={(e) => setShape('Change shape', { shape: e.target.value as typeof node.shape })}
        >
          <option value="rect">Rectangle</option>
          <option value="ellipse">Ellipse</option>
          <option value="line">Line</option>
        </select>
      </label>

      <div className="field-row">
        <label className="field">
          Stroke
          <input
            type="color"
            value={node.stroke?.color ?? '#000000'}
            onChange={(e) =>
              setShape('Change stroke colour', {
                stroke: { widthMm: 0.35, ...node.stroke, color: e.target.value },
              })
            }
          />
        </label>
        <label className="field">
          Width
          <input
            type="number"
            min={0.05}
            step={0.05}
            value={node.stroke?.widthMm ?? 0.35}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value > 0) {
                setShape('Change stroke width', {
                  stroke: { color: '#000000', ...node.stroke, widthMm: value },
                });
              }
            }}
          />
        </label>
        {node.shape === 'rect' && (
          <label className="field">
            Corner
            <input
              type="number"
              min={0}
              step={0.2}
              value={node.cornerRadiusMm ?? 0}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isFinite(value) && value >= 0) {
                  setShape('Change corner radius', { cornerRadiusMm: value });
                }
              }}
            />
          </label>
        )}
      </div>

      <div className="field-row">
        <label className="field">
          Fill
          <input
            type="color"
            value={node.fill?.color ?? '#ffffff'}
            onChange={(e) => setShape('Change fill', { fill: { color: e.target.value } })}
          />
        </label>
        <button onClick={() => setShape(node.fill ? 'Clear fill' : 'Restore fill', { fill: null })}>
          No fill
        </button>
      </div>
    </>
  );
}

function PanelFields({
  api,
  node,
  theme,
  assets,
  onSelectionChange,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'panel' }>;
  theme: Theme;
  assets: AssetsApi;
  onSelectionChange: (ids: NodeId[]) => void;
}) {
  const { commit, document: doc, newId } = api;
  const cellFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingCellIndex, setPendingCellIndex] = useState<number | null>(null);
  const [cellUploadError, setCellUploadError] = useState<string | null>(null);

  // Only plots and images take cells; a scale bar or an arrow is parented to
  // the tile it annotates, not to the panel, so it is not one of them.
  const tiles = childrenOf(doc.nodes, node.id).filter((c) => c.type === 'plot' || c.type === 'image');
  const tileCount = tiles.length;
  const grid = node.contentGrid ?? { rows: 1, cols: Math.max(1, tileCount), gutterMm: 1 };
  // A montage can be created empty (Stage 2's "Add empty montage") and filled
  // in one cell at a time, so the tile controls must show for a declared grid
  // even before it has any children — not only once there is "something to
  // tile" in the usual multi-image-import sense.
  const isMontage = tileCount > 1 || node.contentGrid !== undefined;

  const setGrid = (patch: Partial<typeof grid>): void => {
    commit('Change tile grid', (draft) => {
      const target = draft.nodes[node.id];
      if (target?.type !== 'panel') return;
      target.contentGrid = { ...grid, ...patch };
      // Changing the grid changes the shape the tiles want, so re-fit before
      // re-tiling. A hand-set rows/cols is respected — `fitMontageToImages`
      // fits the panel's *shape* and never rewrites the arrangement.
      fitMontageToImages(draft, node.id);
      // Re-tile immediately: the frames are stored on the children, so an
      // unapplied grid is a setting that claims an arrangement the figure does
      // not have.
      resizePanel(draft, node.id, target.frame);
      reflowGroupLabels(draft);
    });
  };

  /**
   * Turn auto-fitting on or off for this montage.
   *
   * Off clears `aspectLock` back to null, which is what restores free manual
   * resize — leaving the lock behind would keep constraining a drag the author
   * has just said they want to do by hand.
   */
  const setAutoFit = (on: boolean): void => {
    commit(on ? 'Fit montage to images' : 'Stop fitting montage', (draft) => {
      const target = draft.nodes[node.id];
      if (target?.type !== 'panel' || !target.contentGrid) return;
      target.contentGrid = { ...target.contentGrid, autoFit: on };
      if (on) {
        fitMontageToImages(draft, node.id);
      } else {
        target.aspectLock = null;
      }
      resizePanel(draft, node.id, target.frame);
      reflowGroupLabels(draft);
    });
  };

  /**
   * One size for every label in this montage — the requested single edit.
   *
   * Covers each tile's own caption *and* any heading spanning the panel, since
   * a montage whose row heading is a different size from its pane captions is
   * exactly the inconsistency this exists to remove.
   */
  const setAllLabelSizes = (sizePt: number): void => {
    commit('Set montage label size', (draft) => {
      const tileIds = new Set(montageTiles(draft.nodes, node.id).map((t) => t.id));
      for (const candidate of Object.values(draft.nodes)) {
        if (candidate.type !== 'group-label') continue;
        const labelsThisMontage = candidate.memberIds.every(
          (id) => tileIds.has(id) || id === node.id,
        );
        if (!labelsThisMontage) continue;
        candidate.style = { ...candidate.style, fontSizePt: sizePt };
      }
      const target = draft.nodes[node.id];
      if (target?.type === 'panel') {
        fitMontageToImages(draft, node.id);
        resizePanel(draft, node.id, target.frame);
      }
      reserveLayoutSpace(draft);
      reflowGroupLabels(draft);
    });
  };

  /** Sizes currently in use across this montage's labels, for the readout. */
  const montageLabelSizes = (() => {
    const tileIds = new Set(childrenOf(doc.nodes, node.id).map((t) => t.id));
    const sizes = new Set<number>();
    for (const candidate of Object.values(doc.nodes)) {
      if (candidate.type !== 'group-label') continue;
      if (!candidate.memberIds.every((id) => tileIds.has(id) || id === node.id)) continue;
      sizes.add(candidate.style?.fontSizePt ?? theme.type.annotationPt);
    }
    return [...sizes];
  })();

  const requestCellUpload = (index: number): void => {
    setPendingCellIndex(index);
    setCellUploadError(null);
    cellFileInputRef.current?.click();
  };

  // Tiles that already carry a caption of their own, so the button offering
  // to add one disappears rather than silently making a second heading over
  // the same tile — two captions in one place, stacked, is never wanted.
  const labelledTileIds = new Set(
    Object.values(doc.nodes)
      .filter((n) => n.type === 'group-label' && n.memberIds.length === 1)
      .map((n) => (n as Extract<FigureNode, { type: 'group-label' }>).memberIds[0]!),
  );

  /**
   * Caption one tile, through the same `addGroupLabel` the Toolbar's own
   * "Add group title" uses — a caption is a group of one member, so this
   * needs no second mechanism. The same-panel branch re-tiles rather than
   * pushing siblings: the clearance is a grid gutter here, which
   * `fillPanelChildren` recomputes live.
   */
  const addTileLabel = (tileId: NodeId): void => {
    commit('Label montage cell', (draft) => {
      const label = addGroupLabel(draft, newId, {
        memberIds: [tileId],
        edge: 'top',
        title: 'Cell title',
        // Matches the tick labels and annotations around it — see the
        // Toolbar's own "Add group title".
        fontSizePt: theme.type.annotationPt,
      });
      if (!label) return;
      const target = draft.nodes[node.id];
      if (target?.type === 'panel') fillPanelChildren(draft, target.id, target.frame);
      reflowGroupLabels(draft);
      reflowBrackets(draft, theme);
      // Select it, as the Toolbar's own "Add group title" does: the very next
      // thing an author wants is to replace the placeholder title.
      onSelectionChange([label.id]);
    });
  };

  const onCellFileChosen = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0] ?? null;
    e.target.value = '';
    const cellIndex = pendingCellIndex;
    setPendingCellIndex(null);
    if (!file || cellIndex === null) return;

    try {
      const imported = await importImage(file);
      const assetId = newId();
      // Bytes before the commit, the same order `importImageFiles` uses: a
      // document referencing an asset the store has never seen renders a
      // placeholder.
      assets.store.add(assetId, imported.bytes);
      commit(`Set montage cell ${cellIndex + 1}`, (draft) => {
        addAsset(draft, {
          id: assetId,
          filename: imported.filename,
          mimeType: imported.bytes.mimeType,
          byteLength: imported.bytes.original.length,
          naturalPx: imported.naturalPx,
        });
        setMontageCellImage(draft, newId, node.id, cellIndex, {
          assetId,
          naturalPx: imported.naturalPx ?? { width: 0, height: 0 },
        });
        reflowGroupLabels(draft);
        reflowBrackets(draft, theme);
      });
    } catch (error) {
      setCellUploadError(String(error));
    }
  };

  return (
    <>
      <div className="field-row">
        <label className="field">
          Background
          <input
            type="color"
            value={node.background?.color ?? '#ffffff'}
            onChange={(e) =>
              commit('Change panel background', (draft) => {
                const target = draft.nodes[node.id];
                if (target?.type === 'panel') target.background = { color: e.target.value };
              })
            }
          />
        </label>
        <label className="field">
          Padding
          <input
            type="number"
            min={0}
            step={0.5}
            value={node.paddingMm}
            onChange={(e) =>
              commit('Change panel padding', (draft) => {
                const target = draft.nodes[node.id];
                if (target?.type === 'panel') target.paddingMm = Math.max(0, Number(e.target.value));
              })
            }
          />
        </label>
      </div>

      {node.background && (
        <button
          onClick={() =>
            commit('Clear panel background', (draft) => {
              const target = draft.nodes[node.id];
              if (target?.type === 'panel') target.background = null;
            })
          }
        >
          Clear background
        </button>
      )}

      {/* Only where there is something to tile, or a declared grid waiting to
          be filled. A one-child panel with no grid at all has nothing to
          speak of, and offering rows and columns for it would suggest the
          single image is being placed in a cell rather than filling the panel. */}
      {isMontage && (
        <>
          <h4>Tiles</h4>
          <div className="field-row">
            <label className="field">
              Rows
              <input
                type="number"
                min={1}
                max={Math.max(tileCount, grid.rows, 12)}
                value={grid.rows}
                onChange={(e) => setGrid({ rows: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
            <label className="field">
              Columns
              <input
                type="number"
                min={1}
                max={Math.max(tileCount, grid.cols, 12)}
                value={grid.cols}
                onChange={(e) => setGrid({ cols: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
            <label className="field">
              Gutter
              <input
                type="number"
                min={0}
                step={0.5}
                value={grid.gutterMm}
                onChange={(e) => setGrid({ gutterMm: Math.max(0, Number(e.target.value)) })}
              />
            </label>
          </div>
          <p className="hint">
            {tileCount} tiles in {grid.rows} × {grid.cols}
            {grid.rows * grid.cols < tileCount
              ? ' — too few cells, so the extra tiles keep their current size rather than stacking invisibly at the origin.'
              : '. Tiles fill cells in stacking order; use the Layers list to reorder them. Each keeps its own crop, scale bar and annotations.'}
          </p>

          <label className="check">
            <input
              type="checkbox"
              checked={grid.autoFit ?? false}
              onChange={(e) => setAutoFit(e.target.checked)}
            />
            Fit panel shape to the images
          </label>
          <p className="hint">
            {grid.autoFit ?? false
              ? 'The panel is kept at the shape that lets every picture fill its cell, so no space is wasted letterboxing. Resizing by hand keeps that shape; turn this off to reshape freely.'
              : 'Off: tiles letterbox inside whatever shape the panel happens to be. Turning it on sizes the panel to the pictures.'}
          </p>

          {/* One size for every label in the montage — the pane captions and
              any heading spanning the panel — so they cannot drift apart. */}
          <div className="field-row">
            <label className="field">
              Label size (pt)
              <input
                type="number"
                min={4}
                max={24}
                step={0.5}
                value={montageLabelSizes.length === 1 ? montageLabelSizes[0] : theme.type.annotationPt}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value > 0) setAllLabelSizes(value);
                }}
              />
            </label>
          </div>
          <p className="hint">
            {montageLabelSizes.length === 0
              ? 'No labels on this montage yet. Add one from a tile, or from “Label cell” below.'
              : montageLabelSizes.length === 1
                ? 'Every label in this montage is this size. Changing it here changes all of them at once.'
                : `Labels here are currently ${[...montageLabelSizes].sort((a, b) => a - b).join(', ')} pt — set a value to make them all match.`}
          </p>

          {/* One button per declared cell, addressed by the same z-order index
              `fillPanelChildren` tiles into — so an author can fill an empty
              montage one cell at a time, or replace a tile in place, without
              leaving the Inspector. A cell beyond the current tile count is
              always "the next empty slot": there is no way to leave a gap in
              the middle of a z-ordered grid, so every still-empty button
              really does add to the same place. */}
          <div className="field-row" style={{ flexWrap: 'wrap' }}>
            {Array.from({ length: grid.rows * grid.cols }, (_, index) => {
              const occupant = tiles[index];
              return (
                <button key={index} type="button" onClick={() => requestCellUpload(index)}>
                  {occupant ? `Replace cell ${index + 1} (${occupant.name})` : `Upload to cell ${index + 1}`}
                </button>
              );
            })}
          </div>

          {/* A label over one tile is the same `GroupLabelNode` mechanism a
              heading over several uses — a caption is a group of one — so this
              is a shortcut to the Toolbar's own action rather than a second
              kind of label. Offered per cell because that is how it is
              wanted: each pane titled, under whatever heading spans the row.
              `groupLabelExtentMm` is what keeps the two from colliding. */}
          {tiles.length > 0 && (
            <>
              <div className="field-row" style={{ flexWrap: 'wrap' }}>
                {tiles.map((tile, index) =>
                  labelledTileIds.has(tile.id) ? null : (
                    <button key={tile.id} type="button" onClick={() => addTileLabel(tile.id)}>
                      Label cell {index + 1}
                    </button>
                  ),
                )}
              </div>
              <p className="hint">
                A cell&rsquo;s own label sits directly above it, under any heading
                spanning the whole row. The row grows to hold both.
              </p>
            </>
          )}
          <input
            ref={cellFileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            style={{ display: 'none' }}
            onChange={(e) => void onCellFileChosen(e)}
          />
          {cellUploadError && <p className="hint error">{cellUploadError}</p>}
        </>
      )}
    </>
  );
}
