"""Lossy, bounded local camera transport; called on a worker thread."""
from io import BytesIO
from PIL import Image

MAX_EDGE = 2048
INPUT_FORMATS = {"JPEG", "WEBP"}
OUTPUT_QUALITY = 92


def process_frame(payload, runtime):
    with Image.open(BytesIO(payload)) as source:
        if source.format not in INPUT_FORMATS:
            raise ValueError("Camera frame format is not supported.")
        if max(source.size) > MAX_EDGE:
            raise ValueError("Camera frame is too large.")
        source.load()
        frame = source.convert("RGB")
    result = runtime.render(frame)
    buffer = BytesIO()
    result.convert("RGB").save(buffer, format="JPEG", quality=OUTPUT_QUALITY, optimize=False)
    return buffer.getvalue()
