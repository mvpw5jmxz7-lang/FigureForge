/**
 * Scene nodes.
 *
 * Nodes live in a FLAT map keyed by id, each carrying a `parentId`, rather than
 * in a nested tree. Immutable updates then touch exactly one entry, and
 * reparenting or z-reordering never has to restructure anything.
 *
 * Every frame is in millimetres and relative to the parent's frame (or to the
 * page, for top-level nodes).
 */

import type { PointMm, RectMm } from './geometry.js';

export type NodeId = string;
export type LayerId = string;
export type DatasetId = string;
export type AnalysisId = string;
export type AssetId = string;

export interface NodeBase {
  id: NodeId;
  name: string;
  parentId: NodeId | null;
  layerId: LayerId;
  /** Relative to the parent node's frame, or to the page when parentId is null. */
  frame: RectMm;
  /** Degrees clockwise about the frame centre. */
  rotation: number;
  opacity: number;
  locked: boolean;
  hidden: boolean;
  /** Sort order among siblings; low draws first. */
  z: number;
}

// ---------------------------------------------------------------------------
// Presentation primitives
// ---------------------------------------------------------------------------

export interface Stroke {
  color: string;
  /** Millimetres. Journals specify hairlines in pt, so convert on the way in. */
  widthMm: number;
  dash?: readonly number[];
  cap?: 'butt' | 'round' | 'square';
}

export interface Fill {
  color: string;
  opacity?: number;
}

export interface TextStyle {
  fontFamily?: string;
  /** Points — journal-native. Converted to mm at render time. */
  fontSizePt?: number;
  fontWeight?: 'normal' | 'bold';
  fontStyle?: 'normal' | 'italic';
  color?: string;
  /** Multiple of font size. */
  lineHeight?: number;
  align?: 'start' | 'middle' | 'end';
  baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic';
  letterSpacingPt?: number;
}

// ---------------------------------------------------------------------------
// Node variants
// ---------------------------------------------------------------------------

/** A figure panel: the container that holds a plot or an image. */
export interface PanelNode extends NodeBase {
  type: 'panel';
  /** Panel letter ('a', 'b', …). Null suppresses the label. */
  label: string | null;
  /** Aspect ratio (w/h) the auto-layout engine must preserve, if any. */
  aspectLock: number | null;
  background: Fill | null;
  border: Stroke | null;
  /** Space between the panel frame and its plot area. */
  paddingMm: number;
  /**
   * Placement within a layout template's grid, when one is applied. Persisted
   * so re-running the layout keeps the arrangement instead of falling back to
   * an equal grid. Optional: it post-dates SCHEMA_VERSION 1.
   */
  slot?: { row: number; col: number; rowSpan?: number; colSpan?: number } | null;
  /**
   * Tile this panel's content children into a grid instead of stacking them.
   *
   * Absent means the single-child rule every panel has always had: each plot or
   * image fills the whole frame. That was not a rule so much as an assumption —
   * two images in one panel came out perfectly coincident, with only the
   * highest z visible — and it is what a montage needs replaced.
   *
   * Children take cells in `z` order, which is the order the Layers list shows
   * and the order `reorderNode` already lets an author change.
   */
  contentGrid?: { rows: number; cols: number; gutterMm: number };
}

export type PlotType =
  | 'bar'
  | 'dot'
  | 'bar-dot'
  | 'scatter'
  | 'line'
  | 'box'
  | 'violin'
  | 'beeswarm'
  | 'histogram'
  | 'volcano'
  | 'heatmap'
  | 'survival';

/**
 * The plot types whose x axis is a numeric scale rather than a band of
 * categories. Kept here beside the union so the renderer, the model defaults and
 * the UI cannot drift on which is which.
 *
 * `survival` belongs here on the same grounds as `volcano`: time is a real
 * numeric axis with ticks to draw, even though — like volcano's differential
 * data — its geometry is built through a dedicated path
 * (`toSurvivalGroups`/`kaplanMeier`) rather than the generic `toSeries`+
 * `xyMarks` route `continuousGeometry` uses for scatter/line/histogram.
 * Membership here is what gives it numeric x ticks by default (`addPlot`) and
 * what blocks ordinary group-comparison tests in the Stats tab in favour of
 * the log-rank allow-list, for free, through the same mechanism volcano
 * already relies on.
 */
export const CONTINUOUS_X_PLOT_TYPES: ReadonlySet<PlotType> = new Set<PlotType>([
  'scatter',
  'line',
  'histogram',
  'volcano',
  'survival',
]);

/**
 * The plot types drawn as a dense row×column grid rather than marks against
 * an axis — neither dimension is a value axis, so these are excluded from
 * `CONTINUOUS_X_PLOT_TYPES` and from the categorical band-scale path both.
 * Kept as its own registry for the same reason `CONTINUOUS_X_PLOT_TYPES` is:
 * one place that says which types are which.
 */
export const GRID_PLOT_TYPES: ReadonlySet<PlotType> = new Set<PlotType>(['heatmap']);

/** Which side of a significance threshold a volcano point falls on. */
export type VolcanoCategory = 'up' | 'down' | 'ns';

export interface VolcanoThresholds {
  /** |log2 fold change| at or above which a point counts as up/down. */
  foldChange: number;
  /** p-value at or below which a point counts as significant. */
  pValue: number;
  /**
   * FDR/q-value cutoff, read only when `significanceBy` is `'fdr'` and the
   * dataset supplies a q-value column (`Series.qValues`). Absent alongside
   * `significanceBy: 'fdr'` disables the FDR gate rather than defaulting it —
   * there is no safe default cutoff to guess.
   */
  fdr?: number;
  /**
   * Which cutoff decides the significance gate. Absent/`'p-value'` is today's
   * behaviour: only `pValue` (and `foldChange`) are consulted. `'fdr'` reads
   * `fdr` against each point's `qValue` instead — the fold-change cutoff
   * still decides up vs. down either way.
   */
  significanceBy?: 'p-value' | 'fdr';
}

/**
 * Declared here, beside the type, rather than in `packages/plots`: `doc-model`
 * imports nothing internal, so `operations.ts`'s `addPlot` — which sets this as
 * a new volcano plot's starting point — cannot reach across to `plots` for it.
 * `packages/plots/src/volcano.ts` imports this one rather than declaring a
 * second copy.
 */
export const DEFAULT_VOLCANO_THRESHOLDS: VolcanoThresholds = { foldChange: 1, pValue: 0.05 };

/**
 * A Perseus-style permutation (SAM) significance boundary: the two branches of
 * the curve, sampled as `(log2 fold change, -log10 p)` pairs.
 *
 * Named here rather than left inline on `PlotNode` so `packages/plots` can
 * take one as a parameter — the same reason `VolcanoThresholds` is declared in
 * this file and re-exported from `plots/volcano.ts` rather than duplicated.
 * Sample order is not guaranteed: the service emits whatever order its sweep
 * produced, and every consumer sorts for itself.
 */
export interface VolcanoSamCurve {
  readonly up: readonly { x: number; y: number }[];
  readonly down: readonly { x: number; y: number }[];
}

/**
 * What the volcano test was run with, and what it resolved to — the record
 * that lets a figure's significance boundary be described in a methods
 * section rather than only drawn.
 *
 * The parameters and the sentence sit side by side, which is the shape
 * `StatResult` already has (`comparisons` beside `methodsSentence`). It is one
 * fact stored in two forms, not two derivations that can disagree: the
 * sentence is composed once, by the service, beside the numbers it describes,
 * and is never recomputed here.
 */
export interface VolcanoTestRecord {
  /** S0, the regularization constant added to each feature's standard error. */
  s0: number;
  /** The FDR the author asked for, as a percentage. */
  fdrPercent: number;
  /** The FDR actually reached, as a fraction — usually below the target. */
  fdrAchieved: number;
  deltaUsed: number;
  /**
   * The two resolved cutoffs on the SAM statistic `d`.
   *
   * Stored separately, and **not** as one magnitude, because they are
   * genuinely independent: SAM walks inward from each tail against its own
   * side of the permutation null, so they coincide only when the data is
   * symmetric. Each branch's asymptote sits at `cut * s0`, so the visible gap
   * between them grows with S0 — which is what makes recording both worth the
   * two fields.
   */
  cutUp: number;
  cutLow: number;
  mode: 'two-sample' | 'one-sample';
  nTested: number;
  nUp: number;
  nDown: number;
  /** Ready-to-paste manuscript sentence, generated by the service. */
  methodsSentence: string;
}

/**
 * Whether a heatmap's colour domain is the raw `[min, max]` of its cells, or
 * symmetric around zero (`[-max(|min|,|max|), max(|min|,|max|)]`) — the
 * standard reading for a correlation matrix or a log-fold-change matrix,
 * where zero is a meaningful midpoint rather than an arbitrary one.
 *
 * `'sequential'` is the default: it is the safer reading when the author
 * hasn't said whether zero means anything, the same reasoning that leaves
 * every other optional on/off field in this file defaulting to the more
 * literal behaviour.
 */
export type HeatmapScaleMode = 'sequential' | 'diverging';

export type ErrorBarKind = 'none' | 'sd' | 'sem' | 'ci95' | 'range' | 'iqr';

/** Marker shapes. Enough to tell eight series apart in greyscale. */
export type PointShape =
  | 'circle'
  | 'square'
  | 'triangle'
  | 'triangle-down'
  | 'diamond'
  | 'pentagon'
  | 'cross'
  | 'star';

export const POINT_SHAPES: readonly PointShape[] = [
  'circle',
  'square',
  'triangle',
  'triangle-down',
  'diamond',
  'pentagon',
  'cross',
  'star',
];

/** Connecting-line stroke styles for `line` plots. */
export type LineStyle = 'solid' | 'dashed' | 'dotted' | 'dash-dot';

export const LINE_STYLES: readonly LineStyle[] = ['solid', 'dashed', 'dotted', 'dash-dot'];

/** Stroke styles for `PlotNode.showGridlines`'s reference lines. */
export type GridlineStyle = 'solid' | 'dashed' | 'dotted';

export const GRIDLINE_STYLES: readonly GridlineStyle[] = ['solid', 'dashed', 'dotted'];

export type CenterKind = 'mean' | 'median';

/**
 * How a numeric tick prints.
 *
 *   'auto'        today's `formatTick` exactly — significant figures, an
 *                 en-dash minus, and an ×10^n fallback outside 1e-3…1e5.
 *   'plain'       never exponential, regardless of magnitude.
 *   'scientific'  always mantissa × 10ⁿ, with a real superscript exponent.
 *   'power10'     10ⁿ alone, for a log/symlog axis whose ticks are decades. A
 *                 tick that is not itself a clean power of ten falls back to
 *                 'scientific' — a bare exponent would misstate it.
 *
 * Absent reads as 'auto', which routes through the unchanged `formatTick`, so
 * every figure saved before this existed is byte-identical.
 */
export type LabelFormat = 'auto' | 'plain' | 'scientific' | 'power10';

export interface AxisSpec {
  title: string;
  /** Null on either bound means "derive from data". */
  min: number | null;
  max: number | null;
  /** Null means "choose a readable tick step". */
  tickStep: number | null;
  scale: 'linear' | 'log10' | 'symlog';
  showLine: boolean;
  showTicks: boolean;
  showLabels: boolean;
  /** Draw the axis line only across the data range, Tufte-style. */
  trimToData: boolean;
  /**
   * Unlabelled subdivisions between major ticks, or 0/undefined for none.
   * The count is *divisions*, so 5 draws four minor ticks per interval.
   */
  minorTicks?: number;
  /** Ticks point away from the plot by default, as most journals draw them. */
  tickDirection?: 'out' | 'in';
  /**
   * Ranges cut out of the axis, drawn with the conventional break marks.
   *
   * Linear scales only: a broken log axis compounds two different kinds of
   * compression in one line, and there is no honest way to read it. Values
   * falling inside a break are *dropped*, never clamped to its edge — a mark
   * pinned to the break would be read as data at that value.
   */
  breaks?: readonly { from: number; to: number }[];
  /** See `LabelFormat`. Absent is 'auto'. */
  labelFormat?: LabelFormat;
  /** Fixed decimal places for 'plain'/'scientific'. Absent derives from the
   *  tick step, the same rule 'auto' already uses. */
  labelDecimals?: number;
  /**
   * A symlog axis's linear-region half-width: `|v| ≤ linthresh` maps linearly,
   * beyond it the axis is log-shaped on each side of zero. Symlog only.
   *
   * Absent auto-derives (see `packages/plots`' `defaultLinthresh`) rather than
   * storing a computed default — unlike `log10`'s threshold, which decides
   * which *data* are dropped, this is purely presentational, so an unhelpful
   * auto value is cosmetic and this field is the one-field fix rather than a
   * value that would need recomputing as the data changes.
   */
  linthresh?: number;
  /**
   * Drop a mark whose value falls outside `min`/`max` rather than letting it
   * draw past the plot rectangle. Absent/false is today's behaviour: a scale
   * extrapolates for an out-of-domain input, so a point outside the declared
   * range currently overflows the panel uncontained.
   *
   * Meaningless with both `min` and `max` absent — there is no range to clip
   * to — so the Inspector hides the control until at least one is set, and
   * `continuousGeometry` re-checks the same condition before threading this
   * through, so a hand-edited file that sets it with no bounds is a true
   * no-op rather than clipping against the auto-derived, padded domain.
   *
   * Continuous plot types only (scatter/line/volcano) — the ones whose marks
   * are built by `xyMarks`. A histogram's x is bin edges and its y a derived
   * count, and survival's y is hardcoded to `[0, 1]` and never reads this;
   * neither goes through `xyMarks`.
   */
  clipToRange?: boolean;
}

export interface PlotNode extends NodeBase {
  type: 'plot';
  plotType: PlotType;
  datasetId: DatasetId;
  /** Column names from the dataset; meaning depends on plotType. */
  encoding: {
    x?: string;
    y?: string;
    group?: string;
    /** Replicate columns collapsed into a single series. */
    valueColumns?: readonly string[];
  };
  x: AxisSpec;
  y: AxisSpec;
  center: CenterKind;
  errorBars: ErrorBarKind;
  /** Overlay individual replicate points on summary plots. */
  showPoints: boolean;
  pointSizeMm: number;
  jitterMm: number;
  barWidthFraction: number;
  /** Palette id from the theme, or explicit per-series colours. */
  palette: string | readonly string[];
  /**
   * Draw replicate points in their series colour rather than the theme's
   * foreground.
   *
   * Bars default to dark points over a coloured bar, which is conventional and
   * legible — but it means recolouring a series visibly changes the bar and not
   * the dots. Opt-in rather than default, so existing figures do not change.
   */
  pointsUseSeriesColor?: boolean;
  /**
   * Histogram bin count. Unset means Freedman–Diaconis chooses, which is the
   * right default at the sample sizes this tool sees — but bin count changes
   * the shape a reader takes away, so it has to be overridable.
   */
  histogramBins?: number;
  /**
   * Whether an error bar is drawn on both sides of the centre.
   *
   * `'up'` reproduces the bar-chart convention of hiding the lower half under
   * the bar. It reads cleanly and states half of what was measured, so `'both'`
   * is the default and `'up'` is the deliberate choice.
   */
  errorBarDirection?: 'both' | 'up';
  /** Replicate marker shape. Circles unless asked otherwise. */
  pointShape?: PointShape;
  /**
   * Marker shape per series, overriding `pointShape` for the ones it names.
   *
   * Indexed by series *order*, the same key `seriesAxis` and the palette array
   * use — so it needs no names and cannot go stale when a series is renamed. A
   * missing or empty entry falls back to `pointShape`, which keeps a plot that
   * sets only the plot-wide shape rendering exactly as it did.
   *
   * Distinct symbols are what carries the series identity when colour cannot:
   * in greyscale print, and for a reader with a colour-vision deficiency. That
   * makes this redundant encoding rather than decoration, which is why the
   * legend draws the shape rather than a plain swatch once it is set.
   */
  pointShapes?: readonly (PointShape | null)[];
  /** Marker interior. Unset keeps the series/foreground rule in the renderer. */
  pointFill?: string;
  /** Marker outline. Unset draws no outline, as before. */
  pointStroke?: Stroke;
  /**
   * Connecting-line stroke style for `line` plots. Solid unless asked
   * otherwise — absent renders byte-identical to `'solid'`. See
   * `dashArrayFor` in `packages/render`, which is where this actually turns
   * into a dash pattern.
   */
  lineStyle?: LineStyle;
  /**
   * Line style per series, overriding `lineStyle` for the ones it names.
   *
   * Indexed by series *order*, the same key `pointShapes`, `seriesAxis` and
   * the palette array use — so it needs no names and cannot go stale when a
   * series is renamed. A missing or empty entry falls back to `lineStyle`,
   * which keeps a plot that sets only the plot-wide style rendering exactly
   * as it did.
   *
   * A second way (besides `pointShapes`) to carry series identity where
   * colour cannot — in greyscale print, and for a reader with a
   * colour-vision deficiency — which is why the legend draws the actual dash
   * pattern rather than a plain swatch once it is set.
   */
  lineStyles?: readonly (LineStyle | null)[];
  /**
   * A second y axis on the right, and which series read it.
   *
   * `seriesAxis` is indexed the same way as the palette — by series order — so
   * it needs no names and cannot go stale when a series is renamed. Absent or
   * `'y'` means the left axis, which is what every existing figure has.
   */
  y2?: AxisSpec;
  seriesAxis?: readonly ('y' | 'y2')[];
  /**
   * Where the series key is drawn, or `'none'`.
   *
   * Absent means `'auto'`: shown when there is a second factor to name and
   * withheld otherwise. A single-series plot needs no legend — the axis title
   * already says what is plotted — and a key repeating what the category labels
   * spell out underneath is furniture, not information.
   */
  legend?: 'auto' | 'right' | 'bottom' | 'none';
  /**
   * Which physical edge the categorical axis draws against.
   *
   * `'vertical'` (absent, today's only behaviour) runs categories along the
   * bottom and the value axis up the left, bars growing upward. `'horizontal'`
   * runs categories down the left and the value axis along the bottom, bars
   * growing rightward. `node.x` stays "the categorical spec" and `node.y`
   * stays "the numeric spec" either way — orientation only changes which edge
   * each is drawn against, never which one is which.
   *
   * Categorical plot types only (`bar`/`dot`/`bar-dot`/`box`/`violin`/
   * `beeswarm`) — a continuous or grid plot has no category axis to flip.
   * Significance brackets have nowhere flat to anchor on a horizontal plot,
   * so `measurePlot` refuses them the same way it already does on a
   * continuous plot, and the Stats tab disables comparisons with a reason.
   */
  orientation?: 'vertical' | 'horizontal';
  /**
   * Draw the error interval as a filled band rather than as bars.
   *
   * Line plots only, and only where a series carries several y values at one x
   * to compute an interval from. On anything else there is no band to draw and
   * the setting is ignored rather than approximated.
   */
  errorDisplay?: 'bars' | 'band';
  /**
   * Draw every replicate behind the summarised means.
   *
   * Only where replicates were collapsed in the first place — a plot showing one
   * point per observation is already showing them. Prism's own advice for this
   * table shape is to plot each replicate as a first step, because a mean with
   * an interval hides how many measurements it rests on and whether they agree.
   */
  showReplicates?: boolean;
  /**
   * Gap between the bars within one group, as a fraction of the sub-band pitch.
   *
   * Two-factor plots only — a single-factor one has nothing inside a category to
   * space. Absent is `DEFAULT_BAR_GAP_FRACTION`, the literal this replaced, so
   * every existing figure draws exactly as it did.
   */
  barGapFraction?: number;
  /**
   * Gap between one category slot and the next. On a single-factor plot that is
   * the gap between the bars themselves, since there each bar owns a category.
   *
   * Absent is `DEFAULT_GROUP_GAP_FRACTION`. Note this changes the slot a
   * category label has to fit in, so widening it can stand a rotated label back
   * upright — correct, and safe because the geometry is built in exactly two
   * passes rather than converged to.
   */
  groupGapFraction?: number;
  /**
   * Fold-change and p-value cutoffs a volcano plot classifies points against.
   *
   * Absent is `DEFAULT_VOLCANO_THRESHOLDS` (see `packages/plots`). Volcano
   * only — every other plot type ignores it.
   */
  volcanoThresholds?: VolcanoThresholds;
  /** Colour per significance category. Absent falls back to the renderer's default. */
  volcanoColors?: Record<VolcanoCategory, string>;
  /**
   * Whether the fold-change/p-value cutoff lines are drawn.
   *
   * Absent is `'show'` — a string enum rather than a boolean, matching every
   * other optional on/off field on this node (`errorDisplay`, `legend`), since
   * no optional boolean here defaults to `true` when absent.
   */
  volcanoThresholdLines?: 'show' | 'hide';
  /**
   * Whether the dataset's significance column already holds `-log10(p)`
   * rather than a raw p-value — the common shape a Perseus/Prism export
   * already computed and printed as `-LOG10(P-VALUE)`.
   *
   * Absent/`false` is today's behaviour: the column is treated as a raw p
   * and transformed once, here, into the space the axis and classification
   * both read. Fed an already-transformed column, that transform is not
   * skippable — a value like `2.14` re-transforms to a *negative* `-log10`,
   * which classifies as never-significant and usually plots as a squashed
   * sliver near the axis. `true` uses the column exactly as entered, with no
   * transform and no `Number.MIN_VALUE` substitution (both are meaningless
   * once the column is already in log space). Volcano only.
   */
  volcanoPValueIsNegLog10?: boolean;
  /**
   * A Perseus-style permutation (SAM) significance boundary, drawn as two
   * dashed curves in place of the straight fold-change/p-value cutoff lines.
   *
   * Set once, at creation, by the "Run volcano test (Perseus-style)" action
   * (`SidePanel.tsx`) — there is no live link back to the replicate matrix it
   * was computed from, the same scope PCA/UMAP already settled on. Volcano
   * only, and only ever present alongside a dataset whose 4th column is a
   * q-value this curve corresponds to.
   *
   * **When present it also decides the point colours**, in place of
   * `volcanoThresholds` — see `volcanoCurveClassifier` in `packages/plots`,
   * where the equivalence between "above this curve" and the test's own
   * verdict is derived. A plot whose drawn boundary and whose colours came
   * from two different rules disagreed with the test on 47 of 100 proteins.
   */
  volcanoSamCurve?: VolcanoSamCurve;
  /**
   * The volcano test's own parameters and methods sentence, when this plot was
   * created by one. Read by nothing in `packages/render` — it is a record for
   * the author, surfaced in the Stats tab beside every other methods sentence.
   */
  volcanoTest?: VolcanoTestRecord;
  /**
   * Which points carry a drawn name, keyed on the LABEL STRING rather than a
   * row index.
   *
   * A row index is the wrong key twice over: the data grid can insert, delete
   * and reorder rows, and `numericPairsAt` drops any row with a missing
   * label, fold change or p-value — so a dataset row index and a series
   * point index are already different numbers. A label is the identity the
   * author actually selected, and it survives both.
   *
   * A duplicate label (two probes for one gene) labels *every* matching
   * point, not the first — labelling one of two identically-named points
   * draws a name beside a point the reader cannot distinguish from the
   * unlabelled one, which is a false attribution rather than a missing one.
   *
   * Deliberately not capped in the schema: `loadArchive` throws on a
   * validation failure, so a `.max(25)` here would make a hand-edited file
   * unopenable. The cap is enforced in the UI and, as a backstop, by
   * `layoutPointLabels` truncating in a defined order. Volcano only.
   */
  volcanoLabels?: readonly string[];
  /**
   * Manual displacement of a placed point label from where `layoutPointLabels`
   * put it, keyed by label TEXT — the same key `volcanoLabels` uses, so two
   * identically-named points share one offset, the same accepted limitation
   * they already share one auto-placement slot and one colour under.
   *
   * A delta on top of a freshly recomputed auto placement, not an absolute
   * position — the same "auto base, stored delta" split `BracketNode.userOffsetMm`
   * uses, so adding or removing other labels re-flows this one's neighbours
   * correctly rather than pinning it to a page position that could drift out
   * of sync with its point.
   *
   * Plot-area-local millimetres, the same space `LabelCandidate.x/y` use.
   * Volcano only.
   */
  pointLabelOffsets?: Readonly<Record<string, { x: number; y: number }>>;
  /**
   * Font size point labels draw at, in points. Absent falls back to
   * `theme.type.annotationPt`, the same "absent is the theme value" rule
   * every other themed role already follows. Volcano only.
   */
  pointLabelSizePt?: number;
  /** How a heatmap's colour domain is built. Absent is `'sequential'`. Heatmap only. */
  heatmapScale?: HeatmapScaleMode;
  /**
   * Colour stops the domain interpolates between: two for `'sequential'`
   * (low, high), three for `'diverging'` (low, mid, high). Absent uses the
   * renderer's themed default for the chosen mode.
   */
  heatmapStops?: readonly string[];
  /** Fill for a cell whose value is missing. Absent is a themed neutral grey. */
  heatmapMissingColor?: string;
  /**
   * Draw each cell's value centred in it. Skipped where the cell is too
   * small to hold the text legibly rather than overprinting it.
   */
  showCellValues?: boolean;
  /**
   * Draw a tick at each censored subject's point on the curve. Absent is
   * `true` — the opposite default from `showCellValues`/`showReplicates`,
   * since a censoring mark is what makes a Kaplan–Meier curve honest about
   * follow-up loss rather than a source of clutter to opt into. Survival only.
   */
  showCensorMarks?: boolean;
  /**
   * Draw a shaded confidence band around each survival curve. Absent is
   * `false` — with three or more arms, overlapping bands read as clutter
   * before they read as data, the same opt-in stance `showReplicates` takes.
   * Survival only.
   */
  showSurvivalCI?: boolean;
  /**
   * Vertical cascade/ridgeline offset in mm between adjacent series, applied
   * cumulatively by series order (series 2 sits `offsetStepMm` above series
   * 1, series 3 twice that, and so on).
   *
   * Deliberately millimetres, not a data quantity: the whole point of a
   * ridgeline is that the separation is not readable off the value axis, and
   * expressing it in data units would invite reading it as one. It also
   * survives an axis rescale unchanged. Absent or 0 draws exactly as today —
   * offered only for a line plot with more than one series (`isCascadable`
   * in `packages/render`).
   */
  offsetStepMm?: number;
  /**
   * Horizontal companion to `offsetStepMm`, for the reference figure's
   * sideways "3-D" displacement. Absent is 0 — a purely vertical stack — so
   * the sideways variant is opt-in.
   */
  offsetStepXMm?: number;
  /**
   * How a cascaded trace's area under it is drawn. Absent is `'none'`.
   * `'tint'`/`'solid'` are both fully opaque — a translucent fill that is
   * meant to occlude the traces behind it is a contradiction, and opacity
   * sidesteps the PostScript-alpha question this project already measured
   * once (see CLAUDE.md). Ignored unless an offset is actually set.
   */
  offsetFill?: 'none' | 'tint' | 'solid';
  /**
   * Draw a schematic depth axis beside a cascade: one tick per series,
   * labelled with the series name, and — per contiguous run of series
   * sharing a `category` (or the whole cascade when none has one) — an end
   * bracket and a group caption. Absent/false draws nothing extra, so an
   * existing cascade figure is untouched. Meaningless, and hidden by the
   * Inspector, unless a cascade offset is already in effect.
   */
  showCascadeAxis?: boolean;
  /**
   * Freeform caption for the cascade depth axis's single implicit group —
   * used only when no series carries a `category` at all (the common
   * single-group case), so there is one shared axis to caption rather than
   * per-series groups with their own name already. Ignored once any series
   * has a `category`, where each group is captioned by that category string
   * instead. e.g. "Concentration (mg/mL)".
   */
  cascadeAxisTitle?: string;
  /**
   * Close the axis into a full rectangle: draw the top and right lines the
   * default L-shaped axis omits, in the same stroke as the existing
   * left/bottom lines. Absent/false draws exactly as today.
   *
   * Meaningless on a heatmap, which draws no axis lines at all
   * (`GridPlotGeometry` has no numeric axis) — the Inspector hides the
   * control there, the same way it hides other controls a plot type cannot
   * honour.
   */
  boxed?: boolean;
  /**
   * Draw a light reference line at every visible tick of the value axis,
   * beneath the marks. Uses the exact tick list the axis itself draws, so a
   * gridline can never drift from the tick it belongs to. Absent/false draws
   * nothing extra.
   *
   * On a cascading line plot (see `hasCascadeOffset`), each line instead runs
   * diagonally from its front-axis tick to the matching position on the
   * back-most series' plane, that plane is closed as a wall (a flat line per
   * value tick continuing each diagonal, plus its top and right edges), and a
   * second copy of the axes — left value axis and bottom x axis, with ticks
   * but no labels — is drawn standing on it. Together that is the receding 3D
   * box from the reference figure this feature was built against, and all of
   * it is automatic whenever this and cascading are both true: none of it
   * depends on `boxed`, which is a separate rectangle drawn on request.
   *
   * Meaningless on a heatmap (no numeric axis) — the Inspector hides it there.
   */
  showGridlines?: boolean;
  /**
   * Stroke colour for `showGridlines`'s reference lines. Absent/`'grey'`
   * keeps today's exact muted blend between the theme's background and
   * foreground; `'black'` draws them in the theme's plain foreground colour
   * instead, for a grid that reads as a firmer reference rather than a faint
   * one. Never affects the back-axis copy on a cascading plot, which always
   * matches the front axis's own stroke, the same way a real axis would.
   */
  gridlineColor?: 'grey' | 'black';
  /**
   * Line style for `showGridlines`'s reference lines. Absent keeps today's
   * automatic choice — solid on an ordinary plot, dashed on a cascading one
   * (see `hasCascadeOffset`) — so an existing figure is unaffected; setting
   * this explicitly applies uniformly regardless of cascade state.
   * Deliberately narrower than `LineStyle` (no `'dash-dot'`): a reference
   * grid reads clearly in three styles, and a fourth adds choice without
   * adding clarity.
   */
  gridlineStyle?: GridlineStyle;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  assetId: AssetId;
  /** Intrinsic pixel size, used for the export resolution check. */
  naturalPx: { width: number; height: number };
  /** Crop in normalised source coordinates (0–1). */
  crop: { x: number; y: number; width: number; height: number };
  preserveAspect: boolean;
}

export interface TextNode extends NodeBase {
  type: 'text';
  text: string;
  style: TextStyle;
}

/** Panel letter. Kept distinct from TextNode so the checker can audit it. */
export interface PanelLabelNode extends NodeBase {
  type: 'panel-label';
  text: string;
  style: TextStyle;
  /** Which panel this labels; drives auto-relettering. */
  panelId: NodeId;
}

export interface ShapeNode extends NodeBase {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'line';
  fill: Fill | null;
  stroke: Stroke | null;
  cornerRadiusMm?: number;
}

export interface ArrowNode extends NodeBase {
  type: 'arrow';
  /** Relative to this node's frame origin. */
  points: readonly PointMm[];
  stroke: Stroke;
  head: 'none' | 'triangle' | 'open';
  headSizeMm: number;
  tail: 'none' | 'triangle' | 'open';
}

/** Significance bracket linking two x positions above a plot. */
export interface BracketNode extends NodeBase {
  type: 'bracket';
  /** Set when generated from a statistical test; drives staleness checks. */
  analysisId: AnalysisId | null;
  /**
   * The plot this annotates. Held directly rather than joined through the
   * analysis, because re-running a test replaces the analysis record while the
   * bracket must still be findable by the plot it belongs to.
   *
   * Optional: documents written before this field existed simply lack it, which
   * keeps them loadable without a schema migration.
   */
  plotId?: NodeId | null;
  /**
   * How far the user dragged this bracket from its computed position.
   *
   * Stored as an offset rather than a "pinned" flag so a hand-adjusted bracket
   * still follows its bars when the plot is resized — pinning in absolute page
   * space would strand it exactly as an unrepositioned bracket is stranded.
   */
  userOffsetMm?: { x: number; y: number };
  /** Which comparison of the analysis this annotates, for repositioning. */
  comparisonIndex?: number;
  /** Clearance above the tallest datum this bracket was placed with. */
  gapMm?: number;
  /** Displayed annotation: 'ns', '*', '**', … or an explicit p-value string. */
  label: string;
  style: TextStyle;
  stroke: Stroke;
  /** Height of the downward ticks at each end. */
  tickMm: number;
}

/**
 * Where a scale bar's calibration came from.
 *
 * Provenance, not decoration: a bar drawn from a number the user guessed is a
 * false measurement in a published figure, and the quality checker has to be
 * able to tell that apart from one read out of the micrograph's own metadata.
 * `pixelsPerUnit` alone cannot say which it is.
 */
export type CalibrationSource = 'metadata' | 'manual' | 'measured' | 'unknown';

export interface ScaleBarNode extends NodeBase {
  type: 'scale-bar';
  /** Bar length in real-world units, e.g. 10 (µm). */
  length: number;
  unitLabel: string;
  /** Image pixels per real-world unit; ties the bar to the micrograph. */
  pixelsPerUnit: number;
  /**
   * Deprecated in the drawing path: `labelPosition: 'none'` is the single
   * authority on whether a label is drawn. Two fields meaning the same thing is
   * how a control ends up doing nothing because the *other* field is still off.
   * Kept because it is required in the schema, and removing it would be a
   * breaking change to save one boolean. `addScaleBar` keeps the two in step.
   */
  showLabel: boolean;
  style: TextStyle;
  fill: Fill;
  barHeightMm: number;
  labelPosition: 'above' | 'below' | 'none';
  /** Optional: post-dates SCHEMA_VERSION 1. Absent reads as 'unknown'. */
  calibrationSource?: CalibrationSource;
}

export interface GroupNode extends NodeBase {
  type: 'group';
}

export type FigureNode =
  | PanelNode
  | PlotNode
  | ImageNode
  | TextNode
  | PanelLabelNode
  | ShapeNode
  | ArrowNode
  | BracketNode
  | ScaleBarNode
  | GroupNode;

export type FigureNodeType = FigureNode['type'];

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

export type NodeMap = Record<NodeId, FigureNode>;

/** Direct children of `parentId`, in draw order. */
export function childrenOf(nodes: NodeMap, parentId: NodeId | null): FigureNode[] {
  return Object.values(nodes)
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.z - b.z);
}

/** Depth-first walk in draw order, starting from the roots. */
export function walk(
  nodes: NodeMap,
  visit: (node: FigureNode, depth: number) => void,
  parentId: NodeId | null = null,
  depth = 0,
): void {
  for (const child of childrenOf(nodes, parentId)) {
    visit(child, depth);
    walk(nodes, visit, child.id, depth + 1);
  }
}

export function ancestorsOf(nodes: NodeMap, id: NodeId): FigureNode[] {
  const chain: FigureNode[] = [];
  let current = nodes[id]?.parentId ?? null;
  // Guard against a cycle introduced by a malformed document.
  const seen = new Set<NodeId>([id]);
  while (current !== null && !seen.has(current)) {
    const node = nodes[current];
    if (!node) break;
    chain.push(node);
    seen.add(current);
    current = node.parentId;
  }
  return chain;
}

export function descendantsOf(nodes: NodeMap, id: NodeId): FigureNode[] {
  const out: FigureNode[] = [];
  walk(nodes, (n) => out.push(n), id);
  return out;
}

/** Absolute page-space frame, accumulating every ancestor's origin. */
export function absoluteFrame(nodes: NodeMap, id: NodeId): RectMm | null {
  const node = nodes[id];
  if (!node) return null;
  let { x, y } = node.frame;
  for (const ancestor of ancestorsOf(nodes, id)) {
    x += ancestor.frame.x;
    y += ancestor.frame.y;
  }
  return { x, y, width: node.frame.width, height: node.frame.height };
}

/** A node is effectively hidden if it or any ancestor is hidden. */
export function isEffectivelyHidden(nodes: NodeMap, id: NodeId): boolean {
  const node = nodes[id];
  if (!node) return true;
  return node.hidden || ancestorsOf(nodes, id).some((n) => n.hidden);
}

export function isEffectivelyLocked(nodes: NodeMap, id: NodeId): boolean {
  const node = nodes[id];
  if (!node) return true;
  return node.locked || ancestorsOf(nodes, id).some((n) => n.locked);
}
