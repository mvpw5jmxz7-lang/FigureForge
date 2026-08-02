"""Statistical tests checked against externally published reference values.

Every expected number here comes from a canonical dataset with results
published elsewhere — Student's 1908 sleep data and R's own documented output
for `t.test`, `aov` and `cor.test`. Asserting against values this code
generated itself would only prove it is self-consistent, not that it is right.

Reference values:
  sleep       Student (1908); R `t.test(extra ~ group, data = sleep)`
  PlantGrowth R `summary(aov(weight ~ group, data = PlantGrowth))`
  anscombe    Anscombe (1973); R `cor.test(anscombe$x1, anscombe$y1)`
  gender/party Agresti (2007) p.39, via R's `?chisq.test` example
  Hamilton depression scale  Hollander & Wolfe (1973) 29f, via R's
              `?wilcox.test` paired example
  tuna quality  Hollander & Wolfe (1973) p.187f, via R's `?cor.test` example
  drug response  Maxwell & Delaney (1990), via statsmodels' own `AnovaRM`
              documented example — cited from statsmodels since that library,
              not R, computes this test here
  tea tasting   Fisher (1935), via R's `?fisher.test` example
  convictions   Fisher (1962) twin study, via R's `?fisher.test` example
"""

from __future__ import annotations

import math

import pytest

from figureforge.stats.methods import methods_sentence
from figureforge.stats.tests import apply_correction, hedges_g, run_test

# --- Student's sleep data (Gosset 1908) ------------------------------------
SLEEP_1 = [0.7, -1.6, -0.2, -1.2, -0.1, 3.4, 3.7, 0.8, 0.0, 2.0]
SLEEP_2 = [1.9, 0.8, 1.1, 0.1, -0.1, 4.4, 5.5, 1.6, 4.6, 3.4]

# --- R's PlantGrowth --------------------------------------------------------
CTRL = [4.17, 5.58, 5.18, 6.11, 4.50, 4.61, 5.17, 4.53, 5.33, 5.14]
TRT1 = [4.81, 4.17, 4.41, 3.59, 5.87, 3.83, 6.03, 4.89, 4.32, 4.69]
TRT2 = [6.31, 5.12, 5.54, 5.50, 5.37, 5.29, 4.92, 6.15, 5.80, 5.26]

# --- Anscombe's first set ---------------------------------------------------
ANS_X = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5]
ANS_Y = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68]

# --- Agresti (2007) p.39 gender x party affiliation contingency table -------
GENDER_PARTY = {"F": [762, 327, 468], "M": [484, 239, 477]}

# --- Hollander & Wolfe (1973) 29f, Hamilton depression scale, paired visits -
HAMILTON_VISIT_1 = [1.83, 0.50, 1.62, 2.48, 1.68, 1.88, 1.55, 3.06, 1.30]
HAMILTON_VISIT_2 = [0.878, 0.647, 0.598, 2.05, 1.06, 1.29, 1.06, 3.14, 1.29]

# --- Hollander & Wolfe (1973) p.187f, tuna quality: lightness vs panel score
TUNA_LIGHTNESS = [44.4, 45.9, 41.9, 53.3, 44.7, 44.1, 50.7, 45.2, 60.1]
TUNA_PANEL_SCORE = [2.6, 3.1, 2.5, 5.0, 3.6, 4.0, 5.2, 2.8, 3.8]

# --- statsmodels' own AnovaRM documented example (Maxwell & Delaney 1990) --
DRUG_RESPONSE = {
    "drug1": [30, 14, 24, 38, 26],
    "drug2": [28, 18, 20, 34, 28],
    "drug3": [16, 10, 18, 20, 14],
    "drug4": [34, 22, 30, 44, 30],
}


def only(outcome):
    assert len(outcome.comparisons) == 1
    return outcome.comparisons[0]


class TestStudentT:
    """R: t.test(extra ~ group, data = sleep, var.equal = TRUE)
    t = -1.8608, df = 18, p-value = 0.07919
    """

    def test_independent_matches_r(self):
        outcome = run_test("ttest-independent", {"A": SLEEP_1, "B": SLEEP_2}, welch=False)
        c = only(outcome)
        assert c.statistic == pytest.approx(-1.8608, abs=1e-4)
        assert c.df == pytest.approx(18.0)
        assert c.p == pytest.approx(0.07919, abs=1e-5)

    def test_welch_matches_r(self):
        """R: t.test(extra ~ group, data = sleep)
        t = -1.8608, df = 17.776, p-value = 0.07939
        """
        outcome = run_test("ttest-welch", {"A": SLEEP_1, "B": SLEEP_2})
        c = only(outcome)
        assert c.statistic == pytest.approx(-1.8608, abs=1e-4)
        assert c.df == pytest.approx(17.776, abs=1e-3)
        assert c.p == pytest.approx(0.07939, abs=1e-5)

    def test_paired_matches_r(self):
        """R: t.test(extra ~ group, data = sleep, paired = TRUE)
        t = -4.0621, df = 9, p-value = 0.002833
        """
        outcome = run_test("ttest-paired", {"A": SLEEP_1, "B": SLEEP_2})
        c = only(outcome)
        assert c.statistic == pytest.approx(-4.0621, abs=1e-4)
        assert c.df == pytest.approx(9.0)
        assert c.p == pytest.approx(0.002833, abs=1e-6)

    def test_ci_brackets_the_mean_difference(self):
        """R reports 95% CI [-3.3639, 0.2039] for the unpaired equal-variance test."""
        outcome = run_test("ttest-independent", {"A": SLEEP_1, "B": SLEEP_2}, welch=False)
        c = only(outcome)
        assert c.ci is not None
        assert c.ci[0] == pytest.approx(-3.3639, abs=1e-3)
        assert c.ci[1] == pytest.approx(0.2039, abs=1e-3)


class TestAnova:
    """R: summary(aov(weight ~ group, data = PlantGrowth))
    F = 4.846, df 2 and 27, p = 0.0159
    """

    def test_omnibus_matches_r(self):
        outcome = run_test("anova-one-way", {"ctrl": CTRL, "trt1": TRT1, "trt2": TRT2})
        assert outcome.omnibus is not None
        assert outcome.omnibus.statistic == pytest.approx(4.846, abs=1e-3)
        assert outcome.omnibus.df == [2.0, 27.0]
        assert outcome.omnibus.p == pytest.approx(0.01591, abs=1e-5)

    def test_produces_all_pairwise_comparisons(self):
        outcome = run_test("anova-one-way", {"ctrl": CTRL, "trt1": TRT1, "trt2": TRT2})
        assert len(outcome.comparisons) == 3

    def test_holm_correction_raises_p_values(self):
        plain = run_test("anova-one-way", {"ctrl": CTRL, "trt1": TRT1, "trt2": TRT2})
        corrected = run_test(
            "anova-one-way", {"ctrl": CTRL, "trt1": TRT1, "trt2": TRT2}, correction="holm"
        )
        for raw, adj in zip(plain.comparisons, corrected.comparisons, strict=False):
            assert adj.pAdjusted >= raw.p - 1e-12


class TestRepeatedMeasuresAnova:
    """statsmodels AnovaRM's own documented example (Maxwell & Delaney 1990):
    F Value = 24.7589, Num DF = 3, Den DF = 12, Pr > F ≈ 0.00002
    """

    def test_omnibus_matches_statsmodels_docs(self):
        outcome = run_test("anova-rm", DRUG_RESPONSE)
        assert outcome.omnibus is not None
        assert outcome.omnibus.statistic == pytest.approx(24.7589, abs=1e-3)
        assert outcome.omnibus.df == [3.0, 12.0]
        assert outcome.omnibus.p < 0.001

    def test_produces_all_pairwise_comparisons(self):
        outcome = run_test("anova-rm", DRUG_RESPONSE)
        assert len(outcome.comparisons) == 6  # C(4, 2)

    def test_rejects_unbalanced_design(self):
        with pytest.raises(ValueError, match="same number of subjects"):
            run_test("anova-rm", {"a": [1.0, 2.0, 3.0], "b": [1.0, 2.0]})

    def test_rejects_single_condition(self):
        # Caught generically by run_test's "at least two groups" check, before
        # anova-rm's own dispatch branch is even reached.
        with pytest.raises(ValueError, match="At least two groups"):
            run_test("anova-rm", {"a": [1.0, 2.0, 3.0]})


class TestCorrelation:
    """R: cor.test(anscombe$x1, anscombe$y1)
    r = 0.8164, df = 9, p-value = 0.00217
    """

    def test_pearson_matches_r(self):
        outcome = run_test("pearson", {"x": ANS_X, "y": ANS_Y})
        c = only(outcome)
        assert c.statistic == pytest.approx(0.81642, abs=1e-4)
        assert c.df == pytest.approx(9.0)
        assert c.p == pytest.approx(0.00217, abs=1e-5)

    def test_linear_regression_matches_r(self):
        """R: lm(y1 ~ x1, anscombe) -> slope 0.5001, intercept 3.0001, R² 0.6665"""
        outcome = run_test("linear-regression", {"x": ANS_X, "y": ANS_Y})
        c = only(outcome)
        assert c.statistic == pytest.approx(0.5001, abs=1e-3)
        assert c.effectSize == pytest.approx(0.6665, abs=1e-3)

    def test_spearman_rho_matches_r(self):
        """R: cor.test(x, y, method = "spearman") on the tuna quality example
        -> rho = 0.6, S = 48.

        rho is deterministic and matches R exactly. The p-value is not
        asserted against R's documented figure: R's `cor.test` computes an
        exact permutation p-value (AS 89) for this sample size, while SciPy's
        `spearmanr` uses a t-distribution approximation, and the two
        genuinely disagree at this n. The asymptotic value below is SciPy's
        own reproducible output, not an externally published number.
        """
        outcome = run_test("spearman", {"x": TUNA_LIGHTNESS, "y": TUNA_PANEL_SCORE})
        c = only(outcome)
        assert c.statistic == pytest.approx(0.6, abs=1e-9)
        assert c.p == pytest.approx(0.08762, abs=1e-4)

    def test_correlating_a_series_against_its_own_x_matches_two_group_form(self):
        """The x=/x_name= path is a pre-transform into the same two-key shape
        the dispatch branches already use — it must reproduce the two-group
        Anscombe result exactly, not approximately.
        """
        two_group = run_test("pearson", {"x": ANS_X, "y": ANS_Y})
        via_x = run_test("pearson", {"y": ANS_Y}, x=ANS_X, x_name="x")
        assert only(via_x).statistic == pytest.approx(only(two_group).statistic, abs=1e-12)
        assert only(via_x).p == pytest.approx(only(two_group).p, abs=1e-12)

        two_group_lr = run_test("linear-regression", {"x": ANS_X, "y": ANS_Y})
        via_x_lr = run_test("linear-regression", {"y": ANS_Y}, x=ANS_X, x_name="x")
        assert only(via_x_lr).statistic == pytest.approx(only(two_group_lr).statistic, abs=1e-12)

    def test_x_rejected_for_non_correlation_test(self):
        with pytest.raises(ValueError, match="does not accept a separate x series"):
            run_test("ttest-welch", {"y": ANS_Y}, x=ANS_X)


class TestChiSquare:
    """R: chisq.test(M) on Agresti (2007) p.39's gender x party table
    X-squared = 30.07, df = 2, p-value = 2.954e-07
    """

    def test_matches_r(self):
        outcome = run_test("chi-square", GENDER_PARTY)
        assert outcome.omnibus is not None
        assert outcome.omnibus.statistic == pytest.approx(30.07, abs=1e-2)
        assert outcome.omnibus.df == [2.0]
        assert outcome.omnibus.p == pytest.approx(2.954e-07, rel=1e-3)


class TestFisher:
    """R: fisher.test() on the two datasets in its own help page.

    Both p-values match R exactly. The *odds ratio* deliberately does not: R
    reports the conditional maximum-likelihood estimate (6.408 for the tea
    table), SciPy's `fisher_exact` returns the sample odds ratio (9.0). Neither
    is wrong; they are different estimators, and asserting SciPy's own value
    with the reason stated is more honest than forcing a match that is not real.
    """

    # Fisher's lady tasting tea: 3 of 4 cups identified correctly.
    TEA = {"Guessed milk": [3.0, 1.0], "Guessed tea": [1.0, 3.0]}
    # Fisher (1962): convictions among monozygotic vs dizygotic twins.
    CONVICTIONS = {"Dizygotic": [2.0, 10.0], "Monozygotic": [15.0, 3.0]}

    def test_tea_tasting_matches_r(self):
        """R: fisher.test(TeaTasting, alternative = "greater") -> p = 0.2429"""
        outcome = run_test("fisher", self.TEA, alternative="greater")
        c = only(outcome)
        assert c.p == pytest.approx(0.2429, abs=1e-4)
        # SciPy's sample odds ratio, not R's conditional MLE of 6.408.
        assert c.effectSize == pytest.approx(9.0, abs=1e-9)
        assert c.effectSizeName == "Odds ratio"

    def test_convictions_matches_r(self):
        """R: fisher.test(Convictions) -> p = 0.0005367; alternative="less" -> 0.0004652"""
        assert only(run_test("fisher", self.CONVICTIONS)).p == pytest.approx(
            0.0005367, abs=1e-7
        )
        assert only(run_test("fisher", self.CONVICTIONS, alternative="less")).p == pytest.approx(
            0.0004652, abs=1e-7
        )

    def test_reports_no_omnibus(self):
        # Fisher's returns a p-value directly; inventing a chi-square beside it
        # would invite reporting a number this test never computed.
        assert run_test("fisher", self.TEA).omnibus is None

    def test_rejects_a_table_larger_than_two_by_two(self):
        # SciPy has no exact test beyond 2x2 and there is no honest way to
        # approximate one — the whole point of Fisher's is that it is exact.
        with pytest.raises(ValueError, match="2x2"):
            run_test("fisher", GENDER_PARTY)


class TestContingencyValidation:
    """A count table is not a set of measurements, and is checked as one."""

    def test_rejects_a_ragged_table(self):
        # `_clean` drops non-finite values per row, so a blank cell used to
        # arrive as a short row and raise an opaque numpy shape error.
        with pytest.raises(ValueError, match="blank cell is not a zero"):
            run_test("chi-square", {"F": [762.0, 327.0, 468.0], "M": [484.0, float("nan"), 477.0]})

    def test_rejects_fractional_counts(self):
        with pytest.raises(ValueError, match="whole number"):
            run_test("chi-square", {"A": [1.5, 2.0], "B": [3.0, 4.0]})

    def test_rejects_negative_counts(self):
        with pytest.raises(ValueError, match="negative"):
            run_test("chi-square", {"A": [-1.0, 2.0], "B": [3.0, 4.0]})

    def test_rejects_a_single_category(self):
        with pytest.raises(ValueError, match="at least two categories"):
            run_test("chi-square", {"A": [1.0], "B": [3.0]})


class TestNonparametric:
    def test_mann_whitney_matches_r(self):
        """R: wilcox.test(extra ~ group, data = sleep) -> W = 25.5, p = 0.06933"""
        outcome = run_test("mann-whitney", {"A": SLEEP_1, "B": SLEEP_2})
        c = only(outcome)
        assert c.statistic == pytest.approx(25.5, abs=1e-6)
        assert c.p == pytest.approx(0.06933, abs=1e-4)

    def test_kruskal_matches_r(self):
        """R: kruskal.test(weight ~ group, data = PlantGrowth)
        chi-squared = 7.9882, df = 2, p-value = 0.01842
        """
        outcome = run_test("kruskal-wallis", {"ctrl": CTRL, "trt1": TRT1, "trt2": TRT2})
        assert outcome.omnibus is not None
        assert outcome.omnibus.statistic == pytest.approx(7.9882, abs=1e-3)
        assert outcome.omnibus.p == pytest.approx(0.01842, abs=1e-5)

    def test_wilcoxon_matches_r(self):
        """R: wilcox.test(x, y, paired = TRUE, alternative = "greater") on the
        Hamilton depression scale example -> V = 40, p-value = 0.01953
        """
        outcome = run_test(
            "wilcoxon",
            {"visit1": HAMILTON_VISIT_1, "visit2": HAMILTON_VISIT_2},
            alternative="greater",
        )
        c = only(outcome)
        assert c.statistic == pytest.approx(40.0, abs=1e-9)
        assert c.p == pytest.approx(0.01953, abs=1e-4)


class TestEffectSizes:
    def test_hedges_g_applies_small_sample_correction(self):
        """g must be strictly smaller in magnitude than d, and converge as n grows."""
        import numpy as np

        from figureforge.stats.tests import cohens_d

        a = np.array([1.0, 2.0, 3.0])
        b = np.array([4.0, 5.0, 6.0])
        d = cohens_d(a, b)
        g = hedges_g(a, b)
        assert abs(g) < abs(d)
        # df = 4, correction factor = 1 - 3/15 = 0.8
        assert g == pytest.approx(d * 0.8, rel=1e-9)


class TestCorrections:
    def test_bonferroni_multiplies_by_family_size(self):
        adjusted = apply_correction([0.01, 0.02, 0.03], "bonferroni", 0.05)
        assert adjusted[0] == pytest.approx(0.03)
        assert adjusted[2] == pytest.approx(0.09)

    def test_holm_is_less_conservative_than_bonferroni(self):
        p_values = [0.01, 0.02, 0.03]
        holm = apply_correction(p_values, "holm", 0.05)
        bonferroni = apply_correction(p_values, "bonferroni", 0.05)
        assert all(h <= b + 1e-12 for h, b in zip(holm, bonferroni, strict=False))
        assert holm[2] < bonferroni[2]

    def test_none_passes_through(self):
        p_values = [0.01, 0.5]
        assert apply_correction(p_values, "none", 0.05) == p_values

    def test_single_comparison_is_never_adjusted(self):
        assert apply_correction([0.04], "bonferroni", 0.05) == [0.04]


class TestAssumptionWarnings:
    def test_tiny_groups_are_flagged(self):
        outcome = run_test("ttest-welch", {"A": [1.0, 2.0], "B": [3.0, 4.0]})
        assert any("n = 2" in w for w in outcome.warnings)

    def test_unequal_variance_is_flagged(self):
        tight = [5.0, 5.1, 4.9, 5.05, 4.95, 5.02, 4.98, 5.01]
        wide = [1.0, 9.0, 2.0, 8.0, 3.0, 7.0, 0.5, 9.5]
        outcome = run_test("ttest-independent", {"tight": tight, "wide": wide}, welch=False)
        assert any("Levene" in w for w in outcome.warnings)


class TestMethodsSentence:
    def test_names_the_test_and_reports_n(self):
        outcome = run_test("ttest-welch", {"Control": SLEEP_1, "Treated": SLEEP_2})
        sentence = methods_sentence("ttest-welch", outcome)
        assert "Welch's t-test" in sentence
        assert "n = 10 per group" in sentence
        assert "SciPy" in sentence

    def test_reports_adjusted_p_when_corrected(self):
        outcome = run_test(
            "anova-one-way",
            {"ctrl": CTRL, "trt1": TRT1, "trt2": TRT2},
            correction="holm",
        )
        sentence = methods_sentence("anova-one-way", outcome, correction="holm")
        assert "Holm-Bonferroni" in sentence
        # Corrected families must be reported as adjusted, never as raw P.
        assert "P_adj" in sentence

    def test_one_tailed_is_stated(self):
        outcome = run_test("ttest-welch", {"A": SLEEP_1, "B": SLEEP_2}, alternative="less")
        sentence = methods_sentence("ttest-welch", outcome, alternative="less")
        assert "one-tailed" in sentence


class TestValidation:
    def test_rejects_single_group(self):
        with pytest.raises(ValueError, match="two groups"):
            run_test("ttest-welch", {"A": [1.0, 2.0, 3.0]})

    def test_rejects_empty_group(self):
        with pytest.raises(ValueError, match="no numeric values"):
            run_test("ttest-welch", {"A": [1.0, 2.0], "B": []})

    def test_rejects_unknown_test(self):
        with pytest.raises(ValueError, match="Unsupported test"):
            run_test("bogus-test", {"A": [1.0, 2.0], "B": [3.0, 4.0]})

    def test_paired_requires_equal_sizes(self):
        with pytest.raises(ValueError, match="equal group sizes"):
            run_test("ttest-paired", {"A": [1.0, 2.0, 3.0], "B": [1.0, 2.0]})

    def test_non_finite_values_are_dropped(self):
        outcome = run_test(
            "ttest-welch",
            {"A": [*SLEEP_1, math.nan], "B": [*SLEEP_2, math.inf]},
        )
        c = only(outcome)
        assert c.n == [10, 10]
        assert c.statistic == pytest.approx(-1.8608, abs=1e-4)
