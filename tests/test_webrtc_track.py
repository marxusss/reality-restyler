import asyncio
import unittest

import av
from aiortc import VideoStreamTrack
from PIL import Image

from webrtc_track import RestyleTrack


class FrameSource(VideoStreamTrack):
    def __init__(self):
        super().__init__()
        self.frames = asyncio.Queue()

    async def recv(self):
        return await self.frames.get()


class Renderer:
    def render(self, frame):
        return Image.new("RGB", frame.size, (204, 24, 12))

    def report_error(self, _error):
        pass


class WebRTCFrameTests(unittest.IsolatedAsyncioTestCase):
    async def test_video_source_returns_processed_frames_and_stops_cleanly(self):
        source = FrameSource()
        track = RestyleTrack(source, Renderer())
        try:
            source.frames.put_nowait(av.VideoFrame.from_image(
                Image.new("RGB", (64, 48), (12, 24, 204))))
            frame = await asyncio.wait_for(track.recv(), timeout=3)
            self.assertEqual((frame.width, frame.height), (64, 48))
            # The outgoing picture is produced by inference, not the original camera frame.
            self.assertNotEqual(frame.to_image().getpixel((0, 0)), (12, 24, 204))
        finally:
            track.stop()
            await asyncio.gather(track.reader_task, track.render_task, return_exceptions=True)
        self.assertEqual(source.readyState, "ended")
        self.assertEqual(track.readyState, "ended")
