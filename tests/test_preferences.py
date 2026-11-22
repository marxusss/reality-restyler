import asyncio
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

    def test_persists_app_settings_and_ignores_device_rotation(self):
        settings = {"prompt": "watercolor", "steps": 2, "resolution": 768,
                    "upscale": False, "upscaler": "compact2x", "rotation": 90}
        preferences.save_preferences(settings)
        self.assertEqual(preferences.read_preferences(), {
            "prompt": "watercolor", "steps": 2, "resolution": 768, "upscale": False
        })
        self.assertNotIn("rotation", json.loads(preferences.PREFERENCES_PATH.read_text()))
        self.assertNotIn("upscaler", json.loads(preferences.PREFERENCES_PATH.read_text()))

    def test_identical_values_do_not_rewrite(self):
        preferences.save_preferences({"prompt": "", "steps": 4, "resolution": 512, "upscale": True, "upscaler": "compact2x"})
        original = preferences.PREFERENCES_PATH.read_bytes()
        with patch("preferences.os.replace") as replace:
            preferences.save_preferences({"prompt": "", "steps": 4, "resolution": 512, "upscale": True, "upscaler": "compact2x"})
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

    async def test_preferences_can_be_saved_and_read_before_start(self):
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

    async def test_shared_preferences_do_not_require_a_controller_token(self):
        response = await self.client.post("/session", json={})
        self.assertEqual(response.status, 200)
        response = await self.client.post("/preferences", json={
            "settings": {"prompt": "watercolor"}
        })
        self.assertEqual(response.status, 200)
        settings = (await (await self.client.get("/preferences")).json())["settings"]
        self.assertEqual(settings["prompt"], "watercolor")

    async def test_successful_model_start_survives_settings_disk_failure(self):
        token_response = await self.client.post("/session", json={})
        token = (await token_response.json())["token"]
        with patch.object(app.runtime, "start", return_value={"ok": True}), \
             patch.object(app, "save_preferences", side_effect=OSError("disk is full")):
            response = await asyncio.wait_for(
                self.client.post("/start", json={"settings": {}},
                                 headers={"X-Restyle-Session": token}), timeout=3)
        self.assertEqual(response.status, 200)
        result = await response.json()
        self.assertTrue(result["ok"])
        self.assertFalse(result["preferences_saved"])
        self.assertIn("could not be saved", result["warning"])

    async def test_live_settings_are_not_reported_failed_after_save_error(self):
        token_response = await self.client.post("/session", json={})
        token = (await token_response.json())["token"]
        new_settings = {"prompt": "ink", "steps": 3, "resolution": 640,
                        "upscale": False, "rotation": 0}
        with patch.object(app.runtime, "set_settings", return_value=new_settings), \
             patch.object(app, "save_preferences", side_effect=OSError("disk is full")):
            response = await asyncio.wait_for(
                self.client.post("/settings", json={"settings": {"prompt": "ink"}},
                                 headers={"X-Restyle-Session": token}), timeout=3)
        self.assertEqual(response.status, 200)
        result = await response.json()
        self.assertTrue(result["ok"])
        self.assertEqual(result["settings"], new_settings)
        self.assertFalse(result["preferences_saved"])
        self.assertIn("could not be saved", result["warning"])

