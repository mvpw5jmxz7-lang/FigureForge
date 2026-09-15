# FigureForge — A Guide for Everyone

**Version 0.1.0 · September 2026.** FigureForge has no version number on screen
yet; if you're not sure how current your copy is, run `git log -1` in the
project folder and compare the date.

This guide is written for people trying FigureForge who don't write code. If
you've never used a "terminal" before, that's fine — every command you need to
type is written out exactly, and there's a short glossary at the end for any
word that isn't explained the moment it comes up.

**Jump to:** [1. What this is](#1-what-this-is) · [2. What works and what
doesn't](#2-what-works-today-and-what-does-not-yet) · [3. Installing what you
need](#3-installing-what-you-need) · [4. Getting the
project](#4-getting-the-project-onto-your-computer) · [5. Moving FigureForge to
another computer](#5-moving-figureforge-to-another-computer) · [6. Starting it
up](#6-starting-it-up) · [7. First
walkthrough](#7-using-the-app-for-the-first-time) · [8. Command
reference](#8-command-reference) · [9. Stopping
it](#9-stopping-it-or-starting-fresh) · [10.
Troubleshooting](#10-troubleshooting) · [11. Giving
feedback](#11-how-to-give-useful-feedback) · [12. Glossary](#12-glossary)

---

## 1. What this is

FigureForge turns spreadsheet data into the kind of multi-panel figure a
science journal expects — the sort you'd see in *Nature* or *Cell*: clean bar
charts, scatter plots, heatmaps and more, with error bars and significance
stars placed automatically after a real statistical test, panels neatly
labelled **a**, **b**, **c**, arranged on a page sized to that journal's
column width — and it exports a file you can actually submit.

It runs the real statistics (via a well-established Python library called
SciPy, the same engine used across scientific computing), not a rough
approximation — so the p-values and confidence intervals it reports are the
real ones.

The core pipeline — data in, chart, statistics, quality check, publication-
ready export — is complete. A couple of things are still open (there's no
downloadable installer yet); section 2 below is honest about exactly what to
expect, so you can tell the difference between "this is broken" and "this
hasn't been built yet."

---

## 2. What works today and what does not yet

### Works today

- **Import data.** Paste a table from Excel, or drop in a `.csv`/`.tsv`/`.txt`
  file. It recognises a wide range of common layouts — a treatment column with
  replicate columns, a simple X/Y table, grouped/nested data, contingency
  (count) tables, a differential-expression table, a fold-change-vs-fold-change
  table, a samples-by-features matrix, survival (time-to-event) data, a series
  of groups where each column is its own stack of observations (`Y1, Y2,
  Y3, …`, for histograms and distribution comparisons) — and shows you a
  preview before anything is added to the figure.
- **Every chart type on the menu is real**, not a placeholder: bar, dot,
  bar+dot, beeswarm, box, violin, scatter, line, histogram and cumulative
  distribution (ECDF) plots; plus the more specialised omics/biostatistics
  types — **volcano plots**,
  **fold-change vs fold-change plots** (the same protein's change in two
  different comparisons, plotted against each other, with a cutoff on each
  axis), **heatmaps**,
  **Kaplan–Meier survival curves**, and **PCA**/**UMAP** dimensionality-
  reduction plots (run directly from an imported data matrix via a "Run PCA" /
  "Run UMAP" button). Which types are offered depends on the shape of your
  data — for example, a volcano plot needs a differential-expression-shaped
  table — so the dropdown only ever offers types your data can actually
  support, rather than drawing something misleading from the wrong shape. A
  histogram over several groups shares one set of bins across them, drawn as
  overlaid translucent bars or side-by-side outlines, with an option to
  accumulate it into a cumulative histogram.
- **Error bars and replicate display**: standard deviation, standard error, or
  a 95% confidence interval, with the individual data points shown alongside.
- **Real statistics**, all reachable from the on-screen Stats tab: t-tests,
  one-way and repeated-measures ANOVA, Mann-Whitney, Kruskal-Wallis, Wilcoxon,
  chi-square, Fisher's exact, correlation (Pearson/Spearman), linear
  regression, a log-rank test for survival curves, and four tests for comparing
  whole distributions — Kolmogorov-Smirnov, Anderson-Darling, Cramér-von Mises
  and Epps-Singleton — with correction for
  multiple comparisons, an effect size, and a ready-to-paste sentence for your
  methods section. Running Kolmogorov-Smirnov on a cumulative distribution
  (ECDF) plot also draws the two-sample gap the test measures directly on the
  curve. On a scatter or a fold-change-vs-fold-change plot, running
  Pearson or linear regression also **draws the fitted line on the panel**, and
  the Inspector can add a 95% confidence band (where the true line lies) or a
  prediction band (where a new observation would fall). Spearman deliberately
  draws no line: it measures how consistently the ranks move together, not how
  closely the points sit on a straight one. (A few combinations are *deliberately* refused with an
  on-screen explanation rather than run anyway — for example, a nested design
  needs a hierarchical model this tool doesn't fit, and a count table doesn't
  support a t-test. That's a stated statistical guardrail, not a missing
  feature.)
- **Automatic significance brackets** — run a test and it draws the bracket
  with `*` / `**` / `***` / `****` / `ns` positioned correctly over the bars
  or curves being compared, and keeps them positioned correctly if you move
  or resize things afterwards.
- **Image panels.** Import a microscopy image, western blot or gel (PNG, JPEG,
  SVG or TIFF), crop it, add a calibrated scale bar, and annotate it with
  arrows, shapes or text — including tiling several images into one panel.
- **Multi-panel layout.** Add several panels, click one button, and they're
  arranged evenly on a journal-sized page with matching gutters and correctly
  lettered — with more than twenty layout templates to choose from, including
  vertical stacks, plus a **Smart layout** that measures each panel and sizes
  them against one another (small charts small, detailed micrographs large).
- **A "publication readiness" score** out of 100, with a plain-English list of
  anything that would likely get the figure sent back (text too small, images
  too low-resolution, colours that don't work for colour-blind readers, and so
  on). Many of these come with a one-click fix; a few genuinely need a
  decision only you can make (like which colours mean what), so those explain
  the problem and take you straight to the right control instead of guessing.
- **Export** to PDF, EPS, SVG (all fully editable, with real selectable text —
  not a picture of text), or PNG/TIFF at print resolution.
- **Save and reopen your work** as a project file (see the glossary entry for
  `.ffg` files) — use the **Save**, **Save as…**, **Open project** and **Close
  file** buttons at the bottom of the window. On a browser that supports it, a
  **Set folder…** button there fixes which folder the Open and Save dialogs
  start in.
- **A built-in sample figure** — **Open sample** loads an eight-panel worked
  example (statistics, brackets, group titles and a microscopy montage
  already in place) to explore. It
  can't be overwritten; **Save as…** turns it into a figure of your own.
- **An AI layout helper**, on the Smart Layout tab beside **Smart layout**
  itself. Click **Suggest panel groups** to get a suggested grouping of
  panels that narratively belong together (with a short reason for each), or
  type a plain instruction like "give the heatmap more room" or "keep the
  montage near panel c" and have it turned into a grouping or a size nudge
  the layout search can act on — nothing changes until you approve a
  suggestion. It never invents millimetres or moves a panel itself; the
  actual arrangement is still the same measured, deterministic search Smart
  layout always runs. By default this uses a small built-in fallback (simple
  keyword matching) so the buttons work out of the box; for real AI-powered
  suggestions, paste your own Anthropic API key into the box the tab shows
  you — it walks you through getting one from Anthropic's own console,
  step by step, including the billing setup a key needs before it works.
  Your key is stored only in your browser (never on FigureForge's own
  server, and never saved into a figure file) and is sent straight to
  Anthropic only when you use the feature; **Test** confirms it works before
  you rely on it, and **Remove** clears it at any time.

### Not finished yet — please don't report these as bugs

- **A standalone desktop app.** Right now this only runs as a website you open
  in your browser (see below) — there's no downloadable, double-click-to-
  install application yet.
- **No autosave.** FigureForge doesn't save your work in the background. If
  you have unsaved changes the browser will warn you before you close the tab,
  but there's no recovery after a crash or a forced quit. Save often,
  especially before trying something you might want to undo.
- **A couple of smaller, documented trade-offs**, mentioned here so they don't
  come as a surprise: a 16-bit scientific image (common for microscopy)
  displays and exports at 8-bit for the figure itself, though your original
  file is always kept byte-for-byte inside the saved project; and a rotated
  JPEG (from a phone camera, for instance) displays in whatever orientation it
  was saved in, without reading the camera's rotation tag.

If something looks wrong and it **isn't** on this list, that's useful
feedback — see [section 11](#11-how-to-give-useful-feedback).

---

## 3. Installing what you need

You only need to read the section for your own computer.

### On macOS

You need one thing: **Docker Desktop**.

1. Go to **[docker.com](https://www.docker.com/products/docker-desktop/)** and
   download Docker Desktop for Mac.
2. Open the downloaded file and drag Docker into your Applications folder, as
   it will instruct you.
3. Open Docker Desktop from your Applications folder. The first launch may ask
   for your Mac password — that's normal, it needs it to set itself up.
4. Wait until the little whale icon in your menu bar stops animating and
   Docker Desktop's window says it's running. Leave Docker Desktop open in the
   background whenever you're using FigureForge — it does the actual work.

That's the only thing to install. You do **not** need to separately install
Python, Node, or anything else — Docker Desktop provides everything
FigureForge needs, self-contained.

#### If you prefer podman (command-line, no GUI)

Docker Desktop is the simplest option and the one to pick if you just want to
try FigureForge. If you'd rather not run a background GUI app — or you already
use **podman** — that works too, and FigureForge is then driven with the same
`make` commands shown in the Linux sections throughout this guide.

1. If you don't already have **Homebrew** (a package installer for macOS), get
   it from **[brew.sh](https://brew.sh)**.
2. Install podman and make:
   ```bash
   brew install podman make
   ```
   (`make` often comes with Apple's developer tools already; if `brew` reports
   it's already installed, that's fine.)
3. Start podman's Linux engine — a one-time setup; afterwards it starts on
   demand:
   ```bash
   podman machine init
   podman machine start
   ```
4. From then on, use `make up`, `make down`, `make logs` and so on — every
   command in this guide that shows a **Linux** version.

This works the same on an Apple Silicon (M-series) Mac as on an Intel one — the
pieces FigureForge downloads come in both versions and it picks the right one
automatically.

> **A note on how this was written:** the podman path above is how this project
> is set up to run on macOS, and it uses the same commands as the Linux
> instructions, which have been run and checked. The Docker Desktop path on
> macOS, and all of the Windows steps, match how Docker Desktop and this
> project's setup files work but have **not** been tested on those systems
> directly. If a step doesn't match what you see, that's useful feedback too.

### On Windows

You need **Docker Desktop**, which on Windows relies on a feature called WSL2
(a lightweight Linux environment Windows can run alongside itself — Docker
needs it to work).

1. Go to **[docker.com](https://www.docker.com/products/docker-desktop/)** and
   download Docker Desktop for Windows.
2. Run the installer. If it tells you WSL2 isn't installed or enabled, let it
   install/enable it for you (or follow the link it gives you) — this usually
   requires one restart of your computer.
3. If your computer refuses to enable WSL2 at all, the most common cause is
   that "virtualization" is turned off in your PC's BIOS/UEFI settings. This
   varies by manufacturer; searching "[your PC model] enable virtualization
   BIOS" will get you there. This is only needed if the installer specifically
   asks for it.
4. After installing, open **Docker Desktop** from the Start menu. Wait for its
   window to say it's running (the whale icon in the system tray, bottom-right
   of the screen, stops animating).
5. Leave Docker Desktop open in the background whenever you're using
   FigureForge.

You do **not** need to separately install Python, Node, or anything else.
(The podman alternative described under macOS is not a practical option on
Windows — use Docker Desktop.)

### On Linux

You need **podman** and **make**. Most distributions have these in their
standard package manager:

```bash
# Fedora / RHEL
sudo dnf install podman make

# Ubuntu / Debian
sudo apt install podman make
```

### What is a terminal

This applies on macOS, Windows and Linux alike. A few steps below ask you to
type a command into a **terminal** — a text-based window for typing
instructions to your computer instead of clicking. If you've never opened one:

- **macOS:** press `Cmd + Space`, type `Terminal`, press Enter.
- **Windows:** press the `Windows` key, type `Terminal`, press Enter (this
  opens Windows Terminal, which runs PowerShell — the commands in this guide
  work the same there).
- **Linux:** look for "Terminal" in your applications menu, or press
  `Ctrl + Alt + T` on most distributions.

---

## 4. Getting the project onto your computer

If someone has already given you a folder containing this project, you can
skip straight to opening a terminal in that folder — see below.

If you're starting from scratch and have the project's location (a link
ending in `.git`), open a terminal and run:

```bash
git clone <the link you were given>
```

That creates a folder with everything in it.

### Opening a terminal *in* the project folder

This trips people up more than anything else, so it's worth being explicit.
You need the terminal's "current location" to be the project folder before
any command below will work.

- **Easiest way on every platform:** open the terminal, type `cd ` (with a
  trailing space), then drag the project folder from Finder/Explorer/Files
  straight into the terminal window — it will paste the correct path
  automatically. Press Enter.
- You'll know it worked if, when you type `ls` (macOS/Linux) or `dir`
  (Windows PowerShell — `ls` also works there) and press Enter, you see a
  list of files including `README.md`, `GUIDE.md`, `Makefile`, and folders
  like `apps` and `packages`.

Every command in this guide from here on assumes you're sitting in that
folder.

---

## 5. Moving FigureForge to another computer

This section is for two different situations: giving the whole app to
someone else (or setting it up on a second computer of your own), and simply
handing someone a figure you made. They're different problems with different
answers, so they're covered separately.

### Moving the whole app to a new computer

The short version: **only the project folder needs to travel** — but if you've
already run FigureForge on this computer, one part of the folder must be left
behind (see the warning below). Docker (or podman) has to be freshly installed
on the new computer — that's [section 3](#3-installing-what-you-need), for
whichever operating system it runs — and the very first time you start
FigureForge there it will spend a few minutes rebuilding everything, exactly
like the first time you ever ran it. That rebuild is normal and only happens
once per computer.

> **Leave the `node_modules` folders behind.** Before you've ever run
> FigureForge, the project folder is small. Once you've started it, it creates
> one or more folders named `node_modules` *inside* the project folder (for
> example `apps/web/node_modules`). These hold downloaded programs compiled for
> **this** computer's processor and operating system — they will not run on a
> different one, and copying them across is the single most common reason
> FigureForge won't start on the new machine. It bites hardest when the two
> computers have different processors, such as an Intel PC to an Apple Silicon
> Mac.

**Option 1 — you have access to where the project is hosted (a link ending in
`.git`).** This is the easiest and safest route, and it avoids the
`node_modules` problem entirely — that folder is never part of what `git`
stores. On the new computer, just follow
[section 4](#4-getting-the-project-onto-your-computer) and run `git clone`
there directly. Nothing is copied by hand at all.

**Option 2 — you don't have that, you just have the folder on this
computer.** Copy the folder itself across:

1. On the computer you're copying *from*, first stop FigureForge if it's
   running (see [section 9](#9-stopping-it-or-starting-fresh)) — not strictly
   required, but it avoids copying a folder mid-write.
2. **Delete every `node_modules` folder inside the project** (per the warning
   above). This also makes the copy dramatically smaller and faster.
   - **macOS / Linux:** open a terminal in the project folder and run
     `find . -name node_modules -type d -prune -exec rm -rf {} +`
   - **Windows:** in File Explorer, search the project folder for
     `node_modules` and delete every folder it finds.

   Deleting these is always safe — FigureForge rebuilds them on the next start.
3. Right-click the project folder and compress/zip it (macOS: "Compress";
   Windows/Linux: "Compress to ZIP file" or "Send to → Compressed folder").
   This produces one file, much easier to move than a folder full of small
   files.
4. Move that one zip file to the new computer by whatever's convenient: a USB
   flash drive, a shared network drive, or a cloud service you already use
   (Dropbox, Google Drive, OneDrive, WeTransfer — it's an ordinary file).
5. On the new computer, unzip it (double-click, or right-click → "Extract"),
   which gives you back the project folder. If you skipped step 2 and the zip
   still contains `node_modules` folders, delete them now — before the first
   start — using the same commands as step 2.
6. Install Docker or podman on the new computer if you haven't already — see
   [section 3](#3-installing-what-you-need) for that computer's operating
   system.
7. Open a terminal in the unzipped folder (see [section
   4](#4-getting-the-project-onto-your-computer)'s callout on opening a
   terminal in the right place) and start it up as usual — [section
   6](#6-starting-it-up).

That's the whole process. If the first start on the new computer takes a while
and prints a lot of scrolling text, that's expected — but if the `web` piece
stops with an error mentioning `node_modules` or "Cannot find module", see
[section 10](#10-troubleshooting).

### Sharing just a figure, not the whole app

If you just want to send someone a figure you made — not set up FigureForge
on their computer — you don't need any of the above. A saved FigureForge
project is one small file ending in `.ffg` (see the glossary), and it travels
like any other file: attach it to an email, put it on a USB drive, or upload
it to cloud storage.

The only requirement on the receiving end is that the other person already
has FigureForge running on their own computer (their own copy, set up the
same way you did — see sections 3, 4 and 6). They don't need your project
folder at all. Once FigureForge is open in their browser, they click **Open
project** at the bottom of the window and pick the `.ffg` file you sent them
— it opens with everything intact: the data, the layout, and any statistics
that were run.

---

## 6. Starting it up

### On macOS and Windows

If you set up **podman** on macOS instead of Docker Desktop, skip this section
and follow the Linux instructions just below — `make up` and the other `make`
commands work identically on macOS.

```bash
docker compose up --build
```

**The first time you run this, it will take several minutes** — it's
downloading and assembling everything FigureForge needs. This is completely
normal; you'll see a lot of scrolling text. Subsequent starts are much
faster.

Leave that terminal window open — it's running the application. When you see
it settle down and stop scrolling (with lines mentioning `web` and `api`
still ticking over), it's ready.

Open your web browser and go to:

```
http://localhost:5173
```

### On Linux

```bash
make up
```

Same as above: the first run takes a few minutes to build, later runs are
fast. When it finishes, it prints:

```
web  -> http://localhost:5173
api  -> http://localhost:8000/health
```

Open `http://localhost:5173` in your browser.

### What "it's working" looks like

You should see a page titled **FigureForge**, with a toolbar across the top, a
blank journal-page-shaped sheet in the middle (with a line of text on it
pointing you at the Data tab to add your first panel), and a panel on the
right with tabs marked **Data / Inspector / Stats / Layout / Quality /
Layers**. (The exact colours depend on whether your computer is set to light
or dark mode — either is normal.)

FigureForge opens with an empty figure — there's no sample data loaded. The
next section walks you through building one from scratch; if you'd rather
look at a finished example first, click **Open sample** at the bottom of the
window.

### If the browser shows nothing or an error

1. **Check the terminal is still open and running.** If it printed an error
   and stopped, scroll up and read the last few lines — they usually say
   plainly what went wrong (a very common one is "port already in use," see
   [Troubleshooting](#10-troubleshooting)).
2. **Give it another minute**, especially on the very first run — the browser
   can be quicker to try than the app is to finish starting.
3. **Reload the page.** Sometimes the browser gets there before the app is
   fully ready.
4. If it still doesn't work, see [section 10](#10-troubleshooting).

---

## 7. Using the app for the first time

**Want to see a finished figure first?** Click **Open sample** at the bottom
of the window. It loads an eight-panel worked example — a bar chart, a
scatter with a fitted line, a timecourse, a violin plot, a survival curve, a
volcano plot, a heatmap and a microscopy montage — with statistics run,
significance brackets placed, and group titles and captions added, so you can
see the range of features in use. It
**can't be saved over**: your first **Save** opens a fresh "save as" dialog,
so anything you change becomes a new figure of your own rather than
overwriting the example.

The walkthrough below builds a figure from scratch instead. The app opens
empty, so the first step is to bring in some data — you can use the small
example table below and then swap in your own once you've seen the loop work.

1. **Click the Data tab** on the right, and paste this into the big paste box
   (select it here, copy, and paste — it's tab- and comma-tolerant):

   ```
   Group,Value
   Vehicle,10.1
   Vehicle,9.7
   Vehicle,10.4
   Vehicle,9.9
   Drug A,6.2
   Drug A,5.8
   Drug A,6.5
   Drug A,6.0
   Drug B,3.1
   Drug B,2.7
   Drug B,3.4
   Drug B,2.9
   ```

   A preview appears showing how it will be read (three groups of four
   replicates). Give the dataset a name if you like, then click **Import as
   new panel**. A bar-and-dot chart appears on the page, labelled **a**.

2. **Click the Stats tab.**

3. Under **Analysis**, the **Panel** dropdown should already show your new
   panel. Leave the **Test** as **Welch's t-test** (the default), and click
   **Run and annotate**.

4. Watch the figure — horizontal brackets with asterisks appear above the
   bars, stacked so they don't overlap. Three groups means three pairwise
   comparisons, so three brackets. Underneath, in the Stats panel, you'll see
   a table with the actual p-value, an *adjusted* p-value (the one that
   accounts for testing several comparisons at once — using it instead of the
   raw p-value is what stops a figure from overstating a result), an effect
   size for each pair, and (expand **Methods sentence**) a ready-to-paste
   sentence describing exactly what test was run and how it was corrected.

5. **Click the Quality tab.** You'll see a **Publication readiness** score out
   of 100, and a list of anything the tool thinks a journal would flag —
   ideally short for this small figure.

6. **Click PDF** in the bottom-right corner of the window. A file downloads —
   open it. The text in it is real, selectable text (try clicking and
   dragging over a label), and the page is sized exactly to the journal
   column width shown in the toolbar.

7. **Now try your own data.** Back in the **Data** tab, paste a table copied
   from a spreadsheet (or drag a `.csv` file onto the paste box), check the
   preview looks right, and click **Import as new panel** (for a proteomics
   intensity matrix the button reads **Import data table** instead, since
   that's an input to a test rather than a figure). Add a few panels, then
   click **Auto layout** in the toolbar — or open the **Layout** tab and try
   **Smart layout**, which sizes each panel against the others.

That's the whole loop: data in, chart and statistics, a quality check,
export. Once you're comfortable with it, the more specialised chart types —
volcano plots, heatmaps, survival curves, PCA/UMAP — work the same way, but
each expects your data in a particular shape; the Data tab's layout picker
explains what each one needs when you get there.

---

## 8. Command reference

Run these from a terminal, sitting in the project folder (see
[section 4](#4-getting-the-project-onto-your-computer)).

| What you want to do | macOS / Windows | Linux | What it does | If it doesn't work, check |
|---|---|---|---|---|
| Start the app | `docker compose up --build` | `make up` | Builds (if needed) and starts everything; prints the web address | Docker Desktop is open and running; no error text partway through the output |
| Stop the app | `docker compose down` | `make down` | Shuts everything down cleanly | Nothing to check — this one is safe to run any time, even if nothing is running |
| Run the automated checks | `docker compose exec web npm test` and `docker compose exec api python -m pytest -q` | `make test` | Runs the project's internal test suite — a sanity check that nothing is broken, not something you need for everyday use | The app must already be started (step above) first |
| Run the full example end-to-end | `docker compose exec web npx vite-node scripts/acceptance.ts` | `make acceptance` | Builds a whole sample figure from scratch — data, chart, statistics, export — and prints a checklist. Useful if you want proof the whole pipeline works without using the browser at all | The app must already be started first; a `[FAIL]` line tells you exactly which step broke |
| See what's currently running | `docker compose ps` | `make ps` | Lists the two pieces (`web` and `api`) and whether they're healthy | — |
| See what's happening inside | `docker compose logs -f` | `make logs` | Streams the live activity log — useful if something seems stuck and you want to see what it's actually doing | Press `Ctrl + C` to stop watching (this does not stop the app) |

On macOS with **podman** rather than Docker Desktop, use the commands from the
**Linux** column.

Two pieces run together: **web** (what you see in the browser) and **api**
(does the statistics and file conversion in the background). If the app looks
like it's running but statistics or exports don't work, check that both
pieces show as running/healthy with the "see what's currently running"
command above.

---

## 9. Stopping it or starting fresh

To stop everything:

```bash
docker compose down     # macOS / Windows
make down                # Linux
```

It's safe to run this even if you're not sure anything is running.

**If things seem properly stuck** — the app won't start, or behaves strangely
after an update to the project — the equivalent of "turn it off and on
again" is:

```bash
docker compose down && docker compose up --build     # macOS / Windows
make restart                                          # Linux
```

This rebuilds everything from scratch. It's slower (like the very first
start) but resolves almost anything short of an actual bug.

---

## 10. Troubleshooting

**"Port already in use" or similar, when starting up.**
This means something is already using the address FigureForge needs
(`5173` or `8000`) — most often, FigureForge is already running from
earlier and you just forgot. Run the "stop" command from section 9, then
start again. If that doesn't help, it may be a different program on your
computer using that same address; closing that program should free it up.

**The browser says it can't connect / "This site can't be reached."**
The app usually just hasn't finished starting yet — see
[section 6](#if-the-browser-shows-nothing-or-an-error) above. If Docker
Desktop isn't open and running, start it first.

**The page loads, but statistics or exports don't work, and you see a yellow
banner** saying the analysis service isn't reachable.
The `api` piece isn't running or hasn't finished starting. Check with the
"see what's currently running" command in section 8 — give it another
minute, or try the restart in section 9.

**The very first start takes forever.**
Expected — it's downloading and assembling everything. This only happens
once (or after a restart-from-scratch, or after moving the project to a new
computer — see [section 5](#5-moving-figureforge-to-another-computer));
normal starts afterwards are quick.

**The `web` piece stops with an error just after "installing npm dependencies"
— or right after you've moved the project from another computer.**
The message mentions `Cannot find module`, `ERR_MODULE_NOT_FOUND`, or "cannot
execute binary file". Leftover `node_modules` folders came across from the
other computer (see [section
5](#5-moving-figureforge-to-another-computer)). Fix it in three steps:

1. Stop everything **and** clear the cached download — this is the step people
   miss:
   - Docker: `docker compose down -v`
   - podman / Linux: `make clean`

   A plain `docker compose down` / `make down` is not enough — without the `-v`
   (or `make clean`) the broken cache stays and the same error comes straight
   back.
2. Delete every `node_modules` folder inside the project, exactly as in
   [section 5](#5-moving-figureforge-to-another-computer), Option 2, step 2
   (`find . -name node_modules -type d -prune -exec rm -rf {} +` on
   macOS/Linux; search-and-delete in File Explorer on Windows).
3. Start again (`docker compose up --build` / `make up`). It reinstalls
   everything from scratch — a few minutes, like a first run.

**(macOS) A command you pasted fails with `No rule to make target` or `unknown
primary or operator`.**
The Mac's default terminal (zsh) doesn't treat `#` as the start of a comment,
so if you pasted a command with an explanatory `# …` note after it, that note
was run as part of the command. Re-run it with everything from the `#` onwards
removed, or paste one line at a time. (Linux and Windows terminals handle `#`
normally — this one is macOS-only.)

**(Windows) The `web` piece won't start and the error mentions `bash\r`,
`'bash\r': No such file or directory`, or `exec ... : no such file or
directory`.**
The project's internal scripts were saved with Windows-style line endings when
the project was downloaded. Current versions of the project prevent this, so
the reliable fix is a fresh copy: run `git clone` again into a **new** folder
(see [section 4](#4-getting-the-project-onto-your-computer)) and start from
there. If you're comfortable with git and want to keep the folder you have, run
`git pull` then `git rm --cached -r . && git reset --hard` in it (this discards
any unsaved changes, so save your work first).

**(Windows) The installer says WSL2 isn't available, or Docker Desktop won't
start.**
Most often this means "virtualization" is switched off in the computer's
BIOS/UEFI settings, or WSL2 hasn't finished installing yet and the computer
needs a restart. The Docker Desktop installer usually tells you exactly which
of the two it needs — follow what it says and restart if asked.

**Nothing above matches what you're seeing.**
See [section 11](#11-how-to-give-useful-feedback) — copy the last 10–20
lines of text from the terminal window when reporting it; that's almost
always where the real answer is.

---

## 11. How to give useful feedback

This tool is still being refined, and your testing is genuinely part of that
— so when something looks wrong, a little detail goes a long way:

1. **First, check [section 2](#2-what-works-today-and-what-does-not-yet).** If
   it's on the "not finished yet" list, it's expected — no need to report it
   (though "I hit this and was confused" is still useful, just frame it as
   that rather than as a bug).
2. **What were you trying to do?** ("I imported a CSV and tried to make a
   heatmap.")
3. **What did you expect to happen, and what happened instead?**
4. **Copy any error message you saw**, word for word — including the little
   yellow or red banners in the app, and anything unusual in the terminal
   window.
5. If you can, note whether it happens again if you try the exact same steps
   a second time.

---

## 12. Glossary

- **Terminal** — a window for typing text commands to your computer, instead
  of clicking. See [section 3](#what-is-a-terminal).
- **Container / Docker / Docker Desktop** — a way of packaging an application
  with everything it needs to run, so it behaves the same on any computer.
  Docker Desktop is the program that makes this work on a Mac or a Windows PC.
- **Image (Docker image)** — the packaged, ready-to-run blueprint for a piece
  of the app (built the first time you start FigureForge, or after a
  restart-from-scratch). A **container** is that image actually running. You
  never need to handle images directly — `docker compose up --build` /
  `make up` build and run them for you.
- **WSL2** — "Windows Subsystem for Linux," a lightweight Linux environment
  that Windows can run alongside itself. Docker Desktop on Windows uses it
  behind the scenes; see [section 3](#on-windows).
- **Port** (e.g. `5173`, `8000`) — a numbered "channel" a program listens on.
  `http://localhost:5173` means "the program listening on channel 5173, on
  this computer."
- **`localhost`** — a special address that always means "this computer,"
  wherever you are. It only works from the same computer the app is running
  on.
- **Repository / repo** — the project folder, including its full history of
  changes. "Cloning" it means downloading a copy.
- **Zip file / archive (for transferring the app)** — a single compressed
  file containing a whole folder, made so it's easier to move around than
  thousands of individual files. See [section 5](#moving-the-whole-app-to-a-new-computer)
  for how to make and unpack one for FigureForge itself — including the one
  kind of folder (`node_modules`) to delete before zipping, because it holds
  programs built for the computer you're copying *from*. (Not to be confused
  with a `.ffg` project file, below — a `.ffg` file already is a single file
  and needs no zipping.)
- **`.ffg` file** — FigureForge's own save-file format (the project used to
  call this `.figureforge`; both still open). It's a zip file containing your
  original data exactly as imported (never altered), the figure layout, and
  any statistics you've run — so reopening it gives you back everything, not
  just a picture of the result. Small enough to email or upload directly; see
  [section 5](#sharing-just-a-figure-not-the-whole-app).
- **PDF / EPS / SVG vs. PNG / TIFF** — the first three are "vector" formats:
  the text and shapes stay fully editable and scale to any size without
  blurring, which is what a journal wants. PNG and TIFF are "raster" —
  fixed-resolution images, useful for quick sharing but not for
  re-editing.
