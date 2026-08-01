import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  deltaE2000,
  findColorConflicts,
  MIN_SERIES_DELTA_E,
  OKABE_ITO,
  panelLetter,
  relativeLuminance,
  simulateCvd,
  toGrayscale,
} from './index.js';
import { NATURE_THEME, SCIENCE_THEME } from './theme.js';

describe('colour maths', () => {
  it('matches the WCAG reference luminances', () => {
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 6);
  });

  it('gives black on white the maximum contrast ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 4);
  });

  it('reports zero difference for identical colours', () => {
    expect(deltaE2000('#0072b2', '#0072b2')).toBeCloseTo(0, 6);
  });

  it('scores a large difference between blue and orange', () => {
    expect(deltaE2000('#0072b2', '#e69f00')).toBeGreaterThan(40);
  });
});

describe('colour vision deficiency simulation', () => {
  it('collapses red and green under deuteranopia', () => {
    const red = simulateCvd('#ff0000', 'deuteranopia');
    const green = simulateCvd('#00ff00', 'deuteranopia');
    // The classic failure: distinct to most readers, near-identical to some.
    expect(deltaE2000(red, green)).toBeLessThan(deltaE2000('#ff0000', '#00ff00'));
    expect(deltaE2000(red, green)).toBeLessThan(25);
  });

  it('leaves blue and yellow separable under deuteranopia', () => {
    expect(
      deltaE2000(simulateCvd('#0072b2', 'deuteranopia'), simulateCvd('#f0e442', 'deuteranopia')),
    ).toBeGreaterThan(MIN_SERIES_DELTA_E);
  });

  it('reduces any colour to a grey of matching luminance', () => {
    const grey = toGrayscale('#0072b2');
    expect(grey.slice(1, 3)).toBe(grey.slice(3, 5));
    expect(grey.slice(3, 5)).toBe(grey.slice(5, 7));
  });
});

describe('palette validation', () => {
  it('separates the first four Okabe-Ito colours under red-green deficiency', () => {
    // The palette is designed for deuteranopia and protanopia, which together
    // account for virtually all colour vision deficiency.
    const conflicts = findColorConflicts(OKABE_ITO.slice(0, 4)).filter(
      (c) => c.condition === 'deuteranopia' || c.condition === 'protanopia',
    );
    expect(conflicts).toEqual([]);
  });

  it('still separates them in normal vision', () => {
    const conflicts = findColorConflicts(OKABE_ITO.slice(0, 4)).filter(
      (c) => c.condition === 'normal',
    );
    expect(conflicts).toEqual([]);
  });

  it('reports the known tritanopia limit rather than hiding it', () => {
    // Okabe-Ito orange and reddish-purple converge under tritanopia (ΔE ≈ 10).
    // Tritanopia is vanishingly rare, but the checker should say so rather
    // than pretend the palette is universally safe.
    const conflicts = findColorConflicts(OKABE_ITO.slice(0, 4)).filter(
      (c) => c.condition === 'tritanopia',
    );
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]!.deltaE).toBeGreaterThan(5);
  });

  it('flags a red/green pairing', () => {
    const conflicts = findColorConflicts(['#d62728', '#2ca02c']);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.some((c) => c.condition === 'deuteranopia')).toBe(true);
  });

  it('flags colours that merge in greyscale printing', () => {
    // Same lightness, different hue: fine in colour, identical in print.
    const conflicts = findColorConflicts(['#ff0000', '#00a2ff']);
    expect(conflicts.some((c) => c.condition === 'grayscale')).toBe(true);
  });

  it('returns worst conflicts first', () => {
    const conflicts = findColorConflicts(['#d62728', '#2ca02c', '#0072b2']);
    for (let i = 1; i < conflicts.length; i++) {
      expect(conflicts[i]!.deltaE).toBeGreaterThanOrEqual(conflicts[i - 1]!.deltaE);
    }
  });
});

describe('themes', () => {
  it('encodes the Nature typography brief', () => {
    expect(NATURE_THEME.type.panelLabelPt).toBe(8);
    expect(NATURE_THEME.panelLabelWeight).toBe('bold');
    expect(NATURE_THEME.type.minimumPt).toBe(5);
    expect(NATURE_THEME.type.maximumPt).toBe(7);
    expect(NATURE_THEME.fontFamily).toMatch(/^Arial/);
  });

  it('falls back to metric-compatible substitutes for Arial and Helvetica', () => {
    // Liberation Sans is metrically identical to Arial, so a substitution on a
    // machine without Arial licensed does not shift any layout.
    expect(NATURE_THEME.fontFamily).toContain('Liberation Sans');
    expect(SCIENCE_THEME.fontFamily).toContain('Nimbus Sans');
  });

  it('letters panels per journal convention', () => {
    expect(panelLetter(0, NATURE_THEME)).toBe('a');
    expect(panelLetter(25, NATURE_THEME)).toBe('z');
    expect(panelLetter(26, NATURE_THEME)).toBe('aa');
    expect(panelLetter(0, SCIENCE_THEME)).toBe('A');
  });
});
