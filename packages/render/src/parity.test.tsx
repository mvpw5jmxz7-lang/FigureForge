/**
 * Renderer adapter parity.
 *
 * The whole architecture rests on one claim: the canvas and the export are the
 * same drawing. These tests hold both adapters to identical output, so any
 * future divergence fails here rather than in a submitted figure.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  addPanelWithPlot,
  applyAutoLayout,
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  relabelPanels,
  type Dataset,
  type FigureDocument,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument } from './render-document.js';
import { toSvgString } from './svg-string.js';
import { toReact } from './react.js';
import { collectAttr, collectByRole, walkScene } from './scene.js';

const CSV = `Treatment,Rep1,Rep2,Rep3
Vehicle,98.2,95.4,101.3
Drug,42.1,38.7,45.3`;

function makeDataset(id: string): Dataset {
  const parsed = parseDelimited(CSV);
  return {
    id,
    name: 'Viability',
    format: inferFormat(parsed.columns),
    columns: parsed.columns,
    rows: parsed.rows,
    sourcePath: `data/${id}.csv`,
    sourceFilename: 'viability.csv',
    importedAt: '2026-01-01T00:00:00.000Z',
  };
}

export function makeDocument(): FigureDocument {
  const newId = createIdFactory();
  const base = createDocument({
    title: 'Test figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    const dataset = makeDataset(newId());
    draft.datasets = [dataset];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Viability',
      datasetId: dataset.id,
      plotType: 'bar-dot',
      yTitle: 'Cell viability (%)',
    });
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Second',
      datasetId: dataset.id,
      plotType: 'dot',
      yTitle: 'Signal (a.u.)',
    });

    applyAutoLayout(draft, { marginMm: 2, gutterMm: 5, labelGutterMm: 4 });
    relabelPanels(draft, newId, { fontSizePt: 8, offsetMm: 4 });
  });
}

/**
 * Normalise for comparison. React and the string serialiser pick different but
 * equivalent spellings for the same escape (`&#x27;` vs `&apos;`), so entities
 * are folded before comparing — the point of the test is that the *drawing*
 * matches, not that two encoders agree on entity syntax.
 */
function normalise(markup: string): string {
  return markup
    .replace(/<([a-zA-Z]+)([^>]*?)\s*\/>/g, '<$1$2></$1>')
    .replace(/&(?:apos|#x27|#39);/g, "'")
    .replace(/&(?:quot|#x22|#34);/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('adapter parity', () => {
  const doc = makeDocument();
  const scene = renderDocument(doc, { theme: NATURE_THEME });

  it('produces the same markup from both adapters', () => {
    const fromString = normalise(toSvgString(scene));
    const fromReact = normalise(renderToStaticMarkup(toReact(scene)));

    // React adds data-role/data-node-id hooks the exporter must not emit;
    // strip them before comparing the drawing itself.
    const stripped = fromReact
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');

    expect(stripped).toBe(fromString);
  });

  it('renders deterministically across repeated calls', () => {
    const a = toSvgString(renderDocument(doc, { theme: NATURE_THEME }));
    const b = toSvgString(renderDocument(doc, { theme: NATURE_THEME }));
    expect(a).toBe(b);
  });

  it('places jittered points identically on every render', () => {
    // Jitter must be seeded, or the export would not match the screen.
    const first = collectByRole(renderDocument(doc, { theme: NATURE_THEME }), 'point');
    const second = collectByRole(renderDocument(doc, { theme: NATURE_THEME }), 'point');
    expect(first.map((n) => n.attrs?.['cx'])).toEqual(second.map((n) => n.attrs?.['cx']));
    expect(first.length).toBeGreaterThan(0);
  });

  it('excludes editor chrome from the export render', () => {
    const withChrome = renderDocument(doc, {
      theme: NATURE_THEME,
      chrome: { showGrid: true, selectedIds: Object.keys(doc.nodes).slice(0, 1) },
    });
    const clean = renderDocument(doc, { theme: NATURE_THEME });

    let chromeCount = 0;
    let cleanCount = 0;
    walkScene(withChrome, () => chromeCount++);
    walkScene(clean, () => cleanCount++);

    expect(chromeCount).toBeGreaterThan(cleanCount);
    expect(toSvgString(clean)).not.toContain('#0a84ff');
  });
});

describe('page geometry', () => {
  const doc = makeDocument();
  const svg = toSvgString(renderDocument(doc, { theme: NATURE_THEME }));

  it('declares physical dimensions in millimetres', () => {
    expect(svg).toContain('width="183mm"');
    expect(svg).toContain('height="75mm"');
  });

  it('maps one user unit to one millimetre', () => {
    // This is what makes exported PDFs come out at exactly the journal width.
    expect(svg).toContain('viewBox="0 0 183 75"');
  });
});

describe('typography', () => {
  const doc = makeDocument();
  const scene = renderDocument(doc, { theme: NATURE_THEME });

  it('converts point sizes to millimetres', () => {
    const sizes = collectAttr(scene, 'font-size').filter(
      (v): v is number => typeof v === 'number',
    );
    expect(sizes.length).toBeGreaterThan(0);

    // 8 pt panel labels must render as 8 * 25.4/72 = 2.8222 mm.
    const panelLabels = collectByRole(scene, 'panel-label');
    expect(panelLabels).toHaveLength(2);
    expect(panelLabels[0]?.attrs?.['font-size']).toBeCloseTo(2.8222, 3);
  });

  it('keeps every text element within the journal size range', () => {
    const MM_PER_PT = 25.4 / 72;
    const sizes = collectAttr(scene, 'font-size').filter(
      (v): v is number => typeof v === 'number',
    );
    for (const mm of sizes) {
      const pt = mm / MM_PER_PT;
      expect(pt).toBeGreaterThanOrEqual(NATURE_THEME.type.minimumPt - 0.01);
      expect(pt).toBeLessThanOrEqual(NATURE_THEME.type.panelLabelPt + 0.01);
    }
  });

  it('emits text as real text, never as outlined paths', () => {
    const svg = toSvgString(scene);
    expect(svg).toContain('<text');
    expect(svg).toContain('Cell viability (%)');
  });
});

describe('escaping', () => {
  it('escapes XML metacharacters in labels', () => {
    const newId = createIdFactory();
    const doc = editDocument(
      createDocument({ idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' }),
      (draft) => {
        const id = newId();
        draft.nodes[id] = {
          id,
          name: 'Tricky',
          parentId: null,
          layerId: draft.layers[0]!.id,
          frame: { x: 0, y: 0, width: 20, height: 5 },
          rotation: 0,
          opacity: 1,
          locked: false,
          hidden: false,
          z: 0,
          type: 'text',
          text: 'p < 0.05 & "significant"',
          style: { fontSizePt: 6 },
        };
      },
    );

    const svg = toSvgString(renderDocument(doc, { theme: NATURE_THEME }));
    expect(svg).toContain('p &lt; 0.05 &amp; &quot;significant&quot;');
    // A raw < inside the document would produce invalid XML.
    expect(svg).not.toContain('p < 0.05');
  });
});
