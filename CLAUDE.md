# FigureForge — working context

Publication-ready multi-panel figure assembly for life-science journals: the
layout control of Illustrator, the plotting of Prism, and reproducibility that
neither offers.

Requirements source of truth: [`build-a-nature-style-platform.md`](build-a-nature-style-platform.md).
That spec describes a multi-year product surface (30+ chart types, omics compute,
Electron, an AI layout assistant). It was deliberately cut to one complete
vertical slice — data in, publication-ready vector out — so the architecture
could be proven before breadth was added. **Phases 1–7 are done — six rounds of
reported fixes, the DOM-volume mechanism phase 7 needed first, and all five of
phase 7's chart types (volcano plots, heatmaps, survival curves, PCA, UMAP) —
plus a seventh round adding volcano point labels, cascade/offset line plots,
scientific axis label formatting (including a symlog scale), and
save-to-disk with directory selection and a `.ffg` extension, an eighth
round adding volcano label dragging with an auto-following leader, an
axis-range clipping toggle, and a cascade plot's schematic depth (z) axis,
and a ninth round adding sign-aware centred tick labels, a full rectangular
plot border, and — for a cascading line plot — a true 3D-oblique reference
grid with configurable colour/style and a second copy of the axes standing
on its back plane, and a tenth round adding Shift-constrained square
resizing and 45° arrow aiming, node rotation (a free grip plus an Inspector
field, snapping to 45° with Shift), click-to-edit axis titles on the canvas,
Delete-to-clear in the data grid, and eleven more layout templates including
a vertical stack at every panel count. Phase 8 has begun: stage 1 puts the
app in an Electron shell that owns the Python service as a supervised child
process — free-port allocation, health-gated startup, backoff restarts,
SIGTERM→SIGKILL teardown, and a watchdog on the Python side that reaps itself
if the shell is SIGKILLed. Stage 2 adds native Open/Save dialogs, a
File/Edit/View/Help menu, a recent-projects list, an unsaved-changes guard on
quit, and drag-a-project-onto-the-window — with every path the renderer may
touch fenced to ones the shell itself produced. Stage 3 streams the project
archive to and from disk instead of building it whole in memory, on the browser
as well as the desktop: measured, a 200 MB figure's save peak fell from 526 MB
to 337 MB. Packaging is stage 4 and is not started. Phase 9 is not started.**

---

## Running it

Everything runs in containers. **The host has no Node and no Python scientific
stack** — never run `npm` or `pytest` on the host, run them inside the containers
(the Makefile targets already do).

```bash
make up          # build images, start the pod
                 #   web -> http://localhost:5173
                 #   api -> http://localhost:8000/health
make test        # 789 TypeScript + 152 Python tests
make acceptance  # 46-check end-to-end run (needs `make up` first)
make down

make desktop        # launch the Electron shell against the dev server
make desktop-smoke  # drive that shell headlessly, 21 checks
```

`make help` lists all 18 targets. The two `desktop` targets build a separate,
heavier image (`make build-desktop`, based on the API image so the shell has a
real Python to supervise) and are not needed for ordinary web work.

The dev environment is a rootless podman **pod**, so both containers share one
network namespace and the web app reaches the API on plain `localhost:8000`.
`compose.yaml` exists for anyone on Docker proper (there, the API is a separate
host, hence `VITE_API_URL`).

---

## Architecture, and why

The reasoning matters more than the structure — it is what stops a later session
undoing a deliberate choice.

### The one commitment

The spec asked for both a Matplotlib backend *and* SVG-native rendering. These
are incompatible: Matplotlib emits `<path>` soup inside clip groups, so you
cannot click an axis label to edit it, cannot enforce typography across panels,
and cannot guarantee the export matches the screen.

> **The figure is one SVG document, rendered from a typed JSON model by
> isomorphic TypeScript. Python receives numbers and returns numbers — never
> pixels.**

Export runs *the same renderer* headless, so WYSIWYG is structural rather than
maintained by hand.

### Invariants — do not break these

- **`packages/render` must never import the DOM.** This is what keeps canvas and
  export identical; a DOM import breaks export fidelity silently.
  `packages/render/src/parity.test.tsx` holds both output adapters to identical
  markup and will fail if they drift.
- **Millimetres internally**, emitted 1:1 as viewBox units
  (`width="183mm" viewBox="0 0 183 75"`). Journal widths need no conversion and
  PDFs come out at exact physical size. Type sizes are the deliberate exception —
  stored in **points**, because journals specify them that way ("panel labels
  8 pt bold"), converted at render.
- **Rendering is a pure function of the document.** Anything that varies per
  render (jitter) must be seeded — `marks.ts` uses `mulberry32` keyed off the
  node id, or the export would not match the screen.
- **`doc-model` imports nothing internal**, so anything needing measured plot
  geometry takes it as a *parameter* (`PlotMeasurements`), never by importing
  `measurePlot`. `render` depends on `doc-model`; the reverse would be a cycle.
  `measureAllPlots` in `render-document.ts` is the bridge callers use.
- **Layout decisions taken inside the renderer must be deterministic and
  DOM-free.** Tick-label collision handling measures text with the static tables
  in `text-width.ts` rather than `getComputedTextLength`, so the canvas and the
  headless exporter reach the *same* decision. Measuring in the browser would
  put angled labels on screen and overlapping ones in the PDF.

### Package split

```
packages/doc-model/   model, zod schema, undo/redo, layout, operations, .ffg I/O
                      (archive.ts whole-buffer, archive-stream.ts chunked)
packages/theme/       journal presets, palettes, colour-vision validation
packages/plots/       scales, summary statistics, mark geometry   ← maths only
packages/render/      scene tree → {React | SVG string}, quality checker  ← drawing only
apps/web/             Vite + React canvas, inspectors, import/export UI
apps/desktop/         Electron shell: main process, preload bridge, sidecar supervisor,
                      native dialogs and the application menu
services/api/         FastAPI: SciPy statistics, Chromium/Ghostscript export, TIFF decoding
scripts/acceptance.ts end-to-end flow, no UI involved
scripts/desktop-smoke.mjs  drives the real Electron app over CDP
scripts/archive-memory.ts  peak-RSS A/B for the archive writer
```

`apps/desktop` depends on **nothing internal** — not even `apps/web`. It hosts
the web app as a URL and supervises the service as a process, so neither the
renderer nor the packages know they are inside a shell. That is what keeps the
browser build a first-class target rather than a degraded one.

**`plots` computes numbers and `render` draws them.** That split is why the plot
maths is testable against exact expected values, and why there is no dependency
cycle between the two. If drawing logic starts appearing in `plots`, or scale
maths in `render`, the split is being eroded.

`doc-model` depends on nothing internal. `theme` and `plots` depend on
`doc-model`. `render` depends on all three. Keep it that way.

### Model choices

- **Flat node map keyed by id, each with a `parentId`** — not a nested tree.
  Immutable updates touch one entry; reparenting and z-reordering never
  restructure anything.
- **Edits go through Immer `produceWithPatches`** (`store.ts`), so undo/redo,
  version history and incremental autosave are one mechanism, not three.
  Use `editDocument()` to mutate outside the store — it confines the readonly cast.
- **`.figureforge` is a zip**, not one big JSON: micrographs are the bulk of a real
  figure's bytes and base64-ing TIFFs into JSON is untenable. `data/` holds the
  **verbatim** original imports, byte for byte — that is what makes the
  reproducibility claim real. Each analysis stores an `inputHash` so a figure can
  never silently display a p-value its data no longer supports.
  A table edited in the data grid does not weaken this: the edited cells travel
  in `document.json` while `data/` keeps the bytes that arrived, and
  `Dataset.editedAt` is what tells them apart. Both are kept, and they are
  distinguishable — which is the property the claim actually needs.

### Plot type choices

- **`PlotGeometry` is a discriminated union on `kind`, not one shape with
  optional fields.** The categorical arm carries `band`/`marks`/`categories`
  plus `axisBand`/`axisCategories`/`legend`; the continuous arm carries
  `xScale`/`series`/`bins`. Almost nothing is shared, and
  optional fields would let a categorical-only assumption compile against a
  scatter — which is exactly how the unimplemented types went unnoticed.
- **A plot type the data cannot support is withheld, never approximated.**
  `typesFor` gates the dropdown; `continuousGeometry` returns null. There is no
  row-index fallback for a scatter without x: it would draw a confident-looking
  relationship that was never measured.
- **Brackets are refused on continuous plots rather than placed approximately.**
  `measurePlot` returns empty measurements — `PlotMeasurements` keeps its
  category-keyed shape, so `repositionBrackets` in `doc-model` needed no change —
  and the Stats tab disables group comparisons with a reason.
- **The numeric x axis thins labels by width, mirroring the y axis's height
  rule**, and both measure through `text-width.ts`. Measuring in the browser
  would thin labels on screen and leave them overlapping in the export.
  End labels anchor `start`/`end` inward: the theme reserves 2 mm to the right of
  the plot, so a centred last label overhangs the panel and then the page.
- **A histogram's count axis steps by whole numbers.** The generic tick chooser
  labels a histogram peaking at 3 as 0, 0.5, 1, 1.5 — half an observation.

### Statistics choices

Each guards against a specific, common reporting error:

- **Significance annotations read the *adjusted* p-value.** Starring uncorrected
  p-values on a multi-comparison figure is one of the most frequent statistical
  errors in published figures.
- **Effect sizes always returned, with Hedges' correction** — at n = 3–6, plain
  Cohen's *d* noticeably overstates the effect.
- **Confidence intervals use the t distribution.** At n = 3 the correct
  multiplier is 4.303, not 1.96; the 1.96 shortcut badly understates the interval.
- **Fisher's exact test is refused above 2×2.** SciPy has no exact r×c test,
  and approximating the one test whose whole purpose is exactness would be
  worse than declining. Its odds ratio is SciPy's sample estimate, not R's
  conditional MLE — a documented difference, not a discrepancy.
- **Tests are verified against externally published values** — Student's 1908
  sleep data and R's documented output for `t.test`, `aov`, `cor.test`,
  `chisq.test`, `wilcox.test`, `fisher.test`, and statsmodels' own documented
  `AnovaRM` example — not against numbers this code produced itself. Spearman is the one
  exception: R's `cor.test` computes an exact permutation p-value (AS 89) that
  SciPy's t-approximation genuinely does not reproduce at low n, so that test
  asserts against SciPy's own reproducible output and says so in a comment
  rather than pretending to match R.
- **One analysis per plot.** Re-running a test replaces the previous result and
  its brackets (`replaceAnalysisForPlot` + `removeBracketsForPlot`) rather than
  appending. Accumulating them stacked new brackets at the same heights as the
  old, since the placement gap restarts each run.
- **A violin over three replicates is flagged.** Kernel density turns three
  numbers into a smooth, confident-looking distribution the data cannot support;
  box quartiles are unstable below about n = 5. `checkDistributionSampleSize` in
  `quality.ts` warns on both. It is a warning, not a fix — which mark to use
  instead is the author's call.
- **The violin KDE is trimmed to the observed range.** Drawn a bandwidth past the
  extremes, as is conventional, it tapers into values that were never measured
  and a reader takes the taper for data.
- **The stored input hash is composed in exactly one place**, `analysisInputHash`.
  Composing it per call site is how a stored hash and a recomputed one come to
  disagree over nothing, which surfaces as "the data changed" on an untouched
  figure — that bug was live in the acceptance script.

---

## Current state

Phases 1–6 are on `master`, plus **six** rounds of reported bugs and requests.
Round 4 (crop, brackets, the Prism table shapes, the data grid, multi-image
panels) is done — see "Round 4" below. Round 5 covered the import surface in
four merged stages. **Round 6** is six reported bugs across the legend, the
Data tab, the data grid, montage cropping and the selection chrome — all
merged. Run `git status` and `git branch` before assuming the tree is clean or
which branch you're on.

**Verified after phase 8 stage 3 (streaming the archive):** 789 TypeScript
tests, 152 Python tests unchanged, typecheck and lint clean, 46-check
acceptance run unaffected, a 21-check desktop smoke run and a 6-check browser
run. **Measured**: on a 200 MB payload the save peak fell 525.8 → 337.3 MB and
the save-then-open cycle 725.9 → 589.1 MB. See "Phase 8, Stage 3" below.

**Verified after phase 8 stage 2 (native dialogs, the application menu, file
access):** 758 TypeScript tests, 152 Python tests unchanged, typecheck and lint
clean, 46-check acceptance run unaffected, a **19-check desktop smoke run**
(including three checks that an unauthorised path is refused across the IPC
boundary), and an 8-check browser run confirming the web build is inert to all
of it. See "Phase 8, Stage 2" below.

**Verified after phase 8 stage 1 (the Electron shell and its Python sidecar):**
721 TypeScript tests, 152 Python tests, typecheck and lint clean, 46-check
acceptance run unaffected, and a **15-check desktop smoke run** driving the real
Electron app — including a SIGKILL of the shell to prove the Python watchdog
reaps its own orphan. Also fixed a **pre-existing** `RectMm` typecheck error
from round 10 that an incremental build had cached over; round 10's "typecheck
clean" claim was wrong. See "Phase 8, Stage 1" below.

**Verified after round 10 (Shift constraints, rotation, editable axis titles,
cell clearing, more templates):** 706 TypeScript tests, 139 Python tests
unchanged, lint clean, 46-check acceptance run unaffected, and
27 browser checks in each of light and dark — see "Round 10" below. (Its
typecheck claim did not hold; see the line above.)

**Verified after round 9 (sign-aware tick labels, boxed border, 3D cascade
gridlines):** 686 TypeScript tests, 139 Python tests unchanged, typecheck and
lint clean, 46-check acceptance run unaffected — see "Round 9" below.

**Verified after round 8 (volcano label dragging, axis range clipping,
cascade depth axis) — all three stages merged:** 644 TypeScript tests, 139
Python tests unchanged, typecheck and lint clean, 46-check acceptance run
unaffected — see "Round 8" below.

**Verified after round 7 (volcano labels, cascade lines, scientific axes,
save-to-disk) — all six stages merged:** 598 TypeScript tests, 139 Python
tests unchanged, typecheck and lint clean, 46-check acceptance run
unaffected — see "Round 7" below.

**Verified after phase 7 stage 5 (UMAP) — phase 7 is now complete:** 453
TypeScript tests, 139 Python tests, typecheck and lint clean, 46-check
acceptance run unaffected — see "Phase 7, Stage 5 — UMAP" below.

**Verified after phase 7 stage 4 (PCA):** 450 TypeScript tests, 126 Python
tests, typecheck and lint clean, 46-check acceptance run unaffected — see
"Phase 7, Stage 4 — PCA" below.

**Verified after phase 7 stage 3 (survival curves):** 447 TypeScript tests,
111 Python tests, typecheck and lint clean, 46-check acceptance run
unaffected — see "Phase 7, Stage 3 — survival curves" below.

**Verified after phase 7 stage 2 (heatmaps):** 423 TypeScript tests, 105
Python tests, typecheck and lint clean, 46-check acceptance run unaffected —
see "Phase 7, Stage 2 — heatmaps" below.

**Verified after phase 7 stage 1 (volcano plots):** 395 TypeScript tests, 105
Python tests, typecheck and lint clean, 46-check acceptance run unaffected —
see "Phase 7, Stage 1 — volcano plots" below.

**Verified after the DOM-volume mechanism:** 371 TypeScript tests, 105 Python
tests, typecheck and lint clean, 46-check acceptance run — see "Pre-phase-7 —
the DOM-volume mechanism" below.

**Verified after round 6:** 366 TypeScript tests, 105 Python tests, typecheck
and lint clean, 46-check acceptance run.

**Verified after round 5 stage 4:** 357 TypeScript tests, 105 Python tests,
typecheck and lint clean, 46-check acceptance run.

**Verified after round 5 stage 3:** 343 TypeScript tests, 105 Python tests,
typecheck and lint clean, 46-check acceptance run.

**Verified after round 5 stage 2:** 338 TypeScript tests, 105 Python tests,
typecheck and lint clean, 46-check acceptance run (unchanged — the acceptance
script passes its plot types explicitly and its fixtures have fully-named
header rows).

**Verified after round 5 stage 1:** 325 TypeScript tests, 105 Python tests,
typecheck and lint clean, 46-check acceptance run.

**Verified after round 4:** 313 TypeScript tests, 105 Python tests, typecheck
and lint clean, 46-check acceptance run.

**Verified at the end of phase 6:** 265 TypeScript tests, 105 Python tests,
typecheck and lint clean, 43-check acceptance run. Exported PDF confirmed single-page, fonts embedded,
text selectable, exactly 183.0000 × 75.0000 mm with an image XObject embedded;
PNG exactly 300 dpi. The phase 4 surfaces were additionally driven in real
Chromium against the running app — import, scale bars, annotations, crop and
measure — because green tests do not mean the app runs. Phase 5's new paths
(correlation on a scatter plot, repeated-measures ANOVA) were driven the same
way: methods sentence read `F(3, 12) = 24.76, P < 0.001` against the
statsmodels reference dataset, and Pearson on Anscombe's scatter data read
`X vs Y, P = 0.002, r² = 0.67` with no console errors. Stage A was driven the
same way, in **dark mode** (the text-editor bug only appears there): panel
selection, double-click entry, Escape, Delete, grouping, stats following the
selection onto panel b, the non-significant notice, the template control at
4/5/6 panels, an import after a template with no overlap across 7 panels, the
Layers eye, and the editor reading `rgb(232,234,237) on rgb(31,34,39)`. Stage B
likewise: a save named `my-chosen-name.figureforge` from the dialog and adopted
as the title, Ctrl+V and Ctrl+D on a text label and on a whole panel, Send to
back reordering the DOM, and a five-figure-count import with no axis label
outside its panel. Stage C too: two-sided error bars becoming one-sided on
demand, a triangle marker replacing 16 circles on one plot only, minor ticks
12 → 32, inward ticks, a log y axis relabelling, break marks drawn with nothing
at NaN in the gap, a sedimentation-style paste detected as `sigmaplot` and drawn
as two overlaid lines, a right-hand axis, and Fisher's exact on a contingency
import reading `Treated vs Control  P = 0.025, odds ratio 5.57`.

Phase 6 was driven the same way. A 4 pt label reported, fixed by its button,
score 81 → 96, Ctrl+Z restoring both; a deleted panel letter relettered; the
export confirmation naming `"cells.png" is 175 dpi at its current size` and
routing to the Quality tab. A 1200 × 900 micrograph cropped to 30% × 30% took
the export payload from **4234 KB to 438 KB** and still produced a single-page
PDF with fonts embedded and exactly one image XObject. Six concurrent exports
queued through the semaphore without deadlocking.

Round 4 was driven the same way, in both light and **dark** mode. All four of
the PDF's table shapes were pasted into the running app: the Grouped table drew
20 bars over 5 axis labels in 4 colours with a 4-entry legend, the Control /
Treated timecourse drew 2 lines with 2 shaded bands, the nested table clustered
in 2 colours and refused its statistics, and the contingency table drew **four**
bars whose 80/10 heights are in exactly an 8.00 ratio. A one-way ANOVA placed
six brackets at six distinct heights with no label overlap. Dragging the crop
window's SE grip to the middle left exactly half the picture, and one Ctrl+Z
restored it. The data grid opened at 760 px reading `rgb(232,234,237)` on
`rgb(22,24,28)`, and four PNGs made one panel with four tiles at four distinct
positions. The exported PDF stayed single-page at 183.0000 × 75.0000 mm with
fonts embedded, legend text selectable, and **zero** image XObjects — the
translucent band is still vector.

Working end to end: CSV/TSV import with format detection, live preview, an
editable data grid and a user-supplied dataset name →
bar/dot/beeswarm/box/violin/scatter/line/histogram marks with error bars or a
shaded band, over one factor or two, with a legend → Welch's t-test and friends
with corrections and effect sizes → significance brackets placed together on
measured geometry, which follow the plot when it moves → PNG/JPEG/SVG/TIFF image
panels with drag-crop, calibrated scale bars and arrow/shape/text annotations,
several tiled into one panel if wanted → auto-layout with smart guides and
snapping, weighted templates, and drag-resize handles → panel lettering in
reading order → an Inspector for the selected node (colours, text, axis titles,
frame, crop, calibration, tile grid) with double-click-to-edit on canvas →
PDF/EPS/SVG/PNG/TIFF export → Publication Readiness Score → project save/load
with data and images preserved byte for byte.

### Phase 3 — the remaining plot types

All nine `PlotType` variants render. Box and violin dropped into the existing
band-scale machinery; scatter, line and histogram needed a numeric x axis, which
did not exist — see the plot type choices above for the decisions that shaped it.
New: `kernelDensity`/`silvermanBandwidth` in `summary.ts`, `xyMarks`/
`histogramBins`/`histogramMarks` in `marks.ts`, `renderNumericXTicks` and
`continuousGeometry` in `render-document.ts`, `checkDistributionSampleSize` in
`quality.ts`, and `CONTINUOUS_X_PLOT_TYPES` in `nodes.ts` as the one place that
says which types are which.

### Phase 4 — image panels, crop, scale bars, annotations

The node types, their schemas and their renderers already existed; nothing
constructed them and two paths had never been executed. What phase 4 added is
the app layer, plus the fixes that running the scaffolding for the first time
exposed.

- **`renderImage` never rendered its children.** A scale bar is parented to its
  image — that is how `renderScaleBar` finds the calibration — so it drew
  nothing. Found by asserting roles in the parity fixture, not by reading.
- **`scaleBarWidthMm` in `operations.ts` is the single implementation** of the
  calibration arithmetic; `renderScaleBar` calls it. `resyncScaleBars` keeps
  `frame.width` in step, so the selection outline and the eight grips sit on the
  bar rather than beside it — the direct parallel to `repositionBrackets`, called
  from the same places.
- **`normaliseCrop` clamps to a non-zero extent.** The schema allowed `0`, which
  divides by zero in `renderImage` while reading as a *full* frame in
  `checkImageResolution` (`crop.width || 1`) — one document, two answers.
- **`fillPanelChildren`** is shared by `applyAutoLayout` and `resizePanel`, which
  had drifted: auto-layout resized only plots, so a micrograph kept its old size.
- **Asset bytes live outside the document**, in `apps/web/src/assets.ts`.
  `store.ts` records every edit as a patch *and* its inverse, so a micrograph in
  the document would be cloned into the undo history on every unrelated edit.
  Bytes are append-only for the session and never freed on node deletion —
  `deleteNode` does not touch `draft.assets`, so undo can resurrect the node, and
  a revoke on delete is exactly what would strand it. Orphans are surfaced in the
  Data tab as removable rather than collected.
- **Two representations per asset.** `original` is the imported file byte for
  byte and is what the archive writes; `display` is what a browser can draw —
  the same object except for TIFF, where it is a PNG proxy from the API. The
  proxy is regenerated on open rather than archived: caching it would double the
  file and create a second artefact that can disagree with the first.
- **`checkImageResolution` skips vector assets by MIME type**, resolved through
  `findAsset` rather than a sentinel on the node. Telling an author their logo is
  63 dpi is confidently wrong advice, which is worse than no check.
- **`checkScaleBarCalibration` (weight 25) is an error, not a warning.** A bar
  drawn from a guessed calibration is a false measurement in a published figure,
  and it looks identical to a correct one. It is deliberately **not** marked in
  the scene: the renderer is shared with the exporter, so a warning stripe would
  be submitted to the journal.
- **Calibration is read from TIFF metadata, and withheld when absent.** ImageJ
  writes `ResolutionUnit = 1` ("none") and the real unit in `ImageDescription` as
  `unit=um`, with `XResolution` in pixels per *that* unit — reading only the
  baseline TIFF convention reports such a file as "2.5 dpi". Both paths are read;
  when neither says, both headers are omitted rather than defaulted.
- **`calibrationSource`** (`metadata`/`manual`/`measured`/`unknown`) is the one
  optional field added. It is what lets the Inspector say where the number came
  from and the checker tell a measurement from a placeholder.
- **Crop and measure chrome is HTML above the SVG**, never scene nodes. Resize
  handles are *proven* not to leak by the parity test; this chrome would have no
  such guard, and it is editor state rather than part of the drawing.
- **Arrows are insert-then-drag**, not click-to-place: a modal tool state would
  need a cursor preview, an Escape path, multi-point termination and
  interception of the background handler that clears selection. Endpoint grips
  carry a distinct `point-handle` role so the parity test's "exactly 8 resize
  handles" keeps its meaning.

### Phase 5 — remaining stats surface

Four gaps in the stats surface, all in the same slice: three tests worked
server-side but were never exposed, one was declared but undispatchable, and
correlation was unreachable for the plot type it matters most for.

- **`wilcoxon`, `chi-square`, `linear-regression` were implemented and
  R-verified but missing from the `TESTS` dropdown** in `SidePanel.tsx` —
  purely a UI gap, no server change needed.
- **`anova-rm` had no dispatch branch at all**, despite being in the
  `StatTest` union and the `parametric` assumption-check set. Implemented via
  `statsmodels.stats.anova.AnovaRM`, generalising `ttest-paired`'s existing
  row-index-as-subject-id convention from two groups to N. Unbalanced designs
  (unequal group lengths) are refused with a clear error rather than
  approximated — row order is the only signal this shape has for subject
  identity, so a length mismatch can't be resolved, only reported.
- **Correlation was structurally unreachable for a `simple-xy` scatter
  dataset.** Two independent blockers, both fixed: the `continuousPlot` gate
  in `SidePanel.tsx` refused *any* test on a numeric-x plot (now relaxed
  specifically for `pearson`/`spearman`/`linear-regression` when there's a
  single series carrying paired `x`), and the server had no `x` parameter at
  all (`run_test` in `tests.py` now pre-transforms a single series plus `x`
  into the same two-key `groups` shape every dispatch branch already expects,
  so the branches themselves needed no changes).
- **`analysisInputHash` gained an optional third `x` argument, additive
  only.** The 2-argument call must keep hashing exactly as before — every
  already-saved project's `inputHash` was computed that way, and this is the
  same "data changed on an untouched figure" bug class the input-hash
  composition rule above already exists to prevent. `xForHash(series)` is the
  one place that decides whether a persisted analysis's series carry x
  (exactly one series present is a sufficient signal, since every other test
  requires at least two).
- **Spearman's p-value is not asserted against R.** R's `cor.test` computes an
  exact permutation p-value for this sample size; SciPy's `spearmanr` uses a
  t-approximation. The two legitimately disagree at low n — the test asserts
  SciPy's own reproducible value and documents why, rather than forcing a
  match that isn't real.

### Phase 6 — export/QC hardening, autofixes

Three debts, two of which this file had already confessed. The interesting part
is that two planned features were *cancelled by measurement*, not built.

- **`Finding.autoFixable` was a claim nothing honoured.** Set `true` on ten
  findings, read by zero code; `GUIDE.md` told users the buttons did nothing.
  Replaced by **`Finding.fix?`**, a recipe the *rule that found the defect*
  constructs — it already knows which nodes are wrong and what the right value
  is, and re-deriving that from a finding id at apply time is how two
  derivations of one fact come to disagree (the reason `analysisInputHash` and
  `scaleBarWidthMm` are each composed in exactly one place). `checkFigure` stays
  pure: a rule *constructs* a mutation, it never executes one. Recipes live in
  `fixes.ts`; the app runs one through `api.commit` (already one undo entry) and
  a batch through `store.transaction`.
  `Finding` is never persisted or structured-cloned, which is what makes
  carrying a closure free — that constraint is written on the field.
- **Ten claimed fixes became seven, plus one conditional.** `checkTextSize` had
  been collapsing two unrelated defects: a label whose *own* `style.fontSizePt`
  is below the floor (mechanical — clamp it; the Inspector accepts 4 pt while
  Nature's floor is 5) and a tick label drawn at the *theme's* size (raising
  that re-flows every gutter through `requiredMargin`, and the other repair is a
  bigger panel — both authorial). They are now two findings and only the first
  has a button. `walkWithOwner` in `scene.ts` makes the distinction exact rather
  than inferred: `nodeId` sits only on each document node's container `<g>`, so
  the walk tracks the nearest ancestor that has one.
  `colour-blind-conflict` **lost** its fix — remapping decides which plot to
  recolour *and* what the colours mean to a reader who already keyed them — and
  gained `nodeIds`, so "Select N affected" lands on the Inspector's existing
  palette control. `page-width-mismatch` offers a fix only when no content
  overhangs the target width, which makes the change pure and exactly
  reversible. `uneven-gutters-*` is fixable but `rearranges`, so it is excluded
  from "fix all safe issues" and its label says what it does.
- **The export path now validates, and never refuses.** The report is computed
  once in `App` and drives both the Quality tab and a score badge beside the
  export buttons. Errors — and only errors — open a confirmation that lists them
  by name, with *Review in Quality* and *Export anyway*. Warnings never
  interrupt and there is no "don't ask again": a draft going to a colleague is a
  legitimate export, and a checker that blocks is one authors route around.
- **Cropped images ship only their crop**, via `flattenCropsForExport` in
  `apps/web/src/exportImages.ts` — see the risk table. Value-preserving by
  construction: `naturalPx.width * crop.width`, the quantity
  `checkImageResolution` and `scaleBarWidthMm` both compute, is held exactly
  invariant and asserted as an equality. PNG always, because the browser only
  ever holds display bytes (already 8-bit) and re-encoding a JPEG as JPEG would
  be a second lossy generation for a saving the crop already delivered.
  The QC report is computed on the **real** document, never the flattened one.

#### The service, and the two things measurement cancelled

Export hardening the endpoint had never had. Each is a way a caller reaches it
that the web client happens never to take, which is why the guarantee has to
live on the service side: a **120 s Ghostscript timeout** (a hung `gs` used to
hold a worker for the life of the process), Playwright timeouts and an outer
`asyncio.wait_for`, a **per-export browser context** whose network is blocked
except for `data:`/`about:`/`blob:` (this kills remote `href`, `<script src>`,
web-font fetches and SSRF against the pod's own API in one line, and costs
nothing because everything legitimate is inline), an `asyncio.Semaphore(2)`
around rendering, a server-side `filename` pattern (a quote injected into
`Content-Disposition`), a 250 Mpx ceiling on raster requests (2000 mm at 600 dpi
is 2.2 Gpx — an OOM behind a generic 500), and an explicit `ValueError` for an
unknown format, which previously fell through and returned a PNG labelled
otherwise.

Untrusted SVG is **refused, not sanitised** — `<script>`, `<foreignObject>`,
`<iframe>`, event-handler attributes, and any `href` whose scheme is not `data:`
or `#`. Regex-scrubbing markup fails quietly; a refusal cannot turn a figure
into a subtly different one. The predicate was run over the acceptance run's own
`figure.svg` before shipping, and `javascript:` is deliberately *not* in the
substring list: the renderer XML-escapes every `<` and `"` it writes, so a
label reading `<script>` cannot arrive as markup — but it can arrive as those
literal characters, and the `href` check catches the case that would actually do
something.

**The spec lists "editable text" and "vector compliance" as things to validate
before export. Neither became a rule, and both decisions were measured:**

- **Editable text cannot fail here.** The renderer has no path that outlines a
  glyph. A rule for it would be a category that always passes, which is worse
  than an absent one — it teaches an author to trust a check that is not
  checking. `parity.test.tsx` asserts the invariant instead: every text-bearing
  document node produces exactly one `<text>`, none of them empty, and no
  `<path>` carries text attributes. That would catch the only way the claim
  could actually be lost — a future mark family drawing its own labels as paths.
- **A transparency warning would have been a false alarm.** PostScript has no
  alpha, and violin/box marks are hardcoded at `fill-opacity: 0.55`, so the
  concern was that `eps2write` would fall back to a raster tile and cost the
  figure its vector claim. Measured in this image: the translucent overlap comes
  back from EPS **pixel-identical to the screen** (241, 202, 115 both ways) and
  the file grows **+4.2%**. There is nothing to warn anyone about.
- **A vector asset placed as an `<image>` is not rasterised either.** An SVG
  logo as a `data:image/svg+xml` href produces **zero image XObjects** in the
  PDF, so `checkImageResolution`'s decision to skip vector assets is sound and
  the "hole between two rules" did not exist. Both measurements are now
  regression tests in `TestVectorFidelity`, since the wording above depends on
  the answers not changing.

### The editing iteration (after phases 1–2)

A round of reported bugs and requests, all fixed on the phase 1–2 surface:

- **Stats replace rather than accumulate.** `BracketNode.plotId` and
  `Analysis.plotId` join annotations to their plot.
- **Brackets follow their bars.** `repositionBrackets` re-measures on layout,
  resize and import. A manual drag is stored as `userOffsetMm` — an *offset*,
  not a pin, so a nudged bracket keeps its adjustment and still tracks the data.
  `measurePlot` is memoised on `(plot, dataset, theme)` identity, which Immer's
  structural sharing makes a sound key.
- **Axis labels never overprint.** Category labels tilt to 45° when they outgrow
  their band, then stand upright at 90° when 45° would force truncation —
  upright labels are bounded by the space below the axis instead of by their
  neighbours, so long names survive whole. The x title is placed below whatever
  depth the labels reach, clamped to the panel.
- **New surfaces:** Inspector tab, keyboard Delete, dataset rename that
  propagates to panels and plots, provenance in the Layers list, layout
  templates, panel resize handles.

Two traps found by driving the real browser, which neither the unit tests nor
the parity test could catch — both are now covered:

- A `style` **string** on a scene node renders fine through the string
  serialiser and *throws in React*, blanking the canvas whenever anything was
  selected. Parity compares two strings, so it saw nothing. `parity.test.tsx`
  now asserts `toReact` does not throw on chrome.
- Setting a panel's frame through the Inspector without `resizePanel` left its
  plot at the old size inside the resized panel.

### The reported-bug rounds (after phase 5)

Seventeen items reported from real use, split into three stages so each can be
verified and redirected before the next. **Stage A is merged; B and C are not.**

- Stage A — bugs: canvas selection, templates, import overlap, layer visibility,
  stats annotation, text editing, scale bar colour.
- Stage B — editor UX: figure title and chosen save filename, copy/paste,
  z-order reordering, plot margins that grow with their labels.
- Stage C — plotting and data: two-directional error bars, broken and secondary
  axes, log/semi-log axis UI, marker and tick options in the Inspector, import
  format options, contingency tables and Fisher's exact test.

#### Stage A, and what each bug actually was

Three of the eight reports named a symptom whose cause was somewhere else
entirely. Recorded here so they are not "fixed" a second time in the wrong place.

- **"Panels can't be deleted" and "Group doesn't group" are one bug.** Every
  scene node calls `stopPropagation` before reporting itself (`react.tsx`), so
  the renderer always names the *deepest* node under the cursor: clicking a
  panel selected its plot, and a group's own `<g>` never received the event at
  all. `deleteNode` and `addGroup` were both correct the whole time. Canvas
  clicks now resolve through `selectionTarget` in `Canvas.tsx` — a click selects
  the outermost container, double-click steps inside (`enteredId`), Escape steps
  back out. The renderer is untouched, so export fidelity is unaffected.
- **"No statistical labels after a test" was the Stats tab annotating a
  different panel.** `activePlot` fell back to `plots[0]` — *insertion* order,
  not reading order — and nothing tied it to the canvas selection, so selecting
  panel c and hitting Run silently re-annotated panel a. The tab now follows the
  selection (`plotFromSelection`), with the dropdown kept as an override.
  Separately, every reason a bracket might not appear used to be silent: all
  comparisons above α, `addBracket` returning null, correlation having nothing
  to span. Each is now stated in a notice under the button. Reproduced in a real
  browser before being changed — the model path was never broken, and
  `make acceptance` proves it still is not.
- **"Imported panel lands on an existing one" was a stale `slot`.**
  `applyAutoLayout` replayed each panel's `slot` from an earlier template
  against a freshly suggested grid of a different shape, so an old panel's span
  covered the new panel's cell. A slot is only meaningful against the grid it
  was authored for, so a template-less layout now clears it. The second half:
  every import created its panel at a hardcoded `(4, 4)`, which sorts *first* in
  `readingOrder` and took panel a's cell — `nextPanelFrame` places it below
  everything instead.
- **"Templates can't be applied" was a control that disappears.**
  `templatesForPanelCount` only covered 1–4 panels and the Toolbar hid the whole
  `<select>` when the list was empty. Templates for 5 and 6 (and a second 4)
  were added, and the control now shows a disabled reason rather than vanishing.
  A test asserts every template gives every panel its own cell.
- **The in-place text editor was white-on-white.** `:root` declares
  `color-scheme: light dark`, so an `<input>` the app does not colour takes its
  text colour from the OS scheme; `.text-edit-overlay` hardcoded a white
  background and set no colour. Both now track the theme. The app's generic
  input rule only matched `input[type='number'|'file']`, so bare `input` was
  added to it too.
- **The Layers padlock was inert.** `isEffectivelyLocked` only sees the node
  map, so it could never consult `layer.locked`. `isLocked(doc, id)` in
  `document.ts` is the document-aware replacement every call site now uses.
- **Scale bars default to black**, not white. White is right only over a dark
  micrograph. The Inspector's colour control also stopped discarding
  `fill.opacity` on every change.
- **The Layers list can hide as well as delete.** `hidden` and the renderer's
  support for it already existed; the only toggle was buried in the Inspector.

#### Stage B, and the one thing that needed care

Three of the four were additive. The fourth changes plot geometry.

- **Plot gutters are measured, not assumed.** `theme.spacing.plotMarginMm` was
  applied verbatim, so a five-figure tick label plus a y title simply ran out of
  the panel — and panels do not clip, so the overflow landed on the neighbouring
  panel and then the page. `requiredMargin` now sizes the left and bottom
  gutters from the labels that will actually be drawn, through `text-width.ts`'s
  static tables — never the DOM, or the canvas and the exporter would disagree.
  Two things make this safe to rely on:
  - **Exactly two passes, never a loop.** Tick *values* are chosen from the axis
    length, which depends on the margin, which depends on how wide those values
    print. The dependency is circular and a convergence loop could oscillate
    between two label sets, so the geometry is built once against the theme's
    margin, measured, and rebuilt once against the answer. It terminates by
    construction.
  - **The 90° category-label budget is a share of the *panel*, not the plot
    area.** It used to be `plotHeight * 0.45`; now that the plot area shrinks to
    make room for exactly those labels, measuring against it fed the depth back
    into the budget and truncated the names the second pass existed to fit. The
    existing "goes vertical rather than truncating" test caught it.
  - A figure whose labels already fit is byte-identical, which a regression test
    asserts — otherwise every saved document would re-lay itself out on open.
- **`duplicateNode` is `deleteNode`'s inverse**, including its panel-label
  special case, and it remaps every reference *within* the copied set: a copied
  panel's bracket annotates the copied plot, not the original, which would
  otherwise put a "P < 0.001" over a plot whose test never produced it.
  References *out* of the set — `assetId`, `datasetId`, `analysisId` — are
  shared on purpose, since copying a figure element must not fork its data.
  `structuredClone` cannot clone an Immer proxy, so nodes go through `current()`
  first. Derived nodes (`bracket`, `panel-label`, `scale-bar`) are refused as
  standalone copies: alone they would dangle, and
  `checkReferentialIntegrity` would reject the save.
- **The clipboard is in-app**, a list of node ids in a ref, not
  `navigator.clipboard`. Pasting has to run against the current document
  anyway, so serialising figure geometry through the OS clipboard would buy a
  permissions prompt and nothing else. Ctrl/Cmd+C, +V and +D live in the same
  Canvas keydown effect as Delete, which already ignores events aimed at form
  fields.
- **`reorderNode` renumbers every sibling `0..n-1`** rather than nudging one z.
  `nextZ` only ever appended, so before this the only way to change what covered
  what was to delete a node and add it back. The Layers list is now sorted
  highest-z-first, so the top of the list is the top of the stack.
- **The figure title is editable.** It always existed on the document and always
  named the saved file — nothing ever showed it, so every figure downloaded
  itself under the sample document's name. Saving now asks for a name and keeps
  it as the title, so the document and the file on disk stop disagreeing.

#### Stage C, and what each option refuses to do

Six features, four of them new model fields. Every one is **optional** and the
one enum change only *adds* a member, so `SCHEMA_VERSION` stays at 1 — but each
had to be added to `schema.ts` as well as the TS type, since zod strips unknown
keys and a field present only in the type is dropped on save.

- **Error bars draw both ways by default.** `errorInterval` was always
  symmetric; the renderer truncated the stroke at the bar's top, so a figure
  showed half the spread that was measured — and its own comment said only the
  *cap* was hidden. `errorBarDirection` (`'both' | 'up'`, absent reading as
  `'both'`) makes the bar-chart convention a stated choice. It is also ignored
  on a plot with no bar: with nothing to hide the lower half behind, half a
  whisker is just missing data.
- **A broken axis removes a range; it does not compress one.** The kept segments
  share the millimetres in proportion to the data they span, minus a fixed 2 mm
  per break, so equal spans either side of a break get equal length. A value
  inside a break maps to **NaN**, and every mark builder filters on the *scaled*
  position as well as the value — clamping it to the edge of the gap would draw
  a mark at a value the axis explicitly does not show, which a reader takes as
  data. Overlapping breaks are merged before anything is placed, or each would
  reserve its own gap and subtract the shared region twice. Breaks are refused
  on a log axis: compressing what is already compressed leaves nothing to
  measure against.
- **The second y axis is offered on scatter and line plots only.** On a
  categorical plot the bands, not the values, carry the reading — two bar series
  drawn against different scales cannot be compared by length, which is the only
  thing a bar chart is for. Withheld rather than approximated, and the Inspector
  says so. `seriesAxis` is indexed by series *order*, the same key the palette
  uses, so it needs no names and cannot go stale when a series is renamed.
  `requiredMargin` grows `margin.right` to hold it; the theme reserves 2 mm
  there, enough for an overhanging x label and nothing else.
- **Log axes needed no model work at all** — `AxisSpec.scale`, `min`, `max` and
  `tickStep` have been modelled and honoured since phase 1 with nothing in the
  UI referring to them. `AxisFields` is that UI. It warns when a log scale is
  chosen over data containing values ≤ 0, since `resolveDomain` silently clamps
  them and the points then are not drawn.
- **Marker shapes are matched on area**, not on side length, so switching shape
  does not silently change how heavy a series looks. `markerNode` is the single
  implementation; the box-plot outlier reuses it with a forced outline, since
  without one a hollow marker would not be there at all.
- **Import stopped guessing silently.** Delimiter, header row, transpose and the
  *layout* are all overridable, with the layout also fixable after import — a
  layout is a reading of the same rows, not a transformation of them, so
  changing it is lossless. The layout matters most: `prism` reads column 0 as
  one shared x, `sigmaplot` reads the columns as independent pairs, and nothing
  in the old UI said so. Detection was also relaxed: it demanded headers
  literally starting with `x`/`y`, so a sedimentation-velocity export headed
  `Radius,C(s)_run1,Radius,C(s)_run2` was read as `prism` — silently plotting
  run 2 against run 1's radii. Repeated first-of-pair names are the stronger
  signal, since a shared-x table cannot have them.
- **A contingency table is a separate `DataFormat` even though its shape is
  identical to `replicate`.** The numbers mean something different: its rows are
  not replicates of one another, its mean is meaningless, and the tests that
  apply to it are exactly the ones that do not apply to measurements. So the
  gate runs both ways — a count table offers only chi-square and Fisher, and a
  measurement table offers neither. A count table also plots as plain bars with
  no error bars and no points, because an SEM over frequencies is a standard
  error of nothing and looks entirely convincing on the page. The assumption
  checks are skipped for count tests too: `n = 2` there means two *categories*.
- **Fisher's exact test refuses anything larger than 2×2.** SciPy has no exact
  r×c test and the whole point of Fisher's is that it is exact, so the error
  names the shape supplied rather than approximating. Its p-values match R's
  `?fisher.test` examples exactly; the **odds ratio deliberately does not** —
  R reports the conditional MLE (6.408 for the tea table), SciPy the sample odds
  ratio (9.0). Same situation as Spearman: the test asserts SciPy's own value
  and says why.
- **`_contingency_table` validates before `np.array` does.** `_clean` drops
  non-finite values per row, so a table with one blank cell arrived ragged and
  raised an opaque "inhomogeneous shape" error. Counts genuinely include zeros,
  so a blank cell is a mistake to report, not a value to skip.

### Round 4 (after phase 6)

Seven items from real use, plus a PDF of Prism table shapes
(`TestFiles/Document4.pdf`). Three stages, each merged after being driven in a
real browser. Two of the three bugs were *silent* — the figure looked fine and
was wrong.

#### Stage A — three bugs and a missing delete

- **Cropping cut somewhere other than the outline.** The overlay drew its window
  as a fraction of the *panel frame*, but `crop` is normalised **source**
  coordinates and `renderImage` scales the kept region up to fill the frame. The
  two spaces stop agreeing the moment anything is cropped: the picture zooms,
  the outline shrinks into a corner, and the next drag applies frame fractions
  as source fractions. Crop mode now shows the whole uncropped picture,
  letterboxed through the existing `fitAspect`, so the window really is in
  source space — what is outlined is what is kept. It also commits once on
  release; every `pointermove` used to be its own undo entry.
- **Brackets had no collective placement at all.** `bracketFrame` positioned
  each one against the data under its own span, and the entire stacking rule was
  `gapMm: 2 + placed * 3.5` in the *caller*. On the default 60 × 50 mm panel the
  `Math.max(0, …)` clamp bites past ~4.6 mm, so **the second bracket and every
  one after it collapsed onto the panel top, pixel for pixel.**
  `layoutBracketsForPlot` places a plot's brackets together — shortest span
  first, each lifted above both its data and any *horizontally overlapping*
  bracket, so disjoint comparisons share a height instead of spending the
  budget. The pitch is `bracketStepMm`, measured from the theme: a bracket's
  node is 1.2 mm tall and its label is drawn *above* the frame at negative y, so
  3.5 mm left about half a millimetre of real clearance. `computePlotGeometry`
  reserves headroom from the **count** of brackets — a quantity that does not
  depend on the answer, so it terminates by construction, the same argument the
  two-pass margin rule rests on. `reflowBrackets` in the render package pairs
  the measurement and the pitch in one place; nine call sites each passing the
  pitch is nine chances to forget it.
  The correct algorithm had been sitting in `plots/marks.ts` as `stackBrackets`,
  exported, never called, with a broken sort comparator. Deleted rather than
  left as a second copy to drift — `doc-model` imports nothing internal, so
  `plots` could not host the shared implementation anyway.
- **A blank cell moved every point after it onto the wrong x.** `toSeries` read
  the x and y columns independently, filtered each for numbers, then truncated x
  to the y count — so a hole at row 2 shifted rows 3+ onto the x of the row
  before and dropped the last x entirely. `numericPairsAt` reads by row index
  and drops the pair, which is the rule `xyMarks` already applied downstream,
  too late to help.
- **Datasets can be deleted** once nothing reads them, mirroring the orphan
  handling image assets already had, cascading to their analyses and brackets
  and refusing while a plot still points at them —
  `checkReferentialIntegrity` would reject the save.
- **A row-name detection was built and then removed.** "Unique labels plus an
  ascending first numeric column" read a real dose-response *replicate* table as
  row-names-plus-xy, because its group means ascend exactly like an axis. The
  two readings are the same rectangle of numbers, so `couldHaveRowNames` reports
  only that the question is *open* and the author settles it. Found by driving
  the app; all 279 tests were green over it.

#### Stage B — the Prism table shapes

All four of the PDF's shapes reduce to one thing the model could not express: a
mark positioned by **two factors**. That is also why a contingency table drew
one bar at the mean of a count of cases and a count of controls — 50 for an
80/20 split.

- **`Series` gained `category` (outer band), `group` (sub-band) and
  `legendKey` (colour).** `name` stays unique and composite (`"WT — Group A"`),
  which is what lets the second factor arrive without `AnalysisSpec.groups`,
  `Comparison.groupA`, `PlotMeasurements.categoryX` or `bracketFrame` learning
  about it: they all join on the name and none of them changed.
- **`legendKey` is separate from `group` because on nested data they differ.**
  The sub-bands are subjects (Rat 1, Rat 2, …) but the reading is Control versus
  Treated, so points cluster by subject and colour by group. Six colours for six
  rats would key the legend on the one factor a nested design is explicitly not
  comparing.
- **`makeGroupedBandScale` returns a `BandScale` addressed by the composite
  name**, so `categoricalMarks` and `measurePlot` did not change. Only the
  *axis* reads the new `axisBand`, which is why four variants get four labels
  rather than sixteen.
- **Two header rows are detected, not required.** A merged group title exports
  as a name in the first cell of its span and blanks across the rest; that
  sparseness is what separates it from an ordinary header, which names every
  column. Without the test a units row would be read as declaring groups.
- **Column blocks are never guessed.** Six columns are as plausibly six groups
  of one as two of three, and a wrong split averages the wrong numbers into a
  plausible mean. A grouped format with nothing declared reads as one group,
  which draws exactly what the single-factor path draws.
- **`'legend'` had been a declared `SceneRole` since phase 1 with nothing
  constructing one.** It draws from the *geometry*, so the swatch is the colour
  actually used, and reserves its own margin through `text-width.ts`. `'auto'`
  shows one only where there is something it alone can say — a plain bar chart
  already names every mark under its band.
- **Shaded error bands**: `xyMarks` groups pairs sharing an x and runs the
  existing `errorInterval` per x. One closed polygon, not a ribbon per segment —
  two adjacent translucent shapes double their alpha where they meet and print
  as a seam at every timepoint. Withheld where there is one y per x, and on a
  scatter, which is its raw observations by definition.
- **Nested *statistics* are refused**, with the reason in the Stats tab. Prism's
  nested t-test fits a hierarchical model; pooling the subcolumns counts
  observations within a subject as independent, inflates n and reports a p-value
  that is too small. Same stance as Fisher's above 2×2.
- **`defaultPlotTypeFor` exists because every import path passed
  `plotType: 'bar-dot'` explicitly**, so the format-aware defaults never fired
  and the timecourse opened as bars over its timepoints. Found by driving it —
  the tests called the operation directly and passed.

#### Stage C — the editing surfaces

- **`DataGrid`** edits cells, rows, columns and headers, and takes an Excel
  paste. The transforms are pure and live in `data.ts`; `editDataset` is the one
  write-back, so undo/redo, history and staleness apply without the grid
  existing as far as they are concerned. Every transform re-derives column kinds
  through `columnKindFor` (shared with the parser) — a cell edited from `12` to
  `n/a` retypes its column, and the *layout* is inferred from those types.
  Inserting or removing a column shifts the group blocks with it, or every block
  after the edit repoints at its neighbour.
- **Editing does not cost the reproducibility claim.** `buildArchiveContents`
  already wrote `originals.get(path) ?? datasetToCsv(...)`, so the verbatim
  import stays at `sourcePath` while edited cells travel in `document.json`.
  Both are kept and distinguishable; `editedAt` says which. Three acceptance
  checks prove it.
- **Ctrl+Z inside a cell.** `useUndoShortcuts` deliberately never steals it from
  an input — a user mid-typing would lose keystrokes — which also made the grid
  unusable, since after Enter the cursor sits in the next cell. The grid handles
  it only when the cell is *untouched*: nothing typed means no keystrokes to
  lose.
- **`PanelNode.contentGrid` tiles a panel's children.** `fillPanelChildren`
  stretched every content child to the whole frame, so two images in one panel
  came out perfectly coincident with only the highest z visible — an assumption,
  not a rule. It reuses `gridCells`, whose only page-specific inputs are the
  extent and the margin, so a panel's own frame and padding drive it unchanged.
  Children take cells in **`z` order**: `Object.values` order is not a
  guarantee, and a montage that reshuffled itself on every layout would be
  unusable. Absent, behaviour is byte-identical, which a regression test pins.
- **Several files make one tiled panel.** Each tile stays its own `ImageNode`
  with its own crop, scale bar and annotations. `aspectLock` is null for a
  montage: it is derived from a single image's ratio and several differently
  shaped micrographs have no one honest ratio. More tiles than cells leaves the
  extras at their current size rather than stacked at the origin, where they
  would be invisible under a tile — the exact failure this replaces.

### Round 5 (in progress) — the import surface

Reported from real use: categorical graphs import well, line graphs do not, and
"none of the other import options work properly". Being taken one item at a
time, each verified in a real browser before the next is started. Reference
material is in `TestFiles/` — `test graph.xlsx` (independent xy pairs, with the
author's intended chart embedded), `test2 data table.xlsx` (a shared-x,
two-group × three-replicate table), `test graphs.prism` and
`grouped data example.prism` (rows × columns × replicates, the two-factor shape).

#### Stage 1 — x,y pairs draw as an xy graph

Nothing about the *parsing* was broken. `inferFormat` reads `X1,Y1,X2,Y2,X3,Y3`
as `sigmaplot` correctly, `toSeries` pairs by row index, and the Inspector
already offered scatter and line. The table came in right and then drew wrong.

- **`defaultPlotTypeFor` now covers every layout that carries an x per y** —
  `simple-xy`, `prism` and `sigmaplot`, not just `xy-replicates`. Read as
  `bar-dot`, an xy table's x columns are discarded outright and each series
  collapses to the mean of its y column: a number that is nowhere in the table,
  drawn over a category axis the data never had. Round 4 fixed exactly this for
  the one format it was reported against and left the other three; the class of
  defect, not the instance, is what the switch now answers. The blast radius is
  one call site — every other `addPlot` caller passes a type explicitly, which
  is why the acceptance count did not move.
- **A column name titles an axis only when every column feeding that axis
  carries it.** `axisTitlesFor` was putting `X1` and `Y1` on the axes while
  `Y1` sat in the legend beside `Y2` and `Y3` — an axis labelled after one of
  the three things plotted against it. The same rule reads the honest case
  correctly: `Radius,C(s)_run1,Radius,C(s)_run2` really is measured against a
  radius, so `Radius` becomes the x title. Where nothing agrees, `DataTab`'s
  existing `?? 'Value'` fills the y axis and the author renames it — a generic
  title is recoverable, a confidently wrong one is not.
- **The layout is no longer labelled "(paired)".** That reads as *matched*
  pairs, which is the opposite of what it means and exactly what it was
  reported for: the pairing is a column with the column beside it, and no row
  of one run corresponds to the same row of another. It is now "own x per
  series", and the shared-x layout above it says "matched row by row" — the two
  readings of the same rectangle now name themselves. The preview line also
  shows that label rather than the raw enum member; `sigmaplot` on screen tells
  an author nothing about how their columns are being read.

Driven in a real browser, light and **dark**: the pasted sheet previewed as
`X1, Y1, X2, Y2, … (own x per series) · 6 columns · 6 rows`, imported to **3**
lines and **18** markers with **no** new bars, three *distinct* starting x
(run 3 at 0.9 left of run 1 at 1.0 left of run 2 at 1.4 — the guard against a
shared-x misreading, which is invisible on the page), a `Y1`/`Y2`/`Y3` legend,
and no axis titled after a single series. The exported PDF is single-page at
exactly 183.0000 × 75.0000 mm, fonts embedded, legend text selectable, **zero**
image XObjects.

**Not done, deliberately:** `.xlsx` and `.prism` are still not readable
directly — the file input takes `.csv,.tsv,.txt` and reads bytes as text. The
author's route is an Excel paste, which is tab-delimited and already works, so
a spreadsheet reader was not built on speculation.

#### Stage 2 — a shared x with replicate y values

The other xy shape: `TestFiles/test graphs.prism` declares it exactly —
`dataFormat: "y_replicates"`, `replicatesCount: 3`, datasets **Control** and
**Treated** over a `y_single` x titled **Hours** — and
`TestFiles/test2 data table.xlsx` is the same table as a spreadsheet. The model
could already express it. Four things stood between the paste and the reading,
and the one the report treats as the new feature was the one that already worked.

- **A merged group-title row is a declaration, and was being ignored.**
  `parseDelimited` read `columnGroups` only from a *second* header row, which is
  how Prism writes them. A spreadsheet writes the same declaration in **one** row
  by merging cells, so `Hours\tControl\t\t\tTreated\t\t` carried no blocks and
  the table inferred as `prism` — **six** lines named `Control, C, D, Treated, F,
  G`, four of them after placeholder column letters. `mergedHeaderGroups` reads
  it, and refuses every shape that is not a replicate table: at most one leading
  single-column block (the x column, whose own title shares the row — the whole
  difference from the two-row case), then blocks of **equal** width ≥ 2. Both
  guards are load-bearing. Without the equal-width test a stray trailing
  delimiter (`A,B,C,` parses four columns wide) declares `C` a two-column group;
  without the leading-singleton limit `Hours` becomes a block at index 0 and
  `inferFormat`'s `firstGrouped === 0` test reads the table as **Nested**. A
  header that names every column is not sparse, so nothing existing moves.
- **Stating the replicate count is now one step.** The count control rendered
  only for `GROUPED_FORMATS`, and detection lands on `prism`, which is not one —
  so it was invisible until the author had already found the layout in a dropdown
  listed under a Prism name. It is offered on `prism` too, and a count ≥ 2 there
  *is* the statement that the y columns are replicates, so `datasetFromText`
  reads the table as `xy-replicates`. A count of 1 is not a claim about
  replicates and changes nothing.
- **"Bars at each point" was unreachable, not merely unimplemented.** The
  Inspector offers `errorDisplay` inside a branch gated on the plot *not* being
  continuous — so for a line plot, the only type the control applies to, it never
  rendered at all. Behind it, `continuousGeometry` engaged `summariseAtX` only
  for `'band'`, so choosing bars would have drawn nothing anyway: a line
  zig-zagging through all eighteen replicates with no interval. Both are fixed —
  the gate now asks whether there is anything to summarise (`hasReplicatesAtX`,
  a question about the *dataset*; the renderer asks it again downstream on scaled
  positions because a broken axis can remove points), and the renderer draws
  capped I-beams from the same `band` edges the polygon uses. `XySeriesMarks`'s
  own doc comment had anticipated this: the edges are held as two ordered arrays
  *"so a caller that wants whiskers instead can read the same numbers"*.
  An **absent** `errorDisplay` summarises too, because `?? 'bars'` is what the
  Inspector has always displayed. Safe by construction rather than by luck:
  `summariseAtX` returns the series untouched unless some x carries more than one
  value, so every `prism`/`sigmaplot`/`simple-xy` figure renders byte-identically
  — asserted three ways in `grouped-plots.test.ts`.
- **Whiskers are stroked in the series colour**, not `theme.foreground`. On a bar
  chart the bar underneath says which group a black whisker belongs to; here
  several series share the plot area with nothing behind them.
  `errorBarDirection: 'up'` stays ignored, and its control is now hidden on
  continuous plots rather than offered and disregarded.
- **`showReplicates` draws the individual measurements behind the means**, which
  is what the `.prism` file's own note recommends as a first step. Optional, so
  `SCHEMA_VERSION` stays 1 — and added to `schema.ts` as well as the type, or zod
  strips it on save. `XySeriesMarks.replicatePoints` is kept apart from `points`
  so that keeps meaning "what the plot draws a marker at", which the line path,
  the bracket clearance and the legend all read. `markerNode` gained an optional
  `sizeMm`; absent it is `node.pointSizeMm`, so every existing call is unchanged
  and the area-matched shape rule still rests on one radius.

Driven in a real browser, light and **dark**, 22 checks each: the paste previewed
as `Detected XY + replicates (Prism) · 7 columns · 6 rows` with *from the header:
Control, Treated*, imported to **2** lines of **6** vertices (not 18), **2**
shaded bands, a `Control`/`Treated` legend and an x axis titled `Hours`;
switching to bars gave **12** capped bars in **2** series colours with **zero**
polygons; *Show every replicate* added **36** faded markers at 0.6× size; and
typing 3 on the header-less version of the same table reread it as XY +
replicates with 2 groups. Both states exported single-page at exactly
183.0000 × 75.0000 mm, fonts embedded, text selectable, **zero** image
XObjects — the translucent band is still vector.

#### Stage 3 — a symbol per series

Reported next: line plots need different symbols for different series.
`pointShape` was plot-wide, so every series drew the same marker and the only
thing separating them was colour — which greyscale print and a colour-vision
deficiency both take away. `pointShapes` is indexed by series *order*, the same
key `seriesAxis` and the palette array use, so it needs no names and cannot go
stale when a series is renamed. `null` in a slot follows `pointShape`, so a plot
that sets only the plot-wide shape is byte-identical.

- **The legend draws the symbol, not a block, once *any* series carries one** —
  including the series that carry none, which take the plot-wide shape. A key of
  identical blocks beside different symbols withholds exactly the mapping the
  symbols exist to supply. The narrower rule (a marker only for the series that
  named one) was written first and put a *block* beside a line of circles
  whenever an author set shapes on series 2 and 3 and left series 1 alone — the
  common case. The unit test set all three and passed over it; **driving a real
  browser is what caught it**, which is the standing rule earning its keep again.
- **`markerNode` gained `shape` and `role`**, both optional and both defaulting
  to today's values, so it stays the single implementation of the area-matched
  shapes. The legend needs `role: 'legend'` or its swatch would be counted as a
  data point by everything that reads roles.
- **Offered on continuous plots with more than one series.** On a categorical
  plot each mark has its own band and the axis already names it.
- Storing an all-`null` array would leave the field set on every figure whose
  author opened the control, so clearing the last series removes it entirely.

Driven in a real browser, light and **dark**: three lines of circles became
**6** circles + **6** squares + **6** triangles with a matching three-symbol
legend, one Ctrl+Z reverted one series, clearing every series back to *Default*
restored the plain block key, and the exported PDF stayed single-page at
183.0000 × 75.0000 mm with **zero** image XObjects — the symbols are vector.

#### Stage 4 — grouped data, and the spacing of its bars

Reported next: an import option for grouped data, with Inspector controls for the
spacing *within* a group and *between* groups. Reference material is
`TestFiles/grouped data example.prism` — three genotypes down the rows, three
treatments across the columns, three replicates in each cell, which its own note
describes as an interleaved bar graph with "error bars computed from the scatter
among side-by-side replicates".

**The import was checked before it was changed, and mostly did not need
changing.** Pasted from a spreadsheet with its merged group titles, that table
already read as `grouped-replicates` with the three blocks declared and nine
series carrying the right `category`/`group` — round 4's two-factor work plus
stage 2's `mergedHeaderGroups`, which tolerates the *blank* leading cell (the
row-title column has no title of its own) because `columnGroupsFromHeader` emits
no entry for a leading blank, so the leading-singleton guard sees index 0. There
was no test for that shape, only for the two-row-header form; there is now.

- **A count now promotes `replicate` → `grouped-replicates`**, the twin of stage
  2's `prism` → `xy-replicates`. Pasted *without* its group-title row the same
  table detects as one treatment measured nine times — a legitimate reading of
  that rectangle and the wrong one here — and the control that takes the count
  was gated on `GROUPED_FORMATS ∪ {prism}`, so it did not appear until the author
  had already found *Grouped* in the layout dropdown. Saying "three columns per
  group" *is* the statement that the columns block; a count of 1 still claims
  nothing.
- **`blocksOfSize` stopped naming blocks after invented column names.** It names
  each block for its first column, which on a header-less paste is `B`, `E`, `H`
  — so the promotion above would have shipped a legend reading "B, E, H" over
  the author's data. The test is that *every* column carries its positional name,
  which a real header cannot manage past the first column or two, so a sheet with
  a column genuinely titled "B" keeps it.
- **The two spacing knobs existed as a dead parameter and a literal.**
  `makeGroupedBandScale` built its outer band from a `paddingInner` its only
  caller never passed, and its inner band from a hardcoded `0.1`. Now
  `barGapFraction` and `groupGapFraction` on `PlotNode`, both optional so
  `SCHEMA_VERSION` stays 1, both mirrored into `schema.ts` or zod strips them on
  save. The defaults are exported from `plots` as
  `DEFAULT_GROUP_GAP_FRACTION`/`DEFAULT_BAR_GAP_FRACTION` and read by *both* the
  renderer and the Inspector — a second spelling is how a control comes to
  display 35% while the canvas draws something else. Absent equals the old
  literals exactly, asserted at the maths layer and again through `toSvgString`.
- **`barWidthFraction` surfaced with them, because otherwise the gap control
  lies.** It has been a real field with a `0.8` default and no UI since phase 1,
  and at 80% of the slot a sliver survives that no amount of closing the gap can
  remove. Bar width plus zero gap is what gives Prism's touching interleaved
  bars. It is labelled *Mark width* on a box or violin, where it sets their width
  too — calling it "bar" there would be wrong.
- **The gap controls reflow brackets in the same commit; bar width does not.**
  A bracket's ends are `margin.left + band.center(name)`, so a gap change moves
  the bars out from under an annotation that would otherwise stay put. Width
  changes no centre and no mark top, so nothing a bracket reads has moved — the
  asymmetry is asserted in `grouped-plots.test.ts` rather than left to be
  rediscovered.
- **`isTwoFactor` in `data.ts` is now the single spelling** of "these series are
  positioned by two factors". The renderer had it inline and the Inspector needed
  the same question to decide whether there is a within-group gap to offer;
  two spellings would show up as a control that adjusts nothing.
- The group gap is offered on **single-factor** plots too, where each mark owns a
  category and it is simply the gap between the bars. Note it changes
  `axisBand.step`, so widening it can stand a rotated category label back
  upright — correct, and safe because the geometry is built in exactly two
  passes rather than converged to.

Driven in a real browser, light and **dark**: the merged-header paste previewed
as `Grouped — rows × groups (Prism) · 10 columns · 3 rows` with *from the header:
Control, Drug A, Drug B* and imported to **9** bars in **3** colours over **3**
category labels with a three-entry legend and no composite name on the axis;
*Gap within group* 0 with *Bar width* 100 made each cluster's three bars flush to
0.01 mm while the clusters stayed 3.39 mm apart; *Gap between groups* 60 widened
the cluster pitch 5.49 → 7.72 mm and one Ctrl+Z reverted it; a one-way ANOVA
placed 24 brackets and changing the spacing **moved all 24** with the bars. The
header-less paste detected as *Treatment + replicates*, and typing 3 reread it as
Grouped with the legend naming **Group 1 / Group 2 / Group 3**. A single-factor
table offered *Gap between bars* and no within-group gap; a line plot offered
none of the three. Both spacings exported single-page at exactly
183.0000 × 75.0000 mm, fonts embedded, legend text selectable, **zero** image
XObjects.

**Not done, deliberately:** the group blocks are still invisible in the import
preview grid (only listed as muted text beside the count), and *First column:
Row names* is still offered on a grouped table where it does nothing —
`inferFormat` short-circuits on declared blocks and `toSeries` hardcodes column 0
as the row label.

### Round 6 — six reported bugs

Two of the six were *silent*: the figure looked plausible and was wrong. Four of
the six turned out to be one arithmetic mistake each, in code that had never
been exercised in the configuration that exposes it.

- **A legend and a secondary axis were reserved with `Math.max`, then drawn in
  the same millimetres.** `requiredMargin` took the wider of the two reserves,
  and `renderLegend` put its origin at `margin.left + plotWidth + gap` — which
  is exactly where the y2 ticks, labels and title start. `y2WidthMm` is now the
  one composition of "how far the right-hand furniture reaches", read by the
  reserve *and* by the legend origin, the same rule `scaleBarWidthMm` and
  `analysisInputHash` exist under. The reserve stacks (`y2 + gap + legend`)
  rather than choosing. It also fixes a second, quieter error in the same
  arithmetic: the y2 labels are drawn at `tickLen + gap` whether or not a tick
  is drawn there, so a tick-less or inward-ticked axis was under-reserved by
  exactly `tickLengthMm`. There was **no y2 test coverage at all** before this.
- **A legend below the plot advanced by the wrong quantity.** The x of entry *i*
  was `i * width(entry_i)` — that entry's own width, not the sum of the ones
  before it — so any key whose labels differ in length stacked later entries on
  top of earlier ones. A long name followed by a short one printed as a smudge.
  `legendRowLayout` is a running sum, and it wraps at the panel edge rather than
  running off it, with `requiredMargin` reserving a row per row *it* computes.
  The two agree because both measure against the same width: the reserve
  repeats `computePlotGeometry`'s own `max(theme, clamped)` for `margin.left`,
  which is what the final geometry will carry in both the grown and the
  early-return branch. The row count depends only on `left`, never on `bottom`,
  so it still terminates by construction.
- **A crop centred itself against the wrong rectangle.**
  `preserveAspectRatio="xMidYMid meet"` was applied to the *oversized* box —
  the frame scaled by `1/crop.width, 1/crop.height` — so `meet` letterboxed the
  source against a rectangle whose aspect the crop had already changed. Two
  consequences, both silent: cropping an aspect-locked image to half its width
  moved **nothing at all** (the offset and the re-centring cancelled exactly),
  and on a montage tile every crop landed somewhere other than its outline.
  A montage is the case that cannot avoid it — `addPanelWithImages` sets
  `aspectLock: null` on purpose, so a tile's frame comes from `gridCells` and
  never matches the micrograph. `renderImage` now fits the *cropped* aspect to
  the frame itself and emits `preserveAspectRatio="none"`; the box it builds
  already carries the source's own aspect, so nothing can stretch — the `none`
  only stops a second centring rule from moving what the first one placed. The
  image is clipped to the kept region and the overlays to the frame, and they
  differ only when the crop letterboxes: clipping the picture at the frame would
  show the source either side of what was kept, and clipping an annotation to
  the picture would delete an arrow placed in the margin.
  **The crop overlay was never wrong.** It draws the whole uncropped picture
  letterboxed through `fitAspect` and outlines in source space, which is
  correct; the renderer was the half that disagreed.
- **`flattenCropsForExport` stopped refusing the letterboxed case.** Its aspect
  bail-out existed precisely because the nominal crop was not what got drawn.
  Now it is, and the baked form draws identically — an uncropped image of the
  kept pixels letterboxes into the very same rectangle `renderImage` computes
  for the unbaked one. So the guard and `ASPECT_TOLERANCE` are gone, and a
  montage tile's crop no longer ships its discarded pixels to the exporter.
- **The dataset name field collapsed to nothing.** `.rename` carried `flex: 1`
  *and* `min-width: 0`, beside an unstyled `<select>` whose widest option
  (`X1, Y1, X2, Y2, … (own x per series)`) is most of a 340 px panel — and a
  `<select>` cannot shrink below its longest label, so the whole deficit came
  out of the name. The CSS comment beside it already recorded this happening
  once. The layout control moved to the action row, and `.rename` has a floor
  instead of a zero: on a wrapping row a floor grows a line, which is
  recoverable, where `min-width: 0` silently hides the field. `.list li
  .field-row` also never had `display: flex` — only `.inspector .field-row` did
  — so its gap and alignment had been inert.
- **The data grid's paste handler was on the in-cell editor alone**, so it only
  fired once a cell had been opened by clicking it: the one state a user
  arriving with a copied table is not in. Worse, a merely *focused* cell is a
  `<button>`, and `Canvas`'s window-level shortcut guard tested only for
  `INPUT|TEXTAREA|SELECT` — so Ctrl+V there fell through and duplicated figure
  elements onto the canvas. The handler is now on the grid container (React's
  synthetic paste bubbles out of the editor, so it is still one implementation),
  the grid takes focus on open so Ctrl+V works before anything is clicked, an
  `anchor` cell outlives the editor and is shown, and the canvas guard now
  ignores anything focused inside `.side-panel`. `pasteBlock` itself was correct
  and already tested — the affordance was the whole defect.
- **Grab handles were white with a 0.2 px border**, on a page that is white by
  definition in both themes, because `.canvas-page` is paper. Now a dark fill
  with a light ring, which also survives the opposite case — a handle over a
  dark micrograph. The arrow endpoint grips keep their blue fill: they are
  visible already, and the difference marks them as a different kind of grip.

Driven in a real browser, light **and** dark, 29 checks each: eight handles
reading `#111318` on `#ffffff`; a right-hand axis and a key on one plot, the key
starting 4.8 px past where the tick labels end rather than on top of them; three
long group names below a plot in **3** rows with **0** overlapping pairs and
every row inside the panel; a dataset name field **260 px** wide; and a
9-column block pasted with no cell opened first, landing whole (`[1][1]=21`,
`[2][3]=33`) and growing the table 7 → 11 columns, then a second block filling
from the cell the author clicked.

The montage crop was checked by **sampling pixels**, since the failure mode is
that the picture looks fine and shows the wrong region. A 200 × 100 source with
four solid quadrants, tiled with a second image: before cropping, all four
quadrants present in roughly equal measure (3367 / 3345 / 3444 / 3425 px);
cropped to the bottom-right quarter, **13541 px of yellow and zero of the other
three**, filling the same rectangle to within 0.3%. The exported PDF rasterised
at 300 dpi says the same thing — 117855 yellow, zero red, green or blue — and
its embedded raster is **100 × 50**, so the crop really was baked rather than
shipped whole. Single page, exactly 183.0000 × 75.0000 mm, fonts embedded, the
38-character legend label recoverable as text.

**Not done, deliberately:** `.crop-window`'s own white outline and the white
`.crop-grip` squares are unchanged — they sit on the dark `.crop-shade`, and the
report was about panel handles. The `'auto'` legend still resolves to `'right'`
and never picks `'bottom'` on its own.

### Pre-phase-7 — the DOM-volume mechanism

Phase 7 (heatmap, PCA, UMAP, volcano, survival) was blocked on a named risk:
"a 100k-point UMAP as SVG nodes will kill the DOM." Solved before any phase-7
chart type was written, deliberately — retrofitting this once five new mark
types depend on the answer would have touched all five. Proven against the
*existing* `scatter`/`line` types; no new `PlotType`, no schema change.

- **Rasterize past a threshold; never downsample.** Downsampling a UMAP/PCA
  embedding changes its apparent point *density* — the one thing such a plot
  exists to show — which is a scientific-integrity regression, not a neutral
  performance trade. `planPointClouds` (`render-document.ts`) instead bakes
  every point of a plot over `MAX_VECTOR_POINTS` into one raster, dropping
  none; below it, the ordinary per-point `markerNode` loop is untouched —
  `planPointClouds` filters these plots out entirely, so the vector path
  costs nothing extra and every existing figure's output is byte-identical.
- **The threshold was measured, not guessed.** `Canvas.tsx` calls
  `renderDocument`+`toReact` unmemoised on every render, and a resize/crop
  drag commits on every `pointermove` — so the real cost of a large point
  cloud is not "does it paint once" but "does every interaction frame rebuild
  all N points." Forcing that same full-document re-render repeatedly against
  a running instance of the unmodified app measured 55 ms at 500 points,
  104 ms at 2,000, 160 ms at 5,000, 707 ms at 20,000, 1,726 ms at 100,000.
  `MAX_VECTOR_POINTS = 2000` is the largest candidate that still lands under
  the ~100 ms threshold at which a UI response stops reading as immediate.
- **Baked outside `packages/render`, once, read by both live canvas and
  export.** `apps/web/src/pointRasters.ts` mirrors `exportImages.ts`'s
  `OffscreenCanvas` use for cropped micrographs, generalized to also cover
  the *live* canvas — crop-flattening is export-only, but point-cloud volume
  chokes the DOM before export is ever clicked. A `PointRasterStore`, shared
  by `Canvas.tsx` and `App.tsx`'s `runExport` (not two independent stores),
  guarantees the identical base64 PNG lands in both the on-screen `<image
  href>` and the exported one — a stronger WYSIWYG guarantee than keeping two
  live drawing paths in sync. Export **awaits** a fresh bake
  (`bakeAllPointClouds`) rather than opportunistically reading whatever the
  canvas cached, so it can never fire against a half-baked raster. Baked at a
  fixed 600 dpi regardless of the live dpi dropdown: Ghostscript's
  `eps2write` resamples an embedded raster to the export device resolution
  regardless (see the export traps below), so downsampling a generously-baked
  PNG is always safe and upsampling a thin one would not be.
  A plot over threshold with no raster yet — the state a real load briefly
  passes through — draws `renderImage`'s existing "no href" placeholder
  idiom rather than nothing, on screen only.
- **New `SceneRole: 'point-cloud'`**, not a reuse of `'image'` — the same
  precedent as `'point-handle'` staying distinct from `'resize-handle'`, so a
  role-count assertion for one can never conflate it with the other.
- **`line` is covered as an architectural consequence, not a special case.**
  Both `scatter` and `line` flow through the same `ContinuousPlotGeometry`
  arm and the same `s.points` loop in `renderContinuousMarks`, so gating that
  one loop covers both plot types' point markers at once. The connecting
  `<path>` for a line is already one batched node and is untouched.
  Categorical plots were never in scope: their marks are one per category,
  never one per row, so there is no volume problem there to solve.
- **Disclosed, never blocking.** `checkPointCloudRasterization` in
  `quality.ts` is `severity: 'info'`, same stance as
  `checkDistributionSampleSize` — every value is still drawn, none dropped or
  sampled, so this is a disclosure, not a defect, and an info-only category
  already receives full credit toward the Publication Readiness Score.
- **`bakePointCloud` has no unit test, deliberately.** It needs
  `OffscreenCanvas`, which the vitest config does not provide on purpose (see
  the environment traps below) — exactly the reason `exportImages.ts`'s
  `encodeCrop` has none either. Verified in a real browser instead.

Driven in a real browser: a 5,000-row import switched to `scatter` baked to
one `<image>` under `data-role="point-cloud"` — the live DOM held **1** such
node, not 5,000 circles, and the two pre-existing sample panels' categorical
`[data-role="point"]` marks stayed at their baseline count throughout,
unaffected. The Quality tab read the disclosure ("points rendered as a raster
image"). The exported PDF (160,591 bytes) carried an image XObject for the
baked cloud — checked the same way `services/api/tests/test_export.py`
already does, `/Subtype /Image` present in the raw PDF bytes — while
`make acceptance`'s 46 checks, none of which touch a scatter or line plot
large enough to cross the threshold, passed unchanged at a 100/100 score.

**Verified:** 371 TypeScript tests (366 + 5 new: two parity fixtures pinning
the raster/placeholder branch and `line`'s free coverage, three quality-rule
tests), 105 Python tests unchanged, typecheck and lint clean, 46-check
acceptance run unaffected.

### Phase 7, Stage 1 — volcano plots

Phase 7 covers five chart types that split into three different architectural
problems: heatmap and survival each need a wholly new `PlotGeometry` kind;
PCA and UMAP need an `Analysis` whose *output* is itself a new plottable
dataset, which nothing today expresses. Volcano needs neither — it mostly
reuses the existing scatter/continuous geometry — so it went first, planned
and built as one stage rather than the whole phase at once, the same
roadmap-plus-first-stage shape every prior round already used. It is also a
real second workload for the point-cloud rasterization mechanism above: a
gene list is routinely 10,000–20,000 rows, comfortably over
`MAX_VECTOR_POINTS`.

- **`DataFormat` gained `'differential'`: a label plus exactly two numeric
  columns, fixed order** (`Feature, log2FoldChange, pValue`). Structurally
  identical to `'replicate'` (label + N numeric columns) at N=2 — there is no
  cell-level signal separating "two replicate measurements" from "an effect
  size and a significance value," the same situation `'contingency'` is
  already in relative to `'replicate'`. So it is **never auto-inferred**;
  `inferFormat` gained no branch for it, and it is reachable only by explicit
  selection in the layout dropdown, mirroring `'contingency'`. A raw
  DESeq2/edgeR/limma export has more columns in a different order and is not
  read directly — trim and reorder first with the data grid's existing column
  tools, the same "reshape before declaring the layout" convention every
  other format already follows. Deliberately not solved with header-name
  matching in this stage.
- **`Series` gained `pointLabels?: readonly string[]`**, a parallel array
  mirroring `x?: number[]` — the same "one more value per observation, aligned
  by index" shape, rather than a richer point object that would force every
  existing consumer of `.values`/`.x` as flat arrays to change for a feature
  only one plot type needs. `numericPairsAt` gained an optional third
  `labelIndex`, keeping "drop the whole row when any required cell is
  missing" in the one function that already owns that discipline — a missing
  label drops the point, no different from a missing x or y.
- **Per-point colour is resolved in exactly one place, called twice, both
  inside `packages/render`.** `xyMarks` gained an optional `classify(xValue,
  yValue)` callback, threaded through the existing pair-filtering loop onto
  `PointGeometry.category`; `resolveVolcanoColor` in `render-document.ts`
  turns a category into a hex string. The vector path (`renderContinuousMarks`)
  and the raster path (`planPointClouds`) both call it — not `apps/web`,
  which would be a second place this could drift. Only the *resolved* hex
  string crosses into `apps/web/src/pointRasters.ts`, as a new optional
  `color?` on `PointCloudSeries.points[]`; `drawPoint` reads `point.color ??
  series.color`, no volcano-specific import needed there at all. Classification
  itself (`volcanoCategory` in `packages/plots/src/volcano.ts`) is pure
  comparison math against the transformed y and the raw x — no server compute,
  confirming the phase-7 roadmap's own read of this stage.
- **The y axis is `-log10(p)`, transformed once**, before geometry or
  classification sees it, so both are built from the same numbers the axis
  actually shows — not the raw p-value `toSeries` returns. **A p of exactly 0
  substitutes `Number.MIN_VALUE` before the transform**, rather than dropping
  the point or letting `-log10(0) = Infinity` reach the scale: a p of 0 is a
  floating-point underflow in the upstream test, not a claim of infinite
  significance, and the substitution keeps the most significant row in the
  table on the chart, at its extreme top, instead of silently missing.
- **The y domain is anchored at zero** (`includeZero: true`), the same
  reasoning `histogram`'s count axis already uses: `-log10(p)` is a
  magnitude, and the single-point "flat series" fallback every other
  continuous plot uses would otherwise pad symmetrically around one value and
  start the axis well above zero.
- **Point identity is a native SVG `<title>`, not an app-level tooltip.**
  `markerNode` gained an optional `label` that becomes a `<title>` child —
  free, DOM-free, and export-faithful, since both `toReact` and `toSvgString`
  already render `.text` generically regardless of tag.
  `parity.test.tsx`'s "every text-bearing node gets exactly one `<text>`"
  assertion filters on `tag === 'text'` specifically, so this doesn't trip
  it. **This only works below `MAX_VECTOR_POINTS`** — above it, points bake
  into one raster with no per-point node to attach a title to, and a
  realistic gene list crosses that threshold almost every time. Colour still
  applies above threshold, baked into the pixels; label identity does not.
- **Threshold reference lines are in scope**, not deferred — the cutoffs are
  already mandatory `PlotNode` state (needed for colouring regardless), so
  drawing two dashed vertical lines (±fold-change) and one dashed horizontal
  line (p-value) is cheap and is what makes a coloured scatter actually read
  as a volcano plot. New `SceneRole: 'threshold-line'`, kept distinct from
  `'axis'`/`'error-bar'` for the same reason `'point-cloud'` is kept distinct
  from `'image'`.
- **The Stats tab explicitly refuses a `'differential'` dataset.** Once
  `'volcano'` joined `CONTINUOUS_X_PLOT_TYPES`, the existing `xyCorrelation`
  gate would otherwise have automatically offered Pearson/Spearman/linear
  regression on log2FC vs. raw p-value — statistically meaningless, since the
  p-values are already the output of a test this app never ran. Caught before
  shipping, not after: the gate now excludes `differential` explicitly,
  mirroring the existing `nested` refusal.
- **The ordinary per-series Colours block is replaced, not left visible, on
  a volcano plot.** Palette swatches, "reset to palette" and "points use
  series colour" all key off `node.palette`/series colour, none of which
  volcano's rendering ever reads once a point has a valid category — leaving
  them up would be a control that visibly does nothing, the same failure
  mode `isTwoFactor`'s own doc comment warns about. `VolcanoColorControls`
  takes its place: fold-change/p-value cutoffs, a threshold-line toggle, and
  three swatches (down/ns/up), the last chosen (`#4575b4`/`#999999`/`#d73027`)
  specifically *not* red/green — the classic up/down convention is exactly
  the classic colour-vision-deficiency failure case.
- **The second-y-axis offering is withheld for volcano**, the same way it
  already is for categorical plots. `continuousGeometry`'s volcano branch
  never reads `node.y2`/`seriesAxis` — a volcano plot is always exactly one
  series (`series.length !== 1` returns null) — so leaving the Inspector's
  "Second y axis" checkbox enabled would be exactly the same "control that
  does nothing" class of bug the Colours block fix above exists to avoid.

Driven in a real browser: a differential table's layout was never
auto-suggested (`Detect` stayed the default until "Feature, log2 fold change,
p-value" was chosen explicitly), the panel opened as a volcano plot with the
Thresholds/Colours controls in place of the ordinary palette block, 4 points
rendered in **3** distinct colours hoverable by gene name, **3** dashed
threshold lines, the Stats tab's Run button was disabled with a stated
reason, and the exported PDF was a single page. A 2,500-row import (over
`MAX_VECTOR_POINTS`) baked to one `point-cloud` raster with **zero** new
`point`-role nodes; sampling the baked PNG's own pixels — the same technique
round 6's montage-crop fix was verified with — found **188** distinct
colours, proving per-point colour survived the bake rather than collapsing
to one.

**Verified:** 395 TypeScript tests (371 + 24 new: doc-model format/series/
schema tests, `packages/plots` classification and `xyMarks` tests, a
`continuous-axis.test.ts` volcano geometry suite, two parity fixtures below
and above `MAX_VECTOR_POINTS`, and quality-rule tests for the dropped-points
disclosure), 105 Python tests unchanged, typecheck and lint clean, 46-check
acceptance run unaffected (no existing fixture uses the new format or plot
type).

### Phase 7, Stage 2 — heatmaps

Heatmap went second because, unlike volcano, it forces the harder
architectural question phase 7's roadmap flagged: `PlotGeometryBase`
required every geometry to carry a numeric `yScale`, and a heatmap has no
numeric axis on either side — both dimensions are categorical row/column
labels. Getting that split right here means survival (stage 3, also a new
geometry kind) does not have to re-litigate it. No server compute, matching
the roadmap's own read of this stage.

- **`PlotGeometryBase` narrowed to `{margin, plotWidth, plotHeight}`**;
  `yScale: NumericScale` moved onto `CategoricalPlotGeometry` and
  `ContinuousPlotGeometry` individually — a mechanical split, not a semantic
  one, so every existing figure is unaffected. New `GridPlotGeometry` arm
  (`kind: 'grid'`) carries `rowScale`/`colScale` (two independent
  `BandScale`s, not the inner/outer nesting `makeGroupedBandScale` uses for
  a two-factor bar chart) and a flat `cells` array. `renderAxisBreaks`/
  `breakMarks`/`renderAxes`/`requiredMargin`/`yTickLayout`/`xLabelLayout` are
  now typed against `CategoricalPlotGeometry | ContinuousPlotGeometry`
  specifically — a heatmap has no axis breaks and draws its own row/column
  labels in a dedicated `renderHeatmapPlot`, so passing one to any of these
  is now a compile error rather than a latent one.
- **`computePlotGeometry` branches to a wholly separate `heatmapGeometry`
  before `toSeries` is ever called** — a heatmap cell is not a replicate to
  pool or a group to compare, so the grid path never depends on the
  `Series`-shaped machinery the categorical/continuous paths share.
  `heatmapGeometry` runs its own two-pass margin growth
  (`heatmapGeometryForMargin`/`requiredHeatmapMargin`), mirroring
  `geometryForMargin`/`requiredMargin`'s "build once against the theme
  margin, measure, rebuild once against the answer" pattern rather than
  sharing it — row/column label widths and colourbar extent are a different
  measurement problem than tick counts and a discrete legend.
- **`DataFormat` gained `'matrix'`**: `RowLabel,Col1,Col2,…`, one continuous
  value per cell — structurally identical to `'contingency'`'s parsing shape,
  deliberately a separate member for the same reason `'differential'` is
  separate from `'replicate'`: nothing in the cells says whether a number is
  a count to test or a value to colour. Never auto-inferred.
- **A dedicated `toMatrix` accessor bypasses `Series` entirely** —
  `{rowLabels, colLabels, cells: (number | null)[][]}` — rather than reusing
  `'contingency'`'s one-series-per-cell `toSeries` case, which exists for
  pairwise group comparison (`category`/`group`/legend/bracket join keys)
  that a dense grid has no use for. `toSeries` still gets a minimal
  `'matrix'` case, purely so generic UI that calls it for display (the
  dataset list's "N series" count) shows something sensible — the geometry
  itself never reads it. Unlike every per-cell `toSeries` case, which
  silently drops a blank/non-numeric cell, `toMatrix` keeps every (row, col)
  position and makes a missing cell an explicit `null` — a position with no
  data is still a position, and a reader has to be able to tell it apart
  from one that was never looked at.
- **Colour resolution splits the same way volcano's did**: `packages/plots`
  computes a normalized `t`, `packages/render` turns `t` into a colour.
  `resolveHeatmapDomain` (`packages/plots/src/heatmap.ts`) supports two
  modes — `'sequential'` (raw `[min, max]`, the default) and `'diverging'`
  (symmetric around zero, `max(|min|, |max|)` on both sides) — built now
  rather than deferred, since it only changes the domain computation and a
  correlation matrix or log-fold-change matrix (both common in this app's
  domain) genuinely needs zero to sit at the ramp's visual midpoint, not
  wherever the data's mean happens to fall. `interpolateColor` in
  `render-document.ts` is plain sRGB lerp between stop colours, not a
  perceptual (Lab-space) ramp — `packages/theme` has `toLab`/`deltaE2000` but
  no inverse Lab→RGB, and building one is real added complexity this first
  heatmap does not need. Called from both the per-cell fill and the
  colourbar, so they cannot disagree on what a given `t` looks like. A `null`
  cell is a themed flat colour, never a point on the ramp.
- **The colourbar is a strip of ~64 discrete rects, not an SVG
  `linearGradient`.** A true gradient needs a `<defs>` block and a
  per-node-unique id for `url(#...)` referencing — untested territory in this
  render pipeline, with a real risk of two heatmaps on one page colliding on
  gradient ids. A rect strip has direct precedent (the fixed-stop
  `viridis-discrete` palette) and needs no new markup shape at all — both
  adapters draw it identically with zero changes. `colorbarExtentMm` is
  composed once and read by both the margin reservation and the drawing
  function, the same discipline `y2WidthMm`/`scaleBarWidthMm` already
  follow. New `SceneRole`s `'heatmap-cell'`/`'colorbar'`, kept distinct for
  the same reason `'point-cloud'`/`'threshold-line'` are.
- **Column labels reuse `xLabelLayout`'s tilt-then-truncate reasoning without
  reusing the function itself** — `heatmapColumnLabelLayout` takes a plain
  label array and band pitch rather than a `CategoricalPlotGeometry`, since a
  heatmap's column band has no `axisBand`/`axisCategories` to read. Same two
  tier 45°/90° budget, same `translate` + `rotate(-angle)` + anchor-end
  idiom the categorical x axis renders with.
- **`checkColorAccessibility` was not extended to heatmap cells.** That rule
  does an O(n²) pairwise ΔE comparison meant for a handful of *discrete*
  series colours; hundreds of adjacent ramp strips are *supposed* to be
  close together, so pairwise-comparing all of them would be both
  semantically wrong and a performance problem. A new `checkHeatmapColorContrast`
  instead samples only the ramp's own rendered endpoints (read straight off
  the colourbar's first/last strip, so it can never disagree with what was
  actually drawn) and simulates CVD on just those — `severity: 'info'`, the
  same disclosure stance as `checkPointCloudRasterization`, never costing
  score.
- **The Colours block and several categorical-only Marks controls are
  replaced or hidden for a heatmap**, the same "a control that visibly does
  nothing is a defect" stance volcano's stage established: `HeatmapColorControls`
  (scale mode, colour stops, no-data colour, cell-value toggle) replaces the
  palette block; Error bars/Centre, marker shape/size/fill/border and bar
  width are all hidden, since none of them read for a grid geometry. The Y
  `AxisFields` call now passes `numeric={node.plotType !== 'heatmap'}` — it
  previously always showed numeric min/max/log-scale controls for a grid
  that has no numeric y at all, a gap volcano's own Inspector work had not
  had reason to surface since every prior type was either purely categorical
  or purely continuous. The generic "Legend" placement field is reused as-is
  for colourbar placement — `'auto'` reads as `'right'`, `'bottom'` and
  `'none'` behave the same as they already do for a discrete legend, so no
  new control was needed there.
- **The Stats tab explicitly refuses a `'matrix'` dataset.** `toSeries`'s
  minimal per-cell case would otherwise leave `minGroupsMet` seeing plenty
  of "groups" — one per cell — and let an ordinary test run comparing
  single-value cells against each other, which compares nothing meaningful.
  Refused outright, mirroring `nested`/`differential`'s stance exactly.

Driven in a real browser: a tab-separated matrix was never auto-suggested as
the layout (`Detect` stayed selected until "Matrix (rows × columns)" was
chosen explicitly), the panel opened as a heatmap with the Colour-scale
controls in place of the ordinary palette block, **9** cells rendered (3×3)
in **6** distinct colours including the default `#e0e0e0` no-data grey for
the one blank cell in the table, a **64**-strip colourbar was drawn, the
Stats tab's Run button was disabled with a stated reason, and the exported
PDF was a single page.

**Verified:** 423 TypeScript tests (395 + 28 new: doc-model format/matrix/
schema tests, `packages/plots` domain/normalization tests, a new
`heatmap.test.ts` geometry suite, two parity fixtures — an ordinary grid and
a missing-cell case — and quality-rule tests for the CVD-contrast
disclosure), 105 Python tests unchanged, typecheck and lint clean, 46-check
acceptance run unaffected (no existing fixture uses the new format or plot
type).

### Phase 7, Stage 3 — survival curves

Phase 7's own roadmap (written during stage 1's planning) assumed survival
would need "a new `PlotGeometry` kind (step function + censoring)," the same
treatment heatmap needed. Research before implementation showed that
assumption was wrong: a Kaplan–Meier curve has a numeric x (time) and a
numeric y (survival probability) — exactly `ContinuousPlotGeometry`'s shape —
so this stage is architecturally closer to volcano's "extend, don't replace"
pattern than to heatmap's new-geometry-kind one. What genuinely was new: a
subject-level `DataFormat` with no existing positional-column precedent, the
Kaplan–Meier estimator itself (pure `packages/plots` math, no server
compute), and a log-rank test — the one addition in this app with **no SciPy
implementation to call at all**, hand-implemented and verified the same way
every other test here is.

- **`DataFormat` gained `'survival'`: `Time, Event, Group?`** — one row per
  subject, `Event` a 1/0 flag, `Group` optional. Never auto-inferred, for the
  same reason `differential`/`matrix` never are: a bare three-numeric-column
  table reads exactly as plausibly as `replicate` (three repeated
  measurements). The optional trailing `Group` column has no direct
  precedent in this file — every existing format is fixed-position/
  fixed-count or a repeated-meaning block — so `toSurvivalGroups` checks
  `columns.length >= 3` for it directly rather than reusing `hasRowNames`'s
  boolean-flag shape, which reinterprets column 0 rather than adding a role.
  A dedicated accessor bypasses `Series` entirely, the same call `toMatrix`
  made for heatmaps: a subject row is not a replicate to pool, and `Series`
  has nowhere to carry an event/censoring flag.
- **No new `PlotGeometry` kind — `survivalGeometry` returns an ordinary
  `kind: 'continuous'`.** `renderContinuousMarks` already builds its
  connecting line from a bare, ordered vertex array with no curve logic, so a
  step function needed only a geometry-builder that emits two vertices per
  step (hold at the previous survival, then drop) — `survivalSeriesMarks` in
  `render-document.ts`, called from a new `computePlotGeometry` early branch
  (before `toSeries`, mirroring heatmap's `GRID_PLOT_TYPES` branch) that reads
  `toSurvivalGroups` + a new `packages/plots/src/survival.ts::kaplanMeier`
  instead. Because the result is an ordinary continuous geometry,
  `requiredMargin`, `renderAxes`, `renderNumericXTicks` and the per-series
  legend all apply **completely unmodified** — heatmap needed its own
  `requiredHeatmapMargin` because a `GridPlotGeometry` doesn't satisfy
  `requiredMargin`'s type; a survival plot's geometry does, so
  `survivalGeometry` reuses the real function, not a parallel one, for its
  own two-pass margin growth.
- **The y domain is hardcoded at `[0, 1]`, never `resolveDomain`-derived and
  never reading `node.y.min/max`.** A survival probability cannot exceed 1 or
  fall below 0 — the same "hard construction choice, not a default" stance
  the histogram/volcano zero-anchoring already takes, just absolute rather
  than one-sided. The Inspector hides the Y-axis numeric controls for
  survival with the same `numeric={node.plotType !== 'heatmap' &&
  node.plotType !== 'survival'}` pattern heatmap's own gap in `AxisFields`
  established.
- **`XySeriesMarks` gained `censorPoints`, always present and empty except on
  a survival plot** — the same "inert until populated" shape
  `replicatePoints` already has. One tick per censoring *time*, not per
  censored subject: two subjects censored at the same time would draw two
  indistinguishable overlapping ticks, so `survivalSeriesMarks` groups by
  time the same way `kaplanMeier` itself does. `node.showCensorMarks`
  defaults to **`true`** — the opposite default from `showReplicates`/
  `showCellValues` — because a censoring tick is what makes a curve honest
  about follow-up loss, not a clutter risk to opt into. New `SceneRole:
  'censor-mark'`, kept distinct for the same role-count-isolation reason
  `'threshold-line'`/`'point-cloud'` are.
- **The confidence band reuses the existing `band`/error-interval polygon
  machinery outright**, computed via a Greenwood log-transform CI in
  `kaplanMeier` (matching R's `survfit` default `conf.type = "log"`, not the
  plain linear form, which can run outside `[0, 1]`) and drawn through one
  small change to `renderContinuousMarks`'s existing band-vs-whiskers
  condition: `node.errorDisplay === 'band' || node.plotType === 'survival'`
  — survival's CI is always a polygon, never capped whiskers, since a whisker
  every few millimetres along a continuous curve reads as noise, not a
  measurement. `node.showSurvivalCI` defaults to **`false`**: with three or
  more arms, overlapping bands read as clutter before they read as data, the
  same opt-in stance `showReplicates` takes.
- **The ordinary per-series Colours/palette block is kept, not replaced.**
  Unlike volcano and heatmap, a survival curve's colour is exactly a named
  series colour — each arm is a group, coloured the ordinary way — so there
  is nothing computed to key a dedicated control off. `'survival'` joined
  `CONTINUOUS_X_PLOT_TYPES` for this same reason: that registry is not only
  "does this type read `Series.x`" (survival bypasses `Series` entirely) but
  also drives numeric x-axis ticks by default (`addPlot`) and blocks ordinary
  group-comparison tests in the Stats tab in favour of the log-rank
  allow-list — both correct for a real numeric time axis, and both free once
  survival is in the set, the same way volcano already relies on it.
- **Marker shape/size/fill/border, bar-width/gap and the ordinary
  error-bars/centre section are all hidden for survival** — none of them
  read for a stepped line with no per-point markers, the same "a control
  that visibly does nothing is a defect" stance volcano/heatmap established.
  The second-y-axis checkbox is withheld too: comparing two curves against
  different probability scales would defeat the entire point of a comparison
  plot, a sharper version of the reasoning already documented for
  categorical plots.
- **A "number at risk" table under the x-axis — a real, common convention
  for published KM figures — is deliberately deferred**, the same restraint
  heatmap's stage showed toward its import-preview group-block
  visualization. It is a genuinely new layout problem (a small grid of
  counts keyed to x-axis tick positions), and not needed to make the curve
  itself correct.

#### The log-rank test

- **Hand-implemented Mantel–Haenszel, general K-group** (matching what R's
  `survival::survdiff` computes), not a 2-group-only restriction: observed
  vs. expected events per group at each combined event time, reduced via a
  full covariance matrix to a chi-square statistic through `scipy.stats.chi2`
  — only the log-rank *statistic* has no SciPy implementation, not the
  reference distribution. Adding `lifelines` as a dependency was the real
  alternative here and was rejected: the formula is closed-form and
  well-published, not something that needs approximating, and the project
  already prefers pinned, minimal images over speculative dependencies.
- **`run_test`/`_dispatch` gained one more additive-only optional
  parameter, `events`**, the same shape `x`/`x_name` were added in phase 5 —
  the existing call shapes must keep behaving exactly as before. Cleaned in
  `run_test` by pairing each group's times with its event flags and dropping
  a row if either is non-finite, the same "clean pairs together" rule the
  `x`/`x_name` path already follows, not two independent per-column cleans
  that could drift out of alignment.
- **Verified against R's built-in `survival::aml` dataset** (Miller 1997,
  Maintained vs. Nonmaintained chemotherapy) — `survdiff(Surv(time, status) ~
  x, data = aml)` reports Chisq = 3.4 on 1 df, P = 0.07; this implementation
  computes 3.396, P = 0.0653. Because SciPy has nothing to wrap here, unlike
  every other test in this app, this comparison is not a wrapper-correctness
  check — it is what proves the hand-written formula is right at all, not
  merely self-consistent.
- **Response shape follows `anova-rm`'s "omnibus plus pairwise" precedent
  exactly**: the K-group chi-square as `Omnibus`, a 2-group log-rank between
  every pair as `Comparison`s, both returned together from the same
  `TestOutcome` shape every other test already uses. Each pairwise
  `Comparison` also reports a hazard-ratio approximation (`Hazard ratio
  (O/E)`, Peto & Peto 1972) built from the same observed/expected quantities
  the statistic already computes — not a Cox-model MLE, and documented as an
  approximation rather than presented as the thing it resembles, the same
  stance Fisher's odds ratio already takes on its own documented divergence
  from R's conditional MLE.
- **No brackets.** A Kaplan–Meier plot's x axis is continuous time, not
  discrete category bands, the identical shape mismatch
  `blockedByContinuousAxis` already encodes for scatter/line/histogram/
  volcano. Follows the existing `xyCorrelation` precedent exactly: the
  result is a p-value/methods-sentence annotation with no `addBracket` call.
- **The Stats tab's gate is an allow-list, the inverse of
  `nested`/`differential`/`matrix`'s refusal pattern**: log-rank is a
  legitimate test here, so instead of adding a `survival` refusal flag,
  `offeredTests` is extended so log-rank is offered *only* for a
  `'survival'`-format dataset and every other test is withheld for one — the
  same `COUNT_TESTS`-style gating chi-square/Fisher already use, inverted.
  `StatTest` gained `'log-rank'`; `analysisInputHash` gained one more
  additive-only optional parameter for event flags, the same discipline
  `x` was held to in phase 5 — the 2- and 3-argument call sites must keep
  hashing exactly as before.

Driven in a real browser: a tab-separated `Time,Event,Arm` paste of the
`aml` dataset was never auto-suggested as the layout (`Detect` stayed
selected until "Time, event, group (survival)" was chosen explicitly), the
panel opened as a Kaplan–Meier curve with the ordinary Colours block still
in place, **2** stepped curves drawn (Maintained, Nonmaintained) with **5**
censoring ticks, toggling the confidence band added **2** new shaded
polygons (one per arm, no per-point whiskers), the Test dropdown
auto-selected log-rank the moment the survival plot was selected — even
before the Stats tab had ever been mounted this session, the specific case
a naive "sync on change" echo would have missed — and running it produced
"the result is in the table below... no bracket is drawn" with the bracket
count on the panel unchanged. The exported PDF was a single page.

**Verified:** 447 TypeScript tests (423 + 24 new: doc-model format/
`toSurvivalGroups`/schema tests, a `kaplanMeier` suite in `packages/plots`
verified against a hand-worked example, a new `survival.test.ts` geometry
suite, and two parity fixtures — a two-arm curve with censoring ticks and a
confidence band), 111 Python tests (105 + 6 new: the log-rank suite against
the `aml` reference), typecheck and lint clean, 46-check acceptance run
unaffected (no existing fixture uses the new format or plot type).

### Phase 7, Stage 4 — PCA

Phase 7's roadmap flagged PCA and UMAP as needing an unsolved mechanism:
"Analysis output becomes a new plottable `Dataset`" — every stats test
through log-rank *annotates* an existing plot; PCA *creates* a new one, from
server-computed numbers nobody imported. Three research passes before
implementation found the mechanism already existed almost in full —
`Dataset.sourcePath`/`sourceFilename` are nullable, not merely optional, and
`buildArchiveContents` already falls back to serialising a dataset's own
rows via `datasetToCsv` whenever no verbatim original is registered ("used
only when no verbatim original exists"); `addDataset`/`addPanelWithPlot`
already do exactly what's needed; and `SidePanel.tsx`'s own CSV-import path
(`DataTab.importDataset`) is already the identical two-`commit`-in-one-
`transaction` shape a PCA action needs. This is the lightest stage of phase
7 so far — **the only one that touches neither `packages/render` nor
`packages/plots`**, since PC1/PC2 per sample is exactly paired-xy, drawn
through the *existing* `scatter` type with no new geometry.

- **Input reuses `'matrix'` outright — no new input format.** A
  `'matrix'`-format dataset (`RowLabel, Col1, Col2, …`) is already samples ×
  features, and `toMatrix` already parses it into
  `{rowLabels, colLabels, cells}`. "Run PCA →" is offered on the same
  datasets heatmap already accepts, in the Data tab's per-dataset row (not
  the Stats tab, which is structurally built around annotating
  `activePlot` and has no shape for "create a new plot instead") — gated on
  `rowLabels.length >= 3 && colLabels.length >= 2`, the same "minimum size"
  disabled-button-with-a-reason convention `minGroupsMet` uses elsewhere.
- **Output is a new `DataFormat: 'pca'`: `SampleLabel, PC1, PC2`** —
  structurally identical to `'differential'` (a text column, exactly two
  numeric columns) and a separate member for the same reason: the numbers
  are a specific, computed thing. **The first `DataFormat` that is never an
  import layout at all** — every other format is something a real pasted
  file can arrive shaped as; `'pca'` is producible only by the "Run PCA"
  action, so it has no entry in `SidePanel.tsx`'s `DATA_FORMATS` dropdown
  (nothing to select it for), though it still gets the ordinary
  `inferFormat` exclusion since its shape would otherwise be misread as
  `differential`'s. The Data tab shows a static "PCA output (PC1, PC2)"
  label in place of the layout `<select>` for a `'pca'`-format row, since
  changing that reading would be nonsensical for an output rather than a
  parsed table.
  `toSeries`'s `'pca'` case mirrors `differential`'s exactly
  (`numericPairsAt(ds, 1, 2, 0)`), so a PCA scatter gets the same free
  per-point `<title>` hover identity volcano's points already have, with
  zero render-side code. `defaultPlotTypeFor('pca') → 'scatter'`; `addPlot`
  forces `plotType: 'scatter'` the same defensive way
  matrix/differential/survival force theirs — connecting PCA points with a
  line would imply an ordering the data doesn't have.
- **Only PC1/PC2 are stored**, not every component the server computes —
  the dataset stays a 2D scatter by construction, and the full component
  list is surfaced in a confirmation notice instead
  (`"PC1 96.1%, PC2 3.9%"`), reusing the same "informational note through
  `onError`" precedent `DataTab`'s own image-import path already set for a
  non-fatal message. **Deferred, deliberately**: PC3+ selection, a scree
  plot, and re-running PCA when its source matrix changes — there is no
  live link between the two `Dataset` entries once created (this is the
  first feature in the app that derives one dataset from another), and
  staleness-tracking across that link is new surface with no existing
  precedent to extend, so it is scoped out rather than half-built. Axis
  titles carry the variance annotation instead (`"PC1 (96.1%)"`), set once
  at creation and editable afterward like any other axis title.
- **`figureforge/pca.py`, a sibling to `stats/`, not nested inside it** —
  that package is specifically p-value tests (`Comparison`/`Omnibus`/
  `TestOutcome`), and PCA produces neither. Plain mean-centered SVD
  (`numpy.linalg.svd`), the standard closed-form construction — no
  dependency addition, the same reasoning already on record for log-rank vs.
  `lifelines`: this is well-published math, not something that needs
  approximating. An optional `standardize` flag (client-exposed, default
  `False`, the same "safer literal" stance heatmap's sequential-not-
  diverging default takes) divides each feature by its own sample SD after
  centering, for features on different scales.
- **A sample missing any feature value is dropped, not imputed** — the same
  "refuse rather than approximate" stance Fisher's exact test and nested
  statistics already take, reported back as `droppedSamples` and a warning
  string rather than a silent count change. Refused outright below 3
  complete samples or 2 features: a 2-sample PCA is a single direction
  explaining 100% of variance by construction, not a result.
- **No `/analyze`-style test wraps this — `/pca` follows the same request/
  response/error-handling pattern** (pydantic models, `ValueError → 422`,
  generic `Exception → 500` via `logger.exception`, `_sanitize` for NaN/Inf
  before JSON) but needs no semaphore or timeout the way export's
  Chromium/Ghostscript calls do: this is cheap CPU-bound linear algebra on a
  small matrix, not an external hangable process. A modest `Field`
  dimension cap, matching `ExportBody`'s size-validator style, is guard
  rail enough.
- **Verified without an external reference dataset** — the first stage in
  this app where none exists, and unlike log-rank's `aml` dataset, there is
  no R-equivalent tool in this environment to derive one independently.
  Verified instead against properties that hold for *any* correct
  SVD-based PCA, not this implementation specifically: exact reconstruction
  of the centered input from `scores @ Vt` (an SVD identity), mutual
  orthogonality of the component scores, explained-variance ratios summing
  to 1, a closed-form degenerate case (perfectly correlated features must
  put 100% of the variance in PC1), and a small 3-sample/2-feature example
  whose 2×2 covariance matrix's eigenvalues are solved by hand via the
  quadratic formula and cited in the test docstring with the worked
  arithmetic shown — landing on an exact 75/25 explained-variance split,
  cross-checked against this implementation's own output. The same honest
  "hand-verified, documented as such" fallback the survival stage's K>2
  log-rank case already established, not a fabricated external citation.

Driven in a real browser: a tab-separated 5-sample × 3-feature matrix
imported under the existing "Matrix (rows × columns)" layout, "Run PCA →"
appeared on its Data-tab row and stayed disabled until the size guard was
met, clicking it created **exactly one** new panel drawing an **ordinary
scatter** (`Plot type` read `scatter`, not a new type) with axis titles
reading `PC1 (96.1%)` and `PC2 (3.9%)`, the new dataset's own row showed the
static "PCA output (PC1, PC2)" label rather than a layout dropdown, and the
exported PDF was a single page.

**Verified:** 450 TypeScript tests (447 + 3 new: doc-model format/
`toSeries`/schema tests — no `packages/render` or `packages/plots` changes,
so no new tests in either), 126 Python tests (111 + 15 new: the invariant,
degenerate-case, hand-worked-example, standardize and validation suites in
`test_pca.py`), typecheck and lint clean, 46-check acceptance run
unaffected (no existing fixture uses the new format).

### Phase 7, Stage 5 — UMAP (closes phase 7)

Phase 7's own roadmap flagged this stage in advance as the one exception to
the project's standing "avoid the dependency, hand-roll the published
formula" stance: fuzzy simplicial set construction followed by a
stochastic-gradient-descent layout with negative sampling has no closed
form, unlike PCA's SVD or the hand-implemented log-rank test, so
`umap-learn` was added rather than approximated. Everything else about this
stage is a direct reuse of what PCA's stage established — same input
(`'matrix'`-format dataset via `toMatrix`), same output mechanism (a new
derived `Dataset` with `sourcePath: null`, a new panel via
`addPanelWithPlot`), same Data-tab-row trigger and
`transaction`/two-`commit` shape, same "no live link back to the source"
scope cut. **The second consecutive stage that touches neither
`packages/render` nor `packages/plots`** — a UMAP scatter is the existing
`scatter` `PlotType`, exactly like PCA.

- **The dependency was verified empirically before being trusted, per the
  roadmap's own instruction.** A `pip install --dry-run umap-learn` against
  the existing API image confirmed full wheel resolution for the whole
  chain (`umap-learn`, `scikit-learn`, `numba`, `pynndescent`, `llvmlite` —
  the largest download at 59.9 MB) with nothing to compile, and a full
  `make build` of the API image afterward confirmed the same end to end.
  This image has no compiler toolchain, so a wheel gap would have failed
  loudly rather than silently falling back to a slow source build — treated
  as a blocking finding had it occurred, not something to route around.
- **`figureforge/umap.py`, a sibling to `pca.py`, not a reuse of it.**
  `compute_umap(row_labels, values, standardize)` mirrors `compute_pca`'s
  validation shape exactly (drop a sample missing any feature value, report
  `droppedSamples` + a warning, never impute) but diverges where UMAP's own
  requirements diverge: refused outright below **4** complete samples, not
  PCA's 3 — a 2–3 point neighbourhood is not something a clamped neighbour
  count can rescue the way it can for the count itself.
- **`n_neighbors` is auto-clamped to `min(DEFAULT_N_NEIGHBORS, n_samples -
  1)`, not exposed as a UI control**, mirroring PCA's own restraint of
  exposing only `standardize`. The clamped value is reported back
  (`nNeighborsUsed`) so a caller can tell when the default silently
  narrowed. `min_dist` stays fixed at UMAP's own conventional default. A
  full hyperparameter surface (`n_neighbors`, `min_dist`, `metric`) is
  deliberately deferred — the same kind of scope cut round 5/6 and
  heatmap's own stage each made explicitly rather than half-building one.
- **A fixed internal random seed**, not user-exposed, makes repeated "Run
  UMAP" clicks against the same matrix reproducible — the same
  determinism-mindedness `mulberry32`'s "seeded, not left to `Math.random`"
  rule already enforces elsewhere in this app, even though nothing in the
  document model requires it here (the result is stored as an ordinary
  snapshot `Dataset`, ungoverned by anything downstream that would need
  determinism the way on-screen jitter does).
- **`DataFormat` gained `'umap'`, a separate member from `'pca'` despite
  the identical three-column shape** (`SampleLabel, UMAP1, UMAP2`), for the
  same reason `'pca'` is separate from `'differential'`: the axes mean
  something different. **UMAP axes carry no percentage-explained
  annotation** — there is no per-axis variance-explained concept for a
  nonlinear embedding, and stating one would misrepresent what the plot
  shows. Axis titles are plain `"UMAP1"`/`"UMAP2"`, set once at creation by
  `addPlot`'s forcing branch and editable afterward like any other axis
  title. Never an import layout, the same way `'pca'` never is: no
  `DATA_FORMATS` entry, no `inferFormat` branch, and the Data tab shows a
  static "UMAP output (UMAP1, UMAP2)" label in place of the layout
  `<select>` for a `'umap'`-format row. `toSeries`'s `'umap'` case is
  merged into `'pca'`'s existing `switch` arm (`numericPairsAt(ds, 1, 2,
  0)`), since the two really do read identically.
- **`POST /umap` mirrors `/pca`'s error-handling shape exactly**
  (`ValueError → 422`, generic `Exception → 500` via `logger.exception`,
  `_sanitize` for NaN/Inf before JSON) with its own request/response
  models — `UmapRequest`/`UmapResponse` are not a reuse of `PcaRequest`,
  since UMAP's parameters genuinely differ (`nNeighborsUsed` in the
  response has no PCA analogue). No semaphore or timeout, the same
  reasoning `/pca` already documented: bounded CPU-bound work, not an
  external hangable process — a `MAX_UMAP_SAMPLES`/`MAX_UMAP_FEATURES`
  guard rail is enough.
- **`runUmapOn` in `SidePanel.tsx` mirrors `runPcaOn` structurally**, down
  to the `transaction`/two-`commit` shape, and both actions read the same
  `standardize` checkbox — relabelled "Standardize features before
  reducing" to cover both rather than duplicating it, the same "a control
  that visibly does nothing is a defect" stance that has applied to every
  format-specific Inspector block since volcano's stage, inverted here: one
  shared control covering two actions rather than one control per action
  saying the same thing twice. The eligibility gate is `rowLabels.length >=
  4`, UMAP's own stricter minimum, disabled with a reason the same
  `minGroupsMet`-style way PCA's own gate already is.
- **Verified without an external reference, and without a closed form to
  hand-solve either** — the first stage in this app with neither escape
  hatch available. `test_pca.py`'s docstring had already established the
  honest fallback of asserting mathematical invariants instead of a
  citation; this stage extends it with the property this codebase already
  uses to test *stochastic* output, the `mulberry32` seeded-jitter
  precedent ("same seed ⇒ identical output", never a literal expected
  value). `test_umap.py` asserts: pairwise-distance rank correlation
  between the input and the embedding (`scipy.stats.spearmanr` on
  `scipy.spatial.distance.pdist` both ways) exceeds a threshold on a
  matrix with genuine low-dimensional structure; the same input run twice
  produces bit-identical output, with and without standardization; two
  well-separated input clusters remain well-separated in the embedding
  (mean inter-cluster distance exceeds mean intra-cluster distance); the
  neighbour-count clamp engages below the default and does not above it;
  and the missing-value/minimum-sample validation shape mirrors
  `test_pca.py`'s own tests exactly. The module's own docstring states
  plainly that no external reference exists for this stage, the same
  honesty `test_pca.py`'s docstring already modelled.

Driven in a real browser: a tab-separated 5-sample × 3-feature matrix (one
outlier sample well separated from the other four) imported under the
existing "Matrix (rows × columns)" layout, "Run UMAP →" appeared beside
"Run PCA →" on its Data-tab row and stayed disabled until the 4-row size
guard was met, clicking it created **exactly one** new panel drawing an
**ordinary scatter** with axis titles reading plain `UMAP1`/`UMAP2` — no
percentage annotation, unlike the adjacent PCA panel's `PC1 (96.1%)` — the
new dataset's own row showed the static "UMAP output (UMAP1, UMAP2)" label
rather than a layout dropdown, and the exported PDF was a single,
non-trivial-sized page with no console errors throughout.

**Verified:** 453 TypeScript tests (450 + 3 new: doc-model format/
`toSeries`/schema tests — no `packages/render` or `packages/plots`
changes, the second consecutive stage to touch neither), 139 Python tests
(126 + 13 new: neighbourhood-preservation, seed-stability, the two-cluster
degenerate case, neighbour-clamping and validation suites in
`test_umap.py`), typecheck and lint clean, 46-check acceptance run
unaffected (no existing fixture uses the new format). This closes phase 7:
all five chart types (volcano, heatmap, survival, PCA, UMAP) are done.

### Round 7 — volcano labels, cascade lines, scientific axes, save-to-disk

Four features reported from real use, each backed by a reference figure in
`TestFiles/`, taken as six independently-verified stages — none of them
touches `services/api`, and none bumps `SCHEMA_VERSION`: every new field is
optional, and the one enum change (`AxisSpec.scale`) only widens.

- **Stage 1 — save with directory selection and `.ffg`.** `ARCHIVE_EXTENSION`
  is now `.ffg`; `.figureforge` still opens (`ARCHIVE_EXTENSIONS`,
  `loadArchive` identifies a file by its MANIFEST marker, never its name, so
  nothing inside the archive format changed). `apps/web/src/projectFiles.ts`
  is a `ProjectFileSystem` interface over the File System Access API,
  injected into `App` as a prop rather than sniffed inline — the same reason
  `bakePointCloud`'s `OffscreenCanvas` dependency stays untested while this
  one has a real unit suite against a memory-backed double. Bytes are built
  synchronously inside the click handler before the first `await` — the File
  System Access API's permission prompt silently no-ops if a user gesture
  doesn't reach it first. Firefox/Safari fall back to the pre-existing
  `SaveDialog` + anonymous download, unchanged.
- **Stage 2 — superscript tick labels and a number-format control.** Two
  latent bugs were fixed first, both only tripped by this stage: a `<text>`
  that is a `<tspan>` *container* has no text of its own, which
  `parity.test.tsx`'s "every text-bearing node" check read as empty; and a
  superscript at 6 pt broke the theme's 5 pt floor, resolved by
  `superscriptSizePt(basePt) = max(4, basePt * 0.65)` and an explicit
  exemption for the new `'tick-label-sup'` role at both the measurement and
  the assertion. `NumericScale` gained an optional `formatRuns`, so a label
  needing a real superscript (`dy`, never the deprecated `baseline-shift`)
  travels as structured `TickLabelRun[]` rather than a marked-up string that
  both the renderer and `text-width.ts` would have to parse. `AxisSpec.labelFormat`
  (`'auto' | 'plain' | 'scientific' | 'power10'`) defers entirely to the
  unchanged `formatTick` when absent or `'auto'` — not modifying that
  function and proving equivalence is a much weaker guarantee than never
  touching it. `power10` falls back to `'scientific'` for a tick that is not
  itself a clean decade, so a mislabelled `10⁵` next to `487` can't happen.
- **Stage 3 — log-spaced minor ticks.** `minorTickValues` moved from `render`
  into `packages/plots` (choosing where a minor tick sits is scale maths, and
  its old home was already a mild erosion of the split) and grew a log
  branch: the conventional 2×..9× pattern between decade-apart majors,
  geometric interpolation otherwise. The Inspector's minor-ticks spinner
  becomes a checkbox on a non-linear axis — the *count* is meaningless there,
  and a spinner that adjusts nothing is the standing "control that visibly
  does nothing" defect.
- **Stage 4 — volcano point labels.** `PlotNode.volcanoLabels?: readonly
  string[]`, keyed on the **label string**, not a row index — the data grid
  reorders rows and `numericPairsAt` drops incomplete ones, so a row index
  and a series point index are already different numbers. A duplicate label
  names *every* matching point, since labelling one of two identical names
  would draw a name beside a point the reader cannot tell from the unlabelled
  duplicate. `packages/render/src/point-labels.ts` is a small, n-independent
  geometric placement engine (`MAX_POINT_LABELS = 25`): candidates are
  truncated to the cap first so it never depends on placement, eight
  adjacent directions are tried before an eight-step push-out ladder, and
  anything still unplaceable is **dropped, never overprinted** — an
  overprinted name is both unreadable and misattributable. It lives in
  `render`, not `plots`, because it needs `estimateTextWidthMm` and `plots`
  may not import `render`; its only import is `text-width.js`, so the
  DOM-free/no-cycle invariants hold. Candidates are ordered by descending
  significance (`-log10(p)`, then `|fold change|`, then label) rather than by
  click order, so the canvas and the export agree and re-selecting the same
  set in a different order changes nothing on the page. Selection has two
  routes: click a point directly (`pickablePointsForPlot`, HTML chrome above
  the SVG exactly like the crop/measure overlays, hit-tested through a 2 mm
  bucket grid so a real gene list costs no per-point DOM) or select a
  row range in the data grid (`pointLabelColumnIndex` in `data.ts` spells
  "column 0 names a `differential`/`pca`/`umap` row" once, rather than
  leaving it hardcoded only inside `numericPairsAt`). Both routes, and the
  Inspector's own remove button, funnel through the same 25-label cap.
  Labels are emitted between the marks and the axis-break marks in
  `renderPlot`'s continuous branch — after the marks so a label always paints
  over its neighbour, and this needs no extra code above
  `MAX_VECTOR_POINTS`, since `planPointClouds` only gates the *drawing loop*
  and `geometry.series[].points` (and every label) stays fully populated
  either way.
- **Stage 5 — cascade/offset line plots.** Three optional fields
  (`offsetStepMm`, `offsetStepXMm`, `offsetFill`), gated to a line plot with
  more than one series and no second y axis (`isCascadable`/
  `hasCascadeOffset` in `render-document.ts`, composed once and read by both
  the geometry builder and the drawing function — the same "one place"
  discipline `y2WidthMm` already follows). The offset is **baked into
  `xyMarks`' coordinates**, never an SVG `transform`: `planPointClouds` reads
  `s.points` straight out of geometry with no transform anywhere on that
  path, so a transform would move the vectors and leave a large cascaded
  raster behind. `XySeriesMarks` gained `baselineMm`/`offsetMm`, and
  `offsetReserveMm` shrinks the **scale ranges** (never `plotWidth`/
  `plotHeight`, which would lift the x axis off the panel edge) by a
  quantity derived from a *count* of series and the requested step — a
  quantity that does not depend on the geometry it is used to build, the
  same termination argument the two-pass margin rule already rests on — and
  clamped to `0.7×plotHeight`/`0.5×plotWidth` so a large step over many
  series compresses the cascade's pitch rather than collapsing the range to
  zero. The fill (`'tint'`/`'solid'`, new `SceneRole: 'area'`) is **always
  opaque**: a translucent fill meant to occlude the traces behind it is a
  contradiction, and opacity is also what keeps the PostScript-alpha question
  round 6 already measured once from ever coming back. Paint order reverses
  to furthest-offset-first only when `hasCascadeOffset` is true, so a nearer
  trace occludes the ones behind it while an ordinary overlay's DOM order —
  and therefore its exported markup — is untouched.
- **Stage 6 — symlog axis.** A third `AxisScaleKind`, so a true `0` prints on
  an otherwise logarithmic axis (flow cytometry's biexponential convention).
  `t(v) = v` for `|v| ≤ linthresh`, `t(v) = sign(v)·linthresh·(1 +
  log10(|v|/linthresh))` beyond it — continuous at the threshold, exact at
  zero, and each further decade occupies exactly `linthresh` of transformed
  space. `AxisSpec.linthresh` auto-derives three decades below the domain's
  extreme when absent (`defaultLinthresh`) rather than storing a computed
  value: unlike `log10`'s threshold, which decides which *data* are dropped,
  this one is purely presentational, so an unhelpful auto value is cosmetic
  and one field fixes it. `resolveDomain`'s symlog branch keeps negative
  values rather than filtering them the way `log10` does, and snaps the
  non-zero extreme outward to the next decade instead of padding by a
  fraction, which would be invisible at 1e5 and everything at 0. Breaks are
  refused for free — they are consulted only inside `makeScale`'s
  `kind === 'linear'` branch — with the Inspector's reason stated as "already
  contains one compression boundary." The Inspector writes
  `labelFormat: 'power10'` in the same patch as the scale change, so a new
  symlog axis reads its powers of ten immediately while an existing log10
  figure, whose `labelFormat` is absent, is untouched. Deliberately the
  lowest-priority stage of the six — stages 2 and 3 alone already deliver
  most of the reference figure's visual value.

Every stage was driven in a real browser, light and dark: a `.ffg` save
overwrote in place on a second click while Save as… re-prompted, and an
existing `.figureforge` project still opened; a log axis read `10²…10⁵` as
real superscripts with the Quality tab reporting no text-size finding; a
30-gene selection correctly capped the Inspector list at 25 while the canvas
drew 17 of them — the rest genuinely unplaceable in that tight a cluster —
and a >2,000-row import drew its requested labels over the rasterized point
cloud; a three-trace cascade separated its series by exactly the requested
step, reversed its line paint order, and reported "Uses 16.0 mm of the
59.0 mm plot height" in the Inspector matching the Quality tab's own
disclosure; and a `0…1.5×10⁵` symlog axis printed a real `0` tick with a
negative point drawn below it and the axis ending on a decade. Each stage's
export stayed a single, non-trivial page with no console errors.

**Verified:** 598 TypeScript tests (453 + 145 new, across doc-model schema/
round-trip tests, `packages/plots`' scale/mark tests, a new
`point-labels.test.ts`, and parity/quality/continuous-axis suites for every
stage), 139 Python tests unchanged (no stage touches `services/api`),
typecheck and lint clean, 46-check acceptance run unaffected (no existing
fixture uses any of the new fields, and the one shared change — the `.ffg`
constant — is a rename, not a behaviour change).

---

### Round 8 — volcano label dragging, axis range clipping, cascade depth axis

Three more items reported from real use. Two were investigated before being
built and turned out to need a different shape than requested: "choose which
folder to save to" was already true on Chromium — `showSaveFilePicker`'s
native OS dialog already lets the user navigate to any folder on every save —
so the only gap was a visible confirmation that it happened, not a new
picking mechanism; and the requested "avoid overlapping labels" already
existed in `layoutPointLabels`, missing only unlabelled points from its
obstacle set. No `SCHEMA_VERSION` bump: every new field is optional, and the
one grouping concept touches nothing outside `packages/render`.

- **Save-location readout.** `apps/web/src/App.tsx` gained `saveConfirmation`
  state, shown for 4 seconds after a successful save (`"Saved \"name\" — the
  browser remembers this folder for next time."` on Chromium,
  `"Downloaded \"name\" to your browser's downloads folder."` on the
  Firefox/Safari fallback) — the one place a folder choice is acknowledged on
  screen, since the File System Access API deliberately exposes no path for
  the existing `.file-target` readout to show instead.

- **Volcano label dragging, and a stricter obstacle set.** Three related
  changes, all in the label-editing surface stage 1 of round 7 built:
  - **`PlotNode.pointLabelOffsets?: Readonly<Record<string, {x,y}>>`**, keyed
    on label TEXT like `volcanoLabels` itself — the same accepted limitation
    that two identically-named points already share one auto-placement slot
    and one colour. A delta on top of a freshly recomputed auto placement,
    the same "auto base, stored delta" split `BracketNode.userOffsetMm`
    already uses, so adding or removing other labels re-flows this one's
    neighbours correctly rather than pinning it to a page position. A new
    `resolvePointLabels` in `render-document.ts` is the one place both the
    drawing path (`renderPointLabels`) and a new exported
    `placedPointLabelsForPlot` (the drag analogue of `pickablePointsForPlot`,
    same one-place-composition discipline `y2WidthMm` already follows) go
    through — neither can compute a different placement from the other.
    **The leader is never stored, always recomputed** from the point to the
    nearest edge of the *offset* label rect (`point-labels.ts`'s
    `nearestRectPoint`, exported for this), and once a manual offset exists a
    leader always draws — simpler and more honest than re-deriving the
    original adjacent/pushed-out distinction after a drag, and it's what
    makes "the connecting line moves with it" concretely true.
    Canvas.tsx's existing `PointPickOverlay` — already scoped to one plot,
    already the only interactive surface a placed label has — is extended
    rather than given a second mode: a pointer-down hit-testing a placed
    label's rect starts a drag, `pointermove` commits `pointLabelOffsets`
    every frame (matching how an ordinary node drag already commits every
    frame, not the batched crop-drag pattern — there is no absolute frame
    here to convert back into a delta afterward, the delta *is* the field),
    and a `suppressClickRef` swallows the synthetic `click` a browser fires
    after the `pointerup` that ends the drag, so releasing a label over a
    point never also toggles that point's own label.
  - **`layoutPointLabels` gained `otherPointsMm?: readonly {x,y}[]`** on
    `LabelLayoutOptions` — extra marker squares to avoid that are not
    themselves candidates, so a label can no longer land on top of a gene it
    isn't naming. Additive (default `[]`), so every existing call and figure
    is untouched. The caller (`resolvePointLabels`) pre-filters the plot's
    point cloud to a bounding box around the candidates expanded by
    `maxPushMm` before passing it in — a label's rect can only ever land that
    close to its own point, so this stays `O(labels)` rather than
    `O(labels × plot size)`, preserving the module's own stated invariant on
    a real 10,000-row gene list.
  - **`PlotNode.pointLabelSizePt?: number`** (absent is `theme.type.annotationPt`,
    today's behaviour), read in the one place `resolvePointLabels` already
    resolves font size. `checkTextSize`'s `overriddenIds` helper decided
    "author override vs. theme value" via `'style' in owner` — `PlotNode` has
    no `style`, so a too-small `pointLabelSizePt` would have silently fallen
    into the no-fix theme bucket even though the author set it. A new
    `ownFontSizePt(owner, role)` generalises that one check for the
    `point-label` role specifically; `clampFontSize` (`fixes.ts`) gained the
    matching write path (`node.pointLabelSizePt = targetPt` when the owner
    carries no `style`), so the override finding's fix button isn't a
    "control that visibly does nothing" for this one role.

- **Axis range clipping.** `AxisSpec.clipToRange?: boolean` (absent/false is
  today's behaviour: a scale extrapolates for an out-of-domain input, so a
  point outside a narrowed `min`/`max` currently overflows the panel
  uncontained). `packages/plots/src/marks.ts`'s `xyMarks` gained
  `clipToXRange?: boolean` and a **per-series** `clipToYRange?: readonly
  boolean[]` (indexed like `ySeries`/`offsets`, so a y2-assigned series clips
  against `node.y2`'s own range, never `node.y`'s) — extending the same four
  existing NaN-filters a broken axis already relies on
  (`points`/`band`/`linePath`/`drawnPoints`), so a clipped point is dropped
  the same way a break-hidden one already is, checked against the *scaled*
  position (not the raw value, since d3 extrapolates rather than producing
  NaN outside the domain). `replicatePoints` is covered for free, since it's
  already derived from the filtered `points`. A cascaded series clips against
  its *already-offset* position, matching the break precedent exactly. Only
  `scatter`/`line`/`volcano` thread it through `continuousGeometry` — the
  only plot types that call `xyMarks` at all; histogram and survival never
  do. **Volcano labels need zero code changes**: `volcanoLabelCandidates`
  reads the already-filtered `series[0].points`, so a clipped point silently
  stops being a label candidate too, the same "for free" propagation an axis
  break's NaN already gets. The Inspector's `AxisFields` gained a
  `clipRelevant` prop and a "Hide points outside min/max" checkbox, rendered
  only when `clipRelevant && (min set || max set)` — meaningless, and hidden,
  with neither bound set, the same convention the log-axis minor-tick
  checkbox already established in round 7.

- **Cascade depth (z) axis**, matching the reference figure
  (`TestFiles/offset line graphs.png` — two diagonal axes, one per data
  group, each with its own tick labels and an end bracket naming the group).
  `PlotNode.showCascadeAxis?: boolean` and `cascadeAxisTitle?: string` (the
  freeform caption used only when no series carries a `category` at all —
  the common single-group case, ignored the instant any series has one,
  where each group is captioned by that category string instead).
  - **Grouping is `cascadeAxisGroups` in `render-document.ts`**: no series
    with a category at all is one implicit group covering everything (needing
    no per-series setup); once any series has one, contiguous runs by
    category — **including** a run of series with no category of their own
    in an otherwise-categorised list, which still draws ticks/names but is
    never captioned. Inventing a caption for data that doesn't have one is
    exactly the approximation `PlotType` choices already refuse elsewhere.
  - **`Series.category` needed to travel to where the axis is built and
    drawn.** `XySeriesMarks` gained an optional `category` field, set from a
    new `categories?: readonly (string|undefined)[]` option on `XyMarkOptions`
    (indexed like `ySeries`/`offsets`) — the same "compose it once, travel
    with the series" precedent `offsetMm`/`baselineMm` already set, so
    neither the margin reservation nor the draw function need a second
    plumbing path back to the raw `series` array.
  - **The spine is schematic, not the real (already-clamped) offset
    geometry** — a fixed pitch derived from `plotHeight`/series count, and,
    only when the cascade leans sideways at all, a lean distributed evenly
    across steps from a small **fixed** `CASCADE_AXIS_LEAN_MM` (6 mm) budget.
    Fixed rather than proportional to the real `offsetStepXMm` is what keeps
    `cascadeAxisReserveMm`'s reserved width a pure function of label text and
    series count — never of plotHeight or the real offset's own (separately
    clamped) magnitude — preserving the two-pass margin termination argument
    every other reserve in this file rests on. Available because `isCascadable`
    already refuses `y2`, so a cascade's right margin is otherwise unused
    beyond an optional legend; the two compose additively
    (`y2 + cascade + legend`), never double-reserving, since a cascade and a
    y2 axis are mutually exclusive by construction.
  - **New `SceneRole`s**: `'cascade-axis'` (spine, ticks and brackets — one
    role for all three, since this is a single decorative axis, not a
    first-class one), `'cascade-axis-label'`, `'cascade-axis-title'`, each
    kept distinct from `'axis'`/`'tick-label'`/`'axis-title'` so a role-count
    assertion for the real axis is never silently widened.
    `THEME_SIZE_KEYS` maps the two text roles onto the existing
    `tickLabelPt`/`axisTitlePt` sizes — no new `Theme.type` field.
  - **Inspector**: a "Show depth axis" checkbox inside the existing
    `CascadeControls` block, gated the same way its own reserve-usage hint
    already is (only once `hasCascadeOffset` is true) — then *either* the
    freeform title field (only when no series has a category) *or* an
    explanatory note that group brackets come from the data, never both,
    since showing the freeform field when it does nothing would be exactly
    the "control that visibly does nothing" defect this convention exists to
    avoid.
  - **No real import path produces a categorised cascade yet** — `Series.category`
    is set only by the two-factor row×group×replicate formats
    (`grouped-replicates`/`prism`-with-groups), none of which carry the paired
    `x` a line plot needs, so the two-category behaviour is verified directly
    against `cascadeAxisGroups`/`cascadeAxisReserveMm`/`renderCascadeAxis`
    with hand-built series rather than through a real dataset import — the
    same "verified as a pure function" treatment `xyMarks` itself already
    gets in `plots.test.ts`.

Driven in a real browser, light and dark: a save showed "Saved
\"figure.ffg\" — the browser remembers this folder for next time." for four
seconds and then cleared; entering label-pick mode, labelling three points
and dragging one away from its cluster kept its leader connected to its
original point while the other two labels' auto placement was undisturbed,
and the Inspector's "Label size (pt)" field resized it live with the Quality
tab reporting the override finding only below the 5 pt floor; setting an
axis `Max` below the data's own maximum first showed the cut-off point
overflowing the panel as before, then "Hide points outside min/max" removed
it with no orphaned error-bar cap, and unchecking it brought the point back
exactly where it was; and a three-series cascade's "Show depth axis" drew a
diagonal spine with one tick and name per trace in that trace's own colour,
plus a rotated caption once a freeform title was typed in (no categories on
that dataset, so the caption field was offered rather than the data-driven
note). Each stage's export stayed a single, non-trivial page with no console
errors.

**Verified:** 644 TypeScript tests (598 + 46 new: `point-labels.test.ts`'s
`otherPointsMm`/rect-exposure cases, a new `point-label-edit`-style suite
inside `continuous-axis.test.ts` for dragging/font-size, a range-clipping
suite in both `plots.test.ts` and `continuous-axis.test.ts`, and a
cascade-z-axis suite covering `cascadeAxisGroups`/`cascadeAxisReserveMm`/
`renderCascadeAxis` directly plus end-to-end margin/scene-node assertions,
with parity/quality/doc-model round-trip coverage for all three features),
139 Python tests unchanged (no stage touches `services/api`), typecheck and
lint clean, 46-check acceptance run unaffected (no existing fixture uses any
of the new fields).

---

### Round 9 — sign-aware tick labels, a boxed border, and a 3D cascade grid

Three more items reported from real use, the last revised twice against a
reference figure (`TestFiles/cascade with reference lines.png`, a
sedimentation-velocity plot whose four traces cascade diagonally behind a
receding dashed grid and a second, back-plane copy of the axes). No
`SCHEMA_VERSION` bump: every new field is optional.

- **Every visible x tick centres on its digits, sign excluded.** A numeric
  label's minus sign used to be included in the centring math — `formatTick`
  emits it as the literal first character of the first run, and the *string*
  was centred on the tick, which visibly off-centres the *digits* whenever
  the label is negative. `leadingSignWidthMm` (`text-width.ts`) measures a
  run list's leading en dash (`–`, U+2013 — the journal convention this
  codebase already enforces, never the ASCII hyphen or the true minus
  `−`); `renderNumericBottomAxis` shifts `x` left by half of it, so the sign
  hangs outside the centred span rather than pulling the whole label off it.
  The old inward start/end anchoring at the axis ends is gone — every label
  is `text-anchor: 'middle'` now, sign-shifted or not — since a start/end
  label was itself an approximation for the same overhang this fixes exactly.
  `xEdgeOverhangMm` computes how far a centred (and now sign-shifted) edge
  label reaches past the plot area, and `requiredMargin` folds it into the
  existing two-pass `left`/`right` computation via `Math.max`, so a wide
  edge label keeps fitting inside the panel instead of overhanging it.
  `bottomNumericAxis` picks the right axis/scale pair for whichever physical
  direction is currently the numeric one — `node.x` on a continuous plot,
  `node.y` once a horizontal categorical plot flips it to the bottom —
  mirroring `renderAxisBreaks`'s own `valueAxisPhysical` split so the two
  can never disagree about which axis is "the numeric one along the
  bottom." `xBottomAxisLayout` factors the shared tick-visibility/stride
  arithmetic out of `renderNumericBottomAxis` so it and `xEdgeOverhangMm`
  can't drift apart — two copies of that arithmetic would have shown up as
  a label that fits the margin the renderer reserved but not the one it
  actually drew against.
- **`PlotNode.boxed` draws the missing top and right axis lines.** Today's
  axis is always "L-shaped" — bottom and left only — with no way to close it
  into a full rectangle. `renderBoxedBorder(node, plotWidth, plotHeight,
  axisStroke, backOffset?)` is the one implementation, called from both
  `renderAxes` and `renderAxesHorizontal` right after each one's own line
  block, so the two orientations can't draw two different rectangles.
  Hidden on a heatmap, which draws no axis lines at all.
- **A cascading line plot's reference grid is a true 3D-oblique box, not a
  flat one — revised twice against the reference figure.** The first pass
  drew one flat line per series at its own baseline; comparing against the
  reference figure showed the real shape is a receding grid: one dashed
  diagonal per **front-axis tick** (not per series — the reference has
  visibly more grid lines than traces), running parallel to the cascade's
  own front→back offset from the front tick to the matching position on the
  back-most series' plane, plus that plane closed as a wall and a *second*
  copy of the axes standing on it.
  - **`cascadeBackOffsetMm(series)`** is the one derivation of the
    front→back displacement, read directly off the offset-baked
    `baselineMm`/`baselineXMm` already on the first and last series (from
    round 7's cascade work) rather than re-derived from
    `effectiveOffsetStepsMm`/`offsetReserveMm` internals — so it cannot
    disagree with where the marks themselves drew. Verified in-bounds by
    construction: the back-most series' own window is exactly
    `x ∈ [offset.x, plotWidth]`, `y ∈ [0, plotHeight + offset.y]` — the
    canvas's own bounds — so nothing here needs a new margin reservation.
  - **`renderGridlines`** draws the diagonals (one per visible y tick from
    `x=0`, one per visible x tick from `y=plotHeight`, both landing on the
    back plane), then the wall closing them: a flat line per value tick
    continuing its own diagonal, plus the wall's top and right edges — all
    in the gridline colour/style, so the receding grid reads as a closed 3D
    box rather than a loose fan of lines. Every back-plane coordinate is
    computed from the *same rounded* front-tick position the diagonal used
    (`round(round(p) + offset)`, not `round(p + offset)` — the two are not
    the same number), which is what makes a wall line's end and a back
    tick's position land on a diagonal's endpoint exactly rather than a
    rounding step away.
  - **`renderCascadeBackAxes`** stands a second copy of the front L-axis —
    left value axis and bottom x axis, with tick marks but no labels or
    titles — on that back plane, at exactly the ticks the diagonals arrive
    at. Gated per axis on the front axis's own `showLine`/`showTicks`, the
    standing "a control that visibly does nothing is a defect" rule. New
    role `'cascade-back-axis'`, kept distinct from `'axis'`/`'tick'` (the
    real front axis) and `'gridline'` (the diagonals and the wall) so a
    role-count assertion for any of the three is never silently widened by
    another. All of this is automatic whenever `showGridlines` and cascading
    are both true — independent of `boxed`, which still draws its own
    (optionally back-offset) rectangle on request and simply overdraws the
    wall's frame in the firmer axis stroke.
  - **Non-cascading gridlines are unchanged**: flat lines at the value
    axis's own ticks, exactly as before this round.
- **`gridlineColor` (`'grey'` | `'black'`) and `gridlineStyle` (`'solid'` |
  `'dashed'` | `'dotted'`)** make the reference lines' appearance a stated
  choice rather than a fixed blend. Absent stays exactly today's behaviour —
  the muted grey blend, solid on an ordinary plot and dashed on a cascading
  one — and an explicit style overrides the cascade default uniformly, so a
  cascading plot's grid can be forced solid or an ordinary plot's dotted.
  `'dotted'` pairs a zero-length dash with a round linecap (the same idiom
  `dashArrayFor` already uses) so it paints as dots rather than vanishing;
  that is the only style needing an extra attribute, so `'solid'`/`'dashed'`
  stay byte-identical to before this option existed. Both are Inspector
  selects shown only once "Show gridlines" is checked.

Driven in a real browser, light and dark: a negative-tick dataset centred
its digits with the en dash hanging outside; `Boxed` closed a scatter plot
into a rectangle with no effect on a heatmap; a 4-series cascade with both
`offsetStepMm` and `offsetStepXMm` set showed a solid front L-axis, grey
dashed diagonals landing exactly on a solid ticked back L-axis, and the wall
between them closed top and right — with `Boxed` left **unchecked**, proving
the back axes are automatic rather than tied to that toggle; checking
`Boxed` afterward added exactly two more solid lines over the same two wall
edges. Switching `Gridline colour` to black and `Gridline style` to dotted
produced clearly dotted black diagonals; switching style to solid on the
same cascading plot produced solid black diagonals, correctly overriding
the automatic dashed default.

**Verified:** 686 TypeScript tests (644 + 42 new: a `text-width.test.ts`
suite for `leadingSignWidthMm`, a rewritten `gridlines.test.ts` covering the
diagonal grid/wall/back-axes geometry and the colour/style options exactly,
sign-aware-centring and boxed-border cases in `continuous-axis.test.ts`, a
round-trip test in `doc-model.test.ts`, and parity fixtures for the boxed
border and both gridline shapes), 139 Python tests unchanged (no stage
touches `services/api`), typecheck and lint clean, 46-check acceptance run
unaffected (no existing fixture uses any of the new fields).

---

### Round 10 — constrained drawing, rotation, editable axis titles, cell clearing, more templates

Four items from real use. **Research before implementation shrank two of them
to almost nothing and reshaped a third**, which is the reason to read this
section before touching any of it again.

- **`rotation` was already modelled, schema'd and rendered — it simply had no
  UI.** It has been on `NodeBase` (`nodes.ts`), in `schema.ts`, defaulted by
  `baseNode`, and honoured by `renderNode`, which pushes
  `rotate(deg cx cy)` onto every node's wrapping `<g>`. Nothing had ever set it
  to anything but `0`. So this round added no model work at all for rotation:
  the whole job was making the *selection chrome and pointer maths*
  rotation-aware. No `SCHEMA_VERSION` bump for the same reason, and a
  round-trip test now pins that claim rather than asserting it.
- **`resizeFrame` already took an `aspectLock`**, with the corner/edge
  derivation and the re-derive-after-clamping already written — Shift-to-square
  is passing `1`.
- **There is no drag-to-draw tool, so "draw a square" and "resize to a square"
  are the same code path.** Shapes and arrows are *insert-then-drag* (the
  Toolbar inserts at a fixed frame and selects it; the author drags a grip), a
  choice already recorded for arrows: a modal tool state would need a cursor
  preview, an Escape path, multi-point termination and interception of the
  background handler. The Shift constraint was therefore added to the resize
  path rather than a drawing mode being invented for it.

#### Shift constraints

- **Shift locks a resize to a square**, overriding an image's or panel's own
  aspect lock — a deliberate constraint, not a suggestion. Read live off the
  `pointermove` event rather than from `DragState`, so pressing and releasing
  Shift mid-drag takes effect at once. (Shift on *pointerdown* still means
  additive selection; they are different events and do not collide.)
- **Snapping is suspended under Shift, and for any rotated node.** `snapResize`
  moves each axis' live edge independently, so it would break the ratio
  `resizeFrame` had just enforced; and smart guides are computed from the
  axis-aligned `frame`, which for a rotated node is not where the author sees
  the shape — a guide drawn there points at nothing. `altKey` already meant
  "suspend snapping", so all three fold into one `freeform` boolean.
- **Shift constrains an arrow's heading to 45° steps, measured from the
  *adjacent* point** — the other end of a two-point arrow, the tail-side
  neighbour of a bend. `snapAngle` (`geometry.ts`) **preserves the drag
  distance and constrains only the bearing**: projecting onto the ray instead
  would shorten the line as the cursor left the snapped direction, so the arrow
  would appear to shrink while the author was aiming it. A zero-length drag has
  no direction and is returned untouched rather than forced onto 0°.
- **A `shape: 'line'` can only express 0°, 45° and 90°, and that is stated
  rather than faked.** `renderShape` draws a line corner-to-corner of its
  frame, so its angle *is* its frame aspect. Giving `ShapeNode` a hidden points
  array to reach the other five directions would duplicate `ArrowNode` badly;
  an author who needs an arbitrary angle uses an arrow, which has real endpoint
  grips.

#### Rotation, and the one decision that kept it small

- **Offered only on leaf annotations (`shape`, `arrow`, `text`).** This is the
  load-bearing choice. `absoluteFrame` sums ancestor origins and **ignores
  rotation entirely**, and it is what every canvas overlay, `frameOf`, the
  crop/measure chrome and `Toolbar`'s insert position all read; `autoLayout`,
  `snapFrame`, `alignFrames`, `measureGutters` and `resizePanel` all assume
  axis-aligned frames. Restricting rotation to nodes that never have children
  means **no rotated node ever has a descendant**, so every one of those stays
  correct *by construction* rather than by a cascade of fixes. `ROTATABLE_TYPES`
  is spelled once on each side (`isRotatable` in `Canvas.tsx`, read by the
  Inspector; the renderer's own copy gates the grip) and a parity test asserts a
  panel is never offered one.
- **`resizeFrame` gained `rotationDeg`, additive and inert at `0`.** Two things
  happen when it is non-zero: the drag delta is rotated into the frame's own
  axes before any width is computed (dragging the `e` grip of a shape turned 90°
  must widen it along what the author sees as its side), and **the anchored
  corner is then held still *on the page***. Without that second step the
  unrotated origin is pinned while the rotation swings the visible corner away
  from it, and the shape slides across the canvas as it is resized. A test
  asserts exactly that invariant — the anchor's page position before and after
  — rather than a literal expected frame.
- **The chrome is turned by one wrapping group, not per-grip.** `renderSelection`
  now emits one `<g transform="rotate(deg cx cy)">` per selected node, using the
  identical transform `renderNode` applies to the node itself, so every handle
  coordinate inside is written exactly as it was for the unrotated case and the
  two cannot drift. New `SceneRole: 'rotate-handle'`, kept distinct from
  `'resize-handle'` and `'point-handle'` for the documented reason those two are
  distinct from each other: "exactly 8 resize handles" and "one point handle per
  arrow point" are assertions that must keep meaning what they say.
- **Stem before grip.** The rotate grip has a short stem back to the frame, and
  drawing it *after* the circle painted it over the grip's own centre — where,
  carrying no `data-handle`, a pointer-down reached no handler at all and
  silently started a move of whatever was behind. Reordered, plus
  `pointer-events: none` on the stem. **Found by driving a real browser; all 706
  tests were green over it**, which is the standing rule earning its keep again.
- One grip only on a lone selection: rotating several nodes at once has to pick
  a centre, and each node's own versus the selection's disagree visibly.

#### Axis titles edit on the canvas

- **The discriminator is scene *metadata*, not an attribute.** `toSvgString`
  serialises `node.attrs` alone, while `react.tsx` emits `role`/`nodeId` as
  `data-*` — so a new optional `SceneNode.editTarget` (emitted as
  `data-edit-target`) names the field an element edits without changing a byte
  of any exported figure. Widening `role` into per-axis members was the
  alternative and was rejected: it would have silently changed every role-count
  assertion and `quality.ts`'s own role → theme-size map. `nodeId` alone is not
  enough here — it names the plot, and a plot draws several titles.
- **The `editTarget` test is checked in `parity.test.tsx`'s strip list.** The
  whole-document parity assertion normalises React-only hooks off both sides
  before comparing, so it would *not* have caught a leak on its own; the new
  test asserts the export contains no `data-edit-target` and React does. The
  first full run failed on exactly this until the strip was added — the parity
  test doing its job.
- **Ordering in `handleDoubleClick` is load-bearing.** The `editTarget` branch
  runs *before* the container step-in branch: a plot's ancestor is a panel,
  which is a container, so the existing code would otherwise have swallowed
  every double-click and merely entered the panel — the title would never open,
  however many times it was clicked.
- **The cascade caption is editable only when it really is `cascadeAxisTitle`.**
  Where it came from a series' own `category`, the renderer ignores that field
  entirely, so offering to edit it would be a control that silently does
  nothing.
- **Tick labels are deliberately not editable**, and a parity test pins it: they
  are computed from the data, and an editable tick label would let a figure
  display a number its data does not support. The overlay's box is measured with
  `getBoundingClientRect()` on the clicked `<text>` — legal in `apps/web`, and
  the reason `absoluteFrame` (which knows only whole document nodes) could not
  serve.

#### Clearing cells, and the template gap

- **`clearBlock` mirrors `copyBlock`'s signature** and funnels through the same
  private `retyped` helper every other transform uses, so column kinds
  re-derive and `editedAt` is stamped. Corners are accepted in either order and
  **clamped** rather than bounds-rejected — the caller is a selection rectangle,
  and dragging past the last row is ordinary. An already-blank selection returns
  the *same* dataset, so a keystroke that changed nothing leaves no undo entry.
  Worth knowing: `columnKindFor` reports an entirely blank column as `'number'`,
  so clearing a numeric column cannot silently retype it and flip the inferred
  layout — pinned by a test.
- Bound in `onGridKeyDown` (the container-level handler), only with
  `cursor === null`: once a cell is open for typing both keys belong to the
  text. No conflict with the canvas, whose window-level handler already returns
  early for anything focused inside `.side-panel`.
- **Every multi-panel template was landscape-biased — there was not one
  single-column stack in the set**, which is exactly what was reported. Eleven
  templates added (13 → 24): a vertical stack at each of 2–6 panels, plus
  `⅔ over ⅓`, `2 + wide bottom`, `3 + wide bottom`, `⅔ + 3 stacked`,
  `3 over 2` and a `1 + 2 + 3` pyramid. **No geometry changes at all** —
  `GridSpec` already supported `rowWeights` and `spanCell` already handled
  spans, so this is data. The existing "every panel gets its own cell" invariant
  picks all eleven up automatically because it iterates `LAYOUT_TEMPLATES`.
- **Nothing here grows the page, and each tall template says so.** `applyPreset`
  never writes `heightMm` and `gridCells` divides the *existing* height into
  rows, so a 6-tall stack on the default 120 mm page leaves ~15 mm per panel.
  Rather than changing page sizing (which the journal presets fix, and which
  `page-too-tall` polices), the needed height goes in each template's
  `description` — a field the Toolbar already renders as the option's tooltip.
  A test enforces this for **every** template over two rows, which caught two
  cases the first pass missed, one of them the pre-existing `six-two-across`.

Driven in a real browser, light **and** dark, **27 checks each**: a Shift-drag
on a rectangle's SE grip gave exactly 245.8 × 245.8 px (ratio 1.000); the rotate
grip snapped to 45° with Shift and **the chrome's own transform read 45 to match
the node's**, with the Inspector's degrees field agreeing; a panel offered no
rotate grip at all; a Shift-aimed arrow landed 0.000° off a 45° ray from a
deliberately off-axis drag; double-clicking the y title opened an editor seeded
with `Cell viability (%)` and the edit landed on the axis; a Shift-selected
block of cells blanked on Delete, one Ctrl+Z restored `98.2`, and no figure node
was deleted by the same keystroke; `2 stacked` laid both panels into one column
with a 62 px gap and no overlap; and the exported PDF stayed a single 29 KB
page. No console errors in either theme.

**Verified:** 706 TypeScript tests (686 + 20 new: `snapAngle`/`snapRotation`/
`rotatePoint` and the square-lock, rotation-inertness and anchored-corner
`resizeFrame` cases in `doc-model.test.ts`, a `clearBlock` suite, a
rotation round-trip, three template invariants, and parity fixtures for the
rotate grip, the rotated chrome and `editTarget`), 139 Python tests unchanged
(nothing here touches `services/api`), typecheck and lint clean, 46-check
acceptance run unaffected (no existing fixture rotates a node, uses a new
template, or clears cells).

---

### Phase 8, Stage 1 — the Electron shell and its Python sidecar

Phase 8's whole content, per the risk table that has carried it since phase 1,
is that "the desktop shell needs Python bundled as a sidecar process with
lifecycle management — real work, not a wrapper." Stage 1 is that supervisor
plus the minimum shell to host it. **Nothing in `packages/` changed**, and the
one line the web app gained is a fallback that reads exactly as it did before
in a browser.

**The dependency was verified empirically before anything was built**, the same
blocking-finding check UMAP's stage ran with `pip install --dry-run`: Electron
43.4.0 was installed into a throwaway container, its missing GUI libraries
enumerated with `ldd`, and a real `BrowserWindow` opened under Xvfb and asked
to execute JavaScript in its renderer. It answered. Had it not, this stage
would have been reported as blocked rather than written and left unverifiable.

- **The sidecar supervisor is a state machine over failures, and it imports
  nothing.** `apps/desktop/src/sidecar.ts` takes `spawn`, `probe`,
  `allocatePort` and `delay` as injected functions — the same discipline
  `ProjectFileSystem` already follows, and for the same reason: the behaviour
  worth testing is what happens when Python exits during startup, never becomes
  healthy, or dies mid-session, and those are awkward to provoke against a real
  interpreter and trivial against a double. The real effects live beside it in
  `sidecar.node.ts`. Five guarantees, each with a test:
  - **Ready means ready.** `start()` resolves only once `/health` has answered.
    A fixed sleep is the classic way to ship a race that reproduces only on a
    slow machine.
  - **Startup failure fails fast**, and quotes Python's own stderr. A child
    that exits during the poll cannot become healthy, so the poll stops there
    rather than waiting out the 30 s timeout and reporting a generic timeout
    for a problem `ModuleNotFoundError` already explained precisely.
  - **A crash is visible.** An unexpected exit restarts with a backoff and,
    once the budget is spent, reports `failed` through a dialog. The
    alternative is a live window whose every server-backed feature fails
    separately with no shared cause.
  - **A restart that never comes up spends the budget too.** `scheduleRestart`
    recurses through its own catch, so a service dying on every spawn cannot
    report "could not be restarted after 3 attempts" having tried once.
  - **An intentional stop never restarts**, and `stop()` escalates SIGTERM to
    SIGKILL after a grace period.
- **The port is allocated by binding `:0` and letting go, and the race that
  creates is covered rather than engineered away.** Something could take the
  port between allocation and Python's bind; a sidecar that never becomes
  healthy therefore *discards* its port and asks for a fresh one, which a test
  pins. Inheriting a file descriptor instead would remove the race and buy a
  platform-specific launch path on every OS. A restart *reuses* the port, so
  the renderer's API base usually stays valid across one.
- **The watchdog on the Python side is not redundant with the supervisor.**
  `services/api/figureforge/sidecar.py` polls `os.getppid()` and shuts uvicorn
  down when its parent stops matching. The supervisor covers every cooperative
  exit; a SIGKILL, an OOM kill or a power-off runs no handler at all, and each
  mechanism covers exactly the case the other cannot see. `parent_is_gone` is a
  pure predicate compared against the *recorded* pid rather than testing for
  pid 1, which is what keeps it correct under a subreaper, where an orphan's
  new parent is an ordinary process id. It sets uvicorn's own `should_exit`
  rather than exiting hard, so the export renderer's browser pool still gets
  its lifespan shutdown — a hard exit would trade a Python orphan for a
  Chromium one.
- **The sidecar refuses a non-loopback bind.** This service has no
  authentication because as a container it was never exposed beyond the pod; on
  a laptop or a shared lab machine a `0.0.0.0` bind would offer an
  unauthenticated Chromium-backed exporter and image decoder to anyone who
  could route to the host. `--allow-remote` is the explicit opt-out.
  `main.py` is untouched by all of this: the ASGI app is the same object in
  both deployments, so no desktop-only path through the request handlers can
  drift from what the tests cover.
- **`api.ts`'s `BASE` constant became a `base()` function**, and that is the
  entire web-side change. It reads `window.figureforge?.apiBase?.()` and falls
  back to `/api`, so every browser build behaves exactly as before, and it is
  read *per call* rather than captured because a restarted sidecar may come
  back on a different port. Guarded for a missing `window` because the suite
  runs in Node.
- **The renderer is treated as untrusted.** `contextIsolation` and `sandbox`
  are on, `nodeIntegration` off, `webviewTag` off, navigation away from the app
  origin refused, `window.open` denied with genuine `https://` links handed to
  the real browser, and a single-instance lock — a second instance would spawn
  a second sidecar and a second export browser pool and the two would fight
  over the same project files. This is the same stance already taken on the
  export renderer's browser context, which blocks every scheme but
  `data:`/`about:`/`blob:`.
- **The bridge is three keys.** `isDesktop`, `platform`, `apiBase()`. Every
  addition is a permanent widening of what a compromised renderer can reach, so
  stage 2's file dialogs will be the first thing to justify one.
- **The sidecar is started and awaited *before* any window exists**, so the
  preload can hand the renderer a working base URL synchronously and `api.ts`
  needs no promise, no retry and no "not ready yet" state. The cost is a slower
  first paint; the alternative is that same delay redistributed across every
  early request as a race.

#### Two traps, both found by running it

Neither was visible to 721 green tests — the standing "green tests do not mean
the app runs" rule earning its keep twice in one stage.

- **`main.ts` importing a constant from `preload.ts` killed the app at
  startup.** The preload calls `ipcRenderer` at module scope, which exists only
  in a preload context, so requiring it from the main process threw on
  `sendSync` of `undefined` before a window was ever created. The channel name
  now lives in `channels.ts`, which touches no Electron API at all. The rule it
  encodes: anything both sides need must import nothing from either side.
- **A sandboxed preload cannot `require` a relative module.** Its `require`
  resolves only a short allow-list of Electron's own modules, so importing
  `./channels` threw at load and the bridge *silently* never installed — the
  window still opened and React still mounted, so nothing looked wrong until
  the first API call found no base URL. The preload is therefore bundled with
  esbuild (already present transitively via Vite, so no new download), which is
  what lets the channel name keep exactly one definition instead of a literal
  duplicated on both sides of the IPC. Turning `sandbox` off was the other way
  out and was rejected: this app imports untrusted TIFFs and SVGs.

#### Verifying a GUI in a headless container

`docker/desktop.Dockerfile` is **based on the API image, not a Node image** —
the thing under test is a shell that owns a Python sidecar, so a container with
no Python could verify only half of it, and pointing the shell at a service
someone else started would skip the entire lifecycle this stage exists to
build. It is also the closer analogue of a packaged application, which ships an
interpreter beside the executable. Node is copied from the official image
rather than added through a third-party apt repository; both are bookworm, so
the glibc matches. Electron's binary lives in an image path, not in the shared
`node_modules` volume, which the web and test containers install with
`ELECTRON_SKIP_BINARY_DOWNLOAD=1` — they need only the type definitions, never
the 221 MB Chromium.

`scripts/desktop-smoke.mjs` drives the running app over the **Chrome DevTools
Protocol** rather than through Playwright: Electron already speaks CDP with
`--remote-debugging-port`, and Node 22 has `fetch` and `WebSocket` built in, so
the alternative was a new JavaScript dependency for four protocol methods — the
same "avoid the dependency where the published thing is small" stance already
on record for log-rank and PCA.

**Driven for real, 15 checks, all passing:** Electron booted; the React app
mounted; the preload bridge arrived carrying exactly `apiBase, isDesktop,
platform` and nothing else; the API base was a loopback URL with a real
runtime-chosen port (`http://127.0.0.1:33531`); `window.require` and
`window.process` were both `undefined`; the sidecar answered `/health` on that
port reporting **scipy 1.15.0**, so it was the real service rather than a stub;
the renderer reached it **cross-origin**, which the web build never exercises
because Vite proxies it same-origin; exactly one sidecar process was running;
SIGTERM left no orphan; and — the check the watchdog exists for — a **SIGKILL**
of Electron left the sidecar momentarily orphaned and the Python-side watchdog
then reaped it, which nothing in the supervisor could have done.

**Verified:** 721 TypeScript tests (706 + 15 new: the sidecar suite covering
startup, timeout, crash recovery, budget exhaustion, stop escalation and status
reporting), 152 Python tests (139 + 13 new: the watchdog predicate, the
watchdog thread, and the loopback-bind refusal), typecheck and lint clean,
46-check acceptance run unaffected, 15-check desktop smoke run passing.

**One pre-existing defect was found and fixed**: `packages/render/src/render-document.ts`
used `RectMm` in round 10's `rotatedChrome` without importing it. Round 10's
"typecheck clean" claim was wrong — an incremental build had cached over it,
and `tsc --build --force` fails on the round-10 tree. Verified as pre-existing
by stashing this stage's changes and re-running.

**Not done, deliberately** — stage 1 is the shell and the supervisor, and the
following are named here so they are not mistaken for oversights:
native file dialogs and menus still fall back to the browser
`ProjectFileSystem` (stage 2); the archive is still built whole in memory, so
the 300 MB ceiling in the risk table is unchanged (stage 3); and there is no
packaging at all — no electron-builder, no bundled interpreter, no installer,
no code signing (stage 4). A packaged build's `rendererUrl()` branch is
written but only the development path has been run.

### Phase 8, Stage 2 — native dialogs, the application menu, and file access

Stage 1 deliberately reached no filesystem at all. Stage 2 is where the shell
earns its keep: real OS Open/Save dialogs, a File/Edit/View/Help menu, a
recent-projects list, an unsaved-changes guard on quit, and dropping a `.ffg`
on the window to open it. **Round 7's `ProjectFileSystem` turned out to be
exactly the seam this needed** — it was built so the picker/fallback choice
would be testable, and a desktop implementation drops straight into it.

- **`SaveTarget.handle` became `unknown`, and that was the whole adaptation.**
  Research found it is read in exactly one place — `browserProjectFileSystem.write`
  — and treated as an opaque token everywhere else, so a filesystem path could
  take a browser handle's seat without a single call site changing. `App.tsx`
  never learns which implementation it holds; `main.tsx` picks one, and that is
  the only line in the web app that knows the shell exists.
- **`SaveTarget.location` is the one field the desktop adds**, and it is *data*,
  not a platform check. The browser genuinely cannot say where a file went — a
  `FileSystemFileHandle` is a capability, not a path, and round 8 had to settle
  for "the browser remembers this folder for next time" because of it. With a
  location present the confirmation reads `Saved to /home/…/figure.ffg` and the
  status bar's tooltip shows the path; absent, both read exactly as before. No
  `isDesktop` branch anywhere in the UI.
- **The renderer cannot name a path.** This is the security core of the stage.
  `read`/`write` refuse anything the main process did not itself produce — a
  dialog result, a recent entry, or a resolved drop — *and* anything whose
  extension is not `.ffg`/`.figureforge`. Both checks, not either: the
  extension test is what keeps a bug in the granting path from becoming an
  arbitrary file read. `AuthorisedPaths` is pure and tested directly, including
  that `/home/a/../a/figure.ffg` does **not** pass on the strength of
  `/home/a/figure.ffg` having been granted — the set is compared literally, and
  every member came from the OS rather than from the renderer.
  `PROJECT_EXTENSIONS` is hardcoded in `apps/desktop` rather than imported from
  `doc-model`, because this is the process *validating* the renderer and taking
  its word would defeat the check; a **test-only** import of `ARCHIVE_EXTENSIONS`
  asserts the two lists still match, so runtime independence costs no drift.
- **The accelerator rule is the hard part of the menu, and it is inverted from
  the obvious.** An Electron menu accelerator is registered with the OS and
  fires *before* the page — so registering `Ctrl+C`, `Ctrl+V`, `Ctrl+D`,
  `Delete` or `Ctrl+Z` would answer them one way for the whole window and
  silently break the data grid, which chooses between "clear these cells" and
  "delete these nodes" by inspecting what has focus, and the in-cell editor,
  where `Ctrl+Z` is a *text* undo until the cell is untouched. Every such item
  is therefore `registerAccelerator: false`: the shortcut is still **shown**
  next to the item, which is what makes it discoverable, and the key still
  reaches the page. `New`, `Open`, `Save`, `Save As` and the zoom items bind
  keys nothing in the page owns, so they register for real — and `Ctrl+S`
  registering means the menu wins over `App.tsx`'s own listener, which is
  *better* than two paths since both call the same `save()`. Cut/Copy/Paste
  `role` items are omitted entirely: Chromium already handles text editing in a
  focused field, and adding them would register exactly the accelerators this
  paragraph exists to protect.
- **The menu template is a pure function of `ShellState`**, and so is its
  conversion to Electron's option shape. `command` is this codebase's own field
  meaning "ask the renderer to do X"; `toElectronTemplate` turns it into a
  `click` and must not let it survive into the output, where Electron would
  ignore it and the item would look right while doing nothing — which is what
  the conversion test asserts. Keeping both halves pure is what makes
  enablement, the accelerator split and the recent list testable with no
  Electron runtime.
- **Menu commands call what the app already had.** `newFigure` is the one
  genuinely new command, because there was none: the sample document was built
  once as `useDocument`'s initialiser. It clears exactly the four things
  `openFromFile` clears, and produces the same sample the app launches with, so
  New and startup agree what a fresh figure is. **Duplicate and Delete are
  deliberately not dispatched here** — they live in `Canvas`'s keydown, where
  they can tell a canvas selection from a data-grid one, and the menu leaves
  their keys unregistered so that handler keeps them.
- **`save()` now returns whether it saved.** The quit guard needs a real answer
  before it lets the process exit, and every other caller ignores it. A
  *denied* write reports false even though the download rescued the bytes: the
  file the user named was not written, and cancelling the quit is the safe
  reading.
- **Dirty is a boolean set by any commit, not a comparison.** Comparing whole
  documents on every keystroke is expensive, and the cheap approximation errs
  the safe way — undoing back to exactly the saved state still reads dirty, so
  the shell offers to save something that did not need it rather than
  discarding something that did. Counting `history().length` was rejected:
  undo and redo move the position within the history without changing its
  length, which would call an undone-then-redone document clean.
- **The quit guard covers a user quitting, not a SIGTERM.** `before-quit`
  prompts Save / Don't Save / Cancel and, on Save, asks the renderer to run its
  own save and *waits for the answer* — the shell cannot serialise the document
  itself, since the archive is built from state only the renderer holds. A
  30 s timeout resolves false, which cancels the quit: a hung renderer must not
  make the app unquittable, and must not have its work discarded on a guess.
  The `process.on('SIGTERM')` path still exits immediately, on purpose — a
  shutdown request from the system is not a user closing a window, and blocking
  it on a modal dialog would be wrong.
- **Recent files are re-authorised at load, not at save.** The list is a
  per-user JSON in `userData`; the *authorisation* set is per-session and in
  memory, because a path authorised months ago is a standing grant. Picking an
  entry from the menu re-authorises it at that moment, so nothing is lost. A
  `ENOENT` on open drops the entry rather than leaving it failing forever, and
  a corrupt list parses to "no recents" rather than stopping the app — it is
  read during menu construction, so a throw there is a shell that will not
  start.
- **`window.figureforge` is declared in exactly one place.** `api.ts` and
  `desktopFiles.ts` both need it and TypeScript will not merge two `declare
  global` blocks that describe one property differently, so `shell.ts` owns the
  declaration and `api.ts` pulls it in with `import type {}`, which emits
  nothing. The shapes are duplicated from `channels.ts` deliberately —
  `apps/web` must not depend on `apps/desktop`, or the browser build inherits
  the shell — and the IPC channel strings are the real contract between them.

#### What is verified, and what is not

Being explicit, because the gap is real and easy to overstate:

- **Verified by unit test** (37 new): the authorisation rule including the
  traversal and wrong-extension cases, the doc-model extension cross-check, the
  menu's enablement, the accelerator split, the recent list's ordering/bounding/
  corruption handling, and the template→Electron conversion.
- **Verified against the running app** (19 CDP checks, up from 15): the widened
  bridge exposes exactly `apiBase, isDesktop, onMenuCommand, platform, project,
  setShellState`; `openPath('/etc/passwd')`, `openPath` of an unauthorised
  `.ffg` and `write` to an unauthorised path are each **refused across the IPC
  boundary**; and the renderer can push shell state without throwing. Menu
  *installation* is proven indirectly but soundly — `applyMenu()` runs before
  `createWindow()`, so a template Electron rejected would mean no window, and
  the window exists.
- **Not driven, and not claimed**: the native Save/Open dialogs themselves, a
  menu item actually being clicked, the quit-guard message box, the recent-list
  file being written, and the drag-and-drop path. These are OS-level UI and a
  headless container cannot click them. Adding a test-only auto-answer for
  dialogs was rejected for the reason `main.py` is untouched by the sidecar —
  a code path that exists only under test is a path the tests do not cover.
- **The browser build was re-checked in a real browser** (8 checks): the app
  mounts, the status bar still renders its own Save/Open buttons, the
  `.file-target` keeps the "the browser deliberately does not expose one"
  tooltip, `window.figureforge` is `undefined` so all three new effects are
  inert, a panel still selects, and there are no console errors.

**Verified:** 758 TypeScript tests (721 + 37), 152 Python tests unchanged (this
stage touches no Python), typecheck and lint clean, 46-check acceptance run
unaffected, 19-check desktop smoke run, 8-check browser run.

**Not done in stage 2, deliberately:** the status bar keeps its own
Save/Open/Export buttons on desktop rather than deferring to the menu — one
renderer, no desktop-only layout branch, and the redundancy is normal in
desktop apps.
Toolbar commands (insert shape/arrow/text, group, templates, z-order) are
**not** in the menu: they are local closures inside `Toolbar`, unreachable
without lifting them into `App`, and that refactor belongs to whichever stage
actually needs them rather than being smuggled into this one. The archive is
still built whole in memory (stage 3) and there is still no packaging
(stage 4).

### Phase 8, Stage 3 — streaming the archive

The risk table has carried this row since phase 1: *"the archive is built whole
in memory… an OOM and a lost session… what phase 8 (Electron) actually
solves."* This is the stage that redeems it — **on the browser as well as the
desktop**, which was not the original expectation.

**Measured first, because it is a memory claim.** `scripts/archive-memory.ts`
reports `VmHWM` (peak resident set) from `/proc/self/status` — the high-water
mark the kernel observed, not a sampled guess. Peak RSS never falls, so the two
strategies cannot share a process; the script runs twice. On a 200 MB payload:

| 200 MB of images | save peak | then open |
|---|---|---|
| whole buffer (before) | 525.8 MB | 725.9 MB |
| streaming (after) | **337.3 MB** | **589.1 MB** |

Saving went from +200.5 MB to **+1.7 MB** — the archive is no longer
materialised at all. The whole save-then-open cycle dropped 725.9 → 589.1 MB.
The residual is the working set the app must hold either way: the images
themselves.

- **The layout is factored, not rewritten.** `archiveEntries` is now the one
  definition of what is in an archive and in what order; `readArchiveEntries`
  is everything `loadArchive` does after the unzip. `saveArchive` and
  `loadArchive` are thin wrappers over them and keep their signatures — which
  is why the 46-check acceptance run, which calls both directly, did not move.
  `archiveEntries` holds *references* to the caller's bytes, never copies,
  which is what lets the streaming writer be bounded at all; a test pins that.
- **`archive-stream.ts` is DOM-free and Node-free**, so one implementation
  serves the browser's `FileSystemWritableFileStream` and the desktop's IPC
  chunks. That is also what keeps `apps/desktop` free of internal dependencies:
  the zipping happens in the renderer for both platforms and the shell is a
  byte sink.
- **The browser already had a stream and was not using it.**
  `browserProjectFileSystem.write` has always called `createWritable()`; it
  wrote a single buffer into it. Feeding it chunk by chunk was nearly free once
  the layout was factored, so the ceiling lifted for the web build too — the
  risk row no longer claims Electron is what solves this.
- **`ProjectFileSystem` now takes a project, not bytes.** `write(target,
  contents)` and `pickOpen(): { result: LoadResult }` let each implementation
  choose how to serialise. Optional `writeStream?`/`openStream?` beside the
  byte methods was the alternative and was rejected: two ways to do one thing.
- **The manifest carries every entry's uncompressed size, and that is not
  cosmetic.** The first reader collected an entry's chunks and joined them at
  the end — which holds the pieces *and* the result, i.e. two copies of the
  largest micrograph. Measured, that peaked at **765 MB against the
  whole-buffer reader's 722 MB**: worse than the thing it replaced, on exactly
  the "several hundred-megabyte TIFF" this format exists to carry. fflate's
  `originalSize` is unavailable here because its streaming writer emits data
  descriptors (verified directly — declaring `size`/`crc` up front does not
  change it), so `Manifest.entrySizes` supplies them instead. The manifest is
  the first entry, so it has always arrived before anything it describes.
  Optional, and absent it falls back to collecting, so older archives still
  open.
- **Desktop writes go to a temp file and are renamed into place.** Streaming
  makes this necessary rather than tidy: bytes now reach the disk long before
  the archive is complete, so a failure part-way would otherwise leave a
  truncated file that still ends in `.ffg` and opens with an image missing. The
  rename is atomic within a filesystem, so the target is either the previous
  save or the complete new one. Tests cover the abort leaving both the previous
  file *and* the directory untouched.
- **Reads are pulled, not pushed.** The renderer asks for the next 4 MB chunk
  when it is ready for one, which is backpressure for free; pushing would
  buffer without bound in the renderer if it fell behind the disk — the exact
  failure this stage exists to remove.

#### A hole found by writing the test

Stage 2's authorisation set only ever held paths the shell itself produced.
Stage 3 needed a way to reopen a *recent* entry, and the first version of
`resolve(path)` simply granted whatever it was handed — which would have let a
compromised renderer read any `.ffg` on the disk. It now accepts only paths
already in the shell's own recent list. Dropped files travel on a **separate
channel**, because they carry different evidence: the preload derives their
path with `webUtils.getPathForFile`, which returns empty for anything the page
fabricated, so arriving on that channel is itself the proof a real file was
dropped. Both refusals are asserted through the real IPC in the smoke run.

**Verified:** 789 TypeScript tests (758 + 31: the streaming writer and reader
including five pathological chunkings down to one byte at a time, a truncated
stream refusing rather than returning a partial project, `archiveEntries`
order/levels/reference-holding, and the desktop's chunked file I/O against a
real temp directory), 152 Python tests unchanged (no Python in this stage),
typecheck and lint clean, **46-check acceptance run unaffected**, a **21-check
desktop smoke run** (19 + the two new refusals), and a **6-check browser run**
driving a real streamed save and reopen with no console errors.

**Not done, deliberately:** the download fallback for Firefox/Safari still
builds one buffer — it hands a `Blob` to an anchor and there is no stream to
give it instead, so `saveArchive` remains for exactly that caller. Export still
serialises the whole SVG in memory and is unchanged. The two writers produce
*different bytes* for the same project (a streaming zip emits data descriptors
a whole-buffer one has no need for); the tests assert the archives round-trip
to equal contents rather than pretending the bytes match.

---

## What's next

Phases 5–9, with the actual entry points:

| Phase | Scope | Where to start |
|---|---|---|
| 3 | **done** — all 9 plot types render | `PlotGeometry` is a discriminated union on `kind: 'categorical' \| 'continuous'`; `renderNumericXTicks` is the numeric x axis |
| 4 | **done** — image panels, crop, scale bars, annotations | `apps/web/src/assets.ts` is the asset store; `scaleBarWidthMm`/`resyncScaleBars` in `operations.ts`; `/decode-image` in the API |
| 5 | **done** — remaining stats surface | `services/api/figureforge/stats/tests.py`; `run_test`'s `x`/`x_name` params, the `anova-rm` dispatch branch |
| 6 | **done** — export/QC hardening, autofixes | `Finding.fix` in `quality.ts`, recipes in `fixes.ts`; `apps/web/src/exportImages.ts` bakes crops |
| 7 | **done** — all five chart types (volcano, heatmap, survival, PCA, UMAP) | the DOM-volume prerequisite — `planPointClouds`/`MAX_VECTOR_POINTS` in `render-document.ts`; volcano's `'differential'` format and per-point colour resolution, heatmap's `GridPlotGeometry`/`PlotGeometryBase` split and colour-scale machinery, survival's `toSurvivalGroups`/`kaplanMeier` data-prep path reusing the ordinary continuous geometry, PCA's "Analysis output becomes a new plottable Dataset" mechanism (`figureforge/pca.py`, the `'pca'` `DataFormat`, `DataTab`'s "Run PCA" action), and UMAP's reuse of that same mechanism plus its own new dependency (`figureforge/umap.py`, the `'umap'` `DataFormat`, "Run UMAP") — see "Phase 7, Stage 1" through "Stage 5" below |
| 8 | **stages 1–3 done** — shell + sidecar lifecycle, native dialogs and the menu, then streaming archive I/O; stage 4 (packaging) open | `apps/desktop/src/sidecar.ts` is the supervisor (injected effects; the real ones in `sidecar.node.ts`), `figureforge/sidecar.py` the parent watchdog, `channels.ts` the one place both Electron worlds may import from; `make desktop` runs it, `make desktop-smoke` asserts on it. Stage 2's entry points are `apps/desktop/src/{menu,projects,projects.node,recent}.ts` and `apps/web/src/{shell,desktopFiles}.ts`; stage 3's are `packages/doc-model/src/archive-stream.ts` and the chunked bridge in `projects.node.ts`; stage 4 is electron-builder plus a bundled interpreter — see "Phase 8, Stage 1" through "Stage 3" |
| 9 | AI layout assistant | `packages/doc-model/src/layout.ts` already has the geometry |

### Already scaffolded but unused

- **Panel `slot`** (`{row, col, rowSpan, colSpan}`) is written by layout
  templates and honoured by `autoLayout`, but nothing lets a user author a slot
  directly — templates are the only way to set one. It is also *cleared*
  whenever layout runs without a template; see the reported-bug rounds for why.
- **`theme.stroke.bracketMm`** is declared and read by nothing; `addBracket`
  hardcodes `widthMm: 0.18`. `theme.spacing.bracketGapMm` was in the same state
  until round 4 wired it into `bracketStepMm`.
- The `'legend'` `SceneRole` was in this list for six phases. Round 4 emits it —
  see `renderLegend`.
- **`NodeBase.rotation`** belonged in this list for nine rounds and nobody
  noticed: modelled, in the schema, defaulted by `baseNode` and already applied
  by `renderNode`, with no UI anywhere and no document ever holding a non-zero
  value. Round 10 wired it — see "Round 10". It is offered on `shape`/`arrow`/
  `text` only, and **that restriction is load-bearing**, not a staging decision:
  `absoluteFrame` ignores rotation, so a rotated container would misplace every
  descendant's chrome and every layout measurement. Widening it means fixing
  `absoluteFrame`, `snapFrame`, `alignFrames` and `measureGutters` first.

### Declared-but-missing things — check before trusting the types

- **All 12 `PlotType` variants now render distinctly.** The dropdown is gated
  on what the *dataset* supports rather than on what is implemented (`typesFor`
  in `Inspector.tsx`): scatter and line need paired `Series.x`, which `toSeries`
  supplies only for `simple-xy`/`prism`/`sigmaplot`/`xy-replicates`; a histogram needs a single
  series, since pooling groups invents a bimodal shape belonging to neither;
  volcano needs a single series carrying `Series.pointLabels`, which only the
  `differential` format supplies; heatmap needs a `matrix`-format dataset and
  survival needs a `survival`-format dataset, both gated on the dataset's
  format directly rather than on a `Series`-derivable shape, since both bypass
  `Series` entirely (`toMatrix`/`toSurvivalGroups`).
  `computePlotGeometry` returns null for an unsupported combination, so a
  type set some other way draws nothing rather than something wrong.

---

## Risks and open problems

| Risk | Detail |
|---|---|
| **Electron packaging** | *Half fixed.* The lifecycle half — the part this row called "real work, not a wrapper" — is done and verified: `apps/desktop` supervises a real Python child (free port, health-gated readiness, backoff restarts, SIGTERM→SIGKILL teardown) and `figureforge/sidecar.py` reaps itself if the parent is SIGKILLed, proven by a smoke check that does exactly that. **Packaging itself is untouched**: no electron-builder, no bundled interpreter, no installer, no code signing, and the app is only ever run from a checkout. `make desktop-smoke` is a container harness for verifying the shell, not a release pipeline. |
| **Omics panel volume** | *Fixed, for point counts.* A plot over `MAX_VECTOR_POINTS` (2,000, measured — see "Pre-phase-7") bakes to one raster instead of one SceneNode per point, on both the live canvas and export. Phase 7's chart types still need their own geometry (a heatmap's cell count, a UMAP/volcano's point count all reuse this; a survival curve's step count is small enough to never cross the threshold) — this answers the *rendering-volume* mechanism, not the remaining maths. |
| **Stale bracket positions** | *Fixed.* `repositionBrackets` re-measures on layout, resize and import; `userOffsetMm` preserves manual nudges. The staleness *warning* (data edited after a test) now fires in the Stats tab and the quality checker, but nothing re-runs the test automatically — by design. |
| **`measurePlot` recomputes** | *Mitigated.* Memoised on `(plot, dataset, theme)` object identity. The cache is per-call-site correct but unbounded reasoning applies: it is a `WeakMap`, so entries die with their nodes. |
| **No schema migrations** | `SCHEMA_VERSION` is still 1 and `loadArchive` rejects anything newer. Every field added since (`plotId`, `userOffsetMm`, `comparisonIndex`, `gapMm`, `slot`, `pointsUseSeriesColor`, `calibrationSource`, `errorBarDirection`, `pointShape`, `pointFill`, `pointStroke`, `y2`, `seriesAxis`, `minorTicks`, `tickDirection`, `breaks`, and round 4's `hasRowNames`, `columnGroups`, `editedAt`, `legend`, `errorDisplay`, `contentGrid`, and round 5's `showReplicates`, `pointShapes`, `barGapFraction`, `groupGapFraction`, phase 7 stage 1's `volcanoThresholds`, `volcanoColors`, `volcanoThresholdLines`, stage 2's `heatmapScale`, `heatmapStops`, `heatmapMissingColor`, `showCellValues`, and stage 3's `showCensorMarks`, `showSurvivalCI`, and round 7's `labelFormat`, `labelDecimals` on `AxisSpec`, `linthresh` on `AxisSpec`, `volcanoLabels`, `offsetStepMm`, `offsetStepXMm`, `offsetFill` on `PlotNode`, and round 8's `clipToRange` on `AxisSpec`, `pointLabelOffsets`, `pointLabelSizePt`, `showCascadeAxis`, `cascadeAxisTitle` on `PlotNode`, and round 9's `boxed`, `showGridlines`, `gridlineColor`, `gridlineStyle` on `PlotNode`) is **optional**, so old files still load. **Round 10 added no field at all**: rotation writes `NodeBase.rotation`, which has been required and defaulted since phase 1 and is simply the first round to set it to something other than `0`; `SceneNode.editTarget` is render-time metadata that is never persisted; and the new layout templates and `clearBlock` touch no schema. Stages 4 (PCA) and 5 (UMAP) added no new `PlotNode` fields at all — the smallest schema footprint of any phase-7 stages, since both are the existing `scatter` type. Round 4 also widened the `format` enum by three members, phase 7 stage 1 by one more (`differential`), stage 2 by one more again (`matrix`), stage 3 by one more again (`survival`), stage 4 by one more again (`pca`), and stage 5 by one more again (`umap`), which is backward-compatible in the same direction `contingency` already was: an older build cannot read the new layouts, but every file it *has* still validates. The `plotType` enum was widened the same way three times (not five — `pca` and `umap` both reuse `scatter`), for the same reason — a `volcano`, `heatmap` or `survival` node is unreadable by an older build, not unreadable by this one. `StatTest` gained `'log-rank'` the same additive way. Round 7 widened `AxisSpec.scale` by one member (`'symlog'`), the same direction as every other enum widening here — an existing `'linear'`/`'log10'` axis is untouched, and only a `'symlog'` axis is unreadable by a pre-round-7 build. Phase 4 also *narrowed* `crop.width`/`height` from non-negative to `.gt(0).max(1)`, which would normally force a bump — it did not, because nothing could create an image node before that change, so no file in existence contains one. The next *required* field forces it. **zod strips unknown keys**: a field added to a TS type but not to `schema.ts` is silently dropped on save/load. |
| **Text metrics are estimated** | `text-width.ts` uses static Helvetica/Arial advance widths. Correct for the shipped Liberation Sans, and deterministic across canvas and export, which is what matters — but a user-supplied font with different metrics would make the collision decisions slightly off. This now sets the *plot area*, not just label angles: `requiredMargin` sizes the gutters from these numbers, so a mismatched font shifts geometry rather than only the odd label. |
| **No autosave or session restore** | *Guarded on the desktop only.* The shell's `before-quit` now prompts Save / Don't Save / Cancel and can run the renderer's own save before exiting (phase 8 stage 2), so a desktop quit no longer silently discards work. **The browser is unchanged**: closing the tab still loses everything unsaved, and there is still no `beforeunload` guard. Saving is explicit and now names its own file, which was the reported ask; a restore-on-reload store was scoped out of stage B rather than half-built. `store.ts` records patches and their inverses, so incremental autosave is one mechanism away when it is wanted. |
| **Autofixes are advertised, not implemented** | *Fixed.* `autoFixable: boolean` is gone; `Finding.fix?` carries the recipe the rule built while it still had the answer. A boolean can claim a repair that does not exist, a closure cannot. Ten claims became seven fixes plus one conditional; the three that needed an authorial decision were withdrawn rather than faked. |
| **The archive is built whole in memory** | *Fixed, and not only on the desktop.* `writeArchiveStream`/`readArchiveStream` move the archive a chunk at a time, so it is never materialised: measured on a 200 MB payload, the save peak fell 525.8 → 337.3 MB (+200.5 MB of overhead became +1.7 MB) and the save-then-open cycle 725.9 → 589.1 MB. The browser benefits too — `createWritable()` was always a stream and was simply being handed one buffer. What remains is the working set the app must hold either way: the images themselves. The **download fallback** for Firefox/Safari still builds one buffer, because it hands a `Blob` to an anchor and there is no stream to give it instead. |
| **Cropped images ship at full size** | *Fixed at export time.* `renderImage` still crops by clipping — that is what keeps every retained pixel at capture resolution, and `parity.test.tsx` pins it. `flattenCropsForExport` instead builds a throwaway document whose cropped nodes point at synthetic PNG assets holding only their crop, so `packages/render` stays synchronous and DOM-free. Measured: a 1200×900 micrograph cropped to 30%×30% took the export payload from 4234 KB to 438 KB. It withholds itself where it would not be exact — vector assets and trivial crops. The letterboxed case was on that list until round 6, for a real reason: the drawn window was not the crop the document named, so baking the nominal rect changed the picture. `renderImage` now places the kept region itself, the two forms draw identically, and a montage tile's crop is baked like any other — measured, a 200×100 source cropped to a quadrant embeds as 100×50. |
| **Opening a TIFF project needs the API** | The archive stores only the original bytes, so the PNG display proxy is regenerated on open. If the service is down the images render as placeholders and a message says why; everything else in the figure still works. Reversible with one optional field (`Asset.proxyPath?`) if the trade proves wrong. |
| **16-bit micrographs export at 8 bits** | The archive keeps the 16-bit original verbatim, so reproducibility holds, but the figure ships the 8-bit proxy with the observed range mapped linearly. Correct for print, and reported in the UI rather than left to be discovered. |
| **JPEG EXIF orientation is ignored** | A rotated JPEG displays in its stored orientation. Detecting *whether* a JPEG needs transposing requires client-side EXIF parsing, and routing every JPEG through the server for the 1% that need it is a bad trade. Not half-done on purpose. |
| **Font licensing** | Arial is not redistributable. The image ships Liberation Sans, which is metrically identical so layout is unaffected, and the theme stack falls back to it. A user wanting genuine Arial must supply it. |

---

## Environment traps already hit

Each of these cost time once and will again:

- **The host shell is sandboxed from pod-published ports.** `curl localhost:8000`
  from the host returns nothing even when the service is healthy. Verify from
  *inside* the pod (`podman exec figureforge-web node -e '...'`) or with a
  container joined to the pod (`podman run --pod figureforge ...`).
- **The Bash tool's working directory persists between calls.** A stale `cd` from
  an earlier command silently made `-v "$PWD":/app` mount the wrong directory.
  Use absolute paths in mounts.
- **`python:3.12-slim` now resolves to Debian trixie**, where Playwright's
  `--with-deps` fails on font packages Debian has dropped. Pinned to
  `python:3.12-slim-bookworm`. Do not un-pin it.
- **`@eslint/js@10` requires ESLint 10**; this repo is on the v9 line. Both must
  move together.
- **SELinux needs `:z` on every bind mount** (this is Fedora), and `node_modules`
  must be a named volume, not part of the bind mount.
- **Vite needs `usePolling`** — inotify events do not cross the container boundary
  reliably.
- **Piping a build through `tail` masks its exit code.** An image build "succeeded"
  with exit 0 while actually failing. Check the output, not `$?`.
- **zod rebuilds objects in schema key order**, so `JSON.stringify` comparison of
  a round-tripped document reports a difference that does not exist. Use
  `stableStringify` from `analysis.ts`.
- **A raw NUL byte in a source file makes `grep` skip it silently.** One crept
  into `analysis.ts` (a `'\x00'` where `' '` was intended) and `file` reported the
  source as `data`; greps for symbols in it returned nothing, which reads exactly
  like "that symbol does not exist". Fixed, but if a symbol you can see with
  `sed`/`tail` won't `grep`, check `file` and scan for `\x00` before concluding
  anything.
- **`python-multipart` is a separate dependency.** FastAPI needs it for any
  `UploadFile`, and without it `/decode-image` fails at import. Adding it forces
  an API image rebuild — `make build`, not just a restart.
- **CORS `expose_headers` is needed to read a custom response header.**
  `/decode-image` returns its metadata in `X-Image-*` headers, which a
  cross-origin fetch cannot see unless they are exposed. The dev pod's Vite proxy
  makes the call same-origin, so this is invisible there and would silently
  return a PNG with no dimensions under `compose.yaml`.
- **Pillow's `point()` rejects an `int()` cast inside the callable.** It probes
  the function with a sentinel to derive a scale and offset, so the lambda has to
  stay a plain affine expression or it raises rather than falling back.
- **`Image.MAX_IMAGE_PIXELS` must be raised, never set to `None`.** A whole-slide
  scan legitimately exceeds the ~178 Mpx default, but disabling the guard turns a
  hostile upload into an OOM kill of the service.
- **React wants camelCase SVG attributes.** The scene stores canonical hyphenated
  names (what the exporter writes verbatim); `react.tsx` converts. Both adapters
  must still emit identical markup — the parity test enforces it.
- **`vitest.config.ts` did not include `apps/**`.** A test written under
  `apps/web` ran silently never. Fixed, with `environment: 'node'` kept
  deliberately: a jsdom default would let an accidental DOM import into
  `packages/render` pass, which is the one thing that breaks export fidelity
  invisibly.
- **Green tests do not mean the app runs.** The suites render through the string
  serialiser and `renderToStaticMarkup`; neither mounts the real UI. A `style`
  string on a scene node passed every one of them and threw in the browser,
  blanking the canvas on any selection. Playwright is already in the API image
  (it drives export) and can reach the web container across the shared pod
  namespace — use it to click through a change before calling it done:
  `podman cp smoke.py figureforge-api:/tmp/ && podman exec figureforge-api python /tmp/smoke.py`.
- **Playwright clicks an element's centre.** A Layers row's centre is its delete
  button, so `row.click()` deletes the node instead of selecting it. Target the
  name span. Likewise `inner_text()` fails on SVG (`text_content()` works), and
  a synthetic `input` event does not drive a React controlled input — use
  `fill()`, which goes through the native setter React tracks.
- **A sandboxed Electron preload cannot `require` a relative module**, and it
  fails *silently* — the window opens, React mounts, and only the first API
  call reveals that the bridge never installed. Its `require` resolves a short
  allow-list of Electron's own modules and nothing else, so `apps/desktop`
  bundles the preload with esbuild. If you add a preload import, check it
  survives the bundle rather than assuming tsc's output is what runs.
- **Anything the Electron main process and the preload both import must import
  nothing itself.** `preload.ts` touches `ipcRenderer` at module scope, so a
  main-process `require` of it throws on `undefined.sendSync` before any window
  exists — the app dies at startup with every unit test green. Shared constants
  live in `apps/desktop/src/channels.ts` for exactly this reason.
- **`npm install` here does not run lifecycle scripts.** Electron's postinstall
  therefore never fetches its binary, and `node_modules/electron` looks
  correctly installed while carrying no `dist/`. `docker/desktop-entrypoint.sh`
  invokes `install.js` explicitly rather than trusting the postinstall.
- **`tsc --build` caches across a broken tree.** A `RectMm` that was never
  imported survived round 10's "typecheck clean" because the incremental build
  skipped the project. Use `tsc --build --force` before claiming a clean
  typecheck.
- **An Electron menu accelerator fires before the page.** Registering one for a
  key the renderer already handles *context-sensitively* silently breaks it —
  `Ctrl+C`/`Delete` mean "clear these cells" in the data grid and "delete these
  nodes" on the canvas, and `Ctrl+Z` in a typed-in cell is a text undo. Use
  `registerAccelerator: false` to display the shortcut without taking the key.
- **fflate's streaming `Zip` always emits data descriptors**, so an archive it
  wrote has no size in its local headers and `UnzipFile.originalSize` is
  `undefined` when reading one back. Declaring `size`/`crc` before `add()` does
  not change it (verified directly). A streaming reader therefore cannot
  pre-allocate from the zip alone — `Manifest.entrySizes` exists for that, and
  without it the reader holds two copies of the largest file.
- **`toEqual` on a multi-megabyte `Uint8Array` is a per-element walk.** One
  9 MB round-trip assertion took 23 seconds and made the desktop suite unusable;
  `Buffer.compare` is the same assertion in milliseconds.
- **`File.path` was removed in Electron 32.** A dropped file's path now comes
  from `webUtils.getPathForFile`, which is a main-world module the sandboxed
  page cannot reach — so it has to be called in the preload.
- **`xvfb-run` needs `xauth`**, which the slim images do not carry; without it
  it exits with `xauth command not found` before your program starts. It also
  outlives a crashed child, so a hung container may be `xvfb-run` waiting on
  nothing — check with `ps` inside it rather than assuming the app is running.

### Export traps encoded in the code

Three are handled deliberately in `services/api/figureforge/export/renderer.py`;
if you touch that file, keep them:

1. **`svg { display: block }`** — an inline SVG sits on a text baseline and the
   descender space beneath it spills past the page box, producing a second blank
   page, after which Ghostscript refuses EPS conversion entirely.
2. **Chromium rounds the page box up to a whole 1/300 inch**, so 183 mm lands on
   183.13 mm. `crop_to_exact` trims it back. **Crop, never scale** — rescaling
   would shrink every font below the minimum the theme guarantees.
3. **Fonts and the Chromium build are pinned in the image**, which is what makes
   exports reproducible across machines.
4. **`eps2write` gets `-r` matching the export dpi.** It is a vector device that
   re-emits any embedded raster at the device resolution, which defaults to
   720 dpi. Measured in this image: on a figure with an embedded raster `-r300`
   produced an EPS 14% smaller than the default; on vector-only output the
   difference was 0.1% and the `%%BoundingBox` was byte-identical.

---

## Conventions

- Match the surrounding comment density. Comments explain **why**, not what —
  most existing comments justify a non-obvious choice, and that is the bar.
- Tests assert against **externally published reference values** wherever they
  exist. A test that only proves the code agrees with itself is not worth much.
- **Verify by running things.** Every claim in this file was checked against real
  output — test counts from a run, PDF dimensions from the MediaBox, DPI from the
  pixel count. Hold new claims to the same standard.
- Report honestly: if something is declared but not implemented, say so (see the
  two cases above) rather than letting the type signature imply otherwise.
