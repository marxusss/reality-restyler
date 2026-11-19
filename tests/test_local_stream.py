from io import BytesIO
import json
import random
import threading
import unittest
from unittest.mock import patch

from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer
from PIL import Image

import app

class LocalStreamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.loaded_patch = patch.object(app.runtime, "loaded", return_value=True)
        self.render_patch = patch.object(app.runtime, "render", side_effect=lambda image: image.copy())
        self.unload_patch = patch.object(app.runtime, "unload")
        self.print_patch = patch("builtins.print")
        for item in (self.loaded_patch, self.render_patch, self.unload_patch, self.print_patch):
            item.start()
        self.client = TestClient(TestServer(app.create_app()))
        await self.client.start_server()
        response = await self.client.post("/session", json={})
        self.token = (await response.json())["token"]
        self.headers = {"X-Restyle-Session": self.token}

    async def asyncTearDown(self):
        await self.client.close()
        for item in (self.print_patch, self.unload_patch, self.render_patch, self.loaded_patch):
            item.stop()

    async def open_socket(self):
        origin = str(self.client.make_url("/").origin())
        return await self.client.ws_connect("/local-stream", origin=origin, protocols=["restyle." + self.token])

    async def test_loopback_uses_local_transport_and_returns_full_image(self):
        response = await self.client.get("/transport")
        self.assertEqual((await response.json())["mode"], "local")
        socket = await self.open_socket()
        source = Image.new("RGB", (96, 64), (27, 84, 132))
        encoded = BytesIO()
        source.save(encoded, format="JPEG")
        await socket.send_bytes(encoded.getvalue())
        message = await socket.receive(timeout=5)
        self.assertEqual(message.type, WSMsgType.BINARY)
        result = Image.open(BytesIO(message.data))
        self.assertEqual(result.size, source.size)
        self.assertEqual(result.format, "JPEG")
        await socket.close()

    async def test_local_stream_rejects_fuzzed_payloads_without_crashing(self):
        generator = random.Random(20261115)
        socket = await self.open_socket()
        for _ in range(64):
            payload = generator.randbytes(generator.randrange(1, 257))
            await socket.send_bytes(payload)
            message = await socket.receive(timeout=5)
            self.assertEqual(message.type, WSMsgType.TEXT)
            self.assertIn("error", json.loads(message.data))
        await socket.close()

    async def test_render_failure_is_reported_without_returning_camera_pixels(self):
        self.render_patch.stop()
        self.render_patch = patch.object(app.runtime, "render", side_effect=RuntimeError("inference failed"))
        self.render_patch.start()
        socket = await self.open_socket()
        source = Image.new("RGB", (32, 24), (27, 84, 132))
        encoded = BytesIO()
        source.save(encoded, format="JPEG")
        await socket.send_bytes(encoded.getvalue())
        message = await socket.receive(timeout=5)
        self.assertEqual(message.type, WSMsgType.TEXT)
        self.assertIn("Frame processing failed", json.loads(message.data)["error"])
        await socket.close()

    async def test_png_frame_is_rejected(self):
        socket = await self.open_socket()
        encoded = BytesIO()
        Image.new("RGB", (32, 24)).save(encoded, format="PNG")
        await socket.send_bytes(encoded.getvalue())
        message = await socket.receive(timeout=5)
        self.assertEqual(message.type, WSMsgType.TEXT)
        self.assertIn("format is not supported", json.loads(message.data)["error"])
        await socket.close()

    async def test_second_controller_cannot_mutate_or_claim(self):
        for path, body in (("/session", {}), ("/settings", {"settings": {"prompt": "other"}}),
                           ("/pause", {}), ("/stop", {}), ("/heartbeat", {}),
                           ("/start", {"settings": {}}), ("/offer", {"sdp": "fake", "type": "offer"})):
            response = await self.client.post(path, json=body)
            self.assertEqual(response.status, 409, path)
        response = await self.client.post("/session", json={}, headers=self.headers)
        self.assertEqual((await response.json())["token"], self.token)

    async def test_second_transport_rejected_and_stop_releases(self):
        from aiohttp import WSServerHandshakeError
        socket = await self.open_socket()
        with self.assertRaises(WSServerHandshakeError) as rejected:
            await self.open_socket()
        self.assertEqual(rejected.exception.status, 409)
        response = await self.client.post("/stop", json={}, headers=self.headers)
        self.assertEqual(response.status, 200)
        response = await self.client.post("/session", json={})
        self.assertEqual(response.status, 200)
        self.assertNotEqual((await response.json())["token"], self.token)
        await socket.close()

    async def test_transport_is_local_for_the_host_tailscale_address(self):
        original = app.local_peer_addresses
        app.local_peer_addresses = {"100.118.25.61", "fd7a:115c:a1e0::d35:193e"}
        try:
            self.assertTrue(app._is_local_peer("100.118.25.61"))
            self.assertTrue(app._is_local_peer("fd7a:115c:a1e0::d35:193e"))
            self.assertTrue(app._is_local_peer("127.0.0.1"))
            self.assertFalse(app._is_local_peer("100.64.0.12"))
        finally:
            app.local_peer_addresses = original

    async def test_model_status_waits_do_not_block_the_event_loop_thread(self):
        event_loop_thread = threading.get_ident()
        observed_threads = []
        with patch.object(app.runtime, "metrics", side_effect=lambda: (observed_threads.append(threading.get_ident()), {})[1]):
            response = await self.client.get("/metrics")
            self.assertEqual(response.status, 200)
            await response.json()
        with patch.object(app.runtime, "heartbeat", side_effect=lambda: (observed_threads.append(threading.get_ident()), True)[1]):
            response = await self.client.post("/heartbeat", json={}, headers=self.headers)
            self.assertEqual(response.status, 200)
            self.assertTrue((await response.json())["loaded"])
        self.assertEqual(len(observed_threads), 2)
        self.assertTrue(all(thread_id != event_loop_thread for thread_id in observed_threads))

if __name__ == "__main__":
    unittest.main()
