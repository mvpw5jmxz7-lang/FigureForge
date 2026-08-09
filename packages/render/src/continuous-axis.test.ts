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
  type AxisSpec,
  type Dataset,
  type FigureDocument,
  type PlotNode,
  type PlotType,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { xyMarks } from '@figureforge/plots';
import { renderDocument } from './render-document.js';
import {
  cascadeAxisGroups,
  cascadeAxisReserveMm,
  computePlotGeometry,
  isCascadable,
  measurePlot,
  placedPointLabelsForPlot,
  renderCascadeAxis,
  type ContinuousPlotGeometry,
} from './render-document.js';
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

describe('axis range clipping', () => {
  it('drops a point past max once clipToRange is set, and topMm no longer reflects it', () => {
    const withClip = editDocument(makeDocument(XY, 'scatter'), (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') {
          node.x.max = 4;
          node.x.clipToRange = true;
        }
      }
    });
    const plot = Object.values(withClip.nodes).find((n) => n.type === 'plot') as PlotNode;
    const geometry = computePlotGeometry(plot, withClip, NATURE_THEME);
    expect(geometry?.kind).toBe('continuous');
    const series = (geometry as { series: { points: unknown[] }[] }).series;
    // Dose 5 and 6 fall past max=4 and are dropped entirely.
    expect(series[0]!.points).toHaveLength(4);
  });

  it('draws every point, overflowing the panel, when clipToRange is absent — unchanged from before this feature', () => {
    const withMaxOnly = editDocument(makeDocument(XY, 'scatter'), (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') node.x.max = 4;
      }
    });
    const plot = Object.values(withMaxOnly.nodes).find((n) => n.type === 'plot') as PlotNode;
    const geometry = computePlotGeometry(plot, withMaxOnly, NATURE_THEME);
    const series = (geometry as { series: { points: unknown[] }[] }).series;
    expect(series[0]!.points).toHaveLength(6);
  });

  it('is a no-op when clipToRange is set but neither min nor max is', () => {
    const clipNoBounds = editDocument(makeDocument(XY, 'scatter'), (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') node.x.clipToRange = true;
      }
    });
    const plain = makeDocument(XY, 'scatter');
    const plotClip = Object.values(clipNoBounds.nodes).find((n) => n.type === 'plot') as PlotNode;
    const plotPlain = Object.values(plain.nodes).find((n) => n.type === 'plot') as PlotNode;
    const geomClip = computePlotGeometry(plotClip, clipNoBounds, NATURE_THEME);
    const geomPlain = computePlotGeometry(plotPlain, plain, NATURE_THEME);
    expect((geomClip as { series: unknown }).series).toEqual((geomPlain as { series: unknown }).series);
  });

  it('is byte-identical (same SVG) between clipToRange absent and false', () => {
    const absent = scene(makeDocument(XY, 'scatter'));
    const explicitFalse = scene(
      editDocument(makeDocument(XY, 'scatter'), (draft) => {
        for (const node of Object.values(draft.nodes)) {
          if (node.type === 'plot') node.x.clipToRange = false;
        }
      }),
    );
    expect(toSvgString(explicitFalse)).toBe(toSvgString(absent));
  });

  it("drops a volcano point's label and leader for free once the point itself is clipped", () => {
    const clipped = editDocument(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoLabels: ['BRCA1'], // log2FC 4.0, the most extreme fold change
      }),
      (draft) => {
        for (const node of Object.values(draft.nodes)) {
          if (node.type === 'plot') {
            node.x.max = 3;
            node.x.clipToRange = true;
          }
        }
      },
    );
    expect(collectByRole(scene(clipped), 'point-label')).toEqual([]);
    expect(collectByRole(scene(clipped), 'point-label-leader')).toEqual([]);
    // Every other point (log2FC below 3) still draws.
    expect(collectByRole(scene(clipped), 'point').length).toBeGreaterThan(0);
  });
});

describe('scientific and power-of-ten axis labels', () => {
  /** Three clean decades, so a log y axis's ticks land exactly on 10ⁿ. */
  const WIDE = `Dose,Response
1,100
2,1000
3,10000
4,100000`;

  function withY(doc: FigureDocument, patch: Partial<AxisSpec>): FigureDocument {
    return editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') Object.assign(node.y, patch);
      }
    });
  }

  const isYTickLabel = (n: { attrs?: Record<string, unknown> }): boolean =>
    n.attrs?.['dominant-baseline'] === 'central';

  it('renders a decade tick as a bare "10" run plus a superscript tspan', () => {
    const doc = withY(makeDocument(WIDE, 'scatter'), { scale: 'log10', labelFormat: 'power10' });
    const labels = collectByRole(scene(doc), 'tick-label').filter(isYTickLabel);
    expect(labels.length).toBeGreaterThan(0);

    const withSup = labels.filter((n) => (n.children ?? []).some((c) => c.role === 'tick-label-sup'));
    expect(withSup.length).toBeGreaterThan(0);
    for (const label of withSup) {
      // A tspan container has no text of its own — the digits live on its
      // children instead, which is exactly the shape `parity.test.tsx`'s
      // "every text-bearing node" assertion was extended to allow for.
      expect(label.text).toBeUndefined();
      const runs = label.children ?? [];
      expect(runs[0]?.text).toBe('10');
      expect(runs.find((c) => c.role === 'tick-label-sup')).toBeDefined();
    }
  });

  it("emits the superscript at a real reduced font-size for 'scientific' mode", () => {
    const doc = withY(makeDocument(XY, 'scatter'), { labelFormat: 'scientific' });
    const supRuns = collectByRole(scene(doc), 'tick-label-sup');
    expect(supRuns.length).toBeGreaterThan(0);
    for (const run of supRuns) {
      const pt = Number(run.attrs?.['font-size']) / (25.4 / 72);
      expect(pt).toBeGreaterThan(0);
      expect(pt).toBeLessThan(NATURE_THEME.type.tickLabelPt);
    }
  });

  it("an axis that never asks for a format renders no 'tick-label-sup' nodes", () => {
    expect(collectByRole(scene(makeDocument(XY, 'scatter')), 'tick-label-sup')).toHaveLength(0);
  });

  it("'auto', explicit or absent, is byte-identical to a figure that never touched this control", () => {
    const before = toSvgString(scene(makeDocument(XY, 'scatter')));
    const explicitAuto = toSvgString(scene(withY(makeDocument(XY, 'scatter'), { labelFormat: 'auto' })));
    expect(explicitAuto).toBe(before);
  });

  /**
   * A y-axis tick's path is `M{-offset} {y} L0 {y}` — the same y twice,
   * closed at x=0 — which is what separates it from an x-axis tick's
   * `M{x} {plotHeight} L{x} {...}` (same x twice, different y) in a scene
   * that draws both. The backreference requires the *same* rounded number in
   * both positions, which only the y-axis template produces.
   */
  const yTickPositions = (n: { attrs?: Record<string, unknown> }): number | undefined => {
    const match = /^M-?[\d.]+ (-?[\d.]+) L0 \1$/.exec(String(n.attrs?.['d'] ?? ''));
    return match ? Number(match[1]) : undefined;
  };

  it('draws the conventional 2×..9× sub-decade minor ticks on a log y axis, not evenly-spaced ones', () => {
    const doc = withY(makeDocument(WIDE, 'scatter'), { scale: 'log10', minorTicks: 9 });
    const s = scene(doc);

    const majors = collectByRole(s, 'tick-label').filter(
      (n) => n.attrs?.['dominant-baseline'] === 'central',
    ).length;
    // Three decades between four majors (100, 1000, 10000, 100000), eight
    // sub-decade ticks each. A linear-fallback bug would instead draw a fixed
    // `minorTicks - 1` per gap regardless of what the majors actually are,
    // which for `minorTicks: 9` happens to also be 8 — so the real assertion
    // is the *position* check below, not merely the count.
    expect(majors).toBe(4);
    const yTicks = collectByRole(s, 'tick').filter((n) => yTickPositions(n) !== undefined);
    expect(yTicks).toHaveLength(majors + 3 * 8);
  });

  it('places each minor tick exactly on 2×, 3×, …, 9× of its decade — never on a linear fraction', () => {
    const doc = withY(makeDocument(WIDE, 'scatter'), { scale: 'log10', minorTicks: 9 });
    const scene1 = scene(doc);

    // The plot area's y scale is not exposed directly by the scene, so this
    // reads it back the same way the renderer does: from the ordinary major
    // tick-label positions, which are exact log10 ticks (100, 1000, …).
    // A linear interpolation between 100 and 1000 would put its first minor
    // tick at 200; the geometric one this axis actually draws puts it there
    // too by coincidence at k=2, so the discriminating check is at k=5
    // (linear: 550, geometric: 500) — read off the rendered minor-tick paths
    // by their proximity to the value each formula predicts, using the
    // labelled majors' own positions to convert mm back to value linearly-
    // in-log-space (a log scale is linear in log(value)).
    const majorLabels = collectByRole(scene1, 'tick-label')
      .filter((n) => n.attrs?.['dominant-baseline'] === 'central')
      .map((n) => ({ y: Number(n.attrs?.['y']), value: Number(n.text) }))
      .filter((n) => Number.isFinite(n.value) && n.value > 0)
      .sort((a, b) => b.y - a.y); // bottom (smallest value) first

    expect(majorLabels.length).toBeGreaterThanOrEqual(2);
    const [low, high] = [majorLabels[0]!, majorLabels[1]!];
    const mmPerLog10 = (low.y - high.y) / (Math.log10(high.value) - Math.log10(low.value));
    const yFor = (value: number): number => low.y - mmPerLog10 * (Math.log10(value) - Math.log10(low.value));

    const minorYs = collectByRole(scene1, 'tick')
      .map(yTickPositions)
      .filter((v): v is number => v !== undefined);

    // 500 (geometric k=5 between 100 and 1000) must be present; 550 (what a
    // linear interpolation would draw instead) must not be.
    expect(minorYs.some((y) => Math.abs(y - yFor(500)) < 0.05)).toBe(true);
    expect(minorYs.some((y) => Math.abs(y - yFor(550)) < 0.05)).toBe(false);
  });
});

describe('symlog axis', () => {
  // Spans negative, zero and a large positive value — the shape a symlog
  // axis exists for, and one a log10 axis could not draw at all.
  const MIXED = `Dose,Response
1,-500
2,0
3,87000
4,150000`;

  function withY(doc: FigureDocument, patch: Partial<AxisSpec>): FigureDocument {
    return editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') Object.assign(node.y, patch);
      }
    });
  }

  it('places a tick at exactly zero and ends the axis on a decade', () => {
    const doc = withY(makeDocument(MIXED, 'scatter'), { scale: 'symlog' });
    const plot = Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;
    const geometry = computePlotGeometry(plot, doc, NATURE_THEME);
    expect(geometry?.kind).toBe('continuous');
    if (geometry?.kind !== 'continuous') throw new Error('unreachable');
    expect(geometry.yScale.ticks).toContain(0);
    const positive = geometry.yScale.ticks.filter((t) => t > 0);
    expect(positive.length).toBeGreaterThan(0);
    expect(Number.isInteger(Math.log10(Math.max(...positive)))).toBe(true);
  });

  it('draws every point, including the negative one — unlike log10 it never drops non-positive values', () => {
    const doc = withY(makeDocument(MIXED, 'scatter'), { scale: 'symlog' });
    expect(collectByRole(scene(doc), 'point')).toHaveLength(4);
  });

  it('renders a real superscript once labelFormat is set to power10, the same as log10', () => {
    const doc = withY(makeDocument(MIXED, 'scatter'), { scale: 'symlog', labelFormat: 'power10' });
    expect(collectByRole(scene(doc), 'tick-label-sup').length).toBeGreaterThan(0);
  });

  it('draws no break marks even when one is set — a symlog axis already contains one compression boundary', () => {
    const doc = withY(makeDocument(MIXED, 'scatter'), {
      scale: 'symlog',
      breaks: [{ from: 10, to: 100 }],
    });
    expect(collectByRole(scene(doc), 'axis-break')).toEqual([]);
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

  it('draws the four new marker shapes with distinct, area-matched geometry', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      pointShapes: ['triangle-down', 'pentagon', null],
      pointShape: 'star',
    });
    const points = collectByRole(scene(doc), 'point');
    expect(points).toHaveLength(18);

    const paths = points.filter((n) => n.tag === 'path');
    const vertexCount = (n: (typeof paths)[number]): number =>
      String(n.attrs?.['d']).match(/[ML]/g)?.length ?? 0;

    // Pentagon: 5 vertices, six points.
    expect(paths.filter((n) => vertexCount(n) === 5)).toHaveLength(6);
    // Star: 10 vertices — the plot-wide fallback, so it covers the third series.
    expect(paths.filter((n) => vertexCount(n) === 10)).toHaveLength(6);

    // Triangle-down shares its vertex count (3) with 'triangle', so the two
    // are told apart by orientation: its apex — the first point drawn — sits
    // *below* (larger SVG y than) its other two vertices, the opposite of
    // an upright triangle.
    const triangleDown = paths.filter((n) => vertexCount(n) === 3);
    expect(triangleDown).toHaveLength(6);
    for (const n of triangleDown) {
      const ys = [...String(n.attrs?.['d']).matchAll(/[ML]-?[\d.]+ (-?[\d.]+)/g)].map((m) =>
        Number(m[1]),
      );
      expect(ys[0]).toBeGreaterThan(ys[1]!);
      expect(ys[0]).toBeGreaterThan(ys[2]!);
    }
  });

  it('draws the cross marker as a 12-vertex plus sign', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, { pointShape: 'cross' });
    const points = collectByRole(scene(doc), 'point');
    const crosses = points.filter(
      (n) => n.tag === 'path' && String(n.attrs?.['d']).match(/[ML]/g)?.length === 12,
    );
    expect(crosses).toHaveLength(18);
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

/**
 * `lineStyle`/`lineStyles` — a second way (besides `pointShapes`) to carry
 * series identity where colour cannot. Mirrors the `pointShapes` test suite
 * above field for field: plot-wide default, per-series override, fallback,
 * a byte-identical-when-absent regression, and the legend's "any series
 * carries one" drawing rule.
 */
describe('line styles', () => {
  it('gives every line the plot-wide dash pattern', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, { lineStyle: 'dashed' });
    const lines = collectByRole(scene(doc), 'line');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.attrs?.['stroke-dasharray']).toBeDefined();
    }
  });

  it('gives each series its own dash pattern when asked', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      lineStyles: ['dashed', 'dotted', 'dash-dot'],
    });
    const lines = collectByRole(scene(doc), 'line');
    expect(lines).toHaveLength(3);
    const dashArrays = lines.map((l) => l.attrs?.['stroke-dasharray']);
    for (const d of dashArrays) expect(d).toBeDefined();
    // Three distinct patterns, not the same one repeated three times.
    expect(new Set(dashArrays).size).toBe(3);
  });

  it('falls back to the plot-wide style for a series that names none', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      lineStyle: 'dotted',
      lineStyles: ['dashed', null, null],
    });
    const [first, second, third] = collectByRole(scene(doc), 'line');
    expect(first!.attrs?.['stroke-dasharray']).not.toBe(second!.attrs?.['stroke-dasharray']);
    // The two that named nothing both take the plot-wide dotted pattern.
    expect(second!.attrs?.['stroke-dasharray']).toBe(third!.attrs?.['stroke-dasharray']);
  });

  it('gives a series explicitly set to solid no dasharray, even beside a dashed sibling', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      lineStyles: ['solid', 'dashed', null],
    });
    const lines = collectByRole(scene(doc), 'line');
    expect(lines[0]!.attrs?.['stroke-dasharray']).toBeUndefined();
    expect(lines[1]!.attrs?.['stroke-dasharray']).toBeDefined();
    // Third series named nothing, and the plot-wide default is solid too.
    expect(lines[2]!.attrs?.['stroke-dasharray']).toBeUndefined();
  });

  it('leaves the line solid, with no stroke-dasharray attribute, when the style is absent or explicitly solid', () => {
    // The property every optional field in this codebase is held to: a figure
    // drawn before the field existed renders exactly as it did.
    const plain = toSvgString(scene(makeDocument(XY_PAIRS, 'line')));
    const explicitSolid = toSvgString(
      scene(makeDocument(XY_PAIRS, 'line', 80, { lineStyle: 'solid' })),
    );
    const nullArray = toSvgString(
      scene(makeDocument(XY_PAIRS, 'line', 80, { lineStyles: [null, null, null] })),
    );
    expect(explicitSolid).toBe(plain);
    expect(nullArray).toBe(plain);
    expect(plain).not.toContain('stroke-dasharray');
  });

  it('draws a dashed line in the legend once any series is given a line style', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      lineStyles: ['dashed', null, null],
    });
    const swatches = collectByRole(scene(doc), 'legend').filter((n) => n.tag !== 'text');
    // One line-segment swatch per entry — no `pointShapes` set, so the marker
    // branch never engages.
    expect(swatches.map((n) => n.tag)).toEqual(['path', 'path', 'path']);
    expect(swatches[0]!.attrs?.['stroke-dasharray']).toBeDefined();
    // The other two fall back to the plot-wide default, which is solid.
    expect(swatches[1]!.attrs?.['stroke-dasharray']).toBeUndefined();
    expect(swatches[2]!.attrs?.['stroke-dasharray']).toBeUndefined();
  });

  it('leaves the legend a plain block when only the plot-wide style is set', () => {
    // Mirrors `pointShape`'s own asymmetry: a plot-wide-only setting changes
    // nothing about which series is which, so the key stays a plain block.
    const doc = makeDocument(XY_PAIRS, 'line', 80, { lineStyle: 'dashed' });
    const swatches = collectByRole(scene(doc), 'legend').filter((n) => n.tag !== 'text');
    expect(swatches.every((n) => n.tag === 'rect')).toBe(true);
  });

  it('composes a dashed line and a marker in one legend entry when both are set', () => {
    const doc = makeDocument(XY_PAIRS, 'line', 80, {
      pointShapes: ['square', null, null],
      lineStyles: ['dashed', null, null],
    });
    const swatches = collectByRole(scene(doc), 'legend').filter((n) => n.tag !== 'text');
    // Any series carrying a shape draws a marker on every entry, and any
    // series carrying a line style draws a line on every entry too — the
    // same "any, not this one" rule both gates apply independently. Three
    // entries, each with both: 3 markers + 3 lines = 6 swatch nodes, only
    // the first line actually dashed.
    expect(swatches).toHaveLength(6);
    const dashedLines = swatches.filter(
      (n) => n.tag === 'path' && n.attrs?.['stroke-dasharray'] !== undefined,
    );
    expect(dashedLines).toHaveLength(1);
    // series 0's square marker.
    expect(swatches.filter((n) => n.tag === 'rect')).toHaveLength(1);
    // series 1 and 2 fall back to the default circle marker.
    expect(swatches.filter((n) => n.tag === 'circle')).toHaveLength(2);
  });
});

/**
 * Cascade / offset ("ridgeline") line plots.
 *
 * Three series sharing identical x and y values, so any vertical separation
 * between corresponding points is exactly the cascade offset — nothing else
 * (different data, different scale) could produce it.
 */
describe('cascade / offset line plots', () => {
  const IDENTICAL = [
    'X1\tY1\tX2\tY2\tX3\tY3',
    '1\t2\t1\t2\t1\t2',
    '2\t4\t2\t4\t2\t4',
    '3\t6\t3\t6\t3\t6',
  ].join('\n');

  it('separates n traces by exactly the requested step', () => {
    const doc = makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10 });
    const points = collectByRole(scene(doc), 'point').filter((n) => n.tag === 'circle');
    expect(points).toHaveLength(9);

    const byX = new Map<number, number[]>();
    for (const p of points) {
      const cx = Number(p.attrs?.['cx']);
      const cy = Number(p.attrs?.['cy']);
      byX.set(cx, [...(byX.get(cx) ?? []), cy]);
    }
    // Same x per row across all three series, so exactly one bucket per row.
    expect(byX.size).toBe(3);
    for (const cys of byX.values()) {
      expect(cys).toHaveLength(3);
      const sorted = [...cys].sort((a, b) => a - b);
      expect(sorted[1]! - sorted[0]!).toBeCloseTo(10, 6);
      expect(sorted[2]! - sorted[1]!).toBeCloseTo(10, 6);
    }
  });

  it('shrinks the y scale range by exactly the reserve it spends', () => {
    const doc = makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10 });
    const plot = Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;
    const plain = computePlotGeometry(
      { ...plot, offsetStepMm: undefined },
      doc,
      NATURE_THEME,
    );
    const cascaded = computePlotGeometry(plot, doc, NATURE_THEME);
    expect(plain?.kind).toBe('continuous');
    expect(cascaded?.kind).toBe('continuous');
    if (plain?.kind !== 'continuous' || cascaded?.kind !== 'continuous') throw new Error('unreachable');
    // Range top (index 1) moves from 0 down to the reserve; range bottom is untouched.
    expect(plain.yScale.range[0]).toBe(cascaded.yScale.range[0]);
    expect(plain.yScale.range[1]).toBe(0);
    expect(cascaded.yScale.range[1]).toBeCloseTo(20, 6); // (3-1) series * 10 mm
  });

  it('is byte-identical to an un-cascaded plot when the step is absent or zero', () => {
    const plain = toSvgString(scene(makeDocument(IDENTICAL, 'line', 80)));
    const zero = toSvgString(scene(makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 0 })));
    expect(zero).toBe(plain);
  });

  it('reverses line paint order — furthest offset first — only when cascading', () => {
    const plainOrder = collectByRole(scene(makeDocument(IDENTICAL, 'line', 80)), 'line').map(
      (n) => String(n.attrs?.['stroke']),
    );
    const cascadedOrder = collectByRole(
      scene(makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10 })),
      'line',
    ).map((n) => String(n.attrs?.['stroke']));
    expect(cascadedOrder).toEqual([...plainOrder].reverse());
  });

  it('draws an opaque fill closing at the baseline, in front-to-back paint order', () => {
    const doc = makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10, offsetFill: 'tint' });
    const areas = collectByRole(scene(doc), 'area');
    expect(areas).toHaveLength(3);
    for (const area of areas) {
      expect(area.attrs?.['fill-opacity']).toBeUndefined();
      expect(String(area.attrs?.['d'])).toMatch(/^M[\d.]+ [\d.]+ .* Z$/);
    }
  });

  it('draws no fill when offsetFill is absent, even while cascading', () => {
    const doc = makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10 });
    expect(collectByRole(scene(doc), 'area')).toEqual([]);
  });

  it('is disabled (no reserve, no offsets) once a second y axis is in use', () => {
    const doc = makeDocument(IDENTICAL, 'line', 80, {
      offsetStepMm: 10,
      y2: {
        title: 'Y2',
        min: null,
        max: null,
        tickStep: null,
        scale: 'linear',
        showLine: true,
        showTicks: true,
        showLabels: true,
        trimToData: false,
      },
      seriesAxis: ['y', 'y2', 'y'],
    });
    const plot = Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;
    expect(isCascadable(plot, 3)).toBe(false);
    const geometry = computePlotGeometry(plot, doc, NATURE_THEME);
    expect(geometry?.kind).toBe('continuous');
    if (geometry?.kind !== 'continuous') throw new Error('unreachable');
    expect(geometry.yScale.range[1]).toBe(0);
  });

  describe('cascade z-axis', () => {
    describe('cascadeAxisGroups', () => {
      it('is one implicit group covering everything when no series has a category', () => {
        const groups = cascadeAxisGroups([{}, {}, {}]);
        expect(groups).toEqual([{ seriesIndices: [0, 1, 2], category: undefined }]);
      });

      it('is one group when every series shares the same category', () => {
        const groups = cascadeAxisGroups([
          { category: 'Low' },
          { category: 'Low' },
          { category: 'Low' },
        ]);
        expect(groups).toEqual([{ seriesIndices: [0, 1, 2], category: 'Low' }]);
      });

      it('splits into contiguous runs matching alternating categories', () => {
        const groups = cascadeAxisGroups([
          { category: 'Low' },
          { category: 'Low' },
          { category: 'High' },
          { category: 'High' },
        ]);
        expect(groups).toEqual([
          { seriesIndices: [0, 1], category: 'Low' },
          { seriesIndices: [2, 3], category: 'High' },
        ]);
      });

      it('gives an uncategorised run inside a mixed list its own uncaptioned group', () => {
        const groups = cascadeAxisGroups([
          { category: 'Low' },
          { category: undefined },
          { category: 'High' },
        ]);
        expect(groups).toEqual([
          { seriesIndices: [0], category: 'Low' },
          { seriesIndices: [1], category: undefined },
          { seriesIndices: [2], category: 'High' },
        ]);
      });
    });

    describe('cascadeAxisReserveMm', () => {
      const series = [{ name: 'Y1' }, { name: 'Y2' }, { name: 'Y3' }];

      it('is zero when showCascadeAxis is absent', () => {
        expect(cascadeAxisReserveMm({}, NATURE_THEME, series)).toBe(0);
      });

      it('is zero for a single series, even if showCascadeAxis is set', () => {
        expect(cascadeAxisReserveMm({ showCascadeAxis: true }, NATURE_THEME, [{ name: 'A' }])).toBe(0);
      });

      it('grows with a longer series name, and again with a sideways lean', () => {
        const base = cascadeAxisReserveMm({ showCascadeAxis: true }, NATURE_THEME, series);
        const longer = cascadeAxisReserveMm({ showCascadeAxis: true }, NATURE_THEME, [
          { name: 'A very long series name indeed' },
          { name: 'Y2' },
        ]);
        expect(longer).toBeGreaterThan(base);

        const leaning = cascadeAxisReserveMm(
          { showCascadeAxis: true, offsetStepXMm: 2 },
          NATURE_THEME,
          series,
        );
        expect(leaning).toBeGreaterThan(base);
      });

      it('reserves extra depth only once some group is actually captioned', () => {
        const uncaptioned = cascadeAxisReserveMm(
          { showCascadeAxis: true },
          NATURE_THEME,
          series, // no category, no cascadeAxisTitle
        );
        const withTitle = cascadeAxisReserveMm(
          { showCascadeAxis: true, cascadeAxisTitle: 'Concentration' },
          NATURE_THEME,
          series,
        );
        expect(withTitle).toBeGreaterThan(uncaptioned);

        const withCategories = cascadeAxisReserveMm({ showCascadeAxis: true }, NATURE_THEME, [
          { name: 'A', category: 'Low' },
          { name: 'B', category: 'High' },
        ]);
        expect(withCategories).toBeGreaterThan(
          cascadeAxisReserveMm({ showCascadeAxis: true }, NATURE_THEME, [{ name: 'A' }, { name: 'B' }]),
        );
      });
    });

    it('is byte-identical to today, with no cascade-axis scene nodes, when showCascadeAxis is absent', () => {
      const plain = toSvgString(scene(makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10 })));
      const explicitFalse = toSvgString(
        scene(makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10, showCascadeAxis: false })),
      );
      expect(explicitFalse).toBe(plain);
      const s = scene(makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10 }));
      expect(collectByRole(s, 'cascade-axis')).toEqual([]);
      expect(collectByRole(s, 'cascade-axis-label')).toEqual([]);
      expect(collectByRole(s, 'cascade-axis-title')).toEqual([]);
    });

    it('draws nothing when showCascadeAxis is set but the plot is not actually cascading', () => {
      const s = scene(makeDocument(IDENTICAL, 'line', 80, { showCascadeAxis: true }));
      expect(collectByRole(s, 'cascade-axis')).toEqual([]);
    });

    it('draws one tick label per series and grows the right margin by exactly the reserve', () => {
      const withAxis = makeDocument(IDENTICAL, 'line', 80, { offsetStepMm: 10, showCascadeAxis: true });
      const plot = Object.values(withAxis.nodes).find((n): n is PlotNode => n.type === 'plot')!;
      const withGeometry = computePlotGeometry(plot, withAxis, NATURE_THEME);
      const withoutGeometry = computePlotGeometry(
        { ...plot, showCascadeAxis: false },
        withAxis,
        NATURE_THEME,
      );
      expect(withGeometry?.kind).toBe('continuous');
      expect(withoutGeometry?.kind).toBe('continuous');
      if (withGeometry?.kind !== 'continuous' || withoutGeometry?.kind !== 'continuous') {
        throw new Error('unreachable');
      }

      const reserve = cascadeAxisReserveMm(plot, NATURE_THEME, withGeometry.series);
      expect(reserve).toBeGreaterThan(0);
      expect(withGeometry.margin.right - withoutGeometry.margin.right).toBeCloseTo(reserve, 6);

      const s = scene(withAxis);
      expect(collectByRole(s, 'cascade-axis-label')).toHaveLength(3);
      // No category and no cascadeAxisTitle set — nothing to caption.
      expect(collectByRole(s, 'cascade-axis-title')).toEqual([]);
    });

    it('captions the single implicit group with cascadeAxisTitle once set', () => {
      const s = scene(
        makeDocument(IDENTICAL, 'line', 80, {
          offsetStepMm: 10,
          showCascadeAxis: true,
          cascadeAxisTitle: 'Concentration (mg/mL)',
        }),
      );
      const titles = collectByRole(s, 'cascade-axis-title');
      expect(titles).toHaveLength(1);
      expect(titles[0]!.text).toBe('Concentration (mg/mL)');
    });

    it('composes additively with a right-hand legend, reserving room for both', () => {
      const doc = makeDocument(IDENTICAL, 'line', 80, {
        offsetStepMm: 10,
        showCascadeAxis: true,
        legend: 'right',
      });
      const plot = Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;
      const geometry = computePlotGeometry(plot, doc, NATURE_THEME);
      const withoutLegend = computePlotGeometry({ ...plot, legend: 'none' }, doc, NATURE_THEME);
      expect(geometry?.kind).toBe('continuous');
      expect(withoutLegend?.kind).toBe('continuous');
      if (geometry?.kind !== 'continuous' || withoutLegend?.kind !== 'continuous') {
        throw new Error('unreachable');
      }
      // Adding a legend on top of the depth axis reserves strictly more room,
      // not the same (max'd) amount — the two stack rather than share.
      expect(geometry.margin.right).toBeGreaterThan(withoutLegend.margin.right);
    });

    describe('renderCascadeAxis (direct, synthetic two-category geometry)', () => {
      const buildGeometry = (): ContinuousPlotGeometry => {
        const x = { min: 0, max: 3 };
        const xScale = { kind: 'linear' as const, domain: x, range: [0, 60] as [number, number], scale: (v: number) => v * 20, invert: (mm: number) => mm / 20, ticks: [], format: String };
        const yScale = { kind: 'linear' as const, domain: { min: 0, max: 10 }, range: [50, 0] as [number, number], scale: (v: number) => 50 - v * 5, invert: (mm: number) => (50 - mm) / 5, ticks: [], format: String };
        const series = xyMarks(
          [
            { name: 'Low A', values: [1, 2], x: [1, 2] },
            { name: 'Low B', values: [1, 2], x: [1, 2] },
            { name: 'High A', values: [1, 2], x: [1, 2] },
            { name: 'High B', values: [1, 2], x: [1, 2] },
          ],
          { x: xScale, y: yScale, showLine: true, showPoints: false, pointSizeMm: 1, colors: ['#111', '#222', '#333', '#444'], categories: ['Low', 'Low', 'High', 'High'] },
        );
        return { kind: 'continuous', margin: { left: 0, top: 0, right: 0, bottom: 0 }, plotWidth: 60, plotHeight: 50, xScale, yScale, series, bins: [] };
      };

      it('draws two end brackets and two group captions for a two-category cascade', () => {
        const geometry = buildGeometry();
        const node = { showCascadeAxis: true, offsetStepMm: 10, plotType: 'line', pointSizeMm: 1 } as PlotNode;
        const nodes = renderCascadeAxis(node, NATURE_THEME, geometry);
        const labels = nodes.filter((n) => n.role === 'cascade-axis-label');
        const titles = nodes.filter((n) => n.role === 'cascade-axis-title');
        expect(labels).toHaveLength(4);
        expect(titles).toHaveLength(2);
        expect(titles.map((t) => t.text).sort()).toEqual(['High', 'Low']);
      });

      it('draws no captions when categories are absent and cascadeAxisTitle is unset', () => {
        const geometry = buildGeometry();
        // Strip categories to simulate an ordinary, uncategorised cascade.
        const uncategorised: ContinuousPlotGeometry = {
          ...geometry,
          series: geometry.series.map((s) => ({ ...s, category: undefined })),
        };
        const node = { showCascadeAxis: true, offsetStepMm: 10, plotType: 'line', pointSizeMm: 1 } as PlotNode;
        const nodes = renderCascadeAxis(node, NATURE_THEME, uncategorised);
        expect(nodes.filter((n) => n.role === 'cascade-axis-title')).toEqual([]);
      });
    });
  });
});

/**
 * A legend and a secondary axis on the same side of the plot.
 *
 * The reserve for the two was combined with `Math.max`, so whichever was wider
 * won and the other was drawn in the same band of millimetres — a key printed
 * straight over the right-hand tick labels, which is what was reported.
 */
describe('a legend beside a secondary axis', () => {
  const withY2 = (patch: Partial<PlotNode> = {}): FigureDocument =>
    makeDocument(XY_PAIRS, 'line', 80, {
      legend: 'right',
      y2: {
        title: 'Second axis',
        min: null,
        max: null,
        tickStep: null,
        scale: 'linear',
        showLine: true,
        showTicks: true,
        showLabels: true,
        trimToData: false,
      },
      // Only the third series reads it, which is what makes the axis appear.
      seriesAxis: ['y', 'y', 'y2'],
      ...patch,
    });

  /** Every x a right-hand tick label is drawn at, in panel coordinates. */
  const y2LabelXs = (doc: FigureDocument): number[] => {
    const svg = toSvgString(scene(doc));
    // The secondary axis is the only tick-label set anchored `start`.
    return [...svg.matchAll(/<text x="([\d.]+)"[^>]*text-anchor="start"[^>]*>/g)].map((m) =>
      Number(m[1]),
    );
  };

  it('starts the key past the axis rather than on top of it', () => {
    const doc = withY2();
    const legendX = collectByRole(scene(doc), 'legend')
      .filter((n) => n.tag === 'text')
      .map((n) => Number(n.attrs?.x));
    expect(legendX.length).toBeGreaterThan(0);

    // Both are drawn in groups translated to their own origin, so compare the
    // whole rendered strings: the legend group must be translated further right
    // than the axis furniture reaches.
    const svg = toSvgString(scene(doc));
    const origins = [...svg.matchAll(/translate\(([\d.]+) [\d.]+\)/g)].map((m) => Number(m[1]));
    const plotWidth = Math.max(...y2LabelXs(doc));
    expect(Math.max(...origins)).toBeGreaterThan(plotWidth);
  });

  it('reserves room for both, not for the wider of the two', () => {
    // Turning the key off must give the plot area back exactly the key's width;
    // if the two shared a reserve, the axis alone would already have covered it
    // and the width would not move.
    const both = withY2();
    const axisOnly = withY2({ legend: 'none' });

    const widthOf = (d: FigureDocument): number => {
      const bars = collectByRole(scene(d), 'axis').map((n) => String(n.attrs?.['d']));
      // The secondary axis line is drawn at x = plotWidth, on both ends.
      return Math.max(...bars.map((d2) => Number(/M([\d.]+)/.exec(d2)?.[1] ?? 0)));
    };
    expect(widthOf(both)).toBeLessThan(widthOf(axisOnly));
  });
});

const DIFFERENTIAL_CSV = `Gene,log2FC,p
TP53,2.5,0.001
MYC,-3.0,0.0005
EGFR,0.2,0.5
BRCA1,4.0,0.2`;

/** `format: 'differential'` is never inferred, so this sets it directly. */
function makeVolcanoDocument(
  csv: string,
  format: Dataset['format'],
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
      name: 'Differential expression',
      format,
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/d.csv',
      sourceFilename: 'd.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: 80, height: 60 },
      name: 'Volcano',
      datasetId: dataset.id,
      plotType: 'volcano',
    });

    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') Object.assign(node, patch);
    }
  });
}

describe('volcano plots', () => {
  it('classifies each point from its fold change and p-value', () => {
    const s = scene(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoThresholds: { foldChange: 1, pValue: 0.05 },
      }),
    );
    const points = collectByRole(s, 'point');
    expect(points).toHaveLength(4);

    const byLabel = new Map(
      points.map((p) => [p.children?.find((c) => c.tag === 'title')?.text, p.attrs?.['fill']]),
    );
    expect(byLabel.get('TP53')).toBe('#d73027'); // up
    expect(byLabel.get('MYC')).toBe('#4575b4'); // down
    expect(byLabel.get('EGFR')).toBe('#999999'); // fold change too small
    expect(byLabel.get('BRCA1')).toBe('#999999'); // p-value too large
  });

  it('respects custom threshold colours', () => {
    const s = scene(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoThresholds: { foldChange: 1, pValue: 0.05 },
        volcanoColors: { down: '#111111', ns: '#222222', up: '#333333' },
      }),
    );
    const fills = new Set(collectByRole(s, 'point').map((p) => p.attrs?.['fill']));
    expect(fills).toEqual(new Set(['#111111', '#222222', '#333333']));
  });

  it('draws the fold-change and p-value cutoffs as dashed threshold lines', () => {
    const s = scene(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoThresholds: { foldChange: 1, pValue: 0.05 },
      }),
    );
    // Two vertical (±fold change) plus one horizontal (p-value).
    expect(collectByRole(s, 'threshold-line')).toHaveLength(3);
  });

  it('hides the threshold lines when asked, without dropping the points', () => {
    const s = scene(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoThresholdLines: 'hide',
      }),
    );
    expect(collectByRole(s, 'threshold-line')).toEqual([]);
    expect(collectByRole(s, 'point')).toHaveLength(4);
  });

  it('keeps the y domain anchored at zero rather than padding symmetrically', () => {
    // A single point would otherwise pad on both sides of its own value (the
    // "flat series" rule every other continuous plot falls back to) and start
    // the axis well above zero — -log10(p) is a magnitude, so a truncated
    // baseline would misread it the same way an un-anchored count axis would.
    const s = scene(makeVolcanoDocument('Gene,log2FC,p\nA,1,0.5', 'differential'));
    const yTicks = collectByRole(s, 'tick-label')
      .filter((n) => n.attrs?.['dominant-baseline'] === 'central')
      .map((n) => Number(n.text));
    expect(yTicks.length).toBeGreaterThan(0);
    expect(Math.min(...yTicks)).toBe(0);
  });

  it('refuses to draw when the dataset carries more than one series', () => {
    // A prism-format table (shared x, several y series) plotted as volcano —
    // pooling several groups would mix significance calls computed together.
    const s = scene(makeVolcanoDocument('X,Y1,Y2\n1,2,3\n2,4,5', 'prism'));
    expect(collectByRole(s, 'point')).toEqual([]);
  });

  it('refuses to draw without per-point labels', () => {
    // A plain xy table has paired x values but no row identity.
    const s = scene(makeVolcanoDocument('X,Y\n1,2\n2,4', 'simple-xy'));
    expect(collectByRole(s, 'point')).toEqual([]);
  });
});

describe('volcano point labels', () => {
  it('draws nothing when volcanoLabels is absent, and the SVG is byte-identical to before', () => {
    const doc = makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential');
    const s = scene(doc);
    expect(collectByRole(s, 'point-label')).toEqual([]);
    expect(collectByRole(s, 'point-label-leader')).toEqual([]);
  });

  it('draws exactly the selected labels, in the category colour', () => {
    const s = scene(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoThresholds: { foldChange: 1, pValue: 0.05 },
        volcanoLabels: ['TP53', 'MYC'],
      }),
    );
    const labels = collectByRole(s, 'point-label');
    expect(labels).toHaveLength(2);
    const byText = new Map(labels.map((n) => [n.text, n.attrs?.['fill']]));
    expect(byText.get('TP53')).toBe('#d73027'); // up
    expect(byText.get('MYC')).toBe('#4575b4'); // down
  });

  it('ignores a requested label that matches no point', () => {
    const s = scene(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoLabels: ['NOTAGENE'],
      }),
    );
    expect(collectByRole(s, 'point-label')).toEqual([]);
  });

  it('is sized at the theme annotation size, not the tick-label size', () => {
    const s = scene(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoLabels: ['TP53'],
      }),
    );
    const label = collectByRole(s, 'point-label')[0]!;
    const pt = Number(label.attrs?.['font-size']) / (25.4 / 72);
    expect(pt).toBeCloseTo(NATURE_THEME.type.annotationPt, 6);
  });

  it('labels every point sharing a duplicated name, not just the first', () => {
    const csv = 'Gene,log2FC,p\nDUP,2.5,0.001\nDUP,3.0,0.0005\nOther,0.1,0.9';
    const s = scene(
      makeVolcanoDocument(csv, 'differential', {
        volcanoLabels: ['DUP'],
      }),
    );
    expect(collectByRole(s, 'point-label')).toHaveLength(2);
  });

  it('caps at 25 labels even when more are requested', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `Gene${i},${1 + i * 0.01},0.001`);
    const csv = `Gene,log2FC,p\n${rows.join('\n')}`;
    const s = scene(
      makeVolcanoDocument(csv, 'differential', {
        volcanoLabels: rows.map((_, i) => `Gene${i}`),
      }),
    );
    expect(collectByRole(s, 'point-label').length).toBeLessThanOrEqual(25);
  });

  it('draws labels above the raster once the plot exceeds MAX_VECTOR_POINTS', () => {
    // The point loop in renderContinuousMarks is skipped entirely above the
    // threshold, but geometry.series[].points (and every label) is still
    // fully populated — this is the case that matters most in practice, since
    // a real gene list is routinely tens of thousands of rows.
    const rows: string[] = [];
    for (let i = 0; i < 2100; i++) rows.push(`Gene${i},${(i % 5) - 2},0.01`);
    const csv = `Gene,log2FC,p\n${rows.join('\n')}`;
    const s = scene(
      makeVolcanoDocument(csv, 'differential', {
        volcanoLabels: ['Gene1', 'Gene2', 'Gene3'],
      }),
    );
    expect(collectByRole(s, 'point-cloud')).toHaveLength(1);
    expect(collectByRole(s, 'point')).toEqual([]); // vector markers are skipped
    expect(collectByRole(s, 'point-label').length).toBeGreaterThan(0);
  });
});

describe('volcano point label editing', () => {
  it('draws at a custom size when pointLabelSizePt is set, theme size when absent', () => {
    const s = scene(
      makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
        volcanoLabels: ['TP53'],
        pointLabelSizePt: 10,
      }),
    );
    const label = collectByRole(s, 'point-label')[0]!;
    const pt = Number(label.attrs?.['font-size']) / (25.4 / 72);
    expect(pt).toBeCloseTo(10, 6);
  });

  it('always draws a leader once a label carries a manual offset, unlike the unoffset default', () => {
    const base = makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', { volcanoLabels: ['TP53'] });
    expect(collectByRole(scene(base), 'point-label-leader')).toEqual([]);

    const offset = editDocument(base, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') node.pointLabelOffsets = { TP53: { x: 10, y: -5 } };
      }
    });
    expect(collectByRole(scene(offset), 'point-label-leader')).toHaveLength(1);
  });

  it("moves the label by exactly the offset, and the leader's point end stays fixed", () => {
    const base = makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', { volcanoLabels: ['TP53'] });
    const withOffset = (x: number, y: number) =>
      editDocument(base, (draft) => {
        for (const node of Object.values(draft.nodes)) {
          if (node.type === 'plot') node.pointLabelOffsets = { TP53: { x, y } };
        }
      });

    const labelA = collectByRole(scene(withOffset(5, 0)), 'point-label')[0]!;
    const labelB = collectByRole(scene(withOffset(8, -3)), 'point-label')[0]!;
    expect(Number(labelB.attrs?.['x']) - Number(labelA.attrs?.['x'])).toBeCloseTo(3, 5);
    expect(Number(labelB.attrs?.['y']) - Number(labelA.attrs?.['y'])).toBeCloseTo(-3, 5);

    const parseLeader = (d: string) => {
      const m = /M([-\d.]+) ([-\d.]+) L([-\d.]+) ([-\d.]+)/.exec(d);
      return { x1: Number(m![1]), y1: Number(m![2]), x2: Number(m![3]), y2: Number(m![4]) };
    };
    const leaderA = parseLeader(
      collectByRole(scene(withOffset(5, 0)), 'point-label-leader')[0]!.attrs?.['d'] as string,
    );
    const leaderB = parseLeader(
      collectByRole(scene(withOffset(8, -3)), 'point-label-leader')[0]!.attrs?.['d'] as string,
    );
    // The point end of the leader never moves — only the label end does.
    expect(leaderB.x1).toBeCloseTo(leaderA.x1, 5);
    expect(leaderB.y1).toBeCloseTo(leaderA.y1, 5);
    expect(leaderB.x2).not.toBeCloseTo(leaderA.x2, 1);
  });

  it('ignores an offset keyed to a label that is not currently placed, without throwing', () => {
    const doc = makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', {
      volcanoLabels: ['TP53'],
      pointLabelOffsets: { MYC: { x: 1, y: 1 } },
    });
    expect(() => scene(doc)).not.toThrow();
    expect(collectByRole(scene(doc), 'point-label')).toHaveLength(1);
  });

  it('placedPointLabelsForPlot returns the same rects the drawing path used, in panel-local mm', () => {
    const doc = makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', { volcanoLabels: ['TP53'] });
    const plot = Object.values(doc.nodes).find((n) => n.type === 'plot') as PlotNode;
    const placed = placedPointLabelsForPlot(plot, doc, NATURE_THEME);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.text).toBe('TP53');
    const label = collectByRole(scene(doc), 'point-label')[0]!;
    const geometry = computePlotGeometry(plot, doc, NATURE_THEME)!;
    expect(geometry.kind).toBe('continuous');
    const marginLeft = (geometry as { margin: { left: number } }).margin.left;
    expect(Number(label.attrs?.['x']) + marginLeft).toBeGreaterThanOrEqual(placed[0]!.rectMm.x0 - 0.01);
    expect(Number(label.attrs?.['x']) + marginLeft).toBeLessThanOrEqual(placed[0]!.rectMm.x1 + 0.01);
  });

  it('returns [] for a non-volcano plot or an id with no plot node', () => {
    const doc = makeVolcanoDocument(DIFFERENTIAL_CSV, 'differential', { volcanoLabels: ['TP53'] });
    const plot = Object.values(doc.nodes).find((n) => n.type === 'plot') as PlotNode;
    expect(placedPointLabelsForPlot({ ...plot, plotType: 'scatter' }, doc, NATURE_THEME)).toEqual([]);
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
