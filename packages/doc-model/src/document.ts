/**
 * The FigureDocument: the complete, self-describing state of one figure.
 *
 * Everything needed to reproduce the figure lives here — raw data, analysis
 * requests and results, layout, styling and annotations. Nothing about the
 * rendered output is stored; rendering is a pure function of this document.
 */

import type { Analysis } from './analysis.js';
import type { Dataset } from './data.js';
import type { DisplayUnit } from './units.js';
import { isEffectivelyLocked } from './nodes.js';
import type { AssetId, FigureNode, LayerId, NodeId, NodeMap } from './nodes.js';

/** Bumped whenever a migration is required to read older files. */
export const SCHEMA_VERSION = 1;

export interface Page {
  widthMm: number;
  heightMm: number;
  /** Journal preset id from the theme package, or null for custom dimensions. */
  presetId: string | null;
  /** Unit shown in the UI. Purely presentational; geometry stays in mm. */
  displayUnit: DisplayUnit;
  background: string;
}

export interface Layer {
  id: LayerId;
  name: string;
  locked: boolean;
  hidden: boolean;
  /** Draw order; low draws first. */
  z: number;
}

export interface GridSettings {
  spacingMm: number;
  /** Snap is on by default, per the publication-design brief. */
  snap: boolean;
  visible: boolean;
  /** Show smart alignment guides against sibling edges and centres. */
  smartGuides: boolean;
  /** Snap radius in millimetres. */
  toleranceMm: number;
}

/** A binary attachment (micrograph, blot, logo) stored inside the archive. */
export interface Asset {
  id: AssetId;
  filename: string;
  mimeType: string;
  /** Path inside the .figureforge archive. */
  path: string;
  byteLength: number;
  naturalPx: { width: number; height: number } | null;
}

export interface FigureDocument {
  schemaVersion: number;
  id: string;
  title: string;
  page: Page;
  /** Theme id, with optional per-document overrides applied on top. */
  themeId: string;
  themeOverrides: Record<string, unknown>;
  datasets: readonly Dataset[];
  analyses: readonly Analysis[];
  assets: readonly Asset[];
  layers: readonly Layer[];
  nodes: NodeMap;
  grid: GridSettings;
  createdAt: string;
  modifiedAt: string;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export const defaultGrid = (): GridSettings => ({
  spacingMm: 1,
  snap: true,
  visible: false,
  smartGuides: true,
  toleranceMm: 0.5,
});

/** The layer stack the brief calls for, in draw order. */
export const DEFAULT_LAYERS: readonly Omit<Layer, 'id'>[] = [
  { name: 'Images', locked: false, hidden: false, z: 0 },
  { name: 'Graphs', locked: false, hidden: false, z: 1 },
  { name: 'Annotations', locked: false, hidden: false, z: 2 },
  { name: 'Statistics', locked: false, hidden: false, z: 3 },
  { name: 'Labels', locked: false, hidden: false, z: 4 },
];

export interface CreateDocumentOptions {
  title?: string;
  widthMm?: number;
  heightMm?: number;
  presetId?: string | null;
  displayUnit?: DisplayUnit;
  themeId?: string;
  /** Injected so documents can be created deterministically in tests. */
  idFactory?: () => string;
  now?: () => string;
}

export function createDocument(options: CreateDocumentOptions = {}): FigureDocument {
  const newId = options.idFactory ?? createIdFactory();
  const timestamp = (options.now ?? (() => new Date().toISOString()))();

  const layers: Layer[] = DEFAULT_LAYERS.map((layer) => ({ ...layer, id: newId() }));

  return {
    schemaVersion: SCHEMA_VERSION,
    id: newId(),
    title: options.title ?? 'Untitled figure',
    page: {
      widthMm: options.widthMm ?? 183,
      heightMm: options.heightMm ?? 120,
      presetId: options.presetId ?? 'nature-double',
      displayUnit: options.displayUnit ?? 'mm',
      background: '#ffffff',
    },
    themeId: options.themeId ?? 'nature',
    themeOverrides: {},
    datasets: [],
    analyses: [],
    assets: [],
    layers,
    nodes: {},
    grid: defaultGrid(),
    createdAt: timestamp,
    modifiedAt: timestamp,
  };
}

/** Monotonic id source. Prefixed so ids are readable in saved JSON. */
export function createIdFactory(prefix = 'n'): () => string {
  let counter = 0;
  return () => `${prefix}${(++counter).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export const findDataset = (doc: FigureDocument, id: string): Dataset | undefined =>
  doc.datasets.find((d) => d.id === id);

export const findAnalysis = (doc: FigureDocument, id: string): Analysis | undefined =>
  doc.analyses.find((a) => a.id === id);

export const findAsset = (doc: FigureDocument, id: string): Asset | undefined =>
  doc.assets.find((a) => a.id === id);

export const findLayer = (doc: FigureDocument, id: string): Layer | undefined =>
  doc.layers.find((l) => l.id === id);

export const layerByName = (doc: FigureDocument, name: string): Layer | undefined =>
  doc.layers.find((l) => l.name === name);

/**
 * Locked by the node, an ancestor, *or* its layer.
 *
 * `isEffectivelyLocked` only sees the node map, so it could never consult the
 * layer — which made the Layers panel's padlock inert: a "locked" layer's nodes
 * could still be dragged, nudged and deleted. Anything holding the whole
 * document should ask this instead.
 */
export function isLocked(doc: FigureDocument, id: NodeId): boolean {
  const node = doc.nodes[id];
  if (!node) return true;
  if (findLayer(doc, node.layerId)?.locked) return true;
  return isEffectivelyLocked(doc.nodes, id);
}

/**
 * Compare two siblings by the order they are drawn in.
 *
 * Top-level nodes are ordered by `layer.z` and then their own `z`: layers give
 * the Illustrator-style global stacking (all labels above all graphs), and `z`
 * orders siblings within that. A parent's children carry no layer term at all —
 * they are drawn in plain `z` order inside their parent's group.
 *
 * Exported because two places need this one answer: the renderer draws in it and
 * `reorderNode` moves a node through it. A second copy is how they came to
 * disagree about where "the back" is — "send to back" renumbered `z` alone and
 * left a rectangle at the floor of the Annotations layer, still drawn over every
 * graph beneath it.
 */
export function compareDrawOrder(doc: FigureDocument, a: FigureNode, b: FigureNode): number {
  if (a.parentId !== null || b.parentId !== null) return a.z - b.z;
  const za = findLayer(doc, a.layerId)?.z ?? 0;
  const zb = findLayer(doc, b.layerId)?.z ?? 0;
  return za - zb || a.z - b.z;
}

/** All nodes assigned to a layer, in draw order. */
export function nodesInLayer(doc: FigureDocument, layerId: LayerId): FigureNode[] {
  return Object.values(doc.nodes)
    .filter((n) => n.layerId === layerId)
    .sort((a, b) => a.z - b.z);
}

/*
 * `panelsOf` was here, and is deliberately gone. It sorted on raw `frame`, so a
 * panel inside a group sorted by its group-local origin rather than by where it
 * sits on the page — the defect round 42 fixed in `readingOrder`, sitting
 * unused and waiting for its first caller. It had none anywhere in `packages`,
 * `apps` or `scripts`, and no test. `readingOrder` (layout.ts) is the answer it
 * was reaching for.
 */

/**
 * Next z within a parent. Panels and their contents are ordered independently,
 * so this is scoped to siblings rather than global.
 */
export function nextZ(nodes: NodeMap, parentId: NodeId | null): number {
  const siblings = Object.values(nodes).filter((n) => n.parentId === parentId);
  return siblings.length === 0 ? 0 : Math.max(...siblings.map((n) => n.z)) + 1;
}
