"""Opt-in real-GPU smoke check; never run as part of the default unit suite."""
import argparse
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Load the real model and render a frame on this machine.")
    parser.add_argument("--models", type=Path, help="Existing model directory (no download performed).")
    parser.add_argument("--output", type=Path, default=Path("gpu-smoke-output.png"))
    args = parser.parse_args()
    if args.models:
        os.environ["REALITY_RESTYLE_MODELS_DIR"] = str(args.models.resolve())

    # Import after setting the model directory.
    from PIL import Image
    from runtime import Runtime

    runtime = Runtime()
    try:
        started = runtime.start(
            {"prompt": "A watercolor illustration, keep the scene intact",
             "steps": 2, "resolution": 512, "upscale": False},
            allow_low_vram=True,
        )
        if not started.get("ok") or not runtime.loaded():
            raise RuntimeError("The model did not load.")
        input_frame = Image.new("RGB", (512, 384), (70, 100, 140))
        rendered = runtime.render(input_frame)
        if not isinstance(rendered, Image.Image) or min(rendered.size) <= 0:
            raise RuntimeError("The model did not output a valid image.")
        rendered.load()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        rendered.save(args.output)
        print(f"GPU smoke passed: model loaded and produced {rendered.width}x{rendered.height} frame: {args.output}")
    finally:
        runtime.unload()


if __name__ == "__main__":
    main()
