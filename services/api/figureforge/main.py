"""FigureForge API.

Two responsibilities, deliberately narrow:

  * /analyze  — run a statistical test, return numbers and a methods sentence
  * /export   — convert a rendered SVG to PDF/EPS/PNG/TIFF

This service never decides how a figure looks. All layout and drawing happen in
the TypeScript renderer, which runs identically in the browser and here, so the
export cannot drift from what the author saw on screen.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator

from .export.renderer import ExportRequest, render, shutdown_browser
from .stats.methods import methods_sentence, software_versions
from .stats.tests import run_test

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
    groups: list[Group] = Field(min_length=2)
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


class OmnibusOut(BaseModel):
    statistic: float
    p: float
    df: list[float] | None


class AnalyzeResponse(BaseModel):
    test: str
    omnibus: OmnibusOut | None
    comparisons: list[ComparisonOut]
    methodsSentence: str
    warnings: list[str]
    softwareVersions: dict[str, str]


def _sanitize(value: float | None) -> float | None:
    """JSON has no NaN or Infinity; emit null rather than invalid JSON."""
    if value is None:
        return None
    return value if value == value and abs(value) != float("inf") else None


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
            )
            if outcome.omnibus
            else None
        ),
        comparisons=[
            ComparisonOut(
                groupA=c.groupA,
                groupB=c.groupB,
                statistic=_sanitize(c.statistic) or 0.0,
                p=_sanitize(c.p) or 1.0,
                pAdjusted=_sanitize(c.pAdjusted) or 1.0,
                df=_sanitize(c.df),
                ci=(
                    (_sanitize(c.ci[0]), _sanitize(c.ci[1]))
                    if c.ci and _sanitize(c.ci[0]) is not None and _sanitize(c.ci[1]) is not None
                    else None
                ),
                effectSize=_sanitize(c.effectSize),
                effectSizeName=c.effectSizeName,
                n=c.n,
            )
            for c in outcome.comparisons
        ],
        methodsSentence=sentence,
        warnings=outcome.warnings,
        softwareVersions=software_versions(),
    )


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


class ExportBody(BaseModel):
    svg: str = Field(min_length=1)
    widthMm: float = Field(gt=0, le=2000)
    heightMm: float = Field(gt=0, le=2000)
    format: Literal["svg", "pdf", "eps", "png", "tiff"] = "pdf"
    dpi: Literal[150, 300, 450, 600] = 300
    filename: str = "figure"


@app.post("/export")
async def export(body: ExportBody) -> Response:
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
