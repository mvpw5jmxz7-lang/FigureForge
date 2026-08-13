/**
 * The menu template.
 *
 * Two things here are worth pinning. Enablement is the obvious one — a menu
 * that offers Undo with nothing to undo is the "control that visibly does
 * nothing" defect this codebase refuses everywhere else.
 *
 * The accelerator split is the load-bearing one. An Electron menu accelerator
 * fires *before* the page, so registering `Ctrl+C`, `Delete` or `Ctrl+Z` here
 * would answer them one way for the whole window and silently break the data
 * grid, which chooses between "clear these cells" and "delete these nodes" by
 * looking at what has focus. These tests are what stop someone tidying the
 * `registerAccelerator: false` flags away as noise.
 */

import { describe, expect, it } from 'vitest';

import type { MenuCommand, ShellState } from './channels.js';
import {
  buildMenuTemplate,
  toElectronTemplate,
  walkTemplate,
  type MenuTemplateItem,
} from './menu.js';

const state = (overrides: Partial<ShellState> = {}): ShellState => ({
  dirty: false,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  showGrid: false,
  savedPath: null,
  title: 'Figure 1',
  ...overrides,
});

const context = (overrides: Partial<Parameters<typeof buildMenuTemplate>[0]> = {}) => ({
  state: state(),
  recent: [] as readonly string[],
  isMac: false,
  hasGuide: true,
  ...overrides,
});

const find = (items: MenuTemplateItem[], label: string): MenuTemplateItem | undefined =>
  [...walkTemplate(items)].find((item) => item.label === label);

describe('buildMenuTemplate', () => {
  it('offers the four top-level menus', () => {
    const labels = buildMenuTemplate(context()).map((item) => item.label);
    expect(labels).toEqual(['File', 'Edit', 'View', 'Help']);
  });

  it('adds the application menu on macOS only', () => {
    const mac = buildMenuTemplate(context({ isMac: true })).map((item) => item.label);
    expect(mac[0]).toBe('FigureForge');
  });

  describe('accelerators', () => {
    it('does not register keys the page handles context-sensitively', () => {
      const template = buildMenuTemplate(context({ state: state({ canUndo: true }) }));
      for (const label of ['Undo', 'Redo', 'Duplicate', 'Delete']) {
        const item = find(template, label);
        expect(item?.accelerator, `${label} should still display its shortcut`).toBeTruthy();
        expect(item?.registerAccelerator, `${label} must not steal its key`).toBe(false);
      }
    });

    it('registers keys nothing in the page binds', () => {
      const template = buildMenuTemplate(context());
      for (const label of ['New Figure', 'Open…', 'Save', 'Save As…', 'Zoom In']) {
        const item = find(template, label);
        expect(item?.accelerator, `${label} should have a shortcut`).toBeTruthy();
        // Undefined means "register", which is Electron's default.
        expect(item?.registerAccelerator, `${label} should register`).toBeUndefined();
      }
    });
  });

  describe('enablement', () => {
    it('disables undo and redo until there is history', () => {
      const template = buildMenuTemplate(context());
      expect(find(template, 'Undo')?.enabled).toBe(false);
      expect(find(template, 'Redo')?.enabled).toBe(false);
    });

    it('enables each independently', () => {
      const template = buildMenuTemplate(context({ state: state({ canRedo: true }) }));
      expect(find(template, 'Undo')?.enabled).toBe(false);
      expect(find(template, 'Redo')?.enabled).toBe(true);
    });

    it('gates duplicate and delete on a selection', () => {
      const empty = buildMenuTemplate(context());
      expect(find(empty, 'Duplicate')?.enabled).toBe(false);
      expect(find(empty, 'Delete')?.enabled).toBe(false);

      const selected = buildMenuTemplate(context({ state: state({ hasSelection: true }) }));
      expect(find(selected, 'Duplicate')?.enabled).toBe(true);
      expect(find(selected, 'Delete')?.enabled).toBe(true);
    });

    it('reflects the renderer´s real grid state in the checkbox', () => {
      expect(find(buildMenuTemplate(context()), 'Show Grid')?.checked).toBe(false);
      const shown = buildMenuTemplate(context({ state: state({ showGrid: true }) }));
      expect(find(shown, 'Show Grid')?.checked).toBe(true);
    });
  });

  describe('recent files', () => {
    it('disables the submenu and says so when there is nothing in it', () => {
      const template = buildMenuTemplate(context());
      const recent = find(template, 'Open Recent');
      expect(recent?.enabled).toBe(false);
      expect(recent?.submenu?.[0]?.label).toBe('Nothing yet');
    });

    it('lists entries by filename, carrying the full path in the command', () => {
      const template = buildMenuTemplate(
        context({ recent: ['/home/a/one.ffg', '/home/b/two.ffg'] }),
      );
      const recent = find(template, 'Open Recent');
      expect(recent?.enabled).toBe(true);
      expect(recent?.submenu?.map((item) => item.label)).toEqual(['one.ffg', 'two.ffg']);
      expect(recent?.submenu?.[0]?.command).toEqual({
        type: 'open-path',
        path: '/home/a/one.ffg',
      });
    });
  });

  describe('help', () => {
    it('omits the guide entry when the file is not there', () => {
      // A menu item that visibly does nothing is a defect, so it is withheld
      // rather than shown disabled.
      const template = buildMenuTemplate(context({ hasGuide: false }));
      expect(find(template, 'User Guide')).toBeUndefined();
      expect(find(template, 'About FigureForge')).toBeDefined();
    });
  });

  describe('toElectronTemplate', () => {
    const actions = () => {
      const commands: MenuCommand[] = [];
      return {
        commands,
        onCommand: (command: MenuCommand) => commands.push(command),
        onAbout: () => commands.push({ type: 'new' }),
        onGuide: () => undefined,
      };
    };

    it('strips `command`, which Electron would silently ignore', () => {
      const spy = actions();
      const converted = toElectronTemplate(buildMenuTemplate(context()), spy);
      // A leftover `command` field is the failure mode that leaves a menu item
      // looking correct and doing nothing at all.
      const leaked = JSON.stringify(converted).includes('"command"');
      expect(leaked).toBe(false);
    });

    it('turns a command into a click that reports it', () => {
      const spy = actions();
      const converted = toElectronTemplate(buildMenuTemplate(context()), spy);
      const file = converted.find((item) => item.label === 'File');
      const save = file?.submenu?.find((item) => item.label === 'Save');

      save?.click?.();
      expect(spy.commands).toEqual([{ type: 'save' }]);
    });

    it('carries the recent entry´s own path into its click', () => {
      const spy = actions();
      const converted = toElectronTemplate(
        buildMenuTemplate(context({ recent: ['/home/a/one.ffg'] })),
        spy,
      );
      const file = converted.find((item) => item.label === 'File');
      const recent = file?.submenu?.find((item) => item.label === 'Open Recent');
      recent?.submenu?.[0]?.click?.();

      expect(spy.commands).toEqual([{ type: 'open-path', path: '/home/a/one.ffg' }]);
    });

    it('preserves the accelerator flags through the conversion', () => {
      const spy = actions();
      const converted = toElectronTemplate(buildMenuTemplate(context()), spy);
      const edit = converted.find((item) => item.label === 'Edit');
      const undo = edit?.submenu?.find((item) => item.label === 'Undo');

      expect(undo?.accelerator).toBe('CmdOrCtrl+Z');
      expect(undo?.registerAccelerator).toBe(false);
    });
  });

  it('offers every export format the renderer supports', () => {
    const template = buildMenuTemplate(context());
    const exports = find(template, 'Export');
    expect(exports?.submenu?.map((item) => item.label)).toEqual([
      'PDF',
      'EPS',
      'SVG',
      'PNG',
      'TIFF',
    ]);
  });
});
