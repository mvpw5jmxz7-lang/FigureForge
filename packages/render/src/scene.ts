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
  | 'threshold-line';

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
