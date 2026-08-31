import { applyAutoLayout, deleteNode, relabelPanels, type NodeId } from '@figureforge/doc-model';
import { reflowBrackets } from '@figureforge/render';
import type { Theme } from '@figureforge/theme';
import type { DocumentApi } from './useDocument.js';

/**
 * Delete a selection of nodes and, if any panel disappeared (directly, or as
 * a cascade side-effect of deleting a group that contained one), close the
 * gap: re-pack the grid, re-letter in reading order, and put brackets back —
 * exactly what every panel-adding action already does after changing panel
 * count. A panel count comparison (rather than checking whether a deleted id
 * is itself a panel) is what catches the group-cascade case.
 */
export function deleteNodesWithLayout(api: DocumentApi, theme: Theme, ids: readonly NodeId[]): void {
  if (ids.length === 0) return;

  api.commit('Delete', (draft) => {
    const panelCountBefore = Object.values(draft.nodes).filter((n) => n.type === 'panel').length;

    for (const id of ids) deleteNode(draft, id);

    // A deleted plot leaves its brackets pointing at nothing; drop them too
    // so a deleted panel's debris does not linger visually.
    for (const node of Object.values(draft.nodes)) {
      if (node.type !== 'bracket') continue;
      if (node.plotId != null && !draft.nodes[node.plotId]) delete draft.nodes[node.id];
    }

    const panelCountAfter = Object.values(draft.nodes).filter((n) => n.type === 'panel').length;
    if (panelCountAfter === panelCountBefore) return;

    applyAutoLayout(draft, {
      marginMm: theme.spacing.marginMm,
      gutterMm: theme.spacing.panelGutterMm,
      labelGutterMm: 4,
    });
    relabelPanels(draft, api.newId, {
      uppercase: theme.panelLabelCase === 'upper',
      fontSizePt: theme.type.panelLabelPt,
      offsetMm: 4,
    });
    reflowBrackets(draft, theme);
  });
}
