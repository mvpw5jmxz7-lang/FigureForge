# AI Prompt: Build a Nature-Style Scientific Figure Assembly Platform

**Role:** You are a senior scientific software architect, UX designer, and full-stack developer specialising in scientific visualisation software for life sciences research.

## Objective

Design and implement a professional desktop and web-based application called **FigureForge** (working title) that enables scientists to create publication-ready multi-panel figures suitable for submission to journals such as Nature, Cell, Science, and related life-science journals.

The software should combine the usability of PowerPoint, the plotting capabilities of GraphPad Prism, and the layout control of Adobe Illustrator, while maintaining scientific reproducibility and publication-quality output.

---

## Core Design Philosophy

The application should:

* Be intuitive for biomedical researchers.
* Produce publication-ready figures with minimal manual adjustment.
* Prioritise vector graphics and editable content.
* Support reproducible figure generation from source data.
* Automatically enforce good publication design practices.
* Follow Nature-style figure preparation guidelines by default.
* Use clean typography, consistent spacing, and professional aesthetics.

---

# Figure Canvas System

## Figure Definition

Allow the user to specify:

* Figure width and height
* Journal template presets

Examples:

* Nature single-column
* Nature double-column
* Cell
* Science
* Custom dimensions

Units:

* mm
* cm
* inches
* pixels

Display real-world dimensions continuously.

---

## Multi-Panel Layout Engine

The user should define:

* Number of panels
* Panel arrangement

Examples:

* 1×2
* 2×2
* 3×2
* custom

The software should automatically:

* optimise panel size
* maximise use of available space
* maintain equal spacing
* preserve aspect ratios when required
* minimise unused whitespace

Provide:

* Auto Layout mode
* Manual Layout mode

---

## Grid and Alignment System

Implement:

### Smart Grid

* Snap-to-grid enabled by default
* Adjustable grid spacing
* Visual alignment guides
* Smart object alignment

### Override Mode

Allow:

* temporary grid bypass
* pixel-level adjustments
* manual nudging

Support:

* arrow-key movement
* fine movement with modifier keys

---

# Plotting Engine

## Supported Data Input Formats

### Format 1: SigmaPlot Style

```text
X1,Y1,X2,Y2,X3,Y3
```

### Format 2: Prism Style

```text
X,Y1,Y2,Y3
```

### Format 3: Simple XY

```text
X,Y
```

### Format 4: Grouped Data

```text
Group,Value
```

### Format 5: Replicate Data

```text
Treatment,Replicate1,Replicate2,...
```

Input methods:

* Copy/paste from Excel
* CSV import
* TSV import
* TXT import
* Drag-and-drop spreadsheets

Provide a live preview before import.

---

## Supported Graph Types

Life-science focused:

### Quantitative

* Scatter plots
* Dot plots
* Bar graphs
* Box plots
* Violin plots
* Beeswarm plots
* Line graphs
* Time-course plots
* Histograms

### Statistical

* Volcano plots
* Correlation plots
* ROC curves
* Survival curves

### Omics

* Heatmaps
* Clustered heatmaps
* PCA plots
* UMAP plots

### Publication Graphics

* Forest plots
* Bubble plots
* Sankey diagrams

---

# Statistical Analysis Engine

The software should perform statistical analyses automatically.

Supported tests:

* Student's t-test
* Paired t-test
* Welch's t-test
* Mann-Whitney test
* ANOVA
* Repeated measures ANOVA
* Kruskal-Wallis
* Chi-square
* Pearson correlation
* Spearman correlation
* Linear regression

Automatically generate:

* p-values
* adjusted p-values
* confidence intervals
* effect sizes

Display significance annotations:

* "ns"
* "*"
* "**"
* "***"
* "****"

Users should be able to edit annotation placement.

---

# Publication Styling System

## Nature Style Preset

Create a built-in theme called:

**Nature Publication Style**

Default settings:

### Typography

Font family:

```text
Arial
```

Fallback:

```text
Helvetica
```

### Font Sizes

Panel labels:

* 8 pt bold

General figure text:

* 5–7 pt

Axis labels:

* publication-appropriate scaling

Maintain consistency across all panels.

---

## Colour System

Provide:

* colour-blind-safe palettes
* Nature-style palettes
* grayscale-safe palettes

Validate:

* contrast
* accessibility

Warn users when colour choices may not be distinguishable for colour-blind readers.

---

# Image Panel Support

Allow insertion of:

* TIFF
* PNG
* JPG
* SVG
* PDF
* EPS

Support:

* microscopy images
* western blots
* gels
* illustrations
* schematics

Functions:

* crop
* resize
* rotate
* scale
* align

---

## Scale Bars

Provide:

* automatic scale-bar creation
* editable scale-bar layers
* editable scale-bar labels

Scale bars must remain editable vector objects.

---

# Annotation Tools

Provide:

* arrows
* callouts
* brackets
* shapes
* highlights
* text labels

Properties:

* editable
* vector-based
* snap-to-grid compatible

---

# Layer System

Implement Illustrator-style layers:

Examples:

* Graphs
* Images
* Labels
* Arrows
* Statistical annotations

Support:

* lock
* hide
* group
* reorder

---

# Reproducibility System

Every figure should maintain:

* original data source
* plotting parameters
* statistical settings

Saving a project should preserve:

* raw data
* plots
* layout
* annotations

Project format:

```text
.figureforge
```

---

# Export System

## Vector Export

Primary outputs:

* PDF
* EPS
* SVG

Requirements:

* editable text
* embedded fonts
* vector graphics preserved

---

## Raster Export

Secondary outputs:

* PNG
* TIFF

Options:

* 300 dpi
* 450 dpi
* 600 dpi

For image-containing figures, provide warnings if resolution falls below publication standards.

---

# User Experience Features

Include:

* Undo/Redo
* Version history
* Autosave
* Dark mode
* Light mode
* Keyboard shortcuts
* Drag-and-drop workflow

---

# Advanced Features

### AI Layout Assistant

Automatically:

* optimise panel arrangement
* equalise spacing
* detect alignment issues
* suggest improvements

### Figure Quality Checker

Before export, validate:

* font consistency
* panel labelling
* colour accessibility
* image resolution
* panel spacing
* editable text
* vector compliance

Generate:

**Publication Readiness Score (0-100)**

and a list of required fixes.

---

# Technical Architecture

Preferred stack:

Frontend:

* React
* TypeScript
* Electron (desktop)

Backend:

* Python

Scientific libraries:

* NumPy
* SciPy
* Pandas
* Matplotlib
* Seaborn
* Plotly

Vector graphics:

* SVG-native rendering
* PDF/EPS export engine

---

## Deliverables

Produce:

1. Full software requirements specification.
2. System architecture diagram.
3. Database/schema design.
4. UI wireframes.
5. Core plotting engine design.
6. Statistical engine design.
7. Figure layout algorithm.
8. Export engine specification.
9. MVP roadmap.
10. Production roadmap.
11. Example user workflows.
12. Detailed implementation plan suitable for immediate software development.

This application should feel like **GraphPad Prism + Adobe Illustrator + BioRender**, but specifically optimised for assembling publication-quality multi-panel figures for high-impact life-science journals.