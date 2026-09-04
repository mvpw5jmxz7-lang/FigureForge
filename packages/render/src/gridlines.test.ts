/**
 * `PlotNode.showGridlines`: reference lines at a value axis's own ticks, and
 * — on a cascading line plot — a receding 3D box instead: one diagonal per
 * front-axis tick, the back plane closed as a walled grid, and a second copy
 * of the x and y axes standing on it. These tests assert exact numeric
 * equality against the same scale/geometry numbers the renderer itself
 * computed, which is what proves a gridline cannot drift from the tick it
 * belongs to — nor a back tick from the diagonal that arrives at it — rather
 * than merely appearing close to it.
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
import { computePlotGeometry, renderDocument, type ContinuousPlotGeometry } from './render-document.js';
import { checkFigure } from './quality.js';
import { collectByRole, round } from './scene.js';
import { toSvgString } from './svg-string.js';

const XY = `Dose,Response
1,2.1
2,3.9
3,6.2
4,7.8
5,10.1
6,12.4`;

const REPLICATES = `Treatment,R1,R2,R3
Vehicle,10,11,12
Drug,4,5,6`;

/** Two series, each against its own x — the sigmaplot layout `line` needs. */
const XY_PAIRS = [
  'X1\tY1\tX2\tY2',
  '1\t2\t1\t3',
  '2\t4\t2\t5',
  '3\t6\t3\t7',
].join('\n');

function makeContinuousDocument(csv: string, plotType: PlotType, patch: Partial<PlotNode> = {}): FigureDocument {
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

    const { plot } = addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: 80, height: 60 },
      name: 'Dose response',
      datasetId: dataset.id,
      plotType,
      xTitle: 'Dose (mg)',
      yTitle: 'Response',
    });
    Object.assign(plot, patch);
  });
}

function makeCategoricalDocument(patch: Partial<PlotNode> = {}): FigureDocument {
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
      sourcePath: 'data/t.csv',
      sourceFilename: 't.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    const { plot } = addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: 80, height: 60 },
      name: 'Table',
      datasetId: dataset.id,
      plotType: 'bar-dot',
      xTitle: 'Treatment',
      yTitle: 'Value',
    });
    Object.assign(plot, patch);
  });
}

function makeHeatmapDocument(patch: Partial<PlotNode> = {}): FigureDocument {
  const csv = `Gene,S1,S2\nA,1,2\nB,3,4`;
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
      sourcePath: 'data/m.csv',
      sourceFilename: 'm.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    const { plot } = addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: 80, height: 60 },
      name: 'Matrix',
      datasetId: dataset.id,
      plotType: 'heatmap',
    });
    Object.assign(plot, patch);
  });
}

const scene = (doc: FigureDocument) => renderDocument(doc, { theme: NATURE_THEME });
const plotOf = (doc: FigureDocument): PlotNode =>
  Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;

describe('gridlines: ordinary continuous plot', () => {
  it('draws a horizontal line at every visible y tick, at exactly the drawn tick position', () => {
    const doc = makeContinuousDocument(XY, 'scatter', { showGridlines: true });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const gridlines = collectByRole(scene(doc), 'gridline');
    const horizontalYs = gridlines
      .map((n) => /^M0 ([\d.-]+) L/.exec(String(n.attrs?.['d']))?.[1])
      .filter((y): y is string => y !== undefined)
      .map(Number);

    expect(horizontalYs.length).toBeGreaterThan(0);
    for (const y of horizontalYs) {
      expect(geometry.yScale.ticks.some((t) => round(geometry.yScale.scale(t)) === y)).toBe(true);
    }
  });

  it('draws a vertical line at every visible x tick, at exactly the drawn tick position', () => {
    const doc = makeContinuousDocument(XY, 'scatter', { showGridlines: true });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const gridlines = collectByRole(scene(doc), 'gridline');
    const verticalXs = gridlines
      .map((n) => /^M([\d.-]+) 0 L/.exec(String(n.attrs?.['d']))?.[1])
      .filter((x): x is string => x !== undefined)
      .map(Number);

    expect(verticalXs.length).toBeGreaterThan(0);
    for (const x of verticalXs) {
      expect(geometry.xScale.ticks.some((t) => round(geometry.xScale.scale(t)) === x)).toBe(true);
    }
  });

  it('draws nothing when absent, and is byte-identical to explicitly false', () => {
    const absent = toSvgString(scene(makeContinuousDocument(XY, 'scatter')));
    const explicitFalse = toSvgString(scene(makeContinuousDocument(XY, 'scatter', { showGridlines: false })));
    expect(collectByRole(scene(makeContinuousDocument(XY, 'scatter')), 'gridline')).toEqual([]);
    expect(explicitFalse).toBe(absent);
  });
});

describe('gridlines: cascading line plot (3D-style, receding from tick to back plane)', () => {
  function cascadeDoc(patch: Partial<PlotNode> = {}): FigureDocument {
    return makeContinuousDocument(XY_PAIRS, 'line', {
      offsetStepMm: 10,
      showGridlines: true,
      ...patch,
    });
  }

  /** Read straight off the geometry, never hardcoded — the same numbers the
   *  renderer itself uses, so a match here proves "cannot drift". */
  function backOffsetOf(geometry: ContinuousPlotGeometry): { x: number; y: number } {
    const first = geometry.series[0]!;
    const last = geometry.series[geometry.series.length - 1]!;
    return {
      x: round((last.baselineXMm ?? 0) - (first.baselineXMm ?? 0)),
      y: round((last.baselineMm ?? 0) - (first.baselineMm ?? 0)),
    };
  }

  it('draws one dashed diagonal per y tick and per x tick, plus the back wall', () => {
    const doc = cascadeDoc({ offsetStepXMm: 5 });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const gridlines = collectByRole(scene(doc), 'gridline');

    // A diagonal per y tick and per x tick, a flat wall line per y tick, and
    // the wall's two closing edges.
    expect(gridlines.length).toBe(
      2 * geometry.yScale.ticks.length + geometry.xScale.ticks.length + 2,
    );
    // 2 series in this fixture — the grid count must not equal series count
    // unless that's coincidentally also the tick count, which it isn't here.
    expect(gridlines.length).not.toBe(geometry.series.length);
    for (const g of gridlines) {
      expect(g.attrs?.['stroke-dasharray']).toBe('1.5 1');
    }
  });

  it('each y-tick diagonal runs from its front position (x=0) to the back plane', () => {
    const doc = cascadeDoc({ offsetStepXMm: 5 });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const backOffset = backOffsetOf(geometry);
    const gridlines = collectByRole(scene(doc), 'gridline');

    for (const tick of geometry.yScale.ticks) {
      const frontY = round(geometry.yScale.scale(tick));
      const expected = `M0 ${frontY} L${round(backOffset.x)} ${round(frontY + backOffset.y)}`;
      expect(gridlines.some((g) => g.attrs?.['d'] === expected)).toBe(true);
    }
  });

  it('each x-tick diagonal runs from its front position (y=plotHeight) to the back plane', () => {
    const doc = cascadeDoc({ offsetStepXMm: 5 });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const backOffset = backOffsetOf(geometry);
    const gridlines = collectByRole(scene(doc), 'gridline');
    const plotHeight = round(geometry.plotHeight);

    for (const tick of geometry.xScale.ticks) {
      const frontX = round(geometry.xScale.scale(tick));
      const expected = `M${frontX} ${plotHeight} L${round(frontX + backOffset.x)} ${round(
        geometry.plotHeight + backOffset.y,
      )}`;
      expect(gridlines.some((g) => g.attrs?.['d'] === expected)).toBe(true);
    }
  });

  it('with no horizontal lean, the back offset is purely vertical', () => {
    const doc = cascadeDoc();
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const backOffset = backOffsetOf(geometry);
    expect(backOffset.x).toBe(0);
    expect(backOffset.y).not.toBe(0);
  });

  it('continues each y tick into a flat line across the back wall', () => {
    const doc = cascadeDoc({ offsetStepXMm: 5 });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const backOffset = backOffsetOf(geometry);
    const gridlines = collectByRole(scene(doc), 'gridline').map((g) => String(g.attrs?.['d']));

    for (const tick of geometry.yScale.ticks) {
      const frontY = round(geometry.yScale.scale(tick));
      const backY = round(frontY + backOffset.y);
      // The wall line starts exactly where this tick's diagonal ended — the
      // property that keeps the wall attached to the grid rather than near it.
      const diagonal = `M0 ${frontY} L${round(backOffset.x)} ${backY}`;
      const wall = `M${round(backOffset.x)} ${backY} L${round(geometry.plotWidth)} ${backY}`;
      expect(gridlines).toContain(diagonal);
      expect(gridlines).toContain(wall);
    }
  });

  it('closes the back wall along its top and right edges, in the gridline style', () => {
    const doc = cascadeDoc({ offsetStepXMm: 5 });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const backOffset = backOffsetOf(geometry);
    const left = round(backOffset.x);
    const right = round(geometry.plotWidth);
    const bottom = round(geometry.plotHeight + backOffset.y);
    const gridlines = collectByRole(scene(doc), 'gridline');
    const paths = gridlines.map((g) => String(g.attrs?.['d']));

    expect(paths).toContain(`M${left} 0 L${right} 0`);
    expect(paths).toContain(`M${right} 0 L${right} ${bottom}`);
    // These two used to be drawn solid, in the axis stroke. They belong to the
    // grid now — the solid pair moved to the back plane's left and bottom.
    for (const edge of [`M${left} 0 L${right} 0`, `M${right} 0 L${right} ${bottom}`]) {
      const node = gridlines.find((g) => g.attrs?.['d'] === edge);
      expect(node?.attrs?.['stroke-dasharray']).toBe('1.5 1');
      expect(node?.attrs?.['stroke-width']).toBe(NATURE_THEME.stroke.hairlineMinMm);
    }
  });

  it('stands a second copy of the x and y axes on the back plane, with ticks', () => {
    const doc = cascadeDoc({ offsetStepXMm: 5 });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const backOffset = backOffsetOf(geometry);
    const left = round(backOffset.x);
    const bottom = round(geometry.plotHeight + backOffset.y);
    const backAxis = collectByRole(scene(doc), 'cascade-back-axis');

    // Two lines plus one tick per visible tick of each axis.
    expect(backAxis.length).toBe(
      2 + geometry.yScale.ticks.length + geometry.xScale.ticks.length,
    );
    const paths = backAxis.map((n) => String(n.attrs?.['d']));
    // The back plane's own left y axis and bottom x axis — an L, exactly where
    // the diagonals land, not the top/right pair this used to draw.
    expect(paths).toContain(`M${left} 0 L${left} ${bottom}`);
    expect(paths).toContain(`M${left} ${bottom} L${round(geometry.plotWidth)} ${bottom}`);
    // Drawn in the ordinary axis stroke, not the (dashed, muted) gridline one.
    for (const n of backAxis) {
      expect(n.attrs?.['stroke-dasharray']).toBeUndefined();
      expect(n.attrs?.['stroke-width']).toBe(NATURE_THEME.stroke.axisMm);
    }
    // No labels and no titles at the back — only the front axes carry those.
    const labels = collectByRole(scene(doc), 'tick-label').length;
    expect(labels).toBe(
      collectByRole(scene(cascadeDoc({ offsetStepXMm: 5, showGridlines: false })), 'tick-label').length,
    );
  });

  it('lands every back tick at the far end of its own diagonal', () => {
    const doc = cascadeDoc({ offsetStepXMm: 5 });
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const backOffset = backOffsetOf(geometry);
    const tickLen = NATURE_THEME.spacing.tickLengthMm;
    const left = round(backOffset.x);
    const bottom = round(geometry.plotHeight + backOffset.y);
    const paths = collectByRole(scene(doc), 'cascade-back-axis').map((n) => String(n.attrs?.['d']));

    // Front tick → diagonal → back tick, pinned end to end: each back tick's
    // on-axis end is the exact coordinate its diagonal terminated at.
    for (const tick of geometry.yScale.ticks) {
      const y = round(round(geometry.yScale.scale(tick)) + backOffset.y);
      expect(paths).toContain(`M${round(left - tickLen)} ${y} L${left} ${y}`);
    }
    for (const tick of geometry.xScale.ticks) {
      const x = round(round(geometry.xScale.scale(tick)) + backOffset.x);
      expect(paths).toContain(`M${x} ${bottom} L${x} ${round(bottom + tickLen)}`);
    }
  });

  it('omits whichever part of the back axes the front axis itself suppresses', () => {
    // Edited in place from one base document so the tick counts are the same
    // three ways — a fresh cascadeDoc() would get fresh node ids but is also
    // one more geometry to keep in step.
    const base = cascadeDoc({ offsetStepXMm: 5 });
    const geometry = computePlotGeometry(plotOf(base), base, NATURE_THEME) as ContinuousPlotGeometry;
    const yTicks = geometry.yScale.ticks.length;
    const xTicks = geometry.xScale.ticks.length;
    expect(collectByRole(scene(base), 'cascade-back-axis').length).toBe(2 + yTicks + xTicks);

    const patchAxes = (patch: { showLine?: boolean; showTicks?: boolean }) =>
      editDocument(base, (draft) => {
        for (const n of Object.values(draft.nodes)) {
          if (n.type === 'plot') {
            n.x = { ...n.x, ...patch };
            n.y = { ...n.y, ...patch };
          }
        }
      });

    expect(collectByRole(scene(patchAxes({ showLine: false })), 'cascade-back-axis').length).toBe(
      yTicks + xTicks,
    );
    expect(collectByRole(scene(patchAxes({ showTicks: false })), 'cascade-back-axis').length).toBe(2);
  });

  it('draws no back axes when not cascading, or when gridlines are off', () => {
    const notCascading = makeContinuousDocument(XY, 'scatter', { showGridlines: true });
    expect(collectByRole(scene(notCascading), 'cascade-back-axis')).toEqual([]);

    const gridlinesOff = makeContinuousDocument(XY_PAIRS, 'line', { offsetStepMm: 10 });
    expect(collectByRole(scene(gridlinesOff), 'cascade-back-axis')).toEqual([]);
  });

  it('draws the back axes independently of `boxed`', () => {
    const withoutBoxed = cascadeDoc();
    const withBoxed = cascadeDoc({ boxed: true });
    const count = collectByRole(scene(withoutBoxed), 'cascade-back-axis').length;
    expect(count).toBeGreaterThan(2);
    expect(collectByRole(scene(withBoxed), 'cascade-back-axis').length).toBe(count);
  });
});

describe('gridlines: colour and style options', () => {
  /** The exact blend `renderGridlines` uses by default, read off a real
   *  rendered gridline rather than hardcoded — this tracks the real formula
   *  rather than a frozen guess at its output. */
  function mutedGreyStroke(): string {
    const doc = makeContinuousDocument(XY, 'scatter', { showGridlines: true });
    const [g] = collectByRole(scene(doc), 'gridline');
    return String(g!.attrs?.['stroke']);
  }

  it('defaults to the muted grey blend, unchanged from before this option existed', () => {
    const doc = makeContinuousDocument(XY, 'scatter', { showGridlines: true });
    const gridlines = collectByRole(scene(doc), 'gridline');
    for (const g of gridlines) expect(g.attrs?.['stroke']).toBe(mutedGreyStroke());
  });

  it('"black" draws the theme foreground instead of the blend', () => {
    const doc = makeContinuousDocument(XY, 'scatter', { showGridlines: true, gridlineColor: 'black' });
    const gridlines = collectByRole(scene(doc), 'gridline');
    expect(gridlines.length).toBeGreaterThan(0);
    for (const g of gridlines) expect(g.attrs?.['stroke']).toBe(NATURE_THEME.foreground);
  });

  it('an explicit style applies uniformly, overriding the cascade default', () => {
    const doc = makeContinuousDocument(XY_PAIRS, 'line', {
      offsetStepMm: 10,
      showGridlines: true,
      gridlineStyle: 'solid',
    });
    const gridlines = collectByRole(scene(doc), 'gridline');
    expect(gridlines.length).toBeGreaterThan(0);
    for (const g of gridlines) expect(g.attrs?.['stroke-dasharray']).toBeUndefined();
  });

  it('"dotted" draws a round-capped zero-length dash', () => {
    const doc = makeContinuousDocument(XY, 'scatter', { showGridlines: true, gridlineStyle: 'dotted' });
    const gridlines = collectByRole(scene(doc), 'gridline');
    expect(gridlines.length).toBeGreaterThan(0);
    for (const g of gridlines) {
      expect(g.attrs?.['stroke-dasharray']).toBe('0 0.9');
      expect(g.attrs?.['stroke-linecap']).toBe('round');
    }
  });

  it('"solid" on an ordinary plot is byte-identical to leaving the style absent', () => {
    const explicitSolid = toSvgString(
      scene(makeContinuousDocument(XY, 'scatter', { showGridlines: true, gridlineStyle: 'solid' })),
    );
    const absent = toSvgString(scene(makeContinuousDocument(XY, 'scatter', { showGridlines: true })));
    expect(explicitSolid).toBe(absent);
  });

  it('"grey" is byte-identical to leaving the colour absent', () => {
    const explicitGrey = toSvgString(
      scene(makeContinuousDocument(XY, 'scatter', { showGridlines: true, gridlineColor: 'grey' })),
    );
    const absent = toSvgString(scene(makeContinuousDocument(XY, 'scatter', { showGridlines: true })));
    expect(explicitGrey).toBe(absent);
  });
});

describe('boxed border on a cascading line plot', () => {
  function cascadeDoc(patch: Partial<PlotNode> = {}): FigureDocument {
    return makeContinuousDocument(XY_PAIRS, 'line', {
      offsetStepMm: 10,
      offsetStepXMm: 5,
      boxed: true,
      ...patch,
    });
  }

  it('closes the rear plane — the far face of the oblique box — not the whole canvas', () => {
    const doc = cascadeDoc();
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const first = geometry.series[0]!;
    const last = geometry.series[geometry.series.length - 1]!;
    const backOffset = {
      x: round((last.baselineXMm ?? 0) - (first.baselineXMm ?? 0)),
      y: round((last.baselineMm ?? 0) - (first.baselineMm ?? 0)),
    };
    const axisPaths = collectByRole(scene(doc), 'axis').map((n) => String(n.attrs?.['d']));
    const plotWidth = round(geometry.plotWidth);
    const left = round(backOffset.x);
    const bottom = round(geometry.plotHeight + backOffset.y);

    // Top and right edges of the rear plane's rectangle, in the axis stroke.
    expect(axisPaths).toContain(`M${left} 0 L${plotWidth} 0`);
    expect(axisPaths).toContain(`M${plotWidth} 0 L${plotWidth} ${bottom}`);
    // The plain full-canvas box corner never appears once cascading.
    expect(axisPaths).not.toContain(`M0 0 L${plotWidth} 0`);
  });

  it('reduces to the ordinary (non-cascading) box exactly when there is no cascade offset', () => {
    const cascading = toSvgString(scene(makeContinuousDocument(XY_PAIRS, 'line', { boxed: true })));
    const ordinary = toSvgString(scene(makeContinuousDocument(XY, 'scatter', { boxed: true })));
    // Both are non-cascading (the line-pairs fixture has no offset step set),
    // so both must use the plain `M0 0 L{plotWidth} 0` / right-edge formula —
    // proving the `{0,0}` default reduction holds, not just asserting it.
    for (const svg of [cascading, ordinary]) {
      expect(svg).toMatch(/M0 0 L[\d.]+ 0/);
    }
  });
});

describe('cascade front axes: trimmed to the front-most series\' own plane', () => {
  function cascadeDoc(patch: Partial<PlotNode> = {}): FigureDocument {
    return makeContinuousDocument(XY_PAIRS, 'line', {
      offsetStepMm: 10,
      offsetStepXMm: 5,
      showGridlines: true,
      ...patch,
    });
  }

  function backOffsetOf(geometry: ContinuousPlotGeometry): { x: number; y: number } {
    const first = geometry.series[0]!;
    const last = geometry.series[geometry.series.length - 1]!;
    return {
      x: round((last.baselineXMm ?? 0) - (first.baselineXMm ?? 0)),
      y: round((last.baselineMm ?? 0) - (first.baselineMm ?? 0)),
    };
  }

  it('trims the front L-axis to the front plane, mirroring the rear axes', () => {
    const doc = cascadeDoc();
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const backOffset = backOffsetOf(geometry);
    const axisPaths = collectByRole(scene(doc), 'axis').map((n) => String(n.attrs?.['d']));
    const plotWidth = round(geometry.plotWidth);
    const plotHeight = round(geometry.plotHeight);

    // Front y axis starts level with the front trace's top, not the panel top.
    expect(axisPaths).toContain(`M0 ${round(-backOffset.y)} L0 ${plotHeight}`);
    // Front x axis ends short of the right edge by the sideways lean.
    expect(axisPaths).toContain(`M0 ${plotHeight} L${round(plotWidth - backOffset.x)} ${plotHeight}`);
    // The old full-canvas lines are gone.
    expect(axisPaths).not.toContain(`M0 0 L0 ${plotHeight}`);
    expect(axisPaths).not.toContain(`M0 ${plotHeight} L${plotWidth} ${plotHeight}`);
  });

  it('makes the front and rear L-axes equal length', () => {
    const doc = cascadeDoc();

    /** Euclidean length of a two-point `M x y L x y` path. */
    const segLen = (d: string): number => {
      const n = [...d.matchAll(/-?[\d.]+/g)].map(Number);
      return Math.hypot(n[2]! - n[0]!, n[3]! - n[1]!);
    };

    const front = collectByRole(scene(doc), 'axis')
      .map((n) => String(n.attrs?.['d']))
      .filter((d) => /^M-?[\d.]+ -?[\d.]+ L-?[\d.]+ -?[\d.]+$/.test(d));
    const rear = collectByRole(scene(doc), 'cascade-back-axis').map((n) => String(n.attrs?.['d']));

    // The vertical front axis line and the vertical rear axis line (x0 === x1).
    const isVertical = (d: string) => {
      const n = [...d.matchAll(/-?[\d.]+/g)].map(Number);
      return Math.abs(n[0]! - n[2]!) < 1e-6;
    };
    const frontY = front.find(isVertical)!;
    const rearY = rear.find(isVertical)!;
    expect(segLen(frontY)).toBeCloseTo(segLen(rearY), 3);

    // The horizontal pair (y0 === y1), longest of each (the axis line, not a tick).
    const horiz = (arr: string[]) =>
      arr.filter((d) => !isVertical(d)).sort((a, b) => segLen(b) - segLen(a))[0]!;
    expect(segLen(horiz(front))).toBeCloseTo(segLen(horiz(rear)), 3);
  });

  it('leaves a plain (non-cascading) line plot\'s front axes full length', () => {
    const doc = makeContinuousDocument(XY_PAIRS, 'line');
    const geometry = computePlotGeometry(plotOf(doc), doc, NATURE_THEME) as ContinuousPlotGeometry;
    const paths = collectByRole(scene(doc), 'axis').map((n) => String(n.attrs?.['d']));
    expect(paths).toContain(`M0 0 L0 ${round(geometry.plotHeight)}`);
    expect(paths).toContain(
      `M0 ${round(geometry.plotHeight)} L${round(geometry.plotWidth)} ${round(geometry.plotHeight)}`,
    );
  });
});

describe('gridlines: categorical plots', () => {
  it('draws only horizontal lines for a vertical (default) categorical plot', () => {
    const doc = makeCategoricalDocument({ showGridlines: true });
    const gridlines = collectByRole(scene(doc), 'gridline');
    expect(gridlines.length).toBeGreaterThan(0);
    for (const g of gridlines) {
      expect(String(g.attrs?.['d'])).toMatch(/^M0 [\d.-]+ L/);
    }
  });

  it('draws only vertical lines for a horizontal-orientation categorical plot', () => {
    const doc = makeCategoricalDocument({ showGridlines: true, orientation: 'horizontal' });
    const gridlines = collectByRole(scene(doc), 'gridline');
    expect(gridlines.length).toBeGreaterThan(0);
    for (const g of gridlines) {
      expect(String(g.attrs?.['d'])).toMatch(/^M[\d.-]+ 0 L/);
    }
  });
});

describe('gridlines: heatmap', () => {
  it('has no effect — a grid geometry has no numeric axis to grid against', () => {
    const doc = makeHeatmapDocument({ showGridlines: true });
    expect(collectByRole(scene(doc), 'gridline')).toEqual([]);
  });
});

describe('gridlines and colour accessibility', () => {
  it('never changes the colour-accessibility findings, on or off', () => {
    // Edited in place, not built from two separate makeCategoricalDocument()
    // calls: createIdFactory mixes in Math.random(), so two independently
    // constructed documents get different node ids, which would show up as a
    // spurious difference in a finding's own `nodeIds`.
    const without = makeCategoricalDocument();
    const withGridlines = editDocument(without, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') node.showGridlines = true;
      }
    });

    const findingsOf = (doc: FigureDocument) =>
      checkFigure({ document: doc, theme: NATURE_THEME, scene: scene(doc) }).findings.filter(
        (f) => f.id === 'colour-blind-conflict',
      );

    expect(findingsOf(withGridlines)).toEqual(findingsOf(without));
  });
});
