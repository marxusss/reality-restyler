import argparse
import asyncio
import errno
import ipaddress
import json
import os
import shutil
import socket
import ssl
import subprocess
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

from runtime import Runtime, combine_style_prompts
from timing import TimingWindow
from sessions import SESSION_KEY, SessionManager, TOKEN_HEADER, PROTOCOL_PREFIX
from local_frames import process_frame
from webrtc_track import RestyleTrack
from log_retention import enable_logging, prune_logs

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
RUNTIME_DIR = ROOT / ".runtime"
REAPER_TASK_KEY = web.AppKey("reaper_task", asyncio.Task)
STARTUP_PROGRESS_KEY = web.AppKey("startup_progress", dict)
TLS_CONTEXT_KEY = web.AppKey("tls_context", ssl.SSLContext)
TLS_RENEW_TASK_KEY = web.AppKey("tls_renew_task", asyncio.Task)
PHONE_DNS_NAME_KEY = web.AppKey("phone_dns_name", str)
PORT_OVERRIDE = os.environ.get("REALITY_RESTYLE_PORT")
PORT_IS_EXPLICIT = bool(PORT_OVERRIDE)
PORT = int(PORT_OVERRIDE or "8781")
IDLE_SECONDS = min(3600, max(5, int(os.environ.get("REALITY_RESTYLE_IDLE_SECONDS", "30"))))
TLS_RENEW_SECONDS = 6 * 60 * 60
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
    executable = shutil.which("tailscale")
    if executable:
        try:
            result = subprocess.run([executable, "status", "--json"], capture_output=True, text=True, timeout=5, check=True)
            data = json.loads(result.stdout)
            for value in (data.get("Self") or {}).get("TailscaleIPs") or []:
                addresses.add(ipaddress.ip_address(str(value).split("%")[0]).compressed)
        except Exception:
            pass
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
async def boundary(request, handler):
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

async def health(_request):
    return web.json_response({"ok": True, "loaded": await asyncio.to_thread(runtime.loaded)})

async def metrics(_request):
    return web.json_response(await asyncio.to_thread(runtime.metrics))

async def transport_mode(request):
    local = await asyncio.to_thread(_is_local_peer, request.remote)
    return web.json_response({"mode": "local" if local else "remote"})

async def claim_session(request):
    manager = request.app[SESSION_KEY]
    async with manager.lock:
        token = await manager.claim(request.headers.get(TOKEN_HEADER))
        await asyncio.to_thread(runtime.heartbeat)
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
        manager.reserve(token, socket)
        try:
            await socket.prepare(request)
        except BaseException:
            manager.discard(socket)
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
                payload, measurements = await asyncio.to_thread(process_frame, message.data, runtime)
            except Exception as exc:
                if manager.transport is not socket:
                    break
                detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
                await asyncio.to_thread(runtime.report_error, f"Frame processing failed: {detail}")
                print(f"Local frame processing failed: {detail}", flush=True)
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
                timing.record(**measurements, send_ms=(time.perf_counter()-send_started)*1000,
                              total_ms=(time.perf_counter()-frame_started)*1000,
                              input_kb=len(message.data)/1024, output_kb=len(payload)/1024)
            except Exception:
                break
    finally:
        timing.flush()
        manager.discard(socket)
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
    try:
        async with request.app[SESSION_KEY].lock:
            require_owner(request)
            progress = request.app[STARTUP_PROGRESS_KEY]
            stage = {"value": "checking"}
            if startup_id:
                progress[startup_id] = stage

            def report_stage(value):
                stage["value"] = value

            try:
                result = await asyncio.to_thread(runtime.start, settings, allow_low_vram, report_stage)
            finally:
                progress.pop(startup_id, None)
                require_owner(request)
        if result.get("ok"):
            return web.json_response(result)
        return web.json_response(result, status=409)
    except web.HTTPException:
        raise
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=422)
    except RuntimeError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=503)
    except Exception as exc:
        print(f"Runtime startup failed: {type(exc).__name__}: {exc}", flush=True)
        return web.json_response({"ok": False, "error": f"Start failed: {type(exc).__name__}: {exc}"}, status=503)


async def startup_progress(request):
    require_owner(request, touch=False)
    stage = request.app[STARTUP_PROGRESS_KEY].get(request.match_info["startup_id"])
    return web.json_response({"stage": stage["value"] if stage is not None else None})


async def update_settings(request):
    data = await _json(request)
    if set(data) != {"settings"} or not isinstance(data["settings"], dict):
        raise web.HTTPBadRequest(text="Invalid settings.")
    try:
        async with request.app[SESSION_KEY].lock:
            require_owner(request)
            result = runtime.set_settings(data["settings"])
        return web.json_response({"ok": True, "settings": result})
    except ValueError as exc:
        return web.json_response({"ok": False, "error": str(exc)}, status=422)


async def heartbeat(request):
    async with request.app[SESSION_KEY].lock:
        require_owner(request)
        loaded = await asyncio.to_thread(runtime.heartbeat)
    return web.json_response({"ok": True, "loaded": loaded})


async def stop_runtime(request):
    manager = request.app[SESSION_KEY]
    async with manager.lock:
        require_owner(request)
        await manager.close_transport()
        await asyncio.to_thread(runtime.unload)
        manager.release()
    return web.json_response({"ok": True})


async def pause_runtime(request):
    manager = request.app[SESSION_KEY]
    async with manager.lock:
        require_owner(request)
        await manager.close_transport()
        await asyncio.to_thread(runtime.flush_timings)
        loaded = await asyncio.to_thread(runtime.heartbeat)
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
        manager.reserve(request.headers.get(TOKEN_HEADER), pc)

        @pc.on("track")
        def on_track(track):
            if track.kind == "video":
                pc.addTrack(RestyleTrack(track, runtime))

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState in {"failed", "closed"}:
                manager.discard(pc)
                if pc.connectionState != "closed":
                    await pc.close()

        async def negotiate():
            await pc.setRemoteDescription(RTCSessionDescription(sdp=data["sdp"], type="offer"))
            answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            local = pc.localDescription
            if not local or not local.sdp:
                raise RuntimeError("The host produced an empty WebRTC answer.")
            return web.json_response({"sdp": local.sdp, "type": "answer"})

        try:
            return await asyncio.wait_for(negotiate(), timeout=20)
        except (Exception, asyncio.CancelledError) as exc:
            manager.discard(pc)
            try:
                await pc.close()
            except Exception:
                pass
            if isinstance(exc, asyncio.CancelledError):
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
            if manager.expired(IDLE_SECONDS):
                await manager.close_transport()
                await asyncio.to_thread(runtime.unload)
                manager.release()


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


def _tailscale_status():
    executable = shutil.which("tailscale")
    if not executable:
        return {}
    try:
        result = subprocess.run([executable, "status", "--json"], capture_output=True, text=True, timeout=5, check=True)
        return json.loads(result.stdout)
    except Exception:
        return {}

def _tailscale_dns_name(status=None):
    status = status if status is not None else _tailscale_status()
    if status.get("BackendState") != "Running":
        return ""
    return str((status.get("Self") or {}).get("DNSName") or "").rstrip(".")

def _tailscale_addresses(status=None):
    status = status if status is not None else _tailscale_status()
    if status.get("BackendState") != "Running":
        return []
    addresses = []
    seen = set()
    for value in (status.get("Self") or {}).get("TailscaleIPs") or []:
        try:
            address = ipaddress.ip_address(str(value).split("%")[0])
        except ValueError:
            continue
        tailscale_ip = (
            address in ipaddress.ip_network("100.64.0.0/10")
            if address.version == 4
            else address in ipaddress.ip_network("fd7a:115c:a1e0::/48")
        )
        if tailscale_ip and not address.is_unspecified and not address.is_loopback and address.compressed not in seen:
            addresses.append(address.compressed)
            seen.add(address.compressed)
    return addresses

def _listener_socket(address, port):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    info = socket.getaddrinfo(address, port, family, socket.SOCK_STREAM)[0]
    listener = socket.socket(info[0], info[1], info[2])
    try:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
        if info[0] == socket.AF_INET6:
            listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        listener.bind(info[4])
        listener.listen(socket.SOMAXCONN)
        listener.setblocking(False)
        return listener
    except Exception:
        listener.close()
        raise

def _reserve_listener_sockets(addresses):
    candidates = [PORT] if PORT_IS_EXPLICIT else [PORT, 0, 0, 0, 0, 0]
    last_error = None
    for candidate in candidates:
        listeners = []
        try:
            loopback = _listener_socket("127.0.0.1", candidate)
            listeners.append(loopback)
            port = loopback.getsockname()[1]
            for address in addresses:
                listeners.append(_listener_socket(address, port))
            return port, listeners
        except OSError as exc:
            last_error = exc
            for listener in listeners:
                listener.close()
            if exc.errno != errno.EADDRINUSE or PORT_IS_EXPLICIT:
                break
    if last_error and last_error.errno == errno.EADDRINUSE:
        raise RuntimeError("The requested local camera port is already in use. Close the other app and try again.") from last_error
    raise RuntimeError("Could not open a local camera server port.") from last_error

def _certificate_covers(cert_path, dns_name, minimum_validity=timedelta(0)):
    try:
        from cryptography import x509
        certificate = x509.load_pem_x509_certificate(cert_path.read_bytes())
        if certificate.not_valid_after_utc - datetime.now(timezone.utc) < minimum_validity:
            return False
        if dns_name:
            names = certificate.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
            if dns_name.rstrip(".").lower() not in {name.rstrip(".").lower() for name in names}:
                return False
        return True
    except Exception:
        return False

def _certificate_is_self_signed(cert_path):
    try:
        from cryptography import x509
        certificate = x509.load_pem_x509_certificate(cert_path.read_bytes())
        return certificate.issuer == certificate.subject
    except Exception:
        return True

def _create_tailscale_certificate(dns_name, cert_path, key_path):
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    next_cert = RUNTIME_DIR / "tls.next.crt"
    next_key = RUNTIME_DIR / "tls.next.key"
    next_cert.unlink(missing_ok=True)
    next_key.unlink(missing_ok=True)
    executable = shutil.which("tailscale")
    if not executable:
        raise RuntimeError("The Tailscale command is unavailable.")
    subprocess.run(
        [executable, "cert", f"--cert-file={next_cert}", f"--key-file={next_key}", dns_name],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    if not next_cert.is_file() or not next_key.is_file() or not _certificate_covers(next_cert, dns_name) or _certificate_is_self_signed(next_cert):
        raise RuntimeError("Tailscale did not return a valid certificate for this device.")
    validation_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    validation_context.load_cert_chain(str(next_cert), str(next_key))
    os.replace(next_cert, cert_path)
    os.replace(next_key, key_path)

def _refresh_tailscale_certificate(context, dns_name):
    if os.environ.get("REALITY_RESTYLE_CERT") or os.environ.get("REALITY_RESTYLE_KEY"):
        return False
    if _tailscale_dns_name() != dns_name:
        return False
    cert_path = RUNTIME_DIR / "tls.crt"
    key_path = RUNTIME_DIR / "tls.key"
    if cert_path.is_file() and key_path.is_file() and _certificate_covers(cert_path, dns_name, timedelta(days=30)) and not _certificate_is_self_signed(cert_path):
        return False
    _create_tailscale_certificate(dns_name, cert_path, key_path)
    context.load_cert_chain(str(cert_path), str(key_path))
    print("Tailscale HTTPS certificate renewed.", flush=True)
    return True

async def tls_renewal_loop(context, dns_name):
    while True:
        await asyncio.sleep(TLS_RENEW_SECONDS)
        try:
            await asyncio.to_thread(_refresh_tailscale_certificate, context, dns_name)
        except Exception as exc:
            detail = " ".join(str(exc).split())[:400]
            print(f"Tailscale HTTPS renewal failed: {detail or type(exc).__name__}", flush=True)

def _tls_context(dns_name):
    configured_cert = os.environ.get("REALITY_RESTYLE_CERT", "")
    configured_key = os.environ.get("REALITY_RESTYLE_KEY", "")
    if configured_cert or configured_key:
        if not (configured_cert and configured_key):
            raise RuntimeError("Set both the HTTPS certificate and key paths.")
        cert_path, key_path = Path(configured_cert), Path(configured_key)
        if not cert_path.is_file() or not key_path.is_file():
            raise RuntimeError("The configured HTTPS certificate or key file is missing.")
        if not _certificate_covers(cert_path, dns_name) or _certificate_is_self_signed(cert_path):
            raise RuntimeError("The configured HTTPS certificate is not trusted for this Tailscale device.")
    else:
        cert_path, key_path = RUNTIME_DIR / "tls.crt", RUNTIME_DIR / "tls.key"
        usable_certificate = key_path.is_file() and _certificate_covers(cert_path, dns_name) and not _certificate_is_self_signed(cert_path)
        if not usable_certificate or not _certificate_covers(cert_path, dns_name, timedelta(days=30)):
            try:
                _create_tailscale_certificate(dns_name, cert_path, key_path)
            except Exception as exc:
                detail = getattr(exc, "stderr", None) or getattr(exc, "stdout", None) or str(exc)
                detail = " ".join(str(detail).split())[:500]
                print(f"Tailscale certificate unavailable: {detail or type(exc).__name__}", flush=True)
                if not usable_certificate:
                    raise RuntimeError("Enable MagicDNS and HTTPS Certificates in Tailscale Admin → DNS, then restart. https://login.tailscale.com/admin/dns") from None
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(str(cert_path), str(key_path))
    return context

def create_app():
    app = web.Application(middlewares=[boundary], client_max_size=2 * 1024 * 1024)
    app[SESSION_KEY] = SessionManager()
    app[STARTUP_PROGRESS_KEY] = {}
    app.router.add_get("/", index)
    for script in ("app.js", "camera.js", "transport.js"):
        app.router.add_get("/" + script, app_script)
    app.router.add_get("/style.css", style_sheet)
    app.router.add_get("/favicon.svg", favicon)
    app.router.add_get("/styles/{asset:catalog\\.json|[a-zA-Z0-9_-]+\\.webp}", style_asset)
    app.router.add_post("/styles/combine", combine_styles)
    app.router.add_get("/health", health)
    app.router.add_get("/metrics", metrics)
    app.router.add_get("/transport", transport_mode)
    app.router.add_get("/local-stream", local_stream)
    app.router.add_post("/session", claim_session)
    app.router.add_post("/start", start_runtime)
    app.router.add_get("/startup/{startup_id}", startup_progress)
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


async def _run_launcher_server(directory, stopped, phone_access):
    global PORT
    if stopped():
        return
    application = create_app()
    addresses = []
    tls = None
    if phone_access:
        (directory / "stage.txt").write_text("Checking Tailscale", encoding="utf-8")
        status = await asyncio.to_thread(_tailscale_status)
        dns_name = _tailscale_dns_name(status)
        addresses = _tailscale_addresses(status)
        if not dns_name:
            raise RuntimeError("Sign in to Tailscale before starting phone mode.")
        if not addresses:
            raise RuntimeError("Tailscale did not report a usable local IP address.")
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
        if await asyncio.to_thread(_tailscale_dns_name) != dns_name:
            raise RuntimeError("The selected Tailscale hostname changed. Start phone mode again.")
        if stopped():
            return
        (directory / "stage.txt").write_text("Preparing phone HTTPS", encoding="utf-8")
        tls = await asyncio.to_thread(_tls_context, dns_name)
        application[TLS_CONTEXT_KEY] = tls
        application[PHONE_DNS_NAME_KEY] = dns_name

    if stopped():
        return
    PORT, listeners = await asyncio.to_thread(_reserve_listener_sockets, addresses)
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


def _run_from_launcher(directory, parent_pid, phone_access):
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
            asyncio.run(_run_launcher_server(directory, stopped, phone_access))
        except Exception as exc:
            message = str(exc).strip() or type(exc).__name__
            _write_launcher_json(directory, "error.json", {"message": message})
            raise
    finally:
        kernel.CloseHandle(parent)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phone-access", action="store_true")
    parser.add_argument("--launcher-session", type=Path)
    parser.add_argument("--launcher-process-id", type=int)
    args = parser.parse_args()
    if not args.launcher_session:
        parser.error("Start Reality Restyling from its launcher.")
    if not args.launcher_process_id:
        parser.error("--launcher-process-id is required with --launcher-session")
    enable_logging()
    _run_from_launcher(args.launcher_session, args.launcher_process_id, args.phone_access)

if __name__ == "__main__":
    main()
