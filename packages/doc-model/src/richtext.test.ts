/**
 * Rich-text run reconciliation — the algorithm a `<textarea>`'s flat
 * onChange value is mapped back onto structured runs through, and the one
 * place a formatting toggle splits/merges them. Both editing surfaces
 * (canvas overlay, Inspector) share this, so its correctness is what keeps
 * them from disagreeing.
 */

import { describe, expect, it } from 'vitest';

import {
  isRangeFormatted,
  mergeAdjacentRuns,
  plainTextOfRuns,
  reconcileTextEdit,
  splitRunsAt,
  toggleRunFormat,
} from './richtext.js';
import type { TextRun } from './nodes.js';

describe('plainTextOfRuns', () => {
  it('joins run text in order', () => {
    expect(plainTextOfRuns([{ text: 'ab' }, { text: 'cd', bold: true }])).toBe('abcd');
  });

  it('is the identity on a single plain run', () => {
    expect(plainTextOfRuns([{ text: 'hello' }])).toBe('hello');
  });

  it('is empty for no runs', () => {
    expect(plainTextOfRuns([])).toBe('');
  });
});

describe('splitRunsAt', () => {
  it('cuts a run in the middle', () => {
    const runs: TextRun[] = [{ text: 'hello', bold: true }];
    expect(splitRunsAt(runs, 2)).toEqual([
      { text: 'he', bold: true },
      { text: 'llo', bold: true },
    ]);
  });

  it('is a no-op at an existing boundary', () => {
    const runs: TextRun[] = [{ text: 'ab' }, { text: 'cd', italic: true }];
    expect(splitRunsAt(runs, 2)).toEqual(runs);
  });

  it('is a no-op at the very start or end', () => {
    const runs: TextRun[] = [{ text: 'abcd' }];
    expect(splitRunsAt(runs, 0)).toEqual(runs);
    expect(splitRunsAt(runs, 4)).toEqual(runs);
  });

  it('finds the right run across a multi-run list', () => {
    const runs: TextRun[] = [{ text: 'ab' }, { text: 'cdef', bold: true }, { text: 'gh' }];
    expect(splitRunsAt(runs, 4)).toEqual([
      { text: 'ab' },
      { text: 'cd', bold: true },
      { text: 'ef', bold: true },
      { text: 'gh' },
    ]);
  });
});

describe('mergeAdjacentRuns', () => {
  it('reunites neighbours with identical formatting', () => {
    const runs: TextRun[] = [{ text: 'he', bold: true }, { text: 'llo', bold: true }];
    expect(mergeAdjacentRuns(runs)).toEqual([{ text: 'hello', bold: true }]);
  });

  it('does not merge across a real formatting difference', () => {
    const runs: TextRun[] = [{ text: 'he', bold: true }, { text: 'llo' }];
    expect(mergeAdjacentRuns(runs)).toEqual(runs);
  });

  it('treats undefined and explicit false as different states', () => {
    const runs: TextRun[] = [{ text: 'he', bold: undefined }, { text: 'llo', bold: false }];
    expect(mergeAdjacentRuns(runs)).toEqual(runs);
  });

  it('drops zero-length runs', () => {
    const runs: TextRun[] = [{ text: 'he' }, { text: '', bold: true }, { text: 'llo' }];
    expect(mergeAdjacentRuns(runs)).toEqual([{ text: 'hello' }]);
  });
});

describe('reconcileTextEdit', () => {
  it('bootstraps a plain run from empty', () => {
    expect(reconcileTextEdit([], 'hi')).toEqual([{ text: 'hi' }]);
  });

  it('is the identity when nothing changed', () => {
    const runs: TextRun[] = [{ text: 'hi', bold: true }];
    expect(reconcileTextEdit(runs, 'hi')).toBe(runs);
  });

  it('types at the end, inheriting the trailing run\'s formatting', () => {
    const runs: TextRun[] = [{ text: 'hi', bold: true }];
    expect(reconcileTextEdit(runs, 'hi!')).toEqual([{ text: 'hi!', bold: true }]);
  });

  it('types in the middle of a run, splitting and re-merging around it', () => {
    const runs: TextRun[] = [{ text: 'ac', italic: true }];
    expect(reconcileTextEdit(runs, 'abc')).toEqual([{ text: 'abc', italic: true }]);
  });

  it('types in the middle where the inserted text differs in format from neither side (still merges with the left)', () => {
    const runs: TextRun[] = [{ text: 'a', bold: true }, { text: 'c' }];
    // Insertion point is exactly at the run boundary — the run to the left wins.
    expect(reconcileTextEdit(runs, 'abc')).toEqual([{ text: 'ab', bold: true }, { text: 'c' }]);
  });

  it('deletes one character from within a run', () => {
    const runs: TextRun[] = [{ text: 'hello', bold: true }];
    expect(reconcileTextEdit(runs, 'hllo')).toEqual([{ text: 'hllo', bold: true }]);
  });

  it('deletes across a run boundary, keeping each surviving fragment\'s own formatting', () => {
    const runs: TextRun[] = [{ text: 'abc', bold: true }, { text: 'def' }];
    // Delete "cd" (crosses the boundary) -> "ab" + "ef", not merged (different formats).
    expect(reconcileTextEdit(runs, 'abef')).toEqual([{ text: 'ab', bold: true }, { text: 'ef' }]);
  });

  it('pastes, replacing a selection entirely inside one run', () => {
    const runs: TextRun[] = [{ text: 'hello world', italic: true }];
    expect(reconcileTextEdit(runs, 'hello there world')).toEqual([{ text: 'hello there world', italic: true }]);
  });

  it('clears all text back to empty', () => {
    const runs: TextRun[] = [{ text: 'hi', bold: true }];
    expect(reconcileTextEdit(runs, '')).toEqual([]);
  });
});

describe('toggleRunFormat', () => {
  it('turns bold on over an unformatted range', () => {
    const runs: TextRun[] = [{ text: 'hello' }];
    expect(toggleRunFormat(runs, 1, 4, 'bold', false)).toEqual([
      { text: 'h' },
      { text: 'ell', bold: true },
      { text: 'o' },
    ]);
  });

  it('turns bold off over a fully-bold range', () => {
    const runs: TextRun[] = [{ text: 'hello', bold: true }];
    expect(toggleRunFormat(runs, 1, 4, 'bold', false)).toEqual([
      { text: 'h', bold: true },
      { text: 'ell' },
      { text: 'o', bold: true },
    ]);
  });

  it('writes an explicit false when the base style is bold, rather than leaving it to inherit true', () => {
    const runs: TextRun[] = [{ text: 'hello' }];
    expect(toggleRunFormat(runs, 0, 5, 'bold', true)).toEqual([{ text: 'hello', bold: false }]);
  });

  it('splits at a partial overlap of two differently-formatted runs and only flips the in-range fragments', () => {
    const runs: TextRun[] = [{ text: 'abcd', bold: true }, { text: 'efgh' }];
    // Selection [2, 6) straddles the boundary; neither side is fully bold, so it turns on —
    // and the untouched "ab" (already bold) ends up contiguous and re-merges with it.
    expect(toggleRunFormat(runs, 2, 6, 'bold', false)).toEqual([
      { text: 'abcdef', bold: true },
      { text: 'gh' },
    ]);
  });

  it('flips superscript to subscript rather than compounding', () => {
    const runs: TextRun[] = [{ text: 'x2', script: 'sub' }];
    expect(toggleRunFormat(runs, 0, 2, 'sup', false)).toEqual([{ text: 'x2', script: 'sup' }]);
  });

  it('is a no-op for an empty range', () => {
    const runs: TextRun[] = [{ text: 'hello' }];
    expect(toggleRunFormat(runs, 2, 2, 'bold', false)).toBe(runs);
  });
});

describe('isRangeFormatted', () => {
  it('is true only when every overlapping run has the flag', () => {
    const runs: TextRun[] = [{ text: 'abcd', bold: true }, { text: 'efgh' }];
    expect(isRangeFormatted(runs, 0, 4, 'bold', false)).toBe(true);
    expect(isRangeFormatted(runs, 0, 8, 'bold', false)).toBe(false);
    expect(isRangeFormatted(runs, 4, 8, 'bold', false)).toBe(false);
  });

  it('reads baseActive for an undefined bold/italic run', () => {
    const runs: TextRun[] = [{ text: 'hello' }];
    expect(isRangeFormatted(runs, 0, 5, 'bold', true)).toBe(true);
    expect(isRangeFormatted(runs, 0, 5, 'bold', false)).toBe(false);
  });

  it('never inherits baseActive for sup/sub', () => {
    const runs: TextRun[] = [{ text: 'hello' }];
    expect(isRangeFormatted(runs, 0, 5, 'sup', true)).toBe(false);
  });

  it('is false for an empty range', () => {
    expect(isRangeFormatted([{ text: 'hello' }], 2, 2, 'bold', false)).toBe(false);
  });

  it('agrees with what toggleRunFormat decides to do', () => {
    const runs: TextRun[] = [{ text: 'abcd', bold: true }, { text: 'efgh' }];
    const wasFormatted = isRangeFormatted(runs, 2, 6, 'bold', false);
    const after = toggleRunFormat(runs, 2, 6, 'bold', false);
    expect(isRangeFormatted(after, 2, 6, 'bold', false)).toBe(!wasFormatted);
  });
});
