import { describe, expect, it } from 'vitest';
import {
  ArchiveError,
  buildArchiveContents,
  createDocument,
  createIdFactory,
  DocumentStore,
  editDocument,
  formatMm,
  hashInputs,
  inferFormat,
  loadArchive,
  mmToPt,
  parseDelimited,
  ptToMm,
  saveArchive,
  significanceStars,
  toMm,
  toSeries,
  type Dataset,
} from './index.js';
import {
  addBracket,
  addPanelWithPlot,
  applyAutoLayout,
  deleteNode,
  relabelPanels,
  removeBracketsForPlot,
  renameDataset,
  reparentNode,
  replaceAnalysisForPlot,
  repositionBrackets,
  type PlotMeasurements,
} from './operations.js';
import {
  alignFrames,
  autoLayout,
  distributeFrames,
  gridCells,
  resizeFrame,
  snapFrame,
  suggestGrid,
} from './layout.js';
import { findLayoutTemplate } from './templates.js';
import type { Analysis } from './analysis.js';

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
