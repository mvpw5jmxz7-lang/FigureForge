"""Principal component analysis.

Nothing here knows about figures or rendering — it takes a sample × feature
matrix and returns numbers, the same framing `stats/tests.py` uses. This is
not a p-value test, though: nothing here produces a `Comparison`/`Omnibus`,
so it lives as a sibling to `stats/` rather than inside it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class PcaComponent:
    label: str
    explainedVarianceRatio: float


@dataclass
class PcaOutcome:
    sampleLabels: list[str]
    scores: list[list[float]]
    components: list[PcaComponent]
    droppedSamples: list[str]
    warnings: list[str]


def compute_pca(
    row_labels: list[str],
    values: list[list[float | None]],
    standardize: bool = False,
) -> PcaOutcome:
    """Mean-centered SVD, with an optional standardization step.

    `Xc = X - mean(X)`; `U, S, Vt = svd(Xc)`; `scores = U * S`;
    `explainedVarianceRatio = S**2 / sum(S**2)` — the standard, closed-form
    construction (what R's `prcomp` and every PCA textbook compute), not
    something that needs approximating or a dependency like scikit-learn to
    get right. `standardize` divides each feature by its own sample SD after
    centering — the "correlation PCA" variant, for features on different
    scales; a zero-variance feature is left unscaled rather than divided by
    zero, since it already contributes nothing to any component.

    A sample missing any feature value is dropped, not imputed — the same
    "refuse rather than approximate" stance Fisher's exact test and nested
    statistics already take in this app. Refused outright (a `ValueError`)
    below 3 complete samples or 2 features: a 2-sample PCA is a single
    direction explaining 100% of variance by construction, not a result.
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

    if X.shape[0] < 3:
        raise ValueError(
            f"PCA needs at least 3 complete samples; only {X.shape[0]} remain after "
            f"dropping {len(dropped)} with a missing feature value."
        )
    if X.shape[1] < 2:
        raise ValueError("PCA needs at least 2 features.")

    mean = X.mean(axis=0)
    Xc = X - mean
    if standardize:
        std = Xc.std(axis=0, ddof=1)
        std = np.where(std == 0, 1.0, std)
        Xc = Xc / std

    U, S, Vt = np.linalg.svd(Xc, full_matrices=False)
    scores = U * S

    squared = S**2
    total = squared.sum()
    ratios = squared / total if total > 0 else np.zeros_like(squared)

    warnings: list[str] = []
    if dropped:
        warnings.append(
            f"{len(dropped)} sample(s) dropped for a missing feature value: "
            f"{', '.join(dropped)}."
        )

    return PcaOutcome(
        sampleLabels=kept_labels,
        scores=scores.tolist(),
        components=[
            PcaComponent(label=f"PC{i + 1}", explainedVarianceRatio=float(r))
            for i, r in enumerate(ratios)
        ],
        droppedSamples=dropped,
        warnings=warnings,
    )
