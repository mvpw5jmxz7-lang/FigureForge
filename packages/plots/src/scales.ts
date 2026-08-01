/**
 * Scales and tick generation.
 *
 * d3-scale does the numeric mapping; this module adds the publication-specific
 * behaviour on top — axis padding rules, bar baselines that must include zero,
 * and tick counts chosen for the physical size of the axis rather than a fixed
 * number.
 */

import { scaleBand, scaleLinear, scaleLog } from 'd3-scale';
import { extent } from 'd3-array';

export type AxisScaleKind = 'linear' | 'log10';

export interface ScaleDomain {
  min: number;
  max: number;
}

export interface NumericScale {
  kind: AxisScaleKind;
  domain: ScaleDomain;
  /** Millimetre range, [start, end]. For y this is inverted (bottom → top). */
  range: [number, number];
  /** Domain value → millimetres. */
  scale: (value: number) => number;
  /** Millimetres → domain value, for hit-testing and drag-to-edit. */
  invert: (mm: number) => number;
  ticks: number[];
  format: (value: number) => string;
}

export interface DomainOptions {
  /** Explicit bound, or null to derive from the data. */
  min: number | null;
  max: number | null;
  /** Force zero into the domain — mandatory for bars, whose length encodes value. */
  includeZero: boolean;
  /** Fractional headroom added to a derived domain. */
  padFraction: number;
  kind: AxisScaleKind;
}

export function resolveDomain(values: readonly number[], options: DomainOptions): ScaleDomain {
  const finite = values.filter((v) => Number.isFinite(v));
  const positiveOnly = options.kind === 'log10' ? finite.filter((v) => v > 0) : finite;

  const [dataMin, dataMax] = extent(positiveOnly.length > 0 ? positiveOnly : [0, 1]) as [
    number,
    number,
  ];

  let lo = options.min ?? dataMin;
  let hi = options.max ?? dataMax;

  if (options.kind === 'log10') {
    // A log axis cannot contain zero; clamp to a decade below the smallest datum.
    if (lo <= 0) lo = dataMin > 0 ? dataMin / 10 : 0.1;
    if (hi <= lo) hi = lo * 10;
    return { min: lo, max: hi };
  }

  if (options.includeZero) {
    if (options.min === null) lo = Math.min(0, lo);
    if (options.max === null) hi = Math.max(0, hi);
  }

  if (lo === hi) {
    // A flat series still needs a drawable axis.
    const magnitude = Math.abs(lo) || 1;
    lo -= magnitude * 0.1;
    hi += magnitude * 0.1;
  }

  const pad = (hi - lo) * options.padFraction;
  if (options.min === null && !(options.includeZero && lo === 0)) lo -= pad;
  if (options.max === null) hi += pad;

  return { min: lo, max: hi };
}

/**
 * Tick count from the physical length of the axis. A 30 mm axis carrying eight
 * labels at 6 pt is unreadable; roughly one tick per 12 mm stays legible.
 */
export function tickCountForLength(lengthMm: number): number {
  return Math.max(2, Math.min(10, Math.round(lengthMm / 12)));
}

/** Significant-figure formatting that avoids 0.30000000000000004 in labels. */
export function formatTick(value: number, step: number): string {
  if (!Number.isFinite(value)) return '';
  if (value === 0) return '0';

  const magnitude = Math.abs(value);
  if (magnitude >= 1e5 || (magnitude < 1e-3 && magnitude > 0)) {
    return value.toExponential(1).replace('e+', '×10^').replace('e-', '×10^−');
  }

  const decimals = Math.max(0, -Math.floor(Math.log10(Math.abs(step || 1))));
  return value.toFixed(Math.min(decimals, 6));
}

export interface LinearScaleOptions {
  domain: ScaleDomain;
  rangeMm: [number, number];
  tickStep: number | null;
  kind: AxisScaleKind;
}

export function makeScale(options: LinearScaleOptions): NumericScale {
  const { domain, rangeMm, kind } = options;
  const lengthMm = Math.abs(rangeMm[1] - rangeMm[0]);

  if (kind === 'log10') {
    const d3s = scaleLog().domain([domain.min, domain.max]).range(rangeMm);
    const rawTicks = d3s.ticks(tickCountForLength(lengthMm));
    // Log ticks cluster; on a short axis keep only the decade boundaries.
    const decadesOnly = rawTicks.filter((t) => Number.isInteger(Math.log10(t)));
    const ticks = decadesOnly.length >= 2 ? decadesOnly : rawTicks;
    return {
      kind,
      domain,
      range: rangeMm,
      scale: (v) => d3s(v),
      invert: (mm) => d3s.invert(mm),
      ticks,
      format: (v) => formatTick(v, v),
    };
  }

  const d3s = scaleLinear().domain([domain.min, domain.max]).range(rangeMm);

  let ticks: number[];
  if (options.tickStep && options.tickStep > 0) {
    ticks = [];
    const start = Math.ceil(domain.min / options.tickStep) * options.tickStep;
    for (let v = start; v <= domain.max + 1e-9; v += options.tickStep) ticks.push(v);
  } else {
    ticks = d3s.ticks(tickCountForLength(lengthMm));
  }

  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 1;

  return {
    kind,
    domain,
    range: rangeMm,
    scale: (v) => d3s(v),
    invert: (mm) => d3s.invert(mm),
    ticks,
    format: (v) => formatTick(v, step),
  };
}

export interface BandScale {
  domain: string[];
  range: [number, number];
  /** Category → centre position in millimetres. */
  center: (name: string) => number;
  /** Full slot width including padding. */
  step: number;
  /** Drawable width within a slot. */
  bandwidth: number;
}

export function makeBandScale(
  categories: readonly string[],
  rangeMm: [number, number],
  paddingInner = 0.35,
  paddingOuter = 0.25,
): BandScale {
  const d3s = scaleBand<string>()
    .domain([...categories])
    .range(rangeMm)
    .paddingInner(paddingInner)
    .paddingOuter(paddingOuter);

  return {
    domain: [...categories],
    range: rangeMm,
    center: (name) => (d3s(name) ?? 0) + d3s.bandwidth() / 2,
    step: d3s.step(),
    bandwidth: d3s.bandwidth(),
  };
}
