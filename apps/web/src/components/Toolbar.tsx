import {
  absoluteFrame,
  addArrow,
  addGroup,
  addScaleBar,
  addShape,
  addText,
  applyAutoLayout,
  formatMm,
  relabelPanels,
  repositionBrackets,
  suggestGrid,
  templatesForPanelCount,
  findLayoutTemplate,
  type DisplayUnit,
  type FigureDocument,
  type NodeId,
  type RectMm,
} from '@figureforge/doc-model';
import { measureAllPlots } from '@figureforge/render';
import { PAGE_PRESETS, type Theme } from '@figureforge/theme';
import { frameOf } from './Canvas.js';
import type { DocumentApi } from '../useDocument.js';

export interface ToolbarProps {
  api: DocumentApi;
  theme: Theme;
  selectedIds: NodeId[];
  onSelectionChange: (ids: NodeId[]) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onFit: () => void;
  showGrid: boolean;
  onShowGridChange: (show: boolean) => void;
  busy: string | null;
}

/**
 * Where a newly inserted annotation goes.
 *
 * Over the selection when there is one, since an annotation almost always
 * refers to the thing just clicked. Otherwise stepped down the page by the
 * number of annotations already there, so repeated inserts do not stack
 * invisibly on top of each other.
 */
function annotationOrigin(doc: FigureDocument, selectedIds: NodeId[]): { x: number; y: number } {
  if (selectedIds.length === 1) {
    const frame = absoluteFrame(doc.nodes, selectedIds[0]!);
    if (frame) return { x: frame.x + frame.width * 0.25, y: frame.y + frame.height * 0.25 };
  }
  const existing = Object.values(doc.nodes).filter(
    (n) => n.type === 'arrow' || n.type === 'shape' || n.type === 'text',
  ).length;
  const step = (existing % 6) * 3;
  return { x: 8 + step, y: 8 + step };
}

export function Toolbar({
  api,
  theme,
  selectedIds,
  onSelectionChange,
  zoom,
  onZoomChange,
  onFit,
  showGrid,
  onShowGridChange,
  busy,
}: ToolbarProps) {
  const { document: doc, commit, newId } = api;
  const unit = doc.page.displayUnit;

  // A scale bar takes its length from the image it sits on, so it is only
  // offered when there is one. `addScaleBar` refuses any other target.
  const selectedImage =
    selectedIds.length === 1 && doc.nodes[selectedIds[0]!]?.type === 'image'
      ? doc.nodes[selectedIds[0]!]
      : null;

  const insertFrame = (width: number, height: number): RectMm => {
    const origin = annotationOrigin(doc, selectedIds);
    return { ...origin, width, height };
  };

  const insertArrow = (): void =>
    commit('Insert arrow', (draft) => {
      const arrow = addArrow(draft, newId, { frame: insertFrame(20, 12) });
      onSelectionChange([arrow.id]);
    });

  const insertShape = (shape: 'rect' | 'ellipse' | 'line'): void =>
    commit('Insert shape', (draft) => {
      const node = addShape(draft, newId, { shape, frame: insertFrame(20, 14) });
      onSelectionChange([node.id]);
    });

  const insertText = (): void =>
    commit('Insert text', (draft) => {
      const node = addText(draft, newId, {
        frame: insertFrame(30, 6),
        text: 'Label',
        fontSizePt: theme.type.annotationPt,
      });
      onSelectionChange([node.id]);
    });

  const insertScaleBar = (): void => {
    if (!selectedImage) return;
    commit('Insert scale bar', (draft) => {
      const image = draft.nodes[selectedImage.id];
      if (image?.type !== 'image') return;

      // With no calibration there is no honest length, so the bar is created
      // explicitly uncalibrated at a fifth of the image and the quality
      // checker says so. The schema forbids a zero pixelsPerUnit, so a
      // placeholder is unavoidable — flagging it is what keeps it honest.
      const visiblePx = image.naturalPx.width * (image.crop.width || 1);
      const placeholder = visiblePx > 0 ? visiblePx / 5 : 100;

      const bar = addScaleBar(draft, newId, {
        imageId: image.id,
        length: 10,
        pixelsPerUnit: placeholder / 10,
        unitLabel: 'µm',
        calibrationSource: 'unknown',
        fontSizePt: theme.type.scaleBarPt,
      });
      if (bar) onSelectionChange([bar.id]);
    });
  };

  const groupSelection = (): void =>
    commit('Group', (draft) => {
      const group = addGroup(draft, newId, selectedIds);
      if (group) onSelectionChange([group.id]);
    });

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

      <div className="toolbar-group">
        {/* Insert is an action, so it lives here with the other actions rather
            than as a sixth tab in a 340 px panel. Images are imported in the
            Data tab, beside the other things brought in from outside. */}
        <span className="group-label">Insert</span>
        <button onClick={insertArrow} title="Arrow — drag its grips to aim it">
          Arrow
        </button>
        <select
          value=""
          title="Shape"
          onChange={(e) => {
            if (e.target.value) insertShape(e.target.value as 'rect' | 'ellipse' | 'line');
          }}
        >
          <option value="">Shape…</option>
          <option value="rect">Rectangle</option>
          <option value="ellipse">Ellipse</option>
          <option value="line">Line</option>
        </select>
        <button onClick={insertText} title="Text label">
          Text
        </button>
        <button
          onClick={insertScaleBar}
          disabled={selectedImage === null}
          title={
            selectedImage
              ? 'Scale bar over the selected image'
              : 'Select an image first — a scale bar takes its length from the image it sits on'
          }
        >
          Scale bar
        </button>
        <button
          onClick={groupSelection}
          disabled={selectedIds.length < 2}
          title={
            selectedIds.length < 2
              ? 'Select two or more items sharing a parent'
              : 'Group — reachable from the Layers list; clicking the canvas still selects the item'
          }
        >
          Group
        </button>
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
