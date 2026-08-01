/**
 * Scene tree → React elements.
 *
 * The live-canvas adapter. The scene stores SVG attributes in their canonical
 * hyphenated spelling, which is what the export serialiser writes verbatim;
 * React wants the camelCase form of the same attributes and warns otherwise,
 * so names are converted here and nowhere else. `parity.test.tsx` asserts both
 * adapters still emit byte-identical markup.
 */

import { createElement, type ReactElement } from 'react';
import type { SceneAttrs, SceneNode } from './scene.js';
import { round } from './scene.js';

/** `stroke-width` → `strokeWidth`. Left alone: data-*, aria-*, namespaced. */
function toReactAttrName(name: string): string {
  if (!name.includes('-')) return name;
  if (name.startsWith('data-') || name.startsWith('aria-') || name.includes(':')) return name;
  return name.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

export interface ReactAdapterOptions {
  /** Called with the originating document node id when an element is clicked. */
  onNodePointerDown?: (nodeId: string, event: React.PointerEvent) => void;
  /**
   * Called when a selection resize handle is grabbed. Handles are chrome, drawn
   * only when `chrome.selectedIds` is set, so the export path never sees them.
   */
  onHandlePointerDown?: (nodeId: string, handle: string, event: React.PointerEvent) => void;
  /** Called on double-click, for editing a text node in place. */
  onNodeDoubleClick?: (nodeId: string, event: React.MouseEvent) => void;
  /** Ids to mark as selected, exposed via a data attribute for styling. */
  selectedIds?: ReadonlySet<string>;
}

function toReactProps(
  node: SceneNode,
  key: string,
  options: ReactAdapterOptions,
): Record<string, unknown> {
  const props: Record<string, unknown> = { key };

  for (const [name, value] of Object.entries((node.attrs ?? {}) as SceneAttrs)) {
    if (value === undefined) continue;
    props[toReactAttrName(name)] = typeof value === 'number' ? round(value) : value;
  }

  if (node.nodeId) {
    const id = node.nodeId;
    props['data-node-id'] = id;
    if (options.selectedIds?.has(id)) props['data-selected'] = 'true';

    // A resize handle carries the id of the node it resizes, so it must claim
    // the event before the plain selection path treats it as a click on that
    // node — otherwise grabbing a corner would start a move, not a resize.
    const handle = node.attrs?.['data-handle'];
    if (handle !== undefined && options.onHandlePointerDown) {
      props['onPointerDown'] = (event: React.PointerEvent) => {
        event.stopPropagation();
        options.onHandlePointerDown?.(id, String(handle), event);
      };
    } else if (options.onNodePointerDown) {
      props['onPointerDown'] = (event: React.PointerEvent) => {
        // Stop the parent panel from also claiming the event, so clicking a
        // bar selects the bar's node rather than the whole panel.
        event.stopPropagation();
        options.onNodePointerDown?.(id, event);
      };
    }

    if (options.onNodeDoubleClick) {
      props['onDoubleClick'] = (event: React.MouseEvent) => {
        event.stopPropagation();
        options.onNodeDoubleClick?.(id, event);
      };
    }
  }

  if (node.role) props['data-role'] = node.role;

  return props;
}

export function toReact(node: SceneNode, options: ReactAdapterOptions = {}, key = '0'): ReactElement {
  const props = toReactProps(node, key, options);
  const children = node.children ?? [];

  const rendered: (ReactElement | string)[] = [];
  if (node.text !== undefined && node.text !== '') rendered.push(node.text);
  children.forEach((child, i) => rendered.push(toReact(child, options, `${key}.${i}`)));

  return createElement(node.tag, props, rendered.length > 0 ? rendered : undefined);
}
