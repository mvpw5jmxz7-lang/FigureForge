/**
 * What it costs to place N point labels on a volcano plot.
 *
 * `MAX_POINT_LABELS` (25) is a default rather than a limit —
 * `PlotNode.pointLabelLimit` raises it per plot — so the override needs a
 * ceiling, and a ceiling asserted rather than measured is exactly the kind of
 * claim this project refuses. This script is where `MAX_POINT_LABEL_CEILING`
 * comes from; re-run it if the placement engine changes.
 *
 * Two measurements, because they answer different questions:
 *
 *   1. `layoutPointLabels` alone — the placement engine, at a realistic
 *      obstacle count. This is the part whose cost grows with the label count.
 *   2. `placedPointLabelsForPlot` end to end — what the canvas actually pays,
 *      including `computePlotGeometry`. `Canvas.tsx` renders the document
 *      unmemoised and this runs on top of it, so this is an *interaction
 *      frame* cost, not a one-off paint. That is why the budget is ~100 ms,
 *      the same threshold `MAX_VECTOR_POINTS` was measured against.
 *
 * The candidates are spread across the whole plot on purpose. A clustered
 * selection is the cheap case: `resolvePointLabels` pre-filters the point
 * cloud to a bounding box around the candidates, so a tight cluster excludes
 * most of the obstacles. Spreading them is what makes that filter admit nearly
 * the whole cloud, which is the case the ceiling has to survive.
 *
 * Run:  podman exec -w /app figureforge-web npx vite-node scripts/point-label-cost.ts
 */

import {
  addPanelWithPlot,
  addDataset,
  createDocument,
  createIdFactory,
  editDocument,
  updateNode,
  type Dataset,
  type FigureDocument,
} from '@figureforge/doc-model';
import { layoutPointLabels, placedPointLabelsForPlot, type LabelCandidate } from '@figureforge/render';
import { NATURE_THEME } from '@figureforge/theme';

/** A real gene list. The upper end of what a differential export carries. */
const POINTS = 10_000;
const LABEL_COUNTS = [25, 50, 100, 150, 200, 300, 400, 600, 800, 1200];
/** The interactivity budget. See the header. */
const BUDGET_MS = 100;

/** Deterministic, so two runs of this script are comparable. Same generator
 *  the renderer's own seeded jitter uses, for the same reason. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A gene list shaped like a real one, which matters more than it sounds.
 *
 * A first version of this script drew both the cloud and the candidates from a
 * uniform distribution over the plot. That places *nothing* — every position is
 * blocked by a neighbouring marker — and so it measured `fits()` short-circuiting
 * on its first obstacle rather than the cost of actually placing a label. A real
 * volcano is a dense blob of null genes at low `-log10(p)` around zero fold
 * change, with the significant genes sparse out in the wings and up the top:
 * the labelled points sit in the *sparse* region, where `fits()` has to scan
 * the whole obstacle list before it can return true. That is the expensive
 * case, and it is also the only one that draws anything.
 *
 * Null p-values are uniform by construction, so `-log10(p)` for the null genes
 * falls out exponentially without being imposed.
 */
function volcanoRows(rows: number): { fc: number; p: number }[] {
  const r = mulberry32(20260908);
  const normal = (): number =>
    Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
  return Array.from({ length: rows }, () => {
    const regulated = r() < 0.03;
    if (regulated) {
      return { fc: (r() < 0.5 ? -1 : 1) * (1.5 + r() * 4), p: Math.pow(10, -(3 + r() * 9)) };
    }
    return { fc: normal() * 0.45, p: Math.max(1e-12, r()) };
  });
}

/** Median of several runs — a single timing on a shared container is noise. */
function timeMs(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

// ---------------------------------------------------------------------------
// 1. The placement engine on its own
// ---------------------------------------------------------------------------

/** A typical volcano panel's plot area at the sizes smart layout produces. */
const PLOT_W = 80;
const PLOT_H = 60;
const POINT_RADIUS = 0.6;

/** The rows projected into plot-area millimetres, the way the geometry maps
 *  them: fold change across, `-log10(p)` up, each axis scaled to its extremes. */
const rows = volcanoRows(POINTS);
const negLog = rows.map((row) => -Math.log10(row.p));
const fcMax = Math.max(...rows.map((row) => Math.abs(row.fc)));
const yMax = Math.max(...negLog);
const projected = rows.map((row, i) => ({
  x: ((row.fc + fcMax) / (2 * fcMax)) * PLOT_W,
  // Plot-local y grows downward, so the most significant point is at y = 0.
  y: PLOT_H - (negLog[i]! / yMax) * PLOT_H,
  rank: negLog[i]!,
  text: `GENE${i}`,
}));

/** Most significant first — the order `volcanoLabelCandidates` itself imposes,
 *  so the labelled set here is the one an author would really end up with. */
const bySignificance = [...projected].sort((a, b) => b.rank - a.rank);

const cloud = projected.map((p) => ({ x: p.x, y: p.y }));

function candidatesSpread(count: number): LabelCandidate[] {
  return bySignificance.slice(0, count).map((p) => ({
    x: p.x,
    y: p.y,
    text: p.text,
    color: '#d73027',
  }));
}

console.log(`\nlayoutPointLabels — ${POINTS} obstacle points, ${PLOT_W}x${PLOT_H} mm plot\n`);
console.log('  labels    ms   placed  dropped');
for (const count of LABEL_COUNTS) {
  const candidates = candidatesSpread(count);
  let placedCount = 0;
  const ms = timeMs(5, () => {
    const { placed } = layoutPointLabels(candidates, {
      fontSizePt: 6,
      plotWidth: PLOT_W,
      plotHeight: PLOT_H,
      pointRadiusMm: POINT_RADIUS,
      maxLabels: count,
      otherPointsMm: cloud,
    });
    placedCount = placed.length;
  });
  const flag = ms > BUDGET_MS ? '  <- over budget' : '';
  console.log(
    `  ${String(count).padStart(6)}  ${ms.toFixed(1).padStart(6)}  ${String(placedCount).padStart(6)}  ${String(count - placedCount).padStart(7)}${flag}`,
  );
}

// ---------------------------------------------------------------------------
// 2. End to end, the way the canvas pays for it
// ---------------------------------------------------------------------------

function differentialDataset(): Dataset {
  return {
    id: 'ds-volcano',
    name: 'Differential',
    format: 'differential',
    columns: [
      { name: 'Feature', kind: 'text' },
      { name: 'log2FoldChange', kind: 'number' },
      { name: 'pValue', kind: 'number' },
    ],
    rows: rows.map((row, i) => [`GENE${i}`, row.fc, row.p]),
    sourcePath: null,
    sourceFilename: null,
    importedAt: new Date(0).toISOString(),
  };
}

function volcanoDocument(labelCount: number): FigureDocument {
  const newId = createIdFactory();
  let doc = createDocument({ idFactory: newId });
  const dataset = differentialDataset();

  doc = editDocument(doc, (draft) => {
    addDataset(draft, dataset);
    const { plot } = addPanelWithPlot(draft, newId, {
      frame: { x: 10, y: 10, width: 100, height: 80 },
      datasetId: dataset.id,
      plotType: 'volcano',
    });
    // The most significant genes — which is both what an author labels and
    // the order `volcanoLabelCandidates` truncates in, so the set here is the
    // set the real path would keep.
    const labels = bySignificance.slice(0, labelCount).map((p) => p.text);
    updateNode(draft, plot.id, { volcanoLabels: labels, pointLabelLimit: labelCount });
  });
  return doc;
}

console.log(`\nplacedPointLabelsForPlot — end to end, ${POINTS}-row differential table\n`);
console.log('  labels    ms    drawn');
for (const count of LABEL_COUNTS) {
  const doc = volcanoDocument(count);
  const plot = Object.values(doc.nodes).find((n) => n.type === 'plot');
  if (!plot || plot.type !== 'plot') throw new Error('no plot');
  let drawn = 0;
  const ms = timeMs(5, () => {
    drawn = placedPointLabelsForPlot(plot, doc, NATURE_THEME).length;
  });
  const flag = ms > BUDGET_MS ? '  <- over budget' : '';
  console.log(
    `  ${String(count).padStart(6)}  ${ms.toFixed(1).padStart(6)}  ${String(drawn).padStart(6)}${flag}`,
  );
}
console.log(`\nBudget: ${BUDGET_MS} ms per interaction frame.\n`);
