import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from log_retention import prune_legacy_sessions, prune_logs


class LogRetentionTests(unittest.TestCase):
    def test_only_application_logs_older_than_four_days_are_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            directory = root / "logs"
            directory.mkdir()
            now = datetime(2026, 11, 18, 12, tzinfo=timezone.utc)
            names = ["server-2026-11-14-1.log", "server-2026-11-15-2.log",
                     "install-20261113T000000-1-1.log", "install-20261117T000000-1-1.log",
                     "unrelated.log"]
            for name in names:
                path = directory / name
                path.write_text("diagnostic")
                os.utime(path, (now.timestamp() - 5 * 86400,) * 2)
            fresh = directory / names[3]
            os.utime(fresh, (now.timestamp() - 86400,) * 2)
            prune_logs(root, now)
            self.assertFalse((directory / names[0]).exists())
            self.assertTrue((directory / names[1]).exists())
            self.assertFalse((directory / names[2]).exists())
            self.assertTrue(fresh.exists())
            self.assertTrue((directory / names[4]).exists())

    def test_launcher_and_repair_logs_are_pruned(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            logs = root / "logs"
            logs.mkdir()
            now = datetime(2026, 11, 18, 12, tzinfo=timezone.utc)
            for name in ("launcher-20261113T000000123-1-output.log", "install-20261113T000000-1-repair.log"):
                path = logs / name
                path.write_text("log")
                os.utime(path, (now.timestamp() - 5 * 86400,) * 2)
            prune_logs(root, now)
            self.assertEqual(list(logs.iterdir()), [])

    def test_legacy_cleanup_does_not_delete_ipc_or_unrelated_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session = root / ("RealityRestyling-" + "a" * 32)
            session.mkdir()
            now = datetime(2026, 11, 18, 12, tzinfo=timezone.utc)
            old = (now.timestamp() - 5 * 86400,) * 2
            for name in ("output.log", "ready.json"):
                path = session / name
                path.write_text("old")
                os.utime(path, old)
            os.utime(session, old)
            prune_legacy_sessions(now, root)
            self.assertFalse((session / "output.log").exists())
            self.assertTrue((session / "ready.json").exists())
