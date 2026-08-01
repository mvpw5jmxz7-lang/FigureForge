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

/** All nodes assigned to a layer, in draw order. */
export function nodesInLayer(doc: FigureDocument, layerId: LayerId): FigureNode[] {
  return Object.values(doc.nodes)
    .filter((n) => n.layerId === layerId)
    .sort((a, b) => a.z - b.z);
}

export function panelsOf(doc: FigureDocument): Extract<FigureNode, { type: 'panel' }>[] {
  return Object.values(doc.nodes)
    .filter((n): n is Extract<FigureNode, { type: 'panel' }> => n.type === 'panel')
    .sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
}

/**
 * Next z within a parent. Panels and their contents are ordered independently,
 * so this is scoped to siblings rather than global.
 */
export function nextZ(nodes: NodeMap, parentId: NodeId | null): number {
  const siblings = Object.values(nodes).filter((n) => n.parentId === parentId);
  return siblings.length === 0 ? 0 : Math.max(...siblings.map((n) => n.z)) + 1;
}
