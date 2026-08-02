"""Raster decoding for formats the browser cannot open.

Browsers decode PNG and JPEG natively and render SVG directly, so those never
reach this module. TIFF is the exception, and it is the format life-science
microscopy actually produces — a tool that cannot open a TIFF cannot open the
author's data.

What comes back is a *display proxy*, not a replacement. The archive keeps the
original bytes verbatim; this PNG exists so the canvas has something to draw and
the exporter has something to embed. That split is what lets a 16-bit
micrograph be reduced to 8 bits for print without the project losing the
16-bit original.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field

from PIL import Image

# Pillow's decompression-bomb guard defaults to ~178 megapixels. A whole-slide
# scan or a stitched tile set legitimately exceeds that, so the ceiling is
# raised deliberately rather than switched off: `None` would turn a hostile
# upload into an out-of-memory kill of the whole service.
MAX_PIXELS = 800_000_000

# Upload ceiling. Generous enough for a 16-bit whole-slide TIFF, bounded enough
# that the request cannot exhaust the container.
MAX_UPLOAD_BYTES = 512 * 1024 * 1024

# TIFF tag numbers, spelled out because the numeric literals are unreadable.
TAG_IMAGE_DESCRIPTION = 270
TAG_X_RESOLUTION = 282
TAG_RESOLUTION_UNIT = 296

# ResolutionUnit values from the TIFF 6.0 specification.
RESOLUTION_UNIT_NONE = 1
RESOLUTION_UNIT_INCH = 2
RESOLUTION_UNIT_CENTIMETRE = 3


class DecodeError(ValueError):
    """The upload is not an image this service can read."""


class TooLargeError(ValueError):
    """The upload exceeds a declared limit; the message names which."""


@dataclass
class DecodedImage:
    png: bytes
    width: int
    height: int
    source_format: str
    frames: int = 1
    #: Pixels per `unit_label`. None when the file does not say.
    pixels_per_unit: float | None = None
    unit_label: str | None = None
    #: Anything the author should know about the proxy, e.g. a bit-depth change.
    notes: list[str] = field(default_factory=list)


def read_calibration(image: Image.Image) -> tuple[float | None, str | None]:
    """Physical pixel size, in whatever unit the file states it in.

    Two conventions, and reading only the first is how a tool reports a
    micrograph as "2.5 dpi":

    * **Baseline TIFF** puts pixels-per-inch (or per-centimetre) in
      ``XResolution``, with ``ResolutionUnit`` saying which.
    * **ImageJ** — which wrote most of the TIFFs in a working biology lab —
      sets ``ResolutionUnit`` to 1 (none) and puts the real unit in
      ``ImageDescription`` as ``unit=um``. ``XResolution`` is then pixels per
      *that* unit, and a reader that only understands the baseline convention
      either gives up or reports the number as dpi.

    The value is returned in its own unit rather than normalised, so nothing is
    lost to a conversion the caller may not want.

    Returns ``(None, None)`` when the file does not say. A guessed default here
    would be indistinguishable, to every later reader, from a measurement.
    """
    tags = getattr(image, "tag_v2", None)
    if tags is None:
        return None, None

    x_resolution = tags.get(TAG_X_RESOLUTION)
    if x_resolution is None:
        return None, None

    try:
        resolution = float(x_resolution)
    except (TypeError, ValueError):
        return None, None
    if resolution <= 0:
        return None, None

    unit = tags.get(TAG_RESOLUTION_UNIT, RESOLUTION_UNIT_INCH)

    # The ImageJ path first: it is the one that looks like "no calibration".
    if unit == RESOLUTION_UNIT_NONE:
        described = tags.get(TAG_IMAGE_DESCRIPTION) or ""
        if isinstance(described, bytes):
            described = described.decode("utf-8", errors="replace")
        for line in str(described).splitlines():
            key, separator, value = line.partition("=")
            if separator and key.strip() == "unit" and value.strip():
                return resolution, value.strip()
        # ResolutionUnit 1 with no stated unit means the ratio is relative
        # only — a number with no dimension is not a calibration.
        return None, None

    if unit == RESOLUTION_UNIT_INCH:
        return resolution, "in"
    if unit == RESOLUTION_UNIT_CENTIMETRE:
        return resolution, "cm"
    return None, None


def to_display_mode(image: Image.Image) -> tuple[Image.Image, list[str]]:
    """Convert to something PNG can carry, reporting anything lost on the way."""
    notes: list[str] = []
    mode = image.mode

    if mode in ("RGB", "RGBA", "L", "LA", "P", "1"):
        return (image.convert("RGBA") if mode in ("LA", "P") else image), notes

    if mode in ("I", "I;16", "I;16B", "I;16L", "I;16S", "F"):
        # `convert("L")` on a 16-bit image clips at 255 rather than scaling, so
        # a micrograph whose signal sits anywhere above that comes out solid
        # white. Map the observed range linearly instead, and say so: the
        # archive keeps the 16-bit original, but the figure ships this proxy.
        source = image.convert("I")
        low, high = source.getextrema()
        span = high - low
        notes.append(
            f"{mode} source reduced to 8-bit for display and export; "
            "the original bit depth is preserved in the project file."
        )
        if span <= 0:
            # A uniform image has no range to stretch, and the scale factor
            # below would divide by zero.
            return Image.new("L", source.size, 0), notes
        # Kept as a plain affine expression: Pillow probes the callable to
        # derive a scale and offset, and an int() cast inside it defeats that
        # and raises rather than falling back.
        return source.point(lambda value: (value - low) * (255.0 / span)).convert("L"), notes

    if mode == "CMYK":
        notes.append(
            "CMYK converted to RGB without a colour profile; "
            "exact colours may shift."
        )
        return image.convert("RGB"), notes

    notes.append(f"{mode} converted to RGB for display.")
    return image.convert("RGB"), notes


def decode(data: bytes) -> DecodedImage:
    """Decode an upload to a PNG proxy plus everything the client needs."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise TooLargeError(
            f"Image is {len(data) / 1e6:.0f} MB; the limit is "
            f"{MAX_UPLOAD_BYTES / 1e6:.0f} MB."
        )

    previous_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        try:
            image = Image.open(io.BytesIO(data))
        except Image.DecompressionBombError as error:
            raise TooLargeError(
                f"Image exceeds the {MAX_PIXELS / 1e6:.0f} megapixel limit."
            ) from error
        except Exception as error:  # noqa: BLE001 - any failure means "not an image"
            raise DecodeError(f"Could not read this file as an image: {error}") from error

        with image:
            try:
                # Forces the decode; a truncated file fails here, not later.
                image.load()
            except Image.DecompressionBombError as error:
                raise TooLargeError(
                    f"Image exceeds the {MAX_PIXELS / 1e6:.0f} megapixel limit."
                ) from error
            except Exception as error:  # noqa: BLE001
                raise DecodeError(f"Image data is corrupt or truncated: {error}") from error

            source_format = image.format or "unknown"
            width, height = image.size
            frames = int(getattr(image, "n_frames", 1) or 1)
            pixels_per_unit, unit_label = read_calibration(image)

            display, notes = to_display_mode(image)
            if frames > 1:
                # Page 1 is shown; the rest stay in the archived original. The
                # alternative -- silently picking one and not saying so -- is
                # how a figure ends up showing a channel nobody chose.
                notes.append(f"Multi-page file: showing page 1 of {frames}.")

            buffer = io.BytesIO()
            display.save(buffer, format="PNG", optimize=False)

        return DecodedImage(
            png=buffer.getvalue(),
            width=width,
            height=height,
            source_format=source_format,
            frames=frames,
            pixels_per_unit=pixels_per_unit,
            unit_label=unit_label,
            notes=notes,
        )
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit


__all__ = [
    "MAX_PIXELS",
    "MAX_UPLOAD_BYTES",
    "DecodeError",
    "DecodedImage",
    "TooLargeError",
    "decode",
    "read_calibration",
    "to_display_mode",
]
