"""Export engine.

The SVG arriving here was produced by the same TypeScript renderer that drew the
canvas, so this module never decides how anything looks — it only converts.

Pipeline:
    SVG ──> Chromium ──> PDF (text stays text, fonts subset and embedded)
                  └───> PNG at an exact DPI ──> TIFF
            PDF  ──> Ghostscript ──> EPS

Two details are load-bearing and easy to regress:

1. ``svg { display: block }`` in the wrapper page. An inline SVG sits on a text
   baseline and the descender space beneath it spills past the page box, so the
   PDF comes out as two pages — and Ghostscript then refuses to make an EPS at
   all.
2. Explicit page dimensions in millimetres, so 1 SVG user unit stays 1 mm all
   the way to paper.
"""

from __future__ import annotations

import asyncio
import io
import subprocess
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from playwright.async_api import Browser, Page, Route, async_playwright

ExportFormat = Literal["svg", "pdf", "eps", "png", "tiff"]

MM_PER_INCH = 25.4
PT_PER_MM = 72 / 25.4

# A figure that has not rendered in two minutes is not going to. Without these
# a hung Chromium or a hung Ghostscript occupies a worker until the process is
# restarted, which is indistinguishable from the service being down.
RENDER_TIMEOUT_S = 120
GHOSTSCRIPT_TIMEOUT_S = 120

# Each concurrent export is a full renderer holding a whole figure — a 600 dpi
# A4 page is ~35 Mpx of backing store before any micrograph. Two at a time is a
# queue; unbounded is an OOM kill under the load that matters most.
_render_slots = asyncio.Semaphore(2)

_browser: Browser | None = None
_playwright = None
_lock = asyncio.Lock()


async def get_browser() -> Browser:
    """Reuse one Chromium instance; launching costs ~300 ms per export."""
    global _browser, _playwright
    async with _lock:
        if _browser is None or not _browser.is_connected():
            _playwright = await async_playwright().start()
            _browser = await _playwright.chromium.launch(args=["--font-render-hinting=none"])
        return _browser


@asynccontextmanager
async def _export_page(**page_options) -> AsyncIterator[Page]:
    """A page that cannot reach the network, in its own context.

    The SVG arriving here is untrusted input interpolated into a page a real
    browser then loads with JavaScript enabled. Blocking every request that is
    not a `data:` URI closes remote ``href``s, ``<script src>``, web-font
    fetches and SSRF against the pod's own API in one line — and costs nothing,
    because everything this renderer legitimately emits is inline or a data URI.
    (``main.py`` additionally *refuses* an SVG containing script or a foreign
    scheme; this is the belt to that pair of braces.)

    A fresh context per export rather than a shared one: pages on a single
    context share storage and service workers, so one export could observe
    another's.
    """
    browser = await get_browser()
    context = await browser.new_context(**page_options)
    try:
        await context.route("**/*", _block_remote)
        page = await context.new_page()
        page.set_default_timeout(RENDER_TIMEOUT_S * 1000)
        yield page
    finally:
        await context.close()


async def _block_remote(route: Route) -> None:
    # Everything the figure needs is already in the document: images arrive as
    # data URIs and fonts come from the image's own fontconfig, not the network.
    if route.request.url.startswith(("data:", "about:", "blob:")):
        await route.continue_()
    else:
        await route.abort()


async def shutdown_browser() -> None:
    global _browser, _playwright
    if _browser is not None:
        await _browser.close()
        _browser = None
    if _playwright is not None:
        await _playwright.stop()
        _playwright = None


def wrap_svg(svg: str, width_mm: float, height_mm: float) -> str:
    """Wrap bare SVG in a page sized exactly to the figure."""
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
@page {{ size: {width_mm}mm {height_mm}mm; margin: 0; }}
html, body {{ margin: 0; padding: 0; width: {width_mm}mm; height: {height_mm}mm; }}
svg {{ display: block; }}
</style></head>
<body>{svg}</body></html>"""


@dataclass
class ExportRequest:
    svg: str
    width_mm: float
    height_mm: float
    format: ExportFormat
    dpi: int = 300


async def render(request: ExportRequest) -> bytes:
    if request.format == "svg":
        return request.svg.encode("utf-8")

    if request.format in ("pdf", "eps"):
        pdf = await _render_pdf(request)
        return pdf if request.format == "pdf" else pdf_to_eps(pdf, request.dpi)

    if request.format in ("png", "tiff"):
        png = await _render_png(request)
        return png if request.format == "png" else png_to_tiff(png, request.dpi)

    # Unreachable over HTTP — pydantic validates the literal first — but this is
    # called directly by the tests and the acceptance script, where a typo
    # previously fell through and returned a PNG labelled as something else.
    raise ValueError(f"Unsupported export format: {request.format!r}")


async def _render_pdf(request: ExportRequest) -> bytes:
    async with _render_slots:
        async with _export_page() as page:
            await page.set_content(
                wrap_svg(request.svg, request.width_mm, request.height_mm), wait_until="load"
            )
            # Fonts must be resolved before printing or glyphs fall back mid-render.
            await page.evaluate("document.fonts.ready")
            pdf = await asyncio.wait_for(
                page.pdf(
                    width=f"{request.width_mm}mm",
                    height=f"{request.height_mm}mm",
                    print_background=True,
                    margin={"top": "0", "bottom": "0", "left": "0", "right": "0"},
                    prefer_css_page_size=True,
                ),
                timeout=RENDER_TIMEOUT_S,
            )

    return crop_to_exact(pdf, request.width_mm, request.height_mm)


def crop_to_exact(pdf: bytes, width_mm: float, height_mm: float) -> bytes:
    """Trim the page box to the exact figure dimensions.

    Chromium rounds the PDF page box *up* to a whole 1/300-inch device unit
    (0.24 pt), so a 183 mm figure comes out on a 183.13 mm page. The drawing
    itself is unaffected — the surplus is blank — but a journal measuring the
    page, or auto-scaling it to the column width, would see the wrong size.

    The fix is a crop, never a scale: rescaling to fit would shrink every font
    below the size the theme guarantees. Content is anchored at the top-left in
    CSS, which is the *top* in PDF coordinates, so the surplus sits at low y and
    the box is trimmed from the bottom-left.
    """
    from pypdf import PdfReader, PdfWriter

    exact_w = width_mm * PT_PER_MM
    exact_h = height_mm * PT_PER_MM

    reader = PdfReader(io.BytesIO(pdf))
    writer = PdfWriter()

    for page in reader.pages:
        current_h = float(page.mediabox.top) - float(page.mediabox.bottom)
        # Guard against a page that is somehow smaller than requested.
        bottom = max(float(page.mediabox.bottom), current_h - exact_h)
        page.mediabox.lower_left = (0, bottom)
        page.mediabox.upper_right = (exact_w, bottom + exact_h)
        page.cropbox = page.mediabox
        writer.add_page(page)

    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


async def _render_png(request: ExportRequest) -> bytes:
    # Chromium's viewport is in CSS pixels at 96 dpi; the scale factor buys the
    # extra resolution rather than upscaling afterwards, so the output is
    # genuinely 300/600 dpi and not an interpolated 96 dpi image.
    scale = request.dpi / 96.0
    css_width = request.width_mm / MM_PER_INCH * 96.0
    css_height = request.height_mm / MM_PER_INCH * 96.0

    async with _render_slots:
        async with _export_page(
            viewport={"width": max(1, round(css_width)), "height": max(1, round(css_height))},
            device_scale_factor=scale,
        ) as page:
            await page.set_content(
                wrap_svg(request.svg, request.width_mm, request.height_mm), wait_until="load"
            )
            await page.evaluate("document.fonts.ready")
            return await asyncio.wait_for(
                page.screenshot(omit_background=False, type="png"), timeout=RENDER_TIMEOUT_S
            )


def pdf_to_eps(pdf: bytes, dpi: int = 300) -> bytes:
    """Convert via Ghostscript's eps2write.

    EPS is single-page by definition, so a PDF that accidentally paginated will
    fail here rather than silently losing content.

    `-r` matters once figures carry micrographs. eps2write is a vector device;
    it re-emits any embedded raster as PostScript image data at the device
    resolution, which defaults to 720 dpi — resampling a 300 dpi micrograph
    upward for no gain in detail.

    Measured in this image rather than assumed: on a figure with an embedded
    raster, `-r300` produced an EPS 14% smaller than the default; on a
    vector-only figure the difference was 0.1%, and the %%BoundingBox was
    byte-identical in both cases. So it costs nothing where it does not apply.
    """
    with tempfile.TemporaryDirectory() as tmp:
        pdf_path = Path(tmp) / "figure.pdf"
        eps_path = Path(tmp) / "figure.eps"
        pdf_path.write_bytes(pdf)

        try:
            result = subprocess.run(
                [
                    "gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
                    "-sDEVICE=eps2write",
                    "-dEPSCrop",
                    f"-r{dpi}",
                    f"-sOutputFile={eps_path}",
                    str(pdf_path),
                ],
                capture_output=True,
                text=True,
                # Without this a Ghostscript that never returns holds the worker
                # for the lifetime of the process.
                timeout=GHOSTSCRIPT_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                f"EPS conversion timed out after {GHOSTSCRIPT_TIMEOUT_S} s. "
                "The figure may carry an unusually large embedded image."
            ) from error

        if result.returncode != 0 or not eps_path.exists():
            raise RuntimeError(f"EPS conversion failed: {result.stderr.strip() or 'unknown error'}")

        return eps_path.read_bytes()


def png_to_tiff(png: bytes, dpi: int) -> bytes:
    """TIFF with LZW compression and the DPI recorded in the header.

    Journals read the embedded resolution, so writing it is what makes a
    "600 dpi TIFF" actually declare itself as one.
    """
    from PIL import Image

    with Image.open(io.BytesIO(png)) as image:
        rgb = image.convert("RGB")
        buffer = io.BytesIO()
        rgb.save(buffer, format="TIFF", compression="tiff_lzw", dpi=(dpi, dpi))
        return buffer.getvalue()


def effective_dpi(pixel_width: int, rendered_width_mm: float) -> float:
    if rendered_width_mm <= 0:
        return 0.0
    return pixel_width / (rendered_width_mm / MM_PER_INCH)
