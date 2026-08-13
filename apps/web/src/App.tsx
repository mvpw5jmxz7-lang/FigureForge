import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ARCHIVE_EXTENSION,
  ARCHIVE_EXTENSIONS,
  ARCHIVE_MIME,
  buildArchiveContents,
  loadArchive,
  saveArchive,
  type FigureDocument,
  type NodeId,
} from '@figureforge/doc-model';
import { checkFigure, renderDocument, toSvgString } from '@figureforge/render';
import { resolveTheme } from '@figureforge/theme';
import { Canvas } from './components/Canvas.js';
import { SidePanel, scoreTone, type Tab } from './components/SidePanel.js';
import { Toolbar } from './components/Toolbar.js';
import {
  decodeImage,
  download,
  exportFigure,
  health,
  safeFilename,
  type ExportFormat,
} from './api.js';
import { useAssets, type AssetStore } from './assets.js';
import { flattenCropsForExport } from './exportImages.js';
import { usePointCloudRasters } from './pointRasters.js';
import { openedToResult } from './desktopFiles.js';
import { browserProjectFileSystem, type ProjectFileSystem, type SaveTarget } from './projectFiles.js';
import { createSampleDocument } from './sample.js';
import { isDesktop, type DesktopMenuCommand } from './shell.js';
import { useDocument, useUndoShortcuts } from './useDocument.js';
import './styles.css';

/**
 * Strip whichever archive extension a picked filename carries, so the name
 * offered back for the figure's title is "my figure", not "my figure.ffg".
 * Case-insensitive: filesystems that hand back a picked name unchanged still
 * commonly differ in case from what this app writes.
 */
function stripArchiveExtension(name: string): string {
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (name.toLowerCase().endsWith(ext)) return name.slice(0, name.length - ext.length);
  }
  return name;
}

/**
 * Refuse to POST an export beyond this size.
 *
 * Mirrors MAX_EXPORT_BYTES on the service. Checked here as well so the author
 * is told immediately rather than after uploading a hundred megabytes to be
 * rejected — and the message can name the images responsible, which the
 * server, seeing only a string, cannot.
 */
const MAX_EXPORT_BYTES = 128 * 1024 * 1024;

/**
 * Rebuild display proxies for assets the browser cannot draw.
 *
 * Only TIFF needs this, and only after opening a project: the archive stores
 * the original bytes and nothing else, so the PNG the canvas draws has to be
 * regenerated. The alternative — caching a proxy inside the archive — doubles
 * its size and creates a second artefact that can disagree with the first.
 *
 * The cost is that opening a TIFF-bearing project needs the API. A failure
 * here is reported and left at that: the images render as placeholders, which
 * is honest, and every other part of the figure still works.
 */
async function rehydrateProxies(
  document: FigureDocument,
  store: AssetStore,
  onError: (message: string) => void,
): Promise<void> {
  const pending = document.assets.filter(
    (asset) => asset.mimeType === 'image/tiff' && store.has(asset.id),
  );
  if (pending.length === 0) return;

  for (const asset of pending) {
    const original = store.originalBytes(asset.id);
    if (!original) continue;
    try {
      const decoded = await decodeImage(
        new File([new Uint8Array(original)], asset.filename, { type: asset.mimeType }),
      );
      store.add(asset.id, {
        original,
        mimeType: asset.mimeType,
        display: decoded.png,
        displayMimeType: 'image/png',
      });
    } catch (caught) {
      onError(
        `Could not redisplay "${asset.filename}": ${String(caught)}. ` +
          'The original is still in the project; the analysis service may be down.',
      );
    }
  }
}

const EXPORT_FORMATS: { id: ExportFormat; label: string; vector: boolean }[] = [
  { id: 'pdf', label: 'PDF', vector: true },
  { id: 'eps', label: 'EPS', vector: true },
  { id: 'svg', label: 'SVG', vector: true },
  { id: 'png', label: 'PNG', vector: false },
  { id: 'tiff', label: 'TIFF', vector: false },
];

/** CSS reference pixels per millimetre at 100% zoom. */
const PX_PER_MM = 96 / 25.4;
/** Side panel plus canvas padding, so the whole page width is visible. */
const CHROME_PX = 340 + 72;

/**
 * Zoom that fits the figure across the canvas. Opening a 183 mm figure zoomed
 * past the viewport hides half of it, which reads as a broken layout rather
 * than a scroll position.
 */
function fitZoom(widthMm: number): number {
  const available = (globalThis.innerWidth ?? 1440) - CHROME_PX;
  return Math.max(0.5, Math.min(5, available / (widthMm * PX_PER_MM)));
}

export interface AppProps {
  /** Injectable so the native-picker/fallback choice is testable — see
   *  `projectFiles.ts`. Defaults to the real browser implementation. */
  fileSystem?: ProjectFileSystem;
}

export function App({ fileSystem = browserProjectFileSystem }: AppProps = {}) {
  const api = useDocument(createSampleDocument);
  useUndoShortcuts(api);

  const assets = useAssets(api.document);

  /**
   * Verbatim source text for every imported dataset, keyed by archive path.
   *
   * A ref rather than state: nothing renders from it, and it must survive undo
   * exactly as the asset bytes do. Without this the app archived a
   * re-serialised CSV from `datasetToCsv` — so the "byte for byte" claim held
   * for the tests and the acceptance script but not for the actual product.
   */
  const dataOriginals = useRef(new Map<string, string>());

  const [selectedIds, setSelectedIds] = useState<NodeId[]>([]);
  /** Image being cropped directly on canvas. Editor state, never the document. */
  const [cropNodeId, setCropNodeId] = useState<NodeId | null>(null);
  /** Scale bar being calibrated by measuring a feature of known length. */
  const [measureNodeId, setMeasureNodeId] = useState<NodeId | null>(null);
  /** What the last ruler drag measured, in source pixels, awaiting a length. */
  const [measuredPx, setMeasuredPx] = useState<number | null>(null);
  /** Volcano plot whose points are being picked directly on the canvas. */
  const [labelPickNodeId, setLabelPickNodeId] = useState<NodeId | null>(null);
  const [zoom, setZoom] = useState(() => fitZoom(api.document.page.widthMm));
  const [showGrid, setShowGrid] = useState(false);
  /** One spelling, read by both the toolbar's Fit button and the View menu. */
  const fitToWindow = useCallback(
    () => setZoom(fitZoom(api.document.page.widthMm)),
    [api.document.page.widthMm],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [dpi, setDpi] = useState<150 | 300 | 450 | 600>(300);
  /** Filename being confirmed before a save; null means the dialog is closed.
   *  Only ever opened on a browser without the File System Access API. */
  const [saveName, setSaveName] = useState<string | null>(null);
  /**
   * The file this figure was last saved to or opened from, so a plain Save
   * can overwrite it in place with no dialog. Session state, deliberately not
   * in the document: `store.ts` records every edit *and its inverse*, so a
   * handle living there would be cloned into the undo history on every
   * unrelated edit — the same reason asset bytes live outside it (`assets.ts`).
   * Not persisted across a reload either; a fresh permission prompt on load
   * would be needed regardless, so there is nothing to gain by trying.
   */
  const [saveTarget, setSaveTarget] = useState<SaveTarget | null>(null);
  /**
   * Whether there are edits the user has not written to disk.
   *
   * Set by any commit and cleared by save, open and new. It is deliberately
   * *not* an equality check against the last saved document: comparing whole
   * figures on every keystroke is expensive, and the cheap approximation errs
   * in the safe direction — undoing back to exactly the saved state still
   * reads dirty, so the shell offers to save something that did not need it,
   * rather than discarding something that did.
   *
   * Only the desktop shell consumes it (its quit guard and title bar); the
   * browser has no `beforeunload` guard, which the risk table still records
   * as open.
   */
  const [dirty, setDirty] = useState(false);
  /**
   * A brief confirmation shown right after a save completes — the File
   * System Access API deliberately exposes no path (see `.file-target`'s own
   * title text below), so this is the one place a folder choice is
   * acknowledged on screen at all, rather than only ever assumed from a
   * dialog that already closed.
   */
  const [saveConfirmation, setSaveConfirmation] = useState<string | null>(null);
  const saveConfirmationTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSaveConfirmation = useCallback((message: string) => {
    if (saveConfirmationTimeout.current !== null) clearTimeout(saveConfirmationTimeout.current);
    setSaveConfirmation(message);
    saveConfirmationTimeout.current = setTimeout(() => setSaveConfirmation(null), 4000);
  }, []);
  useEffect(() => () => {
    if (saveConfirmationTimeout.current !== null) clearTimeout(saveConfirmationTimeout.current);
  }, []);
  const [tab, setTab] = useState<Tab>('data');
  /** Format waiting on the author's confirmation; null means nothing pending. */
  const [pendingExport, setPendingExport] = useState<ExportFormat | null>(null);

  const theme = resolveTheme(api.document.themeId, api.document.themeOverrides);
  const pointClouds = usePointCloudRasters(api.document, theme);

  /**
   * Publication readiness for the current figure.
   *
   * Computed here rather than in the Quality tab because the export path needs
   * the same answer — the spec's "before export, validate" is not a second
   * check, it is this one, read at the moment it matters. Two computations of
   * one figure's readiness would eventually disagree about that figure.
   */
  const report = useMemo(() => {
    // The scene has to carry its images: text-size and colour rules read the
    // rendered tree, and a figure checked as a set of grey placeholders is not
    // the figure being submitted. No `pointRasters` here on purpose:
    // `checkPointCloudRasterization` reads `document`/`theme` directly via
    // `planPointClouds`, not the scene, so a plot over threshold showing its
    // placeholder in this particular scene changes nothing this report reads.
    const scene = renderDocument(api.document, {
      theme,
      resolveAsset: (id) => assets.urls[id],
    });
    return checkFigure({ document: api.document, theme, scene, exportDpi: dpi });
  }, [api.document, theme, dpi, assets.urls]);

  const blockingErrors = report.findings.filter((f) => f.severity === 'error');

  useEffect(() => {
    void health().then(setApiUp);
  }, []);

  // Escape leaves crop and measure mode. A mode with no visible way out is how
  // a user concludes the canvas has stopped responding.
  useEffect(() => {
    if (cropNodeId === null && measureNodeId === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setCropNodeId(null);
      setMeasureNodeId(null);
      setMeasuredPx(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cropNodeId, measureNodeId]);

  // Escape leaves point-picking mode, the same "no visible way out otherwise"
  // reasoning as crop/measure above — a separate effect since the modes are
  // independent and never active together.
  useEffect(() => {
    if (labelPickNodeId === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLabelPickNodeId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [labelPickNodeId]);

  // --- export -------------------------------------------------------------

  const runExport = useCallback(
    async (format: ExportFormat) => {
      setPendingExport(null);
      setBusy(`Exporting ${format.toUpperCase()}`);
      setError(null);
      try {
        // Bake every crop into its own pixels first, so a micrograph cropped to
        // a tenth uploads a tenth. The result is a throwaway document — it is
        // never committed, never saved, and the readiness check above ran
        // against the real one.
        const flattened = await flattenCropsForExport(
          api.document,
          assets.store,
          assets.resolveForExport,
          setError,
        );

        // Awaited, not read from whatever the canvas happened to have cached:
        // this is what guarantees export never fires against a half-baked
        // raster. The store is shared with the live canvas, so a plot already
        // on screen resolves instantly here; one never shown yet bakes now.
        const pointRasters = await pointClouds.bakeAll(flattened.document);

        // Render without editor chrome: no selection outlines, no grid.
        // Assets resolve to data URIs, never the canvas's blob URLs: those are
        // meaningless outside this tab, so the service would render blanks.
        const scene = renderDocument(flattened.document, {
          theme,
          resolveAsset: flattened.resolve,
          pointRasters,
        });
        const svg = toSvgString(scene, { xmlDeclaration: format === 'svg' });

        if (svg.length > MAX_EXPORT_BYTES) {
          const largest = [...api.document.assets]
            .sort((a, b) => b.byteLength - a.byteLength)
            .slice(0, 3)
            .map((a) => `${a.filename} (${(a.byteLength / 1e6).toFixed(0)} MB)`);
          setError(
            `This figure is ${(svg.length / 1e6).toFixed(0)} MB with its images embedded, ` +
              `over the ${(MAX_EXPORT_BYTES / 1e6).toFixed(0)} MB export limit. ` +
              (largest.length > 0 ? `Largest: ${largest.join(', ')}. ` : '') +
              'Crop them, place them smaller, or supply lower-resolution originals.',
          );
          return;
        }

        const blob = await exportFigure({
          svg,
          widthMm: api.document.page.widthMm,
          heightMm: api.document.page.heightMm,
          format,
          dpi,
          filename: safeFilename(api.document.title).replace(/[^\w-]+/g, '_'),
        });

        download(blob, `${safeFilename(api.document.title)}.${format}`);
      } catch (caught) {
        setError(`Export failed: ${String(caught)}`);
      } finally {
        setBusy(null);
      }
    },
    [api.document, theme, dpi, assets, pointClouds.bakeAll],
  );

  /**
   * Validate before exporting, and say so — but never refuse.
   *
   * The defects that matter most here are invisible in the output file: a
   * p-value the data no longer supports, a scale bar drawn from a placeholder.
   * A figure carrying one should not leave silently. It should still be able to
   * leave: a draft going to a colleague is a legitimate export, and a checker
   * that blocks is one authors learn to route around. So errors interrupt once,
   * warnings never do, and there is no "don't ask again" — the click is cheap
   * and the mistake is not.
   */
  const requestExport = useCallback(
    (format: ExportFormat) => {
      if (blockingErrors.length > 0) setPendingExport(format);
      else void runExport(format);
    },
    [blockingErrors.length, runExport],
  );

  // --- project file -------------------------------------------------------

  /*
   * The figure's title lags the document by one commit when a rename and a
   * save happen in the same click — `api.document` is a value captured at
   * render time, and `commit()` cannot retroactively change what that
   * variable already points to. Reading `api.store.getDocument()` instead,
   * here and in every save path below, is what keeps the saved title in step
   * with a rename made in the same gesture.
   */
  const currentDocument = useCallback((): FigureDocument => api.store.getDocument(), [api.store]);

  /*
   * A rename made through the save flow rather than a dedicated title field —
   * see "Round 4" in CLAUDE.md. The name also becomes the figure's title, so
   * the next save offers it again and the document and the file on disk stop
   * disagreeing about what this figure is.
   */
  const renameIfNeeded = useCallback(
    (rawName: string): string => {
      const name = safeFilename(rawName);
      if (name !== currentDocument().title) {
        api.commit('Rename figure', (draft) => {
          draft.title = name;
        });
      }
      return name;
    },
    [api, currentDocument],
  );

  const buildArchiveBytes = useCallback((): Uint8Array => {
    const document = currentDocument();
    return saveArchive(
      // Both side-stores go in, or the archive keeps the metadata and loses
      // the thing it describes: a project whose micrographs are grey boxes and
      // whose "verbatim" CSV was re-serialised on the way out.
      buildArchiveContents(document, dataOriginals.current, assets.store.archiveMap(document)),
    );
  }, [currentDocument, assets.store]);

  const downloadArchive = useCallback(
    (name: string) => {
      // Copy into a fresh buffer: the zip may sit in a larger pooled ArrayBuffer.
      download(
        new Blob([new Uint8Array(buildArchiveBytes())], { type: ARCHIVE_MIME }),
        `${name}${ARCHIVE_EXTENSION}`,
      );
    },
    [buildArchiveBytes],
  );

  /** The Firefox/Safari path: no File System Access API, so a name and a
   *  browser download stand in for both a location picker and a write. */
  const saveViaDialog = useCallback(
    (chosen: string) => {
      const name = renameIfNeeded(chosen);
      downloadArchive(name);
      setSaveName(null);
      setDirty(false);
      showSaveConfirmation(`Downloaded "${name}${ARCHIVE_EXTENSION}" to your browser's downloads folder.`);
    },
    [renameIfNeeded, downloadArchive, showSaveConfirmation],
  );

  /**
   * Write to an already-picked file, falling back to a download if the
   * permission prompt is denied — a save must never simply vanish.
   *
   * Returns whether the bytes reached the *intended* file. The desktop shell's
   * quit guard needs a real answer before it lets the process exit, and every
   * other caller is free to ignore it. A denied write reports false even
   * though the download rescued the data: the file the user named was not
   * written, and cancelling the quit is the safe reading of that.
   */
  const writeToTarget = useCallback(
    async (target: SaveTarget): Promise<boolean> => {
      setBusy('Saving');
      try {
        const result = await fileSystem.write(target, buildArchiveBytes());
        if (result === 'denied') {
          setError(`Could not write to "${target.name}"; the file was downloaded instead.`);
          downloadArchive(stripArchiveExtension(target.name));
          setSaveTarget(null);
          return false;
        }
        setSaveTarget(target);
        setDirty(false);
        // A path when the platform has one, the name when it does not — the
        // browser genuinely cannot say where the file went, and claiming
        // otherwise would be worse than the vaguer sentence.
        showSaveConfirmation(
          target.location
            ? `Saved to ${target.location}`
            : `Saved "${target.name}" — the browser remembers this folder for next time.`,
        );
        return true;
      } catch (caught) {
        setError(`Could not save: ${String(caught)}`);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [fileSystem, buildArchiveBytes, downloadArchive, showSaveConfirmation],
  );

  /** Always re-prompts, even when a target is already held. */
  const saveAs = useCallback(async (): Promise<boolean> => {
    if (!fileSystem.supported()) {
      setSaveName(safeFilename(currentDocument().title));
      return false;
    }
    const picked = await fileSystem.pickSave(`${safeFilename(currentDocument().title)}${ARCHIVE_EXTENSION}`);
    if (!picked) return false; // the user cancelled the picker
    renameIfNeeded(stripArchiveExtension(picked.name));
    return writeToTarget(picked);
  }, [fileSystem, currentDocument, renameIfNeeded, writeToTarget]);

  /** Overwrites a held target in place; behaves as Save as… with none held. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!fileSystem.supported()) {
      setSaveName(safeFilename(currentDocument().title));
      return false;
    }
    if (saveTarget) return writeToTarget(saveTarget);
    return saveAs();
  }, [fileSystem, currentDocument, saveTarget, writeToTarget, saveAs]);

  const openFromFile = useCallback(
    async (file: File, target: SaveTarget | null) => {
      try {
        const result = loadArchive(new Uint8Array(await file.arrayBuffer()));

        // Load the bytes before resetting the document. The other order shows
        // one frame of placeholders where the images should be.
        assets.store.clear();
        for (const asset of result.document.assets) {
          const bytes = result.assets.get(asset.path);
          if (!bytes) continue;
          // TIFF cannot be drawn by the browser, so its proxy has to be
          // rebuilt. Held as the original for now: `renderImage` falls back to
          // a placeholder, and the decode replaces it when it lands.
          assets.store.add(asset.id, {
            original: bytes,
            mimeType: asset.mimeType,
            display: bytes,
            displayMimeType: asset.mimeType,
          });
        }

        dataOriginals.current = new Map(result.dataFiles);
        api.store.reset(result.document);
        setSelectedIds([]);
        // Retained even when null: opening a project through the plain file
        // input (no handle available) must clear a stale target from a
        // previous project, or "Save" would silently overwrite the wrong file.
        setSaveTarget(target);
        // A freshly opened project is by definition what is on disk.
        setDirty(false);
        setError(result.warnings.length > 0 ? result.warnings.join(' ') : null);

        await rehydrateProxies(result.document, assets.store, setError);
      } catch (caught) {
        setError(`Could not open project: ${String(caught)}`);
      }
    },
    [api.store, assets.store],
  );

  const openProject = useCallback((file: File) => void openFromFile(file, null), [openFromFile]);

  const openViaPicker = useCallback(async () => {
    const picked = await fileSystem.pickOpen();
    if (!picked) return; // the user cancelled the picker
    await openFromFile(picked.file, picked.target);
  }, [fileSystem, openFromFile]);

  /**
   * Start again.
   *
   * There was no "new" command before the menu needed one: the sample document
   * was built once, as `useDocument`'s initialiser. This clears exactly what
   * `openFromFile` clears — the four things that outlive a document reset and
   * would otherwise leak into the next figure — and produces the same sample
   * the app opens with, so New and launch agree about what a fresh figure is.
   */
  const newFigure = useCallback(() => {
    assets.store.clear();
    dataOriginals.current = new Map();
    api.store.reset(createSampleDocument());
    setSelectedIds([]);
    setSaveTarget(null);
    setDirty(false);
    setError(null);
  }, [api.store, assets.store]);

  /**
   * Open a project file dropped on the window.
   *
   * Scoped to project files by extension: the Data tab's textarea has its own
   * drop handler for CSV/TSV, and this must not take those. Chromium would
   * otherwise navigate the window to the dropped file, so both handlers
   * `preventDefault` regardless of whether they act.
   */
  useEffect(() => {
    if (!isDesktop()) return;

    const isProject = (name: string): boolean =>
      ARCHIVE_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));

    const onDragOver = (event: DragEvent): void => event.preventDefault();
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (!file || !isProject(file.name)) return;
      void (async () => {
        try {
          // The path has to come from the shell — `File.path` was removed, so
          // without it a dropped project could be read but never saved back to.
          const opened = await window.figureforge?.project?.openDropped(file);
          if (!opened) return;
          const { file: project, target } = openedToResult(opened);
          await openFromFile(project, target);
        } catch (caught) {
          setError(`Could not open the dropped file: ${String(caught)}`);
        }
      })();
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [openFromFile]);

  /**
   * Any edit makes the document dirty.
   *
   * Subscribed at the store rather than counted from `history()`: undo and
   * redo move the position within the history without changing its length, so
   * a length comparison would call an undone-then-redone document clean.
   */
  useEffect(
    () =>
      api.store.subscribe((_document, commit) => {
        // `reset` notifies with a null commit, and it is always followed by an
        // explicit `setDirty` from whichever of open/new called it.
        if (commit !== null) setDirty(true);
      }),
    [api.store],
  );

  /** Tell the shell what its menu and quit guard need. No-op in a browser. */
  useEffect(() => {
    window.figureforge?.setShellState?.({
      dirty,
      canUndo: api.canUndo,
      canRedo: api.canRedo,
      hasSelection: selectedIds.length > 0,
      showGrid,
      savedPath: saveTarget?.location ?? null,
      title: api.document.title,
    });
  }, [dirty, api.canUndo, api.canRedo, api.document.title, selectedIds.length, showGrid, saveTarget]);

  /**
   * Run a command chosen from the native menu.
   *
   * Every branch calls something the app already had — the menu is a second
   * route to those commands, never a second implementation. The two that carry
   * no existing handler, Duplicate and Delete, are deliberately absent here:
   * they live in `Canvas`'s keydown, where they can tell a canvas selection
   * from a data-grid selection, and the menu leaves their accelerators
   * unregistered so the key still reaches that handler.
   */
  useEffect(() => {
    const dispatch = (command: DesktopMenuCommand): void => {
      switch (command.type) {
        case 'new':
          newFigure();
          break;
        case 'open':
          void openViaPicker();
          break;
        case 'open-path':
          void (async () => {
            try {
              const opened = await window.figureforge?.project?.openPath(command.path);
              if (!opened) return;
              const { file, target } = openedToResult(opened);
              await openFromFile(file, target);
            } catch (caught) {
              setError(`Could not open that project: ${String(caught)}`);
            }
          })();
          break;
        case 'save':
          // The shell may be waiting on this answer before it lets the app
          // quit, so the result is reported rather than dropped.
          void save().then((ok) => window.figureforge?.project?.reportSaved(ok));
          break;
        case 'save-as':
          void saveAs();
          break;
        case 'export':
          requestExport(command.format);
          break;
        case 'undo':
          api.undo();
          break;
        case 'redo':
          api.redo();
          break;
        case 'zoom-in':
          setZoom((current) => Math.min(4, current * 1.25));
          break;
        case 'zoom-out':
          setZoom((current) => Math.max(0.1, current / 1.25));
          break;
        case 'zoom-reset':
          setZoom(1);
          break;
        case 'zoom-fit':
          fitToWindow();
          break;
        case 'toggle-grid':
          setShowGrid((current) => !current);
          break;
        default:
          break;
      }
    };
    return window.figureforge?.onMenuCommand?.(dispatch);
  }, [newFigure, openViaPicker, openFromFile, save, saveAs, requestExport, api, fitToWindow]);

  // Ctrl/Cmd+S and Ctrl/Cmd+Shift+S. Bound in App's own effect, not Canvas's —
  // that one returns early for anything focused inside `.side-panel`, which
  // would silently swallow the shortcut while the Data or Inspector tab has
  // focus. `preventDefault` always fires, or Chromium's own save-page dialog
  // opens over the top.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (event.shiftKey) void saveAs();
      else void save();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save, saveAs]);

  return (
    <div className="app">
      <Toolbar
        api={api}
        theme={theme}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        zoom={zoom}
        onZoomChange={setZoom}
        onFit={fitToWindow}
        showGrid={showGrid}
        onShowGridChange={setShowGrid}
        busy={busy}
      />

      {error && (
        <div className="banner error" onClick={() => setError(null)}>
          {error} <span className="dismiss">dismiss</span>
        </div>
      )}
      {apiUp === false && (
        <div className="banner warn">
          The analysis and export service is not reachable. Statistics and export are unavailable —
          start it with <code>make up</code>.
        </div>
      )}

      <main className="workspace">
        <Canvas
          api={api}
          theme={theme}
          selectedIds={selectedIds}
          onSelectionChange={(ids) => {
            setSelectedIds(ids);
            // Selecting something else ends the crop: leaving the overlay up
            // over a node that is no longer selected is an invisible mode.
            if (ids[0] !== cropNodeId) setCropNodeId(null);
            if (ids[0] !== measureNodeId) {
              setMeasureNodeId(null);
              setMeasuredPx(null);
            }
            if (ids[0] !== labelPickNodeId) setLabelPickNodeId(null);
          }}
          zoom={zoom}
          showGrid={showGrid}
          assetUrls={assets.urls}
          pointRasters={pointClouds.rasters}
          cropNodeId={cropNodeId}
          measureNodeId={measureNodeId}
          onMeasured={setMeasuredPx}
          labelPickNodeId={labelPickNodeId}
        />

        <SidePanel
          api={api}
          theme={theme}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onError={setError}
          setBusy={setBusy}
          assets={assets}
          dataOriginals={dataOriginals.current}
          exportDpi={dpi}
          tab={tab}
          onTabChange={setTab}
          report={report}
          cropNodeId={cropNodeId}
          onCropNodeChange={setCropNodeId}
          measureNodeId={measureNodeId}
          measuredPx={measuredPx}
          onMeasureNodeChange={(id) => {
            setMeasureNodeId(id);
            setMeasuredPx(null);
          }}
          labelPickNodeId={labelPickNodeId}
          onLabelPickNodeChange={setLabelPickNodeId}
        />
      </main>

      <footer className="statusbar">
        <div className="group">
          {fileSystem.supported() ? (
            <>
              <button disabled={busy !== null} onClick={() => void save()}>
                Save
              </button>
              <button disabled={busy !== null} onClick={() => void saveAs()}>
                Save as…
              </button>
              <button disabled={busy !== null} onClick={() => void openViaPicker()}>
                Open project
              </button>
              <span
                className="muted file-target"
                title={
                  saveTarget?.location ??
                  'Not a path — the browser deliberately does not expose one'
                }
              >
                {saveTarget ? saveTarget.name : '— unsaved'}
              </span>
              {saveConfirmation && <span className="save-confirmation">{saveConfirmation}</span>}
            </>
          ) : (
            <>
              <button onClick={() => setSaveName(safeFilename(api.document.title))}>
                Save project…
              </button>
              <label className="file-button">
                Open project
                <input
                  type="file"
                  accept={ARCHIVE_EXTENSIONS.join(',')}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) openProject(file);
                  }}
                />
              </label>
              {saveConfirmation && <span className="save-confirmation">{saveConfirmation}</span>}
            </>
          )}
        </div>

        <div className="group">
          <button
            className={`readiness ${scoreTone(report.score)}`}
            onClick={() => setTab('quality')}
            title="Publication readiness — click for the findings"
          >
            {report.score}/100
            {blockingErrors.length > 0 && ` · ${blockingErrors.length} error`}
            {blockingErrors.length > 1 && 's'}
          </button>

          <label className="field">
            Raster DPI
            <select
              value={dpi}
              onChange={(e) => setDpi(Number(e.target.value) as 150 | 300 | 450 | 600)}
            >
              {[150, 300, 450, 600].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          {EXPORT_FORMATS.map((format) => (
            <button
              key={format.id}
              className={format.vector ? 'vector' : ''}
              disabled={busy !== null}
              onClick={() => requestExport(format.id)}
              title={format.vector ? 'Vector, editable text' : `Raster at ${dpi} dpi`}
            >
              {format.label}
            </button>
          ))}
        </div>
        {saveName !== null && (
          <SaveDialog
            name={saveName}
            onNameChange={setSaveName}
            onSave={() => saveViaDialog(saveName)}
            onCancel={() => setSaveName(null)}
          />
        )}
        {pendingExport !== null && (
          <ExportConfirmDialog
            format={pendingExport}
            errors={blockingErrors.map((f) => f.title)}
            onExport={() => void runExport(pendingExport)}
            onReview={() => {
              setPendingExport(null);
              setTab('quality');
            }}
          />
        )}
      </footer>
    </div>
  );
}

/**
 * What the figure is about to carry out of the app.
 *
 * Lists the errors rather than summarising them: "3 problems" is a number an
 * author dismisses, whereas "Bar 1 has no calibration" is one they recognise.
 * Both buttons are exits — neither refuses the export.
 */
function ExportConfirmDialog({
  format,
  errors,
  onExport,
  onReview,
}: {
  format: ExportFormat;
  errors: string[];
  onExport: () => void;
  onReview: () => void;
}) {
  return (
    <div className="save-dialog right" role="dialog" aria-label="Confirm export">
      <strong>
        {errors.length} issue{errors.length > 1 ? 's' : ''} in this figure
      </strong>
      <ul className="list compact">
        {errors.map((title) => (
          <li key={title}>{title}</li>
        ))}
      </ul>
      <span className="hint">
        These are the defects a reader cannot see in the exported file. The {format.toUpperCase()}{' '}
        will be produced either way.
      </span>
      <div className="group">
        <button className="primary" onClick={onReview}>
          Review in Quality
        </button>
        <button onClick={onExport}>Export anyway</button>
      </div>
    </div>
  );
}

/**
 * Name-before-save, rather than a filename derived silently from a title the
 * user has never seen. Built in-app instead of `window.prompt` so it can be
 * styled, themed and driven in a test like any other control.
 */
function SaveDialog({
  name,
  onNameChange,
  onSave,
  onCancel,
}: {
  name: string;
  onNameChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="save-dialog" role="dialog" aria-label="Save project">
      <label className="field block">
        File name
        <input
          autoFocus
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSave();
            else if (e.key === 'Escape') onCancel();
          }}
        />
      </label>
      <span className="hint">
        Saved as <code>{safeFilename(name)}{ARCHIVE_EXTENSION}</code>, and kept as the figure&apos;s
        title.
      </span>
      <div className="group">
        <button className="primary" onClick={onSave}>
          Save
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
