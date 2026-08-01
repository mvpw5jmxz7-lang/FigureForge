/**
 * Publication themes.
 *
 * A theme is the set of defaults that makes a figure look like it belongs in a
 * given journal without the author tuning anything. The brief's Nature spec is
 * encoded literally: Arial with a Helvetica fallback, panel labels at 8 pt bold,
 * and general figure text held between 5 and 7 pt.
 *
 * Font sizes are in points throughout; stroke widths are in millimetres, since
 * they are geometry. `ptToMm` from doc-model converts at render time.
 */

import { ptToMm } from '@figureforge/doc-model';

export interface TypeScale {
  /** Panel letters — 8 pt bold in the Nature preset. */
  panelLabelPt: number;
  axisTitlePt: number;
  tickLabelPt: number;
  legendPt: number;
  annotationPt: number;
  /** Significance stars and p-value text. */
  statisticPt: number;
  scaleBarPt: number;
  /** Hard floor the quality checker enforces; journals reject text below this. */
  minimumPt: number;
  maximumPt: number;
}

export interface StrokeScale {
  /** Axis lines and plot frames. */
  axisMm: number;
  tickMm: number;
  /** Data lines, bar outlines, error bars. */
  dataMm: number;
  errorBarMm: number;
  bracketMm: number;
  /** Below this a stroke may disappear at press resolution. */
  hairlineMinMm: number;
}

export interface SpacingScale {
  /** Gap between panels in an auto-layout grid. */
  panelGutterMm: number;
  /** Page edge inset. */
  marginMm: number;
  /** Plot area inset within its panel, leaving room for axes. */
  plotMarginMm: { top: number; right: number; bottom: number; left: number };
  tickLengthMm: number;
  /** Gap between a tick and its label. */
  tickLabelGapMm: number;
  axisTitleGapMm: number;
  /** Vertical clearance between the tallest datum and a significance bracket. */
  bracketGapMm: number;
}

export interface Theme {
  id: string;
  name: string;
  /** Ordered font stack. Liberation Sans is metrically identical to Arial, so
   *  it substitutes without shifting any layout. */
  fontFamily: string;
  monoFontFamily: string;
  type: TypeScale;
  stroke: StrokeScale;
  spacing: SpacingScale;
  paletteId: string;
  foreground: string;
  background: string;
  /** Nature-style plots drop the top and right spines. */
  spines: { top: boolean; right: boolean; bottom: boolean; left: boolean };
  /** Panel letters lowercase in Nature, uppercase in Cell and Science. */
  panelLabelCase: 'lower' | 'upper';
  panelLabelWeight: 'bold' | 'normal';
}

const ARIAL_STACK = "Arial, 'Liberation Sans', Helvetica, 'Nimbus Sans', sans-serif";
const HELVETICA_STACK = "Helvetica, 'Nimbus Sans', Arial, 'Liberation Sans', sans-serif";

export const NATURE_THEME: Theme = {
  id: 'nature',
  name: 'Nature Publication Style',
  fontFamily: ARIAL_STACK,
  monoFontFamily: "'DejaVu Sans Mono', monospace",
  type: {
    panelLabelPt: 8,
    axisTitlePt: 7,
    tickLabelPt: 6,
    legendPt: 6,
    annotationPt: 6,
    statisticPt: 6,
    scaleBarPt: 6,
    minimumPt: 5,
    maximumPt: 7,
  },
  stroke: {
    axisMm: ptToMm(0.5),
    tickMm: ptToMm(0.5),
    dataMm: ptToMm(0.75),
    errorBarMm: ptToMm(0.5),
    bracketMm: ptToMm(0.5),
    hairlineMinMm: ptToMm(0.25),
  },
  spacing: {
    panelGutterMm: 5,
    marginMm: 2,
    plotMarginMm: { top: 3, right: 2, bottom: 9, left: 12 },
    tickLengthMm: 1,
    tickLabelGapMm: 0.8,
    axisTitleGapMm: 2.2,
    bracketGapMm: 1.5,
  },
  paletteId: 'okabe-ito',
  foreground: '#000000',
  background: '#ffffff',
  spines: { top: false, right: false, bottom: true, left: true },
  panelLabelCase: 'lower',
  panelLabelWeight: 'bold',
};

export const CELL_THEME: Theme = {
  ...NATURE_THEME,
  id: 'cell',
  name: 'Cell Press Style',
  fontFamily: ARIAL_STACK,
  type: { ...NATURE_THEME.type, panelLabelPt: 9, axisTitlePt: 7, tickLabelPt: 6, maximumPt: 9 },
  panelLabelCase: 'upper',
};

export const SCIENCE_THEME: Theme = {
  ...NATURE_THEME,
  id: 'science',
  name: 'Science Style',
  fontFamily: HELVETICA_STACK,
  type: { ...NATURE_THEME.type, panelLabelPt: 9, axisTitlePt: 7, tickLabelPt: 6, maximumPt: 9 },
  spines: { top: false, right: false, bottom: true, left: true },
  panelLabelCase: 'upper',
};

export const THEMES: readonly Theme[] = [NATURE_THEME, CELL_THEME, SCIENCE_THEME];

export const findTheme = (id: string): Theme | undefined => THEMES.find((t) => t.id === id);

export const getTheme = (id: string): Theme => findTheme(id) ?? NATURE_THEME;

/** Apply per-document overrides on top of a base theme. */
export function resolveTheme(id: string, overrides: Record<string, unknown> = {}): Theme {
  const base = getTheme(id);
  if (Object.keys(overrides).length === 0) return base;
  return {
    ...base,
    ...(overrides as Partial<Theme>),
    type: { ...base.type, ...((overrides['type'] as Partial<TypeScale>) ?? {}) },
    stroke: { ...base.stroke, ...((overrides['stroke'] as Partial<StrokeScale>) ?? {}) },
    spacing: { ...base.spacing, ...((overrides['spacing'] as Partial<SpacingScale>) ?? {}) },
  };
}

/** Panel letters: a, b, c … z, aa, ab … */
export function panelLetter(index: number, theme: Theme): string {
  let n = index;
  let letters = '';
  do {
    letters = String.fromCharCode(97 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return theme.panelLabelCase === 'upper' ? letters.toUpperCase() : letters;
}
