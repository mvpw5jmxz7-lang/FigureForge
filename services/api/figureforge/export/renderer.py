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
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from playwright.async_api import Browser, async_playwright

ExportFormat = Literal["svg", "pdf", "eps", "png", "tiff"]

MM_PER_INCH = 25.4
PT_PER_MM = 72 / 25.4

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
        return pdf if request.format == "pdf" else pdf_to_eps(pdf)

    png = await _render_png(request)
    return png if request.format == "png" else png_to_tiff(png, request.dpi)


async def _render_pdf(request: ExportRequest) -> bytes:
    browser = await get_browser()
    page = await browser.new_page()
    try:
        await page.set_content(
            wrap_svg(request.svg, request.width_mm, request.height_mm), wait_until="load"
        )
        # Fonts must be resolved before printing or glyphs fall back mid-render.
        await page.evaluate("document.fonts.ready")
        pdf = await page.pdf(
            width=f"{request.width_mm}mm",
            height=f"{request.height_mm}mm",
            print_background=True,
            margin={"top": "0", "bottom": "0", "left": "0", "right": "0"},
            prefer_css_page_size=True,
        )
    finally:
        await page.close()

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

    browser = await get_browser()
    page = await browser.new_page(
        viewport={"width": max(1, round(css_width)), "height": max(1, round(css_height))},
        device_scale_factor=scale,
    )
    try:
        await page.set_content(
            wrap_svg(request.svg, request.width_mm, request.height_mm), wait_until="load"
        )
        await page.evaluate("document.fonts.ready")
        return await page.screenshot(omit_background=False, type="png")
    finally:
        await page.close()


def pdf_to_eps(pdf: bytes) -> bytes:
    """Convert via Ghostscript's eps2write.

    EPS is single-page by definition, so a PDF that accidentally paginated will
    fail here rather than silently losing content.
    """
    with tempfile.TemporaryDirectory() as tmp:
        pdf_path = Path(tmp) / "figure.pdf"
        eps_path = Path(tmp) / "figure.eps"
        pdf_path.write_bytes(pdf)

        result = subprocess.run(
            [
                "gs", "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER",
                "-sDEVICE=eps2write",
                "-dEPSCrop",
                f"-sOutputFile={eps_path}",
                str(pdf_path),
            ],
            capture_output=True,
            text=True,
        )

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
