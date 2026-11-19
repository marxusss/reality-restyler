RESOLUTIONS = (512, 640, 768, 896, 1024)
DEFAULT_SETTINGS = {
    "prompt": "",
    "steps": 4,
    "resolution": 1024,
    "upscale": True,
    "rotation": 0,
}

def normalize_settings(raw, previous=None):
    source = dict(DEFAULT_SETTINGS if previous is None else previous)
    if not isinstance(raw, dict):
        raise ValueError("Settings must be an object.")
    allowed = set(DEFAULT_SETTINGS)
    unknown = set(raw) - allowed
    if unknown:
        raise ValueError("Unknown setting.")
    source.update(raw)
    prompt = source.get("prompt")
    if not isinstance(prompt, str) or len(prompt) > 2000:
        raise ValueError("Prompt must be text under 2000 characters.")
    steps = source.get("steps")
    if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= 12:
        raise ValueError("Steps must be between 1 and 12.")
    resolution = source.get("resolution")
    if type(resolution) is not int or resolution not in RESOLUTIONS:
        raise ValueError("Resolution is not supported.")
    upscale = source.get("upscale")
    if not isinstance(upscale, bool):
        raise ValueError("Upscale must be a boolean.")
    rotation = source.get("rotation")
    if type(rotation) is not int or rotation not in (0, 90, 180, 270):
        raise ValueError("Rotation must be 0, 90, 180, or 270.")
    return {
        "prompt": prompt,
        "steps": steps,
        "resolution": int(resolution),
        "upscale": upscale,
        "rotation": rotation,
    }
