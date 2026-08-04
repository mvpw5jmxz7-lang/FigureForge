/**
 * Survival (Kaplan–Meier) plots: an ordinary `kind: 'continuous'` geometry
 * built through a dedicated data-prep path (`toSurvivalGroups`/`kaplanMeier`)
 * rather than `toSeries`/`xyMarks`. These tests pin the geometry only this
 * plot type produces — the stepped line, the censoring ticks, the confidence
 * band and the fixed [0, 1] y domain — none of which the ordinary scatter/
 * line path exercises.
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

// One implicit group. 1/5 have the event at t=1, a tied event+censoring at
// t=2, 1/2 at t=3, and the last subject's event at t=5 exhausts the risk set
// — the same worked example `packages/plots`' own Kaplan-Meier tests use.
const SINGLE_GROUP_CSV = `Time,Event
1,1
2,1
2,0
3,1
5,1`;

// Two arms, one subject in each censored — enough to exercise a legend and a
// second series' censoring tick independently of the first.
const TWO_GROUP_CSV = `Time,Event,Arm
5,1,A
8,0,B
12,1,A
3,1,B`;

function makeSurvivalDocument(csv: string, patch: Partial<PlotNode> = {}): FigureDocument {
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
      name: 'Cohort',
      format: 'survival',
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/d.csv',
      sourceFilename: 'd.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: 80, height: 60 },
      name: 'Survival',
      datasetId: dataset.id,
      plotType: 'survival',
    });

    for (const node of Object.values(draft.nodes)) {
      if (node.type === 'plot') Object.assign(node, patch);
    }
  });
}

const scene = (doc: FigureDocument) => renderDocument(doc, { theme: NATURE_THEME });

describe('survival geometry', () => {
  it('draws one stepped line per group', () => {
    const single = collectByRole(scene(makeSurvivalDocument(SINGLE_GROUP_CSV)), 'line');
    expect(single).toHaveLength(1);

    const grouped = collectByRole(scene(makeSurvivalDocument(TWO_GROUP_CSV)), 'line');
    expect(grouped).toHaveLength(2);
  });

  it('draws the line as a step function, not a straight line between points', () => {
    const [line] = collectByRole(scene(makeSurvivalDocument(SINGLE_GROUP_CSV)), 'line');
    const d = String(line!.attrs?.['d']);
    // 5 distinct observed times plus the (0,1) anchor is 6 vertices for a
    // straight polyline; a step function inserts one extra "hold" vertex
    // before every drop after the first, so there are more L commands than
    // there are distinct times.
    const commands = d.split(/(?=[ML])/).filter((c) => c.trim().length > 0);
    expect(commands.length).toBeGreaterThan(6);
  });

  it('fixes the y domain at [0, 1] regardless of node.y.min/max', () => {
    const s = scene(
      makeSurvivalDocument(SINGLE_GROUP_CSV, {
        y: {
          title: '',
          min: -10,
          max: 10,
          tickStep: null,
          scale: 'linear',
          showLine: true,
          showTicks: true,
          showLabels: true,
          trimToData: false,
        },
      }),
    );
    // Y tick labels are vertically centred on their tick (`dominant-baseline:
    // central`); x tick labels are not — the same disambiguator
    // `continuous-axis.test.ts`'s own y-domain test uses, since an x label
    // (a time) can legitimately read outside [0, 1].
    const yLabels = collectByRole(s, 'tick-label')
      .filter((n) => n.attrs?.['dominant-baseline'] === 'central')
      .map((n) => Number((n as { text?: string }).text));
    expect(yLabels.length).toBeGreaterThan(0);
    for (const value of yLabels) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('draws a censoring tick where a subject leaves without an event, by default', () => {
    const withTicks = collectByRole(scene(makeSurvivalDocument(SINGLE_GROUP_CSV)), 'censor-mark');
    // One subject (at t=2) is censored in SINGLE_GROUP_CSV.
    expect(withTicks).toHaveLength(1);
  });

  it('hides censoring ticks when showCensorMarks is false', () => {
    const s = scene(makeSurvivalDocument(SINGLE_GROUP_CSV, { showCensorMarks: false }));
    expect(collectByRole(s, 'censor-mark')).toEqual([]);
  });

  it('draws no confidence band by default', () => {
    const s = scene(makeSurvivalDocument(SINGLE_GROUP_CSV));
    expect(collectByRole(s, 'error-bar')).toEqual([]);
  });

  it('draws one confidence-band polygon per group when showSurvivalCI is set', () => {
    const single = collectByRole(
      scene(makeSurvivalDocument(SINGLE_GROUP_CSV, { showSurvivalCI: true })),
      'error-bar',
    );
    expect(single).toHaveLength(1);

    const grouped = collectByRole(
      scene(makeSurvivalDocument(TWO_GROUP_CSV, { showSurvivalCI: true })),
      'error-bar',
    );
    expect(grouped).toHaveLength(2);
  });

  it('refuses to draw when there is no event column to read', () => {
    const s = scene(makeSurvivalDocument('Time\n1\n2\n3'));
    expect(collectByRole(s, 'line')).toEqual([]);
    expect(collectByRole(s, 'censor-mark')).toEqual([]);
  });
});
