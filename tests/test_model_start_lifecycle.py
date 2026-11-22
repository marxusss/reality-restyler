import asyncio
import threading
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import app


class ModelStartupLeaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.idle_patch = patch.object(app, "IDLE_SECONDS", 0.1)
        self.idle_patch.start()
        self.unload_patch = patch.object(app.runtime, "unload")
        self.unload_mock = self.unload_patch.start()
        self.save_patch = patch.object(app, "save_preferences")
        self.save_patch.start()
        self.client = TestClient(TestServer(app.create_app()))
        await self.client.start_server()
        response = await self.client.post("/session", json={})
        self.token = (await response.json())["token"]
        self.headers = {"X-Restyle-Session": self.token}

    async def asyncTearDown(self):
        await self.client.close()
        self.save_patch.stop()
        self.unload_patch.stop()
        self.idle_patch.stop()

    async def test_slow_model_load_is_not_unloaded_and_idle_begins_after_completion(self):
        started = threading.Event()
        finish = threading.Event()

        def slow_start(*_args, **_kwargs):
            started.set()
            finish.wait(timeout=5)
            return {"ok": True}

        with patch.object(app.runtime, "start", side_effect=slow_start):
            pending = asyncio.create_task(self.client.post(
                "/start", json={"settings": {}}, headers=self.headers))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                # The normal idle reaper wakes during this simulated cold load.
                await asyncio.sleep(1.25)
                response = await self.client.post("/heartbeat", json={}, headers=self.headers)
                self.assertEqual(response.status, 200)
                self.unload_mock.assert_not_called()
            finally:
                finish.set()
            response = await asyncio.wait_for(pending, timeout=3)
        self.assertEqual(response.status, 200)
        self.assertTrue((await response.json())["ok"])

        # When loading finishes and the controller stops checking in, idle unload resumes.
        await asyncio.sleep(1.25)
        response = await self.client.post("/heartbeat", json={}, headers=self.headers)
        self.assertEqual(response.status, 409)
        self.unload_mock.assert_called()

    async def test_user_can_cancel_model_start_and_retry(self):
        started = threading.Event()
        finish = threading.Event()

        def slow_start(*_args, **_kwargs):
            started.set()
            finish.wait(timeout=5)
            return {"ok": True}

        with patch.object(app.runtime, "start", side_effect=slow_start):
            pending = asyncio.create_task(self.client.post(
                "/start", json={"settings": {}, "startup_id": "manual-cancel"},
                headers=self.headers))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                cancelled = await self.client.post(
                    "/cancel-start", json={"startup_id": "manual-cancel"},
                    headers=self.headers)
                self.assertTrue((await cancelled.json())["cancelling"])
            finally:
                finish.set()
            response = await asyncio.wait_for(pending, timeout=3)
        self.assertEqual(response.status, 422)
        self.assertIn("cancelled", (await response.json())["error"])
        self.unload_mock.assert_called_once()

    async def test_failed_start_does_not_leave_idle_unload_disabled(self):
        with patch.object(app.runtime, "start", side_effect=RuntimeError("model unavailable")):
            response = await self.client.post("/start", json={"settings": {}}, headers=self.headers)
        self.assertEqual(response.status, 503)
        await asyncio.sleep(1.25)
        response = await self.client.post("/heartbeat", json={}, headers=self.headers)
        self.assertEqual(response.status, 409)
        self.unload_mock.assert_called()
