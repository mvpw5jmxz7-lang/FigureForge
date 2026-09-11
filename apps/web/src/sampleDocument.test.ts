import { describe, expect, it } from 'vitest';
import {
  buildArchiveContents,
  loadArchive,
  saveArchive,
  stableStringify,
  type BracketNode,
  type GroupLabelNode,
} from '@figureforge/doc-model';
import { checkFigure, renderDocument, toSvgString } from '@figureforge/render';
import { NATURE_THEME } from '@figureforge/theme';
import { sampleDocument } from './sampleDocument.js';
import { SAMPLE_MICROGRAPHS } from './sampleMicrographs.js';

function panelsInOrder(doc: ReturnType<typeof sampleDocument>) {
  return Object.values(doc.nodes)
    .filter((n) => n.type === 'panel')
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
}

function assetBytes(): Map<string, Uint8Array> {
  return new Map(
    SAMPLE_MICROGRAPHS.map((m) => {
      const binary = atob(m.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return [m.path, bytes];
    }),
  );
}

describe('the built-in sample figure', () => {
  it('has eight panels lettered a-h over eight plot/panel kinds', () => {
    const doc = sampleDocument();
    const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');
    expect(panels).toHaveLength(8);
    expect(
      panels
        .map((p) => (p.type === 'panel' ? p.label : ''))
        .sort()
        .join(''),
    ).toBe('abcdefgh');

    const plotTypes = Object.values(doc.nodes)
      .filter((n) => n.type === 'plot')
      .map((n) => (n.type === 'plot' ? n.plotType : ''))
      .sort();
    expect(plotTypes).toEqual(
      ['bar-dot', 'heatmap', 'line', 'scatter', 'survival', 'violin', 'volcano'].sort(),
    );
    // the eighth panel is an image montage: three tiles.
    expect(Object.values(doc.nodes).filter((n) => n.type === 'image')).toHaveLength(3);
  });

  it('carries four analyses, each with a stored result and a plot', () => {
    const doc = sampleDocument();
    expect(doc.analyses).toHaveLength(4);
    for (const analysis of doc.analyses) {
      expect(analysis.result).not.toBeNull();
      expect(analysis.plotId).toBeTruthy();
      expect(doc.nodes[analysis.plotId!]?.type).toBe('plot');
    }
  });

  it('renders and scores with no stale-analysis or other error-severity finding', () => {
    const doc = sampleDocument();
    const scene = renderDocument(doc, { theme: NATURE_THEME, resolveAsset: () => undefined });
    const report = checkFigure({ document: doc, theme: NATURE_THEME, scene, exportDpi: 300 });
    const errors = report.findings.filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);
    expect(report.score).toBeGreaterThanOrEqual(90);
  });

  it('places three brackets each on the ANOVA and Kruskal-Wallis panels, none on survival', () => {
    const doc = sampleDocument();
    const brackets = Object.values(doc.nodes).filter(
      (n): n is BracketNode => n.type === 'bracket',
    );
    expect(brackets).toHaveLength(6);
    for (const bracket of brackets) {
      expect(['*', '**', '***', '****']).toContain(bracket.label);
    }
    const survivalPlot = Object.values(doc.nodes).find(
      (n) => n.type === 'plot' && n.plotType === 'survival',
    );
    expect(brackets.some((b) => b.plotId === survivalPlot?.id)).toBe(false);
  });

  it('has the omics group title, a whole-figure heading top and left, and a caption per tile', () => {
    const doc = sampleDocument();
    const labels = Object.values(doc.nodes).filter(
      (n): n is GroupLabelNode => n.type === 'group-label',
    );
    const titles = labels.map((l) => l.title);
    expect(titles).toContain('Compound X proteomics');
    expect(titles).toContain('Compound X remodels the HEK293 proteome');
    expect(titles).toContain('Biological triplicate');
    // the tile captions
    for (const caption of ['MAP1LC3B', 'LAMP1', 'Merge']) expect(titles).toContain(caption);
    // one heading is rotated down the left edge
    expect(labels.some((l) => l.edge === 'left')).toBe(true);
    // a scale bar sits below its picture
    const bar = Object.values(doc.nodes).find((n) => n.type === 'scale-bar');
    expect(bar?.type === 'scale-bar' ? bar.placement : undefined).toBe('below');
  });

  it('gives panel b large hollow red markers and a callout with an arrow', () => {
    const doc = sampleDocument();
    const scatter = Object.values(doc.nodes).find(
      (n) => n.type === 'plot' && n.plotType === 'scatter',
    );
    expect(scatter?.type === 'plot' ? scatter.pointFill : undefined).toBe('none');
    expect(
      scatter?.type === 'plot' && scatter.pointStroke !== 'none'
        ? scatter.pointStroke?.color
        : undefined,
    ).toBe('#d62728');
    expect(scatter?.type === 'plot' ? scatter.pointSizeMm : 0).toBeGreaterThan(2);
    expect(Object.values(doc.nodes).some((n) => n.type === 'text')).toBe(true);
    expect(Object.values(doc.nodes).some((n) => n.type === 'arrow')).toBe(true);
  });

  it('labels eight features on the volcano panel', () => {
    const doc = sampleDocument();
    const volcano = Object.values(doc.nodes).find(
      (n) => n.type === 'plot' && n.plotType === 'volcano',
    );
    expect(volcano?.type === 'plot' ? volcano.volcanoLabels?.length : 0).toBe(8);
  });

  it('round-trips through save and reload unchanged', () => {
    const doc = sampleDocument();
    const archive = saveArchive(buildArchiveContents(doc, new Map(), assetBytes()));
    const loaded = loadArchive(archive);
    expect(stableStringify(loaded.document)).toBe(stableStringify(doc));
  });

  it('serialises to an SVG at the Nature double-column width', () => {
    const doc = sampleDocument();
    const scene = renderDocument(doc, { theme: NATURE_THEME, resolveAsset: () => undefined });
    const svg = toSvgString(scene, { xmlDeclaration: true });
    expect(svg).toContain('width="183mm"');
  });

  it('letters panels a-h in reading order', () => {
    const doc = sampleDocument();
    expect(panelsInOrder(doc).map((p) => (p.type === 'panel' ? p.label : ''))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
    ]);
  });
});
