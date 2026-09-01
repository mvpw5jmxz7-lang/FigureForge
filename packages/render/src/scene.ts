/**
 * The scene tree.
 *
 * A plain, serialisable description of the SVG to draw. Two adapters consume
 * it: `toReact` for the live canvas and `toSvgString` for export. Both read the
 * same tree, which is what makes "what you see is what you export" a structural
 * guarantee rather than a promise maintained by hand.
 *
 * NOTHING in this package may import the DOM. If it did, the export path — which
 * runs in a headless renderer with no document — would diverge from the canvas
 * silently, and the divergence would only show up in a submitted figure.
 */

export type SceneAttrs = Record<string, string | number | undefined>;

export interface SceneNode {
  tag: string;
  attrs?: SceneAttrs;
  children?: SceneNode[];
  /** Text content, for <text> and <tspan>. */
  text?: string;
  /** Document node this was generated from; drives hit-testing and selection. */
  nodeId?: string;
  /** What this element is, so the quality checker can audit without guessing. */
  role?: SceneRole;
  /**
   * A field on the owning document node that this element edits in place, as a
   * dotted path (`'x.title'`, `'cascadeAxisTitle'`).
   *
   * Metadata, deliberately, rather than an entry in `attrs`: `toSvgString`
   * serialises only `attrs`, so putting it there would change the exported SVG
   * for a purely editorial concern. The React adapter emits it as
   * `data-edit-target`, which is all the canvas needs to know *which* string a
   * double-click on an axis title should open — `nodeId` alone names the plot,
   * and a plot carries several titles.
   *
   * Distinct from `role` because the two answer different questions: `role`
   * says what an element is (and is consumed by the quality checker's size
   * rules), this says what editing it would write. Widening `role` into
   * per-axis members would have silently changed every role-count assertion.
   */
  editTarget?: string;
}

export type SceneRole =
  | 'page'
  | 'panel'
  | 'panel-label'
  | 'plot-area'
  | 'axis'
  | 'axis-break'
  | 'axis-title'
  | 'tick'
  | 'tick-label'
  | 'bar'
  | 'point'
  | 'error-bar'
  | 'box'
  | 'violin'
  | 'whisker'
  | 'outlier'
  | 'line'
  | 'bracket'
  | 'bracket-label'
  | 'image'
  | 'text'
  | 'shape'
  | 'arrow'
  | 'scale-bar'
  | 'scale-bar-label'
  | 'legend'
  /** Editor chrome only; never present in an exported scene. */
  | 'resize-handle'
  /**
   * An arrow endpoint grip. Kept distinct from 'resize-handle' so counting
   * handles still means "the eight compass grips" — the parity test asserts
   * exactly 8, and folding these in would quietly break that assertion's point.
   */
  | 'point-handle'
  /**
   * The grip that turns a node. Kept distinct from both handle roles above for
   * the same reason they are distinct from each other: "exactly 8 resize
   * handles" and "one point handle per arrow point" are assertions that must
   * keep meaning what they say when a ninth grip appears beside them.
   */
  | 'rotate-handle'
  /**
   * A raster standing in for a plot's points once its count exceeds
   * `MAX_VECTOR_POINTS`. Kept distinct from 'image' — a real `ImageNode` and a
   * baked point cloud are different things, and folding them together would
   * make a role-count assertion for one quietly start counting the other.
   */
  | 'point-cloud'
  /**
   * A volcano plot's dashed fold-change/p-value cutoff line. Kept distinct
   * from 'axis' and 'error-bar' for the same reason 'point-cloud' is kept
   * distinct from 'image' — a role-count assertion for one must not be
   * silently widened by another.
   */
  | 'threshold-line'
  /** One heatmap cell. */
  | 'heatmap-cell'
  /**
   * One strip of a heatmap's colour-scale legend — a ramp drawn as adjacent
   * rects, not a single gradient primitive. Kept distinct from 'legend' since
   * a role-count assertion for a discrete swatch list must not be silently
   * widened by dozens of ramp strips.
   */
  | 'colorbar'
  /**
   * A tick where a censored subject leaves a Kaplan–Meier curve. Kept
   * distinct from 'threshold-line'/'error-bar' for the same reason
   * 'point-cloud' is kept distinct from 'image' — a role-count assertion for
   * one must not be silently widened by another.
   */
  | 'censor-mark'
  /**
   * A tick label's superscript exponent — the `<tspan>` set at
   * `superscriptSizePt`, not the label as a whole (which stays `'tick-label'`
   * on its containing `<text>`). Its own role so `checkTextSize` and
   * `parity.test.tsx`'s font-size range can exempt exactly this text down to
   * `SUPERSCRIPT_MIN_PT`, without loosening the floor for any other label.
   */
  | 'tick-label-sup'
  /**
   * A drawn point identity — a gene name on a volcano plot. Kept distinct
   * from 'text'/'tick-label' for the standing reason: a role-count assertion
   * for one must not be silently widened by another, and `THEME_SIZE_KEYS`
   * maps a role to the theme size it was drawn at.
   */
  | 'point-label'
  /** The dotted leader joining a pushed-out point label to its point. Kept
   *  distinct from 'line' for the same reason. */
  | 'point-label-leader'
  /**
   * A cascade/ridgeline series' opaque fill down to its baseline. Kept
   * distinct from 'error-bar' (which is translucent by design) — an 'area'
   * fill is never `fill-opacity`ed, since a translucent fill that is meant to
   * occlude the traces behind it is a contradiction.
   */
  | 'area'
  /**
   * A cascade/ridgeline plot's schematic depth axis: the spine, its tick
   * strokes, and a group's end bracket. Kept as ONE role for all three —
   * this is a single small decorative axis, not a first-class plot axis —
   * but distinct from 'axis'/'tick'/'bracket' so a role-count assertion for
   * any of those three is never silently widened by this feature.
   */
  | 'cascade-axis'
  /** A cascade depth axis tick's label — one series name. Distinct from
   *  'tick-label' for the same reason 'cascade-axis' is distinct from
   *  'axis'/'tick': `THEME_SIZE_KEYS` and any role-count assertion for the
   *  real axis's tick labels must not be widened by this one. */
  | 'cascade-axis-label'
  /** A cascade depth axis group's end-of-axis caption — the series' shared
   *  `category`, or `cascadeAxisTitle` in the single-implicit-group case.
   *  Distinct from 'axis-title' for the same reason. */
  | 'cascade-axis-title'
  /**
   * A reference line at a value axis's own tick, or (on a cascade) running
   * diagonally to the back plane. Kept distinct from 'axis' for the standing
   * reason: a role-count assertion for the real axis lines must not be
   * silently widened by however many gridlines a plot draws. Never added to
   * `quality.ts`'s `MARK_ROLES` — it is chrome, not data-ink, so the
   * colour-vision-deficiency contrast checker must not compare it against
   * series colours.
   */
  | 'gridline'
  /**
   * The second copy of the front L-axis — left value axis and bottom x axis,
   * with tick marks but no labels — standing on a cascading plot's back
   * plane, drawn by `showGridlines`. See `renderCascadeBackAxes`. Kept
   * distinct from 'axis'/'tick' (the real front axis and its ticks) and from
   * 'gridline' (the pale diagonals and the wall they close, including its top
   * and right edges): this pair is drawn in the ordinary axis stroke rather
   * than the gridline colour/style, and a role-count assertion for any of the
   * others must not be silently widened by it.
   */
  | 'cascade-back-axis'
  /**
   * A Perseus-style permutation (SAM) significance boundary on a volcano
   * plot — two dashed curves in place of the straight fold-change/p-value
   * cutoff lines. Kept distinct from 'threshold-line' for the standing
   * reason: a role-count assertion for the straight-line cutoffs must not be
   * silently widened by this feature, and the two are never drawn together
   * (see `renderVolcanoThresholds`).
   */
  | 'volcano-sam-curve'
  /**
   * A `TextNode` rich-text run's superscript/subscript `<tspan>` — the run
   * as formatted, not the block as a whole (which stays 'text' on its
   * containing `<text>`). Its own roles, kept distinct from 'tick-label-sup'
   * for the standing reason: this is user-authored text, not a computed
   * tick exponent, and a role-count assertion for one must not be silently
   * widened by the other. Both get the same `checkTextSize`/parity size-floor
   * exemption `'tick-label-sup'` already has, down to `SUPERSCRIPT_MIN_PT`.
   */
  | 'text-sup'
  | 'text-sub';

export const el = (
  tag: string,
  attrs?: SceneAttrs,
  children?: SceneNode[],
  extra?: Partial<SceneNode>,
): SceneNode => ({ tag, attrs, children, ...extra });

export const group = (attrs?: SceneAttrs, children: SceneNode[] = [], extra?: Partial<SceneNode>) =>
  el('g', attrs, children, extra);

export const text = (content: string, attrs: SceneAttrs, extra?: Partial<SceneNode>): SceneNode => ({
  tag: 'text',
  attrs,
  text: content,
  ...extra,
});

/** Millimetre translate, rounded so both adapters emit byte-identical output. */
export const translate = (x: number, y: number): string =>
  `translate(${round(x)} ${round(y)})`;

/**
 * Four decimal places is ~0.1 µm — far finer than any press can resolve, and
 * enough to stop float noise producing diffs between renders.
 */
export function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e4) / 1e4;
}

/** Depth-first walk over a scene tree. */
export function walkScene(node: SceneNode, visit: (n: SceneNode, depth: number) => void, depth = 0): void {
  visit(node, depth);
  for (const child of node.children ?? []) walkScene(child, visit, depth + 1);
}

/**
 * Depth-first walk that also reports the document node each element belongs to.
 *
 * `nodeId` is set only on the container `<g>` a document node renders into, so
 * an offending `<text>` two levels down carries no back-link of its own. The
 * quality checker needs one: telling an author "some text is below 5 pt" is
 * useless next to naming the label and offering to fix it. Kept separate from
 * `walkScene` rather than folded into it — that signature is load-bearing in
 * the parity test.
 */
export function walkWithOwner(
  root: SceneNode,
  visit: (node: SceneNode, ownerId: string | undefined) => void,
  owner?: string,
): void {
  const current = root.nodeId ?? owner;
  visit(root, current);
  for (const child of root.children ?? []) walkWithOwner(child, visit, current);
}

/** Collect every node carrying a given role — used by the quality checker. */
export function collectByRole(root: SceneNode, role: SceneRole): SceneNode[] {
  const out: SceneNode[] = [];
  walkScene(root, (n) => {
    if (n.role === role) out.push(n);
  });
  return out;
}

/** Every distinct value of an attribute across the tree, e.g. all font sizes. */
export function collectAttr(root: SceneNode, attr: string): (string | number)[] {
  const values: (string | number)[] = [];
  walkScene(root, (n) => {
    const value = n.attrs?.[attr];
    if (value !== undefined) values.push(value);
  });
  return values;
}
