/**
 * Panel demands, checked against the geometry they claim to be measured from.
 *
 * The point of these is that the numbers are *derived*, not chosen. So each one
 * asserts the relationship to `computePlotGeometry`'s own output rather than a
 * literal millimetre figure, which would only pin whatever the theme happens to
 * be today.
 */

import { describe, expect, it } from 'vitest';
import {
  addPanelWithPlot,
  createDocument,
  createIdFactory,
  editDocument,
  updateNode,
  type Dataset,
  type FigureDocument,
  type PlotNode,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { computePlotGeometry, measurePlot } from './render-document.js';
import { measurePanelDemands, MIN_PLOT_AREA_MM, scaledTypeScale } from './panel-demand.js';

const DATASET: Dataset = {
  id: 'ds1',
  name: 'Expression',
  format: 'replicate',
  columns: [
    { name: 'Genotype', kind: 'text' },
    { name: 'R1', kind: 'number' },
    { name: 'R2', kind: 'number' },
    { name: 'R3', kind: 'number' },
  ],
  rows: [
    // Deliberately five-figure: the theme's `plotMarginMm` is a *floor*
    // (`computePlotGeometry` takes the per-side max), so a plot whose measured
    // furniture fits inside it has a demand that no measurement can move. Wide
    // tick labels are what push the left margin past that floor and make the
    // measurement observable at all.
    ['WT', 41200, 44300, 39100],
    ['KO', 72400, 68800, 79500],
  ],
  sourcePath: null,
  sourceFilename: null,
  importedAt: '2024-01-01T00:00:00.000Z',
};

const OPTIONS = {
  pageWidthMm: 183,
  maxPageHeightMm: 247,
  marginMm: 2,
  gutterMm: 5,
  labelGutterMm: 4,
  exportDpi: 300,
  maxColumns: 4,
  maxRows: 4,
};

function build(yTitle: string): { doc: FigureDocument; plot: PlotNode } {
  const newId = createIdFactory();
  const base = createDocument({ idFactory: newId });
  let plotId = '';
  const doc = editDocument(base, (draft) => {
    draft.datasets = [DATASET];
    const { plot } = addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 60, height: 45 },
      name: 'Expression',
      datasetId: DATASET.id,
      plotType: 'bar-dot',
      yTitle,
      xTitle: 'Genotype',
    });
    plotId = plot.id;
  });
  return { doc, plot: doc.nodes[plotId] as PlotNode };
}

describe('plot demand', () => {
  it('is the measured margin plus a usable plot area, not a guess', () => {
    const { doc, plot } = build('Expression');
    const panelId = plot.parentId!;
    const demand = measurePanelDemands(doc, NATURE_THEME, OPTIONS).get(panelId)!;

    // The wide probe is the one nothing clamps, so it sets the measurement.
    const probe: PlotNode = {
      ...plot,
      frame: { ...plot.frame, width: 183 - 4 - 4, height: 247 - 4 },
    };
    const geometry = computePlotGeometry(
      probe,
      { ...doc, nodes: { ...doc.nodes, [probe.id]: probe } },
      NATURE_THEME,
    )!;

    expect(demand.kind).toBe('plot');
    expect(demand.minWidthMm).toBeCloseTo(
      geometry.margin.left + geometry.margin.right + MIN_PLOT_AREA_MM,
      6,
    );
    expect(demand.minHeightMm).toBeCloseTo(
      geometry.margin.top + geometry.margin.bottom + MIN_PLOT_AREA_MM,
      6,
    );
  });

  it('demands more width for a y title that takes a second line', () => {
    /*
     * The mechanism, not a magic constant. A y title is rotated, so its *line
     * count* — never its character count — is what widens the left margin;
     * `requiredMargin` reads `titleHeightFor`, which splits on newlines. A
     * longer single-line title costs nothing, which is why this uses a real
     * line break rather than a longer string.
     */
    const one = build('Expression');
    const two = build('Relative\nexpression');
    const a = measurePanelDemands(one.doc, NATURE_THEME, OPTIONS).get(one.plot.parentId!)!;
    const b = measurePanelDemands(two.doc, NATURE_THEME, OPTIONS).get(two.plot.parentId!)!;
    expect(b.minWidthMm).toBeGreaterThan(a.minWidthMm);
  });

  it('comfort is never below the minimum', () => {
    const { doc, plot } = build('Expression');
    const demand = measurePanelDemands(doc, NATURE_THEME, OPTIONS).get(plot.parentId!)!;
    expect(demand.comfortWidthMm).toBeGreaterThanOrEqual(demand.minWidthMm);
    expect(demand.comfortHeightMm).toBeGreaterThanOrEqual(demand.minHeightMm);
  });

  it('leaves the real node’s measurement cache alone', () => {
    /*
     * Probing measures a *clone* at a hypothetical frame. `measurePlot` is
     * memoised on the node's identity, so a probe that reused the real object
     * would leave a geometry computed at the wrong size for the canvas to pick
     * up — the figure would then draw against a frame it does not have.
     */
    const { doc, plot } = build('Expression');
    const before = measurePlot(doc, plot, NATURE_THEME);
    measurePanelDemands(doc, NATURE_THEME, OPTIONS);
    const after = measurePlot(doc, plot, NATURE_THEME);
    expect(after).toBe(before);
  });
});

describe('type scaling', () => {
  it('never goes below the theme’s own floor', () => {
    // The floor is the point: `checkTextSize` enforces exactly this number, so
    // buying space by going under it buys a rejection.
    const tiny = { ...NATURE_THEME, type: { ...NATURE_THEME.type, axisTitlePt: 5.2 } };
    const scaled = scaledTypeScale(tiny, 0.85);
    for (const pt of Object.values(scaled)) {
      expect(pt).toBeGreaterThanOrEqual(NATURE_THEME.type.minimumPt);
    }
  });

  it('rounds to a tenth of a point, so the figure reported is the figure set', () => {
    const scaled = scaledTypeScale(NATURE_THEME, 0.92);
    for (const pt of Object.values(scaled)) {
      expect(pt).toBeCloseTo(Math.round(pt * 10) / 10, 10);
    }
  });

  it('shrinks a plot’s demand when the type shrinks', () => {
    /*
     * The whole justification for offering the lever: smaller type means less
     * axis furniture means a panel that fits in less room.
     *
     * Only observable where the measured margin has already cleared the
     * theme's own `plotMarginMm` floor — inside it, `computePlotGeometry`
     * takes the theme's number and no amount of shrinking type moves it. That
     * is not a defect, but it does mean the lever is worth less on a small
     * plain plot than on a crowded one, and the score should not be read as
     * promising otherwise.
     */
    const { doc, plot } = build('Relative expression');
    const full = measurePanelDemands(doc, NATURE_THEME, OPTIONS, 1).get(plot.parentId!)!;

    const small = {
      ...NATURE_THEME,
      type: { ...NATURE_THEME.type, ...scaledTypeScale(NATURE_THEME, 0.85) },
    };
    const reduced = measurePanelDemands(doc, small, OPTIONS, 0.85).get(plot.parentId!)!;

    expect(reduced.minWidthMm).toBeLessThan(full.minWidthMm);
  });
});

describe('the whole document', () => {
  it('measures one demand per panel and no more', () => {
    const { doc } = build('Expression');
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel').length;
    expect(measurePanelDemands(doc, NATURE_THEME, OPTIONS).size).toBe(panels);
  });

  it('falls back to the image path for a panel with no plot', () => {
    const newId = createIdFactory();
    const doc = editDocument(createDocument({ idFactory: newId }), (draft) => {
      draft.datasets = [DATASET];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 0, y: 0, width: 60, height: 45 },
        datasetId: DATASET.id,
        plotType: 'bar-dot',
      });
      // Strip the plot back out, leaving a bare panel.
      updateNode(draft, plot.id, { hidden: true });
      delete draft.nodes[plot.id];
    });
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;
    expect(measurePanelDemands(doc, NATURE_THEME, OPTIONS).get(panel.id)!.kind).toBe('other');
  });
});
