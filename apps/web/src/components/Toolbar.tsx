import {
  applyAutoLayout,
  formatMm,
  relabelPanels,
  repositionBrackets,
  suggestGrid,
  templatesForPanelCount,
  findLayoutTemplate,
  type DisplayUnit,
  type NodeId,
} from '@figureforge/doc-model';
import { measureAllPlots } from '@figureforge/render';
import { PAGE_PRESETS, type Theme } from '@figureforge/theme';
import { frameOf } from './Canvas.js';
import type { DocumentApi } from '../useDocument.js';

export interface ToolbarProps {
  api: DocumentApi;
  theme: Theme;
  selectedIds: NodeId[];
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onFit: () => void;
  showGrid: boolean;
  onShowGridChange: (show: boolean) => void;
  busy: string | null;
}

export function Toolbar({
  api,
  theme,
  selectedIds,
  zoom,
  onZoomChange,
  onFit,
  showGrid,
  onShowGridChange,
  busy,
}: ToolbarProps) {
  const { document: doc, commit, newId } = api;
  const unit = doc.page.displayUnit;

  const panelCount = Object.values(doc.nodes).filter((n) => n.type === 'panel').length;
  const grid = suggestGrid(panelCount);

  const layoutOptions = {
    marginMm: theme.spacing.marginMm,
    gutterMm: theme.spacing.panelGutterMm,
    labelGutterMm: 4,
  };

  const applyPreset = (presetId: string): void => {
    const preset = PAGE_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    api.transaction('Change journal preset', () => {
      commit('Resize page', (draft) => {
        draft.page.presetId = preset.id;
        draft.page.widthMm = preset.widthMm;
        draft.themeId = preset.themeId;
      });
      commit('Re-layout', (draft) => {
        applyAutoLayout(draft, layoutOptions);
        // Brackets sit in absolute page space, so nothing else moves them with
        // the panels they annotate.
        repositionBrackets(draft, measureAllPlots(draft, theme));
      });
    });
  };

  /** Arrange, reletter, then put the significance brackets back on their bars. */
  const arrange = (label: string, templateId?: string): void => {
    const template = templateId ? (findLayoutTemplate(templateId) ?? null) : null;

    api.transaction(label, () => {
      commit('Arrange panels', (draft) => {
        applyAutoLayout(draft, { ...layoutOptions, template });
      });
      // Panels may have changed order, so the letters must follow.
      commit('Reletter panels', (draft) => {
        relabelPanels(draft, newId, {
          uppercase: theme.panelLabelCase === 'upper',
          fontSizePt: theme.type.panelLabelPt,
          offsetMm: 4,
        });
      });
      commit('Reposition brackets', (draft) => {
        repositionBrackets(draft, measureAllPlots(draft, theme));
      });
    });
  };

  const templates = templatesForPanelCount(panelCount);

  const selectedFrame = selectedIds.length === 1 ? frameOf(doc, selectedIds[0]!) : null;

  return (
    <header className="toolbar">
      <div className="toolbar-group">
        <strong className="brand">FigureForge</strong>
        <select
          value={doc.page.presetId ?? ''}
          onChange={(e) => applyPreset(e.target.value)}
          title="Journal template"
        >
          {PAGE_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label} · {preset.widthMm} mm
            </option>
          ))}
        </select>

        <label className="field">
          Height
          <input
            type="number"
            min={10}
            max={400}
            step={1}
            value={Math.round(doc.page.heightMm)}
            onChange={(e) =>
              commit('Change page height', (draft) => {
                draft.page.heightMm = Math.max(10, Number(e.target.value) || 10);
              })
            }
          />
        </label>

        <select
          value={unit}
          onChange={(e) =>
            commit('Change display unit', (draft) => {
              draft.page.displayUnit = e.target.value as DisplayUnit;
            })
          }
          title="Display units"
        >
          {(['mm', 'cm', 'in', 'px'] as const).map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar-group">
        <button onClick={() => arrange('Auto layout')} title={`Arrange as ${grid.rows}×${grid.columns}`}>
          Auto layout ({grid.rows}×{grid.columns})
        </button>

        {/* Arrangement templates, so panels need not all be the same size.
            Only those matching the panel count are offered — a mismatched
            template would leave panels unplaced. */}
        {templates.length > 0 && (
          <select
            value=""
            title="Panel arrangement"
            onChange={(e) => {
              if (e.target.value) arrange('Apply layout template', e.target.value);
            }}
          >
            <option value="">Template…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id} title={template.description}>
                {template.label}
              </option>
            ))}
          </select>
        )}
        <button onClick={api.undo} disabled={!api.canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button onClick={api.redo} disabled={!api.canRedo} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={showGrid}
            onChange={(e) => onShowGridChange(e.target.checked)}
          />
          Grid
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={doc.grid.snap}
            onChange={(e) =>
              commit('Toggle snapping', (draft) => {
                draft.grid.snap = e.target.checked;
              })
            }
          />
          Snap
        </label>
      </div>

      <div className="toolbar-group right">
        {busy && <span className="busy">{busy}…</span>}

        {/* Real-world dimensions, shown continuously as the brief requires. */}
        <span className="readout" title="Figure dimensions">
          {formatMm(doc.page.widthMm, unit)} × {formatMm(doc.page.heightMm, unit)}
        </span>
        {selectedFrame && (
          <span className="readout selected">
            sel {formatMm(selectedFrame.width, unit)} × {formatMm(selectedFrame.height, unit)}
          </span>
        )}

        <label className="field">
          Zoom
          <input
            type="range"
            min={0.5}
            max={5}
            step={0.1}
            value={zoom}
            onChange={(e) => onZoomChange(Number(e.target.value))}
          />
          <span className="zoom-value">{Math.round(zoom * 100)}%</span>
        </label>
        <button onClick={onFit} title="Fit the figure to the canvas">
          Fit
        </button>
      </div>
    </header>
  );
}
