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
import { toSvgString } from './svg-string.js';

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

/**
 * `TestFiles/test graph.xlsx`, tab-delimited as an Excel copy puts it on the
 * clipboard: three runs, each measured at its *own* x positions. Its own chart
 * is three lineMarker series, which is what this must reproduce.
 */
const XY_PAIRS = [
  'X1\tY1\tX2\tY2\tX3\tY3',
  '1\t0\t1.4\t0.05\t0.9\t0.1',
  '2\t0.1\t1.9\t0.2\t2.05\t0.24',
  '3\t0.3\t3.1\t0.4\t2.9\t0.47',
  '4\t0.5\t3.9\t0.7\t4.05\t0.8',
  '5\t0.6\t5.1\t0.8\t5.05\t0.9',
  '6\t0.7\t6.1\t0.9\t6.1\t1.1',
].join('\n');

describe('independent xy pairs', () => {
  it('draws one line per run, each against its own x', () => {
    const s = scene(makeDocument(XY_PAIRS, 'line'));
    const lines = collectByRole(s, 'line');
    expect(lines).toHaveLength(3);
    expect(collectByRole(s, 'bar')).toEqual([]);

    const firstX = lines.map((l) => Number(String(l.attrs?.['d'] ?? '').match(/M([\d.]+)/)?.[1]));
    // Six points each, and three distinct starting positions: read against one
    // shared x, all three would begin at the same place and the misreading
    // would be invisible on the page.
    for (const line of lines) {
      expect([...String(line.attrs?.['d'] ?? '').matchAll(/[ML]/g)]).toHaveLength(6);
    }
    expect(new Set(firstX).size).toBe(3);
    // Run 3 starts at x = 0.9, left of run 1's x = 1, which is left of run 2's 1.4.
    expect(firstX[2]).toBeLessThan(firstX[0]!);
    expect(firstX[0]).toBeLessThan(firstX[1]!);
  });

  it('shows the markers as well as the line', () => {
    // Excel's lineMarker, and what `showPoints` already defaults to: 18 points
    // over three lines. A bare line hides how many observations there were.
    expect(collectByRole(scene(makeDocument(XY_PAIRS, 'line')), 'point')).toHaveLength(18);
  });

  it('gives each series its own marker shape when asked', () => {
    /*
     * Redundant encoding: colour alone is lost in greyscale print and to a
     * reader with a colour-vision deficiency, so the symbol has to carry the
     * series identity too.
     */
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      pointShapes: ['circle', 'square', 'triangle'],
    });
    const points = collectByRole(scene(doc), 'point');
    expect(points).toHaveLength(18);

    // Six of each: a circle, a rect, and a triangle path with three vertices.
    expect(points.filter((n) => n.tag === 'circle')).toHaveLength(6);
    expect(points.filter((n) => n.tag === 'rect')).toHaveLength(6);
    const triangles = points.filter(
      (n) => n.tag === 'path' && String(n.attrs?.['d']).match(/[ML]/g)?.length === 3,
    );
    expect(triangles).toHaveLength(6);
  });

  it('falls back to the plot-wide shape for a series that names none', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      pointShape: 'diamond',
      pointShapes: ['square', null, null],
    });
    const points = collectByRole(scene(doc), 'point');
    expect(points.filter((n) => n.tag === 'rect')).toHaveLength(6);
    // The other two series take the diamond: four vertices, not three.
    const diamonds = points.filter(
      (n) => n.tag === 'path' && String(n.attrs?.['d']).match(/[ML]/g)?.length === 4,
    );
    expect(diamonds).toHaveLength(12);
  });

  it('draws the legend key as the symbol it stands for', () => {
    // Four identical blocks beside three different symbols withholds exactly
    // the mapping a reader needs.
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      pointShapes: ['circle', 'square', 'triangle'],
    });
    const swatches = collectByRole(scene(doc), 'legend').filter((n) => n.tag !== 'text');
    expect(swatches.map((n) => n.tag)).toEqual(['circle', 'rect', 'path']);
  });

  it('draws a marker key for a series that named no shape of its own', () => {
    /*
     * The common case, and the one a real browser caught: an author sets shapes
     * on the series they want to distinguish and leaves the first alone. A key
     * of one block beside two symbols is worse than no key — so once *any*
     * series carries a shape, every entry draws the marker it stands for.
     */
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      pointShapes: [null, 'square', 'triangle'],
    });
    const swatches = collectByRole(scene(doc), 'legend').filter((n) => n.tag !== 'text');
    expect(swatches.map((n) => n.tag)).toEqual(['circle', 'rect', 'path']);
  });

  it('leaves the legend key a plain block when no series names a shape', () => {
    // The property every optional field holds: a figure drawn before it existed
    // renders exactly as it did.
    const plain = toSvgString(scene(makeDocument(XY_PAIRS, 'line')));
    const empty = toSvgString(
      scene(makeDocument(XY_PAIRS, 'line', 80, { pointShapes: [null, null, null] })),
    );
    expect(empty).toBe(plain);
    expect(plain).toContain('<rect');
  });

  it('names the three runs in a legend', () => {
    // Nothing else on a continuous plot says which line is which — the band
    // labels a categorical plot leans on do not exist here.
    const labels = collectByRole(scene(makeDocument(XY_PAIRS, 'line')), 'legend')
      .filter((n) => n.tag === 'text')
      .map((n) => n.text);
    expect(labels).toEqual(['Y1', 'Y2', 'Y3']);
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
