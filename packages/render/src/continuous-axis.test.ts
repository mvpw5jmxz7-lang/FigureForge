/**
 * Numeric x axis, and the marks drawn against it.
 *
 * `scatter`, `line` and `histogram` were declared in `PlotType` for two phases
 * while silently rendering as jittered categorical dots. These tests pin each to
 * geometry only it produces, and cover the axis machinery none of the
 * categorical types needed.
 */

import { describe, expect, it } from 'vitest';
import {
  addPanelWithPlot,
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  type Dataset,
  type FigureDocument,
  type PlotNode,
  type PlotType,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument } from './render-document.js';
import { measurePlot } from './render-document.js';
import { collectByRole } from './scene.js';

/** Two numeric columns → `simple-xy`, the format that carries paired x values. */
const XY = `Dose,Response
1,2.1
2,3.9
3,6.2
4,7.8
5,10.1
6,12.4`;

/** A single distribution, which is what a histogram needs. */
const FLAT = `Dose,Response
1,2.1
2,3.9
3,6.2
4,7.8
5,10.1
6,12.4
7,13.9
8,16.2`;

function makeDocument(
  csv: string,
  plotType: PlotType,
  widthMm = 80,
  patch: Partial<PlotNode> = {},
): FigureDocument {
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
      name: 'Dose response',
      format: inferFormat(parsed.columns),
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/d.csv',
      sourceFilename: 'd.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: widthMm, height: 60 },
      name: 'Dose response',
      datasetId: dataset.id,
      plotType,
      xTitle: 'Dose (mg)',
      yTitle: 'Response',
    });

    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') Object.assign(node, patch);
    }
  });
}

const scene = (doc: FigureDocument) => renderDocument(doc, { theme: NATURE_THEME });

describe('numeric x axis', () => {
  it('reads x from the dataset rather than treating rows as categories', () => {
    const points = collectByRole(scene(makeDocument(XY, 'scatter')), 'point');
    expect(points).toHaveLength(6);

    // Evenly spaced doses must land evenly spaced across the axis. A categorical
    // fallback would place them on band centres and jitter them off it.
    const xs = points.map((p) => Number(p.attrs?.['cx'])).sort((a, b) => a - b);
    const gaps = xs.slice(1).map((v, i) => v - xs[i]!);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0]!, 6);
  });

  it('draws x tick marks, which a categorical axis omits', () => {
    // `addPlot` turns x ticks off for band axes; without them a numeric axis has
    // nothing to read a position against.
    const numeric = collectByRole(scene(makeDocument(XY, 'scatter')), 'tick');
    const categorical = collectByRole(scene(makeDocument(XY, 'bar')), 'tick');
    expect(numeric.length).toBeGreaterThan(categorical.length);
  });

  it('anchors the end labels inward so they stay inside the panel', () => {
    // The Nature theme reserves 2 mm to the right of the plot; a centred label
    // on the last tick overhangs the panel and, on the last panel, the page.
    // Y tick labels are centred on their own baseline; the x ones are not, which
    // is what separates the two axes' labels in the scene.
    const xAxisLabels = collectByRole(scene(makeDocument(XY, 'scatter')), 'tick-label').filter(
      (n) => n.attrs?.['dominant-baseline'] !== 'central',
    );

    expect(xAxisLabels.length).toBeGreaterThan(1);
    expect(xAxisLabels[0]!.attrs?.['text-anchor']).toBe('start');
    expect(xAxisLabels[xAxisLabels.length - 1]!.attrs?.['text-anchor']).toBe('end');
    // Everything between stays centred on its tick.
    for (const label of xAxisLabels.slice(1, -1)) {
      expect(label.attrs?.['text-anchor']).toBe('middle');
    }
  });

  it('thins x labels by width rather than letting them overprint', () => {
    const wide = collectByRole(scene(makeDocument(XY, 'scatter', 90)), 'tick-label').length;
    const narrow = collectByRole(scene(makeDocument(XY, 'scatter', 26)), 'tick-label').length;
    // The tick count comes from the axis length alone, so a narrow panel asks
    // for more labels than fit; the thinning is what keeps them legible.
    expect(narrow).toBeLessThan(wide);
  });
});

describe('continuous plot types', () => {
  it('connects a line plot in x order and draws no bars', () => {
    const s = scene(makeDocument(XY, 'line'));
    const lines = collectByRole(s, 'line');
    expect(lines).toHaveLength(1);
    expect(collectByRole(s, 'bar')).toEqual([]);

    // Six monotonic points: the path's x coordinates must ascend.
    const xs = [...String(lines[0]!.attrs?.['d'] ?? '').matchAll(/[ML]([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(xs).toHaveLength(6);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('draws a histogram as bars against the binned value axis', () => {
    const bars = collectByRole(scene(makeDocument(FLAT, 'histogram')), 'bar');
    expect(bars.length).toBeGreaterThan(1);
    // Bars sit side by side along x, all rising from a shared baseline.
    const bottoms = bars.map((b) => Number(b.attrs?.['y']) + Number(b.attrs?.['height']));
    for (const bottom of bottoms) expect(bottom).toBeCloseTo(bottoms[0]!, 6);
  });

  it('labels the count axis in whole observations', () => {
    // The generic tick chooser labels a histogram peaking at 3 as
    // 0, 0.5, 1, 1.5 … — half an observation, which is not a thing.
    const labels = collectByRole(scene(makeDocument(FLAT, 'histogram')), 'tick-label')
      .filter((n) => n.attrs?.['dominant-baseline'] === 'central')
      .map((n) => n.text ?? '');

    expect(labels.length).toBeGreaterThan(1);
    for (const label of labels) expect(Number(label) % 1).toBe(0);
  });

  it('honours an explicit bin count', () => {
    const bars = collectByRole(
      scene(makeDocument(FLAT, 'histogram', 80, { histogramBins: 3 })),
      'bar',
    );
    expect(bars).toHaveLength(3);
  });

  it('renders nothing rather than something wrong without paired x', () => {
    // A replicate-format dataset yields no `Series.x`. Falling back to the row
    // index would draw a plausible-looking scatter of a relationship that was
    // never measured.
    const grouped = `Treatment,R1,R2,R3
Vehicle,98.2,95.4,101.3
Drug,42.1,38.7,45.3`;
    expect(collectByRole(scene(makeDocument(grouped, 'scatter')), 'point')).toEqual([]);
  });

  it('refuses to pool several groups into one histogram', () => {
    // Two groups pooled produce a bimodal shape that belongs to neither.
    const grouped = `Treatment,R1,R2,R3
Vehicle,98.2,95.4,101.3
Drug,42.1,38.7,45.3`;
    expect(collectByRole(scene(makeDocument(grouped, 'histogram')), 'bar')).toEqual([]);
  });
});

describe('bracket anchoring on a continuous plot', () => {
  it('measures no categories, so no bracket can be misplaced', () => {
    const doc = makeDocument(XY, 'scatter');
    const plot = Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;

    const measured = measurePlot(doc, plot, NATURE_THEME);
    expect(measured).not.toBeNull();
    expect(measured!.categoryX.size).toBe(0);
    expect(measured!.categoryTop.size).toBe(0);
  });

  it('still measures categories for a band-scaled plot', () => {
    const doc = makeDocument(XY, 'bar');
    const plot = Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;
    expect(measurePlot(doc, plot, NATURE_THEME)!.categoryX.size).toBeGreaterThan(0);
  });
});
