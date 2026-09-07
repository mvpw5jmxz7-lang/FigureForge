/**
 * Draw order across layers: what "Send to back" actually has to achieve.
 *
 * `reorderNode` renumbers `z`, but a top-level node's order is `layer.z` first,
 * so an annotation renumbered to the bottom of the Annotations layer was still
 * painted over every graph beneath it — the reported bug. These tests assert
 * the property from the rendered scene rather than from the document: SVG
 * paints in document order and both adapters serialise the scene's children in
 * array order, so "under the graph" is exactly "walked before it". A model-only
 * assertion on `z` is what let this defect exist in the first place.
 */

import { describe, expect, it } from 'vitest';
import {
  addPanelWithPlot,
  addShape,
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  reorderNode,
  type Dataset,
  type FigureDocument,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument } from './render-document.js';
import { walkScene } from './scene.js';

function figureWithRectOverGraph(): { doc: FigureDocument; rectId: string; panelId: string } {
  const newId = createIdFactory();
  const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId });

  const parsed = parseDelimited('Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6');
  const dataset: Dataset = {
    id: newId(),
    name: 'Viability',
    format: inferFormat(parsed.columns),
    columns: parsed.columns,
    rows: parsed.rows,
    sourcePath: null,
    sourceFilename: null,
    importedAt: '2026-01-01T00:00:00.000Z',
  };

  let rectId = '';
  let panelId = '';
  const doc = editDocument(base, (draft) => {
    draft.datasets = [dataset];
    panelId = addPanelWithPlot(draft, newId, {
      frame: { x: 10, y: 5, width: 80, height: 60 },
      datasetId: dataset.id,
      name: 'Viability',
    }).panel.id;
    // A filled rectangle dropped on top of the graph, exactly as the toolbar's
    // Shape… menu creates one: top level, in the Annotations layer.
    rectId = addShape(draft, newId, {
      shape: 'rect',
      frame: { x: 20, y: 10, width: 40, height: 30 },
      fill: { color: '#ff0000', opacity: 1 },
    }).id;
  });

  return { doc, rectId, panelId };
}

/** Document nodes in the order the figure paints them. */
function paintOrder(doc: FigureDocument): string[] {
  const ids: string[] = [];
  walkScene(renderDocument(doc, { theme: NATURE_THEME }), (n) => {
    if (n.nodeId && !ids.includes(n.nodeId)) ids.push(n.nodeId);
  });
  return ids;
}

function paintedAt(doc: FigureDocument, id: string): number {
  const at = paintOrder(doc).indexOf(id);
  expect(at, `node ${id} is not in the drawn figure`).toBeGreaterThanOrEqual(0);
  return at;
}

describe('draw order across layers', () => {
  it('paints a rectangle over the graph until it is sent to back', () => {
    const { doc, rectId, panelId } = figureWithRectOverGraph();
    expect(paintedAt(doc, rectId)).toBeGreaterThan(paintedAt(doc, panelId));

    const sent = editDocument(doc, (draft) => reorderNode(draft, rectId, 'back'));
    expect(paintedAt(sent, rectId)).toBeLessThan(paintedAt(sent, panelId));
    // First of everything, not merely ahead of the panel.
    expect(paintOrder(sent)[0]).toBe(rectId);
  });

  it('brings it back over the graph again, so the move is not one-way', () => {
    const { doc, rectId, panelId } = figureWithRectOverGraph();

    const sent = editDocument(doc, (draft) => reorderNode(draft, rectId, 'back'));
    // Asserted here as well as in the test above, or this one passes on a
    // rectangle that never went under the graph in the first place.
    expect(paintedAt(sent, rectId)).toBeLessThan(paintedAt(sent, panelId));

    const returned = editDocument(sent, (draft) => reorderNode(draft, rectId, 'front'));
    expect(paintedAt(returned, rectId)).toBeGreaterThan(paintedAt(returned, panelId));
  });

  it('leaves every other node in the order it was already drawn in', () => {
    const { doc, rectId } = figureWithRectOverGraph();

    const before = paintOrder(doc).filter((id) => id !== rectId);
    const sent = editDocument(doc, (draft) => reorderNode(draft, rectId, 'back'));
    const after = paintOrder(sent).filter((id) => id !== rectId);

    // Renumbering runs over the whole top level, across layer boundaries, so
    // this is the guard that it moves nothing but the node that was asked to.
    expect(after).toEqual(before);
  });
});
