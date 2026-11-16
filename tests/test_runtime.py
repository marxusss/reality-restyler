from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from runtime import DEFAULT_SETTINGS, Runtime, normalize_settings

class RuntimeSettingsTests(unittest.TestCase):
    def test_defaults_keep_optional_upscaler_enabled(self):
        settings = normalize_settings({})
        self.assertEqual(settings, DEFAULT_SETTINGS)
        self.assertTrue(settings["upscale"])

    def test_partial_updates_preserve_other_values(self):
        updated = normalize_settings({"steps": 8}, {"prompt": "portrait", "steps": 4, "resolution": 640, "seed": 12, "upscale": True, "rotation": 90})
        self.assertEqual(updated["steps"], 8)
        self.assertEqual(updated["prompt"], "portrait")
        self.assertEqual(updated["rotation"], 90)

    def test_rejects_unknown_model_and_runtime_controls(self):
        with self.assertRaises(ValueError):
            normalize_settings({"model": "other"})

    def test_rejects_invalid_ranges_and_boolean_integers(self):
        for payload in ({"steps": 0}, {"steps": True}, {"resolution": 600}, {"resolution": 640.0}, {"seed": -1}, {"rotation": 45}, {"rotation": 90.0}):
            with self.subTest(payload=payload):
                with self.assertRaises(ValueError):
                    normalize_settings(payload)

    def test_runtime_starts_unloaded(self):
        runtime = Runtime()
        self.assertFalse(runtime.loaded())
        self.assertFalse(runtime.metrics()["loaded"])

if __name__ == "__main__":
    unittest.main()
