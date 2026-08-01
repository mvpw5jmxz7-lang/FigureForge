"""Statistical tests checked against externally published reference values.

Every expected number here comes from a canonical dataset with results
published elsewhere — Student's 1908 sleep data and R's own documented output
for `t.test`, `aov` and `cor.test`. Asserting against values this code
generated itself would only prove it is self-consistent, not that it is right.

Reference values:
  sleep       Student (1908); R `t.test(extra ~ group, data = sleep)`
  PlantGrowth R `summary(aov(weight ~ group, data = PlantGrowth))`
  anscombe    Anscombe (1973); R `cor.test(anscombe$x1, anscombe$y1)`
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
