/** Right-hand inspector: data, statistics, quality and layers. */

import { useMemo, useState } from 'react';
import {
  CONTINUOUS_X_PLOT_TYPES,
  addAsset,
  addBracket,
  addPanelWithImage,
  addPanelWithPlot,
  analysisInputHash,
  applyAutoLayout,
  childrenOf,
  dataPathFor,
  defaultAnalysisOptions,
  deleteNode,
  effectiveDpi,
  findAsset,
  findDataset,
  imagesUsingAsset,
  isContingency,
  contingencyCategories,
  isStale,
  nextPanelFrame,
  relabelPanels,
  removeAsset,
  removeBracketsForPlot,
  renameDataset,
  reorderNode,
  replaceAnalysisForPlot,
  repositionBrackets,
  toSeries,
  xForHash,
  type Analysis,
  type Correction,
  type DataFormat,
  type Delimiter,
  type FigureDocument,
  type NodeId,
  type PlotNode,
  type StatTest,
} from '@figureforge/doc-model';
import {
  checkFigure,
  measureAllPlots,
  measurePlot,
  renderDocument,
  type Finding,
} from '@figureforge/render';
import type { Theme } from '@figureforge/theme';
import { analyze, ApiError } from '../api.js';
import { InspectorTab } from './Inspector.js';
import { datasetFromText, type ImportOptions } from '../sample.js';
import type { AssetsApi } from '../assets.js';
import { ACCEPTED_IMAGE_TYPES, importImage, initialImageSize } from '../imageImport.js';
import type { DocumentApi } from '../useDocument.js';

export type Tab = 'data' | 'inspector' | 'stats' | 'quality' | 'layers';

/**
 * Warn once the archive gets big enough to be a problem.
 *
 * `zipSync` builds the whole file in one allocation, so a project well past
 * this is an out-of-memory kill of the tab and a lost session. Surfaced as a
 * running total rather than discovered at save time.
 */
const ASSET_SIZE_WARNING_BYTES = 300 * 1024 * 1024;

/**
 * The layouts an author can choose between, with what each one *means* for the
 * series that come out of it — the difference between `prism` and `sigmaplot`
 * is one shared x versus one x per series, and nothing in the old UI said so.
 */
const DATA_FORMATS: { id: DataFormat; label: string; hint: string }[] = [
  {
    id: 'replicate',
    label: 'Treatment + replicates',
    hint: 'One row per group; the replicate columns collapse into that group’s values.',
  },
  {
    id: 'grouped',
    label: 'Group, Value (long)',
    hint: 'Two columns: a label and a measurement, one observation per row.',
  },
  {
    id: 'simple-xy',
    label: 'X, Y',
    hint: 'One series of paired x and y values.',
  },
  {
    id: 'prism',
    label: 'X, Y1, Y2, … (shared x)',
    hint: 'Column 1 is the x for every series — right only if the series were sampled together.',
  },
  {
    id: 'sigmaplot',
    label: 'X1, Y1, X2, Y2, … (paired)',
    hint: 'Each series carries its own x, so runs sampled at different points stay independent.',
  },
  {
    id: 'contingency',
    label: 'Contingency table (counts)',
    hint: 'One row per group, one column per category. Counts, not measurements: only chi-square and Fisher apply.',
  },
];

export interface SidePanelProps {
  api: DocumentApi;
  theme: Theme;
  selectedIds: NodeId[];
  onSelectionChange: (ids: NodeId[]) => void;
  onError: (message: string | null) => void;
  setBusy: (label: string | null) => void;
  assets: AssetsApi;
  /** Verbatim import text keyed by archive path; written here, saved in App. */
  dataOriginals: Map<string, string>;
  exportDpi: number;
  cropNodeId: NodeId | null;
  onCropNodeChange: (id: NodeId | null) => void;
  measureNodeId: NodeId | null;
  /** Length of the last ruler drag, in source pixels; null until one happens. */
  measuredPx: number | null;
  onMeasureNodeChange: (id: NodeId | null) => void;
}

export function SidePanel(props: SidePanelProps) {
  const [tab, setTab] = useState<Tab>('data');

  return (
    <aside className="side-panel">
      <nav className="tabs">
        {(['data', 'inspector', 'stats', 'quality', 'layers'] as const).map((t) => (
          <button key={t} className={t === tab ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'data' && <DataTab {...props} />}
        {tab === 'inspector' && (
          <InspectorTab
            api={props.api}
            theme={props.theme}
            selectedIds={props.selectedIds}
            onSelectionChange={props.onSelectionChange}
            cropNodeId={props.cropNodeId}
            onCropNodeChange={props.onCropNodeChange}
            measureNodeId={props.measureNodeId}
            measuredPx={props.measuredPx}
            onMeasureNodeChange={props.onMeasureNodeChange}
          />
        )}
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

function DataTab({
  api,
  theme,
  onError,
  setBusy,
  assets,
  dataOriginals,
  exportDpi,
  onSelectionChange,
}: SidePanelProps) {
  const { document: doc, commit, newId } = api;
  const [pasted, setPasted] = useState('');
  // Blank means "use the default"; the placeholder shows what that will be.
  const [name, setName] = useState('');

  /*
   * Import options. Every one is `undefined` until the author touches it, so
   * the preview shows exactly what detection decided and an override is a
   * visible departure from it rather than a silent default.
   */
  const [delimiter, setDelimiter] = useState<Delimiter | ''>('');
  const [headerMode, setHeaderMode] = useState<'auto' | 'yes' | 'no'>('auto');
  const [transpose, setTranspose] = useState(false);
  const [format, setFormat] = useState<DataFormat | ''>('');

  const parseOptions: ImportOptions = useMemo(
    () => ({
      ...(delimiter !== '' ? { delimiter } : {}),
      ...(headerMode !== 'auto' ? { hasHeader: headerMode === 'yes' } : {}),
      ...(transpose ? { transpose: true } : {}),
      ...(format !== '' ? { format } : {}),
    }),
    [delimiter, headerMode, transpose, format],
  );

  const preview = useMemo(() => {
    if (pasted.trim() === '') return null;
    try {
      return datasetFromText(pasted, 'Preview', 'preview', null, parseOptions);
    } catch {
      return null;
    }
  }, [pasted, parseOptions]);

  const defaultName = `Dataset ${doc.datasets.length + 1}`;

  const importDataset = (): void => {
    if (!preview) return;
    const id = newId();
    const dataset = datasetFromText(pasted, name.trim() || defaultName, id, null, parseOptions);

    // Keep the text exactly as it arrived. Re-serialising through
    // `datasetToCsv` on save would round-trip the author's numbers, which is
    // the one thing `data/` exists to prevent.
    dataOriginals.set(dataPathFor(dataset), pasted);

    api.transaction('Import data', () => {
      commit('Add dataset', (draft) => {
        draft.datasets = [...draft.datasets, dataset];
      });
      commit('Add panel', (draft) => {
        addPanelWithPlot(draft, newId, {
          // Below whatever is already on the page, so auto-layout's reading
          // order puts the new panel last rather than in panel a's cell.
          frame: nextPanelFrame(draft, { width: 60, height: 50 }),
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
        // Importing re-lays out every panel, so existing brackets would
        // otherwise be left where the old, wider panels used to be.
        repositionBrackets(draft, measureAllPlots(draft, theme));
      });
    });

    setPasted('');
    setName('');
    onError(null);
  };

  const onFile = async (file: File): Promise<void> => {
    try {
      setPasted(await file.text());
      // The filename is nearly always a better name than "Dataset 3".
      if (name.trim() === '') setName(file.name.replace(/\.[^.]+$/, ''));
    } catch (error) {
      onError(`Could not read ${file.name}: ${String(error)}`);
    }
  };

  // --- images -------------------------------------------------------------

  const importImageFile = async (file: File): Promise<void> => {
    setBusy(`Reading ${file.name}`);
    onError(null);
    try {
      const imported = await importImage(file);
      const assetId = newId();

      // Bytes first: the commit below registers the asset, and a document
      // referencing one the store has never seen would render a placeholder.
      assets.store.add(assetId, imported.bytes);

      commit('Add image', (draft) => {
        // Asset record and image node in ONE commit. Referential integrity
        // rejects an image whose asset is unregistered, so splitting them
        // would leave a figure that edits fine and cannot be saved.
        addAsset(draft, {
          id: assetId,
          filename: imported.filename,
          mimeType: imported.bytes.mimeType,
          byteLength: imported.bytes.original.length,
          naturalPx: imported.naturalPx,
        });
        addPanelWithImage(draft, newId, {
          frame: nextPanelFrame(
            draft,
            initialImageSize(imported.aspect, draft.page.widthMm, draft.page.heightMm),
          ),
          name: imported.filename,
          assetId,
          // Vector sources carry {0,0}: there is no pixel grid to record, and
          // the resolution check skips them by MIME type rather than by this.
          naturalPx: imported.naturalPx ?? { width: 0, height: 0 },
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
        repositionBrackets(draft, measureAllPlots(draft, theme));
      });

      if (imported.notes.length > 0) onError(imported.notes.join(' '));
    } catch (error) {
      onError(`Could not import ${file.name}: ${String(error)}`);
    } finally {
      setBusy(null);
    }
  };

  const insertAsset = (assetId: string): void => {
    const asset = findAsset(doc, assetId);
    if (!asset) return;
    const naturalPx = asset.naturalPx ?? { width: 0, height: 0 };
    const aspect = naturalPx.height > 0 ? naturalPx.width / naturalPx.height : 1;

    commit('Insert image', (draft) => {
      const { image } = addPanelWithImage(draft, newId, {
        frame: nextPanelFrame(draft, initialImageSize(aspect, draft.page.widthMm, draft.page.heightMm)),
        name: asset.filename,
        assetId,
        naturalPx,
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
      onSelectionChange([image.id]);
    });
  };

  const totalAssetBytes = assets.store.totalBytes();

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
            {format === '' ? 'Detected' : 'Reading as'} <strong>{preview.format}</strong> ·{' '}
            {preview.columns.length} columns · {preview.rows.length} rows
          </div>

          {/* Everything below used to be decided silently. Detection is a
              heuristic on column shapes and names; when it guesses wrong it
              changes what every series *is*, and until now the only recourse
              was to re-shape the file by hand. */}
          <div className="field-row">
            <label className="field">
              Delimiter
              <select
                value={delimiter}
                onChange={(e) => setDelimiter(e.target.value as Delimiter | '')}
              >
                <option value="">Detect</option>
                <option value=",">Comma</option>
                <option value="&#9;">Tab</option>
                <option value=";">Semicolon</option>
                <option value="|">Pipe</option>
              </select>
            </label>
            <label className="field">
              Header row
              <select
                value={headerMode}
                onChange={(e) => setHeaderMode(e.target.value as 'auto' | 'yes' | 'no')}
              >
                <option value="auto">Detect</option>
                <option value="yes">First row</option>
                <option value="no">None</option>
              </select>
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              Layout
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as DataFormat | '')}
              >
                <option value="">Detect</option>
                {DATA_FORMATS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={transpose}
                onChange={(e) => setTranspose(e.target.checked)}
              />
              Transpose
            </label>
          </div>
          <p className="hint">
            {DATA_FORMATS.find((f) => f.id === preview.format)?.hint}
          </p>
          <table>
            <thead>
              <tr>
                {/* Keyed by position, not by name: a paired-xy export
                    legitimately repeats a column name ("Radius, C(s)_run1,
                    Radius, C(s)_run2"), and a duplicate React key drops one. */}
                {preview.columns.map((c, i) => (
                  <th key={i}>
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
          <label className="field block">
            Name
            <input
              value={name}
              placeholder={defaultName}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <button className="primary" onClick={importDataset}>
            Import as new panel
          </button>
        </div>
      )}

      <h3>Datasets</h3>
      <ul className="list">
        {doc.datasets.map((dataset) => (
          <li key={dataset.id}>
            {/* Editable in place: the name propagates to the panel and plot,
                which is what makes the Layers list readable. */}
            <input
              className="rename"
              value={dataset.name}
              onChange={(e) =>
                commit('Rename dataset', (draft) =>
                  renameDataset(draft, dataset.id, e.target.value),
                )
              }
            />
            {/* Fixable after the fact: a layout is a reading of the same rows,
                not a transformation of them, so changing it is lossless.
                `toSeries` is the only consumer and it reads this field. */}
            <select
              value={dataset.format}
              title="How these columns are read"
              onChange={(e) =>
                commit('Change data layout', (draft) => {
                  const next = e.target.value as DataFormat;
                  draft.datasets = draft.datasets.map((d) =>
                    d.id === dataset.id ? { ...d, format: next } : d,
                  );
                })
              }
            >
              {DATA_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <span className="muted">{toSeries(dataset).length} series</span>
          </li>
        ))}
        {doc.datasets.length === 0 && <li className="muted">No data imported yet.</li>}
      </ul>

      <h3>Images</h3>
      <p className="hint">
        Micrographs, blots, gels and schematics. PNG, JPEG, SVG or TIFF — TIFF is decoded by the
        analysis service, and the original is kept in the project either way.
      </p>

      <label className="file-button">
        Add image
        <input
          type="file"
          accept={ACCEPTED_IMAGE_TYPES}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importImageFile(file);
            // Clear the input, or picking the same file twice does nothing.
            e.target.value = '';
          }}
        />
      </label>

      <ul className="list assets">
        {doc.assets.map((asset) => {
          const uses = imagesUsingAsset(doc.nodes, asset.id);
          const widest = Math.max(0, ...uses.map((image) => image.frame.width));
          const visiblePx = (asset.naturalPx?.width ?? 0) * (uses[0]?.crop.width ?? 1);
          const dpi = widest > 0 ? effectiveDpi(visiblePx, widest) : null;

          return (
            <li key={asset.id}>
              <span className="rename" title={asset.filename}>
                {asset.filename}
              </span>
              <span className="muted">
                {asset.naturalPx
                  ? `${asset.naturalPx.width}×${asset.naturalPx.height} px`
                  : 'vector'}
                {' · '}
                {(asset.byteLength / 1e6).toFixed(1)} MB
                {dpi !== null && asset.naturalPx && (
                  <>
                    {' · '}
                    <span className={dpi < exportDpi ? 'warning' : ''}>{Math.round(dpi)} dpi</span>
                  </>
                )}
              </span>
              <div className="field-row">
                <button onClick={() => insertAsset(asset.id)}>Insert as panel</button>
                {uses.length === 0 && (
                  <>
                    {/* Deleting the last image that used an asset leaves it
                        here on purpose — undo must be able to bring the node
                        back, and this is how a mistaken delete is recovered.
                        Collecting it automatically is the obvious wrong move. */}
                    <span className="muted">not used</span>
                    <button
                      className="danger"
                      onClick={() => commit('Remove image', (draft) => removeAsset(draft, asset.id))}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
        {doc.assets.length === 0 && <li className="muted">No images added yet.</li>}
      </ul>

      {totalAssetBytes > ASSET_SIZE_WARNING_BYTES && (
        <p className="warning">
          {(totalAssetBytes / 1e6).toFixed(0)} MB of images. The project file is built in memory in
          one piece, so saving may fail beyond roughly half a gigabyte.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

const CORRELATION_TESTS = new Set<StatTest>(['pearson', 'spearman', 'linear-regression']);

/**
 * Tests that read a table of counts rather than measurements.
 *
 * The gate runs both ways. A contingency table's rows are not replicates of one
 * another, so a t-test on it compares means of frequencies — a confident,
 * meaningless number. And chi-square on measurements silently treats them as
 * counts. Neither is offered against the wrong kind of data.
 */
const COUNT_TESTS = new Set<StatTest>(['chi-square', 'fisher']);

const TESTS: { id: StatTest; label: string }[] = [
  { id: 'ttest-welch', label: "Welch's t-test" },
  { id: 'ttest-independent', label: "Student's t-test" },
  { id: 'ttest-paired', label: 'Paired t-test' },
  { id: 'mann-whitney', label: 'Mann-Whitney U' },
  { id: 'wilcoxon', label: 'Wilcoxon signed-rank' },
  { id: 'anova-one-way', label: 'One-way ANOVA' },
  { id: 'anova-rm', label: 'Repeated-measures ANOVA' },
  { id: 'kruskal-wallis', label: 'Kruskal-Wallis' },
  { id: 'chi-square', label: 'Chi-square test' },
  { id: 'fisher', label: "Fisher's exact test" },
  { id: 'pearson', label: 'Pearson correlation' },
  { id: 'spearman', label: 'Spearman correlation' },
  { id: 'linear-regression', label: 'Linear regression' },
];

const CORRECTIONS: { id: Correction; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'holm', label: 'Holm-Bonferroni' },
  { id: 'bonferroni', label: 'Bonferroni' },
  { id: 'benjamini-hochberg', label: 'Benjamini-Hochberg (FDR)' },
];

const CORRECTION_LABEL = Object.fromEntries(CORRECTIONS.map((c) => [c.id, c.label])) as Record<
  Correction,
  string
>;

/**
 * The plot the canvas selection refers to, directly or through its panel.
 *
 * Selecting a panel is how a user says "this graph", so a panel resolves to the
 * plot inside it rather than to nothing.
 */
function plotFromSelection(doc: FigureDocument, selectedIds: readonly NodeId[]): NodeId | '' {
  for (const id of selectedIds) {
    const node = doc.nodes[id];
    if (!node) continue;
    if (node.type === 'plot') return node.id;
    const plotChild = childrenOf(doc.nodes, node.id).find((c) => c.type === 'plot');
    if (plotChild) return plotChild.id;
  }
  return '';
}

function StatsTab({ api, theme, selectedIds, onError, setBusy }: SidePanelProps) {
  const { document: doc, commit, newId } = api;
  const [test, setTest] = useState<StatTest>('ttest-welch');
  const [correction, setCorrection] = useState<Correction>('holm');
  const [plotId, setPlotId] = useState<NodeId | ''>('');
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * Follow the canvas. The dropdown used to be the only way to say which plot a
   * test annotates, and it defaulted to whichever plot happened to be created
   * first — so selecting panel c and hitting Run silently re-annotated panel a,
   * which reads exactly like "the test produced no labels". Selecting a plot
   * (or its panel) now moves the dropdown with it; the dropdown stays an
   * override until the selection changes again.
   */
  const [selectionEcho, setSelectionEcho] = useState<NodeId | ''>('');
  const selectedPlotId = plotFromSelection(doc, selectedIds);
  if (selectedPlotId !== selectionEcho) {
    setSelectionEcho(selectedPlotId);
    if (selectedPlotId) setPlotId(selectedPlotId);
  }

  const plots = Object.values(doc.nodes).filter((n): n is PlotNode => n.type === 'plot');
  const activePlot = plots.find((p) => p.id === plotId) ?? plots[0];
  const dataset = activePlot ? doc.datasets.find((d) => d.id === activePlot.datasetId) : undefined;
  const series = dataset ? toSeries(dataset) : [];

  /*
   * Group comparisons annotate a plot with a bracket spanning two categories.
   * A scatter, line or histogram has no categories to span — `measurePlot`
   * returns empty measurements for them — so the test is refused rather than
   * run and left with nowhere to draw its result.
   *
   * Correlation/regression is the one family that doesn't need categories at
   * all: it consumes a single series against its own paired x-values, which
   * is exactly what a numeric-x plot's dataset provides. So the numeric-x
   * gate is relaxed specifically for that case rather than for the plot type
   * as a whole.
   */
  const continuousPlot = activePlot ? CONTINUOUS_X_PLOT_TYPES.has(activePlot.plotType) : false;
  const xyCorrelation =
    CORRELATION_TESTS.has(test) && series.length === 1 && series[0]?.x !== undefined;
  const blockedByContinuousAxis = continuousPlot && !xyCorrelation;
  const minGroupsMet = xyCorrelation ? series.length >= 1 : series.length >= 2;

  // Counts and measurements take disjoint tests; see COUNT_TESTS.
  const counts = dataset !== undefined && isContingency(dataset);
  const offeredTests = TESTS.filter((t) => COUNT_TESTS.has(t.id) === counts);

  // Keep the dropdown honest when the selected plot's dataset changes kind.
  const [testEcho, setTestEcho] = useState(counts);
  if (testEcho !== counts) {
    setTestEcho(counts);
    if (COUNT_TESTS.has(test) !== counts) setTest(counts ? 'chi-square' : 'ttest-welch');
  }

  const run = async (): Promise<void> => {
    if (blockedByContinuousAxis) {
      onError('Group comparisons need a categorical plot; this one has a numeric x axis.');
      return;
    }
    if (!activePlot || !dataset || !minGroupsMet) {
      onError('Select a plot with at least two groups.');
      return;
    }

    setBusy('Running analysis');
    onError(null);
    setNotice(null);

    const options = { ...defaultAnalysisOptions(), correction };

    try {
      const groupsPayload = xyCorrelation
        ? [{ name: series[0]!.name, values: series[0]!.values }]
        : series.map((s) => ({ name: s.name, values: s.values }));
      const xPayload = xyCorrelation
        ? { name: dataset.columns[0]?.name ?? 'x', values: series[0]!.x! }
        : undefined;

      const result = await analyze({
        test,
        groups: groupsPayload,
        x: xPayload,
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
        plotId: activePlot.id,
        options,
        // Hash the values too, so editing the data marks the result stale.
        inputHash: analysisInputHash(
          { test, correction },
          series.map((s) => s.values),
          xForHash(series),
        ),
        result,
        computedAt: new Date().toISOString(),
      };

      let placed = 0;
      let unplaceable = 0;

      api.transaction('Run analysis', () => {
        // Replace, never accumulate: a plot carries one result, so re-running
        // supersedes the previous one instead of stacking a second set of
        // brackets at the same heights.
        commit('Store analysis', (draft) => {
          replaceAnalysisForPlot(draft, analysis);
        });
        commit('Annotate significance', (draft) => {
          removeBracketsForPlot(draft, activePlot.id);

          // Measured from the renderer's own band scale so bracket ends land on
          // the bars; the gap grows per bracket so stacked ones do not collide.
          // The *draft's* node, not the one captured from the previous document
          // state: mixing the two puts a revoked Immer proxy into `measurePlot`'s
          // identity-keyed cache.
          const draftPlot = draft.nodes[activePlot.id];
          const measurements =
            draftPlot?.type === 'plot' ? (measurePlot(draft, draftPlot, theme) ?? undefined) : undefined;

          // A correlation has no two categories to span, so there is nothing to
          // bracket — the result belongs in the table and the methods sentence.
          if (!xyCorrelation) {
            result.comparisons.forEach((comparison, index) => {
              if (comparison.pAdjusted > options.alpha) return;
              const bracket = addBracket(draft, newId, {
                plotId: activePlot.id,
                analysis,
                comparisonIndex: index,
                gapMm: 2 + placed * 3.5,
                measurements,
              });
              if (bracket) placed++;
              else unplaceable++;
            });
          }

          // Bring any bracket on another panel back onto its bars too, in case
          // the layout moved since it was placed.
          repositionBrackets(draft, measureAllPlots(draft, theme));
        });
      });

      // Every one of these used to be silent, so "the test ran and nothing
      // appeared" was indistinguishable from a broken feature.
      const panelName = activePlot.parentId
        ? (doc.nodes[activePlot.parentId]?.name ?? activePlot.name)
        : activePlot.name;
      if (xyCorrelation) {
        setNotice(
          `Correlation on ${panelName}: the result is in the table below. A numeric x axis has no ` +
            'categories to span, so no bracket is drawn.',
        );
      } else if (unplaceable > 0) {
        setNotice(
          `${unplaceable} of ${result.comparisons.length} comparisons could not be placed on ` +
            `${panelName} — the analysed group names no longer match the plot's data.`,
        );
      } else if (placed === 0) {
        const how = correction === 'none' ? '' : ` after ${CORRECTION_LABEL[correction]}`;
        setNotice(
          `No comparison reached α = ${options.alpha}${how}, so no bracket was added to ` +
            `${panelName}. The p-values are in the table below.`,
        );
      } else {
        setNotice(`${placed} bracket${placed === 1 ? '' : 's'} added to ${panelName}.`);
      }
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
          {offeredTests.map((t) => (
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
        {counts ? 'Rows' : 'Groups'}:{' '}
        {series
          .map((s) => `${s.name} (${counts ? `total ${s.values.reduce((a, b) => a + b, 0)}` : `n=${s.values.length}`})`)
          .join(', ') || '—'}
      </p>

      {counts && (
        <p className="hint">
          This dataset is a contingency table, so only the count tests are offered — a
          t-test here would compare means of frequencies. Its categories are{' '}
          {contingencyCategories(dataset!).join(', ')}.
        </p>
      )}

      {blockedByContinuousAxis && (
        <p className="hint">
          This plot has a numeric x axis, so there are no groups to compare and nowhere to
          anchor a significance bracket. Select a categorical plot, or a correlation/regression
          test, to run.
        </p>
      )}

      <button
        className="primary"
        onClick={() => void run()}
        disabled={!minGroupsMet || blockedByContinuousAxis}
      >
        Run and annotate
      </button>

      {notice && <p className="hint notice">{notice}</p>}

      {analyses.map((analysis) => {
        // The document stores the input hash precisely so drift is detectable;
        // rehash the current values and say so when they no longer match.
        const analysisDataset = findDataset(doc, analysis.spec.datasetId);
        const analysisSeries = analysisDataset ? toSeries(analysisDataset) : [];
        const currentHash = analysisDataset
          ? analysisInputHash(
              { test: analysis.test, correction: analysis.options.correction },
              analysisSeries.map((s) => s.values),
              xForHash(analysisSeries),
            )
          : analysis.inputHash;
        const stale = isStale(analysis, currentHash);

        const analysisPlot = analysis.plotId ? doc.nodes[analysis.plotId] : undefined;
        const analysisPanel =
          analysisPlot?.parentId != null ? doc.nodes[analysisPlot.parentId] : undefined;
        const panelLabel =
          analysisPanel && analysisPanel.type === 'panel' ? analysisPanel.label : null;

        return (
        <div key={analysis.id} className="result">
          <h4>
            {panelLabel && <span className="panel-tag">{panelLabel}</span>} {analysis.name}
          </h4>

          {stale && (
            <p className="warning">
              The data behind this test has changed. Re-run it — the annotated p-values may no
              longer match what is plotted.
            </p>
          )}

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
        );
      })}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

function QualityTab({ api, theme, onSelectionChange, assets, exportDpi }: SidePanelProps) {
  const { document: doc } = api;

  const report = useMemo(() => {
    // The scene has to carry its images: text-size and colour rules read the
    // rendered tree, and a figure checked as a set of grey placeholders is not
    // the figure being submitted.
    const scene = renderDocument(doc, { theme, resolveAsset: (id) => assets.urls[id] });
    // Checked at the resolution it will be exported at. This tab used to keep
    // its own target, so two adjacent tabs of one panel could judge the same
    // micrograph differently — the Data tab has always read `exportDpi`.
    return checkFigure({ document: doc, theme, scene, exportDpi });
  }, [doc, theme, exportDpi, assets.urls]);

  const tone = report.score >= 90 ? 'good' : report.score >= 70 ? 'fair' : 'poor';

  const applyFix = (finding: Finding): void => {
    const fix = finding.fix;
    if (!fix) return;
    // One commit is already one undo entry, so a fix is undone in one keystroke.
    api.commit(fix.label, (draft) => fix.apply(draft, { newId: api.newId, theme }));
  };

  // Everything that repairs a defect without moving anything the author placed.
  // `rearranges` fixes are excluded: re-running Auto Layout as part of a batch
  // is exactly the sort of thing an author would not expect from a button
  // labelled "fix", so it keeps its own, which says what it does.
  const safeFixes = report.findings.filter((f) => f.fix && !f.fix.rearranges);

  return (
    <section>
      <h3>Publication readiness</h3>

      <div className={`score ${tone}`}>
        <span className="score-value">{report.score}</span>
        <span className="score-max">/ 100</span>
      </div>

      <p className="muted small">
        Checked at {exportDpi} dpi, the export resolution. Text stays text in PDF, EPS and SVG;
        PNG and TIFF are pixels by definition.
      </p>

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

      {safeFixes.length > 1 && (
        <button
          onClick={() =>
            // One transaction, so the whole batch undoes as a single action
            // rather than leaving the author to press Ctrl+Z once per fix.
            api.transaction('Fix quality issues', () => {
              for (const finding of safeFixes) applyFix(finding);
            })
          }
        >
          Fix {safeFixes.length} safe issues
        </button>
      )}

      {report.findings.map((finding: Finding) => (
        <div key={finding.id} className={`finding ${finding.severity}`}>
          <strong>{finding.title}</strong>
          <p>{finding.detail}</p>
          <div className="finding-actions">
            {finding.fix && (
              <button className="primary" onClick={() => applyFix(finding)}>
                {finding.fix.label}
              </button>
            )}
            {finding.nodeIds.length > 0 && (
              <button onClick={() => onSelectionChange(finding.nodeIds)}>
                Select {finding.nodeIds.length} affected
              </button>
            )}
          </div>
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

  // Highest z first, so the top of the list is the top of the stack — the
  // convention everywhere else, and the one the ▲/▼ buttons have to match.
  const nodesByLayer = (layerId: string) =>
    Object.values(doc.nodes)
      .filter((n) => n.layerId === layerId)
      .sort((a, b) => b.z - a.z);

  /**
   * What a row belongs to — the dataset behind a plot, the panel a label or
   * bracket annotates. Without it every plot reads "Plot" and two panels' worth
   * of brackets are indistinguishable.
   */
  const provenance = (node: (typeof doc.nodes)[string]): string | null => {
    const panelOf = (id: NodeId | null | undefined): string | null => {
      if (!id) return null;
      const panel = doc.nodes[id];
      if (!panel || panel.type !== 'panel') return null;
      return panel.label ? `panel ${panel.label}` : panel.name;
    };

    switch (node.type) {
      case 'plot':
        return findDataset(doc, node.datasetId)?.name ?? 'dataset missing';
      case 'panel-label':
        return panelOf(node.panelId);
      case 'bracket': {
        const plot = node.plotId ? doc.nodes[node.plotId] : undefined;
        return panelOf(plot?.parentId);
      }
      case 'image':
        // The filename, not the panel: six micrographs all reading "panel a"
        // is exactly the unreadability this column exists to fix.
        return findAsset(doc, node.assetId)?.filename ?? 'asset missing';
      case 'scale-bar': {
        // Calibration provenance is the point of the row. An uncalibrated bar
        // states a measurement nobody supplied, and it looks identical to one
        // that does not.
        const source = node.calibrationSource ?? 'unknown';
        const image = node.parentId ? doc.nodes[node.parentId] : undefined;
        if (image?.type !== 'image') return 'not on an image';
        return source === 'unknown' ? 'uncalibrated' : `${source} calibration`;
      }
      case 'group':
        return `${childrenOf(doc.nodes, node.id).length} items`;
      case 'panel':
        return null;
      default:
        return panelOf(node.parentId);
    }
  };

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
                  className={[
                    selectedIds.includes(node.id) ? 'selected' : '',
                    node.hidden ? 'node-hidden' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onSelectionChange([node.id])}
                >
                  <span className="node-type">{node.type}</span>
                  <span className="node-name">
                    {node.name}
                    {provenance(node) && <em className="provenance">{provenance(node)}</em>}
                  </span>
                  {/* Draw order among siblings. `nextZ` only ever appends, so
                      before this the only way to change what covered what was
                      to delete a node and add it back. */}
                  <button
                    className="icon"
                    title="Bring forward"
                    onClick={(e) => {
                      e.stopPropagation();
                      commit('Bring forward', (draft) => reorderNode(draft, node.id, 'forward'));
                    }}
                  >
                    ▲
                  </button>
                  <button
                    className="icon"
                    title="Send backward"
                    onClick={(e) => {
                      e.stopPropagation();
                      commit('Send backward', (draft) => reorderNode(draft, node.id, 'backward'));
                    }}
                  >
                    ▼
                  </button>
                  {/* Hiding is the reversible answer; deleting is not. Without
                      this the only way to take something out of the figure from
                      here was to remove it, and nothing put it back. */}
                  <button
                    className="icon"
                    title={node.hidden ? 'Show' : 'Hide'}
                    onClick={(e) => {
                      e.stopPropagation();
                      commit('Toggle visibility', (draft) => {
                        const target = draft.nodes[node.id];
                        if (target) target.hidden = !target.hidden;
                      });
                    }}
                  >
                    {node.hidden ? '◌' : '●'}
                  </button>
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
