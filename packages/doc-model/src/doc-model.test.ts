import { describe, expect, it } from 'vitest';
import {
  analysisInputHash,
  ArchiveError,
  buildArchiveContents,
  checkReferentialIntegrity,
  createDocument,
  createIdFactory,
  couldHaveRowNames,
  DocumentStore,
  editDocument,
  formatMm,
  hashInputs,
  contingencyCategories,
  inferFormat,
  isContingency,
  loadArchive,
  mmToPt,
  parseDelimited,
  ptToMm,
  rowNames,
  saveArchive,
  significanceStars,
  toMm,
  toSeries,
  xForHash,
  type Dataset,
} from './index.js';
import {
  addArrow,
  addAsset,
  addBracket,
  addGroup,
  addImage,
  addPanelWithImage,
  addPanelWithPlot,
  addScaleBar,
  addShape,
  addText,
  applyAutoLayout,
  deleteNode,
  duplicateNode,
  imagesUsingAsset,
  isDerivedNode,
  MIN_CROP,
  normaliseArrowFrame,
  normaliseCrop,
  nextPanelFrame,
  plotsUsingDataset,
  recordBracketOffset,
  relabelPanels,
  removeBracketsForPlot,
  removeDataset,
  renameDataset,
  reorderNode,
  reparentNode,
  replaceAnalysisForPlot,
  repositionBrackets,
  resizePanel,
  scaleBarWidthMm,
  setArrowPoint,
  setDatasetReading,
  setImageCrop,
  ungroup,
  type PlotMeasurements,
} from './operations.js';
import { absoluteFrame } from './nodes.js';
import {
  alignFrames,
  autoLayout,
  distributeFrames,
  gridCells,
  resizeFrame,
  snapFrame,
  suggestGrid,
} from './layout.js';
import { LAYOUT_TEMPLATES, findLayoutTemplate, templatesForPanelCount } from './templates.js';
import { isLocked } from './document.js';
import type { Analysis } from './analysis.js';
import type { FigureDocument } from './document.js';

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

  it('reads a contingency table row by row, like replicates', () => {
    // Same shape, different meaning: the numbers are counts, so what may be
    // *done* with them differs, which `isContingency` gates rather than this.
    const table: Dataset = {
      ...dataset('Group,Yes,No\nTreated,15,5\nControl,7,13'),
      format: 'contingency',
    };
    const series = toSeries(table);
    expect(series.map((s) => s.name)).toEqual(['Treated', 'Control']);
    expect(series[0]?.values).toEqual([15, 5]);
    expect(isContingency(table)).toBe(true);
    expect(contingencyCategories(table)).toEqual(['Yes', 'No']);
    expect(isContingency(dataset('Group,Value\nA,1'))).toBe(false);
  });

  it('infers each supported layout', () => {
    expect(inferFormat(parseDelimited('X,Y\n1,2').columns)).toBe('simple-xy');
    expect(inferFormat(parseDelimited('Group,Value\nA,1').columns)).toBe('grouped');
    expect(inferFormat(parseDelimited('Treatment,R1,R2,R3\nA,1,2,3').columns)).toBe('replicate');
    expect(inferFormat(parseDelimited('X,Y1,Y2,Y3\n1,2,3,4').columns)).toBe('prism');
    expect(inferFormat(parseDelimited('X1,Y1,X2,Y2\n1,2,3,4').columns)).toBe('sigmaplot');
  });
});

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
  });

  it('reorders siblings and renumbers z with no gaps', () => {
    const { doc, newId } = sampleDocument();
    const withText = editDocument(doc, (draft) => {
      for (const text of ['one', 'two', 'three']) {
        addText(draft, newId, { frame: { x: 0, y: 0, width: 10, height: 4 }, text });
      }
    });

    const order = (d: typeof withText): string[] =>
      Object.values(d.nodes)
        .filter((n) => n.type === 'text')
        .sort((a, b) => a.z - b.z)
        .map((n) => (n.type === 'text' ? n.text : ''));

    expect(order(withText)).toEqual(['one', 'two', 'three']);

    const first = Object.values(withText.nodes).find((n) => n.type === 'text' && n.text === 'one')!;
    const front = editDocument(withText, (draft) => reorderNode(draft, first.id, 'front'));
    expect(order(front)).toEqual(['two', 'three', 'one']);

    const back = editDocument(front, (draft) => reorderNode(draft, first.id, 'backward'));
    expect(order(back)).toEqual(['two', 'one', 'three']);

    // Renumbered 0..n-1 every time, so repeated steps cannot drift apart.
    const zs = Object.values(back.nodes)
      .filter((n) => n.parentId === null)
      .map((n) => n.z)
      .sort((a, b) => a - b);
    expect(zs).toEqual(zs.map((_, i) => i));
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

  it('doubles when the image is cropped to half its width', () => {
    const { doc, bar, image } = barDocument();
    // Half as many source pixels span the same millimetres, so each pixel is
    // twice as wide on the page and the bar must grow to match.
    const cropped = editDocument(doc, (draft) => setImageCrop(draft, image.id, { width: 0.5 }));
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

  it('leaves an already-normalised arrow alone', () => {
    const { doc, newId } = imageDocument();
    let arrowId = '';
    const withArrow = editDocument(doc, (draft) => {
      arrowId = addArrow(draft, newId).id;
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
