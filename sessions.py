"""Single-controller lease and transport ownership (event-loop confined)."""
import asyncio
import hmac
import json
import secrets
import time

from aiohttp import web

TOKEN_HEADER = "X-Restyle-Session"
PROTOCOL_PREFIX = "restyle."


def session_expired():
    return web.HTTPConflict(
        text=json.dumps({"code": "session_expired", "error": "Camera session expired. Press Start to reconnect."}),
        content_type="application/json",
    )


def session_taken():
    return web.HTTPConflict(
        text=json.dumps({"code": "session_taken", "error": "Another session has camera control. Press Start to take over."}),
        content_type="application/json",
    )


class SessionManager:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.token = None
        self.last_seen = 0.0
        self.transport = None
        self.starting_token = None

    async def transfer_control(self):
        """Explicit Start transfers ownership. Caller holds the lifecycle lock."""
        self.token = secrets.token_urlsafe(32)
        self.starting_token = None
        self.last_seen = time.monotonic()
        await self.close_transport()
        return self.token

    def require(self, supplied, *, touch=True):
        if self.token is None or not supplied or not supplied.isascii() or len(supplied) > 128:
            raise session_expired()
        if not hmac.compare_digest(self.token, supplied):
            raise session_taken()
        if touch:
            self.last_seen = time.monotonic()

    async def resume(self, supplied):
        if supplied is not None and (not supplied or not supplied.isascii() or len(supplied) > 128):
            raise session_expired()
        if self.token is None:
            self.token = supplied or secrets.token_urlsafe(32)
        elif supplied is None:
            raise session_taken()
        else:
            self.require(supplied, touch=False)
        self.last_seen = time.monotonic()
        await self.close_transport()
        return self.token

    def begin_start(self, token):
        """Pause idle expiration for this controller until startup finishes."""
        self.require(token)
        if self.starting_token == self.token:
            raise web.HTTPConflict(text="Model startup is already in progress.")
        self.starting_token = self.token

    def finish_start(self, token):
        if self.token == token and self.starting_token == token:
            self.starting_token = None
            self.last_seen = time.monotonic()

    def attach_transport(self, token, transport):
        self.require(token)
        if self.transport is not None:
            raise web.HTTPConflict(text="A camera session is already active.")
        self.transport = transport

    def detach_transport(self, transport):
        if self.transport is transport:
            self.transport = None

    def expired(self, seconds):
        return (self.token is not None and self.starting_token != self.token
                and time.monotonic() - self.last_seen >= seconds)

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
        self.starting_token = None


SESSION_KEY = web.AppKey("session", SessionManager)
