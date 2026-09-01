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
  absoluteFrame,
  addArrow,
  addAsset,
  addPanelWithImage,
  addPanelWithPlot,
  addScaleBar,
  addShape,
  addText,
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
  type TextRun,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';
import { MAX_VECTOR_POINTS, planPointClouds, renderDocument } from './render-document.js';
import { toSvgString } from './svg-string.js';
import { toReact } from './react.js';
import { collectAttr, collectByRole, round, walkScene, walkWithOwner, type SceneNode } from './scene.js';
import { SUPERSCRIPT_MIN_PT } from './text-width.js';

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
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');

    expect(stripped).toBe(fromString);
  });

  it('marks axis titles as editable without changing a byte of the export', () => {
    /*
     * `editTarget` is scene *metadata*, like `role` and `nodeId` —
     * `toSvgString` serialises `attrs` alone. Putting it in `attrs` would have
     * changed every exported figure for a purely editorial concern, and the
     * whole-document parity assertion above would not have noticed: it strips
     * the React-only hooks from both sides before comparing.
     */
    const titled = editDocument(doc, (draft) => {
      for (const node of Object.values(draft.nodes)) {
        if (node.type !== 'plot') continue;
        node.x = { ...node.x, title: 'Dose (mg)' };
        node.y = { ...node.y, title: 'Response' };
      }
    });
    const titledScene = renderDocument(titled, { theme: NATURE_THEME });

    const marked: SceneNode[] = [];
    walkScene(titledScene, (n) => {
      if (n.editTarget) marked.push(n);
    });

    // Both titles on every plot, and each one names a field the canvas knows
    // how to open — a typo here is a double-click that silently does nothing.
    expect(marked.length).toBeGreaterThan(0);
    for (const node of marked) {
      expect(['x.title', 'y.title', 'y2.title', 'cascadeAxisTitle']).toContain(node.editTarget);
      expect(node.tag).toBe('text');
    }
    expect(marked.map((n) => n.editTarget)).toContain('x.title');
    expect(marked.map((n) => n.editTarget)).toContain('y.title');

    // The export carries none of it; React carries all of it.
    expect(toSvgString(titledScene)).not.toContain('data-edit-target');
    expect(renderToStaticMarkup(toReact(titledScene))).toContain('data-edit-target="x.title"');

    // Tick labels are deliberately not editable: they are computed from the
    // data, and an editable one would let a figure show a number its data does
    // not support.
    for (const label of collectByRole(titledScene, 'tick-label')) {
      expect(label.editTarget).toBeUndefined();
    }
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
      .replace(/ data-edit-target="[^"]*"/g, '')
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

  it('draws grab handles dark enough to see on the page', () => {
    // The page is white in both themes — it is paper — so a white handle with a
    // sub-pixel border was invisible exactly where it is needed. Dark fill,
    // light ring, which also survives a handle sitting on a dark micrograph.
    const selected = Object.values(doc.nodes).find((n) => n.type === 'panel')!.id;
    const handles = collectByRole(
      renderDocument(doc, { theme: NATURE_THEME, chrome: { selectedIds: [selected] } }),
      'resize-handle',
    );

    expect(handles).toHaveLength(8);
    for (const handle of handles) {
      expect(handle.attrs?.fill).toBe('#111318');
      expect(handle.attrs?.stroke).toBe('#ffffff');
    }
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
        .replace(/ data-edit-target="[^"]*"/g, '')
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

  it('draws bar/box/violin/dot marks through both adapters identically when horizontal', () => {
    // The orientation-gated path-string branch in the box/violin/error-bar
    // drawing code is exactly the kind of divergence risk this file exists to
    // catch — one adapter forgetting the branch would still "work" until
    // compared here.
    for (const plotType of ['bar-dot', 'box', 'violin', 'dot'] as const) {
      const doc = editDocument(makeDocument(), (draft) => {
        for (const node of Object.values(draft.nodes)) {
          if (node.type === 'plot') {
            node.plotType = plotType;
            node.orientation = 'horizontal';
          }
        }
      });
      const scene = renderDocument(doc, { theme: NATURE_THEME });

      const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
        .replace(/ data-role="[^"]*"/g, '')
        .replace(/ data-edit-target="[^"]*"/g, '')
        .replace(/ data-node-id="[^"]*"/g, '');
      expect(fromReact).toBe(normalise(toSvgString(scene)));
      expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
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
        .replace(/ data-edit-target="[^"]*"/g, '')
        .replace(/ data-node-id="[^"]*"/g, '');
      expect(fromReact).toBe(normalise(toSvgString(scene)));
      expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
    }
  });

  it('draws a superscripted axis label identically through both adapters', () => {
    // The one shape neither adapter had to handle before Feature 3: a <text>
    // that is a <tspan> container rather than a leaf, carrying the exponent
    // at a reduced size on its own <tspan>.
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited(
      'Dose,Response\n1,100\n2,1000\n3,10000\n4,100000',
    );

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-power10',
        name: 'Dose response',
        format: inferFormat(parsed.columns),
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/power10.csv',
        sourceFilename: 'power10.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Dose response',
        datasetId: dataset.id,
        plotType: 'scatter',
        xTitle: 'Dose (mg)',
        yTitle: 'Response',
      });
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') {
          node.y.scale = 'log10';
          node.y.labelFormat = 'power10';
        }
      }
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'tick-label-sup').length).toBeGreaterThan(0);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('renders a TextNode with richText absent byte-identically to before richText existed', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const withPlain = editDocument(base, (draft) => {
      addText(draft, newId, { frame: { x: 5, y: 5, width: 40, height: 10 }, text: 'plain text', fontSizePt: 9 });
    });
    const withEmptyRuns = editDocument(withPlain, (draft) => {
      const node = Object.values(draft.nodes).find((n) => n.type === 'text');
      if (node?.type === 'text') node.richText = [];
    });

    const plainScene = renderDocument(withPlain, { theme: NATURE_THEME });
    const emptyRunsScene = renderDocument(withEmptyRuns, { theme: NATURE_THEME });
    expect(normalise(toSvgString(emptyRunsScene))).toBe(normalise(toSvgString(plainScene)));

    const fromReact = normalise(renderToStaticMarkup(toReact(plainScene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(plainScene)));
  });

  it('draws a rich-text run list mixing bold, a superscript and a line break with the exact tspan/dy sequence', () => {
    const newId = createIdFactory();
    const base = createDocument({ widthMm: 183, heightMm: 75, idFactory: newId, now: () => '2026-01-01T00:00:00.000Z' });
    const doc = editDocument(base, (draft) => {
      const node = addText(draft, newId, { frame: { x: 5, y: 5, width: 60, height: 20 }, text: 'plain', fontSizePt: 10 });
      // A superscript run ends, then a plain run carries the line break —
      // the trickiest arithmetic in the round: the baseline must return
      // from the pending rise *before* the line-height step, not conflate
      // the two into one dy.
      const runs: TextRun[] = [
        { text: 'bold ' },
        { text: 'x', bold: true },
        { text: '2', script: 'sup' },
        { text: '\nnext line' },
      ];
      const target = draft.nodes[node.id];
      if (target?.type === 'text') target.richText = runs;
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    const textEl = collectByRole(scene, 'text')[0];
    expect(textEl?.tag).toBe('text');
    const tspans = textEl?.children ?? [];
    expect(tspans.map((t) => t.text)).toEqual(['bold ', 'x', '2', '', 'next line']);
    expect(tspans.map((t) => t.attrs?.['font-weight'])).toEqual(['normal', 'bold', 'normal', 'normal', 'normal']);
    expect(tspans[2]?.role).toBe('text-sup');

    // "bold "/"x": no rise pending yet, no dy.
    expect(tspans[0]?.attrs?.dy).toBeUndefined();
    expect(tspans[1]?.attrs?.dy).toBeUndefined();
    // "2": rises by the script offset.
    const riseMm = tspans[2]?.attrs?.dy as number;
    expect(typeof riseMm).toBe('number');
    expect(riseMm).toBeLessThan(0);
    // The empty tspan ending the sup run returns exactly that rise, before
    // any line-height step — it is still on the same line.
    expect(tspans[3]?.attrs?.dy).toBeCloseTo(-riseMm, 6);
    expect(tspans[3]?.attrs?.x).toBeUndefined();
    // "next line" starts the new line at a clean line-height step, with no
    // leftover rise carried into it.
    const lineHeightMm = 10 * (25.4 / 72) * 1.2;
    expect(tspans[4]?.attrs?.dy).toBeCloseTo(lineHeightMm, 6);
    expect(tspans[4]?.attrs?.x).toBeDefined();

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
  });

  it('draws a range-clipped line plot identically through both adapters, with the out-of-range point dropped', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Dose,Response\n1,2.1\n2,3.9\n3,6.2\n4,7.8\n5,10.1\n6,12.4');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-clipped',
        name: 'Dose response',
        format: inferFormat(parsed.columns),
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/clipped.csv',
        sourceFilename: 'clipped.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Dose response',
        datasetId: dataset.id,
        plotType: 'line',
      });
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') {
          node.x.max = 4;
          node.x.clipToRange = true;
        }
      }
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    // Doses 5 and 6 fall past max=4 and are dropped, leaving four.
    expect(collectByRole(scene, 'point')).toHaveLength(4);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
  });

  it('draws a symlog axis identically through both adapters, negative values and all', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Dose,Response\n1,-500\n2,0\n3,87000\n4,150000');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-symlog',
        name: 'Dose response',
        format: inferFormat(parsed.columns),
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/symlog.csv',
        sourceFilename: 'symlog.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Dose response',
        datasetId: dataset.id,
        plotType: 'scatter',
        xTitle: 'Dose (mg)',
        yTitle: 'Response',
      });
      for (const node of Object.values(draft.nodes)) {
        if (node.type === 'plot') {
          node.y.scale = 'symlog';
          node.y.labelFormat = 'power10';
        }
      }
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    // Every row drawn, including the negative one — the property a log10 axis
    // could not have offered at all.
    expect(collectByRole(scene, 'point')).toHaveLength(4);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('rasterizes a scatter or line plot above MAX_VECTOR_POINTS instead of drawing every point', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const rows = Array.from(
      { length: MAX_VECTOR_POINTS + 500 },
      (_, i) => `${i},${Math.sin(i)}`,
    );
    const parsed = parseDelimited(`X,Y\n${rows.join('\n')}`);

    for (const plotType of ['scatter', 'line'] as const) {
      const doc = editDocument(base, (draft) => {
        const dataset: Dataset = {
          id: 'ds-cloud',
          name: 'Cloud',
          format: inferFormat(parsed.columns),
          columns: parsed.columns,
          rows: parsed.rows,
          sourcePath: 'data/cloud.csv',
          sourceFilename: 'cloud.csv',
          importedAt: '2026-01-01T00:00:00.000Z',
        };
        draft.datasets = [dataset];
        addPanelWithPlot(draft, newId, {
          frame: { x: 2, y: 2, width: 80, height: 60 },
          name: 'Cloud',
          datasetId: dataset.id,
          plotType,
          xTitle: 'X',
          yTitle: 'Y',
        });
      });

      // No raster supplied: the pending placeholder stands in, identically in
      // both adapters — the state a real load briefly passes through needs the
      // same parity guarantee as everything else.
      const pending = renderDocument(doc, { theme: NATURE_THEME });
      expect(collectByRole(pending, 'point-cloud').length).toBe(1);
      expect(collectByRole(pending, 'point')).toEqual([]);
      const pendingFromReact = normalise(renderToStaticMarkup(toReact(pending)))
        .replace(/ data-role="[^"]*"/g, '')
        .replace(/ data-edit-target="[^"]*"/g, '')
        .replace(/ data-node-id="[^"]*"/g, '');
      expect(pendingFromReact).toBe(normalise(toSvgString(pending)));

      // A raster supplied: one <image>, still exactly one 'point-cloud' node,
      // still zero per-point marks, identically in both adapters.
      const plotNode = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
      const baked = renderDocument(doc, {
        theme: NATURE_THEME,
        pointRasters: new Map([[plotNode.id, 'data:image/png;base64,AAAA']]),
      });
      expect(collectByRole(baked, 'point-cloud').length).toBe(1);
      expect(collectByRole(baked, 'point')).toEqual([]);
      expect(collectAttr(baked, 'href')).toEqual(['data:image/png;base64,AAAA']);
      const bakedFromReact = normalise(renderToStaticMarkup(toReact(baked)))
        .replace(/ data-role="[^"]*"/g, '')
        .replace(/ data-edit-target="[^"]*"/g, '')
        .replace(/ data-node-id="[^"]*"/g, '');
      expect(bakedFromReact).toBe(normalise(toSvgString(baked)));

      // 'line' keeps its batched connecting path regardless — only the
      // per-point markers collapse.
      if (plotType === 'line') expect(collectByRole(baked, 'line').length).toBe(1);
    }
  });

  it('draws a volcano plot identically through both adapters, coloured and labelled per point', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Gene,log2FC,p\nTP53,2.5,0.001\nMYC,-3.0,0.0005\nEGFR,0.1,0.8');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-volcano',
        name: 'Differential expression',
        format: 'differential',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/volcano.csv',
        sourceFilename: 'volcano.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Volcano',
        datasetId: dataset.id,
        plotType: 'volcano',
      });
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    const points = collectByRole(scene, 'point');
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.children?.find((c) => c.tag === 'title')?.text).sort()).toEqual([
      'EGFR',
      'MYC',
      'TP53',
    ]);
    // Not every point shares a colour — up, down and not-significant all
    // appear in this fixture, which is what would silently collapse to one
    // colour if a future change dropped the per-point resolution.
    expect(new Set(points.map((p) => p.attrs?.['fill'])).size).toBeGreaterThan(1);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
  });

  it('rasterizes a volcano plot above MAX_VECTOR_POINTS with per-point colour surviving the bake', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    // Alternating sign and p-value spread guarantees up, down and
    // not-significant all appear well past the threshold.
    const rows = Array.from({ length: MAX_VECTOR_POINTS + 500 }, (_, i) => {
      const fc = i % 2 === 0 ? 2 + i * 0.001 : -2 - i * 0.001;
      const p = i % 3 === 0 ? 0.5 : 0.0001;
      return `G${i},${fc},${p}`;
    });
    const parsed = parseDelimited(`Gene,log2FC,p\n${rows.join('\n')}`);

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-volcano-cloud',
        name: 'Differential expression',
        format: 'differential',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/volcano-cloud.csv',
        sourceFilename: 'volcano-cloud.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Volcano cloud',
        datasetId: dataset.id,
        plotType: 'volcano',
      });
    });

    const plotNode = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
    const plans = planPointClouds(doc, NATURE_THEME);
    expect(plans).toHaveLength(1);
    // The regression case: if per-point colour resolution ever stopped
    // reaching the raster path, every point would silently share one colour.
    const colors = new Set(plans[0]!.series[0]!.points.map((p) => p.color));
    expect(colors.size).toBeGreaterThan(1);

    const baked = renderDocument(doc, {
      theme: NATURE_THEME,
      pointRasters: new Map([[plotNode.id, 'data:image/png;base64,AAAA']]),
    });
    expect(collectByRole(baked, 'point-cloud').length).toBe(1);
    expect(collectByRole(baked, 'point')).toEqual([]);
    const bakedFromReact = normalise(renderToStaticMarkup(toReact(baked)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(bakedFromReact).toBe(normalise(toSvgString(baked)));
  });

  it('draws a labelled volcano plot identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Gene,log2FC,p\nTP53,2.5,0.001\nMYC,-3.0,0.0005\nEGFR,0.1,0.8');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-volcano-labelled',
        name: 'Differential expression',
        format: 'differential',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/volcano-labelled.csv',
        sourceFilename: 'volcano-labelled.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Volcano',
        datasetId: dataset.id,
        plotType: 'volcano',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') node.volcanoLabels = ['TP53', 'MYC'];
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'point-label')).toHaveLength(2);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('draws a manually-offset, custom-sized volcano label identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Gene,log2FC,p\nTP53,2.5,0.001\nMYC,-3.0,0.0005\nEGFR,0.1,0.8');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-volcano-offset',
        name: 'Differential expression',
        format: 'differential',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/volcano-offset.csv',
        sourceFilename: 'volcano-offset.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Volcano',
        datasetId: dataset.id,
        plotType: 'volcano',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') {
        node.volcanoLabels = ['TP53', 'MYC'];
        node.pointLabelOffsets = { TP53: { x: 8, y: -4 } };
        node.pointLabelSizePt = 7;
      }
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'point-label')).toHaveLength(2);
    expect(collectByRole(scene, 'point-label-leader')).toHaveLength(1); // only the offset one

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
  });

  it('draws point labels over a rasterized point cloud above MAX_VECTOR_POINTS, identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const rows = Array.from({ length: MAX_VECTOR_POINTS + 500 }, (_, i) => {
      const fc = i % 2 === 0 ? 2 + i * 0.001 : -2 - i * 0.001;
      const p = i % 3 === 0 ? 0.5 : 0.0001;
      return `G${i},${fc},${p}`;
    });
    const parsed = parseDelimited(`Gene,log2FC,p\n${rows.join('\n')}`);

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-volcano-cloud-labelled',
        name: 'Differential expression',
        format: 'differential',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/volcano-cloud-labelled.csv',
        sourceFilename: 'volcano-cloud-labelled.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Volcano cloud',
        datasetId: dataset.id,
        plotType: 'volcano',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') node.volcanoLabels = ['G0', 'G1', 'G2'];
    });

    const plotNode = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
    const baked = renderDocument(doc, {
      theme: NATURE_THEME,
      pointRasters: new Map([[plotNode.id, 'data:image/png;base64,AAAA']]),
    });
    // One raster standing in for every marker, plus the three labels drawn
    // as ordinary vector text over it — the case a real gene list needs,
    // since it is routinely well past this threshold.
    expect(collectByRole(baked, 'point-cloud')).toHaveLength(1);
    expect(collectByRole(baked, 'point')).toEqual([]);
    expect(collectByRole(baked, 'point-label')).toHaveLength(3);

    const bakedFromReact = normalise(renderToStaticMarkup(toReact(baked)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(bakedFromReact).toBe(normalise(toSvgString(baked)));
    expect(() => renderToStaticMarkup(toReact(baked))).not.toThrow();
  });

  it('draws a heatmap identically through both adapters, cells and colourbar alike', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Gene,S1,S2,S3\nTP53,0,5,10\nMYC,10,5,0');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-heatmap',
        name: 'Matrix',
        format: 'matrix',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/matrix.csv',
        sourceFilename: 'matrix.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Heatmap',
        datasetId: dataset.id,
        plotType: 'heatmap',
      });
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'heatmap-cell')).toHaveLength(6);
    expect(collectByRole(scene, 'colorbar').length).toBeGreaterThan(1);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('gives a missing heatmap cell the same "no data" colour in both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Gene,S1,S2\nTP53,1,\nMYC,2,3');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-heatmap-missing',
        name: 'Matrix',
        format: 'matrix',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/matrix-missing.csv',
        sourceFilename: 'matrix-missing.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Heatmap',
        datasetId: dataset.id,
        plotType: 'heatmap',
      });
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    const fills = collectByRole(scene, 'heatmap-cell').map((c) => c.attrs?.['fill']);
    expect(fills).toContain('#e0e0e0');

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
  });

  it('draws a survival curve identically through both adapters, censoring ticks and all', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Time,Event,Arm\n5,1,A\n8,0,B\n12,1,A\n3,1,B');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-survival',
        name: 'Cohort',
        format: 'survival',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/survival.csv',
        sourceFilename: 'survival.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Survival',
        datasetId: dataset.id,
        plotType: 'survival',
      });
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'line')).toHaveLength(2); // one arm each
    expect(collectByRole(scene, 'censor-mark')).toHaveLength(1); // arm B's t=8

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('draws a survival confidence band identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Time,Event\n1,1\n2,1\n2,0\n3,1\n5,1');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-survival-ci',
        name: 'Cohort',
        format: 'survival',
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/survival-ci.csv',
        sourceFilename: 'survival-ci.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Survival',
        datasetId: dataset.id,
        plotType: 'survival',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') node.showSurvivalCI = true;
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'error-bar')).toHaveLength(1); // one polygon, not per-point whiskers

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
  });

  it('leaves a plot at or under MAX_VECTOR_POINTS on the ordinary vector path', () => {
    // Regression guard: the continuous-types fixture above already proves
    // this at five rows; this pins it explicitly against the boundary the
    // new branch actually tests, so a future change to that threshold cannot
    // silently start rasterising an ordinary small figure.
    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'point-cloud')).toEqual([]);
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

  it('draws a cascaded line plot with a fill identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited(
      ['X1\tY1\tX2\tY2\tX3\tY3', '1\t2\t1\t2\t1\t2', '2\t4\t2\t4\t2\t4', '3\t6\t3\t6\t3\t6'].join(
        '\n',
      ),
    );

    const cascadeDoc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-cascade',
        name: 'Cascade',
        format: inferFormat(parsed.columns),
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/cascade.csv',
        sourceFilename: 'cascade.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Cascade',
        datasetId: dataset.id,
        plotType: 'line',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') {
        node.offsetStepMm = 10;
        node.offsetFill = 'tint';
      }
    });

    const scene = renderDocument(cascadeDoc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'area')).toHaveLength(3);
    expect(collectByRole(scene, 'line')).toHaveLength(3);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('draws a cascade depth axis with a captioned group identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited(
      ['X1\tY1\tX2\tY2\tX3\tY3', '1\t2\t1\t2\t1\t2', '2\t4\t2\t4\t2\t4', '3\t6\t3\t6\t3\t6'].join(
        '\n',
      ),
    );

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-cascade-axis',
        name: 'Cascade',
        format: inferFormat(parsed.columns),
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/cascade-axis.csv',
        sourceFilename: 'cascade-axis.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Cascade',
        datasetId: dataset.id,
        plotType: 'line',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') {
        node.offsetStepMm = 10;
        node.offsetStepXMm = 2;
        node.showCascadeAxis = true;
        node.cascadeAxisTitle = 'Concentration (mg/mL)';
      }
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'cascade-axis-label')).toHaveLength(3);
    expect(collectByRole(scene, 'cascade-axis-title')).toHaveLength(1);
    expect(collectByRole(scene, 'cascade-axis').length).toBeGreaterThan(0);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('draws a boxed plot border identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Dose,Response\n1,2.1\n2,3.9\n3,6.2\n4,7.8');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-boxed',
        name: 'Boxed',
        format: inferFormat(parsed.columns),
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/boxed.csv',
        sourceFilename: 'boxed.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Boxed',
        datasetId: dataset.id,
        plotType: 'scatter',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') node.boxed = true;
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    // Two ordinary lines (left, bottom) plus the two `boxed` lines (top, right).
    expect(collectByRole(scene, 'axis').filter((n) => n.tag === 'path')).toHaveLength(4);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('draws ordinary gridlines identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited('Dose,Response\n1,2.1\n2,3.9\n3,6.2\n4,7.8');

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-gridlines',
        name: 'Gridlines',
        format: inferFormat(parsed.columns),
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/gridlines.csv',
        sourceFilename: 'gridlines.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Gridlines',
        datasetId: dataset.id,
        plotType: 'scatter',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') node.showGridlines = true;
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    expect(collectByRole(scene, 'gridline').length).toBeGreaterThan(0);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
  });

  it('draws diagonal cascade gridlines identically through both adapters', () => {
    const newId = createIdFactory();
    const base = createDocument({
      widthMm: 183,
      heightMm: 75,
      idFactory: newId,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const parsed = parseDelimited(
      ['X1\tY1\tX2\tY2', '1\t2\t1\t3', '2\t4\t2\t5', '3\t6\t3\t7'].join('\n'),
    );

    const doc = editDocument(base, (draft) => {
      const dataset: Dataset = {
        id: 'ds-cascade-gridlines',
        name: 'Cascade gridlines',
        format: inferFormat(parsed.columns),
        columns: parsed.columns,
        rows: parsed.rows,
        sourcePath: 'data/cascade-gridlines.csv',
        sourceFilename: 'cascade-gridlines.csv',
        importedAt: '2026-01-01T00:00:00.000Z',
      };
      draft.datasets = [dataset];
      const { plot } = addPanelWithPlot(draft, newId, {
        frame: { x: 2, y: 2, width: 80, height: 60 },
        name: 'Cascade gridlines',
        datasetId: dataset.id,
        plotType: 'line',
      });
      const node = draft.nodes[plot.id];
      if (node?.type === 'plot') {
        node.offsetStepMm = 10;
        node.showGridlines = true;
      }
    });

    const scene = renderDocument(doc, { theme: NATURE_THEME });
    // One diagonal gridline per y tick and per x tick — density follows the
    // axis, not the two series — and every one of them is dashed, since a
    // cascade's reference lines recede into the back plane rather than
    // sitting flat on the tick.
    const gridlines = collectByRole(scene, 'gridline');
    expect(gridlines.length).toBeGreaterThan(2);
    for (const g of gridlines) {
      expect(g.attrs?.['stroke-dasharray']).toBe('1.5 1');
    }
    // A second copy of the x and y axes standing on that back plane, with
    // their own tick marks — so more than the two lines alone. The exact
    // coordinates are pinned in `gridlines.test.ts`; what matters here is that
    // the nodes exist in both adapters and neither throws on them.
    expect(collectByRole(scene, 'cascade-back-axis').length).toBeGreaterThan(2);

    const fromReact = normalise(renderToStaticMarkup(toReact(scene)))
      .replace(/ data-role="[^"]*"/g, '')
      .replace(/ data-edit-target="[^"]*"/g, '')
      .replace(/ data-node-id="[^"]*"/g, '');
    expect(fromReact).toBe(normalise(toSvgString(scene)));
    expect(() => renderToStaticMarkup(toReact(scene))).not.toThrow();
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
      .replace(/ data-edit-target="[^"]*"/g, '')
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
    const svg = toSvgString(renderDocument(cropped, { theme: NATURE_THEME, resolveAsset }));

    expect(svg).toContain('clipPath');
    // No `scale`, no resampled raster: the source is placed and then clipped.
    expect(svg).not.toContain('scale(');
  });

  it('shows the region that was cropped, and only that region', () => {
    /*
     * The crop halves the width of an aspect-locked 50 × 40 image, so what is
     * kept is 25 × 40 and it is centred — an aspect-preserving image cannot
     * fill a frame of a different shape without stretching, and stretching a
     * micrograph misstates every distance measured on it.
     *
     * This is the case `preserveAspectRatio="xMidYMid meet"` used to get wrong.
     * It centres inside the *element box*, which for a crop is the oversized
     * one, so `meet` undid the offset exactly and the whole picture was drawn:
     * cropping to half the width changed nothing on the page. The same
     * arithmetic put every montage-tile crop somewhere other than its outline.
     */
    const cropped = editDocument(doc, (draft) => {
      const image = Object.values(draft.nodes).find((n) => n.type === 'image')!;
      setImageCrop(draft, image.id, { x: 0.25, y: 0, width: 0.5, height: 1 });
    });
    const svg = toSvgString(renderDocument(cropped, { theme: NATURE_THEME, resolveAsset }));

    expect(svg).toContain('<rect x="12.5" y="0" width="25" height="40"/>');
    // The source is drawn at frame size and read through that window, so the
    // visible pixels are source x ∈ [0.25, 0.75] — the outlined half.
    expect(svg).toContain('x="0" y="0" width="50" height="40" preserveAspectRatio="none"');
  });

  it('crops a montage tile where the outline is, not where the tile is', () => {
    /*
     * The reported case. A montage panel sets `aspectLock: null` on purpose —
     * several differently shaped micrographs have no one honest ratio — so a
     * tile's frame comes from `gridCells` and its shape has nothing to do with
     * the picture in it. That is the configuration in which the old centring
     * was always wrong, and it is why cropping "didn't crop where the boundary
     * is set" for several images in one panel and looked fine for one.
     *
     * Square tile, 1000 × 800 source, bottom-right quadrant kept.
     */
    const montage = editDocument(doc, (draft) => {
      const image = Object.values(draft.nodes).find((n) => n.type === 'image')!;
      image.frame = { x: 0, y: 0, width: 40, height: 40 };
      setImageCrop(draft, image.id, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    });
    const svg = toSvgString(renderDocument(montage, { theme: NATURE_THEME, resolveAsset }));

    // 1.25 fitted into a square letterboxes to 40 × 32, 4 mm down.
    expect(svg).toContain('<rect x="0" y="4" width="40" height="32"/>');
    // Drawn at 2× so the kept quadrant fills that window: source (0.5, 0.5)
    // lands at (0, 4) — the window's own corner. `meet` used to put it at
    // (0, 0), a quarter of the tile out of place, with the discarded half of
    // the micrograph still on the page beside it.
    expect(svg).toContain('x="-40" y="-28" width="80" height="64"');
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

  it('offers a rotate grip on an annotation, and never on a panel', () => {
    const arrow = Object.values(doc.nodes).find((n) => n.type === 'arrow')!;
    const panel = Object.values(doc.nodes).find((n) => n.type === 'panel')!;

    const onArrow = renderDocument(doc, {
      theme: NATURE_THEME,
      resolveAsset,
      chrome: { selectedIds: [arrow.id] },
    });
    // Exactly one, and it does not disturb either existing handle count — the
    // whole reason 'rotate-handle' is a role of its own.
    expect(collectByRole(onArrow, 'rotate-handle').length).toBe(1);
    expect(collectByRole(onArrow, 'resize-handle').length).toBe(8);

    /*
     * Withheld on containers. `absoluteFrame` ignores rotation, so a rotated
     * panel would misplace every child's chrome, the crop overlay and the
     * layout engine's own idea of where it is. Keeping the grip off containers
     * is what guarantees no rotated node ever has a descendant.
     */
    const onPanel = renderDocument(doc, {
      theme: NATURE_THEME,
      resolveAsset,
      chrome: { selectedIds: [panel.id] },
    });
    expect(collectByRole(onPanel, 'rotate-handle')).toEqual([]);
    expect(collectByRole(onPanel, 'resize-handle').length).toBe(8);

    // Chrome, so it must never reach an export.
    expect(collectByRole(scene, 'rotate-handle')).toEqual([]);
    expect(() => renderToStaticMarkup(toReact(onArrow))).not.toThrow();
  });

  it("turns a rotated node's chrome with it, about the same centre the node uses", () => {
    /*
     * The failure this exists to catch: the outline and all nine grips staying
     * axis-aligned while the shape under them turns, so the grip the author
     * grabs is not the one they are pointing at.
     */
    const shape = Object.values(doc.nodes).find((n) => n.type === 'shape');
    const target = shape ?? Object.values(doc.nodes).find((n) => n.type === 'arrow')!;
    const turned = editDocument(doc, (draft) => {
      draft.nodes[target.id]!.rotation = 30;
    });

    const withChrome = renderDocument(turned, {
      theme: NATURE_THEME,
      resolveAsset,
      chrome: { selectedIds: [target.id] },
    });

    const handle = collectByRole(withChrome, 'rotate-handle')[0];
    expect(handle).toBeDefined();

    // The grips are written in the node's own coordinates and turned once by a
    // wrapping group, so the transform is what proves they follow the node.
    const svg = toSvgString(withChrome);
    const frame = absoluteFrame(turned.nodes, target.id)!;
    expect(svg).toContain(
      `rotate(30 ${round(frame.x + frame.width / 2)} ${round(frame.y + frame.height / 2)})`,
    );

    // An unrotated selection emits no such wrapper at all, so nothing about
    // today's chrome moved.
    const flat = toSvgString(
      renderDocument(doc, {
        theme: NATURE_THEME,
        resolveAsset,
        chrome: { selectedIds: [target.id] },
      }),
    );
    expect(flat).not.toContain('rotate(30');
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
    const sized: { role?: string; pt: number }[] = [];
    walkScene(scene, (node) => {
      const raw = node.attrs?.['font-size'];
      if (typeof raw === 'number') sized.push({ role: node.role, pt: raw / MM_PER_PT });
    });
    expect(sized.length).toBeGreaterThan(0);

    for (const { role, pt } of sized) {
      /*
       * A tick label's superscript exponent is deliberately set below the
       * journal's reading-text floor — the same way a footnote mark is
       * smaller than the sentence it marks — so it is held to its own floor
       * rather than `minimumPt`. `checkTextSize` in quality.ts makes the
       * identical exemption for the identical reason.
       */
      const isSuperscript = role === 'tick-label-sup' || role === 'text-sup' || role === 'text-sub';
      const floor = isSuperscript ? SUPERSCRIPT_MIN_PT : NATURE_THEME.type.minimumPt;
      expect(pt).toBeGreaterThanOrEqual(floor - 0.01);
      if (!isSuperscript) {
        expect(pt).toBeLessThanOrEqual(NATURE_THEME.type.panelLabelPt + 0.01);
      }
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
    const textNodes: { role?: string; text?: string; hasChildText: boolean }[] = [];
    walkScene(scene, (node) => {
      if (node.tag !== 'text') return;
      textNodes.push({
        role: node.role,
        text: node.text,
        hasChildText: (node.children ?? []).some((child) => (child.text ?? '') !== ''),
      });
    });

    expect(textNodes.length).toBeGreaterThan(0);
    for (const node of textNodes) {
      /*
       * A <text> with nothing in it anywhere is a label that silently went
       * missing. A <text> that is instead a <tspan> *container* — multi-line
       * text (`renderText`), or a superscripted tick label — has no text of
       * its own by construction; the content lives on its tspan children, and
       * that is what this assertion actually means to require.
       */
      expect((node.text ?? '') !== '' || node.hasChildText).toBe(true);
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
