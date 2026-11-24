import argparse
import asyncio
import ipaddress
import json
import os
import socket
import ssl
import time
import threading
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

from local_frames import process_frame
from preferences import read_preferences, save_preferences
from log_retention import enable_logging, prune_logs
from phone_access import (
    tailscale_status, tailscale_dns_name, tailscale_addresses,
    reserve_listener_sockets, tls_context, tls_renewal_loop,
)
from runtime import Runtime, combine_style_prompts
from sessions import PROTOCOL_PREFIX, SESSION_KEY, TOKEN_HEADER, SessionManager
from timing import TimingWindow
from user_styles import (
    normalize_user_style_sections, read_user_styles, read_user_style_sections,
    write_user_styles, write_user_style_sections,
)
from webrtc_track import RestyleTrack

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
MODEL_LIFECYCLE_KEY = web.AppKey("model_lifecycle", asyncio.Lock)
PREFERENCES_LOCK_KEY = web.AppKey("preferences_write", asyncio.Lock)
REAPER_TASK_KEY = web.AppKey("reaper_task", asyncio.Task)
STARTUP_PROGRESS_KEY = web.AppKey("startup_progress", dict)
TLS_CONTEXT_KEY = web.AppKey("tls_context", ssl.SSLContext)
TLS_RENEW_TASK_KEY = web.AppKey("tls_renew_task", asyncio.Task)
PHONE_DNS_NAME_KEY = web.AppKey("phone_dns_name", str)
PORT_OVERRIDE = os.environ.get("REALITY_RESTYLE_PORT")
PORT_IS_EXPLICIT = bool(PORT_OVERRIDE)
PORT = int(PORT_OVERRIDE or "8781")
IDLE_SECONDS = min(3600, max(5, int(os.environ.get("REALITY_RESTYLE_IDLE_SECONDS", "30"))))
ALLOW_LAN = os.environ.get("REALITY_RESTYLE_ALLOW_LAN", "").strip().lower() in {"1", "true", "yes", "on"}
runtime = Runtime()
local_peer_addresses = None
local_peer_addresses_updated = 0.0
LOCAL_ADDRESS_CACHE_SECONDS = 30.0

def _trusted_peer(value):
    try:
        address = ipaddress.ip_address(str(value or "").split("%")[0])
    except ValueError:
        return False
    if address.is_loopback or address in ipaddress.ip_network("100.64.0.0/10") or address in ipaddress.ip_network("fd7a:115c:a1e0::/48"):
        return True
    return bool(ALLOW_LAN and address.is_private and not address.is_link_local)

def _local_addresses():
    addresses = {"127.0.0.1", "::1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            addresses.add(ipaddress.ip_address(info[4][0].split("%")[0]).compressed)
    except Exception:
        pass
    addresses.update(tailscale_addresses())
    return addresses

def _is_local_peer(value):
    global local_peer_addresses, local_peer_addresses_updated
    try:
        address = ipaddress.ip_address(str(value or "").split("%")[0])
    except ValueError:
        return False
    if address.is_loopback:
        return True
    if getattr(address, "ipv4_mapped", None):
        address = address.ipv4_mapped
    now = time.monotonic()
    if local_peer_addresses is None or (local_peer_addresses_updated and now - local_peer_addresses_updated >= LOCAL_ADDRESS_CACHE_SECONDS):
        local_peer_addresses = _local_addresses()
        local_peer_addresses_updated = now
    return address.compressed in local_peer_addresses

@web.middleware
async def security_middleware(request, handler):
    if not _trusted_peer(request.remote):
        raise web.HTTPForbidden()
    host = request.headers.get("Host", "")
    if request.scheme == "http" and host.lower().partition(":")[0] not in {"127.0.0.1", "localhost"}:
        raise web.HTTPForbidden()
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("Origin")
        if origin:
            try:
                if urlsplit(origin).netloc.lower() != host.lower():
                    raise web.HTTPForbidden()
            except ValueError:
                raise web.HTTPForbidden() from None
    response = await handler(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    return response

async def _json(request):
    try:
        data = await request.json()
    except Exception:
        raise web.HTTPBadRequest(text="Invalid JSON.") from None
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text="A JSON object is required.")
    return data

async def index(_request):
    return web.FileResponse(WEB_ROOT / "index.html")

async def app_script(request):
    return web.FileResponse(WEB_ROOT / request.path[1:], headers={"Content-Type": "text/javascript"})

async def style_sheet(_request):
    return web.FileResponse(WEB_ROOT / "style.css", headers={"Content-Type": "text/css"})

async def favicon(_request):
    return web.FileResponse(WEB_ROOT / "favicon.svg", headers={"Content-Type": "image/svg+xml"})


async def touch_icon(_request):
    return web.FileResponse(WEB_ROOT / "apple-touch-icon.png", headers={"Content-Type": "image/png"})

async def style_asset(request):
    asset = request.match_info["asset"]
    content_type = "application/json" if asset == "catalog.json" else "image/webp"
    return web.FileResponse(WEB_ROOT / "styles" / asset, headers={"Content-Type": content_type})

async def combine_styles(request):
    data = await _json(request)
    try:
        prompt, tokens = await asyncio.to_thread(combine_style_prompts, data.get("prompts"))
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=422)
    except Exception as exc:
        print(f"Style token count failed: {type(exc).__name__}: {exc}", flush=True)
        return web.json_response({"error": "Could not check the style prompt. Check the model files."}, status=503)
    return web.json_response({"prompt": prompt, "tokens": tokens})

async def get_user_styles(request):
    try:
        styles = await asyncio.to_thread(read_user_styles)
        sections = await asyncio.to_thread(read_user_style_sections)
    except Exception as exc:
        print(f"Could not read custom styles: {type(exc).__name__}: {exc}", flush=True)
        return web.json_response({"error": "Could not load custom styles."}, status=500)
    return web.json_response({"styles": styles, "sections": sections})

async def save_user_styles(request):
    data = await _json(request)
    try:
        sections = normalize_user_style_sections(data["sections"]) if "sections" in data else None
        styles = await asyncio.to_thread(write_user_styles, data.get("styles"))
        if sections is not None:
            sections = await asyncio.to_thread(write_user_style_sections, sections)
        else:
            sections = await asyncio.to_thread(read_user_style_sections)
    except ValueError as exc:
        return web.json_response({"error": str(exc)}, status=422)
    except Exception as exc:
        print(f"Could not save custom styles: {type(exc).__name__}: {exc}", flush=True)
        return web.json_response({"error": "Could not save custom styles."}, status=500)
    return web.json_response({"styles": styles, "sections": sections})

async def get_preferences(request):
    try:
        settings = await asyncio.to_thread(read_preferences)
    except (OSError, RuntimeError):
        return web.json_response({"error": "Could not read camera settings."}, status=500)
    return web.json_response({"settings": settings})


async def _persist_preferences(settings):
    try:
        await asyncio.to_thread(save_preferences, settings)
        return True
    except (OSError, RuntimeError) as exc:
        print(f"Could not persist camera settings: {type(exc).__name__}: {exc}", flush=True)
        return False


async def update_preferences(request):
    data = await _json(request)
    if set(data) != {"settings"} or not isinstance(data["settings"], dict):
        raise web.HTTPBadRequest(text="Invalid settings.")
    if set(data["settings"]) - {"prompt", "steps", "resolution", "upscale"}:
        raise web.HTTPBadRequest(text="Unsupported preference.")
    async with request.app[PREFERENCES_LOCK_KEY]:
        try:
            previous = await asyncio.to_thread(read_preferences)
            updated = {**previous, **data["settings"]}
            stored = await asyncio.to_thread(save_preferences, updated)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=422)
        except (OSError, RuntimeError):
            return web.json_response({"error": "Could not save camera settings."}, status=500)
    return web.json_response({"ok": True, "settings": stored})


async def health(_request):
    return web.json_response({"ok": True, "loaded": await asyncio.to_thread(runtime.loaded)})


async def metrics(request):
    result = await asyncio.to_thread(runtime.metrics)
    manager = request.app[SESSION_KEY]
    if isinstance(manager.transport, RTCPeerConnection):
        try:
            require_owner(request, touch=False)
        except web.HTTPConflict:
            pass
        else:
            for sender in manager.transport.getSenders():
                if isinstance(sender.track, RestyleTrack):
                    result["fresh_frame_age_ms"] = sender.track.fresh_frame_age_ms()
                    break
    return web.json_response(result)

async def transport_mode(request):
    local = await asyncio.to_thread(_is_local_peer, request.remote)
    return web.json_response({"mode": "local" if local else "remote"})

async def claim_session(request):
    data = await _json(request)
    if set(data) - {"resume"} or ("resume" in data and not isinstance(data["resume"], bool)):
        raise web.HTTPBadRequest(text="Invalid camera session request.")
    manager = request.app[SESSION_KEY]
    async with manager.lock:
        supplied = request.headers.get(TOKEN_HEADER)
        if data.get("resume"):
            token = await manager.resume(supplied)
        else:
            token = await manager.transfer_control()
    return web.json_response({"token": token})


def require_owner(request, *, touch=True):
    manager = request.app[SESSION_KEY]
    manager.require(request.headers.get(TOKEN_HEADER), touch=touch)
    return manager


async def local_stream(request):
    if not await asyncio.to_thread(_is_local_peer, request.remote):
        raise web.HTTPForbidden()
    origin = request.headers.get("Origin", "")
    if not origin or urlsplit(origin).netloc.lower() != request.headers.get("Host", "").lower():
        raise web.HTTPForbidden()
    protocol = next((p.strip() for p in request.headers.get("Sec-WebSocket-Protocol", "").split(",")
                     if p.strip().startswith(PROTOCOL_PREFIX)), "")
    token = protocol[len(PROTOCOL_PREFIX):]
    manager = request.app[SESSION_KEY]
    socket = web.WebSocketResponse(protocols=[protocol], max_msg_size=4 * 1024 * 1024, heartbeat=30)
    timing = TimingWindow("local_camera")
    async with manager.lock:
        manager.require(token)
        if not runtime.loaded():
            raise web.HTTPConflict(text="The model is not loaded.")
        manager.attach_transport(token, socket)
        try:
            await socket.prepare(request)
        except BaseException:
            manager.detach_transport(socket)
            raise
    try:
        async for message in socket:
            if manager.transport is not socket:
                break
            if message.type != WSMsgType.BINARY:
                continue
            frame_started = time.perf_counter()
            if not runtime.loaded():
                await socket.send_json({"error": "The model stopped. Press Start to retry."})
                break
            try:
                worker_started = time.perf_counter()
                payload, measurements = await asyncio.to_thread(process_frame, message.data, runtime)
                worker_wait_ms = (time.perf_counter()-worker_started)*1000 - measurements["worker_ms"]
            except Exception as exc:
                if manager.transport is not socket:
                    break
                detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
                await asyncio.to_thread(runtime.report_error, f"Frame processing failed: {detail}")
                print(f"Local frame processing failed: {detail}", flush=True)
                if isinstance(exc, RuntimeError):
                    print(traceback.format_exc().rstrip(), flush=True)
                try:
                    await socket.send_json({"error": f"Frame processing failed: {detail}"})
                except Exception:
                    break
                continue
            if manager.transport is not socket:
                break
            try:
                send_started = time.perf_counter()
                await socket.send_bytes(payload)
                timing.record(**measurements, worker_wait_ms=max(0.0, worker_wait_ms),
                              send_ms=(time.perf_counter()-send_started)*1000,
                              total_ms=(time.perf_counter()-frame_started)*1000,
                              input_kb=len(message.data)/1024, output_kb=len(payload)/1024)
            except Exception:
                break
    finally:
        timing.flush()
        manager.detach_transport(socket)
    return socket


async def start_runtime(request):
    data = await _json(request)
    if set(data) - {"settings", "allow_low_vram", "startup_id"}:
        raise web.HTTPBadRequest(text="Unsupported request.")
    settings = data.get("settings", {})
    allow_low_vram = data.get("allow_low_vram", False)
    startup_id = data.get("startup_id", "")
    if not isinstance(settings, dict) or not isinstance(allow_low_vram, bool):
        raise web.HTTPBadRequest(text="Invalid settings.")
    if not isinstance(startup_id, str) or len(startup_id) > 64:
        raise web.HTTPBadRequest(text="Invalid startup identifier.")

    manager = request.app[SESSION_KEY]
    progress = request.app[STARTUP_PROGRESS_KEY]
    stage = {"value": "checking", "cancel": threading.Event()}

    def report_stage(value):
        if stage["cancel"].is_set():
            raise RuntimeError("Startup cancelled.")
        stage["value"] = value

    token = request.headers.get(TOKEN_HEADER)
    async with manager.lock:
        manager.begin_start(token)
        if startup_id:
            progress[startup_id] = stage

    try:
        # The model lock serializes GPU start/unload without blocking another
        # device from claiming control via the much shorter session lock.
        async with request.app[MODEL_LIFECYCLE_KEY]:
            async with manager.lock:
                require_owner(request, touch=False)
            result = await asyncio.to_thread(runtime.start, settings, allow_low_vram, report_stage)
            if stage["cancel"].is_set():
                if result.get("ok"):
                    await asyncio.to_thread(runtime.unload)
                return web.json_response({"ok": False, "error": "Start cancelled."}, status=422)
            async with manager.lock:
                require_owner(request, touch=False)
            if result.get("ok"):
                async with request.app[PREFERENCES_LOCK_KEY]:
                    async with manager.lock:
                        require_owner(request, touch=False)
                    persisted = await _persist_preferences(runtime.settings())
                result["preferences_saved"] = persisted
                if not persisted:
                    result["warning"] = "Camera settings are active but could not be saved."
        return web.json_response(result, status=200 if result.get("ok") else 409)
    except web.HTTPException:
        raise
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=422)
    except RuntimeError as exc:
        if stage["cancel"].is_set():
            return web.json_response({"ok": False, "error": "Start cancelled."}, status=422)
        return web.json_response({"ok": False, "error": str(exc)}, status=503)
    except Exception as exc:
        print(f"Runtime startup failed: {type(exc).__name__}: {exc}", flush=True)
        return web.json_response({"ok": False, "error": f"Start failed: {type(exc).__name__}: {exc}"}, status=503)
    finally:
        async with manager.lock:
            manager.finish_start(token)
        if startup_id and progress.get(startup_id) is stage:
            progress.pop(startup_id, None)


async def cancel_startup(request):
    data = await _json(request)
    if set(data) != {"startup_id"} or not isinstance(data["startup_id"], str):
        raise web.HTTPBadRequest(text="Invalid startup identifier.")
    async with request.app[SESSION_KEY].lock:
        require_owner(request, touch=False)
        stage = request.app[STARTUP_PROGRESS_KEY].get(data["startup_id"])
        if stage:
            stage["cancel"].set()
    return web.json_response({"ok": True, "cancelling": stage is not None})


async def startup_progress(request):
    require_owner(request, touch=False)
    stage = request.app[STARTUP_PROGRESS_KEY].get(request.match_info["startup_id"])
    return web.json_response({"stage": stage["value"] if stage is not None else None})


async def update_settings(request):
    data = await _json(request)
    if set(data) != {"settings"} or not isinstance(data["settings"], dict):
        raise web.HTTPBadRequest(text="Invalid settings.")
    manager = request.app[SESSION_KEY]
    try:
        async with request.app[PREFERENCES_LOCK_KEY]:
            async with manager.lock:
                require_owner(request)
                result = runtime.set_settings(data["settings"])
            persisted = True
            if set(data["settings"]) & {"prompt", "steps", "resolution", "upscale"}:
                async with manager.lock:
                    require_owner(request, touch=False)
                persisted = await _persist_preferences(result)
        response = {"ok": True, "settings": result, "preferences_saved": persisted}
        if not persisted:
            response["warning"] = "Camera settings are active but could not be saved."
        return web.json_response(response)
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=422)


async def heartbeat(request):
    async with request.app[SESSION_KEY].lock:
        require_owner(request)
        loaded = await asyncio.to_thread(runtime.loaded)
    return web.json_response({"ok": True, "loaded": loaded})


async def stop_runtime(request):
    manager = request.app[SESSION_KEY]
    async with manager.lock:
        require_owner(request)
        await manager.close_transport()
        manager.release()
    # A new device can claim immediately. Its subsequent Start waits for the
    # GPU lifecycle lock instead of being blocked behind session ownership.
    async with request.app[MODEL_LIFECYCLE_KEY]:
        async with manager.lock:
            should_unload = manager.token is None
        if should_unload:
            await asyncio.to_thread(runtime.unload)
    return web.json_response({"ok": True, "unloaded": should_unload})


async def pause_runtime(request):
    manager = request.app[SESSION_KEY]
    async with manager.lock:
        require_owner(request)
        await manager.close_transport()
    await asyncio.to_thread(runtime.flush_timings)
    async with manager.lock:
        require_owner(request)
        loaded = runtime.loaded()
    return web.json_response({"ok": True, "loaded": loaded})


async def offer(request):
    data = await _json(request)
    if set(data) != {"sdp", "type"} or data.get("type") != "offer" or not isinstance(data.get("sdp"), str) or not data["sdp"].strip():
        return web.json_response({"ok": False, "error": "Invalid WebRTC offer."}, status=422)
    manager = request.app[SESSION_KEY]
    async with manager.lock:
        require_owner(request)
        if not runtime.loaded():
            raise web.HTTPConflict(text="The model is not loaded.")
        if manager.transport is not None:
            raise web.HTTPConflict(text="A camera session is already active.")
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        manager.attach_transport(request.headers.get(TOKEN_HEADER), pc)

    @pc.on("track")
    def on_track(track):
        if track.kind == "video":
            restyle_track = RestyleTrack(track, runtime)
            restyle_track.set_sender(pc.addTrack(restyle_track))

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        if pc.connectionState in {"failed", "closed"}:
            manager.detach_transport(pc)
            if pc.connectionState != "closed":
                await pc.close()

    # Signaling must not hold the controller lock: another device can
    # take over while this device is negotiating a connection.
    try:
        await pc.setRemoteDescription(RTCSessionDescription(sdp=data["sdp"], type="offer"))
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        local = pc.localDescription
        if not local or not local.sdp:
            raise RuntimeError("The host produced an empty WebRTC answer.")
        async with manager.lock:
            require_owner(request, touch=False)
            if manager.transport is not pc:
                raise web.HTTPConflict(text="Camera connection was interrupted. Try again.")
        return web.json_response({"sdp": local.sdp, "type": "answer"})
    except (Exception, asyncio.CancelledError) as exc:
        manager.detach_transport(pc)
        try:
            await pc.close()
        except Exception:
            pass
        if isinstance(exc, (asyncio.CancelledError, web.HTTPException)):
            raise
        print(f"WebRTC negotiation failed: {type(exc).__name__}: {exc}", flush=True)
        return web.json_response({"ok": False, "error": "Could not connect the camera."}, status=502)


async def idle_reaper(app):
    manager = app[SESSION_KEY]
    last_prune = time.monotonic()
    while True:
        await asyncio.sleep(min(5, max(1, IDLE_SECONDS / 6)))
        if time.monotonic() - last_prune >= 3600:
            await asyncio.to_thread(prune_logs)
            last_prune = time.monotonic()
        async with manager.lock:
            expired = manager.expired(IDLE_SECONDS)
            if expired:
                await manager.close_transport()
                manager.release()
        if expired:
            async with app[MODEL_LIFECYCLE_KEY]:
                async with manager.lock:
                    should_unload = manager.token is None
                if should_unload:
                    await asyncio.to_thread(runtime.unload)


async def on_startup(app):
    app[REAPER_TASK_KEY] = asyncio.create_task(idle_reaper(app))
    context = app.get(TLS_CONTEXT_KEY)
    if context is not None:
        app[TLS_RENEW_TASK_KEY] = asyncio.create_task(tls_renewal_loop(context, app[PHONE_DNS_NAME_KEY]))


async def on_cleanup(app):
    for key in (REAPER_TASK_KEY, TLS_RENEW_TASK_KEY):
        task = app.get(key)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    await app[SESSION_KEY].close_transport()
    await asyncio.to_thread(runtime.unload)
    app[SESSION_KEY].release()


def create_app():
    app = web.Application(middlewares=[security_middleware], client_max_size=8 * 1024 * 1024)
    app[SESSION_KEY] = SessionManager()
    app[MODEL_LIFECYCLE_KEY] = asyncio.Lock()
    app[PREFERENCES_LOCK_KEY] = asyncio.Lock()
    app[STARTUP_PROGRESS_KEY] = {}
    app.router.add_get("/", index)
    for script in ("app.js", "camera.js", "capture.js", "frame_encoding.js", "styles.js", "errors.js", "metrics.js", "transport.js"):
        app.router.add_get("/" + script, app_script)
    app.router.add_get("/style.css", style_sheet)
    app.router.add_get("/favicon.svg", favicon)
    app.router.add_get("/apple-touch-icon.png", touch_icon)
    app.router.add_get("/styles/{asset:catalog\\.json|[a-zA-Z0-9_-]+\\.webp}", style_asset)
    app.router.add_post("/styles/combine", combine_styles)
    app.router.add_get("/styles/user", get_user_styles)
    app.router.add_post("/styles/user", save_user_styles)
    app.router.add_get("/preferences", get_preferences)
    app.router.add_post("/preferences", update_preferences)
    app.router.add_get("/health", health)
    app.router.add_get("/metrics", metrics)
    app.router.add_get("/transport", transport_mode)
    app.router.add_get("/local-stream", local_stream)
    app.router.add_post("/session", claim_session)
    app.router.add_post("/start", start_runtime)
    app.router.add_get("/startup/{startup_id}", startup_progress)
    app.router.add_post("/cancel-start", cancel_startup)
    app.router.add_post("/settings", update_settings)
    app.router.add_post("/heartbeat", heartbeat)
    app.router.add_post("/pause", pause_runtime)
    app.router.add_post("/offer", offer)
    app.router.add_post("/stop", stop_runtime)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(_shutdown_launcher_sessions)
    app.on_cleanup.append(on_cleanup)
    return app


def _write_launcher_json(directory, filename, data):
    pending = directory / f"{filename}.tmp"
    pending.write_text(json.dumps(data), encoding="utf-8")
    pending.replace(directory / filename)


async def _run_launcher_server(directory, stopped, phone_access, wait_for_tailscale=False):
    global PORT
    if stopped():
        return
    application = create_app()
    addresses = []
    tls = None
    if phone_access:
        try:
            (directory / "stage.txt").write_text("Checking Tailscale", encoding="utf-8")
            deadline = time.monotonic() + (45 if wait_for_tailscale else 0)
            while not stopped():
                status = await asyncio.to_thread(tailscale_status)
                dns_name = tailscale_dns_name(status)
                addresses = tailscale_addresses(status)
                if dns_name and addresses:
                    break
                if time.monotonic() >= deadline:
                    if not dns_name:
                        raise RuntimeError("Sign in to Tailscale before starting phone mode.")
                    raise RuntimeError("Tailscale did not report a usable local IP address.")
                (directory / "stage.txt").write_text("Waiting for Tailscale", encoding="utf-8")
                await asyncio.sleep(1)
            else:
                return
            _write_launcher_json(directory, "phone.json", {"hostname": dns_name})
            approval = directory / "phone.approved"
            while not approval.exists():
                if stopped():
                    return
                await asyncio.sleep(0.2)
            if stopped():
                return
            approved = approval.read_text(encoding="utf-8")
            if approved != dns_name:
                raise RuntimeError("The selected Tailscale hostname changed. Start phone mode again.")
            status = await asyncio.to_thread(tailscale_status)
            if tailscale_dns_name(status) != dns_name:
                raise RuntimeError("The selected Tailscale hostname changed. Start phone mode again.")
            if stopped():
                return
            (directory / "stage.txt").write_text("Preparing phone HTTPS", encoding="utf-8")
            tls = await asyncio.to_thread(tls_context, dns_name)
            application[TLS_CONTEXT_KEY] = tls
            application[PHONE_DNS_NAME_KEY] = dns_name
    
        except RuntimeError as exc:
            # Phone prerequisites must not prevent desktop access.
            _write_launcher_json(directory, "phone-setup.json", {"message": str(exc)})
            phone_access = False
            addresses = []
            tls = None
            dns_name = ""

    if stopped():
        return
    PORT, listeners = await asyncio.to_thread(reserve_listener_sockets, addresses, PORT, PORT_IS_EXPLICIT)
    ready = {
        "desktop": f"http://127.0.0.1:{PORT}/",
        "phone": f"https://{dns_name}:{PORT}/" if phone_access else "",
    }
    if stopped():
        for listener in listeners:
            listener.close()
        return
    runner = web.AppRunner(application, access_log=None, shutdown_timeout=5)
    runner_setup = False
    try:
        await runner.setup()
        runner_setup = True
        for index, listener in enumerate(listeners):
            site = web.SockSite(runner, listener, ssl_context=tls if index else None)
            await site.start()
        if ready["phone"]:
            try:
                import qrcode
                qrcode.make(ready["phone"], box_size=5).save(directory / "phone.png")
            except Exception as exc:
                print(f"Phone QR unavailable: {type(exc).__name__}", flush=True)
        if not stopped():
            _write_launcher_json(directory, "ready.json", ready)
        while not stopped():
            await asyncio.sleep(0.25)
    finally:
        if runner_setup:
            await runner.cleanup()
        for listener in listeners:
            listener.close()


async def _shutdown_launcher_sessions(application):
    async with application[SESSION_KEY].lock:
        await application[SESSION_KEY].close_transport()


def _run_from_launcher(directory, parent_pid, phone_access, wait_for_tailscale=False):
    from ctypes import WinDLL, wintypes

    kernel = WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    synchronize = 0x00100000
    wait_timeout = 258
    parent = kernel.OpenProcess(synchronize, False, parent_pid)
    if not parent:
        return
    try:
        def stopped():
            return (directory / "stop").exists() or kernel.WaitForSingleObject(parent, 0) != wait_timeout

        try:
            asyncio.run(_run_launcher_server(directory, stopped, phone_access, wait_for_tailscale))
        except Exception as exc:
            message = str(exc).strip() or type(exc).__name__
            _write_launcher_json(directory, "error.json", {"message": message})
            raise
    finally:
        kernel.CloseHandle(parent)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev", action="store_true", help="Serve checked-out code on localhost without the launcher.")
    parser.add_argument("--phone-access", action="store_true")
    parser.add_argument("--wait-for-tailscale", action="store_true")
    parser.add_argument("--launcher-session", type=Path)
    parser.add_argument("--launcher-process-id", type=int)
    args = parser.parse_args()
    if args.dev:
        if args.phone_access or args.wait_for_tailscale or args.launcher_session or args.launcher_process_id:
            parser.error("--dev cannot be combined with launcher arguments.")
        web.run_app(create_app(), host="127.0.0.1", port=PORT, access_log=None)
        return
    if not args.launcher_session:
        parser.error("Start Reality Restyling from its launcher.")
    if not args.launcher_process_id:
        parser.error("--launcher-process-id is required with --launcher-session")
    enable_logging(echo=False)
    _run_from_launcher(args.launcher_session, args.launcher_process_id, args.phone_access, args.wait_for_tailscale)

if __name__ == "__main__":
    main()
