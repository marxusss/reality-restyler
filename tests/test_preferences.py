import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import preferences


class CameraPreferencesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path_patch = patch.object(preferences, "PREFERENCES_PATH", Path(self.tmp.name) / "camera_settings.json")
        self.path_patch.start()

    def tearDown(self):
        self.path_patch.stop()
        self.tmp.cleanup()

    def test_defaults_without_browser_storage(self):
        self.assertEqual(preferences.read_preferences(), {
            "prompt": "", "steps": 4, "resolution": 512, "upscale": True
        })
        self.assertFalse(preferences.PREFERENCES_PATH.exists())

    def test_persists_only_app_settings_across_restarts(self):
        settings = {"prompt": "watercolor", "steps": 2, "resolution": 768,
                    "upscale": False, "rotation": 90}
        preferences.save_preferences(settings)
        self.assertEqual(preferences.read_preferences(), {
            "prompt": "watercolor", "steps": 2, "resolution": 768, "upscale": False
        })
        self.assertNotIn("rotation", json.loads(preferences.PREFERENCES_PATH.read_text()))

    def test_identical_values_do_not_rewrite(self):
        preferences.save_preferences({"prompt": "", "steps": 4, "resolution": 512, "upscale": True})
        original = preferences.PREFERENCES_PATH.read_bytes()
        with patch("preferences.os.replace") as replace:
            preferences.save_preferences({"prompt": "", "steps": 4, "resolution": 512, "upscale": True})
        replace.assert_not_called()
        self.assertEqual(preferences.PREFERENCES_PATH.read_bytes(), original)

    def test_invalid_existing_config_is_not_silently_overwritten(self):
        preferences.PREFERENCES_PATH.write_text("{", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            preferences.read_preferences()
        self.assertEqual(preferences.PREFERENCES_PATH.read_text(), "{")
