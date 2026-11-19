"""Private file-based coordination with the local Windows launcher."""
import json
from pathlib import Path


def write_status(path, **values):
    if path is None:
        return
    path = Path(path)
    temporary = path.with_suffix(".tmp")
    try:
        temporary.write_text(json.dumps(values), encoding="utf-8")
        temporary.replace(path)
    except OSError:
        # The launcher may be reading the status file. A later tick retries.
        pass
