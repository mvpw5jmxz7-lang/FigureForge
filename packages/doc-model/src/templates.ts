/**
 * Panel arrangement templates.
 *
 * Auto Layout solves an equal grid, which is the right default and the wrong
 * answer whenever one panel carries more than the others — a wide time course
 * beside two small insets, say. A template names a grid whose tracks are
 * weighted and whose panels may span cells, so "panel a takes two thirds" is a
 * choice rather than something to be dragged into place by hand.
 *
 * Distinct from the *journal* templates in the theme package, which set page
 * size and typography and say nothing about arrangement.
 */

import type { GridSlot, GridSpec } from './layout.js';

export interface LayoutTemplate {
  id: string;
  label: string;
  /** How many panels the template arranges. */
  panelCount: number;
  grid: GridSpec;
  /** One slot per panel, in reading order. */
  slots: readonly GridSlot[];
  description: string;
}

export const LAYOUT_TEMPLATES: readonly LayoutTemplate[] = [
  {
    id: 'single',
    label: '1 panel',
    panelCount: 1,
    grid: { rows: 1, columns: 1 },
    slots: [{ row: 0, col: 0 }],
    description: 'One panel filling the page.',
  },
  {
    id: 'two-equal',
    label: '2 side by side',
    panelCount: 2,
    grid: { rows: 1, columns: 2 },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ],
    description: 'Two equal panels in one row.',
  },
  {
    id: 'two-thirds-one-third',
    label: '⅔ + ⅓',
    panelCount: 2,
    grid: { rows: 1, columns: 2, columnWeights: [2, 1] },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ],
    description: 'A wide panel with a narrow one beside it.',
  },
  {
    id: 'one-third-two-thirds',
    label: '⅓ + ⅔',
    panelCount: 2,
    grid: { rows: 1, columns: 2, columnWeights: [1, 2] },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
    ],
    description: 'A narrow panel with a wide one beside it.',
  },
  {
    id: 'three-equal',
    label: '3 across',
    panelCount: 3,
    grid: { rows: 1, columns: 3 },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ],
    description: 'Three equal panels in one row.',
  },
  {
    id: 'large-left-two-stacked',
    label: '⅔ + 2 stacked',
    panelCount: 3,
    // The arrangement the brief asks for: one panel over two thirds of the
    // width, two smaller ones stacked in the remaining third.
    grid: { rows: 2, columns: 2, columnWeights: [2, 1] },
    slots: [
      { row: 0, col: 0, rowSpan: 2 },
      { row: 0, col: 1 },
      { row: 1, col: 1 },
    ],
    description: 'A tall panel over two thirds, with two stacked beside it.',
  },
  {
    id: 'wide-top-two-below',
    label: 'Wide top + 2',
    panelCount: 3,
    grid: { rows: 2, columns: 2 },
    slots: [
      { row: 0, col: 0, colSpan: 2 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ],
    description: 'A full-width panel above two equal panels.',
  },
  {
    id: 'four-quadrants',
    label: '2 × 2',
    panelCount: 4,
    grid: { rows: 2, columns: 2 },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
    ],
    description: 'Four equal panels.',
  },
];

export const findLayoutTemplate = (id: string): LayoutTemplate | undefined =>
  LAYOUT_TEMPLATES.find((t) => t.id === id);

/** Templates that can arrange exactly this many panels. */
export const templatesForPanelCount = (count: number): LayoutTemplate[] =>
  LAYOUT_TEMPLATES.filter((t) => t.panelCount === count);
