"""FigureForge API.

Five responsibilities, deliberately narrow:

  * /analyze       — run a statistical test, return numbers and a methods sentence
  * /pca           — reduce a sample x feature matrix to principal component scores
  * /umap          — reduce a sample x feature matrix to a 2D UMAP embedding
  * /volcano-test  — a Perseus-style permutation (SAM) significance test,
                     two-sample or one-sample
  * /export        — convert a rendered SVG to PDF/EPS/PNG/TIFF
  * /decode-image  — decode a format the browser cannot open (TIFF) to a PNG proxy

This service never decides how a figure looks. All layout and drawing happen in
the TypeScript renderer, which runs identically in the browser and here, so the
export cannot drift from what the author saw on screen.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Literal, TypeVar

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator, model_validator

from .export.renderer import ExportRequest, render, shutdown_browser
from .images.decode import DecodeError, TooLargeError, decode
from .layout_assistant import (
    LlmClient,
    PanelSummary,
    interpret_instruction,
    suggest_grouping,
)
from .llm_stub import StubLlmClient
from .pca import compute_pca
from .sam_volcano import compute_sam_volcano, compute_sam_volcano_one_sample
from .stats.methods import methods_sentence, software_versions
from .stats.tests import RegressionFit, run_test
from .umap import compute_umap

logger = logging.getLogger("figureforge")

MEDIA_TYPES = {
    "svg": "image/svg+xml",
    "pdf": "application/pdf",
    "eps": "application/postscript",
    "png": "image/png",
    "tiff": "image/tiff",
}


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await shutdown_browser()


app = FastAPI(title="FigureForge API", version="0.1.0", lifespan=lifespan)

# The web container shares a network namespace with this one under the dev pod,
# but a compose or desktop setup puts them on different origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # /decode-image returns its metadata in X-Image-* response headers, and a
    # cross-origin fetch cannot read a response header unless it is exposed
    # here. Under the dev pod the Vite proxy makes the call same-origin so this
    # is invisible; under compose.yaml, where the API is a separate host, the
    # omission would return a valid PNG with no dimensions attached.
    expose_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, object]:
    return {"status": "ok", "versions": software_versions()}


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------


class Group(BaseModel):
    name: str
    values: list[float]


class AnalyzeRequest(BaseModel):
    test: str
    groups: list[Group] = Field(min_length=1)
    # Paired x-values for correlating a single series against its own x axis
    # (pearson/spearman/linear-regression only); every other test compares two
    # or more named groups instead. `run_test` enforces which shape a given
    # test requires.
    x: Group | None = None
    # Per-subject 0/1 event flags, one Group per times group in `groups`,
    # matched by name — log-rank only. Mirrors `x`'s shape rather than adding
    # a differently-structured field, since it is the same kind of thing: one
    # more parallel value per subject.
    events: list[Group] | None = None
    alternative: Literal["two-sided", "less", "greater"] = "two-sided"
    correction: Literal[
        "none", "bonferroni", "holm", "benjamini-hochberg", "tukey", "dunn"
    ] = "none"
    alpha: float = Field(default=0.05, gt=0, lt=1)
    welch: bool = True

    @field_validator("groups")
    @classmethod
    def unique_names(cls, groups: list[Group]) -> list[Group]:
        names = [g.name for g in groups]
        if len(set(names)) != len(names):
            raise ValueError("Group names must be unique.")
        return groups


class ComparisonOut(BaseModel):
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
    #: "below"/"above" when the test brackets its p-value instead of naming
    #: one — see `stats.tests.PBound`. Absent for every other test, so no
    #: existing client sees a change.
    pBound: str | None = None
    #: Where the statistic was attained and which sample was above the other
    #: there — see `stats.tests.Comparison`. Kolmogorov-Smirnov only; null for
    #: every other test, which is what stops a client drawing a marker for a
    #: statistic that has no single place on the axis.
    statisticLocation: float | None = None
    statisticSign: int | None = None


class OmnibusOut(BaseModel):
    statistic: float
    p: float
    df: list[float] | None
    #: As `ComparisonOut.pBound`.
    pBound: str | None = None


class FitOut(BaseModel):
    """The sufficient statistics of a fitted line — see `stats.tests.RegressionFit`."""

    slope: float
    intercept: float
    n: int
    meanX: float
    sumSquaredDevX: float
    residualSe: float
    tMultiplier: float
    confidenceLevel: float
    xMin: float
    xMax: float


class AnalyzeResponse(BaseModel):
    test: str
    omnibus: OmnibusOut | None
    comparisons: list[ComparisonOut]
    methodsSentence: str
    warnings: list[str]
    softwareVersions: dict[str, str]
    #: Only for tests that fit a line, and only when the fit is real — see `_fit_out`.
    fit: FitOut | None = None


def _sanitize(value: float | None) -> float | None:
    """JSON has no NaN or Infinity; emit null rather than invalid JSON."""
    if value is None:
        return None
    return value if value == value and abs(value) != float("inf") else None


def _sanitize_or(value: float | None, fallback: float) -> float:
    """`_sanitize(value) or fallback` looks equivalent and is not: Python's
    `or` treats a legitimate `0.0` as falsy, so it silently replaces a
    maximally significant p-value or q-value (or any other genuine zero)
    with the fallback meant only for NaN/Infinity. Checking `is not None`
    instead is what actually distinguishes "not a real number" from "zero"."""
    sanitized = _sanitize(value)
    return sanitized if sanitized is not None else fallback


def _fit_out(fit: RegressionFit | None) -> FitOut | None:
    """A fit, or nothing — never a partly-finite one.

    The same all-or-nothing rule `ci` above follows: a band drawn from a record
    with one NaN term in it is not a narrower band, it is a wrong one. `n` is an
    int and cannot be non-finite, so it is not part of the check.
    """
    if fit is None:
        return None
    values = {
        "slope": _sanitize(fit.slope),
        "intercept": _sanitize(fit.intercept),
        "meanX": _sanitize(fit.meanX),
        "sumSquaredDevX": _sanitize(fit.sumSquaredDevX),
        "residualSe": _sanitize(fit.residualSe),
        "tMultiplier": _sanitize(fit.tMultiplier),
        "confidenceLevel": _sanitize(fit.confidenceLevel),
        "xMin": _sanitize(fit.xMin),
        "xMax": _sanitize(fit.xMax),
    }
    if any(v is None for v in values.values()):
        return None
    return FitOut(n=fit.n, **values)  # type: ignore[arg-type]


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
    try:
        outcome = run_test(
            request.test,
            {g.name: g.values for g in request.groups},
            alternative=request.alternative,
            correction=request.correction,
            alpha=request.alpha,
            welch=request.welch,
            x=request.x.values if request.x else None,
            x_name=request.x.name if request.x else "x",
            events={g.name: g.values for g in request.events} if request.events else None,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - surface the cause to the UI
        logger.exception("Analysis failed")
        raise HTTPException(status_code=500, detail=f"Analysis failed: {error}") from error

    sentence = methods_sentence(
        request.test,
        outcome,
        alternative=request.alternative,
        correction=request.correction,
        alpha=request.alpha,
    )

    return AnalyzeResponse(
        test=request.test,
        omnibus=(
            OmnibusOut(
                statistic=outcome.omnibus.statistic,
                p=outcome.omnibus.p,
                df=outcome.omnibus.df,
                pBound=outcome.omnibus.pBound,
            )
            if outcome.omnibus
            else None
        ),
        comparisons=[
            ComparisonOut(
                groupA=c.groupA,
                groupB=c.groupB,
                statistic=_sanitize_or(c.statistic, 0.0),
                p=_sanitize_or(c.p, 1.0),
                pAdjusted=_sanitize_or(c.pAdjusted, 1.0),
                df=_sanitize(c.df),
                ci=(
                    (_sanitize(c.ci[0]), _sanitize(c.ci[1]))
                    if c.ci and _sanitize(c.ci[0]) is not None and _sanitize(c.ci[1]) is not None
                    else None
                ),
                effectSize=_sanitize(c.effectSize),
                effectSizeName=c.effectSizeName,
                n=c.n,
                pBound=c.pBound,
                # Through `_sanitize`, not passed straight through: a NaN
                # location would reach the client as `NaN` in JSON, which is
                # not valid JSON at all, and the renderer would then place a
                # marker at a coordinate that cannot be scaled.
                statisticLocation=_sanitize(c.statisticLocation),
                statisticSign=c.statisticSign,
            )
            for c in outcome.comparisons
        ],
        methodsSentence=sentence,
        warnings=outcome.warnings,
        softwareVersions=software_versions(),
        fit=_fit_out(outcome.fit),
    )


# ---------------------------------------------------------------------------
# PCA
# ---------------------------------------------------------------------------

# A defensive dimension cap, matching `ExportBody`'s size-validator style —
# this is cheap CPU-bound linear algebra on a small matrix, not an external
# hangable process, so it needs no semaphore/timeout the way export's
# Chromium/Ghostscript calls do; a sane bound is enough of a guard rail.
MAX_PCA_SAMPLES = 5000
MAX_PCA_FEATURES = 5000


class PcaRequest(BaseModel):
    rowLabels: list[str] = Field(min_length=1, max_length=MAX_PCA_SAMPLES)
    values: list[list[float | None]]
    standardize: bool = False

    @model_validator(mode="after")
    def _check_shape(self) -> PcaRequest:
        if len(self.values) != len(self.rowLabels):
            raise ValueError("rowLabels and values must have the same length.")
        if self.values and len(self.values[0]) > MAX_PCA_FEATURES:
            raise ValueError(f"PCA is limited to {MAX_PCA_FEATURES} features.")
        return self


class PcaComponentOut(BaseModel):
    label: str
    explainedVarianceRatio: float


class PcaResponse(BaseModel):
    sampleLabels: list[str]
    scores: list[list[float]]
    components: list[PcaComponentOut]
    droppedSamples: list[str]
    warnings: list[str]


@app.post("/pca", response_model=PcaResponse)
async def pca(request: PcaRequest) -> PcaResponse:
    try:
        outcome = compute_pca(request.rowLabels, request.values, standardize=request.standardize)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - surface the cause to the UI
        logger.exception("PCA failed")
        raise HTTPException(status_code=500, detail=f"PCA failed: {error}") from error

    return PcaResponse(
        sampleLabels=outcome.sampleLabels,
        scores=[[_sanitize_or(v, 0.0) for v in row] for row in outcome.scores],
        components=[
            PcaComponentOut(
                label=c.label,
                explainedVarianceRatio=_sanitize_or(c.explainedVarianceRatio, 0.0),
            )
            for c in outcome.components
        ],
        droppedSamples=outcome.droppedSamples,
        warnings=outcome.warnings,
    )


# ---------------------------------------------------------------------------
# UMAP
# ---------------------------------------------------------------------------

# Same reasoning as MAX_PCA_SAMPLES/MAX_PCA_FEATURES: a defensive dimension
# cap, not a performance tune. UMAP is heavier per-sample than PCA's SVD, but
# still bounded CPU work with no external process to hang, so a sane bound is
# guard rail enough — no semaphore or timeout needed.
MAX_UMAP_SAMPLES = 5000
MAX_UMAP_FEATURES = 5000


class UmapRequest(BaseModel):
    rowLabels: list[str] = Field(min_length=1, max_length=MAX_UMAP_SAMPLES)
    values: list[list[float | None]]
    standardize: bool = False

    @model_validator(mode="after")
    def _check_shape(self) -> UmapRequest:
        if len(self.values) != len(self.rowLabels):
            raise ValueError("rowLabels and values must have the same length.")
        if self.values and len(self.values[0]) > MAX_UMAP_FEATURES:
            raise ValueError(f"UMAP is limited to {MAX_UMAP_FEATURES} features.")
        return self


class UmapResponse(BaseModel):
    sampleLabels: list[str]
    coords: list[list[float]]
    droppedSamples: list[str]
    warnings: list[str]
    nNeighborsUsed: int


@app.post("/umap", response_model=UmapResponse)
async def umap(request: UmapRequest) -> UmapResponse:
    try:
        outcome = compute_umap(
            request.rowLabels, request.values, standardize=request.standardize
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - surface the cause to the UI
        logger.exception("UMAP failed")
        raise HTTPException(status_code=500, detail=f"UMAP failed: {error}") from error

    return UmapResponse(
        sampleLabels=outcome.sampleLabels,
        coords=[[_sanitize_or(v, 0.0) for v in row] for row in outcome.coords],
        droppedSamples=outcome.droppedSamples,
        warnings=outcome.warnings,
        nNeighborsUsed=outcome.nNeighborsUsed,
    )


# ---------------------------------------------------------------------------
# AI layout assistant
#
# `layout_assistant.py` never talks to a model directly — it takes an
# `LlmClient` and validates whatever comes back before returning it, so a
# malformed or hallucinated reply can never reach the document model. Which
# client it gets is decided here, by `AI_LAYOUT_ASSISTANT_BACKEND`
# (`stub` by default; `anthropic` opts into a real, billed call — see
# `llm_anthropic.py`). Nothing above `_llm_client` needs to know which one it
# is talking to, and the default requires no key and makes no network call.
# ---------------------------------------------------------------------------

# Same reasoning as MAX_PCA_SAMPLES/MAX_UMAP_SAMPLES: a defensive dimension
# cap on how many panels' worth of text is ever sent, not a performance tune.
MAX_LAYOUT_PANELS = 60


def _llm_client(client_supplied_key: str | None = None) -> LlmClient:
    # A key pasted into the app by the user is unambiguous intent to use the
    # real backend, regardless of how this server's own env var is set —
    # bringing your own key should not also require the operator to have
    # opted the server into the anthropic backend.
    if client_supplied_key:
        from .llm_anthropic import AnthropicLlmClient

        return AnthropicLlmClient(api_key=client_supplied_key)

    backend = os.getenv("AI_LAYOUT_ASSISTANT_BACKEND", "stub")
    if backend == "stub":
        return StubLlmClient()
    if backend == "anthropic":
        # Imported here, not at module load, so a stub-backed deployment is
        # unaffected by whether the `anthropic` package or its key are
        # present at all.
        from .llm_anthropic import AnthropicLlmClient

        return AnthropicLlmClient()
    raise HTTPException(
        status_code=503, detail=f"Unknown AI_LAYOUT_ASSISTANT_BACKEND '{backend}'."
    )


# `LlmClient.complete` is a synchronous call — trivial for the stub, but for
# `AnthropicLlmClient` a real, possibly slow network request. Calling it
# directly from an `async def` endpoint would block the event loop for every
# other request the whole time it ran. `asyncio.to_thread` moves it off the
# loop, `asyncio.wait_for` gives it a wall-clock bound, and the semaphore
# caps how many run at once — the identical shape (bound concurrency, bound
# time) `export/renderer.py` already uses around Chromium, applied here
# because `suggest_grouping`/`interpret_instruction` are synchronous
# functions regardless of which backend answers them. Harmless overhead for
# the stub, and what makes `AnthropicLlmClient` safe to select without this
# module needing to know which backend is active.
_LAYOUT_ASSISTANT_SLOTS = asyncio.Semaphore(2)
LAYOUT_ASSISTANT_TIMEOUT_S = 60

_T = TypeVar("_T")


async def _run_llm_task(fn: Callable[..., _T], *args: object) -> _T:
    async with _LAYOUT_ASSISTANT_SLOTS:
        return await asyncio.wait_for(
            asyncio.to_thread(fn, *args), timeout=LAYOUT_ASSISTANT_TIMEOUT_S
        )


class PanelSummaryIn(BaseModel):
    panelId: str
    letter: str
    plotType: str | None = None
    axisTitles: list[str] = []
    datasetName: str | None = None
    captionText: str | None = None


def _panel_summaries(panels: list[PanelSummaryIn]) -> list[PanelSummary]:
    return [
        PanelSummary(
            panel_id=p.panelId,
            letter=p.letter,
            plot_type=p.plotType,
            axis_titles=p.axisTitles,
            dataset_name=p.datasetName,
            caption_text=p.captionText,
        )
        for p in panels
    ]


class SuggestGroupingRequest(BaseModel):
    panels: list[PanelSummaryIn] = Field(min_length=1, max_length=MAX_LAYOUT_PANELS)
    apiKey: str | None = None


class GroupSuggestionOut(BaseModel):
    panelIds: list[str]
    rationale: str


class SuggestGroupingResponse(BaseModel):
    groups: list[GroupSuggestionOut]


@app.post("/layout/suggest-grouping", response_model=SuggestGroupingResponse)
async def layout_suggest_grouping(request: SuggestGroupingRequest) -> SuggestGroupingResponse:
    try:
        outcome = await _run_llm_task(
            suggest_grouping, _panel_summaries(request.panels), _llm_client(request.apiKey)
        )
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - surface the cause to the UI
        logger.exception("AI layout grouping suggestion failed")
        raise HTTPException(
            status_code=500, detail=f"AI layout grouping suggestion failed: {error}"
        ) from error

    return SuggestGroupingResponse(
        groups=[
            GroupSuggestionOut(panelIds=g.panel_ids, rationale=g.rationale)
            for g in outcome.groups
        ]
    )


class InterpretInstructionRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=500)
    panels: list[PanelSummaryIn] = Field(min_length=1, max_length=MAX_LAYOUT_PANELS)
    apiKey: str | None = None


class LayoutInstructionOut(BaseModel):
    kind: Literal["group", "resize", "unsupported"]
    reason: str
    panelIds: list[str] | None = None
    panelId: str | None = None
    direction: Literal["bigger", "smaller"] | None = None


@app.post("/layout/interpret", response_model=LayoutInstructionOut)
async def layout_interpret(request: InterpretInstructionRequest) -> LayoutInstructionOut:
    try:
        outcome = await _run_llm_task(
            interpret_instruction,
            request.instruction,
            _panel_summaries(request.panels),
            _llm_client(request.apiKey),
        )
    except HTTPException:
        raise
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - surface the cause to the UI
        logger.exception("AI layout instruction interpretation failed")
        raise HTTPException(
            status_code=500, detail=f"AI layout instruction interpretation failed: {error}"
        ) from error

    return LayoutInstructionOut(
        kind=outcome.kind,
        reason=outcome.reason,
        panelIds=outcome.panel_ids,
        panelId=outcome.panel_id,
        direction=outcome.direction,
    )


class TestApiKeyRequest(BaseModel):
    apiKey: str = Field(min_length=1)


def _probe_anthropic_key(api_key: str) -> None:
    # A minimal, cheap call — not through AnthropicLlmClient.complete(),
    # which expects a tool-use schema round trip a bare key check gets no
    # benefit from.
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    client.messages.create(
        model="claude-sonnet-5",
        max_tokens=1,
        messages=[{"role": "user", "content": "hi"}],
    )


@app.post("/layout/test-key")
async def layout_test_key(request: TestApiKeyRequest) -> dict:
    import anthropic

    try:
        await _run_llm_task(_probe_anthropic_key, request.apiKey)
    except anthropic.AuthenticationError as error:
        raise HTTPException(
            status_code=401, detail="That key was rejected by Anthropic."
        ) from error
    except Exception as error:  # noqa: BLE001 - surface the cause to the UI
        logger.exception("API key test failed")
        raise HTTPException(status_code=502, detail=f"Could not verify the key: {error}") from error
    return {"ok": True}


# ---------------------------------------------------------------------------
# Volcano test (Perseus-style permutation / SAM significance)
# ---------------------------------------------------------------------------

# Same reasoning as MAX_PCA_SAMPLES/MAX_UMAP_SAMPLES: a defensive dimension
# cap, not a performance tune — the permutation pass is the heaviest of the
# three, but still bounded CPU work with no external process to hang.
MAX_VOLCANO_TEST_ROWS = 20000
MAX_VOLCANO_TEST_SAMPLES = 100


class VolcanoTestRequest(BaseModel):
    rowLabels: list[str] = Field(min_length=1, max_length=MAX_VOLCANO_TEST_ROWS)
    values: list[list[float | None]]
    mode: Literal["two-sample", "one-sample"] = "two-sample"
    groupAIndices: list[int] | None = None
    groupBIndices: list[int] | None = None
    valueIndices: list[int] | None = None
    s0: float = 0.0
    fdrPercent: float = 5.0

    @model_validator(mode="after")
    def _check_shape(self) -> VolcanoTestRequest:
        if len(self.values) != len(self.rowLabels):
            raise ValueError("rowLabels and values must have the same length.")
        if self.values and len(self.values[0]) > MAX_VOLCANO_TEST_SAMPLES:
            raise ValueError(f"The volcano test is limited to {MAX_VOLCANO_TEST_SAMPLES} samples.")
        if self.mode == "two-sample":
            if self.groupAIndices is None or len(self.groupAIndices) < 2:
                raise ValueError("Each group needs at least 2 replicate columns.")
            if self.groupBIndices is None or len(self.groupBIndices) < 2:
                raise ValueError("Each group needs at least 2 replicate columns.")
        else:
            if self.valueIndices is None or len(self.valueIndices) < 3:
                raise ValueError("A one-sample test needs at least 3 replicate columns.")
        return self


class SamVolcanoRowOut(BaseModel):
    label: str
    log2FoldChange: float
    pValue: float
    qValue: float
    category: str


class VolcanoTestResponse(BaseModel):
    rows: list[SamVolcanoRowOut]
    curveUp: list[list[float]]
    curveDown: list[list[float]]
    droppedRows: list[str]
    warnings: list[str]
    deltaUsed: float
    fdrAchieved: float
    # The two resolved cutoffs on `d`. Reported separately rather than as one
    # magnitude because they are genuinely independent — see
    # `sam_methods_sentence` for why they need not be symmetric.
    cutUp: float
    cutLow: float
    permutations: int
    permutationsExhaustive: bool
    # Composed on this side, beside the numbers, exactly as `/analyze`'s own
    # `methodsSentence` is.
    methodsSentence: str


@app.post("/volcano-test", response_model=VolcanoTestResponse)
async def volcano_test(request: VolcanoTestRequest) -> VolcanoTestResponse:
    try:
        if request.mode == "one-sample":
            outcome = compute_sam_volcano_one_sample(
                request.rowLabels,
                request.values,
                value_indices=request.valueIndices or [],
                s0=request.s0,
                fdr_percent=request.fdrPercent,
            )
        else:
            outcome = compute_sam_volcano(
                request.rowLabels,
                request.values,
                group_a_indices=request.groupAIndices or [],
                group_b_indices=request.groupBIndices or [],
                s0=request.s0,
                fdr_percent=request.fdrPercent,
            )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001 - surface the cause to the UI
        logger.exception("Volcano test failed")
        raise HTTPException(status_code=500, detail=f"Volcano test failed: {error}") from error

    return VolcanoTestResponse(
        rows=[
            SamVolcanoRowOut(
                label=r.label,
                log2FoldChange=_sanitize_or(r.log2FoldChange, 0.0),
                pValue=_sanitize_or(r.pValue, 1.0),
                qValue=_sanitize_or(r.qValue, 1.0),
                category=r.category,
            )
            for r in outcome.rows
        ],
        curveUp=[[x, y] for x, y in outcome.curveUp],
        curveDown=[[x, y] for x, y in outcome.curveDown],
        droppedRows=outcome.droppedRows,
        warnings=outcome.warnings,
        deltaUsed=outcome.deltaUsed,
        fdrAchieved=outcome.fdrAchieved,
        # A cutoff of +/-inf is a real answer (nothing was called on that side),
        # so it is carried to the client as a finite sentinel rather than
        # dropped — `_sanitize_or` is the same guard every other route uses.
        cutUp=_sanitize_or(outcome.cutUp, 0.0),
        cutLow=_sanitize_or(outcome.cutLow, 0.0),
        permutations=outcome.permutations,
        permutationsExhaustive=outcome.permutationsExhaustive,
        methodsSentence=outcome.methodsSentence,
    )


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


# An SVG carrying full-resolution micrographs as base64 data URIs is the only
# realistic way to reach this size. Base64 costs 4/3, so this is roughly 96 MB
# of image bytes — beyond which the request would be copied whole three times
# (raw body, parsed str, `wrap_svg` f-string) before Chromium ever saw it.
MAX_EXPORT_BYTES = 128 * 1024 * 1024


@app.middleware("http")
async def limit_request_size(request: Request, call_next):
    """Reject an oversized body before reading it.

    The `max_length` on the field below is the fallback for a chunked request
    with no Content-Length; this is the guard that actually protects memory,
    because it answers without buffering the upload.
    """
    declared = request.headers.get("content-length")
    if declared is not None and request.url.path == "/export":
        try:
            if int(declared) > MAX_EXPORT_BYTES:
                return Response(
                    content=(
                        '{"detail":"Figure is too large to export. Reduce the '
                        'resolution or the on-page size of its images."}'
                    ),
                    status_code=413,
                    media_type="application/json",
                )
        except ValueError:
            pass
    return await call_next(request)


# Markup this renderer never emits, and that a browser would act on.
#
# Refused rather than sanitised. The SVG is interpolated into a page a real
# Chromium then loads with JavaScript enabled, and regex-scrubbing untrusted
# markup is a game you lose quietly — whereas refusing cannot corrupt a figure
# into something subtly different from what the author saw. Proven against the
# acceptance run's own output, which contains none of these.
# Only genuinely active elements. `javascript:` is not in the list because a
# figure could legitimately *say* it in a label, and the href check below
# catches it where it would actually do something. False positives matter: the
# renderer XML-escapes every `<` and `"` it writes, in text and attributes
# alike, so a label reading "<script>" cannot reach here as markup — but it can
# reach here as the literal characters of a naive substring test.
_FORBIDDEN_MARKUP = ("<script", "<foreignobject", "<iframe")
_EVENT_ATTRIBUTE = re.compile(r"""\son[a-z]+\s*=\s*["']""", re.IGNORECASE)
_HREF_PATTERN = re.compile(r"""\b(?:xlink:)?href\s*=\s*["']([^"']*)["']""", re.IGNORECASE)


def _reject_active_content(svg: str) -> str | None:
    """Why this SVG must not be rendered, or None if it is inert."""
    lowered = svg.lower()
    for token in _FORBIDDEN_MARKUP:
        if token in lowered:
            return f"The figure contains {token.lstrip('<')}, which this exporter does not render."

    if _EVENT_ATTRIBUTE.search(svg):
        return "The figure carries an event handler attribute, which this exporter does not run."

    for href in _HREF_PATTERN.findall(svg):
        value = href.strip()
        # Everything legitimate is self-contained: images arrive as data URIs
        # and clip paths as same-document fragments.
        if value.startswith("data:") or value.startswith("#") or value == "":
            continue
        return (
            f"The figure references an external resource ({value[:60]}). "
            "Embed it in the document instead."
        )

    return None


# Beyond this, a raster export is an allocation the service does not survive.
# 2000 mm at 600 dpi is 47 244 px per side — 2.2 Gpx, an OOM kill behind a
# generic 500. The same reasoning as `Image.MAX_IMAGE_PIXELS` in the decoder:
# raise the ceiling to cover real work, do not remove it.
MAX_RASTER_PIXELS = 250_000_000


class ExportBody(BaseModel):
    svg: str = Field(min_length=1, max_length=MAX_EXPORT_BYTES)
    widthMm: float = Field(gt=0, le=2000)
    heightMm: float = Field(gt=0, le=2000)
    format: Literal["svg", "pdf", "eps", "png", "tiff"] = "pdf"
    dpi: Literal[150, 300, 450, 600] = 300
    # A quote or a newline here injects into the Content-Disposition header. The
    # web client happens to strip the name to the same shape; a direct caller
    # does not, so the guarantee belongs on this side of the wire.
    filename: str = Field(default="figure", pattern=r"^[A-Za-z0-9_-]{1,120}$")

    @model_validator(mode="after")
    def _check_raster_size(self) -> ExportBody:
        if self.format not in ("png", "tiff"):
            return self
        pixels = round(self.widthMm / 25.4 * self.dpi) * round(self.heightMm / 25.4 * self.dpi)
        if pixels > MAX_RASTER_PIXELS:
            raise ValueError(
                f"{self.widthMm:.0f} × {self.heightMm:.0f} mm at {self.dpi} dpi is "
                f"{pixels / 1e6:.0f} megapixels, over the {MAX_RASTER_PIXELS / 1e6:.0f} Mpx "
                "limit. Export a smaller figure, or a lower resolution."
            )
        return self


@app.post("/export")
async def export(body: ExportBody) -> Response:
    refusal = _reject_active_content(body.svg)
    if refusal is not None:
        raise HTTPException(status_code=422, detail=refusal)

    try:
        data = await render(
            ExportRequest(
                svg=body.svg,
                width_mm=body.widthMm,
                height_mm=body.heightMm,
                format=body.format,
                dpi=body.dpi,
            )
        )
    except RuntimeError as error:
        raise HTTPException(status_code=500, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001
        logger.exception("Export failed")
        raise HTTPException(status_code=500, detail=f"Export failed: {error}") from error

    return Response(
        content=data,
        media_type=MEDIA_TYPES[body.format],
        headers={
            "Content-Disposition": f'attachment; filename="{body.filename}.{body.format}"',
        },
    )


# ---------------------------------------------------------------------------
# Image decoding
# ---------------------------------------------------------------------------


# Module-level so the dependency is not constructed in a default argument,
# which ruff flags (B008) and which re-evaluates per call.
_UPLOADED_IMAGE = File(...)


@app.post("/decode-image")
async def decode_image(file: UploadFile = _UPLOADED_IMAGE) -> Response:
    """Decode an image the browser cannot open, returning a PNG display proxy.

    Multipart in, raw PNG out, with the metadata in headers. Base64 in JSON
    would inflate a 200 MB micrograph to 267 MB of Python `str` held whole by
    pydantic; multipart streams to a spooled temporary file instead.

    The caller keeps the *original* bytes for the archive. This response is a
    proxy for display and export only.
    """
    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="The uploaded file is empty.")

    try:
        decoded = decode(data)
    except TooLargeError as error:
        raise HTTPException(status_code=413, detail=str(error)) from error
    except DecodeError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except Exception as error:  # noqa: BLE001
        logger.exception("Image decode failed")
        raise HTTPException(status_code=500, detail=f"Image decode failed: {error}") from error

    headers = {
        "X-Image-Width": str(decoded.width),
        "X-Image-Height": str(decoded.height),
        "X-Image-Source-Format": decoded.source_format,
    }
    if decoded.frames > 1:
        headers["X-Image-Frames"] = str(decoded.frames)
    # Both calibration headers are present or neither is. A partial answer
    # cannot be told apart from a measurement by anything downstream.
    if decoded.pixels_per_unit is not None and decoded.unit_label:
        headers["X-Image-Pixels-Per-Unit"] = repr(decoded.pixels_per_unit)
        headers["X-Image-Unit-Label"] = decoded.unit_label
    if decoded.notes:
        headers["X-Image-Notes"] = " ".join(decoded.notes)

    return Response(content=decoded.png, media_type="image/png", headers=headers)
