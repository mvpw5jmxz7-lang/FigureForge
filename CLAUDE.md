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

**`GUIDE.md` and `README.md` were rewritten after phase 8 stage 3 to describe
the app that actually exists**, not the one from when they were first
written. `GUIDE.md` (the non-developer guide) previously said other chart
types "draw something using bar/dot logic," image import "can't be done
yet," several stats tests "aren't reachable," and heatmaps/PCA/UMAP/volcano/
survival were "not built" — all shipped since, over phases 4–7. It now lists
every chart type, all reachable statistics, and image panels as working, and
states the real remaining gaps honestly (no installer, no AI layout
assistant, no autosave). It also gained a section for someone who has never
used Docker on moving the project to another computer (git clone vs.
zip-and-copy, and separately, sharing just a `.ffg` file) and first-time
Windows install steps — the previous version covered only macOS and Linux.
The prior version was kept as `GUIDE.old.md`, deleted since. `README.md`'s Status section had
the identical staleness (still said "Phases 1–6 complete... Phases 7–9 not
yet built") and was corrected the same way, plus its package-layout listing
gained `apps/desktop`. Deliberately **not** mentioned in `GUIDE.md`: the
Electron desktop shell (`make desktop`) — it is a dev/test harness run from a
checkout, not a packaged, downloadable app (stage 4), and advertising it to a
non-developer would be misleading. Checked by hand rather than run: every
internal anchor link against its heading, and every shell command shown
against `Makefile`/`compose.yaml`. There is no automated test over prose, so
this is not part of the TypeScript/Python counts below.

**Verified after round 51 (six polishing steps: montage selection, import
titles, a blank start, a save guard, hidden controls, orphaned files):** 1240
TypeScript tests (1237 + 3 new: two in `quality.test.ts` pinning that an empty
document renders and scores, plus a `toSvgString` guard), 248 Python tests
unchanged (nothing here touches `services/api`), `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected, and **52 + 32 + 28
live-browser checks in each of light and dark** across the three surfaces.
**No schema change, no new field, no model or renderer change** —
`SCHEMA_VERSION` stays 1. **Measured, not assumed**: a plain click on a montage
tile now selects the panel and drags all four tiles by an identical 60.6 px,
where a double-click selects one tile and moves it alone by 39.0 px with the
other three at 0.0; the app opens with **0 document nodes at readiness 100**
with no error-severity finding, so the export confirmation does not greet a new
user; the layout dropdown reads four `<optgroup>`s with Detect outside them,
every name under 60 characters, and the seven-column proteomics example
scrolling inside the 340 px panel rather than overflowing it; and a dirty page
cancels its own unload event while a clean one reloads untouched. **Three
harness traps of my own, all caught by measuring**: a hand-written base64 PNG
was rejected by the browser's own decoder (the app behaving correctly), the
"Detect" option belongs to the *delimiter* select too so the first run measured
that one and reported delimiter names as ungrouped layout names, and the
Inspector's `h4` headings are uppercased in CSS so a literal "Fitted line"
match reported a block that was right there. **The montage and fit-select
guards were confirmed to fail against the unfixed code** — reverting each rule
alone fails exactly its own checks — because both claims are behaviour
inversions, and a harness that passes either way would prove nothing. See
"Round 51" below.

**Verified after round 50 (column-wise distributions, cumulative curves, and
the distribution tests):** 1237 TypeScript tests (1203 + 34: 2 in a new
`ecdf.test.ts` against hand-worked ECDF steps, and 32 across
`doc-model.test.ts`, `continuous-axis.test.ts` and `parity.test.tsx` covering
the new format, the shared-bin-edges histogram, the ECDF geometry and the KS
gap marker), 248 Python tests (204 + 44: the four new tests' dispatch
branches, each SciPy-quirk guard, and the p-bound formatting), `tsc --build
--force`, `eslint .` and `ruff check` clean, 46-check acceptance run
unaffected, and **24 live-browser checks in each of light and dark**.
**Measured, not assumed**: a ragged `Y1,Y2,Y3` paste (8, 6 and 2 finite values)
was never auto-detected as the new layout; declared and imported, its default
histogram drew **33 bars over 11 distinct x positions, all one width** — read
off the rects' own `x`/`width` attributes, scoped to the new plot's own `<g>`
after an earlier pass over the whole page's bars first reported two widths by
counting every other panel's bars too; switching the same plot to ECDF drew a
real curve; and, read back on the *categorical* reading of the same table,
Kolmogorov-Smirnov drew a bracket and Anderson-Darling ran to completion on a
group of n = 2 without a 500, printing `"Groups: Y1 (n=8), Y2 (n=6), Y3
(n=2)"`. No schema version bump: `DataFormat` gains `'distribution'`,
`PlotType` gains `'ecdf'`, `StatTest` gains the four test names, and every new
`PlotNode`/`Comparison`/`Omnibus` field is optional — all additive. See
"Round 50" below.

**Verified after round 49 (every log-rank result reported itself stale):** 1203
TypeScript tests (1200 + 3), 204 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and `eslint .` clean, 46-check acceptance
run unaffected, and **10 live-browser checks in each of light and dark**. **No
schema change and no new field** — one missing argument at two call sites, plus
a third routed through the same function so the three cannot drift again.
**Reproduced before it was changed**, rather than inferred from reading: on R's
`aml` dataset the run path stored `753bee3d66414535` while both recompute sites
produced `e0809e0aa32e7c98`, because `analysisInputHash` branches on
`events !== undefined` and so selects a different grouping entirely. Measured on
the running app, a freshly run log-rank showed an error-severity
`no longer matches its data` finding, a staleness warning on its own result
card, readiness **84 against 96**, and the export confirmation dialog. **The
live harness was itself checked against the unfixed code** — reverted, all three
of those checks fail in both themes — because the whole claim of this round is a
negative, and a harness that passes either way would prove nothing. See
"Round 49" below.

**Verified after round 48 (the correlation line, with an optional confidence
band):** 1200 TypeScript tests (1171 + 29: 10 in a new
`packages/plots/src/regression.test.ts`, 12 in a `fitted line` pair of suites in
`continuous-axis.test.ts`, 2 parity fixtures — one vector, one above
`MAX_VECTOR_POINTS` — 1 archive round-trip in `doc-model.test.ts` and 2 in
`quality.test.ts`), **204 Python tests (190 + 14** — this is the first round
since round 19 to touch `services/api`), `tsc --build --force`, `eslint .` and
`ruff check` clean, 46-check acceptance run unaffected, **54 live-browser checks
in each of light and dark** plus a 22-check large-cloud and export run. **No
schema version bump**: three optional `PlotNode` fields and one optional
`StatResult.fit`. **Measured, not assumed** — the whole claim of this round is
that the drawn line *is* the stored fit, so the harness converts the drawn path
back to data coordinates through the plot's **own rendered tick labels** and
never asks the app what its scale is: on Anscombe's first dataset the line
measures **slope 0.5001 and intercept 3.0001**, which is R's published
`lm(y1 ~ x1)` to four figures, spanning exactly **4.00 … 14.00** — the data's own
x range — where "the whole axis" gives 3.20 … 14.80. The prediction band is
**9.58 → 33.18 mm** thicker than the confidence band, and 2,500 proteins bake to
one raster with the line still a **64-vertex vector path** over it, both
surviving into a 315 KB SVG and a 255 KB PDF. **One real gap found by running it
rather than reading it**: an x/y table imports as a **line** plot by default, a
type this round deliberately does not draw a fit on, so the test succeeded and
nothing appeared — now stated in the run notice. **And two harness traps of my
own**, both caught by measuring: the band's *bounding box* height is dominated
by the line's own rise, so confidence and prediction both measured 305 px until
thickness was read off the polygon instead; and the plot-group lookup walked
*down* to the axis title and returned the enclosing panel, whose id the Stats
dropdown does not carry. See "Round 48" below.

**Verified after round 47 (a fold-change vs fold-change plot for proteomics):**
1171 TypeScript tests (1141 + 30 new: 10 in a new
`packages/plots/src/fold-fold.test.ts`, 5 in `doc-model.test.ts` plus a
five-field archive round-trip, 10 in a `fold change vs fold change` suite in
`continuous-axis.test.ts`, 2 parity fixtures — one vector, one above
`MAX_VECTOR_POINTS` — and 2 in `sample.test.ts`), 190 Python tests unchanged
(nothing here touches `services/api`), `tsc --build --force` and `eslint .`
clean, 46-check acceptance run unaffected, **32 live-browser checks in each of
light and dark**, a 3-check full-size gene-list pass and an 8-check export run.
**No schema version bump**: five optional `PlotNode` fields, two widened enums.
**Measured, not assumed** — the significance count is computed independently in
the harness and compared against the drawn marks: on a 400-protein table
**17 points draw red against 17 computed**, with 383 grey and nothing else;
switching the rule to "either axis" takes it to **42**; quadrant mode draws
**5 distinct fills** where the default drew 2, and recolouring one quadrant
reaches the marks. A cutoff wider than the data draws **no** line beside the
panel. 2,500 proteins bake to **one** raster node with the reference lines
still vector, and an export carries both colours, the gene names and both axis
titles into the file. **One real gap found by running it rather than reading
it**: the Data tab's "Label these rows" action was still volcano-only, so a
fold-fold plot drew labels the Data tab would not offer. **And two harness
traps of my own**, both caught by measuring: the first run counted colours
across *every* panel on the page and reported a bar-dot panel's, and a mouse
click cannot reliably hit a 0.45 mm marker. See "Round 47" below.

**Verified after round 46 (a volcano's point-label limit is the author's to
raise):** 1141 TypeScript tests (1129 + 12 new: 3 in `point-labels.test.ts` for
placing past the default and truncating at whatever `maxLabels` says, 8 in
`continuous-axis.test.ts` — 3 end-to-end drawn-count cases plus a 5-case
`pointLabelLimit()` suite covering the default, an honoured value, the clamp,
the floor and a non-finite value — and 1 archive round-trip in
`doc-model.test.ts`), 190 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and `eslint .` clean, 46-check acceptance
run unaffected, and **19 live-browser checks in each of light and dark** plus an
export check. **No `SCHEMA_VERSION` bump**: `PlotNode.pointLabelLimit` is
optional and absent reads as 25, so every saved figure is untouched.
**Measured, not assumed** — the ceiling is the whole risk in this round and
`scripts/point-label-cost.ts` is where its number comes from, on a 10,000-row
gene list: the placement engine costs 12.9 ms at 100 labels, 25.0 at 200, 67.9
at 400 and 118.6 at 600, against a ~100 ms budget that is spent *twice* per
interaction frame; and `drawn` saturates at 60 by 300 labels and does not move
again through 1200, so a higher ceiling would buy cost and no labels.
`MAX_POINT_LABEL_CEILING = 200`. Driven live against the sample's own volcano
panel: at the default, 40 selected rows cap at 25 and draw 17; raising the limit
to 60 re-enables the Data tab's button and draws 19; and on a panel enlarged to
175 x 125 mm, 60 selected names draw **53** — counted off the DOM, not assumed —
with the Inspector's new "N of LIMIT selected · M drawn" hint agreeing with that
DOM count at every step and one Ctrl+Z stepping it back. An export carries all
60 names into the SVG and returns a single-page PDF, so the file matches the
screen. **Two traps of my own, both caught by measuring rather than reading**:
the first cost script drew its cloud uniformly, which places *nothing* and so
timed `fits()` short-circuiting instead of placement; and `updateNode` takes a
patch object, not a callback, so a mistyped call silently set no labels at all
and vite-node ran it without a typecheck. See "Round 46" below.

**Verified after round 45 ("Send to back" reaches the back of the page):** 1129
TypeScript tests (1122 + 7 new: 4 in `doc-model.test.ts` — the reported
rectangle, the one-press-at-a-time crossing, the hidden/locked stop and a
regression guard that a parent's children still order on `z` alone — plus a new
`draw-order.test.ts` in `packages/render` asserting the property from the
rendered scene rather than from `z`; one existing test rewritten because it was
written against the sibling list that ignored layers, which was the bug), 190
Python tests unchanged (nothing here touches `services/api`), `tsc --build
--force` and `eslint .` clean, 46-check acceptance run unaffected, and **14
live-browser checks in each of light and dark** plus a PDF/SVG export.
**No schema change**; `SCHEMA_VERSION` stays 1, and no field was added — this
is the first code in the app that rewrites a node's `layerId`. **Measured, not
assumed**: before the fix a rectangle sent to back sat at `z = 0` of 18
top-level nodes and was still the 18th thing painted, because layer z leads the
sort; after it the bar chart paints over the rectangle at a point where the two
genuinely overlap, the rectangle is the first node drawn, one Ctrl+Z restores
it, and the exported SVG writes it before the plot's marks. **Six of the seven
new guards were confirmed to fail against the unfixed code** rather than assumed
to be regression guards. **A live-test trap of my own, caught before it shipped
a false pass**: probing `elementsFromPoint` at the rectangle's own centre finds
no panel ink there — a bar chart paints nothing between its bars — so the check
would have passed whichever way the fix went. See "Round 45" below.

**Verified after round 44 (the Stats tab shows one panel's result):** 1122
TypeScript tests (1114 + 8 new in the `statistical annotation lifecycle` suite
in `doc-model.test.ts`), 190 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and `eslint .` clean, 46-check acceptance
run unaffected, and **12 + 19 live-browser checks in each of light and dark**
reproducing both reported sequences exactly. **No schema change**;
`SCHEMA_VERSION` stays 1. **Measured, not assumed**: running a t-test on panel
*a* and then another on panel *g* leaves **one** result card on screen, tagged
`g`, where before both stacked up; switching back to *a* brings its own card
back unchanged; deleting a panel takes its analysis with it, leaving no
stale-analysis error behind and readiness at 96, and one Ctrl+Z restores panel,
brackets, letter and analysis together. **Two real defects found while
implementing, both by measuring rather than reading**: `checkReferentialIntegrity`
runs on **load**, not on save — so a stranded bracket writes a `.ffg` without
complaint that then throws `ArchiveError: Project file has broken internal
references.`, proven by removing the guard and watching the round trip fail —
and `duplicateNode` shares a copied bracket's `analysisId` with the original
while remapping its `plotId`, which makes that stranding reachable by
duplicating a panel and deleting the original. **A second leak was reported
after the list fix shipped and is included here**: the *run notice* is component
state, so no document-level filter reached it — measured, the cards were already
empty (`cards: []`) while the notice still read `2 brackets added to Panel a`.
It is now keyed on `activePlot` and cleared, not hidden. See "Round 44" below.

**Verified after round 43 (panel-first navigation):** 1114 TypeScript tests
(1102 + 12 new in a new `ownership.test.ts`), 190 Python tests unchanged
(nothing here touches `services/api`), `tsc --build --force` and `eslint .`
clean, 46-check acceptance run unaffected, and **30 live-browser checks in each
of light and dark** plus a 6-check second pass. **No model, schema or renderer
change at all** — every panel letter this round displays is `PanelNode.label`,
which `relabelPanels` has refreshed on every layout change since phase 1.
**Measured, not assumed**: the sample's panel *b* had its material filed across
**four** separate layer sections (Graphs, Images, Annotations, Labels) and
appeared as one thing nowhere; the other six spanned two each. After the fix
Layers reads seven banners `a`–`g` in reading order with panel *b*'s three
tiles, its scale bar and its letter all under one heading; the Inspector
navigator jumps between panels *and* into a plot with the canvas outline and
the Layers highlight both following; the Stats dropdown reads
`Panel a — Expression`; and the Data tab reads `used by panel a` and
`on panel b` against the bare counts before. Each of the seven mechanisms was
reverted alone and only its own guard failed. **One pre-existing bug closed**:
the SidePanel held the bare selection setter while only the Canvas got the
wrapper that closes crop/measure/label-pick, so clicking a Layers row mid-crop
left the overlay up over a node no longer selected — confirmed fixed by
cropping a montage tile and jumping away. See "Round 43" below.

**Verified after round 42 (group-aware layout):** 1102 TypeScript tests (1096 +
6 new in a `group-aware layout` suite in `doc-model.test.ts`), 190 Python tests
unchanged (nothing here touches `services/api`), `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected, and live checks in each of
light and dark. **Measured, not assumed** — reproduced against the real code
with three panels, two of them grouped at the bottom of the page: reading order
came back **`A C B`** where the page reads `C A B`; the applied layout put panel
A's frame at `(6, 2)` against a true page position of `(11, 62)`, and B's right
edge at **186 mm on a 183 mm page**; a grouped panel's letter landed in the
group's local space; and the group's own box stayed at its old
`(5, 60, 115, 40)`. **Plain Auto Layout was broken identically** — same panel,
same 186 mm. After the fix the same figure reads `C A B`, B's right edge is
**181.0 mm** (the page less its margin), A's letter is at `(94, 2)` and the
group's box is `(98, 2, 83, 116)`. Driven live: grouping two sample panels and
running smart layout keeps every mark inside `6.00 … 181.00 mm`, letters
`a`–`g`, no console errors in either theme, and a single-page export at exactly
183.0000 mm wide; grouping an *arrow* with a panel and laying out moves the
arrow with it. Each of the three mechanisms was reverted alone and only its own
guards fail. **One honest consequence, measured**: keeping a group together
scales its internal gap with it (10 → 3.6 mm against a 9 mm page gutter), so
`uneven-gutters` fires and readiness reads 95 against 96. See "Round 42" below.

**Verified after round 41 (a montage panel's shape is affine, not a ratio):**
1096 TypeScript tests (1089 + 7 new: 3 in a new `affine shapes` suite and 1 in
`band refinement` in `arrangement.test.ts`, 3 in `doc-model.test.ts` for the
caption band, the letterboxing and the scale-bar strip; plus two existing tests
rewritten because they were pinning the defect), 190 Python tests unchanged
(nothing here touches `services/api`), `tsc --build --force` and `eslint .`
clean, 46-check acceptance run unaffected, and live checks in each of light and
dark. **Measured, not assumed**: `montagePanelAspect`'s claim that "any positive
cell height gives the same ratio" is false — on a 1 × 3 montage of 4:3 tiles
under one group title the true ratio runs **2.5761 → 3.7207** as the cell grows,
and it probed at the 5 mm end. Running the real tiler at frames of that ratio
left **101.5 / 532.6 / 1219.2 mm² dead per tile** at 60 / 120 / 175 mm of width —
21 mm of blank page under every picture, which is the reported whitespace. After
the fix the same three frames give **0.0 mm² at all three**, and driving the
reported scenario live (group title over the sample montage's tiles, its scale
bar switched to "Below the image", then smart layout) gives cells of
**45.00 × 33.75 mm holding 45.00 × 33.75 mm pictures — 0.00 mm dead** in both
themes, lettering still `a`–`g`, readiness 96, and a single-page export at
exactly 183.0000 × 144.1169 mm. Each of the two mechanisms was reverted alone
and only its own guards fail; the arrangement-level guard was additionally
re-run against the literal ratio the solver used before (2.576112) and fails by
exactly the predicted 21.40625 mm. See "Round 41" below.

**Verified after round 40 (a band refinement pass for smart layout):** 1089
TypeScript tests (1078 + 11 new: 7 in a new `band refinement` suite in
`arrangement.test.ts` covering the width reallocation's worked arithmetic, the
width-conditioned height want, the page-agreement property over the whole
enumeration, the no-donor and aligned cases and the resolution ceiling; 4 in
`smart-layout.test.ts` for the discriminating score test, the delivered figure,
the strip hazard and id uniqueness), 190 Python tests unchanged (nothing here
touches `services/api`), `tsc --build --force` and `eslint .` clean, 46-check
acceptance run unaffected, and live checks in each of light and dark.
**Measured, not assumed** — the synthetic reproduction through the real solver
went from a plot stretching to **46 / 56 / 76 mm** on 50 / 60 / 80 mm pages
(against a montage stuck at 28.6) to a flat **page 46 mm and plot 42 mm at every
one**, with the montage widened 125.9 → 136.0 mm; on a short plot beside the
same montage the misalignment is **11.9 → 0.0 mm** and the offered page
**44.5 → 34.0 mm**. On the real sample the montage grew **126.6 → 137.0 mm**
wide and **28.8 → 31.1 mm** tall, its bar-chart neighbour's overhang fell
**11.6 → 10.1 mm**, lettering still reads `a`–`g`, readiness stays 96 and the
export is a single page at exactly 183.0000 × 144.1169 mm with 3 image XObjects
and no console errors. Each of the three levers was reverted alone and only its
own tests fail. **Two things the plan got wrong, both caught by tests rather
than by reading**: a second clamp at column level made rows *raggeder*, not
tighter, and a test asserting the new score term picks the arrangement was
vacuous — it passes with the weight at zero. Both are written up below. See
"Round 40" below.

**Verified after round 39 (the scale bar's label colour):** 1078 TypeScript
tests (1075 + 3 new: 2 in `parity.test.tsx` for an explicit label colour
reaching the drawn caption independently of the bar, and for an absent one
still falling to the theme; 1 in `doc-model.test.ts` for the archive
round-trip), 190 Python tests unchanged (nothing here touches `services/api`),
`tsc --build --force` and `eslint .` clean, 46-check acceptance run unaffected,
and **18 live-browser checks in each of light and dark**. **No model or
renderer change at all** — `TextStyle.color` has been rendered and schema'd
since phase 1, and a `TextNode` has had a swatch writing it since then; the
scale bar's caption was the node that never got one, despite its *bar* having
had a colour control all along. **Measured, not assumed**: the caption redrew at `rgb(255,0,0)` off its own
`scale-bar-label` element while the bar's fill stayed put, the bar then went
white with the label still red, and switching to "Below the image" turned both
black with one Ctrl+Z restoring placement and both colours together. Both new
guards were confirmed to fail when their own mechanism was reverted — the
render one with `...node.style` dropped from the label's attrs, the round-trip
one with `color` deleted from `textStyleSchema`. **Two live-test traps, both
mine**: a synthetic `input` event does not drive a React controlled input
(`fill()` does), and Ctrl+Z with focus still in the colour input correctly
reaches nothing — blur rather than clicking the canvas, which would clear the
selection and take the Inspector away. See "Round 39" below.

**Verified after round 38 (a scale bar below the picture, in black):** 1075
TypeScript tests (1067 + 8 new: 5 in `doc-model.test.ts` for the below-frame,
the unchanged inside frame, the push, the bottom-row shrink and reserving
nothing for an inside bar; 2 in `parity.test.tsx` for the clip; and one existing
test rewritten because it was pinning a bug), 190 Python tests unchanged
(nothing here touches `services/api`), `tsc --build --force` and `eslint .`
clean, 46-check acceptance run unaffected, and **13 live-browser checks in each
of light and dark** plus a PDF export. **Measured, not assumed**: switching the
sample's montage bar to "Below the image" put it at y = 14.89 against a picture
bottom of 13.89, right edge 83.651 against the picture's own 83.649, converted
from `#ffffff` to `#000000`, with no other panel disturbed, the page height
unchanged at 180 mm and one Ctrl+Z restoring placement and colour together;
readiness stays 96 with no error-severity finding and the export is a single
page at 183.0000 × 180.0000 mm. **A false alarm worth recording**: the
right-alignment check first read 0.46 mm out, because `getBoundingClientRect()`
on an `<image>` returns the *element box*, not the painted picture — a 4:3 tile
letterboxes inside its 1.41-aspect box. The bar was already exact. **And a real
bug found in the function being touched**: `scaleBarWidthMm` divided by
`frame.width`, so on any letterboxed image the bar was drawn longer than the
distance it claims — on the test fixture, exactly twice. See "Round 38" below.

**Verified after round 37 (room for a group title over a graph; Placement
hidden where it means nothing):** 1067 TypeScript tests (1059 + 8 new in
`doc-model.test.ts`: reserving against the page edge, the letter/heading/graph
order, idempotence, the letter returning exactly when the heading goes, a
hand-nudged letter surviving, the shrink path, a montage cell caption lifting
nothing, and `groupLabelMembersAreImages`), 190 Python tests unchanged (nothing
here touches `services/api`), `tsc --build --force` and `eslint .` clean,
46-check acceptance run unaffected, and **15 live-browser checks in each of
light and dark**. **Measured, not assumed**: before the fix, adding a group
title to the sample's top-row panel *a* moved nothing at all and drew the
heading at **y = −1.27 mm** — above the page's own top edge and higher than the
letter `a` at y = 2.26; after it the page reads letter (2.26 → 5.39), heading
(5.66 → 7.93), graph (11.93), with the page height unchanged at 180 mm, the
captioned panel shrunk 50.7 → 47.06 mm, the lowest panel ending at 172.37 of a
178 mm limit, and one Ctrl+Z restoring every frame and every letter together.
The Inspector shows no Placement control over a graph and still shows it over
the micrograph montage; readiness stays 96 with no error-severity finding and
the export is a single page at exactly 183.0000 × 180.0000 mm. Each of the
three fixes was checked by reverting it alone and confirming only its own tests
fail. See "Round 37" below.

**Verified after round 36 (ragged rows and L-shapes for smart layout):** 1059
TypeScript tests (1036 + 23 new: 20 in a new `arrangement.test.ts` covering the
enumeration's rules, per-band width solving, the stacked column, the height
demand, `shareOut` and reading order across the *whole* enumeration; 3 in
`smart-layout.test.ts` for the ragged offering plus the no-hole property over
every candidate, the eight-figure variety, and slot clearing), 190 Python tests
unchanged (nothing here touches `services/api`), `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected, **16 live-browser checks
in each of light and dark**, a 6-check L-shape run and a PDF export.
**Measured, not assumed**: the Layout tab now lists eight distinct shapes
spanning two to five rows — `2 + 2 + 3`, `1 + 2 + 2 + 2`, `3 + 2 + 2`, a plain
`4 + 3` and three L-shapes — where before every offer was a uniform grid and a
seven-panel figure could only be a 2 × 4 with one cell empty; applying the
`4 + 3` put four panels across the top spanning 10.5 → 181.0 mm and three
across the bottom spanning 8.7 → 179.0 mm of a 183 mm page, both bands filling
it edge to edge; applying the `3 + 4` L-shape placed a 45.5 mm and a 37.4 mm
panel stacked in one column beside two 89 mm-tall neighbours with **no
overlapping pair** and the letters still reading `a`–`g`; and the export is a
single page at exactly 183.0000 × 97.5000 mm with 3 image XObjects at readiness
96 and no error-severity finding. **A real bug was found by measuring rather
than reading**: the column bound was computed from the *widest* panel's
minimum, so a row of four was never enumerated even though the four narrowest
panels needed 136 mm of the 179 mm available — see "Round 36" below.

**Verified after round 35 (smart layout — a content-aware panel arrangement
solver — and a seven-panel sample figure):** 1036 TypeScript tests (1001 + 35
new: 24 in `smart-layout.test.ts` covering solved weights, the image/montage
demand arithmetic, the rejection classes, determinism, reading order,
explanations and applying; 9 in `panel-demand.test.ts` pinning a plot's demand
to `computePlotGeometry`'s own margin; 2 in `doc-model.test.ts` for scale-bar
placement), 190 Python tests unchanged (nothing here touches `services/api`),
`tsc --build --force` and `eslint .` clean, 46-check acceptance run unaffected,
**20 live-browser checks in each of light and dark** plus a 17-check sample run
and a PDF export. **Measured, not assumed**: on the new sample figure the
solver offers four distinct arrangements scoring 88 / 84 / 73 / 62, and
applying the best gives panel widths of 286, 286, 286, 312, 720, 749, 749 mm-
equivalents with the micrograph montage the widest panel — against a spread of
43 px before; one Ctrl+Z restores every frame *and* the page height together;
the figure opens at readiness 96 with no error-severity finding; and the export
is a single page at exactly 183.0000 x 191.5000 mm with 3 image XObjects and
fonts embedded. Three real defects were found by probing the solver and reading
the rendered figure rather than by reading code — see "Round 35" below. See
"Round 35" below.

**Verified after round 34 (group-title double-click editing):** 1001
TypeScript tests unchanged (a React event-handling fix with no pure function
to unit-test, matching this codebase's standing convention that canvas
pointer interaction is verified live rather than through a component test),
190 Python tests unchanged (nothing here touches `services/api`), `tsc
--build --force` and `eslint .` clean, 46-check acceptance run unaffected,
and **46 live-browser checks across light and dark**. **Measured, not
assumed**: before the fix, double-clicking a group title opened no editor at
all — confirmed by reading the DOM for `.text-edit-overlay` after the
double-click and finding none; after the fix the identical double-click
opened a `<textarea>` overlay, committed a new title read back off the
scene's own `<text>` content, and survived Ctrl+Z; the same editor opened
correctly positioned over a rotated left-edge heading and over an
overlay-placed caption; a heading bolded via the Inspector kept its bold
`tspan` after a canvas-side edit that only appended a character, proving the
edit reconciled through `richText` rather than overwriting it blind; a
locked heading opened no editor; and panel-label double-click editing, which
already worked, was re-confirmed unaffected. See "Round 34" below.

**Verified after round 33 (montage typography, image-edge rules, overlay
labels, auto-fit):** 1001 TypeScript tests (973 + 28 new: 21 in
`doc-model.test.ts` covering `imageContentRect` across the cropped, aligned,
stretched and vector cases, a heading framed to the picture rather than the
cell in both dimensions, overlay labels reserving zero space and neither
stacking nor being stacked against, the median tile aspect, the closed-form
panel aspect, `suggestMontageGrid`'s no-holes and balance rules, `autoFit`
absent leaving a figure untouched, and a round-trip of `placement`/
`labelColor`/`autoFit`; 7 in `parity.test.tsx` covering a bare 6 pt non-bold
heading, an opted-in rule at the picture's width, and the overlay's
white-with-dark-outline drawing through both adapters), 190 Python tests
unchanged (nothing here touches `services/api`), `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected, **50 live-browser checks
in each of light and dark**, and a 10-check reference rebuild. **Measured, not
assumed**: a pane label read back at exactly a tick label's own computed
`font-size` (2.1167 px) at `font-weight` 400 with no rule; an opted-in rule
over a 1:3 picture in a square cell drew **70.2 px** against a ~68 px picture
in a **163.4 px** cell — at the image's edge, not the cell's — and centred on
it; switching a label to overlay moved its tile by **0 mm** against the 22.9 px
an outside caption pushes it; one "Label size" edit collapsed every label in a
montage to a single computed size; and a rebuilt 1 × 3 VSCyto-style panel put
its spanning heading above three pane labels sharing one baseline, over tiles
aligned along their tops, exporting to a 75,473-byte PDF with no console
errors. See "Round 33" below.

**Verified after round 32 (four reported bugs in round 31's montage/group-label
surface: an unselectable montage, no placeholder for an empty cell, image
alignment and per-pane labels, heading spacing):** 973 TypeScript tests
(942 + 31 new: 20 in `doc-model.test.ts` covering `fitAspectAligned`, the
montage top-alignment defaults and their round-trip, `montageCellRects`
agreeing cell-for-cell with `fillPanelChildren`, the group-label stacking
rule in four configurations, the `gapMm` override, and the declared-grid-at-
any-occupancy fix; 11 in `parity.test.tsx` covering the montage chrome
appearing only under `RenderOptions.chrome` and the `preserveAspectRatio`
token for every alignment, including the separately-implemented cropped
path), 190 Python tests unchanged (nothing here touches `services/api`),
`tsc --build --force` and `eslint .` clean, 46-check acceptance run
unaffected, **46 live-browser checks in each of light and dark**, and a
9-check export run. **Measured, not assumed**: an empty 2×2 montage drew
exactly four dashed cell placeholders and one transparent hit target, and a
click on it selected the montage panel itself where before the click reached
nothing at all; a tile uploaded into a cell rendered
`preserveAspectRatio="xMidYMin meet"` with its drawn top edge landing within
0.7 px of its cell's own top; the three remaining placeholders dropped to
three and then two as cells filled; a cell caption and a heading over the
whole montage were read off the DOM at y = 320.3 and 274.6 px — the caption
under the heading, not on top of it — with the lower rule clearing the
picture below it by 3.27 mm; raising that caption's "Gap to content" from
2.5 mm to 8 mm pushed its tile down 6.31 mm; and the SVG actually posted to
the exporter contained neither `montage-hit-area` nor
`montage-cell-placeholder` while still carrying both headings and the
`xMidYMin meet` alignment, with the PDF returning 72,530 bytes. See
"Round 32" below.

**Verified after round 31 (group titles for image panels, with adaptive
spacing, plus per-cell montage image upload/replace):** 942 TypeScript tests
(918 + 24 new: 20 in `doc-model.test.ts` covering `groupLabelFrame`,
`reflowGroupLabels`, `reserveSpaceForGroupLabels`'s shortfall arithmetic
pinned to exact millimetres, the same-panel grid-gutter widening, the
delete/duplicate cascades, a schema round-trip, `gridCells`'s new
boundary-extras parameter, and `addEmptyMontagePanel`/`setMontageCellImage`
including the scale-bar re-sync and out-of-range cases; 4 in
`parity.test.tsx` covering a cross-panel heading and a single-image caption,
both adapters), 190 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and `eslint .` clean, 46-check
acceptance run unaffected (no existing fixture uses a group-label or an empty
montage), and 17 live-browser checks in each of light and dark. **Measured,
not assumed**: creating a heading over two selected sample panels drew
exactly one `group-label` and one `group-label-rule` scene node reading
"Group title"; editing the title in the Inspector updated the canvas text
live; switching its position to "Left" produced a `rotate(-90)` transform on
the drawn title; deleting one of the two member panels removed the heading
entirely, and one undo restored both together; adding an empty 2×2 montage
via the toolbar, uploading a 1×1 PNG into an empty cell, and captioning that
one tile all worked end to end with the Upload button correctly relabelling
itself "Replace cell 1"; and a PDF export taken with a heading present
returned `HTTP 200`, `content-type: application/pdf` and a 70,253-byte body
per its own `Content-Length` header, with zero console errors throughout
both theme runs. See "Round 31" below.

**Verified after round 30 (the same colour swatch, now on the Inspector's own
colour-conflict warnings):** 918 TypeScript tests unchanged (this round is
presentational JSX only — no `quality.ts`/model change and no new test, since
this codebase verifies canvas/Inspector UI live rather than through a React
component unit test), 190 Python tests unchanged, `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected, and a live-browser
check in light **and** dark covering both warning sites. **Measured, not
assumed**: recolouring a line plot's palette and, separately, the volcano
plot's "Down" swatch each into `#d62728` against an unchanged `#d73027`
produced the identical warning text `withColorSwatches` already draws in the
Quality tab, with two `.color-chip` spans read back off the DOM as
`rgb(214,39,40)` and `rgb(215,48,39)` in both cases, no console errors. See
"Round 30" below.

**Verified after round 29 (a reversible legend order, and cascade front axes
trimmed to the projected rear axes):** 918 TypeScript tests (909 + 9 new:
legend-reversal cases in `continuous-axis.test.ts` — the cascade default, a
`reverseLegend:false` override, a plain-line `reverseLegend:true`, and a
reversed swatch still keyed by its own series' line style — a
`doc-model.test.ts` round-trip, a `parity.test.tsx` reversed-legend cascade
fixture, and a `gridlines.test.ts` suite pinning the front axes trimmed to
the front plane, equal in length to the rear axes, and `boxed` closing the
*rear* plane's rectangle), 190 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and `eslint .` clean, 46-check
acceptance run unaffected, and a live-browser check in light **and** dark.
**Measured, not assumed**: on a real three-series cascade the legend text
was read off the DOM as `Y3, Y2, Y1` (reversed to match the stack) with the
"Reverse legend order" checkbox default-checked; unchecking it re-read
`Y1, Y2, Y3` and re-checking flipped it back; the front y-axis line's own
`d` started at `y = 24 mm` (not `0`) with a segment length of `35 mm`
exactly matching the projected rear axis's `35 mm`; and `Boxed` drew the
rear plane's top and right edges. See "Round 29" below.

**Verified after round 28 (a colour swatch beside every hex code a Quality
finding names):** 909 TypeScript tests (906 + 3 new colour-accessibility
cases), 190 Python tests unchanged (nothing here touches `services/api`),
`tsc --build --force` and `eslint .` clean, 46-check acceptance run
unaffected (no fixture triggers a colour finding), and a live-browser check
in light **and** dark. **Measured, not assumed**: the two swatches drawn
after "`#d62728` and `#d73027` are hard to tell apart under deuteranopia"
were read back off the DOM as `background-color` `rgb(214,39,40)` and
`rgb(215,48,39)` — exactly the two hex codes the finding text quotes — at a
9.3 px square, identical in both themes, with no console errors. The
verification itself needed a host toolchain the machine did not have:
Node was installed via `winget` (user scope, portable), `npm ci` run
natively, and Playwright's headless Chromium driven against a native `vite`
dev server — recorded here because "runs in containers only" is otherwise
the standing rule. See "Round 28" below.

**Verified after round 27 (arrows and lines that default to diagonal, and a
line shape with no way to reach horizontal/vertical):** 906 TypeScript
tests, 190 Python tests unchanged, `tsc --build --force` and `eslint .`
clean, 46-check acceptance run unaffected, and 22 live-browser checks
across light and dark. **Measured, not assumed**: the reported "difficult
to draw vertical or horizontal" was traced to two separate defaults before
anything was changed — a freshly inserted arrow's fallback points and a
freshly inserted line shape's frame were both diagonal by construction, not
by drag — and after the fix, a Shift-drag on a line shape's corner handle
was driven through several headings and read directly off the rendered
resize-handle coordinates: a near-horizontal drag landed with its `n`/`s`
handles at the same y, a near-vertical drag landed with `w`/`e` at the same
x, and a deliberately even push landed on a square, with an ordinary
rectangle's own Shift-resize confirmed unchanged (still a literal square)
in the same run. See "Round 27" below.

**Verified after round 26 (an align/distribute function for canvas objects,
including panel labels):** 904 TypeScript tests, 190 Python tests unchanged,
`tsc --build --force` and `eslint .` clean, 46-check acceptance run
unaffected, and live-browser checks in both light and dark. **Measured, not
assumed**: a bug in the first draft — the panel-label sync snapshot was
taken *after* frames were already mutated, so every computed delta was
zero — was caught live (the label visibly did not follow its panel) even
though the unit test for the same behaviour had passed, because that test
happened to use an align mode that was a geometric no-op on the sample
document; both the implementation and the test were fixed together, and the
live check re-run afterward read the label's own rendered `<text>`
transform shifting by the exact same delta as its panel's. See "Round 26"
below.

**Verified after round 25 (a second axis-title line overlapping the tick
labels):** 898 TypeScript tests, 190 Python tests unchanged, `tsc --build
--force` and `eslint .` clean, 46-check acceptance run unaffected, and a
live-browser check in both light and dark. **Measured, not assumed**: the
root cause was confirmed against the theme's own real numbers before
anything was changed — one line step (`2.96 mm` at the Nature theme's
`axisTitlePt = 7`) genuinely exceeds the single-line clearance gap
(`axisTitleGapMm = 2.2 mm`), so the second line was never merely close, it
overlapped by about `0.76 mm`; and after the fix, a live two-line y-title's
own rendered bounding box was read directly off the DOM and found to sit a
clear 11 px short of where the tick labels' own leftmost box begins, with
no console errors. See "Round 25" below.

**Verified after round 24 (rich text formatting on axis titles):** 894
TypeScript tests, 190 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and `eslint .` clean, 46-check
acceptance run unaffected, and live-browser checks across light and dark
covering the x/y title toolbars, the cascade depth-axis title, and Round
23's own `TextNode` toolbar re-run to confirm the shared-hook extraction
left it unchanged (42 checks). **Measured, not assumed**: bolding part of a
y title and superscripting part of an x title were each confirmed to draw
the exact `font-weight`/`text-sup`-role tspan the toolbar's pressed state
claimed, not merely a UI state with no corresponding scene change; and
italicizing the cascade depth-axis caption was confirmed to reach the
renderer past a component-structure change (moving `useRichTextToggle`'s
hook call ahead of `CascadeControls`' own `isCascadable` early return, to
keep its hook count constant across renders) — read directly off the drawn
`<tspan>`'s `font-style`, not assumed safe from the refactor alone. See
"Round 24" below.

**Verified after round 23 (rich text runs, multi-line axis titles, a Greek/
math symbol picker):** 890 TypeScript tests, 190 Python tests unchanged
(nothing here touches `services/api`), `tsc --build --force` and `eslint .`
clean, 46-check acceptance run unaffected, and 45 live-browser checks across
light and dark. **Measured, not assumed**: bolding a range of text, then
toggling it off over the same still-selected range, was confirmed to
re-merge back into a single plain `<tspan>` rather than leaving a
zero-effect split; a superscript run was confirmed drawn at a genuinely
smaller `font-size` than its own node's base size; a rotated two-line y-axis
title was confirmed — by screenshot, not by reading the transform matrix on
paper — to read top-to-bottom in the correct order; and exporting to PDF
with bold text and a two-line axis title present produced a real,
non-trivial download with no console errors. See "Round 23" below.

**Verified after round 22 (panel numbering and layout gaps after delete):**
850 TypeScript tests, 190 Python tests unchanged, `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected, and 22 live-browser
checks across light and dark. **Measured, not assumed**: deleting a panel via
the Delete key was confirmed live to leave the remaining panels' old letters
and an unclosed grid gap in place until some later action happened to run a
layout pass; after the fix the same delete relabels and repacks the grid
**immediately**, confirmed for all three of the Delete key, the Layers tab's
`×` button and Inspector's "Delete this panel" button, with a matching
negative check that deleting a non-panel node moves nothing. See "Round 22"
below.

**Verified after round 21 (a group's resize handles scaled nothing):** 844
TypeScript tests, 190 Python tests unchanged, `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected. **Measured, not
assumed**: a plain, ungrouped panel drag was confirmed live to leave its
letter label behind — moved 40.5 × 32.4 px while the label stayed at the
same pixel — before the fix, then confirmed carrying the label afterward;
grouping two panels and resizing the group grew and repositioned both, with
both labels following, not just the one nearer the dragged corner. See
"Round 21" below.

**Verified after round 20 (a montage tile that wouldn't move or resize):** 836
TypeScript tests, 190 Python tests unchanged, `tsc --build --force`, `eslint .`
clean, 46-check acceptance run unaffected. **Measured, not assumed**: driven
live in a real browser before any fix was written, a plain click on any of
four freshly-imported montage tiles selected and dragged the *whole panel*,
symmetrically across all four positions — not a top-left-specific fault, as
first reported, but the click-selects-the-container rule applying exactly as
documented to every tile alike. See "Round 20" below.

**Verified after round 19 (the volcano methods sentence; the asymmetry
investigated and confirmed correct):** 833 TypeScript tests, 190 Python tests,
`tsc --build --force`, `eslint .` and `ruff check` clean, 46-check acceptance
run unaffected, and 15 browser checks in each of light and dark. **Measured**:
every point of a drawn boundary inverts to one constant `cut` (spread
2.1e-11), equal to the classification's own cutoff to 2.2e-16; and mirrored
data yields `cutUp == -cutLow` exactly at both `s0 = 0.1` and `0.5`, which is
what shows the asymmetry belongs to the data and not the code. See "Round 19"
below.

**Verified after round 18 (colouring by the drawn boundary):** 832 TypeScript
tests, 184 Python tests unchanged, `tsc --build --force`, `eslint .` and
`ruff check` clean, 46-check acceptance run unaffected, and 7 browser checks in
each of light and dark against the reported data. **Measured**: the rule that
shipped disagreed with the volcano test's own verdict on **47 of 100**
proteins; classifying against the drawn curve agrees on 100 of 100, and on
400 of 400 of a set where 380 are not significant. See "Round 18" below.

**Verified after round 17 (the FDR boundary's sampling, proteomics import,
menu order):** 821 TypeScript tests unchanged, 184 Python tests, `tsc --build
--force`, `eslint .` and `ruff check` clean, 46-check acceptance run
unaffected, and 11 browser checks in each of light and dark **against the
reported data itself**. **Measured**: on `Data samples.xlsx` columns T–Z the
boundary covered 0.6% of the panel's width and 4% of its height before, and
100% / 95% after. See "Round 17" below.

**Verified after round 16 (FDR curve clipping, re-run in place, the declared
proteomics layout, hidden inapplicable options):** 821 TypeScript tests, 182
Python tests unchanged, `tsc --build --force` and lint clean, 46-check
acceptance run unaffected, and 27 browser checks in each of light and dark.
**Measured**: on the sample data the unclipped FDR boundary ran to `x = -8.77`
against an x domain starting at `-2.59`, 8 of its 20 points outside the panel.
See "Round 16" below — and the note above it about rounds 11–15, which built
the volcano test this extends and are **not** written up in this file.

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
preview grid (only listed as muted text beside the count). *First column: Row
names* was also still offered on a grouped table where it does nothing —
`inferFormat` short-circuits on declared blocks and `toSeries` hardcodes column 0
as the row label — **fixed in round 16**, which shows the toggle only for the
xy layouts its own doc comment names.

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

### Rounds 11–15 — the Perseus-style volcano test (not written up here)

**A gap, stated rather than papered over.** Five rounds of reported work built
the proteomics volcano surface this file's Round 16 section below extends:
`services/api/figureforge/sam_volcano.py` (SAM/S0 permutation significance,
two-sample and one-sample), `POST /volcano-test`, `PlotNode.volcanoSamCurve`/
`volcanoThresholds.significanceBy`/`volcanoPValueIsNegLog10`, the Data tab's
"Run volcano test (Perseus-style) →" action, and the real Prism-derived sample
data in `apps/web/src/sample.ts`. They also fixed a live serialization bug in
`main.py` — `_sanitize(x) or fallback` treats a legitimate `0.0` as falsy, so a
maximally significant p or q came back as `1.0` across `/analyze`, `/pca`,
`/umap` and `/volcano-test`; `_sanitize_or` is the fix and
`services/api/tests/test_main_routes.py` is the first test in this repo to
exercise a route over real HTTP rather than calling `compute_*` directly.

Those rounds were not recorded here at the time. Rather than reconstruct their
reasoning from memory — this file's standard is that every claim in it was
checked against real output — read the code and its comments, which are
complete. Round 16 below is written to the usual standard.

### Round 16 — FDR curve clipping, re-run in place, a declared proteomics layout, hidden inapplicable options

Four items from real use of the volcano test above. Two of the four were the
"a control that visibly does nothing is a defect" class this file already
names; one was a genuine geometry bug; one needed a new declared format.
**No `SCHEMA_VERSION` bump** — one optional field and one widened enum.

- **The FDR boundary drew outside the panel.** `renderVolcanoSamCurve` scaled
  its points and filtered only on `Number.isFinite`, and a scale
  *extrapolates* outside its domain rather than returning NaN. The curve is
  genuinely unbounded: the server emits one point per protein at
  `(cut·(s+s0), -log10(p_boundary))`, so as a protein's own `s` shrinks the
  boundary p tends to zero and `-log10(p)` grows without limit — while the
  axes are resolved from the *plotted points* only. **Measured on the sample
  data**: the down branch ran to `x = -8.77` against an x domain starting at
  `-2.59`, with **8 of its 20 points outside the axes**, drawn over the
  neighbouring panel.
  `packages/render/src/clip.ts` is the fix — `clipPolylineToRect`,
  Liang–Barsky per segment, its own small DOM-free module on
  `point-labels.ts`'s precedent. Three things it does deliberately:
  - **Interpolates the crossing rather than dropping the vertex.** Dropping
    would end the curve at whichever protein happened to be last inside,
    visibly short of the axis it is claiming a boundary against. The reported
    ask — "this may require interpolation between data points" — is exactly
    right.
  - **Returns several runs, not one.** A curve that leaves and re-enters must
    not be joined: the join is a straight chord across the panel that the
    computation never produced. The runs become sub-paths of a **single**
    `<path>` per branch, so a `volcano-sam-curve` role count cannot start
    depending on the data.
  - `renderVolcanoThresholds` got the same bounds check in the same pass — a
    fold-change cutoff wider than the data drew two straight lines beside the
    panel, the same extrapolation, the same "never mark a value the axis does
    not show" rule a broken axis already follows.

- **Re-running the test replaces its output instead of appending a second
  copy.** `runSamVolcanoOn` always minted a new dataset id and always built a
  new panel, so a second run left two panels answering one question, differing
  only in parameters a reader cannot see. `Dataset.derivedFrom?: {datasetId,
  kind: 'volcano-test'}` is the link — **stored, not re-derived from the
  generated name**, which is editable in the dataset list; the same discipline
  `analysisInputHash` and `scaleBarWidthMm` are each held to, and the same
  "replace, don't accumulate" stance `replaceAnalysisForPlot` already takes.
  - The derived dataset **keeps its id**, which is what makes this a
    replacement rather than a swap: every plot already pointing at it keeps
    pointing at it, so the panel does not move and the author's
    `volcanoLabels`/`pointLabelOffsets` survive — they are keyed on label
    text, and the same proteins come back.
  - **No `applyAutoLayout`, no `relabelPanels` on the replace path.** Nothing
    was added, and re-laying out would shuffle the page as a side effect of
    re-running a test.
  - A previous run whose panel the author *deleted* still overwrites the
    dataset and rebuilds one panel, so a re-run recovers rather than appearing
    to do nothing. The confirmation says which of the two happened, or the
    absence of a new panel reads as a run that failed silently.
  - **Deliberately not extended to PCA/UMAP**, which still append: neither was
    reported, and changing them here is behaviour nobody asked about.

- **A declared `'proteomics'` layout, because nothing in the numbers can say
  it.** The button had been gated structurally (`'matrix' || 'replicate'`),
  which put it — enabled — beside `Cell viability`, a 4×4 dose-response table.
  There is no cell-level signal separating a proteomics intensity matrix from
  any other table of replicate measurements, so this is exactly the situation
  `'contingency'` is already in relative to `'replicate'`: identical shape,
  separate member, because the numbers mean something different and a
  different set of tests applies. Its rows are *features*; comparing one
  protein against another is not a question anyone is asking, and its own
  comparison runs down the columns.
  Never auto-inferred (no `inferFormat` branch, and a test pins that);
  `toSeries` shares `'replicate'`'s case arm, since the generic reading really
  is identical; `defaultPlotTypeFor` needed **no change at all**, because
  `'replicate'` already falls to the `default` arm it should share. The Stats
  tab refuses it outright, the same stance as `matrix`/`nested`/`differential`.
  The sample document's intensity table declares it, so the button is still in
  front of a new user on first launch — Round 14's actual goal — while no
  longer appearing on the two unrelated tables beside it.

- **Inapplicable options are hidden, not shown-and-disabled.** The user chose
  hiding over an explanation in its place, and `typesFor` had already
  established hiding as this Inspector's pattern for plot types.
  - `showPointsRelevant` excludes `volcano`, `scatter` and `histogram` on top
    of `heatmap`/`survival`. **Verified against the renderer, not assumed**:
    `computePlotGeometry`'s volcano branch hardcodes `showPoints: true`, its
    scatter/line branch forces it true for a scatter, and its histogram branch
    never reads the field at all — three plot types where the checkbox did
    nothing whatever.
  - The **Second y axis** section is hidden with its heading, not left as a
    header over an explanation of why there is no control.
  - Four "why this is unavailable" hints are gone, and `typesFor` no longer
    returns a `reason` at all. The hints that *describe an applicable control*
    stay — survival's censor/CI note, the line error-display note, the
    gap-fraction note.
  - The **Stats tab** narrows the Test dropdown to what can actually run: only
    the correlation family on a numeric-x plot, and only when the series
    carries the paired x it consumes; nothing at all for
    `nested`/`differential`/`matrix`/`proteomics` or a horizontal categorical
    plot, where the Test/Correction/Run controls are hidden entirely.
    `correlationPossible` is split out of `xyCorrelation` because the dropdown
    has to decide what to offer *before* a test is chosen, and deciding that
    from a predicate depending on the choice is circular.
    The `counts` and `survival` echoes that corrected `test` are replaced by
    **one** guard asking whether the selection is still in the offered list —
    narrowing it further would have wanted a third echo, and three mechanisms
    maintaining one invariant is how they come to disagree.
  - **One deliberate exception to "say nothing":** where no test applies, the
    single line saying why is kept. That is the tab's own state rather than a
    missing option, and an entirely blank Analysis tab reads as broken.
  - **"Row names in column 1" is now shown only for the xy layouts**, which is
    exactly what `Dataset.hasRowNames`'s own doc comment has always said it is
    meaningful for. This closes the gap round 5 stage 4 recorded as known.

Driven in a real browser, light **and** dark, **27 checks each**: the volcano
button absent on both unrelated replicate tables and present on the declared
proteomics one; a first run adding exactly one dataset and one panel; a second
run adding **neither**, reporting "Updated the existing … table and panel in
place", with the panel count and lettering unmoved; the SAM curve's every
drawn coordinate inside `[0, 69] × [0, 21]` mm with the down branch ending
exactly on `x = 0` — the interpolated boundary, against the 8 out-of-panel
points measured above; the volcano Inspector showing `Thresholds`/`Colours`/
`Labels` and no "Show replicate points" or Second y axis; the Stats tab
offering no test controls for the differential table while still saying why,
and the full measurement list (Welch, Student, paired, Mann-Whitney, ANOVA)
still offered on the categorical panel. No console errors in either theme.

**Verified:** 821 TypeScript tests (807 + 14 new: a `clip.test.ts` suite
covering interpolation at each edge, the leave-and-re-enter two-run case and
the degenerate ones, two `continuous-axis.test.ts` cases for the clipped curve
and the out-of-domain fold-change line, and `doc-model.test.ts` round-trip /
`toSeries`-equivalence / never-inferred / `defaultPlotTypeFor` cases for the
new format and field), 182 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and lint clean, 46-check acceptance run
unaffected.

**Not done, deliberately:** PCA and UMAP still append a new dataset and panel
on every run — the `derivedFrom` mechanism is general enough to cover them and
is deliberately not wired in, since neither was reported. The volcano test is
still offered only on a two-group or one-sample column split chosen by hand;
nothing reads sample names to suggest one.

### Round 17 — the FDR boundary was sampled too narrowly to see

Reported as "no dashed lines at all" after Run volcano test, on
`reference-and-test-files/Data samples.xlsx` columns T–Z (100 proteins,
3 control vs 3 treatment). Reproduced against that exact data through the live
endpoint before anything was changed, which is what kept the fix off the wrong
file:

| | x span | y span |
|---|---|---|
| the plot's own window | −2.32 … 4.09 | 0 … 6.19 |
| **the boundary as it shipped** | **0.131 … 0.167** | **0.699 … 0.961** |
| after this round | −82.3 … 87.9 | 0.31 … 11.6 |

The boundary covered **0.6% of the panel's width and 4% of its height**,
pressed against the axes as a sub-millimetre dash. On screen that is no
boundary at all.

- **Round 16's clipping was innocent, and checking that first mattered.** All
  100 of the old curve's points were already *inside* the window, so clipping
  removed nothing here — the curve had been this small on this data all along.
  Two further checks ruled out the other suspects: a fresh import and a re-run
  both drew the curve correctly, and the boundary was confirmed *correct*
  (110 points agreeing with the reported categories, 0 disagreeing). The defect
  was never in the maths or the drawing; it was in where the maths was sampled.
- **The cause: `curve_points` evaluated the boundary once per protein, at that
  protein's own standard error.** Those 100 standard errors spanned only
  `s ∈ [0.064, 0.109]`, so the sampled points covered a correspondingly tiny
  slice of a boundary that is defined for every `s > 0`. Whether the curve is
  visible depended on how much the experiment's standard errors happened to
  vary — which is not a property of the boundary at all.
- **The fix sweeps `s` over a wide geometric grid** (`CURVE_SAMPLE_POINTS`,
  `CURVE_S_SPAN` in `sam_volcano.py`), same closed form, same `cut`/`s0`/`df`.
  Geometric rather than linear because the curvature is concentrated near the
  vertical asymptote `x = cut·s0`, which is exactly where the points need to be
  dense; and wide (×/÷1000 past the observed range) because the boundary has to
  reach the edges of an axis window this module never sees. This is the *same
  computation evaluated at more places*, not a hyperbola fitted to it — a
  distinction the module docstring's item 6 now makes explicitly, since its
  previous text argued for the per-protein rule as a deliberate choice.
  Round 16's `clipPolylineToRect` then does exactly the right thing with the
  result: trims the sweep to the panel, interpolating the crossings.
- **Both test designs are fixed at once** — `curve_points` lives inside
  `_resolve_significance`, which the two-sample and one-sample paths already
  share.
- **A table with no within-group variance has no observed scale to bracket**,
  so `geomspace` has no positive bounds. The sweep falls back to `s0`'s own
  scale rather than being abandoned: the asymptote `cut·s0` is still well
  defined there. That is the degenerate table `test_main_routes.py` already
  posts.

Two import-surface items reported alongside it:

- **A proteomics import adds a table and no panel.** A proteomics intensity
  table is the input to a test, not a figure — drawn as its layout would have
  it, a real one is hundreds of bar-dot series over protein rows. The sample
  document already left its own proteomics table unattached for this reason, so
  this makes a real import behave the way the sample already said was right.
  The primary button reads **"Import data table"** for that layout rather than
  "Import as new panel", which would be a control describing something it does
  not do; and the import reports what it did and points at "Run volcano test
  (Perseus-style) →", because an import that visibly changes nothing on the
  page otherwise reads as one that failed. Scoped to `'proteomics'` — a
  `'matrix'` still opens as a heatmap, which genuinely is a figure.
- **The layout menu lists Proteomics directly under "Feature, log2 fold change,
  p-value."** The two are neighbours in meaning: one is the table a volcano
  test runs *on*, the other the table it produces. A pure reorder of
  `DATA_FORMATS` — the `<select>` renders in array order and the only other
  reader is a `.find` by id.

Driven in a real browser against the reported data, light **and** dark,
**11 checks each**: Proteomics listed immediately after the differential
layout; the button reading "Import data table"; the import leaving the panel
count at 3 and saying so; the run adding one panel with both boundary branches
drawn; and the boundary now spanning **100% of the panel's width and 95% of its
height** (69.0 × 21.0 mm plot) with every coordinate still inside it — against
the 0.6% / 4% measured before. Re-running still replaced in place. No console
errors.

**Verified:** 821 TypeScript tests unchanged (nothing here touches
`packages/` — the wire shape is still `[x, y]` pairs, just more of them and
better placed), 184 Python tests (182 + 2 new: the boundary must span past the
plotted data on both axes, and the zero-variance fallback must stay finite),
`tsc --build --force`, `eslint .` and `ruff check` clean, 46-check acceptance
run unaffected. The new span test was **confirmed to fail against the old
sampling** on its own fixture (curve x max 0.155 against data reaching 5.391)
rather than assumed to be a regression guard.

**Not done, deliberately:** the straight fold-change and p-value lines stay
suppressed while a SAM curve is present. That has a stated reason — the curve
encodes both cutoffs jointly and its own fold-change asymptote need not match
`thresholds.foldChange` — and with the boundary now visible the case for
bringing them back goes away.

### Round 18 — colour the volcano by the boundary that is actually drawn

Two reports, one defect seen from two sides: the points were not coloured by
the curve, and the Inspector's cutoff fields "did not do anything".

- **The drawn line and the colours came from different rules.** The boundary
  was the SAM permutation curve; the colours were
  `volcanoCategory(x, y, thresholds, qValue)`, which asks `q <= thresholds.fdr`
  **and** `|log2FC| >= thresholds.foldChange`. `runSamVolcanoOn` leaves that
  fold-change cutoff at its default of 1 and the SAM boundary has no such gate,
  so the figure said two different things at once. **Measured against the
  service's own per-protein verdict on the reported data (100 proteins): the
  shipped rule disagreed on 47 of them.**
- **Classifying against the curve is exact, not a proxy — and that is why this
  is the right fix rather than a convenient one.** For a protein with effect
  `fc` and standard error `s`, SAM calls it up when `fc >= cut·(s+s0)`. The
  curve is `X(s) = cut·(s+s0)`, `Y(s) = -log10(2·sf(X(s)/s, df))`, with `X`
  strictly increasing in `s` and `Y` strictly decreasing; writing `s*` for the
  `s` at which `X(s*) = fc`, `fc >= cut·(s+s0)` ⟺ `s <= s*` ⟺ `fc/s >= fc/s*`
  ⟺ `y >= Y(s*)`. Every step an equivalence. **"Above the drawn curve" *is*
  the test's decision.** Verified rather than left as algebra: the new rule
  agrees with the service on **100 of 100** proteins of the reported export and
  **400 of 400** of a mostly-not-significant synthetic set — the discriminating
  case, where 380 are `ns`.
- **`volcanoCurveClassifier` (`packages/plots/src/volcano.ts`) is a factory,
  not a per-point function.** The branches must be sorted before they can be
  interpolated and a real gene list is 10–20k points, so sorting inside the
  callback would be `O(n·m log m)`. Both branches are normalised to ascending
  `|x|` — the down branch's x negated — so one lookup path serves both rather
  than two mirrored ones that can drift. Inside the vertical asymptote it
  returns `'ns'`: no standard error makes the boundary fold change that small,
  so the boundary genuinely does not exist there and is withheld rather than
  extrapolated. Past the far end it clamps to the curve's floor, because
  reading an enormous fold change as *not* significant would be the wrong way
  to fail.
- **`volcanoCategory` is untouched**, and still serves every volcano built from
  an ordinary `differential` import with its own q-value column. The one
  `classify` call site in `render-document.ts` picks between them, so the
  vector path and the rasterised point-cloud path cannot diverge.
- **Two compounding reasons a bare `>=` fails at the boundary, both measured.**
  SAM's rule is inclusive and `cut` is *set to* the `d` of the least extreme
  protein it calls, so that protein sits exactly on the curve. And the boundary
  reaching the classifier is a sampled polyline whose chords lie above the
  convex curve they approximate, so interpolation systematically over-states it
  and under-calls significance. At 256 samples the two boundary-defining
  proteins missed by 3.1e-4 and 1.9e-4 — enough to grey them out.
  `CURVE_SAMPLE_POINTS` is now **1024**, which brings the worst interpolation
  error to **1.6e-5**; `BOUNDARY_EPSILON` is **1e-4**, set from the science
  rather than from that measurement so it does not quietly depend on one
  dataset: it is a factor of 1.00023 in p, a 0.02% difference, and it still
  clears the residual error six times over. A first attempt at concentrating
  samples over the *observed* `s` range made this worse, not better — a
  protein's boundary is evaluated at `s* = fc/cut - s0`, which ranges across
  the whole sweep, not just the band the experiment produced.
- **The Inspector stops offering cutoffs the boundary overrides.** With a SAM
  curve present, `|log2 fold change| ≥`, `Classify significance by` and the
  `FDR ≤` / `p-value ≤` field are hidden and replaced by a line saying the
  boundary decides and naming the FDR the test reached. Round 16's
  "a control that visibly does nothing is a defect" rule, sharpened: one of
  these was not merely inert but quietly wrong, since setting a fold-change
  gate here made the figure disagree with its own test.
  `volcanoThresholds` is still written by the run — `fdr` is the record of what
  was achieved, and is what the new line reports.

Driven in a real browser on the reported data, light **and** dark, **7 checks
each**: 100 proteins drawn, **100 coloured and 0 grey with 0 mismatches**
against the boundary read out of the DOM — every coloured point above the drawn
line and every grey one below, measured rather than eyeballed — and the
Inspector offering none of the three cutoffs while still explaining what
decides. No console errors. Before this round the same measurement found 2
mismatches and 2 proteins greyed against their own test.

**Verified:** 832 TypeScript tests (821 + 11 new: a `volcanoCurveClassifier`
suite in `plots.test.ts` covering branch selection, interpolation, the
exactly-on-boundary case, the asymptote and far-end rules, sample order and an
empty branch; plus two `continuous-axis.test.ts` cases pinning the reported
regression in both directions — points above the curve but under the
fold-change cutoff must colour, and a point clearing the cutoff but under the
curve must not), 184 Python tests unchanged, `tsc --build --force`, `eslint .`
and `ruff check` clean, 46-check acceptance run unaffected.

**Not done, deliberately:** the stored curve grew from 256 to 1024 samples per
branch, which is ~4k numbers in `document.json` per volcano plot. The
alternative — storing `cut`/`s0`/`df` and evaluating the boundary analytically
in TypeScript — would need an incomplete-beta implementation to own and test,
and would make the colours disagree with the drawn polyline by exactly the
interpolation error this round is removing. One boundary, drawn and used, is
the property worth keeping.

### Round 19 — a methods sentence for the volcano test, and the asymmetry answered

Two queries. One was a feature; the other turned out to be a question about
whether the code was right, and the answer was that it is.

#### The asymmetric boundary is correct — three checks, not an assurance

Reported: at `s0 = 0.5` the two branches sit at visibly different distances
from zero. **They should, and the drawing is exact.** Established before
anything was written, because "that's expected" is worthless unasserted:

- **Every drawn point inverts to one constant `cut`.** Solving each emitted
  `(X, Y)` back through the closed form — `t = t.isf(10⁻ʸ/2, df)`,
  `s = |X|/t`, `cut = X/(s + s0)` — gives a single value across all 1024
  points of a branch (spread **2.1e-11**), equal to the cutoff the
  classification uses to **2.2e-16**. No interpolation or calculation error.
- **Mirrored data gives exactly opposite cutoffs.** On a set built so every
  protein has an exact opposite, `cutUp == -cutLow` to floating-point at both
  `s0 = 0.1` and `0.5`, with equal up and down counts. An implementation bug
  could not be symmetric here and asymmetric elsewhere — this is the check
  that separates "the data is lopsided" from "the code is".
- **The reported data is genuinely lopsided** — 63 up against 37 down.

Why `s0` magnifies it: each branch's asymptote sits at `cut · s0`, so the gap
between the asymptotes scales linearly with `s0`. Measured: +0.081/−0.076 at
`s0 = 0.1` (invisible) against +0.265/−0.532 at `0.5` (a factor of two).
Nothing changes but the magnification.

This is the published SAM rule: `cutup` and `cutlow` are found by walking
inward from each tail independently, each judged against its own side of the
permutation null, so they coincide only when the data is symmetric. **A
symmetric-boundary option was offered and declined** — forcing symmetry would
change the statistic, not the picture. Both checks above are now regression
tests (`TestBoundarySymmetry`, `TestCurveFidelity`), so a future change to
`cutoffs_at` cannot quietly break the symmetric case while leaving the
asymmetric one looking plausible.

#### The methods sentence

- **Composed in Python, beside the numbers**, as `stats/methods.py` already is
  for every other test — `sam_methods_sentence` in `sam_volcano.py`. The
  alternative, re-deriving the wording client-side from stored parameters, is
  how a figure and its own methods text come to disagree.
- **It reports the permutation scheme that actually ran**, not the default:
  `MAX_EXHAUSTIVE_PERMUTATIONS` decides at run time, so claiming an exhaustive
  enumeration that never happened would be an unverifiable statement in
  someone's methods section. A test asserts the Monte-Carlo wording appears
  only above that bound.
- **It states both cutoffs**, which is what makes the asymmetry answerable
  from the figure rather than from this file.
- `SamVolcanoOutcome`/`VolcanoTestResponse` gained `cutUp`/`cutLow`,
  `permutations`/`permutationsExhaustive` and `methodsSentence`.
- **`PlotNode.volcanoTest`** stores the parameters *and* the sentence side by
  side — the shape `StatResult` already has (`comparisons` beside
  `methodsSentence`). One fact in two forms, not two derivations: the sentence
  is composed once by the service and never recomputed. Optional, so
  `SCHEMA_VERSION` stays 1. Written in the same `updateNode` patch as
  `volcanoSamCurve`, so a re-run replaces both together and a figure can never
  carry a methods sentence for a boundary it no longer draws.
- **Shown in the Stats tab**, where every other methods sentence lives, in the
  same `<details>` + Copy shape. It completes the "there is no test to run on
  this table here" notice rather than contradicting it: nothing to run *here*,
  and this is what was run. **Deliberately not made an `Analysis`** — that
  shape is built around `Comparison[]`, an omnibus and an `inputHash` over
  series values, none of which a volcano test produces, and the analyses list
  would render an empty comparison table.
- The Inspector gains one line naming both cutoffs and why they differ, so the
  asymmetry is answered where it is seen and not only in the methods text.

Driven in a real browser on the reported data at `s0 = 0.5`, light **and**
dark, **15 checks each**: the Stats tab showing the block with S0 and both FDR
figures, exactly one methods disclosure with a working Copy button, the
sentence naming `S0 = 0.5`, the target FDR, Tusher, both cutoffs and the
relabelling scheme; the Inspector reading `d ≥ 0.531 and d ≤ -1.064`; and a
re-run at `s0 = 0.1` replacing the sentence rather than adding a second. No
console errors.

**Verified:** 833 TypeScript tests (832 + 1: a `volcanoTest` round-trip
asserting *both* cutoffs survive, since a schema keeping one magnitude would
quietly lose half the record), 190 Python tests (184 + 6: the sentence's
contents, the permutation-scheme claim, the one-sample wording, the two
symmetry controls and the curve-fidelity inversion), `tsc --build --force`,
`eslint .` and `ruff check` clean, 46-check acceptance run unaffected.

---

### Round 20 — a montage tile that wouldn't move or resize

Reported: in a panel holding several tiled images, clicking one to move it
sometimes did nothing; specifically, on a test import of four images this
happened with the top-left tile, but clicking a different tile worked.

**The top-left specificity did not survive live reproduction.** Two rounds of
static investigation turned up several plausible mechanisms — a
`contentGrid` cell with no size floor, a coincidence between a tile's own
corner and the panel's resize handle at that same corner — but driving the
*actual* reported sequence in a real browser, cleanly (a fresh import, no
prior drags contaminating tile positions), showed something simpler and
**exactly symmetric across all four tiles**: a plain click on any montage
tile selected and dragged the *whole panel*, not that tile. This is
`selectionTarget`'s documented, deliberate rule (`Canvas.tsx`) — a click
resolves to the outermost container by default, and only a double-click
steps inside far enough to reach an individual tile — applying exactly as
written. Nothing was actually top-left-specific; that was very likely just
the order the reporter happened to test in, since the very first click any
montage receives always hits this path regardless of which tile.

- **A pure montage panel now resolves a plain click straight to the tile.**
  `isPureMontagePanel` (`Canvas.tsx`) is a narrow predicate — a panel with a
  `contentGrid` whose every child is a `plot`/`image`, i.e. a panel whose
  only purpose is holding tiles. `selectionTarget` special-cases exactly this
  case to skip the outermost-container step, as if the panel were already
  entered. Every other case — a single-plot panel, a group, a montage panel
  that also carries an annotation or caption child — keeps today's exact
  behaviour, which is what protects the two bugs this rule already exists to
  fix ("Panels can't be deleted", "Group doesn't group": see the
  reported-bug-rounds section above). Confirmed live, cleanly, in both
  directions: all four tiles now select and drag independently on the first
  click, and clicking a bar/plot in an ordinary single-plot panel, deleting
  it, and grouping two panels together (shift-click, Group, click a member to
  select the group) all still work exactly as before.
- **A tiled panel's cells had no minimum size**, a real but separate gap
  found during investigation: `fillPanelChildren`
  (`packages/doc-model/src/operations.ts`) tiles a panel's own frame via
  `gridCells`, which clamps a cell to `Math.max(0, ...)` with no floor — so a
  panel shrunk enough (past what its grid needs) could hand a tile a
  near-zero frame, whose resize handles then collapse to an ungrabbable
  point. Not what the reporter hit (a fresh montage, freshly auto-laid-out,
  is nowhere near this small), but reachable by hand and worth closing.
  `ResizeOptions` gained optional `minWidthMm`/`minHeightMm`
  (`packages/doc-model/src/layout.ts`), additive alongside the existing
  scalar `minMm` so every other caller of `resizeFrame` is unchanged; the
  canvas resize path computes a montage panel's own grid-derived minimum
  (`cols/rows * MIN_TILE_MM` plus gutters and padding) and passes it instead
  of the generic 5 mm floor, so the panel physically cannot be dragged
  smaller than its grid needs. `MIN_TILE_MM` is exported once from
  `operations.ts` and read by both that computation and a backstop in
  `fillPanelChildren` itself (for any other caller that can still reach a
  too-small frame — a template applied onto an already-small panel, or an
  imported document that started too small): if tiling would hand any cell
  below the floor, every child keeps its prior frame rather than a
  degenerate one, the same "extras keep their size" stance the
  more-children-than-cells case already takes.
- **No schema change.** Both fixes are code-level (a canvas interaction rule,
  a resize-options extension); no document field changed.

Driven in a real browser: a fresh four-image import selected and dragged each
of the four tiles independently on a single click, with zero console errors;
dragging a montage panel's own `se` handle hard toward its origin stopped at
its grid's derived minimum (four ~28×27 px tiles, not a collapse) rather than
the generic 5 mm floor; and the panel-delete and grouping regressions above
were confirmed with real canvas clicks (not the Layers list, which does not
support shift-click multi-select) rather than assumed safe.

**Verified:** 836 TypeScript tests (833 + 3: a per-axis `resizeFrame` minimum
test, and two `fillPanelChildren` cases — refusing a degenerate tile when the
panel is too small for its grid, and still tiling normally when merely
tight), 190 Python tests unchanged (nothing here touches `services/api`),
`tsc --build --force` and `eslint .` clean, 46-check acceptance run
unaffected. `selectionTarget`/`isPureMontagePanel` have no unit test — this
codebase verifies canvas interaction live rather than through component unit
tests (there is no existing precedent for one), so this was verified the same
way the live reproduction was: driving the real app.

---

### Round 21 — a group's resize handles scaled nothing

An "Ungroup" toolbar button was added first — `ungroup` (`operations.ts`) had
existed and been unit-tested since grouping was built, but nothing in the UI
ever called it. Straightforward wiring: enabled only for a lone `group`
selection, dissolves it back into its members with their page positions
preserved (verified pixel-for-pixel live), selects the freed members after.

Then reported: selecting a grouped panel and dragging its resize handles did
nothing visible; double-clicking again (stepping inside the group to select
the panel itself) made resizing work. Confirmed by reading the code before
touching it: `renderNode` (`packages/render/src/render-document.ts`) only
ever *translates* a node — no node type is ever visually scaled by an SVG
transform. Every resizable type instead has its content reshaped at the
**model** level (`resizePanel` re-tiles a panel's children, `rescaleArrowPoints`
rescales an arrow's point array) — and `group`'s render case is a bare
wrapper around its children with no such step. The canvas resize commit
dispatched `panel`/`arrow` to their real handlers and let everything else,
`group` included, fall to a bare `node.frame = snapped.frame`: the group's
own bounding box updated (so its handles visibly moved), but nothing under
it did. "Double-click and it scales" was just the member's own working
resize, once double-clicking (`enteredId`) reached it — `group` staying a
`CONTAINER_TYPES` entry is deliberate and unchanged, the same reasoning
Round 20's `isPureMontagePanel` exception stopped short of applying here:
grouping panels together is specifically for moving/resizing them as one
unit, so a plain click resolving to the group first is the point, not the
bug.

- **`resizeGroup`** (`packages/doc-model/src/operations.ts`, beside
  `ungroup`) scales every member proportionally about the group's own local
  origin — panels, shapes, arrows, nested groups — the way a group resize
  behaves everywhere else (Illustrator, Figma). Dispatches by member type:
  `panel` → a new `resizePanelGeometry` (the frame/tiling half of
  `resizePanel`, split out so this caller can reuse it without also running
  the label shim below), `arrow` → the existing `rescaleArrowPoints`
  unchanged, `group` → recurse, everything else → direct frame assignment
  (identical to what a plain, ungrouped resize already does for those
  types). Individual member `rotation` and text `fontSizePt`/stroke widths
  are deliberately untouched — only `shape`/`arrow`/`text` can be rotated
  and their angle stays fixed while position/size scale, and this codebase
  already keeps type sizes independent of frame geometry everywhere else;
  scaling either would be new, unrequested scope.
- **A second, broader bug found while tracing the first, and fixed in the
  same pass**: a `panel-label` is a top-level node with no parent of its
  own, positioned by a static frame that only `relabelPanels` (relettering)
  and `resizePanel`'s own shim ever rewrite. The canvas **move** commit
  never called either — it only ever rewrote `frame.x/y` for the literal
  dragged node id(s). **Confirmed live before writing any fix**: dragging a
  plain, ungrouped panel moved it 40.5 × 32.4 px while its letter label
  stayed exactly still. `snapshotPanelAbsolutePositions` /
  `syncPanelLabelsFromSnapshot` (`operations.ts`, exported for `Canvas.tsx`)
  read every affected panel's `absoluteFrame` before a move or a group
  resize, then reconcile each panel-label by the delta afterward — one
  mechanism for both call sites, since a move is a resize with a scale
  factor of 1, and `absoluteFrame` already sums any depth of ancestors
  correctly on both reads, so nothing needs to track *how* the geometry
  changed at each nesting level, only that it did.
- **No schema change.** Both fixes are code-level; no document field
  changed.

Driven in a real browser: grouping two panels and dragging the group's `nw`
handle grew and repositioned both panels together with **both** their
letters following, not just the one nearer the dragged corner; a plain,
ungrouped panel drag now carries its label with it while an untouched
sibling panel's label stays exactly put; and the Round 20 montage-tile and
Group/Ungroup/Delete regressions were re-run rather than assumed unaffected.

**Verified:** 844 TypeScript tests (836 + 8: proportional scaling of a shape
member, a panel member's plot/tiles re-filled rather than left at a bare
frame, an arrow member's points rescaled, a nested group scaling correctly
through two levels with no accumulator needed, a panel's label landing
beside its new absolute position after a group resize, rotation/`fontSizePt`
left untouched, and two cases for the move-time label sync — a plain panel
and a panel dragged as part of a group, with its untouched sibling's label
confirmed unmoved), 190 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and `eslint .` clean, 46-check
acceptance run unaffected. `resizeGroup` and the label-sync helpers are
plain functions with real unit tests, the same story as `resizePanel`/
`ungroup`; the `Canvas.tsx` wiring has none, matching this file's standing
note that canvas interaction is verified live rather than through a
component test that doesn't otherwise exist in this codebase.

---

### Round 22 — panel numbering and layout gaps after delete

Reported: after deleting a panel, the remaining panels' letters were not
contiguous and auto-layout still reserved the deleted panel's space; a newly
added panel was "added sequentially to the deleted panel" rather than filling
the gap; deleted panels and labels seemed not to be permanently gone.

- **All four delete pathways called `deleteNode` alone and never
  `applyAutoLayout`/`relabelPanels`/`reflowBrackets` afterward**: the
  Delete/Backspace key (`Canvas.tsx`), the Layers tab's `×` button
  (`SidePanel.tsx`), and Inspector's multi-select and single "Delete this
  panel" buttons (`Inspector.tsx`). Every panel-*adding* action (import, PCA,
  UMAP, volcano test, image insert, asset insert) already calls all three
  after changing panel count — delete was the one panel-count-changing action
  with no analogous call anywhere.
- **`deleteNode` was already fully correct** — it cascades to permanently
  remove a deleted panel's own `panel-label` via a fixed-point sweep, so
  nothing was actually left behind in the document. The "deleted panels
  linger" complaint was the *visual* symptom (an unclosed grid gap and stale
  letters), not leftover data.
- **`applyAutoLayout` was already immune to staleness** — it always
  recomputes `readingOrder(draft.nodes)` and `suggestGrid(panels.length)`
  live, with no cached count or grid shape anywhere, and unconditionally
  clears every panel's stale `.slot` when called without a template (exactly
  how every add-panel action already calls it). The bug was entirely that
  nothing called this pipeline after a delete — not a flaw in the pipeline.
- **`deleteNodesWithLayout`** (`apps/web/src/deleteNodes.ts`, new) is the one
  shared fix, called from all four pathways in place of a bare `deleteNode`
  loop: delete every requested id, sweep away brackets left pointing at a
  now-missing plot (the existing Canvas-only cleanup, now shared by all
  four), and — only if the panel *count* dropped — run
  `applyAutoLayout` + `relabelPanels` + `reflowBrackets` in the same commit.
  It lives in `apps/web`, not `packages/doc-model`: `doc-model` imports
  nothing internal, and `reflowBrackets` lives in `packages/render`, so the
  combined operation cannot live there — the same reason `Toolbar.tsx`'s own
  `arrange()`/`applyPreset()` already compose these three at the app layer.
- **Detection is a panel *count* comparison, before vs. after the delete
  loop, not "is a deleted id itself a panel."** Load-bearing, not defensive:
  Round 21 established that panels can sit inside a `group`, and `deleteNode`'s
  cascade walks `parentId` transitively, so deleting a *group* containing
  panels must still trigger the relayout — only a count comparison catches
  that. Covered by a dedicated test.
- **One commit, not several inside a transaction.** `Toolbar.tsx`'s
  `applyPreset` already composes `applyAutoLayout` + `reflowBrackets` in a
  single commit, and `DocumentStore.commit`/`.transaction` confirms the split
  is purely cosmetic inside a transaction — patches merge into one undo entry
  either way. A single commit is simpler and guarantees exactly one React
  update and one undo step per delete.
- **`apps/web/src/deleteNodes.test.ts`** unit-tests `deleteNodesWithLayout`
  directly against a real `DocumentStore` (no React) — the same "plain
  function, real test" treatment `resizeGroup`/`ungroup` already get,
  distinct from the canvas *wiring* (the keydown handler, the three buttons),
  which stays verified live only, per this file's standing convention. Cases:
  the repro itself (delete one of four panels, remaining three re-pack and
  reletter to exactly match a fresh layout pass), a non-panel delete leaving
  every panel/bracket frame untouched, a group-cascade delete still
  triggering the relayout, permanence of the deleted panel/label/orphaned
  bracket, an empty-selection no-op, and deleting the last remaining panel
  without throwing.

Driven in a real browser, light **and** dark: deleting a panel via the Delete
key dropped the panel count by exactly one and relettered the remainder
contiguously **immediately** (not only after a later action); one Ctrl+Z
restored the panel, its label, and the original lettering together in one
step; deleting a non-panel node (a text label) left every panel's transform
and letter unchanged; the Layers tab's `×` button and Inspector's "Delete
this panel" button both produced the identical contiguous relettering; and
the originally reported sequence — delete a panel, then import a new dataset
— produced a fully packed, contiguously lettered grid with no reserved gap,
in both themes. No console errors throughout.

**Verified:** 850 TypeScript tests (844 + 6 new: the repro, the non-panel
no-op, the group-cascade case, permanence of the deleted panel/label/bracket,
the empty-selection no-op, and deleting the last panel), 190 Python tests
unchanged (nothing here touches `services/api`), `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected (no existing fixture
deletes a panel or depends on stale numbering), and 22 live-browser checks
across light and dark.

---

### Round 23 — rich text runs, multi-line axis titles, a Greek/math symbol picker

Requested: superscript, subscript, italics and symbols in text boxes; line
breaks in axis text; a menu for inserting Greek/math characters. Scoped down
with the user before building anything: all three land together (they share
the same tspan/`dy` rendering technique); line breaks cover **axis titles
only**, not tick/category labels; rich formatting covers **free-standing
text boxes only** (`TextNode`), not panel labels, bracket labels, or axis
titles. Centre-alignment was part of the ask but needed no work — axis
titles are already always `text-anchor: middle`.

- **`renderText` already split `\n` into `<tspan>`s, and whole-node italic
  already rendered through a real font face — the actual gaps were per-run
  formatting and, above everything else, the editor.** `Canvas.tsx`'s
  `text-edit-overlay` was a single-line `<input>` where `Enter` committed
  rather than inserting a newline; multi-line free text had been legal in
  the schema and renderer with no UI path to type one. Round 7's
  `TickLabelRun`/`tickLabelNode` `dy`-cumulative-offset technique was the
  direct precedent generalized here — its rendering approach, not its
  tick-specific production pipeline (`NumericScale.formatRuns`), which has
  no analogue for hand-typed text.
- **`TextRun { text, bold?, italic?, script? }`, flat, not lines-of-runs.**
  `\n` lives inline inside whichever run's own `.text` contains it — the
  same way the plain `text` string already carries `\n` — so there is one
  offset space (matching a `<textarea>`'s own flat-string model exactly),
  one scan in the renderer, and one edit taxonomy instead of two. `bold`/
  `italic` are tri-state (`undefined` inherits the node's own `style`; an
  explicit `false` is needed to turn a range off on a whole-node-bold
  `TextNode`, which a plain boolean can't distinguish from "inherit").
  `TextNode.richText?: readonly TextRun[]` is additive; `TextNode.text`
  stays required and is kept in sync by exactly one function,
  `plainTextOfRuns`, the same "composed in exactly one place" discipline
  `analysisInputHash`/`scaleBarWidthMm` are held to — never a second,
  independently-edited source of truth.
- **`packages/doc-model/src/richtext.ts`** is the one place a run list is
  ever cut, merged, reconciled or toggled, shared by both editing surfaces
  so they cannot disagree:
  - `splitRunsAt`/`mergeAdjacentRuns` — the only place a run is ever split
    in two, and the only place adjacent same-formatting runs are reunited
    (merge treats matching `undefined` and explicit `false` as *different*
    states, per the tri-state note above, and drops zero-length runs).
  - `reconcileTextEdit(prevRuns, nextText)` — a bounded, not general, diff:
    a single `<textarea>` `onChange` can only ever report "unchanged
    prefix, unchanged suffix, changed middle" (true of typing, deleting,
    and pasting alike), so finding the longest common prefix/suffix and
    treating the differing middle as one replaced span is sufficient. The
    inserted text inherits the formatting of the run to its left (typing
    continues the format it's next to), or the run at the insertion point
    when inserting at the very start.
  - `isRangeFormatted`/`toggleRunFormat` — a range's format toggles off if
    every overlapping run already has it (reading `baseActive` — the
    node's own `style` — for what an `undefined` bold/italic run
    inherits; sup/sub have no whole-node equivalent, so they never inherit
    `baseActive`), otherwise on. `isRangeFormatted` is read-only, used by a
    toolbar button to show its pressed state, and `toggleRunFormat` is
    written to call it for its own on/off decision rather than
    duplicating the same rule — a pressed state and what clicking it does
    can never disagree.
- **`richTextNode` (`render-document.ts`) generalizes both existing `dy`
  techniques into one**: line stepping (`renderText`'s own pitch) and
  script rise/drop (`tickLabelNode`'s cumulative-offset bookkeeping,
  extended to a `scriptOffsetMm` reusable in either direction — `text-width.ts`
  gained this one new export, reusing the same 65%/`SUPERSCRIPT_MIN_PT`
  sizing for both). A line-start tspan's `dy` folds the line-height step and
  any pending script return into one number, so no separate "reset" step is
  needed — verified by a parity test asserting the literal `dy` sequence
  for a run list mixing bold, a superscript, and a line break. Bold/italic
  are written **explicitly** (`'normal'` as well as `'bold'`/`'italic'`) on
  every tspan, never omitted when off — a tspan otherwise inherits the
  outer `<text>`'s own whole-node style, so a run overriding *off* what the
  node sets has to say so. New `SceneRole`s `'text-sup'`/`'text-sub'`, kept
  distinct from `'tick-label-sup'` (computed tick exponent vs. user-authored
  run) so a role-count assertion for one is never silently widened by the
  other; both get the identical `checkTextSize`/parity size-floor exemption
  `'tick-label-sup'` already has, down to `SUPERSCRIPT_MIN_PT`. A `richText`-absent
  `TextNode` renders byte-identical to before this round — pinned by a
  parity regression test, the same guarantee every prior structural
  addition here has been held to.
- **Axis titles needed no schema change at all** — a string can already
  legally contain `\n`. `multilineTitleNode`, structurally identical to
  `tickLabelNode`, replaces the bare `text(...)` call at all five axis-title
  sites (`renderAxes`'s x/y, `renderAxesHorizontal`'s x/y, `renderSecondaryAxis`'s
  y2) plus the cascade depth-axis caption, folded in since it's the same
  shape. `editTarget` stays on the outer `<text>`, never a `<tspan>` —
  required by `parity.test.tsx`'s existing assertion that every
  `editTarget`-carrying node is a `'text'` tag.
- **`requiredMargin`/`y2WidthMm`'s single-line `titleHeight` scalar became
  `titleHeightFor(title)`**, a function of the title *string*'s own `\n`
  count — not of any measured width. That is what keeps `requiredMargin`'s
  documented "exactly two passes, never a loop" termination argument
  intact: a line count from splitting a string is knowable before any
  geometry is computed, the same argument `offsetReserveMm` already rests
  on. **Deliberately not built: auto-wrap-to-width** — it would need the
  available width, which is the very quantity `requiredMargin` is
  computing, a real circular dependency the explicit-`\n`-only design
  avoids entirely. Measured directly rather than assumed correct: growth
  is exactly one `titleLineHeightMm` per extra line only once the reserved
  margin has cleared the theme's own default-margin floor — a genuine
  effect of `Math.max(themeMargin, needed)`, not a bug, and comparing a
  1-line title against a 2-line one understated the per-line quantity by
  exactly the amount the 1-line reserve sat under that floor; the pinned
  test compares two counts both already well past it.
- **The canvas overlay grows a second, `<textarea>`-based mode** for
  `TextNode` text and every axis-title `EditTarget` — panel labels and
  bracket labels keep the exact single-line `<input>` they always had,
  Enter still committing immediately, confirmed live unaffected. New
  keybinding for the `<textarea>` case: a bare `Enter` inserts a newline
  (the textarea's own default, not intercepted), `Escape` still cancels,
  blur still commits, and `Ctrl`/`Cmd`+`Enter` commits explicitly without
  needing to blur first — confirmed live that a bare Enter leaves the
  overlay open and `Ctrl+Enter` closes it. `commitTextEdit` routes a
  `TextNode` edit through `reconcileTextEdit` whenever `richText` already
  exists, rather than overwriting `text` directly, so a canvas-side edit
  can never silently discard formatting the Inspector's own textarea would
  have preserved — one algorithm, two call sites. A `richText`-absent
  `TextNode` edited on the canvas is left as a plain string overwrite
  (only when the value actually changed) rather than bootstrapping a
  `richText` array for an edit with nothing to format.
- **`TextFields` (Inspector) gained the toolbar this feature is mostly
  about**: the `Text` field becomes a `<textarea>`; a new Italic `.check`
  checkbox beside the long-existing Bold one closes a second latent gap
  (`TextStyle.fontStyle` was already schema'd and rendered, just never
  exposed in the UI); a new four-button `.format-toggle` row
  (Bold/Italic/Superscript/Subscript), shown only for `node.type === 'text'`,
  reads its selection from the textarea's native `selectionStart`/`selectionEnd`
  (captured on `onSelect`) and calls `toggleRunFormat`/reads `isRangeFormatted`
  for its pressed state. `.format-toggle` is a small, deliberately new CSS
  class rather than a fifth `.check` checkbox: these reflect the formatting
  of the current *selection*, which is transient and can be mixed, not a
  persistent per-node boolean the way Bold/Italic-the-checkboxes already
  are — but its `.active` state reuses the app's existing "control is
  currently on" visual idiom (`.tabs button.active`'s inset-underline
  `box-shadow`) rather than inventing new visual language.
- **A Greek/math symbol picker is a native `<select>`**, not a floating
  popover — no popover/modal infrastructure exists anywhere in this app,
  and the marginal gain over a `<select>` (which also gets free type-ahead)
  didn't justify building one from nothing. Raw Unicode already rendered
  correctly before this round — Liberation Sans covers these blocks, and
  `text-width.ts`'s advance-width table already tolerated any character it
  had no exact metric for — so this is purely a discoverability affordance,
  not a rendering-capability gap. `apps/web/src/textEditing.ts`'s
  `insertAtCaret` is the one small piece of DOM-touching glue (reads
  `selectionStart`/`selectionEnd`, splices the character in, restores
  focus and caret) — an inserted symbol becomes an ordinary edit through
  the same `onChange` → `reconcileTextEdit` path everything else uses, so
  it composes with existing formatting for free. Wired into exactly two
  places: `TextFields`'s textarea and `AxisFields`'s title textarea.
  Deliberately not wired into the floating canvas overlay (stays minimal
  chrome; raw typing/paste there is unaffected) or panel-label/bracket-label
  fields (outside confirmed scope).

Driven in a real browser, light **and** dark, **45 checks total**: bolding
"Hello" of "Hello world" showed the button active and split the scene into
a bold `<tspan>` and a normal one; toggling the same still-selected range
off showed the button inactive and the two tspans re-merged into one plain
run; italic **and** superscript applied to "world" produced a single tspan
carrying both `font-style="italic"` and a measurably smaller `font-size`
than the node's own base size, with role `text-sup`; a Greek letter
inserted at the caret landed exactly there; a two-line `TextNode` drew two
tspans; the canvas overlay for a `TextNode` was confirmed a `<textarea>`
where a bare Enter left it open and `Ctrl+Enter` committed and closed it,
while a panel label's overlay stayed a plain `<input>` where Enter still
committed immediately; double-clicking a panel stepped in and selected its
plot (not the panel), whose Inspector then showed a `<textarea>` for the y
title; typing a second line into it drew two tspans matching what was
typed **and** — confirmed by screenshot, not by reading the rotation
transform on paper — read top-to-bottom in the correct order once rotated
-90°; a symbol inserted into the axis title landed in its value; and
exporting to PDF with a bolded `TextNode` and a two-line axis title present
produced a real, non-trivial download with no console errors throughout.

**Not done, deliberately:** panel labels and bracket labels get no rich
formatting and no symbol picker; tick/category label line-wrapping
(existing tilt/truncate machinery is untouched); axis-title
auto-wrap-to-width; a symbol picker on the canvas double-click overlay;
underline/strikethrough/per-run colour/per-run font/per-run align — `TextRun`
is additive-friendly if these are wanted later, no version bump then
either; nested `<tspan>`-in-`<tspan>` — a flat tspan sequence throughout,
matching every existing pattern in this codebase.

### Round 24 — rich text formatting on axis titles

Requested: the same Bold/Italic/Superscript/Subscript toggle row Round 23
gave free-standing text boxes, on axis titles too — the user tried it on a
y title, found nothing there, and the gap was real: Round 23 deliberately
scoped rich formatting to `TextNode` only, and axis titles got line breaks
and a symbol picker but not the toggle row itself. This is a direct
extension of Round 23's own machinery, not a new mechanism — the same
`TextRun` shape, the same `reconcileTextEdit`/`toggleRunFormat`/
`isRangeFormatted` algorithm, the same `dy`-based tspan technique, applied
to one more field shape (`AxisSpec.title`, `PlotNode.cascadeAxisTitle`) via
one more editing surface (`AxisFields`, the cascade depth-axis title field).

- **`AxisSpec.richText?: readonly TextRun[]` and `PlotNode.cascadeAxisTitleRichText?: readonly TextRun[]`**,
  both additive; `SCHEMA_VERSION` stays 1. An axis title has no whole-title
  `TextStyle` the way a `TextNode` does, so an unformatted run here always
  inherits `false` for both bold and italic — never the tri-state
  `TextNode`'s own `style.fontWeight`/`fontStyle` allows. `cascadeAxisTitle`
  has no wrapping object of its own to attach `richText` to, so its rich-text
  field is a sibling, not a nested one — the same flat-optional-string
  precedent `cascadeAxisTitle` itself already set beside the rest of
  `PlotNode`.
- **`richRunTspans`, extracted once from `richTextNode`'s own inner loop.**
  `richTextNode` (a `TextNode`'s renderer) and `multilineTitleNode` (an axis
  title's) drew two independent copies of the identical `dy`-cumulative
  line/script-offset arithmetic — Round 23 built the first, Round 24 needed
  the second, and duplicating it a second time is exactly how the two come
  to silently disagree. `richTextNode` is now a thin wrapper passing
  `style.fontWeight === 'bold'`/`style.fontStyle === 'italic'` as the
  inherited base; `multilineTitleNode` gained a `richText` parameter and
  calls the same function with the base always `false`, falling through to
  its existing plain `\n`-split path — byte-identical to before this round —
  whenever `richText` is absent or empty. A parity-style test in
  `axis-title.test.ts` asserts the two callers produce the identical
  `dy`/`font-weight`/`font-style`/role sequence for an equivalent run list,
  which is what proves the extraction didn't fork the logic rather than
  merely appearing to. One regression the extraction had to guard against
  explicitly: `richTextNode`'s original line-height came from
  `style.lineHeight ?? 1.2`, a per-node override `multilineTitleNode` has no
  analogue for (axis titles never set one) — `richRunTspans` takes the
  multiplier as a parameter, defaulting to `1.2`, so a `TextNode` with a
  custom `lineHeight` keeps it rather than silently falling back to the
  axis-title default once the two callers share one function.
- **All six axis-title render call sites** (`renderAxes`'s x/y,
  `renderAxesHorizontal`'s x/y, `renderSecondaryAxis`'s y2, the cascade
  caption) now pass their own `richText` field alongside the title string
  they already passed. The cascade caption passes
  `node.cascadeAxisTitleRichText` only when `group.category === undefined` —
  the same condition that already gates whether the caption is
  `node.cascadeAxisTitle` at all (a categorised group's caption comes from
  the data instead, and the renderer ignores the freeform field for exactly
  the same reason Round 23 kept it un-editable there).
- **`useRichTextToggle`, a shared hook, and `FormatToggleRow`, the shared
  four-button-plus-symbol-picker JSX**, both factored out of `TextFields`'s
  original inline implementation so a second and third field (`AxisFields`,
  the cascade depth-axis title) can render the identical toolbar rather than
  a second hand-copied one. The hook bundles the textarea ref, selection
  tracking, and the toggle/pressed-state calls into
  `toggleRunFormat`/`isRangeFormatted` — parameterised by `baseBold`/
  `baseItalic` (a `TextNode`'s own style for `TextFields`, always `false`
  for the two axis-title callers) and a `commit` callback each caller
  supplies its own write path through. `TextFields` itself was refactored
  to call the shared pieces — behaviour unchanged, confirmed by re-running
  Round 23's own live checks against it rather than assumed safe from the
  refactor alone.
- **`AxisFields` gained the toolbar under its existing title `<textarea>`**,
  absorbing the standalone `SymbolPicker` Round 23 already placed there into
  the shared `FormatToggleRow`. Its `commit` writes both `title` (via
  `plainTextOfRuns`) and `richText` in the same `onChange` patch — one undo
  entry, matching every other multi-field Inspector commit in this codebase.
  Because `AxisFields` is the one component already shared by the x/y/y2
  title fields, all three gained the toolbar in one change with no
  per-axis branching.
- **`CascadeControls`' depth-axis title field got the identical treatment**,
  with one structural fix the other two call sites didn't need: the
  component's own `if (!isCascadable(...)) return null;` sat *before* where
  a hook would first be called, and `isCascadable` can flip between renders
  of the same mounted instance (toggling `offsetStepMm`/`offsetStepXMm`
  while `CascadeControls` stays mounted at the same tree position) — calling
  a hook only on the branch that survives the early return would vary this
  component's hook count across renders of one instance, a real rules-of-
  hooks violation this codebase's lint config has no plugin to catch (no
  `eslint-plugin-react-hooks` here, unlike many React projects). Fixed by
  calling `useRichTextToggle` unconditionally before the early return, not
  by removing the early return — the same "hooks first, branch after"
  restructuring the pattern always calls for. Verified live rather than
  trusted from the fix alone: importing a three-series own-x-per-series
  table (which defaults to a line plot), enabling a cascade offset and the
  depth axis, then italicising part of the caption produced the correct
  `font-style="italic"` tspan in the rendered scene.
- **No change to the canvas double-click overlay.** Axis titles keep the
  plain `<textarea>` there for quick line-break edits; formatting stays
  Inspector-only, matching `TextNode`'s own Round 23 precedent exactly.
- **No margin-math changes anywhere.** An axis title is always
  `text-anchor: middle`, so its horizontal extent never feeds
  `requiredMargin` — only line *count* does, which rich formatting cannot
  change (bolding a word doesn't add a `\n`).

Driven in a real browser, light **and** dark: bolding part of a y title and
superscripting part of an x title each showed the corresponding toggle
button active and drew the matching `font-weight`/`text-sup`-role tspan in
the scene; a symbol inserted through the axis title's now-shared toolbar
landed at the caret; exporting to PDF with both formatted titles present
produced a real, non-trivial download with no console errors; and — on a
freshly imported three-series line plot with a cascade offset and depth
axis enabled — italicising part of the depth-axis caption produced a
correctly split, correctly styled two-tspan caption
(`Concentration` italic, ` (mg/mL)` normal). Round 23's own 42-check
`TextNode`-toolbar script was re-run afterward and passed unchanged in both
themes, confirming the `useRichTextToggle`/`FormatToggleRow` extraction
left that surface's behaviour exactly as it was.

**Not done, deliberately:** the y2 title toolbar was not separately driven
live — `AxisFields` is the identical component already verified for x and
y, wired to `y2` through the same `onChange` contract, and its render path
(`multilineTitleNode(spec.title, spec.richText, ...)`) is covered by
`axis-title.test.ts`'s existing y2-margin test plus the new round-trip and
richRunTspans-equivalence tests — a second live pass would exercise no code
the first two didn't already reach. Tick/category labels, panel labels and
bracket labels still get no rich formatting, unchanged from Round 23's
scope.

### Round 25 — a second axis-title line overlapped the tick labels

Reported: a line break in a y-axis title made the second line overlap the
tick labels. The bug predates Round 24 — it was already latent in Round
23's plain `\n`-only multi-line titles, just not yet reported. `requiredMargin`
already grows `margin.left`/`margin.right` to hold every extra line
(`titleHeightFor`, `y2WidthMm`'s own copy of the same arithmetic), but the
*render* call site positioning a rotated title never used that reserved
room — so the second line walked in the wrong direction: toward the axis
instead of into the margin already set aside for it.

- **Root cause, derived from the actual SVG rotation, not assumed.** A
  rotated title's lines stack via `dy` on `<tspan>` children — the same
  idiom used everywhere in this renderer — and `rotate(-90)`/`rotate(90)`
  each turn that *local* `dy` step into a *horizontal global* shift. For an
  unrotated title (the bottom x-title in both orientations, already correct
  since Round 23), stepping down is genuinely "further from the plot." But
  `renderAxes`'s y-title and `renderAxesHorizontal`'s x-title
  (`rotate(-90)`, anchored at *negative* x) get a *positive* global shift
  per line — walking back toward x = 0, the axis. `renderSecondaryAxis`'s
  y2 title (`rotate(90)`, anchored at *positive* x) gets the mirror-image
  *negative* shift — walking back toward the plot from the other side.
  **Measured, not just derived**: at the Nature theme's `axisTitlePt = 7`,
  one line step is `2.96 mm` while the single-line clearance gap
  (`axisTitleGapMm`) is only `2.2 mm` — so the second line didn't just get
  close, it overlapped by about `0.76 mm`.
- **The cascade depth-axis caption needed no fix**, despite also using
  `rotate(-90)`: its anchor sits at a large *positive* x (in the right-hand
  margin, past the plot), so the same per-line shift that hurts the y-title
  moves the caption's extra lines *further* from the plot — already the
  correct direction. Confirmed by an explicit negative-space test
  (`continuous-axis.test.ts`) asserting a one-line and two-line caption's
  `transform` are identical, not merely left untouched on the strength of
  the math alone.
- **The fix is a pure translation of the whole multi-line block, not a
  change to the `dy` stepping itself.** Round 23 already verified (by
  screenshot, not by re-deriving the matrix) that the existing stacking
  direction produces correct top-to-bottom reading order for both
  `TextNode` and the one already-correct axis-title case; touching that
  shared logic would risk that guarantee for no reason. Instead, each
  rotated title's own anchor position now reaches the same extra distance
  `requiredMargin`/`y2WidthMm` already reserve, via one new shared
  `titleExtraLinesDepthMm(title, fontSizePt)` in `render-document.ts` — not
  exported, since every consumer already lives in that one file. This also
  closes a pre-existing "two derivations of one fact" gap in this
  codebase's own terms: `requiredMargin`'s `titleHeightFor` and
  `y2WidthMm`'s inline copy of the identical `(lines - 1) * lineHeight`
  arithmetic now both read the one shared function instead of two
  independently-typed-out copies that could already have drifted.
- **The y2 title's own fix looks like a no-op when read in isolation, and
  that is correct — verified, not assumed.** `renderAxes`'s y-title anchor
  is measured from the fixed y-axis line (local x = 0), so adding the extra
  reach shifts it directly and observably. `renderSecondaryAxis`'s y2-title
  anchor is instead measured from `plotWidth`, and `plotWidth + margin.right`
  is itself invariant — both equal `frame.width - margin.left`, untouched by
  how the two individually split. So when a second line grows `margin.right`,
  `plotWidth` *shrinks* by the same amount, already pulling the old,
  unfixed anchor inward; adding this fix's extra term back out exactly
  cancels that pull, landing the anchor at the *same* position a single-line
  title already used. A dedicated test confirms both halves of this: that
  `plotWidth` really did shrink by one line height (proving the cancellation
  is real, not vacuous), and that the rendered anchor is unchanged.

Driven in a real browser, light **and** dark: a two-line y-axis title's own
rendered bounding box (read via `getBoundingClientRect()`, not eyeballed)
sat with its rightmost edge at `112.08 px` against the tick labels'
leftmost edge at `123.36 px` — a clear gap, where before the fix the
theme's own numbers already proved a `0.76 mm` overlap was mathematically
certain. No console errors.

**Verified:** 898 TypeScript tests (894 + 4 new: anchor-shift tests for the
y-title and `renderAxesHorizontal`'s x-title, the y2-title's
plotWidth-cancellation test, and the cascade caption's negative-space
check), 190 Python tests unchanged (nothing here touches `services/api`),
`tsc --build --force` and `eslint .` clean, 46-check acceptance run
unaffected (no existing fixture uses a multi-line rotated title).

### Round 26 — an align/distribute function for canvas objects, including panel labels

Requested: a way to align multiple selected objects — panels, shapes, text,
arrows, images, groups — explicitly including panel labels, which could
previously only be nudged by hand one at a time.

- **The geometry already existed, fully tested, and was wired to nothing.**
  `alignFrames`/`distributeFrames` in `layout.ts` — six align modes plus
  gap-equalising distribution, pure functions over `Map<NodeId, RectMm>` —
  had a geometry-only unit test and zero call sites anywhere in `apps/web`.
  This round's whole job was the document-aware wrapper and the UI, not new
  geometry, which is exactly what "Already scaffolded but unused" already
  named it as.
- **`alignSelection`/`distributeSelection` (`operations.ts`) convert to and
  from page-absolute space, once, before any frame is written.**
  `NodeBase.frame` is parent-relative and a selection can span different
  parents — a shape inside one panel, a top-level text, a parentless
  panel-label — so every target's `absoluteFrame` and its ancestor origin
  are snapshotted *before* the pure align/distribute call, and each result
  is converted back by subtracting that same pre-mutation origin. Reading
  the snapshot before any write, rather than re-deriving it after some
  targets have already moved, is what keeps a selection that happens to
  include both a container and one of its own descendants from compounding
  a double move — pinned by a dedicated test rather than left as an
  assumption about an edge case nobody would normally hit.
- **`ALIGNABLE_NODE_TYPES` deliberately excludes `bracket` and
  `scale-bar`.** A bracket sits in **absolute page space** and does not
  move with the panel it annotates — `Toolbar.tsx`'s own existing comment
  on `applyPreset` already says so, which is why every panel-repositioning
  command already follows its layout commit with `reflowBrackets`. A scale
  bar's `frame.width` is derived by `scaleBarWidthMm` and owned by
  `resyncScaleBars`. A plain frame align would fight both, so neither is
  ever a target — silently skipped if selected, the same treatment a
  locked node already gets.
- **Panel labels needed no special-casing to become alignable.** They are
  ordinary top-level nodes with `parentId: null`, so `frame ===
  absoluteFrame` for them already, and a user could already drag one
  independently by hand with nothing snapping it back except the next
  structural pass — aligning them plainly, the same way every other node
  aligns, is consistent with that existing precedent, not a new risk.
- **A panel *itself* in the aligned/distributed selection still needs its
  label carried along**, reusing Round 21's
  `snapshotPanelAbsolutePositions`/`syncPanelLabelsFromSnapshot` exactly as
  `resizeGroup` already does. **The first implementation had this
  backwards** — it captured the "before" panel-position snapshot *after*
  the frames had already been mutated, so `syncPanelLabelsFromSnapshot`'s
  own delta computed to zero on every call. The unit test for this
  behaviour passed anyway, because it happened to align two sample panels
  on an axis where they already shared a position — a geometric no-op that
  proved nothing. **Live-browser testing caught what the test missed**: a
  panel's letter visibly stayed behind while its panel moved. Both the
  operation (snapshot moved to before the mutation loop) and the test
  (switched to a mode that actually moves the panel, with an explicit
  assertion that it did) were fixed together — the standing "green tests
  do not mean the app runs" rule earning its keep once more, and a reminder
  that a passing test on a no-op input is not evidence of anything.
- **Toolbar wiring is one `<select>`**, following the existing
  command-style dropdown pattern (reset to its placeholder after firing,
  rather than bound to a persistent document field) rather than a row of
  buttons — this app has no icon system, and a `<select>` matches how the
  layout-template picker already presents a many-option choice as text.
  `runAlign`/`runDistribute` each follow `applyPreset`/`arrange`'s own
  two-commit-in-one-transaction shape: align or distribute the frames, then
  `reflowBrackets`, in one undo step — so a bracket on an aligned panel's
  plot is never left stranded. The dropdown (and, independently, each
  Distribute option) is disabled with a `title` explaining why, matching
  the Group/Ungroup buttons' own existing convention. Rotated leaf nodes
  align by their plain, unrotated frame, the same way `snapFrame`/
  `resizePanel` already ignore rotation, rather than inventing new rotated
  bounding-box math with no precedent anywhere else in this codebase.

Driven in a real browser, light **and** dark: selecting two sample panels
and choosing "Left edges" moved the right-hand panel's x to exactly match
the left one's, with its own panel letter shifting by the identical delta
its panel did; one Ctrl+Z reverted both in a single step; Distribute was
disabled with only two selected and enabled once a duplicated third panel
brought the count to three, after which "Distribute horizontally" spread
all three with equal gaps; and a bracket added by running a statistical
test on a panel was still present, correctly positioned, after that
panel's neighbours were distributed around it — confirming the
`reflowBrackets` wiring rather than assuming it. No console errors in
either theme.

**Verified:** 904 TypeScript tests (898 + 6 new: cross-parent alignment,
panel-label sync — the case that caught the ordering bug above — a locked
node skipped from both the bounding box and the move, brackets/scale-bars
skipped, a container-plus-its-own-descendant selected together not
double-moving, and distribute's three-minimum), 190 Python tests unchanged
(nothing here touches `services/api`), `tsc --build --force` and
`eslint .` clean, 46-check acceptance run unaffected (no existing fixture
selects multiple nodes for alignment).

### Round 27 — arrows and lines that were diagonal by default, not by choice

Reported: inserting an arrow or a line drops it in diagonally inside its
rectangular resize box, making it hard to end up with a clean horizontal or
vertical line. Two independent causes, one per entry point — an `arrow`
and a `shape: 'line'` are different node types with no shared geometry, so
each needed its own fix.

- **An arrow's diagonal default was a deliberate choice, not a bug** — the
  comment above `addArrow`'s fallback points said so ("Up and to the right:
  an arrow's default job is to point at a feature"). Asked directly, the
  user chose to change it anyway: the fallback (used whenever a caller
  doesn't pass explicit points, which `Toolbar.tsx`'s `insertArrow()` never
  does) now runs through the frame's vertical centre —
  `[{x:0,y:height/2},{x:width,y:height/2}]` — instead of corner to corner.
  The frame itself stays the real 20×12 mm `insertFrame` box rather than
  collapsing to match: because both fallback points share one `y`, the
  ordinary box-resize path (`rescaleArrowPoints`, which scales `points`
  proportionally with the frame) can only ever scale that shared `y` by one
  factor for both points, so a freshly-inserted arrow stays perfectly
  horizontal through an ordinary corner/edge drag, with no Shift needed —
  and keeping a non-degenerate frame means its 8 resize handles stay well
  separated and easy to grab immediately, rather than collapsing onto each
  other. Reaching any other heading is unchanged and was already correct:
  Shift-drag an endpoint grip calls `snapAngle` (45° steps,
  distance-preserving, measured from the other endpoint) — that mechanism
  was never the defect, only the starting point was.
- **A `shape: 'line'` has no `points` at all — `renderShape` draws it
  corner-to-corner of its own `frame`, so its angle *is* its frame's aspect
  ratio**, and it has no endpoint grips to extend the way an arrow does
  (confirmed against `renderSelection`: nothing special-cases it, it gets
  only the ordinary 8 rectangular resize handles). Two compounding gaps,
  both closed:
  - It defaulted to the same non-square `insertFrame(20, 14)` every shape
    uses. `Toolbar.tsx`'s `insertShape` now gives `'line'` its own default —
    `insertFrame(20, 0)` — so it starts flat. `RectMm.height` is already
    schema-validated as `nonnegative()`, not `positive()`, so `0` needed no
    schema change.
  - Resizing it via the box handles went through the fully generic path in
    `Canvas.tsx`, where Shift has always meant "lock to a square" — correct
    for a rect/ellipse/panel/image, but for a line this forced exactly 45°
    with **no way at all** to reach 0°/90° short of dragging a single edge
    handle to a sub-millimetre sliver by eye, a precision the generic 5 mm
    (`MIN_TILE_MM`) resize floor every node gets stopped it from reaching
    anyway. Asked directly, the user confirmed this should close: Shift on
    a line shape now snaps its angle instead of forcing a square.
    `ResizeOptions` gained `angleSnap?: boolean` (`layout.ts`); inside
    `resizeFrame`, it reuses `snapAngle` on `(width, height)` treated as a
    point relative to the origin — `atan2(height, width)` is always in
    `[0°, 90°]` since both are non-negative, so rounding to the nearest 45°
    step can only land on 0°, 45° or 90°, exactly the three angles a
    corner-to-corner line can express. `geometry.ts` imports nothing
    itself, so `layout.ts` importing `snapAngle` from it added no cycle.
    `Canvas.tsx`'s box-resize branch detects `primary.type === 'shape' &&
    primary.shape === 'line'` and passes `angleSnap` in place of forcing
    `aspectLock: 1` for that one case only — every other node type's
    Shift-resize is byte-identical to before this round.
  - **A snapped 0°/90° result is a deliberate zero, not a degenerate one,
    and needed its own floor treatment.** The generic 5 mm floor exists so
    a *filled* shape/panel never loses a grabbable handle in both
    directions at once; that doesn't apply to a line snapped flat, since
    the other axis is still a full-length line, still easy to grab by its
    `w`/`e` (or `n`/`s`) handles. So `resizeFrame`'s floor-clamp step skips
    the collapsed axis entirely under `angleSnap` rather than pulling it
    back up to 5 mm, which would have silently defeated the whole point of
    snapping to exactly flat. One floating-point trap found while writing
    this: `Math.cos(Math.PI / 2)` is `~6e-17`, not exactly `0` — without
    flattening anything under `1e-6` to a literal zero first, the 90° case
    would never actually reach the exact zero the floor-skip depends on,
    and would instead clamp right back up to 5 mm every time.
  - Arrows' own box-resize path (`rescaleArrowPoints`) is untouched — an
    arrow already has a correct, more precise angle-snap mechanism via its
    endpoint grips, and changing box-resize behaviour for it wasn't asked
    for or needed.
- **A test-writing trap, caught before it shipped a false confidence: a
  chained sequence of Shift-drags on one line shape does not test what it
  looks like it tests.** The first live-verification script dragged one
  line shape's `se` handle near-horizontal, then near-vertical, then to
  45°, reusing the same shape across all three. The second drag's raw
  angle depends on the *frame the first drag left behind*, not the
  original flat insert — so a modest "near-vertical" delta applied to an
  already-widened frame landed on 45° instead of 90°, which read as a
  snapping bug until the actual cause (compounding state across drags, not
  the angle-snap math) was traced by hand. Fixed in the test, not the
  implementation, by deleting and re-inserting a fresh flat line before
  each directional case — the standing "green tests do not mean the app
  runs" rule cutting the other way this time: a *live* script can just as
  easily give a false negative as a unit suite can give a false positive,
  and both need the same "verify the premise before trusting the result"
  discipline.

Driven in a real browser, light **and** dark, 22 checks each: a freshly
inserted arrow's two endpoint handles read the same y (flat, not diagonal);
Shift-dragging one endpoint through a large, deliberately unambiguous
vertical screen delta landed both handles on the same x; a freshly inserted
line shape's `n`/`s` resize handles coincided (flat); Shift-dragging its
`se` handle near-horizontal, near-vertical and evenly in both axes read
back as flat, upright and square respectively off the resize handles'
own rendered coordinates; a non-Shift drag on the same line shape stayed
unsnapped at a deliberately odd angle; and Shift-resizing an ordinary
rectangle still locked to a literal square, confirming the line-shape
branch didn't leak into any other node type. No console errors in either
theme.

**Verified:** 906 TypeScript tests (904 + 2 new: `resizeFrame`'s
`angleSnap` branch — flat/upright/square/floor-skip/regression cases in one
test — and `addArrow`'s horizontal fallback, plus a fix to an existing test
that had unknowingly relied on the old diagonal default being frame-tight),
190 Python tests unchanged (nothing here touches `services/api`), `tsc
--build --force` and `eslint .` clean, 46-check acceptance run unaffected
(no existing fixture inserts or resizes an arrow or a line shape).

---

### Round 28 — a colour swatch beside every hex code a Quality finding names

Reported: under Quality, an alert like "`#4575b4` and `#0072b2` are hard to
tell apart under protanopia" gives the hex codes but not the colours — add a
small block of the actual colour next to each code.

- **The swatch is drawn in the UI from the string the finding already
  quotes, not from a new structured field.** `withColorSwatches(text)` in
  `apps/web/src/components/SidePanel.tsx` splits a finding's `title`/`detail`
  on a captured `#rrggbb`/`#rgb` regex and, after each code, emits a
  `<span class="color-chip" style={{ background: hex }}>`. `checkFigure`
  read that hex off the rendered scene (`node.attrs.fill`), so the swatch
  cannot disagree with the figure, and every present *and future* finding
  that names a colour gets swatches for free — no `quality.ts` coupling to
  the UI, no model change, no `Finding` field. `.color-chip` (a 0.85 em
  bordered inline block, `var(--border)` so it reads in both themes) is a
  new class, not the Inspector's flex `.swatch` label control.
- **`checkColorAccessibility`'s `grayscale-conflict` and
  `checkHeatmapColorContrast`'s `heatmap-cvd-*` were reworded to name their
  colours**, since neither did — the swatch helper needs a code in the text
  to attach to. Greyscale now reads "`#…` and `#…` merge when printed in
  greyscale" and **also gained `nodeIds`** (populated from `plotsByColor`
  exactly as the CVD finding already did), so its "Select N affected" button
  now appears. Two latent inconsistencies fell out in the same edit: the
  greyscale detail had quoted `conflicts[0]!.deltaE` — the closest pair
  under *any* simulation — while saying "in greyscale"; it now uses the
  worst *greyscale* pair. And the heatmap finding's `strips[0]`/`strips[-1]`
  are the ramp's two ends in *DOM* order, which a right-placed colourbar
  draws low-at-the-bottom (reversed) — so the text says "the scale's two
  ends (`#…` and `#…`)" rather than mislabelling which is low and which is
  high.
- **The dead `const worst = conflicts[0]!` in `checkColorAccessibility`**
  (its only remaining use was the greyscale detail) was removed.

Driven in a real browser, light **and** dark: the Expression panel's series
were recoloured through the Inspector into a CVD-colliding pair, and the
Quality tab's resulting finding drew two `.color-chip` spans whose
`background-color`, read back off the DOM, was exactly the two hex codes in
the finding text (`rgb(214,39,40)` / `rgb(215,48,39)`), 9.3 px square,
identical between themes, no console errors.

**Verified:** 909 TypeScript tests (906 + 3 new in `quality.test.ts`: a CVD
conflict names both colours and the condition, a greyscale conflict names
both colours and carries `nodeIds`, and a colour-safe palette stays silent;
plus two assertions added to the existing heatmap-contrast test that the
ramp ends are now named), 190 Python tests unchanged (nothing here touches
`services/api`), `tsc --build --force` and `eslint .` clean, 46-check
acceptance run unaffected (no fixture triggers a colour finding).

**Not done, deliberately (at the time):** the two identical `conflicts[0]`
warning lines in `Inspector.tsx` (the volcano-colours block and the palette
block) print the same hex codes and would benefit from the same treatment,
but the request named the Quality tab specifically and `withColorSwatches`
operates on a string where those render `{colorA}` / `{colorB}` as separate
JSX — a shared `<ColorChip>` component would be the clean way in if that is
wanted. **Done in round 30**, below.

### Round 29 — a reversible legend order, and trimmed cascade front axes

Two things reported from real use of multi-series line / cascade (offset)
line plots. Neither bumps `SCHEMA_VERSION` — one new optional field, absent ⇒
prior behaviour for every non-cascade figure.

- **The legend read opposite to the cascade.** A cascade paints
  back-to-front, so for a positive `offsetStepMm` the last series sits
  visually at the top of the stack and the depth axis runs the same way —
  but `legendEntries` always listed `geometry.series` in plain order, so the
  legend's top entry was the *bottom* trace.
  - **`PlotNode.reverseLegend?: boolean`** — absent means "reversed on a
    cascade, plain otherwise", the exact cascade-aware default
    `gridlineStyle ?? (cascading ? 'dashed' : 'solid')` already uses. An
    explicit value wins either way. Continuous (line/scatter) plots only — a
    categorical legend keys on the second factor, not series order.
  - **`orderedLegendEntries(node, geometry)`** in `render-document.ts` is the
    one place the order is decided, read by `renderLegend` *and* by
    `requiredMargin`'s bottom-legend row reservation (line wrapping is
    order-sensitive, so a second ordering there would reserve a different row
    count than it drew). It returns each entry tagged with its **series
    index**, because `renderLegend` looks the swatch's shape / line style up
    by series order, not row position — reverse the array without carrying
    that index and the top row draws series 0's symbol beside series N's
    name. A real-browser check confirmed a reversed key's dash patterns stay
    attached to their own series.
  - **Inspector:** a "Reverse legend order" checkbox beside the Legend
    `<select>`, shown for a multi-series line plot,
    `checked={node.reverseLegend ?? hasCascadeOffset(node, series.length)}`,
    always storing an explicit boolean. Scatter is deliberately out of scope
    (trivial to widen).

- **The cascade front axes overshot the front-most trace.** `renderAxes`
  drew the front L-axis across the whole canvas while `renderCascadeBackAxes`
  spanned only the back plane's window, so the two were different lengths and
  did not read as the parallel edges of the oblique box.
  - **`renderAxes` computes `cascadeFront`** (`= cascadeBackOffsetMm(series)`
    when `hasCascadeOffset`, else `null`) — the front→back vector. The back
    plane is the front plane translated by it, so the front plane window is
    `{left: 0, top: -cascadeFront.y, right: plotWidth - cascadeFront.x,
    bottom: plotHeight}`. The front y-axis line's non-`trimToData` top
    becomes `-cascadeFront.y`; the front x-axis line's right end becomes
    `plotWidth - cascadeFront.x`. Front ticks/labels need no change — they
    already sit at scale positions inside the (offset-shrunk) ranges.
    Trimmed **on every cascade offset**, not gated on `showGridlines`.
  - **`renderBoxedBorder`** now takes an explicit `box: {left, top, right,
    bottom}` rectangle (default `{0, 0, plotWidth, plotHeight}` — today's
    formula exactly, so non-cascade `boxed` figures are byte-identical). On a
    cascade `renderAxes` passes the **rear-plane** rect, so `boxed` completes
    the far face of the oblique box (the same top/right edges it drew before
    round 29) while the trimmed front axes draw the near face's L. A first
    pass moved the box to the front plane; the user preferred it on the rear
    frame, which also keeps `boxed`'s output on an existing cascade figure
    unchanged.
  - `renderAxesHorizontal` passes no `box` argument (categorical plots never
    cascade), so that path is untouched.

Driven in a real browser, light **and** dark: a three-series own-x table
imported as a line plot; before any offset the legend read `Y1, Y2, Y3`;
setting `Offset per trace` to 12 mm auto-reversed it to `Y3, Y2, Y1` and the
"Reverse legend order" checkbox showed checked; unchecking read `Y1, Y2, Y3`
and re-checking flipped back. The front y-axis line's `d` started at
`y = 24 mm` (the reserve, `= -cascadeFront.y`) rather than `0`, with a
segment length of `35 mm` exactly matching the projected rear y-axis's
`35 mm`; turning on `Boxed` drew the rear plane's top and right edges. No
console errors in either theme.

**Verified:** 918 TypeScript tests (909 + 9 new across
`continuous-axis.test.ts`, `gridlines.test.ts`, `doc-model.test.ts` and
`parity.test.tsx` — see the list in the verification note near the top),
190 Python tests unchanged (nothing here touches `services/api`), `tsc
--build --force` and `eslint .` clean, 46-check acceptance run unaffected
(no existing fixture cascades a plot or sets a legend order).

**Not done, deliberately:** the y-axis title stays centred on the full plot
height rather than the trimmed front-axis midpoint (the rear axes carry no
title to disagree with, and the offset is small); scatter plots are not
offered the reverse-legend toggle; a cascade with `showGridlines` off still
gets its front axes trimmed even though no rear axes are drawn to visually
match — the user chose "on every cascade offset" so the front axes always
bound the front-most trace's plane.

### Round 30 — the same colour swatch, now on the Inspector's own warnings

Requested as a direct follow-up to round 28: the swatch landed in the
Quality tab but not the Inspector, where the identical warning text already
appears in two places.

- **`apps/web/src/components/ColorChip.tsx`** is the shared component round
  28's own "Not done" note called for — `<ColorChip hex={hex} />`, exactly
  the `<span className="color-chip" style={{background: hex}}>` both call
  sites already needed, reusing `.color-chip` from `styles.css` with no new
  CSS. `withColorSwatches` in `SidePanel.tsx` now renders it too, in place of
  its own inline `<span>` — one implementation instead of two that could
  drift, the same discipline `scaleBarWidthMm`/`analysisInputHash` are held
  to elsewhere in this codebase.
- **`ColorConflictWarning({ conflict })` in `Inspector.tsx`** replaces both
  byte-identical `<p className="warning">` blocks (the volcano-colours block
  and the per-series palette block) with one component, chip placed *after*
  each hex code to match the Quality tab's own convention. Neither call site
  needed any other change — both already had a `ColorConflict` in scope from
  their own `findColorConflicts` call.
- **No model or `quality.ts` change.** `findColorConflicts` itself is
  untouched and already covered by `palettes.test.ts`; this round is pure
  presentation over an existing, already-correct computation.

Driven in a real browser, light **and** dark: a freshly imported two-series
line plot's palette block, recoloured into round 28's own known-colliding
pair (`#d62728`/`#d73027`), drew the warning with two `.color-chip` spans
reading `rgb(214,39,40)`/`rgb(215,48,39)` off the DOM — and, separately, the
sample document's volcano panel (b), with only its "Down" swatch changed to
`#d62728` against the theme's own default "Up" colour (already `#d73027`),
produced the identical warning and chips in its own Colours block. No
console errors in either theme.

### Round 31 — group titles for image panels, with adaptive spacing

Requested: a way to caption a single image or head a row/column of several,
matching the row/column-heading convention common in published multi-panel
figures (the reference was a Nature Scientific Reports paper, unreachable
behind a login wall — the convention itself is standard and needed no more
than that to build against). Scoped up front via direct questions rather
than guessed: titles apply at both a group-heading and a per-image-caption
granularity through **one mechanism** (a caption is a group of one member);
a group can span images inside one montage panel **or** independent panels
on the page; a heading draws a rule as well as text; and this round also
adds per-cell image upload/replace on an existing montage panel. A
Plan-agent review before any code was written surfaced the one real hazard:
this codebase has a standing, explicit contract that **auto-layout** (a
from-scratch grid recompute) may translate frames, while **manual layout**
(drag, resize, align, distribute) must leave them alone except for
snapping. A naive "grow the gap for a new heading by pushing every panel
after it" would have violated that contract every time it ran after a drag.
The design below is built around keeping the two apart.

- **One new node type, `GroupLabelNode`** (`packages/doc-model/src/nodes.ts`) —
  top-level, absolute-page-space, the same family as `PanelLabelNode`/
  `BracketNode`: `memberIds` (panel or image ids; length 1 is a caption),
  `edge` (`'top' | 'left' | 'right'`), `title`, an optional `richText`
  sibling array (the same shape `AxisSpec.title`/`richText` already use),
  `showRule`, `stroke`, `style`, and `userOffsetMm` (the same "auto base +
  stored delta" shape `BracketNode.userOffsetMm` already uses). Added to
  `DERIVED_NODE_TYPES` — a heading describes its members rather than
  standing on its own, the same reasoning `bracket`/`panel-label`/
  `scale-bar` are already held to, so it is refused as a standalone
  duplicate. No `SCHEMA_VERSION` bump: a new node `type` variant is the
  same bump-free precedent those three already are.
- **Two mechanisms, not one — the load-bearing split the Plan-agent review
  produced.** `reflowGroupLabels` (`operations.ts`) only ever recomputes a
  `GroupLabelNode`'s own frame from the current union of its members'
  absolute frames (`groupLabelFrame`, via the existing `union` primitive
  `bracketFrame` already uses) — it never touches any other node, so it is
  exactly as safe to call after *anything* as `reflowBrackets` already is,
  including a manual drag. `reserveSpaceForGroupLabels`, by contrast,
  measures whether the gap on the heading's own side of its members already
  covers `groupLabelClearanceMm`, and if not, translates every top-level
  panel at or beyond the heading's edge by the shortfall — genuinely
  rearranging the page, so it is called **only** from creating/editing a
  heading and from the handful of places that already run `applyAutoLayout`
  from scratch (import, delete, template apply, PCA/UMAP/volcano-test panel
  creation), never from a resize/move/align/distribute. A same-panel heading
  (every member sharing one montage panel's own grid) needs neither
  function's shortfall arithmetic at all: its clearance is folded directly
  into `gridCells`'s tiling as a per-boundary gutter extra (see below), which
  `fillPanelChildren` already re-derives on every resize, so it stays live
  for free with no separate reflow step.
- **`groupLabelClearanceMm`, in `doc-model` rather than `render`.** The
  planning session assumed this would need `text-width.ts` (hence `render`),
  mirroring why `reflowBrackets`'s own measuring half lives there — but a
  heading's reserved band only ever needs its own line height plus a rule
  and a small gap, never the *width* of its title (nothing here auto-wraps
  or truncates a heading the way a tick label does). Since only glyph
  *width* needs `text-width.ts`, this stayed a plain function of point size
  in `packages/doc-model/src/grouplabel.ts`, letting `fillPanelChildren`,
  `reflowGroupLabels` and `reserveSpaceForGroupLabels` all live in
  `doc-model` too, sharing one clearance formula with no cross-package call
  needed at all.
- **`gridCells` (`layout.ts`) gained `columnGutterExtraMm`/
  `rowGutterExtraMm`**, indexed by *boundary* rather than track — index 0 is
  *before* the first row/column, index `rows`/`columns` is *after* the
  last — so a heading over the very first or very last row/column still has
  a boundary to grow into, not only an internal gutter. Purely additive:
  absent, every existing caller (`autoLayout`, `spanCell`,
  `fillPanelChildren`'s own pre-existing calls) produces byte-identical
  frames, pinned by a regression test. **A widened boundary shrinks the
  *other* equal-weight tracks slightly to make room**, rather than growing
  the page — the same "two equal rows share what's left after the extra is
  taken out" arithmetic an unweighted `gridCells` already used, just with a
  bigger deduction; a first draft of the group-label test measured the new
  row against the *old, unwidened* layout's other row and got a puzzling
  half-sized gap until this was traced by hand and the test fixed to compare
  against the tiles' own new, correctly-shrunk positions.
- **`fillPanelChildren` (`operations.ts`) is now exported** (Stage 2 needs
  it directly) and, before tiling, scans for any `GroupLabelNode` whose
  members are *all* children of the panel being tiled, converts its members'
  z-order indices into the row/column they occupy, and folds
  `groupLabelClearanceMm` into the matching `gridCells` boundary. Every
  existing figure with no group-label passes an all-zero extras array,
  which is why this needed no regression fixture of its own beyond the
  existing "byte-identical without a grid" test.
- **`reserveSpaceForGroupLabels`** measures the gap between a heading's
  members and whatever top-level panel sits on the near side (the side the
  heading actually draws into — behind the members for `'top'`/`'left'`,
  ahead of them for `'right'`, which the same boundary-coordinate comparison
  handles uniformly without a per-edge branch), and if short, translates
  every panel at or beyond that boundary by the shortfall — reusing round
  26's own `snapshotPanelAbsolutePositions`/`syncPanelLabelsFromSnapshot` so
  a pushed panel's own letter follows it, exactly as an align/distribute
  already does.
- **Cascading delete and duplicate mirror `bracket`/`panel-label`'s existing
  rules, extended rather than reinvented.** `deleteNode`'s fixed-point sweep
  drops a group-label the instant *any one* of its members is doomed — a
  heading over a partial row it no longer fully spans misdescribes what
  remains, which is worse than none at all. `duplicateNode`'s cascade
  **only** copies a group-label when *every* one of its members is already
  in the set being copied (a judgement call made during planning, mirroring
  a bracket's own single-reference rule generalised to a list): duplicating
  one panel out of a three-panel heading leaves the duplicate uncaptioned
  rather than either silently joining the original heading or refusing the
  duplicate outright. A group-label's own `memberIds` are remapped to the
  copies exactly as a bracket's `plotId` already is.
- **Render** (`packages/render/src/render-document.ts`, `scene.ts`): new
  `SceneRole`s `'group-label'` and `'group-label-rule'`, kept distinct from
  `'panel-label'`/`'text'`/`'line'` for the standing reason a role-count
  assertion for any of those must not be silently widened. `renderGroupLabel`
  draws a `'top'` heading the ordinary way (title over a horizontal rule,
  reusing `multilineTitleNode`/`richRunTspans` — the exact machinery an axis
  title's own rich text already draws through, so a heading gets rich
  formatting for free) and a `'left'`/`'right'` one through the identical
  `rotate(-90)` convention the y/y2 axis titles already use, so a column
  heading reads bottom-to-top the same way an axis title beside a plot does.
- **Creation and editing reuse existing UI, not new selection machinery.**
  "Add group title" in `Toolbar.tsx` is enabled the moment one or more
  panels/images are selected — round 26's own shift-click multi-select,
  unchanged — and decides which of the two mechanisms to run by checking
  whether every selected member shares one montage-panel parent. Selecting
  the created label shows `GroupLabelFields` in `Inspector.tsx`: title
  (through the same `useRichTextToggle`/`FormatToggleRow` pipeline
  `TextFields` already uses), a position `<select>`, a rule toggle, and
  stroke colour/width — every write re-derives the same reserve/reflow pair
  the toolbar action runs at creation, since editing a heading's size or
  edge changes how much room it needs exactly as creating one does.
- **Stage 2 — per-cell montage image upload/replace needs no new
  placeholder concept.** `fillPanelChildren` already tolerates a
  `contentGrid` with more cells than children (the extras stay unused,
  invisible) — an empty cell was already representable, so this only needed
  new operations and UI. `addEmptyMontagePanel` is a thin sibling of
  `addPanelWithImages` with zero children. `setMontageCellImage` retargets a
  filled cell **in place** — overwriting the existing `ImageNode`'s
  `assetId`/`naturalPx`/`crop` rather than deleting it and inserting a fresh
  one — because a scale bar's `parentId` and a group-label's `memberIds` may
  already point at that node's id; the first draft deleted and recreated the
  node, which silently orphaned any scale bar calibrated to that tile, and a
  live-then-caught unit test (`scaleBarWidthMm` returning `null` after a
  replace) is what found it before it reached a live check. An empty cell,
  addressed by its z-order index, still needs an explicit z-insert/renumber
  so the new tile lands in the cell whose button was clicked rather than
  always the last one; because cells are strictly z-ordered with no way to
  leave a gap mid-sequence, an index beyond the current child count always
  fills the *next* empty slot regardless of which still-empty cell's button
  was clicked — documented as the real, load-bearing constraint it is,
  rather than a bug, since every empty cell looks identical anyway.
  `PanelFields` (`Inspector.tsx`) shows one button per declared cell
  ("Upload to cell N" / "Replace cell N (name)"), wired to a single hidden
  file input reusing `importImage`/`ACCEPTED_IMAGE_TYPES` — the same decode
  step `SidePanel.tsx`'s own bulk import already uses — and a small
  `Toolbar.tsx` entry point ("Add empty montage…", four size presets) is the
  minimum needed to reach a starting empty grid at all.
- **Deliberately deferred, named so it is not mistaken for an oversight:**
  a from-scratch "design the whole grid, then drag images into slots"
  screen — a materially different, layout-first UI paradigm than "create an
  empty montage, then fill named cells one at a time," which is what this
  round actually builds.

Driven in a real browser, light **and** dark, **17 checks each**: selecting
two sample panels and clicking "Add group title" drew exactly one heading
and one rule reading "Group title"; editing the title in the Inspector
updated the canvas live; switching position to "Left" produced a
`rotate(-90)` transform on the drawn title; deleting one of the two member
panels dropped the whole heading, and one undo restored panel and heading
together; adding an empty 2×2 montage from the toolbar offered four "Upload
to cell N" buttons, uploading a PNG into cell 1 relabelled it "Replace cell
1 (…)" and drew an image tile, and captioning that one tile added a second,
independent heading; and a PDF export taken with a heading present returned
`HTTP 200`, `content-type: application/pdf` and a real 70,253-byte body
(read off the response's own `Content-Length`), with zero console errors
across the whole run in either theme. One click-selection strategy failed
silently before the checks above were written and had to be replaced:
clicking the geometric centre of a sparse `dot`/`scatter` panel's bounding
box routinely lands on empty space between marks, and `elementFromPoint`
there resolves to the page background rather than any panel content —
confirmed directly before assuming otherwise — so every check instead
clicks an actual drawn mark (a bar, point, box, violin or line) inside the
target panel, which is unambiguous for any plot type.

### Round 32 — four bugs in round 31's montage and group-label surface

Reported from real use of round 31: a montage could not be selected by
clicking it; an empty montage showed nothing at all where its panes would go;
uploaded images floated in the middle of their cells rather than lining up
along the top, with no alignment control, and no way to put a label over one
pane under a heading spanning the row; and a heading's rule sat too close to
the pictures below it. One new optional field per node type, so
`SCHEMA_VERSION` stays 1.

- **A montage could not be selected because it draws nothing of its own.**
  Round 20 deliberately made a plain click on a montage tile resolve straight
  to that tile (`isPureMontagePanel`/`selectionTarget`, `Canvas.tsx`) rather
  than to the panel — correct, and not the defect. The defect is that a panel
  with no background and no border paints no pixels outside its tiles, so its
  gutters, its padding and its empty cells had nothing for a click to land
  on; `elementFromPoint` there resolves to the page background. An **empty**
  montage was therefore entirely unclickable, which is the state round 31's
  own "Add empty montage…" drops an author into.
  - **`montageChrome` (`render-document.ts`) draws a transparent rect over
    the panel's whole frame**, `fill: 'transparent'` rather than `'none'` —
    only a *painted* fill receives pointer events, and `none` would have left
    the panel exactly as unclickable as it was. It carries no `nodeId`, so
    the event bubbles to the wrapper `<g>` `renderNode` already puts the
    panel's id on and `selectionTarget` resolves it the ordinary way, with no
    special case.
  - **Gated on `options.chrome`**, which the export path never passes — so
    this is invisible to the exporter, to `checkFigure`, and to every parity
    assertion, all of which render chrome-free. New `SceneRole`s
    `'montage-hit-area'` and `'montage-cell-placeholder'`, kept distinct for
    the standing reason and deliberately **not** added to `quality.ts`'s
    `MARK_ROLES` — chrome, not data-ink, the same standing `'gridline'`
    already has.
  - **Escape from a tile selects the montage**, because on a tightly packed
    montage the gap between tiles is a millimetre wide and a keyboard route
    is what makes the panel *reliably* reachable. Selecting the parent rather
    than merely deselecting is the useful half: the panel's Inspector is
    where rows, columns, gutter and per-cell upload live. It is checked after
    the existing `enteredId` branch, so stepping out of a container still
    wins.
  - **The "spacing between panes should be adjustable" half of the report
    needed no code at all** — `PanelFields` has had a Gutter field since
    round 31. It was unreachable because the panel carrying it could not be
    selected, which is the same bug.

- **Empty cells now show where their panes will go.** `montageCellRects` is
  extracted out of `fillPanelChildren` (`operations.ts`) and exported, so the
  dashed outline the renderer draws and the frame the tile will actually take
  are **one derivation read twice** — deriving them separately in `render` is
  precisely how round 6's crop bug happened, an outline promising a region
  the drawing did not keep. A test asserts cell-for-cell equality between the
  two. `montageTiles` is extracted alongside it as the one place the z-order
  cell addressing is decided, shared by the tiler, `setMontageCellImage` and
  the placeholders.

- **A latent round-31 bug the placeholders exposed immediately.**
  `fillPanelChildren` bailed out of its grid at `children.length <= 1` and
  gave the lone child the whole panel. That was harmless while a
  `contentGrid` could only ever be created alongside two or more images —
  but filling an empty montage a cell at a time walks straight through the
  state it got wrong, so the *first* tile uploaded stretched across the whole
  panel and then snapped back into cell 1 the moment a second arrived. The
  count is no longer part of that test: a declared grid is a declared grid at
  any occupancy. Found because the placeholder for cell 2 was drawn under a
  tile that had spread over it — the new chrome earning its keep on its first
  run. `isPureMontagePanel` was widened to one tile in the same pass (a tile
  directly clickable at two tiles and not at one is the kind of inconsistency
  an author reads as a bug), which is only safe *because* the panel now has a
  hit target of its own: reaching the panel no longer depends on that
  predicate returning false.

- **Images sit where they are told to inside their cell.** A tile's frame
  comes from `gridCells` and has nothing to do with the micrograph's own
  shape, so an aspect-preserved image genuinely has spare room in its cell,
  and it was being centred — leaving a row of differently-proportioned
  micrographs each floating at its own height.
  - **`ImageNode.alignX`/`alignY`**, both optional; absent is `'middle'` on
    both axes, exactly the centring every image had before, so no saved
    figure moves. A tile uploaded into a montage is written `alignY: 'start'`
    explicitly (`addPanelWithImages` for a real montage, `setMontageCellImage`
    for a new tile) — a *replacement* keeps whatever alignment the author had
    already chosen, since that belongs to the cell they arranged rather than
    to the file that sits in it.
  - **`fitAspectAligned` (`geometry.ts`) is the one implementation**, with
    `fitAspect` now a two-argument wrapper on it, so the centred behaviour is
    the same code rather than a parallel copy. It is read by `renderImage`'s
    *cropped* path and by `Canvas.tsx`'s crop overlay; the *uncropped* path
    hands the job to SVG through `preserveAspectAlign`, whose tokens
    (`xMinYMin`…`xMaxYMax`) is why `FitAlign`'s members are named
    `start`/`middle`/`end` — the mapping is a lookup with no judgement in it.
    The crop overlay had to move with it or a top-aligned tile would outline
    its crop window somewhere other than where the picture is drawn: round
    6's bug again, in a new place.
  - The Inspector's two selects are shown **only while `preserveAspect` is
    on**. A stretched image fills its frame exactly, so there is no spare
    space to place and the control would adjust nothing — the standing "a
    control that visibly does nothing is a defect" rule.

- **A label over one pane, sitting under the heading that spans the row.**
  This needed no new node type: a caption is already a `GroupLabelNode` with
  one member, and round 31 built that. What was missing is that two headings
  on the same line were drawn in the same millimetres, because
  `groupLabelGutterExtras` took the **max** of their clearances and
  `groupLabelFrame` placed both against the same edge.
  - **`groupLabelStackOffsetMm`/`groupLabelExtentMm`** are the rule: anything
    on the same edge, on the same line, overlapping this heading's span, and
    covering strictly *fewer* members takes the space nearer the content and
    pushes this one further out by its own clearance. The narrower heading is
    the inner one — a caption belongs against the pane it names, the heading
    spanning the row belongs above it. Labels covering the *same* number of
    members share one level, so three captions across three panes sit side by
    side rather than in a staircase, and a level costs the widest clearance
    among its members once.
  - **The direction was wrong in the first draft and a unit test caught it**:
    counting labels with *more* members pushed the caption above the heading
    instead of below. Written the other way round it read just as plausibly
    in prose, which is why the test asserts the two frames' actual order
    rather than only that they differ.
  - **`groupLabelExtentMm` is what both reservation paths now read** — the
    same-panel grid gutter and the cross-panel push — so the space a heading
    is *given* and the space it is *drawn in* cannot disagree. A row carrying
    both a spanning heading and a caption per pane grows by the **sum**, not
    the max.
  - A stored explicit "level" per heading was rejected: it is a second source
    of truth for something the member sets already say unambiguously, and it
    would go stale the moment a heading's members changed.
  - **`PanelFields` offers a "Label cell N" button per filled cell**, which
    calls the same `addGroupLabel` the Toolbar's own action does and then
    selects the new label so the placeholder title can be typed over
    immediately. The button disappears once that cell has a caption — two
    captions stacked over one pane is never wanted.

- **A heading's rule now clears what it labels.** `GROUP_LABEL_GAP_MM` is
  2.5 mm rather than 1.5: measured against the theme's own numbers, 1.5 mm
  left the rule about 1.7 mm clear of the picture's top edge, which reads as
  a border drawn *on* the image rather than a heading above it. Overridable
  per heading via **`GroupLabelNode.gapMm`** with an Inspector field, since
  how much air a heading needs depends on what sits under it.
  `clearanceForLabel` in `grouplabel.ts` is now the one place a node's four
  relevant fields become a clearance, so no call site can read three of them
  and quietly disagree with the others.

Driven in a real browser, light **and** dark, **46 checks each**, plus a
9-check export run — the numbers are in the verification note near the top of
this file. Two live-test traps worth recording: a click on the montage
panel's own corner is intercepted by the *currently selected* node's resize
grip, so the panel has to be selected through an empty cell instead; and the
heading created by "Add group title" is left selected, so re-selecting it by
clicking its own `<text>` is both unnecessary and unreliable — a text
element's bounding-box centre falls between glyphs as often as on one, the
same class of trap as clicking a sparse plot panel's centre in round 31.

**Not done, deliberately:** alignment is offered per image rather than as a
montage-wide default an author sets once — every tile takes `'start'` on
upload, which covers the reported case, and a panel-level default would be a
second place the same fact is stored. The dashed placeholders are not
clickable *as upload targets*; clicking one selects the panel, whose
Inspector then names every cell. Panel labels and bracket labels still get no
`gapMm`.

### Round 33 — montage typography, image-edge rules, overlay labels, auto-fit

Reported after using round 31/32's montages on real figures: pane labels came
out 8 pt bold with a rule under them; font sizes could not be made consistent
in one edit; the rule ran to the *cell* edge rather than the image's; nothing
sized a montage so its pictures filled their cells; and there was no way to put
a label on the image. Six published figures were supplied as guides. Read
against them the conventions are unambiguous and confirm every request: small
non-bold headings at the same size as the surrounding type, no rule, headings
tight against the picture, tiles filling their cells.

- **Every group-label default was wrong, and `addGroupLabel` was why.**
  `DEFAULT_GROUP_LABEL_PT` was 8 (a panel *letter*'s size) and
  `renderGroupLabel`'s base style was `fontWeight: 'bold'` — but changing both
  fixed nothing on its own, because **`addGroupLabel` wrote `showRule: true`
  and `fontWeight: 'bold'` onto every heading it created**, and an explicit
  value always beats a default. The stored values are now left absent so the
  defaults apply: 6 pt (`theme.type.annotationPt`, the size tick labels and
  annotations already use), non-bold, no rule. `stroke` is still stored so
  turning a rule on later has something sensible to draw with. A test asserts
  the *absence* of `showRule`/`fontWeight` rather than their values, since an
  explicit `false` would read identically today and reintroduce the bug the
  moment a default moved again.
- **The gap is rule-dependent, because the two cases genuinely differ.** Round
  32 raised `GROUP_LABEL_GAP_MM` to 2.5 mm on a report that a rule sat too
  close to a micrograph; this round reports the *opposite* — that the space is
  larger than it needs to be. Both are right about their own case: a rule needs
  room not to read as a border on the picture, while a bare 6 pt caption at
  2.5 mm is most of a line height of dead space. So `GROUP_LABEL_GAP_NO_RULE_MM`
  (1 mm) applies when there is no rule and 2.5 mm when there is,
  `GroupLabelNode.gapMm` overrides either, and both are read only through
  `clearanceForLabel` so no call site can pick the wrong one for its case.
- **A heading now measures the picture, not the cell — one change fixing two
  reports.** A tile's frame comes from `gridCells` and has nothing to do with
  the micrograph's shape, so an aspect-preserved picture letterboxes inside it
  and the frame is not where the ink is. `imageContentRect` is the one
  implementation of where the picture lands (`preserveAspect ?
  fitAspectAligned(frame, aspect × crop.w / crop.h, alignX, alignY) : frame`,
  one formula covering the cropped and uncropped cases alike), and
  `memberContentRect` lifts it into page space. `groupLabelBounds` reads it, so
  the rule stops at the image's edge *and* the heading stops floating a
  letterbox's worth too high. `renderImage`'s cropped branch calls
  `imageContentRect` too rather than repeating the fit — deriving it twice is
  how the drawing and the geometry would come to disagree, which is round 6's
  crop bug in a new place.
- **Overlay labels reserve nothing.** `GroupLabelNode.placement: 'overlay'`
  draws the title on the picture — the convention the csLFM and VSCyto figures
  use for channel names and timestamps — inset from its top-left, left-aligned,
  in `labelColor ?? white` with a dark stroke under the fill (`paint-order:
  stroke fill`) so it survives a pale patch. `clearanceForLabel` returns **0**
  for it, so it grows no grid gutter, triggers no `reserveSpaceForGroupLabels`
  push, and neither stacks nor is stacked against. The shadow is a stroke pair
  rather than an SVG filter: a filter needs a `<defs>` block and per-node
  unique ids, the same reasoning that kept the heatmap colourbar a strip of
  rects. Automatic contrast detection was considered and refused — reading the
  image's brightness needs pixel access `packages/render` must not have, and a
  value sampled once in the app would go stale the moment the crop changed.
- **A pane's label is edited from the pane.** `ImageFields` renders the very
  same `GroupLabelFields` the label's own Inspector shows whenever the selected
  image is the sole member of a group-label, with an "Add label" button when it
  has none — one editor, so the two cannot drift. `PanelFields` gained a
  **"Label size (pt)"** that writes to every label in the montage at once
  (each pane's caption *and* any heading spanning the panel) plus a readout
  naming the sizes currently in use, which is the requested single edit.
- **Auto-fit uses a lever that already existed.** `autoLayout` has always
  honoured `panel.aspectLock` (`fitAspect(inner, panel.aspectLock)`), and
  `addPanelWithImages` set it to `null` for the stated reason that
  differently-shaped micrographs have "no one honest ratio". They do have one:
  the ratio at which every cell matches the tiles' median aspect, so nothing
  letterboxes. `montageTileAspect` takes the **median**, not the mean — one
  panorama among square micrographs should not drag every cell wide.
  `montagePanelAspect` solves the panel shape in **closed form**: cell height
  cancels out of the ratio, so it terminates by construction rather than
  converging, the same argument the two-pass margin rule rests on.
  **That last claim was wrong and round 41 replaced the function** — cell height
  cancels only when `fixedWidth/fixedHeight == cols·tileAspect/rows`, so a
  captioned montage was locked to a ratio no frame of it ever had. See
  "Round 41"; the closed form is now `montageShape`/`heightForWidth`, which
  needs no probe height at all.
  `fitMontageToImages` sets the lock; `applyAutoLayout` then gives the panel the
  largest correctly-shaped rect in its page cell and `fillPanelChildren` fills
  every cell edge to edge. `contentGrid.autoFit` gates all of it and is absent
  — off — for every figure saved before this existed, so nothing already laid
  out by hand is reshaped on open. The Inspector's off switch clears
  `aspectLock` back to null, since leaving the lock would keep constraining the
  manual resize the author just asked for.
- **`suggestMontageGrid` refuses grids with holes, and needed a tie-break.**
  It picks rows × cols whose aspect best matches the page cell — wide images
  get fewer, wider columns — scoring in log space so "twice as wide" and "half
  as wide" are equally wrong. Two corrections came out of testing rather than
  reasoning: four images scored best as 2 × 3, a better *shape* with two empty
  cells, so grids leaving a wholly empty row or column are now excluded
  outright (an empty cell in a published montage is a hole in the figure, not a
  saving); and four 2:1 tiles in a square cell scored *identically* as 4 × 1 and
  2 × 2 — equally far off in opposite directions — so the first tried won and a
  montage of wide images became a tall single column. A small balance term
  breaks that toward the squarer arrangement without ever outvoting the shape.
  `autoGridForMontage` runs only from `addPanelWithImages`, never from
  `setMontageCellImage`: a grid the author declared when making the montage is
  not silently rearranged the moment a picture lands in it.
- **A latent bug this exposed:** `fillPanelChildren` bailed out of its grid at
  one child, so the first tile uploaded into an empty montage stretched across
  the whole panel and snapped back into cell 1 when a second arrived. Harmless
  while a `contentGrid` could only be created alongside two or more images;
  filling a montage a cell at a time walks straight through it. Fixed in round
  32's follow-up work here — a declared grid is a declared grid at any
  occupancy.

Driven in a real browser, light **and** dark, **50 checks each**: a pane label
read back at exactly the same computed `font-size` as a tick label (2.1167 px
at 100%), `font-weight` 400, and no rule drawn; turning a rule on for a 1:3
picture in a square cell drew it **70.2 px** wide against a ~68 px picture in a
**163.4 px** cell — at the image's edge, not the cell's — and centred on it;
switching a label to overlay moved the tile by 0 mm (against the 22.9 px an
outside caption pushes it) and drew it inside the picture in white; selecting a
pane offered "Add label" and then its full size/placement/colour controls; one
"Label size" edit made every label in the montage the same size; and auto-fit
was on for a new montage with all four tiles drawn at equal, non-zero area.
Plus a **10-check reference rebuild**: a 1 × 3 montage captioned A549 /
BJ-5ta / HEK293T under a spanning "Virtual stain" heading laid out exactly as
the published panel does — heading above all three pane labels, the three
sharing one baseline, tiles aligned along their tops, no rules anywhere — and
exported to a 75,473-byte PDF with no console errors. The screenshot was
inspected by eye, not only by attribute: reading the numbers back proves the
fields are set, not that the figure looks right.

**Two live-test traps, both costing a run before being understood.** A click on
the montage panel's own corner is intercepted by whatever is currently
selected — its resize grip sits exactly there — so the panel has to be reached
by clicking a tile and pressing Escape, which is the keyboard route round 32
added for precisely this reason. And the first version of the rule-width check
labelled a *square* picture in a square cell, where the picture and the cell
have the same width and the assertion could not fail; it was rewritten around a
1:3 picture, where the two differ by more than a factor of two.

**Not done, deliberately:** reallocating page area *between* panels (slot
spans, row weights). A montage claims the largest correctly-shaped rect inside
the cell auto-layout gives it and re-chooses its grid to suit that cell, which
is the honest version of "use the page space well"; taking area from a
neighbouring panel is a different mechanism with its own staleness rules. There
is no automatic light/dark contrast detection for overlay labels, for the
reason given above. `autoFit` is not turned on retroactively for existing
figures.

### Round 34 — group titles couldn't be edited by double-clicking them

Reported: panel labels and group titles should both be editable directly by
clicking on them. Investigation found panel labels already fully worked —
single click selects, double-click opens an inline editor, matching the
app-wide convention used everywhere else in FigureForge. Confirmed with the
user before changing anything: keep that convention (click selects,
double-click edits) rather than introduce single-click-to-edit just for these
two node types. What was actually broken is narrower: double-clicking a
group title (`GroupLabelNode`, added in round 31) opened **nothing at all**.

- **A dead code path, not a missing feature.** The renderer already stamps
  every group-label heading's `<text>` element with
  `data-edit-target="title"` — the identical DOM hook axis titles use to open
  their own canvas editor (`packages/render/src/render-document.ts:677, 695,
  726`, all three of `renderGroupLabel`'s layouts: top, left/right, and the
  overlay placement). But `Canvas.tsx`'s `EDIT_TARGETS` allow-list only ever
  recognized `'x.title' | 'y.title' | 'y2.title' | 'cascadeAxisTitle'` — never
  the literal `'title'` string the renderer emits for a group-label — so the
  double-click handler's `data-edit-target` branch's guard failed, and the
  click fell through every other branch: a group-label isn't a container type
  (nothing to step into) and isn't in the own-string-edit type check either
  (that branch only reads `text`/`panel-label`/`bracket`). The function
  returned having opened no editor. The renderer's half of this had been
  correct since round 31; only the canvas side needed wiring.
- **`EDIT_TARGETS` gained `'title'`, and `readEditTarget` reads it off a
  `group-label` node's own `title`** rather than assuming every recognized
  target lives on a `plot`. No change was needed to the branch that measures
  and positions the editor — it already uses
  `titleEl.getBoundingClientRect()` rather than `absoluteFrame`, which is
  exactly what a group-label needs: `edge: 'left'`/`'right'` headings render
  with a `rotate(-90)` transform, and `absoluteFrame` ignores rotation
  entirely (the same reason rotation itself is restricted to leaf annotation
  types). Using the DOM-measured rect is what makes the rotated case correct
  for free.
- **`commitTextEdit` gained a `'title'` branch, ahead of the axis-title one**,
  writing to the group-label's own `title`/`richText` — reconciled through
  `reconcileTextEdit`/`plainTextOfRuns` exactly the way the `TextNode` branch
  a few lines below already does, so a canvas-side edit can't silently
  discard formatting applied through the Inspector's `GroupLabelFields`
  toolbar. This is deliberately **more careful** than the precedent it sits
  beside: tracing this surfaced that the existing axis-title branch writes
  `title`/`cascadeAxisTitle` on a canvas edit but never reconciles or clears
  the matching `richText`/`cascadeAxisTitleRichText`, so a title bolded via
  the Inspector and then plain-text-edited on the canvas leaves stale,
  mismatched `richText` behind. Left alone — it affects axis titles, not
  group titles, and fixing it wasn't asked for — but recorded here so it
  isn't mistaken for something this round was supposed to cover.
- **The commit's undo label distinguishes the new case**: `'Edit group
  title'` rather than the generic `'Edit axis title'` a `'title'` target
  would otherwise have shared.

No schema change, no `render-document.ts` change — the `editTarget: 'title'`
stamp already existed at all three call sites — and no change to panel-label
behaviour, which needed none.

Driven in a real browser, light **and** dark, **46 checks total**: a single
click on a group title selected it with no editor opening; a double-click
opened a `<textarea>` overlay (multiline, matching the axis-title precedent),
committed a new title on Ctrl+Enter, and the Inspector's own title field read
back the same text; Ctrl+Z reverted it in one step; switching the heading's
Position to Left rendered it rotated, and a double-click there still opened
the editor correctly positioned over the rotated text (not at the origin, the
failure mode `absoluteFrame` would have produced); switching Placement to
Overlay and double-clicking the on-picture caption worked identically;
bolding part of the title via the Inspector's format toolbar, then
double-clicking on the canvas and only *appending* a character, left the bold
`tspan` intact in the rendered scene — proving the edit went through
`reconcileTextEdit` rather than a blind overwrite; locking the group-label
made the double-click open nothing, matching every other locked node; and
panel-label double-click editing (already working) was re-confirmed
unaffected, still opening a single-line `<input>`. No console errors in
either theme.

### Round 35 — smart layout, and a seven-panel sample figure

Requested: a tool that works out how best to present several panels on a page —
resizing so simple graphs are small and detailed micrographs are large,
minimising wasted whitespace, avoiding squashed content, keeping reading order.
Offered as an AI feature; built as a **deterministic solver** instead, which the
user chose. An LLM cannot measure millimetres, and everything else in this
codebase is a pure function of the document verified against real output.

**No schema change.** All four levers already existed and are already in
`schema.ts`: `page.heightMm`, `document.themeOverrides`, `PanelNode.aspectLock`
and `GridSpec`'s weights. `SCHEMA_VERSION` stays 1 and no field was added.

#### The mechanism

- **Nothing sized a panel to its content before this.** The chain was
  `readingOrder` → `suggestGrid` → `gridCells` → optional `fitAspect`, and
  `suggestGrid` never emits weights, so the page was divided evenly, full stop.
- **`PanelDemand` is plain data in `doc-model`, produced in `render`** —
  `measurePanelDemands` (`packages/render/src/panel-demand.ts`). A plot's real
  demand is its measured axis furniture, which only `computePlotGeometry`
  knows, and `doc-model` imports nothing internal. Exactly the
  `PlotMeasurements`/`measureAllPlots` split, for exactly the same reason.
  `requiredMargin` stays private: the public `computePlotGeometry` already
  returns `margin` through the two-pass rule, which is the number wanted.
- **A picture's size comes from the dpi arithmetic that already existed**, read
  in the direction it actually points. `checkImageResolution` prints
  `visiblePx / (exportDpi / 25.4)` as the width to scale *down* to — effective
  dpi falls as a panel grows — so it is a **maximum useful width**. That single
  number is the whole "detailed micrographs large, simple graphs small" rule,
  and it is measured: a 4000 px micrograph wants 338.7 mm and claims the page,
  a 400 px inset caps at 33.9 mm. Capped at the usable width, or one oversized
  import swamps every other weight.
- **A plot is measured at exactly two probe frames**, wide and narrow — this
  codebase's two-pass rule one level up. `requiredMargin` reads the frame it is
  given (its 60/60/30/35 % caps, and how many rows a bottom legend wraps to), so
  one probe cannot answer the question. The probe is a *clone*, so
  `measurePlot`'s WeakMap misses by construction and is never polluted.
- **Three fixed font scales** (1.0 / 0.92 / 0.85), clamped to
  `theme.type.minimumPt`, never a search. Worth knowing, and pinned by a test:
  the theme's own `plotMarginMm` is a **floor**, so shrinking type buys nothing
  until the measured margin has already cleared it — the lever is worth less on
  a plain small plot than on a crowded one.
- **Bounded search**: at most 8 grid shapes x 3 page heights x 3 font scales.
  Shapes reuse `suggestMontageGrid`'s no-wholly-empty-row rule and its reason.
  Slots are row-major over `readingOrder`, so **left-to-right / top-to-bottom
  holds by construction**, never by a check afterwards.
- **The finalists are re-scored against a document each was actually applied
  to.** `reserveSpaceForGroupLabels` translates panels *after* the grid is
  solved, so a predicted score would describe a near-relative of what Apply
  produces. Four document clones buys the property the preview depends on.
- **`SMART_LAYOUT_WEIGHTS` is one exported block.** The balance between "the
  micrograph is too small" and "the page grew 40 mm" is a judgement, and a
  judgement spread over five call sites cannot be revised coherently.
- **The UI is a SidePanel tab, not a modal** — this app has no modal or popover
  infrastructure, and a `<select>` cannot show four scores and four sentences.
  Each row carries an SVG glyph drawn from the candidate's own `gridCells`, so
  it cannot depict a shape the candidate does not have. `explainCandidate` is
  generated from the score's own terms, so it cannot describe a trade the score
  did not make.

#### Four defects found by measuring, not by reading

Each was invisible to a green suite, and three were invisible to the solver's
own unit tests until it was run against a real figure.

- **A vacuous test hid a real design flaw.** The over-resolution case asserted
  inside a `for` over `result.candidates` — which was **empty**, so it passed
  proving nothing. A lone 400 px image always receives its whole cell and so
  *cannot* comply with its own resolution limit; rejecting on that basis
  discarded every arrangement and returned nothing. Being drawn past its pixels
  is now a scored cost (`overResolution`, weighted level with `unmetDemand`)
  and named in the explanation. The replacement test was checked by zeroing the
  weight and confirming it fails.
- **Solving weights purely from comfort starved the minimums.** On the sample
  figure the montage honestly wants 175 mm; in a three-column grid that took
  109 mm and left the heatmap's column 28 mm against a 49 mm minimum, so every
  multi-column shape was rejected and the solver's only answer was a 247 mm
  single column. `shareOut` now allocates every minimum first and divides the
  surplus by remaining hunger.
- **An aspect-locked panel's implied height had to be a minimum, not a want.**
  A montage's row minimum is the mechanical 5 mm tile floor, so min-first
  sharing handed the hungriest panel the *shortest* row — and `autoLayout`,
  fitting it inside, threw away the column width it had just been granted: a
  montage allotted 175 mm came out **74.6 mm** wide.
- **`autoLayout` centred aspect-locked panels, which mislettered the figure.**
  `fitAspect` centres, so a wide montage in a square cell sat 21.7 mm below its
  cell top — past `readingOrder`'s 5 mm row tolerance — and sorted as a later
  row: the sample opened with its *middle* panel lettered `c` and the panel to
  its right lettered `b`. Now `fitAspectAligned(..., 'start', 'start')`: it
  fixes the lettering by construction, stops a panel's letter floating mid-page,
  and is the convention round 33 already chose for the tiles *inside* a montage.

#### The sample figure, and a scale bar that was measuring nothing

The old sample was two panels on a 183 x 75 mm strip. It exercised almost
nothing the app can draw and gave the solver nothing to solve — two panels of
equal demand is the one case an even split already gets right. It is now
**seven** panels of deliberately unlike kinds: a bar-dot, a three-tile
micrograph montage with a calibrated scale bar, the SAM/S0 volcano, a heatmap, a
Kaplan-Meier curve, a timecourse and a violin (n = 12, so
`checkDistributionSampleSize` has nothing to say about the example itself).

- **Asset bytes are split from the document.** `createSampleDocument()` is
  called from Node by `scripts/archive-memory.ts`, so it declares the `Asset`
  records and browser-only `sampleMicrographs.ts` supplies the bytes, seeded in
  **both** places the sample is created — the launch initialiser and
  `newFigure`, which clears the store first. Missing the second is how New
  Figure would open with three images pointing at nothing.
- The micrographs are the already-committed ones in `reference-and-test-files/`,
  re-encoded to JPEG (14–21 KB each; the PNGs base64 to 430 KB and 750 KB) and
  kept at native 800 x 600, which is well past 300 dpi at the ~30 mm a tile
  takes. Downscaling to 640 px would land at 295 dpi and greet every new user
  with a warning.
- **A scale bar was positioned against the image node's *frame*, not its
  picture.** With `preserveAspect` the two differ, and measured on the montage
  the bar sat **100 px below** the micrograph and horizontally under the next
  tile along — a bar that is not on its image measures nothing, which is exactly
  what `checkScaleBarCalibration` exists to keep out of a figure. `scaleBarFrame`
  now derives the position from `imageContentRect` and is read by both
  `addScaleBar` and `resyncScaleBars`, so placement and re-placement cannot
  disagree. It also fixes a second, quieter bug: `resyncScaleBars` rewrote the
  width alone, so a bar kept its old `y` when its image was resized.

**Not done, deliberately:** no free-form span search (only row-major slots —
that is where the candidate count explodes and where reading order stops being
guaranteed by construction); no live canvas preview of a candidate (the score,
the glyph and one Apply-then-undo answer the same question far more cheaply);
no per-panel font scale (`theme.type` is document-wide, and mixed sizes across
panels is itself what `checkFontConsistency` flags); no page *width* change and
no `theme.spacing` change, so the reported trade stays verifiable against the
measured demand; nothing persisted, since re-solving is cheap; and no
Quality-tab fix recipe, because a `FixRecipe` cannot present four choices and
would have to pick silently — which is the behaviour this feature exists to
avoid.

### Round 36 — ragged rows and L-shapes for smart layout

Reported after using round 35: the arrangements offered still waste space, and
a seven-panel figure ought to be able to put three panels in row 1 and four in
row 2 with the last three narrower. Both halves were right, and the second
named the cause exactly. Round 35's candidates were uniform `rows × columns`
grids, so seven panels could only be a **2 × 4 — eight cells for seven panels,
with one simply empty**. That hole *is* the wasted strip. The user also asked
for L-shapes (a tall panel beside a stack of two) and for more options in the
list; both are in.

**No schema change.** The four levers are unchanged and `SCHEMA_VERSION` stays 1.

#### A candidate stops being a grid

The alternative — keep `GridSpec` and express ragged rows through a fine column
grid plus `colSpan` — was worked through and rejected on arithmetic, not taste.
A shared column grid forces the **gutter positions** to be global. Row 1's
three gutters and row 2's four fall in different places, so the grid needs a
boundary at the union of both; but a boundary interior to a row's panel makes
that panel absorb an extra gutter, which shifts every position after it, which
moves the boundaries being placed. It terminates only by iterating, and layout
here refuses convergence loops (`requiredMargin`'s "exactly two passes",
`montageShape`'s closed form).

So `packages/doc-model/src/arrangement.ts` is a new module and a candidate
carries an `Arrangement` plus explicit `frames`. It is pure geometry over four
numbers per panel (`PanelSizeDemand`) with no notion of priority, resolution or
where a demand came from — which is what lets it be tested against exact
millimetres with no document, theme or measurement behind it.
`solveWeights`/`gridShapes`/`rowMajorSlots` are gone; their two-pass reasoning
moved into `arrangementFrames` unchanged.

- **`placePanels` is factored out of `applyAutoLayout`** rather than
  duplicated. A panel moving has the same consequences however its frame was
  computed — re-tile, translate the letter, re-sync scale bars — and a second
  copy is how one caller comes to re-tile and the other forgets to.
- **`applySmartLayout` clears every `panel.slot`.** A smart arrangement is not
  a template grid, and `applyAutoLayout`'s own comment already records what a
  slot replayed against a differently-shaped grid does.
- **It also stopped taking margin/gutter, and `applyCandidate` stopped taking a
  theme.** Both were now unused, and the theme one was the stale-theme hazard
  its own comment warned about: taking no parameter makes the mistake
  unavailable rather than merely documented.

#### Reading order, derived and then checked

Bands top to bottom; within a band every column's *first* panel left to right
(they all start at the band's top edge, so `readingOrder`'s 5 mm y-band groups
them); then the stacked column's lower panel, which sits below all of them
whichever column holds it.

That is provable only while **at most one column per band is stacked, and a
stack holds exactly two** — with two stacks, which lower panel comes first
depends on the heights the demands happen to produce, so the order could not be
known from the structure. Hence the enumeration's rule, and the reason for it.

It is then *verified* rather than trusted: `readsInOrder` sorts the frames a
candidate produced with `readingOrder`'s own comparator and the candidate is
**dropped at generation time** if they disagree. `applySmartLayout`'s assertion
stays as a backstop but can no longer be the thing that fires — a refusal at
Apply reads to an author as a button that does nothing. The unit test asserts
the property across the *whole* enumeration at deliberately uneven demands
rather than for one example.

#### The bug that measurement found

**`maxCols` was computed from the widest panel's minimum**, i.e. "how many
columns if every column were as wide as the widest one needs". On the sample
that is `floor(184 / 47.4) = 3`, so **a band of four was never enumerated** —
and no amount of tuning the ranking could have surfaced the `3 + 4` the round
is about. The four narrowest panels there need 136 mm of the 179 mm available
and fit comfortably. `mostThatFit` now takes the *k smallest* minimums, which
is the true ceiling; whether a particular set of k panels fits is `shareOut`'s
question, asked per band a few lines later. A loose bound the real test then
tightens is the right shape; a tight bound applied *before* the real test can
only discard arrangements that would have worked.

Found by probing the solver against the real sample document — reading the
code, the bound looks like an ordinary feasibility check.

#### Getting eight genuinely different figures in front of the author

The offered count went from four to eight, and two ranking problems had to be
fixed before that bought anything. Both were found by running the tab, not by
reading it.

- **Deduping on the exact structure was too fine.** For seven equal panels the
  top eight came back as four all-but-identical L-shapes — the stack at the left
  or the right of either band, scoring within nothing of each other — plus four
  three-band shapes. `figureSignature` is the coarser key: panels per row,
  whether anything is stacked, whether the columns align. Which *end* the stack
  sits at is not a choice anyone is making.
- **Ranking purely by score bunched the list by row count.** On the real sample
  all eight were three, four or five bands, with no two-row split at all —
  because four panels across 183 mm is genuinely a little tight and it scored a
  couple of points lower. Honest, and a poor offer. Each `(row count, stacked?)`
  bucket now gets its best entry before any bucket gets a second; the rest fill
  by score. Bucketing on row count *alone* was tried first and was not enough —
  the best two-row entry was an L-shape, so the plain `3 + 4` still stayed out,
  and the two kinds have to be separate buckets or the more exotic one wins the
  slot on a point of score. Nothing is reordered by any of this: the
  highest-scoring candidate is still first, only what makes the cut changes.

#### Two smaller things

- **The glyph draws the candidate's real frames**, not `gridCells`. More
  truthful — an aspect-locked micrograph shows at the shape it will actually
  take, including any strip it leaves beside itself, which is exactly what
  someone comparing arrangements is looking at — and `candidateCells` is gone.
- **The title is generated by `describeArrangement`** (`3 + 4`, `3 + 3 ·
  aligned columns`, `2 + 2 + 3 · one tall panel beside a stack`), from the
  structure, so it cannot name a shape the candidate does not have.

**Two test-fixture errors of my own, both corrected rather than worked around.**
A demand carrying `aspect` but not `aspectFromContent` was expected to get an
aspect-shaped row: the solver quite rightly ignores an aspect it will not write
as a lock, and reserving height for a shape then not enforcing it is what round
35's own montage bug was. And a `shareOut` expectation of `[50, 50]` was
arithmetic I got wrong — a track already at its want has zero hunger and gets
none of the surplus, which is the rule, not a defect. Each new regression guard
was checked by reverting the fix and confirming it fails.

**Not done, deliberately:** stacks deeper than two, or two stacked columns in
one band — both stop the reading order being derivable and neither appears in
the reference figures. No free guillotine nesting (a stack whose cell is split
again sideways): the search stops being enumerable. No score term rewarding
column alignment — aligned candidates are offered as their own option and the
author picks; a tidiness weight would make the reported trade unverifiable
against the measured demand. Round 35's "no free-form span search" note is
partly superseded — spans *down* now exist as the stacked column; spans across
several columns still do not.

### Round 37 — room for a group title over a graph, and a Placement control that only appears where it applies

Two reports against the round 31–33 group-title surface.

#### A heading on the top row was drawn off the page

Reproduced before changing anything: selecting the sample's panel *a* and
clicking "Add group title" left the page height at 180 mm, moved **nothing**,
and drew the heading at **y = −1.27 mm** — above the page's own top edge, and
higher up the page than the letter `a` at y = 2.26.

**The cause was one line.** `reserveSpaceForGroupLabels` measures the gap
between the members and the nearest panel on the heading's side, and did
`if (neighborEdge === null) continue` when there was none — which is exactly
the top row. So the one case that most needs space reserved reserved none. A
heading further down the page was already fine: the 5 mm gutter above it exceeds
the ~3.3 mm a bare 6 pt heading needs, so nothing had to move, which is why this
only ever showed up on the first row.

The fix measures against the **page's own margin edge** when there is no panel
to push against. `marginMm(draft)` derives that from the smallest inset any
top-level panel actually sits at, rather than from `theme.spacing.marginMm`
which `doc-model` may not import — a figure dragged inward simply reports a
larger margin, which is the honest answer to "how much room is there above the
top row".

#### The panel letter stays topmost, and it is the letter that moves

Confirmed with the user: the order down the page is **letter, heading, graph**.
The letter identifies the panel and belongs outside everything else.

- **The heading's geometry is untouched** — it still sits in the band
  immediately above its members. What changes is that the *letter* is lifted
  above it. The alternative, insetting the panel's content so the heading fits
  inside the frame below the letter, would have meant changing `groupLabelFrame`
  and `fillPanelChildren` for every heading — including the montage and
  single-image cases verified in rounds 31–33 — to fix something that only
  arises for panels.
- **`PanelLabelNode.liftMm?: number`** records the lift, and
  `reflowPanelLetterLifts` (called from `reflowGroupLabels`, so all ~25 existing
  call sites get it free) adjusts `frame.y` by the *difference*. Storing it is
  load-bearing rather than tidy: `reflowGroupLabels` runs after every canvas drag
  (`Canvas.tsx:672`), so setting `frame.y` outright would snap a hand-nudged
  letter back to its panel on the author's next move. Adjusting by
  `next − previous` leaves the nudge intact and puts the letter back exactly when
  the heading is resized or deleted. Same "automatic base beside a stored delta"
  shape as `BracketNode.userOffsetMm`, with the automatic half stored instead —
  here it is the automatic part that has to be undone precisely.
- **A letter is lifted only by a heading drawn above its panel's own top edge.**
  That one test is what separates a heading over the panel from a montage *cell*
  caption, which lives inside the panel's grid: the cell caption's frame starts
  below the panel top, so it fails the test without this code knowing anything
  about montages.
- `panelLetterHeightMm` joins the other clearance helpers in `grouplabel.ts`,
  read from the label node's own `style.fontSizePt` — the size actually drawn —
  so `doc-model` still needs no theme. `reserveSpaceForGroupLabels` adds it to
  the band it reserves, or the letter would have nowhere to go.

#### Push the page down, and shrink only if it would overflow

The user's choice, and on the sample the shrink is the **common path, not a rare
branch**: the required band is about 6.4 mm against 3.6 mm of slack.
`pushPanelsFrom` translates every panel at or beyond the boundary (the loop that
was already there, with its `snapshotPanelAbsolutePositions`/
`syncPanelLabelsFromSnapshot` pair so letters follow), then measures the
overflow past `pageHeight − margin` and takes it back out of the pushed rows'
heights in proportion, re-stacking them so the gutters survive. Rows are banded
on `y` with the same 5 mm tolerance `readingOrder` uses to decide what a row is —
the banding round 36 introduced.

- **Growing the page instead was refused**: a caption silently making a figure
  taller can breach a journal's maximum, and the page is not this function's to
  spend.
- **No panel goes below `MIN_TILE_MM`.** Where the overflow cannot be fully
  absorbed the rows take what they can and the remainder is left on the page — a
  figure slightly over its page is recoverable, a row collapsed to nothing is
  not.
- **Idempotent by construction**, which matters because
  `reserveSpaceForGroupLabels` runs on every from-scratch layout: after one pass
  the gap equals the clearance, so the next call computes a shortfall of ≤ 0.
  Pinned by a test, since a creeping figure would only show up after several
  imports.

#### A caller that should already have been doing this

`applyCandidate` (`apps/web/src/smartLayout.ts`) called `reflowGroupLabels` but
not `reserveSpaceForGroupLabels`, so applying a smart layout over a figure
carrying a heading put the heading straight back on top of its panel. Smart
layout is a from-scratch layout — the exact case that function's contract says
it is safe for — so the call was added. Round 35's header comment claiming the
re-scoring pass exists *because* `reserveSpaceForGroupLabels` moves panels after
the grid is solved is true again as a result; it had quietly stopped being so.

#### Placement, offered only where it applies

`placement: 'overlay'` draws the heading *on* the content in white with a dark
outline — a micrograph convention that over a plot paints a white caption across
the axes. The control was rendered unconditionally. `groupLabelMembersAreImages`
gates it: every member must be an `image` node, or a panel whose own content
children are images. This is the standing "a control that visibly does nothing is
a defect" rule in its sharper form — here it did something, and that something
was wrong.

The control still appears when the heading is *already* `overlay`, so a value on
an older document stays reachable rather than stranded behind a hidden control.
Nothing is rewritten on load: hiding a control is presentation, changing a stored
`placement` would be a migration, and this is not one.

#### An observed consequence, recorded rather than papered over

Captioning **one** panel of a row staggers that row's letters: the captioned
panel's letter is lifted clear of its heading while its neighbours' stay at their
own panels' tops (measured: `a` at 2.26 mm, `b` and `c` at 9.19 mm). That follows
from the panel's own content — only it carries a heading — and reading order is
unaffected, since `readingOrder` sorts *panels*, not letters. A live check
asserting letter order by rendered position failed on this and was corrected to
assert panel order, which is the property that actually governs lettering. No
cross-panel letter-alignment rule was invented for it.

**No version bump.** `PanelLabelNode.liftMm` is optional, and is mirrored into
`schema.ts` as well as the TS type — a field present only in the type is dropped
on save.

### Round 38 — a scale bar below the picture, in black

Requested: an option to place a scale bar below the image, bottom right, in
black. Until now every bar was drawn *on* the picture, inset 2 mm from its
bottom-right corner — right over a dark micrograph, and the only thing offered.

**Measured before designing anything, because it decided the shape of the
work**: the sample's montage tiles are 16.78 × 11.89 mm pictures in 16.78 ×
11.89 mm frames. `autoFit` matched the panel's aspect to the tiles, so there is
**no spare strip beneath a picture at all** — a below-placed bar falls outside
the image node's frame and the room has to be made for it. The user chose to
reserve it by pushing the rows below and shrinking if the page would overflow,
reusing round 37's `pushPanelsFrom`, with the owning panel shrinking where there
is no row below to push.

- **`ScaleBarNode.placement?: 'inside' | 'below'`**, absent reading as
  `'inside'`, so no saved figure moves. `scaleBarFrame` gains the one branch,
  and because `addScaleBar` and `resyncScaleBars` both already go through that
  function, placement and re-placement cannot disagree. The bar aligns to the
  **picture's** right edge with no inset — it is outside the picture now, so
  insetting it would pull it off the edge it is meant to line up with.
- **Switching to `'below'` writes black in the same commit.** Not cosmetic:
  outside the picture the bar sits on the white page, and white — the right
  choice over a dark micrograph, and what an author will often have set — is
  then invisible. The Colour control beside it still applies, so it is a
  starting point rather than a lock. Verified live by setting the sample's bar
  white first and watching the switch convert it.
- **`reserveSpaceForScaleBars`** is the sibling of `reserveSpaceForGroupLabels`,
  sharing `pushPanelsFrom` rather than a second copy of push-then-shrink, and
  under the same contract: never live during a manual drag, resize, align or
  distribute. On the bottom row there is nothing to push, so the panel that
  gained the bar pays out of its own height and the page is untouched.
- **`reserveLayoutSpace`** now runs both reservations and is what the app calls;
  the ~10 former `reserveSpaceForGroupLabels` call sites switch to it. One name
  is what stops a new call site remembering one reservation and forgetting the
  other — editing ten sites to call two functions each is how that drift starts.
  Both halves stay exported for the tests.

#### The clip that would have eaten it

`renderImage`'s **cropped** branch clips the picture *and its overlays* at the
frame, deliberately — an annotation in the letterbox margin should survive, one
outside the frame should not. A bar below the picture is outside the frame by
construction, so it was clipped away. The uncropped branch emits no clip at all,
so this would have looked right until the author cropped the micrograph and then
silently vanished — and cropping a micrograph is routine.

The overlays now get their own clip, taller by exactly the band the bar needs.
They cannot share one with the picture: on that branch the `<image>` is
*deliberately* larger than the frame — that is how a crop is drawn — so a clip
stretched to hold the bar would also reveal the region the author cropped away.
Emitted only where there is such a bar, so every other cropped figure keeps the
markup it had, which a second parity test pins.

#### A false measurement in the same function

`scaleBarWidthMm` computed `mmPerPixel = parent.frame.width / visiblePx`. Those
`visiblePx` source pixels are drawn across the **picture**, and on a letterboxed
image the picture is narrower than its frame — so the bar was drawn longer than
the distance it claims. It reads `imageContentRect(parent).width` instead.

**An existing test was pinning the bug.** "doubles when the image is cropped to
half its width" asserted 2.0 mm, reasoning that "half as many source pixels span
the same millimetres". They do not: with `preserveAspect` on, halving the crop
width changes the kept region's aspect to 0.625, so `renderImage` letterboxes it
and draws those 500 pixels across 25 mm, not 50. A pixel is still 0.05 mm and
the bar — 10 µm at 2 px/µm, so 20 source pixels — is still 1.0 mm. The old code
said 2.0: exactly twice the distance it claims, which is the class of defect
`checkScaleBarCalibration` exists to keep out of a published figure. The test now
asserts 1.0 with the arithmetic written out, and a second test covers the case it
was reaching for — `preserveAspect: false`, where the kept region really is
stretched across the full frame and the bar really does double.

#### A live-test trap worth recording

The right-alignment check read 0.46 mm out and looked like a placement bug. It
was the measurement: `getBoundingClientRect()` on an `<image>` returns the
**element box**, not the painted picture, and with `preserveAspectRatio="…meet"`
a 4:3 tile letterboxes inside its 1.41-aspect box. Computing the picture rect the
way `imageContentRect` does put the bar's right edge at 83.651 against the
picture's 83.649. The same distinction the code comments are about, caught from
the other side.

**No version bump.** `placement` is optional and is mirrored into `schema.ts` as
well as the TS type — a field present only in the type is dropped on save.

**Not done, deliberately:** the bar stays a child of the image node —
`scaleBarWidthMm` and `checkScaleBarCalibration` both read the parent image, so
re-parenting it to the panel to "get it outside" would break the calibration it
exists to express. The label's above/below control is unchanged and the reserved
band covers either. `'below'` does not become the default for new bars: inside
the picture is still right for a dark micrograph, and the request was for an
option.

### Round 39 — the scale bar's label colour

Requested straight after round 38: let the label's colour be changed, as the bar
already can be. **No model or renderer work at all** — `ScaleBarNode.style` is a
`TextStyle`, `textStyleSchema` has carried an optional `color` since phase 1, and
`renderScaleBar` has always drawn the caption through
`textAttrs(...)`'s `style.color ?? theme.foreground`. The whole gap was one
missing control: a `TextNode` has had a Colour swatch writing this exact field
since phase 1 (`TextFields`), and the scale bar — the one node type that most
needs it, since a white bar over a dark micrograph is the case its own fill
control exists for — never got one. So that caption has always drawn in the
theme's black with no way to fix it.

- **A "Label colour" swatch beside the bar's own**, in the Appearance row. Its
  value is `node.style.color ?? theme.foreground`, rather than `TextFields`'
  hardcoded `?? '#000000'`: a colour input cannot express "unset", and a literal
  would misreport what is drawn on a theme whose foreground is not black. The
  two agree today — `foreground` is `#000000` and no preset overrides it — so
  this is the safer spelling of the same value, not a fix.
  `GroupLabelFields`' own `labelColor ?? …` control is the closer precedent, and
  `theme` is now a prop for the same reason it is one there.
- **The existing swatch is relabelled "Bar colour".** Two controls called
  "Colour" in one row is how the wrong one gets set — the same reasoning already
  written beside the calibration field, which is "That distance is (µm)" rather
  than a second "Length".
- **Hidden when `labelPosition === 'none'`**, since colouring text nobody draws
  is the standing "a control that visibly does nothing is a defect" rule.
- **Switching to `'below'` converts the label too, but only if it is explicitly
  set.** Round 38 turns the bar black on that switch because outside the picture
  a white bar is invisible on the page, and a caption the author has coloured
  white needs the identical treatment. An *absent* colour is deliberately left
  absent: it already resolves to `theme.foreground`, so writing black over it
  would change nothing today and freeze the caption against a later theme
  change. The fill has no such option — `Fill.color` is required, so it is always
  explicit and always converted.

Driven in a real browser, light **and** dark, **18 checks each**: the label
redrawn at `rgb(255,0,0)` off its own `scale-bar-label` element while the bar's
fill was untouched; the bar then set white with the label still red, proving the
two are independent; switching to "Below the image" turning *both* black and the
swatch reporting the conversion; one undo restoring placement, bar colour and
label colour together; and the control disappearing with the label and returning
with it. No console errors in either theme.

**Two live-test traps, both mine, both fixed in the harness rather than the
code.** A synthetic `input`/`change` event does not drive a React controlled
input — an already-recorded trap, hit again, and it made the first run report
that *nothing* changed, including the bar colour that had worked all along;
`fill()` goes through the native setter React tracks. And Ctrl+Z pressed with
focus still in the colour input reaches nothing, which is correct and
deliberate — `useUndoShortcuts` never steals it from a form field and the canvas
handler ignores anything focused inside `.side-panel`. Confirmed by printing
`document.activeElement` before assuming. The fix is to blur, *not* to click the
canvas: a canvas click clears the selection and takes the Inspector's controls
away with it.

**No version bump, and no schema change** — `color` was already there. Nothing
had ever *round-tripped* it though, on any node type, so the test added here is
the first to prove zod keeps it: the standing hazard is usually the other way
round (a field in the type but not the schema is dropped on save), and an
unexercised schema field is the same risk from the far side. Verified by
deleting `color` from `textStyleSchema` and confirming only that test fails.

### Round 40 — a band refinement pass for smart layout

Reported against a real figure produced by round 36's solver: panel *a* (a bar
chart) runs well below panel *b* (a three-tile montage) in the same row, leaving
a dead strip under the pictures; same for *g*/*h*. Suggested as *"an automatic
refinement process once the optimal layout is chosen"*.

**Measured before anything was designed, and it reframed the job.** This is not
an arithmetic bug. The two panels genuinely want different heights, they are
top-aligned, and the difference becomes whitespace under the shorter one. What
*was* a defect is next to it: `shareOut` spends its whole total by design, and
`arrangementFrames` advanced `y` by the **allotted** band height, so a
free-height plot stretched past its own comfortable height to whatever the page
had spare. Reproduced through the real solver: a plot wanting 42 mm came out
46, 56 and 76 mm tall on 50, 60 and 80 mm pages while the montage beside it
stayed at 28.6 mm throughout.

Three decisions taken with the user: widen the picture first and shrink the band
second; squeeze a free-height panel no further than its comfortable height; and
add a score term for wasted height so a tight figure genuinely scores better.

- **Lever 0 — an aspect panel's height *want* is what it can use at the width it
  gets.** `columnWant` took `max(implied, wantHeightMm)`, and a picture's
  `wantHeightMm` is derived at *full page width* — so a montage placed 126 mm
  wide still asked for the 40.2 mm that 177 mm would have implied, height
  `fitAspectAligned` immediately throws away. `columnWantHeight` returns the
  implied height outright for a panel holding an aspect. A picture's wish to be
  bigger is not lost: it lives on the width axis, where `wantWidthMm` already
  carries it into pass 1. **Measured on a short plot beside that montage:
  misalignment 11.9 → 1.4 mm and the offered "tight" page 44.5 → 34.0 mm, from
  this one change.** It is also what makes lever 2 mean anything — afterwards
  `bandWant` really is "every picture at its implied height, every plot at its
  comfortable height", which is exactly the squeeze floor the user chose.
- **Lever 1 — `refineBandWidths` widens a picture toward the height the rest of
  its band wants**, taking the width from free-height neighbours down to their
  own minimums, pro-rata both ways so the band's total width is preserved
  exactly. One reallocation, and **a second pass could not find anything**: a
  donor's want is width-independent so it is unchanged, a receiver's was
  strictly below the target and its `need` is capped at exactly the target, and
  the target was attained by a column that is neither — so the number this aimed
  at did not move. Forward-only by construction, the same argument
  `montagePanelAspect`'s closed form rests on, rather than a loop that happens
  to be bounded. That proof is *why* donors must be free-height columns (an
  aspect donor would shrink its own implied height and merely move the strip)
  and why receivers are single-panel columns (a stack of two aspect panels
  inverts a piecewise-linear function, which is iteration in disguise). Growth
  stops at `wantWidthMm`, a picture's dpi-derived ceiling clamped to the page,
  so this can never make `overResolution` fire. Skipped for an `aligned`
  arrangement, whose one shared width division is the property that option
  exists for.
- **Lever 2 — the band is clamped to what it wants and the page reclaims the
  rest.** `arrangementFrames` became **`arrangementLayout`**, returning
  `{ frames, pageHeightMm }`. Renamed rather than wrapped so every call site is
  revisited: one that kept only the frames would write the *unreduced* height
  onto the document and move the strip to the bottom of the page.
  `arrangementHeightDemand` needed no change and now agrees *provably* — at any
  page at or above `wantMm` the clamp is a no-op, so the realised page is
  exactly `wantMm`, which is asserted as a property over the whole enumeration
  rather than left as the prose claim it was.
- **`bandWaste`, weight 0.5**, measuring how much of each row's own box no panel
  covers, width-weighted inside a row and height-weighted across rows. Derived
  from the **frames**, never the band structure: the finalists are re-scored
  against a document each candidate was actually applied to, after
  `reserveLayoutSpace` has moved panels, and a structure-derived term could not
  be recomputed there — the same reason `whitespace` counts fitted frames.
  `wastedArea / usableArea` was worked out first and rejected as too blunt: the
  reported strip is 0.043 of the page, under a point of score where
  arrangements here are separated by a couple, against 0.165 of its own row.
  `explainCandidate` names it, or a term that reorders the list would never be
  visible to the author.
- **`rowBands` in `layout.ts`** is now the one grouping by `readingOrder`'s 5 mm
  tolerance, shared by `pushPanelsFrom` and the new term.
  `readingOrder`/`readsInOrder` are deliberately *not* routed through it — they
  need an ordering and already share a comparator with each other, so those are
  two different algorithms over one constant rather than two copies of one.
- **`aligned` joined the offered-list bucket key.** An aligned arrangement now
  scores honestly worse on `bandWaste` — sharing one width division across bands
  is exactly what leaves a row ragged — so without its own bucket it would lose
  its slot to the plain variant on a point of score, quietly removing a shipped
  option.
- **Candidates are deduped on the *realised* page height.** Every enumerated
  height at or above `wantMm` now realises as the same page, so two of the three
  would otherwise appear as identical candidates under different ids — and `id`
  is the key the offered list renders on.

#### Two things the plan got wrong, both caught by tests

- **A second clamp at column level made rows raggeder, not tighter.** It was in
  the design so a stacked column would "behave like a band of its own", and the
  existing stacked-column test failed on it immediately: a single panel beside a
  stack of two stopped at its own want and left the stack's full height beside
  it as a strip. A column filling a band a *neighbour genuinely needs* is what
  makes a row flush and costs nothing; only the **page's** spare height must not
  be spent, and the band clamp already refuses that. Removed, with the reason
  written where it was.
- **A test asserting the new term picks the arrangement was vacuous.** It passed
  with the weight at zero. Probing the real candidates shows why: on those
  demands the winning shape is four points clear and `bandWaste` is worth about
  one, so it is not what decides that solve. The claim was removed rather than
  reworded — the term is pinned where it can be isolated, by two frame maps with
  identical coverage, satisfaction and page that differ only in raggedness
  (0.2414 against 0), verified by zeroing the weight and confirming that one
  fails.

#### What it actually delivers, measured

On the real sample the montage grew **126.6 → 137.0 mm** wide and **28.8 →
31.1 mm** tall — the plot beside it gave up width to its own floor — and the
bar chart's overhang fell **11.6 → 10.1 mm**. Honest about the size of that: the
residual is structural for that pairing. To match a 38.2 mm plot a 4.405:1
montage needs 168 mm of width and only ~147 mm can be freed, so **full alignment
in that row is reachable only by taking the plot about 4.7 mm below its
comfortable height** — the one thing the chosen rule forbids. The larger win is
elsewhere: the page no longer stretches a plot past its comfort at all, which
was 34 mm of dead height on an 80 mm page.

**Not done, deliberately:** shrinking an over-wide *aspect* panel to lower a
band, which fights priority head-on; stacked or aspect-locked columns as
lever-1 participants; and the width-axis analogue — `shareOut` spends its whole
usable width too, which is `overResolution`'s territory. The realised page
height is left unrounded rather than snapped to the half millimetre like
`arrangementHeightDemand`'s own answer: re-adding half a millimetre of slack to
make the number tidy is the opposite of what this round is for.

### Round 41 — a montage panel's shape is affine, not a ratio

Reported against `reference-and-test-files/test2.png`: *"when I add group titles
and scale bars, the autolayout still leaves whitespace (see panel a versus b)"*.
Round 40 had just addressed the band-height side of the same figure; this is a
different and larger cause underneath it.

**`montagePanelAspect` returned a single ratio, and a montage panel does not
have one.** Its comment claimed *"Any positive cell height gives the same ratio;
use one that keeps the fixed terms from dominating"* and it probed at
`cellHeight = max(MIN_TILE_MM, fixedHeight)`. The claim holds only when
`fixedWidth / fixedHeight == cols·tileAspect / rows`:

    aspect(h) = (cols·tileAspect·h + fixedWidth) / (rows·h + fixedHeight)

Measured on the reported shape — a 1 × 3 montage of 4:3 tiles under one group
title, `fixedWidth` 2.00 mm of gutters and `fixedHeight` 3.54 mm of label band:

| cell height | true panel ratio |
|---|---|
| 5 mm | **2.5761** ← what it returned |
| 10 mm | 3.1019 |
| 20 mm | 3.4834 |
| 40 mm | 3.7207 |

So panels were locked far too tall. Running the **real tiler** at frames of that
ratio and reading `imageContentRect`:

| frame | cell | picture drawn | dead per tile |
|---|---|---|---|
| 60.0 × 23.3 | 19.33 × 19.75 | 19.33 × 14.50 | 101.5 mm² |
| 120.0 × 46.6 | 39.33 × 43.04 | 39.33 × 29.50 | 532.6 mm² |
| 175.0 × 67.9 | 57.67 × 64.39 | 57.67 × 43.25 | **1219.2 mm²** |

A tile is `alignY: 'start'`, so each keeps its width, loses height, and leaves
the difference as blank page *below* the picture — 21 mm per tile at 175 mm, ×3.
The error is present with no caption at all (4.40 at h=5 against 4.05 at h=40,
~9%); a group label is simply the only thing that makes `fixedHeight` large.

- **Only the *cells block* has an aspect; the bands are constant offsets.** So a
  montage's height is an exact affine function of its width — `gridCells`
  divides the residual evenly, giving `cellHeight = (H − fixedH)/rows` exactly:

      height(w) = fixedHeightMm + (w − fixedWidthMm) / (cols·tileAspect / rows)

  `ShapeMm` in `geometry.ts` carries the three numbers, with `heightForWidth`,
  `widthForHeight` (its exact inverse) and `fitShape`. Still closed form, and
  more strictly so than what it replaced: there is no probe height to pick,
  because the answer is right at every width rather than at one.
- **`fitAspectAligned` is now literally `fitShape(r, aspectShape(a), …)`.** That
  is what turns "byte-identical when the bands are zero" from a claim into a
  structural fact rather than two implementations that agree today.
- **`PanelSizeDemand.aspect` became `shape: ShapeMm`, renamed rather than
  redefined.** Redefining a field in place is the one change the compiler cannot
  catch — every literal keeps compiling and silently means something else.
  Required, not optional, since it is never persisted and required is what makes
  each construction site a compile error. `sizeDemand` emits the whole shape or
  `FREE_SHAPE`, so a `contentAspect` with no bands — a panel with no gutters, no
  padding and no caption — is unrepresentable rather than merely avoided.
- **`refineBandWidths`' one-pass proof acquires an obligation and keeps it.**
  Capping `need` at the target needs
  `heightForWidth(shape, widthForHeight(shape, H0)) === H0`, true only for
  `H0 ≥ fixedHeightMm` — below its own bands a shape has no width that produces
  that height and the round trip overshoots. Discharged by the receiver test
  itself: a receiver needs `columnWant(c) < target` and `columnWant(c) ≥
  fixedHeightMm` unconditionally, so `target > fixedHeightMm` for every receiver
  there is. Written into the docstring, because it is a new precondition the
  affine form creates and it is not obvious.

#### The scale bar, and why it goes in the tiler

`grep -n "scaleBar" packages/doc-model/src/smart-layout.ts` returned **nothing**:
a below-placed bar's 4.14 mm was invisible to the solver, and only
`reserveSpaceForScaleBars` made room afterwards by shrinking the owning panel.

Putting it in the demand alone would have been worse than useless — the demand
would claim a taller panel while `fillPanelChildren` still tiled the full frame,
so the tiles would absorb the band and the two would disagree, which is the exact
failure `montageFixedExtentMm`'s own docstring exists to prevent. It goes into
`montageGutterExtras` (renamed from `groupLabelGutterExtras`) as one more
boundary extra, `rowExtra[row + 1]`. `gridCells`' extras run `0..rows` inclusive,
so a bar under the last row reserves its strip inside the panel; and all three
consumers already read that one function, so `montageCellRects`,
`montageFixedExtentMm` and `montageShape` each pick it up with no further change.

`fillPanelChildren`'s **no-grid** branch needs the same band, or the lone-image
case is the one that double-counts: `imageContentRect` centres by default, so
half the band would land above the picture and the reservation pass would shrink
the panel anyway.

#### `aspectLock` is now the ratio the panel really got

It was built once per font scale, *before* the arrangement loop, from the demand's
nominal aspect — 2.5761 on the fixture, the ratio of no frame any candidate
produced. It is now read off `layout.frames` inside the loop, exact at the size
the author is about to see; the same move round 40 made for the page height.

A single lock still cannot express an affine shape, which is why
`applyAutoLayout` passes the **shape** for an auto-fitting montage
(`PanelLayoutInput.shape`, gated strictly on `contentGrid.autoFit`) and
`aspectLock` is demoted to the manual-resize fallback it should always have
been. Without that, plain Auto Layout kept producing the strip even once smart
layout had stopped.

#### A test that passed for the wrong reason

`doc-model.test.ts`'s *"shapes the panel so square tiles get square cells"*
asserted a 2 × 2 of square tiles gives a panel ratio of 1 — true, and true for a
reason unrelated to the function being right: that is the one configuration
where `fixedWidth == fixedHeight` and `cols·a/rows == 1`, i.e. exactly where a
single ratio genuinely *is* scale-invariant. It would have kept passing through
this defect and the next. Rewritten against the shape's parts, plus the property
it was reaching for — the panel is square at every size. *"sets aspectLock, which
is what auto-layout already honours"* was the other one: it compared the lock
against the very function that produced it, so the lock was self-consistently
wrong and the assertion could not see it.

**No schema change.** `ShapeMm`, `PanelSizeDemand` and `PanelDemand` never
round-trip; the only persisted field touched is `PanelNode.aspectLock`, whose
value changes but not its type. `SCHEMA_VERSION` stays 1.

**Not done, deliberately:** `fitMontageToImages` writes the realised lock but
does **not** also reshape `panel.frame` — it runs from five call sites and
silently changing a panel's height on each is a larger behaviour change than the
defect, and the next layout pass gets the shape right regardless. The width axis
is untouched: `shareOut` spends its whole usable width too, which is
`overResolution`'s territory.

### Round 42 — group-aware layout

Reported: smart layout "fails" when panels are grouped, or when an object is
grouped with a panel — offered with the fallback of just warning the author.
Investigating found it is neither one bug nor smart-layout-specific, and the
fallback was not needed.

**Four defects, all in the same family: a grouped panel's `frame` is relative to
its group, and the layout treated it as page space.**

1. **`readingOrder` sorted on `frame`.** Measured on three panels with two
   grouped at the *bottom* of the page: `A C B`, because A and B's group-local
   `y` of 0 put them inside C's 5 mm row band. The page plainly reads `C A B`,
   and `relabelPanels` shares the function, so the figure was lettered to match
   the wrong answer *and* the arrangement was solved for a sequence the author
   never sees.
2. **`placePanels` wrote page coordinates into `panel.frame`.** A's frame read
   `(6, 2)` against a true page position of `(11, 62)`; B's right edge landed at
   **186 mm on a 183 mm page**.
3. **`relabelPanels` placed a new label at `panel.frame.x - offset`** while a
   `panel-label` is top-level, so a grouped panel's letter went to the group's
   local space.
4. **`GroupNode.frame` was never recomputed** — still `(5, 60, 115, 40)` after
   the layout had moved both members. It is also the child coordinate origin,
   so the next `resizeGroup` would scale against a box bounding nothing.

**Plain `applyAutoLayout` had all four**, so every import, delete and Auto
layout press hit them too. Both paths are fixed, because the bug lives in the
code they share.

- **The layout's subject is now a `LayoutUnit`** — every top-level panel, plus
  every top-level group carrying at least one panel — sorted by
  `compareReadingOrder`, extracted so `readingOrder`, `layoutUnits` and the
  solver's `readsInOrder` genuinely share one rule. (Round 40's note claimed the
  first and last already did; they did not, the last inlined a hard-coded
  tolerance.) `layoutUnits` iterates raw `Object.values` rather than
  `childrenOf`, which sorts by `z` and would change the tie-break between two
  coincident panels — an ungrouped figure has to come out in exactly the order
  it used to.
- **`placePanels` → `placeUnits`**, renamed rather than extended: both callers
  pass a panel list today and a signature change that still reads plausibly is
  how one caller comes to place units and the other panels. A panel unit keeps
  today's body character for character — sound because a panel unit is
  top-level by construction, which is precisely what a grouped panel was not.
  A group is placed with **`resizeGroup` (round 21)**, which already scales
  panels, shapes, arrows and nested groups, already assigns the group's own
  frame (closing defect 4), and already brackets the work with the
  panel-position snapshot, so every descendant's letter follows at any depth.
- **A group's demand is rolled up from its members.** `resizeGroupGeometry`
  applies one `(sx, sy)` at every depth — a nested group recurses with
  `sx' = target.width / old.width` and `target.width = child.frame.width · sx`,
  so `sx' === sx` — which makes `Gw · maxᵢ(minWidthᵢ / wᵢ)` an **exact bound,
  not an estimate**. `max` for comfort, since comfort is the size at which
  nothing is compromised and the hungriest member sets it; `max` for priority
  and never a sum, or five plots would outrank one 4000 px micrograph and invert
  what the measurement says. Every ratio is dimensionless, so the aggregate is
  scale-invariant — which is what keeps `rescoreCandidate` reporting the numbers
  the solve did.
- **A group takes a single ratio, and here that is exact.**
  `resizePanelGeometry` does **not** honour `aspectLock` — verified, it assigns
  the frame and re-tiles — so a non-uniform group scale does not bend a member's
  lock, it hands a montage a wrong-shaped frame that `fillPanelChildren` fills:
  round 41's dead strip, with the group as the cause. Pinning the group to its
  own ratio forces `sx === sy`. The trigger is a descendant's lock **or** a
  montage shape, because an `autoFit` montage has no stored lock after round 41
  demoted it and is distorted just the same. And the group's fixed bands are
  zero, which inverts round 41's lesson rather than ignoring it: under a uniform
  scale every extent inside scales together, bands included, so this is the one
  place a single ratio is right at every size.
- **`marginMm` reads absolute frames over every panel.** It skipped
  `parentId !== null`, so a figure whose panels were all grouped matched nothing
  and reported a 0 mm margin — which let a heading be pushed into the bleed.

#### Two levels of reading order, and why they may disagree

Unit order and panel order are not two granularities of one answer: a tall group
beside a short panel can order its lower member after the neighbour's panel, and
that is correct output. So `readsInOrder` stays a **unit-level** guarantee with
no panel-level analogue — adding one would silently refuse the first real
grouped figure for a property the letters already satisfy. Lettering is whatever
`relabelPanels` computes from absolute frames, which is by definition the order
the page reads.

#### An honest consequence, measured rather than hidden

Keeping a group together means its internal spacing scales with it. Measured on
the reproduction: the gap inside the group went 10 → 3.6 mm against a 9 mm page
gutter, so `uneven-gutters` fires and readiness reads **95 against 96**. That is
the figure the author asked for — a group is a unit whose internal arrangement
is theirs — and the checker is right to say the gutters are now uneven. Not
suppressed.

**Not done, deliberately:** a group holding no panel at all is not a unit and is
left where it is, exactly as a loose `shape` is — moving it would need a rule
about what it belongs to that the document does not carry. The score cannot see
*inside* a group beyond that gutter: `bandWaste` and `whitespace` read unit
frames, which is right, since round 40's term measures the strip the *solver*
creates. `reserveSpaceForGroupLabels` and `reserveSpaceForScaleBars` still
filter to top-level panels, so a heading over a grouped panel still reserves
nothing — pre-existing, and the next thing to do here.

**No schema change.** `LayoutUnit` and `UnitDemand` are derived per call and
never serialised; every document field written is one written today.
`SCHEMA_VERSION` stays 1.

### Round 43 — panel-first navigation

Reported: it is hard to track a panel and the elements belonging to it once a
figure has a few panels. Asked for everything relevant to a panel grouped under
its banner, a panel title that matches the panel *letter* and reads the same in
Layers, Inspector and Stats, a dropdown to jump between panels, the Data tab's
"used by 1 panel" to name the panel, and the Layers list to say which panel each
item belongs to.

**No model, schema or renderer change whatever.** The letter is already
`PanelNode.label`, refreshed by `relabelPanels` on every layout change, and
`SCHEMA_VERSION` stays 1. This round is a `doc-model` query module plus the four
surfaces that read it.

#### The Layers tab could not have grouped by panel, and the reason is structural

`DEFAULT_LAYERS` is **five** layers, and `layerId(draft, …)` files one panel's
own material across up to four of them: its panel and plot in `Graphs`, its
tiles in `Images`, its scale bar and arrows in `Annotations`, its brackets in
`Statistics`, its letter and any heading in `Labels`. **Measured on the sample
before anything was changed**: panel *b*, the micrograph montage, occupied
**four** sections — Graphs, Images, Annotations, Labels — and appeared as one
thing nowhere; the other six occupied two each. So panel grouping cannot nest
*inside* layer grouping; the panel has to be the outer level, and the layers
keep the only control that was ever theirs — show and lock — in a chip strip
above the list. That was put to the user as a choice and is what they chose.

#### One vocabulary, because there were five

`packages/doc-model/src/ownership.ts` is the single answer to "which panel does
this node belong to", which a figure reaches five different ways:

| node | how it reaches its panel |
|---|---|
| `plot`, montage `image`, anything parented in | the `parentId` chain |
| `scale-bar` | the same chain, **two** hops, through its image |
| `panel-label` | its `panelId` — a letter is *top-level*, not a child |
| `bracket` | `plotId` → that plot's parent, also from top level |
| `group-label` | `memberIds`, which may name **several** panels |

Before this, `provenance()` inside `LayersTab` was the only place unifying any
of them — UI-local, returning a display string, and missing `group-label`
entirely. Four decisions are written into the replacement:

- **`panelsOwning` is a flat switch, never recursive.** A `group-label`'s
  members resolve through `panelViaAncestors`, whose zeroth step is "the node
  already *is* a panel", so nothing can descend into another group-label and it
  terminates by construction.
- **`groupNodesByPanel` is an exact partition**: a heading spanning two panels
  is filed under the first only. `panelsOwning` still reports both — that is
  what a row's subtitle reads — but a list showing one heading twice is a worse
  answer than one that puts it somewhere definite. Pinned by a property test
  over every node in the fixture.
- **Order comes from `readingOrder`, not a second rule.** It already sorts on
  `absoluteFrame`, so a grouped panel lands where the page reads it — round 42's
  correction inherited rather than re-derived. `panelsInReadingOrder` is also
  what ranks several letters correctly, since `a`…`z`, `aa` does not sort
  lexicographically past 26 panels.
- **`panelTitle` suppresses `addPanel`'s auto-generated name**, which is a
  *number* (`Panel 3`) — so an unrenamed panel would otherwise read
  `Panel a — Panel 3`, pairing the letter the figure is known by with a counter
  it is not. A display-only heuristic, and safe as one because its false
  positive is the better string anyway.

**`panelsOf` (`document.ts`) was deleted in the same change.** Zero callers in
`packages`, `apps` or `scripts`, no test, and it sorted on raw `frame` — the
exact defect round 42 fixed in `readingOrder`, sitting unused and waiting for
its first caller.

#### What each surface now reads

- **Layers** groups by panel, the banner *being* the panel's own row rather than
  the panel appearing a second time as a child of itself. `<details open>` keyed
  on the panel id, so the browser owns the open flag and no state hook is added.
  Rows sort by `(layer z, node z)` — real draw order — and each row's `title`
  names its layer, since the layer is what ▲/▼ reorder *within*.
  `provenance()` loses its panel branches and keeps the rest: the panel is the
  banner now, so repeating it per row is exactly the redundancy its own `image`
  case has always refused ("six micrographs all reading 'panel a'"). It gained
  the one fact a banner cannot carry — the other panels a spanning heading
  covers.
- **The Inspector** gains a `Go to` navigator: every panel a top-level option,
  its contents indented under the same `<optgroup>`, built from the same
  `groupNodesByPanel` the Layers list draws so the two cannot disagree. It moves
  the *selection*, not a second notion of "current".
- **Stats**'s existing dropdown is relabelled **Panel** and reads `panelTitle`.
  A panel holding more than one plot gets one option per plot with the plot's
  name appended — the label says Panel, so it must not silently annotate one of
  two. Its options are also now in reading order rather than insertion order,
  which is the same class of mistake that once let Run annotate panel *a* while
  panel *c* was selected.
- **Data** names the panel instead of counting. `plotsUsingDataset` returns
  *plots*, so "used by 1 panel" was already counting the wrong thing; it now
  reads `used by panel a` / `used by panels a, c`, each letter selecting that
  panel. The asset list said *nothing* when an image was in use and now reads
  `on panel b`.

#### One pre-existing bug, closed because this round adds a second route to it

`App.tsx` wrapped `onSelectionChange` for the **Canvas** alone so that selecting
something else closes crop, measure and label-pick — *"leaving the overlay up
over a node that is no longer selected is an invisible mode"*. The **SidePanel**
and the **Toolbar** got the bare setter, so clicking a Layers row mid-crop
already left the overlay up. Hoisted into one `selectNodes` callback and given
to all three. Confirmed live in both directions: cropping a montage tile and
then jumping away through the navigator closes the overlay.

**Not done, deliberately:** the Quality tab's findings still name nodes rather
than panels, and its "Select N affected" is unchanged — it was not reported and
`Finding.nodeIds` can span panels, which needs its own wording. There is no
"group by layer" toggle: the measurement above says the layer view cannot show a
panel as one thing, and shipping both would be two answers to one question. The
navigator lists every node in a panel rather than a filtered subset, which on a
very large montage makes a long `<select>` — a real limit, and a scrolling
native select with type-ahead is still better than what it replaces.

### Round 44 — the Stats tab showed every panel's result at once

Reported: run a test on one panel, then another on a different panel, and the
first panel's result stays on screen. Only the selected panel's should show.

**The tab was already scoped everywhere except this one line.** The Panel
dropdown, the test list, every "there is no test to run here" notice, the
volcano-test methods block and the run notice all follow `activePlot`. The
results list read `const analyses = doc.analyses` — the whole document — so
every test run in the session stacked up below the button, oldest first, told
apart only by a small `.panel-tag` letter that had been added the day before as
a mitigation for exactly this. Scoping it to `activePlot` is the actual fix, and
`replaceAnalysisForPlot`'s one-analysis-per-plot rule makes it at most one card.

Confirmed with the user: **nothing** is shown about other panels — the dropdown
is the navigation — and an analysis whose plot is deleted is **deleted with it**
rather than left invisible.

- **Nothing usable was lost by hiding the rest.** `run()` always targets
  `activePlot`, so another panel's card was displayed but never actionable: it
  could not be re-run from where it was shown. It is now neither.
- **Staleness stays figure-wide.** `checkStaleAnalyses` walks every analysis and
  emits an **error**-severity finding per stale one, which also gates export.
  That, not this list, is the surface that stops a stale result elsewhere going
  unnoticed, and it is untouched.
- **`.panel-tag` stays** even though the dropdown above now names the same
  panel. The redundancy is the point: it is what confirms the card on screen
  belongs to the panel named at the top, and it keeps a screenshot of the result
  self-identifying.

#### A second leak, reported after the first fix shipped

Scoping the list was not the whole bug. Reported next: run a test on panel *a*,
select the volcano panel, and *"it shows that 2 bars were added to panel a"*;
run one on *e*, select *f*, and *e*'s details are still there.

**Reproduced before changing anything, and the dump isolated it exactly**: after
switching panel the cards really were empty — `cards: []` in every case, so
round 44's own fix held — while `notice` still read
`2 brackets added to Panel a — Expression.` The **run notice** is component
state, not anything derived from the document, so nothing in a document-level
filter could reach it. It says what one action did to one panel, and left
standing under a different panel it reads as a result belonging to that panel.

**A false lead, and what it actually meant.** The first reproduction appeared to
show the notice clearing when the panel was changed on the canvas but not from
the dropdown — an asymmetry that would have pointed at `selectionEcho`. It was
an artefact of the test: reaching the canvas meant visiting the Layers tab,
which **unmounts `StatsTab` and destroys its state**. The notice survived every
in-tab route equally.

The echo is therefore keyed on **`activePlot`**, not on the canvas selection —
the dropdown reaches that and `selectionEcho` above it does not — and it
*clears* rather than hides, so returning to panel *a* later does not resurrect
confirmation of an action long finished. Same render-phase pattern as
`selectionEcho` directly above it, so it needs no effect.

#### Deleting a plot takes its analysis, and that needed the brackets too

`deleteNode` never touched `draft.analyses`, and only the web app's
`deleteNodesWithLayout` swept brackets. So deleting a panel left an `Analysis`
naming a node that no longer existed — now invisible, unre-runnable, still
written into the `.ffg`, and still able to raise a stale-analysis error with
nowhere to act on it. The sweep went into `deleteNode` so all four delete
pathways and every programmatic caller get it from one place. Two rules, and
**measurement showed each reaches a case the other cannot**:

- **A bracket follows its plot into the doomed set** — the missing sibling of
  the `panel-label` and `group-label` rules beside it. It is the only one that
  reaches a bracket carrying `analysisId: null`, which is legal: a bracket can
  be placed by hand. It also closes a gap predating this round, where
  `deleteNode` called directly left every bracket behind.
- **Then any bracket still naming a removed analysis**, mirroring
  `removeDataset`'s own sweep. This is *not* a defensive duplicate: **`duplicateNode`
  remaps a copied bracket's `plotId` to the copy but deliberately shares its
  `analysisId` with the original** (copying a figure element must not fork its
  data), so deleting the original panel orphans an analysis the *copy's* bracket
  still names — and the copy's plot is not doomed, so the structural rule cannot
  see it.

**The consequence is worse than "the save is refused", which is what the first
draft of these comments claimed.** `checkReferentialIntegrity` runs on **load**
(`archive.ts:275`), not on save. A stranded bracket therefore writes a `.ffg`
without complaint and then throws `ArchiveError: Project file has broken
internal references.` when the author tries to open it. Established by removing
the backstop and watching a real `saveArchive` → `loadArchive` round trip throw,
rather than by asserting the predicate — which is why that test asserts the
round trip.

An analysis with **no** `plotId` is named by nothing and is never doomed; it is
also never shown by the scoped list. A narrow, stated consequence: the field is
optional only so pre-`plotId` documents load unmigrated, every creation site in
the repo sets it, and such a record was already unactionable before this round.
Undo needed no work — `store.ts` records the array replacement and its inverse
through `produceWithPatches`, exactly as for `removeDataset`.

**Not done, deliberately:** `deleteNodesWithLayout`'s own bracket sweep stays as
a backstop for any other route a plot can vanish by. Nothing collects an
analysis already orphaned in an existing project — but such a record was
undisplayable *and* unre-runnable before this round too, so no capability is
lost, and any delete from now on cannot create one.

### Round 45 — "Send to back" stopped at the floor of its own layer

Reported: a filled rectangle drawn over a graph will not go under it when Send
to back is pressed. Reproduced against the real app before anything was
changed, and the cause is one term in a sort.

**A top-level node's draw order is `(layer.z, node.z)`, and `reorderNode` only
ever permuted `z`.** `addShape` creates a rectangle in **Annotations** (layer z
2) while `addPanel` puts a graph in **Graphs** (z 1), so the layer comparison
decides the outcome before `z` is ever read: the button moved the rectangle
correctly to the bottom of its own layer, where it was still drawn over every
graph and image on the page. Sending it back put it *behind the other
annotations* and nothing else, which reads as a button that does nothing.
Measured on the sample: after the press the rectangle was at `z = 0` of 18
top-level nodes and still the 18th thing painted.

- **`compareDrawOrder` (`document.ts`) is now the one statement of that
  order**, read by the renderer's `rootNodesInDrawOrder` and by `reorderNode`.
  Two copies is exactly how they came to disagree about which end "the back"
  is — the same one-place discipline `scaleBarWidthMm`, `y2WidthMm` and
  `analysisInputHash` are each held to. It also states the half that is easy to
  miss: **a parent's children carry no layer term at all**, so a montage tile
  or a plot inside a panel orders on plain `z`, and `reorderNode` was already
  right for them. Only the top level was wrong.
- **A top-level node therefore changes layer when it passes a boundary**,
  adopting the layer of whatever it comes to rest against — the node above it
  when moving up, below it when moving down. That is what the button says it
  does and what every editor does at a layer boundary, and it leaves the
  Illustrator-style grouping intact: layers still stack globally, the object
  has simply moved to a different one. A figure whose top-level nodes all share
  one layer is byte-identical to before.
- **It stops rather than stepping into a hidden or locked layer.** A
  draw-order command must not make an object invisible or unselectable as a
  side effect, and both are reachable from the Layers tab's own chip strip. The
  node lands in the last layer it may legally reach, which may be the one it
  started in — and because the renumbering runs over the *whole* top level
  regardless, it still ends up as far back as it can legally go rather than
  refusing the press.
- **It rests against a node, not an empty layer.** Sent to back on the sample
  the rectangle lands in **Graphs**, not the empty Images layer beneath it:
  what it must get under is the bottom-most thing *drawn*, and an empty layer
  is nothing to rest against.
- **Renumbering still runs `0..n-1` across the whole top level**, unchanged.
  Safe across layers because each layer's nodes are contiguous under the
  `(layer, z)` sort, so no other node moves relative to its own layer-mates —
  asserted directly (every other node's painted position is unchanged) rather
  than argued.
- `forward`/`backward` cross a boundary the same way, one node per press.
  Stopping them at the layer floor would be the same defect in slower motion,
  and the Layers tab's row tooltip — which said the layer is what ▲/▼ reorder
  *within* — was corrected with it.

**No schema change, no new field, no `SCHEMA_VERSION` bump** — `layerId` has
been required on every node since phase 1 and this is the first code that
rewrites one.

Driven in a real browser, light **and** dark, **14 checks each**. **Measured
the way a reader sees it, not off a model field**: the probe is
`elementsFromPoint` at a point where the rectangle and a drawn bar genuinely
overlap, so it reports what is actually painted on top. Before the press the
rectangle was topmost and 18th in document order against the panel's 1st;
after it the *bar* is topmost, the rectangle is the first node drawn on the
page, and one Ctrl+Z puts it back over the graph. Bring to front returns it;
stepping backward with the ▼ button reaches the same place in 14 presses, one
node at a time. The export agrees: a single-page 151 KB PDF, and the exported
SVG writes the rectangle before the plot's marks, so the file matches the
screen. Readiness stays 96 with no console errors in either theme.

**A live-test trap of my own, worth recording.** The first run probed
`elementsFromPoint` at the *rectangle's own centre* and reported the rectangle
on top even after the fix — a bar chart paints nothing between its bars, so
there was no panel ink at that point to be on top of it, and every check would
have passed either way once the direction was reversed. The probe now searches
for a mark whose box actually intersects the rectangle's, and asserts it found
one.

**Not done, deliberately:** there is still no way to author a layer, rename
one, or move a node to a named layer directly — this changes `layerId` only as
a consequence of a draw-order press. The Layers tab keeps its own display
comparator: its rows under a panel banner can come from *different parents*, a
mixed list `compareDrawOrder` deliberately does not answer, since a child and a
top-level node are not in one draw order to begin with.

### Round 46 — a volcano's point-label limit is the author's to raise

Reported: a figure sometimes needs to name more points than FigureForge allows.
It allowed 25 — `MAX_POINT_LABELS`, a round-7 constant whose stated reason is
that "past this a key stops being readable and the leaders cross". That is a
good default and was a poor absolute: whether a figure calling out an entire
regulated pathway is readable is the author's judgement, and there was no way to
express it. The Data tab's "Label these rows" button disabled itself at 25, a
canvas click at the cap was a silent no-op, and the Inspector said the maximum
was reached.

- **`PlotNode.pointLabelLimit`, optional, absent = 25.** The additive pattern
  every field since phase 1 has used, so `SCHEMA_VERSION` stays 1 and no saved
  figure moves. Mirrored into `schema.ts` as well as the TS type, or zod strips
  it on save — pinned by a round-trip test that was confirmed to fail when the
  schema line is removed.
- **No `.max()` in the schema, deliberately**, for the reason already written on
  `volcanoLabels`: `loadArchive` throws on a validation failure, so a bound there
  would make a hand-edited file **unopenable** rather than merely
  over-ambitious. The ceiling is applied when the value is *read*, and a test
  loads a `pointLabelLimit: 100000` archive to prove it still opens.
- **`pointLabelLimit(node)` in `render-document.ts` is the one composition.**
  The number had been spelled at six sites across four files — the renderer, the
  canvas's cap test *and* its tooltip, the Data tab's disabled reason, the
  Inspector's hint and the Quality tab's disclosure — three of them as the
  literal "25" inside a sentence. That is exactly the drift `scaleBarWidthMm`,
  `y2WidthMm` and `analysisInputHash` are each composed once to avoid; all six
  now read this. It lives beside `resolvePointLabels` rather than in
  `point-labels.ts`, whose header states its only import is `text-width.js` and
  which is deliberately pure geometry knowing nothing about `PlotNode`.
- **`layoutPointLabels` needed no change at all.** `LabelLayoutOptions.maxLabels`
  has existed since round 7 and already truncates in a defined order; it was only
  ever called without it. And because `volcanoLabelCandidates` sorts by
  descending -log10(p), then |fold change|, then label, and the cap truncates
  *after* that sort, raising the limit adds the **next most significant** names
  deterministically — the canvas and the export agree, and re-selecting the same
  genes in a different order changes nothing.

#### The ceiling, which is the only real risk here

An unbounded field is not safe. Per label, placement tries 8 directions adjacent
then up to 8 push rings x 8 directions — 72 attempts — and each attempt's
`fits()` linearly scans the placed rects, the leaders and the marker obstacles.
The obstacle set is the part that bites: `resolvePointLabels` pre-filters the
point cloud to a box around *all* candidates, which is tight for 25 clustered
hits and admits nearly the whole 10,000-row cloud once labels spread across both
wings. `Canvas.tsx` renders the document unmemoised and `placedPointLabelsForPlot`
resolves the same placement again for drag hit-testing, so the cost is paid about
twice per interaction frame.

`scripts/point-label-cost.ts` measures it rather than arguing it, and its numbers
are on the constant:

| labels | engine | end to end | drawn |
|---|---|---|---|
| 100 | 12.9 ms | 15.8 ms | 32 |
| 200 | 25.0 ms | 37.7 ms | 43 |
| 400 | 67.9 ms | 36.6 ms | 60 |
| 600 | 118.6 ms | 38.2 ms | 60 |

"engine" hands `layoutPointLabels` the whole cloud; "end to end" is the real
path with its filter. **The engine column is what the ceiling rests on**, because
that filter stops helping exactly when an author labels points spread over the
whole plot — the case that has to survive. At 200 that is ~25 ms, so ~50 ms a
frame with real headroom; at 400 it is ~68 ms, so ~136 ms, and a drag would
stutter. The second half of the argument is that a higher ceiling buys nothing:
`drawn` saturates at 60 by 300 labels and does not move through 1200. Hence
**`MAX_POINT_LABEL_CEILING = 200`**, eight times the default and far past any
realistic need.

**Deliberately not done:** replacing the linear obstacle scan with a spatial
bucket grid. It would raise the ceiling a lot and `Canvas.tsx`'s own
`PICK_BUCKET_MM` hit-test map is precedent for the idiom, but it changes a
function every figure's label placement depends on and would have to be proven
byte-identical first. Named here so it is not mistaken for an oversight; the
trigger for it is an author who needs more than 200.

#### The drawn count, which the raised limit makes necessary

An unplaceable label is dropped rather than overprinted — deliberate, and round
7 already observed 30 selected drawing as 17. Once the limit rises that becomes
confusing: raising it looks like it did nothing whenever the extra names do not
fit. The Inspector's hint now reads `N of LIMIT selected · M drawn`, with `M`
from the existing `placedPointLabelsForPlot` — the same function the canvas uses
for hit-testing, itself `resolvePointLabels`, so the count cannot disagree with
what is drawn — and says plainly when names were left off and what would fit
more. It is memoised on `[node, doc, theme]` exactly as `Canvas.tsx` does, since
it runs a full `computePlotGeometry`. The Quality tab's own figure-wide
`checkPointLabelPlacement` disclosure stays; this is the same fact where the
author is actually choosing labels.

**Setting the field back to 25 removes it** rather than storing the default, the
same "clearing the last override removes it entirely" rule `pointShapes`
follows, so a figure only carries the field if its author moved it.

#### One pre-existing subtlety, left alone

The cap counts **candidates**, and `volcanoLabelCandidates` emits one per
matching *point* while `volcanoLabels` counts *names*. A duplicated feature name
(two probes for one gene) therefore consumes two of the limit while reading as
one selection. That follows from round 7's deliberate choice to label every
matching point rather than misattribute one, and is not changed here.

#### Two traps of my own, both found by measuring

- **The first cost script drew its point cloud uniformly over the plot**, which
  places *nothing* — every position is blocked — so it was timing `fits()`
  short-circuiting on its first obstacle rather than the cost of placing a
  label, and reported a flat "0 placed" at every count. A real volcano is a
  dense blob of null genes with the significant ones sparse in the wings, and
  the labelled points sit in the sparse region where `fits()` must scan the
  whole obstacle list before returning true. That is both the expensive case
  and the only one that draws anything. The generator now produces that shape.
- **`updateNode` takes a patch object, not a callback.** Passing a function
  makes `Object.assign` copy nothing, so the measurement harness set no labels
  at all and every end-to-end row read zero — and `vite-node` does not
  typecheck, so it ran silently. Found by probing the path rather than by
  re-reading the script.

---

### Round 47 — a fold-change vs fold-change plot

Requested with a reference figure (`reference-and-test-files/Picture 1.png`): a
proteomics scatter of the same feature's log2 fold change in **two** contrasts —
97Q/25Q against 97Q/APEX — a grey cloud with the significant proteins in red,
dashed lines through zero on both axes, and named points with leaders.

FigureForge could not draw it. The nearest type is the volcano plot, whose y
axis is a −log10 transform of a p-value: pointed at two fold-change columns it
would take −log10 of a negative number, silently dropping every
down-regulated protein and ordering the survivors by magnitude rather than by
value. That is the whole reason this is a separate plot type rather than a
volcano with different colours.

**Decisions taken with the user:** two-colour significant/not by default with a
**Colour by** dropdown offering quadrants, and a swatch for every significant
class; **zero lines and cutoff lines each independently toggleable**; and
correlation offered on this plot.

#### Most of it already existed

Established by reading before writing, and it is why the round is small:

- **The point-label surface was already generic.** `resolvePointLabels`,
  `layoutPointLabels`, `pointLabelLimit`, `pointLabelOffsets`,
  `pointLabelSizePt` and the Inspector's own label block name nothing
  volcano-specific — only the *gates* on them did. Six of those now read one
  `LABELLED_POINT_PLOT_TYPES` set in `nodes.ts`, spelled beside the union for
  the reason `CONTINUOUS_X_PLOT_TYPES` is: six copies of a plot-type test is
  six chances for the next labellable type to reach five of them.
- **Correlation cost nothing.** `correlationPossible` already reads
  `series.length === 1 && series[0]?.x !== undefined && !differential`, and a
  fold-fold dataset satisfies it — only `differential` is excluded, and for a
  stated reason that does not apply here (both axes are effect sizes this app
  never computed a significance value for). Verified by reading the gate *and*
  live: the Stats tab offers Pearson, Spearman and linear regression and
  returns `r² = 0.58`.
- **Rasterization was free.** A real gene list is 2,000–8,000 features, over
  `MAX_VECTOR_POINTS`, and `planPointClouds` bakes per-point colour into the
  raster already. It resolves colour through exactly one function — the one
  generalised below — which is what kept this to a rename.

#### `volcanoLabels` is reused, and the misnomer is deliberate

A fold-fold plot names its points through the same field. Renaming it would be
this project's first schema migration, bought for a nicer name; a parallel
`foldFoldLabels` would fork all eight call sites that read it — the Data tab's
action, the canvas overlay, two quality rules, the Inspector block and three
render helpers. The field's own doc comment records both the reuse and why the
name survives.

#### Quadrant mode implies AND, by construction rather than by policy

`foldFoldCategory` (a new `packages/plots/src/fold-fold.ts`, its own module
because `volcano.ts` is about significance measured against effect) takes a
cutoff per axis and a `rule` of `'both'` or `'either'`. The rule applies to the
two-colour mode **only**: a point clearing x but not y has a direction on one
axis and none on the other, so it belongs to no quadrant and there is nothing
to colour it. So quadrant mode does not read `rule` at all, and the Inspector
hides that control there rather than offering one that does nothing — with a
unit test asserting `rule: 'either'` is ignored in quadrant mode, which is what
pins the UI decision to the maths rather than to a comment.

#### Two kinds of dashed line, kept apart

`renderFoldFoldLines` draws zero lines (`'zero-line'`, a new role) and cutoff
lines (the existing `'threshold-line'`), each on its own toggle, defaulting to
zero-on and cutoff-off — four cutoff lines plus two zero lines is a busy panel,
and the colours already say where the cutoffs fall. The roles are distinct
because the two say different things, a quadrant boundary against a
significance boundary, so a count of one must not include the other.

Every line goes through the same in-bounds test `renderVolcanoThresholds` uses,
and for the same reason: **a scale extrapolates outside its domain rather than
returning NaN**, so a cutoff — or a zero — the data never reaches would be
drawn beside the panel. Measured live: a cutoff of 50 on data reaching 3.5
draws *no* x lines while the two y lines, still in range, stay.

#### Axis titles: the opposite choice to volcano's, for the stated reason

`addPlot` hardcodes a volcano's titles because the fold-change column is spelled
inconsistently and the y axis is a transform of the p-value column, so neither
header names what is drawn. Here both columns are plotted exactly as they
arrive and their headers *are* the axis names an author wants, so
`axisTitlesFor` gained a branch returning columns 1 and 2 by name — through the
same placeholder filter (`usableAxisName`, lifted out rather than copied) that
rejects the `A`/`B` a header-less paste produces. Confirmed live: both axes
read `97Q/25Q fold enrichment` and `97Q/APEX fold enrichment`.

#### Label ranking is in data space, not millimetres

A volcano ranks candidates by significance then effect; a fold-fold plot has no
significance value, so it ranks by **distance from the origin** — the one
ordering that treats the two contrasts symmetrically, as the plot does. Both
are computed through `xScale.invert`/`yScale.invert` rather than from the drawn
positions: a panel's aspect would otherwise decide which protein is "further
out", so the same figure resized would label a different set once the cap binds.

#### One real gap, found by running it

**The Data tab's "Label these rows" action was still volcano-only.** The plot
drew labels perfectly and the Inspector offered the picker, but the grid's own
route silently did nothing — `volcanoPlot` was found by
`n.plotType === 'volcano'`. It now reads `LABELLED_POINT_PLOT_TYPES` and is
named `labellablePlot`. Invisible to 1,171 green tests and to reading the
renderer, because the defect was in the one surface neither covers.

#### Two harness traps of my own

- **The first live run counted colours across every panel on the page**, and
  reported a sample bar-dot panel's palette as though it were this plot's —
  "76 red against 17 computed". Every count is now scoped to the imported
  plot's own `<g data-node-id>`, found from a planted protein name only the
  generated table has.
- **A mouse click cannot reliably hit a 0.45 mm marker** (~1.7 px at this
  zoom): a single click on one reported "Nothing selected". The plot is now
  selected through the Inspector's own "Go to" navigator by node id — exact,
  and a route a real user has.

Also measured, and worth recording because it is *not* this round's doing: a
2,500-row paste takes ~30 s and a 3,000-row one ~40 s, because the paste box
re-parses the whole table on every change. Confirmed **format-independent** —
a plain replicate table of the same size is just as slow — so it is a
pre-existing property of the import preview, not something this plot type
introduced. Named here rather than fixed, since it was not what was asked for.

**Not done, deliberately:** no p-value or FDR column for this format (both axes
are effect sizes; significance here is the author's stated cutoff, which is
what the request asked for); no diagonal *y = x* reference line, which the
reference figure does not have; no density or contour shading of the cloud.

---

### Round 48 — the correlation line, with an optional confidence band

Reported: on scatter plots and the new fold-vs-fold plot, the correlation line
from the stats analysis should be drawn, with confidence intervals as an option.

Running Pearson or a regression put a p-value and an r² in the Stats table and a
sentence in the methods block and **nothing whatever on the canvas**. The run
notice said as much — *"the result is in the table below. A numeric x axis has no
categories to span, so no bracket is drawn."* — which is right about brackets and
wrong as a final answer: what a reader of a correlation figure looks for is the
line.

**Decisions taken with the user:** a None / Confidence / Prediction dropdown
defaulting to None; **Spearman draws no line**, with the reason stated; line
extent is a **control** (the data's x range, or the whole axis); and the equation
stays in the Stats tab rather than becoming an on-plot label.

#### The service was throwing the answer away

`tests.py` has called `sps.linregress(x, y)` since phase 5 and kept only
`fit.slope`, as the generic `Comparison.statistic`. **There is nowhere in that
shape for an intercept**, so a stored `linear-regression` analysis was not
sufficient to draw its own line — this could not have been a render-only change,
and reading the code rather than assuming is what established that before any
was written.

- **`TestOutcome.fit`, a new optional `RegressionFit`** carrying ten *sufficient
  statistics* — slope, intercept, n, meanX, sumSquaredDevX, residualSe,
  tMultiplier, confidenceLevel, xMin, xMax. The client evaluates
  `y = a + bx` and `t·s·√(k + 1/n + (x−x̄)²/Sxx)` (`k = 0` confidence, `k = 1`
  prediction) exactly at any x.
- **Ten numbers rather than a sampled polyline**, which is the shape
  `volcanoSamCurve` is stuck with. That boundary needs an incomplete beta to
  evaluate, so it can only travel as points; this needs nothing but arithmetic
  once `tMultiplier` — the one term requiring a t quantile — is resolved
  server-side beside SciPy. Two consequences worth having: the band is exact at
  every x rather than to within a sampling interval, and it re-renders correctly
  when the axis range changes.
- **Pearson carries the same fit; Spearman carries none.** r measures how
  tightly the pairs sit on a straight line, so the line is what the reader is
  being asked to judge. Spearman measures a monotonic relationship between
  *ranks*, and a least-squares line through the raw values would claim a
  linearity the statistic never tested — withheld, never approximated, the
  stance Fisher's above 2×2 already takes. `packages/plots/src/summary.ts`'s own
  header is the rule this follows: *"inferential statistics come from the Python
  service; nothing here decides significance."*
- **`tMultiplier` is `t.ppf(1 − alpha/2, n−2)`**, the same call the slope CI
  already makes, so the band follows the **analysis's own alpha** rather than a
  hardcoded 95%.
- **Refused whole, never partly.** No fit below three pairs (df ≤ 0: the line
  passes through both points by construction), none when every x is identical,
  and `main.py`'s `_fit_out` collapses the object to `None` if any term fails
  `_sanitize` — mirroring how `ci` is already handled, because a band drawn from
  a record with one NaN in it is not a narrower band but a wrong one.
- **The zero-variance test runs *before* `linregress`, and that ordering is
  load-bearing.** `linregress` *raises* on identical x while `pearsonr` returns
  NaN quietly, so fitting first would have turned a Pearson request that has
  always succeeded into a 422 as a side effect of adding a line to draw. Found
  by a test failing, not by reading.

#### The fit lives on the analysis, not the node

`PlotNode.volcanoSamCurve` is the precedent for storing a server result on the
node, and it exists precisely because a volcano test is deliberately **not** an
`Analysis`. A correlation is one. Storing the fit on `StatResult` means it is
already joined to the plot by `plotId`, already replaced rather than accumulated
by `replaceAnalysisForPlot`, and already covered by `checkStaleAnalyses` — three
mechanisms inherited rather than rebuilt. `renderPlot` has `doc` in scope, and
`quality.ts` already reads `doc.analyses`, so nothing needed a new channel.

#### Drawing it

- **`resolveTrendFit` is the one place a stored fit becomes geometry**, called
  once from `renderPlot` and its two halves spliced at two points of the
  emission array: the **band before `renderContinuousMarks`** so the cloud reads
  over it, the **line after** so the fit stays legible against a dense scatter.
  One resolve, two placements — the discipline that has `resolvePointLabels`
  serve both the drawing path and the drag hit-test.
- **Sampled at 64 evenly spaced *millimetre* positions, inverted back to data.**
  A straight line in data space is a curve on a log or symlog axis, and two
  endpoints would draw the chord — wrong in the direction that overstates the
  fit near the ends. Sampling in millimetres rather than in data gives uniform
  on-page resolution whatever the scale kind, and the line and its band share
  one sample set, so the line cannot appear to cross its own band.
- **Withheld entirely on an axis carrying a break.** A break says a range is not
  shown; a line straight across the gap asserts a continuity the axis has
  already ruled out, and the fit was computed over the removed values too. One
  condition, stated in the Inspector, rather than splitting both the line and the
  band into runs for a combination nobody asked for.
- **The band's y is clamped, not clipped.** It is x-simple — one vertical
  interval per x — so intersecting it with the panel is exactly what clamping
  each edge produces, and where the clamped edges cross the polygon closes on
  itself and paints nothing. `clipPolylineToRect` handles open polylines only,
  and an SVG `clipPath` would mean a `<defs>` block and per-node unique ids that
  neither adapter emits anywhere today. The prediction band at n = 11 genuinely
  reaches the panel edges, so this is the common path, not an edge case.
- **Both are drawn in `theme.foreground`, not the series colour.** On a
  fold-vs-fold plot the series colour is a palette entry the points never use —
  they are coloured per category — so a "series colour" line would match nothing
  on screen. The band's alpha is **0.15, not the error band's 0.25**: that band
  is filled in a mid-tone series colour and this one in the foreground, and black
  at the same value reads far heavier over a grey cloud. Confirmed by eye in both
  themes rather than asserted.
- **New roles `'trend-line'` and `'trend-band'`**, kept distinct from `'line'`
  and `'error-bar'` so a count of a series' own drawn lines or intervals cannot
  silently start including a fit. Both are outside `quality.ts`'s `MARK_ROLES`
  allow-list without any change, which is the right answer: drawn in the
  foreground colour, they would otherwise be compared against every series colour
  and report a conflict between the data and the ink the axes use.
- The line is **solid**. In this renderer a dashed stroke means a reference or a
  threshold, and the fit is neither.

#### One pre-existing gap closed, because this round makes it visible

`checkStaleAnalyses` populated `nodeIds` with **brackets only** — and a
correlation never gets one — so its error-severity finding carried an empty list
and its "Select N affected" button selected nothing at all. It now includes the
analysis's own `plotId`. The renderer deliberately does **not** re-hash and
refuse to draw a stale fit: that would put a hash of every input value inside
every render pass, and the checker already fires at error severity, which gates
export.

#### The gap found by running it

**An x/y table imports as a `line` plot** (`defaultPlotTypeFor('simple-xy')`), a
type this round deliberately does not draw a fit on — so the most ordinary path
to a correlation ran the test successfully and put nothing on the page, with no
Inspector block to explain it either. That silence is a defect whatever the
scope, so the run notice now distinguishes three outcomes: the line was drawn;
a fit was computed but this plot type does not draw one, *and here is what to
change*; or no line was fitted at all. Invisible to 1,200 green tests.

**Not done, deliberately:** `line` plots still draw no fit — the user named
scatter and the proteomics plot, a straight fit beside an already-drawn
connecting line is a different question, and `TREND_LINE_PLOT_TYPES` makes it a
one-word change if wanted. No colour control for the line or band. No non-linear
fits, no LOESS, no forced-through-origin. No on-plot equation label. And the
confidence band is genuinely **invisible at large n** — at 2,500 proteins the
line's position is known to about a hundredth of a unit — which is the statistic
being honest, not a defect; an author wanting a visible band at that n wants the
prediction band.

**Also found, and NOT fixed** — a different defect from the one reported:
`quality.ts` and `SidePanel.tsx`'s staleness displays both recompute
`analysisInputHash` with **three** arguments while the run path passes a fourth
(`events`) for `log-rank`. The function branches on `events !== undefined`, so
**every log-rank analysis is reported permanently stale at error severity, which
gates export**. Correlation is unaffected — its fourth argument is `undefined`,
taking the same branch as the 3-arg call, which is why this feature does not
arrive looking broken. Confirmed by reading both call sites; left for its own
round — **which is round 49, below.**

---

### Round 49 — every log-rank result reported itself stale

The defect round 48 found while exploring and deliberately left alone, now
fixed. It is one missing argument, and it made the app say a figure's data had
changed on a test run seconds earlier.

**Reproduced before anything was changed**, since "confirmed by reading" is not
the standard this file holds itself to: on R's `aml` dataset the run path stores
`753bee3d66414535` and both places that recompute the hash produce
`e0809e0aa32e7c98`. `analysisInputHash` branches on `events !== undefined`, so
the fourth argument does not merely change the input — it selects a different
`hashInputs` grouping — and the two could never agree.

**Measured on the running app, in both themes**: a freshly run log-rank went
straight to a `"log-rank on Survival by arm" no longer matches its data` error,
a `The data behind this test has changed` warning on its own result card,
readiness **84 against 96**, and the export confirmation dialog in front of
every attempt to leave the app.

- **`eventsForHash(test, dataset)` is `xForHash`'s twin**, and the fix is that
  all three sites now call it — including the run path, which had
  `survivalGroups` already in hand. Deriving it a second way there is exactly
  how the stored hash and the recomputed one came to disagree over nothing, and
  it is why the run path already calls `xForHash(series)` on the line above
  rather than reading `series[0].x`, which is equally available. One function
  cannot disagree with itself; three call sites reproducing a condition can.
- **It takes the dataset, not the `Series`** — and that asymmetry with
  `xForHash` *is* the root cause rather than an inconsistency. A subject's event
  flag has nowhere to travel in a `Series` (`toSeries`'s minimal `'survival'`
  case carries the times alone), so it has to be read from the table through
  `toSurvivalGroups`. That extra step is precisely what the two recompute sites
  had no way to know they were missing.
- **The condition mirrors the run path's own `survival && test === 'log-rank'`,
  both halves.** `toSurvivalGroups` reads columns positionally, so asking it
  about a table that is not a survival table would hash whatever happened to sit
  in the first three columns. Reproducing the condition is not a defensive
  guard; a test-name check alone would be a different, wrong function.
- `analysis.ts` gains a value import from `data.ts`, which was previously
  type-only. Checked rather than assumed: `data.ts` imports nothing but
  `nodes.js`, and nothing in it reaches back, so the edge is one-directional.
- **No schema change, no new field, no behaviour change to any other test.**
  A non-log-rank analysis takes the `undefined` branch, so its hash is byte-for-
  byte what it has always been — which is what keeps every already-saved
  project's `inputHash` valid, the same rule the `x` parameter was added under
  in phase 5.

**Verified:** 1203 TypeScript tests (1200 + 3 new: two in `doc-model.test.ts` —
the stored and recomputed hashes agreeing, and `eventsForHash` answering only
for log-rank on a survival table — and one end-to-end in `quality.test.ts`
asserting through `checkFigure` that a freshly stored result raises no finding),
204 Python tests unchanged (nothing here touches `services/api`), `tsc --build
--force` and `eslint .` clean, 46-check acceptance run unaffected, and **10
live-browser checks in each of light and dark**. **Each new guard was confirmed
to fail against the unfixed code**, and so was the live harness — reverted, it
reports the staleness warning, the Quality error, readiness 84 and the export
dialog, in both themes. A harness that passes either way would have proved
nothing here, since the whole claim is a negative.

**Not fixed, deliberately:** the staleness check still compares only the values,
the x and now the event flags — not the *options* beyond test and correction,
and not the dataset's column names. That is unchanged from phase 1 and was not
what was reported. Nothing collects an analysis whose stored hash was written by
the broken path: reopening such a project recomputes correctly and the finding
simply goes away, so there is nothing to migrate.

---

### Round 50 — column-wise distributions, cumulative curves, and the distribution tests

Requested: a new import layout for a series of groups (`Y1, Y2, Y3, …`) where
each column is its own stack of values — a Prism *Column* table — usable for
histograms and distributions per column, with tests such as
Kolmogorov-Smirnov, and cumulative histograms as an option. Four follow-up
decisions were settled with the user before any code was written: all four
distribution tests (KS, Anderson-Darling k-sample, Cramér-von Mises,
Epps-Singleton), not just KS; both cumulative forms — a histogram toggle
*and* a separate ECDF plot type; multi-group histograms offered as both
overlay and step outline, on shared bins; and the tests offered everywhere a
reading of the table supports them — brackets on the categorical readings,
a carve-out on histogram/ECDF — with the KS maximum-gap drawn on the ECDF.

- **`DataFormat` gains `'distribution'`, never auto-inferred** — the same
  stance `contingency`/`differential`/`matrix`/`proteomics` already take.
  Nothing at the cell level separates "one column of observations per group"
  from "a shared x and several y series" (`prism`), and detection guessing
  wrong here is worse than usual: the misread consumes the first column as an
  axis and drops it from the figure entirely, rather than merely mislabelling
  something. Placed directly under `replicate` in the layout dropdown, since
  the two are readings of one rectangle turned 90° from each other — a
  replicate runs across a row, a distribution runs down a column — and naming
  both in the hint is what lets an author tell which one their own table is.
  Columns are allowed to be **ragged**: a shorter group is a column with
  fewer numbers in it, not a row that has to be padded to match, needing no
  special handling beyond what `parseDelimited` and `columnKindFor` already
  do for any table with holes. `toSeries`'s `'distribution'` arm reads every
  column independently and deliberately never consults `ds.hasRowNames` — a
  distribution table has no label column by construction, but the flag can
  survive stale from an earlier xy-shaped declaration of the same paste, and
  reading it here would drop the first Y column as though it were a label.
- **`PlotType` gains `'ecdf'`, a separate type rather than a checkbox on
  histogram.** It has no bin count — the whole reason a histogram needs one —
  and it is literally the curve a Kolmogorov-Smirnov test is defined on: D is
  the largest vertical distance between two of these, so an author looking at
  the plot is looking at the quantity the p-value came from. `ecdfSteps`
  (`packages/plots/src/ecdf.ts`) is pure maths with no rendering in it,
  matching the `kaplanMeier` precedent exactly — ties collapse into one step
  rather than several zero-width risers, and it returns an empty array for a
  sample with nothing finite rather than a synthetic anchor, since unlike a
  survival curve's `(0, 1)` start an ECDF's flat run has no natural x of its
  own to begin at.
  - **It lives inside `continuousGeometry`, not as a copy of
    `survivalGeometry`.** Survival runs its own two-pass margin loop only
    because `computePlotGeometry` diverts to it *before* `toSeries` is ever
    called — a subject row carries an event flag `Series` has nowhere to
    hold. A sample column is exactly what `toSeries` already returns for
    `'distribution'`, so the ECDF branch sits where histogram's does and
    inherits `requiredMargin`, `renderAxes`, the legend and axis breaks
    completely unmodified.
  - **The y domain is hardcoded `[0, 1]`**, ignoring `node.y.min/max/scale`
    entirely — the same hard construction choice survival's curve already
    makes, for the identical reason: a cumulative proportion cannot leave
    that interval, so a narrower axis would crop a curve that is complete by
    definition. The Inspector's numeric y-controls, `showPointsRelevant`,
    `clipToRangeRelevant` and `secondAxisRelevant` all exclude it, matching
    survival's own treatment.
  - **The curve runs flat to both axis edges** — held at 0 left of the
    smallest observation, at 1 right of the largest. Not cosmetic: where two
    groups' ranges only partly overlap, the largest gap between their
    curves — the KS statistic — very often falls in the stretch where one
    group has no data at all, and without the flat runs that gap is simply
    not on the page.
  - **A deterministic vertex decimator** (`decimatePolyline`, 0.02 mm
    epsilon) drops a vertex within that distance of the last one kept on
    both axes, always keeping the first and last. A 10,000-row column is
    10,000 vertices in one `<path>`, and `planPointClouds` cannot catch it —
    it counts `s.points.length`, which is 0 for a line-only series like this
    one. Fixed-epsilon rather than a target vertex count so canvas and
    export decimate identically, the determinism every layout decision in
    this renderer is held to.
- **Multi-group histograms share one set of bin edges and are never pooled.**
  The old restriction — a histogram needs exactly one series — is gone, and
  so is the reasoning that used to justify it: pooling several groups into
  one set of bars invents a shape belonging to no group, which is still
  true, but the fix is to bin them *together* rather than to refuse more
  than one. `binEdges` computes one set of edges across every group's values
  combined; each group is then counted (`binCounts`) and transformed
  (`histogramValues`) against those shared edges, so two groups' bars land
  at identical `x0`/`x1` and can be compared honestly.
  - **A single-group histogram carries no `seriesIndex`** and populates no
    `geometry.series` at all — `renderContinuousMarks` pushes an unconditional
    `group({}, markChildren)` for every series, so giving a lone group an
    identity-only entry would add an empty `<g>` and break parity
    byte-identity with every histogram drawn before this round.
  - **`histogramStyle: 'overlay' | 'step'`** offers translucent filled bars
    or an unfilled staircase outline per group. Step drives a new
    `SceneRole 'histogram-outline'`, kept distinct from both `'bar'` (a
    role-count assertion for real bars must not silently include outlines)
    and `'line'` (nothing here connects one observation to the next — it is
    the boundary of a distribution, not a series). It is included in
    `checkColorAccessibility`'s `MARK_ROLES` for the same reason `'bar'`
    is — it is one group's data in that group's own colour, so switching
    style from bars to outlines must not silently exempt a histogram from
    the colour-vision check.
  - **`histogramCumulative`/`histogramNormalize` (`'count' | 'frequency' |
    'density'`)** compose in `histogramValues`, called once per group
    against the shared edges — the y domain and its tick step both read the
    *drawn* value, never the raw count, so a density histogram never ends
    up on an axis stating a whole-number tally. The generic "count axis
    steps by whole numbers" rule from phase 3 is now conditional on
    `normalize === 'count'` specifically, not on whether the histogram is
    cumulative — a cumulative *count* is still a whole number, and a
    cumulative *frequency* accumulates to exactly 1.
  - **`typesFor`'s histogram gate was widened**, and this was a real gap
    found while implementing rather than a planned change: it read
    `if (t.id === 'histogram') return single`, so a distribution table's
    several series would have hidden the one plot type whose default is
    `histogram` — the dropdown would have offered every type except the one
    that was just declared as the reason to import.
- **The four distribution tests, each guarded against a specific way SciPy
  fails quietly rather than loudly:**
  - **Kolmogorov-Smirnov** is two-sample, reported the `wilcoxon` way — a
    `Comparison` with no df, no CI and no effect size, since D *is* the
    effect and inventing a Hedges' g beside it would describe a difference
    in means the test never looked at. It carries `statisticLocation`
    (where along x the maximum gap sits) and `statisticSign` (which sample
    was higher there) straight from SciPy's own `statistic_location`/
    `statistic_sign` rather than re-derived client-side, which would be a
    second answer to a question already settled and could disagree wherever
    a tie makes the maximum non-unique.
  - **Anderson-Darling k-sample** is the one genuinely k-sample test of the
    four, taking the omnibus-plus-pairwise shape `anova-one-way` and
    `kruskal-wallis` already use rather than being reduced to pairs.
    `anderson_ksamp` **clamps its p-value to [0.001, 0.25] and emits a
    `UserWarning`** doing it — passed through as a point value, `P = 0.25`
    states a precision the test explicitly declines to claim, and `P =
    0.001` reads as significant at three decimal places by coincidence of
    the floor. The warning is captured (`warnings.catch_warnings`, since it
    is the only channel SciPy offers this on — `p == 0.25` is also a
    legitimate unclamped answer, indistinguishable from the number alone)
    and surfaces as `pBound: 'below' | 'above'` on both `Comparison` and
    `Omnibus`, formatted as `P < 0.001` / `P > 0.25` rather than a bare
    equality. It also raises a bare `IndexError` at n = 1 per group (guarded
    into a 422 naming the author's data) and `ValueError` on an all-constant
    pooled sample (pre-empted with the same message, for the same reason).
  - **Epps-Singleton** compares empirical characteristic functions rather
    than ranks, which is what makes it sensitive to spread differences that
    leave two ECDFs close together. It **returns NaN below n = 5 per
    group**, which `main.py`'s `_sanitize_or(c.p, 1.0)` would otherwise turn
    into a fabricated **p = 1.0** — a confidently null result computed from
    an estimate too thin to be one. Refused outright below that n.
  - **Neither Cramér-von Mises nor Epps-Singleton accepts an `alternative`
    parameter, and none of the four is offered one-sided regardless** — a
    directional request is refused for all four, even Kolmogorov-Smirnov,
    which does accept one in SciPy. Accepting it for one test of four would
    mean the same dropdown setting silently applied on one plot and
    silently ignored on the next, and the concrete harm is not abstract:
    `methods_sentence` rewrites a test's name whenever `alternative` is
    directional, so a silently-ignored setting would still hand the author
    a sentence reading "one-tailed (lower) two-sample Cramér-von Mises
    test" — a claim about an analysis that never ran.
  - **The Shapiro/Levene assumption checks are not skipped for these four**,
    unlike the count tests and log-rank, and that was checked rather than
    assumed backwards: `check_assumptions` only runs those two when
    `parametric` is true, and none of the four distribution tests is in
    that set, so the skip condition never actually reaches them. What they
    do get from the shared path is the small-sample advisory, which is if
    anything more apt here — a two-sample KS at n = 2 is very nearly
    powerless, and saying so is the whole point of an advisory warning.
- **The methods sentence names the statistic, not just the p-value.**
  `STATISTIC_SYMBOLS` (D, T, W, A²k) is read in `_comparisons_clause`, and
  its own comment records why this matters beyond tidiness: these four are
  the only tests here with no effect size and no CI, so without the symbol
  the magnitude appears nowhere in the sentence at all —
  `"Y1 vs Y2: P = 0.03"` and nothing else — found by reading a real
  generated sentence, not by reading the code that builds it. A correction
  moving the p-value off the bracket the test reported means the bound is
  applied only to the uncorrected value; claiming `P_adj < 0.001` from a
  bound on the raw p would overstate what the correction computed.
- **The KS maximum gap is drawn on the ECDF**, from the stored analysis's
  own `statisticLocation` — `resolveKsGap` in `render-document.ts`, the same
  "resolve once, read by both the drawn marker and anything else that
  wants it" discipline `resolveTrendFit` (round 48) already established,
  so the drawn marker and the tabulated D cannot disagree.
  - **Matched by series *name*, never by position.** `geometry.series` is
    ordered by the table's columns; `comparisons` by `itertools.combinations`
    over the request's groups. The two agree today, and pairing them on
    that agreement rather than on `groupA`/`groupB` would draw the gap's
    sign upside down the first time either ordering changed.
  - **Withheld above two series, and for every test but KS.** Cramér-von
    Mises and Anderson-Darling integrate over the whole range and
    Epps-Singleton works in the frequency domain, so none of the other
    three has a single x to point at; and with k > 2 groups a KS run
    reports C(k,2) separate gaps with no honest way to draw one of them as
    "the" gap. Withheld rather than approximated, Fisher's-above-2×2's
    stance again.
  - **`PlotNode.ksGapMarker?: boolean`, absent reads as ON** — the same
    justification round 48's `trendLine` default carries: it can only
    appear once the author has explicitly run KS on this exact plot, so no
    saved figure receives a marker it never asked for.
  - New `SceneRole`s `'ks-gap'` (the rule and its two caps, one `<path>` so
    a role count is 1 per marker) and `'ks-gap-label'` (the `D = …`
    caption, split out the way `'bracket-label'` is split from `'bracket'`
    so `checkTextSize` has something to key a theme size onto).
- **The Stats tab's gates move together, or the tab contradicts itself.**
  `distributionOnContinuous` (a distribution plot type, running a
  distribution test) is composed once and read by three places that must
  agree: `blockedByContinuousAxis` (the carve-out, alongside correlation and
  log-rank), the bracket-suppression gate (miss this and every comparison
  counts as `unplaceable`, which makes the run notice falsely claim the
  group names do not match the plot's data — exactly the class of bug this
  file's "composed once" rule exists to prevent), and `offeredTests` itself.
  On a **categorical** reading of the same table (a violin or a box), the
  same four tests bracket like any other test — no gating change there at
  all, since that path was already correct.

Driven in a real browser, light **and** dark, **24 checks each**: a ragged
`Y1,Y2,Y3` paste (8, 6 and 2 finite values) was never auto-detected as the
new layout; declared and imported, the default histogram drew **33 bars
over 11 distinct x positions, all one width** — measured off the rects' own
`x`/`width`, scoped to the new plot's own `<g>` after an unscoped first pass
over the whole page's bars reported two widths by counting an unrelated
panel too; switching the same plot to ECDF drew a real curve; and, on the
*categorical* reading of the same table, Kolmogorov-Smirnov drew a bracket
while Anderson-Darling ran to completion on a group of n = 2
(`"Groups: Y1 (n=8), Y2 (n=6), Y3 (n=2)"`) without a 500. No console errors
in either theme.

**Not in scope, deliberately:** one-sample KS (goodness-of-fit against a
named distribution) — `run_test` hard-requires two groups for a different
reason than any guard added here, so it needs a different request shape
entirely; side-by-side (dodged) histogram bars; a KDE/density-curve overlay;
per-group small multiples; and re-running a distribution test automatically
when its data changes, which `checkStaleAnalyses` already discloses
unchanged. `checkDistributionSampleSize` (the violin/box small-n warning)
was deliberately **not** widened to histogram/ECDF: a histogram of n = 4
draws four bars at their true counts and an ECDF of n = 4 draws four true
steps — small-n here is a legibility problem, not the false-confidence one
a kernel density or a set of quartiles creates from too little data, so it
earns no finding.

---

### Round 51 — six polishing steps

Six items reported after real use, unrelated to each other. Three of them
delete or invert something an earlier round added deliberately, so the
reasoning is rewritten alongside the code rather than left for a later session
to "fix" back. **No schema change and no new field anywhere** —
`SCHEMA_VERSION` stays 1, and nothing in `packages/doc-model`'s model, schema
or `packages/render`'s scene changed at all.

#### A click on a montage selects the panel (item 1)

Round 20 made a pure montage panel the one container a plain click resolves
*through* rather than to, so a fresh multi-image import could be rearranged
tile by tile without double-clicking first. It bought that at the cost of the
panel, reachable only through a gutter a millimetre wide or an Escape shortcut
nobody finds — and was reported the other way round: the montage is hard to
move or resize.

- **One rule for every container**, which answers both reports rather than
  trading one for the other: click selects the panel, double-click steps in to
  a tile, Escape steps back out. The tile is now one double-click away, where
  the panel was effectively unreachable.
- **`isPureMontagePanel` had exactly two callers and both go** — the exception
  in `selectionTarget`, and an Escape branch that selected a tile's montage
  parent. The generic `enteredId` Escape replacing the latter now steps out
  *to* the container rather than merely clearing the entry. **That promotion
  was the half of the montage-specific branch actually doing the work** — the
  panel's Inspector is where rows, columns, gutter and per-cell upload live —
  and it is right for every container, so there is one rule rather than one
  plus an exception. Deleting the branch without upgrading the generic one
  would have been a net loss.
- **`handleDoubleClick` and `handlePointerDown` needed no change**, verified by
  reading rather than assumed: `CONTAINER_TYPES` already holds `'panel'`, so a
  double-click on a tile enters the panel and then resolves to the tile, and
  the drag arms from the same `selectionTarget` result — not entered drags the
  panel, entered drags the tile.
- **`montageChrome` stays; its comment does not.** It cannot intercept a tile
  click (`renderPanel` pushes it *before* `renderChildren`, so tiles paint over
  it), and it is still the only way to select an *empty* montage — the state
  "Add empty montage…" drops an author into. Its rationale cited round 20's
  rule and was rewritten. Round 20's *other* fix, the grid-derived minimum tile
  size, is untouched.

#### Import titles that say how the sheet must look (item 2)

Fifteen layouts named by shape (`XY + replicates (Prism)`) without saying how a
sheet must be organised to match. Reported as not descriptive enough, and it is
not: `contingency`, `proteomics`, `matrix` and `replicate` are all "a text
column then numbers", separated only by what the numbers mean.

- **Three things per layout, each answering a different half.** The `label`
  states the literal column pattern, which is what an author matches their own
  sheet against. The `hint` says what the numbers will *mean* once read that
  way. The `example` — three rows of a plausible sheet — is what actually
  settles it, because a sentence has to *assert* what the four look-alike
  layouts differ in where a table shows it.
- **The three Prism layouts' examples include their merged group-title row**,
  since that row is the declaration `mergedHeaderGroups` reads and an example
  without it would not import the way its own hint says.
- **The dropdown is grouped into four sections.** An `<optgroup>` cannot be
  reopened, so the array's order *is* the grouping — which is why the count
  table moved down to sit with the other declared-meaning layouts rather than
  beside the xy ones it resembles in shape. A pure reorder is safe here for the
  reason round 17's already was: the select renders in array order and every
  other reader is a `.find` by id.
- Nothing about parsing, `inferFormat` or the model changed.

#### A blank page on launch (item 3)

The seven-panel sample figure was built in round 35 to show what the renderer
could draw and to give Smart layout unlike panel demands to solve. It did both;
an author starting work wants the page they are going to publish.

- **`blankDocument()` is `createDocument()` under a name**, and the name is the
  point: launch, New Figure and Close File must all produce the same thing, and
  three call sites each spelling out their own idea of "blank" is how they come
  to disagree. `createDocument`'s defaults were already right, so `fitZoom`
  still reads 183 mm.
- **Deleted with it**: `sampleMicrographs.ts`, `sampleVolcanoTest.ts`, the
  eight `SAMPLE_*` tables and `createSampleDocument`. `sample.ts` keeps
  `ImportOptions`, `datasetFromText` and `axisTitlesFor`, which `SidePanel.tsx`
  calls on every paste and which were always the load-bearing half of it.
  `archive-memory.ts` weighs assets, not nodes, so a bare document serves it and
  the measured RSS figures stand.
- **Two surfaces this reaches that nothing had evaluated**, because the app
  never opened empty: `checkFigure` runs on every render and its score is in
  the footer, and `renderDocument`/`toSvgString` are the canvas and the export.
  Both are fine — **a blank page scores 100 with no error-severity finding**, so
  the export confirmation does not open on an untouched figure — and both are
  now pinned rather than assumed, since a rule gaining an opinion about an empty
  document would move that number silently.
- **The empty page carries one line pointing at the Data tab.** HTML above the
  SVG, never a scene node — a scene node would export, and would do it on
  precisely the documents most likely to be exported early.

#### A save guard in the browser, and Close File (item 4)

Unsaved work was guarded on the desktop only, and there was no way to put a
figure down without either saving it or reloading the page. Autosave was
offered and declined in favour of these two.

- **`beforeunload`, registered only while dirty**, so a clean page adds no
  listener and stays eligible for the back-forward cache. **Desktop is excluded
  deliberately**: its `before-quit` already offers Save / Don't Save / Cancel
  and can run this app's save, which is strictly better than anything a
  renderer can do, and a second guard would ask twice for one decision.
- **Close File is one renderer-side dialog serving both platforms**, from a
  status-bar button and a File-menu item. Routing the desktop through the
  shell's `confirmDiscard` was the alternative and was rejected: that function
  is wired only to `before-quit`, so a close-triggered save would land on the
  same one-shot `PROJECT_SAVED` channel a concurrent quit is waiting on, and
  the wording would fork between platforms. **No accelerator** — `CmdOrCtrl+W`
  belongs to the close/quit role at the end of the same menu, and taking it
  would leave the window with no keyboard way to close.
- **The trap is `save()`'s return value.** On a browser without File System
  Access it returns false *immediately*: it has only opened `SaveDialog`, and
  the write happens a user interaction later in `saveViaDialog`. A close driven
  off that boolean would silently cancel itself on every Firefox and Safari —
  the browser where losing the work is least recoverable — so the intent
  travels in a ref that `SaveDialog`'s own Save completes and its Cancel
  clears. On the File System Access path the boolean *is* the outcome.
- **`newFigure` became `resetToBlank`** and now also clears the editor modes
  and pending dialogs it never did. A crop overlay is drawn over a node id and
  an export confirmation lists findings; both name things the next document
  does not have. That mattered less when New was reachable only from a menu.
- **Still no autosave and no session restore.** A crash or a force-quit loses
  unsaved work on either platform; the risk table says so.

#### Hide what cannot apply, and say why where it mattered (item 5)

Two controls still sat there refusing, against round 16's convention, and
**both carried no explanation at all — not even a tooltip**.

- **The Stats tab's "Run and annotate"** was disabled on three conditions with
  the reason reaching the author only through a notice that had its own reasons
  for being empty. Hidden now, with the reason in its place. The three
  conditions compose into one `runBlockedReason` read by both the button and
  the line replacing it — spelling them out at each site is how a control and
  its own explanation come to disagree.
- **The Inspector's two "Fitted line" selects** describe a line that is not
  being drawn, so with the line off they are hidden rather than greyed —
  matching the axis-break branch directly above them, which already replaced
  the whole block.
- **Run PCA, Run UMAP and the volcano test deliberately stay
  visible-but-disabled**, which is the opposite call and a considered one:
  nothing about that kind of table makes them inapplicable, it is merely too
  small yet, and hiding the only route to a feature until the data grows would
  make it undiscoverable. What was wrong is that the requirement lived in a
  `title`, and a tooltip is not where an author looks to find out why a button
  does nothing — it is a visible line under the row now.

#### The orphaned inputs (item 6)

`reference-and-test-files/` (12 MB, 23 files) was cited only by the sample
figure and by this file, so item 3 is what made deleting it safe. The stale
`TestFiles/` provenance comments left by an earlier deletion — in
`sample.test.ts`, `doc-model.test.ts` and `continuous-axis.test.ts` — were
rewritten rather than removed: they are the only record of where those inlined
literals came from, and each file now says plainly that the workbooks are no
longer in the repo. `GUIDE.old.md`'s own stale reference here was corrected
too, and the risk table's "there is still no `beforeunload` guard" row is no
longer true and no longer says so. **The app's test suites are untouched.**
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
| 9 | AI layout assistant | **Partly answered deterministically by round 35's smart layout** (`packages/doc-model/src/smart-layout.ts` + `packages/render/src/panel-demand.ts`), which measures each panel's demand and solves the arrangement without a model. What remains genuinely model-shaped is *narrative* grouping — which panels belong together — not geometry |

### Already scaffolded but unused

- **Panel `slot`** (`{row, col, rowSpan, colSpan}`) is written by layout
  templates and honoured by `autoLayout`, but nothing lets a user author a slot
  directly — templates and, since round 35, smart layout (which hands
  `applyAutoLayout` a *synthetic* `LayoutTemplate` rather than growing a second
  way in) are the only ways to set one. It is also *cleared* whenever layout
  runs without a template; see the reported-bug rounds for why.
- **`GridSpec.columnWeights`/`rowWeights`** were in this list in spirit: real,
  honoured by `tracks`, and only ever set by the six weighted entries in
  `templates.ts`, never derived from anything. Round 35 solves them from
  measured demands.
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
- **`alignFrames`/`distributeFrames`** belonged in this list since the smart-guide
  snapping machinery was built alongside them: pure, tested geometry with zero
  call sites in `apps/web`. Round 26 wired them up — see "Round 26".
- **`TextStyle.color` is reachable on a `TextNode` and nowhere else**, though
  `textAttrs` renders it for every text-bearing node. `TextFields` has had a
  Colour swatch since phase 1; round 39 added the scale bar's. A panel label
  and a bracket label still have none, so both always draw at
  `theme.foreground` — each is one swatch in the matching Inspector block if
  it is ever wanted.

### Declared-but-missing things — check before trusting the types

- **All 14 `PlotType` variants now render distinctly.** The dropdown is gated
  on what the *dataset* supports rather than on what is implemented (`typesFor`
  in `Inspector.tsx`): scatter and line need paired `Series.x`, which `toSeries`
  supplies only for `simple-xy`/`prism`/`sigmaplot`/`xy-replicates`; a histogram
  or an ECDF needs at least one series carrying values, and — since round 50 —
  pools several series' values only to choose shared bin edges, never into one
  drawn shape, so a distribution table's several groups no longer hide the one
  plot type whose default is `histogram`; volcano needs a single series
  carrying `Series.pointLabels` **and a dataset
  that is not `fold-fold`** — that format satisfies the label test exactly as
  `differential` does, and a volcano drawn on it would take −log10 of a
  negative fold change; fold-fold is gated on its own format for the mirror
  reason; heatmap needs a `matrix`-format dataset and
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
| **No schema migrations** | `SCHEMA_VERSION` is still 1 and `loadArchive` rejects anything newer. Every field added since (`plotId`, `userOffsetMm`, `comparisonIndex`, `gapMm`, `slot`, `pointsUseSeriesColor`, `calibrationSource`, `errorBarDirection`, `pointShape`, `pointFill`, `pointStroke`, `y2`, `seriesAxis`, `minorTicks`, `tickDirection`, `breaks`, and round 4's `hasRowNames`, `columnGroups`, `editedAt`, `legend`, `errorDisplay`, `contentGrid`, and round 5's `showReplicates`, `pointShapes`, `barGapFraction`, `groupGapFraction`, phase 7 stage 1's `volcanoThresholds`, `volcanoColors`, `volcanoThresholdLines`, stage 2's `heatmapScale`, `heatmapStops`, `heatmapMissingColor`, `showCellValues`, and stage 3's `showCensorMarks`, `showSurvivalCI`, and round 7's `labelFormat`, `labelDecimals` on `AxisSpec`, `linthresh` on `AxisSpec`, `volcanoLabels`, `offsetStepMm`, `offsetStepXMm`, `offsetFill` on `PlotNode`, and round 8's `clipToRange` on `AxisSpec`, `pointLabelOffsets`, `pointLabelSizePt`, `showCascadeAxis`, `cascadeAxisTitle` on `PlotNode`, and round 9's `boxed`, `showGridlines`, `gridlineColor`, `gridlineStyle` on `PlotNode`, and round 16's `derivedFrom` on `Dataset`, and round 19's `volcanoTest` on `PlotNode`, and round 23's `richText` on `TextNode`, and round 24's `richText` on `AxisSpec` and `cascadeAxisTitleRichText` on `PlotNode`, and round 29's `reverseLegend` on `PlotNode`, and round 32's `alignX`/`alignY` on `ImageNode` and `gapMm` on `GroupLabelNode`, and round 33's `placement`/`labelColor` on `GroupLabelNode` and `autoFit` inside `PanelNode.contentGrid`, and round 37's `liftMm` on `PanelLabelNode`, and round 38's `placement` on `ScaleBarNode`, and round 46's `pointLabelLimit` on `PlotNode`, and round 47's `foldFoldThresholds`, `foldFoldColorBy`, `foldFoldColors`, `foldFoldZeroLines` and `foldFoldCutoffLines` on `PlotNode`, and round 48's `trendLine`, `trendInterval` and `trendExtent` on `PlotNode` plus `fit` on `StatResult` — the first optional field added to a *result* rather than a node, and nullable as well as optional because the wire sends `null` for every test that fits no line, and round 50's `histogramStyle`, `histogramCumulative`, `histogramNormalize` and `ksGapMarker` on `PlotNode`, plus `pBound`, `statisticLocation` and `statisticSign` on `Comparison`/`Omnibus` — the second and third result-level fields after round 48's `fit`) is **optional**, so old files still load. Round 50's `ksGapMarker` is the second field, after round 48's `trendLine`, whose absent value reads as **on**: the marker it controls can only appear once the author has explicitly run Kolmogorov-Smirnov on that exact plot, so no saved figure receives one uninvited. Round 48's `trendLine` was the first optional field here whose absent value reads as **on** rather than off, which is a deliberate, stated exception: the line it controls can only appear once somebody has explicitly run a correlation, so there is no saved figure it arrives on uninvited. Round 47 also widened two enums the same additive way every earlier one was: `DataFormat` gained `'fold-fold'` and `PlotType` gained `'fold-fold'`, so an older build cannot read a fold-vs-fold figure but every file it already has still validates. Round 33 also *changed two defaults* for absent fields — `showRule` now reads as false and the group-label size as 6 pt — which is a deliberate, retroactive presentation change rather than a compatibility break: an old file still validates and still loads, its headings simply draw the way a published one does. `autoFit` is pointedly **not** retroactive, since it moves frames. Round 32's two enums (`FitAlign`, and the widened `SceneRole`) are not persisted at all — `alignX`/`alignY` are the only new *stored* enum, and absent reads as `'middle'`, which is what every image already did. **Round 31 added a new node `type` variant, `group-label`** — the same bump-free precedent `bracket`/`panel-label`/`scale-bar` themselves already are, since a file with no such node still validates on any future build — plus one widened `LayoutOptions`/`GridSpec`-adjacent function signature (`gridCells`'s `columnGutterExtraMm`/`rowGutterExtraMm`) that touches no persisted schema at all. **Round 10 added no field at all**: rotation writes `NodeBase.rotation`, which has been required and defaulted since phase 1 and is simply the first round to set it to something other than `0`; `SceneNode.editTarget` is render-time metadata that is never persisted; and the new layout templates and `clearBlock` touch no schema. Stages 4 (PCA) and 5 (UMAP) added no new `PlotNode` fields at all — the smallest schema footprint of any phase-7 stages, since both are the existing `scatter` type. Round 4 also widened the `format` enum by three members, phase 7 stage 1 by one more (`differential`), stage 2 by one more again (`matrix`), stage 3 by one more again (`survival`), stage 4 by one more again (`pca`), stage 5 by one more again (`umap`), round 16 by one more again (`proteomics`), round 47 by one more again (`fold-fold`), and round 50 by one more again (`distribution`), which is backward-compatible in the same direction `contingency` already was: an older build cannot read the new layouts, but every file it *has* still validates. The `plotType` enum was widened the same way five times — `volcano`, `heatmap`, `survival`, `fold-fold` and `ecdf` — not seven, since `pca` and `umap` both reuse `scatter`, for the same reason: a `volcano`, `heatmap`, `survival`, `fold-fold` or `ecdf` node is unreadable by an older build, not unreadable by this one. `StatTest` gained `'log-rank'` the same additive way, and round 50 widened it by four more (`'kolmogorov-smirnov'`, `'anderson-darling'`, `'cramer-von-mises'`, `'epps-singleton'`) in one change. Round 7 widened `AxisSpec.scale` by one member (`'symlog'`), the same direction as every other enum widening here — an existing `'linear'`/`'log10'` axis is untouched, and only a `'symlog'` axis is unreadable by a pre-round-7 build. Phase 4 also *narrowed* `crop.width`/`height` from non-negative to `.gt(0).max(1)`, which would normally force a bump — it did not, because nothing could create an image node before that change, so no file in existence contains one. The next *required* field forces it. **zod strips unknown keys**: a field added to a TS type but not to `schema.ts` is silently dropped on save/load. |
| **Text metrics are estimated** | `text-width.ts` uses static Helvetica/Arial advance widths. Correct for the shipped Liberation Sans, and deterministic across canvas and export, which is what matters — but a user-supplied font with different metrics would make the collision decisions slightly off. This now sets the *plot area*, not just label angles: `requiredMargin` sizes the gutters from these numbers, so a mismatched font shifts geometry rather than only the odd label. **Round 35 raises the stakes again**: smart layout derives each plot's demand from exactly these measurements, so a mismatched font would shift the *arrangement* — which grid wins — not merely a gutter. Still identical between canvas and export, which is the property that matters. |
| **No autosave or session restore** | *Guarded on both platforms; still no autosave.* The desktop shell's `before-quit` prompts Save / Don't Save / Cancel and can run the renderer's own save before exiting (phase 8 stage 2). Round 51 added the browser's half — a `beforeunload` guard registered only while dirty — plus a **Close File** command on both platforms, one renderer-side dialog with the same three choices, so a figure can be put down without either saving it or reloading the page. What a browser cannot do is write the wording or save on the user's behalf, which is why the shell keeps its own prompt. **There is still no autosave and no session restore**: a crash or a force-quit loses unsaved work on either platform. `store.ts` records patches and their inverses, so incremental autosave is one mechanism away when it is wanted. |
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
