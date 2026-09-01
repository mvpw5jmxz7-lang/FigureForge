/**
 * Multi-line axis titles (round 23).
 *
 * `AxisSpec.title` needed no schema change — a string already legally
 * contains `\n` — so what these tests actually pin is: `requiredMargin`
 * reserves more room for a title with more lines (measured off the string,
 * never the rendered width, which is what keeps its two-pass termination
 * argument intact), `multilineTitleNode` draws the extra lines as `<tspan>`
 * children of the same `<text>`, and a single-line title is byte-identical
 * to before this feature existed.
 */

import { describe, expect, it } from 'vitest';
import {
  addPanelWithPlot,
  addText,
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  type Dataset,
  type FigureDocument,
  type PlotNode,
  type TextRun,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { computePlotGeometry, renderDocument, type ContinuousPlotGeometry } from './render-document.js';
import { collectByRole, walkScene } from './scene.js';
import { toSvgString } from './svg-string.js';

const XY = `Dose,Response
1,2.1
2,3.9
3,6.2
4,7.8
5,10.1
6,12.4`;

function makeDocument(xTitle: string, yTitle: string): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
  return editDocument(base, (draft) => {
    const parsed = parseDelimited(XY);
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
      frame: { x: 2, y: 2, width: 80, height: 60 },
      name: 'Dose response',
      datasetId: dataset.id,
      plotType: 'scatter',
      xTitle,
      yTitle,
    });
  });
}

const plotOf = (doc: FigureDocument) => Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;
const geometryOf = (doc: FigureDocument) =>
  computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
const titleLineHeightMm = (NATURE_THEME.type.axisTitlePt * (25.4 / 72)) * 1.2;

describe('multi-line axis titles', () => {
  it('is byte-identical to a single-line title', () => {
    const oneLine = geometryOf(makeDocument('Dose (mg)', 'Response'));
    const bootstrapped = geometryOf(makeDocument('Dose (mg)\nExtra', 'Response'));
    // Sanity: the two-line title really did change something, so the
    // single-line comparison below is meaningful.
    expect(bootstrapped.margin.bottom).toBeGreaterThan(oneLine.margin.bottom);

    const svgOneLine = toSvgString(renderDocument(makeDocument('Dose (mg)', 'Response'), { theme: NATURE_THEME }));
    expect(svgOneLine).toContain('Dose (mg)');
    expect(svgOneLine).not.toContain('<tspan');
  });

  // Four vs. five lines, not one vs. two: the theme's own default margin is
  // itself a floor (`Math.max(themeMargin, needed)`), so a short one-line
  // title's *needed* reserve can sit entirely under that floor and a second
  // line then only partly shows through it — a real effect, not a bug, but
  // one that makes a one-vs-two comparison an unreliable way to pin the
  // per-line quantity. Comparing two counts already well past the floor
  // isolates exactly `titleLineHeightMm` per line.
  const fourLines = 'Dose (mg)\nL0\nL1\nL2';
  const fiveLines = 'Dose (mg)\nL0\nL1\nL2\nL3';

  it('grows the bottom margin by exactly one line height per extra x-title line', () => {
    const four = geometryOf(makeDocument(fourLines, 'Response'));
    const five = geometryOf(makeDocument(fiveLines, 'Response'));
    expect(five.margin.bottom - four.margin.bottom).toBeCloseTo(titleLineHeightMm, 4);
  });

  it('grows the left margin by exactly one line height per extra y-title line', () => {
    const four = geometryOf(makeDocument('Dose (mg)', fourLines.replace('Dose (mg)', 'Response')));
    const five = geometryOf(makeDocument('Dose (mg)', fiveLines.replace('Dose (mg)', 'Response')));
    expect(five.margin.left - four.margin.left).toBeCloseTo(titleLineHeightMm, 4);
  });

  it('draws the second line as a <tspan> with x reset and a line-height dy', () => {
    const scene = renderDocument(makeDocument('Dose (mg)', 'Response'), { theme: NATURE_THEME });
    const titles = collectByRole(scene, 'axis-title');
    const xTitle = titles.find((n) => n.editTarget === 'x.title');
    expect(xTitle?.tag).toBe('text');
    expect(xTitle?.text).toBe('Dose (mg)');
    expect(xTitle?.children ?? []).toHaveLength(0);
  });

  it('draws a two-line title as tspans, second line offset by the line height', () => {
    const scene = renderDocument(makeDocument('Dose (mg)\nSecond line', 'Response'), { theme: NATURE_THEME });
    const titles = collectByRole(scene, 'axis-title');
    const xTitle = titles.find((n) => n.editTarget === 'x.title');
    expect(xTitle?.tag).toBe('text');
    expect(xTitle?.text).toBeUndefined();
    const tspans = xTitle?.children ?? [];
    expect(tspans.map((t) => t.text)).toEqual(['Dose (mg)', 'Second line']);
    expect(tspans[0]?.attrs?.dy).toBe(0);
    expect(tspans[1]?.attrs?.dy).toBeCloseTo(titleLineHeightMm, 6);
    expect(tspans[1]?.attrs?.x).toBe(tspans[0]?.attrs?.x ?? xTitle?.attrs?.x);
  });

  it('keeps editTarget on the outer <text>, never a <tspan>, for a two-line title', () => {
    const scene = renderDocument(makeDocument('Dose (mg)\nSecond line', 'Response'), { theme: NATURE_THEME });
    let sawTspanWithEditTarget = false;
    walkScene(scene, (node) => {
      if (node.tag === 'tspan' && node.editTarget) sawTspanWithEditTarget = true;
    });
    expect(sawTspanWithEditTarget).toBe(false);
    expect(toSvgString(scene)).not.toContain('data-edit-target');
  });

  it('grows the right margin for a two-line secondary (y2) axis title', () => {
    const withY2 = (title: string): FigureDocument =>
      editDocument(makeDocument('Dose (mg)', 'Response'), (draft) => {
        const plot = Object.values(draft.nodes).find((n) => n.type === 'plot');
        if (plot?.type !== 'plot') return;
        plot.y2 = {
          title,
          min: null,
          max: null,
          tickStep: null,
          scale: 'linear',
          showLine: true,
          showTicks: true,
          showLabels: true,
          trimToData: false,
        };
        plot.seriesAxis = ['y2'];
      });

    const oneLine = geometryOf(withY2('Y2'));
    const twoLine = geometryOf(withY2('Y2\nSecond line'));
    expect(twoLine.margin.right).toBeGreaterThan(oneLine.margin.right);
  });
});

describe('rotated title anchors extend away from the tick labels, not toward them (overlap fix)', () => {
  // Reported: a second y-title line overlapped the tick labels. Root cause:
  // `rotate(-90)`/`rotate(90)` turn a title's per-line `dy` step into a
  // *horizontal* global shift, and for these three rotated titles that
  // shift pointed back toward the plot instead of into the margin
  // `requiredMargin`/`y2WidthMm` already reserve for extra lines. These
  // tests pin the anchor's own position — the fix — directly, rather than
  // re-deriving the dy-to-global-shift matrix math inside the test. Values
  // are compared to 3 decimal places, not more: `round()` (`scene.ts`)
  // quantizes every coordinate to 4 decimals independently, so two values
  // that should differ by exactly one line height can differ from that by
  // up to two rounding grains.
  const transformXOf = (n: { attrs?: Record<string, unknown> } | undefined): number => {
    const match = String(n?.attrs?.['transform']).match(/translate\((-?[\d.]+) (-?[\d.]+)\)/);
    return Number(match![1]);
  };

  it('extends the y-title anchor further left (more negative) for a second line', () => {
    const oneLine = renderDocument(makeDocument('Dose (mg)', 'Response'), { theme: NATURE_THEME });
    const twoLine = renderDocument(makeDocument('Dose (mg)', 'Response\nSecond line'), { theme: NATURE_THEME });
    const xOne = transformXOf(collectByRole(oneLine, 'axis-title').find((n) => n.editTarget === 'y.title'));
    const xTwo = transformXOf(collectByRole(twoLine, 'axis-title').find((n) => n.editTarget === 'y.title'));
    // More negative by exactly one line height — the *last* line (nearest
    // the axis) then lands exactly where the single-line title already sat,
    // which is the actual "no more overlap" guarantee. This anchor is
    // measured from the y-axis line itself (local x=0, a fixed reference
    // that doesn't move as margin.left grows), so the shift is direct with
    // no other effect to account for.
    expect(xOne - xTwo).toBeCloseTo(titleLineHeightMm, 3);
  });

  it("leaves the y2-title anchor unchanged for a second line — plotWidth's own shrinkage already does the work", () => {
    const withY2 = (title: string): FigureDocument =>
      editDocument(makeDocument('Dose (mg)', 'Response'), (draft) => {
        const plot = Object.values(draft.nodes).find((n) => n.type === 'plot');
        if (plot?.type !== 'plot') return;
        plot.y2 = {
          title,
          min: null,
          max: null,
          tickStep: null,
          scale: 'linear',
          showLine: true,
          showTicks: true,
          showLabels: true,
          trimToData: false,
        };
        plot.seriesAxis = ['y2'];
      });

    // Unlike the y-title (measured from the fixed x=0 axis line), the
    // y2-title anchor is measured as `plotWidth + (fixed local offsets)` —
    // and `plotWidth + margin.right` is itself invariant (both equal
    // `frame.width - margin.left`, which nothing here touches). So when a
    // second line grows margin.right by `titleLineHeightMm`, plotWidth
    // *shrinks* by the same amount — an effect this fix's `+extra` term
    // exists to counteract, landing the anchor back at the same place a
    // single-line title already correctly used. Confirmed as the real
    // mechanism, not assumed: plotWidth must actually have shrunk, or this
    // equality would be vacuous.
    const oneLineGeometry = geometryOf(withY2('Y2'));
    const twoLineGeometry = geometryOf(withY2('Y2\nSecond line'));
    expect(oneLineGeometry.plotWidth - twoLineGeometry.plotWidth).toBeCloseTo(titleLineHeightMm, 3);

    const oneLine = renderDocument(withY2('Y2'), { theme: NATURE_THEME });
    const twoLine = renderDocument(withY2('Y2\nSecond line'), { theme: NATURE_THEME });
    const xOne = transformXOf(collectByRole(oneLine, 'axis-title').find((n) => n.editTarget === 'y2.title'));
    const xTwo = transformXOf(collectByRole(twoLine, 'axis-title').find((n) => n.editTarget === 'y2.title'));
    expect(xTwo).toBeCloseTo(xOne, 3);
  });

  it("extends renderAxesHorizontal's x-title anchor further left for a second line", () => {
    // node.x is the category axis in both orientations; horizontal draws it
    // rotated down the left edge — the same `rotate(-90)` shape as
    // renderAxes's own y-title, so it needs the identical correction.
    const REPLICATES = 'Treatment,R1,R2,R3\nVehicle,10,11,12\nDrug,4,5,6';
    const makeHorizontal = (xTitle: string): FigureDocument => {
      const newId = createIdFactory();
      const base = createDocument({
        widthMm: 183,
        heightMm: 75,
        idFactory: newId,
        now: () => '2026-01-01T00:00:00.000Z',
      });
      return editDocument(base, (draft) => {
        const parsed = parseDelimited(REPLICATES);
        const dataset: Dataset = {
          id: newId(),
          name: 'Table',
          format: inferFormat(parsed.columns),
          columns: parsed.columns,
          rows: parsed.rows,
          sourcePath: 'data/d.csv',
          sourceFilename: 'd.csv',
          importedAt: '2026-01-01T00:00:00.000Z',
        };
        draft.datasets = [dataset];
        const { plot } = addPanelWithPlot(draft, newId, {
          frame: { x: 2, y: 2, width: 80, height: 60 },
          name: 'Table',
          datasetId: dataset.id,
          plotType: 'bar-dot',
          xTitle,
          yTitle: 'Value',
        });
        plot.orientation = 'horizontal';
      });
    };

    const oneLine = renderDocument(makeHorizontal('Treatment'), { theme: NATURE_THEME });
    const twoLine = renderDocument(makeHorizontal('Treatment\nGroup'), { theme: NATURE_THEME });
    const xOne = transformXOf(collectByRole(oneLine, 'axis-title').find((n) => n.editTarget === 'x.title'));
    const xTwo = transformXOf(collectByRole(twoLine, 'axis-title').find((n) => n.editTarget === 'x.title'));
    expect(xOne - xTwo).toBeCloseTo(titleLineHeightMm, 3);
  });
});

describe('rich text on axis titles (round 24)', () => {
  it('renders identically whether richText is absent or an explicit empty array', () => {
    const plain = makeDocument('Dose (mg)', 'Response');
    const withEmptyRuns = editDocument(plain, (draft) => {
      const plot = Object.values(draft.nodes).find((n) => n.type === 'plot');
      if (plot?.type === 'plot') plot.x.richText = [];
    });
    expect(toSvgString(renderDocument(withEmptyRuns, { theme: NATURE_THEME }))).toBe(
      toSvgString(renderDocument(plain, { theme: NATURE_THEME })),
    );
  });

  it('draws bold/italic/superscript runs on an x title, explicit font-weight/style on every tspan', () => {
    const runs: TextRun[] = [{ text: 'Dose ' }, { text: 'x', bold: true }, { text: '2', script: 'sup' }];
    const withRuns = editDocument(makeDocument('Dose (mg)', 'Response'), (draft) => {
      const plot = Object.values(draft.nodes).find((n) => n.type === 'plot');
      if (plot?.type === 'plot') plot.x.richText = runs;
    });
    const scene = renderDocument(withRuns, { theme: NATURE_THEME });
    const xTitle = collectByRole(scene, 'axis-title').find((n) => n.editTarget === 'x.title');
    const tspans = xTitle?.children ?? [];
    expect(tspans.map((t) => t.text)).toEqual(['Dose ', 'x', '2']);
    expect(tspans.map((t) => t.attrs?.['font-weight'])).toEqual(['normal', 'bold', 'normal']);
    expect(tspans.map((t) => t.attrs?.['font-style'])).toEqual(['normal', 'normal', 'normal']);
    expect(tspans[2]?.role).toBe('text-sup');
  });

  it('draws a run list identically through richTextNode and multilineTitleNode — the shared richRunTspans extraction', () => {
    // Proves the extraction didn't fork the logic: a TextNode's free-standing
    // rich text and an axis title's rich text must produce the exact same
    // dy/font-weight/font-style/role sequence for an equivalent run list, at
    // the same base font size (a TextNode's own fontSizePt set to match the
    // theme's axisTitlePt, which an axis title always draws at).
    const runs: TextRun[] = [{ text: 'Fold change (log' }, { text: '2', script: 'sub' }, { text: ')' }];

    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const withTextNode = editDocument(base, (draft) => {
      const node = addText(draft, newId, {
        frame: { x: 5, y: 5, width: 60, height: 20 },
        text: 'placeholder',
        fontSizePt: NATURE_THEME.type.axisTitlePt,
      });
      const target = draft.nodes[node.id];
      if (target?.type === 'text') target.richText = runs;
    });
    const textScene = renderDocument(withTextNode, { theme: NATURE_THEME });
    const textNodeTspans = collectByRole(textScene, 'text')[0]?.children ?? [];

    const withAxisTitle = editDocument(makeDocument('Dose (mg)', 'Response'), (draft) => {
      const plot = Object.values(draft.nodes).find((n) => n.type === 'plot');
      if (plot?.type === 'plot') plot.x.richText = runs;
    });
    const axisScene = renderDocument(withAxisTitle, { theme: NATURE_THEME });
    const axisTitleTspans =
      collectByRole(axisScene, 'axis-title').find((n) => n.editTarget === 'x.title')?.children ?? [];

    const shapeOf = (tspans: typeof textNodeTspans) =>
      tspans.map((t) => ({
        text: t.text,
        dy: t.attrs?.dy,
        weight: t.attrs?.['font-weight'],
        style: t.attrs?.['font-style'],
        role: t.role,
      }));
    expect(shapeOf(axisTitleTspans)).toEqual(shapeOf(textNodeTspans));
    expect(textNodeTspans.length).toBeGreaterThan(0);
  });
});
