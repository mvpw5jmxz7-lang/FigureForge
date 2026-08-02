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
  childrenOf,
  deleteNode,
  effectiveDpi,
  findAsset,
  findDataset,
  formatMm,
  normaliseArrowFrame,
  repositionBrackets,
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
  type FigureNode,
  type NodeId,
  type PlotNode,
  type PlotType,
  type TextStyle,
} from '@figureforge/doc-model';
import { measureAllPlots } from '@figureforge/render';
import { PALETTES, findColorConflicts, paletteColors, type Theme } from '@figureforge/theme';
import type { DocumentApi } from '../useDocument.js';

/** Every plot type. All nine render distinctly since phase 3. */
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
];

/**
 * Which types this particular dataset can actually support.
 *
 * Scatter and line need paired x values, which `toSeries` supplies only for the
 * xy-shaped formats; a histogram needs a single distribution, since pooling
 * several groups invents a bimodal shape belonging to neither. Offering a type
 * the data cannot support is how the unimplemented plot types shipped
 * plausible-looking wrong output — so they are withheld rather than approximated.
 */
function typesFor(series: readonly { values: number[]; x?: number[] }[]): {
  offered: typeof OFFERED_PLOT_TYPES;
  reason: string | null;
} {
  const hasX = series.length > 0 && series.every((s) => s.x !== undefined && s.x.length > 0);
  const single = series.length === 1;

  const blocked: string[] = [];
  if (!hasX) blocked.push('Scatter and line need a dataset with an x column');
  if (!single) blocked.push('Histogram needs a single group');

  return {
    offered: OFFERED_PLOT_TYPES.filter((t) => {
      if (t.id === 'scatter' || t.id === 'line') return hasX;
      if (t.id === 'histogram') return single;
      return true;
    }),
    reason: blocked.length > 0 ? `${blocked.join('. ')}.` : null,
  };
}

/** Types that draw the whole distribution, so a centre and error bar say nothing extra. */
const DISTRIBUTION_TYPES: ReadonlySet<PlotType> = new Set<PlotType>(['box', 'violin']);

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
      {node.type === 'panel' && <PanelFields api={api} node={node} />}
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
            {childrenOf(doc.nodes, node.id).length} items. Clicking on the canvas still selects the
            individual item, not the group — use the Layers list to select this.
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
                  repositionBrackets(draft, measureAllPlots(draft, theme));
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

  // Warn as colours are picked rather than at export: a pair that collides
  // under colour-vision deficiency is far cheaper to fix now.
  const conflicts = findColorConflicts(colors);

  const setPlot = (label: string, patch: Partial<PlotNode>): void => {
    commit(label, (draft) => updateNode<PlotNode>(draft, node.id, patch));
  };

  const setSeriesColor = (index: number, color: string): void => {
    const next = [...colors];
    next[index] = color;
    setPlot('Change series colour', { palette: next });
  };

  return (
    <>
      <h4>Data</h4>
      <p className="hint">{dataset ? dataset.name : 'Dataset missing'}</p>

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

      <div className="swatches">
        {series.map((s, index) => (
          <label className="swatch" key={s.name} title={s.name}>
            <input
              type="color"
              value={colors[index] ?? '#000000'}
              onChange={(e) => setSeriesColor(index, e.target.value)}
            />
            <span>{s.name}</span>
          </label>
        ))}
      </div>

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
      ) : CONTINUOUS_X_PLOT_TYPES.has(node.plotType) ? (
        <p className="hint">
          A {node.plotType} plots every observation against a numeric x axis, so there is
          no group to summarise with a centre or error bar.
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

      <h4>Axes</h4>
      <label className="field block">
        Y title
        <input
          value={node.y.title}
          onChange={(e) => setPlot('Change y title', { y: { ...node.y, title: e.target.value } })}
        />
      </label>
      <label className="field block">
        X title
        <input
          value={node.x.title}
          onChange={(e) => setPlot('Change x title', { x: { ...node.x, title: e.target.value } })}
        />
      </label>
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
              repositionBrackets(draft, measureAllPlots(draft, theme));
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
            onChange={(e) => setBar('Change bar colour', { fill: { color: e.target.value } })}
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
  const { commit } = api;

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
    </>
  );
}
