/**
 * The Kaplan–Meier estimator: pure numbers, no colour and no rendering.
 * `packages/render` turns this into step-shaped `XySeriesMarks`, the same
 * "plots computes numbers, render draws them" split volcano's classification
 * and heatmap's colour-domain math already follow.
 */

/** The 95% two-sided normal critical value, `qnorm(0.975)`. */
const Z_95 = 1.959963984540054;

/**
 * One row of the Kaplan–Meier step function, at one distinct observed time.
 *
 * `survival`/`lower`/`upper` hold from this `time` up to (not including) the
 * next row's `time` — that is what makes a step function out of an ordered
 * list of these without any further interpolation.
 */
export interface SurvivalStep {
  time: number;
  survival: number;
  /** Greenwood log-transform 95% CI, matching R's `survfit` default (`conf.type = "log"`). */
  lower: number;
  upper: number;
  /** Subjects still under observation immediately before this time. */
  atRisk: number;
  /** Events at exactly this time. */
  events: number;
  /** Censorings at exactly this time. */
  censored: number;
  /** `true` when nothing but censoring happened at this time — the curve's height is unchanged, only its risk set shrank. */
  censoringOnly: boolean;
}

/**
 * The product-limit (Kaplan–Meier) estimator, with a Greenwood confidence
 * band.
 *
 * `times`/`events` are index-aligned and unordered — subject order carries no
 * meaning here, unlike `ttest-paired`'s row-index-as-subject-id convention.
 * Ties are grouped: every subject sharing a time is one row, with events
 * counted before censoring leaves the risk set, the standard convention (and
 * what R's `survfit` does).
 *
 * Always starts with a synthetic `{time: 0, survival: 1, ...}` anchor, even
 * when the earliest real observation is itself at time 0 — the curve begins
 * at (0, 1) by definition, and a caller drawing a step function needs that
 * anchor to hold the first segment from.
 *
 * The confidence interval follows R's default log transform
 * (`S(t)·exp(∓z·√Σ)`, Σ = Greenwood's `Σ dᵢ/(nᵢ(nᵢ−dᵢ))`) rather than the
 * plain linear form, which can run outside `[0, 1]` — this codebase's other
 * confidence intervals are already held to matching a specific, correct
 * convention (the t-distribution CI in `services/api`), not the simplest one
 * available. Fixed at 95%: no caller needs another level yet, and a plain
 * number keeps this function's signature simple until one does.
 */
export function kaplanMeier(
  times: readonly number[],
  events: readonly boolean[],
): SurvivalStep[] {
  const n = Math.min(times.length, events.length);
  if (n === 0) return [];

  const byTime = new Map<number, { events: number; censored: number }>();
  for (let i = 0; i < n; i++) {
    const t = times[i]!;
    const bucket = byTime.get(t) ?? { events: 0, censored: 0 };
    if (events[i]) bucket.events += 1;
    else bucket.censored += 1;
    byTime.set(t, bucket);
  }
  const distinctTimes = [...byTime.keys()].sort((a, b) => a - b);

  const steps: SurvivalStep[] = [
    { time: 0, survival: 1, lower: 1, upper: 1, atRisk: n, events: 0, censored: 0, censoringOnly: false },
  ];

  let atRisk = n;
  let survival = 1;
  let greenwoodSum = 0;

  for (const t of distinctTimes) {
    const { events: d, censored: c } = byTime.get(t)!;

    if (d > 0) {
      survival *= 1 - d / atRisk;
      // Skip the term when the risk set is exactly exhausted by this time's
      // events (n_i - d_i = 0): its contribution is formally infinite, and
      // the curve has hit zero regardless, where the CI collapses to [0, 0].
      if (atRisk - d > 0) greenwoodSum += d / (atRisk * (atRisk - d));
    }

    const seLog = Math.sqrt(greenwoodSum);
    const lower = survival <= 0 ? 0 : Math.max(0, survival * Math.exp(-Z_95 * seLog));
    const upper = survival <= 0 ? 0 : Math.min(1, survival * Math.exp(Z_95 * seLog));

    steps.push({
      time: t,
      survival,
      lower,
      upper,
      atRisk,
      events: d,
      censored: c,
      censoringOnly: d === 0,
    });

    atRisk -= d + c;
  }

  return steps;
}
