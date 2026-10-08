"""Conform an image to what a render job asks for: an opaque PNG at the job's size."""

from __future__ import annotations

import io
import warnings
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_UPLOAD_BYTES = 40 * 1024 * 1024
MAX_PIXELS = 64_000_000
MIN_SIDE = 512
ACCEPTED_FORMATS = frozenset({"PNG", "JPEG", "WEBP"})


class RasterError(ValueError):
    """The uploaded or generated image cannot be used for this job."""


@dataclass(frozen=True)
class Conformed:
    png: bytes
    width: int
    height: int
    source_width: int
    source_height: int
    cropped: bool


def conform(payload: bytes, *, width: int, height: int, exact: bool) -> Conformed:
    """Return an RGB PNG for a job.

    With `exact`, the image is center-cropped to the job's aspect ratio, then resized to
    the exact pixel size the engine will check. Without it (reference jobs), the image
    keeps its proportions and is only enlarged when a side is below the engine minimum.
    """
    if not payload:
        raise RasterError("The image is empty.")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise RasterError("The image is larger than 40 MB.")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(payload)) as opened:
                if opened.format not in ACCEPTED_FORMATS:
                    raise RasterError("Use a PNG, JPEG, or WebP image.")
                if opened.width * opened.height > MAX_PIXELS:
                    raise RasterError("The image has too many pixels.")
                image = ImageOps.exif_transpose(opened)
                image.load()
    except RasterError:
        raise
    except (OSError, SyntaxError, UnidentifiedImageError, Image.DecompressionBombError,
            Image.DecompressionBombWarning) as error:
        raise RasterError("The file is not a readable image.") from error

    source_width, source_height = image.size
    if image.mode in {"RGBA", "LA", "PA"} or "transparency" in image.info:
        rgba = image.convert("RGBA")
        flat = Image.new("RGB", rgba.size, (255, 255, 255))
        flat.paste(rgba, mask=rgba.getchannel("A"))
        image = flat
    else:
        image = image.convert("RGB")

    cropped = False
    if exact:
        target_ratio = width / height
        ratio = image.width / image.height
        if abs(ratio - target_ratio) > 1e-6:
            cropped = True
            if ratio > target_ratio:
                new_width = round(image.height * target_ratio)
                left = (image.width - new_width) // 2
                image = image.crop((left, 0, left + new_width, image.height))
            else:
                new_height = round(image.width / target_ratio)
                top = (image.height - new_height) // 2
                image = image.crop((0, top, image.width, top + new_height))
        if image.size != (width, height):
            image = image.resize((width, height), Image.Resampling.LANCZOS)
    elif min(image.size) < MIN_SIDE:
        scale = MIN_SIDE / min(image.size)
        image = image.resize(
            (max(MIN_SIDE, round(image.width * scale)), max(MIN_SIDE, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )

    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    return Conformed(
        png=buffer.getvalue(),
        width=image.width,
        height=image.height,
        source_width=source_width,
        source_height=source_height,
        cropped=cropped,
    )
