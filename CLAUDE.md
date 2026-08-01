# FigureForge — working context

Publication-ready multi-panel figure assembly for life-science journals: the
layout control of Illustrator, the plotting of Prism, and reproducibility that
neither offers.

Requirements source of truth: [`build-a-nature-style-platform.md`](build-a-nature-style-platform.md).
That spec describes a multi-year product surface (30+ chart types, omics compute,
Electron, an AI layout assistant). It was deliberately cut to one complete
vertical slice — data in, publication-ready vector out — so the architecture
could be proven before breadth was added. **Phases 1–2 are done; phases 3–9 are not.**

---

## Running it

Everything runs in containers. **The host has no Node and no Python scientific
stack** — never run `npm` or `pytest` on the host, run them inside the containers
(the Makefile targets already do).

```bash
make up          # build images, start the pod
                 #   web -> http://localhost:5173
                 #   api -> http://localhost:8000/health
make test        # 85 TypeScript + 38 Python tests
make acceptance  # 28-check end-to-end run (needs `make up` first)
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

### Package split

```
packages/doc-model/   model, zod schema, undo/redo, layout, operations, .figureforge I/O
packages/theme/       journal presets, palettes, colour-vision validation
packages/plots/       scales, summary statistics, mark geometry   ← maths only
packages/render/      scene tree → {React | SVG string}, quality checker  ← drawing only
apps/web/             Vite + React canvas, inspectors, import/export UI
services/api/         FastAPI: SciPy statistics, Chromium/Ghostscript export
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

---

## Current state

Phases 1–2 committed as `fb401cb`: ~9,570 lines of source across 80 tracked files.

Uncommitted on top of that commit: this file, and a fix in `analysis.ts` replacing
a raw NUL byte with the escape `'\u0000'` — the same character, so every hash is
byte-identical and nothing behavioural changed (see the trap below). Run
`git status` before assuming the tree is clean.

**Verified:** 85 TypeScript tests, 38 Python tests, typecheck and lint clean,
28-check acceptance run. Exported PDF confirmed single-page, fonts embedded,
text selectable, exactly 183.0000 × 75.0000 mm; PNG exactly 300 dpi.

Working end to end: CSV/TSV import with format detection and live preview →
bar/dot/beeswarm marks with error bars → Welch's t-test and friends with
corrections and effect sizes → significance bracket placed on measured geometry →
auto-layout with smart guides and snapping → panel lettering in reading order →
PDF/EPS/SVG/PNG/TIFF export → Publication Readiness Score → project save/load.

---

## What's next

Phases 3–9, with the actual entry points:

| Phase | Scope | Where to start |
|---|---|---|
| 3 | box, violin, line, scatter, histogram | `packages/plots/src/marks.ts` (pure functions) + a branch in `computePlotGeometry`/`renderPlot` |
| 4 | image panels, crop, scale bars, annotations | node types and renderers **already exist** — needs UI and asset plumbing |
| 5 | remaining stats surface | `services/api/figureforge/stats/tests.py` |
| 6 | export/QC hardening, autofixes | `packages/render/src/quality.ts` |
| 7 | heatmaps, PCA, UMAP, volcano, survival | new mark types; needs the DOM-volume answer below first |
| 8 | Electron shell | new; see the sidecar risk below |
| 9 | AI layout assistant | `packages/doc-model/src/layout.ts` already has the geometry |

### Already scaffolded but unused

- **Node types** `image`, `scale-bar`, `arrow`, `shape`, `group` are fully
  implemented in the model, schema and renderer, but nothing in the UI creates
  them. Scale bars already derive their length from the parent image's
  calibration and on-page size, which is the hard part.
- **Statistical tests** `chi-square`, `linear-regression`, `wilcoxon` are
  implemented in the API but absent from the UI dropdown in `SidePanel.tsx`.
- **Asset pipeline**: `resolveAsset` is wired through the renderer and
  `App.tsx` passes `assetUrls={{}}`. Image panels need blob URLs in the browser
  and data URIs on export — the seam exists, nothing fills it.

### Two declared-but-missing things — check before trusting the types

- **`PlotType` declares 9 variants; only 4 render distinctly.** `bar`, `dot`,
  `bar-dot` and `beeswarm` are real. `scatter`, `line`, `box`, `violin` and
  `histogram` pass the type system and the zod schema but fall through to the
  categorical dot path and render as something plausible-looking and wrong.
  Adding one means: the mark geometry, a renderer branch, and nothing else — the
  union in `nodes.ts:84` and its mirror in `schema.ts:87` already list them.
- **`anova-rm` is in the `StatTest` union and in the `parametric` set
  (`tests.py:250`) but has no dispatch branch**, so calling it raises
  `Unsupported test: anova-rm`. It is not in the UI dropdown, so it is not
  user-reachable — but the type says it works.

---

## Risks and open problems

| Risk | Detail |
|---|---|
| **Electron packaging** | Web-first deferred this, it did not remove it. The desktop shell needs Python bundled as a sidecar process with lifecycle management — real work, not a wrapper. |
| **Omics panel volume** | A 100k-point UMAP as SVG nodes will kill the DOM. Phase 7 needs downsampling or a canvas/WebGL inset before the marks are written, not after. |
| **Stale bracket positions** | `addBracket` computes geometry once from `measurePlot`. Editing the data afterwards leaves brackets where they were. `inputHash` detects the staleness; nothing repositions or warns yet. |
| **`measurePlot` recomputes** | It re-runs the full geometry pass (scales, marks, summary stats) on every call, duplicating the render path. Fine at two panels; wasteful at twenty. Memoise before adding many panels. |
| **No schema migrations** | `SCHEMA_VERSION` is 1 and `loadArchive` rejects anything newer. The moment the model changes shape, old `.figureforge` files break — a migration path is needed *before* the first breaking change ships. |
| **Autofixes are advertised, not implemented** | Quality checker findings carry `autoFixable: true`, but no fixer is wired up and the UI offers no button. Either build them or stop claiming it. |
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
- **React wants camelCase SVG attributes.** The scene stores canonical hyphenated
  names (what the exporter writes verbatim); `react.tsx` converts. Both adapters
  must still emit identical markup — the parity test enforces it.

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
