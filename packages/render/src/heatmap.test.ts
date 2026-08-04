/**
 * Heatmaps: a dense row×column grid, the one `PlotGeometry` kind with no
 * numeric axis on either side. These tests pin the geometry only this kind
 * produces — cell placement, colour resolution, the "no data" cell, and the
 * colourbar — none of which the categorical or continuous arms exercise.
 */

import { describe, expect, it } from 'vitest';
import {
  addPanelWithPlot,
  createDocument,
  createIdFactory,
  editDocument,
  parseDelimited,
  type Dataset,
  type FigureDocument,
  type PlotNode,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument } from './render-document.js';
import { collectByRole } from './scene.js';

const MATRIX_CSV = `Gene,S1,S2,S3
TP53,0,5,10
MYC,10,5,0`;

function makeHeatmapDocument(csv: string, patch: Partial<PlotNode> = {}): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    widthMm: 183,
    heightMm: 75,
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const parsed = parseDelimited(csv);
    const dataset: Dataset = {
      id: newId(),
      name: 'Matrix',
      format: 'matrix',
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/d.csv',
      sourceFilename: 'd.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: 80, height: 60 },
      name: 'Heatmap',
      datasetId: dataset.id,
      plotType: 'heatmap',
    });

    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') Object.assign(node, patch);
    }
  });
}

const scene = (doc: FigureDocument) => renderDocument(doc, { theme: NATURE_THEME });

describe('heatmap geometry', () => {
  it('draws exactly one cell per (row, column)', () => {
    const cells = collectByRole(scene(makeHeatmapDocument(MATRIX_CSV)), 'heatmap-cell');
    expect(cells).toHaveLength(6); // 2 rows × 3 columns
  });

  it('colours the extremes of a sequential scale at the two stop colours', () => {
    const s = scene(makeHeatmapDocument(MATRIX_CSV, { heatmapScale: 'sequential' }));
    const fills = new Set(collectByRole(s, 'heatmap-cell').map((c) => c.attrs?.['fill']));
    // 0 (domain min) and 10 (domain max) are both present in the table, so
    // the default sequential stops must both appear somewhere in the grid.
    expect(fills.has('#f7fbff')).toBe(true);
    expect(fills.has('#08306b')).toBe(true);
  });

  it('centres a diverging domain on zero, not on the data mean', () => {
    // -8 and +2: a naive [min, max] domain would put zero off-centre. The
    // diverging domain is [-8, 8], so a value of 0 must resolve to the
    // scale's own midpoint colour.
    const s = scene(
      makeHeatmapDocument('Gene,S1,S2\nA,-8,0\nB,2,0', { heatmapScale: 'diverging' }),
    );
    const fills = collectByRole(s, 'heatmap-cell').map((c) => c.attrs?.['fill']);
    const midCount = fills.filter((f) => f === '#ffffff').length;
    expect(midCount).toBeGreaterThanOrEqual(2); // both cells valued 0
  });

  it('gives a missing cell the themed "no data" colour, not a point on the ramp', () => {
    const s = scene(makeHeatmapDocument('Gene,S1,S2\nA,1,\nB,2,3'));
    const fills = collectByRole(s, 'heatmap-cell').map((c) => c.attrs?.['fill']);
    expect(fills).toContain('#e0e0e0');
  });

  it('respects a custom missing-cell colour', () => {
    const s = scene(
      makeHeatmapDocument('Gene,S1,S2\nA,1,\nB,2,3', { heatmapMissingColor: '#ff00ff' }),
    );
    const fills = collectByRole(s, 'heatmap-cell').map((c) => c.attrs?.['fill']);
    expect(fills).toContain('#ff00ff');
    expect(fills).not.toContain('#e0e0e0');
  });

  it('draws a colourbar with more than one strip', () => {
    const strips = collectByRole(scene(makeHeatmapDocument(MATRIX_CSV)), 'colorbar');
    expect(strips.length).toBeGreaterThan(1);
  });

  it('hides the colourbar when the legend is set to none', () => {
    const s = scene(makeHeatmapDocument(MATRIX_CSV, { legend: 'none' }));
    expect(collectByRole(s, 'colorbar')).toEqual([]);
    // The cells themselves are unaffected by the legend setting.
    expect(collectByRole(s, 'heatmap-cell')).toHaveLength(6);
  });

  it('draws cell values only when asked, and skips none silently', () => {
    const off = collectByRole(scene(makeHeatmapDocument(MATRIX_CSV)), 'tick-label').length;
    const on = collectByRole(
      scene(makeHeatmapDocument(MATRIX_CSV, { showCellValues: true })),
      'tick-label',
    ).length;
    expect(on).toBeGreaterThan(off);
  });

  it('refuses to draw a matrix with no data columns left after the row labels', () => {
    // Column 0 is always read as the row label, so a single-column table has
    // nothing left to grid — the same "withhold rather than approximate"
    // stance every other plot type's geometry function takes.
    const s = scene(makeHeatmapDocument('Gene\nTP53\nMYC'));
    expect(collectByRole(s, 'heatmap-cell')).toEqual([]);
  });
});
