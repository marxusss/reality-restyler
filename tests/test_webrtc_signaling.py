import asyncio
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

import app


class WaitingPeer:
    def __init__(self):
        self.connectionState = "connecting"
        self.entered = asyncio.Event()
        self.released = asyncio.Event()
        self.localDescription = None

    def on(self, _event):
        return lambda callback: callback

    async def setRemoteDescription(self, _offer):
        self.entered.set()
        await self.released.wait()

    async def createAnswer(self):
        return object()

    async def setLocalDescription(self, _answer):
        self.localDescription = type("Description", (), {"sdp": "v=0", "type": "answer"})()

    async def close(self):
        self.connectionState = "closed"
        self.released.set()


class WebRTCSignalingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = TestClient(TestServer(app.create_app()))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    async def test_new_start_takes_control_during_webrtc_negotiation(self):
        response = await self.client.post("/session", json={})
        token = (await response.json())["token"]
        peer = WaitingPeer()
        with patch.object(app.runtime, "loaded", return_value=True), \
             patch.object(app, "RTCPeerConnection", return_value=peer):
            request = asyncio.create_task(self.client.post(
                "/offer", json={"sdp": "v=0", "type": "offer"},
                headers={"X-Restyle-Session": token}))
            try:
                await asyncio.wait_for(peer.entered.wait(), timeout=2)
                transferred = await asyncio.wait_for(
                    self.client.post("/session", json={}), timeout=2)
                self.assertEqual(transferred.status, 200)
                self.assertNotEqual((await transferred.json())["token"], token)
            finally:
                peer.released.set()
            result = await asyncio.wait_for(request, timeout=2)
            self.assertEqual(result.status, 409)
