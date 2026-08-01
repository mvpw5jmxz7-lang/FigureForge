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
  addPanelWithPlot,
  applyAutoLayout,
  deleteNode,
  relabelPanels,
  reparentNode,
} from './operations.js';
import { alignFrames, distributeFrames, gridCells, snapFrame, suggestGrid } from './layout.js';

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
