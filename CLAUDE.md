# FigureForge — working context

Publication-ready multi-panel figure assembly for life-science journals: the
layout control of Illustrator, the plotting of Prism, and reproducibility that
neither offers.

Requirements source of truth: [`build-a-nature-style-platform.md`](build-a-nature-style-platform.md).
That spec describes a multi-year product surface (30+ chart types, omics compute,
Electron, an AI layout assistant). It was deliberately cut to one complete
vertical slice — data in, publication-ready vector out — so the architecture
could be proven before breadth was added. **Phases 1–6 are done, plus four rounds of reported fixes; phases 7–9 are not.**

---

## Running it

Everything runs in containers. **The host has no Node and no Python scientific
stack** — never run `npm` or `pytest` on the host, run them inside the containers
(the Makefile targets already do).

```bash
make up          # build images, start the pod
                 #   web -> http://localhost:5173
                 #   api -> http://localhost:8000/health
make test        # 313 TypeScript + 105 Python tests
make acceptance  # 46-check end-to-end run (needs `make up` first)
make down
```

`make help` lists all 15 targets.

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
packages/doc-model/   model, zod schema, undo/redo, layout, operations, .figureforge I/O
packages/theme/       journal presets, palettes, colour-vision validation
packages/plots/       scales, summary statistics, mark geometry   ← maths only
packages/render/      scene tree → {React | SVG string}, quality checker  ← drawing only
apps/web/             Vite + React canvas, inspectors, import/export UI
services/api/         FastAPI: SciPy statistics, Chromium/Ghostscript export, TIFF decoding
scripts/acceptance.ts end-to-end flow, no UI involved
```

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

Phases 1–6 are on `master`, plus **four** rounds of reported bugs and requests.
Round 4 (crop, brackets, the Prism table shapes, the data grid, multi-image
panels) is done — see "Round 4" below. **Round 5 is in progress on
`feat/round-5-*`**: the import surface, one reported item at a time — stage 1
(xy pairs) and stage 2 (a shared x with replicate y) are merged. Run
`git status` and `git branch` before assuming the tree is clean or which branch
you're on.

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
two-group × three-replicate table) and `test graphs.prism`.

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

---

## What's next

Phases 5–9, with the actual entry points:

| Phase | Scope | Where to start |
|---|---|---|
| 3 | **done** — all 9 plot types render | `PlotGeometry` is a discriminated union on `kind: 'categorical' \| 'continuous'`; `renderNumericXTicks` is the numeric x axis |
| 4 | **done** — image panels, crop, scale bars, annotations | `apps/web/src/assets.ts` is the asset store; `scaleBarWidthMm`/`resyncScaleBars` in `operations.ts`; `/decode-image` in the API |
| 5 | **done** — remaining stats surface | `services/api/figureforge/stats/tests.py`; `run_test`'s `x`/`x_name` params, the `anova-rm` dispatch branch |
| 6 | **done** — export/QC hardening, autofixes | `Finding.fix` in `quality.ts`, recipes in `fixes.ts`; `apps/web/src/exportImages.ts` bakes crops |
| 7 | heatmaps, PCA, UMAP, volcano, survival | new mark types; needs the DOM-volume answer below first |
| 8 | Electron shell | new; see the sidecar risk below |
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

### Declared-but-missing things — check before trusting the types

- **All 9 `PlotType` variants now render distinctly.** The dropdown is gated on
  what the *dataset* supports rather than on what is implemented (`typesFor` in
  `Inspector.tsx`): scatter and line need paired `Series.x`, which `toSeries`
  supplies only for `simple-xy`/`prism`/`sigmaplot`/`xy-replicates`; a histogram needs a single
  series, since pooling groups invents a bimodal shape belonging to neither.
  `computePlotGeometry` returns null for an unsupported combination, so a type
  set some other way draws nothing rather than something wrong.

---

## Risks and open problems

| Risk | Detail |
|---|---|
| **Electron packaging** | Web-first deferred this, it did not remove it. The desktop shell needs Python bundled as a sidecar process with lifecycle management — real work, not a wrapper. |
| **Omics panel volume** | A 100k-point UMAP as SVG nodes will kill the DOM. Phase 7 needs downsampling or a canvas/WebGL inset before the marks are written, not after. |
| **Stale bracket positions** | *Fixed.* `repositionBrackets` re-measures on layout, resize and import; `userOffsetMm` preserves manual nudges. The staleness *warning* (data edited after a test) now fires in the Stats tab and the quality checker, but nothing re-runs the test automatically — by design. |
| **`measurePlot` recomputes** | *Mitigated.* Memoised on `(plot, dataset, theme)` object identity. The cache is per-call-site correct but unbounded reasoning applies: it is a `WeakMap`, so entries die with their nodes. |
| **No schema migrations** | `SCHEMA_VERSION` is still 1 and `loadArchive` rejects anything newer. Every field added since (`plotId`, `userOffsetMm`, `comparisonIndex`, `gapMm`, `slot`, `pointsUseSeriesColor`, `calibrationSource`, `errorBarDirection`, `pointShape`, `pointFill`, `pointStroke`, `y2`, `seriesAxis`, `minorTicks`, `tickDirection`, `breaks`, and round 4's `hasRowNames`, `columnGroups`, `editedAt`, `legend`, `errorDisplay`, `contentGrid`, and round 5's `showReplicates`) is **optional**, so old files still load. Round 4 also widened the `format` enum by three members, which is backward-compatible in the same direction `contingency` already was: an older build cannot read the new layouts, but every file it *has* still validates. Phase 4 also *narrowed* `crop.width`/`height` from non-negative to `.gt(0).max(1)`, which would normally force a bump — it did not, because nothing could create an image node before that change, so no file in existence contains one. The next *required* field forces it. **zod strips unknown keys**: a field added to a TS type but not to `schema.ts` is silently dropped on save/load. |
| **Text metrics are estimated** | `text-width.ts` uses static Helvetica/Arial advance widths. Correct for the shipped Liberation Sans, and deterministic across canvas and export, which is what matters — but a user-supplied font with different metrics would make the collision decisions slightly off. This now sets the *plot area*, not just label angles: `requiredMargin` sizes the gutters from these numbers, so a mismatched font shifts geometry rather than only the odd label. |
| **No autosave or session restore** | Closing the tab loses everything unsaved, and there is no `beforeunload` guard. Saving is explicit and now names its own file, which was the reported ask; a restore-on-reload store was scoped out of stage B rather than half-built. `store.ts` records patches and their inverses, so incremental autosave is one mechanism away when it is wanted. |
| **Autofixes are advertised, not implemented** | *Fixed.* `autoFixable: boolean` is gone; `Finding.fix?` carries the recipe the rule built while it still had the answer. A boolean can claim a repair that does not exist, a closure cannot. Ten claims became seven fixes plus one conditional; the three that needed an authorial decision were withdrawn rather than faked. |
| **The archive is built whole in memory** | `zipSync` returns one `Uint8Array`, so a project with several hundred-megabyte TIFFs is a single allocation of that size in a browser tab — an OOM and a lost session. The Data tab shows a running total and warns past 300 MB, so the ceiling is anticipated rather than discovered at save time. This is the real limit on TIFF support in a web app, and what phase 8 (Electron) actually solves. |
| **Cropped images ship at full size** | *Fixed at export time.* `renderImage` still crops by clipping — that is what keeps every retained pixel at capture resolution, and `parity.test.tsx` pins it. `flattenCropsForExport` instead builds a throwaway document whose cropped nodes point at synthetic PNG assets holding only their crop, so `packages/render` stays synchronous and DOM-free. Measured: a 1200×900 micrograph cropped to 30%×30% took the export payload from 4234 KB to 438 KB. It withholds itself where it would not be exact — vector assets, trivial crops, and the letterboxed `preserveAspectRatio` case. |
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
