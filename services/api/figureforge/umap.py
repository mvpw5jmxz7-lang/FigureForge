"""UMAP dimensionality reduction.

Nothing here knows about figures or rendering — it takes a sample × feature
matrix and returns 2D coordinates, the same framing `pca.py` uses. Unlike
PCA, this has no closed form: fuzzy simplicial set construction followed by
a stochastic-gradient-descent layout with negative sampling is not
reasonably hand-implementable to production quality, so this is the one
place in this app that reaches for a dependency (`umap-learn`) rather than
hand-rolling the published algorithm — see `requirements.txt` for why that
trade is justified here specifically.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import umap as umap_learn

DEFAULT_N_NEIGHBORS = 15
DEFAULT_MIN_DIST = 0.1
# Fixed rather than user-exposed: makes repeated "Run UMAP" clicks against the
# same matrix reproducible, the same determinism-mindedness `mulberry32`'s
# "seeded, not left to Math.random" rule already enforces elsewhere in this app.
RANDOM_SEED = 42


@dataclass
class UmapOutcome:
    sampleLabels: list[str]
    # coords[i] is [UMAP1, UMAP2] for sampleLabels[i].
    coords: list[list[float]]
    droppedSamples: list[str]
    warnings: list[str]
    nNeighborsUsed: int


def compute_umap(
    row_labels: list[str],
    values: list[list[float | None]],
    standardize: bool = False,
) -> UmapOutcome:
    """Fit a 2D UMAP embedding of a sample × feature matrix.

    A sample missing any feature value is dropped, not imputed — the same
    "refuse rather than approximate" stance `compute_pca` already takes.
    Refused outright (a `ValueError`) below 4 complete samples: UMAP needs a
    real local neighbourhood to mean anything, a stricter floor than PCA's 3
    since 2-3 points is not a "reduce rather than approximate" case a clamped
    neighbour count can rescue.

    `n_neighbors` is auto-clamped to `min(DEFAULT_N_NEIGHBORS, n - 1)` rather
    than exposed as a UI control, mirroring PCA's own restraint of only
    exposing `standardize` — a full hyperparameter surface is deliberately
    deferred. `min_dist` stays fixed at UMAP's own conventional default.
    """
    if len(row_labels) != len(values):
        raise ValueError("row_labels and values must have the same length.")
    if values:
        width = len(values[0])
        if any(len(row) != width for row in values):
            raise ValueError("Every sample must have the same number of feature values.")

    arr = np.array(
        [[np.nan if v is None else v for v in row] for row in values],
        dtype=float,
    )

    complete = ~np.isnan(arr).any(axis=1) if arr.size else np.zeros(0, dtype=bool)
    dropped = [row_labels[i] for i in range(len(row_labels)) if not complete[i]]
    kept_labels = [row_labels[i] for i in range(len(row_labels)) if complete[i]]
    X = arr[complete]

    if X.shape[0] < 4:
        raise ValueError(
            f"UMAP needs at least 4 complete samples; only {X.shape[0]} remain after "
            f"dropping {len(dropped)} with a missing feature value."
        )
    if X.shape[1] < 2:
        raise ValueError("UMAP needs at least 2 features.")

    if standardize:
        mean = X.mean(axis=0)
        std = X.std(axis=0, ddof=1)
        std = np.where(std == 0, 1.0, std)
        X = (X - mean) / std

    n_neighbors = min(DEFAULT_N_NEIGHBORS, X.shape[0] - 1)

    reducer = umap_learn.UMAP(
        n_neighbors=n_neighbors,
        min_dist=DEFAULT_MIN_DIST,
        n_components=2,
        random_state=RANDOM_SEED,
    )
    coords = reducer.fit_transform(X)

    warnings: list[str] = []
    if dropped:
        warnings.append(
            f"{len(dropped)} sample(s) dropped for a missing feature value: "
            f"{', '.join(dropped)}."
        )

    return UmapOutcome(
        sampleLabels=kept_labels,
        coords=np.asarray(coords).tolist(),
        droppedSamples=dropped,
        warnings=warnings,
        nNeighborsUsed=n_neighbors,
    )
