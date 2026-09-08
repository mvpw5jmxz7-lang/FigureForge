/**
 * Fold-vs-fold classification.
 *
 * Every case here is a comparison whose right answer is arithmetic, so the
 * expected values are stated rather than derived from the implementation. The
 * cases that matter most are the boundaries: a point exactly on a cutoff, a
 * point clearing one axis but not the other, and a zero fold change, which has
 * a magnitude but no direction.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLD_FOLD_THRESHOLDS, foldFoldCategory } from './fold-fold.js';
import type { FoldFoldThresholds } from './fold-fold.js';

const T: FoldFoldThresholds = { x: 1, y: 1 };

describe('the two-colour mode', () => {
  it('defaults to requiring both axes', () => {
    // No `rule`, so `'both'`: clearing x alone is not enough.
    expect(foldFoldCategory(2, 2, T)).toBe('sig');
    expect(foldFoldCategory(2, 0.5, T)).toBe('ns');
    expect(foldFoldCategory(0.5, 2, T)).toBe('ns');
    expect(foldFoldCategory(0.5, 0.5, T)).toBe('ns');
  });

  it('takes either axis when asked to', () => {
    const either: FoldFoldThresholds = { ...T, rule: 'either' };
    expect(foldFoldCategory(2, 0.5, either)).toBe('sig');
    expect(foldFoldCategory(0.5, 2, either)).toBe('sig');
    // Still nothing when neither axis clears — 'either' widens the rule, it
    // does not remove it.
    expect(foldFoldCategory(0.5, 0.5, either)).toBe('ns');
  });

  it('counts a point sitting exactly on both cutoffs', () => {
    // Inclusive, matching `volcanoCategory`: a cutoff is the value at which a
    // point counts, not the value it must beat.
    expect(foldFoldCategory(1, 1, T)).toBe('sig');
    expect(foldFoldCategory(-1, -1, T)).toBe('sig');
  });

  it('reads magnitude, so a fall counts as much as a rise', () => {
    expect(foldFoldCategory(-3, -4, T)).toBe('sig');
    expect(foldFoldCategory(-3, 4, T)).toBe('sig');
  });

  it('uses independent cutoffs per axis', () => {
    // Two contrasts can warrant different cutoffs, which is why the field
    // carries two numbers rather than one.
    const uneven: FoldFoldThresholds = { x: 0.5, y: 3 };
    expect(foldFoldCategory(1, 1, uneven)).toBe('ns'); // clears x, not y
    expect(foldFoldCategory(1, 3, uneven)).toBe('sig');
  });
});

describe('the quadrant mode', () => {
  const q = (x: number, y: number) => foldFoldCategory(x, y, T, 'quadrant');

  it('names each of the four quadrants', () => {
    expect(q(2, 3)).toBe('up-up');
    expect(q(-2, -3)).toBe('down-down');
    expect(q(2, -3)).toBe('up-down');
    expect(q(-2, 3)).toBe('down-up');
  });

  it('requires both cutoffs, whatever the rule says', () => {
    /*
     * Not a policy but a construction: a point clearing x but not y has a
     * direction on one axis and none on the other, so it belongs to no
     * quadrant. `rule: 'either'` is deliberately not read here — this is the
     * assertion that pins the Inspector's decision to hide that control.
     */
    expect(q(2, 0.5)).toBe('ns');
    expect(q(0.5, 2)).toBe('ns');
    expect(foldFoldCategory(2, 0.5, { ...T, rule: 'either' }, 'quadrant')).toBe('ns');
  });

  it('gives a zero fold change no quadrant, even at a zero cutoff', () => {
    // A cutoff of zero passes every point on magnitude, so this is the one
    // way an exactly-zero value reaches the quadrant branch at all.
    expect(foldFoldCategory(0, 2, { x: 0, y: 0 }, 'quadrant')).toBe('ns');
    expect(foldFoldCategory(2, 0, { x: 0, y: 0 }, 'quadrant')).toBe('ns');
    // A non-zero point at the same zero cutoff still lands in its quadrant.
    expect(foldFoldCategory(2, 2, { x: 0, y: 0 }, 'quadrant')).toBe('up-up');
  });
});

describe('values that are not numbers', () => {
  it('reads a non-finite coordinate as not significant, in either mode', () => {
    /*
     * A NaN must not become significant by accident any more than it becomes
     * insignificant by accident — `Math.abs(NaN) >= 1` is false, which would
     * quietly give the right answer here and the wrong one under a `<`
     * comparison elsewhere. Stated rather than relied upon, the stance
     * `volcanoCategory` already takes.
     */
    for (const mode of ['significant', 'quadrant'] as const) {
      expect(foldFoldCategory(Number.NaN, 2, T, mode)).toBe('ns');
      expect(foldFoldCategory(2, Number.NaN, T, mode)).toBe('ns');
      expect(foldFoldCategory(Number.POSITIVE_INFINITY, 2, T, mode)).toBe('ns');
      expect(foldFoldCategory(2, Number.NEGATIVE_INFINITY, T, mode)).toBe('ns');
    }
  });
});

describe('the shipped default', () => {
  it('is one log2 unit on each axis — a doubling', () => {
    expect(DEFAULT_FOLD_FOLD_THRESHOLDS).toEqual({ x: 1, y: 1 });
    expect(foldFoldCategory(1, 1, DEFAULT_FOLD_FOLD_THRESHOLDS)).toBe('sig');
    expect(foldFoldCategory(0.99, 1, DEFAULT_FOLD_FOLD_THRESHOLDS)).toBe('ns');
  });
});
