import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import preferences
import app
from aiohttp.test_utils import TestClient, TestServer


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


class CameraPreferencesApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path_patch = patch.object(preferences, "PREFERENCES_PATH", Path(self.tmp.name) / "camera_settings.json")
        self.path_patch.start()
        self.client = TestClient(TestServer(app.create_app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.path_patch.stop()
        self.tmp.cleanup()

    async def test_settings_can_be_saved_before_start_and_read_by_another_device(self):
        response = await self.client.post("/preferences", json={
            "settings": {"prompt": "soft watercolor", "resolution": 640}
        })
        self.assertEqual(response.status, 200)
        response = await self.client.get("/preferences")
        self.assertEqual(response.status, 200)
        saved = (await response.json())["settings"]
        self.assertEqual(saved["prompt"], "soft watercolor")
        self.assertEqual(saved["resolution"], 640)
        self.assertEqual(saved["steps"], 4)
        self.assertFalse("rotation" in saved)

    async def test_other_device_cannot_overwrite_active_owner_preferences(self):
        response = await self.client.post("/session", json={})
        token = (await response.json())["token"]
        stale = await self.client.post("/preferences", json={"settings": {"prompt": "stale"}})
        self.assertEqual(stale.status, 409)
        own = await self.client.post("/preferences", json={"settings": {"prompt": "owner"}},
                                     headers={"X-Restyle-Session": token})
        self.assertEqual(own.status, 200)
        response = await self.client.get("/preferences")
        self.assertEqual((await response.json())["settings"]["prompt"], "owner")
