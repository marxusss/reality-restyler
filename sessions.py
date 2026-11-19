"""Single-controller lease and transport ownership (event-loop confined)."""
import asyncio
import hmac
import secrets
import time

from aiohttp import web

TOKEN_HEADER = "X-Restyle-Session"
PROTOCOL_PREFIX = "restyle."


class SessionManager:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.token = None
        self.last_seen = 0.0
        self.transport = None

    def claim(self, supplied=None):
        if self.token is not None:
            self.require(supplied)
            return self.token
        self.token = secrets.token_urlsafe(32)
        self.last_seen = time.monotonic()
        return self.token

    def require(self, supplied, *, touch=True):
        if not self.token or not supplied or not supplied.isascii() or not hmac.compare_digest(self.token, supplied):
            raise web.HTTPConflict(text="Another controller owns the session. Close it or wait for the idle timeout.")
        if touch:
            self.last_seen = time.monotonic()

    def reserve(self, token, transport):
        self.require(token)
        if self.transport is not None:
            raise web.HTTPConflict(text="A camera session is already active.")
        self.transport = transport

    def discard(self, transport):
        if self.transport is transport:
            self.transport = None

    def expired(self, seconds):
        return self.token is not None and time.monotonic() - self.last_seen >= seconds

    async def close_transport(self):
        transport, self.transport = self.transport, None
        if transport is not None:
            try:
                await transport.close()
            except Exception as exc:
                print(f"Camera close failed: {type(exc).__name__}: {exc}", flush=True)

    def release(self):
        self.token = None
        self.last_seen = 0.0


SESSION_KEY = web.AppKey("session", SessionManager)
