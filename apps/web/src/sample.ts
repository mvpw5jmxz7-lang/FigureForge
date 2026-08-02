/**
 * Demo figure used as the app's starting document.
 *
 * Shaped like real experimental data: a treatment column plus replicate
 * columns, which is what comes out of a plate reader or an image quantification
 * and is the format most authors will paste in.
 */

import {
  addPanelWithPlot,
  applyAutoLayout,
  createDocument,
  createIdFactory,
  editDocument,
  inferFormat,
  parseDelimited,
  relabelPanels,
  type DataFormat,
  type Dataset,
  type ParseOptions,
  type FigureDocument,
} from '@figureforge/doc-model';
import { NATURE_THEME } from '@figureforge/theme';

export const SAMPLE_VIABILITY = `Treatment,Rep1,Rep2,Rep3,Rep4
Vehicle,98.2,95.4,101.3,97.8
10 µM,74.5,71.2,78.9,73.1
50 µM,42.1,38.7,45.3,40.2
100 µM,18.4,21.9,16.2,19.7`;

export const SAMPLE_EXPRESSION = `Genotype,Rep1,Rep2,Rep3
WT,1.02,0.98,1.00
KO,2.41,2.68,2.55
Rescue,1.18,1.09,1.24`;

/** Build a Dataset from pasted or imported delimited text. */
export interface ImportOptions extends ParseOptions {
  /**
   * Override the inferred layout.
   *
   * Detection is a heuristic on column shapes and names, and a wrong guess
   * silently changes what every series *is* — `prism` reads column 0 as one
   * shared x, `sigmaplot` reads the columns as independent pairs. The author is
   * the only one who actually knows, so they get the last word.
   */
  format?: DataFormat;
}

export function datasetFromText(
  text: string,
  name: string,
  id: string,
  filename: string | null = null,
  options: ImportOptions = {},
): Dataset {
  const parsed = parseDelimited(text, options);
  return {
    id,
    name,
    format: options.format ?? inferFormat(parsed.columns),
    columns: parsed.columns,
    rows: parsed.rows,
    sourcePath: `data/${id}.csv`,
    sourceFilename: filename,
    importedAt: new Date().toISOString(),
  };
}

export function createSampleDocument(): FigureDocument {
  const newId = createIdFactory();

  const base = createDocument({
    title: 'Compound X reduces viability and induces target expression',
    presetId: 'nature-double',
    widthMm: 183,
    heightMm: 75,
    idFactory: newId,
  });

  return editDocument(base, (draft) => {
    const viability = datasetFromText(SAMPLE_VIABILITY, 'Cell viability', newId());
    const expression = datasetFromText(SAMPLE_EXPRESSION, 'Target expression', newId());
    draft.datasets = [viability, expression];

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Viability',
      datasetId: viability.id,
      plotType: 'bar-dot',
      yTitle: 'Cell viability (%)',
      xTitle: 'Compound X',
    });

    addPanelWithPlot(draft, newId, {
      frame: { x: 0, y: 0, width: 80, height: 60 },
      name: 'Expression',
      datasetId: expression.id,
      plotType: 'bar-dot',
      yTitle: 'Relative expression',
      xTitle: 'Genotype',
    });

    applyAutoLayout(draft, {
      marginMm: NATURE_THEME.spacing.marginMm,
      gutterMm: NATURE_THEME.spacing.panelGutterMm,
      labelGutterMm: 4,
    });

    relabelPanels(draft, newId, {
      fontSizePt: NATURE_THEME.type.panelLabelPt,
      offsetMm: 4,
    });
  });
}
