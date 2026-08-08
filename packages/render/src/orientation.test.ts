/**
 * Horizontal orientation for bar/dot/bar-dot/box/violin/beeswarm plots.
 *
 * `node.x` stays "the categorical spec" and `node.y` stays "the numeric
 * spec" regardless of orientation — only which physical edge each is drawn
 * against changes. These tests pin the margin swap (`requiredMargin`), the
 * axis-line/label placement (`renderAxesHorizontal`), and the bracket
 * refusal (`measurePlot`) that orientation drives, plus the standing
 * "absent is unchanged" regression every optional field in this codebase
 * is held to.
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
import { measurePlot, renderDocument } from './render-document.js';
import { collectByRole } from './scene.js';
import { toSvgString } from './svg-string.js';

/** A single-factor replicate table — two groups, three replicates each. */
const REPLICATES = `Treatment,R1,R2,R3
Vehicle,10,11,12
Drug,4,5,6`;

function makeDocument(patch: Partial<PlotNode> = {}, plotType: PlotType = 'bar-dot'): FigureDocument {
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
      plotType,
      xTitle: 'Treatment',
      yTitle: 'Value',
    });
    Object.assign(plot, patch);
  });
}

const scene = (doc: FigureDocument) => renderDocument(doc, { theme: NATURE_THEME });
const plotOf = (doc: FigureDocument): PlotNode =>
  Object.values(doc.nodes).find((n): n is PlotNode => n.type === 'plot')!;

describe('horizontal orientation', () => {
  it('omitting orientation renders exactly as vertical', () => {
    // Edited in place, not built from two separate `makeDocument()` calls:
    // `createIdFactory` mixes in `Math.random()`, so two independently
    // constructed documents get different plot ids and therefore different
    // seeded jitter — the comparison has to hold the id fixed.
    const implicitDoc = makeDocument();
    const implicit = toSvgString(scene(implicitDoc));
    const explicitDoc = editDocument(implicitDoc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') node.orientation = 'vertical';
      }
    });
    const explicit = toSvgString(scene(explicitDoc));
    expect(explicit).toBe(implicit);
  });

  it('draws the category axis line vertically and the value axis line horizontally', () => {
    const doc = makeDocument({ orientation: 'horizontal' });
    const [axisLine] = collectByRole(scene(doc), 'axis');
    // The category (x) axis line: same physical x at both ends (a vertical
    // stroke), unlike the vertical-orientation default where it is the y
    // axis that runs vertically.
    const d = String(axisLine!.attrs?.['d']);
    const points = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(points).toHaveLength(2);
    expect(points[0]![0]).toBeCloseTo(points[1]![0]!, 6); // same x: vertical line
  });

  it('draws category labels to the left, at negative x, one per category', () => {
    const doc = makeDocument({ orientation: 'horizontal' });
    const labels = collectByRole(scene(doc), 'tick-label').filter(
      (n) => n.text === 'Vehicle' || n.text === 'Drug',
    );
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(Number(label.attrs?.['x'])).toBeLessThan(0);
      expect(label.attrs?.['text-anchor']).toBe('end');
    }
  });

  it('draws numeric tick labels along the bottom, at y past the plot area', () => {
    const vertical = scene(makeDocument());
    const horizontal = scene(makeDocument({ orientation: 'horizontal' }));

    // Vertical: numeric labels are the y-axis ones, drawn at negative x.
    // Horizontal: numeric labels move to the bottom axis, drawn at y > 0
    // (below the plot origin) instead.
    const verticalNumeric = collectByRole(vertical, 'tick-label').filter(
      (n) => n.text !== 'Vehicle' && n.text !== 'Drug',
    );
    const horizontalNumeric = collectByRole(horizontal, 'tick-label').filter(
      (n) => n.text !== 'Vehicle' && n.text !== 'Drug',
    );
    expect(verticalNumeric.length).toBeGreaterThan(0);
    expect(horizontalNumeric.length).toBeGreaterThan(0);
    for (const label of verticalNumeric) expect(Number(label.attrs?.['x'])).toBeLessThan(0);
    for (const label of horizontalNumeric) expect(Number(label.attrs?.['y'])).toBeGreaterThan(0);
  });

  it('grows bars along x instead of y, at equal height instead of equal width', () => {
    const doc = makeDocument({ orientation: 'horizontal' });
    const bars = collectByRole(scene(doc), 'bar');
    expect(bars).toHaveLength(2);
    const [a, b] = bars;
    // Same band slot height (both are ordinary single-factor bars), but
    // different widths — since Vehicle (mean 11) and Drug (mean 5) differ.
    expect(Number(a!.attrs?.['height'])).toBeCloseTo(Number(b!.attrs?.['height']), 6);
    expect(Number(a!.attrs?.['width'])).not.toBeCloseTo(Number(b!.attrs?.['width']), 1);
  });

  it('reserves the left margin for category labels and the bottom for numeric ones', () => {
    // Indirectly observed through the plot-area transform: `margin.left`
    // grows to hold "Vehicle"/"Drug" (short) either way, but the *split*
    // between left and bottom inverts — proven by the bottom margin now
    // being small (no long category names to fit) rather than large.
    const vertical = scene(makeDocument());
    const horizontal = scene(makeDocument({ orientation: 'horizontal' }));
    const transform = (s: typeof vertical): [number, number] => {
      const [area] = collectByRole(s, 'plot-area');
      const match = String(area!.attrs?.['transform']).match(/translate\((-?[\d.]+) (-?[\d.]+)\)/);
      return [Number(match![1]), Number(match![2])];
    };
    const [verticalLeft] = transform(vertical);
    const [horizontalLeft] = transform(horizontal);
    // Horizontal's left margin holds "Vehicle"/"Drug" unrotated (a few mm);
    // vertical's left margin holds only y-axis numbers, which are narrower —
    // so horizontal's left margin must be the larger of the two.
    expect(horizontalLeft).toBeGreaterThan(verticalLeft);
  });

  for (const plotType of ['box', 'violin'] as const) {
    it(`draws a ${plotType} plot's whisker/median geometry with the same role counts when horizontal`, () => {
      const vertical = scene(makeDocument({}, plotType));
      const horizontal = scene(makeDocument({ orientation: 'horizontal' }, plotType));
      for (const role of ['whisker', 'box', 'line', 'violin'] as const) {
        expect(collectByRole(horizontal, role)).toHaveLength(collectByRole(vertical, role).length);
      }
    });
  }

  it('refuses brackets on a horizontal plot, the same way a continuous plot already is', () => {
    const doc = makeDocument({ orientation: 'horizontal' });
    const measurements = measurePlot(doc, plotOf(doc), NATURE_THEME);
    expect(measurements).toEqual({ categoryX: new Map(), categoryTop: new Map() });
  });

  it('still measures brackets normally when orientation is vertical', () => {
    const doc = makeDocument();
    const measurements = measurePlot(doc, plotOf(doc), NATURE_THEME);
    expect(measurements!.categoryX.size).toBe(2);
    expect(measurements!.categoryTop.size).toBe(2);
  });
});
