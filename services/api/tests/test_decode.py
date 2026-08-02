"""Image decoding tests.

Fixtures are built with Pillow here rather than committed as binaries: a
checked-in TIFF is an opaque blob nobody can audit, and the interesting part of
every case below is precisely which tags it carries.

The calibration cases are grounded in ImageJ's documented TIFF conventions
rather than in numbers this code produced.
"""

from __future__ import annotations

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, TiffImagePlugin

from figureforge.images.decode import decode, read_calibration
from figureforge.main import app

client = TestClient(app)


def tiff_bytes(
    image: Image.Image,
    *,
    description: str | None = None,
    x_resolution: float | None = None,
    resolution_unit: int | None = None,
    extra_frames: list[Image.Image] | None = None,
) -> bytes:
    tags = TiffImagePlugin.ImageFileDirectory_v2()
    if description is not None:
        tags[270] = description
    if x_resolution is not None:
        tags[282] = x_resolution
        tags[283] = x_resolution
    if resolution_unit is not None:
        tags[296] = resolution_unit

    buffer = io.BytesIO()
    if extra_frames:
        image.save(buffer, format="TIFF", tiffinfo=tags, save_all=True, append_images=extra_frames)
    else:
        image.save(buffer, format="TIFF", tiffinfo=tags)
    return buffer.getvalue()


def post(data: bytes, filename: str = "micrograph.tif"):
    return client.post("/decode-image", files={"file": (filename, data, "image/tiff")})


# ---------------------------------------------------------------------------
# Decoding
# ---------------------------------------------------------------------------


class TestDecoding:
    def test_decodes_a_tiff_to_png(self):
        data = tiff_bytes(Image.new("RGB", (64, 48), (10, 120, 200)))
        response = post(data)

        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
        with Image.open(io.BytesIO(response.content)) as out:
            assert out.format == "PNG"
            assert out.size == (64, 48)

    def test_reports_the_natural_pixel_size(self):
        # This is what feeds ImageNode.naturalPx, and so the dpi check. A wrong
        # answer here makes every resolution warning wrong.
        response = post(tiff_bytes(Image.new("RGB", (1024, 768))))
        assert response.headers["X-Image-Width"] == "1024"
        assert response.headers["X-Image-Height"] == "768"
        assert response.headers["X-Image-Source-Format"] == "TIFF"

    def test_rejects_a_file_that_is_not_an_image(self):
        response = client.post(
            "/decode-image", files={"file": ("notes.txt", b"not an image at all", "text/plain")}
        )
        assert response.status_code == 422
        assert "image" in response.json()["detail"].lower()

    def test_rejects_an_empty_upload(self):
        response = client.post("/decode-image", files={"file": ("empty.tif", b"", "image/tiff")})
        assert response.status_code == 422

    def test_rejects_a_decompression_bomb(self, monkeypatch):
        # Pillow's guard exists because a few kilobytes of header can declare a
        # multi-gigapixel image. Lower the ceiling rather than build one.
        monkeypatch.setattr("figureforge.images.decode.MAX_PIXELS", 1000)
        response = post(tiff_bytes(Image.new("RGB", (200, 200))))

        assert response.status_code == 413
        # The limit has to be named, or the author cannot tell what to change.
        assert "megapixel" in response.json()["detail"]

    def test_rejects_an_oversized_upload(self, monkeypatch):
        monkeypatch.setattr("figureforge.images.decode.MAX_UPLOAD_BYTES", 128)
        response = post(tiff_bytes(Image.new("RGB", (64, 64))))

        assert response.status_code == 413
        assert "MB" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------


class TestCalibration:
    def test_reads_imagej_calibration(self):
        # ImageJ writes ResolutionUnit = 1 ("none") and puts the real unit in
        # ImageDescription, with XResolution in pixels per *that* unit. A reader
        # that only knows the baseline convention reports this as 2.5 dpi.
        data = tiff_bytes(
            Image.new("RGB", (64, 48)),
            description="ImageJ=1.54f\nunit=um\nspacing=1.0\n",
            x_resolution=2.5,
            resolution_unit=1,
        )
        response = post(data)

        assert float(response.headers["X-Image-Pixels-Per-Unit"]) == pytest.approx(2.5)
        assert response.headers["X-Image-Unit-Label"] == "um"

    def test_reads_baseline_inch_resolution(self):
        data = tiff_bytes(
            Image.new("RGB", (64, 48)), x_resolution=600, resolution_unit=2
        )
        response = post(data)

        assert float(response.headers["X-Image-Pixels-Per-Unit"]) == pytest.approx(600)
        assert response.headers["X-Image-Unit-Label"] == "in"

    def test_reads_baseline_centimetre_resolution(self):
        data = tiff_bytes(
            Image.new("RGB", (64, 48)), x_resolution=300, resolution_unit=3
        )
        response = post(data)
        assert response.headers["X-Image-Unit-Label"] == "cm"

    def test_omits_calibration_when_the_file_does_not_state_it(self):
        # Withheld, never guessed: a default here would be indistinguishable,
        # to every later reader, from a real measurement of the specimen.
        response = post(tiff_bytes(Image.new("RGB", (64, 48))))

        assert "X-Image-Pixels-Per-Unit" not in response.headers
        assert "X-Image-Unit-Label" not in response.headers

    def test_omits_calibration_for_a_dimensionless_ratio(self):
        # ResolutionUnit 1 with no unit= line means the number has no dimension.
        data = tiff_bytes(
            Image.new("RGB", (64, 48)),
            description="something else entirely",
            x_resolution=2.5,
            resolution_unit=1,
        )
        response = post(data)
        assert "X-Image-Pixels-Per-Unit" not in response.headers

    def test_read_calibration_returns_none_for_a_png(self):
        buffer = io.BytesIO()
        Image.new("RGB", (8, 8)).save(buffer, format="PNG")
        with Image.open(io.BytesIO(buffer.getvalue())) as image:
            assert read_calibration(image) == (None, None)


# ---------------------------------------------------------------------------
# Proxies that lose something, and say so
# ---------------------------------------------------------------------------


class TestLossyProxies:
    def test_uses_the_first_frame_of_a_multipage_tiff(self):
        data = tiff_bytes(
            Image.new("L", (32, 32), 10),
            extra_frames=[Image.new("L", (32, 32), 128), Image.new("L", (32, 32), 250)],
        )
        response = post(data)

        assert response.headers["X-Image-Frames"] == "3"
        # Silently choosing a page is how a figure ends up showing a channel
        # nobody picked, so the choice is reported.
        assert "page 1 of 3" in response.headers["X-Image-Notes"]
        # Each frame is a different uniform grey, so the value identifies which
        # one was decoded. 10 is frame 0; 128 and 250 are the pages not shown.
        with Image.open(io.BytesIO(response.content)) as out:
            assert out.convert("L").getextrema() == (10, 10)

    def test_maps_16_bit_range_linearly_to_8_bit(self):
        # convert("L") clips at 255, so a 16-bit micrograph would come out solid
        # white. The observed range must be stretched across 0-255 instead.
        source = Image.new("I", (2, 1))
        source.putpixel((0, 0), 1000)
        source.putpixel((1, 0), 5000)

        decoded = decode(tiff_bytes(source))
        with Image.open(io.BytesIO(decoded.png)) as out:
            grey = out.convert("L")
            assert grey.getpixel((0, 0)) == 0
            assert grey.getpixel((1, 0)) == 255

        assert any("8-bit" in note for note in decoded.notes)
        # The loss is acceptable only because the original survives elsewhere.
        assert any("preserved in the project file" in note for note in decoded.notes)

    def test_handles_a_flat_16_bit_image_without_dividing_by_zero(self):
        source = Image.new("I", (2, 1), 4242)
        decoded = decode(tiff_bytes(source))
        with Image.open(io.BytesIO(decoded.png)) as out:
            assert out.convert("L").getextrema() == (0, 0)

    def test_notes_a_cmyk_conversion(self):
        decoded = decode(tiff_bytes(Image.new("CMYK", (16, 16))))
        assert any("CMYK" in note for note in decoded.notes)

    def test_says_nothing_about_a_lossless_rgb_proxy(self):
        response = post(tiff_bytes(Image.new("RGB", (16, 16))))
        assert "X-Image-Notes" not in response.headers


# ---------------------------------------------------------------------------
# Limits on the export path
# ---------------------------------------------------------------------------


class TestExportSizeGuard:
    def test_rejects_an_oversized_export_body(self, monkeypatch):
        # The guard answers from Content-Length, before the body is read: that
        # is the point, since buffering it is the thing being prevented.
        monkeypatch.setattr("figureforge.main.MAX_EXPORT_BYTES", 1024)
        response = client.post(
            "/export",
            json={
                "svg": "<svg xmlns='http://www.w3.org/2000/svg'>" + "x" * 4096 + "</svg>",
                "widthMm": 183,
                "heightMm": 75,
                "format": "svg",
            },
        )

        assert response.status_code == 413
        assert "too large" in response.json()["detail"].lower()

    def test_allows_an_ordinary_figure_through(self):
        response = client.post(
            "/export",
            json={
                "svg": "<svg xmlns='http://www.w3.org/2000/svg' width='10mm' height='10mm'></svg>",
                "widthMm": 10,
                "heightMm": 10,
                "format": "svg",
            },
        )
        assert response.status_code == 200
