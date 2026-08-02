import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ARCHIVE_EXTENSION,
  buildArchiveContents,
  loadArchive,
  saveArchive,
  type FigureDocument,
  type NodeId,
} from '@figureforge/doc-model';
import { renderDocument, toSvgString } from '@figureforge/render';
import { resolveTheme } from '@figureforge/theme';
import { Canvas } from './components/Canvas.js';
import { SidePanel } from './components/SidePanel.js';
import { Toolbar } from './components/Toolbar.js';
import { decodeImage, download, exportFigure, health, type ExportFormat } from './api.js';
import { useAssets, type AssetStore } from './assets.js';
import { createSampleDocument } from './sample.js';
import { useDocument, useUndoShortcuts } from './useDocument.js';
import './styles.css';

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

export function App() {
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
  const [zoom, setZoom] = useState(() => fitZoom(api.document.page.widthMm));
  const [showGrid, setShowGrid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [dpi, setDpi] = useState<150 | 300 | 450 | 600>(300);

  const theme = resolveTheme(api.document.themeId, api.document.themeOverrides);

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

  // --- export -------------------------------------------------------------

  const runExport = useCallback(
    async (format: ExportFormat) => {
      setBusy(`Exporting ${format.toUpperCase()}`);
      setError(null);
      try {
        // Render without editor chrome: no selection outlines, no grid.
        // Assets resolve to data URIs, never the canvas's blob URLs: those are
        // meaningless outside this tab, so the service would render blanks.
        const scene = renderDocument(api.document, {
          theme,
          resolveAsset: assets.resolveForExport,
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
          filename: api.document.title.replace(/[^\w-]+/g, '_').slice(0, 60) || 'figure',
        });

        download(blob, `${api.document.title.slice(0, 60) || 'figure'}.${format}`);
      } catch (caught) {
        setError(`Export failed: ${String(caught)}`);
      } finally {
        setBusy(null);
      }
    },
    [api.document, theme, dpi, assets],
  );

  // --- project file -------------------------------------------------------

  const saveProject = useCallback(() => {
    const bytes = saveArchive(
      // Both side-stores go in, or the archive keeps the metadata and loses
      // the thing it describes: a project whose micrographs are grey boxes and
      // whose "verbatim" CSV was re-serialised on the way out.
      buildArchiveContents(
        api.document,
        dataOriginals.current,
        assets.store.archiveMap(api.document),
      ),
    );
    // Copy into a fresh buffer: the zip may sit in a larger pooled ArrayBuffer.
    download(
      new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
      `${api.document.title.slice(0, 60) || 'figure'}${ARCHIVE_EXTENSION}`,
    );
  }, [api.document, assets.store]);

  const openProject = useCallback(
    async (file: File) => {
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
        setError(result.warnings.length > 0 ? result.warnings.join(' ') : null);

        await rehydrateProxies(result.document, assets.store, setError);
      } catch (caught) {
        setError(`Could not open project: ${String(caught)}`);
      }
    },
    [api.store, assets.store],
  );

  return (
    <div className="app">
      <Toolbar
        api={api}
        theme={theme}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        zoom={zoom}
        onZoomChange={setZoom}
        onFit={() => setZoom(fitZoom(api.document.page.widthMm))}
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
          }}
          zoom={zoom}
          showGrid={showGrid}
          assetUrls={assets.urls}
          cropNodeId={cropNodeId}
          measureNodeId={measureNodeId}
          onMeasured={setMeasuredPx}
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
          cropNodeId={cropNodeId}
          onCropNodeChange={setCropNodeId}
          measureNodeId={measureNodeId}
          measuredPx={measuredPx}
          onMeasureNodeChange={(id) => {
            setMeasureNodeId(id);
            setMeasuredPx(null);
          }}
        />
      </main>

      <footer className="statusbar">
        <div className="group">
          <button onClick={saveProject}>Save project</button>
          <label className="file-button">
            Open project
            <input
              type="file"
              accept={ARCHIVE_EXTENSION}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void openProject(file);
              }}
            />
          </label>
        </div>

        <div className="group">
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
              onClick={() => void runExport(format.id)}
              title={format.vector ? 'Vector, editable text' : `Raster at ${dpi} dpi`}
            >
              {format.label}
            </button>
          ))}
        </div>
      </footer>
    </div>
  );
}
