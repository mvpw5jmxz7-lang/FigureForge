import {
  absoluteFrame,
  addArrow,
  addEmptyMontagePanel,
  addGroup,
  addGroupLabel,
  addScaleBar,
  addShape,
  addText,
  ALIGNABLE_NODE_TYPES,
  alignSelection,
  applyAutoLayout,
  distributeSelection,
  fillPanelChildren,
  formatMm,
  isLocked,
  nextPanelFrame,
  reflowGroupLabels,
  relabelPanels,
  reorderNode,
  reserveSpaceForGroupLabels,
  suggestGrid,
  templatesForPanelCount,
  findLayoutTemplate,
  ungroup,
  type AlignMode,
  type DisplayUnit,
  type FigureDocument,
  type GuideAxis,
  type NodeId,
  type RectMm,
} from '@figureforge/doc-model';
import { reflowBrackets } from '@figureforge/render';
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

  // Ungroup is offered only for a lone group — the same one-node gate
  // `selectedImage` above uses for the scale bar button.
  const selectedGroup =
    selectedIds.length === 1 && doc.nodes[selectedIds[0]!]?.type === 'group' ? selectedIds[0]! : null;

  // A group-label's members are panels or images — a caption on one, or a
  // heading over several, through the same mechanism (round 26's own
  // multi-select, reused rather than a new selection UI being invented).
  const groupLabelMembers = selectedIds.filter((id) => {
    const node = doc.nodes[id];
    return node !== undefined && (node.type === 'panel' || node.type === 'image') && !isLocked(doc, id);
  });

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
      // A line's angle is its own frame's aspect ratio (renderShape draws it
      // corner-to-corner) — start it flat rather than at the generic
      // non-square rect/ellipse default, which drew a diagonal.
      const frame = shape === 'line' ? insertFrame(20, 0) : insertFrame(20, 14);
      const node = addShape(draft, newId, { shape, frame });
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

  const ungroupSelection = (): void => {
    if (!selectedGroup) return;
    commit('Ungroup', (draft) => {
      const members = ungroup(draft, selectedGroup);
      if (members.length > 0) onSelectionChange(members);
    });
  };

  /**
   * A caption on one selected panel/image, or a heading over several.
   *
   * Whether this needs to grow a gap, and how, differs by scope: members
   * sharing one montage panel already have a live grid gutter
   * (`fillPanelChildren`) that only needs a fresh tiling pass to show it;
   * members spread across independent panels need `reserveSpaceForGroupLabels`
   * instead — safe here specifically because creating a heading is a
   * deliberate action, not the manual drag/resize/align/distribute that
   * function is otherwise never run after.
   */
  const addGroupTitle = (): void => {
    if (groupLabelMembers.length === 0) return;
    commit('Add group title', (draft) => {
      const label = addGroupLabel(draft, newId, {
        memberIds: groupLabelMembers,
        edge: 'top',
        title: 'Group title',
        // The size the rest of the figure's type is set in, not a panel
        // letter's — a heading is a caption, not a panel identifier.
        fontSizePt: theme.type.annotationPt,
      });
      if (!label) return;

      const parentIds = new Set(groupLabelMembers.map((id) => draft.nodes[id]?.parentId ?? null));
      const soleParentId = parentIds.size === 1 ? [...parentIds][0] : null;
      const soleParent = soleParentId ? draft.nodes[soleParentId] : null;
      if (soleParent?.type === 'panel' && soleParent.contentGrid) {
        fillPanelChildren(draft, soleParent.id, soleParent.frame);
      } else {
        reserveSpaceForGroupLabels(draft);
      }
      reflowGroupLabels(draft);
      onSelectionChange([label.id]);
    });
  };

  /**
   * A montage panel with a declared grid and zero children — the starting
   * point for filling cells in one at a time from the Inspector
   * (`setMontageCellImage`), rather than only ever arriving from a bulk
   * multi-file import.
   */
  const addEmptyMontage = (rows: number, cols: number): void =>
    commit('Add empty montage', (draft) => {
      const panel = addEmptyMontagePanel(draft, newId, {
        frame: nextPanelFrame(draft, { width: 60, height: 50 }),
        name: `Montage ${rows}×${cols}`,
        rows,
        cols,
        gutterMm: 2,
      });
      applyAutoLayout(draft, layoutOptions);
      reserveSpaceForGroupLabels(draft);
      relabelPanels(draft, newId, {
        uppercase: theme.panelLabelCase === 'upper',
        fontSizePt: theme.type.panelLabelPt,
        offsetMm: 4,
      });
      reflowGroupLabels(draft);
      reflowBrackets(draft, theme);
      onSelectionChange([panel.id]);
    });

  // Same predicate `alignSelection`/`distributeSelection` themselves filter
  // by, read here only to gate and label the dropdown — not a second,
  // independently-typed-out copy of which types are alignable.
  const alignableCount = selectedIds.filter((id) => {
    const node = doc.nodes[id];
    return node !== undefined && ALIGNABLE_NODE_TYPES.has(node.type) && !isLocked(doc, id);
  }).length;

  // Brackets sit in absolute page space (see `alignSelection`'s own doc
  // comment), so aligning a panel that carries one needs the same
  // reflow-after-reposition step `applyPreset`/`arrange` already take.
  const runAlign = (mode: AlignMode): void => {
    api.transaction(`Align ${mode}`, () => {
      commit('Align', (draft) => alignSelection(draft, selectedIds, mode));
      commit('Reposition brackets', (draft) => {
        // Never `reserveSpaceForGroupLabels` here: a manual align/distribute
        // leaves frames alone except for snapping, and growing a gap on top
        // of it would read as the editor overriding the drag. A heading
        // still needs to follow wherever its members just landed, though —
        // the same "always follow" contract `reflowBrackets` already has.
        reflowGroupLabels(draft);
        reflowBrackets(draft, theme);
      });
    });
  };

  const runDistribute = (axis: GuideAxis): void => {
    api.transaction(`Distribute ${axis}`, () => {
      commit('Distribute', (draft) => distributeSelection(draft, selectedIds, axis));
      commit('Reposition brackets', (draft) => {
        reflowGroupLabels(draft);
        reflowBrackets(draft, theme);
      });
    });
  };

  const runAlignCommand = (value: string): void => {
    if (value === 'distribute-x') runDistribute('x');
    else if (value === 'distribute-y') runDistribute('y');
    else if (value) runAlign(value as AlignMode);
  };

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
        // A from-scratch grid recompute, so — unlike a manual align/resize —
        // it is safe to grow a gap for a cross-panel heading here.
        reserveSpaceForGroupLabels(draft);
        // Brackets sit in absolute page space, so nothing else moves them with
        // the panels they annotate.
        reflowGroupLabels(draft);
        reflowBrackets(draft, theme);
      });
    });
  };

  /** Arrange, reletter, then put the significance brackets back on their bars. */
  const arrange = (label: string, templateId?: string): void => {
    const template = templateId ? (findLayoutTemplate(templateId) ?? null) : null;

    api.transaction(label, () => {
      commit('Arrange panels', (draft) => {
        applyAutoLayout(draft, { ...layoutOptions, template });
        reserveSpaceForGroupLabels(draft);
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
        reflowGroupLabels(draft);
        reflowBrackets(draft, theme);
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

        {/* The title has always existed on the document and named every saved
            file, but nothing ever showed it — so every figure downloaded itself
            under the sample document's name. */}
        <input
          className="figure-title"
          value={doc.title}
          placeholder="Untitled figure"
          title="Figure title — the default name for saves and exports"
          onChange={(e) =>
            commit('Rename figure', (draft) => {
              draft.title = e.target.value;
            })
          }
        />

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
            template would leave panels unplaced. The control is always shown,
            even with nothing to offer: hiding it made the feature look as
            though it had stopped working the moment a figure grew past four
            panels, rather than saying there is no template for that count. */}
        <select
          value=""
          title="Panel arrangement"
          disabled={templates.length === 0}
          onChange={(e) => {
            if (e.target.value) arrange('Apply layout template', e.target.value);
          }}
        >
          <option value="">
            {templates.length > 0 ? 'Template…' : `No template for ${panelCount} panels`}
          </option>
          {templates.map((template) => (
            <option key={template.id} value={template.id} title={template.description}>
              {template.label}
            </option>
          ))}
        </select>
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
              : 'Group — click any member to select the group, double-click to step inside'
          }
        >
          Group
        </button>
        <button
          onClick={ungroupSelection}
          disabled={selectedGroup === null}
          title={
            selectedGroup === null
              ? 'Select a group first'
              : 'Ungroup — members return to their own selection, keeping their page position'
          }
        >
          Ungroup
        </button>
        <button
          onClick={addGroupTitle}
          disabled={groupLabelMembers.length === 0}
          title={
            groupLabelMembers.length === 0
              ? 'Select one or more panels/images — one member captions it, several get a shared heading'
              : groupLabelMembers.length === 1
                ? 'Add a caption above the selected panel or image'
                : `Add a heading over the selected ${groupLabelMembers.length} panels/images`
          }
        >
          Add group title
        </button>
        <select
          value=""
          title="Add an empty montage panel, then fill its cells from the Inspector"
          onChange={(e) => {
            const value = e.target.value;
            e.target.value = '';
            if (!value) return;
            const [rows, cols] = value.split('x').map(Number) as [number, number];
            addEmptyMontage(rows, cols);
          }}
        >
          <option value="">Add empty montage…</option>
          <option value="1x2">1 × 2</option>
          <option value="2x1">2 × 1</option>
          <option value="2x2">2 × 2</option>
          <option value="1x3">1 × 3</option>
        </select>
      </div>

      {/* Align/distribute whatever is selected — panels, images, shapes,
          arrows, text, groups and panel labels alike. A one-shot command
          dropdown, not bound to a persistent document field, so it resets
          to its placeholder after firing rather than showing a "stuck"
          option. */}
      <div className="toolbar-group">
        <select
          value=""
          disabled={alignableCount < 2}
          title={
            alignableCount < 2
              ? 'Select at least two objects to align'
              : 'Align or distribute the selection'
          }
          onChange={(e) => {
            const value = e.target.value;
            e.target.value = '';
            runAlignCommand(value);
          }}
        >
          <option value="">Align…</option>
          <option value="left">Left edges</option>
          <option value="center-h">Center horizontally</option>
          <option value="right">Right edges</option>
          <option value="top">Top edges</option>
          <option value="center-v">Center vertically</option>
          <option value="bottom">Bottom edges</option>
          <option value="distribute-x" disabled={alignableCount < 3}>
            Distribute horizontally
          </option>
          <option value="distribute-y" disabled={alignableCount < 3}>
            Distribute vertically
          </option>
        </select>
      </div>

      {/* Draw order for whatever is selected. Layers has the same two steps per
          row; this is the version that works while you are looking at the page. */}
      <div className="toolbar-group">
        {(
          [
            ['front', 'Bring to front'],
            ['forward', 'Bring forward'],
            ['backward', 'Send backward'],
            ['back', 'Send to back'],
          ] as const
        ).map(([where, label]) => (
          <button
            key={where}
            disabled={selectedIds.length === 0}
            title={label}
            onClick={() =>
              commit(label, (draft) => {
                for (const id of selectedIds) reorderNode(draft, id, where);
              })
            }
          >
            {{ front: '⤒', forward: '↑', backward: '↓', back: '⤓' }[where]}
          </button>
        ))}
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
