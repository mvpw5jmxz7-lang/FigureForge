"""SAM/Perseus-style permutation volcano significance, checked where no
external reference exists.

Like `test_umap.py`, there is no R/lifelines-equivalent tool in this
environment to derive an independent reference from, and unlike PCA's SVD
there is no closed form either: a permutation-based FDR search has no exact
answer to check against. Correctness rests instead on properties any correct
implementation of the published method (Tusher, Tibshirani & Chu, PNAS 2001)
satisfies, independent of this implementation's specific numbers:

  * a dataset with no real difference between groups calls almost nothing
    significant at a conservative FDR;
  * a dataset with a strong, clearly injected difference calls it, with the
    correct sign;
  * loosening the target FDR never calls fewer proteins significant;
  * the same input and parameters, run twice through this implementation's
    fixed internal seed, produce bit-identical output — the same
    "same seed -> identical output" property `test_umap.py` already
    established as this app's standard way of testing randomness.

The same honest fallback `test_pca.py`/`test_umap.py`'s own docstrings model
for the identical reason.
"""

from __future__ import annotations

import numpy as np
import pytest
from scipy import stats

from figureforge.sam_volcano import compute_sam_volcano, compute_sam_volcano_one_sample


def _no_signal(n_rows: int = 60, n_a: int = 4, n_b: int = 4, seed: int = 0):
    rng = np.random.default_rng(seed)
    values = rng.normal(loc=0.0, scale=1.0, size=(n_rows, n_a + n_b)).tolist()
    labels = [f"P{i}" for i in range(n_rows)]
    return labels, values, list(range(n_a)), list(range(n_a, n_a + n_b))


def _with_signal(n_rows: int = 60, n_signal: int = 10, n_a: int = 4, n_b: int = 4, seed: int = 0):
    rng = np.random.default_rng(seed)
    values = rng.normal(loc=0.0, scale=0.3, size=(n_rows, n_a + n_b))
    # The first n_signal rows get a large, unambiguous upward shift in group B.
    values[:n_signal, n_a:] += 6.0
    labels = [f"P{i}" for i in range(n_rows)]
    return labels, values.tolist(), list(range(n_a)), list(range(n_a, n_a + n_b))


def _no_signal_one_sample(n_rows: int = 60, n_reps: int = 4, seed: int = 0):
    rng = np.random.default_rng(seed)
    values = rng.normal(loc=0.0, scale=1.0, size=(n_rows, n_reps)).tolist()
    labels = [f"P{i}" for i in range(n_rows)]
    return labels, values, list(range(n_reps))


def _with_signal_one_sample(n_rows: int = 60, n_signal: int = 10, n_reps: int = 4, seed: int = 0):
    rng = np.random.default_rng(seed)
    values = rng.normal(loc=0.0, scale=0.3, size=(n_rows, n_reps))
    # The first n_signal rows get a large, unambiguous upward mean shift.
    values[:n_signal, :] += 6.0
    labels = [f"P{i}" for i in range(n_rows)]
    return labels, values.tolist(), list(range(n_reps))


class TestInvariants:
    def test_no_real_difference_calls_almost_nothing_significant(self):
        labels, values, group_a, group_b = _no_signal()
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)
        called = sum(1 for r in outcome.rows if r.category != "ns")
        # A conservative FDR search over pure noise should call very few, if
        # any, of 60 proteins significant — not zero necessarily (FDR is an
        # expectation, not a guarantee), but nowhere near half.
        assert called <= 6

    def test_a_strong_injected_difference_is_called_up(self):
        labels, values, group_a, group_b = _with_signal()
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)
        by_label = {r.label: r for r in outcome.rows}
        signal_rows = [by_label[f"P{i}"] for i in range(10)]
        assert all(r.category == "up" for r in signal_rows)
        assert all(r.log2FoldChange > 0 for r in signal_rows)
        assert all(r.qValue <= 0.05 for r in signal_rows)

    def test_loosening_the_target_fdr_never_calls_fewer_proteins(self):
        labels, values, group_a, group_b = _with_signal()
        strict = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=1.0)
        loose = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=25.0)
        strict_called = sum(1 for r in strict.rows if r.category != "ns")
        loose_called = sum(1 for r in loose.rows if r.category != "ns")
        assert loose_called >= strict_called

    def test_same_seed_reproduces_bit_identical_output(self):
        labels, values, group_a, group_b = _with_signal()
        a = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)
        b = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)
        assert [r.qValue for r in a.rows] == [r.qValue for r in b.rows]
        assert [r.category for r in a.rows] == [r.category for r in b.rows]
        assert a.deltaUsed == b.deltaUsed

    def test_q_values_are_bounded_and_curve_points_are_finite(self):
        labels, values, group_a, group_b = _with_signal()
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)
        assert all(0.0 <= r.qValue <= 1.0 for r in outcome.rows)
        for x, y in outcome.curveUp + outcome.curveDown:
            assert np.isfinite(x)
            assert np.isfinite(y)


class TestValidation:
    def test_rejects_mismatched_lengths(self):
        with pytest.raises(ValueError, match="same length"):
            compute_sam_volcano(["a", "b"], [[1.0, 2.0]], [0], [1], s0=0.1, fdr_percent=5.0)

    def test_rejects_overlapping_groups(self):
        labels, values, _, _ = _no_signal()
        with pytest.raises(ValueError, match="cannot share"):
            compute_sam_volcano(labels, values, [0, 1], [1, 2], s0=0.1, fdr_percent=5.0)

    def test_rejects_a_group_with_fewer_than_two_columns(self):
        labels, values, _, _ = _no_signal()
        with pytest.raises(ValueError, match="at least 2"):
            compute_sam_volcano(labels, values, [0], [4, 5], s0=0.1, fdr_percent=5.0)

    def test_rejects_negative_s0(self):
        labels, values, group_a, group_b = _no_signal()
        with pytest.raises(ValueError, match="s0"):
            compute_sam_volcano(labels, values, group_a, group_b, s0=-1.0, fdr_percent=5.0)

    def test_rejects_out_of_range_fdr_percent(self):
        labels, values, group_a, group_b = _no_signal()
        with pytest.raises(ValueError, match="fdr_percent"):
            compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=150.0)

    def test_drops_rows_missing_a_value_in_either_group(self):
        labels, values, group_a, group_b = _no_signal(n_rows=10)
        values[3][group_a[0]] = None
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)
        assert outcome.droppedRows == ["P3"]
        assert len(outcome.rows) == 9

    def test_refuses_below_four_complete_rows(self):
        labels, values, group_a, group_b = _no_signal(n_rows=3)
        with pytest.raises(ValueError, match="at least 4"):
            compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)


class TestOneSampleInvariants:
    """The one-class SAM design (sign-flip permutation), added so a
    per-replicate-ratio table (e.g. `Rep1_log2FC, Rep2_log2FC, Rep3_log2FC`
    with no raw two-group columns) has a real path into this feature —
    the exact shape the two-sample-only tool could not use at all."""

    def test_no_real_difference_calls_almost_nothing_significant(self):
        labels, values, value_idx = _no_signal_one_sample()
        outcome = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=5.0)
        called = sum(1 for r in outcome.rows if r.category != "ns")
        assert called <= 6

    def test_a_strong_injected_shift_is_called_up(self):
        labels, values, value_idx = _with_signal_one_sample()
        outcome = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=5.0)
        by_label = {r.label: r for r in outcome.rows}
        signal_rows = [by_label[f"P{i}"] for i in range(10)]
        assert all(r.category == "up" for r in signal_rows)
        assert all(r.log2FoldChange > 0 for r in signal_rows)
        assert all(r.qValue <= 0.05 for r in signal_rows)

    def test_loosening_the_target_fdr_never_calls_fewer_proteins(self):
        labels, values, value_idx = _with_signal_one_sample()
        strict = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=1.0)
        loose = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=25.0)
        strict_called = sum(1 for r in strict.rows if r.category != "ns")
        loose_called = sum(1 for r in loose.rows if r.category != "ns")
        assert loose_called >= strict_called

    def test_same_seed_reproduces_bit_identical_output(self):
        labels, values, value_idx = _with_signal_one_sample()
        a = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=5.0)
        b = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=5.0)
        assert [r.qValue for r in a.rows] == [r.qValue for r in b.rows]
        assert [r.category for r in a.rows] == [r.category for r in b.rows]
        assert a.deltaUsed == b.deltaUsed

    def test_q_values_are_bounded_and_curve_points_are_finite(self):
        labels, values, value_idx = _with_signal_one_sample()
        outcome = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=5.0)
        assert all(0.0 <= r.qValue <= 1.0 for r in outcome.rows)
        for x, y in outcome.curveUp + outcome.curveDown:
            assert np.isfinite(x)
            assert np.isfinite(y)

    def test_falls_back_to_monte_carlo_above_the_exhaustive_threshold(self):
        # 2**12 = 4096 > MAX_EXHAUSTIVE_PERMUTATIONS (2000), so this exercises
        # the Monte Carlo sign-flip branch rather than the exhaustive one.
        labels, values, value_idx = _with_signal_one_sample(n_reps=12)
        outcome = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=5.0)
        by_label = {r.label: r for r in outcome.rows}
        assert all(by_label[f"P{i}"].category == "up" for i in range(10))


class TestOneSampleValidation:
    def test_rejects_mismatched_lengths(self):
        with pytest.raises(ValueError, match="same length"):
            compute_sam_volcano_one_sample(
                ["a", "b"], [[1.0, 2.0, 3.0]], [0, 1, 2], s0=0.1, fdr_percent=5.0
            )

    def test_rejects_fewer_than_three_value_columns(self):
        labels, values, _ = _no_signal_one_sample()
        with pytest.raises(ValueError, match="at least 3"):
            compute_sam_volcano_one_sample(labels, values, [0, 1], s0=0.1, fdr_percent=5.0)

    def test_rejects_a_duplicated_column(self):
        labels, values, _ = _no_signal_one_sample()
        with pytest.raises(ValueError, match="more than once"):
            compute_sam_volcano_one_sample(labels, values, [0, 1, 1], s0=0.1, fdr_percent=5.0)

    def test_rejects_negative_s0(self):
        labels, values, value_idx = _no_signal_one_sample()
        with pytest.raises(ValueError, match="s0"):
            compute_sam_volcano_one_sample(labels, values, value_idx, s0=-1.0, fdr_percent=5.0)

    def test_rejects_out_of_range_fdr_percent(self):
        labels, values, value_idx = _no_signal_one_sample()
        with pytest.raises(ValueError, match="fdr_percent"):
            compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=150.0)

    def test_drops_rows_missing_a_value(self):
        labels, values, value_idx = _no_signal_one_sample(n_rows=10)
        values[3][value_idx[0]] = None
        outcome = compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=5.0)
        assert outcome.droppedRows == ["P3"]
        assert len(outcome.rows) == 9

    def test_refuses_below_four_complete_rows(self):
        labels, values, value_idx = _no_signal_one_sample(n_rows=3)
        with pytest.raises(ValueError, match="at least 4"):
            compute_sam_volcano_one_sample(labels, values, value_idx, s0=0.1, fdr_percent=5.0)


class TestCurveMonotonicity:
    """A direct regression guard for the reported bug: sorted by fold
    change, the significance-boundary curve must be a proper monotonic
    function (rising as |fold change| shrinks toward the asymptote), not a
    jagged or non-monotonic scatter — for both test designs, since they
    share the curve-generation code in `_resolve_significance`."""

    @staticmethod
    def _assert_monotonic(branch: list[tuple[float, float]]) -> None:
        if len(branch) < 3:
            return
        ys = [p[1] for p in sorted(branch, key=lambda p: p[0])]
        # y is expected to fall as |x| grows away from the asymptote. Ties in
        # x (several proteins sharing the same standard error) can reorder
        # arbitrarily and differ by floating-point noise, so a reversal only
        # counts once it clears that noise floor.
        eps = 1e-9
        assert all(ys[i] >= ys[i + 1] - eps for i in range(len(ys) - 1)) or all(
            ys[i] <= ys[i + 1] + eps for i in range(len(ys) - 1)
        )

    def test_two_sample_curve_branches_are_monotonic(self):
        labels, values, group_a, group_b = _with_signal(n_rows=200, seed=1)
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=10.0)
        for branch in (outcome.curveUp, outcome.curveDown):
            self._assert_monotonic(branch)

    def test_one_sample_curve_branches_are_monotonic(self):
        labels, values, value_idx = _with_signal_one_sample(n_rows=200, seed=1)
        outcome = compute_sam_volcano_one_sample(
            labels, values, value_idx, s0=0.1, fdr_percent=10.0
        )
        for branch in (outcome.curveUp, outcome.curveDown):
            self._assert_monotonic(branch)

    def test_one_sample_curve_is_monotonic_with_many_tied_standard_errors(self):
        # A realistic proteomics table (e.g. every protein sharing the same
        # per-replicate noise magnitude by construction) gives many proteins
        # an identical standard error, hence an identical x on the curve —
        # exactly the shape that first exposed a too-strict monotonicity
        # check (floating-point noise at ties, not a real reversal) when
        # this was run against the reported bug's real reference data.
        rng = np.random.default_rng(3)
        n_rows = 60
        base = rng.normal(loc=0.0, scale=2.0, size=n_rows)
        # Every row gets the exact same three offsets applied to its own
        # mean, so every row's standard error is identical.
        offsets = np.array([-0.1, 0.0, 0.1])
        values = (base[:, None] + offsets[None, :]).tolist()
        labels = [f"P{i}" for i in range(n_rows)]
        outcome = compute_sam_volcano_one_sample(
            labels, values, [0, 1, 2], s0=0.1, fdr_percent=10.0
        )
        for branch in (outcome.curveUp, outcome.curveDown):
            self._assert_monotonic(branch)


class TestCurveCoversThePlot:
    """The boundary has to be drawable, not merely correct.

    Reported as "no dashed lines at all" on a real 100-protein export. The
    boundary was right — it agreed with the reported categories on every
    point that fell inside it — but it was evaluated once per protein, at
    that protein's own standard error, and those clustered in a narrow band.
    Measured on that data, the resulting curve covered x in [0.131, 0.167]
    and y in [0.699, 0.961] against a plot spanning x in [-2.32, 4.09] and
    y in [0, 6.19]: 0.6% of the width and 4% of the height, a sub-millimetre
    dash pressed against the axes.

    So these assert the property that makes it *visible* — the swept curve
    must reach past the data it is drawn over on both axes — rather than any
    particular number this implementation produces.
    """

    @staticmethod
    def _tight_replicates(n_rows: int = 100, seed: int = 5):
        """The regime that exposed this: within-group noise far smaller than
        the effects, so every protein is called and the standard errors are
        both tiny and tightly clustered."""
        rng = np.random.default_rng(seed)
        base = rng.normal(loc=22.0, scale=3.0, size=n_rows)
        effect = rng.normal(loc=0.0, scale=2.0, size=n_rows)
        noise = 0.07
        control = base[:, None] + rng.normal(0.0, noise, size=(n_rows, 3))
        treated = (base + effect)[:, None] + rng.normal(0.0, noise, size=(n_rows, 3))
        values = np.hstack([control, treated])
        labels = [f"P{i:03d}" for i in range(n_rows)]
        return labels, values.tolist(), [0, 1, 2], [3, 4, 5]

    def test_the_boundary_spans_past_the_plotted_data(self):
        labels, values, group_a, group_b = self._tight_replicates()
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)

        fold_changes = [row.log2FoldChange for row in outcome.rows]
        neg_log_p = [-np.log10(row.pValue) for row in outcome.rows if row.pValue > 0]
        assert outcome.curveUp and outcome.curveDown

        # Rightward past the widest real up-regulation, and leftward past the
        # widest down-regulation: whatever x window the axes end up showing,
        # the curve crosses it rather than stopping short.
        assert max(x for x, _ in outcome.curveUp) > max(fold_changes)
        assert min(x for x, _ in outcome.curveDown) < min(fold_changes)

        # And upward past the most significant point, so the curve reaches the
        # top of the panel instead of hugging the baseline.
        for branch in (outcome.curveUp, outcome.curveDown):
            assert max(y for _, y in branch) > max(neg_log_p)

        # Both branches approach the same vertical asymptote from either side,
        # so neither starts out at a fold change the axis would never show.
        assert min(abs(x) for x, _ in outcome.curveUp) < abs(max(fold_changes))
        assert min(abs(x) for x, _ in outcome.curveDown) < abs(min(fold_changes))

    def test_a_table_with_no_within_group_variance_still_yields_a_curve(self):
        """Every standard error is zero, so there is no observed scale to
        bracket the sweep with. The asymptote `cut * s0` is still defined, so
        the sweep falls back to `s0`'s own scale rather than being abandoned —
        the same degenerate table `test_main_routes.py` posts."""
        labels = [f"P{i}" for i in range(6)]
        values = [[1.0, 1.0, 1.0, 100.0, 100.0, 100.0] for _ in labels]
        outcome = compute_sam_volcano(labels, values, [0, 1, 2], [3, 4, 5], s0=0.1, fdr_percent=5.0)
        for branch in (outcome.curveUp, outcome.curveDown):
            for x, y in branch:
                assert np.isfinite(x) and np.isfinite(y)


class TestMethodsSentence:
    """The manuscript sentence, checked for the facts it must not omit.

    Asserted against *content*, never against the whole string: the wording is
    prose and will be edited, but a methods sentence that fails to name the S0
    value it ran with, or claims an exhaustive permutation that never
    happened, is wrong in a way a reader cannot detect.
    """

    def test_names_the_parameters_it_ran_with(self):
        labels, values, group_a, group_b = _with_signal(n_rows=60, seed=2)
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=0.25, fdr_percent=5.0)
        sentence = outcome.methodsSentence
        assert "S0 = 0.25" in sentence
        assert "5%" in sentence
        assert f"{outcome.deltaUsed:.3f}" in sentence
        assert f"{outcome.fdrAchieved * 100:.1f}%" in sentence
        assert f"{outcome.cutUp:.3f}" in sentence
        assert f"{outcome.cutLow:.3f}" in sentence
        assert str(len(outcome.rows)) in sentence
        assert "Tusher" in sentence

    def test_reports_the_permutation_scheme_that_actually_ran(self):
        # 4v4 is C(8,4) = 70 relabellings, comfortably exhaustive.
        labels, values, group_a, group_b = _with_signal(n_rows=30, n_a=4, n_b=4, seed=3)
        exhaustive = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)
        assert exhaustive.permutationsExhaustive
        assert "all 70 possible relabellings" in exhaustive.methodsSentence
        assert "random" not in exhaustive.methodsSentence

        # 8v8 is C(16,8) = 12870, past MAX_EXHAUSTIVE_PERMUTATIONS, so the
        # sentence must say sampled rather than claim the full enumeration.
        labels, values, group_a, group_b = _with_signal(n_rows=30, n_a=8, n_b=8, seed=3)
        sampled = compute_sam_volcano(labels, values, group_a, group_b, s0=0.1, fdr_percent=5.0)
        assert not sampled.permutationsExhaustive
        assert f"{sampled.permutations} random relabellings" in sampled.methodsSentence
        assert "all " not in sampled.methodsSentence

    def test_the_one_sample_design_is_described_as_its_own(self):
        labels, values, value_idx = _with_signal_one_sample(n_rows=40, seed=4)
        outcome = compute_sam_volcano_one_sample(
            labels, values, value_idx, s0=0.1, fdr_percent=5.0
        )
        assert "one-sample (sign-flip)" in outcome.methodsSentence
        assert "sign flips" in outcome.methodsSentence
        assert "relabellings" not in outcome.methodsSentence


class TestBoundarySymmetry:
    """The control that separates "the data is lopsided" from "the code is".

    Reported: at a larger S0 the two branches are visibly asymmetric. They
    should be — SAM walks inward from each tail independently, against its own
    side of the permutation null, so `cutup` and `cutlow` are separate order
    statistics and coincide only when the data is symmetric. Each branch's
    asymptote sits at `cut * s0`, so raising S0 magnifies an existing
    difference rather than creating one.

    This is what makes that answer checkable rather than asserted, and guards
    `cutoffs_at` against a future change that would break the symmetric case
    while leaving the asymmetric one looking plausible.
    """

    @staticmethod
    def _mirrored(n_pairs: int = 50, seed: int = 11):
        """Every protein has an exact opposite: the same replicates with the
        two groups swapped, so its fold change is the exact negation."""
        rng = np.random.default_rng(seed)
        base = rng.normal(20.0, 2.0, n_pairs)
        noise = rng.gamma(2.0, 0.25, n_pairs)
        effect = rng.normal(0.0, 1.5, n_pairs)
        labels: list[str] = []
        values: list[list[float]] = []
        for i in range(n_pairs):
            control = base[i] + rng.normal(0.0, noise[i], 3)
            treated = base[i] + effect[i] + rng.normal(0.0, noise[i], 3)
            labels.append(f"U{i:03d}")
            values.append([float(v) for v in [*control, *treated]])
            labels.append(f"D{i:03d}")
            values.append([float(v) for v in [*treated, *control]])
        return labels, values, [0, 1, 2], [3, 4, 5]

    def test_mirrored_data_gives_exactly_opposite_cutoffs(self):
        labels, values, group_a, group_b = self._mirrored()
        for s0 in (0.1, 0.5):
            outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=s0, fdr_percent=5.0)
            assert outcome.cutUp == pytest.approx(-outcome.cutLow, rel=1e-9)
            up = sum(1 for r in outcome.rows if r.category == "up")
            down = sum(1 for r in outcome.rows if r.category == "down")
            assert up == down

    def test_lopsided_data_is_allowed_to_give_unequal_cutoffs(self):
        # The other half of the claim: asymmetry is a property of the data, so
        # a set with signal on one side only must not be forced symmetric.
        labels, values, group_a, group_b = _with_signal(n_rows=120, n_signal=30, seed=6)
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=0.5, fdr_percent=5.0)
        assert outcome.cutUp != pytest.approx(-outcome.cutLow, rel=1e-6)


class TestCurveFidelity:
    """Every drawn point must lie on the boundary it claims to be.

    Inverting a curve point back through the closed form recovers the `cut`
    that produced it: `t` from the p-value, `s = |x| / t`, then
    `cut = x / (s + s0)`. A correct branch gives one constant, and it must be
    the same cutoff the classification uses — which is what makes "above the
    curve" and "called significant" the same statement rather than two.
    """

    def test_each_branch_inverts_to_a_single_constant_cut(self):
        # Signal in *both* directions: `_with_signal` shifts one way only, so
        # its down branch is empty (`cutlow = -inf`) and would prove nothing.
        labels, values, group_a, group_b = TestBoundarySymmetry._mirrored(n_pairs=40, seed=7)
        s0 = 0.5
        outcome = compute_sam_volcano(labels, values, group_a, group_b, s0=s0, fdr_percent=5.0)
        df = len(group_a) + len(group_b) - 2

        for branch, expected in (
            (outcome.curveUp, outcome.cutUp),
            (outcome.curveDown, outcome.cutLow),
        ):
            recovered = []
            for x, y in branch:
                p = 10.0**-y
                if not 0.0 < p < 1.0:
                    continue
                t = float(stats.t.isf(p / 2, df))
                if not np.isfinite(t) or t <= 0:
                    continue
                recovered.append(x / (abs(x) / t + s0))
            assert len(recovered) > 100
            assert max(recovered) - min(recovered) < 1e-6
            assert float(np.median(recovered)) == pytest.approx(expected, abs=1e-6)
