# FigureForge — A Guide for Everyone

This guide is written for people trying FigureForge who don't write code. If
you've never used a "terminal" before, that's fine — every command you need to
type is written out exactly, and there's a short glossary at the end for any
word that isn't explained the moment it comes up.

**Jump to:** [1. What this is](#1-what-this-is) · [2. What works and what
doesn't](#2-what-works-today-and-what-does-not-yet) · [3. Installing what you
need](#3-installing-what-you-need) · [4. Getting the
project](#4-getting-the-project-onto-your-computer) · [5. Starting it
up](#5-starting-it-up) · [6. First
walkthrough](#6-using-the-app-for-the-first-time) · [7. Command
reference](#7-command-reference) · [8. Stopping
it](#8-stopping-it-or-starting-fresh) · [9.
Troubleshooting](#9-troubleshooting) · [10. Giving
feedback](#10-how-to-give-useful-feedback) · [11. Glossary](#11-glossary)

---

## 1. What this is

FigureForge turns spreadsheet data into the kind of multi-panel figure a
science journal expects — the sort you'd see in *Nature* or *Cell*: clean
bar charts with error bars, significance stars placed automatically after a
real statistical test, panels neatly labelled **a**, **b**, **c**, arranged on
a page sized to that journal's column width — and it exports a file you can
actually submit.

It runs the real statistics (via a well-established Python library called
SciPy, the same engine used across scientific computing), not a rough
approximation — so the p-values and confidence intervals it reports are the
real ones.

It is **not finished**. Section 2 below is the most important part of this
guide: it tells you exactly what to expect right now, so you can tell the
difference between "this is broken" and "this hasn't been built yet."

---

## 2. What works today and what does not yet

### Works today

- **Import data.** Paste a table from Excel, or drop in a `.csv`/`.tsv`/`.txt`
  file. It recognises a few common layouts (a treatment column with replicate
  columns, a simple X/Y table, grouped data) and shows you a preview before
  anything is added to the figure.
- **Bar and dot charts**, with error bars (standard deviation, standard error,
  or a 95% confidence interval) and the individual data points shown as dots.
- **Real statistics.** t-tests, ANOVA, Mann-Whitney, Kruskal-Wallis,
  correlation, and more — with correction for multiple comparisons, an effect
  size, and a ready-to-paste sentence for your methods section.
- **Automatic significance brackets** — run a test and it draws the bracket
  with `*` / `**` / `***` / `****` / `ns` positioned correctly over the bars
  being compared.
- **Multi-panel layout.** Add several panels, click one button, and they're
  arranged evenly on a journal-sized page with matching gutters and correctly
  lettered.
- **A "publication readiness" score** out of 100, with a plain-English list of
  anything that would likely get the figure sent back (text too small, images
  too low-resolution, colours that don't work for colour-blind readers, and so
  on).
- **Export** to PDF, EPS, SVG (all fully editable, with real selectable text —
  not a picture of text), or PNG/TIFF at print resolution.
- **Save and reopen your work** as a project file (see the glossary entry for
  `.figureforge` files).

### Not finished yet — please don't report these as bugs

- **Other chart types.** The chart-type menu lists box plots, violin plots,
  line graphs, scatter plots and histograms, but choosing one of these
  currently draws *something* using the bar/dot logic underneath — it is not
  actually that chart type yet. Stick to **Bar** or **Dot** for now; anything
  else is not trustworthy.
- **Inserting images** — microscopy pictures, western blots, gels. The menu
  and the underlying support exist, but there's no way yet to actually load an
  image file in.
- **A few statistical tests** (chi-square, linear regression, and a couple of
  others) work correctly behind the scenes but aren't in the on-screen list
  yet, so you can't reach them from the app.
- **Heatmaps, PCA/UMAP plots, volcano plots, survival curves** — not built.
- **A standalone desktop app.** Right now this only runs as a website you open
  in your browser (see below) — there's no downloadable application yet.
- **The "fix it for me" buttons** on the readiness score — some findings say
  they're auto-fixable, but nothing happens yet if you click to fix them.

If something looks wrong and it **isn't** on this list, that's useful
feedback — see [section 10](#10-how-to-give-useful-feedback).

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

> **A note on how this was written:** the macOS steps above are correct and
> match how Docker Desktop and this project's setup files work, but they were
> written without a Mac available to test them on directly — everything on
> the Linux side of this guide has been run and checked this session; the
> macOS side has not. If a step doesn't match what you see, that's useful
> feedback too.

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

This applies on both macOS and Linux. A few steps below ask you to type a
command into a **terminal** — a
text-based window for typing instructions to your computer instead of
clicking. If you've never opened one:

- **macOS:** press `Cmd + Space`, type `Terminal`, press Enter.
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

- **Easiest way on both platforms:** open the terminal, type `cd ` (with a
  trailing space), then drag the project folder from Finder/Files straight
  into the terminal window — it will paste the correct path automatically.
  Press Enter.
- You'll know it worked if, when you type `ls` and press Enter, you see a list
  of files including `README.md`, `GUIDE.md`, `Makefile`, and folders like
  `apps` and `packages`.

Every command in this guide from here on assumes you're sitting in that
folder.

---

## 5. Starting it up

### On macOS

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
journal-page-shaped figure in the middle already showing two example charts
side by side (labelled **a** and **b**), and a panel on the right with tabs
marked **Data / Stats / Quality / Layers**. (The exact colours depend on
whether your computer is set to light or dark mode — either is normal.)

### If the browser shows nothing or an error

1. **Check the terminal is still open and running.** If it printed an error
   and stopped, scroll up and read the last few lines — they usually say
   plainly what went wrong (a very common one is "port already in use," see
   [Troubleshooting](#9-troubleshooting)).
2. **Give it another minute**, especially on the very first run — the browser
   can be quicker to try than the app is to finish starting.
3. **Reload the page.** Sometimes the browser gets there before the app is
   fully ready.
4. If it still doesn't work, see [section 9](#9-troubleshooting).

---

## 6. Using the app for the first time

This walks through the whole loop once, using the sample data that's already
loaded when you open the app, so you can see everything working before trying
your own data.

1. **Look at the two charts already on screen.** Panel **a** shows cell
   viability dropping across four doses of a compound; panel **b** shows gene
   expression across three genotypes. This is sample data, loaded
   automatically so there's always something to look at.

2. **Click the Stats tab** on the right.

3. Under **Analysis**, the **Plot** dropdown should already show **Viability**
   (panel a). Leave the **Test** as **Welch's t-test** (the default), and
   click **Run and annotate**.

4. Watch the figure — a set of horizontal brackets with asterisks (`****`)
   appears above the bars, stacked so they don't overlap. Panel a has four
   groups (Vehicle and three doses), so the tool compares every pair of them
   automatically — six comparisons in total — which is why several brackets
   appear at once rather than just one. Underneath, in the Stats panel,
   you'll see a table with the actual p-value, an *adjusted* p-value (the one
   that accounts for testing six comparisons at once — using it instead of
   the raw p-value is what stops a figure from overstating how significant a
   result is), an effect size for each pair, and (click "Methods sentence" to
   expand it) a ready-to-paste sentence describing exactly what test was run
   and how it was corrected.

   If you'd rather see a single, simpler bracket, switch the **Plot**
   dropdown to **Expression** (panel b) instead — it only has three groups,
   so it produces three comparisons rather than six.

5. **Click the Quality tab.** You'll see a **Publication readiness** score out
   of 100, and a list of anything the tool thinks a journal would flag —
   ideally short or empty for the sample figure.

6. **Click PDF** in the bottom-right corner of the window. A file downloads —
   open it. The text in it is real, selectable text (try clicking and
   dragging over a label), and the page is sized exactly to the journal
   column width shown in the toolbar.

7. **Try your own data.** Click the **Data** tab, paste a table copied from a
   spreadsheet (or drag a `.csv` file onto the paste box), check the preview
   looks right, and click **Import as new panel**. Then click **Auto layout**
   in the toolbar to tidy everything up.

That's the whole loop: data in, chart and statistics, a quality check,
export.

---

## 7. Command reference

Run these from a terminal, sitting in the project folder (see
[section 4](#4-getting-the-project-onto-your-computer)).

| What you want to do | macOS | Linux | What it does | If it doesn't work, check |
|---|---|---|---|---|
| Start the app | `docker compose up --build` | `make up` | Builds (if needed) and starts everything; prints the web address | Docker Desktop is open and running (macOS); no error text partway through the output |
| Stop the app | `docker compose down` | `make down` | Shuts everything down cleanly | Nothing to check — this one is safe to run any time, even if nothing is running |
| Run the automated checks | `docker compose exec web npm test` and `docker compose exec api python -m pytest -q` | `make test` | Runs the project's internal test suite — a sanity check that nothing is broken, not something you need for everyday use | The app must already be started (step above) first |
| Run the full example end-to-end | `docker compose exec web npx vite-node scripts/acceptance.ts` | `make acceptance` | Builds a whole sample figure from scratch — data, chart, statistics, export — and prints a checklist. Useful if you want proof the whole pipeline works without using the browser at all | The app must already be started first; a `[FAIL]` line tells you exactly which step broke |
| See what's currently running | `docker compose ps` | `make ps` | Lists the two pieces (`web` and `api`) and whether they're healthy | — |
| See what's happening inside | `docker compose logs -f` | `make logs` | Streams the live activity log — useful if something seems stuck and you want to see what it's actually doing | Press `Ctrl + C` to stop watching (this does not stop the app) |

Two pieces run together: **web** (what you see in the browser) and **api**
(does the statistics and file conversion in the background). If the app looks
like it's running but statistics or exports don't work, check that both
pieces show as running/healthy with the "see what's currently running"
command above.

---

## 8. Stopping it or starting fresh

To stop everything:

```bash
docker compose down     # macOS
make down                # Linux
```

It's safe to run this even if you're not sure anything is running.

**If things seem properly stuck** — the app won't start, or behaves strangely
after an update to the project — the equivalent of "turn it off and on
again" is:

```bash
docker compose down && docker compose up --build     # macOS
make restart                                          # Linux
```

This rebuilds everything from scratch. It's slower (like the very first
start) but resolves almost anything short of an actual bug.

---

## 9. Troubleshooting

**"Port already in use" or similar, when starting up.**
This means something is already using the address FigureForge needs
(`5173` or `8000`) — most often, FigureForge is already running from
earlier and you just forgot. Run the "stop" command from section 8, then
start again. If that doesn't help, it may be a different program on your
computer using that same address; closing that program should free it up.

**The browser says it can't connect / "This site can't be reached."**
The app usually just hasn't finished starting yet — see
[section 5](#if-the-browser-shows-nothing-or-an-error) above. If Docker
Desktop (macOS) isn't open and running, start it first.

**The page loads, but statistics or exports don't work, and you see a yellow
banner** saying the analysis service isn't reachable.
The `api` piece isn't running or hasn't finished starting. Check with the
"see what's currently running" command in section 7 — give it another
minute, or try the restart in section 8.

**The very first start takes forever.**
Expected — it's downloading and assembling everything. This only happens
once (or after a restart-from-scratch); normal starts afterwards are quick.

**Nothing above matches what you're seeing.**
See [section 10](#10-how-to-give-useful-feedback) — copy the last 10–20
lines of text from the terminal window when reporting it; that's almost
always where the real answer is.

---

## 10. How to give useful feedback

This tool is still being built, and your testing is genuinely part of that —
so when something looks wrong, a little detail goes a long way:

1. **First, check [section 2](#2-what-works-today-and-what-does-not-yet).** If
   it's on the "not finished yet" list, it's expected — no need to report it
   (though "I hit this and was confused" is still useful, just frame it as
   that rather than as a bug).
2. **What were you trying to do?** ("I imported a CSV and tried to make a
   line graph.")
3. **What did you expect to happen, and what happened instead?**
4. **Copy any error message you saw**, word for word — including the little
   yellow or red banners in the app, and anything unusual in the terminal
   window.
5. If you can, note whether it happens again if you try the exact same steps
   a second time.

---

## 11. Glossary

- **Terminal** — a window for typing text commands to your computer, instead
  of clicking. See [section 3](#what-is-a-terminal).
- **Container / Docker / Docker Desktop** — a way of packaging an application
  with everything it needs to run, so it behaves the same on any computer.
  Docker Desktop is the program that makes this work on a Mac.
- **Port** (e.g. `5173`, `8000`) — a numbered "channel" a program listens on.
  `http://localhost:5173` means "the program listening on channel 5173, on
  this computer."
- **`localhost`** — a special address that always means "this computer,"
  wherever you are. It only works from the same computer the app is running
  on.
- **Repository / repo** — the project folder, including its full history of
  changes. "Cloning" it means downloading a copy.
- **`.figureforge` file** — FigureForge's own save-file format. It's a zip
  file containing your original data exactly as imported (never altered),
  the figure layout, and any statistics you've run — so reopening it gives
  you back everything, not just a picture of the result.
- **PDF / EPS / SVG vs. PNG / TIFF** — the first three are "vector" formats:
  the text and shapes stay fully editable and scale to any size without
  blurring, which is what a journal wants. PNG and TIFF are "raster" —
  fixed-resolution images, useful for quick sharing but not for
  re-editing.
