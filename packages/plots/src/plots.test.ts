import { describe, expect, it } from 'vitest';
import {
  beeswarmOffsets,
  binCountFor,
  categoricalMarks,
  errorInterval,
  formatTick,
  histogramBins,
  histogramMarks,
  kernelDensity,
  makeBandScale,
  makeScale,
  mulberry32,
  resolveDomain,
  silvermanBandwidth,
  summarize,
  tCritical95,
  tickCountForLength,
  xyMarks,
  type MarkOptions,
  type XyMarkOptions,
} from './index.js';

describe('summary statistics', () => {
  const values = [2, 4, 4, 4, 5, 5, 7, 9];

  it('computes the sample standard deviation with the n-1 denominator', () => {
    const s = summarize(values);
    expect(s.mean).toBeCloseTo(5, 10);
    // Population SD here is 2; the sample SD is 2 * sqrt(8/7).
    expect(s.sd).toBeCloseTo(2 * Math.sqrt(8 / 7), 10);
    expect(s.sem).toBeCloseTo(s.sd / Math.sqrt(8), 10);
  });

  it('identifies Tukey whiskers and outliers', () => {
    const s = summarize([1, 2, 3, 4, 5, 100]);
    expect(s.outliers).toContain(100);
    expect(s.upperWhisker).toBe(5);
  });

  it('survives an empty or single-value series', () => {
    expect(summarize([]).n).toBe(0);
    const single = summarize([42]);
    expect(single.mean).toBe(42);
    expect(single.sd).toBe(0);
    expect(single.sem).toBe(0);
  });

  it('ignores non-finite values rather than propagating NaN', () => {
    const s = summarize([1, 2, Number.NaN, 3, Number.POSITIVE_INFINITY]);
    expect(s.n).toBe(3);
    expect(s.mean).toBeCloseTo(2, 10);
  });
});

describe('t critical values', () => {
  it('matches the published two-sided 95% table', () => {
    // Using 1.96 at these sample sizes would understate the interval badly:
    // at n = 3 the correct multiplier is 4.303, not 1.96.
    expect(tCritical95(1)).toBeCloseTo(12.706, 3);
    expect(tCritical95(2)).toBeCloseTo(4.303, 3);
    expect(tCritical95(9)).toBeCloseTo(2.262, 3);
    expect(tCritical95(29)).toBeCloseTo(2.045, 3);
  });

  it('converges on the normal quantile for large samples', () => {
    expect(tCritical95(5000)).toBeCloseTo(1.96, 3);
  });
});

describe('error intervals', () => {
  const summary = summarize([10, 12, 14]);

  it('distinguishes SD from SEM', () => {
    const sd = errorInterval(summary, 'mean', 'sd');
    const sem = errorInterval(summary, 'mean', 'sem');
    // SEM is always the tighter of the two; conflating them overstates precision.
    expect(sem.high - sem.low).toBeLessThan(sd.high - sd.low);
    expect(sd.label).toBe('mean ± s.d.');
    expect(sem.label).toBe('mean ± s.e.m.');
  });

  it('widens a 95% CI beyond the SEM at small n', () => {
    const sem = errorInterval(summary, 'mean', 'sem');
    const ci = errorInterval(summary, 'mean', 'ci95');
    expect(ci.high - ci.low).toBeGreaterThan(sem.high - sem.low);
  });

  it('collapses to a point when error bars are off', () => {
    const none = errorInterval(summary, 'mean', 'none');
    expect(none.low).toBe(none.high);
  });
});

describe('domains', () => {
  it('includes zero for bar charts', () => {
    // A bar encodes magnitude by length, so a truncated baseline misleads.
    const domain = resolveDomain([50, 60, 70], {
      min: null, max: null, includeZero: true, padFraction: 0.08, kind: 'linear',
    });
    expect(domain.min).toBe(0);
  });

  it('omits zero when it is not required', () => {
    const domain = resolveDomain([50, 60, 70], {
      min: null, max: null, includeZero: false, padFraction: 0.08, kind: 'linear',
    });
    expect(domain.min).toBeGreaterThan(0);
  });

  it('honours explicit bounds over derived ones', () => {
    const domain = resolveDomain([50, 60], {
      min: 10, max: 100, includeZero: true, padFraction: 0.08, kind: 'linear',
    });
    expect(domain).toEqual({ min: 10, max: 100 });
  });

  it('keeps a log domain strictly positive', () => {
    const domain = resolveDomain([0, 1, 100], {
      min: null, max: null, includeZero: true, padFraction: 0, kind: 'log10',
    });
    expect(domain.min).toBeGreaterThan(0);
  });

  it('gives a flat series a drawable range', () => {
    const domain = resolveDomain([5, 5, 5], {
      min: null, max: null, includeZero: false, padFraction: 0, kind: 'linear',
    });
    expect(domain.max).toBeGreaterThan(domain.min);
  });
});

describe('scales', () => {
  it('inverts the y range so data grows upward', () => {
    const scale = makeScale({
      domain: { min: 0, max: 100 },
      rangeMm: [60, 0],
      tickStep: null,
      kind: 'linear',
    });
    expect(scale.scale(0)).toBeCloseTo(60, 6);
    expect(scale.scale(100)).toBeCloseTo(0, 6);
    expect(scale.invert(30)).toBeCloseTo(50, 6);
  });

  it('scales tick density to the physical axis length', () => {
    // Eight labels at 6 pt on a 20 mm axis would be unreadable in print.
    expect(tickCountForLength(20)).toBeLessThan(tickCountForLength(120));
    expect(tickCountForLength(5)).toBeGreaterThanOrEqual(2);
  });

  it('honours an explicit tick step', () => {
    const scale = makeScale({
      domain: { min: 0, max: 100 },
      rangeMm: [60, 0],
      tickStep: 25,
      kind: 'linear',
    });
    expect(scale.ticks).toEqual([0, 25, 50, 75, 100]);
  });

  it('formats ticks without floating-point noise', () => {
    expect(formatTick(0.3, 0.1)).toBe('0.3');
    expect(formatTick(0, 1)).toBe('0');
    expect(formatTick(1000, 100)).toBe('1000');
  });

  it('cuts a range out of a broken axis and keeps the rest monotonic', () => {
    const scale = makeScale({
      domain: { min: 0, max: 100 },
      rangeMm: [60, 0],
      tickStep: null,
      kind: 'linear',
      breaks: [{ from: 20, to: 80 }],
    });

    // 40 units of data over 58 mm of axis, the other 2 mm being the gap.
    expect(scale.scale(0)).toBeCloseTo(60, 6);
    expect(scale.scale(100)).toBeCloseTo(0, 6);
    expect(scale.scale(10)).toBeGreaterThan(scale.scale(20));
    expect(scale.scale(20)).toBeGreaterThan(scale.scale(80));
    expect(scale.scale(80)).toBeGreaterThan(scale.scale(90));

    // Equal spans on either side of the break get equal millimetres, because a
    // break removes a range rather than compressing it.
    expect(scale.scale(0) - scale.scale(20)).toBeCloseTo(scale.scale(80) - scale.scale(100), 6);
    expect(scale.breaks).toHaveLength(1);
  });

  it('maps a value inside a break to NaN rather than to the edge of the gap', () => {
    // Clamping would draw a mark at a value the axis explicitly does not show,
    // which a reader takes as data.
    const scale = makeScale({
      domain: { min: 0, max: 100 },
      rangeMm: [60, 0],
      tickStep: null,
      kind: 'linear',
      breaks: [{ from: 20, to: 80 }],
    });
    expect(Number.isNaN(scale.scale(50))).toBe(true);
    expect(scale.ticks.every((t) => t <= 20 + 1e-9 || t >= 80 - 1e-9)).toBe(true);
  });

  it('merges overlapping breaks and ignores ones outside the domain', () => {
    const scale = makeScale({
      domain: { min: 0, max: 100 },
      rangeMm: [60, 0],
      tickStep: null,
      kind: 'linear',
      // Two overlapping ranges would each reserve a gap and each subtract their
      // span, so the axis would lose the shared region twice.
      breaks: [
        { from: 20, to: 50 },
        { from: 40, to: 80 },
        { from: 200, to: 300 },
      ],
    });
    expect(scale.breaks).toHaveLength(1);
    expect(scale.scale(0)).toBeCloseTo(60, 6);
    expect(scale.scale(100)).toBeCloseTo(0, 6);
  });

  it('ignores breaks on a log axis', () => {
    const scale = makeScale({
      domain: { min: 1, max: 1000 },
      rangeMm: [60, 0],
      tickStep: null,
      kind: 'log10',
      breaks: [{ from: 10, to: 100 }],
    });
    expect(scale.breaks).toBeUndefined();
    expect(Number.isFinite(scale.scale(50))).toBe(true);
  });

  it('spaces band categories evenly', () => {
    const band = makeBandScale(['A', 'B', 'C'], [0, 90]);
    const centres = ['A', 'B', 'C'].map((n) => band.center(n));
    expect(centres[1]! - centres[0]!).toBeCloseTo(centres[2]! - centres[1]!, 6);
    expect(band.bandwidth).toBeGreaterThan(0);
  });
});

describe('kernel density', () => {
  const values = [1, 2, 3, 4, 5];
  const summary = summarize(values);

  it('matches Silverman\'s rule of thumb', () => {
    // 0.9 * min(sd, IQR/1.349) * n^(-1/5). Here sd = sqrt(2.5) ≈ 1.5811 and
    // IQR/1.349 = 2/1.349 ≈ 1.4826, so the robust estimate is the smaller one —
    // which is the point of taking the minimum: one wild value cannot widen it.
    expect(silvermanBandwidth(summary)).toBeCloseTo(
      0.9 * (2 / 1.349) * Math.pow(5, -1 / 5),
      10,
    );
  });

  it('trims the profile to the observed range', () => {
    // Drawn past the extremes, a violin tapers into values that were never
    // measured and a reader takes the taper for data.
    const density = kernelDensity(values, summary, 16);
    expect(density).toHaveLength(17);
    expect(density[0]!.value).toBeCloseTo(summary.min, 10);
    expect(density[density.length - 1]!.value).toBeCloseTo(summary.max, 10);
  });

  it('peaks in the middle of a symmetric sample', () => {
    const density = kernelDensity(values, summary, 16);
    const middle = density[8]!.density;
    expect(middle).toBeGreaterThan(density[0]!.density);
    expect(middle).toBeGreaterThan(density[density.length - 1]!.density);
    // Symmetric data, symmetric estimate.
    expect(density[0]!.density).toBeCloseTo(density[density.length - 1]!.density, 10);
  });

  it('returns nothing rather than a spike for a degenerate spread', () => {
    // Every value identical: there is no density to estimate, and drawing a
    // zero-width violin would imply one.
    expect(kernelDensity([7, 7, 7], summarize([7, 7, 7]))).toEqual([]);
    expect(kernelDensity([7], summarize([7]))).toEqual([]);
  });
});

describe('mark geometry', () => {
  // Chosen so the R-7 quartiles land exactly on data points: q1 = 2, median = 3,
  // q3 = 4, and the Tukey fences at -1 and 7 leave every value inside.
  const values = [1, 2, 3, 4, 5];

  /** scale(v) = 50 − 5v, so a value of 2 sits at 40 mm. */
  const y = makeScale({ domain: { min: 0, max: 10 }, rangeMm: [50, 0], tickStep: null, kind: 'linear' });
  const band = makeBandScale(['A'], [0, 60]);

  const options = (overrides: Partial<MarkOptions> = {}): MarkOptions => ({
    band,
    y,
    center: 'mean',
    errorBars: 'sem',
    barWidthFraction: 0.8,
    showBar: false,
    showBox: false,
    showViolin: false,
    showPoints: false,
    pointSizeMm: 1,
    jitterMm: 0.8,
    pointLayout: 'jitter',
    colors: ['#000000'],
    seed: 1,
    ...overrides,
  });

  it('places box hinges and whiskers on the scaled quartiles', () => {
    const [mark] = categoricalMarks([{ name: 'A', values }], options({ showBox: true }));
    const box = mark!.box!;
    expect(box.q1Mm).toBeCloseTo(40, 6);
    expect(box.q3Mm).toBeCloseTo(30, 6);
    expect(box.medianMm).toBeCloseTo(35, 6);
    expect(box.lowerWhiskerMm).toBeCloseTo(45, 6);
    expect(box.upperWhiskerMm).toBeCloseTo(25, 6);
    // y is inverted, so q3 is the top edge and the IQR is the height.
    expect(Math.abs(box.q1Mm - box.q3Mm)).toBeCloseTo(10, 6);
  });

  it('clears a bracket above the whisker, not the hinge', () => {
    const [mark] = categoricalMarks([{ name: 'A', values }], options({ showBox: true }));
    // The upper whisker at 5 → 25 mm, above both q3 (30) and the mean (35).
    expect(mark!.topMm).toBeCloseTo(25, 6);
  });

  it('lifts topMm clear of an outlier drawn beyond the whisker', () => {
    const withOutlier = [1, 2, 3, 4, 5, 9];
    const [mark] = categoricalMarks(
      [{ name: 'A', values: withOutlier }],
      options({ showBox: true }),
    );
    expect(mark!.outliers.map((o) => o.value)).toEqual([9]);
    // 9 → 5 mm, minus half the point size. A bracket placed off the whisker
    // instead would be drawn straight through the outlier.
    expect(mark!.topMm).toBeCloseTo(4.5, 6);
  });

  it('draws error bars in both directions unless asked otherwise', () => {
    // The default has to be symmetric: the interval is symmetric, and drawing
    // half of it states half of what was measured.
    const [both] = categoricalMarks([{ name: 'A', values }], options({ showBar: true }));
    expect(both!.errorBar!.upperOnly).toBe(false);
    expect(both!.errorBar!.bottomMm).toBeGreaterThan(both!.errorBar!.topMm);

    const [up] = categoricalMarks(
      [{ name: 'A', values }],
      options({ showBar: true, errorBarDirection: 'up' }),
    );
    expect(up!.errorBar!.upperOnly).toBe(true);
  });

  it('keeps both directions on a dot plot even when "up" is asked for', () => {
    // With no bar there is nothing for the lower half to hide behind, so the
    // convention does not apply and half a whisker would just be missing data.
    const [mark] = categoricalMarks(
      [{ name: 'A', values }],
      options({ showBar: false, errorBarDirection: 'up' }),
    );
    expect(mark!.errorBar!.upperOnly).toBe(false);
  });

  it('drops points that fall inside an axis break', () => {
    const broken = makeScale({
      domain: { min: 0, max: 10 },
      rangeMm: [50, 0],
      tickStep: null,
      kind: 'linear',
      breaks: [{ from: 2.5, to: 4.5 }],
    });
    const [mark] = categoricalMarks(
      [{ name: 'A', values }],
      options({ y: broken, showPoints: true, showBar: true }),
    );
    // 3 and 4 are inside the break; 1, 2 and 5 survive.
    expect(mark!.points.map((p) => p.value).sort((a, b) => a - b)).toEqual([1, 2, 5]);
    expect(mark!.points.every((p) => Number.isFinite(p.y))).toBe(true);
    expect(Number.isFinite(mark!.bar!.baselineMm)).toBe(true);
  });

  it('suppresses the error bar when the distribution is already drawn', () => {
    // An SEM bar through a box states the precision of a centre the reader
    // cannot see; both types drop it even though errorBars is set to 'sem'.
    for (const kind of ['showBox', 'showViolin'] as const) {
      const [mark] = categoricalMarks([{ name: 'A', values }], options({ [kind]: true }));
      expect(mark!.errorBar).toBeNull();
    }
  });

  it('drops the separate outlier marks when every point is overlaid', () => {
    const withOutlier = [1, 2, 3, 4, 5, 9];
    const [mark] = categoricalMarks(
      [{ name: 'A', values: withOutlier }],
      options({ showBox: true, showPoints: true }),
    );
    // Otherwise the outlier is drawn twice, once as a point and once as a ring.
    expect(mark!.outliers).toEqual([]);
    expect(mark!.points).toHaveLength(6);
  });

  it('scales the violin so its widest point fills the band', () => {
    const [mark] = categoricalMarks([{ name: 'A', values }], options({ showViolin: true }));
    const violin = mark!.violin!;
    const widest = Math.max(...violin.profile.map((p) => p.halfWidthMm));
    expect(widest).toBeCloseTo((band.bandwidth * 0.8) / 2, 6);
    expect(violin.centerX).toBeCloseTo(band.center('A'), 6);
  });

  it('leaves box and violin null for the categorical types', () => {
    const [mark] = categoricalMarks([{ name: 'A', values }], options({ showBar: true }));
    expect(mark!.box).toBeNull();
    expect(mark!.violin).toBeNull();
    expect(mark!.outliers).toEqual([]);
  });
});

describe('continuous marks', () => {
  /** scale(v) = 5v horizontally, scale(v) = 50 − 5v vertically. */
  const x = makeScale({ domain: { min: 0, max: 20 }, rangeMm: [0, 100], tickStep: null, kind: 'linear' });
  const y = makeScale({ domain: { min: 0, max: 10 }, rangeMm: [50, 0], tickStep: null, kind: 'linear' });

  const xyOptions = (overrides: Partial<XyMarkOptions> = {}): XyMarkOptions => ({
    x,
    y,
    showLine: false,
    showPoints: true,
    pointSizeMm: 1,
    colors: ['#000000'],
    ...overrides,
  });

  it('places a point at its own paired x, not its index', () => {
    const [mark] = xyMarks([{ name: 'A', values: [2, 4], x: [10, 20] }], xyOptions());
    expect(mark!.points.map((p) => [p.x, p.y])).toEqual([
      [50, 40],
      [100, 30],
    ]);
  });

  it('orders the line by x rather than by row', () => {
    // Drawn in row order these three points make a zig-zag; the data is
    // monotonic and the line has to say so.
    const [mark] = xyMarks(
      [{ name: 'A', values: [2, 6, 4], x: [10, 30, 20] }],
      xyOptions({ showLine: true }),
    );
    expect(mark!.linePath!.map((p) => p.x)).toEqual([50, 100, 150]);
  });

  it('drops a pair when either coordinate is missing', () => {
    // Dropping the pair keeps x and y aligned. Dropping one side would shift
    // every later point onto the wrong x.
    const [mark] = xyMarks(
      [{ name: 'A', values: [2, Number.NaN, 4], x: [10, 15, 20] }],
      xyOptions(),
    );
    expect(mark!.n).toBe(2);
    expect(mark!.points.map((p) => p.x)).toEqual([50, 100]);
  });

  it('yields nothing when the series carries no x at all', () => {
    const [mark] = xyMarks([{ name: 'A', values: [2, 4] }], xyOptions());
    expect(mark!.n).toBe(0);
    expect(mark!.points).toEqual([]);
  });
});

describe('histogram bins', () => {
  it('keeps the maximum value inside the last bin', () => {
    // With half-open bins the maximum falls outside every one of them and
    // vanishes from its own histogram.
    const bins = histogramBins([0, 1, 2, 3, 4], 4);
    expect(bins.map((b) => b.count)).toEqual([1, 1, 1, 2]);
    expect(bins.reduce((sum, b) => sum + b.count, 0)).toBe(5);
  });

  it('spans exactly the observed range', () => {
    const bins = histogramBins([2, 4, 6, 8, 10], 4);
    expect(bins[0]!.x0).toBeCloseTo(2, 10);
    expect(bins[bins.length - 1]!.x1).toBeCloseTo(10, 10);
  });

  it('prefers the IQR to the range when choosing a bin count', () => {
    // One extreme value must not collapse the histogram into a single bar,
    // which is what a range-based rule (Sturges) does here.
    const skewed = [1, 2, 2, 3, 3, 3, 4, 4, 5, 1000];
    expect(binCountFor(skewed)).toBeGreaterThan(1);
    // Never more bins than observations — that says nothing about the shape.
    expect(binCountFor(skewed)).toBeLessThanOrEqual(skewed.length);
  });

  it('falls back to Sturges when every value is identical in the middle', () => {
    // IQR of zero leaves Freedman–Diaconis with no width to offer.
    const flatMiddle = [0, 5, 5, 5, 5, 5, 5, 10];
    expect(binCountFor(flatMiddle)).toBe(Math.ceil(Math.log2(8)) + 1);
  });

  it('draws bars from the count baseline', () => {
    const yScale = makeScale({ domain: { min: 0, max: 4 }, rangeMm: [40, 0], tickStep: null, kind: 'linear' });
    const xScale = makeScale({ domain: { min: 0, max: 4 }, rangeMm: [0, 40], tickStep: null, kind: 'linear' });
    const bins = histogramMarks({
      x: xScale,
      y: yScale,
      bins: [{ x0: 0, x1: 2, count: 3 }, { x0: 2, x1: 4, count: 1 }],
      barWidthFraction: 1,
    });
    // count 3 of a 0–4 domain on a 40 mm axis: top at 10 mm, height 30 mm.
    expect(bins[0]!.y).toBeCloseTo(10, 6);
    expect(bins[0]!.height).toBeCloseTo(30, 6);
    expect(bins[0]!.width).toBeCloseTo(20, 6);
    expect(bins[1]!.height).toBeCloseTo(10, 6);
  });
});

describe('point layout', () => {
  it('produces identical jitter for a given seed', () => {
    // Jitter must not move between the screen and the exported PDF.
    const a = Array.from({ length: 5 }, mulberry32(42));
    const b = Array.from({ length: 5 }, mulberry32(42));
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(5);
  });

  it('separates overlapping points in a beeswarm', () => {
    const offsets = beeswarmOffsets([10, 10, 10, 10], 1);
    expect(new Set(offsets).size).toBeGreaterThan(1);
  });

  it('leaves well-separated points on the centre line', () => {
    expect(beeswarmOffsets([0, 50, 100], 1)).toEqual([0, 0, 0]);
  });
});
