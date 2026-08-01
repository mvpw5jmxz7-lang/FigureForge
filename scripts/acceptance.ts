/**
 * Phase 2 acceptance flow, run end to end without the UI.
 *
 *   CSV in → bar+dot plot with mean ± s.e.m. → Welch's t-test → significance
 *   bracket → two panels on Nature double-column → panel letters → export PDF
 *   with selectable text and a 300 dpi PNG → publication readiness score.
 *
 * Driving the model directly rather than through the interface is the point:
 * the app, the tests and this script all go through the same operations, so a
 * pass here means the pipeline itself works, not that a button is wired up.
 *
 * Run:  make acceptance
 */

import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import {
  addBracket,
  addPanelWithPlot,
  applyAutoLayout,
  buildArchiveContents,
  createDocument,
  createIdFactory,
  editDocument,
  hashInputs,
  inferFormat,
  loadArchive,
  parseDelimited,
  relabelPanels,
  saveArchive,
  stableStringify,
  toSeries,
  type Analysis,
  type Dataset,
  type FigureDocument,
  type StatResult,
} from '@figureforge/doc-model';
import { checkFigure, measurePlot, renderDocument, toSvgString } from '@figureforge/render';
import { NATURE_THEME } from '@figureforge/theme';

const API = process.env['API_URL'] ?? 'http://localhost:8000';
const OUT = new URL('../out/', import.meta.url).pathname;

const VIABILITY = `Treatment,Rep1,Rep2,Rep3,Rep4
Vehicle,98.2,95.4,101.3,97.8
Compound X,42.1,38.7,45.3,40.2`;

const EXPRESSION = `Genotype,Rep1,Rep2,Rep3
WT,1.02,0.98,1.00
KO,2.41,2.68,2.55`;

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  const mark = condition ? '  ok  ' : ' FAIL ';
  console.log(`[${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures++;
}

function makeDataset(text: string, name: string, id: string): Dataset {
  const parsed = parseDelimited(text);
  return {
    id,
    name,
    format: inferFormat(parsed.columns),
    columns: parsed.columns,
    rows: parsed.rows,
    sourcePath: `data/${id}.csv`,
    sourceFilename: `${name}.csv`,
    importedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const newId = createIdFactory();

  // -- 1. Import -----------------------------------------------------------
  console.log('\n1. Import');

  const viability = makeDataset(VIABILITY, 'Cell viability', newId());
  const expression = makeDataset(EXPRESSION, 'Target expression', newId());

  check('replicate layout detected', viability.format === 'replicate', viability.format);

  const series = toSeries(viability);
  check('two groups extracted', series.length === 2);
  check('four replicates each', series.every((s) => s.values.length === 4));

  // -- 2. Build the figure -------------------------------------------------
  console.log('\n2. Figure assembly');

  let doc: FigureDocument = createDocument({
    title: 'Compound X reduces viability',
    presetId: 'nature-double',
    widthMm: 183,
    heightMm: 75,
    idFactory: newId,
  });

  doc = editDocument(doc, (draft) => {
    draft.datasets = [viability, expression];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Viability',
      datasetId: viability.id,
      plotType: 'bar-dot',
      yTitle: 'Cell viability (%)',
    });
    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Expression',
      datasetId: expression.id,
      plotType: 'bar-dot',
      yTitle: 'Relative expression',
    });

    applyAutoLayout(draft, {
      marginMm: NATURE_THEME.spacing.marginMm,
      gutterMm: NATURE_THEME.spacing.panelGutterMm,
      labelGutterMm: 4,
    });
    relabelPanels(draft, newId, { fontSizePt: NATURE_THEME.type.panelLabelPt, offsetMm: 4 });
  });

  const panels = Object.values(doc.nodes).filter((n) => n.type === 'panel');
  const labels = Object.values(doc.nodes).filter((n) => n.type === 'panel-label');

  check('two panels laid out', panels.length === 2);
  check('panels lettered a, b', labels.map((l) => ('text' in l ? l.text : '')).sort().join('') === 'ab');
  check('page is Nature double-column', doc.page.widthMm === 183, `${doc.page.widthMm} mm`);

  // The visible gap is the theme gutter plus the inset reserved for the next
  // panel's letter, so labels never collide with the neighbouring axis.
  const gutter = panels[1]!.frame.x - (panels[0]!.frame.x + panels[0]!.frame.width);
  const expectedGutter = NATURE_THEME.spacing.panelGutterMm + 4;
  check('gutter matches theme + label inset', Math.abs(gutter - expectedGutter) < 0.01,
    `${gutter.toFixed(2)} mm`);

  // -- 3. Statistics -------------------------------------------------------
  console.log('\n3. Statistics');

  const response = await fetch(`${API}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      test: 'ttest-welch',
      groups: series.map((s) => ({ name: s.name, values: s.values })),
      correction: 'none',
    }),
  });

  check('analysis service responded', response.ok, `HTTP ${response.status}`);
  const result = (await response.json()) as StatResult;

  const comparison = result.comparisons[0]!;
  check('p-value is significant', comparison.pAdjusted < 0.001,
    `P = ${comparison.pAdjusted.toExponential(2)}`);
  check('effect size reported', comparison.effectSize !== null,
    `${comparison.effectSizeName} = ${comparison.effectSize?.toFixed(2)}`);
  check('confidence interval reported', comparison.ci !== null,
    comparison.ci ? `[${comparison.ci[0].toFixed(1)}, ${comparison.ci[1].toFixed(1)}]` : '');
  check('methods sentence generated', result.methodsSentence.includes("Welch's t-test"));

  const plot = Object.values(doc.nodes).find((n) => n.type === 'plot')!;
  const analysis: Analysis = {
    id: newId(),
    name: 'Welch t-test',
    test: 'ttest-welch',
    spec: { datasetId: viability.id, groups: series.map((s) => s.name) },
    options: { alternative: 'two-sided', correction: 'none', alpha: 0.05, welch: true },
    inputHash: hashInputs({ test: 'ttest-welch' }, series.map((s) => s.values)),
    result,
    computedAt: new Date().toISOString(),
  };

  // Positions come from the renderer's own band scale, so the bracket ends sit
  // exactly over the bars they refer to.
  const measurements = measurePlot(doc, plot, NATURE_THEME) ?? undefined;

  doc = editDocument(doc, (draft) => {
    draft.analyses = [analysis];
    addBracket(draft, newId, { plotId: plot.id, analysis, gapMm: 2, measurements });
  });

  const bracket = Object.values(doc.nodes).find((n) => n.type === 'bracket');
  check('bracket added to the figure', bracket !== undefined);
  check('bracket shows the right annotation',
    bracket && 'label' in bracket ? bracket.label === '****' : false,
    bracket && 'label' in bracket ? bracket.label : '');

  console.log(`\n   ${result.methodsSentence}\n`);

  // -- 4. Render -----------------------------------------------------------
  console.log('4. Render');

  const scene = renderDocument(doc, { theme: NATURE_THEME });
  const svg = toSvgString(scene, { xmlDeclaration: true });

  check('SVG declares millimetre dimensions', svg.includes('width="183mm"'));
  check('one user unit is one millimetre', svg.includes('viewBox="0 0 183 75"'));
  check('axis title present as real text', svg.includes('Cell viability (%)'));
  writeFileSync(`${OUT}figure.svg`, svg);

  // -- 5. Quality ----------------------------------------------------------
  console.log('\n5. Quality check');

  const report = checkFigure({ document: doc, theme: NATURE_THEME, scene, exportDpi: 300 });
  console.log(`   Publication Readiness Score: ${report.score}/100`);
  for (const finding of report.findings) {
    console.log(`   [${finding.severity}] ${finding.title}`);
  }
  check('no blocking errors', report.findings.every((f) => f.severity !== 'error'));

  // -- 6. Export -----------------------------------------------------------
  console.log('\n6. Export');

  for (const format of ['pdf', 'png', 'eps'] as const) {
    const exported = await fetch(`${API}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        svg,
        widthMm: doc.page.widthMm,
        heightMm: doc.page.heightMm,
        format,
        dpi: 300,
      }),
    });

    check(`${format.toUpperCase()} export succeeded`, exported.ok, `HTTP ${exported.status}`);
    if (!exported.ok) continue;

    const bytes = new Uint8Array(await exported.arrayBuffer());
    writeFileSync(`${OUT}figure.${format}`, bytes);
    check(`${format.toUpperCase()} is non-trivial`, bytes.length > 1000,
      `${(bytes.length / 1024).toFixed(0)} KB`);
  }

  // -- 7. Project round-trip ----------------------------------------------
  console.log('\n7. Project file');

  const archive = saveArchive(
    buildArchiveContents(doc, new Map([[`data/${viability.id}.csv`, VIABILITY]])),
  );
  writeFileSync(`${OUT}figure.figureforge`, archive);

  const reopened = loadArchive(archive);
  // Compared with sorted keys: validation rebuilds objects in schema order, so
  // plain JSON.stringify would report a difference that does not exist.
  check('document survives a save/load round-trip',
    stableStringify(reopened.document) === stableStringify(doc));
  check('verbatim source data preserved',
    reopened.dataFiles.get(`data/${viability.id}.csv`) === VIABILITY);
  check('cached p-value preserved',
    reopened.document.analyses[0]?.result?.comparisons[0]?.p === comparison.p);

  // Staleness: editing the data must invalidate the displayed statistic.
  const tampered = hashInputs({ test: 'ttest-welch' }, [[1, 2, 3], [4, 5, 6]]);
  check('edited data marks the analysis stale', tampered !== analysis.inputHash);

  console.log(
    failures === 0
      ? `\n✓ Acceptance flow passed. Artefacts in out/\n`
      : `\n✗ ${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nAcceptance run crashed:', error);
  process.exit(1);
});
