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
 *
 * Nothing here grows the page. `gridCells` divides the *existing*
 * `page.heightMm` into rows, and `applyPreset` never writes a height — so a
 * template with several rows compresses its panels into whatever height the
 * document already has rather than extending it. That is why every template
 * taller than two rows states the height it wants in its `description`, which
 * the Toolbar already shows as the option's tooltip: a number the author can
 * act on beats a stack of 15 mm panels they have to diagnose.
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
    id: 'two-stacked',
    label: '2 stacked',
    panelCount: 2,
    grid: { rows: 2, columns: 1 },
    slots: [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    ],
    description: 'Two equal panels in one column.',
  },
  {
    id: 'two-thirds-over-one-third',
    label: '⅔ over ⅓',
    panelCount: 2,
    grid: { rows: 2, columns: 1, rowWeights: [2, 1] },
    slots: [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
    ],
    description: 'A tall panel above a short one.',
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
    id: 'three-stacked',
    label: '3 stacked',
    panelCount: 3,
    grid: { rows: 3, columns: 1 },
    slots: [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 2, col: 0 },
    ],
    description: 'Three equal panels in one column. Tall: set page height to ~135 mm first.',
  },
  {
    id: 'three-two-over-wide-bottom',
    label: '2 + wide bottom',
    panelCount: 3,
    grid: { rows: 2, columns: 2 },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0, colSpan: 2 },
    ],
    description: 'Two equal panels above a full-width panel.',
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
  {
    id: 'four-wide-top-three-below',
    label: 'Wide top + 3',
    panelCount: 4,
    grid: { rows: 2, columns: 3 },
    slots: [
      { row: 0, col: 0, colSpan: 3 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ],
    description: 'A full-width panel above three equal panels.',
  },
  {
    id: 'four-three-over-wide-bottom',
    label: '3 + wide bottom',
    panelCount: 4,
    grid: { rows: 2, columns: 3 },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 0, colSpan: 3 },
    ],
    description: 'Three equal panels above a full-width panel.',
  },
  {
    id: 'four-stacked',
    label: '4 stacked',
    panelCount: 4,
    grid: { rows: 4, columns: 1 },
    slots: [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 2, col: 0 },
      { row: 3, col: 0 },
    ],
    description: 'Four equal panels in one column. Tall: set page height to ~160 mm first.',
  },
  {
    id: 'four-tall-left-three-stacked',
    label: '⅔ + 3 stacked',
    panelCount: 4,
    grid: { rows: 3, columns: 2, columnWeights: [2, 1] },
    slots: [
      { row: 0, col: 0, rowSpan: 3 },
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { row: 2, col: 1 },
    ],
    description:
      'A tall panel over two thirds, with three stacked beside it. Set page height to ~135 mm first.',
  },
  {
    id: 'five-two-over-three',
    label: '2 over 3',
    panelCount: 5,
    grid: { rows: 2, columns: 6 },
    slots: [
      { row: 0, col: 0, colSpan: 3 },
      { row: 0, col: 3, colSpan: 3 },
      { row: 1, col: 0, colSpan: 2 },
      { row: 1, col: 2, colSpan: 2 },
      { row: 1, col: 4, colSpan: 2 },
    ],
    // A 6-column grid is the smallest that divides evenly by both 2 and 3, so
    // neither row needs a fractional cell.
    description: 'Two panels above three.',
  },
  {
    id: 'five-wide-top-four-below',
    label: 'Wide top + 4',
    panelCount: 5,
    grid: { rows: 2, columns: 4 },
    slots: [
      { row: 0, col: 0, colSpan: 4 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
      { row: 1, col: 3 },
    ],
    description: 'A full-width panel above four equal panels.',
  },
  {
    id: 'five-three-over-two',
    label: '3 over 2',
    panelCount: 5,
    // Same 6-column reasoning as `five-two-over-three`, with the rows swapped.
    grid: { rows: 2, columns: 6 },
    slots: [
      { row: 0, col: 0, colSpan: 2 },
      { row: 0, col: 2, colSpan: 2 },
      { row: 0, col: 4, colSpan: 2 },
      { row: 1, col: 0, colSpan: 3 },
      { row: 1, col: 3, colSpan: 3 },
    ],
    description: 'Three panels above two.',
  },
  {
    id: 'five-stacked',
    label: '5 stacked',
    panelCount: 5,
    grid: { rows: 5, columns: 1 },
    slots: [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 2, col: 0 },
      { row: 3, col: 0 },
      { row: 4, col: 0 },
    ],
    description: 'Five equal panels in one column. Tall: set page height to ~200 mm first.',
  },
  {
    id: 'six-grid',
    label: '3 × 2',
    panelCount: 6,
    grid: { rows: 2, columns: 3 },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ],
    description: 'Six equal panels, three across and two down.',
  },
  {
    id: 'six-two-across',
    label: '2 × 3',
    panelCount: 6,
    grid: { rows: 3, columns: 2 },
    slots: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 2, col: 0 },
      { row: 2, col: 1 },
    ],
    description:
      'Six equal panels, two across and three down. Set page height to ~135 mm first.',
  },
  {
    id: 'six-one-two-three',
    label: '1 + 2 + 3',
    panelCount: 6,
    // 6 columns again: the only width that divides evenly by 1, 2 and 3 at
    // once, so none of the three rows needs a fractional cell.
    grid: { rows: 3, columns: 6 },
    slots: [
      { row: 0, col: 0, colSpan: 6 },
      { row: 1, col: 0, colSpan: 3 },
      { row: 1, col: 3, colSpan: 3 },
      { row: 2, col: 0, colSpan: 2 },
      { row: 2, col: 2, colSpan: 2 },
      { row: 2, col: 4, colSpan: 2 },
    ],
    description: 'A full-width panel, then two, then three. Set page height to ~135 mm first.',
  },
  {
    id: 'six-stacked',
    label: '6 stacked',
    panelCount: 6,
    grid: { rows: 6, columns: 1 },
    slots: [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 2, col: 0 },
      { row: 3, col: 0 },
      { row: 4, col: 0 },
      { row: 5, col: 0 },
    ],
    description: 'Six equal panels in one column. Very tall: set page height to ~225 mm first.',
  },
];

export const findLayoutTemplate = (id: string): LayoutTemplate | undefined =>
  LAYOUT_TEMPLATES.find((t) => t.id === id);

/** Templates that can arrange exactly this many panels. */
export const templatesForPanelCount = (count: number): LayoutTemplate[] =>
  LAYOUT_TEMPLATES.filter((t) => t.panelCount === count);
