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
import warnings
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
import pandas as pd
from scipy import stats as sps
from statsmodels.stats.anova import AnovaRM
from statsmodels.stats.multitest import multipletests

Alternative = Literal["two-sided", "less", "greater"]
Correction = Literal["none", "bonferroni", "holm", "benjamini-hochberg", "tukey", "dunn"]

#: A p-value that is known only to lie on one side of the reported number.
#: "below" means the true p is smaller than `p`, "above" that it is larger.
PBound = Literal["below", "above"]


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
    #: Set only where the test itself will not commit to a point value — see
    #: `PBound`. Appended with a default because every construction site in
    #: this module passes positionally.
    pBound: PBound | None = None
    #: Where along the measured axis the statistic was attained, for the tests
    #: whose statistic is a quantity read at one place rather than accumulated
    #: over the whole range. Only Kolmogorov-Smirnov sets it: D is the largest
    #: vertical distance between the two empirical CDFs, so it has a location
    #: on the x axis and can be drawn. Cramer-von Mises and Anderson-Darling
    #: integrate over every observation and Epps-Singleton works in the
    #: frequency domain, so for those there is no single x to point at and the
    #: field stays None rather than being filled with something plausible.
    statisticLocation: float | None = None
    #: Which sample's CDF was the higher one at that location: +1 for `groupA`,
    #: -1 for `groupB`. Without it a marker drawn from the location and the
    #: magnitude alone could be placed the wrong way up.
    statisticSign: int | None = None


@dataclass
class Omnibus:
    statistic: float
    p: float
    df: list[float] | None
    #: As `Comparison.pBound`, and appended for the same reason.
    pBound: PBound | None = None


@dataclass
class RegressionFit:
    """The sufficient statistics of an ordinary least-squares fit of y on x.

    Enough to reconstruct the fitted line *and* a pointwise confidence or
    prediction interval at any x, without this module deciding where the plot's
    axes happen to fall. A client evaluates

        y(x)          = intercept + slope * x
        halfWidth(x)  = tMultiplier * residualSe
                        * sqrt(k + 1/n + (x - meanX)**2 / sumSquaredDevX)

    with k = 0 for a confidence band on the fitted line and k = 1 for a
    prediction band on a new observation.

    Ten numbers rather than a sampled polyline, which is what the volcano
    boundary has to store: that boundary needs an incomplete beta to evaluate,
    whereas this needs only arithmetic once `tMultiplier` — the one quantity
    requiring a t quantile — has been resolved here, beside SciPy.
    """

    slope: float
    intercept: float
    #: Pairs the fit was computed from, after dropping rows with a missing value.
    n: int
    meanX: float
    #: Sum of (x - meanX)**2, the term that widens the interval away from the mean.
    sumSquaredDevX: float
    #: Residual standard error, sqrt(SSE / (n - 2)).
    residualSe: float
    #: Two-sided t multiplier at the caller's own alpha, df = n - 2.
    tMultiplier: float
    #: e.g. 0.95 — recorded so a reader of the fit alone knows what it covers.
    confidenceLevel: float
    #: The x range the fit actually used, so a line can span the data and no more.
    xMin: float
    xMax: float


@dataclass
class TestOutcome:
    comparisons: list[Comparison]
    omnibus: Omnibus | None = None
    warnings: list[str] = field(default_factory=list)
    #: Present only for tests that fit a line — see `_regression_fit`.
    fit: RegressionFit | None = None


def _regression_fit(
    x: np.ndarray, y: np.ndarray, alpha: float, fit: object | None = None
) -> RegressionFit | None:
    """The OLS fit of y on x, or None where a line would be a fiction.

    Refused rather than approximated in three cases, each of which produces a
    number that looks like a fit and is not one:

    * fewer than three pairs — df = n - 2 is zero or negative, so there is no
      residual variance to estimate and the "fit" passes exactly through the
      points by construction;
    * every x identical — the line is vertical, `sumSquaredDevX` is zero and the
      interval divides by it;
    * any resulting term non-finite.

    Returning None rather than a record with NaN in it is what keeps a caller
    from drawing half a band.

    The zero-variance test comes *before* `linregress`, which raises rather than
    returning NaN on identical x. Pearson's own `pearsonr` returns NaN there
    without complaint, so fitting first would turn a request that has always
    succeeded into a 422 as a side effect of adding a line to draw.
    """
    n = len(x)
    df = n - 2
    if df <= 0:
        return None

    mean_x = float(np.mean(x))
    sum_sq_dev_x = float(np.sum((x - mean_x) ** 2))
    if not np.isfinite(sum_sq_dev_x) or sum_sq_dev_x <= 0:
        return None

    line = sps.linregress(x, y) if fit is None else fit
    residuals = y - (line.intercept + line.slope * x)
    residual_se = float(np.sqrt(np.sum(residuals**2) / df))
    t_multiplier = float(sps.t.ppf(1 - alpha / 2, df))

    result = RegressionFit(
        slope=float(line.slope),
        intercept=float(line.intercept),
        n=int(n),
        meanX=mean_x,
        sumSquaredDevX=sum_sq_dev_x,
        residualSe=residual_se,
        tMultiplier=t_multiplier,
        confidenceLevel=float(1 - alpha),
        xMin=float(np.min(x)),
        xMax=float(np.max(x)),
    )
    finite = (
        result.slope,
        result.intercept,
        result.meanX,
        result.sumSquaredDevX,
        result.residualSe,
        result.tMultiplier,
        result.xMin,
        result.xMax,
    )
    return result if all(np.isfinite(v) for v in finite) else None


def _clean(values: Sequence[float]) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    return arr[np.isfinite(arr)]


def _contingency_table(groups: dict[str, np.ndarray], names: list[str]) -> np.ndarray:
    """A count table, or a clear error.

    `_clean` drops non-finite values from each row independently, which is right
    for unrelated groups of measurements and wrong here: a table with a missing
    cell in one row comes through ragged, and `np.array` then raises an opaque
    "inhomogeneous shape" error. Contingency counts also genuinely have zeros,
    so a blank cell is a mistake to report rather than a value to skip.
    """
    lengths = {len(groups[n]) for n in names}
    if len(lengths) != 1:
        detail = ", ".join(f'"{n}" has {len(groups[n])}' for n in names)
        raise ValueError(
            "A contingency table needs the same number of counts in every row "
            f"(a blank cell is not a zero): {detail}."
        )

    table = np.array([groups[n] for n in names], dtype=float)
    if table.shape[1] < 2:
        raise ValueError("A contingency table needs at least two categories.")
    if np.any(table < 0):
        raise ValueError("A contingency table cannot contain negative counts.")
    if not np.allclose(table, np.round(table)):
        raise ValueError("A contingency table holds counts, so every cell must be a whole number.")
    if table.sum() <= 0:
        raise ValueError("A contingency table of all zeros has nothing to test.")
    return table


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
    # Named `notes`, not `warnings`: this module imports the stdlib `warnings`
    # module to capture SciPy's own p-value clamp warning, and a local of that
    # name here would shadow it for anyone who later reaches for it.
    notes: list[str] = []

    for name, values in groups.items():
        if len(values) < 3:
            notes.append(f'Group "{name}" has n = {len(values)}; results are unreliable.')
            continue
        if parametric and 3 <= len(values) <= 5000:
            try:
                p = sps.shapiro(values).pvalue
                if p < 0.05:
                    notes.append(
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
                    notes.append(
                        f"Group variances differ (Levene P = {p:.3f}); "
                        "Welch's correction is advisable."
                    )
            except ValueError:
                pass

    return notes


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


#: The distribution tests: they compare two samples' whole shapes rather than
#: one summary of each, which is what makes them the right question to ask of a
#: column of observations drawn as a histogram or an ECDF.
DISTRIBUTION_TESTS = frozenset(
    {"kolmogorov-smirnov", "anderson-darling", "cramer-von-mises", "epps-singleton"}
)

#: Below this many observations per sample, `epps_singleton_2samp` returns NaN
#: rather than raising. Measured against SciPy 1.15.0: n = 4 gives NaN with a
#: `SmallSampleWarning`, n = 5 gives a real statistic.
MIN_EPPS_SINGLETON_N = 5


def _require_two_sided(test: str, alternative: Alternative) -> None:
    """Refuse a directional distribution test rather than silently ignoring it.

    Three of the four take no `alternative` at all — `cramervonmises_2samp` and
    `epps_singleton_2samp` have no such parameter, and `anderson_ksamp` is
    k-sample and inherently omnidirectional. Kolmogorov-Smirnov *does* accept
    one, and it is refused here anyway, deliberately: accepting it for one test
    of four would mean the same dropdown setting silently applied on one plot
    and silently ignored on the next.

    The concrete harm of ignoring it is not abstract. `methods_sentence`
    rewrites its test name whenever `alternative` is directional, so a request
    that quietly dropped the setting would still hand the author a sentence
    reading "one-tailed (lower) two-sample Cramer-von Mises test" to paste into
    a paper — a claim about an analysis that never ran.
    """
    if alternative != "two-sided":
        raise ValueError(
            f"The {test} test is two-sided: it compares the whole shape of two "
            "distributions, so there is no single direction to test. Set the "
            "alternative to two-sided."
        )


def _anderson_ksamp(arrays: list[np.ndarray]) -> tuple[float, float, PBound | None]:
    """Anderson-Darling k-sample, with SciPy's p-value clamp reported as a bound.

    `anderson_ksamp` interpolates its p-value from a published table and
    **clamps the result to [0.001, 0.25]**, emitting a `UserWarning` when it
    does. Passing that clamped number through as a point value would print
    "P = 0.25" for a result the test is only willing to call "larger than 0.25",
    and "P = 0.001" for one it will only call smaller — the second of which a
    reader would take as significant at three decimal places.

    The warning is the only channel SciPy offers for this, so it is captured
    rather than parsed out of the value: `p == 0.25` is also a legitimate
    interpolated answer, and the two cases are indistinguishable from the
    number alone.
    """
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        result = sps.anderson_ksamp(arrays)

    bound: PBound | None = None
    for entry in caught:
        message = str(entry.message)
        if "floored" in message:
            bound = "below"
        elif "capped" in message:
            bound = "above"

    return float(result.statistic), float(result.pvalue), bound


def _check_anderson_darling_inputs(groups: dict[str, np.ndarray]) -> None:
    """Refuse the two inputs on which `anderson_ksamp` misleads or raises.

    A one-observation sample is the dangerous one: SciPy does *not* complain,
    it returns a large negative statistic and a p-value clamped to 0.25 —
    a confident "no difference" derived from a sample that cannot support any
    conclusion at all.

    An entirely constant pooled sample raises `ValueError("anderson_ksamp needs
    more than one distinct observation")`, which already reaches the client as
    a 422; it is pre-empted here only so the message names the author's data
    rather than SciPy's internals.
    """
    small = [name for name, values in groups.items() if len(values) < 2]
    if small:
        raise ValueError(
            "The Anderson-Darling k-sample test needs at least two observations in "
            f"every group; {', '.join(sorted(small))} has fewer. With one observation "
            "the test reports a difference of nothing at all rather than refusing."
        )

    pooled = np.concatenate(list(groups.values()))
    if len(np.unique(pooled)) < 2:
        raise ValueError(
            "Every observation across all groups is the same value, so there is no "
            "distribution to compare."
        )


def _check_epps_singleton_inputs(groups: dict[str, np.ndarray]) -> None:
    """Refuse below the sample size at which SciPy stops returning a number.

    This is a hard refusal rather than a warning because of what happens
    downstream if it is not: `epps_singleton_2samp` returns NaN below
    `MIN_EPPS_SINGLETON_N`, and `main.py`'s `_sanitize_or(c.p, 1.0)` turns a
    non-finite p into **1.0** — so the figure would report a perfectly
    confident null result computed from nothing. The empirical characteristic
    function this test compares is estimated from too few points to be one.
    """
    small = {
        name: len(values) for name, values in groups.items() if len(values) < MIN_EPPS_SINGLETON_N
    }
    if small:
        detail = ", ".join(f'"{name}" has {n}' for name, n in sorted(small.items()))
        raise ValueError(
            f"The Epps-Singleton test needs at least {MIN_EPPS_SINGLETON_N} observations "
            f"per group ({detail}). Below that it returns no result at all rather than "
            "a weak one."
        )


def _logrank_terms(
    times_list: list[np.ndarray], events_list: list[np.ndarray]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per-group observed/expected event counts and the log-rank covariance matrix.

    The standard Mantel-Haenszel construction — what R's `survival::survdiff`
    computes. At every time any group has an event, that time's events are
    allocated across groups in proportion to each group's share of the
    combined risk set (`expected`), and the multivariate hypergeometric
    variance at that time is accumulated into a full K x K covariance matrix
    — the same "at risk" definition (a subject's own time, event or
    censoring, is >= t) `packages/plots`'s `kaplanMeier` estimator uses.
    """
    k = len(times_list)
    event_times = [t[e] for t, e in zip(times_list, events_list, strict=True) if np.any(e)]
    all_times = np.unique(np.concatenate(event_times)) if event_times else np.array([])

    observed = np.zeros(k)
    expected = np.zeros(k)
    cov = np.zeros((k, k))

    for t in all_times:
        at_risk = np.array([np.sum(times >= t) for times in times_list], dtype=float)
        d_g = np.array(
            [
                np.sum((times == t) & events)
                for times, events in zip(times_list, events_list, strict=True)
            ],
            dtype=float,
        )
        n = at_risk.sum()
        d = d_g.sum()
        if n <= 0:
            continue
        observed += d_g
        expected += d * (at_risk / n)
        # A single subject at risk contributes no variance (n - 1 = 0), and a
        # time with no event contributes neither an expected share nor any
        # variance — d = 0 makes the `factor` term vanish on its own.
        if n > 1:
            factor = d * (n - d) / (n - 1)
            p = at_risk / n
            cov += factor * (np.diag(p) - np.outer(p, p))

    return observed, expected, cov


def _logrank_chi2(
    observed: np.ndarray, expected: np.ndarray, cov: np.ndarray
) -> tuple[float, int, float]:
    """Reduce K groups' observed/expected/covariance to a chi-square statistic.

    `cov`'s rows and columns each sum to zero by construction (a fixed number
    of events at each time is *reallocated*, not created), so it is singular
    and one group is dropped before inverting — the standard reduction, and
    what R's `survdiff` does. Singular even after dropping a group means the
    groups' risk sets never genuinely overlap; refused rather than pseudo-
    inverted into a number that would not mean what a chi-square usually means.
    """
    k = len(observed)
    diff = (observed - expected)[:-1]
    sub_cov = cov[:-1, :-1]
    df = k - 1
    try:
        inv = np.linalg.inv(sub_cov)
    except np.linalg.LinAlgError as err:
        raise ValueError(
            "Log-rank test: these groups' risk sets never overlap; nothing to compare."
        ) from err
    chi2 = float(diff @ inv @ diff)
    p = float(sps.chi2.sf(chi2, df))
    return chi2, df, p


def _logrank_pairwise(
    na: str, times_a: np.ndarray, events_a: np.ndarray,
    nb: str, times_b: np.ndarray, events_b: np.ndarray,
) -> Comparison:
    observed, expected, cov = _logrank_terms([times_a, times_b], [events_a, events_b])
    chi2, df, p = _logrank_chi2(observed, expected, cov)
    # The observed/expected ratio hazard-ratio approximation (Peto & Peto
    # 1972) — not a Cox-model MLE, but a standard, widely cited estimate built
    # from the same quantities the log-rank statistic already computes.
    # Documented as an approximation rather than presented as the thing it
    # resembles, the same stance Fisher's odds ratio takes on its own
    # documented divergence from R's conditional MLE.
    hr = (
        (observed[0] / expected[0]) / (observed[1] / expected[1])
        if expected[0] > 0 and expected[1] > 0 and observed[1] > 0
        else float("nan")
    )
    return Comparison(
        na, nb, chi2, p, p, float(df), None,
        float(hr) if np.isfinite(hr) else None,
        "Hazard ratio (O/E)" if np.isfinite(hr) else None,
        [len(times_a), len(times_b)],
    )


def run_test(
    test: str,
    groups: dict[str, Sequence[float]],
    alternative: Alternative = "two-sided",
    correction: Correction = "none",
    alpha: float = 0.05,
    welch: bool = True,
    x: Sequence[float] | None = None,
    x_name: str = "x",
    events: dict[str, Sequence[float]] | None = None,
) -> TestOutcome:
    if x is not None:
        # A series correlated against its own x column (e.g. a scatter plot's
        # simple-xy dataset) arrives as one named series plus a separate x
        # array, not two named series. Fold it into the two-key shape every
        # dispatch branch below already expects, so nothing past this point
        # needs to know the difference.
        if test not in ("pearson", "spearman", "linear-regression"):
            raise ValueError(f'"{test}" does not accept a separate x series; provide two groups.')
        if len(groups) != 1:
            raise ValueError("Correlating a series against its own x needs exactly one series.")
        (series_name, values), = groups.items()
        if series_name == x_name:
            raise ValueError(f'The series and its x-axis cannot both be named "{x_name}".')
        if len(x) != len(values):
            raise ValueError("x and the series must have the same number of points.")
        xs = np.asarray(x, dtype=float)
        ys = np.asarray(values, dtype=float)
        # A NaN in either column must drop that whole pair together; cleaning
        # each column independently (as the generic path below does for
        # unrelated groups) would shift x and y out of alignment.
        mask = np.isfinite(xs) & np.isfinite(ys)
        groups = {x_name: xs[mask].tolist(), series_name: ys[mask].tolist()}

    cleaned_events: dict[str, np.ndarray] | None = None
    if test == "log-rank":
        if events is None or set(events) != set(groups):
            raise ValueError(
                "Log-rank test needs a matching 0/1 event flag for every subject in "
                "every group."
            )
        cleaned = {}
        cleaned_events = {}
        for name, times in groups.items():
            flags = events[name]
            if len(flags) != len(times):
                raise ValueError(
                    f'Group "{name}" has {len(times)} times but {len(flags)} event flags; '
                    "they must be index-aligned and the same length."
                )
            # Times and their event flags are cleaned together, not
            # independently — a NaN in either column must drop the whole
            # pair, the same rule the `x`/`x_name` pairing follows above;
            # cleaning each column on its own would shift a time onto the
            # wrong flag.
            times_arr = np.asarray(times, dtype=float)
            flags_arr = np.asarray(flags, dtype=float)
            mask = np.isfinite(times_arr) & np.isfinite(flags_arr)
            cleaned[name] = times_arr[mask]
            cleaned_events[name] = flags_arr[mask] != 0
    else:
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
    # Assumption checks read each group as a sample of measurements. A
    # contingency row is a set of *category counts*, so "n = 2" would mean two
    # categories, not two observations — a warning that is simply about the
    # wrong thing. The count tests carry their own validation instead. A
    # log-rank "group" is a set of follow-up times, not measurements either —
    # Shapiro/Levene say nothing meaningful about a time-to-event sample.
    #
    # The distribution tests are deliberately NOT skipped here, though the
    # obvious argument says they should be: warning that a distribution-free
    # test's input is non-normal would indeed be backwards. It cannot happen.
    # `check_assumptions` runs Shapiro and Levene only when `parametric` is
    # true, and none of these four is in that set — measured, not reasoned
    # about, after a test written to pin the skip passed just as happily with
    # the skip removed. What the checks actually contribute for these tests is
    # the small-sample warning, and that one is if anything more apt here than
    # elsewhere: a two-sample Kolmogorov-Smirnov at n = 2 is very nearly
    # powerless, and saying so is the whole job of an advisory warning.
    counts = test in ("chi-square", "fisher")
    checks = [] if (counts or test == "log-rank") else check_assumptions(cleaned, parametric)
    outcome = _dispatch(test, cleaned, alternative, alpha, welch, cleaned_events)
    outcome.warnings = checks + outcome.warnings

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
    events: dict[str, np.ndarray] | None = None,
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

    if test == "anova-rm":
        # run_test's generic "at least two groups" check above already rules
        # out a single condition before dispatch is reached.
        arrays = [groups[n] for n in names]
        lengths = {len(a) for a in arrays}
        if len(lengths) != 1:
            # Row order is the only signal this shape has for subject identity
            # (the same convention ttest-paired already relies on for two
            # groups), so an unequal count can't be resolved - which subject
            # would be missing which condition is not knowable from the data.
            detail = ", ".join(f'"{n}" has {len(a)}' for n, a in zip(names, arrays, strict=True))
            raise ValueError(
                "Repeated-measures ANOVA needs the same number of subjects in every "
                f"condition (row order is treated as subject identity): {detail}."
            )
        n_subjects = lengths.pop()
        if n_subjects < 2:
            raise ValueError("Repeated-measures ANOVA needs at least two subjects.")

        long_df = pd.DataFrame({
            "value": np.concatenate(arrays),
            "condition": np.repeat(names, n_subjects),
            "subject": np.tile(np.arange(n_subjects), len(names)),
        })
        fit = AnovaRM(long_df, depvar="value", subject="subject", within=["condition"]).fit()
        row = fit.anova_table.loc["condition"]
        f_stat = float(row["F Value"])
        df1 = float(row["Num DF"])
        df2 = float(row["Den DF"])
        p = float(row["Pr > F"])

        # Pairwise follow-ups use the same paired convention as ttest-paired;
        # correction is applied by the caller, consistent with anova-one-way.
        def run(na, a, nb, b):
            result = sps.ttest_rel(a, b, alternative="two-sided")
            differences = a - b
            n = len(differences)
            sd_diff = differences.std(ddof=1) if n > 1 else 0.0
            d = float(differences.mean() / sd_diff) if sd_diff > 0 else float("nan")
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                float(n - 1), None, d, "Cohen's dz", [len(a), len(b)],
            )

        return TestOutcome(_pairwise(groups, run), Omnibus(f_stat, p, [df1, df2]))

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

    if test in DISTRIBUTION_TESTS:
        _require_two_sided(test, alternative)

    if test == "kolmogorov-smirnov":
        # Two-sample, so pairwise with no omnibus — the shape `wilcoxon`
        # already uses. No df, no confidence interval and no effect size: D is
        # itself the effect, being the largest gap between the two empirical
        # CDFs, and inventing a Hedges' g beside it would describe a difference
        # in means the test never looked at.
        def run(na, a, nb, b):
            result = sps.ks_2samp(a, b, alternative="two-sided")
            # `statistic_location` and `statistic_sign` are what let the gap be
            # drawn on an ECDF rather than only tabulated. They are taken from
            # SciPy rather than re-derived on the client: recomputing the
            # argmax there would be a second answer to a question this one has
            # already settled, and the two would disagree wherever a tie makes
            # the maximum non-unique.
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                None, None, None, None, [len(a), len(b)], None,
                float(result.statistic_location), int(result.statistic_sign),
            )

        return TestOutcome(_pairwise(groups, run))

    if test == "cramer-von-mises":
        # Integrates the squared distance between the two ECDFs over the whole
        # range rather than reading only its maximum, so it notices a
        # difference spread thinly across the distribution that KS can miss.
        def run(na, a, nb, b):
            result = sps.cramervonmises_2samp(a, b)
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                None, None, None, None, [len(a), len(b)],
            )

        return TestOutcome(_pairwise(groups, run))

    if test == "epps-singleton":
        _check_epps_singleton_inputs(groups)

        # Compares empirical characteristic functions, so unlike the other
        # three it is not rank-based — which is what makes it sensitive to
        # differences in spread that leave the ECDFs close together.
        def run(na, a, nb, b):
            result = sps.epps_singleton_2samp(a, b)
            return Comparison(
                na, nb, float(result.statistic), float(result.pvalue), float(result.pvalue),
                None, None, None, None, [len(a), len(b)],
            )

        return TestOutcome(_pairwise(groups, run))

    if test == "anderson-darling":
        _check_anderson_darling_inputs(groups)

        # The one genuinely k-sample test of the four, so it takes the
        # omnibus-plus-pairwise shape `anova-one-way` and `kruskal-wallis`
        # already use rather than being reduced to a series of pairs.
        arrays = [groups[n] for n in names]
        statistic, p, bound = _anderson_ksamp(arrays)

        def run(na, a, nb, b):
            pair_stat, pair_p, pair_bound = _anderson_ksamp([a, b])
            return Comparison(
                na, nb, pair_stat, pair_p, pair_p,
                None, None, None, None, [len(a), len(b)], pair_bound,
            )

        # `df` is None on purpose: the k-sample A² statistic is standardised to
        # a fixed null distribution rather than referred to a chi-square with
        # degrees of freedom, so reporting a number there would name a quantity
        # the test does not have.
        return TestOutcome(_pairwise(groups, run), Omnibus(statistic, p, None, bound))

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
        # Pearson carries the least-squares line as well: r measures how tightly
        # the pairs sit on a straight line, so the line itself is what a reader
        # is being asked to judge. Spearman does not — it measures a monotonic
        # relationship between *ranks*, and a straight line through the raw
        # values would claim a linearity the statistic never tested. Withheld
        # rather than approximated, the stance Fisher's above 2x2 already takes.
        fit = _regression_fit(a, b, alpha) if test == "pearson" else None
        return TestOutcome(
            [
                Comparison(
                    names[0], names[1], r, float(result.pvalue), float(result.pvalue),
                    float(len(a) - 2), ci, r * r, "r²", [len(a), len(b)],
                )
            ],
            fit=fit,
        )

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
        return TestOutcome(
            [
                Comparison(
                    names[0], names[1], float(fit.slope), float(fit.pvalue), float(fit.pvalue),
                    float(df), ci, float(fit.rvalue ** 2), "R²", [len(x), len(y)],
                )
            ],
            # The same `linregress` result the comparison above reports, passed
            # through rather than recomputed: one fit, so the drawn line can
            # never disagree with the slope printed beside it.
            fit=_regression_fit(x, y, alpha, fit),
        )

    if test == "log-rank":
        assert events is not None  # run_test validates this before dispatch
        times_list = [groups[n] for n in names]
        events_list = [events[n] for n in names]
        observed, expected, cov = _logrank_terms(times_list, events_list)
        chi2, df, p = _logrank_chi2(observed, expected, cov)

        def run(na, a, nb, b):
            return _logrank_pairwise(na, a, events[na], nb, b, events[nb])

        return TestOutcome(_pairwise(groups, run), Omnibus(chi2, p, [float(df)]))

    if test in ("chi-square", "fisher"):
        # Groups are rows of a contingency table.
        table = _contingency_table(groups, names)

    if test == "fisher":
        # SciPy has no exact test beyond 2x2, and there is no honest way to
        # approximate one: the whole point of Fisher's is that it is exact.
        # Refused with the shape that was actually supplied, so the author can
        # see what to collapse.
        if table.shape != (2, 2):
            raise ValueError(
                "Fisher's exact test needs a 2x2 table; this one is "
                f"{table.shape[0]}x{table.shape[1]}. Use the chi-square test, or collapse "
                "the table to two rows and two columns."
            )
        odds_ratio, p = sps.fisher_exact(table, alternative=alternative)
        return TestOutcome(
            [
                Comparison(
                    names[0], names[1],
                    float(odds_ratio), float(p), float(p), float("nan"), None,
                    float(odds_ratio), "Odds ratio", [int(row.sum()) for row in table],
                )
            ],
            # No omnibus statistic: Fisher's returns a p-value directly, and
            # inventing a chi-square to sit beside it would invite reporting a
            # number this test never computed.
            None,
        )

    if test == "chi-square":
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
