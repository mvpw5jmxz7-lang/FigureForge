"""Perseus-style permutation-based (SAM) volcano significance.

Tusher, Tibshirani & Chu, "Significance analysis of microarrays applied to
the ionizing radiation response", PNAS 2001 — the permutation method
Perseus's own volcano test adapts, for both designs the paper describes:
**two-sample** (two groups of raw replicate measurements) and **one-sample**
(a single set of replicate values — e.g. per-replicate log2 ratios already
computed elsewhere — tested against zero). Nothing here knows about figures
or rendering, the same framing `pca.py`/`umap.py` use.

No SciPy implementation exists to wrap (the same situation as this app's
log-rank test) and no external reference value exists to verify this
against (the same situation as UMAP) — see `test_sam_volcano.py`'s own
docstring for the invariants this is verified against instead.

The algorithm, in order (two-sample; one-sample differs only in how `d`,
`s` and the permutation null are built — see `compute_sam_volcano_one_sample`
and `_resolve_significance` below):

1. Per row (protein), given two groups of replicate values: a pooled
   standard error `s`, `log2FoldChange = mean(B) - mean(A)`, and the SAM
   statistic `d = log2FoldChange / (s + s0)`.
2. A permutation null: every relabelling of the combined samples into groups
   of the observed sizes (exhaustive when that count is small enough,
   otherwise a fixed-seed Monte Carlo sample — reproducible, the same
   determinism stance this app's seeded UMAP run already takes). For each
   permutation, the *sorted* (ascending, across proteins) `d` values; their
   average across permutations gives the expected order statistic `dE`.
3. For a candidate `delta`, `cutup`/`cutlow` are found by the SAM paper's own
   published rule: starting from the most extreme real `d` and moving
   inward, stop at the first rank where `d - dE` (or `dE - d`, mirrored)
   drops below `delta`. Both boundaries are monotonic functions of rank by
   construction (a suffix-min and a prefix-min, respectively), so they are
   found by a binary search rather than a fresh scan per query.
4. The estimated FDR at a `delta` is the median (across permutations) count
   of permuted values beyond `cutup`/`cutlow`, divided by the number of real
   proteins beyond them. `delta` is solved, over a bounded grid (not one
   evaluation per protein — the same practical bound published SAM
   implementations use), for the smallest value hitting the requested
   target FDR without exceeding it.
5. A per-protein q-value: the smallest FDR at which that protein would still
   be called, read off the same (monotonized) delta/FDR grid — never
   evaluated as a fresh permutation pass per protein, which would not scale
   to a real protein list.
6. A curve for plotting: at the resolved `cutup`/`cutlow`, a standard error
   `s` gives a boundary fold change (`cutup * (s + s0)` / `cutlow * (s + s0)`)
   and, converting that boundary d back to a t-statistic on that same `s`
   (not `s + s0`), a boundary p-value. Both are monotonic functions of `s`
   for a fixed `cut`/`s0`/degrees of freedom — constant across every row,
   since every protein shares the same replicate/group counts — so sorting
   the points by fold change, which the renderer already does, traces a true
   single-valued curve.

   `s` is swept over a wide geometric grid rather than taken from the
   proteins themselves, and that distinction is the whole point. Evaluating
   it once per protein sounds like the more faithful choice and is not: it
   confines the drawn boundary to whichever standard errors the experiment
   happened to produce. Measured on a real 100-protein export, those spanned
   `s` in [0.064, 0.109], and the resulting curve covered 0.6% of the plot's
   width and 4% of its height — pressed against the axes as a
   sub-millimetre dash, reported as no boundary at all. The boundary is
   defined for every `s > 0`; sampling it across that range is the *same*
   computation evaluated at more places, not a hyperbola fitted to it, and
   it is what lets the curve reach the edges of whatever window the axes
   show. `packages/render`'s own `clipPolylineToRect` then trims the sweep
   to the panel, interpolating the crossings.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations, product
from math import comb

import numpy as np
from scipy import stats

from .stats.methods import software_versions

# A bounded, not-user-exposed resolution for the delta/FDR search and the
# per-protein q-value lookup — the same kind of defensive constant as
# `MAX_PCA_SAMPLES`, chosen so the search cost is a fixed, small multiple of
# one permutation pass rather than growing with the protein count.
N_DELTA_GRID = 200

# Enumerate every relabelling (two-sample) or every sign flip (one-sample)
# when there are few enough to; a typical proteomics design (3v3, 4v4
# replicates, or 3-10 one-sample replicates) is comfortably below this.
# Above it, sample a fixed number of random relabellings/flips instead.
MAX_EXHAUSTIVE_PERMUTATIONS = 2000
MONTE_CARLO_PERMUTATIONS = 1000

# How the significance boundary is sampled for drawing. Geometric, not linear:
# the curve's own curvature is concentrated near its vertical asymptote
# (`cut * s0`, approached as `s -> 0`), which is exactly where the points need
# to be dense. `CURVE_S_SPAN` is how far past the observed standard errors the
# sweep runs in each direction — generous on purpose, because the boundary has
# to reach the edges of an axis range this module never sees. See the module
# docstring's item 6 for what confining it to the observed range cost.
#
# The sample count answers *resolution*, which is a separate requirement from
# reach and the one that binds: the sweep covers six-odd decades of `s`, and the
# curve is also what decides each point's colour (`volcanoCurveClassifier` in
# `packages/plots`), so the error of interpolating between samples has to stay
# well under the tolerance that classifier allows. Measured on a real export,
# the worst such error is 1.9e-4 at 256 samples and 1.6e-5 at 1024 — the latter
# comfortably inside the 1e-4 tolerance, the former not.
CURVE_SAMPLE_POINTS = 1024
CURVE_S_SPAN = 1000.0

# Fixed, not user-exposed: repeated runs against the same matrix are
# reproducible, the same determinism stance `umap.py`'s own seeded run
# already takes — nothing about this document model requires it, but a
# volcano test that answered differently each click would be its own defect.
_SEED = 20260830


@dataclass
class SamVolcanoRow:
    label: str
    # For a two-sample test this is `mean(B) - mean(A)`; for a one-sample
    # test it is the mean of the replicate values themselves — the same
    # field name because both feed the identical downstream 4-column
    # differential dataset (Feature, log2FoldChange, pValue, qValue).
    log2FoldChange: float
    pValue: float
    qValue: float
    category: str  # 'up' | 'down' | 'ns'


@dataclass
class SamVolcanoOutcome:
    rows: list[SamVolcanoRow]
    # (log2FoldChange, -log10 p) points sampled along each branch, unsorted.
    curveUp: list[tuple[float, float]]
    curveDown: list[tuple[float, float]]
    droppedRows: list[str]
    warnings: list[str]
    deltaUsed: float
    fdrAchieved: float
    # The two resolved cutoffs on `d`, reported rather than left implicit
    # because they are *not* mirror images of each other: SAM walks inward
    # from each tail independently, so each is judged against its own side of
    # the permutation null and they coincide only when the data is symmetric.
    # Since each branch's vertical asymptote sits at `cut * s0`, the visible
    # gap between them grows in proportion to `s0` — which is what makes this
    # worth stating in the methods rather than leaving a reader to wonder.
    cutUp: float
    cutLow: float
    # What the permutation step actually did, not what it defaults to:
    # `MAX_EXHAUSTIVE_PERMUTATIONS` decides at run time, and a methods
    # sentence claiming an exhaustive enumeration that did not happen would be
    # exactly the kind of unverifiable statement this app exists to prevent.
    permutations: int
    permutationsExhaustive: bool
    methodsSentence: str


def _group_stats(a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per-row fold change and the pooled SAM denominator `s`.

    Pooled across both groups (not Welch), matching the classic two-sample
    SAM statistic's own construction. `values` are assumed already
    log2-scale intensities, the standard proteomics convention Perseus
    itself assumes — `log2FoldChange` is a plain difference of means.
    """
    n_a, n_b = a.shape[1], b.shape[1]
    mean_a, mean_b = a.mean(axis=1), b.mean(axis=1)
    var_a = a.var(axis=1, ddof=1) if n_a > 1 else np.zeros(a.shape[0])
    var_b = b.var(axis=1, ddof=1) if n_b > 1 else np.zeros(b.shape[0])
    pooled_var = ((n_a - 1) * var_a + (n_b - 1) * var_b) / max(n_a + n_b - 2, 1)
    s = np.sqrt(pooled_var * (1.0 / n_a + 1.0 / n_b))
    fold_change = mean_b - mean_a
    return fold_change, s


def _resolve_significance(
    d: np.ndarray,
    s: np.ndarray,
    effect: np.ndarray,
    sorted_perm_d: np.ndarray,
    s0: float,
    fdr_percent: float,
    df: int,
) -> tuple[
    np.ndarray,
    np.ndarray,
    float,
    float,
    float,
    float,
    list[tuple[float, float]],
    list[tuple[float, float]],
]:
    """Steps 3-6 above, shared by the two-sample and one-sample paths.

    `d`/`s`/`effect` are per-row (real data); `sorted_perm_d` is
    `(n_permutations, n_rows)`, each row already sorted ascending across
    proteins. `df` is the single degrees-of-freedom value every row shares
    (constant because every protein has the same replicate/group counts),
    which is what lets the curve be evaluated once per branch here rather
    than per protein with its own df.

    Returns `(categories, q_values, delta_used, fdr_achieved, cutup, cutlow,
    curveUp, curveDown)`.
    """
    n_rows = d.shape[0]

    order = np.argsort(d)
    d_sorted = d[order]
    dE = sorted_perm_d.mean(axis=0)
    diffs = d_sorted - dE
    neg_diffs = dE - d_sorted

    # `suf_min[i] = min(diffs[i:])` — non-decreasing in `i`, since the suffix
    # it is taken over only shrinks. `cutup(delta)` is then the smallest `i`
    # with `suf_min[i] >= delta`, found by binary search rather than a fresh
    # scan — this is exactly the SAM paper's own "move inward until the
    # first violation" rule, expressed as a lookup.
    suf_min = np.minimum.accumulate(diffs[::-1])[::-1]
    # `pre_min[i] = min(neg_diffs[:i+1])` — non-increasing in `i`. `cutlow`
    # is the largest `i` with `pre_min[i] >= delta`.
    pre_min = np.minimum.accumulate(neg_diffs)
    pre_min_rev = pre_min[::-1]  # non-decreasing

    def cutoffs_at(delta: float) -> tuple[float, float]:
        i = int(np.searchsorted(suf_min, delta, side="left"))
        cutup = float(d_sorted[i]) if i < n_rows else float("inf")
        k = int(np.searchsorted(pre_min_rev, delta, side="left"))
        m = n_rows - 1 - k
        cutlow = float(d_sorted[m]) if m >= 0 else float("-inf")
        return cutup, cutlow

    def fdr_at(delta: float) -> float:
        cutup, cutlow = cutoffs_at(delta)
        real_sig = int(np.sum((d >= cutup) | (d <= cutlow)))
        false_pos = ((sorted_perm_d >= cutup) | (sorted_perm_d <= cutlow)).sum(axis=1)
        expected_false_pos = float(np.median(false_pos))
        return expected_false_pos / max(1, real_sig)

    max_delta = max(float(diffs.max(initial=0.0)), float(neg_diffs.max(initial=0.0)), 0.0)
    grid = np.linspace(0.0, max_delta, N_DELTA_GRID) if max_delta > 0 else np.zeros(1)
    fdr_grid = np.array([fdr_at(g) for g in grid])
    # FDR is not truly monotonic in `delta` once estimated from a finite
    # permutation sample — a running minimum enforces the conservative
    # reading (never overstate significance at a stricter delta than one
    # already known to hit a lower FDR).
    fdr_monotonic = np.minimum.accumulate(fdr_grid)

    target = fdr_percent / 100.0
    hits = np.nonzero(fdr_monotonic <= target)[0]
    delta_idx = int(hits[0]) if hits.size > 0 else len(grid) - 1
    delta_used = float(grid[delta_idx])
    fdr_achieved = float(fdr_monotonic[delta_idx])

    cutup, cutlow = cutoffs_at(delta_used)
    categories = np.where(d >= cutup, "up", np.where(d <= cutlow, "down", "ns"))

    # Per-protein q-value: the smallest FDR at which this protein's own rank
    # would still clear the boundary, read off the same grid rather than a
    # fresh permutation pass per protein. `rank` maps original index -> its
    # position in the ascending-sorted arrays above.
    rank = np.empty(n_rows, dtype=int)
    rank[order] = np.arange(n_rows)
    q_up = np.interp(suf_min[rank], grid, fdr_monotonic)
    q_down = np.interp(pre_min[rank], grid, fdr_monotonic)
    # A boundary below the grid's own floor (0) means this protein is never
    # called even at the loosest delta — `np.interp` would otherwise clip it
    # to the grid's first FDR value, which understates how insignificant it
    # is.
    q_up = np.where(suf_min[rank] < 0, 1.0, q_up)
    q_down = np.where(pre_min[rank] < 0, 1.0, q_down)
    q_values = np.minimum(q_up, q_down)

    # --- Curve for plotting ------------------------------------------------
    # The boundary effect size at a given standard error, converted back to a
    # p-value on that same `s` (never `s + s0` — that denominator exists only
    # in `d`, not in the real test statistic) through the shared, dataset-wide
    # degrees of freedom.
    #
    # Swept over a wide geometric grid of `s`, not evaluated at the proteins'
    # own standard errors: the boundary is defined for every `s > 0`, and
    # confining it to the handful of values one experiment produced is what
    # collapsed it into an invisible sliver. See the module docstring's item 6.
    finite_s = s[np.isfinite(s) & (s > 0)]
    if finite_s.size > 0:
        s_lo = float(finite_s.min()) / CURVE_S_SPAN
        s_hi = float(finite_s.max()) * CURVE_S_SPAN
    else:
        # Every protein had zero within-group variance. There is no observed
        # scale to bracket, but the asymptote `cut * s0` is still well defined,
        # so the sweep is centred on `s0` rather than abandoned.
        s_lo = s0 / CURVE_S_SPAN if s0 > 0 else 1e-6
        s_hi = s0 * CURVE_S_SPAN if s0 > 0 else 1.0
    s_grid = np.geomspace(s_lo, s_hi, CURVE_SAMPLE_POINTS)

    def curve_points(cut: float) -> list[tuple[float, float]]:
        if not np.isfinite(cut):
            return []
        boundary_effect = cut * (s_grid + s0)
        with np.errstate(invalid="ignore", divide="ignore"):
            boundary_t = boundary_effect / s_grid
            boundary_p = 2 * stats.t.sf(np.abs(boundary_t), df)
        pts: list[tuple[float, float]] = []
        # `p > 0` is what bounds the top of the sweep: a boundary p-value
        # underflows to exactly 0.0 well before `s` reaches the floor of the
        # grid, and the last surviving point already sits far above any real
        # volcano axis — so the segment leading to it crosses the top edge and
        # the renderer's own clipping interpolates the crossing.
        for fc, p in zip(boundary_effect.tolist(), boundary_p.tolist(), strict=True):
            if not (np.isfinite(fc) and np.isfinite(p) and p > 0):
                continue
            pts.append((fc, -np.log10(p)))
        return pts

    return (
        categories,
        q_values,
        delta_used,
        fdr_achieved,
        cutup,
        cutlow,
        curve_points(cutup),
        curve_points(cutlow),
    )


def sam_methods_sentence(
    *,
    mode: str,
    s0: float,
    fdr_percent: float,
    fdr_achieved: float,
    delta_used: float,
    cut_up: float,
    cut_low: float,
    n_tested: int,
    n_up: int,
    n_down: int,
    n_permutations: int,
    exhaustive: bool,
) -> str:
    """A ready-to-paste manuscript sentence for the volcano test.

    Composed here, beside the numbers it describes, exactly as
    `stats/methods.py` does for every other test in this app — the alternative
    is re-deriving the wording in the client from stored parameters, which is
    how a figure and its own methods text come to disagree.

    Two things it deliberately reports that a shorter sentence would omit:

    * **The permutation scheme that actually ran.** `MAX_EXHAUSTIVE_PERMUTATIONS`
      decides at run time, so claiming an exhaustive enumeration that did not
      happen would be an unverifiable statement in someone's methods section.
    * **Both cutoffs.** They are not mirror images: SAM walks inward from each
      tail independently, so each is judged against its own side of the
      permutation null, and they coincide only when the data is symmetric.
      Stating both is what lets a reader account for two branches sitting at
      different distances from zero.
    """
    versions = software_versions()
    design = (
        "two-sample (unpaired, pooled variance)"
        if mode == "two-sample"
        else "one-sample (sign-flip)"
    )
    scheme = (
        f"all {n_permutations} possible {'relabellings' if mode == 'two-sample' else 'sign flips'}"
        if exhaustive
        else f"{n_permutations} random {'relabellings' if mode == 'two-sample' else 'sign flips'}"
    )
    return (
        f"Differential abundance was assessed by a Perseus-style SAM permutation test "
        f"(Tusher, Tibshirani & Chu, PNAS 2001) on {n_tested} features, using a {design} "
        f"statistic regularized with S0 = {s0:g} and a permutation null over {scheme}. "
        f"The significance boundary was chosen as the least stringent delta reaching the "
        f"target false discovery rate of {fdr_percent:g}%, giving delta = {delta_used:.3f} "
        f"and an achieved FDR of {fdr_achieved * 100:.1f}%. "
        f"Because SAM resolves each tail against its own side of the permutation null, the "
        f"two cutoffs are independent and need not be symmetric: d >= {cut_up:.3f} for "
        f"enrichment and d <= {cut_low:.3f} for depletion, which called {n_up} features up "
        f"and {n_down} down. "
        f"Analyses were performed in Python {versions['python']} "
        f"(NumPy {versions['numpy']}, SciPy {versions['scipy']})."
    )


def _complete_rows(
    row_labels: list[str], values: list[list[float | None]], used_indices: list[int]
) -> tuple[np.ndarray, list[str], list[str]]:
    """Shared row-cleaning: an array of only the columns this test uses,
    with any row missing a value in one of them dropped and reported —
    the same "clean rows together" convention every mode here follows."""
    arr = np.array(
        [[np.nan if v is None else v for v in row] for row in values],
        dtype=float,
    )
    if arr.size == 0 or arr.shape[1] == 0:
        raise ValueError("No columns supplied.")
    if max(used_indices) >= arr.shape[1]:
        raise ValueError("A column index is out of range for the supplied columns.")

    used = arr[:, used_indices]
    complete = ~np.isnan(used).any(axis=1)
    dropped = [row_labels[i] for i in range(len(row_labels)) if not complete[i]]
    kept_labels = [row_labels[i] for i in range(len(row_labels)) if complete[i]]
    return arr[complete][:, used_indices], kept_labels, dropped


def compute_sam_volcano(
    row_labels: list[str],
    values: list[list[float | None]],
    group_a_indices: list[int],
    group_b_indices: list[int],
    s0: float,
    fdr_percent: float,
) -> SamVolcanoOutcome:
    if len(row_labels) != len(values):
        raise ValueError("row_labels and values must have the same length.")
    if len(group_a_indices) < 2 or len(group_b_indices) < 2:
        raise ValueError("Each group needs at least 2 replicate columns.")
    if set(group_a_indices) & set(group_b_indices):
        raise ValueError("Group A and Group B cannot share a column.")
    if s0 < 0:
        raise ValueError("s0 must be non-negative.")
    if not (0 < fdr_percent <= 100):
        raise ValueError("fdr_percent must be between 0 and 100.")

    used_ab, kept_labels, dropped = _complete_rows(
        row_labels, values, group_a_indices + group_b_indices
    )
    n_a, n_b = len(group_a_indices), len(group_b_indices)
    a = used_ab[:, : len(group_a_indices)]
    b = used_ab[:, len(group_a_indices) :]
    n_rows = a.shape[0]
    df = n_a + n_b - 2

    if n_rows < 4:
        raise ValueError(
            f"The SAM volcano test needs at least 4 complete rows; only {n_rows} "
            f"remain after dropping {len(dropped)} with a missing value in either group."
        )

    fold_change, s = _group_stats(a, b)
    d = fold_change / (s + s0)

    with np.errstate(invalid="ignore", divide="ignore"):
        t_stat = fold_change / s
        p_value = 2 * stats.t.sf(np.abs(t_stat), df)
    # A row with zero variance in both groups has an undefined t-statistic:
    # a perfect, noiseless difference reads as maximally significant, and no
    # difference at all as entirely unremarkable — reported, not refused,
    # since real replicate technical measurements can genuinely tie.
    p_value = np.where(np.isnan(p_value), np.where(fold_change != 0, 0.0, 1.0), p_value)

    # --- Permutation null (relabelling) ------------------------------------
    combined = np.concatenate([a, b], axis=1)
    n_total = n_a + n_b
    total_combinations = comb(n_total, n_a)

    if total_combinations <= MAX_EXHAUSTIVE_PERMUTATIONS:
        perms: list[tuple[int, ...]] = list(combinations(range(n_total), n_a))
    else:
        rng = np.random.default_rng(_SEED)
        idx = np.arange(n_total)
        perms = []
        for _ in range(MONTE_CARLO_PERMUTATIONS):
            rng.shuffle(idx)
            perms.append(tuple(sorted(idx[:n_a].tolist())))

    sorted_perm_d = np.empty((len(perms), n_rows), dtype=float)
    for i, a_idx in enumerate(perms):
        a_set = set(a_idx)
        b_idx = [c for c in range(n_total) if c not in a_set]
        pa = combined[:, list(a_idx)]
        pb = combined[:, b_idx]
        pfc, ps = _group_stats(pa, pb)
        with np.errstate(invalid="ignore", divide="ignore"):
            sorted_perm_d[i] = np.sort(pfc / (ps + s0))

    (
        categories,
        q_values,
        delta_used,
        fdr_achieved,
        cut_up,
        cut_low,
        curve_up,
        curve_down,
    ) = _resolve_significance(d, s, fold_change, sorted_perm_d, s0, fdr_percent, df)

    warnings: list[str] = []
    if dropped:
        warnings.append(
            f"{len(dropped)} row(s) dropped for a missing value in either group: "
            f"{', '.join(dropped)}."
        )

    return SamVolcanoOutcome(
        rows=[
            SamVolcanoRow(
                label=kept_labels[i],
                log2FoldChange=float(fold_change[i]),
                pValue=float(p_value[i]),
                qValue=float(q_values[i]),
                category=str(categories[i]),
            )
            for i in range(n_rows)
        ],
        curveUp=curve_up,
        curveDown=curve_down,
        droppedRows=dropped,
        warnings=warnings,
        deltaUsed=delta_used,
        fdrAchieved=fdr_achieved,
        cutUp=cut_up,
        cutLow=cut_low,
        permutations=len(perms),
        permutationsExhaustive=total_combinations <= MAX_EXHAUSTIVE_PERMUTATIONS,
        methodsSentence=sam_methods_sentence(
            mode="two-sample",
            s0=s0,
            fdr_percent=fdr_percent,
            fdr_achieved=fdr_achieved,
            delta_used=delta_used,
            cut_up=cut_up,
            cut_low=cut_low,
            n_tested=n_rows,
            n_up=int(np.sum(categories == "up")),
            n_down=int(np.sum(categories == "down")),
            n_permutations=len(perms),
            exhaustive=total_combinations <= MAX_EXHAUSTIVE_PERMUTATIONS,
        ),
    )


def compute_sam_volcano_one_sample(
    row_labels: list[str],
    values: list[list[float | None]],
    value_indices: list[int],
    s0: float,
    fdr_percent: float,
) -> SamVolcanoOutcome:
    """The one-class SAM design (Tusher, Tibshirani & Chu, PNAS 2001): a
    single set of replicate values per row — e.g. per-replicate log2 ratios
    already computed elsewhere — tested against zero, with the permutation
    null built from sign flips rather than group relabelling.

    Real power is inherently limited at small replicate counts (`2**n` sign
    patterns — 8 at n=3) the same way Perseus's own one-sample tools are;
    this is the method's own resolution, not a shortfall of this
    implementation.
    """
    if len(row_labels) != len(values):
        raise ValueError("row_labels and values must have the same length.")
    if len(value_indices) < 3:
        raise ValueError("A one-sample test needs at least 3 replicate columns.")
    if len(set(value_indices)) != len(value_indices):
        raise ValueError("A column cannot be selected more than once.")
    if s0 < 0:
        raise ValueError("s0 must be non-negative.")
    if not (0 < fdr_percent <= 100):
        raise ValueError("fdr_percent must be between 0 and 100.")

    v, kept_labels, dropped = _complete_rows(row_labels, values, value_indices)
    n_rows = v.shape[0]
    n = v.shape[1]
    df = n - 1

    if n_rows < 4:
        raise ValueError(
            f"The SAM volcano test needs at least 4 complete rows; only {n_rows} "
            f"remain after dropping {len(dropped)} with a missing value."
        )

    def _mean_and_se(x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        mean = x.mean(axis=1)
        sd = x.std(axis=1, ddof=1) if n > 1 else np.zeros(x.shape[0])
        se = sd / np.sqrt(n)
        return mean, se

    mean, s = _mean_and_se(v)
    d = mean / (s + s0)

    with np.errstate(invalid="ignore", divide="ignore"):
        t_stat = mean / s
        p_value = 2 * stats.t.sf(np.abs(t_stat), df)
    # Same zero-variance handling as the two-sample path: a perfectly flat
    # replicate set is maximally significant if its mean is nonzero, entirely
    # unremarkable if it is exactly zero.
    p_value = np.where(np.isnan(p_value), np.where(mean != 0, 0.0, 1.0), p_value)

    # --- Permutation null (sign flips) -------------------------------------
    total_flips = 2**n
    if total_flips <= MAX_EXHAUSTIVE_PERMUTATIONS:
        signs: list[tuple[int, ...]] = list(product((1, -1), repeat=n))
    else:
        rng = np.random.default_rng(_SEED)
        signs = [
            tuple(rng.choice((1, -1), size=n).tolist()) for _ in range(MONTE_CARLO_PERMUTATIONS)
        ]

    sorted_perm_d = np.empty((len(signs), n_rows), dtype=float)
    for i, sign in enumerate(signs):
        flipped = v * np.array(sign, dtype=float)
        pmean, pse = _mean_and_se(flipped)
        with np.errstate(invalid="ignore", divide="ignore"):
            sorted_perm_d[i] = np.sort(pmean / (pse + s0))

    (
        categories,
        q_values,
        delta_used,
        fdr_achieved,
        cut_up,
        cut_low,
        curve_up,
        curve_down,
    ) = _resolve_significance(d, s, mean, sorted_perm_d, s0, fdr_percent, df)

    warnings: list[str] = []
    if dropped:
        warnings.append(
            f"{len(dropped)} row(s) dropped for a missing value: {', '.join(dropped)}."
        )

    return SamVolcanoOutcome(
        rows=[
            SamVolcanoRow(
                label=kept_labels[i],
                log2FoldChange=float(mean[i]),
                pValue=float(p_value[i]),
                qValue=float(q_values[i]),
                category=str(categories[i]),
            )
            for i in range(n_rows)
        ],
        curveUp=curve_up,
        curveDown=curve_down,
        droppedRows=dropped,
        warnings=warnings,
        deltaUsed=delta_used,
        fdrAchieved=fdr_achieved,
        cutUp=cut_up,
        cutLow=cut_low,
        permutations=len(signs),
        permutationsExhaustive=total_flips <= MAX_EXHAUSTIVE_PERMUTATIONS,
        methodsSentence=sam_methods_sentence(
            mode="one-sample",
            s0=s0,
            fdr_percent=fdr_percent,
            fdr_achieved=fdr_achieved,
            delta_used=delta_used,
            cut_up=cut_up,
            cut_low=cut_low,
            n_tested=n_rows,
            n_up=int(np.sum(categories == "up")),
            n_down=int(np.sum(categories == "down")),
            n_permutations=len(signs),
            exhaustive=total_flips <= MAX_EXHAUSTIVE_PERMUTATIONS,
        ),
    )
