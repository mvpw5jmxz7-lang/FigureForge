/**
 * Axis label collision handling.
 *
 * Importing another dataset creates another panel and re-runs the layout, so
 * every existing panel narrows. Below some width the category labels no longer
 * fit their band, and until this behaviour existed they simply overprinted each
 * other.
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
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument } from './render-document.js';
import { collectByRole } from './scene.js';
import { estimateTextHeightMm, estimateTextWidthMm, truncateToWidth } from './text-width.js';

/** Long category names, of the kind real treatment labels actually have. */
const CSV = `Treatment,R1,R2,R3
Vehicle control,98.2,95.4,101.3
Compound A 10 uM,42.1,38.7,45.3
Compound B 10 uM,55.4,51.2,58.8
Compound C 10 uM,61.5,64.2,59.9`;

function makeDocument(panelWidthMm: number): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    widthMm: 183,
    heightMm: 75,
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const parsed = parseDelimited(CSV);
    const dataset: Dataset = {
      id: newId(),
      name: 'Viability',
      format: inferFormat(parsed.columns),
      columns: parsed.columns,
      rows: parsed.rows,
      sourcePath: 'data/d.csv',
      sourceFilename: 'd.csv',
      importedAt: '2026-01-01T00:00:00.000Z',
    };
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 2, y: 2, width: panelWidthMm, height: 60 },
      name: 'Viability',
      datasetId: dataset.id,
      plotType: 'bar-dot',
      yTitle: 'Cell viability (%)',
    });
  });
}

const tickLabels = (doc: FigureDocument) =>
  collectByRole(renderDocument(doc, { theme: NATURE_THEME }), 'tick-label');

/**
 * Y tick labels only. Rotated *category* labels also anchor at `end`, so the
 * anchor alone does not distinguish them — the absence of a transform does.
 */
const isYTickLabel = (n: { attrs?: Record<string, unknown> }): boolean =>
  n.attrs?.['text-anchor'] === 'end' && n.attrs?.['transform'] === undefined;

describe('text width estimation', () => {
  it('grows with length and with font size', () => {
    expect(estimateTextWidthMm('WWWW', 6)).toBeGreaterThan(estimateTextWidthMm('WW', 6));
    expect(estimateTextWidthMm('Vehicle', 12)).toBeCloseTo(
      estimateTextWidthMm('Vehicle', 6) * 2,
      6,
    );
  });

  it('accounts for glyph width, not just character count', () => {
    // 'W' is roughly four times the advance of 'l'; a naive count would tie.
    expect(estimateTextWidthMm('WWWW', 6)).toBeGreaterThan(estimateTextWidthMm('llll', 6) * 3);
  });

  it('returns zero for empty or nonsensical input', () => {
    expect(estimateTextWidthMm('', 6)).toBe(0);
    expect(estimateTextWidthMm('x', 0)).toBe(0);
    expect(estimateTextHeightMm(0)).toBe(0);
  });

  it('truncates only when the text does not fit', () => {
    const wide = estimateTextWidthMm('Compound A', 6);
    expect(truncateToWidth('Compound A', 6, wide + 1)).toBe('Compound A');

    const short = truncateToWidth('Compound A 10 uM', 6, wide / 2);
    expect(short.endsWith('…')).toBe(true);
    expect(estimateTextWidthMm(short, 6)).toBeLessThanOrEqual(wide / 2);
  });
});

describe('axis label collision', () => {
  it('rotates category labels once they no longer fit their band', () => {
    const narrow = tickLabels(makeDocument(45));
    const rotated = narrow.filter((n) => String(n.attrs?.['transform'] ?? '').includes('rotate'));

    // Four long names in a 45 mm panel cannot sit horizontally.
    expect(rotated.length).toBeGreaterThan(0);
    // Rotation is all-or-nothing per axis: a mix reads as a mistake.
    const categories = narrow.filter((n) => n.text?.startsWith('Compound') || n.text === 'Vehicle control');
    expect(categories.every((n) => String(n.attrs?.['transform'] ?? '').includes('rotate'))).toBe(
      true,
    );
  });

  it('goes vertical rather than truncating names to nothing', () => {
    // At 45° the clearance is only slot × √2, so a very narrow panel would have
    // to cut every name to two or three characters — worse than the overlap it
    // set out to fix. Upright labels are bounded by the space below the axis
    // instead of by their neighbours, so the names survive intact.
    const labels = tickLabels(makeDocument(30)).filter((n) => n.text?.includes('Compound'));

    expect(labels.length).toBe(3);
    expect(labels.every((n) => String(n.attrs?.['transform'] ?? '').includes('rotate(-90)'))).toBe(
      true,
    );
    expect(labels.every((n) => !n.text?.includes('…'))).toBe(true);
  });

  it('keeps the x axis title clear of angled labels and inside the panel', () => {
    const scene = renderDocument(makeDocument(30), { theme: NATURE_THEME });
    const title = collectByRole(scene, 'axis-title').find((n) => n.text === 'Compound');
    const labels = collectByRole(scene, 'tick-label').filter((n) =>
      String(n.attrs?.['transform'] ?? '').includes('rotate(-90)'),
    );

    if (title && labels.length > 0) {
      const titleY = Number(title.attrs?.['y']);
      const labelBase = Number(
        /translate\([\d.]+ ([\d.]+)\)/.exec(String(labels[0]!.attrs?.['transform']))?.[1],
      );
      // Below where the labels start, and still within the panel.
      expect(titleY).toBeGreaterThan(labelBase);
      expect(titleY).toBeLessThanOrEqual(60 + NATURE_THEME.spacing.plotMarginMm.bottom);
    }
  });

  it('leaves labels horizontal when there is room', () => {
    const wide = tickLabels(makeDocument(175));
    const categories = wide.filter((n) => n.text === 'Vehicle control');
    expect(categories.length).toBeGreaterThan(0);
    expect(categories.every((n) => n.attrs?.['transform'] === undefined)).toBe(true);
  });

  it('thins y tick labels rather than overprinting them', () => {
    // A short axis still asks for ~length/12 ticks, which is more labels than
    // the height can hold.
    const scene = renderDocument(makeDocument(60), { theme: NATURE_THEME });
    const labels = collectByRole(scene, 'tick-label')
      .filter(isYTickLabel)
      .map((n) => Number(n.attrs?.['y']))
      .sort((a, b) => a - b);

    const minimum = estimateTextHeightMm(NATURE_THEME.type.tickLabelPt);
    for (let i = 1; i < labels.length; i++) {
      expect(labels[i]! - labels[i - 1]!).toBeGreaterThanOrEqual(minimum);
    }
  });

  it('grows the left gutter so long tick labels and the title stay in the panel', () => {
    // Five-figure counts plus a y title need far more than the theme's 12 mm.
    // Before the gutter was derived they simply ran out of the panel, and
    // panels do not clip — so the overflow landed on the neighbouring panel.
    const doc = makeDocument(80);
    const big = editDocument(doc, (draft) => {
      const ds = draft.datasets[0]!;
      draft.datasets = [
        {
          ...ds,
          rows: ds.rows.map((row) =>
            row.map((cell) => (typeof cell === 'number' ? cell * 1000 : cell)),
          ),
        },
      ];
    });

    const scene = renderDocument(big, { theme: NATURE_THEME });
    const area = collectByRole(scene, 'plot-area')[0]!;
    const marginLeft = Number(/translate\((-?[\d.]+)/.exec(String(area.attrs?.['transform']))?.[1]);

    expect(marginLeft).toBeGreaterThan(NATURE_THEME.spacing.plotMarginMm.left);

    // Everything the axis draws sits at a negative x relative to the plot area,
    // so `marginLeft + x` is its position within the panel and must not go
    // negative.
    const title = collectByRole(scene, 'axis-title').find((n) => n.text?.includes('viability'))!;
    const titleX = Number(/translate\((-?[\d.]+)/.exec(String(title.attrs?.['transform']))?.[1]);
    expect(marginLeft + titleX).toBeGreaterThanOrEqual(0);

    for (const label of collectByRole(scene, 'tick-label').filter(isYTickLabel)) {
      const right = Number(label.attrs?.['x']);
      const left = right - estimateTextWidthMm(label.text ?? '', NATURE_THEME.type.tickLabelPt);
      expect(marginLeft + left).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves the gutter alone when the theme default already fits', () => {
    // Regression guard: growing the margin must not shift a figure that never
    // needed it, or every existing document re-lays itself out on open.
    const scene = renderDocument(makeDocument(80), { theme: NATURE_THEME });
    const area = collectByRole(scene, 'plot-area')[0]!;
    const marginLeft = Number(/translate\((-?[\d.]+)/.exec(String(area.attrs?.['transform']))?.[1]);
    expect(marginLeft).toBeCloseTo(NATURE_THEME.spacing.plotMarginMm.left, 6);
  });

  it('clears the y axis title past the widest tick label', () => {
    const scene = renderDocument(makeDocument(80), { theme: NATURE_THEME });
    const title = collectByRole(scene, 'axis-title').find((n) => n.text?.includes('viability'));
    const transform = String(title?.attrs?.['transform'] ?? '');
    const x = Number(/translate\((-?[\d.]+)/.exec(transform)?.[1]);

    const widest = Math.max(
      ...collectByRole(scene, 'tick-label')
        .filter(isYTickLabel)
        .map((n) => estimateTextWidthMm(n.text ?? '', NATURE_THEME.type.tickLabelPt)),
    );

    // The title sits beyond the labels, not on top of them.
    expect(Math.abs(x)).toBeGreaterThan(widest);
  });
});
