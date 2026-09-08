/**
 * Evaluating a stored least-squares fit.
 *
 * The fixture is Anscombe's first dataset, whose fit R publishes in
 * `summary(lm(y1 ~ x1, anscombe))`: slope 0.5001, intercept 3.0001, residual
 * standard error 1.2366 on 9 degrees of freedom, and `qt(0.975, 9)` = 2.262157.
 * Its x column (10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5) has a mean of exactly 9
 * and squared deviations summing to exactly 110, so the two terms driving the
 * band's shape are integers rather than rounded constants.
 *
 * The half-widths below are worked out by hand from those published numbers,
 * not read back from this code — see each case.
 */

import { describe, expect, it } from 'vitest';
import type { RegressionFit } from '@figureforge/doc-model';
import { fitHalfWidthAt, fitIntervalAt, fitYAt } from './regression.js';

const ANSCOMBE: RegressionFit = {
  slope: 0.5001,
  intercept: 3.0001,
  n: 11,
  meanX: 9,
  sumSquaredDevX: 110,
  residualSe: 1.2366,
  tMultiplier: 2.262157,
  confidenceLevel: 0.95,
  xMin: 4,
  xMax: 14,
};

describe('the fitted line', () => {
  it('is the published intercept at x = 0', () => {
    expect(fitYAt(ANSCOMBE, 0)).toBeCloseTo(3.0001, 10);
  });

  it('rises by the slope per unit of x', () => {
    // R: predict(fit, data.frame(x1 = 9)) = 7.500909
    expect(fitYAt(ANSCOMBE, 9)).toBeCloseTo(7.5010, 4);
    expect(fitYAt(ANSCOMBE, 10) - fitYAt(ANSCOMBE, 9)).toBeCloseTo(0.5001, 10);
  });
});

describe('the confidence half-width', () => {
  it('collapses to t·s/√n at the mean of x', () => {
    // (x − meanX)² is zero there, so the whole term is
    // 2.262157 × 1.2366 × √(1/11) = 2.7973833 × 0.3015113 = 0.8434428.
    expect(fitHalfWidthAt(ANSCOMBE, 9, 'confidence')).toBeCloseTo(0.8434428, 7);
  });

  it('widens away from the mean by the leverage term', () => {
    // At x = 14: (14 − 9)²/110 = 0.2272727, plus 1/11 = 0.0909091, so
    // 2.7973833 × √0.3181818 = 2.7973833 × 0.5640761 = 1.5779370.
    expect(fitHalfWidthAt(ANSCOMBE, 14, 'confidence')).toBeCloseTo(1.5779370, 7);
  });

  it('is symmetric about the mean of x', () => {
    // The leverage term is squared, so equal distances either side match
    // exactly — the property that makes the band a hyperbola rather than a
    // wedge, and what would break if the deviation were ever taken unsquared.
    expect(fitHalfWidthAt(ANSCOMBE, 9 - 3.5, 'confidence')).toBeCloseTo(
      fitHalfWidthAt(ANSCOMBE, 9 + 3.5, 'confidence'),
      12,
    );
  });

  it('is narrowest at the mean of x and grows monotonically either side', () => {
    const at = (x: number): number => fitHalfWidthAt(ANSCOMBE, x, 'confidence');
    for (let step = 1; step <= 6; step += 1) {
      expect(at(9 + step)).toBeGreaterThan(at(9 + step - 1));
      expect(at(9 - step)).toBeGreaterThan(at(9 - step + 1));
    }
  });
});

describe('the prediction half-width', () => {
  it('adds one whole residual variance to the confidence term', () => {
    // √(1 + 1/11) = 1.0444659, so 2.7973833 × 1.0444659 = 2.9217716.
    expect(fitHalfWidthAt(ANSCOMBE, 9, 'prediction')).toBeCloseTo(2.9217716, 7);
  });

  it('is strictly wider than the confidence band everywhere', () => {
    // Not merely wider on average: a prediction interval covers a new
    // observation's own scatter as well as the line's position, so there is no
    // x at which the two can meet.
    for (let x = 0; x <= 20; x += 0.5) {
      expect(fitHalfWidthAt(ANSCOMBE, x, 'prediction')).toBeGreaterThan(
        fitHalfWidthAt(ANSCOMBE, x, 'confidence'),
      );
    }
  });

  it('does not narrow towards zero as n grows, unlike the confidence band', () => {
    const big: RegressionFit = { ...ANSCOMBE, n: 100000, sumSquaredDevX: 1e9 };
    expect(fitHalfWidthAt(big, 9, 'confidence')).toBeLessThan(0.01);
    // Still about t·s — the scatter of a single observation about the line.
    expect(fitHalfWidthAt(big, 9, 'prediction')).toBeCloseTo(2.7973833, 3);
  });
});

describe('fitIntervalAt', () => {
  it('centres the interval on the fitted value', () => {
    const { y, low, high } = fitIntervalAt(ANSCOMBE, 12, 'confidence');
    expect(y).toBeCloseTo(fitYAt(ANSCOMBE, 12), 12);
    expect(high - y).toBeCloseTo(y - low, 12);
    expect(high - y).toBeCloseTo(fitHalfWidthAt(ANSCOMBE, 12, 'confidence'), 12);
  });
});
