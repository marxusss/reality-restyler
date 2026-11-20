import asyncio
import time
import traceback

import av
from aiortc import VideoStreamTrack
from aiortc.mediastreams import MediaStreamError

from timing import TimingWindow


class RestyleTrack(VideoStreamTrack):
    def __init__(self, source, active_runtime):
        super().__init__()
        self.source = source
        self.runtime = active_runtime
        self.input_frames = asyncio.Queue(maxsize=1)
        self.output_frames = asyncio.Queue(maxsize=1)
        self.last_image = None
        self.last_output_ready_at = 0.0
        self.last_fresh_at = time.perf_counter()
        self.last_error = ""
        self.input_frames_dropped = 0
        self.render_timing = TimingWindow("webrtc_render")
        self.output_timing = TimingWindow("webrtc_output")
        self.reader_task = asyncio.create_task(self._read())
        self.render_task = asyncio.create_task(self._render())

    async def _replace_latest(self, queue, item):
        replaced = False
        if queue.full():
            try:
                queue.get_nowait()
                replaced = True
            except asyncio.QueueEmpty:
                pass
        queue.put_nowait(item)
        return replaced

    async def _read(self):
        try:
            while self.readyState == "live":
                frame = await self.source.recv()
                if await self._replace_latest(self.input_frames, frame):
                    self.input_frames_dropped += 1
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
                        self.input_frames_dropped += 1
                    except asyncio.QueueEmpty:
                        break
                frame_started = time.perf_counter()
                decode_ms = 0.0
                render_ms = 0.0
                failed = 0
                output = None
                try:
                    decode_started = time.perf_counter()
                    image = frame.to_image()
                    decode_ms = (time.perf_counter() - decode_started) * 1000.0
                    render_started = time.perf_counter()
                    output = await asyncio.to_thread(self.runtime.render, image)
                    render_ms = (time.perf_counter() - render_started) * 1000.0
                except Exception as exc:
                    failed = 1
                    error = f"{type(exc).__name__}: {exc}"
                    if error != self.last_error:
                        detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
                        print(f"Frame processing failed: {detail}", flush=True)
                        if isinstance(exc, RuntimeError):
                            print(traceback.format_exc().rstrip(), flush=True)
                        await asyncio.to_thread(self.runtime.report_error, f"Frame processing failed: {detail}")
                        self.last_error = error
                else:
                    self.last_error = ""
                self.render_timing.record(
                    decode_ms=decode_ms,
                    render_ms=render_ms,
                    total_ms=(time.perf_counter() - frame_started) * 1000.0,
                    input_dropped=self.input_frames_dropped,
                    failed=failed,
                )
                self.input_frames_dropped = 0
                if output is not None:
                    self.last_fresh_at = time.perf_counter()
                    await self._replace_latest(self.output_frames, (output, self.last_fresh_at))
        except asyncio.CancelledError:
            raise
        except Exception:
            self.stop()

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        pts, time_base = await self.next_timestamp()
        repeated = 0
        try:
            image, ready_at = self.output_frames.get_nowait()
            self.last_image = image
            self.last_output_ready_at = ready_at
        except asyncio.QueueEmpty:
            if self.last_image is None:
                item = await self.output_frames.get()
                if item is None:
                    raise MediaStreamError
                image, ready_at = item
                self.last_image = image
                self.last_output_ready_at = ready_at
            else:
                image = self.last_image
                ready_at = self.last_output_ready_at
                repeated = 1
        if self.readyState != "live":
            raise MediaStreamError
        convert_started = time.perf_counter()
        frame = av.VideoFrame.from_image(image)
        convert_ms = (time.perf_counter() - convert_started) * 1000.0
        frame.pts = pts
        frame.time_base = time_base
        self.output_timing.record(
            output_age_ms=(time.perf_counter() - ready_at) * 1000.0 if ready_at else 0.0,
            convert_ms=convert_ms,
            repeated_frame=repeated,
        )
        return frame

    def fresh_frame_age_ms(self):
        return (time.perf_counter() - self.last_fresh_at) * 1000.0

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
        self.render_timing.flush()
        self.output_timing.flush()
        super().stop()
        if self.output_frames.empty():
            self.output_frames.put_nowait(None)

