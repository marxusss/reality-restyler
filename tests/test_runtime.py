from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runtime import DEFAULT_SETTINGS, RESOLUTIONS, Runtime, normalize_settings

class RuntimeSettingsTests(unittest.TestCase):
    def test_defaults_keep_optional_upscaler_enabled(self):
        settings = normalize_settings({})
        self.assertEqual(settings, DEFAULT_SETTINGS)
        self.assertTrue(settings["upscale"])
        self.assertEqual(settings["resolution"], 1024)

    def test_partial_updates_preserve_other_values(self):
        updated = normalize_settings({"steps": 8}, {"prompt": "portrait", "steps": 4, "resolution": 640, "upscale": True, "rotation": 90})
        self.assertEqual(updated["steps"], 8)
        self.assertEqual(updated["prompt"], "portrait")
        self.assertEqual(updated["rotation"], 90)

    def test_rejects_unknown_model_and_runtime_controls(self):
        for payload in ({"model": "other"}, {"seed": 4}):
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                normalize_settings(payload)

    def test_rejects_invalid_ranges_and_boolean_integers(self):
        for payload in ({"steps": 0}, {"steps": True}, {"resolution": 600}, {"resolution": 640.0}, {"rotation": 45}, {"rotation": 90.0}):
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    normalize_settings(payload)

    def test_runtime_starts_unloaded(self):
        runtime = Runtime()
        self.assertFalse(runtime.loaded())
        self.assertFalse(runtime.metrics()["loaded"])

    def test_render_never_returns_an_unprocessed_frame(self):
        runtime = Runtime()
        with self.assertRaisesRegex(RuntimeError, "not loaded"):
            runtime.render(None)

    def test_idle_unload_rechecks_the_deadline_under_the_runtime_lock(self):
        runtime = Runtime()
        runtime._pipe = object()
        runtime._last_heartbeat = 100.0
        with patch("runtime.time.monotonic", return_value=129.9):
            self.assertFalse(runtime.unload_if_idle(30))
        with patch("runtime.time.monotonic", return_value=130.0), patch.object(runtime, "_unload_locked") as unload:
            self.assertTrue(runtime.unload_if_idle(30))
            unload.assert_called_once_with()

    def test_heartbeat_refreshes_only_a_loaded_runtime(self):
        runtime = Runtime()
        self.assertFalse(runtime.heartbeat())
        self.assertEqual(runtime._last_heartbeat, 0.0)
        runtime._pipe = object()
        with patch("runtime.time.monotonic", return_value=42.0):
            self.assertTrue(runtime.heartbeat())
        self.assertEqual(runtime._last_heartbeat, 42.0)

class RuntimeSettingsFuzzTests(unittest.TestCase):
    def test_random_json_payloads_are_validated(self):
        generator = random.Random(20261115)
        keys = list(DEFAULT_SETTINGS) + ["model", "strength", "__proto__", "unknown"]
        values = [None, True, False, 0, 1, -1, 512, 640, 1024, 1024.0, float("nan"), "", "text", [], [1], {}, {"x": []}]
        for _ in range(5000):
            payload = {}
            for _ in range(generator.randrange(8)):
                payload[generator.choice(keys)] = generator.choice(values)
            try:
                settings = normalize_settings(payload)
            except ValueError:
                continue
            self.assertEqual(set(settings), set(DEFAULT_SETTINGS))
            self.assertIn(settings["resolution"], RESOLUTIONS)
            self.assertGreaterEqual(settings["steps"], 1)
            self.assertLessEqual(settings["steps"], 12)

if __name__ == "__main__":
    unittest.main()
