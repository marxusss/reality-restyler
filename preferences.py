"""App-owned camera preferences, persisted outside the installation directory.

Rotation is intentionally per-device and is not saved across phone/desktop sessions.
"""
import json
import os
import threading
from pathlib import Path

from runtime_settings import DEFAULT_SETTINGS, normalize_settings

if os.name == "nt":
    USER_DATA_ROOT = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "Reality Restyling"
else:
    USER_DATA_ROOT = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "reality-restyling"
USER_DATA_ROOT = Path(os.environ.get("REALITY_RESTYLE_USER_DATA", USER_DATA_ROOT))
PREFERENCES_PATH = USER_DATA_ROOT / "camera_settings.json"
PERSISTED_KEYS = ("prompt", "steps", "resolution", "upscale")
_LOCK = threading.RLock()


def _normalize(data):
    if not isinstance(data, dict) or set(data) - {*PERSISTED_KEYS, "upscaler"}:
        raise ValueError("The saved camera settings are invalid.")
    settings = normalize_settings({key: data[key] for key in PERSISTED_KEYS if key in data}, DEFAULT_SETTINGS)
    return {key: settings[key] for key in PERSISTED_KEYS}


def read_preferences():
    with _LOCK:
        if not PREFERENCES_PATH.exists():
            return _normalize({})
        try:
            data = json.loads(PREFERENCES_PATH.read_text(encoding="utf-8"))
            return _normalize(data)
        except (OSError, ValueError, TypeError) as exc:
            raise RuntimeError("The saved camera settings could not be read.") from exc


def save_preferences(settings):
    """Store a complete normalized settings snapshot; do not persist device rotation."""
    normalized = _normalize({key: settings[key] for key in PERSISTED_KEYS})
    payload = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    with _LOCK:
        if PREFERENCES_PATH.exists():
            try:
                if PREFERENCES_PATH.read_text(encoding="utf-8") == payload:
                    return normalized
            except OSError as exc:
                raise RuntimeError("The saved camera settings could not be read.") from exc
        PREFERENCES_PATH.parent.mkdir(parents=True, exist_ok=True)
        pending = PREFERENCES_PATH.with_name(f".{PREFERENCES_PATH.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            with pending.open("w", encoding="utf-8") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(pending, PREFERENCES_PATH)
        finally:
            pending.unlink(missing_ok=True)
    return normalized
