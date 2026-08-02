# FigureForge — working context

Publication-ready multi-panel figure assembly for life-science journals: the
layout control of Illustrator, the plotting of Prism, and reproducibility that
neither offers.

Requirements source of truth: [`build-a-nature-style-platform.md`](build-a-nature-style-platform.md).
That spec describes a multi-year product surface (30+ chart types, omics compute,
Electron, an AI layout assistant). It was deliberately cut to one complete
vertical slice — data in, publication-ready vector out — so the architecture
could be proven before breadth was added. **Phases 1–4 are done; phases 5–9 are not.**

---

## Running it

Everything runs in containers. **The host has no Node and no Python scientific
stack** — never run `npm` or `pytest` on the host, run them inside the containers
(the Makefile targets already do).

```bash
make up          # build images, start the pod
                 #   web -> http://localhost:5173
                 #   api -> http://localhost:8000/health
make test        # 215 TypeScript + 59 Python tests
make acceptance  # 43-check end-to-end run (needs `make up` first)
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

### Plot type choices

- **`PlotGeometry` is a discriminated union on `kind`, not one shape with
  optional fields.** The categorical arm carries `band`/`marks`/`categories`; the
  continuous arm carries `xScale`/`series`/`bins`. Almost nothing is shared, and
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
- **Tests are verified against externally published values** — Student's 1908
  sleep data and R's documented output for `t.test`, `aov`, `cor.test` — not
  against numbers this code produced itself.
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

Phases 1–4 are on `master` plus the `feature/phase-4-images-annotations`
branch. Run `git status` before assuming the tree is clean.

**Verified:** 215 TypeScript tests, 59 Python tests, typecheck and lint clean,
43-check acceptance run. Exported PDF confirmed single-page, fonts embedded,
text selectable, exactly 183.0000 × 75.0000 mm with an image XObject embedded;
PNG exactly 300 dpi. The phase 4 surfaces were additionally driven in real
Chromium against the running app — import, scale bars, annotations, crop and
measure — because green tests do not mean the app runs.

Working end to end: CSV/TSV import with format detection, live preview and a
user-supplied dataset name → bar/dot/beeswarm/box/violin/scatter/line/histogram
marks with error bars → Welch's t-test and friends with corrections and effect
sizes → significance bracket placed on measured geometry, which follows the plot
when it moves → PNG/JPEG/SVG/TIFF image panels with drag-crop, calibrated scale
bars and arrow/shape/text annotations → auto-layout with smart guides and
snapping, weighted templates, and drag-resize handles → panel lettering in
reading order → an Inspector for the selected node (colours, text, axis titles,
frame, crop, calibration) with double-click-to-edit on canvas →
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

---

## What's next

Phases 5–9, with the actual entry points:

| Phase | Scope | Where to start |
|---|---|---|
| 3 | **done** — all 9 plot types render | `PlotGeometry` is a discriminated union on `kind: 'categorical' \| 'continuous'`; `renderNumericXTicks` is the numeric x axis |
| 4 | **done** — image panels, crop, scale bars, annotations | `apps/web/src/assets.ts` is the asset store; `scaleBarWidthMm`/`resyncScaleBars` in `operations.ts`; `/decode-image` in the API |
| 5 | remaining stats surface | `services/api/figureforge/stats/tests.py` |
| 6 | export/QC hardening, autofixes | `packages/render/src/quality.ts` |
| 7 | heatmaps, PCA, UMAP, volcano, survival | new mark types; needs the DOM-volume answer below first |
| 8 | Electron shell | new; see the sidecar risk below |
| 9 | AI layout assistant | `packages/doc-model/src/layout.ts` already has the geometry |

### Already scaffolded but unused

- **Statistical tests** `chi-square`, `linear-regression`, `wilcoxon` are
  implemented in the API but absent from the UI dropdown in `SidePanel.tsx`.
- **Panel `slot`** (`{row, col, rowSpan, colSpan}`) is written by layout
  templates and honoured by `autoLayout`, but nothing lets a user author a slot
  directly — templates are the only way to set one.
- **Group semantics are half-shipped, deliberately.** `addGroup`/`ungroup`
  preserve every member's page position, and the Toolbar and Inspector expose
  them — but clicking the canvas still selects the leaf, so a group is only
  reachable from the Layers list. Real semantics (click selects the outermost
  group, double-click enters it) is a substantial change to canvas selection,
  the one path everything else depends on. The UI says so rather than pretending.

### Declared-but-missing things — check before trusting the types

- **All 9 `PlotType` variants now render distinctly.** The dropdown is gated on
  what the *dataset* supports rather than on what is implemented (`typesFor` in
  `Inspector.tsx`): scatter and line need paired `Series.x`, which `toSeries`
  supplies only for `simple-xy`/`prism`/`sigmaplot`; a histogram needs a single
  series, since pooling groups invents a bimodal shape belonging to neither.
  `computePlotGeometry` returns null for an unsupported combination, so a type
  set some other way draws nothing rather than something wrong.
- **`anova-rm` is in the `StatTest` union and in the `parametric` set
  (`tests.py:250`) but has no dispatch branch**, so calling it raises
  `Unsupported test: anova-rm`. It is not in the UI dropdown, so it is not
  user-reachable — but the type says it works.
- **`pearson`/`spearman` correlate two y-series against each other, never a
  series against its own x.** `run()` in `SidePanel.tsx` posts only
  `Series.values`, and `tests.py` takes `groups[names[0]]` vs `groups[names[1]]`.
  For a `simple-xy` dataset `toSeries` yields a single series, so the run bails
  at "at least two groups" — the correlation test is **unreachable for the
  canonical scatter case**. Both tests are in the UI dropdown today.

---

## Risks and open problems

| Risk | Detail |
|---|---|
| **Electron packaging** | Web-first deferred this, it did not remove it. The desktop shell needs Python bundled as a sidecar process with lifecycle management — real work, not a wrapper. |
| **Omics panel volume** | A 100k-point UMAP as SVG nodes will kill the DOM. Phase 7 needs downsampling or a canvas/WebGL inset before the marks are written, not after. |
| **Stale bracket positions** | *Fixed.* `repositionBrackets` re-measures on layout, resize and import; `userOffsetMm` preserves manual nudges. The staleness *warning* (data edited after a test) now fires in the Stats tab and the quality checker, but nothing re-runs the test automatically — by design. |
| **`measurePlot` recomputes** | *Mitigated.* Memoised on `(plot, dataset, theme)` object identity. The cache is per-call-site correct but unbounded reasoning applies: it is a `WeakMap`, so entries die with their nodes. |
| **No schema migrations** | `SCHEMA_VERSION` is still 1 and `loadArchive` rejects anything newer. Every field added since (`plotId`, `userOffsetMm`, `comparisonIndex`, `gapMm`, `slot`, `pointsUseSeriesColor`, `calibrationSource`) is **optional**, so old files still load. Phase 4 also *narrowed* `crop.width`/`height` from non-negative to `.gt(0).max(1)`, which would normally force a bump — it did not, because nothing could create an image node before that change, so no file in existence contains one. The next *required* field forces it. **zod strips unknown keys**: a field added to a TS type but not to `schema.ts` is silently dropped on save/load. |
| **Text metrics are estimated** | `text-width.ts` uses static Helvetica/Arial advance widths. Correct for the shipped Liberation Sans, and deterministic across canvas and export, which is what matters — but a user-supplied font with different metrics would make the collision decisions slightly off. |
| **Autofixes are advertised, not implemented** | Quality checker findings carry `autoFixable: true`, but no fixer is wired up and the UI offers no button. Either build them or stop claiming it. |
| **The archive is built whole in memory** | `zipSync` returns one `Uint8Array`, so a project with several hundred-megabyte TIFFs is a single allocation of that size in a browser tab — an OOM and a lost session. The Data tab shows a running total and warns past 300 MB, so the ceiling is anticipated rather than discovered at save time. This is the real limit on TIFF support in a web app, and what phase 8 (Electron) actually solves. |
| **Cropped images ship at full size** | `renderImage` embeds the whole asset and discards the out-of-crop pixels with a `clipPath`, so a 100 MP image cropped to 10% still uploads 100 MP. Shipping *only* the cropped region at full resolution is pixel-identical to the screen, so unlike downsampling it is value-preserving — it needs an `OffscreenCanvas` re-encode, which is phase 6 work. The export size guard (128 MiB, client pre-check plus a `Content-Length` middleware) is the interim answer. |
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
