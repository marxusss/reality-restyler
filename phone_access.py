"""Tailscale phone access, HTTPS certificate rotation, and listener sockets."""
import asyncio
import errno
import ipaddress
import json
import os
import shutil
import socket
import ssl
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

RUNTIME_DIR = Path(__file__).resolve().parent / ".runtime"
TLS_RENEW_SECONDS = 6 * 60 * 60

def tailscale_json(*arguments):
    executable = shutil.which("tailscale")
    if not executable:
        return {}
    try:
        result = subprocess.run([executable, *arguments], capture_output=True, text=True, timeout=5, check=True)
        data = json.loads(result.stdout)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def tailscale_status():
    return tailscale_json("status", "--json")

def tailscale_dns_name(status=None):
    status = status if status is not None else tailscale_status()
    if status.get("BackendState") != "Running":
        return ""
    return str((status.get("Self") or {}).get("DNSName") or "").rstrip(".")

def tailscale_addresses(status=None):
    status = status if status is not None else tailscale_status()
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

def reserve_listener_sockets(addresses, preferred_port, explicit_port=False):
    candidates = [preferred_port] if explicit_port else [preferred_port, 0, 0, 0, 0, 0]
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
            if exc.errno != errno.EADDRINUSE or explicit_port:
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
    if tailscale_dns_name() != dns_name:
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

def tls_context(dns_name):
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

