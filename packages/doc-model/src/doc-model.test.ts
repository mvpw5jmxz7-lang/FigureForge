import { describe, expect, it } from 'vitest';
import {
  analysisInputHash,
  ARCHIVE_EXTENSION,
  ARCHIVE_EXTENSIONS,
  ARCHIVE_FILE_TYPE,
  ARCHIVE_MIME,
  ArchiveError,
  buildArchiveContents,
  checkReferentialIntegrity,
  compareDrawOrder,
  findLayer,
  LEGACY_ARCHIVE_EXTENSION,
  createDocument,
  createIdFactory,
  blocksOfSize,
  clearBlock,
  copyBlock,
  couldHaveRowNames,
  dataBlocks,
  insertColumn,
  insertRow,
  moveColumn,
  pasteBlock,
  removeColumn,
  removeRow,
  setCell,
  DocumentStore,
  editDocument,
  formatMm,
  hashInputs,
  contingencyCategories,
  inferFormat,
  pointLabelColumnIndex,
  mergedHeaderGroups,
  isContingency,
  loadArchive,
  mmToPt,
  parseDelimited,
  ptToMm,
  rowNames,
  saveArchive,
  significanceStars,
  toMm,
  toMatrix,
  toSeries,
  toSurvivalGroups,
  eventsForHash,
  xForHash,
  type Dataset,
} from './index.js';
import {
  addArrow,
  addAsset,
  addBracket,
  addEmptyMontagePanel,
  addGroup,
  addGroupLabel,
  addImage,
  addPanel,
  addPanelWithImage,
  addPanelWithImages,
  addPanelWithPlot,
  addScaleBar,
  addShape,
  addText,
  alignSelection,
  applyAutoLayout,
  distributeSelection,
  DISTRIBUTION_Y_TITLES,
  defaultPlotTypeFor,
  distributionYTitle,
  deleteNode,
  duplicateNode,
  fillPanelChildren,
  groupLabelMembersAreImages,
  reserveSpaceForScaleBars,
  scaleBarBelowExtentMm,
  SCALE_BAR_BELOW_GAP_MM,
  groupLabelExtentMm,
  fitMontageToImages,
  imageContentRect,
  resyncScaleBars,
  imagesUsingAsset,
  memberContentRect,
  montageShape,
  montageTileAspect,
  suggestMontageGrid,
  montageCellRects,
  montageTiles,
  isDerivedNode,
  MIN_CROP,
  normaliseArrowFrame,
  normaliseCrop,
  nextPanelFrame,
  editDataset,
  plotsUsingDataset,
  recordBracketOffset,
  reflowGroupLabels,
  relabelPanels,
  removeBracketsForPlot,
  removeDataset,
  renameDataset,
  reorderNode,
  MIN_TILE_MM,
  reparentNode,
  replaceAnalysisForPlot,
  replaceSeriesAnalysesForPlot,
  repositionBrackets,
  rescaleArrowPoints,
  reserveSpaceForGroupLabels,
  resizeGroup,
  resizePanel,
  scaleBarWidthMm,
  setMontageCellImage,
  snapshotPanelAbsolutePositions,
  syncPanelLabelsFromSnapshot,
  setArrowPoint,
  setDatasetReading,
  setImageCrop,
  ungroup,
  type PlotMeasurements,
} from './operations.js';
import { absoluteFrame } from './nodes.js';
import type { BracketNode, FigureNode, GroupLabelNode, ImageNode, ScaleBarNode } from './nodes.js';
import { GROUP_LABEL_GAP_MM, groupLabelClearanceMm, panelLetterHeightMm } from './grouplabel.js';
import {
  alignFrames,
  autoLayout,
  distributeFrames,
  gridCells,
  resizeFrame,
  layoutUnits,
  readingOrder,
  snapFrame,
  suggestGrid,
} from './layout.js';
import { fitAspect, fitAspectAligned, fitShape, heightForWidth, rotatePoint, snapAngle, snapRotation } from './geometry.js';
import { LAYOUT_TEMPLATES, findLayoutTemplate, templatesForPanelCount } from './templates.js';
import { isLocked } from './document.js';
import type { Analysis } from './analysis.js';
import type { FigureDocument } from './document.js';
import type { NodeId, TextRun } from './nodes.js';

/*
 * The workbooks and .prism files named in the fixtures below were supplied by
 * the user and are inlined here as the literal bytes an Excel copy puts on the
 * clipboard. They are no longer in the repo — round 51 removed the reference
 * directory once nothing read it — so the names are provenance, not paths.
 */

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

describe('units', () => {
  it('converts points to millimetres at the printer definition', () => {
    // 72 pt = 1 inch = 25.4 mm, exactly.
    expect(ptToMm(72)).toBeCloseTo(25.4, 10);
    expect(mmToPt(25.4)).toBeCloseTo(72, 10);
  });

  it('round-trips through every display unit', () => {
    for (const unit of ['mm', 'cm', 'in', 'px'] as const) {
      expect(toMm(Number((183).toFixed(6)), 'mm')).toBeCloseTo(183, 9);
      const displayed = toMm(Number(formatMm(183, unit).split(' ')[0]), unit);
      // px rounds to whole pixels, so tolerance scales with the unit's precision.
      expect(displayed).toBeCloseTo(183, unit === 'px' ? 0 : 1);
    }
  });

  it('holds Nature column widths exactly', () => {
    expect(formatMm(89, 'mm')).toBe('89.0 mm');
    expect(formatMm(183, 'in')).toBe('7.205 in');
  });
});

// ---------------------------------------------------------------------------
// Data import
// ---------------------------------------------------------------------------

describe('delimited parsing', () => {
  it('detects tab-delimited Excel pastes', () => {
    const parsed = parseDelimited('Group\tValue\nA\t1.5\nB\t2.5');
    expect(parsed.delimiter).toBe('\t');
    expect(parsed.columns.map((c) => c.name)).toEqual(['Group', 'Value']);
    expect(parsed.rows).toEqual([
      ['A', 1.5],
      ['B', 2.5],
    ]);
  });

  it('honours RFC 4180 quoting', () => {
    // Delimiters and escaped quotes inside quoted fields must survive intact.
    const parsed = parseDelimited('name,note,value\n"Smith, J.","said ""hi""",5\n');
    expect(parsed.hasHeader).toBe(true);
    expect(parsed.rows[0]).toEqual(['Smith, J.', 'said "hi"', 5]);
  });

  it('treats an all-blank column as numeric with missing data', () => {
    // Typing it as text would change the inferred layout of the entire file.
    const parsed = parseDelimited('Treatment,R1,R2,R3\nA,10,,12');
    expect(parsed.columns.map((c) => c.kind)).toEqual(['text', 'number', 'number', 'number']);
    expect(inferFormat(parsed.columns)).toBe('replicate');
  });

  it('treats blanks and NA as missing rather than zero', () => {
    // Coercing a missing replicate to 0 would silently corrupt every mean.
    const parsed = parseDelimited('a,b,c\n1,,NA');
    expect(parsed.rows[0]).toEqual([1, null, null]);
  });

  it('detects a header row only when the body is numeric', () => {
    expect(parseDelimited('x,y\n1,2').hasHeader).toBe(true);
    expect(parseDelimited('a,b\nc,d').hasHeader).toBe(false);
  });

  it('pads ragged rows to the widest row', () => {
    const parsed = parseDelimited('a,b,c\n1,2\n3,4,5');
    expect(parsed.rows[0]).toHaveLength(3);
    expect(parsed.rows[0]?.[2]).toBeNull();
  });

  it('takes an explicit delimiter, header rule and transpose', () => {
    // Detection is a heuristic; when it is wrong the author needs a way to say
    // so that does not involve re-shaping the file by hand.
    const semi = parseDelimited('a;b\n1;2', { delimiter: ';' });
    expect(semi.rows[0]).toEqual([1, 2]);

    // 'x,y' over numbers detects as a header; forcing it off keeps the row.
    const noHeader = parseDelimited('x,y\n1,2', { hasHeader: false });
    expect(noHeader.hasHeader).toBe(false);
    expect(noHeader.rows).toHaveLength(2);

    const flipped = parseDelimited('Vehicle,10,11\nDrug,4,5', { transpose: true });
    expect(flipped.rows.map((r) => r[0])).toEqual([10, 11]);
  });

  it('reads a sedimentation-style export as independent xy pairs', () => {
    /*
     * Repeated first-of-pair column names are the signal. The old rule demanded
     * headers literally starting with x and y, so this table was read as
     * `prism` — one shared x for every series, silently plotting run 2 against
     * run 1's radii.
     */
    const columns = parseDelimited(
      'Radius,C(s)_run1,Radius,C(s)_run2\n6.0,0.1,6.1,0.2\n6.5,0.4,6.6,0.5',
    ).columns;
    expect(inferFormat(columns)).toBe('sigmaplot');
  });

  it('still reads a genuinely shared-x table as prism', () => {
    // Regression guard: the relaxed rule must not swallow the shared-x case,
    // whose distinguishing feature is that the first-of-pair names differ.
    expect(inferFormat(parseDelimited('Time,WT,KO,Rescue\n0,1,2,3').columns)).toBe('prism');
    expect(inferFormat(parseDelimited('Dose,A,B,C\n0,1,2,3\n1,2,3,4').columns)).toBe('prism');
  });

  it('reads a contingency table cell by cell, as two factors', () => {
    // Same *shape* as a replicate table, different meaning — and the difference
    // now reaches the series too. Reading the rows as replicates put a bar at
    // the mean of a count of cases and a count of controls.
    const table: Dataset = {
      ...dataset('Group,Yes,No\nTreated,15,5\nControl,7,13'),
      format: 'contingency',
    };
    const series = toSeries(table);
    expect(series.map((s) => [s.category, s.group, s.values])).toEqual([
      ['Treated', 'Yes', [15]],
      ['Treated', 'No', [5]],
      ['Control', 'Yes', [7]],
      ['Control', 'No', [13]],
    ]);
    expect(isContingency(table)).toBe(true);
    expect(contingencyCategories(table)).toEqual(['Yes', 'No']);
    expect(isContingency(dataset('Group,Value\nA,1'))).toBe(false);
  });

  it('never infers differential from a bare label+2-numeric table', () => {
    // Same shape as `replicate` — nothing in the cells says whether the two
    // numeric columns are replicates or an effect size and a p-value, so the
    // ambiguity is handed to the author instead of guessed.
    expect(inferFormat(parseDelimited('Gene,log2FC,p\nTP53,1.2,0.01').columns)).toBe('replicate');
  });

  it('reads a differential table as one series with per-point labels', () => {
    const table: Dataset = {
      ...dataset('Gene,log2FC,p\nTP53,2.1,0.001\nMYC,-1.8,0.02\nEGFR,0.1,0.5'),
      format: 'differential',
    };
    const series = toSeries(table);
    expect(series).toHaveLength(1);
    expect(series[0]).toEqual({
      name: 'Test',
      values: [0.001, 0.02, 0.5],
      x: [2.1, -1.8, 0.1],
      pointLabels: ['TP53', 'MYC', 'EGFR'],
    });
  });

  it('drops a differential row missing any of label, fold change or p-value', () => {
    const table: Dataset = {
      ...dataset('Gene,log2FC,p\nTP53,2.1,0.001\n,1.0,0.01\nMYC,n/a,0.02\nEGFR,0.1,'),
      format: 'differential',
    };
    const series = toSeries(table);
    expect(series).toHaveLength(1);
    // Every incomplete row is gone, not just the bad cell — the same rule
    // `numericPairsAt` already applies to every other xy layout.
    expect(series[0]!.pointLabels).toEqual(['TP53']);
    expect(series[0]!.x).toEqual([2.1]);
    expect(series[0]!.values).toEqual([0.001]);
  });

  it('never infers fold-fold, which is the differential shape exactly', () => {
    // Two effect sizes and an effect-size-plus-p-value are the same three
    // columns of the same types. Neither is guessed; the author states which.
    const columns = parseDelimited('Gene,97Q/25Q,97Q/APEX\nTP53,1.2,0.8').columns;
    expect(inferFormat(columns)).not.toBe('fold-fold');
    expect(inferFormat(columns)).not.toBe('differential');
  });

  it('reads a fold-fold table as one series with per-point labels', () => {
    const table: Dataset = {
      ...dataset('Gene,97Q/25Q,97Q/APEX\nTP53,2.1,1.7\nMYC,-1.8,-2.4\nEGFR,0.1,0.05'),
      format: 'fold-fold',
    };
    const series = toSeries(table);
    expect(series).toHaveLength(1);
    // Column 1 is x and column 2 is y — the same read as `differential`, with
    // no q-value column, since both numbers here are effect sizes.
    expect(series[0]).toEqual({
      name: 'Test',
      values: [1.7, -2.4, 0.05],
      x: [2.1, -1.8, 0.1],
      pointLabels: ['TP53', 'MYC', 'EGFR'],
    });
    expect(series[0]).not.toHaveProperty('qValues');
  });

  it('drops a fold-fold row missing its label or either fold change', () => {
    const table: Dataset = {
      ...dataset('Gene,A,B\nTP53,2.1,1.7\n,1.0,1.0\nMYC,n/a,0.5\nEGFR,0.1,'),
      format: 'fold-fold',
    };
    const series = toSeries(table);
    expect(series[0]!.pointLabels).toEqual(['TP53']);
  });

  it('names the fold-fold label column, which is what makes labels selectable', () => {
    const table: Dataset = { ...dataset('Gene,A,B\nTP53,1,2'), format: 'fold-fold' };
    expect(pointLabelColumnIndex(table)).toBe(0);
  });

  it('opens a fold-fold table as a fold-fold plot', () => {
    expect(defaultPlotTypeFor('fold-fold')).toBe('fold-fold');
  });

  it('reads a differential table\'s optional 4th column as per-point FDR/q-values', () => {
    const table: Dataset = {
      ...dataset(
        'Gene,log2FC,p,fdr\nTP53,2.1,0.001,0.01\nMYC,-1.8,0.02,\nEGFR,0.1,0.5,0.9',
      ),
      format: 'differential',
    };
    const series = toSeries(table);
    expect(series).toHaveLength(1);
    // A blank FDR cell is NaN, not a dropped row — unlike label/x/p, a
    // missing q-value means "no FDR call for this point," not "this point
    // does not exist."
    expect(series[0]!.pointLabels).toEqual(['TP53', 'MYC', 'EGFR']);
    expect(series[0]!.qValues?.[0]).toBe(0.01);
    expect(series[0]!.qValues?.[1]).toBeNaN();
    expect(series[0]!.qValues?.[2]).toBe(0.9);
  });

  it('has no qValues on an ordinary 3-column differential table', () => {
    const table: Dataset = {
      ...dataset('Gene,log2FC,p\nTP53,2.1,0.001'),
      format: 'differential',
    };
    expect(toSeries(table)[0]!.qValues).toBeUndefined();
  });

  it('never infers matrix from a bare row×column table', () => {
    // Same shape as `contingency` — nothing in the cells says whether it's
    // counts to test or continuous values to colour.
    expect(inferFormat(parseDelimited('Gene,S1,S2\nA,1.2,3.4').columns)).toBe('replicate');
  });

  it('reads a matrix table as a dense grid, preserving row order', () => {
    const table: Dataset = {
      ...dataset('Gene,Sample1,Sample2,Sample3\nTP53,1.2,-0.5,0.8\nMYC,2.1,1.9,-1.1'),
      format: 'matrix',
    };
    const matrix = toMatrix(table);
    expect(matrix.rowLabels).toEqual(['TP53', 'MYC']);
    expect(matrix.colLabels).toEqual(['Sample1', 'Sample2', 'Sample3']);
    expect(matrix.cells).toEqual([
      [1.2, -0.5, 0.8],
      [2.1, 1.9, -1.1],
    ]);
  });

  it('keeps a blank or non-numeric matrix cell as a distinct null, not dropped', () => {
    const table: Dataset = {
      ...dataset('Gene,Sample1,Sample2\nTP53,1.2,\nMYC,n/a,1.9'),
      format: 'matrix',
    };
    const matrix = toMatrix(table);
    // Position preserved — a missing cell is still a cell, not absent from
    // the grid the way `toSeries`'s per-cell formats silently drop one.
    expect(matrix.cells).toEqual([
      [1.2, null],
      [null, 1.9],
    ]);
  });

  it('drops a matrix row with no row label entirely', () => {
    const table: Dataset = {
      ...dataset('Gene,Sample1\nTP53,1.2\n,3.4'),
      format: 'matrix',
    };
    const matrix = toMatrix(table);
    expect(matrix.rowLabels).toEqual(['TP53']);
    expect(matrix.cells).toEqual([[1.2]]);
  });

  it('never infers survival from a bare table shaped like one', () => {
    // A text column followed by numeric columns is `replicate`'s own shape —
    // nothing in the cells says whether the two numeric columns are repeated
    // measurements or a time plus a 0/1 event flag.
    expect(inferFormat(parseDelimited('Subject,Time,Event\nA,5,1\nB,8,0').columns)).toBe(
      'replicate',
    );
    expect(inferFormat(parseDelimited('Time,Event,Group\n5,1,X\n8,0,Y').columns)).not.toBe(
      'survival',
    );
  });

  it('reads a survival table as one implicit group when no group column is given', () => {
    const table: Dataset = {
      ...dataset('Time,Event\n5,1\n8,1\n8,0\n12,1'),
      format: 'survival',
      name: 'Cohort',
    };
    const groups = toSurvivalGroups(table);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      name: 'Cohort',
      times: [5, 8, 8, 12],
      events: [true, true, false, true],
    });
  });

  it('groups survival rows by the third column, preserving row order within a group', () => {
    const table: Dataset = {
      ...dataset('Time,Event,Arm\n5,1,A\n8,0,B\n12,1,A\n3,1,B'),
      format: 'survival',
    };
    const groups = toSurvivalGroups(table);
    expect(groups).toEqual([
      { name: 'A', times: [5, 12], events: [true, true] },
      { name: 'B', times: [8, 3], events: [false, true] },
    ]);
  });

  it('drops a survival row missing a numeric time or event flag', () => {
    const table: Dataset = {
      ...dataset('Time,Event,Arm\n5,1,A\n,1,A\n8,,A\nMYC,1,A'),
      format: 'survival',
    };
    const groups = toSurvivalGroups(table);
    expect(groups).toEqual([{ name: 'A', times: [5], events: [true] }]);
  });

  it('reads a non-zero event flag as an event, and exactly zero as censored', () => {
    const table: Dataset = {
      ...dataset('Time,Event\n5,1\n8,0\n12,2'),
      format: 'survival',
    };
    expect(toSurvivalGroups(table)[0]!.events).toEqual([true, false, true]);
  });

  it('never infers pca from a bare table shaped like one', () => {
    // Identical shape to `differential` — a label column plus exactly two
    // numeric columns — and nothing in the cells says which reading is
    // meant. `'pca'` is reachable only by the "Run PCA" action itself, never
    // by declaring a layout, so this only has to confirm inference never
    // lands on it, not that some other explicit-selection path exists.
    expect(inferFormat(parseDelimited('Sample,PC1,PC2\nA,1.2,-0.5').columns)).not.toBe('pca');
  });

  it('reads a pca table as one series with per-sample labels', () => {
    const table: Dataset = {
      ...dataset('Sample,PC1,PC2\nA,2.1,-0.5\nB,-1.8,1.2\nC,0.1,0.3'),
      format: 'pca',
    };
    const series = toSeries(table);
    expect(series).toHaveLength(1);
    expect(series[0]).toEqual({
      name: 'Test',
      x: [2.1, -1.8, 0.1],
      values: [-0.5, 1.2, 0.3],
      pointLabels: ['A', 'B', 'C'],
    });
  });

  it('never infers umap from a bare table shaped like one', () => {
    // Same reasoning as pca: identical shape to `differential`, reachable
    // only by the "Run UMAP" action itself, never by declaring a layout.
    expect(inferFormat(parseDelimited('Sample,UMAP1,UMAP2\nA,1.2,-0.5').columns)).not.toBe(
      'umap',
    );
  });

  it('reads a umap table as one series with per-sample labels', () => {
    const table: Dataset = {
      ...dataset('Sample,UMAP1,UMAP2\nA,2.1,-0.5\nB,-1.8,1.2\nC,0.1,0.3'),
      format: 'umap',
    };
    const series = toSeries(table);
    expect(series).toHaveLength(1);
    expect(series[0]).toEqual({
      name: 'Test',
      x: [2.1, -1.8, 0.1],
      values: [-0.5, 1.2, 0.3],
      pointLabels: ['A', 'B', 'C'],
    });
  });

  it('infers each supported layout', () => {
    expect(inferFormat(parseDelimited('X,Y\n1,2').columns)).toBe('simple-xy');
    expect(inferFormat(parseDelimited('Group,Value\nA,1').columns)).toBe('grouped');
    expect(inferFormat(parseDelimited('Treatment,R1,R2,R3\nA,1,2,3').columns)).toBe('replicate');
    expect(inferFormat(parseDelimited('X,Y1,Y2,Y3\n1,2,3,4').columns)).toBe('prism');
    expect(inferFormat(parseDelimited('X1,Y1,X2,Y2\n1,2,3,4').columns)).toBe('sigmaplot');
  });

  it('reads an Excel paste of three independent xy runs', () => {
    /*
     * The user-supplied `test graph.xlsx`, verbatim, tab-delimited as a paste from
     * Excel arrives. Its own chart is three lineMarker series, each against its
     * own x column, and the whole point of the layout is that no row of one run
     * corresponds to the same row of another.
     */
    const ds = dataset(XY_PAIRS_PASTE);
    expect(ds.format).toBe('sigmaplot');

    const series = toSeries(ds);
    expect(series.map((s) => s.name)).toEqual(['Y1', 'Y2', 'Y3']);
    expect(series.every((s) => s.values.length === 6 && s.x?.length === 6)).toBe(true);

    // The regression guard: read as a shared x, run 2 would be plotted against
    // run 1's positions and the misreading is invisible on the page.
    expect(series[1]?.x).toEqual([1.4, 1.9, 3.1, 3.9, 5.1, 6.1]);
    expect(series[2]?.x).toEqual([0.9, 2.05, 2.9, 4.05, 5.05, 6.1]);
    expect(series[0]?.values).toEqual([0, 0.1, 0.3, 0.5, 0.6, 0.7]);
  });
});

/**
 * The columns of the user-supplied `test graph.xlsx`, tab-delimited — the bytes an
 * Excel copy actually puts on the clipboard.
 */
const XY_PAIRS_PASTE = [
  'X1\tY1\tX2\tY2\tX3\tY3',
  '1\t0\t1.4\t0.05\t0.9\t0.1',
  '2\t0.1\t1.9\t0.2\t2.05\t0.24',
  '3\t0.3\t3.1\t0.4\t2.9\t0.47',
  '4\t0.5\t3.9\t0.7\t4.05\t0.8',
  '5\t0.6\t5.1\t0.8\t5.05\t0.9',
  '6\t0.7\t6.1\t0.9\t6.1\t1.1',
].join('\n');

/**
 * The columns of the user-supplied `test2 data table.xlsx` — the same table
 * The user-supplied `test graphs.prism` holds as `y_replicates` with
 * `replicatesCount: 3`. Its group titles are *merged cells*, so a copy carries
 * one header row with the names spread across their blocks.
 */
const XY_REPLICATES_PASTE = [
  'Hours\tControl\t\t\tTreated\t\t',
  '0\t45\t34\t20\t34\t31\t29',
  '6\t56\t58\t61\t41\t43\t42',
  '12\t76\t72\t77\t52\t55\t55',
  '24\t81\t95\t83\t63\t63\t80',
  '48\t99\t100\t104\t72\t67\t81',
  '72\t97\t110\t115\t78\t87\t60',
].join('\n');

/**
 * The user-supplied `grouped data example.prism` — three genotypes down the rows, three
 * treatments across the columns, three replicates in each cell. Its group titles
 * are merged cells too, and the row-title column has no title of its own, so the
 * header row opens with a *blank* before the first block name.
 */
const GROUPED_PASTE = [
  '\tControl\t\t\tDrug A\t\t\tDrug B\t\t',
  'Wild type\t23\t21\t19\t67\t79\t98\t88\t86\t89',
  'Knock-out A\t24\t23\t15\t29\t31\t32\t90\t91\t92',
  'Knock-out B\t21\t25\t27\t65\t69\t71\t65\t66\t63',
].join('\n');

function dataset(text: string, id = 'd1'): Dataset {
  const parsed = parseDelimited(text);
  return {
    id,
    name: 'Test',
    format: inferFormat(parsed.columns),
    columns: parsed.columns,
    rows: parsed.rows,
    sourcePath: `data/${id}.csv`,
    sourceFilename: null,
    importedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('series extraction', () => {
  it('collapses replicate columns into one series per treatment', () => {
    const series = toSeries(dataset('Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6'));
    expect(series).toHaveLength(2);
    expect(series[0]).toEqual({ name: 'Vehicle', values: [10, 11, 12] });
    expect(series[1]).toEqual({ name: 'Drug', values: [4, 5, 6] });
  });

  it('reads a distribution table as one series per column', () => {
    // The transpose of the replicate case above: groups run down the columns.
    const table: Dataset = {
      ...dataset('Y1,Y2,Y3\n10,4,7\n11,5,8\n12,6,9'),
      format: 'distribution',
    };
    const series = toSeries(table);
    expect(series).toHaveLength(3);
    expect(series[0]).toEqual({ name: 'Y1', values: [10, 11, 12] });
    expect(series[1]).toEqual({ name: 'Y2', values: [4, 5, 6] });
    expect(series[2]).toEqual({ name: 'Y3', values: [7, 8, 9] });
  });

  it('keeps ragged distribution columns at their own lengths', () => {
    /*
     * The property that separates this layout from `replicate`: groups really
     * do differ in size, so a short column is a group with fewer observations
     * — not a row to pad out. Read by row instead, the blanks would either
     * drop whole rows out of the long columns or pad the short ones with
     * numbers nobody measured.
     */
    const table: Dataset = {
      ...dataset('Y1,Y2,Y3\n10,4,7\n11,5,\n12,,\n13,,'),
      format: 'distribution',
    };
    const series = toSeries(table);
    expect(series.map((s) => s.values)).toEqual([[10, 11, 12, 13], [4, 5], [7]]);
  });

  it('drops a text column declared into a distribution table', () => {
    // It filters down to no numbers rather than drawing an empty group.
    const table: Dataset = {
      ...dataset('Label,Y1\nA,10\nB,11'),
      format: 'distribution',
    };
    expect(toSeries(table).map((s) => s.name)).toEqual(['Y1']);
  });

  it('reads every column of a distribution table even with a stale row-names flag', () => {
    // `hasRowNames` can survive from an earlier xy-shaped declaration of the
    // same paste. A distribution table has no label column by construction —
    // every one of these three is a group — so the flag must be ignored here,
    // not just left at its default.
    const table: Dataset = {
      ...dataset('Y1,Y2,Y3\n10,4,7\n11,5,8'),
      format: 'distribution',
      hasRowNames: true,
    };
    expect(toSeries(table).map((s) => s.name)).toEqual(['Y1', 'Y2', 'Y3']);
  });

  it('never infers distribution from a table of numeric columns', () => {
    /*
     * Nothing at the cell level separates "three columns of observations"
     * from "a shared x and two y series", so the author declares it. This is
     * also the misreading the format exists to fix: left to detection the
     * first group is consumed as an x axis and never plotted at all.
     */
    const columns = parseDelimited('Y1,Y2,Y3\n10,4,7\n11,5,8').columns;
    expect(inferFormat(columns)).not.toBe('distribution');
    expect(inferFormat(columns)).toBe('prism');
  });

  it('groups long-form data by label', () => {
    const series = toSeries(dataset('Group,Value\nA,1\nB,2\nA,3'));
    expect(series).toHaveLength(2);
    expect(series[0]).toEqual({ name: 'A', values: [1, 3] });
  });

  it('splits SigmaPlot xy pairs into independent series', () => {
    const series = toSeries(dataset('X1,Y1,X2,Y2\n1,10,5,50\n2,20,6,60'));
    expect(series).toHaveLength(2);
    expect(series[0]?.x).toEqual([1, 2]);
    expect(series[1]?.values).toEqual([50, 60]);
  });

  it('skips missing replicates instead of counting them', () => {
    const series = toSeries(dataset('Treatment,R1,R2,R3\nA,10,,12'));
    expect(series[0]?.values).toEqual([10, 12]);
  });

  it('keeps every xy point on its own x when a value is missing', () => {
    /*
     * The columns used to be read independently and filtered separately, then
     * x was truncated to the y count — so a hole at row 2 shifted rows 3+ onto
     * the x of the row before, and dropped the last x entirely. Nothing about
     * the resulting curve looked wrong.
     */
    const series = toSeries(dataset('Time,WT,KO\n0,10,1\n1,,2\n2,30,3\n3,40,4'));

    expect(series[0]?.x).toEqual([0, 2, 3]);
    expect(series[0]?.values).toEqual([10, 30, 40]);
    // The untouched series must not be disturbed by its neighbour's hole.
    expect(series[1]?.x).toEqual([0, 1, 2, 3]);
    expect(series[1]?.values).toEqual([1, 2, 3, 4]);
  });

  it('drops an xy pair whose x is missing, not just its y', () => {
    // A blank x is equally unplottable: the point has no position to take.
    const series = toSeries(dataset('X1,Y1,X2,Y2\n1,10,5,50\n,20,6,60\n3,30,7,70'));
    expect(series[0]?.x).toEqual([1, 3]);
    expect(series[0]?.values).toEqual([10, 30]);
    expect(series[1]?.x).toEqual([5, 6, 7]);
  });

  it('pairs a simple xy table by row', () => {
    const series = toSeries(dataset('X,Y\n1,10\n2,\n3,30'));
    expect(series[0]).toEqual({ name: 'Y', values: [10, 30], x: [1, 3] });
  });

  it('draws a contingency table one bar per count, not one per row', () => {
    /*
     * Read as replicates, a `Smoked` row of [80, 20] became a single bar at 50
     * — the mean of a count of cases and a count of controls, which is not a
     * number in the table and not a fact about the experiment.
     */
    const table: Dataset = {
      ...dataset('Group,Cases,Control\nSmoked,80,20\nNever smoked,10,90'),
      format: 'contingency',
    };
    const series = toSeries(table);

    expect(series).toHaveLength(4);
    expect(series.map((s) => s.values)).toEqual([[80], [20], [10], [90]]);
    expect(series.map((s) => s.category)).toEqual([
      'Smoked',
      'Smoked',
      'Never smoked',
      'Never smoked',
    ]);
    expect(series.map((s) => s.group)).toEqual(['Cases', 'Control', 'Cases', 'Control']);
    // Names stay unique, which is what every downstream join relies on.
    expect(new Set(series.map((s) => s.name)).size).toBe(4);
  });

  it('reads x from column 2 when column 1 holds row names', () => {
    // Without the flag this is the `replicate` signature — a text column in
    // front of numbers — and the x values would be read as replicate data.
    const table: Dataset = {
      ...dataset('Sample,Time,WT,KO\na,0,10,1\nb,1,20,2\nc,2,30,3'),
      format: 'prism',
      hasRowNames: true,
    };
    const series = toSeries(table);
    expect(series.map((s) => s.name)).toEqual(['WT', 'KO']);
    expect(series[0]?.x).toEqual([0, 1, 2]);
    expect(series[0]?.values).toEqual([10, 20, 30]);
    expect(rowNames(table)).toEqual(['a', 'b', 'c']);
  });

  it('reads a two-row header as group blocks over columns', () => {
    // A merged group title exports as a name in the first cell of its span and
    // blanks across the rest, which is what makes the blocking detectable.
    const table = parseDelimited(
      ',Group A,,,Group B,,\n' +
        'Hours,A:Y1,A:Y2,A:Y3,B:Y1,B:Y2,B:Y3\n' +
        '0,45,34,20,34,31,29\n' +
        '6,56,58,61,41,43,42',
    );

    expect(table.headerRows).toBe(2);
    // The lower row names the columns; the upper one only blocks them.
    expect(table.columns.map((c) => c.name)).toEqual([
      'Hours',
      'A:Y1',
      'A:Y2',
      'A:Y3',
      'B:Y1',
      'B:Y2',
      'B:Y3',
    ]);
    expect(table.columnGroups).toEqual([
      { name: 'Group A', from: 1, to: 3 },
      { name: 'Group B', from: 4, to: 6 },
    ]);
    // Numeric column 0 in front of the blocks means a shared x.
    expect(inferFormat(table.columns, { columnGroups: table.columnGroups })).toBe('xy-replicates');
  });

  it('does not mistake an ordinary header for a group row', () => {
    // An ordinary header names *every* column; a merged group title names one
    // cell per block. Sparseness is what separates them.
    const plain = parseDelimited('Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6');
    expect(plain.headerRows).toBe(1);
    expect(plain.columnGroups).toEqual([]);
    expect(inferFormat(plain.columns, { columnGroups: plain.columnGroups })).toBe('replicate');
  });

  it('reads a single merged header row as group blocks', () => {
    /*
     * The user-supplied `test2 data table.xlsx`, tab-delimited as an Excel copy puts it
     * on the clipboard: `A1 = Hours`, `B1:D1` merged to "Control", `E1:G1` to
     * "Treated". Read without the blocks it infers as `prism` — six lines, four
     * of them named after placeholder column letters.
     */
    const table = parseDelimited(XY_REPLICATES_PASTE);

    expect(table.headerRows).toBe(1);
    expect(table.columnGroups).toEqual([
      { name: 'Control', from: 1, to: 3 },
      { name: 'Treated', from: 4, to: 6 },
    ]);

    const format = inferFormat(table.columns, { columnGroups: table.columnGroups });
    expect(format).toBe('xy-replicates');

    const series = toSeries({
      ...dataset('placeholder,1\n'),
      format,
      columns: table.columns,
      rows: table.rows,
      columnGroups: table.columnGroups,
    });
    expect(series.map((s) => s.name)).toEqual(['Control', 'Treated']);
    // Six timepoints x three replicates, each replicate against its own x.
    expect(series[0]!.values).toHaveLength(18);
    expect(series[0]!.x?.slice(0, 6)).toEqual([0, 0, 0, 6, 6, 6]);
  });

  it('refuses every single-row shape that is not a replicate table', () => {
    // Names every column: an ordinary header, declaring nothing.
    expect(mergedHeaderGroups(['A', 'B', 'C', 'D'], 4)).toEqual([]);
    /*
     * A trailing delimiter parses the table one column wider than the header
     * names it. Without the equal-width test that reads as "C spans two
     * columns", and a stray comma would silently restructure the file.
     */
    expect(mergedHeaderGroups(['A', 'B', 'C', ''], 4)).toEqual([]);
    // Unequal blocks are not a replicate count; Prism's is a single number.
    expect(mergedHeaderGroups(['X', 'A', '', '', 'B', ''], 6)).toEqual([]);
    // Two ungrouped leading columns: past the x column the row is partly
    // filled rather than merged, which says nothing about blocking.
    expect(mergedHeaderGroups(['X', 'Y', 'A', '', 'B', ''], 6)).toEqual([]);
  });

  it('reads a merged row with no leading column as nested blocks', () => {
    // Prism's Nested has no x or row-label column, so the blocks start at 0 —
    // the case the leading-singleton allowance must not require.
    const groups = mergedHeaderGroups(['Control', '', '', 'Treated', '', ''], 6);
    expect(groups).toEqual([
      { name: 'Control', from: 0, to: 2 },
      { name: 'Treated', from: 3, to: 5 },
    ]);
  });

  it('reads Prism’s Grouped table as a value per row and group', () => {
    const table = parseDelimited(
      ',Group A,,Group B,\n' +
        'Variant,A:Y1,A:Y2,B:Y1,B:Y2\n' +
        'WT,0.08,-0.25,0.06,0.006\n' +
        'Q331K,-0.18,0.12,-0.59,-0.66',
    );
    const format = inferFormat(table.columns, { columnGroups: table.columnGroups });
    expect(format).toBe('grouped-replicates');

    const ds: Dataset = {
      ...dataset('placeholder,1\n'),
      format,
      columns: table.columns,
      rows: table.rows,
      columnGroups: table.columnGroups,
    };
    const series = toSeries(ds);

    expect(series).toHaveLength(4);
    expect(series[0]).toEqual({
      name: 'WT — Group A',
      values: [0.08, -0.25],
      category: 'WT',
      group: 'Group A',
    });
    expect(series[3]!.category).toBe('Q331K');
    expect(series[3]!.group).toBe('Group B');
    expect(series[3]!.values).toEqual([-0.59, -0.66]);
  });

  it('reads a Grouped table declared in one merged header row', () => {
    /*
     * The spreadsheet form of the same declaration: one header row with the
     * group titles spread across their blocks, and — unlike the XY shape — a
     * *blank* leading cell, because the row-title column carries no title.
     */
    const table = parseDelimited(GROUPED_PASTE);
    expect(table.headerRows).toBe(1);
    expect(table.columnGroups).toEqual([
      { name: 'Control', from: 1, to: 3 },
      { name: 'Drug A', from: 4, to: 6 },
      { name: 'Drug B', from: 7, to: 9 },
    ]);

    const format = inferFormat(table.columns, { columnGroups: table.columnGroups });
    expect(format).toBe('grouped-replicates');

    const series = toSeries({
      ...dataset('placeholder,1\n'),
      format,
      columns: table.columns,
      rows: table.rows,
      columnGroups: table.columnGroups,
    });

    // Three genotypes × three treatments, over three category labels.
    expect(series).toHaveLength(9);
    expect(series[0]).toEqual({
      name: 'Wild type — Control',
      values: [23, 21, 19],
      category: 'Wild type',
      group: 'Control',
    });
    expect(new Set(series.map((s) => s.category)).size).toBe(3);
    expect(new Set(series.map((s) => s.group)).size).toBe(3);
  });

  it('drops a blank replicate rather than shifting the row', () => {
    const table = parseDelimited(GROUPED_PASTE.replace('23\t21\t19', '23\t\t19'));
    const series = toSeries({
      ...dataset('placeholder,1\n'),
      format: 'grouped-replicates',
      columns: table.columns,
      rows: table.rows,
      columnGroups: table.columnGroups,
    });
    // Two replicates, not three with a neighbour's value pulled in — the note
    // in the Prism file makes a point of the table carrying a missing value.
    expect(series[0]!.values).toEqual([23, 19]);
    expect(series[1]!.values).toEqual([67, 79, 98]);
  });

  it('names blocks generically when the columns have no names of their own', () => {
    // A header-less paste columns as A, B, C…; a legend reading "B, E, H" names
    // nothing in the author's data while looking exactly as though it did.
    const headerless = GROUPED_PASTE.split('\n').slice(1).join('\n');
    const ds: Dataset = { ...dataset(headerless), format: 'grouped-replicates' };
    expect(blocksOfSize(ds, 3).map((b) => b.name)).toEqual(['Group 1', 'Group 2', 'Group 3']);

    // A table that does name its columns keeps those names.
    const named: Dataset = {
      ...dataset('Hours,C1,C2,C3,T1,T2,T3\n0,45,34,20,34,31,29\n6,56,58,61,41,43,42'),
      format: 'xy-replicates',
    };
    expect(blocksOfSize(named, 3).map((b) => b.name)).toEqual(['C1', 'T1']);
  });

  it('reads Prism’s XY-with-replicates as one series per group, x repeated', () => {
    const table = parseDelimited(
      ',Control,,,Treated,,\n' +
        'Hours,A:Y1,A:Y2,A:Y3,B:Y1,B:Y2,B:Y3\n' +
        '0,45,34,20,34,31,29\n' +
        '6,56,58,61,41,43,42',
    );
    const ds: Dataset = {
      ...dataset('placeholder,1\n'),
      format: 'xy-replicates',
      columns: table.columns,
      rows: table.rows,
      columnGroups: table.columnGroups,
    };
    const series = toSeries(ds);

    expect(series.map((s) => s.name)).toEqual(['Control', 'Treated']);
    // Every replicate is its own point at its own x, so a scatter is already
    // right and the mean is a grouping the renderer does.
    expect(series[0]!.values).toEqual([45, 34, 20, 56, 58, 61]);
    expect(series[0]!.x).toEqual([0, 0, 0, 6, 6, 6]);
    expect(series[1]!.values).toEqual([34, 31, 29, 41, 43, 42]);
  });

  it('reads Prism’s Nested table clustered by subject, keyed by group', () => {
    const table = parseDelimited(
      'Control,,,Treated,,\n' +
        'Rat 1,Rat 2,Rat 3,Rat 4,Rat 5,Rat 6\n' +
        '1,2,3,7,8,9\n' +
        '1.5,2.5,3.5,7.5,8.5,9.5',
    );
    expect(table.columnGroups).toEqual([
      { name: 'Control', from: 0, to: 2 },
      { name: 'Treated', from: 3, to: 5 },
    ]);
    expect(inferFormat(table.columns, { columnGroups: table.columnGroups })).toBe('nested');

    const ds: Dataset = {
      ...dataset('placeholder,1\n'),
      format: 'nested',
      columns: table.columns,
      rows: table.rows,
      columnGroups: table.columnGroups,
    };
    const series = toSeries(ds);

    expect(series).toHaveLength(6);
    // One band per group, one sub-band per subject inside it…
    expect(series[0]!.category).toBe('Control');
    expect(series[0]!.group).toBe('Rat 1');
    expect(series[0]!.values).toEqual([1, 1.5]);
    // …and colour keys on the group, since subjects are not what is compared.
    expect(series.map((s) => s.legendKey)).toEqual([
      'Control',
      'Control',
      'Control',
      'Treated',
      'Treated',
      'Treated',
    ]);
  });

  it('reads one group rather than inventing a split when none is declared', () => {
    const ds: Dataset = {
      ...dataset('Variant,A,B,C\nWT,1,2,3\nKO,4,5,6'),
      format: 'grouped-replicates',
    };
    // Guessing that three columns are groups would assert a design the file
    // never stated. One block draws exactly what the replicate reading draws.
    expect(dataBlocks(ds)).toEqual([{ name: 'A', from: 1, to: 3 }]);
    expect(toSeries(ds).map((s) => s.values)).toEqual([[1, 2, 3], [4, 5, 6]]);

    // An author who knows the shape can say so.
    expect(blocksOfSize(ds, 2)).toEqual([
      { name: 'A', from: 1, to: 2 },
      { name: 'C', from: 3, to: 3 },
    ]);
  });

  it('offers the row-name reading without guessing at it', () => {
    /*
     * These two tables are the same rectangle of numbers and mean opposite
     * things. An earlier version guessed between them on "unique labels and an
     * ascending first numeric column" and read a real dose-response replicate
     * table — whose group means ascend by construction — as row names plus xy.
     * So the question is reported as open and the author settles it.
     */
    const labelled = parseDelimited('Sample,Time,WT,KO\na,0,10,1\nb,1,20,2\nc,2,30,3');
    const replicates = parseDelimited(
      'Treatment,R1,R2,R3\nVehicle,10,11,12\nLow,25,26,24\nMid,50,51,49\nHigh,80,81,79',
    );

    expect(couldHaveRowNames(labelled.columns)).toBe(true);
    expect(couldHaveRowNames(replicates.columns)).toBe(true);

    // Neither is *read* that way unless asked: the replicate reading is what
    // both tables get by default, which is how they have always been read.
    expect(inferFormat(labelled.columns)).toBe('replicate');
    expect(inferFormat(replicates.columns)).toBe('replicate');
    expect(inferFormat(labelled.columns, { hasRowNames: true })).toBe('prism');

    // An all-numeric table has no label column to be asked about.
    expect(couldHaveRowNames(parseDelimited('X,Y1,Y2\n1,2,3\n4,5,6').columns)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

describe('layout', () => {
  it('suggests a landscape-biased grid', () => {
    expect(suggestGrid(2)).toEqual({ rows: 1, columns: 2 });
    expect(suggestGrid(4)).toEqual({ rows: 2, columns: 2 });
    expect(suggestGrid(6)).toEqual({ rows: 2, columns: 3 });
  });

  it('divides the page into equal cells with uniform gutters', () => {
    const cells = gridCells(
      { rows: 1, columns: 2 },
      { pageWidthMm: 183, pageHeightMm: 75, marginMm: 2, gutterMm: 5 },
    );
    expect(cells).toHaveLength(2);
    // (183 - 4 margin - 5 gutter) / 2 = 87
    expect(cells[0]?.width).toBeCloseTo(87, 6);
    expect(cells[1]?.x).toBeCloseTo(2 + 87 + 5, 6);
    expect(cells[1]!.x - (cells[0]!.x + cells[0]!.width)).toBeCloseTo(5, 6);
  });

  it('never lets panels overflow the page', () => {
    const cells = gridCells(
      { rows: 2, columns: 3 },
      { pageWidthMm: 89, pageHeightMm: 120, marginMm: 2, gutterMm: 5 },
    );
    for (const cell of cells) {
      expect(cell.x + cell.width).toBeLessThanOrEqual(89 + 1e-9);
      expect(cell.y + cell.height).toBeLessThanOrEqual(120 + 1e-9);
    }
  });

  it('divides columns by weight', () => {
    const options = { pageWidthMm: 183, pageHeightMm: 75, marginMm: 2, gutterMm: 5 };
    const cells = gridCells({ rows: 1, columns: 2, columnWeights: [2, 1] }, options);

    // 174 mm of usable width split 2:1 → 116 and 58.
    expect(cells[0]!.width).toBeCloseTo(116, 6);
    expect(cells[1]!.width).toBeCloseTo(58, 6);
    expect(cells[0]!.width / cells[1]!.width).toBeCloseTo(2, 6);
    // The gutter is still exactly one gutter wide.
    expect(cells[1]!.x - (cells[0]!.x + cells[0]!.width)).toBeCloseTo(5, 6);
  });

  it('matches the equal grid when weights are absent or uniform', () => {
    const options = { pageWidthMm: 183, pageHeightMm: 75, marginMm: 2, gutterMm: 5 };
    // Regression guard: adding weights must not shift any existing figure.
    expect(gridCells({ rows: 2, columns: 3, columnWeights: [1, 1, 1], rowWeights: [1, 1] }, options))
      .toEqual(gridCells({ rows: 2, columns: 3 }, options));
  });

  it('matches today\'s behaviour when the boundary-extras arrays are absent', () => {
    // Additive: a caller that never sets these must get byte-identical
    // frames to before they existed.
    const options = { pageWidthMm: 183, pageHeightMm: 75, marginMm: 2, gutterMm: 5 };
    expect(gridCells({ rows: 1, columns: 2 }, options)).toEqual(
      gridCells({ rows: 1, columns: 2 }, { ...options, columnGutterExtraMm: undefined }),
    );
  });

  it('grows a specific boundary by the requested extra clearance — the room a group-label needs', () => {
    const options = { pageWidthMm: 183, pageHeightMm: 75, marginMm: 2, gutterMm: 5 };
    // Boundary 0 is *before* the first column — a heading over the very
    // first column still has a boundary to grow, unlike a plain gutter
    // (which only ever sits *between* tracks).
    const cells = gridCells(
      { rows: 1, columns: 2 },
      { ...options, columnGutterExtraMm: [10, 0, 0] },
    );
    const plain = gridCells({ rows: 1, columns: 2 }, options);

    expect(cells[0]!.x).toBeCloseTo(plain[0]!.x + 10, 6);
    // The second column's own gutter to the first is untouched.
    expect(cells[1]!.x - (cells[0]!.x + cells[0]!.width)).toBeCloseTo(5, 6);
    // The extra came out of both cells' shared usable width, not the page.
    expect(cells[0]!.width).toBeLessThan(plain[0]!.width);
  });

  it('grows the trailing boundary too — a heading past the last row/column', () => {
    const options = { pageWidthMm: 183, pageHeightMm: 75, marginMm: 2, gutterMm: 5 };
    // Boundary `rows` (here 1) is *after* the last row.
    const cells = gridCells({ rows: 1, columns: 2 }, { ...options, rowGutterExtraMm: [0, 8] });
    const plain = gridCells({ rows: 1, columns: 2 }, options);

    // Nothing moves — there is no row after it — but every cell shrank to
    // leave the trailing 8 mm free.
    expect(cells[0]!.y).toBeCloseTo(plain[0]!.y, 6);
    expect(cells[0]!.height).toBeCloseTo(plain[0]!.height - 8, 6);
  });

  it('spans a panel across cells, gutters included', () => {
    const template = findLayoutTemplate('large-left-two-stacked')!;
    const options = { pageWidthMm: 183, pageHeightMm: 75, marginMm: 2, gutterMm: 5 };

    const frames = autoLayout(
      [
        { id: 'a', aspectLock: null, slot: template.slots[0]! },
        { id: 'b', aspectLock: null, slot: template.slots[1]! },
        { id: 'c', aspectLock: null, slot: template.slots[2]! },
      ],
      template.grid,
      options,
    );

    const a = frames.get('a')!;
    const b = frames.get('b')!;
    const c = frames.get('c')!;

    // The tall panel covers both rows plus the gutter between them.
    expect(a.height).toBeCloseTo(b.height + c.height + 5, 6);
    // And it is twice as wide as the stacked pair.
    expect(a.width / b.width).toBeCloseTo(2, 6);
    expect(c.y).toBeGreaterThan(b.y);
  });

  it('resizes from a handle, holding the opposite edge', () => {
    const original = { x: 10, y: 10, width: 40, height: 30 };

    // Dragging the east edge right widens it; x is untouched.
    const east = resizeFrame(original, 'e', 6, 0);
    expect(east.x).toBeCloseTo(10, 6);
    expect(east.width).toBeCloseTo(46, 6);
    expect(east.height).toBeCloseTo(30, 6);

    // Dragging the west edge left grows it leftward; the right edge holds.
    const west = resizeFrame(original, 'w', -6, 0);
    expect(west.x).toBeCloseTo(4, 6);
    expect(west.width).toBeCloseTo(46, 6);
    expect(west.x + west.width).toBeCloseTo(original.x + original.width, 6);
  });

  it('honours an aspect lock and a minimum size', () => {
    const original = { x: 0, y: 0, width: 40, height: 20 };

    const locked = resizeFrame(original, 'se', 20, 0, { aspectLock: 2 });
    expect(locked.width / locked.height).toBeCloseTo(2, 6);

    // Dragging far past zero clamps rather than inverting the frame.
    const clamped = resizeFrame(original, 'e', -500, 0, { minMm: 5 });
    expect(clamped.width).toBeCloseTo(5, 6);
    expect(clamped.height).toBeGreaterThan(0);
  });

  it('honours a per-axis minimum distinct from the generic floor', () => {
    // A tiled panel needs a wider floor than a plain node — e.g. a 2×2 grid
    // needs ~12 mm of width to keep every cell at the usual 5 mm minimum, not
    // 5 mm total. `minWidthMm`/`minHeightMm` override `minMm` per axis; a
    // caller that only ever passed `minMm` sees no change.
    const original = { x: 0, y: 0, width: 40, height: 20 };

    const clamped = resizeFrame(original, 'e', -500, 0, {
      minMm: 5,
      minWidthMm: 12,
    });
    expect(clamped.width).toBeCloseTo(12, 6);

    // The other axis still floors at the generic minimum.
    const clampedHeight = resizeFrame(original, 's', 0, -500, {
      minMm: 5,
      minHeightMm: 8,
    });
    expect(clampedHeight.height).toBeCloseTo(8, 6);

    // Absent, both fall back to `minMm` exactly as before this option existed.
    const withoutOverride = resizeFrame(original, 'e', -500, 0, { minMm: 5 });
    expect(withoutOverride.width).toBeCloseTo(5, 6);
  });

  it('locks to a square from every corner and edge under aspectLock 1', () => {
    // What Shift does on the canvas: a square whichever grip is dragged, and
    // whichever axis the pointer favours.
    const original = { x: 10, y: 10, width: 40, height: 20 };

    for (const handle of ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'] as const) {
      const square = resizeFrame(original, handle, 12, 4, { aspectLock: 1 });
      expect(square.width).toBeCloseTo(square.height, 6);
    }

    // The floor must not be allowed to break the ratio — the re-derive after
    // clamping is what stops a 5 mm-wide, 20 mm-tall "square".
    const clamped = resizeFrame(original, 'se', -500, -500, { aspectLock: 1, minMm: 5 });
    expect(clamped.width).toBeCloseTo(clamped.height, 6);
    expect(clamped.width).toBeCloseTo(5, 6);
  });

  it('snaps to the nearest 45° step under angleSnap instead of forcing a square', () => {
    // Built for a line shape (`renderShape` draws it corner-to-corner of its
    // own frame), which has no endpoint grips to reach 0°/90° the way an
    // arrow's Shift-drag already does — this gives it the same three angles.
    const original = { x: 10, y: 10, width: 40, height: 20 };

    // Near-horizontal.
    const flat = resizeFrame(original, 'se', 30, 2, { angleSnap: true });
    expect(flat.height).toBe(0);
    expect(flat.width).toBeGreaterThan(0);

    // Near-vertical.
    const upright = resizeFrame(original, 'se', 1, 100, { angleSnap: true });
    expect(upright.width).toBe(0);
    expect(upright.height).toBeGreaterThan(0);

    // Exactly 45°: distance-preserving, so both sides land on the same value.
    const diagonal = resizeFrame(original, 'se', 20, 40, { angleSnap: true });
    expect(diagonal.width).toBeCloseTo(diagonal.height, 6);

    // A snapped zero is deliberate and skips the floor — the axis it landed
    // on is still a full line, still easy to grab, so the reason the floor
    // exists (never lose a grabbable handle in both directions at once)
    // doesn't apply to it. The *other* axis still honours the floor.
    const tiny = { x: 0, y: 0, width: 5, height: 2 };
    const nearVertical = resizeFrame(tiny, 'e', -4.99, 0, { angleSnap: true, minMm: 5 });
    expect(nearVertical.width).toBe(0);
    expect(nearVertical.height).toBeCloseTo(5, 6);

    // An ordinary, non-angleSnap resize is unaffected.
    const plain = resizeFrame(original, 'se', 12, 4, { aspectLock: 1 });
    expect(plain.width).toBeCloseTo(plain.height, 6);
  });

  it('is byte-identical with rotationDeg 0 or absent', () => {
    // The guarantee every existing caller relies on: adding the option changed
    // nothing for a figure that never rotates anything.
    const original = { x: 10, y: 10, width: 40, height: 30 };
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
      expect(resizeFrame(original, handle, 7, -3, { rotationDeg: 0 })).toEqual(
        resizeFrame(original, handle, 7, -3),
      );
    }
  });

  it('holds the anchored corner still on the page while resizing a rotated frame', () => {
    /*
     * The property that makes a rotated resize correct.
     *
     * Both frames are drawn about their own centres, and the centre moves when
     * the size changes — so anchoring the opposite corner in the frame's own
     * coordinates (which is the whole answer while axis-aligned) lets the
     * *visible* corner swing away, and the shape slides under the cursor.
     */
    const original = { x: 10, y: 10, width: 40, height: 30 };
    const rotationDeg = 37;

    const pageCorner = (r: typeof original, fx: number, fy: number) =>
      rotatePoint(
        { x: r.x + r.width * fx, y: r.y + r.height * fy },
        { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        rotationDeg,
      );

    // Dragging 'se' anchors 'nw' (fractions 0,0); dragging 'nw' anchors 'se'.
    const se = resizeFrame(original, 'se', 9, 5, { rotationDeg });
    const beforeNw = pageCorner(original, 0, 0);
    const afterNw = pageCorner(se, 0, 0);
    expect(afterNw.x).toBeCloseTo(beforeNw.x, 6);
    expect(afterNw.y).toBeCloseTo(beforeNw.y, 6);

    const nw = resizeFrame(original, 'nw', -6, -4, { rotationDeg });
    const beforeSe = pageCorner(original, 1, 1);
    const afterSe = pageCorner(nw, 1, 1);
    expect(afterSe.x).toBeCloseTo(beforeSe.x, 6);
    expect(afterSe.y).toBeCloseTo(beforeSe.y, 6);

    // An edge grip anchors the midpoint of the opposite edge.
    const east = resizeFrame(original, 'e', 8, 0, { rotationDeg });
    const beforeW = pageCorner(original, 0, 0.5);
    const afterW = pageCorner(east, 0, 0.5);
    expect(afterW.x).toBeCloseTo(beforeW.x, 6);
    expect(afterW.y).toBeCloseTo(beforeW.y, 6);
  });

  it('resizes a rotated frame along its own axes, not the page\'s', () => {
    // Turned a quarter turn, a drag straight down the page runs along what the
    // author sees as the shape's *width*.
    const original = { x: 0, y: 0, width: 40, height: 20 };
    const turned = resizeFrame(original, 'e', 0, 10, { rotationDeg: 90 });
    expect(turned.width).toBeCloseTo(50, 6);
    expect(turned.height).toBeCloseTo(20, 6);
  });

  it('snaps a drag onto the nearest 45° ray, keeping its distance', () => {
    const anchor = { x: 10, y: 10 };

    // Just past due east snaps back to due east, at the same radius.
    const nearEast = snapAngle(anchor, { x: 30, y: 12 });
    expect(nearEast.y).toBeCloseTo(10, 6);
    expect(nearEast.x).toBeGreaterThan(anchor.x);
    expect(Math.hypot(nearEast.x - anchor.x, nearEast.y - anchor.y)).toBeCloseTo(
      Math.hypot(20, 2),
      6,
    );

    // All eight rays are reachable, and each lands on a multiple of 45°.
    for (let bearing = 0; bearing < 360; bearing += 45) {
      const rad = (bearing * Math.PI) / 180;
      const point = { x: anchor.x + 10 * Math.cos(rad), y: anchor.y + 10 * Math.sin(rad) };
      const snapped = snapAngle(anchor, point);
      expect(snapped.x).toBeCloseTo(point.x, 6);
      expect(snapped.y).toBeCloseTo(point.y, 6);
    }

    // Exactly between two rays it may go either way, but never anywhere else.
    const between = snapAngle(anchor, { x: 10 + 10 * Math.cos(Math.PI / 8), y: 10 + 10 * Math.sin(Math.PI / 8) });
    const degrees = (Math.atan2(between.y - anchor.y, between.x - anchor.x) * 180) / Math.PI;
    expect(Math.abs(degrees % 45)).toBeCloseTo(0, 6);
  });

  it('leaves a zero-length drag alone rather than forcing it to 0°', () => {
    const anchor = { x: 4, y: 9 };
    expect(snapAngle(anchor, { x: 4, y: 9 })).toEqual({ x: 4, y: 9 });
  });

  it('snaps a rotation to 45° and normalises it into [0, 360)', () => {
    expect(snapRotation(37)).toBe(45);
    expect(snapRotation(20)).toBe(0);
    expect(snapRotation(-10)).toBe(0);
    // Wrapping, so a grip dragged several turns round never stores 720.
    expect(snapRotation(-46)).toBe(315);
    expect(snapRotation(359)).toBe(0);
  });

  it('rotates a point clockwise about a centre, matching SVG', () => {
    // SVG's rotate() is clockwise in a y-down space: +x turns onto +y.
    const turned = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90);
    expect(turned.x).toBeCloseTo(0, 6);
    expect(turned.y).toBeCloseTo(1, 6);
    // Zero is the identity, which is what keeps the unrotated path untouched.
    expect(rotatePoint({ x: 3, y: 7 }, { x: 1, y: 1 }, 0)).toEqual({ x: 3, y: 7 });
  });

  it('snaps to a neighbour edge in preference to the grid', () => {
    const result = snapFrame(
      { x: 40.3, y: 10, width: 20, height: 20 },
      {
        others: [{ id: 'other', frame: { x: 40, y: 40, width: 20, height: 20 } }],
        pageWidthMm: 183,
        pageHeightMm: 120,
        gridSpacingMm: 1,
        snapToGrid: true,
        smartGuides: true,
        toleranceMm: 0.5,
      },
    );
    expect(result.frame.x).toBeCloseTo(40, 6);
    expect(result.guides.some((g) => g.axis === 'x')).toBe(true);
  });

  it('falls back to the grid when nothing is near', () => {
    const result = snapFrame(
      { x: 40.3, y: 10.8, width: 20, height: 20 },
      {
        others: [],
        pageWidthMm: 183,
        pageHeightMm: 120,
        gridSpacingMm: 1,
        snapToGrid: true,
        smartGuides: false,
        toleranceMm: 0.5,
      },
    );
    expect(result.frame.x).toBeCloseTo(40, 6);
    expect(result.frame.y).toBeCloseTo(11, 6);
  });

  it('aligns and distributes selections', () => {
    const frames = new Map([
      ['a', { x: 0, y: 0, width: 10, height: 10 }],
      ['b', { x: 20, y: 5, width: 10, height: 10 }],
      ['c', { x: 100, y: 9, width: 10, height: 10 }],
    ]);

    expect([...alignFrames(frames, 'top').values()].every((f) => f.y === 0)).toBe(true);

    const ordered = [...distributeFrames(frames, 'x').values()].sort((p, q) => p.x - q.x);
    const gaps = ordered.slice(1).map((f, i) => f.x - (ordered[i]!.x + ordered[i]!.width));
    // Equal gaps is the whole point of distribute.
    expect(gaps[0]).toBeCloseTo(gaps[1]!, 6);
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function sampleDocument() {
  const newId = createIdFactory();
  const base = createDocument({
    widthMm: 183,
    heightMm: 75,
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const doc = editDocument(base, (draft) => {
    const ds = dataset('Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6', newId());
    draft.datasets = [ds];
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      datasetId: ds.id,
      name: 'One',
    });
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      datasetId: ds.id,
      name: 'Two',
    });
    applyAutoLayout(draft, { marginMm: 2, gutterMm: 5, labelGutterMm: 4 });
    relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
  });

  return { doc, newId };
}

describe('operations', () => {
  it('opens every layout carrying an x per y as an xy graph', () => {
    /*
     * Read as bars, an xy table's x columns are discarded outright and each
     * series collapses to the mean of its y column — a number that is nowhere
     * in the table, drawn over a category axis the data never had.
     */
    expect(defaultPlotTypeFor('simple-xy')).toBe('line');
    expect(defaultPlotTypeFor('prism')).toBe('line');
    expect(defaultPlotTypeFor('sigmaplot')).toBe('line');
    expect(defaultPlotTypeFor('xy-replicates')).toBe('line');

    // Unchanged: these have no x to plot against.
    expect(defaultPlotTypeFor('replicate')).toBe('bar-dot');
    expect(defaultPlotTypeFor('grouped')).toBe('bar-dot');
    expect(defaultPlotTypeFor('grouped-replicates')).toBe('bar-dot');
    expect(defaultPlotTypeFor(undefined)).toBe('bar-dot');
    expect(defaultPlotTypeFor('contingency')).toBe('bar');
    expect(defaultPlotTypeFor('nested')).toBe('dot');
    expect(defaultPlotTypeFor('differential')).toBe('volcano');
    expect(defaultPlotTypeFor('matrix')).toBe('heatmap');
    expect(defaultPlotTypeFor('survival')).toBe('survival');
    expect(defaultPlotTypeFor('pca')).toBe('scatter');
    expect(defaultPlotTypeFor('umap')).toBe('scatter');
    // A column of observations is a distribution; a bar over its mean throws
    // away the shape that is the whole reading.
    expect(defaultPlotTypeFor('distribution')).toBe('histogram');
    // Same reading as `replicate`, whose shape it shares — what differs is
    // which tests apply, which is not this function's business.
    expect(defaultPlotTypeFor('proteomics')).toBe('bar-dot');
  });

  it('titles a distribution panel’s axes for what each one actually shows', () => {
    /*
     * The Data tab cannot name either axis for this layout — `axisTitlesFor`
     * returns nothing, because the headers name the *groups* — so it passes its
     * generic `?? 'Value'` placeholder for y, exactly as it does for every other
     * unnameable table.
     *
     * That placeholder is right for x and wrong for y, and passing it is what
     * this pins: an earlier version shipped with **both** axes reading "Value",
     * because `retitleDistributionY` correctly declines to overwrite a title
     * somebody set. Every unit test called `addPlot` with no `yTitle` at all, so
     * only running the app showed it.
     */
    const newId = createIdFactory();
    const doc = editDocument(
      createDocument({ widthMm: 183, heightMm: 75, idFactory: newId }),
      (draft) => {
        const ds: Dataset = {
          ...dataset('Y1,Y2\n1,3\n2,4', newId()),
          format: 'distribution',
        };
        draft.datasets = [ds];
        addPanelWithPlot(draft, newId, {
          frame: { x: 0, y: 0, width: 80, height: 60 },
          datasetId: ds.id,
          name: 'Groups',
          // What `DataTab.importDataset` really passes for this format.
          yTitle: 'Value',
        });
      },
    );

    const plot = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
    expect(plot.type === 'plot' && plot.x.title).toBe('Value');
    expect(plot.type === 'plot' && plot.y.title).toBe('Count');
  });

  it('leaves a hand-written distribution y title alone', () => {
    // The other half of the rule: only a title this code could have generated
    // — or the generic placeholder above — is ever replaced.
    const plot = {
      plotType: 'histogram' as const,
      y: { title: 'Cells counted' },
      histogramNormalize: 'density' as const,
    };
    expect(DISTRIBUTION_Y_TITLES.has(plot.y.title)).toBe(false);
    expect(distributionYTitle(plot)).toBe('Density');
  });

  it('gives an imported xy panel a numeric x axis with ticks', () => {
    // The import path passes no plot type on purpose, so this is the only
    // place the default above actually reaches a document.
    const newId = createIdFactory();
    const doc = editDocument(
      createDocument({ widthMm: 183, heightMm: 75, idFactory: newId }),
      (draft) => {
        const ds = dataset('X1,Y1,X2,Y2\n1,2,1.5,3\n2,4,2.5,5', newId());
        draft.datasets = [ds];
        addPanelWithPlot(draft, newId, {
          frame: { x: 0, y: 0, width: 80, height: 60 },
          datasetId: ds.id,
          name: 'Runs',
        });
      },
    );

    const plot = Object.values(doc.nodes).find((n) => n.type === 'plot');
    expect(plot && 'plotType' in plot ? plot.plotType : null).toBe('line');
    // Without ticks a numeric axis has nothing to read a position against.
    expect(plot && 'x' in plot ? plot.x.showTicks : null).toBe(true);
  });

  it('defaults a bar graph to a single light-red fill, not the multi-series palette', () => {
    // 'bar'/'bar-dot' are the only plot types that draw a bar rect at all
    // (`options.showBar` in `categoricalMarks`) — every other type keeps the
    // CVD-safe Okabe-Ito default.
    const { doc } = sampleDocument();
    const barDotPlots = Object.values(doc.nodes).filter((n) => n.type === 'plot');
    expect(barDotPlots).toHaveLength(2);
    for (const plot of barDotPlots) {
      expect(plot.type === 'plot' && plot.plotType).toBe('bar-dot');
      expect(plot.type === 'plot' && plot.palette).toBe('bar-red');
    }

    // A contingency table forces `plotType` to 'bar' after this node is
    // already constructed, so the default has to catch that override too —
    // but a contingency table is row x column, exactly the two-factor shape
    // that keeps the CVD-safe default: colour is what separates its columns
    // (Yes vs No) across its rows.
    const newId = createIdFactory();
    const counts: Dataset = {
      ...dataset('Group,Yes,No\nTreated,15,5\nControl,7,13', newId()),
      format: 'contingency',
    };
    const contingencyDoc = editDocument(
      createDocument({ widthMm: 183, heightMm: 75, idFactory: newId }),
      (draft) => {
        draft.datasets = [counts];
        addPanelWithPlot(draft, newId, {
          frame: { x: 0, y: 0, width: 60, height: 50 },
          datasetId: counts.id,
        });
      },
    );
    const contingencyPlot = Object.values(contingencyDoc.nodes).find((n) => n.type === 'plot')!;
    expect(contingencyPlot.type === 'plot' && contingencyPlot.plotType).toBe('bar');
    expect(contingencyPlot.type === 'plot' && contingencyPlot.palette).toBe('okabe-ito');

    // A single-factor dataset explicitly plotted as 'bar' (rather than
    // reaching it through `defaultPlotTypeFor`) gets the flat default too —
    // it is `plotType`, not the path that produced it, that this reads.
    const explicitBarDoc = editDocument(
      createDocument({ widthMm: 183, heightMm: 75, idFactory: newId }),
      (draft) => {
        const ds = dataset('Group,Value\nA,5\nB,7\nC,3', newId());
        draft.datasets = [ds];
        addPanelWithPlot(draft, newId, {
          frame: { x: 0, y: 0, width: 60, height: 50 },
          datasetId: ds.id,
          plotType: 'bar',
        });
      },
    );
    const explicitBarPlot = Object.values(explicitBarDoc.nodes).find((n) => n.type === 'plot')!;
    expect(explicitBarPlot.type === 'plot' && explicitBarPlot.palette).toBe('bar-red');

    // A non-bar plot type keeps the CVD-safe default — only bars change.
    const lineDoc = editDocument(
      createDocument({ widthMm: 183, heightMm: 75, idFactory: newId }),
      (draft) => {
        const ds = dataset('X1,Y1,X2,Y2\n1,2,1.5,3\n2,4,2.5,5', newId());
        draft.datasets = [ds];
        addPanelWithPlot(draft, newId, {
          frame: { x: 0, y: 0, width: 80, height: 60 },
          datasetId: ds.id,
        });
      },
    );
    const linePlot = Object.values(lineDoc.nodes).find((n) => n.type === 'plot')!;
    expect(linePlot.type === 'plot' && linePlot.plotType).toBe('line');
    expect(linePlot.type === 'plot' && linePlot.palette).toBe('okabe-ito');

    // An explicit caller-supplied palette is never overridden.
    const explicitDoc = editDocument(
      createDocument({ widthMm: 183, heightMm: 75, idFactory: newId }),
      (draft) => {
        const ds = dataset('Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6', newId());
        draft.datasets = [ds];
        addPanelWithPlot(draft, newId, {
          frame: { x: 0, y: 0, width: 80, height: 60 },
          datasetId: ds.id,
          palette: 'viridis-discrete',
        });
      },
    );
    const explicitPlot = Object.values(explicitDoc.nodes).find((n) => n.type === 'plot')!;
    expect(explicitPlot.type === 'plot' && explicitPlot.palette).toBe('viridis-discrete');
  });

  it('letters panels in reading order', () => {
    const { doc } = sampleDocument();
    const labels = Object.values(doc.nodes).filter((n) => n.type === 'panel-label');
    expect(labels.map((l) => l.text).sort()).toEqual(['a', 'b']);
  });

  it('re-letters after panels are rearranged', () => {
    const { doc, newId } = sampleDocument();
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');

    const swapped = editDocument(doc, (draft) => {
      // Move the second panel to the left of the first.
      const second = draft.nodes[panels[1]!.id]!;
      second.frame = { ...second.frame, x: -50 };
      relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
    });

    const relabelled = Object.values(swapped.nodes).find(
      (n) => n.type === 'panel-label' && n.panelId === panels[1]!.id,
    );
    expect(relabelled && 'text' in relabelled ? relabelled.text : null).toBe('a');
  });

  it('deletes a panel together with its plot and label', () => {
    const { doc } = sampleDocument();
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const before = Object.keys(doc.nodes).length;

    const after = editDocument(doc, (draft) => deleteNode(draft, panel.id));

    // Panel + its plot + its label all go.
    expect(Object.keys(after.nodes).length).toBe(before - 3);
    expect(
      Object.values(after.nodes).some((n) => n.type === 'panel-label' && n.panelId === panel.id),
    ).toBe(false);
  });

  it('preserves page position when reparenting', () => {
    const { doc } = sampleDocument();
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');
    const label = Object.values(doc.nodes).find((n) => n.type === 'panel-label')!;
    const originalX = label.frame.x;
    const targetPanel = panels[1]!;

    const after = editDocument(doc, (draft) => reparentNode(draft, label.id, targetPanel.id));
    const moved = after.nodes[label.id]!;

    expect(moved.frame.x + targetPanel.frame.x).toBeCloseTo(originalX, 6);
  });

  it('keeps plots filling their panel through a re-layout', () => {
    const { doc } = sampleDocument();
    for (const node of Object.values(doc.nodes)) {
      if (node.type !== 'plot') continue;
      const panel = doc.nodes[node.parentId!]!;
      expect(node.frame.width).toBeCloseTo(panel.frame.width, 6);
      expect(node.frame.height).toBeCloseTo(panel.frame.height, 6);
    }
  });

  it('places a new panel below everything already on the page', () => {
    const { doc } = sampleDocument();
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');
    const lowest = Math.max(...panels.map((p) => p.frame.y + p.frame.height));

    const frame = nextPanelFrame(doc, { width: 60, height: 50 });

    // Below, so `readingOrder` sorts it last and auto-layout gives it the new
    // cell instead of displacing panel a.
    expect(frame.y).toBeGreaterThan(lowest);
    expect(frame.width).toBe(60);
  });

  it('drops a stale template slot when a plain auto-layout runs', () => {
    const { doc, newId } = sampleDocument();

    // Two panels arranged 2:1, then a third imported with no template.
    const templated = editDocument(doc, (draft) => {
      applyAutoLayout(draft, {
        marginMm: 2,
        gutterMm: 5,
        labelGutterMm: 4,
        template: findLayoutTemplate('two-thirds-one-third')!,
      });
    });
    expect(
      Object.values(templated.nodes).some((n) => n.type === 'panel' && n.slot !== null),
    ).toBe(true);

    const ds = templated.datasets[0]!;
    const grown = editDocument(templated, (draft) => {
      addPanelWithPlot(draft, newId, {
        frame: nextPanelFrame(draft, { width: 60, height: 50 }),
        datasetId: ds.id,
        name: 'Three',
      });
      applyAutoLayout(draft, { marginMm: 2, gutterMm: 5, labelGutterMm: 4 });
    });

    const panels = Object.values(grown.nodes).filter((n) => n.type === 'panel');
    // A slot authored for a 2-column weighted grid would otherwise be replayed
    // against the new 3-column one, putting two panels in the same cell.
    expect(panels.every((p) => p.slot === null)).toBe(true);

    for (const [i, a] of panels.entries()) {
      for (const b of panels.slice(i + 1)) {
        const overlaps =
          a.frame.x < b.frame.x + b.frame.width - 1e-9 &&
          b.frame.x < a.frame.x + a.frame.width - 1e-9 &&
          a.frame.y < b.frame.y + b.frame.height - 1e-9 &&
          b.frame.y < a.frame.y + a.frame.height - 1e-9;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('plots a contingency table as plain counted bars', () => {
    const newId = createIdFactory();
    const base = createDocument({ idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const counts: Dataset = {
      ...dataset('Group,Yes,No\nTreated,15,5\nControl,7,13', newId()),
      format: 'contingency',
    };

    const doc = editDocument(base, (draft) => {
      draft.datasets = [counts];
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 50 },
        datasetId: counts.id,
      });
    });

    const plot = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
    // An SEM over category counts is a standard error of nothing, and it looks
    // entirely convincing on the page.
    expect(plot.type === 'plot' && plot.errorBars).toBe('none');
    expect(plot.type === 'plot' && plot.showPoints).toBe(false);
    expect(plot.type === 'plot' && plot.plotType).toBe('bar');
    expect(plot.type === 'plot' && plot.y.title).toBe('Count');
  });

  it('locks a node whose layer is locked', () => {
    const { doc } = sampleDocument();
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    expect(isLocked(doc, panel.id)).toBe(false);

    // The Layers padlock only ever set this flag; nothing read it, so a locked
    // layer's nodes could still be dragged, nudged and deleted.
    const locked = editDocument(doc, (draft) => {
      const layer = draft.layers.find((l) => l.id === panel.layerId)!;
      layer.locked = true;
    });
    expect(isLocked(locked, panel.id)).toBe(true);
  });
});

describe('duplicate and draw order', () => {
  it('copies a panel with its plot and its label, all under fresh ids', () => {
    const { doc, newId } = sampleDocument();
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const before = Object.keys(doc.nodes).length;

    let copyId: string | null = null;
    const after = editDocument(doc, (draft) => {
      copyId = duplicateNode(draft, newId, panel.id, { x: 3, y: 3 });
    });

    // Panel + plot + label, exactly as `deleteNode` removes them.
    expect(Object.keys(after.nodes).length).toBe(before + 3);
    const copy = after.nodes[copyId!]!;
    expect(copy.id).not.toBe(panel.id);
    expect(copy.frame.x).toBeCloseTo(panel.frame.x + 3, 6);

    const copiedPlot = Object.values(after.nodes).find(
      (n) => n.type === 'plot' && n.parentId === copy.id,
    )!;
    expect(copiedPlot.id).not.toBe(
      Object.values(doc.nodes).find((n) => n.type === 'plot' && n.parentId === panel.id)!.id,
    );
    // The dataset is an input, not part of the figure element: copying a panel
    // must not fork the data behind it.
    expect(copiedPlot.type === 'plot' && copiedPlot.datasetId).toBe(doc.datasets[0]!.id);

    const copiedLabel = Object.values(after.nodes).find(
      (n) => n.type === 'panel-label' && n.panelId === copy.id,
    );
    expect(copiedLabel).toBeDefined();
  });

  it('remaps a copied bracket onto the copied plot', () => {
    const { doc, newId, plotId } = annotatedDocument();
    const panelId = doc.nodes[plotId]!.parentId!;

    let copyId: string | null = null;
    const after = editDocument(doc, (draft) => {
      copyId = duplicateNode(draft, newId, panelId);
    });

    const copiedPlot = Object.values(after.nodes).find(
      (n) => n.type === 'plot' && n.parentId === copyId,
    )!;
    const brackets = Object.values(after.nodes).filter((n) => n.type === 'bracket');
    expect(brackets).toHaveLength(2);
    // A bracket left pointing at the original would put "P < 0.001" over a plot
    // whose test never produced it.
    expect(brackets.some((b) => b.type === 'bracket' && b.plotId === copiedPlot.id)).toBe(true);
    expect(brackets.some((b) => b.type === 'bracket' && b.plotId === plotId)).toBe(true);
  });

  it('names the derived nodes that must not be copied alone', () => {
    const { doc } = annotatedDocument();
    const label = Object.values(doc.nodes).find((n) => n.type === 'panel-label')!;
    const bracket = Object.values(doc.nodes).find((n) => n.type === 'bracket')!;
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;

    expect(isDerivedNode(label)).toBe(true);
    expect(isDerivedNode(bracket)).toBe(true);
    expect(isDerivedNode(panel)).toBe(false);
    // A group-label — a caption or a heading — describes another node's
    // content rather than standing on its own, the same reasoning as the two
    // above.
    expect(isDerivedNode({ ...panel, type: 'group-label', memberIds: [panel.id], edge: 'top', title: '' } as unknown as Parameters<typeof isDerivedNode>[0])).toBe(true);
  });

  it('reorders siblings through the real draw order and renumbers z with no gaps', () => {
    const { doc, newId } = sampleDocument();
    const withText = editDocument(doc, (draft) => {
      for (const text of ['one', 'two', 'three']) {
        addText(draft, newId, { frame: { x: 0, y: 0, width: 10, height: 4 }, text });
      }
    });

    // The order the renderer paints in, named so the assertions read as the
    // page does. The sample's panels are in the Graphs layer, the texts land in
    // Annotations and the panel letters in Labels, so this list spans three.
    const order = (d: typeof withText): string[] =>
      Object.values(d.nodes)
        .filter((n) => n.parentId === null)
        .sort((a, b) => compareDrawOrder(d, a, b))
        .map((n) => (n.type === 'text' ? n.text : n.type));

    expect(order(withText)).toEqual([
      'panel',
      'panel',
      'one',
      'two',
      'three',
      'panel-label',
      'panel-label',
    ]);

    // "Bring to front" means the front of the *page*: it passes the panel
    // letters standing above it in the Labels layer rather than stopping at the
    // top of its own.
    const first = Object.values(withText.nodes).find((n) => n.type === 'text' && n.text === 'one')!;
    const front = editDocument(withText, (draft) => reorderNode(draft, first.id, 'front'));
    expect(order(front)).toEqual([
      'panel',
      'panel',
      'two',
      'three',
      'panel-label',
      'panel-label',
      'one',
    ]);

    // One step back is one node back, whichever layer that node is in.
    const back = editDocument(front, (draft) => reorderNode(draft, first.id, 'backward'));
    expect(order(back)).toEqual([
      'panel',
      'panel',
      'two',
      'three',
      'panel-label',
      'one',
      'panel-label',
    ]);

    // Renumbered 0..n-1 every time, so repeated steps cannot drift apart. Each
    // layer's nodes stay contiguous under the (layer, z) sort, so numbering the
    // whole top level in one run reorders nothing across a boundary.
    const zs = Object.values(back.nodes)
      .filter((n) => n.parentId === null)
      .map((n) => n.z)
      .sort((a, b) => a - b);
    expect(zs).toEqual(zs.map((_, i) => i));
  });

  it('sends a shape under a graph, which needs its layer to change', () => {
    const { doc, newId } = sampleDocument();
    const withRect = editDocument(doc, (draft) => {
      addShape(draft, newId, {
        shape: 'rect',
        frame: { x: 10, y: 10, width: 30, height: 20 },
        fill: { color: '#ff0000', opacity: 1 },
      });
    });

    const rect = Object.values(withRect.nodes).find((n) => n.type === 'shape')!;
    const panel = Object.values(withRect.nodes).find((n) => n.type === 'panel')!;
    const graphs = findLayer(withRect, panel.layerId)!;

    // Created in Annotations, which sorts above Graphs however z is numbered —
    // the reported bug: "send to back" left the rectangle covering the figure.
    expect(findLayer(withRect, rect.layerId)!.name).toBe('Annotations');
    expect(compareDrawOrder(withRect, rect, panel)).toBeGreaterThan(0);

    const sent = editDocument(withRect, (draft) => reorderNode(draft, rect.id, 'back'));
    const moved = sent.nodes[rect.id]!;

    // Both read out of `sent`: every sibling is renumbered, so comparing
    // against the pre-move panel would compare two different documents.
    expect(compareDrawOrder(sent, moved, sent.nodes[panel.id]!)).toBeLessThan(0);
    expect(findLayer(sent, moved.layerId)!.z).toBeLessThanOrEqual(graphs.z);
    // Behind every other top-level node, not merely behind the panel.
    for (const other of Object.values(sent.nodes).filter(
      (n) => n.parentId === null && n.id !== moved.id,
    )) {
      expect(compareDrawOrder(sent, moved, other)).toBeLessThan(0);
    }

    // And back to the front again, so the move is not one-way.
    const returned = editDocument(sent, (draft) => reorderNode(draft, rect.id, 'front'));
    for (const other of Object.values(returned.nodes).filter(
      (n) => n.parentId === null && n.id !== rect.id,
    )) {
      expect(compareDrawOrder(returned, returned.nodes[rect.id]!, other)).toBeGreaterThan(0);
    }
  });

  it('steps a shape across a layer boundary one press at a time', () => {
    const { doc, newId } = sampleDocument();
    const withRect = editDocument(doc, (draft) => {
      addShape(draft, newId, { shape: 'rect', frame: { x: 0, y: 0, width: 10, height: 10 } });
    });
    const rect = Object.values(withRect.nodes).find((n) => n.type === 'shape')!;

    // Two panels sit below it, so two presses put it under both — the second is
    // the one that has to leave the Annotations layer.
    const once = editDocument(withRect, (draft) => reorderNode(draft, rect.id, 'backward'));
    const twice = editDocument(once, (draft) => reorderNode(draft, rect.id, 'backward'));

    const panels = Object.values(twice.nodes).filter((n) => n.type === 'panel');
    expect(panels).toHaveLength(2);
    for (const panel of panels) {
      expect(compareDrawOrder(twice, twice.nodes[rect.id]!, panel)).toBeLessThan(0);
    }
    expect(findLayer(twice, twice.nodes[rect.id]!.layerId)!.name).toBe('Graphs');
  });

  it('stops rather than moving a node into a hidden or locked layer', () => {
    const { doc, newId } = sampleDocument();
    const withRect = editDocument(doc, (draft) => {
      addShape(draft, newId, { shape: 'rect', frame: { x: 0, y: 0, width: 10, height: 10 } });
    });
    const rect = Object.values(withRect.nodes).find((n) => n.type === 'shape')!;

    const landsIn = (
      where: 'front' | 'back',
      prepare: (draft: typeof withRect) => void = () => undefined,
    ): string => {
      const prepared = editDocument(withRect, prepare);
      const sent = editDocument(prepared, (draft) => reorderNode(draft, rect.id, where));
      return findLayer(sent, sent.nodes[rect.id]!.layerId)!.name;
    };

    // Untouched, the rectangle reaches the layer of the node it comes to rest
    // against — the panels it was reported as covering. (Not `Images`: the
    // sample has no node there, and an empty layer is nothing to rest against.)
    expect(landsIn('back')).toBe('Graphs');
    expect(landsIn('front')).toBe('Labels');

    // Hidden or locked, that layer is out of bounds: a draw-order command must
    // not make an object disappear or become unselectable, so the node goes as
    // far as it legally may — here, no further than the bottom of its own.
    expect(
      landsIn('back', (draft) => {
        draft.layers.find((l) => l.name === 'Graphs')!.hidden = true;
      }),
    ).toBe('Annotations');
    expect(
      landsIn('back', (draft) => {
        draft.layers.find((l) => l.name === 'Graphs')!.locked = true;
      }),
    ).toBe('Annotations');

    // Stopping short is per layer, not all-or-nothing: with the panel letters'
    // own layer locked the rectangle still climbs through the one below it.
    expect(
      landsIn('front', (draft) => {
        draft.layers.find((l) => l.name === 'Labels')!.locked = true;
      }),
    ).toBe('Statistics');
  });

  it('orders the children of a parent by z alone, with no layer term', () => {
    const { doc, newId } = sampleDocument();
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const withChildren = editDocument(doc, (draft) => {
      // A shape parented into the panel: created in Annotations, drawn among the
      // panel's own children, where the layer never enters the comparison.
      addShape(draft, newId, {
        shape: 'rect',
        frame: { x: 0, y: 0, width: 5, height: 5 },
        parentId: panel.id,
      });
    });

    const child = Object.values(withChildren.nodes).find(
      (n) => n.type === 'shape' && n.parentId === panel.id,
    )!;
    const plot = Object.values(withChildren.nodes).find((n) => n.parentId === panel.id && n.type === 'plot')!;
    expect(child.z).toBeGreaterThan(plot.z);

    const sent = editDocument(withChildren, (draft) => reorderNode(draft, child.id, 'back'));
    expect(sent.nodes[child.id]!.z).toBeLessThan(sent.nodes[plot.id]!.z);
    // No layer change: among children the layer is not what decides the order,
    // so moving one would be a side effect nobody asked for.
    expect(sent.nodes[child.id]!.layerId).toBe(child.layerId);
  });
});

describe('layout templates', () => {
  it('offers a template for every panel count up to six', () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      expect(templatesForPanelCount(count).length).toBeGreaterThan(0);
    }
  });

  it('gives every panel its own cell', () => {
    for (const template of LAYOUT_TEMPLATES) {
      expect(template.slots).toHaveLength(template.panelCount);

      // Two panels sharing a slot would stack on top of each other, which is
      // exactly the overlap this round of fixes exists to remove.
      const occupied = new Set<string>();
      for (const slot of template.slots) {
        for (let r = slot.row; r < slot.row + (slot.rowSpan ?? 1); r++) {
          for (let c = slot.col; c < slot.col + (slot.colSpan ?? 1); c++) {
            expect(occupied.has(`${r},${c}`)).toBe(false);
            occupied.add(`${r},${c}`);
            expect(r).toBeLessThan(template.grid.rows);
            expect(c).toBeLessThan(template.grid.columns);
          }
        }
      }
    }
  });

  it('offers a single-column stack at every multi-panel count', () => {
    /*
     * The reported gap: every template was landscape-biased, and a vertical
     * stack — the commonest arrangement for a multi-row figure — could not be
     * chosen at all.
     */
    for (const count of [2, 3, 4, 5, 6]) {
      const stack = templatesForPanelCount(count).find(
        (t) => t.grid.columns === 1 && t.grid.rows === count,
      );
      expect(stack, `no vertical stack for ${count} panels`).toBeDefined();
      expect(stack!.slots).toEqual(
        Array.from({ length: count }, (_, row) => ({ row, col: 0 })),
      );
    }
  });

  it('has a unique id for every template', () => {
    // `findLayoutTemplate` returns the first match, so a duplicate id would
    // make one of the two unreachable from the Toolbar's dropdown.
    const ids = LAYOUT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(findLayoutTemplate(id)?.id).toBe(id);
  });

  it('warns about page height on every template taller than two rows', () => {
    // Nothing here grows the page, so a tall template compresses its panels
    // into the existing height. The description is the one place that says so,
    // and the Toolbar already shows it as the option's tooltip.
    for (const template of LAYOUT_TEMPLATES) {
      if (template.grid.rows <= 2) continue;
      expect(template.description, `${template.id} says nothing about height`).toMatch(
        /page height/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Images, scale bars and annotations
// ---------------------------------------------------------------------------

/** TIFF magic plus bytes that are not valid UTF-8, so any text round trip
 *  through the archive corrupts them detectably rather than silently. */
const TIFF_BYTES = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xff, 0xfe, 0x00, 0x80, 0xc0, 0x01]);

function imageDocument(options: { naturalPx?: { width: number; height: number } } = {}) {
  const newId = createIdFactory();
  const base = createDocument({
    widthMm: 183,
    heightMm: 75,
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const assetId = newId();
  const naturalPx = options.naturalPx ?? { width: 1000, height: 800 };

  const doc = editDocument(base, (draft) => {
    addAsset(draft, {
      id: assetId,
      filename: 'micrograph.tif',
      mimeType: 'image/tiff',
      byteLength: TIFF_BYTES.length,
      naturalPx,
    });
    addPanelWithImage(draft, newId, {
      frame: { x: 0, y: 0, width: 50, height: 40 },
      assetId,
      naturalPx,
      name: 'Micrograph',
    });
  });

  const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;
  return { doc, newId, assetId, image };
}

describe('assets and image panels', () => {
  it('derives an archive path from the filename extension', () => {
    const { doc, assetId } = imageDocument();
    expect(doc.assets[0]!.path).toBe(`assets/${assetId}.tif`);
  });

  it('is idempotent on asset id, so re-importing does not duplicate', () => {
    const { doc, assetId } = imageDocument();
    const after = editDocument(doc, (draft) => {
      addAsset(draft, {
        id: assetId,
        filename: 'micrograph.tif',
        mimeType: 'image/tiff',
        byteLength: 10,
        naturalPx: null,
      });
    });
    expect(after.assets).toHaveLength(1);
  });

  it('refuses an image whose asset was never registered', () => {
    const { doc, newId } = imageDocument();
    expect(() =>
      editDocument(doc, (draft) => {
        addImage(draft, newId, {
          assetId: 'nope',
          frame: { x: 0, y: 0, width: 10, height: 10 },
          naturalPx: { width: 10, height: 10 },
        });
      }),
    ).toThrow(/No such asset/);
  });

  it('locks the panel to the image aspect ratio so layout reserves the right cell', () => {
    const { doc } = imageDocument({ naturalPx: { width: 1000, height: 500 } });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    expect(panel.type === 'panel' && panel.aspectLock).toBeCloseTo(2, 10);
  });

  it('names the image after its file, not "Image 1"', () => {
    const { image } = imageDocument();
    expect(image.name).toBe('Micrograph');
    // …and without an explicit name, the filename stands in.
    const { doc, newId, assetId } = imageDocument();
    const after = editDocument(doc, (draft) => {
      addImage(draft, newId, {
        assetId,
        frame: { x: 0, y: 0, width: 10, height: 10 },
        naturalPx: { width: 10, height: 10 },
      });
    });
    const added = Object.values(after.nodes).filter((n) => n.type === 'image').at(-1)!;
    expect(added.name).toBe('micrograph.tif');
  });

  it('keeps images filling their panel through a re-layout', () => {
    const { doc, image } = imageDocument();
    // Auto-layout used to resize only plots, so a micrograph kept its old size
    // inside a resized panel — visible as the image no longer filling it.
    const laid = editDocument(doc, (draft) =>
      applyAutoLayout(draft, { marginMm: 2, gutterMm: 5, labelGutterMm: 4 }),
    );
    const panel = laid.nodes[image.parentId!]!;
    expect(laid.nodes[image.id]!.frame.width).toBeCloseTo(panel.frame.width, 6);
    expect(laid.nodes[image.id]!.frame.height).toBeCloseTo(panel.frame.height, 6);
  });

  it('tracks which images use an asset, so orphans are findable', () => {
    const { doc, assetId, image } = imageDocument();
    expect(imagesUsingAsset(doc.nodes, assetId)).toHaveLength(1);

    const after = editDocument(doc, (draft) => deleteNode(draft, image.id));
    expect(imagesUsingAsset(after.nodes, assetId)).toHaveLength(0);
    // The record survives: undo must be able to bring the node back.
    expect(after.assets).toHaveLength(1);
  });
});

describe('crop', () => {
  it('never yields a zero extent, which the renderer would divide by', () => {
    const crop = normaliseCrop({ x: 0, y: 0, width: 0, height: 0 });
    expect(crop.width).toBeGreaterThanOrEqual(MIN_CROP);
    expect(crop.height).toBeGreaterThanOrEqual(MIN_CROP);
  });

  it('clamps an extent that would run past the source edge', () => {
    expect(normaliseCrop({ x: 0.9, y: 0, width: 0.5, height: 1 }).width).toBeCloseTo(0.1, 10);
  });

  it('clamps negative and out-of-range origins into the unit square', () => {
    const crop = normaliseCrop({ x: -0.3, y: 4, width: 1, height: 1 });
    expect(crop.x).toBe(0);
    expect(crop.y).toBeCloseTo(1 - MIN_CROP, 10);
  });

  it('falls back to the full frame for missing or non-finite values', () => {
    expect(normaliseCrop(undefined)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(normaliseCrop({ width: Number.NaN, height: Infinity }).width).toBe(1);
  });

  it('survives the archive, so a crop narrower than the schema floor cannot be saved', () => {
    const { doc, image } = imageDocument();
    const cropped = editDocument(doc, (draft) =>
      setImageCrop(draft, image.id, { x: 0.25, width: 0.5 }),
    );
    const loaded = loadArchive(saveArchive(buildArchiveContents(cropped)));
    const back = loaded.document.nodes[image.id]!;
    expect(back.type === 'image' && back.crop).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
  });
});

describe('scale bars', () => {
  /** 1000 px wide, shown 50 mm wide → 0.05 mm per pixel. At 2 px/µm a 10 µm
   *  bar spans 20 px, so it must draw exactly 1.0 mm. */
  function barDocument() {
    const { doc, newId, image } = imageDocument();
    const withBar = editDocument(doc, (draft) => {
      addScaleBar(draft, newId, {
        imageId: image.id,
        length: 10,
        pixelsPerUnit: 2,
        unitLabel: 'µm',
        calibrationSource: 'metadata',
      });
    });
    const bar = Object.values(withBar.nodes).find((n) => n.type === 'scale-bar')!;
    return { doc: withBar, bar, image, newId };
  }

  it('derives its width from the image calibration', () => {
    const { doc, bar } = barDocument();
    expect(scaleBarWidthMm(doc.nodes, bar.id)).toBeCloseTo(1.0, 10);
    expect(doc.nodes[bar.id]!.frame.width).toBeCloseTo(1.0, 10);
  });

  it('sits on the picture, not in the letterbox beside it', () => {
    /*
     * An aspect-preserved micrograph in a frame of a different shape leaves
     * empty space inside its own frame. Placing the bar against the *frame*
     * put it in that emptiness — measured on the sample figure's montage,
     * 100 px below the micrograph and horizontally under the next tile along.
     * A bar that is not on its image measures nothing.
     */
    const { doc, bar, image, newId } = barDocument();

    // Make the frame much taller than the picture needs, so the two differ.
    const tall = editDocument(doc, (draft) => {
      const img = draft.nodes[image.id]!;
      img.frame = { ...img.frame, height: img.frame.height * 3 };
      resyncScaleBars(draft);
    });

    const placed = tall.nodes[bar.id]!.frame;
    const content = imageContentRect(tall.nodes[image.id] as ImageNode);
    expect(placed.y + placed.height).toBeLessThanOrEqual(content.y + content.height + 0.001);
    expect(placed.x + placed.width).toBeLessThanOrEqual(content.x + content.width + 0.001);
    expect(placed.y).toBeGreaterThanOrEqual(content.y - 0.001);
    void newId;
  });

  it('follows its picture when the image is resized', () => {
    // `resyncScaleBars` used to rewrite the width alone, so a bar kept its old
    // `y` and the selection chrome drifted off the drawn bar.
    const { doc, bar, image } = barDocument();
    const before = doc.nodes[bar.id]!.frame.y;
    const shorter = editDocument(doc, (draft) => {
      const img = draft.nodes[image.id]!;
      img.frame = { ...img.frame, height: img.frame.height / 2 };
      resyncScaleBars(draft);
    });
    expect(shorter.nodes[bar.id]!.frame.y).not.toBeCloseTo(before, 3);
  });

  it('sits under the picture, right-aligned to it, when placed below', () => {
    const { doc, bar, image } = barDocument();
    const placed = editDocument(doc, (draft) => {
      const target = draft.nodes[bar.id]!;
      if (target.type === 'scale-bar') target.placement = 'below';
      resyncScaleBars(draft);
    });

    const content = imageContentRect(placed.nodes[image.id] as ImageNode);
    const frame = placed.nodes[bar.id]!.frame;
    const width = scaleBarWidthMm(placed.nodes, bar.id)!;

    // Below the picture's bottom edge by the gap, and flush with its right
    // edge — the picture's, not the frame's, which is the distinction that
    // matters the moment an image letterboxes.
    expect(frame.y).toBeCloseTo(content.y + content.height + SCALE_BAR_BELOW_GAP_MM, 10);
    expect(frame.x + frame.width).toBeCloseTo(content.x + content.width, 10);
    expect(frame.width).toBeCloseTo(width, 10);
  });

  it('leaves an inside bar exactly where it has always been', () => {
    // Absent and explicit `'inside'` must both produce today's frame, or every
    // saved figure moves on open.
    const { doc, bar } = barDocument();
    const explicit = editDocument(doc, (draft) => {
      const target = draft.nodes[bar.id]!;
      if (target.type === 'scale-bar') target.placement = 'inside';
      resyncScaleBars(draft);
    });
    expect(explicit.nodes[bar.id]!.frame).toEqual(doc.nodes[bar.id]!.frame);
  });

  it("keeps the label's own colour through a save", () => {
    /*
     * `TextStyle.color` has been in the schema since phase 1 and nothing has
     * ever round-tripped it, on any node type — so this is the first thing to
     * prove zod actually keeps it. The standing hazard is the other way round
     * (a field in the type but not the schema is dropped on save); an
     * unexercised schema field is the same risk from the far side.
     */
    const { doc, bar } = barDocument();
    const coloured = editDocument(doc, (draft) => {
      const target = draft.nodes[bar.id]!;
      if (target.type === 'scale-bar') target.style = { ...target.style, color: '#ff0000' };
    });
    const reloaded = loadArchive(saveArchive(buildArchiveContents(coloured))).document;
    const node = reloaded.nodes[bar.id]!;
    expect(node.type === 'scale-bar' && node.style.color).toBe('#ff0000');
    // And an untouched bar keeps no colour at all, so it still follows the
    // theme rather than being frozen at whatever black happened to be.
    const plain = loadArchive(saveArchive(buildArchiveContents(doc))).document.nodes[bar.id]!;
    expect(plain.type === 'scale-bar' && plain.style.color).toBeUndefined();
  });

  it('makes room below by pushing the row beneath it', () => {
    /*
     * A picture routinely fills its frame exactly — measured on the sample, the
     * montage tiles are 16.78 x 11.89 mm pictures in 16.78 x 11.89 mm frames —
     * so there is no spare strip to drop a bar into and the space has to be
     * made.
     */
    const { doc, bar, image } = barDocument();
    const upper = image.parentId!;
    const newId = createIdFactory();
    const withNeighbour = editDocument(doc, (draft) => {
      addPanel(draft, newId, { frame: { x: 0, y: 41, width: 50, height: 20 }, name: 'Below' });
    });
    const lower = Object.values(withNeighbour.nodes).find(
      (n) => n.type === 'panel' && n.name === 'Below',
    )!;

    const after = editDocument(withNeighbour, (draft) => {
      const target = draft.nodes[bar.id]!;
      if (target.type === 'scale-bar') target.placement = 'below';
      resyncScaleBars(draft);
      reserveSpaceForScaleBars(draft);
    });

    const band = scaleBarBelowExtentMm(after.nodes[bar.id] as ScaleBarNode);
    const pictureBottom = 0 + imageContentRect(after.nodes[image.id] as ImageNode).height;
    expect(after.nodes[lower.id]!.frame.y - pictureBottom).toBeCloseTo(band, 6);
    // The captioned panel itself never moved — only what sits below it.
    expect(after.nodes[upper]!.frame).toEqual(withNeighbour.nodes[upper]!.frame);

    // And a second pass moves nothing: this runs on every from-scratch layout.
    const again = editDocument(after, (draft) => reserveSpaceForScaleBars(draft));
    expect(again.nodes[lower.id]!.frame).toEqual(after.nodes[lower.id]!.frame);
  });

  it('shrinks its own panel when there is no row below to push', () => {
    /*
     * The bottom row: nothing to move, so the panel that gained the bar pays
     * for it out of its own height and the page is untouched.
     *
     * The picture has to actually reach the page's bottom edge for there to be
     * no room — the plain fixture leaves 35 mm of empty page below it, where
     * the honest answer is that nothing needs reserving at all. So the panel is
     * grown to the full page and the image stretched to fill it.
     */
    const { doc: base, bar, image } = barDocument();
    const panelId = image.parentId!;
    const doc = editDocument(base, (draft) => {
      const img = draft.nodes[image.id]!;
      if (img.type === 'image') img.preserveAspect = false;
      resizePanel(draft, panelId, { x: 0, y: 0, width: 50, height: 75 });
      resyncScaleBars(draft);
    });
    const before = doc.nodes[panelId]!.frame.height;

    const after = editDocument(doc, (draft) => {
      const target = draft.nodes[bar.id]!;
      if (target.type === 'scale-bar') target.placement = 'below';
      resyncScaleBars(draft);
      reserveSpaceForScaleBars(draft);
    });

    expect(after.nodes[panelId]!.frame.height).toBeLessThan(before);
    expect(after.nodes[panelId]!.frame.height).toBeGreaterThanOrEqual(MIN_TILE_MM);
    expect(after.page.heightMm).toBe(doc.page.heightMm);
  });

  it('reserves nothing for a bar drawn on the picture', () => {
    const { doc, image } = barDocument();
    const panelId = image.parentId!;
    const after = editDocument(doc, (draft) => reserveSpaceForScaleBars(draft));
    expect(after.nodes[panelId]!.frame).toEqual(doc.nodes[panelId]!.frame);
  });

  it('draws black unless asked otherwise', () => {
    // White is right only over a dark micrograph and invisible everywhere else,
    // including on the page a bar dragged off its image sits on.
    const { bar } = barDocument();
    expect(bar.type === 'scale-bar' && bar.fill.color).toBe('#000000');
  });

  it('halves when its image is halved — the integrity property', () => {
    const { doc, bar, image } = barDocument();
    const panelId = image.parentId!;
    const resized = editDocument(doc, (draft) =>
      resizePanel(draft, panelId, { x: 0, y: 0, width: 25, height: 20 }),
    );
    expect(scaleBarWidthMm(resized.nodes, bar.id)).toBeCloseTo(0.5, 10);
    // The frame follows too, or the selection chrome sits where the bar is not.
    expect(resized.nodes[bar.id]!.frame.width).toBeCloseTo(0.5, 10);
  });

  it('is measured across the picture, not the frame, when a crop letterboxes it', () => {
    /*
     * This test used to assert 2.0 and was pinning a real bug.
     *
     * The fixture is a 1000 x 800 px micrograph in a 50 x 40 mm frame, so the
     * picture fills the frame and 1000 px span 50 mm. Cropping to half the
     * width keeps 500 px, and because `preserveAspect` is on, the kept region's
     * new 0.625 aspect **letterboxes**: `renderImage` draws those 500 px across
     * 25 mm, not 50. So a pixel is still 0.05 mm, and the bar — 10 µm at 2 px
     * per µm, i.e. 20 source pixels — is still 1.0 mm.
     *
     * Dividing by `frame.width` instead said 0.1 mm per pixel and drew the bar
     * at 2.0 mm: exactly twice the distance it claims. A bar that overstates
     * its own length is a false measurement in a published figure, which is
     * what `checkScaleBarCalibration` exists to keep out.
     */
    const { doc, bar, image } = barDocument();
    const cropped = editDocument(doc, (draft) => setImageCrop(draft, image.id, { width: 0.5 }));
    expect(imageContentRect(cropped.nodes[image.id] as ImageNode).width).toBeCloseTo(25, 10);
    expect(scaleBarWidthMm(cropped.nodes, bar.id)).toBeCloseTo(1.0, 10);
  });

  it('does grow when the crop really does spread fewer pixels over the same width', () => {
    /*
     * The property the old test was reaching for, set up so it actually holds:
     * with `preserveAspect` off the kept region is stretched to fill the frame,
     * so 500 px really do span all 50 mm and each is twice as wide.
     */
    const { doc, bar, image } = barDocument();
    const cropped = editDocument(doc, (draft) => {
      const img = draft.nodes[image.id]!;
      if (img.type === 'image') img.preserveAspect = false;
      setImageCrop(draft, image.id, { width: 0.5 });
    });
    expect(scaleBarWidthMm(cropped.nodes, bar.id)).toBeCloseTo(2.0, 10);
  });

  it('refuses a target that is not an image', () => {
    const { doc, newId } = imageDocument();
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    let bar: unknown = 'unset';
    editDocument(doc, (draft) => {
      bar = addScaleBar(draft, newId, { imageId: panel.id, length: 10, pixelsPerUnit: 2 });
    });
    expect(bar).toBeNull();
  });

  it('keeps showLabel in step with labelPosition', () => {
    const { doc, newId, image } = imageDocument();
    const after = editDocument(doc, (draft) => {
      addScaleBar(draft, newId, {
        imageId: image.id,
        length: 10,
        pixelsPerUnit: 2,
        labelPosition: 'none',
      });
    });
    const bar = Object.values(after.nodes).find((n) => n.type === 'scale-bar')!;
    expect(bar.type === 'scale-bar' && bar.showLabel).toBe(false);
  });

  it('records calibration provenance, defaulting to unknown', () => {
    const { doc, newId, image } = imageDocument();
    const after = editDocument(doc, (draft) => {
      addScaleBar(draft, newId, { imageId: image.id, length: 10, pixelsPerUnit: 2 });
    });
    const bar = Object.values(after.nodes).find((n) => n.type === 'scale-bar')!;
    expect(bar.type === 'scale-bar' && bar.calibrationSource).toBe('unknown');
  });
});

describe('annotations', () => {
  it('always writes at least two points, which the schema requires', () => {
    const { doc, newId } = imageDocument();
    const after = editDocument(doc, (draft) => {
      addArrow(draft, newId, { points: [{ x: 0, y: 0 }] });
    });
    const arrow = Object.values(after.nodes).find((n) => n.type === 'arrow')!;
    expect(arrow.type === 'arrow' && arrow.points.length).toBeGreaterThanOrEqual(2);
    // The real test: a one-point arrow would make the project unloadable.
    expect(() => loadArchive(saveArchive(buildArchiveContents(after)))).not.toThrow();
  });

  it('rebases the frame when a point is dragged past the origin', () => {
    const { doc, newId } = imageDocument();
    let arrowId = '';
    const withArrow = editDocument(doc, (draft) => {
      arrowId = addArrow(draft, newId, { frame: { x: 20, y: 20, width: 10, height: 10 } }).id;
    });

    const moved = editDocument(withArrow, (draft) =>
      setArrowPoint(draft, arrowId, 0, { x: -5, y: -4 }),
    );
    const arrow = moved.nodes[arrowId]!;

    expect(arrow.type === 'arrow' && Math.min(...arrow.points.map((p) => p.x))).toBe(0);
    expect(arrow.frame.x).toBeCloseTo(15, 10);
    expect(arrow.frame.y).toBeCloseTo(16, 10);
  });

  it('defaults to a horizontal line, not a diagonal, when no points are given', () => {
    const { doc, newId } = imageDocument();
    const after = editDocument(doc, (draft) => {
      addArrow(draft, newId, { frame: { x: 0, y: 0, width: 20, height: 12 } });
    });
    const arrow = Object.values(after.nodes).find((n) => n.type === 'arrow')!;
    const points = arrow.type === 'arrow' ? arrow.points : [];
    expect(points).toHaveLength(2);
    expect(points[0]!.y).toBeCloseTo(points[1]!.y, 6);

    // Scaling the frame asymmetrically (the ordinary box-resize path) can
    // only ever scale that one shared y by a single factor — it cannot
    // introduce a diagonal on its own.
    const rescaled = editDocument(after, (draft) => {
      rescaleArrowPoints(draft, arrow.id, { x: 0, y: 0, width: 40, height: 3 });
    });
    const rescaledPoints = rescaled.nodes[arrow.id]!;
    const p = rescaledPoints.type === 'arrow' ? rescaledPoints.points : [];
    expect(p[0]!.y).toBeCloseTo(p[1]!.y, 6);
  });

  it('leaves an already-normalised arrow alone', () => {
    const { doc, newId } = imageDocument();
    let arrowId = '';
    const withArrow = editDocument(doc, (draft) => {
      // Points spanning the frame's full width and height exactly — i.e.
      // already tight, unlike the default (horizontal) fallback, which
      // deliberately keeps a taller frame than its points need so the
      // freshly-inserted resize handles stay well separated.
      arrowId = addArrow(draft, newId, {
        frame: { x: 10, y: 10, width: 20, height: 10 },
        points: [
          { x: 0, y: 10 },
          { x: 20, y: 0 },
        ],
      }).id;
    });
    const before = withArrow.nodes[arrowId]!.frame;
    const after = editDocument(withArrow, (draft) => normaliseArrowFrame(draft, arrowId));
    expect(after.nodes[arrowId]!.frame).toEqual(before);
  });

  it('creates shapes unfilled, since an annotation outlines rather than hides', () => {
    const { doc, newId } = imageDocument();
    const after = editDocument(doc, (draft) => {
      addShape(draft, newId, { shape: 'rect', frame: { x: 0, y: 0, width: 10, height: 10 } });
    });
    const shape = Object.values(after.nodes).find((n) => n.type === 'shape')!;
    expect(shape.type === 'shape' && shape.fill).toBeNull();
    expect(shape.type === 'shape' && shape.stroke).not.toBeNull();
  });
});

describe('group-aware layout', () => {
  /**
   * The reported figure: panel C alone at the top, panels A and B grouped at
   * the *bottom*, which is what makes the relative-versus-page distinction
   * bite. `addGroup` unions the members, so G comes out (5, 60, 115, 40) with A
   * local (0, 0) and B local (60, 0).
   */
  function groupedFigure() {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 120,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    let doc = editDocument(base, (draft) => {
      addPanel(draft, newId, { frame: { x: 5, y: 60, width: 55, height: 40 }, name: 'A' });
      addPanel(draft, newId, { frame: { x: 65, y: 60, width: 55, height: 40 }, name: 'B' });
      addPanel(draft, newId, { frame: { x: 5, y: 5, width: 80, height: 40 }, name: 'C' });
    });
    const id = (name: string): NodeId =>
      Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === name)!.id;
    const a = id('A');
    const b = id('B');
    const c = id('C');
    doc = editDocument(doc, (draft) => {
      addGroup(draft, newId, [a, b]);
    });
    const g = Object.values(doc.nodes).find((n) => n.type === 'group')!.id;
    return { doc, newId, a, b, c, g };
  }

  const OPTS = { marginMm: 2, gutterMm: 5, labelGutterMm: 4 };

  it('reads a grouped panel at its page position, not its position in the group', () => {
    /*
     * A grouped panel's frame is relative to its group, so comparing the two
     * spaces put A and B — local y 0, page y 60 — inside C's 5 mm row band and
     * sorted the three by x: 0, 5, 60. Measured `A C B`, on a page that plainly
     * reads `C A B`, and the figure was lettered to match.
     */
    const { doc } = groupedFigure();
    expect(readingOrder(doc.nodes).map((n) => n.name)).toEqual(['C', 'A', 'B']);
  });

  it('lays a group out as one unit, keeping its members together', () => {
    /*
     * Two units — panel C and group G — so `suggestGrid(2)` is 1 × 2.
     *   usable width 183 − 2*2 − 5 = 174, columns 87, xs at 2 and 94
     *   label gutter 4 -> inner cells (6, 2, 83, 116) and (98, 2, 83, 116)
     * G holds no shape-bound panel, so it takes its cell whole and
     *   sx = 83/115 = 0.7217391304 , sy = 116/40 = 2.9
     *   A local (0, 0, 55, 40)  -> (0, 0, 39.6956522, 116)
     *   B local (60, 0, 55, 40) -> (43.3043478, 0, 39.6956522, 116)
     *
     * Before this, every panel was placed individually and its page-space frame
     * written into a group-relative field: A read (6, 2) against a true page
     * position of (11, 62), and B landed with its right edge at 186 mm on a
     * 183 mm page.
     */
    const { doc, a, b, c, g } = groupedFigure();
    const after = editDocument(doc, (draft) => {
      applyAutoLayout(draft, OPTS);
    });

    expect(after.nodes[c]!.frame).toEqual({ x: 6, y: 2, width: 83, height: 116 });
    // The group's own box moved with its members, where it used to go stale.
    expect(after.nodes[g]!.frame).toEqual({ x: 98, y: 2, width: 83, height: 116 });

    const pageA = absoluteFrame(after.nodes, a)!;
    const pageB = absoluteFrame(after.nodes, b)!;
    expect(pageA.x).toBeCloseTo(98, 6);
    expect(pageA.y).toBeCloseTo(2, 6);
    expect(pageB.x).toBeCloseTo(141.3043478, 6);
    // 141.3043478 + 39.6956522 = 181, the page less its own margin.
    expect(pageB.x + pageB.width).toBeCloseTo(181, 6);
  });

  it('puts a grouped panel’s letter beside where the panel actually is', () => {
    /*
     * A `panel-label` is a top-level node, so it is positioned in page space —
     * but it was placed from `panel.frame`, which for a grouped panel is the
     * group's local space. Asserted in both orders because two different
     * mechanisms are involved: relabel-then-layout goes through `resizeGroup`'s
     * position snapshot, layout-then-relabel through the creation path.
     */
    const { doc, newId, a, b, c } = groupedFigure();
    const label = (nodes: FigureDocument['nodes'], panelId: NodeId) =>
      Object.values(nodes).find(
        (n): n is Extract<FigureNode, { type: 'panel-label' }> =>
          n.type === 'panel-label' && n.panelId === panelId,
      )!;

    const layoutFirst = editDocument(doc, (draft) => {
      applyAutoLayout(draft, OPTS);
      relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
    });
    const relabelFirst = editDocument(doc, (draft) => {
      relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
      applyAutoLayout(draft, OPTS);
    });

    for (const nodes of [layoutFirst.nodes, relabelFirst.nodes]) {
      // A sits at page (98, 2), so its letter is 4 mm to the left of that.
      expect(label(nodes, a).frame.x).toBeCloseTo(94, 6);
      expect(label(nodes, a).frame.y).toBeCloseTo(2, 6);
      // Two panels in one group still get two letters, in page order.
      expect(label(nodes, c).text).toBe('a');
      expect(label(nodes, a).text).toBe('b');
      expect(label(nodes, b).text).toBe('c');
    }
  });

  it('scales a group uniformly when something inside it needs a shape', () => {
    /*
     * `resizeGroupGeometry` scales sx and sy independently and
     * `resizePanelGeometry` does not enforce a member's `aspectLock` — it
     * assigns the frame and re-tiles. So a non-uniform scale does not bend the
     * lock, it hands the member a wrong-shaped frame: round 41's dead strip,
     * with the group as the cause. Pinning the group to its own ratio is what
     * forces sx === sy.
     */
    const { doc, a, b, g } = groupedFigure();
    const locked = editDocument(doc, (draft) => {
      const panel = draft.nodes[a];
      if (panel?.type === 'panel') panel.aspectLock = 2;
    });
    const before = locked.nodes[g]!.frame;
    const after = editDocument(locked, (draft) => {
      applyAutoLayout(draft, OPTS);
    });

    const now = after.nodes[g]!.frame;
    expect(now.width / before.width).toBeCloseTo(now.height / before.height, 10);
    // And the members really did scale by that one factor.
    const sx = now.width / before.width;
    expect(after.nodes[a]!.frame.width).toBeCloseTo(55 * sx, 6);
    expect(after.nodes[b]!.frame.x).toBeCloseTo(60 * sx, 6);
  });

  it('leaves a group carrying no panel exactly where it is', () => {
    /*
     * The layout arranges panels. A group of annotations is no more part of the
     * grid than a loose shape is, and moving one would need a rule about what
     * it belongs to that the document does not carry.
     */
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 120, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    let doc = editDocument(base, (draft) => {
      addPanel(draft, newId, { frame: { x: 5, y: 5, width: 50, height: 40 }, name: 'A' });
      addPanel(draft, newId, { frame: { x: 70, y: 5, width: 50, height: 40 }, name: 'B' });
      addShape(draft, newId, { frame: { x: 10, y: 90, width: 20, height: 10 }, shape: 'rect' });
      addShape(draft, newId, { frame: { x: 40, y: 90, width: 20, height: 10 }, shape: 'rect' });
    });
    const shapes = Object.values(doc.nodes).filter((n) => n.type === 'shape').map((n) => n.id);
    doc = editDocument(doc, (draft) => {
      addGroup(draft, newId, shapes);
    });
    const g = Object.values(doc.nodes).find((n) => n.type === 'group')!.id;
    expect(layoutUnits(doc.nodes).map((u) => u.kind)).toEqual(['panel', 'panel']);

    const before = doc.nodes[g]!.frame;
    const after = editDocument(doc, (draft) => {
      applyAutoLayout(draft, OPTS);
    });
    expect(after.nodes[g]!.frame).toEqual(before);
  });

  it('lays out a figure with no groups exactly as it always did', () => {
    /*
     * The guard for the whole round, with the numbers written out rather than
     * compared against a freshly computed reference — a reference would shift
     * with the code it is meant to be checking.
     *
     *   suggestGrid(4) = 2 × 2
     *   usable width  183 − 4 − 5 = 174 -> 87 each, xs at 2 and 94
     *   usable height 120 − 4 − 5 = 111 -> 55.5 each, ys at 2 and 62.5
     *   label gutter 4 off each cell's left
     */
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 120, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      for (const name of ['A', 'B', 'C', 'D']) {
        addPanel(draft, newId, { frame: { x: 5, y: 5, width: 20, height: 20 }, name });
      }
      applyAutoLayout(draft, OPTS);
      relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
    });
    const frames = Object.values(doc.nodes)
      .filter((n) => n.type === 'panel')
      .map((n) => n.frame);
    expect(frames).toEqual([
      { x: 6, y: 2, width: 83, height: 55.5 },
      { x: 98, y: 2, width: 83, height: 55.5 },
      { x: 6, y: 62.5, width: 83, height: 55.5 },
      { x: 98, y: 62.5, width: 83, height: 55.5 },
    ]);
    const labels = Object.values(doc.nodes)
      .filter((n) => n.type === 'panel-label')
      .map((n) => ({ x: n.frame.x, y: n.frame.y }));
    expect(labels).toEqual([
      { x: 2, y: 2 },
      { x: 94, y: 2 },
      { x: 2, y: 62.5 },
      { x: 94, y: 62.5 },
    ]);
  });
});

describe('grouping', () => {
  function twoShapes() {
    const { doc, newId } = imageDocument();
    const ids: string[] = [];
    const after = editDocument(doc, (draft) => {
      ids.push(addShape(draft, newId, { shape: 'rect', frame: { x: 10, y: 10, width: 20, height: 10 } }).id);
      ids.push(addShape(draft, newId, { shape: 'ellipse', frame: { x: 50, y: 30, width: 20, height: 10 } }).id);
    });
    return { doc: after, ids, newId };
  }

  it('preserves every member position on the page', () => {
    const { doc, ids, newId } = twoShapes();
    const before = ids.map((id) => absoluteFrame(doc.nodes, id)!);

    const grouped = editDocument(doc, (draft) => {
      addGroup(draft, newId, ids);
    });

    for (const [index, id] of ids.entries()) {
      const now = absoluteFrame(grouped.nodes, id)!;
      expect(now.x).toBeCloseTo(before[index]!.x, 6);
      expect(now.y).toBeCloseTo(before[index]!.y, 6);
    }
  });

  it('sizes the group to the union of its members', () => {
    const { doc, ids, newId } = twoShapes();
    const grouped = editDocument(doc, (draft) => {
      addGroup(draft, newId, ids);
    });
    const group = Object.values(grouped.nodes).find((n) => n.type === 'group')!;
    expect(group.frame).toEqual({ x: 10, y: 10, width: 60, height: 30 });
  });

  it('restores positions on ungroup', () => {
    const { doc, ids, newId } = twoShapes();
    const before = ids.map((id) => absoluteFrame(doc.nodes, id)!);

    let groupId = '';
    const grouped = editDocument(doc, (draft) => {
      groupId = addGroup(draft, newId, ids)!.id;
    });
    const flat = editDocument(grouped, (draft) => ungroup(draft, groupId));

    expect(flat.nodes[groupId]).toBeUndefined();
    for (const [index, id] of ids.entries()) {
      const now = absoluteFrame(flat.nodes, id)!;
      expect(now.x).toBeCloseTo(before[index]!.x, 6);
      expect(now.y).toBeCloseTo(before[index]!.y, 6);
    }
  });

  it('refuses a selection spread across different parents', () => {
    const { doc, ids, newId } = twoShapes();
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    let group: unknown = 'unset';
    editDocument(doc, (draft) => {
      group = addGroup(draft, newId, [ids[0]!, image.id]);
    });
    expect(group).toBeNull();
  });

  it('refuses a selection of fewer than two nodes', () => {
    const { doc, ids, newId } = twoShapes();
    let group: unknown = 'unset';
    editDocument(doc, (draft) => {
      group = addGroup(draft, newId, [ids[0]!]);
    });
    expect(group).toBeNull();
  });

  describe('resizeGroup', () => {
    it('scales every member proportionally about the group origin', () => {
      const { doc, ids, newId } = twoShapes();
      let groupId = '';
      const grouped = editDocument(doc, (draft) => {
        groupId = addGroup(draft, newId, ids)!.id;
      });
      const group = grouped.nodes[groupId]!;
      const origin = { x: group.frame.x, y: group.frame.y };

      const resized = editDocument(grouped, (draft) => {
        resizeGroup(draft, groupId, {
          x: group.frame.x,
          y: group.frame.y,
          width: group.frame.width * 2,
          height: group.frame.height * 2,
        });
      });

      for (const id of ids) {
        const before = absoluteFrame(grouped.nodes, id)!;
        const after = absoluteFrame(resized.nodes, id)!;
        // Distance from the group's own (unmoved) corner doubles along with
        // the group, exactly like an ordinary anchored resize.
        expect(after.x - origin.x).toBeCloseTo((before.x - origin.x) * 2, 6);
        expect(after.y - origin.y).toBeCloseTo((before.y - origin.y) * 2, 6);
        expect(after.width).toBeCloseTo(before.width * 2, 6);
        expect(after.height).toBeCloseTo(before.height * 2, 6);
      }
      expect(resized.nodes[groupId]!.frame.width).toBeCloseTo(group.frame.width * 2, 6);
    });

    it("re-fills a panel member's content, not just its bare frame", () => {
      const { doc, newId } = imageDocument();
      const ds = dataset('Treatment,R1,R2\nA,1,2\nB,3,4', newId());
      let groupId = '';
      let panelId = '';
      const grouped = editDocument(doc, (draft) => {
        draft.datasets = [...draft.datasets, ds];
        const { panel } = addPanelWithPlot(draft, newId, {
          frame: { x: 0, y: 0, width: 40, height: 30 },
          datasetId: ds.id,
          name: 'Panel',
        });
        panelId = panel.id;
        const shape = addShape(draft, newId, {
          shape: 'rect',
          frame: { x: 50, y: 0, width: 10, height: 10 },
        });
        groupId = addGroup(draft, newId, [panel.id, shape.id])!.id;
      });

      const group = grouped.nodes[groupId]!;
      const resized = editDocument(grouped, (draft) => {
        resizeGroup(draft, groupId, {
          x: group.frame.x,
          y: group.frame.y,
          width: group.frame.width * 2,
          height: group.frame.height * 2,
        });
      });

      const panelAfter = resized.nodes[panelId]!;
      const plotAfter = Object.values(resized.nodes).find(
        (n) => n.type === 'plot' && n.parentId === panelId,
      )!;
      // The plot fills the panel's *new* frame -- fillPanelChildren ran,
      // rather than the panel just being handed a bigger bare rectangle.
      expect(plotAfter.frame).toEqual({
        x: 0,
        y: 0,
        width: panelAfter.frame.width,
        height: panelAfter.frame.height,
      });
    });

    it("rescales an arrow member's points", () => {
      const { doc, newId } = imageDocument();
      let groupId = '';
      let arrowId = '';
      const grouped = editDocument(doc, (draft) => {
        const arrow = addArrow(draft, newId, { frame: { x: 0, y: 0, width: 20, height: 10 } });
        arrowId = arrow.id;
        const shape = addShape(draft, newId, {
          shape: 'rect',
          frame: { x: 30, y: 0, width: 10, height: 10 },
        });
        groupId = addGroup(draft, newId, [arrow.id, shape.id])!.id;
      });

      const group = grouped.nodes[groupId]!;
      const resized = editDocument(grouped, (draft) => {
        resizeGroup(draft, groupId, {
          x: group.frame.x,
          y: group.frame.y,
          width: group.frame.width * 2,
          height: group.frame.height * 3,
        });
      });

      const before = grouped.nodes[arrowId]!;
      const after = resized.nodes[arrowId]!;
      if (before.type !== 'arrow' || after.type !== 'arrow') throw new Error('expected an arrow');
      const sx = after.frame.width / before.frame.width;
      const sy = after.frame.height / before.frame.height;
      for (const [i, p] of before.points.entries()) {
        expect(after.points[i]!.x).toBeCloseTo(p.x * sx, 6);
        expect(after.points[i]!.y).toBeCloseTo(p.y * sy, 6);
      }
    });

    it('scales a nested group correctly through two levels', () => {
      const { doc, newId } = imageDocument();
      let outerId = '';
      let shapeId = '';
      const grouped = editDocument(doc, (draft) => {
        const shape = addShape(draft, newId, { shape: 'rect', frame: { x: 0, y: 0, width: 10, height: 10 } });
        const other = addShape(draft, newId, {
          shape: 'ellipse',
          frame: { x: 20, y: 0, width: 10, height: 10 },
        });
        shapeId = shape.id;
        const innerId = addGroup(draft, newId, [shape.id, other.id])!.id;
        const third = addShape(draft, newId, { shape: 'rect', frame: { x: 60, y: 0, width: 10, height: 10 } });
        outerId = addGroup(draft, newId, [innerId, third.id])!.id;
      });

      const outer = grouped.nodes[outerId]!;
      const origin = { x: outer.frame.x, y: outer.frame.y };
      const before = absoluteFrame(grouped.nodes, shapeId)!;

      const resized = editDocument(grouped, (draft) => {
        resizeGroup(draft, outerId, {
          x: outer.frame.x,
          y: outer.frame.y,
          width: outer.frame.width * 3,
          height: outer.frame.height * 3,
        });
      });

      const after = absoluteFrame(resized.nodes, shapeId)!;
      // Scaled correctly through two nested levels with no accumulator
      // needed: absoluteFrame sums whatever depth of ancestors exist, both
      // before and after, so the diff is right regardless of nesting.
      expect(after.x - origin.x).toBeCloseTo((before.x - origin.x) * 3, 6);
      expect(after.width).toBeCloseTo(before.width * 3, 6);
    });

    it("keeps a panel's label beside it after its group resizes", () => {
      const { doc, newId } = sampleDocument();
      const panelOne = Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === 'One')!;
      const labelOne = Object.values(doc.nodes).find(
        (n) => n.type === 'panel-label' && n.panelId === panelOne.id,
      )!;
      const offset = { x: labelOne.frame.x - panelOne.frame.x, y: labelOne.frame.y - panelOne.frame.y };

      let groupId = '';
      const grouped = editDocument(doc, (draft) => {
        const shape = addShape(draft, newId, {
          shape: 'rect',
          frame: { x: 200, y: 0, width: 10, height: 10 },
        });
        groupId = addGroup(draft, newId, [panelOne.id, shape.id])!.id;
      });

      const group = grouped.nodes[groupId]!;
      const resized = editDocument(grouped, (draft) => {
        resizeGroup(draft, groupId, {
          x: group.frame.x + 15,
          y: group.frame.y + 8,
          width: group.frame.width * 1.5,
          height: group.frame.height * 1.5,
        });
      });

      const panelAbsAfter = absoluteFrame(resized.nodes, panelOne.id)!;
      const labelAfter = resized.nodes[labelOne.id]!;
      // The label keeps the same fixed offset from the panel's new absolute
      // position that it had before — it followed the panel through the
      // group's move-and-scale, rather than staying where it was.
      expect(labelAfter.frame.x).toBeCloseTo(panelAbsAfter.x + offset.x, 6);
      expect(labelAfter.frame.y).toBeCloseTo(panelAbsAfter.y + offset.y, 6);
    });

    it('leaves rotation and font size untouched', () => {
      const { doc, newId } = imageDocument();
      let groupId = '';
      let shapeId = '';
      let textId = '';
      const grouped = editDocument(doc, (draft) => {
        const shape = addShape(draft, newId, { shape: 'rect', frame: { x: 0, y: 0, width: 10, height: 10 } });
        shape.rotation = 45;
        shapeId = shape.id;
        const text = addText(draft, newId, {
          frame: { x: 30, y: 0, width: 20, height: 6 },
          text: 'Label',
          fontSizePt: 9,
        });
        textId = text.id;
        groupId = addGroup(draft, newId, [shape.id, text.id])!.id;
      });

      const group = grouped.nodes[groupId]!;
      const resized = editDocument(grouped, (draft) => {
        resizeGroup(draft, groupId, {
          x: group.frame.x,
          y: group.frame.y,
          width: group.frame.width * 2,
          height: group.frame.height * 2,
        });
      });

      expect(resized.nodes[shapeId]!.rotation).toBe(45);
      const text = resized.nodes[textId]!;
      if (text.type !== 'text') throw new Error('expected a text node');
      expect(text.style.fontSizePt).toBe(9);
    });
  });

  describe('panel-label sync on move', () => {
    /*
     * A panel-label is a top-level node with no parent of its own — moving a
     * panel (directly, or as part of a dragged group) does not move it
     * automatically the way `absoluteFrame` composes a *descendant's*
     * position for free. `snapshotPanelAbsolutePositions` /
     * `syncPanelLabelsFromSnapshot` are the two halves of the fix the
     * Canvas move commit uses; exercised directly here since there is no
     * Canvas.tsx test file in this codebase.
     */
    it('follows a plain panel dragged directly', () => {
      const { doc } = sampleDocument();
      const panelOne = Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === 'One')!;
      const labelOne = Object.values(doc.nodes).find(
        (n) => n.type === 'panel-label' && n.panelId === panelOne.id,
      )!;
      const offset = { x: labelOne.frame.x - panelOne.frame.x, y: labelOne.frame.y - panelOne.frame.y };

      const moved = editDocument(doc, (draft) => {
        const before = snapshotPanelAbsolutePositions(draft.nodes, panelOne.id);
        const panel = draft.nodes[panelOne.id]!;
        panel.frame = { ...panel.frame, x: panel.frame.x + 12, y: panel.frame.y - 5 };
        syncPanelLabelsFromSnapshot(draft, before);
      });

      const panelAbsAfter = absoluteFrame(moved.nodes, panelOne.id)!;
      const labelAfter = moved.nodes[labelOne.id]!;
      expect(labelAfter.frame.x).toBeCloseTo(panelAbsAfter.x + offset.x, 6);
      expect(labelAfter.frame.y).toBeCloseTo(panelAbsAfter.y + offset.y, 6);
    });

    it('follows a panel dragged as part of a group, leaving an unmoved sibling panel alone', () => {
      const { doc, newId } = sampleDocument();
      const panelOne = Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === 'One')!;
      const panelTwo = Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === 'Two')!;
      const labelTwo = Object.values(doc.nodes).find(
        (n) => n.type === 'panel-label' && n.panelId === panelTwo.id,
      )!;
      const labelTwoBefore = { ...labelTwo.frame };

      let groupId = '';
      const grouped = editDocument(doc, (draft) => {
        const shape = addShape(draft, newId, {
          shape: 'rect',
          frame: { x: 200, y: 0, width: 10, height: 10 },
        });
        groupId = addGroup(draft, newId, [panelOne.id, shape.id])!.id;
      });

      const moved = editDocument(grouped, (draft) => {
        const before = snapshotPanelAbsolutePositions(draft.nodes, groupId);
        const group = draft.nodes[groupId]!;
        group.frame = { ...group.frame, x: group.frame.x + 20, y: group.frame.y + 10 };
        syncPanelLabelsFromSnapshot(draft, before);
      });

      const labelOne = Object.values(moved.nodes).find(
        (n) => n.type === 'panel-label' && n.panelId === panelOne.id,
      )!;
      const panelOneAbsAfter = absoluteFrame(moved.nodes, panelOne.id)!;
      const offset = {
        x: Object.values(doc.nodes).find((n) => n.type === 'panel-label' && n.panelId === panelOne.id)!
          .frame.x - panelOne.frame.x,
        y: Object.values(doc.nodes).find((n) => n.type === 'panel-label' && n.panelId === panelOne.id)!
          .frame.y - panelOne.frame.y,
      };
      expect(labelOne.frame.x).toBeCloseTo(panelOneAbsAfter.x + offset.x, 6);
      expect(labelOne.frame.y).toBeCloseTo(panelOneAbsAfter.y + offset.y, 6);

      // Panel Two never moved, so its label must not have been touched.
      const labelTwoAfter = moved.nodes[labelTwo.id]!;
      expect(labelTwoAfter.frame).toEqual(labelTwoBefore);
    });
  });

  describe('align/distribute selection', () => {
    function threeShapes() {
      const { doc, newId } = imageDocument();
      const ids: string[] = [];
      const after = editDocument(doc, (draft) => {
        ids.push(addShape(draft, newId, { shape: 'rect', frame: { x: 10, y: 10, width: 20, height: 10 } }).id);
        ids.push(addShape(draft, newId, { shape: 'ellipse', frame: { x: 50, y: 30, width: 20, height: 10 } }).id);
        ids.push(addShape(draft, newId, { shape: 'rect', frame: { x: 90, y: 60, width: 20, height: 10 } }).id);
      });
      return { doc: after, ids, newId };
    }

    it('aligns nodes with different parents by their absolute position', () => {
      const { doc, ids, newId } = twoShapes();
      let groupId = '';
      let outsideId = '';
      const withGroup = editDocument(doc, (draft) => {
        groupId = addGroup(draft, newId, ids)!.id;
        outsideId = addShape(draft, newId, { shape: 'rect', frame: { x: 0, y: 0, width: 10, height: 10 } }).id;
      });

      const memberId = ids[0]!; // now parented under the group
      const groupOriginX = withGroup.nodes[groupId]!.frame.x;

      const aligned = editDocument(withGroup, (draft) => {
        alignSelection(draft, [memberId, outsideId], 'left');
      });

      // Both land at the selection's shared minimum x, in page-absolute
      // terms, even though one is nested inside a group and the other is
      // top-level.
      const expectedX = Math.min(absoluteFrame(withGroup.nodes, memberId)!.x, absoluteFrame(withGroup.nodes, outsideId)!.x);
      expect(absoluteFrame(aligned.nodes, memberId)!.x).toBeCloseTo(expectedX, 6);
      expect(absoluteFrame(aligned.nodes, outsideId)!.x).toBeCloseTo(expectedX, 6);
      // The group itself was not in the selection, so its own origin — and
      // therefore the member's local, parent-relative frame — moved by
      // exactly the same amount its absolute position did.
      expect(aligned.nodes[groupId]!.frame.x).toBeCloseTo(groupOriginX, 6);
    });

    it("carries a panel's label along when the panel itself is in the selection", () => {
      const { doc } = sampleDocument();
      const panelOne = Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === 'One')!;
      const panelTwo = Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === 'Two')!;
      // The two sample panels already share a top y — 'top' would be a
      // correct no-op and could pass even with a stale pre-move snapshot.
      // 'left' actually moves whichever panel isn't already the leftmost
      // (they differ in x), which is what exercises the label-sync path —
      // panelTwo starts to the right of panelOne, so panelTwo is the one
      // that moves.
      expect(panelTwo.frame.x).toBeGreaterThan(panelOne.frame.x);
      const labelTwo = Object.values(doc.nodes).find(
        (n) => n.type === 'panel-label' && n.panelId === panelTwo.id,
      )!;
      const offset = { x: labelTwo.frame.x - panelTwo.frame.x, y: labelTwo.frame.y - panelTwo.frame.y };

      const aligned = editDocument(doc, (draft) => {
        alignSelection(draft, [panelOne.id, panelTwo.id], 'left');
      });

      const panelTwoAbsAfter = absoluteFrame(aligned.nodes, panelTwo.id)!;
      const labelAfter = aligned.nodes[labelTwo.id]!;
      // The panel actually moved — otherwise this assertion would pass
      // trivially even if the label were never synced at all.
      expect(panelTwoAbsAfter.x).not.toBeCloseTo(panelTwo.frame.x, 3);
      expect(labelAfter.frame.x).toBeCloseTo(panelTwoAbsAfter.x + offset.x, 6);
      expect(labelAfter.frame.y).toBeCloseTo(panelTwoAbsAfter.y + offset.y, 6);
    });

    it('skips a locked node — excluded from both the bounding box and the move', () => {
      const { doc, ids } = threeShapes();
      const [lockedId, freeOneId, freeTwoId] = ids as [string, string, string];
      const lockedBefore = { ...doc.nodes[lockedId]!.frame };

      const locked = editDocument(doc, (draft) => {
        draft.nodes[lockedId]!.locked = true;
      });

      const aligned = editDocument(locked, (draft) => {
        alignSelection(draft, [lockedId, freeOneId, freeTwoId], 'left');
      });

      expect(aligned.nodes[lockedId]!.frame).toEqual(lockedBefore);
      // The bounding box the two free shapes aligned to came from just the
      // two of them — the locked shape's far-left x never entered it.
      const expectedX = Math.min(locked.nodes[freeOneId]!.frame.x, locked.nodes[freeTwoId]!.frame.x);
      expect(aligned.nodes[freeOneId]!.frame.x).toBeCloseTo(expectedX, 6);
      expect(aligned.nodes[freeTwoId]!.frame.x).toBeCloseTo(expectedX, 6);
    });

    it('skips brackets and scale bars — their positions are owned elsewhere', () => {
      const { doc, ids, newId, image } = (() => {
        const base = imageDocument();
        const shapeIds: string[] = [];
        const withShapes = editDocument(base.doc, (draft) => {
          shapeIds.push(
            addShape(draft, base.newId, { shape: 'rect', frame: { x: 10, y: 10, width: 20, height: 10 } }).id,
          );
          shapeIds.push(
            addShape(draft, base.newId, { shape: 'ellipse', frame: { x: 50, y: 30, width: 20, height: 10 } }).id,
          );
        });
        return { doc: withShapes, ids: shapeIds, newId: base.newId, image: base.image };
      })();

      let barId = '';
      const withBar = editDocument(doc, (draft) => {
        const bar = addScaleBar(draft, newId, {
          imageId: image.id,
          length: 10,
          pixelsPerUnit: 10,
          unitLabel: 'µm',
          calibrationSource: 'manual',
        });
        barId = bar!.id;

        const bracket: BracketNode = {
          id: 'test-bracket',
          name: 'Test bracket',
          parentId: null,
          layerId: 'Statistics',
          frame: { x: 5, y: 5, width: 15, height: 4 },
          rotation: 0,
          opacity: 1,
          locked: false,
          hidden: false,
          z: 0,
          type: 'bracket',
          analysisId: null,
          label: 'ns',
          style: {},
          stroke: { color: '#000000', widthMm: 0.18 },
          tickMm: 1.2,
        };
        draft.nodes[bracket.id] = bracket;
      });

      const barBefore = { ...withBar.nodes[barId]!.frame };
      const bracketBefore = { ...withBar.nodes['test-bracket']!.frame };

      const aligned = editDocument(withBar, (draft) => {
        alignSelection(draft, [ids[0]!, ids[1]!, barId, 'test-bracket'], 'left');
      });

      // The two shapes moved (their shared min-x is 10, not both already there).
      expect(aligned.nodes[ids[0]!]!.frame.x).toBeCloseTo(10, 6);
      expect(aligned.nodes[ids[1]!]!.frame.x).toBeCloseTo(10, 6);
      // Neither the scale bar nor the bracket did.
      expect(aligned.nodes[barId]!.frame).toEqual(barBefore);
      expect(aligned.nodes['test-bracket']!.frame).toEqual(bracketBefore);
    });

    it('does not double-move a member when its own group is also selected', () => {
      const { doc, ids, newId } = twoShapes();
      let groupId = '';
      const withGroup = editDocument(doc, (draft) => {
        groupId = addGroup(draft, newId, ids)!.id;
      });
      const memberId = ids[0]!;

      const groupAbsBefore = absoluteFrame(withGroup.nodes, groupId)!;
      const memberAbsBefore = absoluteFrame(withGroup.nodes, memberId)!;
      const expectedX = Math.min(groupAbsBefore.x, memberAbsBefore.x);

      const aligned = editDocument(withGroup, (draft) => {
        alignSelection(draft, [groupId, memberId], 'left');
      });

      // Each was aligned from its own pre-mutation absolute position, not
      // re-read after the other had already moved — otherwise the member,
      // riding along with its already-shifted group, would land past
      // `expectedX` a second time.
      expect(absoluteFrame(aligned.nodes, groupId)!.x).toBeCloseTo(expectedX, 6);
      expect(absoluteFrame(aligned.nodes, memberId)!.x).toBeCloseTo(expectedX, 6);
    });

    it('distributes three or more objects with equal gaps, and leaves fewer than three untouched', () => {
      const { doc, ids } = threeShapes();

      const distributed = editDocument(doc, (draft) => {
        distributeSelection(draft, ids, 'x');
      });

      const xs = ids.map((id) => distributed.nodes[id]!.frame.x).sort((a, b) => a - b);
      const widths = ids.map((id) => distributed.nodes[id]!.frame.width);
      const gap1 = xs[1]! - (xs[0]! + widths[0]!);
      const gap2 = xs[2]! - (xs[1]! + widths[1]!);
      expect(gap1).toBeCloseTo(gap2, 6);

      const twoOnly = editDocument(doc, (draft) => {
        distributeSelection(draft, [ids[0]!, ids[1]!], 'x');
      });
      expect(twoOnly.nodes[ids[0]!]!.frame).toEqual(doc.nodes[ids[0]!]!.frame);
      expect(twoOnly.nodes[ids[1]!]!.frame).toEqual(doc.nodes[ids[1]!]!.frame);
    });
  });
});

// ---------------------------------------------------------------------------
// Store / undo
// ---------------------------------------------------------------------------

describe('document store', () => {
  it('undoes and redoes an edit', () => {
    const store = new DocumentStore(createDocument({ title: 'A' }));
    store.commit('Rename', (draft) => {
      draft.title = 'B';
    });

    expect(store.getDocument().title).toBe('B');
    store.undo();
    expect(store.getDocument().title).toBe('A');
    store.redo();
    expect(store.getDocument().title).toBe('B');
  });

  it('ignores a recipe that changes nothing', () => {
    const store = new DocumentStore(createDocument({ title: 'A' }));
    const commit = store.commit('No-op', (draft) => {
      draft.title = 'A';
    });
    // A no-op must not consume an undo slot the user then has to press through.
    expect(commit).toBeNull();
    expect(store.canUndo()).toBe(false);
  });

  it('collapses a transaction into a single undo step', () => {
    const store = new DocumentStore(createDocument({ title: 'A' }));
    store.transaction('Batch', () => {
      store.commit('one', (draft) => {
        draft.title = 'B';
      });
      store.commit('two', (draft) => {
        draft.page.heightMm = 200;
      });
    });

    expect(store.history()).toHaveLength(1);
    store.undo();
    expect(store.getDocument().title).toBe('A');
    expect(store.getDocument().page.heightMm).toBe(120);
  });

  it('discards the redo branch after a new edit', () => {
    const store = new DocumentStore(createDocument({ title: 'A' }));
    store.commit('one', (draft) => {
      draft.title = 'B';
    });
    store.undo();
    store.commit('two', (draft) => {
      draft.title = 'C';
    });
    expect(store.canRedo()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

describe('.figureforge archive', () => {
  it('round-trips a document without loss', () => {
    const { doc } = sampleDocument();
    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);

    expect(loaded.document).toEqual(doc);
    expect(loaded.manifest.format).toBe('figureforge');
  });

  // The extension is a filesystem affordance only — the archive is identified
  // by its MANIFEST marker, never by a name, so shortening it changes nothing
  // about what a save/load round trip produces.
  it('writes the short .ffg extension and still reads the legacy long form', () => {
    expect(ARCHIVE_EXTENSION).toBe('.ffg');
    expect(LEGACY_ARCHIVE_EXTENSION).toBe('.figureforge');
    expect(ARCHIVE_EXTENSIONS).toEqual(['.ffg', '.figureforge']);
    expect(ARCHIVE_FILE_TYPE.accept[ARCHIVE_MIME]).toEqual(['.ffg', '.figureforge']);

    const { doc } = sampleDocument();
    const bytes = saveArchive(buildArchiveContents(doc));
    // A save has no filename in it at all; the manifest marker is the only
    // thing `loadArchive` checks. Renaming the file this came from — the
    // scenario a `.figureforge` project being opened after the switch models
    // — cannot affect what unzips.
    const loaded = loadArchive(bytes);
    expect(loaded.manifest.format).toBe('figureforge');
  });

  it('round-trips a non-zero rotation on an annotation', () => {
    /*
     * `rotation` has been on `NodeBase` and in the schema since phase 1, but
     * nothing ever set it to anything but 0 — so nothing proved it survives a
     * save. It does not need a `SCHEMA_VERSION` bump for exactly that reason,
     * and this is what makes that claim checkable rather than asserted.
     */
    const { doc } = sampleDocument();
    const rotated = editDocument(doc, (draft) => {
      const shape = addShape(draft, createIdFactory(), {
        shape: 'rect',
        frame: { x: 10, y: 10, width: 20, height: 12 },
      });
      draft.nodes[shape.id]!.rotation = 37.5;
    });

    const loaded = loadArchive(saveArchive(buildArchiveContents(rotated)));
    const shape = Object.values(loaded.document.nodes).find((n) => n.type === 'shape');
    expect(shape?.rotation).toBe(37.5);
    // And the untouched nodes still carry the default, so the field did not
    // become something every node now has to opt out of.
    const panels = Object.values(loaded.document.nodes).filter((n) => n.type === 'panel');
    expect(panels.every((p) => p.rotation === 0)).toBe(true);
  });

  it('round-trips a volcano plot with its new optional fields', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,log2FC,p\nTP53,2.1,0.001\nMYC,-1.8,0.02', newId()),
        format: 'differential',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Volcano',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'volcano';
        plotNode.volcanoThresholds = { foldChange: 1.5, pValue: 0.01 };
        plotNode.volcanoColors = { down: '#111111', ns: '#222222', up: '#333333' };
        plotNode.volcanoThresholdLines = 'hide';
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips a hollow marker fill and an explicit none outline', () => {
    /*
     * `pointStroke` gained a `'none'` union member; zod strips a key present
     * only on the TS type, and an unexercised schema branch is the same risk
     * from the far side — delete `z.literal('none')` and this fails.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const doc = editDocument(base, (draft) => {
      const ds = dataset('Dose,Response\n1,2\n2,4\n3,6', newId());
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Scatter',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'scatter';
        plotNode.pointFill = 'none';
        plotNode.pointStroke = 'none';
      }
    });
    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips a dragged legend position', () => {
    // `legendOffsetMm` is a new optional object field; a missing `schema.ts`
    // line drops it on save and the key snaps back on the next open.
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const doc = editDocument(base, (draft) => {
      const ds = dataset('X1,Y1,X2,Y2\n1,2,1,3\n2,4,2,5', newId());
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Line',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'line';
        plotNode.legendOffsetMm = { x: 12.5, y: -8 };
      }
    });
    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips a fold-fold plot with all five of its new fields', () => {
    /*
     * zod strips a key present only on the TS type, so a round-trip is the
     * check that matters — a missing `schema.ts` line would drop the field on
     * save and the figure would open with its colours and cutoffs reset.
     * Every one of the five is set to a non-default, or a dropped field could
     * pass by coinciding with what the renderer would have used anyway.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,97Q/25Q,97Q/APEX\nTP53,2.1,1.7\nMYC,-1.8,-2.4', newId()),
        format: 'fold-fold',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Fold vs fold',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'fold-fold';
        plotNode.foldFoldThresholds = { x: 1.5, y: 0.75, rule: 'either' };
        plotNode.foldFoldColorBy = 'quadrant';
        plotNode.foldFoldColors = {
          ns: '#111111',
          sig: '#222222',
          'up-up': '#333333',
          'down-down': '#444444',
          'up-down': '#555555',
          'down-up': '#666666',
        };
        plotNode.foldFoldZeroLines = 'hide';
        plotNode.foldFoldCutoffLines = 'show';
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips a distribution figure: the ecdf plot type and all three histogram fields', () => {
    /*
     * The two halves of round 50's schema surface, checked together because
     * they fail the same way and only a round trip can see it: zod strips a
     * key present only on the TS type, and it validates `plotType` against an
     * enum, so a missing member would make the *whole document* refuse to
     * load rather than merely losing a setting.
     *
     * Two plots, because the two cases are genuinely different. The ECDF
     * exercises the widened enum and the per-series `lineStyles` that are its
     * only non-colour way to tell samples apart; the histogram carries all
     * three `histogram*` fields at once, each set to a non-default so a
     * dropped one cannot pass by coinciding with what the renderer would have
     * chosen anyway.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Y1,Y2\n1.0,3.0\n1.4,3.6\n1.8,4.1', newId()),
        format: 'distribution',
      };
      draft.datasets = [ds];

      const { plot: hist } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Histogram',
        plotType: 'histogram',
      });
      const histNode = draft.nodes[hist.id];
      if (histNode?.type === 'plot') {
        histNode.histogramStyle = 'step';
        histNode.histogramCumulative = true;
        histNode.histogramNormalize = 'frequency';
        histNode.histogramBins = 7;
      }

      const { plot: curve } = addPanelWithPlot(draft, newId, {
        frame: { x: 90, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'ECDF',
        plotType: 'ecdf',
      });
      const curveNode = draft.nodes[curve.id];
      if (curveNode?.type === 'plot') {
        curveNode.lineStyles = ['solid', 'dashed'];
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips a proteomics dataset and its derivedFrom link', () => {
    /*
     * Both are optional additions, so `SCHEMA_VERSION` stays 1 — and zod
     * strips a key present only on the TS type, which is what makes a
     * round-trip the check that matters rather than a type assertion.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const source: Dataset = {
        ...dataset('Protein,C1,C2,T1,T2\nP1,1,2,8,9\nP2,3,4,3,4', newId()),
        format: 'proteomics',
      };
      const derived: Dataset = {
        ...dataset('Feature,log2FoldChange,pValue,qValue\nP1,3,0.001,0.01', newId()),
        format: 'differential',
        derivedFrom: { datasetId: source.id, kind: 'volcano-test' },
      };
      draft.datasets = [source, derived];
    });

    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);
    expect(loaded.document.datasets[0]!.format).toBe('proteomics');
    expect(loaded.document.datasets[1]!.derivedFrom).toEqual({
      datasetId: doc.datasets[0]!.id,
      kind: 'volcano-test',
    });
  });

  it('reads a proteomics table exactly as it reads a replicate one', () => {
    /*
     * The two layouts are structurally identical on purpose — what separates
     * them is which tests apply, decided in the Stats tab, not here. If the
     * generic reading ever diverges, every consumer of `toSeries` starts
     * seeing two different tables where the author declared one shape.
     */
    const csv = 'Protein,C1,C2,T1\nP1,1,2,8\nP2,3,4,5';
    const newId = createIdFactory();
    const asReplicate: Dataset = { ...dataset(csv, newId()), format: 'replicate' };
    const asProteomics: Dataset = { ...dataset(csv, newId()), format: 'proteomics' };
    expect(toSeries(asProteomics)).toEqual(toSeries(asReplicate));
    expect(toSeries(asProteomics).map((s) => s.name)).toEqual(['P1', 'P2']);
  });

  it('never infers the proteomics layout from the numbers alone', () => {
    // Nothing at the cell level separates it from an ordinary replicate
    // table — which is exactly why declaring it is what gates the volcano
    // test, and why a plain paste must never land on it by accident.
    const columns = dataset('Protein,C1,C2,T1,T2\nP1,1,2,8,9\nP2,3,4,5,6', createIdFactory()())
      .columns;
    expect(inferFormat(columns)).not.toBe('proteomics');
  });

  it('round-trips the volcano test record, including both cutoffs', () => {
    /*
     * Optional, so `SCHEMA_VERSION` stays 1 — and zod strips a key present
     * only on the TS type, so a round-trip is the check that matters. Both
     * cutoffs specifically: they are stored separately because SAM resolves
     * each tail independently and they are not mirror images, so a schema
     * that kept only one magnitude would quietly lose half the record.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const record = {
      s0: 0.5,
      fdrPercent: 5,
      fdrAchieved: 0.032,
      deltaUsed: 0.5587,
      cutUp: 0.5306,
      cutLow: -1.0644,
      mode: 'two-sample' as const,
      nTested: 100,
      nUp: 59,
      nDown: 24,
      methodsSentence: 'Differential abundance was assessed by a SAM permutation test.',
    };

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,log2FC,p,fdr\nTP53,2.1,0.001,0.01', newId()),
        format: 'differential',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Volcano',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'volcano';
        plotNode.volcanoTest = record;
      }
    });

    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' ? plot.volcanoTest : undefined).toEqual(record);
  });

  it('round-trips FDR thresholds, volcanoPValueIsNegLog10 and volcanoSamCurve', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,log2FC,p,fdr\nTP53,2.1,0.001,0.01', newId()),
        format: 'differential',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Volcano',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'volcano';
        plotNode.volcanoThresholds = {
          foldChange: 1,
          pValue: 0.05,
          fdr: 0.02,
          significanceBy: 'fdr',
        };
        plotNode.volcanoPValueIsNegLog10 = true;
        plotNode.volcanoSamCurve = {
          up: [{ x: 1, y: 2 }],
          down: [{ x: -1, y: 2 }],
        };
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('leaves the new volcano fields absent when never set', () => {
    // A figure whose author never touched FDR/curve/representation fields
    // must still round-trip byte-identically — otherwise every existing
    // saved volcano plot would gain fields on its next open.
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,log2FC,p\nTP53,2.1,0.001', newId()),
        format: 'differential',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Volcano',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') plotNode.plotType = 'volcano';
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
    for (const node of Object.values(loaded.document.nodes)) {
      if (node.type !== 'plot') continue;
      expect(node.volcanoPValueIsNegLog10).toBeUndefined();
      expect(node.volcanoSamCurve).toBeUndefined();
      expect(node.volcanoThresholds?.fdr).toBeUndefined();
      expect(node.volcanoThresholds?.significanceBy).toBeUndefined();
    }
  });

  it('round-trips volcanoLabels, with no cap enforced at the schema layer', () => {
    // Deliberately not `.max(25)` in schema.ts — a hand-edited file with more
    // than the UI's cap must still load, or `loadArchive`'s validation would
    // make it unopenable. The cap is enforced in the UI and by
    // `layoutPointLabels`'s own truncation, not here.
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,log2FC,p\nTP53,2.1,0.001\nMYC,-1.8,0.02', newId()),
        format: 'differential',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Volcano',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'volcano';
        plotNode.volcanoLabels = Array.from({ length: 30 }, (_, i) => `Gene${i}`);
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.volcanoLabels).toHaveLength(30);
  });

  it('round-trips pointLabelOffsets and pointLabelSizePt, absent when never set', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,log2FC,p\nTP53,2.1,0.001\nMYC,-1.8,0.02', newId()),
        format: 'differential',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Volcano',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'volcano';
        plotNode.volcanoLabels = ['TP53'];
        plotNode.pointLabelOffsets = { TP53: { x: 3.5, y: -2 } };
        plotNode.pointLabelSizePt = 7;
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.pointLabelOffsets).toEqual({ TP53: { x: 3.5, y: -2 } });
    expect(plot?.type === 'plot' && plot.pointLabelSizePt).toBe(7);

    // An older archive without either field loads with both undefined.
    const untouched = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,log2FC,p\nTP53,2.1,0.001', newId()),
        format: 'differential',
      };
      draft.datasets = [ds];
      const { plot: p } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Volcano',
      });
      const plotNode = draft.nodes[p.id];
      if (plotNode?.type === 'plot') plotNode.plotType = 'volcano';
    });
    const loadedUntouched = loadArchive(saveArchive(buildArchiveContents(untouched)));
    const untouchedPlot = Object.values(loadedUntouched.document.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && 'pointLabelOffsets' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'pointLabelSizePt' in untouchedPlot).toBe(false);
  });

  it('round-trips pointLabelLimit, including a value past the ceiling', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const build = (limit: number | undefined): FigureDocument =>
      editDocument(base, (draft) => {
        const ds: Dataset = {
          ...dataset('Gene,log2FC,p\nTP53,2.1,0.001\nMYC,-1.8,0.02', newId()),
          format: 'differential',
        };
        draft.datasets = [ds];
        const { plot } = addPanelWithPlot(draft, newId, {
          frame: { x: 0, y: 0, width: 80, height: 60 },
          datasetId: ds.id,
          name: 'Volcano',
        });
        const plotNode = draft.nodes[plot.id];
        if (plotNode?.type === 'plot') {
          plotNode.plotType = 'volcano';
          if (limit !== undefined) plotNode.pointLabelLimit = limit;
        }
      });

    const doc = build(60);
    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.pointLabelLimit).toBe(60);

    // The schema carries no `.max()` on purpose: `loadArchive` throws on a
    // validation failure, so a bound here would make a hand-edited file
    // UNOPENABLE rather than merely over-ambitious. The ceiling is applied
    // when the value is read, by `pointLabelLimit()` in packages/render.
    const ambitious = build(100000);
    const loadedAmbitious = loadArchive(saveArchive(buildArchiveContents(ambitious)));
    const ambitiousPlot = Object.values(loadedAmbitious.document.nodes).find((n) => n.type === 'plot');
    expect(ambitiousPlot?.type === 'plot' && ambitiousPlot.pointLabelLimit).toBe(100000);

    // An archive written before the field existed loads with it absent, which
    // is what makes 25 keep being the default for every figure already saved.
    const untouched = build(undefined);
    const loadedUntouched = loadArchive(saveArchive(buildArchiveContents(untouched)));
    const untouchedPlot = Object.values(loadedUntouched.document.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && 'pointLabelLimit' in untouchedPlot).toBe(false);
  });

  it("round-trips an axis's labelFormat/labelDecimals, and leaves both absent when never set", () => {
    // The same schema trap as `orientation`: a field on the TS type but not in
    // schema.ts is silently dropped by zod on save.
    const { doc } = sampleDocument();
    const formatted = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') {
          node.y.labelFormat = 'scientific';
          node.y.labelDecimals = 2;
        }
      }
    });

    const bytes = saveArchive(buildArchiveContents(formatted));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(formatted);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.y.labelFormat).toBe('scientific');
    expect(plot?.type === 'plot' && plot.y.labelDecimals).toBe(2);

    // Unset stays absent, not defaulted to 'auto' by the schema — otherwise a
    // figure saved before this feature existed would gain a new key on open.
    const untouchedPlot = Object.values(doc.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && untouchedPlot.y.labelFormat).toBeUndefined();
  });

  it("round-trips a symlog axis's scale and linthresh, and leaves linthresh absent when never set", () => {
    const { doc } = sampleDocument();
    const symlog = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') {
          node.y.scale = 'symlog';
          node.y.linthresh = 50;
        }
      }
    });

    const bytes = saveArchive(buildArchiveContents(symlog));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(symlog);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.y.scale).toBe('symlog');
    expect(plot?.type === 'plot' && plot.y.linthresh).toBe(50);

    const untouchedPlot = Object.values(doc.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && untouchedPlot.y.linthresh).toBeUndefined();
  });

  it("round-trips an axis's clipToRange, and leaves it absent when never set", () => {
    const { doc } = sampleDocument();
    const clipped = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') {
          node.x.max = 10;
          node.x.clipToRange = true;
        }
      }
    });

    const bytes = saveArchive(buildArchiveContents(clipped));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(clipped);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.x.clipToRange).toBe(true);

    const untouchedPlot = Object.values(doc.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && untouchedPlot.x.clipToRange).toBeUndefined();
  });

  it('round-trips a horizontal plot, and leaves orientation absent when never set', () => {
    // The schema trap this project keeps hitting: zod strips an undeclared
    // optional key on save, so a field present only on the TS type is
    // silently dropped. This is the regression guard for `orientation`.
    const { doc } = sampleDocument();
    const horizontal = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') node.orientation = 'horizontal';
      }
    });

    const bytes = saveArchive(buildArchiveContents(horizontal));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(horizontal);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.orientation).toBe('horizontal');

    // A document that never touched orientation round-trips with the field
    // absent, not defaulted to `'vertical'` — the same "absent means the
    // default" convention every other optional field in this file holds to.
    const untouchedLoaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    const untouchedPlot = Object.values(untouchedLoaded.document.nodes).find(
      (n) => n.type === 'plot',
    );
    expect(untouchedPlot?.type === 'plot' && 'orientation' in untouchedPlot).toBe(false);
  });

  it('round-trips a line plot with lineStyle/lineStyles, and leaves them absent when never set', () => {
    // The same schema trap `orientation`'s own regression guard exists for:
    // zod strips an undeclared optional key on save, so a field present only
    // on the TS type is silently dropped.
    const { doc } = sampleDocument();
    const styled = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') {
          node.plotType = 'line';
          node.lineStyle = 'dash-dot';
          node.lineStyles = ['dashed', null, 'dotted'];
        }
      }
    });

    const bytes = saveArchive(buildArchiveContents(styled));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(styled);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.lineStyle).toBe('dash-dot');
    expect(plot?.type === 'plot' && plot.lineStyles).toEqual(['dashed', null, 'dotted']);

    // A document that never touched line style round-trips with both fields
    // absent, not defaulted to `'solid'` — the same "absent means the
    // default" convention every other optional field in this file holds to.
    const untouchedLoaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    const untouchedPlot = Object.values(untouchedLoaded.document.nodes).find(
      (n) => n.type === 'plot',
    );
    expect(untouchedPlot?.type === 'plot' && 'lineStyle' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'lineStyles' in untouchedPlot).toBe(false);
  });

  it('round-trips a heatmap plot with its new optional fields', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Gene,S1,S2\nTP53,1.2,-0.5\nMYC,2.1,1.9', newId()),
        format: 'matrix',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Heatmap',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'heatmap';
        plotNode.heatmapScale = 'diverging';
        plotNode.heatmapStops = ['#111111', '#ffffff', '#333333'];
        plotNode.heatmapMissingColor = '#cccccc';
        plotNode.showCellValues = true;
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips a survival plot with its new optional fields', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Time,Event,Arm\n5,1,A\n8,0,B', newId()),
        format: 'survival',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Survival',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'survival';
        plotNode.showCensorMarks = false;
        plotNode.showSurvivalCI = true;
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips a cascaded line plot with its new optional fields', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('X1\tY1\tX2\tY2\n1\t2\t1\t2\n2\t4\t2\t4', newId()),
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Cascade',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'line';
        plotNode.offsetStepMm = 10;
        plotNode.offsetStepXMm = 2;
        plotNode.offsetFill = 'tint';
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips reverseLegend, absent when never set', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X1\tY1\tX2\tY2\n1\t2\t1\t2\n2\t4\t2\t4', newId()) };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Lines',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'line';
        plotNode.reverseLegend = false;
      }
    });

    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.reverseLegend).toBe(false);

    const untouched = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X1\tY1\tX2\tY2\n1\t2\t1\t2', newId()) };
      draft.datasets = [ds];
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Plain',
      });
    });
    const reloaded = loadArchive(saveArchive(buildArchiveContents(untouched)));
    const untouchedPlot = Object.values(reloaded.document.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && 'reverseLegend' in untouchedPlot).toBe(false);
  });

  it('round-trips showCascadeAxis/cascadeAxisTitle, absent when never set', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('X1\tY1\tX2\tY2\n1\t2\t1\t2\n2\t4\t2\t4', newId()),
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Cascade',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'line';
        plotNode.offsetStepMm = 10;
        plotNode.showCascadeAxis = true;
        plotNode.cascadeAxisTitle = 'Concentration (mg/mL)';
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.showCascadeAxis).toBe(true);
    expect(plot?.type === 'plot' && plot.cascadeAxisTitle).toBe('Concentration (mg/mL)');

    // An older cascade figure without either field loads with both absent,
    // and hasCascadeOffset (offsetStepMm alone) is unaffected.
    const untouched = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X1\tY1\tX2\tY2\n1\t2\t1\t2', newId()) };
      draft.datasets = [ds];
      const { plot: p } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Cascade',
      });
      const plotNode = draft.nodes[p.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'line';
        plotNode.offsetStepMm = 5;
      }
    });
    const loadedUntouched = loadArchive(saveArchive(buildArchiveContents(untouched)));
    const untouchedPlot = Object.values(loadedUntouched.document.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && 'showCascadeAxis' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'cascadeAxisTitle' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && untouchedPlot.offsetStepMm).toBe(5);
  });

  it("round-trips an axis's richText and a plot's cascadeAxisTitleRichText, absent when never set", () => {
    // Round 24's extension of round 23's TextNode.richText onto axis titles.
    // The same schema trap every optional-field test in this file guards
    // against: zod strips an undeclared key on save, so a field present only
    // on the TS type is silently dropped.
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const yTitleRuns: TextRun[] = [{ text: 'Fold change (log' }, { text: '2', script: 'sub' }, { text: ')' }];
    const captionRuns: TextRun[] = [{ text: 'Concentration ' }, { text: '(mg/mL)', italic: true }];

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X1\tY1\tX2\tY2\n1\t2\t1\t2\n2\t4\t2\t4', newId()) };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Cascade',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'line';
        plotNode.y.title = 'Fold change (log2)';
        plotNode.y.richText = yTitleRuns;
        plotNode.offsetStepMm = 10;
        plotNode.showCascadeAxis = true;
        plotNode.cascadeAxisTitle = 'Concentration (mg/mL)';
        plotNode.cascadeAxisTitleRichText = captionRuns;
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.y.richText).toEqual(yTitleRuns);
    expect(plot?.type === 'plot' && plot.cascadeAxisTitleRichText).toEqual(captionRuns);

    // An older figure that never touched either field loads with both
    // absent, not defaulted to an empty array.
    const untouched = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X1\tY1\tX2\tY2\n1\t2\t1\t2', newId()) };
      draft.datasets = [ds];
      const { plot: p } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Cascade',
      });
      const plotNode = draft.nodes[p.id];
      if (plotNode?.type === 'plot') plotNode.plotType = 'line';
    });
    const loadedUntouched = loadArchive(saveArchive(buildArchiveContents(untouched)));
    const untouchedPlot = Object.values(loadedUntouched.document.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && 'richText' in untouchedPlot.y).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'cascadeAxisTitleRichText' in untouchedPlot).toBe(false);
  });

  it('round-trips boxed/showGridlines/gridlineColor/gridlineStyle, absent when never set', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X\tY\n1\t2\n2\t4\n3\t6', newId()) };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Boxed',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'scatter';
        plotNode.boxed = true;
        plotNode.showGridlines = true;
        plotNode.gridlineColor = 'black';
        plotNode.gridlineStyle = 'dotted';
      }
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.boxed).toBe(true);
    expect(plot?.type === 'plot' && plot.showGridlines).toBe(true);
    expect(plot?.type === 'plot' && plot.gridlineColor).toBe('black');
    expect(plot?.type === 'plot' && plot.gridlineStyle).toBe('dotted');

    const untouched = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X\tY\n1\t2\n2\t4', newId()) };
      draft.datasets = [ds];
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Boxed',
      });
    });
    const loadedUntouched = loadArchive(saveArchive(buildArchiveContents(untouched)));
    const untouchedPlot = Object.values(loadedUntouched.document.nodes).find((n) => n.type === 'plot');
    expect(untouchedPlot?.type === 'plot' && 'boxed' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'showGridlines' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'gridlineColor' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'gridlineStyle' in untouchedPlot).toBe(false);
  });

  it("round-trips a bracketed p-value on both a comparison and its omnibus", () => {
    /*
     * Anderson–Darling is the one test here whose p-value is a bracket rather
     * than a number: SciPy interpolates it from a published table and clamps
     * the result to [0.001, 0.25]. `pBound` is what carries that fact, and
     * zod strips any key the schema does not name — so without its two schema
     * lines a saved result would reopen reporting the clamp as a point value,
     * turning "P > 0.25" into a confident "P = 0.250".
     *
     * Both places are set, and to *different* bounds, because they are two
     * separate schema entries: one covering the other would leave the missing
     * half silently passing.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('Y1\tY2\n1\t5\n2\t6\n3\t7', newId()), format: 'distribution' };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Distributions',
        plotType: 'histogram',
      });
      draft.analyses = [
        {
          id: newId(),
          name: 'Y1 vs Y2',
          test: 'anderson-darling',
          spec: { datasetId: ds.id, groups: ['Y1', 'Y2'] },
          plotId: plot.id,
          options: { alternative: 'two-sided', correction: 'none', alpha: 0.05, welch: true },
          inputHash: 'hash',
          result: {
            test: 'anderson-darling',
            omnibus: { statistic: 7.81, p: 0.001, df: null, pBound: 'below' },
            comparisons: [
              {
                groupA: 'Y1',
                groupB: 'Y2',
                statistic: -1.15,
                p: 0.25,
                pAdjusted: 0.25,
                df: null,
                ci: null,
                effectSize: null,
                effectSizeName: null,
                n: [3, 3],
                pBound: 'above',
              },
            ],
            methodsSentence: 'A²k = 7.81, P < 0.001.',
            warnings: [],
            softwareVersions: { scipy: '1.15.0' },
          },
          computedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
    });

    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);
    expect(loaded.document.analyses[0]?.result?.omnibus?.pBound).toBe('below');
    expect(loaded.document.analyses[0]?.result?.comparisons[0]?.pBound).toBe('above');
  });

  it("round-trips the KS gap's location and sign, and an explicit marker off", () => {
    /*
     * The three fields the ECDF's gap marker is drawn from. All three are
     * post-SCHEMA_VERSION-1 and therefore optional, which is exactly why each
     * needs its own schema line and its own assertion: zod strips whatever it
     * is not told about, so a missing line would show up only as a saved
     * figure reopening without the marker it was drawing when it was saved.
     *
     * `ksGapMarker` is set to `false` deliberately. It is the one optional
     * field here whose *absent* reading is on, so `true` would survive a
     * stripped schema line by accident and prove nothing.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        ...dataset('Y1\tY2\n1\t5\n2\t6\n3\t7', newId()),
        format: 'distribution',
      };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Distributions',
        plotType: 'ecdf',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') plotNode.ksGapMarker = false;
      draft.analyses = [
        {
          id: newId(),
          name: 'Y1 vs Y2',
          test: 'kolmogorov-smirnov',
          spec: { datasetId: ds.id, groups: ['Y1', 'Y2'] },
          plotId: plot.id,
          options: { alternative: 'two-sided', correction: 'none', alpha: 0.05, welch: true },
          inputHash: 'hash',
          result: {
            test: 'kolmogorov-smirnov',
            omnibus: null,
            comparisons: [
              {
                groupA: 'Y1',
                groupB: 'Y2',
                statistic: 1,
                p: 0.1,
                pAdjusted: 0.1,
                df: null,
                ci: null,
                effectSize: null,
                effectSizeName: null,
                n: [3, 3],
                // A negative sign as well as a non-zero location: a schema
                // line that dropped the sign would leave a marker that could
                // be drawn the wrong way up with nothing to say so.
                statisticLocation: 3,
                statisticSign: -1,
              },
            ],
            methodsSentence: 'D = 1.000, P = 0.100.',
            warnings: [],
            softwareVersions: { scipy: '1.15.0' },
          },
          computedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
    });

    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);
    const comparison = loaded.document.analyses[0]?.result?.comparisons[0];
    expect(comparison?.statisticLocation).toBe(3);
    expect(comparison?.statisticSign).toBe(-1);
    const reloaded = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(reloaded?.type === 'plot' && reloaded.ksGapMarker).toBe(false);
  });

  it('round-trips the fitted-line fields and the analysis fit, absent when never set', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X\tY\n1\t2\n2\t4\n3\t6', newId()) };
      draft.datasets = [ds];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Fit',
      });
      const plotNode = draft.nodes[plot.id];
      if (plotNode?.type === 'plot') {
        plotNode.plotType = 'scatter';
        plotNode.trendLine = 'hide';
        plotNode.trendInterval = 'prediction';
        plotNode.trendExtent = 'axis';
      }
      draft.analyses = [
        {
          id: newId(),
          name: 'X vs Y',
          test: 'linear-regression',
          spec: { datasetId: ds.id, groups: ['Y'] },
          plotId: plot.id,
          options: { alternative: 'two-sided', correction: 'none', alpha: 0.05, welch: true },
          inputHash: 'hash',
          result: {
            test: 'linear-regression',
            omnibus: null,
            comparisons: [],
            // Every term matters: the band is unusable if any one is dropped,
            // which a `toEqual` on the whole document would not localise.
            fit: {
              slope: 2,
              intercept: 0.5,
              n: 3,
              meanX: 2,
              sumSquaredDevX: 2,
              residualSe: 0.25,
              tMultiplier: 12.706,
              confidenceLevel: 0.95,
              xMin: 1,
              xMax: 3,
            },
            methodsSentence: 'Fitted by ordinary least squares.',
            warnings: [],
            softwareVersions: { scipy: '1.15.0' },
          },
          computedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
    });

    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.document).toEqual(doc);

    const plot = Object.values(loaded.document.nodes).find((n) => n.type === 'plot');
    expect(plot?.type === 'plot' && plot.trendLine).toBe('hide');
    expect(plot?.type === 'plot' && plot.trendInterval).toBe('prediction');
    expect(plot?.type === 'plot' && plot.trendExtent).toBe('axis');

    // Field by field, so a schema entry dropped one at a time is caught here
    // rather than only by the whole-document comparison above.
    const fit = loaded.document.analyses[0]?.result?.fit;
    expect(fit).toEqual({
      slope: 2,
      intercept: 0.5,
      n: 3,
      meanX: 2,
      sumSquaredDevX: 2,
      residualSe: 0.25,
      tMultiplier: 12.706,
      confidenceLevel: 0.95,
      xMin: 1,
      xMax: 3,
    });

    const untouched = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X\tY\n1\t2\n2\t4', newId()) };
      draft.datasets = [ds];
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Fit',
      });
    });
    const loadedUntouched = loadArchive(saveArchive(buildArchiveContents(untouched)));
    const untouchedPlot = Object.values(loadedUntouched.document.nodes).find(
      (n) => n.type === 'plot',
    );
    expect(untouchedPlot?.type === 'plot' && 'trendLine' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'trendInterval' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'trendExtent' in untouchedPlot).toBe(false);
  });

  it('leaves an ordinary line plot without the offset fields at all', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = { ...dataset('X1\tY1\n1\t2\n2\t4', newId()) };
      draft.datasets = [ds];
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'Line',
      });
    });

    const untouchedPlot = Object.values(doc.nodes).find(
      (n) => n.type === 'plot',
    );
    expect(untouchedPlot?.type === 'plot' && 'offsetStepMm' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'offsetStepXMm' in untouchedPlot).toBe(false);
    expect(untouchedPlot?.type === 'plot' && 'offsetFill' in untouchedPlot).toBe(false);
  });

  it('round-trips a pca dataset with a null source path', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        id: newId(),
        name: 'Cohort — PCA',
        format: 'pca',
        columns: [
          { name: 'Sample', kind: 'text' },
          { name: 'PC1', kind: 'number' },
          { name: 'PC2', kind: 'number' },
        ],
        rows: [
          ['A', 2.1, -0.5],
          ['B', -1.8, 1.2],
        ],
        // A PCA dataset has no verbatim import behind it — this is the
        // escape hatch `buildArchiveContents` already handles by
        // serialising the rows themselves through `datasetToCsv`.
        sourcePath: null,
        sourceFilename: null,
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [ds];
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'PCA',
        plotType: 'scatter',
      });
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('round-trips a umap dataset with a null source path', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const ds: Dataset = {
        id: newId(),
        name: 'Cohort — UMAP',
        format: 'umap',
        columns: [
          { name: 'Sample', kind: 'text' },
          { name: 'UMAP1', kind: 'number' },
          { name: 'UMAP2', kind: 'number' },
        ],
        rows: [
          ['A', 2.1, -0.5],
          ['B', -1.8, 1.2],
        ],
        // A UMAP dataset has no verbatim import behind it either — the same
        // `datasetToCsv` escape hatch the pca round-trip test above exercises.
        sourcePath: null,
        sourceFilename: null,
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [ds];
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 80, height: 60 },
        datasetId: ds.id,
        name: 'UMAP',
        plotType: 'scatter',
      });
    });

    const bytes = saveArchive(buildArchiveContents(doc));
    const loaded = loadArchive(bytes);
    expect(loaded.document).toEqual(doc);
  });

  it('stores the verbatim source data alongside the model', () => {
    const { doc } = sampleDocument();
    const original = 'Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6';
    const path = `data/${doc.datasets[0]!.id}.csv`;

    const bytes = saveArchive(
      buildArchiveContents(doc, new Map([[path, original]])),
    );
    const loaded = loadArchive(bytes);

    // Reproducibility rests on the original bytes surviving untouched.
    expect(loaded.dataFiles.get(path)).toBe(original);
  });

  it('stores image assets byte for byte', () => {
    const { doc } = imageDocument();
    const path = doc.assets[0]!.path;

    const bytes = saveArchive(
      buildArchiveContents(doc, new Map(), new Map([[path, TIFF_BYTES]])),
    );
    const loaded = loadArchive(bytes);

    // The same reproducibility claim `data/` makes, for binaries: the bytes a
    // reviewer extracts must be the bytes that were imported. TIFF_BYTES is
    // deliberately not valid UTF-8, so a stray text round trip corrupts it.
    expect(loaded.assets.get(path)).toEqual(TIFF_BYTES);
    expect(loaded.warnings).toHaveLength(0);
  });

  it('warns rather than fails when an asset binary is missing', () => {
    const { doc } = imageDocument();
    // A figure whose micrograph is missing still opens, and draws a placeholder
    // — losing one image must not cost the author the whole project.
    const loaded = loadArchive(saveArchive(buildArchiveContents(doc)));
    expect(loaded.warnings.join(' ')).toMatch(/micrograph\.tif.*missing/);
  });

  it('rejects an image whose asset was never registered', () => {
    const { doc, image } = imageDocument();
    const broken = editDocument(doc, (draft) => {
      const node = draft.nodes[image.id]!;
      if (node.type === 'image') node.assetId = 'does-not-exist';
    });
    expect(() => loadArchive(saveArchive(buildArchiveContents(broken)))).toThrow(
      /broken internal references/,
    );
  });

  it('rejects a file that is not a project', () => {
    expect(() => loadArchive(new Uint8Array([1, 2, 3, 4]))).toThrow(ArchiveError);
  });

  it('rejects a document with broken references', () => {
    const { doc } = sampleDocument();
    const broken = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') node.datasetId = 'does-not-exist';
      }
    });

    const bytes = saveArchive(buildArchiveContents(broken));
    expect(() => loadArchive(bytes)).toThrow(/broken internal references/);
  });

  it('refuses a schema version from the future', () => {
    const { doc } = sampleDocument();
    const future = { ...doc, schemaVersion: 99 };
    const bytes = saveArchive(buildArchiveContents(future));
    expect(() => loadArchive(bytes)).toThrow(/newer than this build/);
  });
});

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

describe('significance annotation', () => {
  it('maps adjusted p-values to the conventional asterisks', () => {
    expect(significanceStars(0.06)).toBe('ns');
    expect(significanceStars(0.05)).toBe('*');
    expect(significanceStars(0.004)).toBe('**');
    expect(significanceStars(0.0005)).toBe('***');
    expect(significanceStars(0.00001)).toBe('****');
  });
});

describe('input hashing', () => {
  it('is insensitive to key order', () => {
    expect(hashInputs({ a: 1, b: 2 })).toBe(hashInputs({ b: 2, a: 1 }));
  });

  it('changes when any value changes', () => {
    // This is what marks a displayed p-value stale after the data is edited.
    expect(hashInputs([1, 2, 3])).not.toBe(hashInputs([1, 2, 3.0001]));
  });

  it('analysisInputHash without x matches the pre-existing 2-argument form', () => {
    // Every already-saved project's inputHash was computed by the 2-argument
    // call. If the 3-argument form changed that output, every analysis in an
    // existing .figureforge file would read as stale the moment it reopens.
    const options = { test: 'ttest-welch' as const, correction: 'holm' as const };
    const values = [[1, 2, 3], [4, 5, 6]];
    expect(analysisInputHash(options, values)).toBe(
      hashInputs({ test: options.test, correction: options.correction }, values),
    );
  });

  it('analysisInputHash changes when x is supplied, and xForHash gates on series count', () => {
    const options = { test: 'pearson' as const, correction: 'none' as const };
    const values = [[1, 2, 3]];
    const withoutX = analysisInputHash(options, values);
    const withX = analysisInputHash(options, values, [4, 5, 6]);
    expect(withX).not.toBe(withoutX);

    expect(xForHash([{ name: 'y', values: [1, 2, 3], x: [4, 5, 6] }])).toEqual([4, 5, 6]);
    expect(
      xForHash([
        { name: 'a', values: [1], x: [1] },
        { name: 'b', values: [2], x: [2] },
      ]),
    ).toBeUndefined();
  });

  /**
   * A survival table, the shape `toSurvivalGroups` reads: time, event flag,
   * arm. Two arms so the events genuinely differ between groups — a single
   * arm would hash the same whichever way the flags were grouped.
   */
  const survivalDataset = (censorFirst = false): Dataset => ({
    ...dataset(
      'Time,Event,Arm\n' +
        `9,${censorFirst ? 0 : 1},Maintained\n` +
        '13,1,Maintained\n13,0,Maintained\n' +
        '23,1,Nonmaintained\n28,0,Nonmaintained\n31,1,Nonmaintained',
    ),
    format: 'survival',
  });

  it('the stored log-rank hash and the recomputed one agree', () => {
    // The regression this exists for: the run path folded in the event flags
    // while both places that recompute the hash called the 3-argument form,
    // and `analysisInputHash` branches on `events !== undefined` — so every
    // log-rank analysis reported itself permanently stale at error severity,
    // which gates export. Both sides now derive the flags through
    // `eventsForHash`, so the only way they can differ is a real data edit.
    const ds = survivalDataset();
    const options = { test: 'log-rank' as const, correction: 'none' as const };
    const series = toSeries(ds);
    const hashFor = (d: Dataset) => {
      const s = toSeries(d);
      return analysisInputHash(
        options,
        s.map((v) => v.values),
        xForHash(s),
        eventsForHash(options.test, d),
      );
    };

    expect(hashFor(ds)).toBe(
      analysisInputHash(
        options,
        series.map((s) => s.values),
        xForHash(series),
        toSurvivalGroups(ds).map((g) => g.events),
      ),
    );

    // And it is still a real staleness check, not one that agrees with
    // everything: censoring a subject who had an event changes nothing in
    // `values` — the times are identical — so the flags are the only thing
    // that can catch it.
    const censored = survivalDataset(true);
    expect(toSeries(censored).map((s) => s.values)).toEqual(series.map((s) => s.values));
    expect(hashFor(censored)).not.toBe(hashFor(ds));
  });

  it('eventsForHash answers only for a log-rank test on a survival table', () => {
    const ds = survivalDataset();
    expect(eventsForHash('log-rank', ds)).toEqual([
      [true, true, false],
      [true, false, true],
    ]);
    // Another test on the same table folds in nothing, so its 4-argument call
    // hashes exactly as the 3-argument one always did.
    expect(eventsForHash('ttest-welch', ds)).toBeUndefined();
    // And log-rank against a table that is not a survival table reads no
    // columns positionally: `toSurvivalGroups` would hash whatever sat in the
    // first three.
    expect(eventsForHash('log-rank', { ...ds, format: 'replicate' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Statistical annotation lifecycle
// ---------------------------------------------------------------------------

/** An analysis over the sample document's two groups, with one comparison. */
function sampleAnalysis(id: string, plotId: string, datasetId: string): Analysis {
  return {
    id,
    name: 'ttest-welch on Data',
    test: 'ttest-welch',
    spec: { datasetId, groups: ['Vehicle', 'Drug'] },
    plotId,
    options: { alternative: 'two-sided', correction: 'holm', alpha: 0.05, welch: true },
    inputHash: 'hash',
    result: {
      test: 'ttest-welch',
      omnibus: null,
      comparisons: [
        {
          groupA: 'Vehicle',
          groupB: 'Drug',
          statistic: 8,
          p: 0.001,
          pAdjusted: 0.001,
          df: 4,
          ci: null,
          effectSize: 3.2,
          effectSizeName: "Hedges' g",
          n: [3, 3],
        },
      ],
      methodsSentence: 'Welch t-test.',
      warnings: [],
      softwareVersions: {},
    },
    computedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Measurements as `measurePlot` would supply them, at a given scale. */
function measurementsAt(centreA: number, centreB: number, top = 10): PlotMeasurements {
  return {
    categoryX: new Map([
      ['Vehicle', centreA],
      ['Drug', centreB],
    ]),
    categoryTop: new Map([
      ['Vehicle', top],
      ['Drug', top],
    ]),
  };
}

/** The sample document with one analysis and its bracket already placed. */
function annotatedDocument() {
  const { doc, newId } = sampleDocument();
  const plot = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
  const analysis = sampleAnalysis(newId(), plot.id, doc.datasets[0]!.id);

  const annotated = editDocument(doc, (draft) => {
    replaceAnalysisForPlot(draft, analysis);
    addBracket(draft, newId, {
      plotId: plot.id,
      analysis,
      comparisonIndex: 0,
      measurements: measurementsAt(10, 30),
    });
  });

  return { doc: annotated, newId, plotId: plot.id, analysis };
}

describe('statistical annotation lifecycle', () => {
  it('replaces the previous analysis and brackets when a test is re-run', () => {
    const { doc, newId, plotId, analysis } = annotatedDocument();
    expect(doc.analyses).toHaveLength(1);
    expect(Object.values(doc.nodes).filter((n) => n.type === 'bracket')).toHaveLength(1);

    // Running a different test on the same plot must supersede the first, not
    // stack a second result and a second bracket on top of it.
    const second = { ...sampleAnalysis(newId(), plotId, analysis.spec.datasetId), test: 'mann-whitney' as const };
    const after = editDocument(doc, (draft) => {
      replaceAnalysisForPlot(draft, second);
      removeBracketsForPlot(draft, plotId);
      addBracket(draft, newId, {
        plotId,
        analysis: second,
        comparisonIndex: 0,
        measurements: measurementsAt(10, 30),
      });
    });

    expect(after.analyses).toHaveLength(1);
    expect(after.analyses[0]!.test).toBe('mann-whitney');
    expect(Object.values(after.nodes).filter((n) => n.type === 'bracket')).toHaveLength(1);
  });

  it('stores one per-series correlation per plot and prunes the unpicked ones', () => {
    const { doc, newId, plotId, analysis } = annotatedDocument();
    const dsId = analysis.spec.datasetId;
    const seriesAnalysis = (seriesName: string): Analysis => ({
      ...sampleAnalysis(newId(), plotId, dsId),
      test: 'linear-regression',
      spec: { datasetId: dsId, groups: [seriesName], seriesName },
    });

    // A group comparison already sits on this plot; the per-series batch must
    // leave it and add one analysis per fitted series.
    const first = editDocument(doc, (draft) => {
      replaceSeriesAnalysesForPlot(draft, plotId, [seriesAnalysis('Y1'), seriesAnalysis('Y2')]);
    });
    expect(first.analyses).toHaveLength(3);
    expect(first.analyses.filter((a) => a.spec.seriesName !== undefined).map((a) => a.spec.seriesName))
      .toEqual(['Y1', 'Y2']);
    expect(first.analyses.some((a) => a.test === 'ttest-welch')).toBe(true);

    // Re-run with only Y2 picked: Y1's analysis is gone, the group test stays.
    const second = editDocument(first, (draft) => {
      replaceSeriesAnalysesForPlot(draft, plotId, [seriesAnalysis('Y2')]);
    });
    expect(second.analyses.filter((a) => a.spec.seriesName !== undefined).map((a) => a.spec.seriesName))
      .toEqual(['Y2']);
    expect(second.analyses.some((a) => a.test === 'ttest-welch')).toBe(true);
  });

  it('round-trips a per-series correlation analysis', () => {
    const { doc, newId, plotId, analysis } = annotatedDocument();
    const withSeries = editDocument(doc, (draft) => {
      replaceSeriesAnalysesForPlot(draft, plotId, [
        {
          ...sampleAnalysis(newId(), plotId, analysis.spec.datasetId),
          test: 'linear-regression',
          spec: { datasetId: analysis.spec.datasetId, groups: ['Y1'], seriesName: 'Y1' },
        },
      ]);
    });
    const loaded = loadArchive(saveArchive(buildArchiveContents(withSeries)));
    expect(loaded.document.analyses.find((a) => a.spec.seriesName === 'Y1')).toBeDefined();
  });

  it('keeps analyses for other plots when one is re-run', () => {
    const { doc, newId, plotId, analysis } = annotatedDocument();
    const otherPlot = Object.values(doc.nodes).find(
      (n) => n.type === 'plot' && n.id !== plotId,
    )!;

    const withBoth = editDocument(doc, (draft) => {
      replaceAnalysisForPlot(
        draft,
        sampleAnalysis(newId(), otherPlot.id, analysis.spec.datasetId),
      );
    });
    expect(withBoth.analyses).toHaveLength(2);

    const rerun = editDocument(withBoth, (draft) => {
      replaceAnalysisForPlot(draft, sampleAnalysis(newId(), plotId, analysis.spec.datasetId));
    });
    expect(rerun.analyses).toHaveLength(2);
  });

  /*
   * An analysis outliving its plot was invisible once the Stats tab began
   * showing only the selected panel's result — a record naming a node that no
   * longer exists, unre-runnable, still written into the archive, and still
   * able to raise a stale-analysis error in the Quality tab with nowhere to go.
   */
  it('takes a plot’s analysis and brackets with it when the plot is deleted', () => {
    const { doc, plotId } = annotatedDocument();
    expect(doc.analyses).toHaveLength(1);
    expect(Object.values(doc.nodes).filter((n) => n.type === 'bracket')).toHaveLength(1);

    const after = editDocument(doc, (draft) => deleteNode(draft, plotId));
    expect(after.analyses).toEqual([]);
    expect(Object.values(after.nodes).filter((n) => n.type === 'bracket')).toEqual([]);
  });

  it('cascades the same way when the panel is deleted rather than the plot', () => {
    const { doc, plotId } = annotatedDocument();
    const panelId = doc.nodes[plotId]!.parentId!;

    const after = editDocument(doc, (draft) => deleteNode(draft, panelId));
    expect(after.analyses).toEqual([]);
    expect(Object.values(after.nodes).filter((n) => n.type === 'bracket')).toEqual([]);
  });

  it('leaves another plot’s analysis and brackets alone', () => {
    const { doc, newId, plotId, analysis } = annotatedDocument();
    const otherPlot = Object.values(doc.nodes).find((n) => n.type === 'plot' && n.id !== plotId)!;

    const withBoth = editDocument(doc, (draft) => {
      const second = sampleAnalysis(newId(), otherPlot.id, analysis.spec.datasetId);
      replaceAnalysisForPlot(draft, second);
      addBracket(draft, newId, {
        plotId: otherPlot.id,
        analysis: second,
        comparisonIndex: 0,
        measurements: measurementsAt(10, 30),
      });
    });
    expect(withBoth.analyses).toHaveLength(2);

    const after = editDocument(withBoth, (draft) => deleteNode(draft, plotId));
    expect(after.analyses).toHaveLength(1);
    expect(after.analyses[0]!.plotId).toBe(otherPlot.id);
    expect(Object.values(after.nodes).filter((n) => n.type === 'bracket')).toHaveLength(1);
  });

  it('takes a bracket carrying no analysis at all', () => {
    /*
     * `BracketNode.analysisId` is nullable — a bracket can be placed by hand.
     * Such a bracket is reachable only through the structural rule (its plot is
     * doomed, so it is), never through the integrity backstop, which keys on
     * the analysis id. This is what separates the two rules: today's reference
     * graph lets either one alone cover an ordinary bracket, and only this one
     * covers a hand-placed one.
     *
     * It also closes a gap that predates this round: `deleteNode` on its own
     * left every bracket behind, and only `deleteNodesWithLayout` in the web
     * app swept them.
     */
    const { doc, plotId } = annotatedDocument();
    const withManual = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'bracket') node.analysisId = null;
      }
    });

    const after = editDocument(withManual, (draft) => deleteNode(draft, plotId));
    expect(Object.values(after.nodes).filter((n) => n.type === 'bracket')).toEqual([]);
  });

  it('leaves the document openable — the reason the brackets must go too', () => {
    /*
     * `checkReferentialIntegrity` refuses a bracket whose `analysisId` names a
     * missing analysis. It runs on load, not on save, so dropping the analysis
     * on its own would write a project that can never be opened again.
     */
    const { doc, plotId } = annotatedDocument();
    const after = editDocument(doc, (draft) => deleteNode(draft, plotId));
    expect(checkReferentialIntegrity(after)).toEqual([]);
  });

  it('takes a duplicate’s bracket, which shares the original’s analysis', () => {
    /*
     * The case the integrity backstop exists for, and it is reachable rather
     * than hypothetical. `duplicateNode` remaps a copied bracket's `plotId` to
     * the copy but *shares* its `analysisId` with the original, deliberately —
     * copying a figure element must not fork its data. So deleting the
     * original panel orphans an analysis the copy's bracket still names, and
     * the structural rule cannot reach it: the copy's plot is not doomed.
     *
     * Measured: without the backstop the round trip below throws
     * `ArchiveError: Project file has broken internal references.`
     */
    const { doc, newId, plotId } = annotatedDocument();
    const panelId = doc.nodes[plotId]!.parentId!;

    const withCopy = editDocument(doc, (draft) => {
      duplicateNode(draft, newId, panelId);
    });
    const copied = Object.values(withCopy.nodes).filter((n) => n.type === 'bracket');
    expect(copied).toHaveLength(2);
    expect(new Set(copied.map((b) => b.analysisId)).size).toBe(1);

    const after = editDocument(withCopy, (draft) => deleteNode(draft, panelId));
    expect(after.analyses).toEqual([]);
    expect(Object.values(after.nodes).filter((n) => n.type === 'bracket')).toEqual([]);
    expect(checkReferentialIntegrity(after)).toEqual([]);

    // The check runs on *load*, not on save, so the real failure is a project
    // that writes without complaint and can then never be opened again. Prove
    // the round trip rather than the predicate.
    expect(() => loadArchive(saveArchive(buildArchiveContents(after)))).not.toThrow();
  });

  it('restores the analysis, its brackets and the nodes in one undo', () => {
    const { doc, plotId } = annotatedDocument();
    const store = new DocumentStore(doc);
    store.commit('Delete plot', (draft) => deleteNode(draft, plotId));
    expect(store.getDocument().analyses).toEqual([]);

    store.undo();
    const restored = store.getDocument();
    expect(restored.analyses).toHaveLength(1);
    expect(restored.nodes[plotId]).toBeDefined();
    expect(Object.values(restored.nodes).filter((n) => n.type === 'bracket')).toHaveLength(1);
  });

  it('never dooms an analysis that names no plot', () => {
    // `plotId` is optional only so documents predating the field load
    // unmigrated. Nothing here names such a record, so nothing may collect it.
    const { doc, plotId, analysis } = annotatedDocument();
    const detached = editDocument(doc, (draft) => {
      draft.analyses = [{ ...analysis, plotId: null }];
    });

    const after = editDocument(detached, (draft) => deleteNode(draft, plotId));
    expect(after.analyses).toHaveLength(1);
  });

  it('moves brackets back onto the bars when the plot is resized', () => {
    const { doc, plotId } = annotatedDocument();
    const before = Object.values(doc.nodes).find((n) => n.type === 'bracket')!;

    // The bars have moved outward, as they would when the panel widens.
    const after = editDocument(doc, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measurementsAt(20, 60)]]));
    });
    const moved = after.nodes[before.id]!;

    expect(moved.frame.x).toBeGreaterThan(before.frame.x);
    expect(moved.frame.width).toBeCloseTo(40, 6);
  });

  it('preserves a hand-dragged offset while still following the bars', () => {
    const { doc, plotId } = annotatedDocument();
    const bracket = Object.values(doc.nodes).find((n) => n.type === 'bracket')!;

    // A bracket nudged 3 mm up must keep that adjustment across a resize —
    // pinning it in absolute space instead would strand it exactly as an
    // unrepositioned bracket is stranded.
    const nudged = editDocument(doc, (draft) => {
      const target = draft.nodes[bracket.id]!;
      if (target.type === 'bracket') target.userOffsetMm = { x: 0, y: -3 };
    });

    const baseline = editDocument(doc, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measurementsAt(20, 60)]]));
    }).nodes[bracket.id]!;

    const after = editDocument(nudged, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measurementsAt(20, 60)]]));
    }).nodes[bracket.id]!;

    expect(after.frame.x).toBeCloseTo(baseline.frame.x, 6);
    expect(after.frame.y).toBeCloseTo(baseline.frame.y - 3, 6);
  });

  it('leaves brackets alone when their plot cannot be measured', () => {
    const { doc } = annotatedDocument();
    const before = Object.values(doc.nodes).find((n) => n.type === 'bracket')!;

    const after = editDocument(doc, (draft) => repositionBrackets(draft, new Map()));

    expect(after.nodes[before.id]!.frame).toEqual(before.frame);
  });

  it('keeps a bracket on its bars once its panel has been grouped with another and the group moves', () => {
    /*
     * Reported from real use: grouping a bracketed panel with another, then
     * moving the group, left the bracket behind — or worse, moved it in the
     * wrong direction entirely. Traced to `layoutBracketsForPlot` (what
     * `repositionBrackets`/`reflowBrackets` actually calls) reading
     * `panel.frame.x/y` directly rather than the panel's absolute position.
     * `panel.frame` is only page space for a top-level panel; the moment it
     * is grouped with another, `.frame` is relative to the group, and using
     * it unconverted put the bracket somewhere in the group's *local* space
     * instead of the page space every bracket lives in. `bracketFrame` (the
     * creation-time placement) had the identical bug.
     */
    const { doc, newId, plotId } = annotatedDocument();
    const bracketId = Object.values(doc.nodes).find((n) => n.type === 'bracket')!.id;
    const plot = doc.nodes[plotId]!;
    const panelId = plot.parentId!;
    const otherPanel = Object.values(doc.nodes).find(
      (n) => n.type === 'panel' && n.id !== panelId,
    )!;
    const measurements = new Map([[plotId, measurementsAt(10, 30)]]);

    // A baseline computed by the same `repositionBrackets` call the grouped
    // case will also go through, not the bracket's own creation-time frame
    // — `addBracket`'s default gap (4 mm) and `repositionBrackets`' default
    // (`DEFAULT_BRACKET_GAP_MM`, 2 mm) legitimately differ, which is not
    // what this test is about.
    const baseline = editDocument(doc, (draft) => {
      repositionBrackets(draft, measurements);
    }).nodes[bracketId]!.frame;

    const grouped = editDocument(doc, (draft) => {
      addGroup(draft, newId, [panelId, otherPanel.id]);
    });
    // Grouping alone must not move anything — round 21's own guarantee —
    // so the bracket is still exactly where it started.
    expect(grouped.nodes[bracketId]!.frame).toEqual(doc.nodes[bracketId]!.frame);

    const group = Object.values(grouped.nodes).find((n) => n.type === 'group')!;
    const after = editDocument(grouped, (draft) => {
      // Moving the group, the same way a drag does: translate its own
      // frame directly, leaving every member's frame — relative to the
      // group — untouched.
      const node = draft.nodes[group.id]!;
      node.frame = { ...node.frame, x: node.frame.x + 50, y: node.frame.y + 30 };
      repositionBrackets(draft, measurements);
    });

    const bracketAfter = after.nodes[bracketId]!.frame;
    expect(bracketAfter.x).toBeCloseTo(baseline.x + 50, 6);
    expect(bracketAfter.y).toBeCloseTo(baseline.y + 30, 6);
  });

  it('collapses a stale bracket to a harmless full-width marker, not a crash, when its plot flips to horizontal', () => {
    // `packages/render`'s `measurePlot` refuses a horizontal plot's brackets
    // the same way it already refuses a continuous plot's — empty but
    // *defined* `categoryX`/`categoryTop` maps, not an absent measurement.
    // That distinction matters here: an absent measurement leaves a bracket
    // alone (the test above), but a defined-and-empty one reaches
    // `bracketSpan`'s measured branch with nothing in it, which is what this
    // test reproduces directly, without needing `packages/render` at all.
    const { doc, plotId } = annotatedDocument();
    const flipped = editDocument(doc, (draft) => {
      const plot = draft.nodes[plotId];
      if (plot?.type === 'plot') plot.orientation = 'horizontal';
    });
    const before = Object.values(flipped.nodes).find((n) => n.type === 'bracket')!;
    const plotFrame = flipped.nodes[plotId]!.frame;

    const after = editDocument(flipped, (draft) => {
      repositionBrackets(draft, new Map([[plotId, { categoryX: new Map(), categoryTop: new Map() }]]));
    });
    const moved = after.nodes[before.id]!;

    expect(moved.type).toBe('bracket');
    expect(moved.type === 'bracket' && Number.isFinite(moved.frame.x)).toBe(true);
    expect(moved.type === 'bracket' && Number.isFinite(moved.frame.y)).toBe(true);
    // `bracketSpan`'s measured branch falls back to `0`/`plot.frame.width`
    // for a category name that misses an empty map — spanning the full
    // plot width is the resulting degenerate-but-harmless shape, an
    // obviously-off marker the author can select and delete.
    expect(moved.type === 'bracket' && moved.frame.width).toBeCloseTo(plotFrame.width, 6);
  });

  it('names brackets after the panel they annotate', () => {
    const { doc } = annotatedDocument();
    const bracket = Object.values(doc.nodes).find((n) => n.type === 'bracket')!;
    // Two panels' brackets would otherwise both read "Vehicle vs Drug".
    expect(bracket.name).toBe('a: Vehicle vs Drug');
  });
});

// ---------------------------------------------------------------------------
// Bracket stacking
// ---------------------------------------------------------------------------

/** Four groups, so comparisons can genuinely overlap or not. */
const FOUR_GROUP_CSV = 'Treatment,R1,R2,R3\nA,1,2,3\nB,4,5,6\nC,7,8,9\nD,10,11,12';

/** Band centres 10 mm apart, every category the same height. */
function fourGroupMeasurements(top = 8): PlotMeasurements {
  return {
    categoryX: new Map([
      ['A', 10],
      ['B', 20],
      ['C', 30],
      ['D', 40],
    ]),
    categoryTop: new Map([
      ['A', top],
      ['B', top],
      ['C', top],
      ['D', top],
    ]),
  };
}

/** A document with one plot over four groups and a bracket per comparison. */
function stackedDocument(pairs: readonly [string, string][], measured = fourGroupMeasurements()) {
  const newId = createIdFactory();
  const base = createDocument({
    widthMm: 183,
    heightMm: 75,
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const doc = editDocument(base, (draft) => {
    const ds = dataset(FOUR_GROUP_CSV, newId());
    draft.datasets = [ds];
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 60, height: 50 },
      datasetId: ds.id,
      name: 'One',
    });
  });

  const plot = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
  const analysis: Analysis = {
    ...sampleAnalysis(newId(), plot.id, doc.datasets[0]!.id),
    spec: { datasetId: doc.datasets[0]!.id, groups: ['A', 'B', 'C', 'D'] },
    result: {
      ...sampleAnalysis('x', plot.id, doc.datasets[0]!.id).result!,
      comparisons: pairs.map(([groupA, groupB]) => ({
        groupA,
        groupB,
        statistic: 4,
        p: 0.001,
        pAdjusted: 0.001,
        df: 4,
        ci: null,
        effectSize: 1,
        effectSizeName: "Hedges' g",
        n: [3, 3],
      })),
    },
  };

  const annotated = editDocument(doc, (draft) => {
    replaceAnalysisForPlot(draft, analysis);
    pairs.forEach((_, index) => {
      addBracket(draft, newId, {
        plotId: plot.id,
        analysis,
        comparisonIndex: index,
        measurements: measured,
      });
    });
  });

  return { doc: annotated, plotId: plot.id, measured };
}

/** Bracket frames in creation order, as a list of {y, left, right}. */
function bracketBoxes(doc: FigureDocument) {
  return Object.values(doc.nodes)
    .filter((n) => n.type === 'bracket')
    .map((n) => ({
      y: n.frame.y,
      left: n.frame.x,
      right: n.frame.x + n.frame.width,
      name: n.name,
    }));
}

describe('bracket stacking', () => {
  it('separates every overlapping comparison by the step', () => {
    // A–B, A–C and A–D all start at A, so all three overlap horizontally and
    // each must clear the one below it. Placing them independently — which is
    // what the caller's increasing-gap sequence did — put the second and third
    // on the same line as soon as the panel ran out of headroom.
    const { doc, plotId, measured } = stackedDocument([
      ['A', 'B'],
      ['A', 'C'],
      ['A', 'D'],
    ]);

    const laid = editDocument(doc, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measured]]), { stepMm: 4 });
    });

    const ys = bracketBoxes(laid)
      .map((b) => b.y)
      .sort((a, b) => a - b);
    expect(new Set(ys).size).toBe(3);
    // y is inverted, so consecutive brackets differ by a full step upward.
    expect(ys[1]! - ys[0]!).toBeCloseTo(4, 6);
    expect(ys[2]! - ys[1]!).toBeCloseTo(4, 6);
  });

  it('puts the shortest span lowest, so nested comparisons sit inside wider ones', () => {
    const { doc, plotId, measured } = stackedDocument([
      ['A', 'D'],
      ['A', 'B'],
    ]);

    const laid = editDocument(doc, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measured]]), { stepMm: 4 });
    });

    const boxes = bracketBoxes(laid);
    const wide = boxes.find((b) => b.right - b.left > 20)!;
    const narrow = boxes.find((b) => b.right - b.left <= 20)!;
    // Declared first but spanning further, so it must end up above — the old
    // rule keyed the height off comparison order and would have crossed them.
    expect(wide.y).toBeLessThan(narrow.y);
  });

  it('lets disjoint comparisons share a height', () => {
    // A–B and C–D do not overlap, so lifting the second buys nothing and costs
    // the vertical budget that the overlapping case actually needs.
    const { doc, plotId, measured } = stackedDocument([
      ['A', 'B'],
      ['C', 'D'],
    ]);

    const laid = editDocument(doc, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measured]]), { stepMm: 4 });
    });

    const [first, second] = bracketBoxes(laid);
    expect(first!.y).toBeCloseTo(second!.y, 6);
  });

  it('shifts the whole stack down rather than collapsing it onto the panel top', () => {
    /*
     * The tallest mark 1 mm from the panel top leaves no room for three
     * brackets. The old code clamped each one to `Math.max(0, …)`, which is
     * exactly how they came to be drawn on top of one another. Shifting the
     * stack keeps every separation intact.
     */
    const { doc, plotId, measured } = stackedDocument(
      [
        ['A', 'B'],
        ['A', 'C'],
        ['A', 'D'],
      ],
      fourGroupMeasurements(1),
    );

    const laid = editDocument(doc, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measured]]), { stepMm: 4 });
    });

    const boxes = bracketBoxes(laid);
    const ys = boxes.map((b) => b.y).sort((a, b) => a - b);
    expect(new Set(ys).size).toBe(3);
    expect(ys[1]! - ys[0]!).toBeCloseTo(4, 6);
    // Still inside the panel, which starts at y = 0.
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it('keeps a manual nudge measured against the collective placement', () => {
    const { doc, plotId, measured } = stackedDocument([
      ['A', 'B'],
      ['A', 'C'],
    ]);

    const laid = editDocument(doc, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measured]]), { stepMm: 4 });
    });
    const target = bracketBoxes(laid)[0]!;
    const targetId = Object.values(laid.nodes).find(
      (n) => n.type === 'bracket' && n.name === target.name,
    )!.id;

    // Drag it 3 mm up, record the offset, then re-lay everything out.
    const nudged = editDocument(laid, (draft) => {
      const node = draft.nodes[targetId]!;
      node.frame = { ...node.frame, y: node.frame.y - 3 };
      recordBracketOffset(draft, targetId, new Map([[plotId, measured]]), { stepMm: 4 });
    });

    const recorded = nudged.nodes[targetId]!;
    expect(recorded.type === 'bracket' && recorded.userOffsetMm).toEqual({ x: 0, y: -3 });

    const again = editDocument(nudged, (draft) => {
      repositionBrackets(draft, new Map([[plotId, measured]]), { stepMm: 4 });
    });
    // The adjustment survives, and is not applied twice.
    expect(again.nodes[targetId]!.frame.y).toBeCloseTo(target.y - 3, 6);
  });
});

// ---------------------------------------------------------------------------
// Dataset naming
// ---------------------------------------------------------------------------

describe('dataset renaming', () => {
  it('propagates the new name to the panel and plot that took it', () => {
    const { doc } = sampleDocument();
    const datasetId = doc.datasets[0]!.id;

    const after = editDocument(doc, (draft) => renameDataset(draft, datasetId, 'Cell viability'));

    expect(after.datasets[0]!.name).toBe('Cell viability');
    const plots = Object.values(after.nodes).filter((n) => n.type === 'plot');
    expect(plots.every((p) => p.name === 'Plot — Cell viability')).toBe(true);
  });

  it('ignores a blank name rather than clearing the dataset', () => {
    const { doc } = sampleDocument();
    const before = doc.datasets[0]!.name;
    const after = editDocument(doc, (draft) =>
      renameDataset(draft, doc.datasets[0]!.id, '   '),
    );
    expect(after.datasets[0]!.name).toBe(before);
  });
});

describe('dataset removal', () => {
  it('refuses while a plot still reads it', () => {
    const { doc } = sampleDocument();
    const datasetId = doc.datasets[0]!.id;
    expect(plotsUsingDataset(doc.nodes, datasetId).length).toBeGreaterThan(0);

    let removed = true;
    const after = editDocument(doc, (draft) => {
      removed = removeDataset(draft, datasetId);
    });

    // Removing it anyway would fail `checkReferentialIntegrity` on save: the
    // figure would edit perfectly and then refuse to be written.
    expect(removed).toBe(false);
    expect(after.datasets).toHaveLength(doc.datasets.length);
    expect(checkReferentialIntegrity(after)).toEqual([]);
  });

  it('takes its analyses and their brackets with it once nothing reads it', () => {
    const { doc } = annotatedDocument();
    const datasetId = doc.analyses[0]!.spec.datasetId;
    expect(doc.analyses).toHaveLength(1);

    const after = editDocument(doc, (draft) => {
      // *Every* plot on it, not just the annotated one — the sample document
      // draws the same dataset in two panels, and one remaining reader is
      // still a reader.
      for (const plot of plotsUsingDataset(draft.nodes, datasetId)) deleteNode(draft, plot.id);
      expect(removeDataset(draft, datasetId)).toBe(true);
    });

    expect(after.datasets.some((d) => d.id === datasetId)).toBe(false);
    // A result card citing data the document no longer holds cannot be checked
    // against it, and its bracket could never be repositioned again.
    expect(after.analyses).toHaveLength(0);
    expect(Object.values(after.nodes).filter((n) => n.type === 'bracket')).toHaveLength(0);
    expect(checkReferentialIntegrity(after)).toEqual([]);
  });

  it('leaves another dataset’s analysis alone', () => {
    const { doc } = annotatedDocument();
    const kept = doc.analyses[0]!;
    const spare: Dataset = { ...doc.datasets[0]!, id: 'spare', name: 'Spare' };

    const after = editDocument(doc, (draft) => {
      draft.datasets = [...draft.datasets, spare];
      expect(removeDataset(draft, 'spare')).toBe(true);
    });

    expect(after.analyses.map((a) => a.id)).toEqual([kept.id]);
    expect(after.datasets.some((d) => d.id === 'spare')).toBe(false);
  });
});

describe('panel tile grid', () => {
  /** A panel holding `count` images, tiled if there is more than one. */
  function montage(count: number) {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const doc = editDocument(base, (draft) => {
      const images = Array.from({ length: count }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, {
          id: assetId,
          filename: `tile-${i}.png`,
          mimeType: 'image/png',
          byteLength: 10,
          naturalPx: { width: 100, height: 100 },
        });
        return { assetId, naturalPx: { width: 100, height: 100 } };
      });

      addPanelWithImages(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 40 },
        name: 'Montage',
        images,
        gutterMm: 2,
      });
    });

    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const tiles = Object.values(doc.nodes)
      .filter((n) => n.type === 'image')
      .sort((a, b) => a.z - b.z);
    return { doc, panel, tiles, newId };
  }

  it('tiles four images into a 2×2 grid that fills the panel', () => {
    const { panel, tiles } = montage(4);
    // 2 × 2, not the 2 × 3 a shape-only fit would prefer for a wide panel:
    // `suggestMontageGrid` refuses a grid with a wholly empty row or column,
    // because an empty cell in a published montage is a hole in the figure.
    expect(panel.type === 'panel' && panel.contentGrid).toEqual({
      rows: 2,
      cols: 2,
      gutterMm: 2,
      autoFit: true,
    });

    // Four distinct cells — stacked at the origin is what happened before, and
    // only the highest z was ever visible.
    const boxes = tiles.map((t) => `${t.frame.x},${t.frame.y}`);
    expect(new Set(boxes).size).toBe(4);

    // Two columns of equal width, sharing the frame minus one gutter.
    const [a, b] = tiles;
    expect(a!.frame.width).toBeCloseTo(b!.frame.width, 6);
    expect(a!.frame.width * 2 + 2).toBeCloseTo(60, 6);
    expect(a!.frame.y).toBeCloseTo(b!.frame.y, 6);
  });

  it('re-tiles when the grid is changed, without touching the panel', () => {
    const { doc, panel } = montage(4);

    const relaid = editDocument(doc, (draft) => {
      const target = draft.nodes[panel.id]!;
      if (target.type === 'panel') target.contentGrid = { rows: 1, cols: 4, gutterMm: 2 };
      resizePanel(draft, panel.id, target.frame);
    });

    const tiles = Object.values(relaid.nodes)
      .filter((n) => n.type === 'image')
      .sort((a, b) => a.z - b.z);
    // One row: every tile shares a y, and the widths sum with three gutters.
    expect(new Set(tiles.map((t) => t.frame.y)).size).toBe(1);
    expect(tiles[0]!.frame.width * 4 + 3 * 2).toBeCloseTo(60, 6);
  });

  it('leaves a single-child panel exactly as it was', () => {
    /*
     * The guarantee that makes the grid safe to add: every existing figure has
     * one child per panel, and none of them may move. `contentGrid` is not even
     * written for a single image, so an old document cannot acquire one.
     */
    const { panel, tiles } = montage(1);
    expect(panel.type === 'panel' && panel.contentGrid).toBeUndefined();
    expect(tiles[0]!.frame).toEqual({ x: 0, y: 0, width: 60, height: 40 });

    // And a re-layout keeps it filling the panel rather than tiling it.
    const { doc } = montage(1);
    const target = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const relaid = editDocument(doc, (draft) =>
      resizePanel(draft, target.id, { x: 0, y: 0, width: 80, height: 50 }),
    );
    const image = Object.values(relaid.nodes).find((n) => n.type === 'image')!;
    expect(image.frame).toEqual({ x: 0, y: 0, width: 80, height: 50 });
  });

  it('keeps every tile its own node, so each carries its own crop', () => {
    const { doc, tiles } = montage(3);
    // Three image nodes, three assets — pooling them into one would throw away
    // the per-tile crop, scale bar and annotations.
    expect(tiles).toHaveLength(3);
    expect(new Set(tiles.map((t) => t.type === 'image' && t.assetId)).size).toBe(3);
    expect(checkReferentialIntegrity(doc)).toEqual([]);
  });

  it('leaves extra tiles alone rather than stacking them invisibly', () => {
    const { doc, panel } = montage(4);
    // A 1×2 grid has two cells for four tiles. The extras keep their size:
    // moving them to the origin would hide them under a tile, which is the
    // failure this whole feature exists to remove.
    const relaid = editDocument(doc, (draft) => {
      const target = draft.nodes[panel.id]!;
      if (target.type === 'panel') target.contentGrid = { rows: 1, cols: 2, gutterMm: 2 };
      resizePanel(draft, panel.id, target.frame);
    });

    const tiles = Object.values(relaid.nodes)
      .filter((n) => n.type === 'image')
      .sort((a, b) => a.z - b.z);
    expect(tiles[2]!.frame).not.toEqual(tiles[3]!.frame);
  });

  it('refuses to hand a tile a degenerate frame when the panel is too small for its grid', () => {
    // Reported bug: shrink a montage panel enough (or apply a template onto
    // one already too small) and a cell can collapse toward 0×0, leaving that
    // tile's own resize handles an ungrabbable point. The live drag path can
    // no longer reach this state (`panelGridMinimumMm` in `Canvas.tsx` floors
    // the resize), but any other caller of `resizePanel` still can, so this
    // is the backstop: every child keeps its prior frame rather than being
    // handed a degenerate one.
    const { doc, panel, tiles: before } = montage(4);
    const tooSmall = editDocument(doc, (draft) => resizePanel(draft, panel.id, { x: 0, y: 0, width: 6, height: 6 }));

    const after = Object.values(tooSmall.nodes)
      .filter((n) => n.type === 'image')
      .sort((a, b) => a.z - b.z);
    expect(after.map((t) => t.frame)).toEqual(before.map((t) => t.frame));
    // The panel itself still shrank — only its children were protected.
    const shrunkPanel = tooSmall.nodes[panel.id]!;
    expect(shrunkPanel.frame).toEqual({ x: 0, y: 0, width: 6, height: 6 });
  });

  it('keeps tiling once the panel is merely tight, not degenerate', () => {
    // The backstop above must not fire early: a panel that can still give
    // every cell a real (if modest) size keeps tiling normally.
    const { doc, panel } = montage(4);
    const tight = editDocument(doc, (draft) => resizePanel(draft, panel.id, { x: 0, y: 0, width: 24, height: 24 }));

    const tiles = Object.values(tight.nodes)
      .filter((n) => n.type === 'image')
      .sort((a, b) => a.z - b.z);
    for (const tile of tiles) {
      expect(tile.frame.width).toBeGreaterThanOrEqual(MIN_TILE_MM);
      expect(tile.frame.height).toBeGreaterThanOrEqual(MIN_TILE_MM);
    }
    expect(new Set(tiles.map((t) => `${t.frame.x},${t.frame.y}`)).size).toBe(4);
  });
});

describe('dataset editing', () => {
  const table = (): Dataset => dataset('Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6');

  it('re-types a column when an edit changes what it holds', () => {
    // The layout is inferred from the column kinds, so an edit that retypes a
    // column and leaves the kind behind produces a table whose declared shape
    // no longer matches its contents.
    const before = table();
    expect(before.columns[1]!.kind).toBe('number');

    const after = setCell(before, 0, 1, 'not measured');
    expect(after.columns[1]!.kind).toBe('text');
    expect(after.rows[0]![1]).toBe('not measured');
    // …and back again when the mistake is corrected.
    expect(setCell(after, 0, 1, '10').columns[1]!.kind).toBe('number');
  });

  it('parses an edited cell exactly as an import would', () => {
    const edited = setCell(table(), 0, 1, ' 12.5 ');
    expect(edited.rows[0]![1]).toBe(12.5);
    // The importer's blanks, so a cleared cell is missing data and not "NA".
    expect(setCell(table(), 0, 1, 'NA').rows[0]![1]).toBeNull();
  });

  it('adds and removes rows without disturbing the rest', () => {
    const grown = insertRow(table(), 1);
    expect(grown.rows).toHaveLength(3);
    expect(grown.rows[1]).toEqual([null, null, null, null]);
    expect(grown.rows[2]![0]).toBe('Drug');

    const shrunk = removeRow(grown, 1);
    expect(shrunk.rows.map((r) => r[0])).toEqual(['Vehicle', 'Drug']);
  });

  it('shifts the group blocks when a column is inserted or removed', () => {
    /*
     * The blocks are column *indices*. Left alone, every one after an insertion
     * repoints at its neighbour — a group quietly acquires a column belonging
     * to the next group and its mean changes with nothing on screen saying so.
     */
    const ds: Dataset = {
      ...dataset('Variant,A1,A2,B1,B2\nWT,1,2,3,4'),
      format: 'grouped-replicates',
      columnGroups: [
        { name: 'Group A', from: 1, to: 2 },
        { name: 'Group B', from: 3, to: 4 },
      ],
    };

    const inserted = insertColumn(ds, 3);
    expect(inserted.columnGroups).toEqual([
      { name: 'Group A', from: 1, to: 2 },
      { name: 'Group B', from: 4, to: 5 },
    ]);

    const removed = removeColumn(ds, 1);
    expect(removed.columnGroups).toEqual([
      // Group A lost one of its two columns…
      { name: 'Group A', from: 1, to: 1 },
      { name: 'Group B', from: 2, to: 3 },
    ]);
    expect(removed.columns.map((c) => c.name)).toEqual(['Variant', 'A2', 'B1', 'B2']);
  });

  it('drops a block whose every column has gone', () => {
    const ds: Dataset = {
      ...dataset('Variant,A1,B1\nWT,1,2'),
      format: 'grouped-replicates',
      columnGroups: [
        { name: 'Group A', from: 1, to: 1 },
        { name: 'Group B', from: 2, to: 2 },
      ],
    };
    // An empty group is not a group.
    expect(removeColumn(ds, 1).columnGroups).toEqual([{ name: 'Group B', from: 1, to: 1 }]);
  });

  it('swaps two adjacent columns, data and header together', () => {
    const ds = dataset('Feature,B,C\nPDCD6,2.14,3.02\nCDK1,1.74,2.04');
    const moved = moveColumn(ds, 1, 'right');
    expect(moved.columns.map((c) => c.name)).toEqual(['Feature', 'C', 'B']);
    expect(moved.rows).toEqual([
      ['PDCD6', 3.02, 2.14],
      ['CDK1', 2.04, 1.74],
    ]);

    // Moving back is the inverse.
    expect(moveColumn(moved, 2, 'left').rows).toEqual(ds.rows);
  });

  it('is a no-op at either boundary', () => {
    const ds = dataset('Feature,B,C\nPDCD6,2.14,3.02');
    expect(moveColumn(ds, 0, 'left')).toBe(ds);
    expect(moveColumn(ds, 2, 'right')).toBe(ds);
  });

  it('is a no-op once column groups are declared', () => {
    const ds: Dataset = {
      ...dataset('Variant,A1,A2,B1,B2\nWT,1,2,3,4'),
      format: 'grouped-replicates',
      columnGroups: [
        { name: 'Group A', from: 1, to: 2 },
        { name: 'Group B', from: 3, to: 4 },
      ],
    };
    expect(moveColumn(ds, 1, 'right')).toBe(ds);
  });

  it('pastes a block from Excel, growing the table to fit', () => {
    // An Excel paste is tab-delimited, and its first row must not be eaten as a
    // header — a paste that silently lost a row ends up in a figure.
    const pasted = pasteBlock(table(), 1, 1, '100\t200\t300\n400\t500\t600');
    expect(pasted.rows).toHaveLength(3);
    expect(pasted.rows[1]).toEqual(['Drug', 100, 200, 300]);
    expect(pasted.rows[2]).toEqual([null, 400, 500, 600]);
    // The untouched row is exactly as it was.
    expect(pasted.rows[0]).toEqual(['Vehicle', 10, 11, 12]);
  });

  it('copies a single cell', () => {
    expect(copyBlock(table(), 0, 0, 0, 0)).toBe('Vehicle');
    expect(copyBlock(table(), 1, 2, 1, 2)).toBe('5');
  });

  it('copies a multi-row, multi-column rectangle as tab/newline-delimited text', () => {
    // The same shape Excel puts on the clipboard, and the shape `pasteBlock`
    // already reads — a copy is meant to round-trip through a real
    // spreadsheet and back.
    expect(copyBlock(table(), 0, 1, 1, 3)).toBe('10\t11\t12\n4\t5\t6');
  });

  it('copies a blank cell as an empty string, not the word "null"', () => {
    const ds = setCell(table(), 0, 1, '');
    expect(copyBlock(ds, 0, 0, 0, 3)).toBe('Vehicle\t\t11\t12');
  });

  it('round-trips a copied block through pasteBlock at a new anchor', () => {
    const copied = copyBlock(table(), 0, 1, 1, 3);
    const pasted = pasteBlock(table(), 2, 1, copied);
    expect(pasted.rows[2]).toEqual([null, 10, 11, 12]);
    expect(pasted.rows[3]).toEqual([null, 4, 5, 6]);
  });

  it('clears a rectangle of cells without changing the table shape', () => {
    const cleared = clearBlock(table(), 0, 1, 1, 2);
    // The rectangle is blanked, and blanked to `null` — the same value the
    // parser writes for an empty cell, not the string "null".
    expect(cleared.rows[0]).toEqual(['Vehicle', null, null, 12]);
    expect(cleared.rows[1]).toEqual(['Drug', null, null, 6]);
    // Row and column counts are untouched: clearing is not removing.
    expect(cleared.rows).toHaveLength(table().rows.length);
    expect(cleared.columns).toHaveLength(table().columns.length);
  });

  it('clears a single cell, and accepts its corners in either order', () => {
    expect(clearBlock(table(), 1, 2, 1, 2).rows[1]).toEqual(['Drug', 4, null, 6]);
    // A selection dragged up-and-left names the same rectangle backwards.
    expect(clearBlock(table(), 1, 2, 0, 1).rows[0]).toEqual(['Vehicle', null, null, 12]);
  });

  it('clamps a selection that runs past the table rather than refusing it', () => {
    // Dragging past the last row is ordinary; refusing the whole clear over it
    // would be surprising.
    const cleared = clearBlock(table(), 0, 0, 99, 99);
    expect(cleared.rows.every((r) => r.every((c) => c === null))).toBe(true);
    expect(cleared.rows).toHaveLength(table().rows.length);
  });

  it('leaves a numeric column numeric when every value in it is cleared', () => {
    /*
     * `columnKindFor` reports an entirely blank column as 'number', so clearing
     * one cannot silently retype it and flip the layout the format inference
     * reads off those kinds. Worth pinning: the opposite behaviour would make a
     * Delete keystroke quietly change how the whole table is plotted.
     */
    const cleared = clearBlock(table(), 0, 1, 1, 1);
    expect(cleared.columns[1]?.kind).toBe('number');
  });

  it('returns the same dataset when the selection is already blank', () => {
    // No edit, so no `editedAt` stamp and no undo entry for a keystroke that
    // changed nothing.
    const blank = clearBlock(table(), 0, 1, 1, 2);
    expect(clearBlock(blank, 0, 1, 1, 2)).toBe(blank);
  });

  it('marks the dataset edited, which is what makes an analysis go stale', () => {
    const before = table();
    expect(before.editedAt).toBeUndefined();

    const after = setCell(before, 0, 1, '99');
    expect(after.editedAt).toBeDefined();
    // The hash reads the rows, so the staleness warning fires without any
    // further plumbing.
    const options = { test: 'ttest-welch' as const, correction: 'none' as const };
    expect(analysisInputHash(options, toSeries(after).map((s) => s.values))).not.toBe(
      analysisInputHash(options, toSeries(before).map((s) => s.values)),
    );
  });

  it('writes edits back through one commit, so undo covers them', () => {
    const { doc } = sampleDocument();
    const datasetId = doc.datasets[0]!.id;

    const after = editDocument(doc, (draft) =>
      editDataset(draft, datasetId, (ds) => setCell(ds, 0, 1, '99')),
    );

    expect(after.datasets[0]!.rows[0]![1]).toBe(99);
    // The original is untouched — the transforms are pure.
    expect(doc.datasets[0]!.rows[0]![1]).not.toBe(99);
  });
});

describe('dataset reading', () => {
  it('changes how columns are read without touching the rows', () => {
    const { doc } = sampleDocument();
    const before = doc.datasets[0]!;

    const after = editDocument(doc, (draft) =>
      setDatasetReading(draft, before.id, { format: 'prism', hasRowNames: true }),
    );

    const changed = after.datasets[0]!;
    expect(changed.format).toBe('prism');
    expect(changed.hasRowNames).toBe(true);
    // Lossless and reversible: only the reading moved.
    expect(changed.rows).toEqual(before.rows);
    expect(changed.columns).toEqual(before.columns);
  });
});

// ---------------------------------------------------------------------------
// Group labels
// ---------------------------------------------------------------------------

describe('group labels', () => {
  function oneImagePanel(newId: () => string, doc: FigureDocument, frame = { x: 0, y: 0, width: 60, height: 30 }) {
    return editDocument(doc, (draft) => {
      addAsset(draft, {
        id: `asset-${newId()}`,
        filename: 'tile.png',
        mimeType: 'image/png',
        byteLength: 10,
        naturalPx: { width: 100, height: 100 },
      });
      const asset = draft.assets[draft.assets.length - 1]!;
      addPanelWithImage(draft, newId, {
        frame,
        name: 'Panel',
        assetId: asset.id,
        naturalPx: asset.naturalPx!,
      });
    });
  }

  it('frames a caption on a single image as one member', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = oneImagePanel(newId, base, { x: 5, y: 5, width: 60, height: 30 });
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [image.id], edge: 'top', title: 'Panel a' });
    });
    const label = Object.values(withLabel.nodes).find((n) => n.type === 'group-label') as GroupLabelNode;
    expect(label).toBeDefined();
    expect(label.memberIds).toEqual([image.id]);

    const clearance = groupLabelClearanceMm(undefined, false, undefined);
    /*
     * Sits directly above the *picture*, spanning the picture's width — not
     * the cell's. The panel is 60 × 30 mm holding a square (100 × 100 px)
     * image, so `preserveAspect` letterboxes it to a 30 mm square centred at
     * x = 5 + (60 - 30) / 2 = 20. Framing this against the cell is what used
     * to run a heading's rule out past the edge of the image it labels.
     *
     * The height is the geometry's own clearance formula rather than a
     * literal, so it cannot drift from what `renderGroupLabel` draws against —
     * and it is the *no-rule* clearance now, since a bare heading is the
     * default.
     */
    expect(label.frame).toEqual({ x: 20, y: 5 - clearance, width: 30, height: clearance });
  });

  it('frames a heading spanning two independent panels', () => {
    const { doc, newId } = sampleDocument();
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');
    expect(panels).toHaveLength(2);

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, {
        memberIds: panels.map((p) => p.id),
        edge: 'top',
        title: 'Both panels',
      });
    });
    const label = Object.values(withLabel.nodes).find((n) => n.type === 'group-label') as GroupLabelNode;

    const bounds = {
      x: Math.min(...panels.map((p) => p.frame.x)),
      y: Math.min(...panels.map((p) => p.frame.y)),
      right: Math.max(...panels.map((p) => p.frame.x + p.frame.width)),
    };
    const clearance = groupLabelClearanceMm(undefined, false, undefined);
    expect(label.frame.x).toBeCloseTo(bounds.x, 6);
    expect(label.frame.width).toBeCloseTo(bounds.right - bounds.x, 6);
    expect(label.frame.y).toBeCloseTo(bounds.y - clearance, 6);
  });

  it('follows its members when reflowed, without touching anything else', () => {
    const { doc, newId } = sampleDocument();
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [panels[0]!.id], edge: 'left', title: 'Row' });
    });

    const moved = editDocument(withLabel, (draft) => {
      const target = draft.nodes[panels[0]!.id]!;
      target.frame = { ...target.frame, x: target.frame.x + 15, y: target.frame.y + 4 };
      reflowGroupLabels(draft);
    });

    const label = Object.values(moved.nodes).find((n) => n.type === 'group-label') as GroupLabelNode;
    const panel = moved.nodes[panels[0]!.id]!;
    expect(label.frame.y).toBeCloseTo(panel.frame.y, 6);
    // The *other* panel and its own label never moved.
    const otherPanel = moved.nodes[panels[1]!.id]!;
    expect(otherPanel.frame).toEqual(doc.nodes[panels[1]!.id]!.frame);
  });

  it('grows the gap between two stacked panels for a top heading, translating the lower one', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 120, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    let doc = oneImagePanel(newId, base, { x: 0, y: 0, width: 60, height: 30 });
    doc = oneImagePanel(newId, doc, { x: 0, y: 32, width: 60, height: 30 }); // only 2 mm clear

    const panels = Object.values(doc.nodes)
      .filter((n) => n.type === 'panel')
      .sort((a, b) => a.frame.y - b.frame.y);
    const lowerImage = childImageOf(doc, panels[1]!.id);

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [lowerImage], edge: 'top', title: 'Group B' });
    });

    const reserved = editDocument(withLabel, (draft) => {
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });

    const clearance = groupLabelClearanceMm(undefined, false, undefined);
    const upper = reserved.nodes[panels[0]!.id]!;
    const lower = reserved.nodes[panels[1]!.id]!;
    // The gap between the two panels now equals exactly the clearance the
    // heading needs — not merely "some amount larger than before".
    expect(lower.frame.y - (upper.frame.y + upper.frame.height)).toBeCloseTo(clearance, 6);
    // The upper panel never moved: only what sits at or beyond the heading's
    // own edge is translated.
    expect(upper.frame).toEqual(doc.nodes[panels[0]!.id]!.frame);
  });

  it('does nothing when the existing gap already covers the clearance', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 120, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    let doc = oneImagePanel(newId, base, { x: 0, y: 0, width: 60, height: 30 });
    doc = oneImagePanel(newId, doc, { x: 0, y: 50, width: 60, height: 30 }); // 20 mm clear already

    const panels = Object.values(doc.nodes)
      .filter((n) => n.type === 'panel')
      .sort((a, b) => a.frame.y - b.frame.y);
    const lowerImage = childImageOf(doc, panels[1]!.id);

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [lowerImage], edge: 'top', title: 'Group B' });
    });
    const reserved = editDocument(withLabel, (draft) => reserveSpaceForGroupLabels(draft));

    expect(reserved.nodes[panels[1]!.id]!.frame).toEqual(withLabel.nodes[panels[1]!.id]!.frame);
  });

  it('same-panel headings are excluded from reserveSpaceForGroupLabels — the grid gutter handles them live instead', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const images = Array.from({ length: 2 }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `tile-${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
        return { assetId, naturalPx: { width: 100, height: 100 } };
      });
      addPanelWithImages(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 40 }, name: 'Montage', images, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const tiles = Object.values(doc.nodes).filter((n) => n.type === 'image').sort((a, b) => a.z - b.z);

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [tiles[0]!.id, tiles[1]!.id], edge: 'top', title: 'Row' });
    });

    const reserved = editDocument(withLabel, (draft) => reserveSpaceForGroupLabels(draft));
    // The panel itself never moves for a same-panel heading — its own grid
    // gutter, not a translated sibling, is what makes room.
    expect(reserved.nodes[panel.id]!.frame).toEqual(withLabel.nodes[panel.id]!.frame);
  });

  it('widens a montage panel\'s own grid gutter above a captioned row, live on every re-tile', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const images = Array.from({ length: 4 }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `tile-${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
        return { assetId, naturalPx: { width: 100, height: 100 } };
      });
      addPanelWithImages(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 60 }, name: 'Montage', images, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const plainTiles = Object.values(doc.nodes).filter((n) => n.type === 'image').sort((a, b) => a.z - b.z);

    // Caption the bottom row (indices 2, 3 of a 2×2 grid) with a top heading —
    // the boundary between row 0 and row 1.
    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [plainTiles[2]!.id, plainTiles[3]!.id], edge: 'top', title: 'Treated' });
      const target = draft.nodes[panel.id]!;
      fillPanelChildren(draft, panel.id, target.frame);
    });

    const tiles = Object.values(withLabel.nodes).filter((n) => n.type === 'image').sort((a, b) => a.z - b.z);
    const clearance = groupLabelClearanceMm(undefined, false, undefined);
    // The gap between the two rows now equals the plain gutter plus the
    // heading's own clearance — measured against row 0's *new* bottom edge,
    // which itself sits slightly higher than in the plain layout: the extra
    // boundary space comes out of the shared usable height before it is
    // split evenly between the two equal-weight rows, exactly the way a
    // widened column already does in `gridCells`'s own test above. Nothing
    // outside the panel moved.
    expect(tiles[2]!.frame.y - (tiles[0]!.frame.y + tiles[0]!.frame.height)).toBeCloseTo(2 + clearance, 6);
    expect(tiles[0]!.frame.height).toBeLessThan(plainTiles[0]!.frame.height);
    // The un-captioned column boundary is untouched.
    expect(tiles[1]!.frame.x - (tiles[0]!.frame.x + tiles[0]!.frame.width)).toBeCloseTo(2, 6);
    expect(panel.frame).toEqual(withLabel.nodes[panel.id]!.frame);

    const label = Object.values(withLabel.nodes).find((n) => n.type === 'group-label') as GroupLabelNode;
    expect(label).toBeDefined();
  });

  it('drops a group-label the instant any one member is deleted', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    let doc = oneImagePanel(newId, base, { x: 0, y: 0, width: 60, height: 30 });
    doc = oneImagePanel(newId, doc, { x: 70, y: 0, width: 60, height: 30 });
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: panels.map((p) => p.id), edge: 'top', title: 'Row' });
    });
    expect(Object.values(withLabel.nodes).some((n) => n.type === 'group-label')).toBe(true);

    const afterDelete = editDocument(withLabel, (draft) => deleteNode(draft, panels[0]!.id));
    expect(Object.values(afterDelete.nodes).some((n) => n.type === 'group-label')).toBe(false);
    // The surviving panel is untouched — only the label and the deleted
    // panel are gone.
    expect(afterDelete.nodes[panels[1]!.id]).toBeDefined();
  });

  it('duplicates a caption alongside its sole member, remapped to the copy', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = oneImagePanel(newId, base, { x: 0, y: 0, width: 60, height: 30 });
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [image.id], edge: 'top', title: 'Panel a' });
    });
    const panel = Object.values(withLabel.nodes).find((n) => n.type === 'panel')!;

    const duplicated = editDocument(withLabel, (draft) => {
      duplicateNode(draft, newId, panel.id, { x: 20, y: 0 });
    });
    const labels = Object.values(duplicated.nodes).filter((n) => n.type === 'group-label') as GroupLabelNode[];
    expect(labels).toHaveLength(2);
    const copy = labels.find((l) => l.id !== Object.values(withLabel.nodes).find((n) => n.type === 'group-label')!.id)!;
    const copiedImage = Object.values(duplicated.nodes).find(
      (n) => n.type === 'image' && n.id !== image.id,
    )!;
    // The copy's member is remapped to the *copied* image, not the original.
    expect(copy.memberIds).toEqual([copiedImage.id]);
  });

  it('does not duplicate a heading when only one of its several members is copied', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    let doc = oneImagePanel(newId, base, { x: 0, y: 0, width: 60, height: 30 });
    doc = oneImagePanel(newId, doc, { x: 70, y: 0, width: 60, height: 30 });
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: panels.map((p) => p.id), edge: 'top', title: 'Row' });
    });

    const duplicated = editDocument(withLabel, (draft) => {
      duplicateNode(draft, newId, panels[0]!.id, { x: 0, y: 40 });
    });
    // Still exactly one heading — a lone duplicated panel is left uncaptioned
    // rather than either joining the original heading or being refused.
    expect(Object.values(duplicated.nodes).filter((n) => n.type === 'group-label')).toHaveLength(1);
  });

  it('round-trips through save/load with no schema version bump', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = oneImagePanel(newId, base, { x: 0, y: 0, width: 60, height: 30 });
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [image.id], edge: 'left', title: 'Caption' });
    });

    expect(checkReferentialIntegrity(withLabel)).toEqual([]);
    const loaded = loadArchive(saveArchive(buildArchiveContents(withLabel)));
    const label = Object.values(loaded.document.nodes).find((n) => n.type === 'group-label') as GroupLabelNode;
    expect(label.title).toBe('Caption');
    expect(label.memberIds).toEqual([image.id]);
    expect(label.edge).toBe('left');
  });

  /*
   * Two lettered panels stacked with a generous gap, on a page with room to
   * spare, so each test below can choose whether it wants the shrink path.
   */
  function twoLetteredPanels(heightMm: number, gapMm = 20) {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const doc = editDocument(base, (draft) => {
      addPanel(draft, newId, { frame: { x: 2, y: 2, width: 60, height: 40 }, name: 'Top' });
      addPanel(draft, newId, {
        frame: { x: 2, y: 42 + gapMm, width: 60, height: 40 },
        name: 'Bottom',
      });
      relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
    });
    const panels = Object.values(doc.nodes)
      .filter((n) => n.type === 'panel')
      .sort((a, b) => a.frame.y - b.frame.y);
    return { doc, newId, panels };
  }

  const letterOf = (doc: FigureDocument, panelId: string) =>
    Object.values(doc.nodes).find(
      (n): n is Extract<FigureNode, { type: 'panel-label' }> =>
        n.type === 'panel-label' && n.panelId === panelId,
    )!;

  it('reserves against the page edge for a heading with no panel above it', () => {
    /*
     * The reported defect. `reserveSpaceForGroupLabels` measured the gap to the
     * nearest panel on the heading's side and gave up when there was none —
     * which is exactly the top row, so the case that most needs space reserved
     * reserved none and the heading was drawn above the page's own top edge.
     *
     * The band required is the heading's extent *plus* the panel letter's line
     * height, because the letter is lifted to sit above the heading.
     */
    const { doc, newId, panels } = twoLetteredPanels(200);
    const top = panels[0]!;

    const after = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [top.id], edge: 'top', title: 'Group' });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });

    const letter = letterOf(after, top.id);
    const needed =
      groupLabelClearanceMm(undefined, false, undefined) +
      panelLetterHeightMm(letter.style.fontSizePt);
    // The panel moved down by exactly the shortfall — its top was at the page
    // margin, so the whole band had to be made.
    expect(after.nodes[top.id]!.frame.y).toBeCloseTo(top.frame.y + needed, 6);
  });

  it('reserves against the page edge even when the heading’s panel has been grouped with another', () => {
    /*
     * Reported from real use through the AI layout helper, but reproducible
     * with no AI at all: grouping a headed top-row panel with another panel
     * anywhere else on the page, then triggering a from-scratch layout, left
     * the heading — and the letter lifted above it — drawn over the page's
     * own top edge. Two compounding causes, both in
     * `reserveSpaceForGroupLabels`:
     *
     *   - `letterMm` resolved each member via `topLevelOwner`, whose answer
     *     for a grouped panel is the *group*, never `type === 'panel'` — so
     *     the panel's own letter-clearance need was silently counted as
     *     zero, and the reservation was short by exactly that much.
     *   - the pushable candidate list was top-level *panels* only, so even
     *     with the right shortfall computed, the grouped panel itself could
     *     never be one of the things moved to make room for it.
     *
     * Both are fixed via `layoutUnits`/`panelOwning`, the same abstraction
     * the smart-layout solver already uses for "the top-level thing that
     * moves, panel or group."
     */
    const { doc, newId, panels } = twoLetteredPanels(200);
    const top = panels[0]!;

    const withThird = editDocument(doc, (draft) => {
      addPanel(draft, newId, { frame: { x: 100, y: 150, width: 40, height: 30 }, name: 'Elsewhere' });
    });
    const elsewhere = Object.values(withThird.nodes).find(
      (n) => n.type === 'panel' && n.id !== top.id && n.id !== panels[1]!.id,
    )!;
    const grouped = editDocument(withThird, (draft) => {
      addGroup(draft, newId, [top.id, elsewhere.id]);
    });
    // Grouping alone must not move anything — round 21's own guarantee.
    expect(absoluteFrame(grouped.nodes, top.id)).toEqual(absoluteFrame(doc.nodes, top.id));

    const after = editDocument(grouped, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [top.id], edge: 'top', title: 'Group' });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });

    const letter = letterOf(after, top.id);
    const needed =
      groupLabelClearanceMm(undefined, false, undefined) +
      panelLetterHeightMm(letter.style.fontSizePt);
    const topBefore = absoluteFrame(grouped.nodes, top.id)!;
    const topAfter = absoluteFrame(after.nodes, top.id)!;

    // The grouped panel moved down by exactly the shortfall, the identical
    // amount an ungrouped panel would — not left in place with nothing
    // reserved for it.
    expect(topAfter.y).toBeCloseTo(topBefore.y + needed, 6);
    // And the letter sits at a real, on-page position, not lifted off the
    // top of it.
    expect(letter.frame.y).toBeGreaterThanOrEqual(0);
  });

  it('puts the panel letter above the heading, and the heading above the graph', () => {
    const { doc, newId, panels } = twoLetteredPanels(200);
    const top = panels[0]!;

    const after = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [top.id], edge: 'top', title: 'Group' });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });

    const letter = letterOf(after, top.id);
    const heading = Object.values(after.nodes).find(
      (n) => n.type === 'group-label',
    ) as GroupLabelNode;
    const panel = after.nodes[top.id]!;

    // Reading down the page: letter, heading, graph — and nothing off the page.
    expect(letter.frame.y).toBeGreaterThanOrEqual(0);
    expect(letter.frame.y + panelLetterHeightMm(letter.style.fontSizePt)).toBeLessThanOrEqual(
      heading.frame.y + 1e-6,
    );
    expect(heading.frame.y + heading.frame.height).toBeLessThanOrEqual(panel.frame.y + 1e-6);
    // The letter itself did not move: it was already at the top, and it is the
    // page below it that was pushed down.
    expect(letter.frame.y).toBeCloseTo(letterOf(doc, top.id).frame.y, 6);
  });

  it('reserves once and then leaves the page alone', () => {
    // Every from-scratch layout path runs this, so a second pass that moved
    // anything would creep the figure down the page on every import or delete.
    const { doc, newId, panels } = twoLetteredPanels(200);
    const once = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [panels[0]!.id], edge: 'top', title: 'Group' });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });
    const twice = editDocument(once, (draft) => {
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });
    for (const panel of panels) {
      expect(twice.nodes[panel.id]!.frame).toEqual(once.nodes[panel.id]!.frame);
    }
    expect(letterOf(twice, panels[0]!.id).frame).toEqual(letterOf(once, panels[0]!.id).frame);
  });

  it('puts the letter back exactly when the heading goes away', () => {
    const { doc, newId, panels } = twoLetteredPanels(200);
    const top = panels[0]!;
    const before = letterOf(doc, top.id).frame.y;

    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [top.id], edge: 'top', title: 'Group' });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });
    const heading = Object.values(withLabel.nodes).find((n) => n.type === 'group-label')!;
    expect(letterOf(withLabel, top.id).liftMm).toBeGreaterThan(0);

    const removed = editDocument(withLabel, (draft) => {
      deleteNode(draft, heading.id);
      reflowGroupLabels(draft);
    });
    // The panel stays where the reservation put it — nothing un-pushes a page —
    // but the letter returns to its own panel's top, with no lift left over.
    const letter = letterOf(removed, top.id);
    expect(letter.liftMm).toBeUndefined();
    expect(letter.frame.y).toBeCloseTo(removed.nodes[top.id]!.frame.y, 6);
    expect(letter.frame.y).toBeGreaterThan(before);
  });

  it('keeps a letter that was nudged by hand', () => {
    /*
     * Why the lift is stored rather than recomputed. `reflowGroupLabels` runs
     * after every canvas drag, so setting `frame.y` outright would snap a
     * hand-placed letter back to its panel on the author's next move.
     */
    const { doc, newId, panels } = twoLetteredPanels(200);
    const top = panels[0]!;

    const caption = (source: FigureDocument) =>
      editDocument(source, (draft) => {
        addGroupLabel(draft, newId, { memberIds: [top.id], edge: 'top', title: 'Group' });
        reserveSpaceForGroupLabels(draft);
        reflowGroupLabels(draft);
      });

    const nudged = editDocument(doc, (draft) => {
      const letter = Object.values(draft.nodes).find(
        (n) => n.type === 'panel-label' && n.panelId === top.id,
      )!;
      letter.frame = { ...letter.frame, x: letter.frame.x - 3, y: letter.frame.y - 1 };
    });

    // Against the same figure captioned without the nudge: the difference
    // between the two is exactly the nudge, on both axes, and nothing else.
    const plain = letterOf(caption(doc), top.id).frame;
    const moved = letterOf(caption(nudged), top.id).frame;
    expect(moved.x).toBeCloseTo(plain.x - 3, 6);
    expect(moved.y).toBeCloseTo(plain.y - 1, 6);
  });

  it('shrinks the pushed rows rather than walking them off the page', () => {
    /*
     * "Push the rest down, shrink only if needed" — and on a tight page the
     * shrink is the common path, not a rare branch. Growing the page instead
     * was refused: a caption silently making a figure taller can breach a
     * journal's maximum.
     */
    const { doc, newId, panels } = twoLetteredPanels(90, 5);
    const heightBefore = doc.page.heightMm;

    const after = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [panels[0]!.id], edge: 'top', title: 'Group' });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });

    const margin = 2;
    const lowest = Math.max(
      ...panels.map((p) => after.nodes[p.id]!.frame.y + after.nodes[p.id]!.frame.height),
    );
    expect(after.page.heightMm).toBe(heightBefore);
    expect(lowest).toBeLessThanOrEqual(after.page.heightMm - margin + 1e-6);
    for (const panel of panels) {
      expect(after.nodes[panel.id]!.frame.height).toBeGreaterThanOrEqual(MIN_TILE_MM);
      expect(after.nodes[panel.id]!.frame.height).toBeLessThan(panel.frame.height);
    }
  });

  it('moves a pushed-and-shrunk panel’s letter by exactly as far as the panel itself, not twice as far', () => {
    /*
     * Reported from real use: applying a smart-layout candidate on the
     * sample figure left panel g's and h's letters far above their own
     * panels, sometimes over a different row entirely. Traced to
     * `pushPanelsFrom`'s shrink loop (the branch the test above already
     * exercises): it called `resizePanel`, which already carries a panel's
     * label along by its own dx/dy shim, and then *also* called
     * `syncPanelLabelsFromSnapshot` for the identical move — every panel
     * the shrink pass touches had its letter shifted twice for one resize.
     * `panels[1]` here names no heading of its own, so this isolates the
     * defect from any legitimate heading-lift: its letter should simply
     * track its panel through the push-then-shrink pass, at whatever offset
     * it already had, not accumulate a second, spurious shift.
     */
    const { doc, newId, panels } = twoLetteredPanels(90, 5);
    const bottom = panels[1]!;
    const offsetBefore = letterOf(doc, bottom.id).frame.y - doc.nodes[bottom.id]!.frame.y;

    const after = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [panels[0]!.id], edge: 'top', title: 'Group' });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });

    // The panel really did move (the test above already proves the shrink
    // engaged), so a passing offset check here is not vacuous.
    expect(after.nodes[bottom.id]!.frame.y).not.toBeCloseTo(doc.nodes[bottom.id]!.frame.y, 3);
    const offsetAfter = letterOf(after, bottom.id).frame.y - after.nodes[bottom.id]!.frame.y;
    expect(offsetAfter).toBeCloseTo(offsetBefore, 6);
  });

  it('lifts no letter for a caption that sits inside its panel', () => {
    // A montage cell caption is drawn in the panel's own grid gutter, below the
    // panel's top edge, so the panel letter is not in its way.
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 120, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const images = Array.from({ length: 2 }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `t${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
        return { assetId, naturalPx: { width: 100, height: 100 } };
      });
      addPanelWithImages(draft, newId, { frame: { x: 2, y: 2, width: 120, height: 60 }, name: 'Montage', images, gutterMm: 2 });
      relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const tile = Object.values(doc.nodes).filter((n) => n.type === 'image').sort((a, b) => a.z - b.z)[0]!;

    const after = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [tile.id], edge: 'top', title: 'Cell' });
      fillPanelChildren(draft, panel.id, panel.frame);
      reflowGroupLabels(draft);
    });
    expect(letterOf(after, panel.id).liftMm).toBeUndefined();
    expect(letterOf(after, panel.id).frame.y).toBeCloseTo(letterOf(doc, panel.id).frame.y, 6);
  });

  it('lifts only the letters in the heading’s own row, not every member wherever it ended up', () => {
    /*
     * Reported from real use of the AI layout helper, but reproducible with
     * no AI involved at all: apply *any* smart-layout candidate other than
     * the one a heading's members were originally positioned for, and a
     * top-edge heading spanning members that end up in different rows used
     * to lift *every* member toward its own band — including one nowhere
     * near it, whose letter went as far as off the top of the page. The
     * heading's own frame is the union of its members' boxes, so "below the
     * heading's own y" was true for a member in a lower row too; only a
     * member sharing the heading's own topmost row is one it is actually
     * drawn above.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 150,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const doc = editDocument(base, (draft) => {
      addPanel(draft, newId, { frame: { x: 2, y: 20, width: 60, height: 40 }, name: 'Row 1 left' });
      addPanel(draft, newId, { frame: { x: 70, y: 20, width: 60, height: 40 }, name: 'Row 1 right' });
      addPanel(draft, newId, { frame: { x: 2, y: 100, width: 60, height: 40 }, name: 'Row 2' });
      relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
    });
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');
    const rowOneLeft = panels.find((p) => p.frame.y === 20 && p.frame.x === 2)!;
    const rowOneRight = panels.find((p) => p.frame.y === 20 && p.frame.x === 70)!;
    const rowTwo = panels.find((p) => p.frame.y === 100)!;

    const after = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, {
        memberIds: [rowOneLeft.id, rowOneRight.id, rowTwo.id],
        edge: 'top',
        title: 'Heading',
      });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });

    // The row the heading is genuinely drawn above is lifted...
    expect(letterOf(after, rowOneLeft.id).liftMm).toBeGreaterThan(0);
    expect(letterOf(after, rowOneRight.id).liftMm).toBeGreaterThan(0);
    // ...and the member in a different row is not touched at all: its letter
    // stays exactly where its own panel puts it, not lifted toward a band
    // drawn nowhere near it.
    expect(letterOf(after, rowTwo.id).liftMm).toBeUndefined();
    expect(letterOf(after, rowTwo.id).frame.y).toBeCloseTo(letterOf(doc, rowTwo.id).frame.y, 6);
  });

  it('still lifts a heading’s member once it has been grouped with an unrelated panel', () => {
    /*
     * The specific case real use hit: grouping two panels a heading already
     * names. `topLevelOwner` resolves a grouped panel's *top-level ancestor*
     * to the group, not the panel — so a member that is now inside a group
     * was silently dropped from `reflowPanelLetterLifts`'s consideration
     * entirely, which read as the panel's letter no longer being lifted
     * (`liftMm` reset to zero) even though the heading is still genuinely
     * drawn above it. `panelOwning` resolves through any grouping to the
     * panel itself.
     */
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 150,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const doc = editDocument(base, (draft) => {
      addPanel(draft, newId, { frame: { x: 2, y: 20, width: 60, height: 40 }, name: 'Headed' });
      addPanel(draft, newId, { frame: { x: 70, y: 20, width: 60, height: 40 }, name: 'Also headed' });
      addPanel(draft, newId, { frame: { x: 2, y: 100, width: 60, height: 40 }, name: 'Elsewhere' });
      relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
    });
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');
    const headed = panels.find((p) => p.frame.x === 2 && p.frame.y === 20)!;
    const alsoHeaded = panels.find((p) => p.frame.x === 70)!;
    const elsewhere = panels.find((p) => p.frame.y === 100)!;

    const withHeading = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, {
        memberIds: [headed.id, alsoHeaded.id],
        edge: 'top',
        title: 'Heading',
      });
      reserveSpaceForGroupLabels(draft);
      reflowGroupLabels(draft);
    });
    const liftBeforeGrouping = letterOf(withHeading, headed.id).liftMm;
    expect(liftBeforeGrouping).toBeGreaterThan(0);

    // Group the headed panel with the unrelated one elsewhere on the page —
    // `addGroup` does not move either panel (round 21's own guarantee), so
    // the heading's real geometric relationship to `headed` is unchanged.
    const grouped = editDocument(withHeading, (draft) => {
      addGroup(draft, newId, [headed.id, elsewhere.id]);
      reflowGroupLabels(draft);
    });

    expect(letterOf(grouped, headed.id).liftMm).toBeCloseTo(liftBeforeGrouping!, 6);
  });

  it('knows which headings could be overlaid on their content', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 120, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addAsset(draft, { id: 'a1', filename: 't.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
      addPanelWithImage(draft, newId, { frame: { x: 2, y: 2, width: 60, height: 40 }, name: 'Pic', assetId: 'a1', naturalPx: { width: 100, height: 100 } });
      addPanel(draft, newId, { frame: { x: 70, y: 2, width: 60, height: 40 }, name: 'Plain' });
    });
    const imagePanel = Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === 'Pic')!;
    const plainPanel = Object.values(doc.nodes).find((n) => n.type === 'panel' && n.name === 'Plain')!;
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;

    expect(groupLabelMembersAreImages(doc.nodes, [image.id])).toBe(true);
    expect(groupLabelMembersAreImages(doc.nodes, [imagePanel.id])).toBe(true);
    // A panel with no image children has nothing to overlay a heading onto.
    expect(groupLabelMembersAreImages(doc.nodes, [plainPanel.id])).toBe(false);
    expect(groupLabelMembersAreImages(doc.nodes, [image.id, plainPanel.id])).toBe(false);
    expect(groupLabelMembersAreImages(doc.nodes, [])).toBe(false);
  });

  it('refuses a group-label with no members at the referential-integrity check', () => {
    const bad = {
      nodes: {
        gl1: { id: 'gl1', parentId: null, layerId: 'l1', type: 'group-label', memberIds: [] as string[] },
      },
      layers: [{ id: 'l1' }],
      datasets: [],
      assets: [],
      analyses: [],
    };
    const issues = checkReferentialIntegrity(bad);
    expect(issues.some((i) => i.path === 'nodes.gl1.memberIds')).toBe(true);
  });
});

/** The single image child of a panel, for group-label member tests. */
function childImageOf(doc: FigureDocument, panelId: string): string {
  return Object.values(doc.nodes).find((n) => n.type === 'image' && n.parentId === panelId)!.id;
}

// ---------------------------------------------------------------------------
// Per-cell montage image upload/replace
// ---------------------------------------------------------------------------

describe('per-cell montage image upload', () => {
  function emptyMontage(rows: number, cols: number) {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addEmptyMontagePanel(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 40 }, name: 'Montage', rows, cols, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    return { doc, panel, newId };
  }

  function withAsset(doc: FigureDocument, newId: () => string, filename: string) {
    return editDocument(doc, (draft) => {
      addAsset(draft, { id: `${filename}-asset`, filename, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
    });
  }

  it('starts with an empty grid and no children', () => {
    const { doc, panel } = emptyMontage(2, 2);
    // `autoFit` is on for montages made from here on: the panel keeps the
    // shape that lets its pictures fill their cells. Existing figures carry no
    // such flag and are left exactly as they were.
    expect(panel.type === 'panel' && panel.contentGrid).toEqual({
      rows: 2,
      cols: 2,
      gutterMm: 2,
      autoFit: true,
    });
    expect(Object.values(doc.nodes).filter((n) => n.parentId === panel.id)).toHaveLength(0);
  });

  it('fills cells one at a time, each new tile landing in the next empty slot', () => {
    /*
     * Cells are addressed purely by z-order — the same "children take cells
     * in z order" rule `fillPanelChildren` has always followed — so there is
     * no way to leave a gap in the middle: an index beyond the current child
     * count always lands in the next still-empty slot, whichever cell button
     * the author actually clicked. That is a real, load-bearing constraint of
     * this model, not a defect — every empty cell looks identical anyway, so
     * "fill the next one" is indistinguishable from "fill this one" until a
     * cell is already occupied, at which point the same index instead
     * replaces it (covered separately below).
     */
    const initial = emptyMontage(2, 2);
    const { panel, newId } = initial;
    let doc = initial.doc;
    doc = withAsset(doc, newId, 'b.png');
    doc = withAsset(doc, newId, 'a.png');

    doc = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 3, { assetId: 'b.png-asset', naturalPx: { width: 100, height: 100 } });
    });
    doc = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 3, { assetId: 'a.png-asset', naturalPx: { width: 100, height: 100 } });
    });

    const tiles = Object.values(doc.nodes)
      .filter((n) => n.type === 'image')
      .sort((a, b) => a.z - b.z);
    expect(tiles).toHaveLength(2);
    expect(tiles[0]!.type === 'image' && tiles[0]!.assetId).toBe('b.png-asset');
    expect(tiles[1]!.type === 'image' && tiles[1]!.assetId).toBe('a.png-asset');
    // Distinct, non-degenerate frames — each really did land in its own cell.
    expect(new Set(tiles.map((t) => `${t.frame.x},${t.frame.y}`)).size).toBe(2);
  });

  it('replaces an existing tile in place, keeping its neighbours untouched', () => {
    const initial = emptyMontage(1, 2);
    const { panel, newId } = initial;
    let doc = initial.doc;
    doc = withAsset(doc, newId, 'a.png');
    doc = withAsset(doc, newId, 'b.png');
    doc = withAsset(doc, newId, 'c.png');
    doc = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'a.png-asset', naturalPx: { width: 100, height: 100 } });
    });
    doc = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 1, { assetId: 'b.png-asset', naturalPx: { width: 100, height: 100 } });
    });
    const before = Object.values(doc.nodes).filter((n) => n.type === 'image').sort((a, b) => a.z - b.z);

    const replaced = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'c.png-asset', naturalPx: { width: 100, height: 100 } });
    });
    const after = Object.values(replaced.nodes).filter((n) => n.type === 'image').sort((a, b) => a.z - b.z);

    expect(after).toHaveLength(2);
    expect(after[0]!.type === 'image' && after[0]!.assetId).toBe('c.png-asset');
    // The untouched neighbour keeps its own asset and its own frame.
    expect(after[1]!.type === 'image' && after[1]!.assetId).toBe('b.png-asset');
    expect(after[1]!.frame).toEqual(before[1]!.frame);
  });

  it('re-derives a scale bar calibrated to a tile that was just replaced', () => {
    const initial = emptyMontage(1, 1);
    const { panel, newId } = initial;
    let doc = initial.doc;
    doc = withAsset(doc, newId, 'a.png');
    doc = withAsset(doc, newId, 'b.png');
    doc = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'a.png-asset', naturalPx: { width: 200, height: 100 } });
    });
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    doc = editDocument(doc, (draft) => {
      addScaleBar(draft, newId, {
        imageId: image.id,
        length: 10,
        pixelsPerUnit: 20,
        unitLabel: 'µm',
        calibrationSource: 'manual',
        fontSizePt: 6,
      });
    });
    const bar = Object.values(doc.nodes).find((n) => n.type === 'scale-bar')!;
    const before = scaleBarWidthMm(doc.nodes, bar.id);

    // A wider natural pixel size at the same physical frame means the same
    // real-world length now spans fewer millimetres.
    const replaced = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'b.png-asset', naturalPx: { width: 400, height: 100 } });
    });
    const after = scaleBarWidthMm(replaced.nodes, bar.id);
    expect(after).not.toBeCloseTo(before!, 6);
    // resyncScaleBars keeps frame.width in step with the derived value.
    const barNode = replaced.nodes[bar.id]!;
    expect(barNode.frame.width).toBeCloseTo(after!, 6);
  });

  it('refuses an out-of-range cell index', () => {
    const { doc, panel, newId } = emptyMontage(1, 2);
    const result = editDocument(doc, (draft) =>
      setMontageCellImage(draft, newId, panel.id, 2, { assetId: 'nope', naturalPx: { width: 1, height: 1 } }),
    );
    // Nothing was added — the document is unchanged.
    expect(Object.values(result.nodes).filter((n) => n.type === 'image')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Round 32 — image alignment, montage cell geometry, stacked headings,
// heading clearance
// ---------------------------------------------------------------------------

describe('fitAspectAligned', () => {
  // A 2:1 picture in a square box letterboxes vertically: 20 wide, 10 tall,
  // leaving 10 mm of spare height that has to be placed somewhere.
  const box = { x: 0, y: 0, width: 20, height: 20 };

  it('centres on both axes by default, and fitAspect is exactly that', () => {
    expect(fitAspectAligned(box, 2, 'middle', 'middle')).toEqual({ x: 0, y: 5, width: 20, height: 10 });
    expect(fitAspect(box, 2)).toEqual(fitAspectAligned(box, 2, 'middle', 'middle'));
  });

  it('puts the picture against the top for alignY start — the montage default', () => {
    expect(fitAspectAligned(box, 2, 'middle', 'start')).toEqual({ x: 0, y: 0, width: 20, height: 10 });
  });

  it('puts the picture against the bottom for alignY end', () => {
    expect(fitAspectAligned(box, 2, 'middle', 'end')).toEqual({ x: 0, y: 10, width: 20, height: 10 });
  });

  it('aligns horizontally when the spare space is on that axis instead', () => {
    // A 1:2 picture in the same square box letterboxes horizontally.
    expect(fitAspectAligned(box, 0.5, 'start', 'middle').x).toBeCloseTo(0, 6);
    expect(fitAspectAligned(box, 0.5, 'end', 'middle').x).toBeCloseTo(10, 6);
    expect(fitAspectAligned(box, 0.5, 'middle', 'middle').x).toBeCloseTo(5, 6);
  });

  it('returns the box untouched for a degenerate aspect, as fitAspect always did', () => {
    expect(fitAspectAligned(box, 0, 'start', 'start')).toEqual(box);
  });
});

describe('montage image alignment', () => {
  function montageOf(count: number) {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const images = Array.from({ length: count }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `tile-${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 200, height: 100 } });
        return { assetId, naturalPx: { width: 200, height: 100 } };
      });
      addPanelWithImages(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 40 }, name: 'Montage', images, gutterMm: 2 });
    });
    return { doc, newId };
  }

  it('top-aligns every tile of a real montage', () => {
    const { doc } = montageOf(4);
    const tiles = Object.values(doc.nodes).filter((n) => n.type === 'image');
    expect(tiles).toHaveLength(4);
    // A tile's frame comes from `gridCells` and has nothing to do with the
    // micrograph's own shape, so the letterboxing is real and has to be placed.
    for (const tile of tiles) expect(tile.type === 'image' && tile.alignY).toBe('start');
  });

  it('leaves a lone image un-aligned, so every existing one-image panel is byte-identical', () => {
    const { doc } = montageOf(1);
    const tile = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    // Absent rather than an explicit 'middle': writing a value would set a
    // field on every figure whose author never asked for one.
    expect(tile.type === 'image' && tile.alignY).toBeUndefined();
    expect(tile.type === 'image' && tile.alignX).toBeUndefined();
  });

  it('top-aligns a tile uploaded into an empty cell, and keeps the chosen alignment on replace', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    let doc = editDocument(base, (draft) => {
      addEmptyMontagePanel(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 40 }, name: 'Montage', rows: 1, cols: 2, gutterMm: 2 });
      addAsset(draft, { id: 'a', filename: 'a.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 200, height: 100 } });
      addAsset(draft, { id: 'b', filename: 'b.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 200, height: 100 } });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;

    doc = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'a', naturalPx: { width: 200, height: 100 } });
    });
    const tile = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    expect(tile.type === 'image' && tile.alignY).toBe('start');

    // Move it to the bottom, then replace the picture: the alignment belongs
    // to the cell the author arranged, not to the file that sits in it.
    doc = editDocument(doc, (draft) => {
      const target = draft.nodes[tile.id];
      if (target?.type === 'image') target.alignY = 'end';
    });
    doc = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'b', naturalPx: { width: 300, height: 100 } });
    });
    const replaced = doc.nodes[tile.id]!;
    expect(replaced.type === 'image' && replaced.alignY).toBe('end');
    expect(replaced.type === 'image' && replaced.assetId).toBe('b');
  });

  it('keeps alignX/alignY through a save, with SCHEMA_VERSION unchanged', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addAsset(draft, { id: 'a', filename: 'a.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
      addPanelWithImage(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 30 },
        name: 'Panel',
        assetId: 'a',
        naturalPx: { width: 100, height: 100 },
      });
    });
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    const aligned = editDocument(doc, (draft) => {
      const target = draft.nodes[image.id];
      if (target?.type === 'image') {
        target.alignX = 'end';
        target.alignY = 'start';
      }
    });

    // zod strips a key present only on the TS type, so the round-trip is the
    // assertion that matters here, not the field simply being assignable.
    const loaded = loadArchive(saveArchive(buildArchiveContents(aligned)));
    expect(loaded.document).toEqual(aligned);
    const node = loaded.document.nodes[image.id]!;
    expect(node.type === 'image' && node.alignX).toBe('end');
    expect(node.type === 'image' && node.alignY).toBe('start');
  });
});

describe('montageCellRects', () => {
  function montage(rows: number, cols: number) {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addEmptyMontagePanel(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 40 }, name: 'Montage', rows, cols, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    return { doc, panel, newId };
  }

  it('returns one rect per declared cell even with no tiles at all', () => {
    const { doc, panel } = montage(2, 2);
    // This is what the renderer draws its dashed placeholders from: an empty
    // montage has to show four outlines, not nothing at all.
    expect(montageCellRects(doc, panel.id, panel.frame)).toHaveLength(4);
  });

  it('agrees exactly with the frames fillPanelChildren hands the tiles', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const images = Array.from({ length: 4 }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `t${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
        return { assetId, naturalPx: { width: 100, height: 100 } };
      });
      addPanelWithImages(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 40 }, name: 'Montage', images, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const cells = montageCellRects(doc, panel.id, panel.frame)!;
    const tiles = montageTiles(doc.nodes, panel.id);

    // One derivation read twice. An outline promising a position the tile then
    // failed to take would be exactly the round-6 crop bug over again.
    tiles.forEach((tile, index) => expect(tile.frame).toEqual(cells[index]));
  });

  it('returns null for a panel with no grid, and for one too small for its grid', () => {
    const { doc, panel } = montage(2, 2);
    const noGrid = editDocument(doc, (draft) => {
      const target = draft.nodes[panel.id];
      if (target?.type === 'panel') target.contentGrid = undefined;
    });
    expect(montageCellRects(noGrid, panel.id, panel.frame)).toBeNull();

    // Below MIN_TILE_MM per cell the renderer draws no placeholders rather
    // than degenerate slivers — the same stance `fillPanelChildren` takes.
    expect(montageCellRects(doc, panel.id, { x: 0, y: 0, width: 6, height: 6 })).toBeNull();
  });
});

describe('stacked group labels', () => {
  /** A 1×3 montage — a row of three tiles inside one panel. */
  function rowOfThree() {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const images = Array.from({ length: 3 }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `t${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
        return { assetId, naturalPx: { width: 100, height: 100 } };
      });
      addPanelWithImages(draft, newId, { frame: { x: 0, y: 10, width: 90, height: 40 }, name: 'Montage', images, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const tiles = montageTiles(doc.nodes, panel.id);
    return { doc, panel, tiles, newId };
  }

  it('sits a single-tile caption underneath the heading spanning its whole row', () => {
    const { doc, panel, tiles, newId } = rowOfThree();

    const withBoth = editDocument(doc, (draft) => {
      // The wide heading first, then the caption on one tile — creation order
      // must not be what decides which one ends up on top.
      addGroupLabel(draft, newId, { memberIds: tiles.map((t) => t.id), edge: 'top', title: 'Treatment' });
      addGroupLabel(draft, newId, { memberIds: [tiles[1]!.id], edge: 'top', title: 'Middle' });
      const target = draft.nodes[panel.id]!;
      fillPanelChildren(draft, panel.id, target.frame);
      reflowGroupLabels(draft);
    });

    const labels = Object.values(withBoth.nodes).filter(
      (n): n is GroupLabelNode => n.type === 'group-label',
    );
    const wide = labels.find((l) => l.memberIds.length === 3)!;
    const caption = labels.find((l) => l.memberIds.length === 1)!;
    const clearance = groupLabelClearanceMm(undefined, false, undefined);

    // The caption takes the space nearest its tile and the wide heading stacks
    // above it. Without this rule both are drawn in the same millimetres.
    expect(caption.frame.y).toBeGreaterThan(wide.frame.y);
    expect(wide.frame.y + wide.frame.height).toBeCloseTo(caption.frame.y, 6);
    expect(groupLabelExtentMm(withBoth.nodes, caption)).toBeCloseTo(clearance, 6);
    expect(groupLabelExtentMm(withBoth.nodes, wide)).toBeCloseTo(2 * clearance, 6);
  });

  it('gives the row enough gutter for both, not just for the taller one', () => {
    const { doc, panel, tiles, newId } = rowOfThree();
    const clearance = groupLabelClearanceMm(undefined, false, undefined);

    const headingOnly = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: tiles.map((t) => t.id), edge: 'top', title: 'Treatment' });
      const target = draft.nodes[panel.id]!;
      fillPanelChildren(draft, panel.id, target.frame);
    });
    const oneLevel = montageTiles(headingOnly.nodes, panel.id)[0]!.frame.y;

    const both = editDocument(headingOnly, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [tiles[1]!.id], edge: 'top', title: 'Middle' });
      const target = draft.nodes[panel.id]!;
      fillPanelChildren(draft, panel.id, target.frame);
    });
    const twoLevels = montageTiles(both.nodes, panel.id)[0]!.frame.y;

    // The boundary grows by a second clearance — the sum, not the max. A max
    // is what would have drawn the caption on top of the heading.
    expect(twoLevels - oneLevel).toBeCloseTo(clearance, 6);
  });

  it('does not stack captions on different tiles of the same row against each other', () => {
    const { doc, panel, tiles, newId } = rowOfThree();

    const captioned = editDocument(doc, (draft) => {
      for (const tile of tiles) {
        addGroupLabel(draft, newId, { memberIds: [tile.id], edge: 'top', title: tile.id });
      }
      const target = draft.nodes[panel.id]!;
      fillPanelChildren(draft, panel.id, target.frame);
      reflowGroupLabels(draft);
    });

    const labels = Object.values(captioned.nodes).filter(
      (n): n is GroupLabelNode => n.type === 'group-label',
    );
    expect(labels).toHaveLength(3);
    // Three captions over three tiles are one level: they sit side by side,
    // never in a staircase. Equal member counts never stack.
    expect(new Set(labels.map((l) => Math.round(l.frame.y * 1000))).size).toBe(1);
  });

  it('ignores a heading over a different row entirely', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const images = Array.from({ length: 4 }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `t${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
        return { assetId, naturalPx: { width: 100, height: 100 } };
      });
      addPanelWithImages(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 60 }, name: 'Montage', images, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const tiles = montageTiles(doc.nodes, panel.id);

    const withBoth = editDocument(doc, (draft) => {
      // Row 0 spanned, plus a caption on a row 1 tile: different lines, so
      // neither takes any room from the other.
      addGroupLabel(draft, newId, { memberIds: [tiles[0]!.id, tiles[1]!.id], edge: 'top', title: 'Row 0' });
      addGroupLabel(draft, newId, { memberIds: [tiles[2]!.id], edge: 'top', title: 'One of row 1' });
      const target = draft.nodes[panel.id]!;
      fillPanelChildren(draft, panel.id, target.frame);
      reflowGroupLabels(draft);
    });

    const caption = Object.values(withBoth.nodes).find(
      (n): n is GroupLabelNode => n.type === 'group-label' && n.memberIds.length === 1,
    )!;
    expect(groupLabelExtentMm(withBoth.nodes, caption)).toBeCloseTo(
      groupLabelClearanceMm(undefined, false, undefined),
      6,
    );
  });
});

describe('group-label gap override', () => {
  it('reads gapMm in place of the default, grows the frame, and survives a save', () => {
    const base = groupLabelClearanceMm(8, true, 0.35);
    const wider = groupLabelClearanceMm(8, true, 0.35, GROUP_LABEL_GAP_MM + 3);
    // The gap is the only term that changed, so the difference is exactly it.
    expect(wider - base).toBeCloseTo(3, 6);

    const newId = createIdFactory();
    const start = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(start, (draft) => {
      addAsset(draft, { id: 'gap-asset', filename: 'g.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
      addPanelWithImage(draft, newId, {
        frame: { x: 5, y: 20, width: 60, height: 30 },
        name: 'Panel',
        assetId: 'gap-asset',
        naturalPx: { width: 100, height: 100 },
      });
    });
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;

    const withLabel = editDocument(doc, (draft) => {
      const label = addGroupLabel(draft, newId, { memberIds: [image.id], edge: 'top', title: 'Caption' });
      const target = label ? draft.nodes[label.id] : undefined;
      if (target?.type === 'group-label') target.gapMm = 6;
      reflowGroupLabels(draft);
    });

    const label = Object.values(withLabel.nodes).find(
      (n): n is GroupLabelNode => n.type === 'group-label',
    )!;
    expect(label.gapMm).toBe(6);
    // The frame really grew by the override — the field is read, not just stored.
    expect(label.frame.height).toBeCloseTo(groupLabelClearanceMm(undefined, false, undefined, 6), 6);

    const loaded = loadArchive(saveArchive(buildArchiveContents(withLabel)));
    expect(loaded.document).toEqual(withLabel);
  });
});

describe('a declared grid is honoured at any occupancy', () => {
  function emptyGrid(rows: number, cols: number) {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addEmptyMontagePanel(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 40 }, name: 'Montage', rows, cols, gutterMm: 2 });
      addAsset(draft, { id: 'a', filename: 'a.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
      addAsset(draft, { id: 'b', filename: 'b.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    return { doc, panel, newId };
  }

  it('puts a montage\'s first tile in its first cell, not across the whole panel', () => {
    /*
     * Under the old rule — which bailed out of the grid at one child — the
     * first tile uploaded into an empty montage stretched across the whole
     * panel and then snapped back into cell 1 the moment a second arrived.
     * That was invisible while a `contentGrid` could only ever be created
     * alongside two or more images; filling a montage a cell at a time is
     * what walks straight through the state it got wrong.
     */
    const { doc, panel, newId } = emptyGrid(2, 2);
    const filled = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'a', naturalPx: { width: 100, height: 100 } });
    });

    const tile = Object.values(filled.nodes).find((n) => n.type === 'image')!;
    const cells = montageCellRects(filled, panel.id, panel.frame)!;
    expect(tile.frame).toEqual(cells[0]);
    // Emphatically not the whole panel.
    expect(tile.frame.width).toBeLessThan(panel.frame.width);
    expect(tile.frame.height).toBeLessThan(panel.frame.height);
  });

  it('leaves the first tile exactly where it was when a second one joins it', () => {
    const { doc, panel, newId } = emptyGrid(1, 2);
    const one = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'a', naturalPx: { width: 100, height: 100 } });
    });
    const firstFrame = { ...montageTiles(one.nodes, panel.id)[0]!.frame };

    const two = editDocument(one, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 1, { assetId: 'b', naturalPx: { width: 100, height: 100 } });
    });
    // No jump: the tile already sat in its cell, so adding a neighbour moves
    // nothing that was already placed.
    expect(montageTiles(two.nodes, panel.id)[0]!.frame).toEqual(firstFrame);
  });

  it('still fills the whole panel for a one-child panel with no grid at all', () => {
    // The ordinary single-plot/single-image panel, which is every existing
    // figure — this is the byte-identical case the change must not touch.
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addAsset(draft, { id: 'a', filename: 'a.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
      addPanelWithImage(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 40 },
        name: 'Panel',
        assetId: 'a',
        naturalPx: { width: 100, height: 100 },
      });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const tile = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    expect(panel.type === 'panel' && panel.contentGrid).toBeUndefined();
    expect(tile.frame).toEqual({ x: 0, y: 0, width: 60, height: 40 });
  });
});

// ---------------------------------------------------------------------------
// Round 33 — image-edge framing, overlay labels, montage auto-fit
// ---------------------------------------------------------------------------

describe('imageContentRect', () => {
  function image(overrides: Partial<ImageNode> = {}) {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addAsset(draft, { id: 'a', filename: 'a.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 200, height: 100 } });
      addPanelWithImage(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 60 },
        name: 'Panel',
        assetId: 'a',
        naturalPx: { width: 200, height: 100 },
      });
    });
    const node = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    return { ...node, ...overrides } as ImageNode;
  }

  it('letterboxes a 2:1 picture inside a square frame, centred by default', () => {
    // 60 × 60 frame, 2:1 source → 60 × 30 of picture with 30 mm of spare
    // height, centred means 15 mm above it.
    expect(imageContentRect(image())).toEqual({ x: 0, y: 15, width: 60, height: 30 });
  });

  it('follows alignY, which is what a montage tile is given', () => {
    expect(imageContentRect(image({ alignY: 'start' }))).toEqual({ x: 0, y: 0, width: 60, height: 30 });
    expect(imageContentRect(image({ alignY: 'end' }))).toEqual({ x: 0, y: 30, width: 60, height: 30 });
  });

  it('is the whole frame when the picture is stretched to fill it', () => {
    // Nothing letterboxes, so there is no spare space and the ink really does
    // reach every edge.
    expect(imageContentRect(image({ preserveAspect: false }))).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 60,
    });
  });

  it('accounts for the crop, which changes the drawn shape', () => {
    // Cropping a 2:1 source to half its width leaves a 1:1 region, which fills
    // the square frame exactly.
    const cropped = image({ crop: { x: 0, y: 0, width: 0.5, height: 1 } });
    expect(imageContentRect(cropped)).toEqual({ x: 0, y: 0, width: 60, height: 60 });
  });

  it('is the whole frame for a vector asset, which has no intrinsic shape', () => {
    // naturalPx {0, 0} — there is nothing to letterbox against.
    expect(imageContentRect(image({ naturalPx: { width: 0, height: 0 } }))).toEqual({
      x: 0,
      y: 0,
      width: 60,
      height: 60,
    });
  });
});

describe('group labels measure the picture, not the cell', () => {
  /** One montage tile that letterboxes: a 2:1 picture in a square-ish cell. */
  function letterboxedTile() {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addAsset(draft, { id: 'a', filename: 'a.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 200, height: 100 } });
      addPanelWithImage(draft, newId, {
        frame: { x: 10, y: 20, width: 60, height: 60 },
        name: 'Panel',
        assetId: 'a',
        naturalPx: { width: 200, height: 100 },
      });
    });
    const tile = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    // Centre it, so the letterboxing is on both sides and unmistakable.
    const centred = editDocument(doc, (draft) => {
      const target = draft.nodes[tile.id];
      if (target?.type === 'image') target.alignY = 'middle';
    });
    return { doc: centred, tile, newId };
  }

  it('frames a caption to the drawn picture, not to the frame around it', () => {
    const { doc, tile, newId } = letterboxedTile();
    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [tile.id], edge: 'top', title: 'Caption' });
      reflowGroupLabels(draft);
    });
    const label = Object.values(withLabel.nodes).find(
      (n): n is GroupLabelNode => n.type === 'group-label',
    )!;

    // The picture is 60 × 30 sitting 15 mm down inside a 60 × 60 frame at
    // (10, 20), so its own top edge is y = 35 — not the frame's y = 20. A rule
    // drawn at the frame's edge floats 15 mm above the thing it labels.
    const clearance = groupLabelClearanceMm(undefined, false, undefined);
    expect(label.frame.y + label.frame.height).toBeCloseTo(35, 6);
    expect(label.frame.y).toBeCloseTo(35 - clearance, 6);
  });

  it('spans the picture\'s width, so an opted-in rule stops at the image edge', () => {
    const { doc, tile, newId } = letterboxedTile();
    // Narrow the picture instead: a 1:2 source in a 60-wide frame draws 30 wide.
    const narrow = editDocument(doc, (draft) => {
      const target = draft.nodes[tile.id];
      if (target?.type === 'image') target.naturalPx = { width: 100, height: 200 };
    });
    const withLabel = editDocument(narrow, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [tile.id], edge: 'top', title: 'Caption' });
      reflowGroupLabels(draft);
    });
    const label = Object.values(withLabel.nodes).find(
      (n): n is GroupLabelNode => n.type === 'group-label',
    )!;

    // 60 × 60 frame, 1:2 source → 30 × 60 of picture, centred at x = 10 + 15.
    expect(label.frame.width).toBeCloseTo(30, 6);
    expect(label.frame.x).toBeCloseTo(25, 6);
  });
});

describe('overlay group labels', () => {
  function tileWithLabel(placement: 'outside' | 'overlay') {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    let doc = editDocument(base, (draft) => {
      const images = Array.from({ length: 4 }, (_, i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `t${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
        return { assetId, naturalPx: { width: 100, height: 100 } };
      });
      addPanelWithImages(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 60 }, name: 'Montage', images, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    const tiles = montageTiles(doc.nodes, panel.id);
    doc = editDocument(doc, (draft) => {
      const label = addGroupLabel(draft, newId, {
        memberIds: [tiles[0]!.id],
        edge: 'top',
        title: 'Channel',
      });
      const target = label ? draft.nodes[label.id] : undefined;
      if (target?.type === 'group-label' && placement === 'overlay') target.placement = 'overlay';
      fillPanelChildren(draft, panel.id, panel.frame);
      reflowGroupLabels(draft);
    });
    return { doc, panel, tiles, newId };
  }

  it('reserves no space at all, so nothing on the page moves for it', () => {
    const outside = tileWithLabel('outside');
    const overlay = tileWithLabel('overlay');

    const outsideTop = montageTiles(outside.doc.nodes, outside.panel.id)[0]!.frame.y;
    const overlayTop = montageTiles(overlay.doc.nodes, overlay.panel.id)[0]!.frame.y;

    // The outside caption grows the row's gutter and pushes its tile down; the
    // overlaid one is drawn on the picture and costs nothing.
    expect(outsideTop).toBeGreaterThan(overlayTop);
    expect(overlayTop).toBeCloseTo(0, 6);
  });

  it('sits inside the picture it labels', () => {
    const { doc, panel } = tileWithLabel('overlay');
    const label = Object.values(doc.nodes).find(
      (n): n is GroupLabelNode => n.type === 'group-label',
    )!;
    const tile = montageTiles(doc.nodes, panel.id)[0]!;
    const content = memberContentRect(doc.nodes, tile.id)!;

    expect(label.frame.x).toBeGreaterThanOrEqual(content.x);
    expect(label.frame.y).toBeGreaterThanOrEqual(content.y);
    expect(label.frame.x + label.frame.width).toBeLessThanOrEqual(content.x + content.width + 1e-6);
    expect(label.frame.y + label.frame.height).toBeLessThanOrEqual(content.y + content.height + 1e-6);
  });

  it('neither stacks nor is stacked against', () => {
    // An overlaid caption takes no space, so a heading spanning the same row
    // must not be pushed out to clear it.
    const { doc, panel, tiles, newId } = tileWithLabel('overlay');
    const withHeading = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, {
        memberIds: tiles.map((t) => t.id),
        edge: 'top',
        title: 'All',
      });
      fillPanelChildren(draft, panel.id, panel.frame);
      reflowGroupLabels(draft);
    });
    const heading = Object.values(withHeading.nodes).find(
      (n): n is GroupLabelNode => n.type === 'group-label' && n.memberIds.length === 4,
    )!;
    expect(groupLabelExtentMm(withHeading.nodes, heading)).toBeCloseTo(
      groupLabelClearanceMm(undefined, false, undefined),
      6,
    );
  });
});

describe('montage auto-fit', () => {
  function montageOf(aspects: readonly (readonly [number, number])[], frame = { x: 0, y: 0, width: 60, height: 60 }) {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const images = aspects.map(([w, h], i) => {
        const assetId = `asset-${i}`;
        addAsset(draft, { id: assetId, filename: `t${i}.png`, mimeType: 'image/png', byteLength: 10, naturalPx: { width: w, height: h } });
        return { assetId, naturalPx: { width: w, height: h } };
      });
      addPanelWithImages(draft, newId, { frame, name: 'Montage', images, gutterMm: 2 });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    return { doc, panel, newId };
  }

  it('takes the median tile aspect, not the mean', () => {
    // Three squares and one panorama: the median is 1, the mean is 3.25. A
    // mean would drag every cell wide for one outlier.
    const { doc, panel } = montageOf([[100, 100], [100, 100], [100, 100], [1000, 100]]);
    expect(montageTileAspect(doc.nodes, panel.id)).toBeCloseTo(1, 6);
  });

  it('shapes the panel so square tiles get square cells', () => {
    /*
     * Rewritten rather than merely repointed. The old form asserted that a
     * 2 × 2 of squares gives a *panel ratio* of 1 — true, but for a reason that
     * had nothing to do with the function being right: it is the one
     * configuration where `fixedWidth == fixedHeight` and `cols·a/rows == 1`,
     * i.e. exactly where a single ratio genuinely is scale-invariant. It would
     * have kept passing through the defect this round removes.
     *
     * Asserted on the shape's parts instead, which are what the tiler reads:
     *   contentAspect = 2 × 1 / 2      = 1
     *   fixedWidth    = 1 gutter × 2   = 2   (= fixedHeight, by symmetry)
     */
    const { doc, panel } = montageOf([[100, 100], [100, 100], [100, 100], [100, 100]]);
    const shape = montageShape(doc, panel.id)!;
    expect(shape.contentAspect).toBeCloseTo(1, 6);
    expect(shape.fixedWidthMm).toBeCloseTo(shape.fixedHeightMm, 6);
    // And the panel really is square at every size, which is the property the
    // old assertion was reaching for.
    for (const w of [30, 60, 120]) {
      expect(heightForWidth(shape, w)).toBeCloseTo(w, 6);
    }
  });

  it('counts a group title as a band, not as part of the ratio', () => {
    /*
     * The reported figure: three 4:3 tiles in a row under one group title.
     * `contentAspect` is the *cells'* combined ratio, 3 × (4/3) / 1 = 4, and
     * the caption is a constant band on top of the padding the panel already
     * had — 3.54 mm for a 6 pt heading with no rule.
     */
    // A wide cell, so the grid comes out 1 × 3 — the reported shape.
    const { doc, panel, newId } = montageOf(
      [[800, 600], [800, 600], [800, 600]],
      { x: 0, y: 0, width: 180, height: 45 },
    );
    const tiles = Object.values(doc.nodes).filter((n) => n.type === 'image');
    const captioned = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: tiles.map((t) => t.id), edge: 'top', title: 'Group title' });
      reflowGroupLabels(draft);
    });

    const bare = montageShape(doc, panel.id)!;
    const shape = montageShape(captioned, panel.id)!;
    expect(shape.contentAspect).toBeCloseTo(4, 6);
    // The caption adds a band and nothing else: the cells' own aspect and the
    // width are untouched, where a single ratio rescaled everything.
    expect(shape.fixedHeightMm - bare.fixedHeightMm).toBeCloseTo(3.54, 2);
    expect(shape.fixedWidthMm).toBeCloseTo(bare.fixedWidthMm, 6);
    expect(shape.contentAspect).toBeCloseTo(bare.contentAspect!, 6);
  });

  it('lets no tile letterbox, at any panel size', () => {
    /*
     * The whitespace itself, measured through the real tiler. Fitted with the
     * single ratio `montagePanelAspect` returned (2.5761), the tiles kept their
     * width and lost height at every size:
     *
     *   60.0 × 23.3  -> cell 19.33 × 19.75, picture 19.33 × 14.50,  101.5 mm² dead
     *   120.0 × 46.6 -> cell 39.33 × 43.04, picture 39.33 × 29.50,  532.6 mm² dead
     *   175.0 × 67.9 -> cell 57.67 × 64.39, picture 57.67 × 43.25, 1219.2 mm² dead
     *
     * × 3 tiles, all of it under the pictures because a montage tile is
     * `alignY: 'start'`. At the affine height there is nothing left over.
     */
    const { doc, panel, newId } = montageOf(
      [[800, 600], [800, 600], [800, 600]],
      { x: 0, y: 0, width: 180, height: 45 },
    );
    const tiles = Object.values(doc.nodes).filter((n) => n.type === 'image');
    const captioned = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: tiles.map((t) => t.id), edge: 'top', title: 'Group title' });
      reflowGroupLabels(draft);
    });
    const shape = montageShape(captioned, panel.id)!;

    for (const width of [60, 120, 175]) {
      const height = heightForWidth(shape, width);
      const laid = editDocument(captioned, (draft) => {
        fillPanelChildren(draft, panel.id, { x: 0, y: 0, width, height });
      });
      for (const tile of montageTiles(laid.nodes, panel.id)) {
        const ink = imageContentRect(tile as Extract<FigureNode, { type: 'image' }>);
        expect(ink.width).toBeCloseTo(tile.frame.width, 6);
        expect(ink.height).toBeCloseTo(tile.frame.height, 6);
      }
    }
  });

  it('reserves the strip a below-placed scale bar needs, inside the grid', () => {
    /*
     * A bar below its picture is drawn outside the tile's own frame, so unless
     * the *grid* holds the room open the tiler fills it with picture and the
     * bar lands on whatever is beneath. Nothing in the solver's demand path
     * read a scale bar at all before this.
     *
     *   band = 1 mm gap + 0.6 mm bar + a 6 pt label ≈ 4.14 mm
     */
    const { doc, panel, newId } = montageOf(
      [[800, 600], [800, 600], [800, 600]],
      { x: 0, y: 0, width: 180, height: 45 },
    );
    const tiles = Object.values(doc.nodes).filter((n) => n.type === 'image');
    const withBar = editDocument(doc, (draft) => {
      addScaleBar(draft, newId, { imageId: tiles[2]!.id, length: 10, unitLabel: 'µm', pixelsPerUnit: 2 });
      const bar = Object.values(draft.nodes).find((n) => n.type === 'scale-bar')!;
      if (bar.type === 'scale-bar') bar.placement = 'below';
      resyncScaleBars(draft);
    });
    const bar = Object.values(withBar.nodes).find((n) => n.type === 'scale-bar')!;
    const band = scaleBarBelowExtentMm(bar as Extract<FigureNode, { type: 'scale-bar' }>);
    expect(band).toBeCloseTo(4.14, 2);

    // The band is in the panel's fixed extent, so it is real to the tiler and
    // to the solver at once — not stated in one and forgotten by the other.
    const before = montageShape(doc, panel.id)!;
    const after = montageShape(withBar, panel.id)!;
    expect(after.fixedHeightMm - before.fixedHeightMm).toBeCloseTo(band, 6);
    expect(after.contentAspect).toBeCloseTo(before.contentAspect!, 6);
    // The pictures are unchanged: the panel grew by the band, the tiles did not
    // shrink to make room for it.
    expect(heightForWidth(after, 175) - heightForWidth(before, 175)).toBeCloseTo(band, 6);
  });

  it('shapes it wider for wide tiles', () => {
    const { doc, panel } = montageOf([[200, 100], [200, 100], [200, 100], [200, 100]]);
    const square = montageOf([[100, 100], [100, 100], [100, 100], [100, 100]]);
    const wide = montageShape(doc, panel.id)!;
    const plain = montageShape(square.doc, square.panel.id)!;
    expect(wide.contentAspect).toBeGreaterThan(plain.contentAspect!);
  });

  it('locks the ratio the panel really got, not one from some other size', () => {
    /*
     * The test that pinned the defect. It asserted `aspectLock` equalled
     * `montagePanelAspect`, which probed at a 5 mm cell and returned a ratio no
     * frame of the panel ever had — so the lock was self-consistently wrong and
     * the assertion could not see it.
     *
     * The lock is now read off the fitted frame, which is exact at the size the
     * panel actually has.
     */
    const { doc, panel } = montageOf([[200, 100], [200, 100]]);
    const locked = doc.nodes[panel.id]!;
    const shape = montageShape(doc, panel.id)!;
    const fitted = fitShape(panel.frame, shape, 'start', 'start');
    expect(locked.type === 'panel' && locked.aspectLock).toBeCloseTo(fitted.width / fitted.height, 6);
    expect(fitted.height).toBeCloseTo(heightForWidth(shape, fitted.width), 6);
  });

  it('leaves a montage with autoFit off exactly as it was', () => {
    const { doc, panel } = montageOf([[200, 100], [200, 100], [200, 100], [200, 100]]);
    const off = editDocument(doc, (draft) => {
      const target = draft.nodes[panel.id];
      if (target?.type === 'panel' && target.contentGrid) {
        target.contentGrid = { ...target.contentGrid, autoFit: false };
        target.aspectLock = null;
      }
    });
    const after = editDocument(off, (draft) => fitMontageToImages(draft, panel.id));
    // Every figure saved before this existed carries no `autoFit`, and must
    // not be reshaped the first time it is opened.
    expect(after.nodes[panel.id]!.frame).toEqual(off.nodes[panel.id]!.frame);
    const reloaded = after.nodes[panel.id]!;
    expect(reloaded.type === 'panel' ? reloaded.aspectLock : undefined).toBeNull();
  });
});

describe('suggestMontageGrid', () => {
  it('never leaves a wholly empty row or column', () => {
    // Four tiles in a wide cell: 2 × 3 is the better *shape* but wastes two
    // cells, and an empty cell in a published montage is a hole in the figure.
    for (const cellAspect of [0.5, 1, 2, 4]) {
      const grid = suggestMontageGrid(4, 1, cellAspect);
      expect(grid.rows * grid.cols - 4).toBeLessThan(Math.min(grid.rows, grid.cols));
    }
  });

  it('gives wide images fewer columns than tall ones, for the same cell', () => {
    const wide = suggestMontageGrid(6, 3, 1);
    const tall = suggestMontageGrid(6, 1 / 3, 1);
    expect(wide.cols).toBeLessThan(tall.cols);
  });

  it('lays four square tiles out 2 × 2 in a square cell', () => {
    expect(suggestMontageGrid(4, 1, 1)).toEqual({ rows: 2, cols: 2 });
  });

  it('falls back to suggestGrid when there is no aspect to aim at', () => {
    const fallback = suggestGrid(5);
    expect(suggestMontageGrid(5, 1, 0)).toEqual({ rows: fallback.rows, cols: fallback.columns });
    expect(suggestMontageGrid(5, 0, 1)).toEqual({ rows: fallback.rows, cols: fallback.columns });
  });
});

describe('round 33 round-trip', () => {
  it('keeps placement, labelColor and autoFit through a save', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    let doc = editDocument(base, (draft) => {
      addEmptyMontagePanel(draft, newId, { frame: { x: 0, y: 0, width: 60, height: 40 }, name: 'Montage', rows: 1, cols: 2, gutterMm: 2 });
      addAsset(draft, { id: 'a', filename: 'a.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    doc = editDocument(doc, (draft) => {
      setMontageCellImage(draft, newId, panel.id, 0, { assetId: 'a', naturalPx: { width: 100, height: 100 } });
    });
    const tile = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    const styled = editDocument(doc, (draft) => {
      const label = addGroupLabel(draft, newId, { memberIds: [tile.id], edge: 'top', title: 'Ch1' });
      const target = label ? draft.nodes[label.id] : undefined;
      if (target?.type === 'group-label') {
        target.placement = 'overlay';
        target.labelColor = '#ffcc00';
      }
      reflowGroupLabels(draft);
    });

    // zod strips a key present only on the TS type, so the round-trip is the
    // assertion that matters, not the field being assignable.
    const loaded = loadArchive(saveArchive(buildArchiveContents(styled)));
    expect(loaded.document).toEqual(styled);
    const label = Object.values(loaded.document.nodes).find(
      (n): n is GroupLabelNode => n.type === 'group-label',
    )!;
    expect(label.placement).toBe('overlay');
    expect(label.labelColor).toBe('#ffcc00');
    const reloadedPanel = loaded.document.nodes[panel.id]!;
    expect(reloadedPanel.type === 'panel' && reloadedPanel.contentGrid?.autoFit).toBe(true);
  });

  it('creates a heading with no rule and no bold, so the defaults actually apply', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      addAsset(draft, { id: 'a', filename: 'a.png', mimeType: 'image/png', byteLength: 10, naturalPx: { width: 100, height: 100 } });
      addPanelWithImage(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 60 },
        name: 'Panel',
        assetId: 'a',
        naturalPx: { width: 100, height: 100 },
      });
    });
    const image = Object.values(doc.nodes).find((n) => n.type === 'image')!;
    const withLabel = editDocument(doc, (draft) => {
      addGroupLabel(draft, newId, { memberIds: [image.id], edge: 'top', title: 'Caption' });
    });
    const label = Object.values(withLabel.nodes).find(
      (n): n is GroupLabelNode => n.type === 'group-label',
    )!;
    // Absent, not false/normal: an explicit value would override the default
    // and is exactly what made every heading arrive bold and ruled.
    expect(label.showRule).toBeUndefined();
    expect(label.style?.fontWeight).toBeUndefined();
  });
});
