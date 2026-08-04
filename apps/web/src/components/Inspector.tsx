/**
 * Properties of the current selection.
 *
 * Everything the figure model can express was previously unreachable once a
 * node existed — colours, text, axis titles and sizes were all fixed at import
 * and editable only by hand-editing a saved archive. This is the surface that
 * makes them editable, so it deliberately covers every node type rather than
 * just plots.
 */

import { useState } from 'react';
import {
  CONTINUOUS_X_PLOT_TYPES,
  DEFAULT_VOLCANO_THRESHOLDS,
  POINT_SHAPES,
  childrenOf,
  deleteNode,
  effectiveDpi,
  findAsset,
  findDataset,
  formatMm,
  hasReplicatesAtX,
  isTwoFactor,
  normaliseArrowFrame,
  resizePanel,
  resyncScaleBars,
  scaleBarWidthMm,
  setImageCrop,
  setScaleBarCalibration,
  toSeries,
  ungroup,
  updateNode,
  type CalibrationSource,
  type FigureDocument,
  type AxisSpec,
  type FigureNode,
  type NodeId,
  type PlotNode,
  type PlotType,
  type PointShape,
  type TextStyle,
  type VolcanoCategory,
} from '@figureforge/doc-model';
import { DEFAULT_VOLCANO_COLORS, reflowBrackets } from '@figureforge/render';
import { DEFAULT_BAR_GAP_FRACTION, DEFAULT_GROUP_GAP_FRACTION } from '@figureforge/plots';
import { PALETTES, findColorConflicts, paletteColors, type Theme } from '@figureforge/theme';
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
  { id: 'volcano', label: 'Volcano' },
];

/**
 * Which types this particular dataset can actually support.
 *
 * Scatter and line need paired x values, which `toSeries` supplies only for the
 * xy-shaped formats; a histogram needs a single distribution, since pooling
 * several groups invents a bimodal shape belonging to neither; a volcano plot
 * needs a per-point identity, which only the `differential` format supplies —
 * gated on that data shape rather than on the format's name, the same way
 * scatter/line gate on "does `.x` exist" rather than on a format list. Offering
 * a type the data cannot support is how the unimplemented plot types shipped
 * plausible-looking wrong output — so they are withheld rather than approximated.
 */
function typesFor(series: readonly { values: number[]; x?: number[]; pointLabels?: readonly string[] }[]): {
  offered: typeof OFFERED_PLOT_TYPES;
  reason: string | null;
} {
  const hasX = series.length > 0 && series.every((s) => s.x !== undefined && s.x.length > 0);
  const single = series.length === 1;
  const hasLabels = single && (series[0]?.pointLabels?.length ?? 0) > 0;

  const blocked: string[] = [];
  if (!hasX) blocked.push('Scatter and line need a dataset with an x column');
  if (!single) blocked.push('Histogram needs a single group');
  if (!hasLabels) blocked.push('Volcano needs a dataset with a label, fold change and p-value per row');

  return {
    offered: OFFERED_PLOT_TYPES.filter((t) => {
      if (t.id === 'scatter' || t.id === 'line') return hasX;
      if (t.id === 'histogram') return single;
      if (t.id === 'volcano') return hasLabels;
      return true;
    }),
    reason: blocked.length > 0 ? `${blocked.join('. ')}.` : null,
  };
}

/** Types that draw the whole distribution, so a centre and error bar say nothing extra. */
const DISTRIBUTION_TYPES: ReadonlySet<PlotType> = new Set<PlotType>(['box', 'violin']);

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
  setPlot,
}: {
  node: PlotNode;
  setPlot: (label: string, patch: Partial<PlotNode>) => void;
}) {
  const thresholds = node.volcanoThresholds ?? DEFAULT_VOLCANO_THRESHOLDS;
  const colors = { ...DEFAULT_VOLCANO_COLORS, ...node.volcanoColors };
  const conflicts = findColorConflicts(Object.values(colors));

  return (
    <>
      <h4>Thresholds</h4>
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
      {conflicts.length > 0 && (
        <p className="warning">
          {conflicts[0]!.colorA} and {conflicts[0]!.colorB} are hard to tell apart under{' '}
          {conflicts[0]!.condition} (ΔE {conflicts[0]!.deltaE.toFixed(1)}).
        </p>
      )}
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
}: InspectorProps) {
  const { document: doc, commit } = api;

  if (selectedIds.length === 0) {
    return (
      <section>
        <h3>Inspector</h3>
        <p className="hint">
          Select something on the canvas — a panel, a plot, a label or a bracket — to edit it
          here. Double-click a label on the canvas to retype it directly.
        </p>
      </section>
    );
  }

  if (selectedIds.length > 1) {
    return (
      <section>
        <h3>Inspector</h3>
        <p className="hint">{selectedIds.length} nodes selected.</p>
        <button
          className="danger"
          onClick={() => {
            api.commit('Delete nodes', (draft) => {
              for (const id of selectedIds) deleteNode(draft, id);
            });
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
        {node.type} <span className="muted">{node.name}</span>
      </h3>

      <label className="field block">
        Name
        <input value={node.name} onChange={(e) => set('Rename node', { name: e.target.value })} />
      </label>

      {node.type === 'plot' && <PlotFields api={api} theme={theme} node={node} doc={doc} />}
      {(node.type === 'text' || node.type === 'panel-label') && (
        <TextFields api={api} node={node} />
      )}
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
          <PanelFields api={api} node={node} />
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
          commit('Delete node', (draft) => deleteNode(draft, node.id));
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
}: {
  api: DocumentApi;
  theme: Theme;
  node: PlotNode;
  doc: FigureDocument;
}) {
  const { commit } = api;
  const dataset = findDataset(doc, node.datasetId);
  const series = dataset ? toSeries(dataset) : [];
  const colors = paletteColors(node.palette, Math.max(1, series.length));
  const { offered, reason } = typesFor(series);

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
  const perSeriesShapes = CONTINUOUS_X_PLOT_TYPES.has(node.plotType) && series.length > 1;

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

      {node.plotType === 'volcano' ? (
        <VolcanoColorControls node={node} setPlot={setPlot} />
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

          {typeof node.palette !== 'string' && (
            <button onClick={() => setPlot('Reset palette', { palette: theme.paletteId })}>
              Reset to palette
            </button>
          )}

          {conflicts.length > 0 && (
            <p className="warning">
              {conflicts[0]!.colorA} and {conflicts[0]!.colorB} are hard to tell apart under{' '}
              {conflicts[0]!.condition} (ΔE {conflicts[0]!.deltaE.toFixed(1)}).
            </p>
          )}

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
            // A numeric x axis is unreadable without ticks; a categorical one
            // needs none. The default is set at creation, so switching type
            // afterwards has to carry it across too.
            setPlot('Change plot type', {
              plotType,
              x: { ...node.x, showTicks: CONTINUOUS_X_PLOT_TYPES.has(plotType) },
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
      {reason && <p className="hint">{reason}</p>}

      {DISTRIBUTION_TYPES.has(node.plotType) ? (
        <p className="hint">
          A {node.plotType} already shows the full distribution, so the centre and error
          bars are not drawn. Switch to a bar or dot plot to set them.
        </p>
      ) : CONTINUOUS_X_PLOT_TYPES.has(node.plotType) && !summarisable ? (
        <p className="hint">
          A {node.plotType} plots every observation against a numeric x axis.{' '}
          {node.plotType === 'line'
            ? 'This table measures each x once, so there is no spread at a point to summarise.'
            : 'It shows the raw observations, so there is no group to summarise with a centre or error bar.'}
        </p>
      ) : (
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
                  <option value="band">Shaded band</option>
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
              </p>
            </>
          )}
        </>
      )}

      <label className="check">
        <input
          type="checkbox"
          checked={node.showPoints}
          onChange={(e) => setPlot('Toggle points', { showPoints: e.target.checked })}
        />
        {node.plotType === 'box' ? 'Overlay all points' : 'Show replicate points'}
      </label>

      {!CONTINUOUS_X_PLOT_TYPES.has(node.plotType) && (
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

      <h4>Axes</h4>
      <AxisFields
        label="Y"
        axis={node.y}
        seriesValues={series.flatMap((s) => s.values)}
        onChange={(patch, label) => setPlot(label, { y: { ...node.y, ...patch } })}
      />
      <AxisFields
        label="X"
        axis={node.x}
        seriesValues={series.flatMap((s) => [...(s.x ?? [])])}
        numeric={CONTINUOUS_X_PLOT_TYPES.has(node.plotType)}
        onChange={(patch, label) => setPlot(label, { x: { ...node.x, ...patch } })}
      />

      <h4>Second y axis</h4>
      {CONTINUOUS_X_PLOT_TYPES.has(node.plotType) && node.plotType !== 'volcano' ? (
        <>
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
      ) : (
        <p className="hint">
          A second axis is offered on scatter and line plots only. Two bar series drawn
          against different scales cannot be compared by length, which is the only thing a
          bar chart is for.
        </p>
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
  onChange,
}: {
  label: string;
  axis: AxisSpec;
  /** Values bound to this axis, for the non-positive warning on a log scale. */
  seriesValues: readonly number[];
  /** False for a categorical x axis, which has no numeric bounds to set. */
  numeric?: boolean;
  onChange: (patch: Partial<AxisSpec>, undoLabel: string) => void;
}) {
  const nonPositive = seriesValues.filter((v) => Number.isFinite(v) && v <= 0).length;

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
        <input
          value={axis.title}
          onChange={(e) => onChange({ title: e.target.value }, `Change ${label} title`)}
        />
      </label>

      {numeric && (
        <>
          <div className="field-row">
            <label className="field">
              Scale
              <select
                value={axis.scale}
                onChange={(e) =>
                  onChange({ scale: e.target.value as 'linear' | 'log10' }, `Change ${label} scale`)
                }
              >
                <option value="linear">Linear</option>
                <option value="log10">Log₁₀</option>
              </select>
            </label>
            {numberField('tickStep', 'Tick step')}
          </div>

          {axis.scale === 'log10' && nonPositive > 0 && (
            <p className="warning">
              {nonPositive} value{nonPositive === 1 ? '' : 's'} at or below zero cannot be
              placed on a log axis. The domain is clamped to a decade below the smallest
              positive datum, so those points are not drawn.
            </p>
          )}

          <div className="field-row">
            {numberField('min', 'Min')}
            {numberField('max', 'Max')}
          </div>

          <div className="field-row">
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

  if (axis.scale === 'log10') {
    return breaks.length > 0 ? (
      <p className="hint">
        Breaks are ignored on a log axis: compressing a range that is already compressed
        leaves nothing a reader can measure against.
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

  return (
    <>
      <label className="field block">
        Text
        <input
          value={node.text}
          onChange={(e) =>
            commit('Edit text', (draft) => {
              const target = draft.nodes[node.id];
              if (target && (target.type === 'text' || target.type === 'panel-label')) {
                target.text = e.target.value;
              }
            })
          }
        />
      </label>

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
  const { commit } = api;
  const asset = findAsset(doc, node.assetId);
  const isVector = asset?.mimeType === 'image/svg+xml';

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
  measuring,
  measuredPx,
  onMeasureNodeChange,
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'scale-bar' }>;
  doc: FigureDocument;
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
        <label className="field">
          Colour
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
}: {
  api: DocumentApi;
  node: Extract<FigureNode, { type: 'panel' }>;
}) {
  const { commit, document: doc } = api;

  // Only plots and images take cells; a scale bar or an arrow is parented to
  // the tile it annotates, not to the panel, so it is not one of them.
  const tileCount = childrenOf(doc.nodes, node.id).filter(
    (c) => c.type === 'plot' || c.type === 'image',
  ).length;
  const grid = node.contentGrid ?? { rows: 1, cols: Math.max(1, tileCount), gutterMm: 1 };

  const setGrid = (patch: Partial<typeof grid>): void => {
    commit('Change tile grid', (draft) => {
      const target = draft.nodes[node.id];
      if (target?.type !== 'panel') return;
      target.contentGrid = { ...grid, ...patch };
      // Re-tile immediately: the frames are stored on the children, so an
      // unapplied grid is a setting that claims an arrangement the figure does
      // not have.
      resizePanel(draft, node.id, target.frame);
    });
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

      {/* Only where there is something to tile. A one-child panel has no grid
          to speak of, and offering rows and columns for it would suggest the
          single image is being placed in a cell rather than filling the panel. */}
      {tileCount > 1 && (
        <>
          <h4>Tiles</h4>
          <div className="field-row">
            <label className="field">
              Rows
              <input
                type="number"
                min={1}
                max={tileCount}
                value={grid.rows}
                onChange={(e) => setGrid({ rows: Math.max(1, Number(e.target.value) || 1) })}
              />
            </label>
            <label className="field">
              Columns
              <input
                type="number"
                min={1}
                max={tileCount}
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
        </>
      )}
    </>
  );
}
