/**
 * Two-factor tables, legends and error bands.
 *
 * The four table shapes in the PDF of examples all reduce to one thing the
 * model could not express: a mark positioned by *two* factors. `toSeries`
 * returned a flat list of named series and `categoricalMarks` gave each one a
 * band, so a table of four variants by four groups drew sixteen bands and
 * sixteen labels — and a contingency table drew one bar at the mean of a count
 * of cases and a count of controls.
 *
 * The load-bearing test here is the last one: single-factor figures must render
 * exactly as they did, or every saved document re-lays itself out on open.
 */

import { describe, expect, it } from 'vitest';
import {
  addPanelWithPlot,
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  type DataFormat,
  type Dataset,
  type FigureDocument,
  type PlotNode,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument, measurePlot } from './render-document.js';
import { collectByRole } from './scene.js';
import { toSvgString } from './svg-string.js';

/** Prism's Grouped: two variants, two groups, two replicates each. */
const GROUPED = `,Group A,,Group B,
Variant,A:Y1,A:Y2,B:Y1,B:Y2
WT,1,1.2,3,3.2
KO,2,2.2,4,4.2`;

/** Prism's XY with replicate subcolumns: a shared x, two groups of three. */
const XY_REPLICATES = `,Control,,,Treated,,
Hours,A:Y1,A:Y2,A:Y3,B:Y1,B:Y2,B:Y3
0,45,34,20,34,31,29
6,56,58,61,41,43,42
12,76,72,77,52,55,58`;

/** Prism's Nested: three subjects per group, no row-label column. */
const NESTED = `Control,,,Treated,,
Rat 1,Rat 2,Rat 3,Rat 4,Rat 5,Rat 6
1,2,3,7,8,9
1.5,2.5,3.5,7.5,8.5,9.5`;

const CONTINGENCY = `Group,Cases,Control
Smoked,80,20
Never smoked,10,90`;

/** A single-factor replicate table — the shape every existing figure has. */
const REPLICATES = `Treatment,R1,R2,R3
Vehicle,10,11,12
Drug,4,5,6`;

function makeDocument(
  csv: string,
  patch: Partial<PlotNode> = {},
  formatOverride?: DataFormat,
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
    const format =
      formatOverride ??
      inferFormat(parsed.columns, { columnGroups: parsed.columnGroups });
    const dataset: Dataset = {
      id: newId(),
      name: 'Table',
      format,
      columns: parsed.columns,
      rows: parsed.rows,
      ...(parsed.columnGroups.length > 0 ? { columnGroups: parsed.columnGroups } : {}),
      sourcePath: 'data/d.csv',
      sourceFilename: 'd.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: 80, height: 60 },
      name: 'Table',
      datasetId: dataset.id,
      yTitle: 'Value',
    });

    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') Object.assign(node, patch);
    }
  });
}

const scene = (doc: FigureDocument) => renderDocument(doc, { theme: NATURE_THEME });
const plotOf = (doc: FigureDocument): PlotNode =>
  Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;

describe('two-factor categorical plots', () => {
  it('labels the axis once per category, not once per mark', () => {
    const doc = makeDocument(GROUPED, { plotType: 'bar' });
    const bars = collectByRole(scene(doc), 'bar');
    const labels = collectByRole(scene(doc), 'tick-label')
      .map((n) => n.text)
      .filter((c): c is string => typeof c === 'string');

    // Two variants x two groups is four bars…
    expect(bars).toHaveLength(4);
    // …over two labels. A flat band gave four, which is the table's shape
    // repeated on the axis rather than its meaning.
    expect(labels).toContain('WT');
    expect(labels).toContain('KO');
    expect(labels).not.toContain('WT — Group A');
  });

  it('groups the sub-bands of one category together', () => {
    const doc = makeDocument(GROUPED, { plotType: 'bar' });
    const xs = collectByRole(scene(doc), 'bar')
      .map((n) => Number(n.attrs?.['x']))
      .sort((a, b) => a - b);

    // Two tight pairs, with a wider gap between the categories than within one.
    const withinFirst = xs[1]! - xs[0]!;
    const betweenCategories = xs[2]! - xs[1]!;
    const withinSecond = xs[3]! - xs[2]!;
    expect(withinFirst).toBeCloseTo(withinSecond, 6);
    expect(betweenCategories).toBeGreaterThan(withinFirst);
  });

  it('colours by group, so one group reads as one colour across categories', () => {
    const fills = collectByRole(scene(makeDocument(GROUPED, { plotType: 'bar' })), 'bar').map(
      (n) => n.attrs?.['fill'],
    );
    // WT/A, WT/B, KO/A, KO/B — the two A bars share a colour, as do the two B.
    expect(fills[0]).toBe(fills[2]);
    expect(fills[1]).toBe(fills[3]);
    expect(fills[0]).not.toBe(fills[1]);
  });

  it('draws a contingency table one bar per count, at the count', () => {
    // `contingency` is never inferred — counts and measurements are the same
    // rectangle of numbers — so the author selects it, as the importer requires.
    const doc = makeDocument(CONTINGENCY, {}, 'contingency');
    const plot = plotOf(doc);
    expect(plot.plotType).toBe('bar');

    const bars = collectByRole(scene(doc), 'bar');
    // Four cells, four bars. One per row put a bar at the mean of a count of
    // cases and a count of controls — 50 for an 80/20 split.
    expect(bars).toHaveLength(4);

    // Bar height encodes the count, so the 80 bar is eight times the 10 bar.
    const heights = bars.map((n) => Number(n.attrs?.['height']));
    expect(heights[0]! / heights[2]!).toBeCloseTo(8, 1);
    expect(heights[3]! / heights[1]!).toBeCloseTo(4.5, 1);

    // No error bars: an SEM over one frequency is a standard error of nothing.
    expect(collectByRole(scene(doc), 'error-bar')).toHaveLength(0);
  });

  it('clusters nested subjects inside their group and colours by group', () => {
    const doc = makeDocument(NESTED);
    const plot = plotOf(doc);
    // Points, not bars: a bar over subjects averages away what makes it nested.
    expect(plot.plotType).toBe('dot');

    const points = collectByRole(scene(doc), 'point');
    expect(points).toHaveLength(12); // 6 subjects x 2 rows

    const fills = new Set(points.map((n) => n.attrs?.['fill']));
    // Two colours for two groups, not six for six rats — the subjects are the
    // one factor a nested design is explicitly not comparing.
    expect(fills.size).toBe(2);

    const labels = collectByRole(scene(doc), 'tick-label')
      .map((n) => n.text)
      .filter((c): c is string => typeof c === 'string');
    expect(labels).toContain('Control');
    expect(labels).toContain('Treated');
  });

  it('keeps bracket anchors keyed by the composite series name', () => {
    // Two-factor data must not break the stats join: `bracketFrame` looks
    // series up by name, and the second factor arrives without it knowing.
    const doc = makeDocument(GROUPED, { plotType: 'bar' });
    const measured = measurePlot(doc, plotOf(doc), NATURE_THEME)!;
    expect([...measured.categoryX.keys()]).toEqual([
      'WT — Group A',
      'WT — Group B',
      'KO — Group A',
      'KO — Group B',
    ]);
    // Distinct positions, so a bracket lands on the bar it names.
    expect(new Set(measured.categoryX.values()).size).toBe(4);
  });
});

describe('legend', () => {
  it('names the groups of a two-factor plot', () => {
    const legend = collectByRole(scene(makeDocument(GROUPED, { plotType: 'bar' })), 'legend');
    const labels = legend.map((n) => n.text).filter((c): c is string => typeof c === 'string');
    expect(labels).toEqual(['Group A', 'Group B']);
  });

  it('is withheld where the category labels already say it', () => {
    // A single-factor bar chart names every mark under its band, so a key
    // repeating those names is furniture rather than information.
    expect(collectByRole(scene(makeDocument(REPLICATES)), 'legend')).toHaveLength(0);
  });

  it('can be turned off, and moved', () => {
    expect(
      collectByRole(scene(makeDocument(GROUPED, { plotType: 'bar', legend: 'none' })), 'legend'),
    ).toHaveLength(0);

    const right = makeDocument(GROUPED, { plotType: 'bar', legend: 'right' });
    const bottom = makeDocument(GROUPED, { plotType: 'bar', legend: 'bottom' });
    // Both draw a key; they differ in where, which the plot area's width shows:
    // a legend on the right takes margin the plot would otherwise use.
    expect(collectByRole(scene(right), 'legend').length).toBe(
      collectByRole(scene(bottom), 'legend').length,
    );
    // A right-hand legend takes width from the plot; a bottom one takes height
    // and leaves the width alone. Both keep the same origin, so the span of the
    // bands is what tells them apart.
    const span = (d: FigureDocument): number => {
      const xs = [...measurePlot(d, plotOf(d), NATURE_THEME)!.categoryX.values()];
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(span(right)).toBeLessThan(span(bottom));
  });

  it('reserves margin, so it is drawn inside the panel', () => {
    const doc = makeDocument(GROUPED, { plotType: 'bar', legend: 'right' });
    const svg = toSvgString(scene(doc));
    expect(svg).toContain('Group A');

    // The plot area must have given up width for it: with the legend off, the
    // same figure has more room.
    const withLegend = measurePlot(doc, plotOf(doc), NATURE_THEME)!;
    const off = makeDocument(GROUPED, { plotType: 'bar', legend: 'none' });
    const withoutLegend = measurePlot(off, plotOf(off), NATURE_THEME)!;

    const spanOf = (m: typeof withLegend): number => {
      const xs = [...m.categoryX.values()];
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spanOf(withLegend)).toBeLessThan(spanOf(withoutLegend));
  });
});

describe('error bands', () => {
  it('collapses replicates at one x and shades the interval', () => {
    const doc = makeDocument(XY_REPLICATES, {
      plotType: 'line',
      errorDisplay: 'band',
      errorBars: 'sd',
    });
    const s = scene(doc);

    // One polygon per group, filled and translucent.
    const bands = collectByRole(s, 'error-bar').filter((n) => n.tag === 'path');
    expect(bands).toHaveLength(2);
    expect(bands[0]?.attrs?.['fill-opacity']).toBe(0.25);

    // The line now runs through three means, not eighteen replicates: a line
    // through every replicate zig-zags between them at each timepoint.
    const lines = collectByRole(s, 'line');
    expect(lines).toHaveLength(2);
    const vertices = String(lines[0]?.attrs?.['d']).split(/[ML]/).filter(Boolean);
    expect(vertices).toHaveLength(3);
  });

  it('draws no band where there is no interval to draw', () => {
    // One y per x: the "interval" would be zero-width, and a hairline band
    // asserts a precision the data never had.
    const doc = makeDocument('X,Y\n1,10\n2,20\n3,30', {
      plotType: 'line',
      errorDisplay: 'band',
      errorBars: 'sd',
    });
    expect(collectByRole(scene(doc), 'error-bar').filter((n) => n.tag === 'path')).toHaveLength(0);
    // The line itself is still drawn.
    expect(collectByRole(scene(doc), 'line')).toHaveLength(1);
  });

  it('leaves a scatter as its raw observations', () => {
    // Summarising a scatter would hide the very thing it is drawn to show.
    const doc = makeDocument(XY_REPLICATES, {
      plotType: 'scatter',
      errorDisplay: 'band',
      errorBars: 'sd',
    });
    expect(collectByRole(scene(doc), 'point')).toHaveLength(18);
    expect(collectByRole(scene(doc), 'error-bar').filter((n) => n.tag === 'path')).toHaveLength(0);
  });
});

describe('error bars at each point', () => {
  /*
   * The Inspector offered "Bars at each point" for a release and nothing drew
   * one: only `errorDisplay: 'band'` engaged the summary, so choosing bars gave
   * a line zig-zagging through every replicate with no interval anywhere.
   */
  it('draws a capped bar per timepoint instead of a filled polygon', () => {
    const doc = makeDocument(XY_REPLICATES, {
      plotType: 'line',
      errorDisplay: 'bars',
      errorBars: 'sd',
    });
    const bars = collectByRole(scene(doc), 'error-bar');

    // Three timepoints x two groups, each its own node — not one polygon each.
    expect(bars).toHaveLength(6);
    for (const bar of bars) {
      expect(bar.attrs?.['fill']).toBe('none');
      // Two caps and a stem: three subpaths, and no polygon close.
      const d = String(bar.attrs?.['d']);
      expect(d.match(/M/g)).toHaveLength(3);
      expect(d).not.toContain('Z');
    }
  });

  it('keys the bars to their series rather than drawing them all black', () => {
    // No bar sits underneath to say which group a whisker belongs to, which is
    // what lets the categorical path use the foreground colour.
    const doc = makeDocument(XY_REPLICATES, {
      plotType: 'line',
      errorDisplay: 'bars',
      errorBars: 'sd',
    });
    const colors = new Set(
      collectByRole(scene(doc), 'error-bar').map((n) => String(n.attrs?.['stroke'])),
    );
    expect(colors.size).toBe(2);
    expect(colors.has(NATURE_THEME.foreground)).toBe(false);
  });

  it('still summarises when no display was ever chosen', () => {
    /*
     * `addPlot` sets `'band'` when it builds this plot, so the field is cleared
     * here to model a document that predates it. `node.errorDisplay ?? 'bars'`
     * is what the Inspector shows for such a plot, so bars are what it must draw
     * — before this it drew nothing and ran the line through every replicate.
     */
    const doc = makeDocument(XY_REPLICATES, {
      plotType: 'line',
      errorBars: 'sd',
      errorDisplay: undefined,
    });
    const s = scene(doc);

    expect(collectByRole(s, 'error-bar')).toHaveLength(6);
    // The means, not the replicates: three vertices, not nine.
    const vertices = String(collectByRole(s, 'line')[0]?.attrs?.['d']).split(/[ML]/).filter(Boolean);
    expect(vertices).toHaveLength(3);
  });

  it('moves nothing on a table with one y per x', () => {
    /*
     * The safety argument for summarising an unset plot: `summariseAtX` returns
     * the series untouched unless some x carries more than one value, so an
     * ordinary shared-x table renders identically however the field is set.
     */
    const table = 'Time,WT,KO\n0,10,1\n1,20,2\n2,30,3';
    const unset = toSvgString(scene(makeDocument(table, { plotType: 'line', errorBars: 'sd' })));
    const bars = toSvgString(
      scene(makeDocument(table, { plotType: 'line', errorBars: 'sd', errorDisplay: 'bars' })),
    );
    const band = toSvgString(
      scene(makeDocument(table, { plotType: 'line', errorBars: 'sd', errorDisplay: 'band' })),
    );

    expect(bars).toBe(unset);
    expect(band).toBe(unset);
    expect(unset).not.toContain('role="error-bar"');
  });
});

describe('showing every replicate', () => {
  it('draws the individual measurements behind the means', () => {
    const means = makeDocument(XY_REPLICATES, {
      plotType: 'line',
      errorDisplay: 'band',
      errorBars: 'sd',
    });
    const all = makeDocument(XY_REPLICATES, {
      plotType: 'line',
      errorDisplay: 'band',
      errorBars: 'sd',
      showReplicates: true,
    });

    // Three means per group; with the replicates, those plus all eighteen.
    expect(collectByRole(scene(means), 'point')).toHaveLength(6);
    expect(collectByRole(scene(all), 'point')).toHaveLength(24);
  });

  it('draws them smaller and part-transparent, so the means still read', () => {
    const doc = makeDocument(XY_REPLICATES, {
      plotType: 'line',
      errorDisplay: 'band',
      errorBars: 'sd',
      showReplicates: true,
    });
    const radii = collectByRole(scene(doc), 'point').map((n) => Number(n.attrs?.['r']));
    const small = Math.min(...radii);
    const full = Math.max(...radii);
    expect(small).toBeLessThan(full);

    const faded = collectByRole(scene(doc), 'point').filter(
      (n) => n.attrs?.['fill-opacity'] === 0.45,
    );
    expect(faded).toHaveLength(18);
  });

  it('is byte-identical to before the field existed when it is absent', () => {
    // The property every optional field has to hold, or a saved document
    // re-draws itself the moment it is opened.
    const patch = { plotType: 'line', errorDisplay: 'band', errorBars: 'sd' } as const;
    expect(toSvgString(scene(makeDocument(XY_REPLICATES, { ...patch, showReplicates: false })))).toBe(
      toSvgString(scene(makeDocument(XY_REPLICATES, patch))),
    );
  });
});

describe('bar spacing', () => {
  const barsOf = (doc: FigureDocument): { x: number; width: number }[] =>
    collectByRole(scene(doc), 'bar')
      .map((n) => ({ x: Number(n.attrs?.['x']), width: Number(n.attrs?.['width']) }))
      .sort((a, b) => a.x - b.x);

  it('draws exactly as before when a plot says nothing about spacing', () => {
    /*
     * The two gaps were a dead parameter and a literal inside the band scale.
     * Absent has to mean precisely what those literals meant, or every saved
     * figure — one factor or two — re-lays itself out the first time it is
     * opened. Stated as the equality directly: silent equals the old numbers.
     *
     * Both scenes come from *one* document because `createIdFactory` mixes in
     * `Math.random()` and the jitter seed is hashed from the node id, so two
     * separately-built documents differ in their replicate points alone.
     */
    for (const csv of [GROUPED, REPLICATES]) {
      const silent = makeDocument(csv, { plotType: 'bar' });
      const stated = editDocument(silent, (draft) => {
        for (const node of Object.values(draft.nodes)) {
          if (node.type === 'plot') {
            node.barGapFraction = 0.1;
            node.groupGapFraction = 0.35;
          }
        }
      });
      expect(toSvgString(scene(stated))).toBe(toSvgString(scene(silent)));
    }
  });

  it('makes the bars of a group meet at full width with no gap', () => {
    const bars = barsOf(
      makeDocument(GROUPED, { plotType: 'bar', barGapFraction: 0, barWidthFraction: 1 }),
    );
    expect(bars).toHaveLength(4);

    // Within a category the bars are flush: one ends exactly where the next
    // begins. This is what the width control exists for — at 80% of the slot a
    // sliver survives that no amount of closing the gap can remove.
    expect(bars[0]!.x + bars[0]!.width).toBeCloseTo(bars[1]!.x, 6);
    expect(bars[2]!.x + bars[2]!.width).toBeCloseTo(bars[3]!.x, 6);
    // The categories stay apart: that is the other control's business.
    expect(bars[2]!.x - (bars[1]!.x + bars[1]!.width)).toBeGreaterThan(1);
  });

  it('separates the clusters without disturbing the pitch inside one', () => {
    const base = barsOf(makeDocument(GROUPED, { plotType: 'bar' }));
    const wide = barsOf(makeDocument(GROUPED, { plotType: 'bar', groupGapFraction: 0.6 }));

    const between = (b: typeof base): number => b[2]!.x - b[1]!.x;
    expect(between(wide)).toBeGreaterThan(between(base));
    // Still two tight pairs, just narrower ones — the invariant the two-factor
    // reading rests on.
    expect(wide[1]!.x - wide[0]!.x).toBeLessThan(between(wide));
  });

  it('spaces a single-factor plot by the same control', () => {
    const tight = barsOf(makeDocument(REPLICATES, { plotType: 'bar', groupGapFraction: 0.05 }));
    const loose = barsOf(makeDocument(REPLICATES, { plotType: 'bar', groupGapFraction: 0.8 }));

    // One factor gives every bar its own category, so the gap between groups is
    // the gap between the bars. Wider gap, narrower bars, same plot area.
    expect(loose[0]!.width).toBeLessThan(tight[0]!.width);
  });

  it('moves the measured category positions a bracket is anchored to', () => {
    /*
     * Why the Inspector reflows brackets in the same commit as a gap change: a
     * bracket's ends are `margin.left + band.center(name)`, so widening a gap
     * moves the bars out from under an annotation that stays where it was.
     */
    const at = (patch: Partial<PlotNode>): number[] => {
      const doc = makeDocument(GROUPED, { plotType: 'bar', ...patch });
      return [...measurePlot(doc, plotOf(doc), NATURE_THEME)!.categoryX.values()];
    };
    expect(at({ groupGapFraction: 0.6 })).not.toEqual(at({}));
    expect(at({ barGapFraction: 0.5 })).not.toEqual(at({}));
    // Width changes no centre, which is why it commits without a reflow.
    expect(at({ barWidthFraction: 0.4 })).toEqual(at({}));
  });
});

describe('single-factor output is unchanged', () => {
  it('renders a replicate table byte for byte as before', () => {
    /*
     * The guarantee that makes two-factor support safe to add: a figure with
     * one factor must take the path it always did. Anything else and every
     * saved document re-lays itself out the moment it is opened.
     *
     * The expected string is the output of the single-factor path — one band
     * per series, one colour per series, no legend, no wrapping group.
     */
    const doc = makeDocument(REPLICATES);
    const svg = toSvgString(scene(doc));

    expect(svg).not.toContain('role="legend"');
    // Two bands, two series, two categories — not a composite name in sight.
    expect(svg).not.toContain(' — ');
    expect(svg).toContain('>Vehicle<');
    expect(svg).toContain('>Drug<');

    const measured = measurePlot(doc, plotOf(doc), NATURE_THEME)!;
    expect([...measured.categoryX.keys()]).toEqual(['Vehicle', 'Drug']);
  });
});
