/** Right-hand inspector: data, statistics, quality and layers. */

import { useMemo, useState, type ReactNode } from 'react';
import {
  CONTINUOUS_X_PLOT_TYPES,
  addAsset,
  addBracket,
  addPanelWithImage,
  addPanelWithImages,
  addPanelWithPlot,
  analysisInputHash,
  applyAutoLayout,
  childrenOf,
  dataPathFor,
  DEFAULT_VOLCANO_THRESHOLDS,
  defaultAnalysisOptions,
  effectiveDpi,
  findAsset,
  findDataset,
  couldHaveRowNames,
  dataBlocks,
  GROUPED_FORMATS,
  imagesUsingAsset,
  plotsUsingDataset,
  removeDataset,
  setDatasetReading,
  isContingency,
  contingencyCategories,
  isStale,
  nextPanelFrame,
  pointLabelColumnIndex,
  relabelPanels,
  removeAsset,
  removeBracketsForPlot,
  renameDataset,
  reorderNode,
  replaceAnalysisForPlot,
  repositionBrackets,
  toMatrix,
  toSeries,
  toSurvivalGroups,
  updateNode,
  xForHash,
  type Analysis,
  type Correction,
  type DataFormat,
  type Dataset,
  type Delimiter,
  type FigureDocument,
  type NodeId,
  type PlotNode,
  type StatTest,
} from '@figureforge/doc-model';
import {
  measureAllPlots,
  measurePlot,
  bracketStepMm,
  MAX_POINT_LABELS,
  reflowBrackets,
  type Finding,
  type QualityReport,
} from '@figureforge/render';
import type { Theme } from '@figureforge/theme';
import { analyze, ApiError, runPca, runUmap, runVolcanoTest } from '../api.js';
import { DataGrid } from './DataGrid.js';
import { InspectorTab } from './Inspector.js';
import { axisTitlesFor, datasetFromText, type ImportOptions } from '../sample.js';
import type { AssetsApi } from '../assets.js';
import { deleteNodesWithLayout } from '../deleteNodes.js';
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
    hint: 'Column 1 is the x for every series, matched row by row — right only if the series were sampled together.',
  },
  {
    id: 'sigmaplot',
    /*
     * Not "(paired)". That reads as *matched* pairs, which is the opposite of
     * what this layout means and exactly the confusion it was reported for: the
     * pairing here is a column with the column beside it, and no row of one
     * series is claimed to correspond to the same row of another.
     */
    label: 'X1, Y1, X2, Y2, … (own x per series)',
    hint: 'Each series carries its own x column, so runs sampled at different points stay independent. Nothing is matched row by row — use the shared-x layout above for that.',
  },
  {
    id: 'contingency',
    label: 'Contingency table (counts)',
    hint: 'One row per group, one column per category. Counts, not measurements: only chi-square and Fisher apply. Each count is its own bar.',
  },
  {
    id: 'grouped-replicates',
    label: 'Grouped — rows × groups (Prism)',
    hint: 'Column 1 labels the rows; the rest block into one group of replicates each. Two factors: a mark per row and group, coloured by group.',
  },
  {
    id: 'xy-replicates',
    label: 'XY + replicates (Prism)',
    hint: 'Column 1 is a shared x; the rest block into one group of replicate y columns each. Drawn as a line per group through the mean, with its spread.',
  },
  {
    id: 'nested',
    label: 'Nested — subjects within groups (Prism)',
    hint: 'Every column is a subject, blocked into groups. Points cluster by subject and colour by group. Plotted but not tested — a nested design needs a hierarchical model.',
  },
  {
    id: 'differential',
    label: 'Feature, log2 fold change, p-value',
    hint: 'Three columns in this order: a feature name, an effect size and a significance value — plus an optional 4th column, an FDR/q-value per point (use the ‹ › buttons above to reorder columns first). A raw differential-expression export has more columns in a different order — trim and reorder first. Draws as a volcano plot; not tested here, since the p-values are already the output of a test this app never ran. If your significance column already is −log10(p) rather than a raw p-value, say so in the plot’s Inspector after import.',
  },
  {
    // Directly under the differential layout: the two are neighbours in
    // meaning — this is the table a volcano test is run *on*, that is the
    // table it produces.
    id: 'proteomics',
    label: 'Proteomics — replicate intensities (LFQ)',
    hint: 'Column 1 names the protein; every other column is one sample’s intensity (LFQ, iBAQ, a normalised ratio). Its rows are features, not treatment groups, so the comparison runs down the columns: this is the only layout the Perseus-style volcano test is offered on, and the ordinary group-comparison tests are withheld. Imported as a table only, with no panel — it is the input to a test, not a figure. Choose it explicitly; nothing in the numbers themselves separates it from any other replicate table.',
  },
  {
    id: 'matrix',
    label: 'Matrix (rows × columns)',
    hint: 'Column 1 labels the rows, the header row labels the columns, one continuous value per cell — a gene-expression table, a correlation matrix, a distance matrix. Draws as a heatmap; not tested here, since there is no group comparison to run on a dense grid.',
  },
  {
    id: 'survival',
    label: 'Time, event, group (survival)',
    hint: 'One row per subject: a time to event or censoring, a 1/0 event flag (1 = the event happened, 0 = censored), and an optional treatment/arm column. Draws as a Kaplan–Meier curve; the only test offered here is the log-rank test.',
  },
];

/**
 * Layouts where a column block is a set of *replicates of one series*, rather
 * than a group of separate measurements. Only the wording of the count control
 * differs — "columns per group" says nothing to an author looking at a
 * timecourse whose three columns are three repeats of the same condition.
 */
const XY_REPLICATE_FORMATS: ReadonlySet<DataFormat> = new Set<DataFormat>([
  'prism',
  'xy-replicates',
]);

/**
 * Layouts where "row names in column 1" is a real question.
 *
 * Exactly the set `Dataset.hasRowNames` names as meaningful: the xy layouts,
 * where column 0 either holds x values or labels the rows and only the author
 * can say which. Every other format reads column 0 as a label by definition,
 * so offering the toggle there is a control that changes nothing.
 */
const ROW_NAME_FORMATS: ReadonlySet<DataFormat> = new Set<DataFormat>([
  'simple-xy',
  'prism',
  'sigmaplot',
]);

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
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  /**
   * Computed in App, not here: the export path checks the same report before
   * it sends a figure out, and two independent computations of a figure's
   * readiness would eventually disagree about the same figure.
   */
  report: QualityReport;
  cropNodeId: NodeId | null;
  onCropNodeChange: (id: NodeId | null) => void;
  measureNodeId: NodeId | null;
  /** Length of the last ruler drag, in source pixels; null until one happens. */
  measuredPx: number | null;
  onMeasureNodeChange: (id: NodeId | null) => void;
  /** Volcano plot whose points are being picked directly on the canvas. */
  labelPickNodeId: NodeId | null;
  onLabelPickNodeChange: (id: NodeId | null) => void;
}

export function SidePanel(props: SidePanelProps) {
  // The tab lives in App because two things outside this panel open it: the
  // readiness badge in the status bar, and the confirmation shown when an
  // export is about to carry an error out of the app.
  const { tab, onTabChange: setTab } = props;

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
            labelPickNodeId={props.labelPickNodeId}
            onLabelPickNodeChange={props.onLabelPickNodeChange}
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
  const [firstColumn, setFirstColumn] = useState<'data' | 'names'>('data');
  // 0 means "use whatever the file's group header row declared".
  const [replicatesPerGroup, setReplicatesPerGroup] = useState(0);

  const parseOptions: ImportOptions = useMemo(
    () => ({
      ...(delimiter !== '' ? { delimiter } : {}),
      ...(headerMode !== 'auto' ? { hasHeader: headerMode === 'yes' } : {}),
      ...(transpose ? { transpose: true } : {}),
      ...(format !== '' ? { format } : {}),
      ...(firstColumn === 'names' ? { hasRowNames: true } : {}),
      ...(replicatesPerGroup > 0 ? { replicatesPerGroup } : {}),
    }),
    [delimiter, headerMode, transpose, format, firstColumn, replicatesPerGroup],
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

  /*
   * The dataset whose grid is open, or null. It takes over the tab rather than
   * sitting inside it: a spreadsheet in a 340 px column is unusable, and there
   * is nothing else in this tab worth reading while a table is being edited.
   */
  const [editingId, setEditingId] = useState<NodeId | null>(null);
  const editing = editingId ? doc.datasets.find((d) => d.id === editingId) : undefined;
  /** Rows currently selected in the open grid — read by the volcano
   *  point-labelling row action below, kept as state (not a ref) since it
   *  drives whether that action's button is enabled. */
  const [selectedRowRange, setSelectedRowRange] = useState<{ r0: number; r1: number } | null>(
    null,
  );

  const importDataset = (): void => {
    if (!preview) return;
    const id = newId();
    const dataset = datasetFromText(pasted, name.trim() || defaultName, id, null, parseOptions);

    // Keep the text exactly as it arrived. Re-serialising through
    // `datasetToCsv` on save would round-trip the author's numbers, which is
    // the one thing `data/` exists to prevent.
    dataOriginals.set(dataPathFor(dataset), pasted);

    /*
     * A proteomics intensity table is the *input* to a test, not a figure.
     * Drawn as the layout would have it, a real one is hundreds or thousands
     * of bar-dot series over protein rows — a panel nobody wants and every
     * author would immediately delete. The sample document already leaves its
     * own proteomics table unattached for exactly this reason; this makes a
     * real import behave the way the sample already says is right.
     *
     * Scoped to this one layout. A `'matrix'` still opens as a heatmap, which
     * genuinely is a figure.
     */
    const dataOnly = dataset.format === 'proteomics';

    api.transaction('Import data', () => {
      commit('Add dataset', (draft) => {
        draft.datasets = [...draft.datasets, dataset];
      });
      if (dataOnly) return;
      commit('Add panel', (draft) => {
        // The author already labelled their columns; asking them to type the
        // same two words into the Inspector is work the header row did.
        const titles = axisTitlesFor(dataset);
        addPanelWithPlot(draft, newId, {
          // Below whatever is already on the page, so auto-layout's reading
          // order puts the new panel last rather than in panel a's cell.
          frame: nextPanelFrame(draft, { width: 60, height: 50 }),
          name: dataset.name,
          datasetId: dataset.id,
          // No type here: the layout chooses. Passing 'bar-dot' meant a
          // replicate-per-timepoint table opened as bars over its timepoints,
          // which is exactly the figure that layout exists to avoid.
          yTitle: titles.y ?? 'Value',
          ...(titles.x ? { xTitle: titles.x } : {}),
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
        reflowBrackets(draft, theme);
      });
    });

    setPasted('');
    setName('');
    // An import that visibly does nothing to the page reads as one that
    // failed, so the data-only path says what it did and where to go next —
    // the same informational use of `onError` the PCA/UMAP actions make.
    onError(
      dataOnly
        ? `Imported “${dataset.name}” (${dataset.rows.length} rows) as a table only — a ` +
            'proteomics intensity table is the input to a test, not a figure. Use “Run volcano ' +
            'test (Perseus-style) →” on its row below to draw one.'
        : null,
    );
  };

  // Divides each feature by its own sample SD before PCA — off by default,
  // the same "safer literal" stance heatmap's sequential-not-diverging
  // default already takes, since it materially changes the result and isn't
  // always wanted.
  const [pcaStandardize, setPcaStandardize] = useState(false);
  const [pcaBusyId, setPcaBusyId] = useState<NodeId | null>(null);

  // Which dataset's inline "Run volcano test" form is open — unlike PCA/UMAP,
  // this action needs the author to say which columns are which group before
  // anything can run, so it expands a form rather than running on one click.
  const [samFormId, setSamFormId] = useState<string | null>(null);
  // Two-sample mode: which columns are Group A / Group B. One-sample mode:
  // which columns are replicate values (tested against zero) — a separate
  // piece of state rather than overloading `samGroups`'s two-value type,
  // since "not one of two groups" and "not selected as a replicate value"
  // are different questions the UI asks depending on `samMode`.
  const [samMode, setSamMode] = useState<'two-sample' | 'one-sample'>('two-sample');
  const [samGroups, setSamGroups] = useState<Record<number, 'a' | 'b'>>({});
  const [samValueCols, setSamValueCols] = useState<Record<number, boolean>>({});
  const [samS0, setSamS0] = useState(0.1);
  const [samFdrPercent, setSamFdrPercent] = useState(5);
  const [samBusyId, setSamBusyId] = useState<NodeId | null>(null);

  /*
   * PCA is the first action in this app that creates a *new* dataset from an
   * existing one rather than editing it or importing one from pasted text —
   * so this mirrors `importDataset`'s own dataset+panel `transaction` shape,
   * just building the `Dataset` from the server's scores instead of
   * `datasetFromText`. There is no live link back to `source`: editing it
   * afterward does not update or stale-flag this PCA dataset, the same way
   * editing one imported dataset never reaches into another.
   */
  const runPcaOn = async (source: Dataset): Promise<void> => {
    const matrix = toMatrix(source);
    setPcaBusyId(source.id);
    setBusy('Running PCA');
    onError(null);

    try {
      const result = await runPca({
        rowLabels: matrix.rowLabels,
        values: matrix.cells,
        standardize: pcaStandardize,
      });

      const [pc1, pc2] = result.components;
      const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
      const pcaName = `${source.name} — PCA`;
      const pcaDataset: Dataset = {
        id: newId(),
        name: pcaName,
        format: 'pca',
        columns: [
          { name: 'Sample', kind: 'text' },
          { name: 'PC1', kind: 'number' },
          { name: 'PC2', kind: 'number' },
        ],
        rows: result.sampleLabels.map((label, i) => [
          label,
          result.scores[i]?.[0] ?? null,
          result.scores[i]?.[1] ?? null,
        ]),
        sourcePath: null,
        sourceFilename: null,
        importedAt: new Date().toISOString(),
      };

      api.transaction('Run PCA', () => {
        commit('Add PCA dataset', (draft) => {
          draft.datasets = [...draft.datasets, pcaDataset];
        });
        commit('Add PCA panel', (draft) => {
          addPanelWithPlot(draft, newId, {
            frame: nextPanelFrame(draft, { width: 60, height: 50 }),
            name: pcaName,
            datasetId: pcaDataset.id,
            plotType: 'scatter',
            xTitle: pc1 ? `PC1 (${pct(pc1.explainedVarianceRatio)})` : 'PC1',
            yTitle: pc2 ? `PC2 (${pct(pc2.explainedVarianceRatio)})` : 'PC2',
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
          reflowBrackets(draft, theme);
        });
      });

      // Reuses the "informational note through onError" precedent `onFile`
      // already sets below for a non-fatal import note — there is no
      // separate success-notice channel in this tab.
      const variance = [pc1, pc2]
        .filter((c): c is (typeof result)['components'][number] => c !== undefined)
        .map((c) => `${c.label} ${pct(c.explainedVarianceRatio)}`)
        .join(', ');
      const dropped =
        result.droppedSamples.length > 0
          ? ` ${result.droppedSamples.length} sample(s) dropped for a missing value.`
          : '';
      onError(`PCA on ${source.name}: ${variance}.${dropped}`);
    } catch (error) {
      onError(
        error instanceof ApiError
          ? `PCA failed: ${error.message}`
          : `Could not reach the analysis service. Is the API running? (${String(error)})`,
      );
    } finally {
      setBusy(null);
      setPcaBusyId(null);
    }
  };

  const [umapBusyId, setUmapBusyId] = useState<NodeId | null>(null);

  /*
   * UMAP reuses PCA's "create a new dataset+panel, no live link back to the
   * source" mechanism exactly, down to the `transaction`/two-`commit` shape —
   * this is the second consecutive stage that touches only this action, not
   * `packages/render` or `packages/plots`. Where it differs: no
   * percentage-explained annotation on the axis titles (a nonlinear embedding
   * has no per-axis variance-explained concept to state), and it shares the
   * standardize checkbox with PCA rather than duplicating it.
   */
  const runUmapOn = async (source: Dataset): Promise<void> => {
    const matrix = toMatrix(source);
    setUmapBusyId(source.id);
    setBusy('Running UMAP');
    onError(null);

    try {
      const result = await runUmap({
        rowLabels: matrix.rowLabels,
        values: matrix.cells,
        standardize: pcaStandardize,
      });

      const umapName = `${source.name} — UMAP`;
      const umapDataset: Dataset = {
        id: newId(),
        name: umapName,
        format: 'umap',
        columns: [
          { name: 'Sample', kind: 'text' },
          { name: 'UMAP1', kind: 'number' },
          { name: 'UMAP2', kind: 'number' },
        ],
        rows: result.sampleLabels.map((label, i) => [
          label,
          result.coords[i]?.[0] ?? null,
          result.coords[i]?.[1] ?? null,
        ]),
        sourcePath: null,
        sourceFilename: null,
        importedAt: new Date().toISOString(),
      };

      api.transaction('Run UMAP', () => {
        commit('Add UMAP dataset', (draft) => {
          draft.datasets = [...draft.datasets, umapDataset];
        });
        commit('Add UMAP panel', (draft) => {
          addPanelWithPlot(draft, newId, {
            frame: nextPanelFrame(draft, { width: 60, height: 50 }),
            name: umapName,
            datasetId: umapDataset.id,
            plotType: 'scatter',
            xTitle: 'UMAP1',
            yTitle: 'UMAP2',
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
          reflowBrackets(draft, theme);
        });
      });

      const dropped =
        result.droppedSamples.length > 0
          ? ` ${result.droppedSamples.length} sample(s) dropped for a missing value.`
          : '';
      const clamped =
        result.nNeighborsUsed < 15 ? ` (neighbours clamped to ${result.nNeighborsUsed})` : '';
      onError(
        `UMAP on ${source.name}: embedded ${result.sampleLabels.length} sample(s)${clamped}. ` +
          "UMAP axes aren't directly interpretable the way PCA's are — distances " +
          `in the plot are not distances in the original feature units.${dropped}`,
      );
    } catch (error) {
      onError(
        error instanceof ApiError
          ? `UMAP failed: ${error.message}`
          : `Could not reach the analysis service. Is the API running? (${String(error)})`,
      );
    } finally {
      setBusy(null);
      setUmapBusyId(null);
    }
  };

  /*
   * The Perseus-style permutation (SAM) volcano test. Unlike PCA/UMAP it
   * needs the author to say which columns are which group before it can run
   * at all — there is no way to guess a two-group split from column names
   * alone — so the trigger button expands an inline form (`samFormId`)
   * rather than running immediately. Once run, this follows PCA/UMAP's own
   * mechanism exactly: a new derived dataset and panel, with no live link
   * back to `source`.
   */
  const runSamVolcanoOn = async (
    source: Dataset,
    params:
      | { mode: 'two-sample'; groupAIndices: number[]; groupBIndices: number[] }
      | { mode: 'one-sample'; valueIndices: number[] },
    s0: number,
    fdrPercent: number,
  ): Promise<void> => {
    const matrix = toMatrix(source);
    setSamBusyId(source.id);
    setBusy('Running volcano test');
    onError(null);

    try {
      const result = await runVolcanoTest({
        rowLabels: matrix.rowLabels,
        values: matrix.cells,
        mode: params.mode,
        ...(params.mode === 'two-sample'
          ? { groupAIndices: params.groupAIndices, groupBIndices: params.groupBIndices }
          : { valueIndices: params.valueIndices }),
        s0,
        fdrPercent,
      });

      /*
       * A second run on the same source replaces the first result rather than
       * appending a second copy of it — the same "replace, don't accumulate"
       * stance `replaceAnalysisForPlot` already takes for statistical tests,
       * and for the same reason: two panels answering one question, differing
       * only in which parameters produced them, is not something a reader can
       * tell apart on the page.
       *
       * The link is the stored `derivedFrom`, never the generated name: the
       * name is editable in the list above.
       */
      const existing = doc.datasets.find(
        (d) => d.derivedFrom?.kind === 'volcano-test' && d.derivedFrom.datasetId === source.id,
      );
      const samName = existing?.name ?? `${source.name} — volcano test`;
      const samDataset: Dataset = {
        // Keeping the id is what makes this a replacement: every plot already
        // pointing here keeps pointing here, so its panel does not move and
        // its point labels — keyed on the label text, and the same proteins
        // come back — survive the re-run.
        id: existing?.id ?? newId(),
        name: samName,
        format: 'differential',
        columns: [
          { name: 'Feature', kind: 'text' },
          { name: 'log2FoldChange', kind: 'number' },
          { name: 'pValue', kind: 'number' },
          { name: 'qValue', kind: 'number' },
        ],
        rows: result.rows.map((r) => [r.label, r.log2FoldChange, r.pValue, r.qValue]),
        sourcePath: null,
        sourceFilename: null,
        importedAt: new Date().toISOString(),
        derivedFrom: { datasetId: source.id, kind: 'volcano-test' },
      };
      const volcanoPatch: Partial<PlotNode> = {
        volcanoThresholds: {
          ...DEFAULT_VOLCANO_THRESHOLDS,
          fdr: result.fdrAchieved,
          significanceBy: 'fdr',
        },
        volcanoSamCurve: {
          up: result.curveUp.map(([x, y]) => ({ x, y })),
          down: result.curveDown.map(([x, y]) => ({ x, y })),
        },
        // The record that lets this boundary be written up. Stored in the same
        // patch as the curve it describes, so a re-run replaces both together
        // and a figure can never carry a methods sentence for a boundary it no
        // longer draws.
        volcanoTest: {
          s0,
          fdrPercent,
          fdrAchieved: result.fdrAchieved,
          deltaUsed: result.deltaUsed,
          cutUp: result.cutUp,
          cutLow: result.cutLow,
          mode: params.mode,
          nTested: result.rows.length,
          nUp: result.rows.filter((r) => r.category === 'up').length,
          nDown: result.rows.filter((r) => r.category === 'down').length,
          methodsSentence: result.methodsSentence,
        },
      };
      // A panel is still built when the author deleted the previous one, so a
      // re-run recovers rather than appearing to do nothing.
      const reusedPlots = existing ? plotsUsingDataset(doc.nodes, existing.id) : [];
      const replaced = existing !== undefined && reusedPlots.length > 0;

      api.transaction('Run volcano test', () => {
        commit(replaced ? 'Update volcano test dataset' : 'Add volcano test dataset', (draft) => {
          draft.datasets = existing
            ? draft.datasets.map((d) => (d.id === existing.id ? samDataset : d))
            : [...draft.datasets, samDataset];
        });
        commit(replaced ? 'Update volcano test panel' : 'Add volcano test panel', (draft) => {
          if (replaced) {
            for (const plot of reusedPlots) updateNode<PlotNode>(draft, plot.id, volcanoPatch);
            // Nothing was added, so nothing is re-laid-out or re-lettered:
            // re-running a test must not shuffle the author's page.
            return;
          }
          const { plot } = addPanelWithPlot(draft, newId, {
            frame: nextPanelFrame(draft, { width: 60, height: 50 }),
            name: samName,
            datasetId: samDataset.id,
            plotType: 'volcano',
            xTitle: 'Log2 fold change',
            yTitle: '-Log10 p-value',
          });
          updateNode<PlotNode>(draft, plot.id, volcanoPatch);
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
          reflowBrackets(draft, theme);
        });
      });

      setSamFormId(null);
      setSamGroups({});
      setSamValueCols({});

      const dropped =
        result.droppedRows.length > 0
          ? ` ${result.droppedRows.length} row(s) dropped for a missing value in either group.`
          : '';
      onError(
        `Volcano test on ${source.name}: reached ${(result.fdrAchieved * 100).toFixed(1)}% FDR ` +
          `at delta ${result.deltaUsed.toFixed(3)}. ` +
          // Said explicitly, or the absence of a new panel reads as a run that
          // failed silently.
          (replaced
            ? `Updated the existing “${samName}” table and panel in place.`
            : `Added “${samName}” as a new table and panel.`) +
          dropped,
      );
    } catch (error) {
      onError(
        error instanceof ApiError
          ? `Volcano test failed: ${error.message}`
          : `Could not reach the analysis service. Is the API running? (${String(error)})`,
      );
    } finally {
      setBusy(null);
      setSamBusyId(null);
    }
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

  /**
   * Import one or more images.
   *
   * Several files land in *one* panel, tiled — the montage a multi-channel
   * micrograph figure is made of. One file behaves exactly as it always did,
   * including the aspect lock a single image gives its panel, which a montage
   * cannot have because there is no one honest ratio for several pictures.
   */
  const importImageFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    setBusy(files.length === 1 ? `Reading ${files[0]!.name}` : `Reading ${files.length} images`);
    onError(null);

    try {
      // Decoded first, all of them: a partial commit would leave a panel
      // holding some of the montage with no way to say which files failed.
      const decoded: { imported: Awaited<ReturnType<typeof importImage>>; assetId: string }[] =
        [];
      for (const file of files) {
        const imported = await importImage(file);
        const assetId = newId();
        // Bytes before the commit: the commit registers the asset, and a
        // document referencing one the store has never seen renders a
        // placeholder.
        assets.store.add(assetId, imported.bytes);
        decoded.push({ imported, assetId });
      }

      const first = decoded[0]!.imported;

      commit(files.length === 1 ? 'Add image' : `Add ${files.length} images`, (draft) => {
        // Asset records and image nodes in ONE commit. Referential integrity
        // rejects an image whose asset is unregistered, so splitting them
        // would leave a figure that edits fine and cannot be saved.
        for (const { imported, assetId } of decoded) {
          addAsset(draft, {
            id: assetId,
            filename: imported.filename,
            mimeType: imported.bytes.mimeType,
            byteLength: imported.bytes.original.length,
            naturalPx: imported.naturalPx,
          });
        }

        const frame = nextPanelFrame(
          draft,
          initialImageSize(first.aspect, draft.page.widthMm, draft.page.heightMm),
        );
        const images = decoded.map(({ imported, assetId }) => ({
          name: imported.filename,
          assetId,
          // Vector sources carry {0,0}: there is no pixel grid to record, and
          // the resolution check skips them by MIME type rather than by this.
          naturalPx: imported.naturalPx ?? { width: 0, height: 0 },
        }));

        if (images.length === 1) {
          addPanelWithImage(draft, newId, { frame, ...images[0]! });
        } else {
          addPanelWithImages(draft, newId, {
            frame,
            name: `${first.filename} +${images.length - 1}`,
            images,
          });
        }

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
        reflowBrackets(draft, theme);
      });

      const notes = decoded.flatMap((d) => d.imported.notes);
      if (notes.length > 0) onError([...new Set(notes)].join(' '));
    } catch (error) {
      onError(`Could not import: ${String(error)}`);
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

  // The grid takes the whole tab while it is open. Nothing else here is worth
  // reading mid-edit, and a spreadsheet squeezed into a 340 px column is not a
  // spreadsheet.
  if (editing) {
    /*
     * The volcano-labelling row action, when this dataset feeds one.
     *
     * `pointLabelColumnIndex` is the single spelling of "column 0 carries the
     * point label" that `toSeries`'s own `differential`/`pca`/`umap` cases
     * already act on — reading it here rather than re-deriving the fact is
     * what keeps a row's label the same one the plot itself would draw.
     */
    const labelColumn = pointLabelColumnIndex(editing);
    const volcanoPlot =
      labelColumn !== null
        ? Object.values(doc.nodes).find(
            (n): n is PlotNode =>
              n.type === 'plot' && n.plotType === 'volcano' && n.datasetId === editing.id,
          )
        : undefined;

    const rowLabelAt = (r: number): string | null => {
      if (labelColumn === null) return null;
      const value = editing.rows[r]?.[labelColumn];
      return value === null || value === undefined ? null : String(value);
    };

    const currentLabels = volcanoPlot?.volcanoLabels ?? [];
    const markedRows =
      volcanoPlot &&
      new Set(
        editing.rows
          .map((_, r) => r)
          .filter((r) => {
            const rowLabel = rowLabelAt(r);
            return rowLabel !== null && currentLabels.includes(rowLabel);
          }),
      );

    let disabledReason: string | null = null;
    if (volcanoPlot) {
      if (currentLabels.length >= MAX_POINT_LABELS) {
        disabledReason =
          '25 labels is the maximum — past that a key stops being readable and the leaders cross.';
      } else if (selectedRowRange) {
        const usable = [];
        for (let r = selectedRowRange.r0; r <= selectedRowRange.r1; r++) {
          const rowLabel = rowLabelAt(r);
          if (rowLabel !== null && !currentLabels.includes(rowLabel)) usable.push(rowLabel);
        }
        if (usable.length === 0) {
          disabledReason =
            'None of the selected rows have a usable label, fold change and p-value, or they are already on the plot.';
        }
      }
    }

    return (
      <DataGrid
        api={api}
        dataset={editing}
        onClose={() => setEditingId(null)}
        onRowRangeChange={setSelectedRowRange}
        markedRows={markedRows}
        rowAction={
          volcanoPlot
            ? {
                label: 'Label these rows on the plot',
                disabledReason,
                onApply: (r0, r1) => {
                  const toAdd: string[] = [];
                  for (let r = r0; r <= r1; r++) {
                    const rowLabel = rowLabelAt(r);
                    if (rowLabel !== null && !currentLabels.includes(rowLabel) && !toAdd.includes(rowLabel)) {
                      toAdd.push(rowLabel);
                    }
                  }
                  const next = [...currentLabels, ...toAdd].slice(0, MAX_POINT_LABELS);
                  commit('Label points', (draft) => {
                    const target = draft.nodes[volcanoPlot.id];
                    if (target?.type === 'plot') target.volcanoLabels = next;
                  });
                },
              }
            : undefined
        }
      />
    );
  }

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
            {/* The label, not the enum member: "sigmaplot" on screen says
                nothing about how the columns are being read. */}
            {format === '' ? 'Detected' : 'Reading as'}{' '}
            <strong>
              {DATA_FORMATS.find((f) => f.id === preview.format)?.label ?? preview.format}
            </strong>{' '}
            · {preview.columns.length} columns · {preview.rows.length} rows
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

          {/* Offered only when the question is genuinely open — a text column
              in front of numbers is both a row-labelled xy table and a
              replicate table, and nothing in the cells tells them apart. It is
              a choice, never a guess: guessing read a dose-response replicate
              table as xy, because its group means ascend like an axis. */}
          {couldHaveRowNames(preview.columns) && (
            <div className="field-row">
              <label className="field">
                First column
                <select
                  value={firstColumn}
                  onChange={(e) => setFirstColumn(e.target.value as 'data' | 'names')}
                >
                  <option value="data">Data — group labels or x values</option>
                  <option value="names">Row names — the data starts in column 2</option>
                </select>
              </label>
            </div>
          )}

          {/* Column blocks: read from the header when the file declares them,
              settable when it does not. Nothing infers a split — six columns
              are as plausibly six groups of one as two of three, and a wrong
              guess averages the wrong numbers into a plausible mean.

              Offered on `prism` and `replicate` too, where it is the *only* way
              to say that the columns block rather than each standing alone; a
              count of 2 or more reads them as XY + replicates and as Grouped
              respectively. Both detections are what a Prism table lands on when
              it is pasted without its group-title row. */}
          {(GROUPED_FORMATS.has(preview.format) ||
            preview.format === 'prism' ||
            preview.format === 'replicate') && (
            <div className="field-row">
              <label className="field">
                {XY_REPLICATE_FORMATS.has(preview.format)
                  ? 'Replicate y columns per series'
                  : 'Columns per group'}
                <input
                  type="number"
                  min={0}
                  max={Math.max(1, preview.columns.length)}
                  value={replicatesPerGroup}
                  onChange={(e) => setReplicatesPerGroup(Math.max(0, Number(e.target.value) || 0))}
                />
              </label>
              <span className="muted">
                {replicatesPerGroup > 0
                  ? `${dataBlocks(preview).length} groups`
                  : preview.columnGroups && preview.columnGroups.length > 0
                    ? `from the header: ${preview.columnGroups.map((g) => g.name).join(', ')}`
                    : preview.format === 'prism'
                      ? '0 = every y column is its own series'
                      : '0 = one group; set it if the file has no group header row'}
              </span>
            </div>
          )}

          <p className="hint">
            {DATA_FORMATS.find((f) => f.id === preview.format)?.hint}
            {preview.hasRowNames && ' Column 1 names the rows; the data starts in column 2.'}
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

          {/* The label has to keep its own promise: a proteomics table is
              imported without a panel, so saying "as new panel" there would
              be a control describing something it does not do. */}
          <button className="primary" onClick={importDataset}>
            {preview.format === 'proteomics' ? 'Import data table' : 'Import as new panel'}
          </button>
        </div>
      )}

      <h3>Datasets</h3>
      <label className="check" title="Divide each feature by its own sample SD before reducing">
        <input
          type="checkbox"
          checked={pcaStandardize}
          onChange={(e) => setPcaStandardize(e.target.checked)}
        />
        Standardize features before reducing
      </label>
      <ul className="list">
        {doc.datasets.map((dataset) => {
          const uses = plotsUsingDataset(doc.nodes, dataset.id);
          const matrix = dataset.format === 'matrix' ? toMatrix(dataset) : null;
          const pcaEligible = matrix !== null && matrix.rowLabels.length >= 3 && matrix.colLabels.length >= 2;
          // UMAP's own minimum, stricter than PCA's 3: it needs a real local
          // neighbourhood to mean anything.
          const umapEligible = matrix !== null && matrix.rowLabels.length >= 4;
          /*
           * `toMatrix` is purely structural (column 0 a label, the rest plain
           * numbers) and never reads `dataset.format` at all — which is
           * exactly why the format gate has to do the deciding. Nothing in the
           * cells separates a proteomics intensity table from any other table
           * of replicate measurements, so a structural gate put this button
           * beside every unrelated dataset in the document, enabled. It is
           * offered on the declared `'proteomics'` layout alone: the author
           * says the rows are features, and only then is a test that compares
           * down the columns a sensible thing to offer.
           */
          const samMatrix = dataset.format === 'proteomics' ? toMatrix(dataset) : null;
          // At least 3 columns — the one-sample mode's own minimum; the
          // two-sample mode's stricter 2+2 is enforced by the inline form's
          // own `ready` check once a mode is chosen.
          const samEligible =
            samMatrix !== null && samMatrix.rowLabels.length >= 4 && samMatrix.colLabels.length >= 3;
          return (
            <li key={dataset.id}>
              {/* Editable in place: the name propagates to the panel and plot,
                  which is what makes the Layers list readable. */}
              <input
                className="rename"
                value={dataset.name}
                title={dataset.name}
                onChange={(e) =>
                  commit('Rename dataset', (draft) =>
                    renameDataset(draft, dataset.id, e.target.value),
                  )
                }
              />
              <span className="muted">{toSeries(dataset).length} series</span>
              {/* The layout control sits on the action row rather than beside
                  the name. Its widest option is most of a 340 px panel, and a
                  <select> cannot shrink below its longest label — so all of the
                  deficit came out of the name, which is the one field here an
                  author has to be able to read. */}
              <div className="field-row">
                {/* Fixable after the fact: a layout is a reading of the same
                    rows, not a transformation of them, so changing it is
                    lossless. `toSeries` is the only consumer of this field.
                    Neither `'pca'` nor `'umap'` is offered here at all —
                    nothing in `DATA_FORMATS` names them, since neither is a
                    reading a raw paste can take, only an output the "Run
                    PCA"/"Run UMAP" actions themselves produce. */}
                {dataset.format === 'pca' ? (
                  <span className="muted">PCA output (PC1, PC2)</span>
                ) : dataset.format === 'umap' ? (
                  <span className="muted">UMAP output (UMAP1, UMAP2)</span>
                ) : (
                  <select
                    value={dataset.format}
                    title="How these columns are read"
                    onChange={(e) =>
                      commit('Change data layout', (draft) =>
                        setDatasetReading(draft, dataset.id, {
                          format: e.target.value as DataFormat,
                        }),
                      )
                    }
                  >
                    {DATA_FORMATS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                )}
                <button onClick={() => setEditingId(dataset.id)}>Edit data…</button>
                {dataset.format === 'matrix' && (
                  <button
                    title={
                      pcaEligible
                        ? 'Reduce this matrix to its first two principal components'
                        : 'PCA needs at least 3 rows and 2 columns'
                    }
                    disabled={!pcaEligible || pcaBusyId === dataset.id}
                    onClick={() => void runPcaOn(dataset)}
                  >
                    Run PCA →
                  </button>
                )}
                {dataset.format === 'matrix' && (
                  <button
                    title={
                      umapEligible
                        ? 'Embed this matrix into a 2D UMAP projection'
                        : 'UMAP needs at least 4 rows'
                    }
                    disabled={!umapEligible || umapBusyId === dataset.id}
                    onClick={() => void runUmapOn(dataset)}
                  >
                    Run UMAP →
                  </button>
                )}
                {dataset.format === 'proteomics' && (
                  <button
                    title={
                      samEligible
                        ? "Choose the groups to compare (or replicate values), an S0 cutoff and a target FDR — Perseus's own volcano-plot significance test"
                        : 'Needs at least 4 rows and 3+ replicate columns (2+2 for a two-group test)'
                    }
                    disabled={!samEligible || samBusyId === dataset.id}
                    onClick={() => {
                      setSamGroups({});
                      setSamValueCols({});
                      setSamFormId(samFormId === dataset.id ? null : dataset.id);
                    }}
                  >
                    Run volcano test (Perseus-style) →
                  </button>
                )}
                {/* Only the xy layouts read this. Every other format already
                    treats column 0 as a label by definition, so the checkbox
                    was a control that visibly did nothing on most of the
                    tables it appeared beside — see `Dataset.hasRowNames`'s
                    own doc comment, which has said so since it was added. */}
                {ROW_NAME_FORMATS.has(dataset.format) && (
                  <label className="check" title="Column 1 labels the rows rather than holding data">
                    <input
                      type="checkbox"
                      checked={dataset.hasRowNames ?? false}
                      onChange={(e) =>
                        commit('Change first column', (draft) =>
                          setDatasetReading(draft, dataset.id, { hasRowNames: e.target.checked }),
                        )
                      }
                    />
                    Row names in column 1
                  </label>
                )}
                {dataset.editedAt && (
                  <span className="muted" title={`Last edited ${dataset.editedAt}`}>
                    edited
                  </span>
                )}
                {uses.length > 0 ? (
                  <span className="muted">
                    used by {uses.length} {uses.length === 1 ? 'panel' : 'panels'}
                  </span>
                ) : (
                  <>
                    {/* Offered only once nothing reads it. A plot pointing at a
                        missing dataset fails referential integrity, so the
                        figure would edit fine and then refuse to save. */}
                    <span className="muted">not used</span>
                    <button
                      className="danger"
                      onClick={() =>
                        commit('Remove dataset', (draft) => {
                          removeDataset(draft, dataset.id);
                        })
                      }
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
              {samFormId === dataset.id && samMatrix && (
                <div className="sam-volcano-form">
                  <p className="hint">
                    Perseus's own volcano-plot test: choose the groups to compare (or replicate
                    values), an S0 cutoff, and a target FDR.
                  </p>
                  <label className="field">
                    Test design
                    <select
                      value={samMode}
                      onChange={(e) => {
                        setSamMode(e.target.value as 'two-sample' | 'one-sample');
                        setSamGroups({});
                        setSamValueCols({});
                      }}
                    >
                      <option value="two-sample">Two groups (raw replicate measurements)</option>
                      <option value="one-sample">
                        One sample (replicate values vs. zero, e.g. per-replicate ratios)
                      </option>
                    </select>
                  </label>
                  {samMode === 'two-sample' ? (
                    <>
                      <p className="hint">
                        Assign each sample column to Group A or Group B — the volcano's fold
                        change is Group B minus Group A.
                      </p>
                      <div className="field-row">
                        {samMatrix.colLabels.map((label, i) => (
                          <label key={i} className="field">
                            {label}
                            <select
                              value={samGroups[i] ?? ''}
                              onChange={(e) =>
                                setSamGroups((prev) => {
                                  const next = { ...prev };
                                  const value = e.target.value;
                                  if (value === 'a' || value === 'b') next[i] = value;
                                  else delete next[i];
                                  return next;
                                })
                              }
                            >
                              <option value="">—</option>
                              <option value="a">Group A</option>
                              <option value="b">Group B</option>
                            </select>
                          </label>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="hint">
                        Check each column that holds a replicate value to test against zero —
                        leave any other column (e.g. a per-replicate p-value) unchecked.
                      </p>
                      <div className="field-row">
                        {samMatrix.colLabels.map((label, i) => (
                          <label key={i} className="check">
                            <input
                              type="checkbox"
                              checked={samValueCols[i] ?? false}
                              onChange={(e) =>
                                setSamValueCols((prev) => ({ ...prev, [i]: e.target.checked }))
                              }
                            />
                            {label}
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                  <div className="field-row">
                    <label className="field">
                      s0
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={samS0}
                        onChange={(e) => setSamS0(Math.max(0, Number(e.target.value) || 0))}
                      />
                    </label>
                    <label className="field">
                      Target FDR (%)
                      <input
                        type="number"
                        min={0.01}
                        max={100}
                        step={0.1}
                        value={samFdrPercent}
                        onChange={(e) =>
                          setSamFdrPercent(Math.min(100, Math.max(0.01, Number(e.target.value) || 0.01)))
                        }
                      />
                    </label>
                  </div>
                  {(() => {
                    if (samMode === 'one-sample') {
                      const valueIndices = Object.entries(samValueCols)
                        .filter(([, checked]) => checked)
                        .map(([i]) => Number(i));
                      const ready = valueIndices.length >= 3;
                      return (
                        <button
                          className="primary"
                          disabled={!ready || samBusyId === dataset.id}
                          title={ready ? undefined : 'Needs at least 3 replicate columns'}
                          onClick={() =>
                            void runSamVolcanoOn(
                              dataset,
                              { mode: 'one-sample', valueIndices },
                              samS0,
                              samFdrPercent,
                            )
                          }
                        >
                          Run
                        </button>
                      );
                    }
                    const groupA = Object.entries(samGroups)
                      .filter(([, g]) => g === 'a')
                      .map(([i]) => Number(i));
                    const groupB = Object.entries(samGroups)
                      .filter(([, g]) => g === 'b')
                      .map(([i]) => Number(i));
                    const ready = groupA.length >= 2 && groupB.length >= 2;
                    return (
                      <button
                        className="primary"
                        disabled={!ready || samBusyId === dataset.id}
                        title={ready ? undefined : 'Each group needs at least 2 columns'}
                        onClick={() =>
                          void runSamVolcanoOn(
                            dataset,
                            { mode: 'two-sample', groupAIndices: groupA, groupBIndices: groupB },
                            samS0,
                            samFdrPercent,
                          )
                        }
                      >
                        Run
                      </button>
                    );
                  })()}
                </div>
              )}
            </li>
          );
        })}
        {doc.datasets.length === 0 && <li className="muted">No data imported yet.</li>}
      </ul>

      <h3>Images</h3>
      <p className="hint">
        Micrographs, blots, gels and schematics. PNG, JPEG, SVG or TIFF — TIFF is decoded by the
        analysis service, and the original is kept in the project either way. Select several at
        once and they are tiled into one panel; the grid is editable in the Inspector.
      </p>

      <label className="file-button">
        Add image(s)
        <input
          type="file"
          multiple
          accept={ACCEPTED_IMAGE_TYPES}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length > 0) void importImageFiles(files);
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
          {(totalAssetBytes / 1e6).toFixed(0)} MB of images. The project streams to disk as it
          saves, so the limit is how much your browser will hold at once rather than twice this
          again — but a figure this heavy will still be slow to open and to export.
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
  { id: 'log-rank', label: 'Log-rank test' },
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
  /*
   * A volcano's x is a fold change and its y is already -log10 of a p-value
   * this app never computed — correlating the two would be Pearson/Spearman
   * on an effect size against a transform of its own significance call,
   * which answers nothing. `differential` excludes it from the correlation
   * gate below even though it otherwise looks exactly like a single-series
   * numeric-x plot, the shape `xyCorrelation` exists to allow.
   */
  const differential = dataset?.format === 'differential';
  /*
   * Whether a correlation/regression *could* run here at all, asked of the
   * data alone. Split out from `xyCorrelation` below — which is the same
   * question plus "and one is currently selected" — because the dropdown has
   * to decide what to offer before a test is chosen, and deciding that from a
   * predicate that already depends on the choice is circular.
   */
  const correlationPossible = series.length === 1 && series[0]?.x !== undefined && !differential;
  const xyCorrelation = CORRELATION_TESTS.has(test) && correlationPossible;
  /*
   * A survival curve's x is continuous time too, exactly the shape
   * `blockedByContinuousAxis` exists to refuse group comparisons on — so
   * log-rank needs the same carve-out `xyCorrelation` gets, for the same
   * reason: it is the one test built for this axis shape, not a group
   * comparison mistakenly allowed through it.
   */
  const survival = dataset?.format === 'survival';
  const survivalLogRank = survival && test === 'log-rank';
  const blockedByContinuousAxis = continuousPlot && !xyCorrelation && !survivalLogRank;
  /*
   * A horizontal plot's categories run down the side, not along the bottom
   * — there is nowhere flat to sit a bracket above a bar the way vertical
   * orientation has. `measurePlot` already refuses it there (the same
   * empty-measurements answer continuous plots get), so this gate keeps the
   * Stats tab from offering a test whose result could never be drawn.
   * `!continuousPlot` guards it the same way `blockedByContinuousAxis`
   * guards itself — orientation is only ever meaningful on a categorical
   * plot type.
   */
  const blockedByHorizontalOrientation = !continuousPlot && activePlot?.orientation === 'horizontal';
  const minGroupsMet = xyCorrelation ? series.length >= 1 : series.length >= 2;

  // Counts and measurements take disjoint tests; see COUNT_TESTS.
  const counts = dataset !== undefined && isContingency(dataset);

  /*
   * Nested data is plotted but not tested.
   *
   * Prism's nested t-test fits a hierarchical model, in which the subjects are
   * a random effect. Pooling the subcolumns and running an ordinary test treats
   * every observation as independent when by construction they are not, which
   * inflates n and shrinks p — the error the design exists to avoid. Averaging
   * each subject first is a *different* procedure answering a different
   * question. SciPy has no nested test, so this is refused with a reason rather
   * than approximated, exactly as Fisher's is above 2x2.
   */
  const nested = dataset?.format === 'nested';

  /*
   * A dense matrix reads through `toSeries` as one series per cell, purely so
   * generic UI (the dataset list's "N series" count) has something to show —
   * `continuousPlot`/`minGroupsMet` above would otherwise see plenty of
   * "groups" and let an ordinary test run comparing single-value cells
   * against each other, which compares nothing meaningful. Refused outright,
   * the same stance as `nested`/`differential`.
   */
  const matrix = dataset?.format === 'matrix';

  /*
   * A proteomics intensity table reads through `toSeries` as one series per
   * *protein*, so an ordinary group comparison here would compare one protein
   * against another — not a question anyone is asking of this table. Its own
   * comparison runs down the columns, and that is the volcano test in the
   * Data tab, not anything here. Refused for the same reason `matrix` is.
   */
  const proteomics = dataset?.format === 'proteomics';

  /*
   * Formats that carry no runnable test at all. Their controls are hidden
   * rather than shown-and-disabled: a dropdown of tests that cannot run,
   * above a button that refuses, is a longer way of saying nothing applies.
   */
  const noTestApplies = nested || differential || matrix || proteomics;

  /*
   * Log-rank is the only test that reads a subject's time and event flag
   * together rather than treating a group as a plain sample of measurements
   * — offered only for a survival-format dataset, and it is the only test
   * offered there, the same two-way gate `COUNT_TESTS` already runs for a
   * contingency table.
   *
   * A numeric-x plot narrows the list the same way: only the correlation
   * family has any meaning without categories to span, and only when the
   * series actually carries the paired x it consumes.
   */
  const offeredTests = TESTS.filter((t) => {
    if (noTestApplies || blockedByHorizontalOrientation) return false;
    if (t.id === 'log-rank') return survival;
    if (survival) return false;
    if (COUNT_TESTS.has(t.id) !== counts) return false;
    if (continuousPlot) return CORRELATION_TESTS.has(t.id) && correlationPossible;
    return true;
  });

  /*
   * One correction, not one per reason the list can change.
   *
   * This replaced a `counts` echo and a `survival` echo that each fixed up
   * `test` for their own case; narrowing the list further (continuous plots,
   * the formats above) would have wanted a third. Three mechanisms
   * maintaining one invariant is how they come to disagree — asking the list
   * itself whether the selection is still in it covers every reason at once,
   * present and future.
   *
   * `null` rather than the first offered id, so this runs on the component's
   * very first render: `StatsTab` mounts fresh each time the tab is opened,
   * and a plot can already be selected before it exists at all.
   */
  const offeredKey = offeredTests.map((t) => t.id).join(',');
  const [offeredEcho, setOfferedEcho] = useState<string | null>(null);
  if (offeredEcho !== offeredKey) {
    setOfferedEcho(offeredKey);
    const first = offeredTests[0];
    if (first && !offeredTests.some((t) => t.id === test)) setTest(first.id);
  }

  const run = async (): Promise<void> => {
    if (matrix) {
      onError(
        'A heatmap has no groups to compare — each cell is its own value, not a group of ' +
          'replicates. There is nothing to test on this table here.',
      );
      return;
    }
    if (differential) {
      onError(
        'This table already holds computed significance values; there is nothing further to ' +
          'test on them here.',
      );
      return;
    }
    if (nested) {
      onError(
        'Nested data needs a hierarchical model, which this build does not have. Pooling the ' +
          'subcolumns would treat observations within a subject as independent and report a ' +
          'p-value that is too small.',
      );
      return;
    }
    if (proteomics) {
      onError(
        'A proteomics intensity table’s rows are proteins, not groups — a test here would ' +
          'compare one protein against another. Its comparison runs down the columns: use ' +
          '“Run volcano test (Perseus-style)” on the Data tab.',
      );
      return;
    }
    if (survival && !survivalLogRank) {
      onError(
        'A survival dataset supports only the log-rank test — every other test compares ' +
          'measurements, and a follow-up time is not one.',
      );
      return;
    }
    if (blockedByContinuousAxis) {
      onError('Group comparisons need a categorical plot; this one has a numeric x axis.');
      return;
    }
    if (blockedByHorizontalOrientation) {
      onError(
        "This plot's categories run down the side, so there is nowhere flat to anchor a " +
          'significance bracket. Switch it back to vertical to compare groups.',
      );
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
      // A subject row is not a replicate to pool, so log-rank reads through
      // `toSurvivalGroups`, not `toSeries` — `series` here carries only the
      // times (`toSeries`'s minimal `'survival'` case), with nowhere to
      // carry the event flag every log-rank term needs.
      const survivalGroups = survivalLogRank ? toSurvivalGroups(dataset) : [];

      const groupsPayload = xyCorrelation
        ? [{ name: series[0]!.name, values: series[0]!.values }]
        : series.map((s) => ({ name: s.name, values: s.values }));
      const xPayload = xyCorrelation
        ? { name: dataset.columns[0]?.name ?? 'x', values: series[0]!.x! }
        : undefined;
      const eventsPayload = survivalLogRank
        ? survivalGroups.map((g) => ({ name: g.name, values: g.events.map((e) => (e ? 1 : 0)) }))
        : undefined;

      const result = await analyze({
        test,
        groups: groupsPayload,
        x: xPayload,
        events: eventsPayload,
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
          survivalLogRank ? survivalGroups.map((g) => g.events) : undefined,
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
          // the bars. The *draft's* node, not the one captured from the previous
          // document state: mixing the two puts a revoked Immer proxy into
          // `measurePlot`'s identity-keyed cache.
          const draftPlot = draft.nodes[activePlot.id];
          const measurements =
            draftPlot?.type === 'plot' ? (measurePlot(draft, draftPlot, theme) ?? undefined) : undefined;

          // A correlation has no two categories to span, so there is nothing to
          // bracket — the result belongs in the table and the methods sentence.
          // A Kaplan–Meier plot's x axis is continuous time for the same
          // reason: there is no categorical band for a bracket to anchor to.
          if (!xyCorrelation && !survivalLogRank) {
            result.comparisons.forEach((comparison, index) => {
              if (comparison.pAdjusted > options.alpha) return;
              // Placed provisionally; the stacking is settled below, once every
              // bracket on this plot exists. The caller used to pass an
              // increasing gap per bracket, which cannot see whether two
              // comparisons even overlap and collapsed them onto one line as
              // soon as the panel ran out of headroom.
              const bracket = addBracket(draft, newId, {
                plotId: activePlot.id,
                analysis,
                comparisonIndex: index,
                measurements,
              });
              if (bracket) placed++;
              else unplaceable++;
            });
          }

          // Settles this plot's stack, and brings any bracket on another panel
          // back onto its bars in case the layout moved since it was placed.
          repositionBrackets(draft, measureAllPlots(draft, theme), {
            stepMm: bracketStepMm(theme),
          });
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
      } else if (survivalLogRank) {
        setNotice(
          `Log-rank test on ${panelName}: the result is in the table below. A Kaplan–Meier ` +
            "curve's x axis is continuous time, not discrete categories, so no bracket is drawn.",
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

      {/* Hidden outright where nothing can run, rather than offered and then
          refused. What stays is the one line saying why — that is the tab's
          own state, not a missing option, and an entirely blank Analysis tab
          reads as broken. */}
      {offeredTests.length > 0 && (
        <>
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
        </>
      )}

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

      {survival && (
        <p className="hint">
          This dataset is subject-level time-to-event data, so only the log-rank test is
          offered — every other test compares measurements, and a follow-up time is not one.
        </p>
      )}

      {continuousPlot && !noTestApplies && !survival && (
        <p className="hint">
          This plot has a numeric x axis, so there are no groups to compare and nowhere to anchor
          a significance bracket.{' '}
          {correlationPossible
            ? 'Only correlation and regression are offered, which read the paired x values instead.'
            : 'Correlation and regression would read paired x values, and this dataset has one series carrying none — so no test is offered here. Select a categorical plot to compare groups.'}
        </p>
      )}

      {blockedByHorizontalOrientation && (
        <p className="hint">
          This plot's categories run down the side, so there is nowhere flat to anchor a
          significance bracket. Switch it back to vertical in the Inspector to compare groups.
        </p>
      )}

      {nested && (
        <p className="hint">
          Nested data plots here but is not tested. A nested design needs a hierarchical model,
          in which the subcolumns are a random effect; pooling them and running an ordinary test
          would count every observation as independent, inflate n and report a p-value that is
          too small. Averaging each subject first answers a different question. This build has
          no nested test, so it declines rather than approximating one.
        </p>
      )}

      {differential && (
        <p className="hint">
          A volcano plot's p-values are already the output of a test run elsewhere — correlating
          the fold change against its own significance call answers nothing. There is no test to
          run on this table here; the cutoffs that colour the plot are set in the Inspector.
        </p>
      )}

      {matrix && (
        <p className="hint">
          A heatmap's cells are values to colour, not groups to compare — there is no test to run
          on this table here. The colour scale is set in the Inspector.
        </p>
      )}

      {proteomics && (
        <p className="hint">
          This table's rows are proteins, not groups — a test here would compare one protein
          against another. Its comparison runs down the columns instead: use “Run volcano test
          (Perseus-style)” on the Data tab.
        </p>
      )}

      {/* The test that produced this table, where every other methods sentence
          lives. It completes the notices above rather than contradicting them:
          there is nothing to run *here*, and this is what was run. */}
      {activePlot?.volcanoTest && (
        <div className="analysis">
          <h4>Volcano test</h4>
          <p className="hint">
            S0 {activePlot.volcanoTest.s0}, target FDR {activePlot.volcanoTest.fdrPercent}% —
            reached {(activePlot.volcanoTest.fdrAchieved * 100).toFixed(1)}% at delta{' '}
            {activePlot.volcanoTest.deltaUsed.toFixed(3)}, calling{' '}
            {activePlot.volcanoTest.nUp} of {activePlot.volcanoTest.nTested} features up and{' '}
            {activePlot.volcanoTest.nDown} down.
          </p>
          <details>
            <summary>Methods sentence</summary>
            <p className="methods">{activePlot.volcanoTest.methodsSentence}</p>
            <button
              onClick={() =>
                void navigator.clipboard?.writeText(activePlot.volcanoTest?.methodsSentence ?? '')
              }
            >
              Copy
            </button>
          </details>
        </div>
      )}

      {offeredTests.length > 0 && (
        <button
          className="primary"
          onClick={() => void run()}
          disabled={!minGroupsMet || blockedByContinuousAxis || blockedByHorizontalOrientation}
        >
          Run and annotate
        </button>
      )}

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

/** Shared with the status-bar badge, so one score never reads two ways. */
export function scoreTone(score: number): 'good' | 'fair' | 'poor' {
  return score >= 90 ? 'good' : score >= 70 ? 'fair' : 'poor';
}

/**
 * A 3- or 6-digit `#` hex, captured and `\b`-bounded so it doesn't swallow a
 * trailing word. Deliberately not global: `split` divides on every match
 * anyway, and a shared `lastIndex` between calls is a state bug waiting to
 * happen.
 */
const HEX_IN_TEXT = /(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b)/;

/**
 * Render a finding's text, drawing a small block of any hex colour it names
 * right after the code — so "#4575b4 and #0072b2 are hard to tell apart" shows
 * the two colours, not just their identifiers. Purely presentational: the
 * swatch fill is the same string the finding quotes, and the checker read that
 * string off the rendered scene, so it cannot disagree with the figure.
 */
function withColorSwatches(text: string): ReactNode {
  // A capturing split alternates [text, hex, text, hex, …], so the odd indices
  // are exactly the colour codes.
  const parts = text.split(HEX_IN_TEXT);
  if (parts.length === 1) return text;

  const out: ReactNode[] = [];
  parts.forEach((part, i) => {
    out.push(part);
    if (i % 2 === 1) {
      out.push(
        <span
          key={i}
          className="color-chip"
          style={{ background: part }}
          title={part}
          aria-hidden
        />,
      );
    }
  });
  return out;
}

function QualityTab({ api, theme, onSelectionChange, exportDpi, report }: SidePanelProps) {
  const tone = scoreTone(report.score);

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
          <strong>{withColorSwatches(finding.title)}</strong>
          <p>{withColorSwatches(finding.detail)}</p>
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

function LayersTab({ api, theme, selectedIds, onSelectionChange }: SidePanelProps) {
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
                      deleteNodesWithLayout(api, theme, [node.id]);
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
