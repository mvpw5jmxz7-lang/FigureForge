/**
 * Pinned statistics for the built-in sample figure.
 *
 * `sampleDocument()` is a synchronous, DOM-free build with no API call — the
 * same restriction `createSampleDocument` was written under — so the results
 * of the tests it showcases ship as data: computed once against the live
 * `/analyze` endpoint and stored exactly as a real Stats-tab run would leave
 * them on the document, rather than re-fetched at open time.
 *
 * Regenerate with `scripts/build-sample-stats.ts` (see that file's header).
 * The `inputHash` each analysis carries is **not** pinned here — it is
 * recomputed in `sampleDocument.ts` from the dataset via `analysisInputHash`,
 * the same helper the staleness checker uses, so it cannot drift from what
 * `checkFigure` recomputes.
 */
import type { StatResult } from '@figureforge/doc-model';

/** Panel a — one-way ANOVA over three genotypes, Holm-corrected. */
export const SAMPLE_ANOVA_RESULT: StatResult = {
  test: 'anova-one-way',
  omnibus: { statistic: 657.3142057382928, p: 5.477617621909221e-13, df: [2, 12], pBound: null },
  comparisons: [
    {
      groupA: 'WT',
      groupB: 'KO',
      statistic: -32.40166768599501,
      p: 8.970361603275773e-10,
      pAdjusted: 2.691108480982732e-9,
      df: 8,
      ci: [-1.5874729084160606, -1.3765270915839398],
      effectSize: -18.50945778398327,
      effectSizeName: "Hedges' g",
      n: [5, 5],
      pBound: null,
      statisticLocation: null,
      statisticSign: null,
    },
    {
      groupA: 'WT',
      groupB: 'Rescue',
      statistic: -7.261550055213292,
      p: 0.0000870714604844809,
      pAdjusted: 0.0000870714604844809,
      df: 8,
      ci: [-0.34256654166043266, -0.1774334583395678],
      effectSize: -4.148161616117889,
      effectSizeName: "Hedges' g",
      n: [5, 5],
      pBound: null,
      statisticLocation: null,
      statisticSign: null,
    },
    {
      groupA: 'KO',
      groupB: 'Rescue',
      statistic: 25.250952244221725,
      p: 6.478872951464542e-9,
      pAdjusted: 1.2957745902929084e-8,
      df: 8,
      ci: [1.1104027411732826, 1.3335972588267173],
      effectSize: 14.424610458301077,
      effectSizeName: "Hedges' g",
      n: [5, 5],
      pBound: null,
      statisticLocation: null,
      statisticSign: null,
    },
  ],
  methodsSentence:
    "Data were analysed by one-way ANOVA (n = 5 per group) with Holm-Bonferroni correction for multiple comparisons. The omnibus test was significant (F(2, 12) = 657.31, P < 0.001). WT vs KO: P_adj < 0.001, Hedges' g = -18.51, 95% CI [-1.59, -1.38]; WT vs Rescue: P_adj < 0.001, Hedges' g = -4.15, 95% CI [-0.343, -0.177]; KO vs Rescue: P_adj < 0.001, Hedges' g = 14.42, 95% CI [1.11, 1.33]. Significance was assessed at α = 0.05. Analyses were performed in Python 3.12.14 (SciPy 1.15.0, statsmodels 0.14.4).",
  warnings: [],
  softwareVersions: { python: '3.12.14', numpy: '2.2.1', scipy: '1.15.0', statsmodels: '0.14.4' },
  fit: null,
};

/** Panel b — Pearson correlation of response on dose; carries the fitted line. */
export const SAMPLE_PEARSON_RESULT: StatResult = {
  test: 'pearson',
  omnibus: null,
  comparisons: [
    {
      groupA: 'Dose (uM)',
      groupB: 'Response (AU)',
      statistic: 0.9922307760331632,
      p: 1.3507463667561274e-7,
      pAdjusted: 1.3507463667561274e-7,
      df: 7,
      ci: [0.9620894616806241, 0.9984270202208171],
      effectSize: 0.9845219129073733,
      effectSizeName: 'r²',
      n: [9, 9],
      pBound: null,
      statisticLocation: null,
      statisticSign: null,
    },
  ],
  methodsSentence:
    'Data were analysed by Pearson correlation (n = 9 per group). Dose (uM) vs Response (AU): P < 0.001, r² = 0.98, 95% CI [0.962, 0.998]. Significance was assessed at α = 0.05. Analyses were performed in Python 3.12.14 (SciPy 1.15.0, statsmodels 0.14.4).',
  warnings: ['Group variances differ (Levene P = 0.001); Welch’s correction is advisable.'],
  softwareVersions: { python: '3.12.14', numpy: '2.2.1', scipy: '1.15.0', statsmodels: '0.14.4' },
  fit: {
    slope: 7.913333333333332,
    intercept: 3.9066666666666663,
    n: 9,
    meanX: 2,
    sumSquaredDevX: 15,
    residualSe: 1.4524527694968419,
    tMultiplier: 2.3646242515927844,
    confidenceLevel: 0.95,
    xMin: 0,
    xMax: 4,
  },
};

/** Panel d — Kruskal-Wallis over three genotypes (n = 12), Holm-corrected. */
export const SAMPLE_KRUSKAL_RESULT: StatResult = {
  test: 'kruskal-wallis',
  omnibus: { statistic: 29.439881029077018, p: 4.047725572854023e-7, df: [2], pBound: null },
  comparisons: [
    {
      groupA: 'WT',
      groupB: 'KO',
      statistic: 0,
      p: 0.00003629993584104522,
      pAdjusted: 0.00010889980752313566,
      df: null,
      ci: null,
      effectSize: -1,
      effectSizeName: 'rank-biserial r',
      n: [12, 12],
      pBound: null,
      statisticLocation: null,
      statisticSign: null,
    },
    {
      groupA: 'WT',
      groupB: 'Rescue',
      statistic: 8.5,
      p: 0.00026797034793251475,
      pAdjusted: 0.00026797034793251475,
      df: null,
      ci: null,
      effectSize: -0.8819444444444444,
      effectSizeName: 'rank-biserial r',
      n: [12, 12],
      pBound: null,
      statisticLocation: null,
      statisticSign: null,
    },
    {
      groupA: 'KO',
      groupB: 'Rescue',
      statistic: 144,
      p: 0.00003644202729246209,
      pAdjusted: 0.00010889980752313566,
      df: null,
      ci: null,
      effectSize: 1,
      effectSizeName: 'rank-biserial r',
      n: [12, 12],
      pBound: null,
      statisticLocation: null,
      statisticSign: null,
    },
  ],
  methodsSentence:
    'Data were analysed by Kruskal-Wallis test (n = 12 per group) with Holm-Bonferroni correction for multiple comparisons. H(2) = 29.44, P < 0.001. WT vs KO: P_adj < 0.001, rank-biserial r = -1.00; WT vs Rescue: P_adj < 0.001, rank-biserial r = -0.88; KO vs Rescue: P_adj < 0.001, rank-biserial r = 1.00. Significance was assessed at α = 0.05. Analyses were performed in Python 3.12.14 (SciPy 1.15.0, statsmodels 0.14.4).',
  warnings: [],
  softwareVersions: { python: '3.12.14', numpy: '2.2.1', scipy: '1.15.0', statsmodels: '0.14.4' },
  fit: null,
};

/** Panel e — log-rank (Mantel-Cox) between the two survival arms. */
export const SAMPLE_LOGRANK_RESULT: StatResult = {
  test: 'log-rank',
  omnibus: { statistic: 5.99386583396697, p: 0.014355707622426885, df: [1], pBound: null },
  comparisons: [
    {
      groupA: 'Vehicle',
      groupB: 'Compound X',
      statistic: 5.99386583396697,
      p: 0.014355707622426885,
      pAdjusted: 0.014355707622426885,
      df: 1,
      ci: null,
      effectSize: 3.4864961205225486,
      effectSizeName: 'Hazard ratio (O/E)',
      n: [10, 10],
      pBound: null,
      statisticLocation: null,
      statisticSign: null,
    },
  ],
  methodsSentence:
    'Data were analysed by log-rank (Mantel-Cox) test (n = 10 per group). χ²(1) = 5.99, P = 0.01. Vehicle vs Compound X: P = 0.01, Hazard ratio (O/E) = 3.49. Significance was assessed at α = 0.05. Analyses were performed in Python 3.12.14 (SciPy 1.15.0, statsmodels 0.14.4).',
  warnings: [],
  softwareVersions: { python: '3.12.14', numpy: '2.2.1', scipy: '1.15.0', statsmodels: '0.14.4' },
  fit: null,
};
