/**
 * Rich-text run reconciliation for `TextNode.richText`.
 *
 * A `<textarea>` holds one flat string; `richText` is a flat `TextRun[]`
 * over the same character offsets. These functions are the only place that
 * ever cuts, merges or rewrites that run list, so the editing surfaces
 * (the canvas overlay, the Inspector) can never diverge on where a
 * boundary lands or how a toggle resolves.
 */

import type { TextRun } from './nodes.js';

/** The one derivation of `TextNode.text` from `TextNode.richText`. */
export function plainTextOfRuns(runs: readonly TextRun[]): string {
  return runs.map((r) => r.text).join('');
}

function sameFormat(a: TextRun, b: TextRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.script === b.script;
}

/**
 * Splits the run containing flat offset `at` into two runs at that
 * character boundary. A no-op if `at` already falls on one (including
 * `at <= 0` or `at >= length`). The one place a run is ever cut in two —
 * used by both `reconcileTextEdit` and `toggleRunFormat` so the two can
 * never disagree about where a cut lands.
 */
export function splitRunsAt(runs: readonly TextRun[], at: number): readonly TextRun[] {
  if (at <= 0) return runs;
  let offset = 0;
  const result: TextRun[] = [];
  for (const run of runs) {
    const start = offset;
    const end = offset + run.text.length;
    if (at > start && at < end) {
      const cut = at - start;
      result.push({ ...run, text: run.text.slice(0, cut) });
      result.push({ ...run, text: run.text.slice(cut) });
    } else {
      result.push(run);
    }
    offset = end;
  }
  return result;
}

/**
 * Reunites adjacent runs whose bold/italic/script fields are strictly
 * equal (including matching `undefined` vs. an explicit `false`, which are
 * different states — see `TextRun.bold`'s own doc comment), and drops
 * zero-length runs left behind by a split or a toggle. Keeps a run list
 * from growing unboundedly over a typing session.
 */
export function mergeAdjacentRuns(runs: readonly TextRun[]): readonly TextRun[] {
  const nonEmpty = runs.filter((r) => r.text.length > 0);
  const result: TextRun[] = [];
  for (const run of nonEmpty) {
    const prev = result[result.length - 1];
    if (prev && sameFormat(prev, run)) {
      result[result.length - 1] = { ...prev, text: prev.text + run.text };
    } else {
      result.push(run);
    }
  }
  return result;
}

/**
 * Reconciles a `<textarea>`'s new flat value against the previous run
 * list. Bounded, not a general diff — sufficient because a single
 * `onChange` from one textarea can only ever report "unchanged prefix,
 * unchanged suffix, changed middle": typing, deleting and pasting all
 * produce exactly this shape. Splits the previous runs at both edges of
 * the changed span, drops whatever fell strictly inside it, and splices in
 * one new run carrying the inserted text with the formatting of the run
 * immediately to its left (typing continues the format to its left), or
 * the run at the insertion point when inserting at the very start.
 */
export function reconcileTextEdit(prevRuns: readonly TextRun[], nextText: string): readonly TextRun[] {
  const prevText = plainTextOfRuns(prevRuns);
  if (prevText === nextText) return prevRuns;

  const bound = Math.min(prevText.length, nextText.length);
  let prefix = 0;
  while (prefix < bound && prevText[prefix] === nextText[prefix]) prefix++;

  const suffixBound = bound - prefix;
  let suffix = 0;
  while (
    suffix < suffixBound &&
    prevText[prevText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removedStart = prefix;
  const removedEnd = prevText.length - suffix;
  const insertedText = nextText.slice(prefix, nextText.length - suffix);

  // Bootstrap: a brand-new TextNode with no runs yet.
  if (prevRuns.length === 0) {
    return insertedText.length > 0 ? [{ text: insertedText }] : [];
  }

  const split = splitRunsAt(splitRunsAt(prevRuns, removedStart), removedEnd);

  const before: TextRun[] = [];
  const after: TextRun[] = [];
  let formatSource: TextRun | undefined;
  let offset = 0;
  for (const run of split) {
    const start = offset;
    const end = offset + run.text.length;
    offset = end;
    if (end <= removedStart) {
      before.push(run);
      formatSource = run;
    } else if (start >= removedEnd) {
      after.push(run);
      if (formatSource === undefined) formatSource = run;
    }
    // else: strictly within [removedStart, removedEnd) — dropped.
  }

  const result = [...before];
  if (insertedText.length > 0) {
    result.push(
      formatSource
        ? { text: insertedText, bold: formatSource.bold, italic: formatSource.italic, script: formatSource.script }
        : { text: insertedText },
    );
  }
  result.push(...after);

  return mergeAdjacentRuns(result);
}

function isRunFlagActive(
  run: TextRun,
  flag: 'bold' | 'italic' | 'sup' | 'sub',
  baseActive: boolean,
): boolean {
  if (flag === 'sup') return run.script === 'sup';
  if (flag === 'sub') return run.script === 'sub';
  const explicit = flag === 'bold' ? run.bold : run.italic;
  return explicit ?? baseActive;
}

/**
 * Whether `flag` is active across the *whole* flat-offset range `[start,
 * end)` — read-only, for a toolbar button's pressed state. A run's
 * formatting is uniform along its own length regardless of where it's cut,
 * so this reads the unsplit `runs` directly rather than needing
 * `splitRunsAt` first: overlap with the range is enough to pick up a run's
 * one flag. Shares the exact "every overlapping run must have it" rule
 * `toggleRunFormat` decides its own on/off with, so a button's pressed
 * state and what clicking it does can never disagree.
 */
export function isRangeFormatted(
  runs: readonly TextRun[],
  start: number,
  end: number,
  flag: 'bold' | 'italic' | 'sup' | 'sub',
  baseActive: boolean,
): boolean {
  if (start >= end) return false;
  let offset = 0;
  let any = false;
  for (const run of runs) {
    const rStart = offset;
    const rEnd = offset + run.text.length;
    offset = rEnd;
    if (Math.min(rEnd, end) <= Math.max(rStart, start)) continue;
    any = true;
    if (!isRunFlagActive(run, flag, baseActive)) return false;
  }
  return any;
}

/**
 * Toggles `flag` over flat-offset range `[start, end)`. Splits at both
 * edges, then: if every run now fully inside the range already has the
 * flag active — an `undefined` bold/italic run inherits `baseActive` (the
 * node's own `style.fontWeight`/`fontStyle`; always `false` for sup/sub,
 * which have no whole-node equivalent) — turns it off everywhere in range
 * (an explicit `false` where `baseActive` is `true`, since clearing the
 * field there would still inherit `true`); otherwise turns it on. The
 * standard word-processor "off if fully on" convention. Toggling `sup` on
 * a `sub` range flips rather than compounds, since the two are mutually
 * exclusive.
 */
export function toggleRunFormat(
  runs: readonly TextRun[],
  start: number,
  end: number,
  flag: 'bold' | 'italic' | 'sup' | 'sub',
  baseActive: boolean,
): readonly TextRun[] {
  if (start >= end) return runs;
  const turnOn = !isRangeFormatted(runs, start, end, flag, baseActive);
  const split = splitRunsAt(splitRunsAt(runs, start), end);
  const inRange = (rStart: number, rEnd: number): boolean => rStart >= start && rEnd <= end && rEnd > rStart;

  let offset = 0;
  const result = split.map((run) => {
    const rStart = offset;
    const rEnd = offset + run.text.length;
    offset = rEnd;
    if (!inRange(rStart, rEnd)) return run;
    if (flag === 'sup' || flag === 'sub') return { ...run, script: turnOn ? flag : undefined };
    if (flag === 'bold') return { ...run, bold: turnOn ? true : baseActive ? false : undefined };
    return { ...run, italic: turnOn ? true : baseActive ? false : undefined };
  });

  return mergeAdjacentRuns(result);
}
