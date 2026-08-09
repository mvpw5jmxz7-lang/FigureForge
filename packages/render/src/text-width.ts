/**
 * Text width estimation, without a DOM.
 *
 * The renderer must decide whether tick labels collide *before* emitting them,
 * and it must reach the same decision on the canvas and in the headless export
 * — measuring with `getComputedTextLength` in one and guessing in the other
 * would put rotated labels on screen and overlapping ones in the PDF.
 *
 * So: a static advance-width table. The figures below are Helvetica/Arial
 * advance widths in units of 1/1000 em, the metrics Liberation Sans reproduces
 * exactly (which is why the image ships it as the Arial substitute). Absolute
 * accuracy matters less than both adapters agreeing, but these are close enough
 * that a label declared to fit does fit.
 */

/** Advance widths per 1000 em for the characters that appear in axis labels. */
const ADVANCE: Readonly<Record<string, number>> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556,
  '8': 556, '9': 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
  // Common in scientific labels.
  '±': 584, µ: 556, '°': 400, '−': 584, '–': 556, '—': 1000, '…': 1000, '×': 584,
};

/** Unlisted characters — accented letters, Greek — bill as a lowercase letter. */
const DEFAULT_ADVANCE = 556;

/** Points to millimetres. Duplicated from doc-model's `ptToMm` to keep this
 *  module free of imports, since it is called per label per render. */
const PT_TO_MM = 25.4 / 72;

/**
 * Width of `text` set at `fontSizePt`, in millimetres.
 *
 * Deterministic: same input, same answer, in the browser and in the exporter.
 */
export function estimateTextWidthMm(text: string, fontSizePt: number): number {
  if (text === '' || !Number.isFinite(fontSizePt) || fontSizePt <= 0) return 0;

  let thousandths = 0;
  // Iterate by code point so astral characters count once, not twice.
  for (const char of text) {
    thousandths += ADVANCE[char] ?? DEFAULT_ADVANCE;
  }

  return (thousandths / 1000) * fontSizePt * PT_TO_MM;
}

/** Cap height plus descender: the vertical space one line actually occupies. */
export function estimateTextHeightMm(fontSizePt: number): number {
  if (!Number.isFinite(fontSizePt) || fontSizePt <= 0) return 0;
  // 0.716 cap height + 0.212 descender for this metric set.
  return fontSizePt * PT_TO_MM * 0.928;
}

/**
 * Shorten to fit, appending an ellipsis.
 *
 * Last resort: rotation is preferred because it keeps the label readable, and a
 * truncated category name can be genuinely ambiguous. Returns the original when
 * it already fits, and the ellipsis alone when nothing else does.
 */
export function truncateToWidth(text: string, fontSizePt: number, maxWidthMm: number): string {
  if (maxWidthMm <= 0) return '';
  if (estimateTextWidthMm(text, fontSizePt) <= maxWidthMm) return text;

  const chars = [...text];
  for (let take = chars.length - 1; take > 0; take--) {
    const candidate = `${chars.slice(0, take).join('')}…`;
    if (estimateTextWidthMm(candidate, fontSizePt) <= maxWidthMm) return candidate;
  }
  return '…';
}

/**
 * Superscript size and baseline rise, as fractions of the base size. 65% and
 * 40% are the conventional typographic ratios, and exactly what `tickLabelNode`
 * (`render-document.ts`) draws — so the measurement here and the drawing there
 * cannot disagree, the same "composed once" discipline `scaleBarWidthMm` and
 * `analysisInputHash` are already held to.
 */
const SUPERSCRIPT_SCALE = 0.65;
const SUPERSCRIPT_RISE = 0.4;

/**
 * The absolute floor a superscript's `font-size` may reach.
 *
 * An exponent is not body text: Nature's 5 pt minimum (`minimumPt`) is a floor
 * for prose and axis labels a reader has to read on their own, and clamping a
 * 6 pt tick label's 65% exponent to that floor would make "10⁵" print as
 * "10 5". `parity.test.tsx` and `checkTextSize` exempt the `'tick-label-sup'`
 * role down to this floor instead — half a point under the body floor, and no
 * lower regardless of how small the base size drops.
 */
export const SUPERSCRIPT_MIN_PT = 4;

/**
 * A superscript run's font size, in points.
 *
 * Read by both `estimateRunsWidthMm` below and `tickLabelNode`'s drawing, so
 * neither can compute a different answer from the other.
 */
export function superscriptSizePt(basePt: number): number {
  return Math.max(SUPERSCRIPT_MIN_PT, basePt * SUPERSCRIPT_SCALE);
}

/** Width of a run list, each optionally set at the reduced superscript size. */
export function estimateRunsWidthMm(
  runs: readonly { text: string; sup?: boolean }[],
  fontSizePt: number,
): number {
  return runs.reduce(
    (sum, run) =>
      sum + estimateTextWidthMm(run.text, run.sup ? superscriptSizePt(fontSizePt) : fontSizePt),
    0,
  );
}

/**
 * How far a run list reaches above the baseline — 0 unless something in it is
 * raised. A superscript grows *upward* from the baseline, so a caller sizing
 * the room above a tick label (the gap before an axis line, a category
 * label's clearance) has to add this on top of the ordinary line height.
 */
export function superscriptRiseMm(
  runs: readonly { text: string; sup?: boolean }[],
  fontSizePt: number,
): number {
  return runs.some((run) => run.sup) ? fontSizePt * PT_TO_MM * SUPERSCRIPT_RISE : 0;
}
