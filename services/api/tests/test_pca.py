"""Principal component analysis, checked where an external reference isn't available.

Every other test module in this app checks its numbers against a published,
externally reproducible source (R's documented output, a cited textbook
example). There is no R/lifelines-equivalent tool available in this
environment to derive an independent PCA reference from, so correctness here
instead rests on:

  * mathematical identities that hold for any correct SVD-based PCA,
    independent of this implementation (reconstruction, orthogonality,
    variance ratios summing to 1);
  * a closed-form degenerate case (perfectly correlated features must put
    100% of the variance in PC1);
  * a small 2-feature, 3-sample example whose eigenvalues are solved by hand
    below via the quadratic formula and cross-checked against this
    implementation's output.

The same honest fallback the survival stage's K>2 log-rank test already
documented for the identical reason.
"""

from __future__ import annotations

import numpy as np
import pytest

from figureforge.pca import compute_pca


class TestInvariants:
    """Properties every correct SVD-based PCA satisfies, regardless of the
    specific input — these do not depend on trusting any one reference number.
    """

    LABELS = ["a", "b", "c", "d", "e"]
    VALUES = [[1.0, 5.0], [2.0, 3.0], [3.0, 8.0], [4.0, 1.0], [5.0, 6.0]]

    def test_reconstructs_the_centered_matrix_exactly(self):
        outcome = compute_pca(self.LABELS, self.VALUES)

        X = np.array(self.VALUES)
        Xc = X - X.mean(axis=0)
        scores = np.array(outcome.scores)
        _, _, Vt = np.linalg.svd(Xc, full_matrices=False)
        # scores @ Vt reconstructs the centered input exactly for the full,
        # non-truncated set of components — a property of SVD itself, not of
        # this implementation.
        assert np.allclose(scores @ Vt, Xc, atol=1e-9)

    def test_components_are_mutually_orthogonal(self):
        outcome = compute_pca(self.LABELS, self.VALUES)
        scores = np.array(outcome.scores)
        assert abs(scores[:, 0] @ scores[:, 1]) < 1e-9

    def test_explained_variance_ratios_sum_to_one(self):
        outcome = compute_pca(self.LABELS, self.VALUES)
        total = sum(c.explainedVarianceRatio for c in outcome.components)
        assert total == pytest.approx(1.0)


class TestDegenerateCase:
    def test_perfectly_correlated_features_put_all_variance_in_pc1(self):
        labels = ["a", "b", "c", "d"]
        f1 = [1.0, 2.0, 3.0, 5.0]
        values = [[x, 2 * x] for x in f1]  # feature2 = 2 * feature1 exactly
        outcome = compute_pca(labels, values)
        assert outcome.components[0].explainedVarianceRatio == pytest.approx(1.0, abs=1e-9)
        assert outcome.components[1].explainedVarianceRatio == pytest.approx(0.0, abs=1e-9)


class TestHandWorkedExample:
    """3 samples, 2 features — small enough to solve by hand.

    Data: a=(0,0), b=(2,1), c=(1,3). Mean = (1, 4/3).

    Centered: a=(-1,-4/3), b=(1,-1/3), c=(0,5/3).

    Sample covariance (ddof=1, denominator n-1=2):
        Var(x)    = (1 + 1 + 0) / 2                        = 1
        Var(y)    = (16/9 + 1/9 + 25/9) / 2 = (42/9) / 2    = 7/3
        Cov(x, y) = ((-1)(-4/3) + (1)(-1/3) + 0) / 2 = 1/2
        C = [[1, 0.5], [0.5, 7/3]]

    Eigenvalues, via the quadratic formula on det(C - lambda*I) = 0:
        (1 - lambda)(7/3 - lambda) - 0.25 = 0
        lambda^2 - (10/3) lambda + 25/12  = 0
        12 lambda^2 - 40 lambda + 25      = 0
        lambda = (40 +/- sqrt(1600 - 1200)) / 24 = (40 +/- 20) / 24
        lambda1 = 2.5,  lambda2 = 5/6

    Explained variance ratio: lambda1 / (lambda1 + lambda2) = 2.5 / (10/3)
    = 0.75; lambda2 / (10/3) = 0.25 — an exact 75/25 split.

    PC1's unit eigenvector solves (C - 2.5 I) v = 0 -> v2 = 3 v1, giving
    direction (1, 3) / sqrt(10). Projecting each centered sample onto it:
        a: (-1, -4/3) . (1, 3) / sqrt(10) = (-1 - 4)  / sqrt(10) = -5 / sqrt(10)
        b: (1,  -1/3) . (1, 3) / sqrt(10) = (1  - 1)  / sqrt(10) = 0
        c: (0,   5/3) . (1, 3) / sqrt(10) = (0  + 5)  / sqrt(10) = 5 / sqrt(10)
    """

    LABELS = ["a", "b", "c"]
    VALUES = [[0.0, 0.0], [2.0, 1.0], [1.0, 3.0]]

    def test_explained_variance_is_exactly_75_25(self):
        outcome = compute_pca(self.LABELS, self.VALUES)
        assert outcome.components[0].explainedVarianceRatio == pytest.approx(0.75, abs=1e-9)
        assert outcome.components[1].explainedVarianceRatio == pytest.approx(0.25, abs=1e-9)

    def test_pc1_scores_match_the_hand_solved_projection(self):
        outcome = compute_pca(self.LABELS, self.VALUES)
        pc1 = [row[0] for row in outcome.scores]
        # SVD fixes no sign convention for a component direction, so this
        # checks magnitude and relative structure rather than a signed
        # value: sample b sits exactly on the mean along PC1, and a/c are
        # equal and opposite.
        assert pc1[1] == pytest.approx(0.0, abs=1e-9)
        assert abs(pc1[0]) == pytest.approx(5 / np.sqrt(10), abs=1e-9)
        assert pc1[0] == pytest.approx(-pc1[2], abs=1e-9)


class TestStandardize:
    """A feature on a much larger raw scale dominates PC1 unless standardized."""

    LABELS = ["a", "b", "c", "d"]
    SMALL = [1.0, 2.0, 3.0, 4.0]
    LARGE = [1000.0, 1010.0, 990.0, 1020.0]
    VALUES = [[s, large] for s, large in zip(SMALL, LARGE, strict=True)]

    def test_raw_scale_lets_the_large_feature_dominate(self):
        outcome = compute_pca(self.LABELS, self.VALUES, standardize=False)
        assert outcome.components[0].explainedVarianceRatio > 0.99

    def test_standardizing_gives_each_feature_comparable_weight(self):
        outcome = compute_pca(self.LABELS, self.VALUES, standardize=True)
        assert outcome.components[0].explainedVarianceRatio == pytest.approx(0.70, abs=1e-9)
        assert outcome.components[1].explainedVarianceRatio == pytest.approx(0.30, abs=1e-9)


class TestMissingValues:
    def test_drops_a_sample_missing_any_feature_value(self):
        labels = ["a", "b", "c", "d", "e"]
        values = [[1.0, 2.0], [2.0, None], [3.0, 6.0], [4.0, 8.0], [5.0, 10.0]]
        outcome = compute_pca(labels, values)
        assert outcome.sampleLabels == ["a", "c", "d", "e"]
        assert outcome.droppedSamples == ["b"]
        assert len(outcome.warnings) == 1
        assert "b" in outcome.warnings[0]

    def test_no_warning_when_nothing_is_dropped(self):
        outcome = compute_pca(["a", "b", "c"], [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])
        assert outcome.droppedSamples == []
        assert outcome.warnings == []


class TestValidation:
    def test_rejects_fewer_than_three_complete_samples(self):
        with pytest.raises(ValueError, match="at least 3 complete samples"):
            compute_pca(["a", "b"], [[1.0, 2.0], [3.0, 4.0]])

    def test_rejects_fewer_than_two_features(self):
        with pytest.raises(ValueError, match="at least 2 features"):
            compute_pca(["a", "b", "c"], [[1.0], [2.0], [3.0]])

    def test_rejects_mismatched_lengths(self):
        with pytest.raises(ValueError, match="same length"):
            compute_pca(["a", "b"], [[1.0, 2.0]])

    def test_rejects_ragged_rows(self):
        with pytest.raises(ValueError, match="same number of feature values"):
            compute_pca(["a", "b", "c"], [[1.0, 2.0], [3.0, 4.0, 5.0], [6.0, 7.0]])

    def test_a_matrix_reduced_to_fewer_than_three_rows_by_dropping_is_also_rejected(self):
        labels = ["a", "b", "c"]
        values = [[1.0, 2.0], [None, 4.0], [None, 6.0]]
        with pytest.raises(ValueError, match="at least 3 complete samples"):
            compute_pca(labels, values)
