"""The /export endpoint itself.

Everything in `test_export.py` calls `render` directly, so the route — its
validation, its size guard, the header it writes — had never been executed by a
test. Each case here is a way a caller reaches the service that the web client
happens never to take, which is exactly why the guarantee has to live on this
side of the wire.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from figureforge.main import MAX_EXPORT_BYTES, MAX_RASTER_PIXELS, app

client = TestClient(app)

SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" '
    'viewBox="0 0 100 50"><rect width="100" height="50" fill="#fff"/>'
    '<text x="4" y="8" font-size="3">Panel a</text></svg>'
)


def body(**overrides) -> dict:
    return {"svg": SVG, "widthMm": 100, "heightMm": 50, "format": "svg", **overrides}


class TestResponse:
    def test_returns_the_svg_with_a_download_header(self):
        response = client.post("/export", json=body(filename="figure-1"))
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("image/svg+xml")
        assert response.headers["content-disposition"] == 'attachment; filename="figure-1.svg"'
        assert response.content.decode() == SVG


class TestFilename:
    @pytest.mark.parametrize(
        "name",
        [
            'a"b',            # closes the quoted header value
            "a\nb",           # injects a second header
            "../../etc/passwd",
            "",
        ],
    )
    def test_refuses_a_filename_that_would_escape_the_header(self, name):
        # The web client strips names to this same shape, so this path is only
        # reachable by a direct caller — which is the one that matters.
        assert client.post("/export", json=body(filename=name)).status_code == 422

    def test_accepts_an_ordinary_name(self):
        assert client.post("/export", json=body(filename="Figure_2-final")).status_code == 200


class TestActiveContent:
    """The SVG is interpolated into a page a real Chromium loads with JS on.

    Refused rather than sanitised: regex-scrubbing untrusted markup fails
    quietly, whereas a refusal cannot turn a figure into a subtly different one.
    """

    @pytest.mark.parametrize(
        "svg",
        [
            '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/steal")</script></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(1)"><rect/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://169.254.169.254/"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="file:///etc/passwd"/></svg>',
        ],
    )
    def test_refuses_active_or_remote_content(self, svg):
        response = client.post("/export", json=body(svg=svg))
        assert response.status_code == 422
        assert response.json()["detail"]

    def test_allows_everything_this_renderer_actually_emits(self):
        # Data URIs for images, fragment references for clip paths, and escaped
        # text — including text that merely *mentions* something forbidden.
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" '
            'viewBox="0 0 100 50">'
            '<defs><clipPath id="c"><rect width="10" height="10"/></clipPath></defs>'
            '<g clip-path="url(#c)">'
            '<image href="data:image/png;base64,iVBORw0KGgo=" width="10" height="10"/></g>'
            "<text x=\"4\" y=\"8\" font-size=\"3\">&lt;script&gt; in javascript: a study</text>"
            "</svg>"
        )
        assert client.post("/export", json=body(svg=svg)).status_code == 200


class TestSizeGuards:
    def test_rejects_an_oversized_body_from_its_content_length(self):
        # Answered from the header, without buffering the upload — which is the
        # whole point, since buffering it is the thing being prevented.
        response = client.post(
            "/export",
            content=b"{}",
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(MAX_EXPORT_BYTES + 1),
            },
        )
        assert response.status_code == 413
        assert "too large" in response.json()["detail"]

    def test_rejects_a_raster_request_that_would_not_fit_in_memory(self):
        # 2000 mm at 600 dpi is 47 244 px per side — 2.2 Gpx, an OOM kill
        # behind a generic 500 rather than an answer.
        response = client.post(
            "/export", json=body(widthMm=2000, heightMm=2000, format="png", dpi=600)
        )
        assert response.status_code == 422
        assert "megapixels" in str(response.json()["detail"])

    def test_leaves_vector_formats_alone(self):
        # A vector export has no pixel grid, so the raster ceiling does not
        # apply to it — a large PDF is just a large PDF.
        assert (
            client.post("/export", json=body(widthMm=2000, heightMm=2000, format="svg")).status_code
            == 200
        )

    def test_the_ceiling_admits_a_real_figure(self):
        # A double-column figure at the highest offered resolution must pass, or
        # the guard is protecting the service from its own users.
        pixels = round(183 / 25.4 * 600) * round(247 / 25.4 * 600)
        assert pixels < MAX_RASTER_PIXELS


class TestValidation:
    @pytest.mark.parametrize(
        "override",
        [
            {"svg": ""},
            {"widthMm": 0},
            {"heightMm": -1},
            {"widthMm": 5000},
            {"dpi": 1200},
            {"format": "webp"},
        ],
    )
    def test_refuses_a_malformed_request(self, override):
        assert client.post("/export", json=body(**override)).status_code == 422
