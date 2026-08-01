/**
 * Journal page presets.
 *
 * Widths are the figures journals actually publish to. Nature's are the
 * canonical case: 89 mm single-column, 183 mm double-column, and a hard
 * 247 mm ceiling on height so a figure plus its legend fits one page.
 */

export interface PagePreset {
  id: string;
  journal: string;
  label: string;
  widthMm: number;
  /** Suggested starting height; the user is free to change it. */
  defaultHeightMm: number;
  /** Hard ceiling the quality checker enforces. */
  maxHeightMm: number;
  /** Theme applied alongside this page size. */
  themeId: string;
}

export const PAGE_PRESETS: readonly PagePreset[] = [
  {
    id: 'nature-single',
    journal: 'Nature',
    label: 'Nature — single column',
    widthMm: 89,
    defaultHeightMm: 80,
    maxHeightMm: 247,
    themeId: 'nature',
  },
  {
    id: 'nature-1.5',
    journal: 'Nature',
    label: 'Nature — 1.5 column',
    widthMm: 136,
    defaultHeightMm: 100,
    maxHeightMm: 247,
    themeId: 'nature',
  },
  {
    id: 'nature-double',
    journal: 'Nature',
    label: 'Nature — double column',
    widthMm: 183,
    defaultHeightMm: 120,
    maxHeightMm: 247,
    themeId: 'nature',
  },
  {
    id: 'cell-single',
    journal: 'Cell',
    label: 'Cell — single column',
    widthMm: 85,
    defaultHeightMm: 80,
    maxHeightMm: 225,
    themeId: 'cell',
  },
  {
    id: 'cell-double',
    journal: 'Cell',
    label: 'Cell — double column',
    widthMm: 174,
    defaultHeightMm: 120,
    maxHeightMm: 225,
    themeId: 'cell',
  },
  {
    id: 'science-single',
    journal: 'Science',
    label: 'Science — single column',
    widthMm: 55,
    defaultHeightMm: 55,
    maxHeightMm: 230,
    themeId: 'science',
  },
  {
    id: 'science-double',
    journal: 'Science',
    label: 'Science — double column',
    widthMm: 121,
    defaultHeightMm: 100,
    maxHeightMm: 230,
    themeId: 'science',
  },
  {
    id: 'science-triple',
    journal: 'Science',
    label: 'Science — triple column',
    widthMm: 183,
    defaultHeightMm: 120,
    maxHeightMm: 230,
    themeId: 'science',
  },
];

export const findPreset = (id: string): PagePreset | undefined =>
  PAGE_PRESETS.find((p) => p.id === id);

export function presetsByJournal(): Map<string, PagePreset[]> {
  const grouped = new Map<string, PagePreset[]>();
  for (const preset of PAGE_PRESETS) {
    const bucket = grouped.get(preset.journal);
    if (bucket) bucket.push(preset);
    else grouped.set(preset.journal, [preset]);
  }
  return grouped;
}
