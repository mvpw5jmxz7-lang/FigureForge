# TestPlan.md — FigureForge manual test guide

A single document a tester can follow, unassisted, to exercise every feature of
FigureForge as it exists today (commits `fb401cb` + `be29341`).

> **This is a manual test plan, not an automated suite.** Automated tests for
> the model, renderer and statistics already run inside the repo
> (`packages/*/src/*.test.ts`, `services/api/tests/`) and are passing.

## Sessions run

Add one row per testing session. The next development session reads this table
first, so it knows what was reached, what broke, and what to look at.

| Date | Tester | App version | Sections run | Pass / Fail / Skip | Issues filed | Linked commit |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |

**Filled example row to copy when starting a new session:**

```
| 2026-08-01 | AK | 68c3a6d | 0–5, 8 | 7 / 1 / 0 | 2 | dc1e276 |
```

- **Date** — the day the session ran.
- **Tester** — initials or first name, consistent across the project.
- **App version** — the git short SHA of the FigureForge build you tested
  against (e.g. `68c3a6d`).
- **Sections run** — list of section numbers, e.g. `0–5, 8`.
- **Pass / Fail / Skip** — three counts, e.g. `7 / 1 / 0`.
- **Issues filed** — count of new rows in section 18 ("Notes &
  suggestions") this session.
- **Linked commit** — the SHA of any FigureForge commit that affected
  what you tested, when known.

## How to read this document

Every test step has the same shape:

- **What to do** — the click, dropdown, paste or keyboard action.
- **What to look at** — what you should see on screen.
- **What a failure looks like** — what to record in section 18 ("Notes &
  suggestions") if something is wrong.

Most steps include a clickable control name and a tab name. The app has four
tabs on the right: **Data**, **Stats**, **Quality**, **Layers**. The
top toolbar and bottom status bar are not tabs.

## How to update this file as a tester

This document is the input to the next development session. After a session:

1. Tick `- [x]` next to each step you completed. Leave `- [ ]` if you did
   not run that step. If a step **failed**, leave `- [ ]` and add
   `(FAIL — see Notes)` so the next session can find it quickly.
2. Add a **row to the "Sessions run" table** at the top with your date,
   initials, app version and what you covered.
3. Add a **short summary line** in the footer of each section you ran
   (the `> Session YYYY-MM-DD:` blockquote at the end of every section).
4. For anything you want **next**, add an entry to section 17
   ("Suggestions for the next round of development").
5. For anything **broken**, add an entry to section 18 ("Notes &
   suggestions").
6. **Commit your changes** when you finish. The next session reads the
   committed version — uncommitted edits are not visible to it.

Before you start, the app must be running and open in your browser at
`http://localhost:5173`. If you don't see anything on the screen, see section
15 ("What not to file") — it lists features that simply don't exist yet —
before reporting an empty page as broken.

---

## 0. Before you start

- [ ] **Open the app and confirm the starting state.**

Confirm:

- The browser shows two side-by-side panels, each titled with a small bold
  letter in the top-left: **a** and **b**.
- The top-right of the toolbar reads `183.0 mm × 75.0 mm`.
- There is **no** yellow warning banner at the top of the page.
- The right-hand side panel shows the four tabs Data / Stats / Quality / Layers,
  with **Data** underlined (the default tab).
- The bottom status bar shows a "Save project" button on the left and five
  export buttons on the right (PDF, EPS, SVG, PNG, TIFF).

**Failure:** if the page is blank or stuck on "Loading", the dev environment
isn't fully up — restart it (`make down` then `make up` on Linux,
`docker compose down` then `docker compose up --build` on macOS) and wait
~30 seconds.

> **Session ____-__-__** — passed / failed / skipped. _one-line summary_

---

## 1. The starting figure

- [ ] **Inspect the two demo panels and confirm labels, colours and page size.**

You are looking at two demonstration datasets loaded on app start:

- **Panel a — Cell viability (dose–response).** Four treatment groups
  (Vehicle, 10 µM, 50 µM, 100 µM of a test compound), four biological
  replicates each. The bars should be **blue / orange / green / pink**
  (left to right) and each bar carries three or four black dots showing
  the individual replicates.
- **Panel b — Target expression (knock-out).** Three genotype groups
  (WT, KO, Rescue), three replicates each. Three bars in **blue / orange /
  green** (left to right), each with three black dots on top.

**What to look at:**

- Both panels labelled `a` and `b` in the top-left, **bold 8 pt**.
- Y-axis labels on both panels, in the units appropriate to the data.
- X-axis categories named (Vehicle, 10 µM, … / WT, KO, Rescue).
- The bars do not overflow the panels; the points sit *on top of* the bars,
  not overlapping them.

**Failure:** a panel without its letter, or bars coloured outside the four
above (only occurs if a different palette was applied — not in the default
demo), or axis labels unreadable at the default zoom.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 2. Data tab — paste, preview, import

- [ ] **Run each format-detection snippet and check the live preview matches.**

The Data tab has a paste area and a file picker. Pasting (or selecting) data
produces a **live preview** before you commit to importing it.

### Format detection — paste each of these in turn

- [ ] **Grouped paste** — preview reads `grouped · 2 columns · 3 rows`.

   ```text
   Group,Value
   A,1
   A,2
   B,3
   ```
   Columns should show `Group` (A) and `Value` (#).

- [ ] **Replicate paste** — preview reads `replicate · 4 columns · 2 rows`.

   ```text
   Treatment,Rep1,Rep2,Rep3
   Vehicle,10,11,12
   Drug,4,5,6
   ```

- [ ] **Prism paste** — preview reads `prism · 3 columns · 2 rows`.

   ```text
   X,Y1,Y2
   1,2,5
   2,3,6
   ```

- [ ] **Broken paste** — pasting `42` produces no preview and hides the
  Import button.

### Import

- [ ] **Import a successful preview** — a new panel labelled `c` (or next
  available letter) appears with the data plotted.

**Failure:** preview shows a wrong format (e.g. the Prism paste labelled
`replicate`), the columns display `A` instead of `#` for numeric, or
importing produces a panel with no data.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 3. Layout — auto-arrangement

- [ ] **Click Auto layout** — grid label updates and panels rearrange; switch
  journal preset to see the page-width readout and figure rescale.

Click **Auto layout** in the toolbar.

- With 1 panel the label reads `1×1`.
- With 2 panels: `1×2`.
- With 3 panels: `1×3`.
- With 4 panels: `2×2`.
- With 5 or 6 panels: `2×3` (the grid selector rounds the square-root up).

> **Why:** the auto-layout rounds up — 5 panels sharing a 2×3 grid is by
> design, not a bug.

Change the **journal preset** dropdown at the top-left to a different
journal — try **Nature — single column**. The page readout should switch
to `89.0 mm × …` and the figure should rescale to fit. Try **Cell — double
column** (174 mm) and **Science — triple column** (183 mm) to see the
full range.

**Failure:** changing the preset does not change the page width, or the
panels do not re-arrange after the preset change.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 4. Layout — manual nudge

- [ ] **Select a panel and nudge it with arrow keys** — `sel …` readout
  updates by 1 / 5 / 0.1 mm for plain / Shift / Alt respectively; toggle
  Snap and Grid to confirm behaviour.

Click any panel to select it (a red dashed outline appears; the top-right
shows a `sel 87.0 mm × 60.0 mm` readout for that selection).

- **Arrow keys** nudge by 1 mm (the grid spacing).
- **Shift + arrow** nudges by 5 mm.
- **Alt + arrow** nudges by 0.1 mm — useful for fine adjustment.

The **sel …** readout should update after every keypress. Pressing arrow
keys with no panel selected does nothing — that is expected.

Toggle the **Snap** checkbox off and confirm nudge no longer snaps to the
grid. Toggle the **Grid** checkbox to see a faint 1-mm grid overlay (this is
canvas-only and is **not** included in exports).

> **There is no marquee / rubber-band selection.** Dragging on the empty
> canvas only clears the current selection. Selecting multiple panels
> requires Ctrl/Cmd-click or Shift-click on each one. Do not file this as
> a bug.

**Failure:** keys do nothing at all (the focus might be in a text input —
click the canvas first), or the nudge distance is wrong (one full panel's
worth instead of 1 mm).


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 5. Stats tab — single comparison

- [ ] **Run Welch's t-test on the demo data** — bracket with `****` appears
  over bars; results table, adjusted P ≤ 0.05 in green, methods sentence
  expands and Copy works.

With the demo data loaded, open the **Stats** tab.

- The **Plot** dropdown shows your current plots; it auto-selects the first
  one.
- The **Test** dropdown defaults to **Welch's t-test**.
- The **Multiple comparisons** dropdown defaults to **Holm-Bonferroni**.
- Below the controls, the **Groups hint** reads something like
  `Groups: Vehicle (n=4), 10 µM (n=4), 50 µM (n=4), 100 µM (n=4)`.

Click **Run and annotate**. The toolbar briefly shows `Running analysis…`.
When it clears:

- A results table appears with the comparisons run. Adjusted P values ≤ 0.05
  render in **green**; values > 0.05 render in default colour.
- For each significant comparison, a `****` (or fewer stars) significance
  bracket appears above the relevant bars in the canvas. The bracket's two
  ends should sit directly over the centres of the bars it links.
- Below the table, expand the **Methods sentence** disclosure to see a
  paste-ready prose sentence of the form *"Data were analysed by two-tailed
  unpaired Welch's t-test (n = N per group). … vs …: P_adj < 0.001, Hedges'
  g = …, 95% CI […, …]. Significance was assessed at α = 0.05. Analyses
  were performed in Python 3.12 …"*. The exact effect size and CI depend on
  the comparison; what matters is that the sentence is well-formed and the
  brackets line up. Click **Copy** to confirm the browser clipboard receives
  the text.

> **The results table shows Comparison / P / P_adj / Effect. It does not show
> a confidence-interval column.** The CI is computed and lives inside the
> generated **Methods sentence**, not in the table. Verify the CI by
> expanding the methods sentence, not the table.

**Failure:** API error banner reading "Could not reach the analysis service.
Is the API running?" — the API container is not up. Click the **Stats** tab
again once it is.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 6. Stats tab — corrections and test switching

- [ ] **Switch the correction** — methods sentence wording changes per option
  (None, Holm-Bonferroni, Bonferroni, Benjamini-Hochberg).
- [ ] **Switch to One-way ANOVA** — methods sentence changes and the
  results table now contains three pairwise comparisons.

The **Multiple comparisons** dropdown offers four choices:

| Choice | What the methods sentence will contain |
|---|---|
| None | no correction mentioned |
| Holm-Bonferroni | "with Holm-Bonferroni correction for multiple comparisons" |
| Bonferroni | "with Bonferroni correction" |
| Benjamini-Hochberg (FDR) | "with Benjamini-Hochberg false discovery rate correction" |

Re-run after each change and confirm the methods sentence picks up the
correct wording. Adjusted P values will increase as the correction becomes
more conservative.

Switch the **Test** dropdown to **One-way ANOVA** and re-run. The methods
sentence should change to *"…by one-way ANOVA…"*, and the results table
should now contain **three** pairwise comparisons (vehicle vs 10 µM,
vehicle vs 50 µM, vehicle vs 100 µM). This is the omnibus-then-pairwise
flow — the omnibus is reported inside the methods sentence, not the table.

**Failure:** the methods sentence does not change when the dropdown
changes, or pairwise comparisons don't appear after switching to ANOVA.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 7. Stats tab — assumption warnings

- [ ] **Trigger the Levene warning** — paste the unequal-variance dataset,
  run Welch's t-test, confirm a yellow warning appears above the results.

The demo data has equal n's and similar variances, so **no** warning is
expected on the default run — that is normal.

To deliberately trigger a warning, paste this into the data box and run
Welch's t-test:

```text
Sample,A,B
s1,5.1,0.5
s2,5.0,9.5
s3,5.0,1.2
s4,5.0,9.0
```

A small **yellow warning** should appear above the results table mentioning
either *Levene P* or *variances differ*. This is the **assumption checker**
telling the tester the data violate a t-test assumption.

**Failure:** no warning appears, or a warning appears on the clean demo
data (false positive).


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 8. Quality tab — Publication Readiness Score

- [ ] **Default demo shows 100/100** with seven green ✓ and zero findings.
- [ ] **Break it deliberately** — change Height to 400, switch to Nature
  double-column; score drops, Page dimensions flips to yellow `!`, the
  "Height exceeds the 247 mm limit" finding appears.

Open the **Quality** tab. With the default demo:

- A large score reads **100/100** (green, because ≥ 90).
- A **Target resolution** dropdown reads 300 dpi.
- A **Categories** list shows seven rows, each with a green ✓:
  Text size, Image resolution, Panel labelling, Colour accessibility,
  Font consistency, Page dimensions, Panel spacing.
- **Findings** shows the line *"Nothing to fix. Ready to export."*

### Deliberately break it

In the top toolbar, change the **Height** number from 75 to **400** and
confirm the value is accepted (the field's HTML max is 400, and values
above that are *not* programmatically clamped — try 9999 and see what
happens). Then switch the journal preset to **Nature — double column** (max
height 247 mm). The Quality tab recomputes:

- The score should drop sharply (large error forfeits a category).
- The **Page dimensions** row should flip to a yellow **!**.
- A finding titled *"Height 400.0 mm exceeds the 247 mm limit"* appears
  with severity **error**.

Click **Select 1 affected** on the finding — the page rectangle on the
canvas should briefly outline, confirming the finding is wired to the
actual nodes.

Reset by typing 75 back into the Height field. The score should return to
100/100.

**Failure:** score does not change when the height is altered, or the
finding does not appear.

> **The Quality tab's "Target resolution" dropdown is *separate* from the
> bottom status bar's "Raster DPI" dropdown.** Quality cares about whether
> images inside the figure will print at ≥ the target DPI; the export DPI
> is about what you actually render. They are deliberately independent.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 9. Layers tab

- [ ] **Visibility, lock, delete** — toggle each on a non-essential layer
  (Labels / Graphs); confirm a deleted panel label disappears and Undo
  restores it (see section 10).

Open the **Layers** tab. Five layers are listed top-to-bottom in **reverse
draw order**:

1. **Labels** — panel letters (a, b).
2. **Statistics** — significance brackets.
3. **Annotations** — currently empty.
4. **Graphs** — plots and panel frames.
5. **Images** — currently empty (no images are inserted in the demo).

Each layer has two icon buttons on its row:

- **Visibility dot** (● visible / ◌ hidden) — click to hide or show all
  nodes on that layer. Test on **Annotations** first (no visible change
  expected, since it's empty), then on **Labels** to make the `a`/`b`
  letters disappear from the canvas; click again to restore them.
- **Lock** (🔒 / 🔓) — when locked, none of the layer's nodes can be
  dragged. Lock **Graphs** and confirm trying to drag a panel does
  nothing.

Beneath each layer is a list of **nodes** (each labelled `panel`, `plot`,
`bracket`, `panel-label`, etc.). Click a row to select that node on the
canvas — the canvas selection outline should move to it.

Each row has a small **×** button. Click it on a panel-label row to
delete that label. The canvas updates immediately.

**Failure:** visibility/lock toggles don't change anything, deleted nodes
re-appear, or selection doesn't update.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 10. Undo / redo

- [ ] **Ctrl+Z / Ctrl+Shift+Z round-trip** — after the deletion in section
  9, the toolbar buttons and keyboard shortcuts both work.

After deleting a node in section 9:

- Click **Undo** in the toolbar (or **Ctrl+Z** / **Cmd+Z** on the keyboard).
  The deleted node should return.
- Click **Redo** (or **Ctrl+Shift+Z** / **Cmd+Shift+Z**). It should
  disappear again.

The keyboard shortcuts must work *without* a text input having focus —
click the canvas first if you just typed in the paste area.

**Failure:** keyboard shortcuts do nothing, or one of the buttons stays
disabled when there is history available.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 11. Export — vector formats

- [ ] **PDF** downloads (~25 KB), opens at exactly 183.0 mm × 75.0 mm with
  selectable text; exactly one page; bracket and `****` are visible.
- [ ] **EPS** downloads (~330 KB) and starts with `%!PS-Adobe-3.0 EPSF-3.0`.
- [ ] **SVG** downloads and renders identically to the canvas in a browser.

Click **PDF** in the bottom status bar. A file downloads; the toolbar
briefly shows `Exporting PDF…`. The filename is the figure title (top of
the canvas) plus `.pdf`.

Open the PDF in any viewer that shows page properties (Acrobat, Preview on
macOS, or any browser PDF viewer).

Confirm:

- **Page size reads exactly 183.0 mm × 75.0 mm.** In Preview this is under
  Tools → Show Inspector → Pages; in Acrobat it is File → Properties.
- **Text is selectable.** Click and drag over the panel letter `a` with a
  text-tool. It should highlight as text — if the letter turns into a
  rectangle of the figure when clicked, the text has been outlined, which
  is a regression.
- The bracket and `****` stars appear above the relevant bars.
- The PDF has **exactly one page** — a second blank page would mean the
  `svg { display: block }` fix has regressed.

Click **EPS** (~330 KB). Open it in any text editor and confirm the first
line reads `%!PS-Adobe-3.0 EPSF-3.0`. Click **SVG** (a few KB). Drag it
into a browser tab — it should look identical to the canvas, including
the bracketed significance stars.

**Failure:** text is outlined (regression of the export-fidelity invariant),
wrong page size, missing bracket, or blank second page.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 12. Export — raster formats

- [ ] **PNG at 300 dpi** is ~2163 × 884 pixels, not pixelated.
- [ ] **PNG at 600 dpi** doubles the pixel count.
- [ ] **TIFF** carries the embedded DPI in its properties dialog.

Set **Raster DPI** in the bottom status bar to **300** and click **PNG**.
A PNG downloads (~45 KB). Open it in Preview (or any image viewer) and
confirm:

- **Pixel dimensions are about 2163 × 884** (183 mm × 75 mm at 300 dpi —
  300 dpi means 300 pixels per inch of physical size).
- The figure is not pixelated — text looks crisp at 100% zoom; nothing
  is rasterised.

Change **Raster DPI** to **600** and re-export. The pixel dimensions
should roughly double (~4325 × 1768), confirming the raster DPI dropdown
actually controls the resolution.

Click **TIFF**. Open it and confirm the file's properties dialog reports
the embedded DPI matches what you selected (300 or 600). This is what a
journal's submission system uses to verify the resolution claim.

**Failure:** pixel dimensions don't scale with DPI (Chromium would be
ignoring the `device_scale_factor`), or the embedded DPI in the TIFF is
wrong.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 13. Project save / load

- [ ] **Save downloads a `.figureforge` zip** with `MANIFEST.json`,
  `document.json`, `data/*.csv`.
- [ ] **Open round-trips** — figure reappears identically (panels, brackets,
  analyses).

Click **Save project** in the bottom status bar. A file downloads with
the figure title plus the `.figureforge` extension. Open it with any zip
tool (Finder on macOS can preview a zip; `unzip -l <file>` on Linux) and
confirm the structure:

- `MANIFEST.json` — format marker
- `document.json` — the model
- `data/*.csv` — the verbatim original data files
- `assets/*` — present only if you added images (none in the demo)

Then click **Open project** in the bottom status bar and pick the file
you just saved. The figure reappears identically — same panels, same
brackets, same analysis results.

**Failure:** save does nothing (no download), open fails with a red banner
("Could not open project: …"), or the figure looks different after
loading.


> **Session ____-__-__** — passed / failed / skipped. _one-line summary_
---

## 14. End-to-end in one go

- [ ] **Full flow** — paste → import → auto layout → Welch t-test → bracket
  → Quality ≥ 80 → PDF opens at 183 × 75 mm with selectable text.

The combined scenario, written as a single continuous flow. Run this when
you just want to know *"is the whole thing working today?"*.

1. **Data** tab → paste the in-app viability demo (section 16) → click
   **Import as new panel**.
2. Click **Auto layout**.
3. **Stats** tab → Plot: the new panel → Test: **Welch's t-test** →
   Multiple comparisons: **None** → click **Run and annotate**.
4. Look at the canvas — confirm a `****` bracket appears over the two
   bars.
5. **Quality** tab → confirm the score is ≥ 80 / 100 and no error-severity
   findings.
6. Bottom status bar → click **PDF**. Open the PDF. Confirm 183.0 mm ×
   75.0 mm and selectable text.

If every step passes, the core pipeline works.

> **Session ____-__-__** — passed / failed / skipped. _one-line summary_

---

## 15. What NOT to file (these are not yet built)

- [ ] **Confirm I've read this section** — items here are deliberately not
  built; do not file them as bugs.

Check this list before reporting something as a bug — every item here is in
CLAUDE.md's "declared but missing" or "already scaffolded but unused"
section. **Do not report any of these.**

- Plot types **scatter**, **line**, **box**, **violin**, **histogram**.
  Selecting one of these in code draws *something* — but it is the same
  categorical dot path, not a real scatter/line/box/violin/histogram.
- Statistical tests **anova-rm**, **wilcoxon**, **chi-square**,
  **linear-regression** — present in the data model and Python service,
  but not in the Stats tab dropdown.
- **Image panels**, **scale bars**, **arrow**, **shape** tools — the node
  types and renderers exist; no UI button to create them yet.
- **Marquee / rubber-band selection** — clicking on empty canvas only
  clears selection (see section 4).
- **Drag-to-resize** handles on panels — only drag-to-move exists.
- **Per-plot controls** — there is no UI to change plot type, error-bar
  kind, axis scale, axis title, axis min/max, or colour palette from the
  interface. These live on the data model but the only editable aspects
  per plot are its frame position and size.
- **Stale-analysis warning** — the system records an `inputHash` to detect
  whether data has changed since the analysis ran, but no UI surface calls
  this check.
- **Quality autofix button** — findings list `autoFixable: true`, but no
  button exists to apply the fix. The select-affected-nodes button is the
  only action.
- **The desktop app (Electron)** — only the web app is built.

---

## 16. Test datasets

- [ ] **Use each dataset below at least once** during a session — different
  shapes exercise different parts of the import path.

All values below are taken from existing code in the repo so the
expected outcomes are real, not invented.

### Vehicle viability (in-app demo, already loaded)

- [ ] Vehicle viability is significant at every dose vs vehicle (P < 0.001).

```text
Treatment,Rep1,Rep2,Rep3,Rep4
Vehicle,98.2,95.4,101.3,97.8
10 µM,74.5,71.2,78.9,73.1
50 µM,42.1,38.7,45.3,40.2
100 µM,18.4,21.9,16.2,19.7
```

A 4-treatment dose–response, n = 4 per group, expected to be **highly
significant** at every dose vs vehicle (P < 0.001).

### Genotype expression (in-app demo, already loaded)

- [ ] Genotype expression distinguishes the KO genotype from WT.

```text
Genotype,Rep1,Rep2,Rep3
WT,1.02,0.98,1.00
KO,2.41,2.68,2.55
Rescue,1.18,1.09,1.24
```

Three genotype groups, n = 3 per group.

### Student's 1908 sleep data (Welch's t-test reference)

Two groups of 10 paired observations each. Use as
**`Treatment,Rep1,Rep2,…,Rep10`** with two rows:

```text
Treatment,g1,g2,g3,g4,g5,g6,g7,g8,g9,g10
Control,0.7,-1.6,-0.2,-1.2,-0.1,3.4,3.7,0.8,0.0,2.0
Treated,1.9,0.8,1.1,0.1,-0.1,4.4,5.5,1.6,4.6,3.4
```

The app will auto-detect this as **replicate**. Run **Welch's t-test**
with **No multiple comparisons** and confirm `P ≈ 0.079` — the
canonically published value. (Reference: Student's 1908 paper; same
result in R's `t.test`.)

> **Note:** the values above are 10 replicates per row, so the importer
> will see 11 columns. If the live preview mislabels the format, change
> the first column to read `X,g1,…,g10` for two rows of `Control` and
> `Treated`; the app will then detect `prism` and behave equivalently.
> The P value is the same in either case.

### PlantGrowth (one-way ANOVA reference)

- [ ] PlantGrowth ANOVA matches R: F(2, 27) = 4.85, P = 0.016.

Three groups of 10 observations each. Paste as replicates:

```text
Group,R1,R2,R3,R4,R5,R6,R7,R8,R9,R10
ctrl,4.17,5.58,5.18,6.11,4.50,4.61,5.17,4.53,5.33,5.14
trt1,4.81,4.17,4.41,3.59,5.87,3.83,6.03,4.89,4.32,4.69
trt2,6.31,5.12,5.54,5.50,5.37,5.29,4.92,6.15,5.80,5.26
```

Run **One-way ANOVA**. Methods sentence should report `F(2, 27) = 4.85,
P = 0.016`. Three pairwise comparisons follow. (Reference: R's
`summary(aov(weight ~ group, data = PlantGrowth))`.)

### Unequal-variance trigger (assumption-warning test)

- [ ] Triggers a Levene/variance warning above the results table.

```text
Sample,A,B
s1,5.1,0.5
s2,5.0,9.5
s3,5.0,1.2
s4,5.0,9.0
```

Use with **Welch's t-test** in section 7 of this plan. A Levene / variance
warning should appear.

---

## 17. Suggestions for the next round of development

What you'd like to see built or fixed next. One item per row. The next
development session reads this list when deciding what to work on.

1. _title_ — `initials, YYYY-MM-DD` — _one-line rationale_
2.
3.
4.
5.

> Examples of useful suggestions:
>
> - **Box plots** — `AK, 2026-08-01` — section 15 lists them as not-yet-built, but the analysis service already has the maths; a next session could build the renderer.
> - **Image panels** — `BJ, 2026-08-02` — important for our microscopy figures; would unblock the "image in figure" use case.
> - **Drag-to-resize** — `CM, 2026-08-03` — I tried to drag panel corners and it just moved the whole panel; frustrating.

Delete empty rows at session end so the list doesn't grow forever.

---

## 18. Notes & suggestions

Use the table below for anything you find **broken** or otherwise worth
recording. **Describe the issue by what you clicked** — not by paragraph.
Include the figure title (top of the canvas) and the export format, if
relevant.

**Before you file, check section 15** — features listed there are
deliberately not yet built, and reporting them wastes both our time.

| # | Date | What I tried (clicks) | What I expected | What happened | Severity |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |

**Severity** — pick one:

- **Just a question** — clarification, not a defect.
- **Minor cosmetic** — a misalignment, off-by-one, label wording.
- **Looks wrong** — visual output doesn't match the description.
- **Broken** — clicking a control does nothing wrong output, file
  downloads corrupt, calculation is off.
- **Security** — anything that suggests a sandbox escape or data leak.