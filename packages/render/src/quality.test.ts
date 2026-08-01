/**
 * Quality checker rules.
 *
 * These assert the checker's *judgements*, not its plumbing — a rule that never
 * fires is worse than no rule, because the readiness score then reads as a pass.
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
  type PlotType,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument } from './render-document.js';
import { checkFigure } from './quality.js';

/** Three replicates per group — the sample size biology actually runs. */
const SMALL = `Treatment,Rep1,Rep2,Rep3
Vehicle,98.2,95.4,101.3
Drug,42.1,38.7,45.3`;

/** Twelve replicates, enough to support a density estimate. */
const LARGE = `Treatment,R1,R2,R3,R4,R5,R6,R7,R8,R9,R10,R11,R12
Vehicle,98,95,101,97,99,96,102,94,100,98,97,103
Drug,42,39,45,41,43,40,44,38,46,42,41,47`;

function makeDocument(csv: string, plotType: PlotType): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'Quality figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const parsed = parseDelimited(csv);
    const dataset: Dataset = {
      id: newId(),
      name: 'Viability',
      format: inferFormat(parsed.columns),
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/viability.csv',
      sourceFilename: 'viability.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Viability',
      datasetId: dataset.id,
      plotType,
      yTitle: 'Cell viability (%)',
    });
  });
}

function findingsFor(csv: string, plotType: PlotType) {
  const document = makeDocument(csv, plotType);
  const scene = renderDocument(document, { theme: NATURE_THEME });
  return checkFigure({ document, theme: NATURE_THEME, scene }).findings;
}

describe('distribution sample size', () => {
  const ids = (csv: string, plotType: PlotType) =>
    findingsFor(csv, plotType)
      .filter((f) => f.id.startsWith('distribution-n-'))
      .map((f) => f.title);

  it('warns about a violin drawn over three replicates', () => {
    // Kernel density turns three numbers into a smooth, confident-looking
    // shape. The reader sees a distribution; the data supports nothing of it.
    expect(ids(SMALL, 'violin')).toEqual(['Violin plot with n = 3']);
  });

  it('warns about a box plot below the quartile threshold', () => {
    expect(ids(SMALL, 'box')).toEqual(['Box plot with n = 3']);
  });

  it('stays quiet once the sample supports the mark', () => {
    expect(ids(LARGE, 'violin')).toEqual([]);
    expect(ids(LARGE, 'box')).toEqual([]);
  });

  it('says nothing about plots that draw every replicate', () => {
    // A beeswarm at n = 3 shows three points and claims nothing more.
    for (const plotType of ['bar', 'dot', 'bar-dot', 'beeswarm'] as const) {
      expect(ids(SMALL, plotType)).toEqual([]);
    }
  });

  it('costs the readiness score when it fires', () => {
    const withWarning = makeDocument(SMALL, 'violin');
    const clean = makeDocument(LARGE, 'violin');

    const score = (doc: FigureDocument) =>
      checkFigure({
        document: doc,
        theme: NATURE_THEME,
        scene: renderDocument(doc, { theme: NATURE_THEME }),
      }).score;

    expect(score(withWarning)).toBeLessThan(score(clean));
  });
});
