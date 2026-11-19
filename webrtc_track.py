import asyncio
import traceback

import av
from aiortc import VideoStreamTrack
from aiortc.mediastreams import MediaStreamError
from PIL import Image

class RestyleTrack(VideoStreamTrack):
    def __init__(self, source, active_runtime):
        super().__init__()
        self.source = source
        self.runtime = active_runtime
        self.input_frames = asyncio.Queue(maxsize=1)
        self.output_frames = asyncio.Queue(maxsize=1)
        self.last_image = None
        self.last_error = ""
        self.reader_task = asyncio.create_task(self._read())
        self.render_task = asyncio.create_task(self._render())

    async def _replace_latest(self, queue, item):
        if queue.full():
            try:
                queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(item)

    async def _read(self):
        try:
            while self.readyState == "live":
                frame = await self.source.recv()
                await self._replace_latest(self.input_frames, frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.stop()

    async def _render(self):
        try:
            while self.readyState == "live":
                frame = await self.input_frames.get()
                while not self.input_frames.empty():
                    try:
                        frame = self.input_frames.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                try:
                    image = frame.to_image()
                    output = await asyncio.to_thread(self.runtime.render, image)
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    if error != self.last_error:
                        detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
                        print(f"Frame processing failed: {detail}", flush=True)
                        await asyncio.to_thread(self.runtime.report_error, f"Frame processing failed: {detail}")
                        self.last_error = error
                    output = self.last_image.copy() if self.last_image is not None else Image.new("RGB", (frame.width, frame.height))
                else:
                    self.last_error = ""
                await self._replace_latest(self.output_frames, output)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.stop()

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        pts, time_base = await self.next_timestamp()
        try:
            image = self.output_frames.get_nowait()
            self.last_image = image
        except asyncio.QueueEmpty:
            if self.last_image is None:
                image = await self.output_frames.get()
                if image is None:
                    raise MediaStreamError
                self.last_image = image
            else:
                image = self.last_image
        if self.readyState != "live":
            raise MediaStreamError
        frame = av.VideoFrame.from_image(image)
        frame.pts = pts
        frame.time_base = time_base
        return frame

    def stop(self):
        if self.readyState != "live":
            return
        for task in (self.reader_task, self.render_task):
            if not task.done():
                task.cancel()
        try:
            self.source.stop()
        except Exception:
            pass
        super().stop()
        if self.output_frames.empty():
            self.output_frames.put_nowait(None)

