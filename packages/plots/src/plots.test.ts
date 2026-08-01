import { describe, expect, it } from 'vitest';
import {
  beeswarmOffsets,
  errorInterval,
  formatTick,
  makeBandScale,
  makeScale,
  mulberry32,
  resolveDomain,
  summarize,
  tCritical95,
  tickCountForLength,
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

  it('spaces band categories evenly', () => {
    const band = makeBandScale(['A', 'B', 'C'], [0, 90]);
    const centres = ['A', 'B', 'C'].map((n) => band.center(n));
    expect(centres[1]! - centres[0]!).toBeCloseTo(centres[2]! - centres[1]!, 6);
    expect(band.bandwidth).toBeGreaterThan(0);
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
