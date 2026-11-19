import argparse
import asyncio
import ipaddress
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import time
import traceback
import webbrowser
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription

from runtime import Runtime
from sessions import SESSION_KEY, TOKEN_HEADER, PROTOCOL_PREFIX, SessionManager
from local_frames import process_frame
from webrtc_track import RestyleTrack
from log_retention import enable_logging, prune_logs
from launcher_ipc import write_status

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
RUNTIME_DIR = ROOT / ".runtime"
TLS_CONTEXT_KEY = web.AppKey("tls_context", ssl.SSLContext)
TLS_RENEW_TASK_KEY = web.AppKey("tls_renew_task", asyncio.Task)
PHONE_DNS_NAME_KEY = web.AppKey("phone_dns_name", str)
PORT = int(os.environ.get("REALITY_RESTYLE_PORT", "8781"))
IDLE_SECONDS = min(3600, max(5, int(os.environ.get("REALITY_RESTYLE_IDLE_SECONDS", "30"))))
TLS_RENEW_SECONDS = 6 * 60 * 60
ALLOW_LAN = os.environ.get("REALITY_RESTYLE_ALLOW_LAN", "").strip().lower() in {"1", "true", "yes", "on"}
runtime = Runtime()
REAPER_TASK_KEY = web.AppKey("reaper_task", asyncio.Task)
MANAGED_TASK_KEY = web.AppKey("managed_task", asyncio.Task)
MANAGED_KEY = web.AppKey("managed", dict)
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
        token = manager.claim(request.headers.get(TOKEN_HEADER))
    return web.json_response({"token": token})


def require_owner(request):
    manager = request.app[SESSION_KEY]
    manager.require(request.headers.get(TOKEN_HEADER))
    return manager


async def local_stream(request):
    if not await asyncio.to_thread(_is_local_peer, request.remote):
        raise web.HTTPForbidden()
    origin = request.headers.get("Origin", "")
    if not origin or urlsplit(origin).netloc.lower() != request.headers.get("Host", "").lower():
        raise web.HTTPForbidden()
    protocols = request.headers.get("Sec-WebSocket-Protocol", "").split(",")
    protocol = next((p.strip() for p in protocols if p.strip().startswith(PROTOCOL_PREFIX)), "")
    token = protocol[len(PROTOCOL_PREFIX):]
    manager = request.app[SESSION_KEY]
    socket = web.WebSocketResponse(protocols=[protocol], max_msg_size=4 * 1024 * 1024, heartbeat=30)
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
            if not runtime.loaded():
                await socket.send_json({"error": "The model stopped. Press Start to retry."})
                break
            try:
                payload = await asyncio.to_thread(process_frame, message.data, runtime)
            except Exception as exc:
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
                await socket.send_bytes(payload)
            except Exception:
                break
    finally:
        manager.discard(socket)
    return socket


async def start_runtime(request):
    data = await _json(request)
    if set(data) - {"settings", "allow_low_vram"}:
        raise web.HTTPBadRequest(text="Unsupported request.")
    settings = data.get("settings", {})
    allow_low_vram = data.get("allow_low_vram", False)
    if not isinstance(settings, dict) or not isinstance(allow_low_vram, bool):
        raise web.HTTPBadRequest(text="Invalid settings.")
    manager = request.app[SESSION_KEY]
    async with manager.lock:
        require_owner(request)
        try:
            result = await asyncio.to_thread(runtime.start, settings, allow_low_vram)
            manager.require(request.headers.get(TOKEN_HEADER))
            return web.json_response(result, status=200 if result.get("ok") else 409)
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=422)
        except RuntimeError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=503)
        except Exception as exc:
            print(f"Runtime startup failed: {type(exc).__name__}: {exc}", flush=True)
            return web.json_response({"ok": False, "error": f"Start failed: {type(exc).__name__}: {exc}"}, status=503)


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
        loaded = await asyncio.to_thread(runtime.heartbeat)
    return web.json_response({"ok": True, "loaded": loaded})


async def offer(request):
    data = await _json(request)
    if set(data) != {"sdp", "type"} or data.get("type") != "offer" or not isinstance(data.get("sdp"), str) or not data["sdp"].strip():
        return web.json_response({"ok": False, "error": "Invalid WebRTC offer."}, status=422)
    manager = request.app[SESSION_KEY]
    token = request.headers.get(TOKEN_HEADER)
    async with manager.lock:
        manager.require(token)
        if not runtime.loaded():
            raise web.HTTPConflict(text="The model stopped before the camera connected. Press Start to retry.")
        if manager.transport is not None:
            raise web.HTTPConflict(text="A camera session is already active.")
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        manager.reserve(token, pc)

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
            if not local or not isinstance(local.sdp, str) or not local.sdp.strip():
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


async def managed_watch(app):
    managed = app[MANAGED_KEY]
    while True:
        if managed["stop"].exists():
            # Schedule the same graceful-exit signal aiohttp uses for SIGINT/SIGTERM.
            def exit_server():
                raise web.GracefulExit()
            asyncio.get_running_loop().call_soon(exit_server)
            return
        if managed.get("ready"):
            write_status(managed["status"], ready=True, url=managed["url"],
                         loaded=runtime.loaded(), connected=app[SESSION_KEY].transport is not None)
        await asyncio.sleep(1)


async def on_startup(app):
    app[REAPER_TASK_KEY] = asyncio.create_task(idle_reaper(app))
    if MANAGED_KEY in app:
        app[MANAGED_TASK_KEY] = asyncio.create_task(managed_watch(app))
    context = app.get(TLS_CONTEXT_KEY)
    if context is not None:
        app[TLS_RENEW_TASK_KEY] = asyncio.create_task(tls_renewal_loop(context, app[PHONE_DNS_NAME_KEY]))


async def on_shutdown(app):
    async with app[SESSION_KEY].lock:
        await app[SESSION_KEY].close_transport()


async def on_cleanup(app):
    for key in (REAPER_TASK_KEY, TLS_RENEW_TASK_KEY, MANAGED_TASK_KEY):
        task = app.get(key)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    manager = app[SESSION_KEY]
    await manager.close_transport()
    await asyncio.to_thread(runtime.unload)
    manager.release()


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

def _confirm_phone_access(dns_name, launcher):
    disclosure = (
        f"Phone access may publish {dns_name} in a permanent public certificate log.\n"
        "Use a generic Tailscale device name before continuing."
    )
    if launcher:
        from ctypes import windll
        return windll.user32.MessageBoxW(None, f"{disclosure}\n\nEnable phone access?", "Phone access", 0x124) == 6
    print(disclosure, flush=True)
    try:
        return input("Enable phone access? [y/N] ").strip().lower() in {"y", "yes"}
    except (EOFError, KeyboardInterrupt):
        return False

def _print_phone_link(dns_name):
    url = f"https://{dns_name}:{PORT}/"
    print(f"Phone: {url}", flush=True)
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(out=sys.stdout, invert=True)
    except Exception as exc:
        print(f"Phone QR unavailable: {type(exc).__name__}", flush=True)

def create_app():
    app = web.Application(middlewares=[boundary], client_max_size=2 * 1024 * 1024)
    app[SESSION_KEY] = SessionManager()
    app.router.add_get("/", index)
    for script in ("app.js", "camera.js", "transport.js"):
        app.router.add_get("/" + script, app_script)
    app.router.add_get("/style.css", style_sheet)
    app.router.add_get("/favicon.svg", favicon)
    app.router.add_get("/health", health)
    app.router.add_get("/metrics", metrics)
    app.router.add_get("/transport", transport_mode)
    app.router.add_get("/local-stream", local_stream)
    app.router.add_post("/session", claim_session)
    app.router.add_post("/start", start_runtime)
    app.router.add_post("/settings", update_settings)
    app.router.add_post("/heartbeat", heartbeat)
    app.router.add_post("/pause", pause_runtime)
    app.router.add_post("/offer", offer)
    app.router.add_post("/stop", stop_runtime)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    app.on_cleanup.append(on_cleanup)
    return app

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phone-access", action="store_true")
    parser.add_argument("--launcher", action="store_true")
    parser.add_argument("--status-file", type=Path)
    parser.add_argument("--stop-file", type=Path)
    args = parser.parse_args()
    if bool(args.status_file) != bool(args.stop_file):
        parser.error("Both launcher coordination paths are required.")
    enable_logging()
    application = create_app()
    managed = None
    if args.status_file:
        managed = {"status": args.status_file, "stop": args.stop_file, "ready": False}
        application[MANAGED_KEY] = managed

    def failure(message):
        print(message, flush=True)
        if managed:
            write_status(managed["status"], ready=False, error=message)
        return 1

    def serve(url, hosts, tls=None):
        def ready(banner):
            print(banner, flush=True)
            if managed:
                managed.update(ready=True, url=url)
                write_status(managed["status"], ready=True, url=url, loaded=False, connected=False)
            elif args.launcher and not args.phone_access:
                webbrowser.open(url)
            if args.phone_access:
                _print_phone_link(dns_name)
        try:
            web.run_app(application, host=hosts, port=PORT, ssl_context=tls, access_log=None,
                        print=ready)
        except OSError as exc:
            return failure(f"Could not start server: {exc}")
        return 0

    if args.phone_access:
        status = _tailscale_status()
        dns_name = _tailscale_dns_name(status)
        addresses = _tailscale_addresses(status)
        if not dns_name:
            return failure("Sign in to Tailscale before starting phone mode.")
        if not addresses:
            return failure("Tailscale did not report a usable local IP address.")
        if not _confirm_phone_access(dns_name, args.launcher):
            return failure("Phone access cancelled.")
        try:
            tls = _tls_context(dns_name)
        except (OSError, RuntimeError) as exc:
            return failure(f"Phone access unavailable. {exc}")
        application[TLS_CONTEXT_KEY] = tls
        application[PHONE_DNS_NAME_KEY] = dns_name
        return serve(f"https://{dns_name}:{PORT}/", addresses, tls)

    desktop_url = f"http://127.0.0.1:{PORT}/"
    print(f"Desktop: {desktop_url}", flush=True)
    return serve(desktop_url, "127.0.0.1")


if __name__ == "__main__":
    sys.exit(main())
