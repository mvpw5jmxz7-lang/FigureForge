# FigureForge

Publication-ready multi-panel figure assembly for life-science journals — the
layout control of Illustrator, the plotting of Prism, and reproducibility that
neither of them offers.

Built from [`build-a-nature-style-platform.md`](build-a-nature-style-platform.md).

---

## Running it

Everything runs in containers, so no Node or Python setup is needed on the host.

```bash
make up          # build images, start the pod
                 #   web -> http://localhost:5173
                 #   api -> http://localhost:8000/health

make test        # TypeScript + Python test suites
make acceptance  # end-to-end: CSV in, publication-ready PDF out
make down        # stop
```

`make help` lists every target.

The dev environment is a **podman pod**, so both containers share one network
namespace and the web app reaches the API on plain `localhost:8000`. A
`compose.yaml` is included for anyone on Docker proper.

---

## The one architectural commitment

The brief asked for both a Matplotlib backend *and* SVG-native rendering. Those
are incompatible: Matplotlib emits `<path>` soup inside clip groups, so you
cannot click an axis label to edit it, cannot enforce typography across panels,
and cannot guarantee the export matches the screen.

So:

> **The figure is one SVG document, rendered from a typed JSON model by
> isomorphic TypeScript. Python receives numbers and returns numbers — never
> pixels.**

The export path runs *the same renderer* headless. WYSIWYG is therefore
structural, not a promise maintained by hand. `packages/render` must never
import the DOM; `parity.test.tsx` holds both output adapters to byte-identical
markup so any drift fails a test instead of a submission.

### Millimetres all the way down

Internal geometry is millimetres, and the SVG is emitted as
`width="183mm" viewBox="0 0 183 75"` — so one user unit *is* one millimetre.
Nature's 183 mm double column needs no conversion anywhere, and exported PDFs
come out at exactly the right physical size.

Type sizes are the deliberate exception: stored in **points**, because that is
what journals specify ("panel labels 8 pt bold"), and converted at render.

---

## Layout

```
packages/
  doc-model/   FigureDocument, schema, undo/redo, layout engine, .figureforge I/O
  theme/       journal presets, palettes, colour-vision validation
  plots/       scales, ticks, summary statistics, mark geometry  (pure maths)
  render/      scene tree -> {React | SVG string}, quality checker
apps/web/      Vite + React canvas, inspectors, export UI
services/api/  FastAPI: statistics and export conversion
scripts/       end-to-end acceptance flow
```

`plots` computes numbers and `render` draws them. That split is why the plotting
maths is testable against exact expected values, and why there is no dependency
cycle between the two.

### The document

A `FigureDocument` holds everything needed to reproduce the figure: raw data,
analysis requests *and* their cached results, layout, styling, annotations.
Rendering is a pure function of it.

Nodes live in a **flat map keyed by id**, each carrying a `parentId`, rather
than a nested tree — immutable updates touch one entry, and reparenting or
z-reordering never restructures anything.

Edits go through Immer's `produceWithPatches`, so undo/redo, version history and
incremental autosave are one mechanism rather than three.

### `.figureforge` files

A zip, following the `.docx` precedent — micrographs are the bulk of a real
figure's bytes and base64-ing TIFFs into JSON is untenable.

```
MANIFEST.json    format marker, schema version
document.json    the model
data/*.csv       verbatim original imports, byte for byte
assets/*         images, unmodified
```

`data/` holding the **untouched** originals is what makes the reproducibility
claim real: the numbers a reviewer extracts are the numbers that were imported,
not a round-tripped re-serialisation. Each analysis stores a hash of its inputs,
so a figure can never silently display a p-value its data no longer supports.

---

## Statistics

`POST /analyze` returns the statistic, p-value, **adjusted** p-value, confidence
interval, effect size, assumption warnings — and a ready-to-paste methods
sentence:

> Data were analysed by two-tailed unpaired Welch's t-test (n = 4 per group).
> Vehicle vs Compound X: P < 0.001, Hedges' g = 18.62, 95% CI [52, 61.2].
> Significance was assessed at α = 0.05. Analyses were performed in Python
> 3.12.13 (SciPy 1.15.0, statsmodels 0.14.4).

Three choices worth stating, because each is a common reporting error:

- **Significance annotations read the adjusted p-value.** Starring uncorrected
  p-values on a multi-comparison figure is one of the most frequent statistical
  errors in published figures.
- **Effect sizes are always returned**, with Hedges' small-sample correction —
  at n = 3–6, plain Cohen's *d* noticeably overstates the effect.
- **Confidence intervals use the t distribution.** At n = 3 the correct
  multiplier is 4.303, not 1.96; the shortcut understates the interval badly.

Every test is verified against **externally published reference values** —
Student's 1908 sleep data and R's documented output for `t.test`, `aov` and
`cor.test` — rather than values this code generated itself.

---

## Export

| Format | Path |
|---|---|
| SVG | serialised directly from the scene tree |
| PDF | headless Chromium — text stays text, fonts subset and embedded |
| EPS | PDF → Ghostscript `eps2write` |
| PNG | Chromium at an exact DPI (300 / 450 / 600) |
| TIFF | Pillow, LZW, resolution written into the header |

Three traps are handled explicitly, each found by testing rather than assumed:

1. **`svg { display: block }`.** An inline SVG sits on a text baseline; the
   descender space beneath it spills past the page box and produces a second,
   blank page — after which Ghostscript refuses to make an EPS at all.
2. **Chromium rounds the page box up** to a whole 1/300-inch unit, so a 183 mm
   figure lands on a 183.13 mm page. The export crops it back to exact
   dimensions. Crop, never scale — rescaling would shrink every font below the
   size the theme guarantees.
3. **Fonts are pinned in the image.** Arial is not redistributable, so the
   container ships Liberation Sans, which is metrically identical and therefore
   substitutes without shifting any layout. Pinning the fonts and the Chromium
   build is what makes exports reproducible across machines.

---

## Quality checker

Runs against the **rendered scene**, not the document — what a journal receives
is the rendered output, and a font size that looks right in the inspector but
resolves to 4 pt after a panel is scaled is exactly the defect worth catching.

Checks text size, font consistency, panel labelling, image resolution, colour
accessibility, page dimensions and gutter uniformity, and reports a
**Publication Readiness Score** out of 100.

Colour is validated by simulating deuteranopia, protanopia, tritanopia and
greyscale, then measuring CIEDE2000 distance between every pair of series
colours. The default palette is **Okabe–Ito**. Note it is designed for red-green
deficiency — around 99% of cases — and the checker reports its known tritanopia
limit rather than pretending the palette is universally safe.

---

## Status

Phases 1–2 of the plan are complete and verified end to end: import → plot →
statistics → annotation → layout → export, with a 100/100 readiness score and a
PDF confirmed to carry selectable text at exact journal dimensions.

**Implemented:** document model with undo/redo and project files, auto-layout
with smart guides and snapping, bar/dot/beeswarm marks with error bars,
statistics with corrections and effect sizes, all five export formats, quality
checker, canvas with selection and nudging, data import with live preview.

**Not yet built** (Phases 3+): box/violin/line/scatter/histogram plots, image
panels with crop and scale bars, omics plots (heatmaps, PCA, UMAP, volcano,
survival), the Electron desktop shell, and the AI layout assistant. The node
types, renderer hooks and statistics for several of these are already in place.

Run `make acceptance` to see the whole pipeline execute.
