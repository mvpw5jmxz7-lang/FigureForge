/**
 * Panel ownership: which panel a node belongs to, and how the figure reads when
 * grouped by panel.
 *
 * Built against real operations rather than hand-written node literals, because
 * the whole point of the module is the five *different* ways the operations
 * happen to link a node to its panel — `addScaleBar` parenting to an image,
 * `relabelPanels` writing a top-level letter with a `panelId`, `addBracket`
 * reaching its panel only through its plot. A fixture that constructed those
 * links by hand would be testing my reading of them, not them.
 */

import { describe, expect, it } from 'vitest';
import {
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  type Analysis,
  type Dataset,
  type FigureDocument,
  type NodeId,
  type PlotMeasurements,
} from './index.js';
import {
  addAsset,
  addBracket,
  addGroup,
  addGroupLabel,
  addPanelWithImages,
  addPanelWithPlot,
  addScaleBar,
  addText,
  applyAutoLayout,
  relabelPanels,
  replaceAnalysisForPlot,
} from './operations.js';
import { groupNodesByPanel, panelOwning, panelsOwning, panelTitle } from './ownership.js';
import type { PanelNode } from './nodes.js';

function dataset(id: string): Dataset {
  const parsed = parseDelimited('Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6');
  return {
    id,
    name: 'Viability',
    format: inferFormat(parsed.columns),
    columns: parsed.columns,
    rows: parsed.rows,
    sourcePath: `data/${id}.csv`,
    sourceFilename: null,
    importedAt: '2026-01-01T00:00:00.000Z',
  };
}

function analysisFor(id: string, plotId: NodeId, datasetId: string): Analysis {
  return {
    id,
    name: 'ttest-welch on Viability',
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

const MEASUREMENTS: PlotMeasurements = {
  categoryX: new Map([
    ['Vehicle', 10],
    ['Drug', 30],
  ]),
  categoryTop: new Map([
    ['Vehicle', 10],
    ['Drug', 10],
  ]),
};

/**
 * One figure exercising every link kind at once:
 *
 * - panel **A** holds a plot, which carries a bracket and a letter;
 * - panel **B** is a two-tile montage whose first tile carries a scale bar;
 * - one group title spans A and B, so it belongs to *two* panels;
 * - panel **C** sits inside a `group` at the bottom of the page, which is where
 *   page space and group-local space disagree;
 * - one loose text node belongs to nothing.
 */
function figure() {
  const newId = createIdFactory();
  const base = createDocument({
    widthMm: 183,
    heightMm: 120,
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  const ids: Record<string, NodeId> = {};

  let doc: FigureDocument = editDocument(base, (draft) => {
    const ds = dataset('d1');
    draft.datasets = [ds];

    const a = addPanelWithPlot(draft, newId, {
      frame: { x: 5, y: 5, width: 80, height: 40 },
      datasetId: ds.id,
      name: 'Expression',
    });
    ids.panelA = a.panel.id;
    ids.plotA = a.plot.id;

    addAsset(draft, {
      id: 'asset-1',
      filename: 'cells-01.png',
      mimeType: 'image/png',
      byteLength: 1000,
      naturalPx: { width: 800, height: 600 },
    });
    addAsset(draft, {
      id: 'asset-2',
      filename: 'cells-02.png',
      mimeType: 'image/png',
      byteLength: 1000,
      naturalPx: { width: 800, height: 600 },
    });
    const b = addPanelWithImages(draft, newId, {
      frame: { x: 95, y: 5, width: 80, height: 40 },
      name: 'Micrographs',
      images: [
        { assetId: 'asset-1', naturalPx: { width: 800, height: 600 } },
        { assetId: 'asset-2', naturalPx: { width: 800, height: 600 } },
      ],
    });
    ids.panelB = b.panel.id;
    ids.tile1 = b.images[0]!.id;
    ids.tile2 = b.images[1]!.id;

    const bar = addScaleBar(draft, newId, {
      imageId: b.images[0]!.id,
      length: 10,
      pixelsPerUnit: 2,
      unitLabel: 'µm',
      calibrationSource: 'metadata',
    });
    ids.scaleBar = bar!.id;

    // Bottom of the page, so its group-local origin (0, 0) and its page
    // position (5, 70) disagree — the round-42 case.
    const c = addPanelWithPlot(draft, newId, {
      frame: { x: 5, y: 70, width: 80, height: 40 },
      datasetId: ds.id,
      name: 'Survival',
    });
    ids.panelC = c.panel.id;

    ids.text = addText(draft, newId, {
      frame: { x: 5, y: 115, width: 40, height: 4 },
      text: 'Figure note',
    }).id;
  });

  doc = editDocument(doc, (draft) => {
    // Panel C grouped with the loose note — "an object grouped to a figure",
    // the shape round 42 was reported against. The note gains a group ancestor
    // and still belongs to no panel, which is the case a naive ancestor walk
    // would get wrong in the other direction.
    ids.group = addGroup(draft, newId, [ids.panelC!, ids.text!])!.id;

    const heading = addGroupLabel(draft, newId, {
      memberIds: [ids.panelA!, ids.panelB!],
      edge: 'top',
      title: 'Virtual stain',
    });
    ids.heading = heading!.id;

    const analysis = analysisFor(newId(), ids.plotA!, 'd1');
    replaceAnalysisForPlot(draft, analysis);
    ids.bracket = addBracket(draft, newId, {
      plotId: ids.plotA!,
      analysis,
      comparisonIndex: 0,
      measurements: MEASUREMENTS,
    })!.id;

    relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
  });

  const letterFor = (panelId: NodeId): NodeId =>
    Object.values(doc.nodes).find((n) => n.type === 'panel-label' && n.panelId === panelId)!.id;
  ids.letterA = letterFor(ids.panelA!);

  return { doc, ids };
}

const nameOf = (doc: FigureDocument, id: NodeId | undefined): string | undefined =>
  id ? doc.nodes[id]?.name : undefined;

describe('panel ownership', () => {
  it('resolves a plot and a montage tile through the parent chain', () => {
    const { doc, ids } = figure();
    expect(panelOwning(doc.nodes, ids.plotA!)?.id).toBe(ids.panelA);
    expect(panelOwning(doc.nodes, ids.tile1!)?.id).toBe(ids.panelB);
    expect(panelOwning(doc.nodes, ids.tile2!)?.id).toBe(ids.panelB);
  });

  it('resolves a scale bar two hops, through the image it calibrates', () => {
    // A scale bar is parented to its *image*, never to the panel — that is how
    // `scaleBarWidthMm` finds its calibration — so a one-hop rule misses it.
    const { doc, ids } = figure();
    expect(doc.nodes[ids.scaleBar!]!.parentId).toBe(ids.tile1);
    expect(panelOwning(doc.nodes, ids.scaleBar!)?.id).toBe(ids.panelB);
  });

  it('resolves a panel letter through its panelId, with no parent to walk', () => {
    const { doc, ids } = figure();
    expect(doc.nodes[ids.letterA!]!.parentId).toBeNull();
    expect(panelOwning(doc.nodes, ids.letterA!)?.id).toBe(ids.panelA);
  });

  it('resolves a bracket through its plot, and to nothing once that plot is gone', () => {
    const { doc, ids } = figure();
    expect(doc.nodes[ids.bracket!]!.parentId).toBeNull();
    expect(panelOwning(doc.nodes, ids.bracket!)?.id).toBe(ids.panelA);

    // A bracket outliving its plot is reachable: `deleteNode` sweeps them, but
    // an older document can carry one. It must resolve to nothing, not throw.
    const orphaned = editDocument(doc, (draft) => {
      delete draft.nodes[ids.plotA!];
    });
    expect(panelsOwning(orphaned.nodes, ids.bracket!)).toEqual([]);
  });

  it('returns every panel a spanning group title belongs to, in reading order', () => {
    const { doc, ids } = figure();
    const owners = panelsOwning(doc.nodes, ids.heading!);
    expect(owners.map((p) => p.name)).toEqual(['Expression', 'Micrographs']);
    // Several owners, so there is no single one to name.
    expect(panelOwning(doc.nodes, ids.heading!)).toBeNull();
  });

  it('resolves a grouped panel and sorts it by its page position', () => {
    /*
     * Panel C's own frame is (0, 0) relative to its group; the page reads it
     * last, at y = 70. A `frame`-based sort would put it first — the defect
     * round 42 fixed in `readingOrder`, inherited here rather than re-derived.
     */
    const { doc, ids } = figure();
    expect(doc.nodes[ids.panelC!]!.parentId).toBe(ids.group);
    expect(doc.nodes[ids.panelC!]!.frame.y).toBe(0);
    expect(panelOwning(doc.nodes, ids.panelC!)?.id).toBe(ids.panelC);
    expect(groupNodesByPanel(doc.nodes).groups.map((g) => g.panel.name)).toEqual([
      'Expression',
      'Micrographs',
      'Survival',
    ]);
  });

  it('gives a page-level note no panel at all', () => {
    const { doc, ids } = figure();
    expect(panelsOwning(doc.nodes, ids.text!)).toEqual([]);
    expect(panelOwning(doc.nodes, ids.text!)).toBeNull();
  });

  it('partitions the figure exactly: every node in one bucket, no node in two', () => {
    /*
     * The property the Layers list rests on. The spanning group title is the
     * case that makes it a real claim rather than a restatement: it belongs to
     * two panels and must still appear exactly once, under the first.
     */
    const { doc, ids } = figure();
    const { groups, unassigned } = groupNodesByPanel(doc.nodes);

    const placed = [
      ...groups.flatMap((g) => [g.panel.id, ...g.nodes.map((n) => n.id)]),
      ...unassigned.map((n) => n.id),
    ];
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed].sort()).toEqual(Object.keys(doc.nodes).sort());

    const headingIn = groups.filter((g) => g.nodes.some((n) => n.id === ids.heading));
    expect(headingIn).toHaveLength(1);
    expect(headingIn[0]!.panel.name).toBe('Expression');

    const byName = (name: string) => groups.find((g) => g.panel.name === name)!;
    expect(byName('Micrographs').nodes.map((n) => n.id).sort()).toEqual(
      [ids.tile1!, ids.tile2!, nodeIdOf(doc, ids.panelB!, 'panel-label'), ids.scaleBar!].sort(),
    );
    expect(unassigned.map((n) => nameOf(doc, n.id))).toEqual(
      expect.arrayContaining(['Figure note']),
    );
  });

  it('leaves a panel with nothing in it as an empty group rather than dropping it', () => {
    const newId = createIdFactory();
    const doc = editDocument(
      createDocument({ idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' }),
      (draft) => {
        addPanelWithPlot(draft, newId, {
          frame: { x: 5, y: 5, width: 80, height: 40 },
          datasetId: 'missing',
          name: 'Lonely',
        });
        applyAutoLayout(draft, { marginMm: 2, gutterMm: 5, labelGutterMm: 4 });
      },
    );
    const stripped = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') delete draft.nodes[node.id];
      }
    });
    const { groups } = groupNodesByPanel(stripped.nodes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.nodes).toEqual([]);
  });
});

describe('panelTitle', () => {
  const panel = (over: Partial<PanelNode>): PanelNode =>
    ({ type: 'panel', name: 'Expression', label: 'a', ...over }) as PanelNode;

  it('leads with the letter, then the panel’s own name', () => {
    expect(panelTitle(panel({}))).toBe('Panel a — Expression');
  });

  it('drops addPanel’s auto-generated name, which is a number', () => {
    // "Panel a — Panel 3" pairs the letter the figure is known by with a
    // counter it is not. The letter alone is the better string.
    expect(panelTitle(panel({ name: 'Panel 3' }))).toBe('Panel a');
    expect(panelTitle(panel({ name: '  ' }))).toBe('Panel a');
    // A real name that merely looks similar is kept.
    expect(panelTitle(panel({ name: 'Panel 3 replicates' }))).toBe('Panel a — Panel 3 replicates');
  });

  it('falls back to the name when no letter has been assigned yet', () => {
    expect(panelTitle(panel({ label: null }))).toBe('Expression');
    expect(panelTitle(panel({ label: null, name: 'Panel 3' }))).toBe('Panel 3');
  });
});

function nodeIdOf(doc: FigureDocument, panelId: NodeId, type: 'panel-label'): NodeId {
  return Object.values(doc.nodes).find((n) => n.type === type && n.panelId === panelId)!.id;
}
