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

from .tests import Comparison, Omnibus, TestOutcome

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
        sentence += " " + _comparisons_clause(outcome.comparisons, corrected)

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
    if test == "chi-square" and omnibus.df:
        return f"χ²({omnibus.df[0]:.0f}) = {omnibus.statistic:.2f}, {_format_p(omnibus.p)}."
    return f"Omnibus statistic = {omnibus.statistic:.2f}, {_format_p(omnibus.p)}."


def _comparisons_clause(comparisons: list[Comparison], corrected: bool) -> str:
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
        fragment = f"{c.groupA} vs {c.groupB}: {_format_p(p_value).replace('P', label, 1)}"
        if c.effectSize is not None and np.isfinite(c.effectSize) and c.effectSizeName:
            fragment += f", {c.effectSizeName} = {c.effectSize:.2f}"
        if c.ci is not None and all(np.isfinite(v) for v in c.ci):
            fragment += f", 95% CI [{c.ci[0]:.3g}, {c.ci[1]:.3g}]"
        fragments.append(fragment)

    return "; ".join(fragments) + "."
