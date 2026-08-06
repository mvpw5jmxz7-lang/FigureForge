"""UMAP embedding, checked where no external reference exists.

Unlike every other test module in this app, there is no R/lifelines-equivalent
tool available in this environment to derive an independent UMAP reference
from — and unlike `test_pca.py`, there is no closed form to hand-solve either:
fuzzy simplicial set construction followed by a stochastic-gradient-descent
layout with negative sampling has no exact answer to check against. So
correctness here rests on properties that hold for *any* correct
neighbour-preserving embedding, independent of this implementation's specific
numbers:

  * pairwise distances in the input broadly agree, by rank, with pairwise
    distances in the 2D embedding (Spearman correlation, not exact values);
  * the same input run twice through this implementation's fixed internal
    seed produces the identical output — proving the seed actually pins the
    result, not that any particular embedding is "correct";
  * two well-separated input clusters remain two well-separated output
    clusters — true for any correct neighbour-preserving embedding.

The same honest fallback `test_pca.py`'s own docstring already modelled for
the identical reason, extended with the seed-stability property this app's
`mulberry32` seeded-jitter test already established as its standard way of
testing randomness: not exact values, "same seed -> identical output."
"""

from __future__ import annotations

import numpy as np
import pytest
from scipy.spatial.distance import pdist
from scipy.stats import spearmanr

from figureforge.umap import compute_umap


def _two_clusters(n_per_cluster: int = 10, n_features: int = 5, seed: int = 0):
    rng = np.random.default_rng(seed)
    c1 = rng.normal(loc=0.0, scale=0.3, size=(n_per_cluster, n_features))
    c2 = rng.normal(loc=15.0, scale=0.3, size=(n_per_cluster, n_features))
    values = np.vstack([c1, c2]).tolist()
    labels = [f"a{i}" for i in range(n_per_cluster)] + [f"b{i}" for i in range(n_per_cluster)]
    return labels, values


class TestNeighborhoodPreservation:
    def test_pairwise_distance_ranks_correlate_with_the_input(self):
        rng = np.random.default_rng(1)
        n = 40
        # A genuine low-dimensional structure (a noisy 2D plane embedded in
        # 6D) rather than pure noise, so there is real neighbourhood
        # structure for the embedding to have a chance of preserving.
        latent = rng.uniform(-5, 5, size=(n, 2))
        projection = rng.normal(size=(2, 6))
        values = (latent @ projection + rng.normal(scale=0.1, size=(n, 6))).tolist()
        labels = [f"s{i}" for i in range(n)]

        outcome = compute_umap(labels, values)

        input_distances = pdist(np.array(values))
        embedded_distances = pdist(np.array(outcome.coords))
        rho, _ = spearmanr(input_distances, embedded_distances)
        assert rho > 0.5


class TestSeedStability:
    def test_the_same_input_produces_the_identical_embedding_twice(self):
        labels, values = _two_clusters()
        first = compute_umap(labels, values)
        second = compute_umap(labels, values)
        assert np.allclose(first.coords, second.coords)

    def test_standardizing_is_also_seed_stable(self):
        labels, values = _two_clusters()
        first = compute_umap(labels, values, standardize=True)
        second = compute_umap(labels, values, standardize=True)
        assert np.allclose(first.coords, second.coords)


class TestDegenerateCase:
    def test_two_well_separated_clusters_stay_well_separated(self):
        labels, values = _two_clusters()
        outcome = compute_umap(labels, values)
        coords = np.array(outcome.coords)
        n = len(labels) // 2
        cluster_a, cluster_b = coords[:n], coords[n:]

        intra = np.concatenate([pdist(cluster_a), pdist(cluster_b)])
        inter = np.linalg.norm(
            cluster_a[:, None, :] - cluster_b[None, :, :], axis=-1
        ).ravel()

        assert inter.mean() > intra.mean()


class TestNeighborClamping:
    def test_n_neighbors_is_clamped_below_the_default_for_a_small_sample(self):
        labels = [f"s{i}" for i in range(5)]
        values = [[float(i), float(i) * 2] for i in range(5)]
        outcome = compute_umap(labels, values)
        assert outcome.nNeighborsUsed == 4  # n_samples - 1

    def test_n_neighbors_is_not_clamped_for_a_large_sample(self):
        labels, values = _two_clusters(n_per_cluster=20)
        outcome = compute_umap(labels, values)
        assert outcome.nNeighborsUsed == 15  # DEFAULT_N_NEIGHBORS


class TestMissingValues:
    def test_drops_a_sample_missing_any_feature_value(self):
        labels, values = _two_clusters()
        values[3][0] = None
        outcome = compute_umap(labels, values)
        assert "a3" not in outcome.sampleLabels
        assert outcome.droppedSamples == ["a3"]
        assert len(outcome.warnings) == 1
        assert "a3" in outcome.warnings[0]

    def test_no_warning_when_nothing_is_dropped(self):
        labels, values = _two_clusters()
        outcome = compute_umap(labels, values)
        assert outcome.droppedSamples == []
        assert outcome.warnings == []


class TestValidation:
    def test_rejects_fewer_than_four_complete_samples(self):
        with pytest.raises(ValueError, match="at least 4 complete samples"):
            compute_umap(["a", "b", "c"], [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]])

    def test_rejects_fewer_than_two_features(self):
        with pytest.raises(ValueError, match="at least 2 features"):
            compute_umap(["a", "b", "c", "d"], [[1.0], [2.0], [3.0], [4.0]])

    def test_rejects_mismatched_lengths(self):
        with pytest.raises(ValueError, match="same length"):
            compute_umap(["a", "b"], [[1.0, 2.0]])

    def test_rejects_ragged_rows(self):
        with pytest.raises(ValueError, match="same number of feature values"):
            compute_umap(
                ["a", "b", "c", "d"],
                [[1.0, 2.0], [3.0, 4.0, 5.0], [6.0, 7.0], [8.0, 9.0]],
            )

    def test_a_matrix_reduced_to_fewer_than_four_rows_by_dropping_is_also_rejected(self):
        labels = ["a", "b", "c", "d"]
        values = [[1.0, 2.0], [None, 4.0], [None, 6.0], [7.0, 8.0]]
        with pytest.raises(ValueError, match="at least 4 complete samples"):
            compute_umap(labels, values)
