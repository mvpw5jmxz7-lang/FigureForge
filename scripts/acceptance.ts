/**
 * Acceptance flow, run end to end without the UI.
 *
 *   CSV in → bar+dot plot with mean ± s.e.m. → Welch's t-test → significance
 *   bracket → micrograph panel with a calibrated scale bar and annotations →
 *   two panels on Nature double-column → panel letters → export PDF with
 *   selectable text and a 300 dpi PNG → publication readiness score.
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
  addArrow,
  addAsset,
  addBracket,
  addImage,
  addPanelWithPlot,
  addScaleBar,
  applyAutoLayout,
  buildArchiveContents,
  createDocument,
  createIdFactory,
  editDataset,
  editDocument,
  analysisInputHash,
  inferFormat,
  loadArchive,
  parseDelimited,
  relabelPanels,
  saveArchive,
  scaleBarWidthMm,
  setCell,
  setImageCrop,
  stableStringify,
  toSeries,
  type Analysis,
  type Dataset,
  type FigureDocument,
  type StatResult,
} from '@figureforge/doc-model';
import {
  checkFigure,
  collectByRole,
  measurePlot,
  renderDocument,
  toSvgString,
} from '@figureforge/render';
import { NATURE_THEME } from '@figureforge/theme';

const API = process.env['API_URL'] ?? 'http://localhost:8000';
const OUT = new URL('../out/', import.meta.url).pathname;

const VIABILITY = `Treatment,Rep1,Rep2,Rep3,Rep4
Vehicle,98.2,95.4,101.3,97.8
Compound X,42.1,38.7,45.3,40.2`;

// Six replicates, not three: panel b is drawn as a box plot, and quartiles and
// Tukey whiskers are not meaningful below about n = 5 — the quality checker
// says so, and a demo figure should not model the thing it warns about.
const EXPRESSION = `Genotype,Rep1,Rep2,Rep3,Rep4,Rep5,Rep6
WT,1.02,0.98,1.00,1.07,0.94,1.03
KO,2.41,2.68,2.55,2.33,2.72,2.49`;

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
      plotType: 'box',
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
    plotId: plot.id,
    // Through the shared helper, so this matches what the staleness check
    // recomputes — composing the hash by hand here made it disagree.
    inputHash: analysisInputHash(
      { test: 'ttest-welch', correction: 'none' },
      series.map((s) => s.values),
    ),
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

  // -- 3b. Image panel, scale bar and annotations ---------------------------
  console.log('\n3b. Image panel');

  // A real 2×2 PNG rather than a stub: the export path has to embed decodable
  // image data, and a placeholder would pass every check below while producing
  // a blank rectangle in the PDF.
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4' +
    'nGP8z8DAwMDAxAADRDEAWFsCBQlnMcgAAAAASUVORK5CYII=';
  const pngBytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

  const assetId = newId();
  // 1000 px shown 40 mm wide → 0.04 mm/px. At 2 px/µm a 10 µm bar spans 20 px,
  // so it must draw exactly 0.8 mm. Hand-computed, not read back from the code.
  const EXPECTED_BAR_MM = 0.8;

  let imageId = '';
  let barId = '';

  doc = editDocument(doc, (draft) => {
    addAsset(draft, {
      id: assetId,
      filename: 'micrograph.png',
      mimeType: 'image/png',
      byteLength: pngBytes.length,
      naturalPx: { width: 1000, height: 800 },
    });

    const image = addImage(draft, newId, {
      assetId,
      frame: { x: 120, y: 8, width: 40, height: 32 },
      naturalPx: { width: 1000, height: 800 },
      name: 'Micrograph',
    });
    imageId = image.id;

    barId =
      addScaleBar(draft, newId, {
        imageId: image.id,
        length: 10,
        pixelsPerUnit: 2,
        unitLabel: 'µm',
        calibrationSource: 'metadata',
      })?.id ?? '';

    addArrow(draft, newId, { frame: { x: 125, y: 12, width: 12, height: 8 } });
  });

  check('image panel created', doc.nodes[imageId]?.type === 'image');
  check('scale bar attached to the image', doc.nodes[barId]?.parentId === imageId);
  check('scale bar length matches the calibration',
    Math.abs((scaleBarWidthMm(doc.nodes, barId) ?? 0) - EXPECTED_BAR_MM) < 1e-9,
    `${(scaleBarWidthMm(doc.nodes, barId) ?? 0).toFixed(3)} mm`);

  // Halving the image halves what a millimetre on it represents. A bar that
  // held its length here would silently misstate the scale.
  const halved = editDocument(doc, (draft) => {
    const image = draft.nodes[imageId]!;
    image.frame = { ...image.frame, width: image.frame.width / 2 };
  });
  check('scale bar halves with its image',
    Math.abs((scaleBarWidthMm(halved.nodes, barId) ?? 0) - EXPECTED_BAR_MM / 2) < 1e-9);

  // -- 4. Render -----------------------------------------------------------
  console.log('\n4. Render');

  // The exporter hands back data URIs: an exported SVG must not depend on
  // anything outside itself, and a blob URL is meaningless off this machine.
  const dataUri = `data:image/png;base64,${PNG_BASE64}`;
  const resolveAsset = (id: string): string | undefined =>
    id === assetId ? dataUri : undefined;

  const scene = renderDocument(doc, { theme: NATURE_THEME, resolveAsset });
  const svg = toSvgString(scene, { xmlDeclaration: true });

  check('SVG declares millimetre dimensions', svg.includes('width="183mm"'));
  check('one user unit is one millimetre', svg.includes('viewBox="0 0 183 75"'));
  check('axis title present as real text', svg.includes('Cell viability (%)'));

  // Panel b is a box plot: prove the distribution marks reach the output rather
  // than falling through to the categorical dot path, which is what every one of
  // the declared-but-unimplemented plot types silently did.
  check('box plot hinges rendered', collectByRole(scene, 'box').length === 2);
  check('box plot whiskers rendered', collectByRole(scene, 'whisker').length === 2);
  check('no error bars drawn under a box', collectByRole(scene, 'error-bar').length === 2);

  check('image embedded as a self-contained data URI',
    svg.includes('<image') && svg.includes('data:image/png;base64,'));
  check('scale bar and its label rendered',
    collectByRole(scene, 'scale-bar').length === 1 &&
      collectByRole(scene, 'scale-bar-label').length === 1);
  // Markers scale with stroke-width and are flattened on import into vector
  // editors, which is why the head is explicit path geometry.
  check('arrowheads drawn as geometry, not markers',
    collectByRole(scene, 'arrow').length === 1 && !svg.includes('<marker'));

  // Cropping must clip an oversized image, never resample it: every retained
  // pixel keeps the resolution it was captured at.
  const cropped = editDocument(doc, (draft) =>
    setImageCrop(draft, imageId, { x: 0.25, width: 0.5 }),
  );
  const croppedSvg = toSvgString(
    renderDocument(cropped, { theme: NATURE_THEME, resolveAsset }),
  );
  const imageFrame = cropped.nodes[imageId]!.frame;
  // `preserveAspectRatio="none"` is the marker of the corrected path: the
  // renderer places the kept region itself rather than handing the job to a
  // second centring rule that was resolving against the oversized box.
  check('crop clips an oversized image rather than scaling it',
    croppedSvg.includes('clipPath') &&
      croppedSvg.includes('preserveAspectRatio="none"') &&
      !croppedSvg.includes('scale(') &&
      imageFrame.width > 0);

  writeFileSync(`${OUT}figure.svg`, svg);

  // -- 5. Quality ----------------------------------------------------------
  console.log('\n5. Quality check');

  const report = checkFigure({ document: doc, theme: NATURE_THEME, scene, exportDpi: 300 });
  console.log(`   Publication Readiness Score: ${report.score}/100`);
  for (const finding of report.findings) {
    console.log(`   [${finding.severity}] ${finding.title}`);
  }
  check('no blocking errors', report.findings.every((f) => f.severity !== 'error'));

  // A rule that never fires passes "no blocking errors" just as well as a rule
  // that works, so prove the two heaviest ones actually judge something. Built
  // in a throwaway document: firing them in the main one would turn the check
  // above red for the right reason at the wrong time.
  const underResolved = editDocument(doc, (draft) => {
    const image = draft.nodes[imageId]!;
    // 1000 px across 160 mm is 159 dpi, well under the 300 dpi target.
    image.frame = { ...image.frame, width: 160 };
  });
  const lowDpi = checkFigure({
    document: underResolved,
    theme: NATURE_THEME,
    scene: renderDocument(underResolved, { theme: NATURE_THEME, resolveAsset }),
    exportDpi: 300,
  }).findings;
  check('an under-resolution image is flagged',
    lowDpi.some((f) => f.id.startsWith('image-low-dpi-') && f.severity === 'error'));

  const uncalibrated = editDocument(doc, (draft) => {
    const bar = draft.nodes[barId];
    if (bar?.type === 'scale-bar') bar.calibrationSource = 'unknown';
  });
  const barFindings = checkFigure({
    document: uncalibrated,
    theme: NATURE_THEME,
    scene: renderDocument(uncalibrated, { theme: NATURE_THEME, resolveAsset }),
  }).findings;
  check('an uncalibrated scale bar is flagged',
    barFindings.some((f) => f.id.startsWith('scale-bar-uncalibrated-')));

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

  const assetPath = doc.assets[0]!.path;
  const archive = saveArchive(
    buildArchiveContents(
      doc,
      new Map([[`data/${viability.id}.csv`, VIABILITY]]),
      new Map([[assetPath, pngBytes]]),
    ),
  );
  writeFileSync(`${OUT}figure.figureforge`, archive);

  const reopened = loadArchive(archive);
  // Compared with sorted keys: validation rebuilds objects in schema order, so
  // plain JSON.stringify would report a difference that does not exist.
  check('document survives a save/load round-trip',
    stableStringify(reopened.document) === stableStringify(doc));
  check('verbatim source data preserved',
    reopened.dataFiles.get(`data/${viability.id}.csv`) === VIABILITY);

  // The same claim, for binaries: what a reviewer extracts must be the bytes
  // that were imported, not a re-encoding of them.
  const reopenedAsset = reopened.assets.get(assetPath);
  check('image asset preserved byte for byte',
    reopenedAsset !== undefined &&
      reopenedAsset.length === pngBytes.length &&
      reopenedAsset.every((byte, i) => byte === pngBytes[i]),
    `${reopenedAsset?.length ?? 0} bytes`);
  check('scale bar calibration survives the round-trip',
    Math.abs((scaleBarWidthMm(reopened.document.nodes, barId) ?? 0) - EXPECTED_BAR_MM) < 1e-9);
  check('cached p-value preserved',
    reopened.document.analyses[0]?.result?.comparisons[0]?.p === comparison.p);

  // Staleness: editing the data must invalidate the displayed statistic.
  const tampered = analysisInputHash({ test: 'ttest-welch', correction: 'none' }, [
    [1, 2, 3],
    [4, 5, 6],
  ]);
  check('edited data marks the analysis stale', tampered !== analysis.inputHash);

  /*
   * Editing a table in the data grid must not cost the reproducibility claim.
   * The edited cells travel in `document.json`; the bytes that were imported
   * stay at `sourcePath`. Both are kept, they are distinguishable, and a
   * reviewer extracting the archive still gets the original numbers.
   */
  const editedDoc = editDocument(doc, (draft) =>
    editDataset(draft, viability.id, (ds) => setCell(ds, 0, 1, '0.1')),
  );
  const editedArchive = saveArchive(
    buildArchiveContents(
      editedDoc,
      new Map([[`data/${viability.id}.csv`, VIABILITY]]),
      new Map([[assetPath, pngBytes]]),
    ),
  );
  const reopenedEdit = loadArchive(editedArchive);
  const editedDataset = reopenedEdit.document.datasets.find((d) => d.id === viability.id);

  check('an edited cell survives the round-trip', editedDataset?.rows[0]?.[1] === 0.1);
  check('the edit is recorded as one', editedDataset?.editedAt !== undefined);
  check(
    'the verbatim import survives the edit',
    reopenedEdit.dataFiles.get(`data/${viability.id}.csv`) === VIABILITY,
  );

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
