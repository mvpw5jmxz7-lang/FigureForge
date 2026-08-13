/**
 * The application menu.
 *
 * Built as a pure function of `ShellState` returning a plain template, so the
 * two things worth asserting — that items enable and disable correctly, and
 * that the right items refuse to register their accelerator — are testable
 * without an Electron runtime.
 *
 * ## The accelerator rule, which is the whole difficulty here
 *
 * An Electron menu accelerator is registered with the OS and fires *before*
 * the page sees the key. That is fine for a shortcut nothing else handles, and
 * actively destructive for one the page handles **context-sensitively** — and
 * this app has several:
 *
 *   * `Ctrl+C`, `Ctrl+V`, `Delete` mean "clear these cells" in the data grid
 *     and "copy/paste/delete these nodes" on the canvas. `Canvas.tsx` chooses
 *     between them by inspecting the focused element.
 *   * `Ctrl+Z` in a data-grid cell that has been typed into is a *text* undo,
 *     and only becomes a document undo once the cell is untouched.
 *
 * A menu accelerator would take all of those and answer them one way for the
 * whole window, silently breaking the grid. So every item whose key the page
 * already owns is declared `registerAccelerator: false`: the shortcut is still
 * *shown* next to the item, which is what makes it discoverable, but the key
 * itself keeps reaching the page. The menu item's own click still works.
 *
 * Items whose keys nothing in the page binds — New, Open, zoom — register
 * normally. `Ctrl+S` is the interesting middle case: `App.tsx` binds it
 * window-wide with no typing guard, so registering it here means the menu wins
 * and the app's own listener never fires. That is *better* than two paths, and
 * both call the same `save()`, so it registers for real.
 *
 * Text editing inside inputs needs no menu entries at all — Chromium handles
 * cut/copy/paste/select-all natively in a focused field, and adding `role`
 * items for them would register exactly the accelerators the paragraph above
 * explains we must not take.
 */

import type { MenuCommand, ShellState } from './channels';

/** The subset of Electron's MenuItemConstructorOptions this module produces. */
export interface MenuTemplateItem {
  label?: string;
  id?: string;
  role?: string;
  type?: 'separator' | 'checkbox';
  accelerator?: string;
  registerAccelerator?: boolean;
  enabled?: boolean;
  checked?: boolean;
  command?: MenuCommand;
  submenu?: MenuTemplateItem[];
}

export interface MenuContext {
  state: ShellState;
  recent: readonly string[];
  isMac: boolean;
  /** Omitted when the file is not there, rather than shown doing nothing. */
  hasGuide: boolean;
}

const EXPORT_FORMATS = [
  { label: 'PDF', format: 'pdf' },
  { label: 'EPS', format: 'eps' },
  { label: 'SVG', format: 'svg' },
  { label: 'PNG', format: 'png' },
  { label: 'TIFF', format: 'tiff' },
] as const;

const separator: MenuTemplateItem = { type: 'separator' };

/** Shown in the submenu; the full path is the tooltip Electron gives for free. */
function recentLabel(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut === -1 ? path : path.slice(cut + 1);
}

function fileMenu(context: MenuContext): MenuTemplateItem {
  const { recent, isMac } = context;

  const openRecent: MenuTemplateItem = {
    label: 'Open Recent',
    // Disabled with its reason visible rather than hidden: a File menu that
    // grows and loses entries between sessions is harder to learn than one
    // whose shape is constant.
    enabled: recent.length > 0,
    submenu:
      recent.length === 0
        ? [{ label: 'Nothing yet', enabled: false }]
        : recent.map((path) => ({
            label: recentLabel(path),
            command: { type: 'open-path', path } as MenuCommand,
          })),
  };

  return {
    label: 'File',
    submenu: [
      { label: 'New Figure', accelerator: 'CmdOrCtrl+N', command: { type: 'new' } },
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', command: { type: 'open' } },
      openRecent,
      separator,
      { label: 'Save', accelerator: 'CmdOrCtrl+S', command: { type: 'save' } },
      {
        label: 'Save As…',
        accelerator: 'CmdOrCtrl+Shift+S',
        command: { type: 'save-as' },
      },
      separator,
      {
        label: 'Export',
        submenu: EXPORT_FORMATS.map((entry) => ({
          label: entry.label,
          command: { type: 'export', format: entry.format } as MenuCommand,
        })),
      },
      separator,
      { role: isMac ? 'close' : 'quit' },
    ],
  };
}

function editMenu(context: MenuContext): MenuTemplateItem {
  const { state } = context;
  return {
    label: 'Edit',
    submenu: [
      {
        label: 'Undo',
        accelerator: 'CmdOrCtrl+Z',
        // See the accelerator rule above: a typed-in data-grid cell wants a
        // text undo, and only the page can tell that from a document undo.
        registerAccelerator: false,
        enabled: state.canUndo,
        command: { type: 'undo' },
      },
      {
        label: 'Redo',
        accelerator: 'CmdOrCtrl+Shift+Z',
        registerAccelerator: false,
        enabled: state.canRedo,
        command: { type: 'redo' },
      },
      separator,
      {
        label: 'Duplicate',
        accelerator: 'CmdOrCtrl+D',
        registerAccelerator: false,
        enabled: state.hasSelection,
        command: { type: 'duplicate' },
      },
      {
        label: 'Delete',
        accelerator: 'Delete',
        registerAccelerator: false,
        enabled: state.hasSelection,
        command: { type: 'delete' },
      },
    ],
  };
}

function viewMenu(context: MenuContext): MenuTemplateItem {
  return {
    label: 'View',
    submenu: [
      // Nothing in the page binds these, so they register for real.
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', command: { type: 'zoom-in' } },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', command: { type: 'zoom-out' } },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', command: { type: 'zoom-reset' } },
      { label: 'Fit to Window', accelerator: 'CmdOrCtrl+9', command: { type: 'zoom-fit' } },
      separator,
      {
        label: 'Show Grid',
        type: 'checkbox',
        // Reflects the renderer's actual state rather than tracking a private
        // copy, which would drift the moment the toolbar toggle was used.
        checked: context.state.showGrid,
        command: { type: 'toggle-grid' },
      },
      separator,
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ],
  };
}

function helpMenu(context: MenuContext): MenuTemplateItem {
  const submenu: MenuTemplateItem[] = [{ label: 'About FigureForge', id: 'about' }];
  // Only offered when there is something to open. A menu item that visibly
  // does nothing is the defect this codebase refuses everywhere else.
  if (context.hasGuide) submenu.push({ label: 'User Guide', id: 'guide' });
  return { label: 'Help', role: 'help', submenu };
}

export function buildMenuTemplate(context: MenuContext): MenuTemplateItem[] {
  const template: MenuTemplateItem[] = [];

  // macOS puts the application menu first and expects About/Quit to live in
  // it; every other platform expects Quit at the bottom of File.
  if (context.isMac) {
    template.push({
      label: 'FigureForge',
      role: 'appMenu',
    });
  }

  template.push(fileMenu(context), editMenu(context), viewMenu(context), helpMenu(context));
  return template;
}

/** Walk the template, for wiring click handlers and for tests. */
export function* walkTemplate(
  items: readonly MenuTemplateItem[],
): Generator<MenuTemplateItem> {
  for (const item of items) {
    yield item;
    if (item.submenu) yield* walkTemplate(item.submenu);
  }
}

/** What the converted template needs to be able to call. */
export interface MenuActions {
  onCommand: (command: MenuCommand) => void;
  onAbout: () => void;
  onGuide: () => void;
}

/** The shape `Menu.buildFromTemplate` accepts, minus what we do not emit. */
export interface ElectronMenuItem {
  label?: string;
  role?: string;
  type?: 'separator' | 'checkbox';
  accelerator?: string;
  registerAccelerator?: boolean;
  enabled?: boolean;
  checked?: boolean;
  click?: () => void;
  submenu?: ElectronMenuItem[];
}

/**
 * Turn the declarative template into something Electron will accept.
 *
 * `command` is this codebase's own field, not an Electron option — it says
 * "this item asks the renderer to do X" — so it is translated to a `click`
 * here and must not survive into the output, where Electron would ignore it
 * and the item would silently do nothing. Kept in this module, and pure, so
 * that translation is testable without an Electron runtime; `main.ts` only
 * supplies the three effects.
 */
export function toElectronTemplate(
  items: readonly MenuTemplateItem[],
  actions: MenuActions,
): ElectronMenuItem[] {
  return items.map((item) => {
    const { command, submenu, id, ...rest } = item;
    const converted: ElectronMenuItem = { ...rest };

    if (command) converted.click = () => actions.onCommand(command);
    if (id === 'about') converted.click = actions.onAbout;
    if (id === 'guide') converted.click = actions.onGuide;
    if (submenu) converted.submenu = toElectronTemplate(submenu, actions);
    return converted;
  });
}
