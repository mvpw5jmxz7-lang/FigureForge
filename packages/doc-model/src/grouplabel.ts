/**
 * Geometry shared by both group-label mechanisms — the same-panel gutter
 * growth in `operations.ts`'s `fillPanelChildren`, and the cross-panel
 * `reserveSpaceForGroupLabels` — so the two cannot compute two different
 * clearances for what is, on the page, one heading.
 *
 * Deliberately here rather than in `packages/render` (where the plan that
 * shaped this feature first placed it, reasoning it would need
 * `text-width.ts`): the clearance a heading needs is its own line height plus
 * its rule and a small gap — never the *width* of its title text, since
 * nothing here auto-wraps or truncates a heading the way a tick label does.
 * Only glyph *width* needs `text-width.ts`, and nothing here measures that, so
 * `doc-model`'s "imports nothing internal" invariant holds without a
 * dependency this feature never actually needed.
 */

import { ptToMm } from './units.js';

/**
 * A group-label with no explicit font size uses this.
 *
 * 6 pt, matching `theme.type.annotationPt`/`tickLabelPt` — the size the rest
 * of a figure's type is set in. It was 8 pt (a panel *letter*'s size), which
 * made a pane caption the loudest text on the page. Checked against six
 * published multi-panel figures: every one sets its column headings at the
 * same size and weight as the tick labels beside them, carrying the hierarchy
 * in position rather than in size.
 */
export const DEFAULT_GROUP_LABEL_PT = 6;

/**
 * Gap between a heading's rule and the members below it.
 *
 * Measured on a real heading over a micrograph, 1.5 mm leaves the rule about
 * 1.7 mm clear of the picture's top edge, which reads as a border drawn *on*
 * the image rather than a heading above it.
 */
export const GROUP_LABEL_GAP_MM = 2.5;

/**
 * Gap between a heading's *text* and the members below it, where no rule is
 * drawn — which is now the default.
 *
 * Deliberately much tighter than the ruled case. The 2.5 mm above exists to
 * stop a rule reading as part of the picture; a bare 6 pt caption has no such
 * problem, and at that size 2.5 mm is most of a line height of dead space
 * between a label and the thing it names. Both are overridden by
 * `GroupLabelNode.gapMm`, and both are read only through `clearanceForLabel`,
 * so no call site can pick the wrong one for its case.
 */
export const GROUP_LABEL_GAP_NO_RULE_MM = 1;

/** Gap between the rule and the title text sitting above/beside it. */
export const GROUP_LABEL_RULE_TEXT_GAP_MM = 0.8;

/** Inset from the picture's own edge to an overlaid label's text. */
export const GROUP_LABEL_OVERLAY_PAD_MM = 1;

/**
 * Millimetres of clearance a heading needs on its own side of its members.
 *
 * A single line of text at `titleSizePt` (the 1.2 line-height convention
 * `TextStyle.lineHeight` already defaults to elsewhere in this codebase),
 * plus the rule and its own gap to the text when shown.
 */
export function groupLabelClearanceMm(
  titleSizePt: number | undefined,
  showRule: boolean,
  ruleWidthMm: number | undefined,
  gapMm?: number,
): number {
  const lineHeightMm = ptToMm(titleSizePt ?? DEFAULT_GROUP_LABEL_PT) * 1.2;
  const ruleMm = showRule ? (ruleWidthMm ?? 0.35) + GROUP_LABEL_RULE_TEXT_GAP_MM : 0;
  const defaultGap = showRule ? GROUP_LABEL_GAP_MM : GROUP_LABEL_GAP_NO_RULE_MM;
  return lineHeightMm + ruleMm + (gapMm ?? defaultGap);
}

/**
 * The one place a `GroupLabelNode`'s own fields become a clearance, so no
 * call site can read three of the four and quietly disagree with the others.
 *
 * An overlaid label needs **none**: it is drawn on the picture, so it grows no
 * grid gutter, triggers no `reserveSpaceForGroupLabels` push, and moves
 * nothing on the page. That is the whole point of overlaying it.
 */
export function clearanceForLabel(label: {
  style?: { fontSizePt?: number };
  showRule?: boolean;
  stroke?: { widthMm: number };
  gapMm?: number;
  placement?: 'outside' | 'overlay';
}): number {
  if (label.placement === 'overlay') return 0;
  return groupLabelClearanceMm(
    label.style?.fontSizePt,
    // Absent is now *no* rule. A column heading in a published figure is bare
    // text; the rule is the exception, so it is what has to be asked for.
    label.showRule ?? false,
    label.stroke?.widthMm,
    label.gapMm,
  );
}
