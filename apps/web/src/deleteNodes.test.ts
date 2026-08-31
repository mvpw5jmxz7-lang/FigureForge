import { describe, expect, it } from 'vitest';
import {
  addGroup,
  addPanelWithPlot,
  addShape,
  applyAutoLayout,
  createDocument,
  createIdFactory,
  DocumentStore,
  editDocument,
  inferFormat,
  parseDelimited,
  relabelPanels,
  type BracketNode,
  type Dataset,
  type FigureDocument,
  type NodeId,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { deleteNodesWithLayout } from './deleteNodes.js';
import type { DocumentApi } from './useDocument.js';

function dataset(text: string, id: string): Dataset {
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

function makeApi(store: DocumentStore, newId: () => string): DocumentApi {
  return {
    get document() {
      return store.getDocument();
    },
    store,
    commit: (label, recipe) => {
      store.commit(label, recipe);
    },
    transaction: (label, body) => {
      store.transaction(label, body);
    },
    undo: () => {
      store.undo();
    },
    redo: () => {
      store.redo();
    },
    get canUndo() {
      return store.canUndo();
    },
    get canRedo() {
      return store.canRedo();
    },
    newId,
  };
}

const LAYOUT_OPTIONS = {
  marginMm: NATURE_THEME.spacing.marginMm,
  gutterMm: NATURE_THEME.spacing.panelGutterMm,
  labelGutterMm: 4,
};

/** A 2x2 grid of four panels (a/b/c/d), each with its own tiny dataset. */
function fourPanelGrid(): { store: DocumentStore; api: DocumentApi; newId: () => string } {
  const newId = createIdFactory();
  const base = createDocument({ widthMm: 183, heightMm: 120, idFactory: newId });
  const doc = editDocument(base, (draft) => {
    const datasets = ['One', 'Two', 'Three', 'Four'].map((name) => ({
      ...dataset('Treatment,R1,R2\nVehicle,10,11\nDrug,4,5', newId()),
      name,
    }));
    draft.datasets = datasets;
    for (const ds of datasets) {
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 50 },
        datasetId: ds.id,
        name: ds.name,
      });
    }
    applyAutoLayout(draft, LAYOUT_OPTIONS);
    relabelPanels(draft, newId, {
      uppercase: NATURE_THEME.panelLabelCase === 'upper',
      fontSizePt: NATURE_THEME.type.panelLabelPt,
      offsetMm: 4,
    });
  });
  const store = new DocumentStore(doc);
  return { store, api: makeApi(store, newId), newId };
}

function panelsInReadingOrder(doc: FigureDocument) {
  return Object.values(doc.nodes)
    .filter((n) => n.type === 'panel')
    .sort((a, b) => (Math.abs(a.frame.y - b.frame.y) <= 5 ? a.frame.x - b.frame.x : a.frame.y - b.frame.y));
}

function labelOf(doc: FigureDocument, panelId: NodeId): string | null {
  const label = Object.values(doc.nodes).find((n) => n.type === 'panel-label' && n.panelId === panelId);
  return label && label.type === 'panel-label' ? label.text : null;
}

describe('deleteNodesWithLayout', () => {
  it('closes the gap and relabels contiguously after deleting a panel', () => {
    const { store, api } = fourPanelGrid();
    const before = panelsInReadingOrder(store.getDocument());
    expect(before.map((p) => labelOf(store.getDocument(), p.id))).toEqual(['a', 'b', 'c', 'd']);
    const panelB = before[1]!;

    deleteNodesWithLayout(api, NATURE_THEME, [panelB.id]);

    const after = panelsInReadingOrder(store.getDocument());
    expect(after).toHaveLength(3);
    expect(after.map((p) => labelOf(store.getDocument(), p.id))).toEqual(['a', 'b', 'c']);

    // The result must match a fresh layout pass exactly — proof the panels
    // were actually re-packed, not merely relettered in place.
    const reference = editDocument(store.getDocument(), (draft) => {
      applyAutoLayout(draft, LAYOUT_OPTIONS);
      relabelPanels(draft, api.newId, {
        uppercase: NATURE_THEME.panelLabelCase === 'upper',
        fontSizePt: NATURE_THEME.type.panelLabelPt,
        offsetMm: 4,
      });
    });
    const referencePanels = panelsInReadingOrder(reference);
    expect(after.map((p) => p.frame)).toEqual(referencePanels.map((p) => p.frame));
  });

  it('does not relayout or relabel when the deleted node is not a panel', () => {
    const { store, api } = fourPanelGrid();
    store.commit('Insert shape', (draft) => {
      addShape(draft, api.newId, { shape: 'rect', frame: { x: 5, y: 5, width: 10, height: 8 } });
    });
    const shape = Object.values(store.getDocument().nodes).find((n) => n.type === 'shape')!;
    const beforePanels = panelsInReadingOrder(store.getDocument());
    const beforeFrames = beforePanels.map((p) => ({ id: p.id, frame: p.frame, label: labelOf(store.getDocument(), p.id) }));

    deleteNodesWithLayout(api, NATURE_THEME, [shape.id]);

    expect(store.getDocument().nodes[shape.id]).toBeUndefined();
    const afterPanels = panelsInReadingOrder(store.getDocument());
    expect(afterPanels.map((p) => ({ id: p.id, frame: p.frame, label: labelOf(store.getDocument(), p.id) }))).toEqual(
      beforeFrames,
    );
  });

  it('relayouts when a panel disappears as a cascade of deleting its group', () => {
    const { store, api } = fourPanelGrid();
    const [panelA, panelB] = panelsInReadingOrder(store.getDocument());
    store.commit('Group', (draft) => {
      addGroup(draft, api.newId, [panelA!.id, panelB!.id]);
    });
    const group = Object.values(store.getDocument().nodes).find((n) => n.type === 'group')!;

    deleteNodesWithLayout(api, NATURE_THEME, [group.id]);

    const after = panelsInReadingOrder(store.getDocument());
    expect(after).toHaveLength(2);
    expect(after.map((p) => labelOf(store.getDocument(), p.id))).toEqual(['a', 'b']);
    expect(store.getDocument().nodes[panelA!.id]).toBeUndefined();
    expect(store.getDocument().nodes[panelB!.id]).toBeUndefined();
  });

  it('permanently removes a deleted panel, its label, and any bracket left pointing at its plot', () => {
    const { store, api } = fourPanelGrid();
    const panel = panelsInReadingOrder(store.getDocument())[0]!;
    const plot = Object.values(store.getDocument().nodes).find(
      (n) => n.type === 'plot' && n.parentId === panel.id,
    )!;

    // A minimal, hand-built bracket pointing at the doomed plot — enough to
    // exercise the orphan-sweep without needing a full analysis/comparison.
    store.commit('Insert bracket', (draft) => {
      const id = api.newId();
      const bracket: BracketNode = {
        id,
        name: 'Vehicle vs Drug',
        parentId: null,
        layerId: draft.layers[0]!.id,
        frame: { x: 0, y: 0, width: 10, height: 4 },
        rotation: 0,
        opacity: 1,
        locked: false,
        hidden: false,
        z: 999,
        type: 'bracket',
        analysisId: null,
        plotId: plot.id,
        comparisonIndex: 0,
        label: '*',
        style: { align: 'middle' },
        stroke: { color: '#000000', widthMm: 0.18, cap: 'butt' },
        tickMm: 0.8,
      };
      draft.nodes[id] = bracket;
    });
    const bracketId = Object.values(store.getDocument().nodes).find((n) => n.type === 'bracket')!.id;

    deleteNodesWithLayout(api, NATURE_THEME, [panel.id]);

    const doc = store.getDocument();
    expect(doc.nodes[panel.id]).toBeUndefined();
    expect(doc.nodes[bracketId]).toBeUndefined();
    expect(
      Object.values(doc.nodes).some((n) => n.type === 'panel-label' && n.panelId === panel.id),
    ).toBe(false);
  });

  it('is a no-op for an empty selection', () => {
    const { store, api } = fourPanelGrid();
    const before = store.getDocument();
    expect(store.canUndo()).toBe(false);

    deleteNodesWithLayout(api, NATURE_THEME, []);

    expect(store.getDocument()).toBe(before);
    expect(store.canUndo()).toBe(false);
  });

  it('does not throw when deleting the last remaining panel', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 120, idFactory: newId });
    const doc = editDocument(base, (draft) => {
      const ds = dataset('Treatment,R1,R2\nVehicle,10,11\nDrug,4,5', newId());
      draft.datasets = [ds];
      addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 50 },
        datasetId: ds.id,
        name: ds.name,
      });
      applyAutoLayout(draft, LAYOUT_OPTIONS);
      relabelPanels(draft, newId, { fontSizePt: NATURE_THEME.type.panelLabelPt, offsetMm: 4 });
    });
    const store = new DocumentStore(doc);
    const api = makeApi(store, newId);
    const panel = panelsInReadingOrder(store.getDocument())[0]!;

    expect(() => deleteNodesWithLayout(api, NATURE_THEME, [panel.id])).not.toThrow();
    expect(panelsInReadingOrder(store.getDocument())).toHaveLength(0);
  });
});
