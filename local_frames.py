"""Local transport decode, inference and encode run together on a worker."""
from io import BytesIO
import time
from PIL import Image

MAX_EDGE = 2048
INPUT_FORMATS = {"JPEG", "WEBP", "PNG"}  # Accept legacy clients; never emit PNG.
OUTPUT_QUALITY = 92

def process_frame(payload, runtime):
    started = time.perf_counter()
    with Image.open(BytesIO(payload)) as source:
        if source.format not in INPUT_FORMATS:
            raise ValueError("Camera frame format is not supported.")
        if max(source.size) > MAX_EDGE:
            raise ValueError("Camera frame is too large.")
        source.load()
        frame = source.convert("RGB")
    decoded = time.perf_counter()
    result = runtime.render(frame)
    rendered = time.perf_counter()
    buffer = BytesIO()
    result.convert("RGB").save(buffer, format="JPEG", quality=OUTPUT_QUALITY, optimize=False)
    payload = buffer.getvalue()
    finished = time.perf_counter()
    return payload, {"decode_ms": (decoded-started)*1000,
                     "render_ms": (rendered-decoded)*1000,
                     "encode_ms": (finished-rendered)*1000,
                     "worker_ms": (finished-started)*1000}
