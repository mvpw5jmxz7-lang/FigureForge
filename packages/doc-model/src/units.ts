/**
 * Unit handling.
 *
 * Millimetres are the single internal unit for all geometry. The renderer emits
 * `width="183mm" viewBox="0 0 183 120"`, so one SVG user unit is exactly one
 * millimetre and no scaling arithmetic exists anywhere in the geometry path.
 *
 * Type sizes are the one exception: they are stored in points, because that is
 * what journals specify ("panel labels 8 pt bold"), and converted at render.
 */

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;
/** CSS reference pixel. */
export const PX_PER_INCH = 96;

export const MM_PER_PT = MM_PER_INCH / PT_PER_INCH; // 0.35277…
export const MM_PER_PX = MM_PER_INCH / PX_PER_INCH; // 0.26458…

export type DisplayUnit = 'mm' | 'cm' | 'in' | 'px';

export const ptToMm = (pt: number): number => pt * MM_PER_PT;
export const mmToPt = (mm: number): number => mm / MM_PER_PT;
export const inToMm = (inches: number): number => inches * MM_PER_INCH;
export const mmToIn = (mm: number): number => mm / MM_PER_INCH;

/** Pixel count needed to raster `mm` at a given output resolution. */
export const mmToPxAtDpi = (mm: number, dpi: number): number => (mm / MM_PER_INCH) * dpi;

/** Effective resolution of a bitmap drawn at a given physical width. */
export const effectiveDpi = (pixelWidth: number, renderedWidthMm: number): number =>
  renderedWidthMm <= 0 ? 0 : pixelWidth / (renderedWidthMm / MM_PER_INCH);

const FROM_MM: Record<DisplayUnit, number> = {
  mm: 1,
  cm: 0.1,
  in: 1 / MM_PER_INCH,
  px: 1 / MM_PER_PX,
};

export const fromMm = (mm: number, unit: DisplayUnit): number => mm * FROM_MM[unit];
export const toMm = (value: number, unit: DisplayUnit): number => value / FROM_MM[unit];

/** Decimal places worth showing per unit, for the live dimension readout. */
const PRECISION: Record<DisplayUnit, number> = { mm: 1, cm: 2, in: 3, px: 0 };

export function formatMm(mm: number, unit: DisplayUnit): string {
  return `${fromMm(mm, unit).toFixed(PRECISION[unit])} ${unit}`;
}

/** Round to a sane sub-micron grid; keeps float drift out of saved documents. */
export const roundMm = (mm: number): number => Math.round(mm * 1e4) / 1e4;
