/**
 * Properties of the current selection.
 *
 * Everything the figure model can express was previously unreachable once a
 * node existed — colours, text, axis titles and sizes were all fixed at import
 * and editable only by hand-editing a saved archive. This is the surface that
 * makes them editable, so it deliberately covers every node type rather than
 * just plots.
 */

import {
  deleteNode,
  findDataset,
  formatMm,
  repositionBrackets,
  resizePanel,
  toSeries,
  updateNode,
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

/**
 * Only the plot types that actually render distinctly.
 *
 * `PlotType` also declares scatter, line, box, violin and histogram; those pass
 * the type system but fall through to the categorical dot path, so offering
 * them here would ship a control that produces plausible-looking wrong output.
 */
const OFFERED_PLOT_TYPES: { id: PlotType; label: string }[] = [
  { id: 'bar', label: 'Bar' },
  { id: 'dot', label: 'Dot' },
  { id: 'bar-dot', label: 'Bar + points' },
  { id: 'beeswarm', label: 'Beeswarm' },
];

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
}

export function InspectorTab({ api, theme, selectedIds, onSelectionChange }: InspectorProps) {
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
          onChange={(e) => setPlot('Change plot type', { plotType: e.target.value as PlotType })}
        >
          {OFFERED_PLOT_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

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
          onChange={(e) => setPlot('Change centre', { center: e.target.value as 'mean' | 'median' })}
        >
          <option value="mean">Mean</option>
          <option value="median">Median</option>
        </select>
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={node.showPoints}
          onChange={(e) => setPlot('Toggle points', { showPoints: e.target.checked })}
        />
        Show replicate points
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
