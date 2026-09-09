"""Methods-section sentence generation.

Returning a ready-to-paste sentence alongside the numbers is cheap here and
saves the author transcribing test names, n, corrections and software versions
by hand — which is where reporting errors usually creep in.
"""

from __future__ import annotations

import platform

import numpy as np
import scipy
import statsmodels

from .tests import Comparison, Omnibus, PBound, TestOutcome

TEST_NAMES = {
    "ttest-independent": "two-tailed unpaired Student's t-test",
    "ttest-welch": "two-tailed unpaired Welch's t-test",
    "ttest-paired": "two-tailed paired Student's t-test",
    "mann-whitney": "two-tailed Mann-Whitney U test",
    "wilcoxon": "Wilcoxon signed-rank test",
    "anova-one-way": "one-way ANOVA",
    "anova-rm": "repeated-measures ANOVA",
    "kruskal-wallis": "Kruskal-Wallis test",
    "chi-square": "chi-square test of independence",
    "fisher": "Fisher's exact test",
    "pearson": "Pearson correlation",
    "spearman": "Spearman rank correlation",
    "linear-regression": "ordinary least-squares linear regression",
    "log-rank": "log-rank (Mantel-Cox) test",
    # None of the four carries a "two-tailed " prefix, and that is deliberate
    # rather than an omission: `run_test` refuses a directional alternative for
    # all of them, so the prefix-stripping branch below can never fire and a
    # sentence can never claim a one-tailed distribution test.
    "kolmogorov-smirnov": "two-sample Kolmogorov-Smirnov test",
    "anderson-darling": "Anderson-Darling k-sample test",
    "cramer-von-mises": "two-sample Cramer-von Mises test",
    "epps-singleton": "two-sample Epps-Singleton test",
}

CORRECTION_NAMES = {
    "bonferroni": "Bonferroni correction",
    "holm": "Holm-Bonferroni correction",
    "benjamini-hochberg": "Benjamini-Hochberg false discovery rate correction",
    "tukey": "Tukey's honestly significant difference test",
    "dunn": "Dunn's test",
}

_ONE_TAILED = {"less": "one-tailed (lower)", "greater": "one-tailed (upper)"}


def software_versions() -> dict[str, str]:
    return {
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scipy": scipy.__version__,
        "statsmodels": statsmodels.__version__,
    }


def _format_p(p: float) -> str:
    if not np.isfinite(p):
        return "P = n/a"
    if p < 0.001:
        return "P < 0.001"
    if p < 0.01:
        return f"P = {p:.3f}"
    return f"P = {p:.2f}"


def _format_p_bounded(p: float, bound: PBound | None) -> str:
    """A p-value the test will only bracket, printed as the bracket it is.

    `_format_p` alone would report Anderson-Darling's clamped 0.25 as
    "P = 0.25", which states a precision the test explicitly declines to
    claim — and its floored 0.001 as "P < 0.001" only by coincidence of the
    threshold, which is worse: right for the wrong reason, and silently wrong
    the day either number changes.
    """
    if bound is None:
        return _format_p(p)
    if not np.isfinite(p):
        return "P = n/a"
    return f"P {'<' if bound == 'below' else '>'} {p:g}"


def _describe_n(comparisons: list[Comparison]) -> str:
    sizes = sorted({n for c in comparisons for n in c.n})
    if not sizes:
        return ""
    if len(sizes) == 1:
        return f"n = {sizes[0]} per group"
    return f"n = {sizes[0]}-{sizes[-1]} per group"


def methods_sentence(
    test: str,
    outcome: TestOutcome,
    alternative: str = "two-sided",
    correction: str = "none",
    alpha: float = 0.05,
) -> str:
    """Compose the sentence. Reports adjusted p-values whenever a correction ran."""
    name = TEST_NAMES.get(test, test)

    if alternative in _ONE_TAILED:
        name = name.replace("two-tailed ", "")
        name = f"{_ONE_TAILED[alternative]} {name}"

    parts = [f"Data were analysed by {name}"]

    n_text = _describe_n(outcome.comparisons)
    if n_text:
        parts.append(f"({n_text})")

    corrected = correction != "none" and len(outcome.comparisons) > 1
    if corrected:
        correction_name = CORRECTION_NAMES.get(correction, correction)
        parts.append(f"with {correction_name} for multiple comparisons")

    sentence = " ".join(parts) + "."

    if outcome.omnibus is not None:
        sentence += f" {_omnibus_clause(test, outcome.omnibus)}"

    if outcome.comparisons:
        sentence += " " + _comparisons_clause(test, outcome.comparisons, corrected)

    versions = software_versions()
    sentence += (
        f" Significance was assessed at α = {alpha:g}. "
        f"Analyses were performed in Python {versions['python']} "
        f"(SciPy {versions['scipy']}, statsmodels {versions['statsmodels']})."
    )
    return sentence


def _omnibus_clause(test: str, omnibus: Omnibus) -> str:
    if test in ("anova-one-way", "anova-rm") and omnibus.df and len(omnibus.df) == 2:
        return (
            f"The omnibus test was significant "
            f"(F({omnibus.df[0]:.0f}, {omnibus.df[1]:.0f}) = {omnibus.statistic:.2f}, "
            f"{_format_p(omnibus.p)})."
            if omnibus.p < 0.05
            else (
                f"The omnibus test was not significant "
                f"(F({omnibus.df[0]:.0f}, {omnibus.df[1]:.0f}) = {omnibus.statistic:.2f}, "
                f"{_format_p(omnibus.p)})."
            )
        )
    if test == "kruskal-wallis" and omnibus.df:
        return f"H({omnibus.df[0]:.0f}) = {omnibus.statistic:.2f}, {_format_p(omnibus.p)}."
    if test in ("chi-square", "log-rank") and omnibus.df:
        return f"χ²({omnibus.df[0]:.0f}) = {omnibus.statistic:.2f}, {_format_p(omnibus.p)}."
    if test == "anderson-darling":
        # No degrees of freedom to quote: the k-sample A² statistic is
        # standardised against a fixed null distribution rather than referred
        # to a chi-square, so the generic clause below would leave a reader
        # looking for a df that does not exist. The bound matters most here —
        # this is the one test in the app whose p-value is clamped.
        return (
            f"A²k = {omnibus.statistic:.2f}, "
            f"{_format_p_bounded(omnibus.p, omnibus.pBound)}."
        )
    return f"Omnibus statistic = {omnibus.statistic:.2f}, {_format_p(omnibus.p)}."


#: The symbol each distribution test's statistic is published under.
#:
#: These four are the only tests here that return no effect size and no
#: confidence interval, on purpose — the statistic *is* the effect, and
#: inventing a Hedges' g beside it would describe a difference in means none of
#: them looked at. The consequence, found by reading a real methods sentence
#: rather than by reading this file, is that without this the magnitude appears
#: nowhere in the paragraph at all: "Y1 vs Y2: P = 0.03" and nothing else. Every
#: other test carries its magnitude in the effect-size fragment below.
STATISTIC_SYMBOLS = {
    "kolmogorov-smirnov": "D",
    "cramer-von-mises": "T",
    "epps-singleton": "W",
    # The same symbol the omnibus clause uses, so one sentence does not name
    # the same quantity two ways.
    "anderson-darling": "A²k",
}


def _comparisons_clause(test: str, comparisons: list[Comparison], corrected: bool) -> str:
    # Enumerating every pair gets unwieldy past a handful of groups.
    if len(comparisons) > 6:
        return (
            f"Pairwise results for all {len(comparisons)} comparisons "
            "are reported in the figure."
        )

    fragments = []
    for c in comparisons:
        p_value = c.pAdjusted if corrected else c.p
        label = "P_adj" if corrected else "P"
        # A correction moves the p-value off the bracket the test reported, so
        # the bound only describes the raw value. Claiming "P_adj < 0.001" from
        # a bound on the uncorrected p would be a stronger statement than
        # anything that was computed.
        bound = c.pBound if not corrected else None
        symbol = STATISTIC_SYMBOLS.get(test)
        statistic = (
            f"{symbol} = {c.statistic:.3f}, "
            if symbol is not None and np.isfinite(c.statistic)
            else ""
        )
        fragment = (
            f"{c.groupA} vs {c.groupB}: "
            f"{statistic}"
            f"{_format_p_bounded(p_value, bound).replace('P', label, 1)}"
        )
        if c.effectSize is not None and np.isfinite(c.effectSize) and c.effectSizeName:
            fragment += f", {c.effectSizeName} = {c.effectSize:.2f}"
        if c.ci is not None and all(np.isfinite(v) for v in c.ci):
            fragment += f", 95% CI [{c.ci[0]:.3g}, {c.ci[1]:.3g}]"
        fragments.append(fragment)

    return "; ".join(fragments) + "."
