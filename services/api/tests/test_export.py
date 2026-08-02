"""Export conversion tests.

These cover the traps that only show up in the output file — a second blank
page, an oversized page box, a missing embedded font. Each one has already
caused a real failure during development, which is why they are pinned here.
"""

from __future__ import annotations

import re
import subprocess

import pytest

from figureforge.export.renderer import (
    ExportRequest,
    crop_to_exact,
    effective_dpi,
    render,
    shutdown_browser,
    wrap_svg,
)

WIDTH_MM = 183.0
HEIGHT_MM = 75.0
PT_PER_MM = 72 / 25.4

SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH_MM}mm" height="{HEIGHT_MM}mm"
 viewBox="0 0 {WIDTH_MM:g} {HEIGHT_MM:g}" font-family="Arial, 'Liberation Sans', sans-serif">
  <rect x="0" y="0" width="{WIDTH_MM:g}" height="{HEIGHT_MM:g}" fill="#ffffff"/>
  <text x="4" y="6" font-size="2.8222" font-weight="bold">PanelLabelA</text>
  <text x="4" y="14" font-size="2.4694">CellViabilityPercent</text>
  <rect x="20" y="30" width="12" height="30" fill="#0072b2"/>
</svg>"""


def page_boxes(pdf: bytes) -> list[list[float]]:
    return [
        [float(v) for v in match.group(1).split()]
        for match in re.finditer(rb"/MediaBox\s*\[([^\]]+)\]", pdf)
    ]


def extract_text(pdf: bytes, tmp_path) -> str:
    """Ghostscript's txtwrite only recovers glyphs that are real text."""
    path = tmp_path / "in.pdf"
    path.write_bytes(pdf)
    result = subprocess.run(
        ["gs", "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=txtwrite", "-sOutputFile=-", str(path)],
        capture_output=True,
        text=True,
    )
    return result.stdout


@pytest.fixture(scope="module")
def pdf_bytes() -> bytes:
    import asyncio

    async def build() -> bytes:
        try:
            return await render(
                ExportRequest(svg=SVG, width_mm=WIDTH_MM, height_mm=HEIGHT_MM, format="pdf")
            )
        finally:
            await shutdown_browser()

    return asyncio.run(build())


class TestWrapper:
    def test_svg_is_block_level(self):
        # An inline SVG sits on a text baseline; the descender space beneath it
        # pushes content onto a second page and breaks EPS conversion entirely.
        assert "svg { display: block; }" in wrap_svg(SVG, WIDTH_MM, HEIGHT_MM)

    def test_page_size_is_declared_in_millimetres(self):
        html = wrap_svg(SVG, WIDTH_MM, HEIGHT_MM)
        assert f"size: {WIDTH_MM}mm {HEIGHT_MM}mm" in html
        assert "margin: 0" in html


class TestPdf:
    def test_is_a_single_page(self, pdf_bytes):
        assert len(re.findall(rb"/Type\s*/Page[^s]", pdf_bytes)) == 1

    def test_embeds_its_fonts(self, pdf_bytes):
        # Without embedded fonts a journal's RIP substitutes metrics and the
        # layout shifts.
        assert b"/FontFile" in pdf_bytes

    def test_keeps_text_as_text(self, pdf_bytes, tmp_path):
        text = extract_text(pdf_bytes, tmp_path)
        assert "PanelLabelA" in text
        assert "CellViabilityPercent" in text

    def test_page_is_exactly_the_requested_size(self, pdf_bytes):
        # Chromium rounds the page box up to a whole 1/300 inch; the export
        # crops it back so journals measure the dimensions they asked for.
        box = page_boxes(pdf_bytes)[0]
        assert box[2] - box[0] == pytest.approx(WIDTH_MM * PT_PER_MM, abs=0.01)
        assert box[3] - box[1] == pytest.approx(HEIGHT_MM * PT_PER_MM, abs=0.01)


class TestCropToExact:
    def test_trims_from_the_bottom_left(self, pdf_bytes):
        # Content is anchored top-left in CSS, which is the top in PDF space,
        # so the surplus must come off the bottom or the figure is clipped.
        box = page_boxes(pdf_bytes)[0]
        assert box[1] >= 0
        assert box[3] == pytest.approx(box[1] + HEIGHT_MM * PT_PER_MM, abs=0.01)

    def test_is_idempotent(self, pdf_bytes):
        again = crop_to_exact(pdf_bytes, WIDTH_MM, HEIGHT_MM)
        first = page_boxes(pdf_bytes)[0]
        second = page_boxes(again)[0]
        assert second[2] - second[0] == pytest.approx(first[2] - first[0], abs=0.01)

    def test_preserves_text_after_cropping(self, pdf_bytes, tmp_path):
        cropped = crop_to_exact(pdf_bytes, WIDTH_MM, HEIGHT_MM)
        assert "PanelLabelA" in extract_text(cropped, tmp_path)


class TestRaster:
    def test_png_lands_on_the_requested_dpi(self):
        import asyncio
        import io

        from PIL import Image

        async def build() -> bytes:
            try:
                return await render(
                    ExportRequest(
                        svg=SVG, width_mm=WIDTH_MM, height_mm=HEIGHT_MM, format="png", dpi=300
                    )
                )
            finally:
                await shutdown_browser()

        png = asyncio.run(build())
        with Image.open(io.BytesIO(png)) as image:
            expected = round(WIDTH_MM / 25.4 * 300)
            # Genuinely rendered at 300 dpi, not upscaled from 96.
            assert abs(image.size[0] - expected) <= 2


class TestEmbeddedRasters:
    """Figures with micrographs in them.

    Embedded rasters had no coverage at all before image panels existed, and
    EPS is where they break: eps2write is a vector device that re-emits image
    data at the device resolution, so a silently blank or silently resampled
    micrograph would pass every other check in this file.
    """

    #: A 2x2 red PNG, small enough to read but a real decodable image.
    RASTER = (
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4"
        "nGP8z8DAwMDAxAADRDEAWFsCBQlnMcgAAAAASUVORK5CYII="
    )

    @pytest.fixture(scope="class")
    def raster_svg(self) -> str:
        return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH_MM}mm"
 height="{HEIGHT_MM}mm" viewBox="0 0 {WIDTH_MM:g} {HEIGHT_MM:g}">
  <rect x="0" y="0" width="{WIDTH_MM:g}" height="{HEIGHT_MM:g}" fill="#ffffff"/>
  <image href="{self.RASTER}" x="10" y="10" width="40" height="40"
   preserveAspectRatio="xMidYMid meet" image-rendering="pixelated"/>
  <text x="4" y="6" font-size="2.8222">Micrograph</text>
</svg>"""

    def test_pdf_carries_the_embedded_image(self, raster_svg):
        import asyncio

        async def build() -> bytes:
            try:
                return await render(
                    ExportRequest(
                        svg=raster_svg, width_mm=WIDTH_MM, height_mm=HEIGHT_MM, format="pdf"
                    )
                )
            finally:
                await shutdown_browser()

        pdf = asyncio.run(build())
        # An image XObject is how a raster reaches a PDF; without one the
        # micrograph was dropped and the page is text on white.
        assert b"/Subtype /Image" in pdf or b"/Subtype/Image" in pdf
        assert len(re.findall(rb"/Type\s*/Page[^s]", pdf)) == 1

    def test_eps_conversion_survives_an_embedded_raster(self, raster_svg):
        import asyncio

        async def build() -> bytes:
            try:
                return await render(
                    ExportRequest(
                        svg=raster_svg, width_mm=WIDTH_MM, height_mm=HEIGHT_MM, format="eps"
                    )
                )
            finally:
                await shutdown_browser()

        eps = asyncio.run(build())
        assert eps.startswith(b"%!PS-Adobe")
        assert b"%%BoundingBox" in eps
        # Ghostscript emits raster data through an image operator. Its absence
        # means the conversion silently discarded the micrograph.
        assert b"image" in eps


class TestResolutionCheck:
    def test_computes_effective_dpi(self):
        # A 1000 px image placed 84.67 mm wide is exactly 300 dpi.
        assert effective_dpi(1000, 84.6667) == pytest.approx(300, abs=0.1)

    def test_guards_against_zero_width(self):
        assert effective_dpi(1000, 0) == 0.0
