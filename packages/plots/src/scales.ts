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
  /**
   * Where the axis is cut, in millimetres, when it carries breaks.
   *
   * Present only on a broken scale, so `scale()` returning `NaN` and this being
   * non-empty always travel together — a caller that ignores it draws nothing
   * for a value in a gap, which is the safe failure.
   */
  breaks?: readonly { startMm: number; endMm: number }[];
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
  const formatted =
    magnitude >= 1e5 || (magnitude < 1e-3 && magnitude > 0)
      ? value.toExponential(1).replace('e+', '×10^').replace('e-', '×10^-')
      : value.toFixed(Math.min(Math.max(0, -Math.floor(Math.log10(Math.abs(step || 1)))), 6));

  // Journals set a negative sign as an en dash (–), not the ASCII
  // hyphen-minus `toFixed`/`toExponential` emit — replaced once, here, so
  // every caller (axis ticks, heatmap cell values, the colourbar) agrees
  // with text-width.ts's own '–' advance-width entry used to measure it. The
  // only characters either branch can produce are digits, '.', 'e' and '-',
  // so a blanket replace is exact, not a heuristic.
  return formatted.replace(/-/g, '–');
}

export interface AxisBreak {
  from: number;
  to: number;
}

/** Millimetres of blank axis left where a break was cut out. */
export const BREAK_GAP_MM = 2;

/**
 * Breaks reduced to a usable form: inside the domain, non-empty, sorted, and
 * with overlapping ranges merged.
 *
 * Two overlapping breaks would each reserve their own gap and each subtract
 * their own span, so the axis would lose the shared region twice and the
 * mapping would stop being monotonic.
 */
export function normaliseBreaks(
  breaks: readonly AxisBreak[] | undefined,
  domain: ScaleDomain,
): AxisBreak[] {
  if (!breaks || breaks.length === 0) return [];

  const clipped = breaks
    .map((b) => ({ from: Math.min(b.from, b.to), to: Math.max(b.from, b.to) }))
    .map((b) => ({ from: Math.max(b.from, domain.min), to: Math.min(b.to, domain.max) }))
    .filter((b) => Number.isFinite(b.from) && Number.isFinite(b.to) && b.to > b.from)
    // A break covering the whole domain would leave nothing to draw.
    .filter((b) => !(b.from <= domain.min && b.to >= domain.max))
    .sort((a, b) => a.from - b.from);

  const merged: AxisBreak[] = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.from <= last.to) last.to = Math.max(last.to, b.to);
    else merged.push({ ...b });
  }
  return merged;
}

/**
 * A linear scale with ranges cut out of it, drawn with the conventional break
 * marks.
 *
 * The kept segments share the range in proportion to the data they span, minus
 * a fixed gap per break — so a break compresses nothing, it removes. A value
 * inside a break maps to `NaN` rather than to the edge of the gap: clamping it
 * would draw a mark at a value the axis explicitly does not show, which a
 * reader takes as data.
 */
function makeBrokenScale(
  domain: ScaleDomain,
  rangeMm: [number, number],
  breaks: AxisBreak[],
  tickStep: number | null,
): NumericScale {
  const segments: { from: number; to: number }[] = [];
  let cursor = domain.min;
  for (const b of breaks) {
    if (b.from > cursor) segments.push({ from: cursor, to: b.from });
    cursor = Math.max(cursor, b.to);
  }
  if (cursor < domain.max) segments.push({ from: cursor, to: domain.max });

  const totalSpan = segments.reduce((sum, s) => sum + (s.to - s.from), 0);
  const totalMm = rangeMm[1] - rangeMm[0];
  const direction = Math.sign(totalMm) || 1;
  const usableMm = Math.abs(totalMm) - BREAK_GAP_MM * breaks.length;

  // Not enough room for the gaps: fall back to an unbroken scale rather than
  // producing a reversed or zero-length axis.
  if (totalSpan <= 0 || usableMm <= 0) {
    return makeScale({ domain, rangeMm, tickStep, kind: 'linear' });
  }

  const placed = segments.map((s, index) => {
    const startMm =
      rangeMm[0] +
      direction *
        (segments.slice(0, index).reduce((sum, p) => sum + ((p.to - p.from) / totalSpan) * usableMm, 0) +
          BREAK_GAP_MM * index);
    const lengthMm = ((s.to - s.from) / totalSpan) * usableMm;
    return { ...s, startMm, lengthMm };
  });

  const scale = (v: number): number => {
    for (const s of placed) {
      if (v >= s.from - 1e-9 && v <= s.to + 1e-9) {
        const fraction = s.to === s.from ? 0 : (v - s.from) / (s.to - s.from);
        return s.startMm + direction * fraction * s.lengthMm;
      }
    }
    return Number.NaN;
  };

  const invert = (mm: number): number => {
    for (const s of placed) {
      const a = s.startMm;
      const b = s.startMm + direction * s.lengthMm;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (mm >= lo - 1e-9 && mm <= hi + 1e-9) {
        const fraction = s.lengthMm === 0 ? 0 : Math.abs(mm - s.startMm) / s.lengthMm;
        return s.from + fraction * (s.to - s.from);
      }
    }
    return Number.NaN;
  };

  // Ticks per segment, so each side of a break is read against its own values
  // and no tick can land inside a gap.
  const ticks: number[] = [];
  for (const s of placed) {
    const sub = scaleLinear().domain([s.from, s.to]).range([0, Math.abs(s.lengthMm)]);
    const wanted = tickStep && tickStep > 0 ? null : tickCountForLength(Math.abs(s.lengthMm));
    if (wanted === null) {
      const start = Math.ceil(s.from / tickStep!) * tickStep!;
      for (let v = start; v <= s.to + 1e-9; v += tickStep!) ticks.push(v);
    } else {
      for (const t of sub.ticks(Math.max(2, wanted))) {
        if (t >= s.from - 1e-9 && t <= s.to + 1e-9) ticks.push(t);
      }
    }
  }
  ticks.sort((a, b) => a - b);
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 1;

  return {
    kind: 'linear',
    domain,
    range: rangeMm,
    scale,
    invert,
    ticks,
    format: (v) => formatTick(v, step),
    breaks: placed.slice(0, -1).map((s) => ({
      // Where the axis is cut, in millimetres: the end of one segment and the
      // start of the next, which is what the renderer draws the marks between.
      startMm: s.startMm + direction * s.lengthMm,
      endMm: s.startMm + direction * s.lengthMm + direction * BREAK_GAP_MM,
    })),
  };
}

export interface LinearScaleOptions {
  domain: ScaleDomain;
  rangeMm: [number, number];
  tickStep: number | null;
  kind: AxisScaleKind;
  /** Ranges to cut out. Ignored on a log axis — see `AxisSpec.breaks`. */
  breaks?: readonly AxisBreak[];
}

export function makeScale(options: LinearScaleOptions): NumericScale {
  const { domain, rangeMm, kind } = options;
  const lengthMm = Math.abs(rangeMm[1] - rangeMm[0]);

  if (kind === 'linear') {
    const breaks = normaliseBreaks(options.breaks, domain);
    if (breaks.length > 0) {
      return makeBrokenScale(domain, rangeMm, breaks, options.tickStep);
    }
  }

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

/**
 * Gap between one category slot and the next, as a fraction of the slot pitch.
 *
 * Exported because the Inspector displays it as the value a plot has when it
 * says nothing, and the renderer passes it when a plot says nothing. Two
 * spellings of one default is how a control comes to read 35% while the canvas
 * draws something else — the same reason `analysisInputHash` and
 * `scaleBarWidthMm` are each composed in exactly one place.
 */
export const DEFAULT_GROUP_GAP_FRACTION = 0.35;

/** Gap between the bars inside one category, on a two-factor plot. */
export const DEFAULT_BAR_GAP_FRACTION = 0.1;

export function makeBandScale(
  categories: readonly string[],
  rangeMm: [number, number],
  paddingInner = DEFAULT_GROUP_GAP_FRACTION,
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

/** One mark's place in a two-factor table: which band, and where inside it. */
export interface GroupedBandItem {
  /** Unique key the returned scale is addressed by. */
  name: string;
  /** Outer band — what the category axis labels. */
  category: string;
  /** Sub-band inside the outer one. */
  group: string;
}

export interface GroupedBandScale {
  /**
   * Addressed by the composite `name`, so it satisfies `BandScale` and every
   * existing reader — `categoricalMarks`, `measurePlot`, `bracketFrame` — works
   * against a two-factor plot without knowing there is a second factor.
   */
  band: BandScale;
  /** The outer band, for the axis labels and for anything spanning a category. */
  outer: BandScale;
}

/**
 * Bands within bands: one slot per category, subdivided per group.
 *
 * This is the shape Prism's Grouped, Nested and contingency tables all need,
 * and the reason the flat one-band-per-series model could not draw them — a
 * table of four variants × four groups has sixteen marks over four labels, and
 * a flat band gives sixteen labels.
 *
 * The inner band takes no outer padding: the gap between two categories is the
 * outer band's business, and padding the inner one too would leave the groups
 * of a category adrift in their slot rather than reading as one cluster.
 *
 * Both gaps are parameters because they are the two things an author adjusts on
 * a grouped bar chart. `groupGap` had been one since this function was written
 * and its only caller never passed it; `barGap` was a literal beside it.
 */
export function makeGroupedBandScale(
  items: readonly GroupedBandItem[],
  rangeMm: [number, number],
  groupGap = DEFAULT_GROUP_GAP_FRACTION,
  barGap = DEFAULT_BAR_GAP_FRACTION,
): GroupedBandScale {
  const categories = [...new Set(items.map((i) => i.category))];
  const groups = [...new Set(items.map((i) => i.group))];

  const outer = makeBandScale(categories, rangeMm, groupGap, 0.25);
  // Group slots inside one category, measured from that category's left edge.
  const inner = makeBandScale(groups, [0, outer.bandwidth], barGap, 0);

  const offsets = new Map<string, number>();
  for (const item of items) {
    offsets.set(item.name, outer.center(item.category) - outer.bandwidth / 2 + inner.center(item.group));
  }

  return {
    outer,
    band: {
      domain: items.map((i) => i.name),
      range: rangeMm,
      center: (name) => offsets.get(name) ?? 0,
      step: inner.step,
      bandwidth: inner.bandwidth,
    },
  };
}
