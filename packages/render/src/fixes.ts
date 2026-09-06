/**
 * The repairs the quality checker is allowed to perform.
 *
 * A `Finding` carries the recipe that fixes it, built by the rule that found it
 * — the rule has already computed which nodes are wrong and what the right
 * value is, and re-deriving that from a finding id at apply time is how two
 * derivations of one fact come to disagree. `analysisInputHash` and
 * `scaleBarWidthMm` exist in this codebase for the same reason.
 *
 * Two rules every recipe here obeys:
 *
 *   - Close over **node ids and target values**, never over derived geometry.
 *     A recipe may run some time after the check that produced it, against a
 *     document that has moved on.
 *   - Tolerate a missing target. "Fix all" applies several recipes to one
 *     draft, and an earlier one may have removed a node a later one names, so
 *     every lookup here returns early rather than assuming the node is still
 *     there.
 *
 * `checkFigure` stays a pure analysis: a rule *constructs* a mutation, it never
 * executes one.
 */

import {
  applyAutoLayout,
  relabelPanels,
  repositionBrackets,
  type FigureDocument,
  type NodeId,
  type TextStyle,
} from '@figureforge/doc-model';
import type { Theme } from '@figureforge/theme';
import { measureAllPlots } from './render-document.js';

export interface FixContext {
  /** Id factory, for recipes that create nodes. */
  newId: () => string;
  theme: Theme;
}

export type FixRecipe = (draft: FigureDocument, ctx: FixContext) => void;

export interface Fix {
  /**
   * What the button says. Where a fix has a consequence beyond the defect it
   * repairs, the label is where that is disclosed — see `equaliseGutters`.
   */
  label: string;
  apply: FixRecipe;
  /**
   * True when the fix moves things the author placed. Excluded from
   * "fix all safe issues", which must never rearrange a figure silently.
   */
  rearranges?: boolean;
}

/**
 * Restyle a node that carries a `TextStyle`, or do nothing if it does not
 * exist any more. Not `updateNode`: its patch is typed against the whole
 * `FigureNode` union, which has no common `style`, whereas the four variants
 * that do carry one are exactly the ones a text fix may touch.
 */
function restyle(
  draft: FigureDocument,
  id: NodeId,
  change: (style: TextStyle) => TextStyle,
): void {
  const node = draft.nodes[id];
  // A group-label's `style` is optional (absent means "theme default"), so
  // `'style' in node` alone no longer guarantees a value to restyle — a
  // node with no style of its own has no *own* size to be out of range.
  if (!node || !('style' in node) || node.style === undefined) return;
  node.style = change(node.style);
}

/**
 * Bring an explicitly-sized label back inside the journal's range.
 *
 * Only ever applied to nodes whose *own* `style.fontSizePt` (or, for a
 * volcano's point labels, `PlotNode.pointLabelSizePt` — the one role sized by
 * a field of its own rather than a shared `style` object) is out of range. A
 * tick label drawn at the theme's size is a different defect with a different
 * repair — see `checkTextSize`, which refuses to offer a fix for it.
 */
export function clampFontSize(ids: readonly NodeId[], targetPt: number): FixRecipe {
  return (draft) => {
    for (const id of ids) {
      const node = draft.nodes[id];
      if (node && 'style' in node) {
        restyle(draft, id, (style) => ({ ...style, fontSizePt: targetPt }));
      } else if (node?.type === 'plot') {
        node.pointLabelSizePt = targetPt;
      }
    }
  };
}

/**
 * Drop per-node font families so everything falls back to the theme's.
 *
 * Nothing in the app can set `style.fontFamily`; the only way a figure acquires
 * a second family is by opening a file that already had one. So the theme's
 * family is by definition the intended one, and clearing the override is the
 * whole repair.
 */
export function dropFontOverrides(ids: readonly NodeId[]): FixRecipe {
  return (draft) => {
    for (const id of ids) {
      restyle(draft, id, ({ fontFamily: _dropped, ...rest }) => rest);
    }
  };
}

/** Letter every panel in reading order, creating any label that is missing. */
export function relabelAllPanels(): FixRecipe {
  return (draft, ctx) => {
    relabelPanels(draft, ctx.newId, {
      uppercase: ctx.theme.panelLabelCase === 'upper',
      fontSizePt: ctx.theme.type.panelLabelPt,
      offsetMm: 4,
    });
  };
}

/**
 * Re-run auto layout, which is what equalises gutters.
 *
 * This resizes every panel and its contents — `fillPanelChildren` does not know
 * which arrangement was deliberate — so a figure the author arranged by hand is
 * replaced by the grid. That is disclosed in the button label rather than
 * softened, and `rearranges` keeps it out of "fix all".
 */
export function equaliseGutters(): FixRecipe {
  return (draft, ctx) => {
    applyAutoLayout(draft, {
      marginMm: ctx.theme.spacing.marginMm,
      gutterMm: ctx.theme.spacing.panelGutterMm,
      labelGutterMm: 4,
    });
    // Brackets sit in absolute page space; nothing else moves them with the
    // panels they annotate.
    repositionBrackets(draft, measureAllPlots(draft, ctx.theme));
  };
}

/**
 * Set the page width to the preset's.
 *
 * Offered *only* when every panel already fits inside the target width, which
 * makes the change pure: nothing moves, and undo restores it exactly. Narrowing
 * a page whose panels overhang would push them off it, and the repair for that
 * is a re-layout that discards the author's arrangement — a decision, not a fix.
 * `checkPageDimensions` withholds this recipe in that case.
 */
export function matchPresetWidth(widthMm: number): FixRecipe {
  return (draft) => {
    draft.page.widthMm = widthMm;
  };
}
