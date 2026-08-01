import { useCallback, useEffect, useState } from 'react';
import {
  ARCHIVE_EXTENSION,
  buildArchiveContents,
  loadArchive,
  saveArchive,
  type NodeId,
} from '@figureforge/doc-model';
import { renderDocument, toSvgString } from '@figureforge/render';
import { resolveTheme } from '@figureforge/theme';
import { Canvas } from './components/Canvas.js';
import { SidePanel } from './components/SidePanel.js';
import { Toolbar } from './components/Toolbar.js';
import { download, exportFigure, health, type ExportFormat } from './api.js';
import { createSampleDocument } from './sample.js';
import { useDocument, useUndoShortcuts } from './useDocument.js';
import './styles.css';

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

  const [selectedIds, setSelectedIds] = useState<NodeId[]>([]);
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

  // --- export -------------------------------------------------------------

  const runExport = useCallback(
    async (format: ExportFormat) => {
      setBusy(`Exporting ${format.toUpperCase()}`);
      setError(null);
      try {
        // Render without editor chrome: no selection outlines, no grid.
        const scene = renderDocument(api.document, { theme });
        const svg = toSvgString(scene, { xmlDeclaration: format === 'svg' });

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
    [api.document, theme, dpi],
  );

  // --- project file -------------------------------------------------------

  const saveProject = useCallback(() => {
    const bytes = saveArchive(buildArchiveContents(api.document));
    // Copy into a fresh buffer: the zip may sit in a larger pooled ArrayBuffer.
    download(
      new Blob([new Uint8Array(bytes)], { type: 'application/zip' }),
      `${api.document.title.slice(0, 60) || 'figure'}${ARCHIVE_EXTENSION}`,
    );
  }, [api.document]);

  const openProject = useCallback(
    async (file: File) => {
      try {
        const result = loadArchive(new Uint8Array(await file.arrayBuffer()));
        api.store.reset(result.document);
        setSelectedIds([]);
        setError(result.warnings.length > 0 ? result.warnings.join(' ') : null);
      } catch (caught) {
        setError(`Could not open project: ${String(caught)}`);
      }
    },
    [api.store],
  );

  return (
    <div className="app">
      <Toolbar
        api={api}
        theme={theme}
        selectedIds={selectedIds}
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
          onSelectionChange={setSelectedIds}
          zoom={zoom}
          showGrid={showGrid}
          assetUrls={{}}
        />

        <SidePanel
          api={api}
          theme={theme}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onError={setError}
          setBusy={setBusy}
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
