/** Right-hand inspector: data, statistics, quality and layers. */

import { useMemo, useState } from 'react';
import {
  addBracket,
  addPanelWithPlot,
  applyAutoLayout,
  defaultAnalysisOptions,
  deleteNode,
  hashInputs,
  relabelPanels,
  toSeries,
  type Analysis,
  type Correction,
  type FigureDocument,
  type NodeId,
  type PlotNode,
  type StatTest,
} from '@figureforge/doc-model';
import { checkFigure, measurePlot, renderDocument, type Finding } from '@figureforge/render';
import type { Theme } from '@figureforge/theme';
import { analyze, ApiError } from '../api.js';
import { datasetFromText } from '../sample.js';
import type { DocumentApi } from '../useDocument.js';

export type Tab = 'data' | 'stats' | 'quality' | 'layers';

export interface SidePanelProps {
  api: DocumentApi;
  theme: Theme;
  selectedIds: NodeId[];
  onSelectionChange: (ids: NodeId[]) => void;
  onError: (message: string | null) => void;
  setBusy: (label: string | null) => void;
}

export function SidePanel(props: SidePanelProps) {
  const [tab, setTab] = useState<Tab>('data');

  return (
    <aside className="side-panel">
      <nav className="tabs">
        {(['data', 'stats', 'quality', 'layers'] as const).map((t) => (
          <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'data' && <DataTab {...props} />}
        {tab === 'stats' && <StatsTab {...props} />}
        {tab === 'quality' && <QualityTab {...props} />}
        {tab === 'layers' && <LayersTab {...props} />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function DataTab({ api, theme, onError }: SidePanelProps) {
  const { document: doc, commit, newId } = api;
  const [pasted, setPasted] = useState('');

  const preview = useMemo(() => {
    if (pasted.trim() === '') return null;
    try {
      return datasetFromText(pasted, 'Preview', 'preview');
    } catch {
      return null;
    }
  }, [pasted]);

  const importDataset = (): void => {
    if (!preview) return;
    const id = newId();
    const dataset = datasetFromText(pasted, `Dataset ${doc.datasets.length + 1}`, id);

    api.transaction('Import data', () => {
      commit('Add dataset', (draft) => {
        draft.datasets = [...draft.datasets, dataset];
      });
      commit('Add panel', (draft) => {
        addPanelWithPlot(draft, newId, {
          frame: { x: 4, y: 4, width: 60, height: 50 },
          name: dataset.name,
          datasetId: dataset.id,
          plotType: 'bar-dot',
          yTitle: 'Value',
        });
        applyAutoLayout(draft, {
          marginMm: theme.spacing.marginMm,
          gutterMm: theme.spacing.panelGutterMm,
          labelGutterMm: 4,
        });
        relabelPanels(draft, newId, {
          uppercase: theme.panelLabelCase === 'upper',
          fontSizePt: theme.type.panelLabelPt,
          offsetMm: 4,
        });
      });
    });

    setPasted('');
    onError(null);
  };

  const onFile = async (file: File): Promise<void> => {
    try {
      setPasted(await file.text());
    } catch (error) {
      onError(`Could not read ${file.name}: ${String(error)}`);
    }
  };

  return (
    <section>
      <h3>Import</h3>
      <p className="hint">Paste from Excel, or drop a CSV/TSV/TXT file.</p>

      <textarea
        className="paste-area"
        placeholder={'Treatment,Rep1,Rep2,Rep3\nVehicle,98.2,95.4,101.3\n…'}
        value={pasted}
        rows={6}
        onChange={(e) => setPasted(e.target.value)}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file) void onFile(file);
        }}
        onDragOver={(e) => e.preventDefault()}
      />

      <input
        type="file"
        accept=".csv,.tsv,.txt,text/csv,text/plain"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
        }}
      />

      {preview && (
        <div className="preview">
          {/* Live preview before import, so a mis-detected layout is visible
              before it becomes a plot. */}
          <div className="preview-meta">
            Detected <strong>{preview.format}</strong> · {preview.columns.length} columns ·{' '}
            {preview.rows.length} rows
          </div>
          <table>
            <thead>
              <tr>
                {preview.columns.map((c) => (
                  <th key={c.name}>
                    {c.name}
                    <span className="kind">{c.kind === 'number' ? '#' : 'A'}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 5).map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell === null ? '—' : String(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <button className="primary" onClick={importDataset}>
            Import as new panel
          </button>
        </div>
      )}

      <h3>Datasets</h3>
      <ul className="list">
        {doc.datasets.map((dataset) => (
          <li key={dataset.id}>
            <strong>{dataset.name}</strong>
            <span className="muted">
              {dataset.format} · {toSeries(dataset).length} series
            </span>
          </li>
        ))}
        {doc.datasets.length === 0 && <li className="muted">No data imported yet.</li>}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const TESTS: { id: StatTest; label: string }[] = [
  { id: 'ttest-welch', label: "Welch's t-test" },
  { id: 'ttest-independent', label: "Student's t-test" },
  { id: 'ttest-paired', label: 'Paired t-test' },
  { id: 'mann-whitney', label: 'Mann-Whitney U' },
  { id: 'anova-one-way', label: 'One-way ANOVA' },
  { id: 'kruskal-wallis', label: 'Kruskal-Wallis' },
  { id: 'pearson', label: 'Pearson correlation' },
  { id: 'spearman', label: 'Spearman correlation' },
];

const CORRECTIONS: { id: Correction; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'holm', label: 'Holm-Bonferroni' },
  { id: 'bonferroni', label: 'Bonferroni' },
  { id: 'benjamini-hochberg', label: 'Benjamini-Hochberg (FDR)' },
];

function StatsTab({ api, theme, onError, setBusy }: SidePanelProps) {
  const { document: doc, commit, newId } = api;
  const [test, setTest] = useState<StatTest>('ttest-welch');
  const [correction, setCorrection] = useState<Correction>('holm');
  const [plotId, setPlotId] = useState<NodeId | ''>('');

  const plots = Object.values(doc.nodes).filter((n): n is PlotNode => n.type === 'plot');
  const activePlot = plots.find((p) => p.id === plotId) ?? plots[0];
  const dataset = activePlot ? doc.datasets.find((d) => d.id === activePlot.datasetId) : undefined;
  const series = dataset ? toSeries(dataset) : [];

  const run = async (): Promise<void> => {
    if (!activePlot || !dataset || series.length < 2) {
      onError('Select a plot with at least two groups.');
      return;
    }

    setBusy('Running analysis');
    onError(null);

    const options = { ...defaultAnalysisOptions(), correction };

    try {
      const result = await analyze({
        test,
        groups: series.map((s) => ({ name: s.name, values: s.values })),
        alternative: options.alternative,
        correction,
        alpha: options.alpha,
        welch: options.welch,
      });

      const analysis: Analysis = {
        id: newId(),
        name: `${test} on ${dataset.name}`,
        test,
        spec: { datasetId: dataset.id, groups: series.map((s) => s.name) },
        options,
        // Hash the values too, so editing the data marks the result stale.
        inputHash: hashInputs(
          { test, correction },
          series.map((s) => s.values),
        ),
        result,
        computedAt: new Date().toISOString(),
      };

      api.transaction('Run analysis', () => {
        commit('Store analysis', (draft) => {
          draft.analyses = [...draft.analyses, analysis];
        });
        commit('Annotate significance', (draft) => {
          // Measured from the renderer's own band scale so bracket ends land on
          // the bars; the gap grows per bracket so stacked ones do not collide.
          const measurements = measurePlot(draft, activePlot, theme) ?? undefined;
          let placed = 0;
          result.comparisons.forEach((comparison, index) => {
            if (comparison.pAdjusted > options.alpha) return;
            addBracket(draft, newId, {
              plotId: activePlot.id,
              analysis,
              comparisonIndex: index,
              gapMm: 2 + placed * 3.5,
              measurements,
            });
            placed++;
          });
        });
      });
    } catch (error) {
      onError(
        error instanceof ApiError
          ? `Analysis failed: ${error.message}`
          : `Could not reach the analysis service. Is the API running? (${String(error)})`,
      );
    } finally {
      setBusy(null);
    }
  };

  const analyses = doc.analyses;

  return (
    <section>
      <h3>Analysis</h3>

      <label className="field block">
        Plot
        <select value={activePlot?.id ?? ''} onChange={(e) => setPlotId(e.target.value)}>
          {plots.map((plot) => {
            const parent = plot.parentId ? doc.nodes[plot.parentId] : undefined;
            return (
              <option key={plot.id} value={plot.id}>
                {parent?.name ?? plot.name}
              </option>
            );
          })}
        </select>
      </label>

      <label className="field block">
        Test
        <select value={test} onChange={(e) => setTest(e.target.value as StatTest)}>
          {TESTS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field block">
        Multiple comparisons
        <select value={correction} onChange={(e) => setCorrection(e.target.value as Correction)}>
          {CORRECTIONS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <p className="hint">
        Groups: {series.map((s) => `${s.name} (n=${s.values.length})`).join(', ') || '—'}
      </p>

      <button className="primary" onClick={() => void run()} disabled={series.length < 2}>
        Run and annotate
      </button>

      {analyses.map((analysis) => (
        <div key={analysis.id} className="result">
          <h4>{analysis.test}</h4>

          {analysis.result?.warnings.map((warning, i) => (
            <p key={i} className="warning">
              {warning}
            </p>
          ))}

          <table className="results-table">
            <thead>
              <tr>
                <th>Comparison</th>
                <th>P</th>
                <th>P adj.</th>
                <th>Effect</th>
              </tr>
            </thead>
            <tbody>
              {analysis.result?.comparisons.map((c, i) => (
                <tr key={i}>
                  <td>
                    {c.groupA} vs {c.groupB}
                  </td>
                  <td>{c.p < 0.001 ? '<0.001' : c.p.toFixed(3)}</td>
                  <td className={c.pAdjusted <= 0.05 ? 'significant' : ''}>
                    {c.pAdjusted < 0.001 ? '<0.001' : c.pAdjusted.toFixed(3)}
                  </td>
                  <td>
                    {c.effectSize !== null && Number.isFinite(c.effectSize)
                      ? `${c.effectSize.toFixed(2)} ${c.effectSizeName ?? ''}`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Copyable methods text: the most-used output of the whole panel. */}
          <details>
            <summary>Methods sentence</summary>
            <p className="methods">{analysis.result?.methodsSentence}</p>
            <button
              onClick={() =>
                void navigator.clipboard?.writeText(analysis.result?.methodsSentence ?? '')
              }
            >
              Copy
            </button>
          </details>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

function QualityTab({ api, theme, onSelectionChange }: SidePanelProps) {
  const { document: doc } = api;
  const [dpi, setDpi] = useState(300);

  const report = useMemo(() => {
    const scene = renderDocument(doc, { theme });
    return checkFigure({ document: doc, theme, scene, exportDpi: dpi });
  }, [doc, theme, dpi]);

  const tone = report.score >= 90 ? 'good' : report.score >= 70 ? 'fair' : 'poor';

  return (
    <section>
      <h3>Publication readiness</h3>

      <div className={`score ${tone}`}>
        <span className="score-value">{report.score}</span>
        <span className="score-max">/ 100</span>
      </div>

      <label className="field block">
        Target resolution
        <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))}>
          {[300, 450, 600].map((d) => (
            <option key={d} value={d}>
              {d} dpi
            </option>
          ))}
        </select>
      </label>

      <ul className="categories">
        {report.categories.map((category) => (
          <li key={category.name} className={category.passed ? 'pass' : 'fail'}>
            <span>{category.name}</span>
            <span>{category.passed ? '✓' : '!'}</span>
          </li>
        ))}
      </ul>

      <h3>Findings</h3>
      {report.findings.length === 0 && <p className="muted">Nothing to fix. Ready to export.</p>}

      {report.findings.map((finding: Finding) => (
        <div key={finding.id} className={`finding ${finding.severity}`}>
          <strong>{finding.title}</strong>
          <p>{finding.detail}</p>
          {finding.nodeIds.length > 0 && (
            <button onClick={() => onSelectionChange(finding.nodeIds)}>
              Select {finding.nodeIds.length} affected
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function LayersTab({ api, selectedIds, onSelectionChange }: SidePanelProps) {
  const { document: doc, commit } = api;

  const nodesByLayer = (layerId: string) =>
    Object.values(doc.nodes)
      .filter((n) => n.layerId === layerId)
      .sort((a, b) => a.z - b.z);

  return (
    <section>
      <h3>Layers</h3>
      {[...doc.layers]
        .sort((a, b) => b.z - a.z)
        .map((layer) => (
          <div key={layer.id} className="layer">
            <div className="layer-head">
              <button
                className="icon"
                title={layer.hidden ? 'Show layer' : 'Hide layer'}
                onClick={() =>
                  commit('Toggle layer visibility', (draft) => {
                    const target = draft.layers.find((l) => l.id === layer.id);
                    if (target) target.hidden = !target.hidden;
                  })
                }
              >
                {layer.hidden ? '◌' : '●'}
              </button>
              <button
                className="icon"
                title={layer.locked ? 'Unlock layer' : 'Lock layer'}
                onClick={() =>
                  commit('Toggle layer lock', (draft) => {
                    const target = draft.layers.find((l) => l.id === layer.id);
                    if (target) target.locked = !target.locked;
                  })
                }
              >
                {layer.locked ? '🔒' : '🔓'}
              </button>
              <strong>{layer.name}</strong>
            </div>

            <ul className="list nodes">
              {nodesByLayer(layer.id).map((node) => (
                <li
                  key={node.id}
                  className={selectedIds.includes(node.id) ? 'selected' : ''}
                  onClick={() => onSelectionChange([node.id])}
                >
                  <span className="node-type">{node.type}</span>
                  <span>{node.name}</span>
                  <button
                    className="icon danger"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      commit('Delete node', (draft) => deleteNode(draft, node.id));
                      onSelectionChange(selectedIds.filter((id) => id !== node.id));
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

export type { FigureDocument };
