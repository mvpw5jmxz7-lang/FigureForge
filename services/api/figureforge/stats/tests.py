"""Statistical tests.

Each test returns the statistic, the p-value, degrees of freedom, a confidence
interval and an effect size. Effect sizes are not optional extras here: a
p-value alone says whether a difference is detectable, not whether it matters,
and figures that report only asterisks are a large part of why so much of the
literature is hard to interpret.

Nothing in this module knows about figures or rendering. It takes numbers and
returns numbers.
"""

from __future__ import annotations

import itertools
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
from scipy import stats as sps
from statsmodels.stats.multitest import multipletests

Alternative = Literal["two-sided", "less", "greater"]
Correction = Literal["none", "bonferroni", "holm", "benjamini-hochberg", "tukey", "dunn"]


@dataclass
class Comparison:
    groupA: str
    groupB: str
    statistic: float
    p: float
    pAdjusted: float
    df: float | None
    ci: tuple[float, float] | None
    effectSize: float | None
    effectSizeName: str | None
    n: list[int]


@dataclass
class Omnibus:
    statistic: float
    p: float
    df: list[float] | None


@dataclass
class TestOutcome:
    comparisons: list[Comparison]
    omnibus: Omnibus | None = None
    warnings: list[str] = field(default_factory=list)


def _clean(values: Sequence[float]) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    return arr[np.isfinite(arr)]


# ---------------------------------------------------------------------------
# Effect sizes
# ---------------------------------------------------------------------------


def cohens_d(a: np.ndarray, b: np.ndarray, pooled: bool = True) -> float:
    """Standardised mean difference.

    Uses the pooled SD for Student's t and the average variance for Welch,
    matching the variance assumption of the test that produced the p-value.
    """
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return float("nan")
    va, vb = a.var(ddof=1), b.var(ddof=1)
    if pooled:
        sd = np.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2))
    else:
        sd = np.sqrt((va + vb) / 2)
    return float((a.mean() - b.mean()) / sd) if sd > 0 else float("nan")


def hedges_g(a: np.ndarray, b: np.ndarray) -> float:
    """Cohen's d with the small-sample bias correction.

    At the sample sizes typical in biology (n of 3-6) d overestimates the effect
    by a noticeable margin, so the correction is worth applying by default.
    """
    d = cohens_d(a, b)
    df = len(a) + len(b) - 2
    if df <= 0 or not np.isfinite(d):
        return float("nan")
    correction = 1 - (3 / (4 * df - 1))
    return float(d * correction)


def rank_biserial(a: np.ndarray, b: np.ndarray, u: float) -> float:
    """Effect size for Mann-Whitney: the common-language probability, rescaled."""
    n = len(a) * len(b)
    return float(2 * u / n - 1) if n > 0 else float("nan")


def eta_squared(groups: list[np.ndarray]) -> float:
    """Proportion of total variance explained by group membership."""
    everything = np.concatenate(groups)
    grand_mean = everything.mean()
    ss_between = sum(len(g) * (g.mean() - grand_mean) ** 2 for g in groups)
    ss_total = ((everything - grand_mean) ** 2).sum()
    return float(ss_between / ss_total) if ss_total > 0 else float("nan")


# ---------------------------------------------------------------------------
# Confidence intervals
# ---------------------------------------------------------------------------


def mean_difference_ci(
    a: np.ndarray, b: np.ndarray, alpha: float, welch: bool
) -> tuple[tuple[float, float] | None, float | None]:
    """CI for the difference in means, plus the degrees of freedom used."""
    na, nb = len(a), len(b)
    if na < 2 or nb < 2:
        return None, None

    va, vb = a.var(ddof=1), b.var(ddof=1)
    diff = a.mean() - b.mean()

    if welch:
        se = np.sqrt(va / na + vb / nb)
        if se == 0:
            return None, None
        # Welch-Satterthwaite
        df = (va / na + vb / nb) ** 2 / (
            (va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1)
        )
    else:
        df = na + nb - 2
        pooled = ((na - 1) * va + (nb - 1) * vb) / df
        se = np.sqrt(pooled * (1 / na + 1 / nb))
        if se == 0:
            return None, None

    t_crit = sps.t.ppf(1 - alpha / 2, df)
    return (float(diff - t_crit * se), float(diff + t_crit * se)), float(df)


# ---------------------------------------------------------------------------
# Assumption checks
# ---------------------------------------------------------------------------


def check_assumptions(groups: dict[str, np.ndarray], parametric: bool) -> list[str]:
    """Surface assumption violations rather than failing silently.

    These are advisory. The point is that an author choosing a t-test on n=3
    skewed data should be told, not blocked.
    """
    warnings: list[str] = []

    for name, values in groups.items():
        if len(values) < 3:
            warnings.append(f'Group "{name}" has n = {len(values)}; results are unreliable.')
            continue
        if parametric and 3 <= len(values) <= 5000:
            try:
                p = sps.shapiro(values).pvalue
                if p < 0.05:
                    warnings.append(
                        f'Group "{name}" deviates from normality '
                        f"(Shapiro-Wilk P = {p:.3f}); consider a rank-based test."
                    )
            except ValueError:
                pass

    if parametric and len(groups) >= 2:
        sized = [v for v in groups.values() if len(v) >= 3]
        if len(sized) >= 2:
            try:
                p = sps.levene(*sized, center="median").pvalue
                if p < 0.05:
                    warnings.append(
                        f"Group variances differ (Levene P = {p:.3f}); "
                        "Welch's correction is advisable."
                    )
            except ValueError:
                pass

    return warnings


# ---------------------------------------------------------------------------
# Multiple-comparison correction
# ---------------------------------------------------------------------------

_METHODS = {
    "bonferroni": "bonferroni",
    "holm": "holm",
    "benjamini-hochberg": "fdr_bh",
}


def apply_correction(p_values: list[float], correction: Correction, alpha: float) -> list[float]:
    """Adjust a family of p-values. Unknown or 'none' passes them through."""
    if correction in ("none", "tukey", "dunn") or len(p_values) < 2:
        return list(p_values)
    method = _METHODS.get(correction)
    if method is None:
        return list(p_values)
    finite = [p if np.isfinite(p) else 1.0 for p in p_values]
    _, adjusted, _, _ = multipletests(finite, alpha=alpha, method=method)
    return [float(p) for p in adjusted]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def _pairwise(
    groups: dict[str, np.ndarray],
    fn,
) -> list[Comparison]:
    out: list[Comparison] = []
    for (name_a, a), (name_b, b) in itertools.combinations(groups.items(), 2):
        out.append(fn(name_a, a, name_b, b))
    return out


def run_test(
    test: str,
    groups: dict[str, Sequence[float]],
    alternative: Alternative = "two-sided",
    correction: Correction = "none",
    alpha: float = 0.05,
    welch: bool = True,
) -> TestOutcome:
    cleaned = {name: _clean(values) for name, values in groups.items()}

    if len(cleaned) < 2:
        raise ValueError("At least two groups are required.")
    if any(len(v) == 0 for v in cleaned.values()):
        empty = [n for n, v in cleaned.items() if len(v) == 0]
        raise ValueError(f"Group(s) with no numeric values: {', '.join(empty)}")

    parametric = test in {
        "ttest-independent",
        "ttest-welch",
        "ttest-paired",
        "anova-one-way",
        "anova-rm",
        "pearson",
        "linear-regression",
    }
    warnings = check_assumptions(cleaned, parametric)
    outcome = _dispatch(test, cleaned, alternative, alpha, welch)
    outcome.warnings = warnings + outcome.warnings

    adjusted = apply_correction([c.p for c in outcome.comparisons], correction, alpha)
    # strict=True on purpose: a length mismatch would leave some comparison
    # showing its uncorrected p-value while the rest were adjusted.
    for comparison, p_adj in zip(outcome.comparisons, adjusted, strict=True):
        comparison.pAdjusted = p_adj

    return outcome


def _dispatch(
    test: str,
    groups: dict[str, np.ndarray],
    alternative: Alternative,
    alpha: float,
    welch: bool,
) -> TestOutcome:
    names = list(groups)

    if test in ("ttest-independent", "ttest-welch"):
        use_welch = welch or test == "ttest-welch"

        def run(na, a, nb, b):
            result = sps.ttest_ind(a, b, equal_var=not use_welch, alternative=alternative)
            ci, df = mean_difference_ci(a, b, alpha, use_welch)
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                df, ci, hedges_g(a, b), "Hedges' g", [len(a), len(b)],
            )

        return TestOutcome(_pairwise(groups, run))

    if test == "ttest-paired":
        def run(na, a, nb, b):
            if len(a) != len(b):
                raise ValueError(
                    f'Paired test needs equal group sizes; "{na}" has {len(a)} '
                    f'and "{nb}" has {len(b)}.'
                )
            result = sps.ttest_rel(a, b, alternative=alternative)
            differences = a - b
            n = len(differences)
            se = differences.std(ddof=1) / np.sqrt(n) if n > 1 else 0.0
            t_crit = sps.t.ppf(1 - alpha / 2, n - 1) if n > 1 else float("nan")
            ci = (
                (float(differences.mean() - t_crit * se), float(differences.mean() + t_crit * se))
                if se > 0
                else None
            )
            # Paired designs use the SD of the differences, not the pooled SD.
            sd_diff = differences.std(ddof=1) if n > 1 else 0.0
            d = float(differences.mean() / sd_diff) if sd_diff > 0 else float("nan")
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                float(n - 1), ci, d, "Cohen's dz", [len(a), len(b)],
            )

        return TestOutcome(_pairwise(groups, run))

    if test == "mann-whitney":
        def run(na, a, nb, b):
            result = sps.mannwhitneyu(a, b, alternative=alternative)
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                None, None, rank_biserial(a, b, float(result.statistic)),
                "rank-biserial r", [len(a), len(b)],
            )

        return TestOutcome(_pairwise(groups, run))

    if test == "wilcoxon":
        def run(na, a, nb, b):
            if len(a) != len(b):
                raise ValueError("Wilcoxon signed-rank needs paired samples of equal length.")
            result = sps.wilcoxon(a, b, alternative=alternative)
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                None, None, None, None, [len(a), len(b)],
            )

        return TestOutcome(_pairwise(groups, run))

    if test == "anova-one-way":
        arrays = [groups[n] for n in names]
        f_stat, p = sps.f_oneway(*arrays)
        df_between = len(arrays) - 1
        df_within = sum(len(a) for a in arrays) - len(arrays)

        # Pairwise follow-ups; correction is applied by the caller.
        def run(na, a, nb, b):
            result = sps.ttest_ind(a, b, equal_var=True)
            ci, df = mean_difference_ci(a, b, alpha, welch=False)
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                df, ci, hedges_g(a, b), "Hedges' g", [len(a), len(b)],
            )

        return TestOutcome(
            _pairwise(groups, run),
            Omnibus(float(f_stat), float(p), [float(df_between), float(df_within)]),
        )

    if test == "kruskal-wallis":
        arrays = [groups[n] for n in names]
        h_stat, p = sps.kruskal(*arrays)

        def run(na, a, nb, b):
            result = sps.mannwhitneyu(a, b, alternative="two-sided")
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                None, None, rank_biserial(a, b, float(result.statistic)),
                "rank-biserial r", [len(a), len(b)],
            )

        return TestOutcome(
            _pairwise(groups, run),
            Omnibus(float(h_stat), float(p), [float(len(arrays) - 1)]),
        )

    if test in ("pearson", "spearman"):
        if len(names) != 2:
            raise ValueError("Correlation takes exactly two variables.")
        a, b = groups[names[0]], groups[names[1]]
        if len(a) != len(b):
            raise ValueError("Correlation needs paired observations of equal length.")

        if test == "pearson":
            result = sps.pearsonr(a, b, alternative=alternative)
            ci_obj = result.confidence_interval(confidence_level=1 - alpha)
            ci = (float(ci_obj.low), float(ci_obj.high))
        else:
            result = sps.spearmanr(a, b, alternative=alternative)
            ci = None

        r = float(result.statistic)
        return TestOutcome([
            Comparison(
                names[0], names[1], r, float(result.pvalue), float(result.pvalue),
                float(len(a) - 2), ci, r * r, "r²", [len(a), len(b)],
            )
        ])

    if test == "linear-regression":
        if len(names) != 2:
            raise ValueError("Linear regression takes exactly two variables (x and y).")
        x, y = groups[names[0]], groups[names[1]]
        if len(x) != len(y):
            raise ValueError("Regression needs paired observations of equal length.")
        fit = sps.linregress(x, y)
        df = len(x) - 2
        t_crit = sps.t.ppf(1 - alpha / 2, df) if df > 0 else float("nan")
        ci = (
            (float(fit.slope - t_crit * fit.stderr), float(fit.slope + t_crit * fit.stderr))
            if np.isfinite(t_crit)
            else None
        )
        return TestOutcome([
            Comparison(
                names[0], names[1], float(fit.slope), float(fit.pvalue), float(fit.pvalue),
                float(df), ci, float(fit.rvalue ** 2), "R²", [len(x), len(y)],
            )
        ])

    if test == "chi-square":
        # Groups are rows of a contingency table.
        table = np.array([groups[n] for n in names])
        chi2, p, dof, _ = sps.chi2_contingency(table)
        n_total = table.sum()
        # Cramer's V
        denominator = n_total * (min(table.shape) - 1)
        v = float(np.sqrt(chi2 / denominator)) if denominator > 0 else float("nan")
        return TestOutcome(
            [
                Comparison(
                    names[0], names[1] if len(names) > 1 else names[0],
                    float(chi2), float(p), float(p), float(dof), None, v,
                    "Cramér's V", [int(row.sum()) for row in table],
                )
            ],
            Omnibus(float(chi2), float(p), [float(dof)]),
        )

    raise ValueError(f"Unsupported test: {test}")
