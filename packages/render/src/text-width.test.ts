import { describe, expect, it } from 'vitest';
import { estimateTextWidthMm, leadingSignWidthMm } from './text-width.js';

describe('leadingSignWidthMm', () => {
  it('is zero for a plain, unsigned run', () => {
    expect(leadingSignWidthMm([{ text: '100' }], 6)).toBe(0);
  });

  it('is the en dash advance width for a negative run', () => {
    expect(leadingSignWidthMm([{ text: '–100' }], 6)).toBe(estimateTextWidthMm('–', 6));
  });

  it('is zero when the first run is a superscript', () => {
    // `formatTick`/`formatRunsFor` never put the sign in a sup run, but a
    // hand-built run list should not be mistaken for a signed label either.
    expect(leadingSignWidthMm([{ text: '–100', sup: true }], 6)).toBe(0);
  });

  it('is zero for an empty run list', () => {
    expect(leadingSignWidthMm([], 6)).toBe(0);
  });

  it('never matches the ASCII hyphen or the true minus sign', () => {
    expect(leadingSignWidthMm([{ text: '-100' }], 6)).toBe(0);
    expect(leadingSignWidthMm([{ text: '−100' }], 6)).toBe(0);
  });
});
