"""Application-owned daily diagnostics; retain at most four UTC calendar days."""
import os
import re
import stat
import sys
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(os.environ.get("REALITY_RESTYLE_RUNTIME_DIR", Path(__file__).resolve().parent / ".runtime"))
LOG_DIR = ROOT / "logs"
RETENTION_DAYS = 4
SERVER_LOG = re.compile(r"server-(\d{4}-\d{2}-\d{2})-\d+\.log$")
INSTALL_LOG = re.compile(r"(?:install|launcher)-[0-9T-]+(?:-(?:error|setup|repair|output))?\.log$")
def _is_redirected(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def prune_logs(root=ROOT, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = now.timestamp() - RETENTION_DAYS * 86400
    oldest_day = now.date() - timedelta(days=RETENTION_DAYS - 1)
    candidates = list((root / "logs").glob("*.log"))
    candidates.extend(root / name for name in ("install.log", "install-error.log"))
    for path in candidates:
        try:
            if not path.is_file() or _is_redirected(path):
                continue
            match = SERVER_LOG.fullmatch(path.name)
            if match:
                expired = date.fromisoformat(match.group(1)) < oldest_day
            elif INSTALL_LOG.fullmatch(path.name) or path.name in {"install.log", "install-error.log"}:
                expired = path.stat().st_mtime < cutoff
            else:
                continue
            if expired:
                path.unlink()
        except (OSError, ValueError):
            # A different process may have removed the file or still be writing it.
            continue


class DailyLog:
    def __init__(self, directory=LOG_DIR):
        self.directory = directory
        self.day = None
        self.file = None
        self.lock = threading.RLock()

    def write(self, value):
        if not value:
            return
        with self.lock:
            try:
                day = datetime.now(timezone.utc).date()
                if day != self.day:
                    if self.file:
                        self.file.close()
                    self.directory.mkdir(parents=True, exist_ok=True)
                    self.file = (self.directory / f"server-{day.isoformat()}-{os.getpid()}.log").open("a", encoding="utf-8", buffering=1)
                    self.day = day
                    prune_logs(self.directory.parent)
                self.file.write(value)
                self.file.flush()
            except OSError:
                pass

    def flush(self):
        with self.lock:
            if self.file:
                try:
                    self.file.flush()
                except OSError:
                    pass


class Tee:
    def __init__(self, original, log, echo=True):
        self.original = original
        self.log = log
        self.echo = echo
        self.encoding = getattr(original, "encoding", None) or "utf-8"

    def write(self, value):
        self.log.write(value)
        if self.original and self.echo:
            try:
                self.original.write(value)
            except (OSError, UnicodeError):
                pass
        return len(value)

    def flush(self):
        self.log.flush()
        if self.original:
            try:
                self.original.flush()
            except OSError:
                pass

    def isatty(self):
        return bool(self.original and self.original.isatty())

    def fileno(self):
        return self.original.fileno()


def enable_logging(*, echo=True):
    prune_logs()
    log = DailyLog()
    sys.stdout = Tee(sys.stdout, log, echo)
    sys.stderr = Tee(sys.stderr, log, echo)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--prune", action="store_true", required=True)
    parser.parse_args()
    prune_logs()
