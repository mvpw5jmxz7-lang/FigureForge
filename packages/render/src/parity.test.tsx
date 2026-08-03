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
  addArrow,
  addAsset,
  addPanelWithImage,
  addPanelWithPlot,
  addScaleBar,
  addShape,
  applyAutoLayout,
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  relabelPanels,
  setImageCrop,
  type Dataset,
  type FigureDocument,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { renderDocument } from './render-document.js';
import { toSvgString } from './svg-string.js';
import { toReact } from './react.js';
import { collectAttr, collectByRole, walkScene, walkWithOwner } from './scene.js';

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

  it('produces the same markup when axis labels are rotated', () => {
    // Rotation and truncation are layout decisions taken inside the renderer,
    // so both adapters must reach them identically — otherwise the screen would
    // show angled labels and the PDF overlapping ones.
    const crowded = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        // 26 mm leaves ~12 mm of plot once the axis gutters are taken, so the
        // two category names no longer fit their bands.
        if (node.type === 'panel') node.frame = { ...node.frame, width: 26 };
        if (node.type === 'plot') node.frame = { ...node.frame, width: 26 };
      }
    });
    const scene = renderDocument(crowded, { theme: NATURE_THEME });

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');

    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(
      collectByRole(scene, 'tick-label').some((n) =>
        String(n.attrs?.['transform'] ?? '').includes('rotate'),
      ),
    ).toBe(true);
  });

  it('keeps selection chrome out of the exported drawing', () => {
    // Resize handles are drawn into the scene, so this proves they cannot leak
    // into an export: the export path passes no chrome at all.
    const selected = Object.values(doc.nodes).find((n) => n.type === 'panel')!.id;
    const withHandles = renderDocument(doc, {
      theme: NATURE_THEME,
      chrome: { selectedIds: [selected] },
    });

    expect(collectByRole(withHandles, 'resize-handle').length).toBe(8);
    expect(collectByRole(renderDocument(doc, { theme: NATURE_THEME }), 'resize-handle')).toEqual(
      [],
    );

    // React must actually accept every attribute the chrome emits. Comparing
    // the two adapters' strings does not prove this — a `style` string renders
    // fine through the serialiser and throws in React, taking the canvas with
    // it the moment anything is selected.
    expect(() => renderToStaticMarkup(toReact(withHandles))).not.toThrow();
  });

  it('draws box and violin marks through both adapters identically', () => {
    // The distribution types were declared in `PlotType` long before they
    // rendered, and fell through to the categorical dot path in the meantime.
    // This pins each one to geometry only it produces.
    for (const [plotType, role] of [
      ['box', 'box'],
      ['violin', 'violin'],
    ] as const) {
      const doc = editDocument(makeDocument(), (draft) => {
        for (const node of Object.values(draft.nodes)) {
          if (node.type === 'plot') node.plotType = plotType;
        }
      });
      const scene = renderDocument(doc, { theme: NATURE_THEME });

      expect(collectByRole(scene, role).length).toBeGreaterThan(0);

      const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
        .replace(/ data-role="[^"]*"/g, '')
        .replace(/ data-node-id="[^"]*"/g, '');
      expect(fromReact).toBe(normalise(toSvgString(scene)));

      // Parity compares two strings, so it cannot catch an attribute React
      // rejects outright — assert the React path survives the new marks too.
      expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
    }
  });

  it('suppresses error bars under a box or violin', () => {
    // The mark geometry drops them; this proves nothing downstream puts them back.
    for (const plotType of ['box', 'violin'] as const) {
      const doc = editDocument(makeDocument(), (draft) => {
        for (const node of Object.values(draft.nodes)) {
          if (node.type === 'plot') {
            node.plotType = plotType;
            node.errorBars = 'sem';
          }
        }
      });
      const scene = renderDocument(doc, { theme: NATURE_THEME });
      expect(collectByRole(scene, 'error-bar')).toEqual([]);
    }
  });

  it('draws the continuous types through both adapters identically', () => {
    // These need a numeric x axis and paired x values, so they get their own
    // two-column document rather than the replicate CSV above.
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Dose,Response\n1,2.1\n2,3.9\n3,6.2\n4,7.8\n5,10.1');

    for (const [plotType, role] of [
      ['scatter', 'point'],
      ['line', 'line'],
      ['histogram', 'bar'],
    ] as const) {
      const doc = editDocument(base, (draft) => {
        const dataset: Dataset = {
          id: 'ds-xy',
          name: 'Dose response',
          format: inferFormat(parsed.columns),
          columns: parsed.columns,
          rows: parsed.rows,
          sourcePath: 'data/xy.csv',
          sourceFilename: 'xy.csv',
          importedAt: '2026-01-01T00:00:00.000Z',
        };
        draft.datasets = [dataset];
        addPanelWithPlot(draft, newId, {
          frame: { x: 2, y: 2, width: 80, height: 60 },
          name: 'Dose response',
          datasetId: dataset.id,
          plotType,
          xTitle: 'Dose (mg)',
          yTitle: 'Response',
        });
      });

      const scene = renderDocument(doc, { theme: NATURE_THEME });
      expect(collectByRole(scene, role).length).toBeGreaterThan(0);

      const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
        .replace(/ data-role="[^"]*"/g, '')
        .replace(/ data-node-id="[^"]*"/g, '');
      expect(fromReact).toBe(normalise(toSvgString(scene)));
      expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
    }
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

// ---------------------------------------------------------------------------
// Image panels, scale bars and annotations
// ---------------------------------------------------------------------------

/** A real 1×1 PNG, so the `<image href>` path is genuinely exercised rather
 *  than falling through to the missing-asset placeholder. */
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
  'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ASSET_ID = 'asset-1';
const NATURAL_PX = { width: 1000, height: 800 };

/**
 * A figure with one of every node type this phase added, so the adapters are
 * held to the same drawing for all of them at once.
 */
function makeImageDocument(): FigureDocument {
  const newId = createIdFactory('img');
  const base = createDocument({
    title: 'Micrograph figure',
    widthMm: 183,
    heightMm: 75,
    presetId: 'nature-double',
    idFactory: newId,
    now: () => '2026-01-01T00:00:00.000Z',
  });

  return editDocument(base, (draft) => {
    addAsset(draft, {
      id: ASSET_ID,
      filename: 'cells.png',
      mimeType: 'image/png',
      byteLength: 128,
      naturalPx: NATURAL_PX,
    });

    const { image } = addPanelWithImage(draft, newId, {
      frame: { x: 4, y: 4, width: 50, height: 40 },
      name: 'Cells',
      assetId: ASSET_ID,
      naturalPx: NATURAL_PX,
    });

    // 1000 px shown 50 mm wide → 0.05 mm/px; at 2 px/µm a 10 µm bar is 1.0 mm.
    addScaleBar(draft, newId, {
      imageId: image.id,
      length: 10,
      pixelsPerUnit: 2,
      unitLabel: 'µm',
      calibrationSource: 'metadata',
    });

    addArrow(draft, newId, { frame: { x: 60, y: 10, width: 15, height: 8 } });
    addShape(draft, newId, {
      shape: 'rect',
      frame: { x: 60, y: 30, width: 20, height: 12 },
    });
    addShape(draft, newId, {
      shape: 'ellipse',
      frame: { x: 90, y: 30, width: 20, height: 12 },
    });
  });
}

const resolveAsset = (): string => PNG_DATA_URI;

describe('image and annotation nodes', () => {
  const doc = makeImageDocument();
  const scene = renderDocument(doc, { theme: NATURE_THEME, resolveAsset });

  it('renders every new node type', () => {
    for (const role of ['image', 'shape', 'arrow', 'scale-bar', 'scale-bar-label'] as const) {
      expect(collectByRole(scene, role).length).toBeGreaterThan(0);
    }
  });

  it('produces the same markup from both adapters', () => {
    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
  });

  it('survives the React adapter', () => {
    // The highest-value assertion in this group. `renderImage` emits `href`,
    // `preserveAspectRatio`, `image-rendering` and `clip-path` — four
    // attributes React had never seen from this renderer. Parity compares two
    // strings and so cannot catch one React rejects outright, which is exactly
    // how a `style` string once blanked the canvas while every test stayed green.
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('embeds the asset as a self-contained data URI', () => {
    // An exported SVG must not depend on anything outside itself; a blob URL
    // here would render on screen and be blank on the journal's machine.
    const svg = toSvgString(scene);
    expect(svg).toContain('<image');
    expect(svg).toContain('data:image/png;base64,');
  });

  it('degrades to a visible placeholder when the asset is missing', () => {
    // No resolveAsset: a lost micrograph must read as a gap, not as a blank
    // area the author might not notice before submitting.
    const orphaned = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(orphaned, 'image').length).toBeGreaterThan(0);
    expect(toSvgString(orphaned)).not.toContain('href');
  });

  it('crops by clipping rather than by scaling', () => {
    // Scaling the image to the crop would resample it; the oversized-image plus
    // clipPath technique keeps every retained pixel at its original resolution.
    const cropped = editDocument(doc, (draft) => {
      const image = Object.values(draft.nodes).find((n) => n.type === 'image')!;
      setImageCrop(draft, image.id, { x: 0.25, y: 0, width: 0.5, height: 1 });
    });
    const image = Object.values(cropped.nodes).find((n) => n.type === 'image')!;
    const svg = toSvgString(renderDocument(cropped, { theme: NATURE_THEME, resolveAsset }));

    expect(svg).toContain('clipPath');
    // Half the source spans the frame, so the image is drawn at twice its width.
    expect(svg).toContain(`width="${image.frame.width / 0.5}"`);
  });

  it('draws the scale bar at its calibrated length', () => {
    // Read from the scene, not from the helper, so this proves what is actually
    // drawn rather than re-checking the arithmetic against itself.
    const bar = collectByRole(scene, 'scale-bar')[0]!;
    expect(Number(bar.attrs?.width)).toBeCloseTo(1.0, 6);
  });

  it('rescales the drawn bar when its image is resized', () => {
    const halved = editDocument(doc, (draft) => {
      const image = Object.values(draft.nodes).find((n) => n.type === 'image')!;
      // Halving the image halves what a millimetre on it represents. A bar that
      // held its length here would silently misstate the scale.
      image.frame = { ...image.frame, width: image.frame.width / 2 };
    });
    const bar = collectByRole(
      renderDocument(halved, { theme: NATURE_THEME, resolveAsset }),
      'scale-bar',
    )[0]!;
    expect(Number(bar.attrs?.width)).toBeCloseTo(0.5, 6);
  });

  it('omits the label when labelPosition is none, whatever showLabel says', () => {
    const silent = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type !== 'scale-bar') continue;
        node.labelPosition = 'none';
        // Deliberately contradictory: labelPosition is the sole authority.
        node.showLabel = true;
      }
    });
    const scene = renderDocument(silent, { theme: NATURE_THEME, resolveAsset });
    expect(collectByRole(scene, 'scale-bar-label')).toEqual([]);
  });

  it('draws arrowheads as explicit geometry, never as markers', () => {
    // Markers scale with stroke-width and are flattened on import into vector
    // editors — the whole reason the head is a path.
    const svg = toSvgString(scene);
    expect(svg).not.toContain('<marker');
    expect(svg).not.toContain('marker-end');
  });

  it('gives a selected arrow one grip per point, separate from the resize grips', () => {
    const arrow = Object.values(doc.nodes).find((n) => n.type === 'arrow')!;
    const withChrome = renderDocument(doc, {
      theme: NATURE_THEME,
      resolveAsset,
      chrome: { selectedIds: [arrow.id] },
    });

    expect(collectByRole(withChrome, 'resize-handle').length).toBe(8);
    expect(collectByRole(withChrome, 'point-handle').length).toBe(
      arrow.type === 'arrow' ? arrow.points.length : 0,
    );
    // Chrome, so it must never reach an export.
    expect(collectByRole(scene, 'point-handle')).toEqual([]);
    expect(() => renderToStaticMarkup(toReact(withChrome))).not.toThrow();
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

  /**
   * The spec lists "editable text" as something to validate before export. In
   * this architecture it cannot fail at runtime — the renderer has no path that
   * outlines a glyph — so a quality *rule* for it would be a category that
   * always passes, which is worse than an absent one: it teaches an author to
   * trust a check that is not checking.
   *
   * This is the guard instead. It would catch the only way the claim could
   * actually be lost: a future mark family drawing its own labels as paths.
   */
  it('gives every text-bearing node exactly one <text>, and none of them empty', () => {
    const textNodes: { role?: string; text?: string }[] = [];
    walkScene(scene, (node) => {
      if (node.tag === 'text') textNodes.push({ role: node.role, text: node.text });
    });

    expect(textNodes.length).toBeGreaterThan(0);
    for (const node of textNodes) {
      // A <text> with nothing in it is a label that silently went missing.
      expect(node.text ?? '').not.toBe('');
    }

    // Every document node that carries text is represented, and once only.
    const documentText = Object.values(doc.nodes).filter(
      (n) => n.type === 'text' || n.type === 'panel-label',
    );
    for (const node of documentText) {
      const owned: string[] = [];
      walkWithOwner(scene, (element, ownerId) => {
        if (element.tag === 'text' && ownerId === node.id) owned.push(element.text ?? '');
      });
      expect(owned).toHaveLength(1);
    }
  });

  it('draws nothing with a path where a glyph belongs', () => {
    // Belt to the brace above: no <path> may carry text-ish attributes, which
    // is what a naive "convert text to outlines" change would produce.
    walkScene(scene, (node) => {
      if (node.tag !== 'path') return;
      expect(node.attrs?.['font-size']).toBeUndefined();
      expect(node.role).not.toBe('tick-label');
      expect(node.role).not.toBe('axis-title');
    });
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
