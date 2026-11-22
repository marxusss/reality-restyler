"""Black-box check that developer mode serves this checkout, not an installed release."""
import json
import os
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


class DeveloperServerTests(unittest.TestCase):
    def test_dev_mode_serves_checkout_without_installer(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]

        environment = dict(os.environ, REALITY_RESTYLE_PORT=str(port))
        server = subprocess.Popen(
            [sys.executable, "-B", str(ROOT / "app.py"), "--dev"],
            cwd=ROOT, env=environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 8
            while True:
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health", timeout=0.5) as response:
                        health = json.load(response)
                    break
                except OSError:
                    if server.poll() is not None or time.monotonic() >= deadline:
                        self.fail("Developer server did not start from the checkout.")
                    time.sleep(0.1)

            self.assertTrue(health["ok"])
            with urlopen(f"http://127.0.0.1:{port}/app.js", timeout=2) as response:
                served = response.read()
            self.assertEqual(served, (ROOT / "web" / "app.js").read_bytes())
            with urlopen(f"http://127.0.0.1:{port}/apple-touch-icon.png", timeout=2) as response:
                self.assertEqual(response.read()[:8], b"\x89PNG\r\n\x1a\n")
        finally:
            server.terminate()
            server.wait(timeout=5)
