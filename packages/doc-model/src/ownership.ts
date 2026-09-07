/**
 * Which panel does this node belong to?
 *
 * A figure's nodes reach their panel five different ways, and until this module
 * every consumer re-derived its own subset of them:
 *
 * - a `plot`, a montage `image`, anything parented into a panel — the
 *   `parentId` chain;
 * - a `scale-bar` — the same chain, two hops, through the image it calibrates;
 * - a `panel-label` — its `panelId` field, since a letter is a *top-level* node
 *   that merely names the panel it labels;
 * - a `bracket` — `plotId` → that plot's parent, also from top level;
 * - a `group-label` — its `memberIds`, which may name **several** panels, since
 *   a heading spans a row.
 *
 * Spreading that over the UI is how one view comes to say a bracket belongs to
 * panel *a* while another says it belongs to nothing — the same "composed in
 * exactly one place" discipline `scaleBarWidthMm` and `analysisInputHash` are
 * already held to.
 *
 * The letter itself needs no derivation: `PanelNode.label` is model state,
 * refreshed by `relabelPanels` on every layout change.
 */

import {
  absoluteFrame,
  ancestorsOf,
  type FigureNode,
  type NodeId,
  type NodeMap,
  type PanelNode,
} from './nodes.js';
import { compareReadingOrder, ROW_TOLERANCE_MM } from './layout.js';

const isPanel = (node: FigureNode | undefined): node is PanelNode => node?.type === 'panel';

/**
 * The panel a node sits *inside*, by the ordinary parent chain.
 *
 * Its zeroth step is "the node already is a panel", which is what lets the
 * `group-label` case below resolve each of its members — panels and images
 * alike — through one call rather than recursing.
 */
function panelViaAncestors(nodes: NodeMap, id: NodeId): PanelNode | null {
  const node = nodes[id];
  if (!node) return null;
  if (isPanel(node)) return node;
  for (const ancestor of ancestorsOf(nodes, id)) {
    if (isPanel(ancestor)) return ancestor;
  }
  return null;
}

/**
 * Every panel a node belongs to, in reading order.
 *
 * Usually exactly one. A group title spanning a row belongs to several; a
 * page-level note belongs to none. A bracket whose plot has since been deleted
 * also belongs to none, rather than throwing.
 *
 * Deliberately a flat switch and never recursive: a `group-label`'s members go
 * through `panelViaAncestors`, so nothing here can descend into another
 * group-label and the function terminates by construction.
 */
export function panelsOwning(
  nodes: NodeMap,
  id: NodeId,
  rowToleranceMm = ROW_TOLERANCE_MM,
): PanelNode[] {
  const node = nodes[id];
  if (!node) return [];

  switch (node.type) {
    case 'panel-label': {
      const panel = nodes[node.panelId];
      return isPanel(panel) ? [panel] : [];
    }
    case 'bracket': {
      const plot = node.plotId ? nodes[node.plotId] : undefined;
      if (!plot) return [];
      const panel = panelViaAncestors(nodes, plot.id);
      return panel ? [panel] : [];
    }
    case 'group-label': {
      const found = new Map<NodeId, PanelNode>();
      for (const memberId of node.memberIds) {
        const panel = panelViaAncestors(nodes, memberId);
        if (panel) found.set(panel.id, panel);
      }
      return sortByReadingOrder(nodes, [...found.values()], rowToleranceMm);
    }
    default: {
      const panel = panelViaAncestors(nodes, id);
      return panel ? [panel] : [];
    }
  }
}

/** The one panel a node belongs to, or null when that is none or several. */
export function panelOwning(nodes: NodeMap, id: NodeId): PanelNode | null {
  const panels = panelsOwning(nodes, id);
  return panels.length === 1 ? panels[0]! : null;
}

/**
 * `addPanel`'s own default name, which is a *number* — so a panel nobody
 * renamed would otherwise read "Panel a — Panel 3", pairing the letter it is
 * known by with a counter it is not.
 *
 * A heuristic, and safe as one because it is display-only and its false
 * positive is the better string anyway: a panel genuinely named "Panel 7"
 * shows as "Panel a", which is what the figure calls it.
 */
const AUTO_PANEL_NAME = /^Panel \d+$/;

/**
 * What a panel is called, everywhere it is named: the Layers banner, the
 * Inspector heading, the Stats dropdown, the Data tab's "used by".
 *
 * Letter first, because that is what is drawn on the figure and what a legend
 * refers to. One spelling, so the four surfaces cannot drift.
 */
export function panelTitle(panel: PanelNode): string {
  const named = panel.name.trim();
  const informative = named.length > 0 && !AUTO_PANEL_NAME.test(named);
  if (!panel.label) return informative ? named : panel.name;
  return informative ? `Panel ${panel.label} — ${named}` : `Panel ${panel.label}`;
}

/** Short form for running text: "panel a", or the title when it has no letter. */
export function panelShortTitle(panel: PanelNode): string {
  return panel.label ? `panel ${panel.label}` : panelTitle(panel);
}

export interface PanelGroup {
  panel: PanelNode;
  /** Everything belonging to it, the panel itself excluded. */
  nodes: FigureNode[];
}

export interface PanelGrouping {
  groups: PanelGroup[];
  /** Nodes belonging to no panel: page-level text, arrows, shapes, groups. */
  unassigned: FigureNode[];
}

/**
 * The whole figure partitioned by panel, in reading order.
 *
 * **An exact partition**: every node lands in exactly one bucket. A group title
 * spanning two panels is listed under the first of them only — `panelsOwning`
 * still reports both, which is what a row's subtitle and the Data tab read, but
 * a list that showed one heading twice would be a worse answer than a list that
 * puts it somewhere definite.
 *
 * Read by the Layers list and by the Inspector's navigator, so the two cannot
 * disagree about what belongs where.
 */
export function groupNodesByPanel(
  nodes: NodeMap,
  rowToleranceMm = ROW_TOLERANCE_MM,
): PanelGrouping {
  const panels = panelsInReadingOrder(nodes, rowToleranceMm);
  const groups = new Map<NodeId, PanelGroup>(
    panels.map((panel) => [panel.id, { panel, nodes: [] }]),
  );
  const unassigned: FigureNode[] = [];

  for (const node of Object.values(nodes)) {
    if (isPanel(node)) continue;
    const owner = panelsOwning(nodes, node.id, rowToleranceMm)[0];
    const group = owner ? groups.get(owner.id) : undefined;
    if (group) group.nodes.push(node);
    else unassigned.push(node);
  }

  return { groups: [...groups.values()], unassigned };
}

/**
 * Every panel, in the order the page reads — which is the order `relabelPanels`
 * assigned their letters in.
 *
 * The rank a caller needs to list several panels' letters in the right order,
 * since `a`…`z`, `aa` does not sort lexicographically past 26 panels.
 */
export function panelsInReadingOrder(
  nodes: NodeMap,
  rowToleranceMm = ROW_TOLERANCE_MM,
): PanelNode[] {
  return sortByReadingOrder(nodes, Object.values(nodes).filter(isPanel), rowToleranceMm);
}

/**
 * Panels sorted the way the page reads. Sorted on `absoluteFrame` via
 * `readingOrder`'s own comparator, so a panel inside a group lands where the
 * page puts it rather than where its group-local origin happens to fall.
 */
function sortByReadingOrder(
  nodes: NodeMap,
  panels: readonly PanelNode[],
  rowToleranceMm: number,
): PanelNode[] {
  return panels
    .map((panel) => ({ panel, frame: absoluteFrame(nodes, panel.id) ?? panel.frame }))
    .sort((a, b) => compareReadingOrder(a.frame, b.frame, rowToleranceMm))
    .map((entry) => entry.panel);
}
