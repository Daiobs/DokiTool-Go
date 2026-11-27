#!/usr/bin/env python3
"""Minimal standalone batch downloader for the DokiTool Personal Agent API.

Uses the Python 3.9+ standard library only (zero third-party or repo imports).
Reads the API token exclusively from the DOKITOOL_API_TOKEN (or legacy
DOKITOOL_OWNER_TOKEN) environment variable, sends it only via the
Authorization: Bearer header (never in URL query parameters, where tokens are
ignored as anonymous visitor requests without error while leaking into access
logs and shell history), enforces anti-SSRF IP pinning on CDN downloads and
redirects, and never forwards Authorization or Cookie headers to media CDNs.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import random
import re
import socket
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

CHUNK_BYTES = 256 * 1024
PROBE_BYTES = 256 * 1024
MAGIC_PEEK_BYTES = 32
EXPIRY_MARGIN_SECONDS = 30
MAX_API_JSON_BYTES = 8 * 1024 * 1024
MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024
MAX_CDN_REDIRECTS = 5
STANDARD_HTTP_PORTS = frozenset({80, 443})
BLOCKED_HOST_SUFFIXES = (
    "localhost", "local", "internal", "localdomain", "home.arpa",
    "invalid", "lan", "corp", "intranet", "private",
)
_FORBIDDEN_IPV4_NETS = tuple(ipaddress.ip_network(c) for c in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
    "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
))
_FORBIDDEN_IPV6_NETS = tuple(ipaddress.ip_network(c) for c in (
    "::/128", "::1/128", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64",
    "2001::/32", "2001:2::/48", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
))
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{4,}")
_URL_USERINFO_RE = re.compile(r"(?<![A-Za-z0-9+.-])(https?://)[^\s/@#\"'<>]+@")
_URL_QUERY_RE = re.compile(r"(?<![A-Za-z0-9+.-])(https?://[^\s?#\"'<>]+)\?[^\s#\"'<>]+")
_DNS_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_PUBLIC_TLD_RE = re.compile(r"^(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$")
WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}
MIME_EXTENSIONS = {
    "video/mp4": "mp4",
    "video/x-m4v": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/x-matroska": "mkv",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/avif": "avif",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/m4a": "m4a",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
}
CONTAINER_ALIASES = {
    "jpeg": "jpg",
    "quicktime": "mov",
    "matroska": "mkv",
}
KNOWN_MEDIA_EXTENSIONS = {
    "mp4", "m4v", "mov", "webm", "mkv", "avi", "flv", "ts",
    "m4a", "mp3", "aac", "flac", "ogg", "opus", "wav",
    "jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "avif",
}


class FatalAuthError(RuntimeError):
    """Raised on HTTP 401 so all workers stop before exhausting per-IP burst."""


class PermanentAPIError(RuntimeError):
    """Raised on non-retryable unified-v1 business errors."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"HTTP {status} {code}: {message}")
        self.status = status
        self.code = code
        self.api_message = message


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def parse_rfc3339(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def is_expired(expires_at: str | None, margin_seconds: int = EXPIRY_MARGIN_SECONDS) -> bool:
    if not expires_at:
        return False
    dt = parse_rfc3339(expires_at)
    if dt is None:
        return False
    return (dt - utc_now()).total_seconds() <= margin_seconds


def redact_sensitive(text: str) -> str:
    out = _BEARER_RE.sub("Bearer [REDACTED]", str(text or ""))
    for env_key in ("DOKITOOL_API_TOKEN", "DOKITOOL_OWNER_TOKEN"):
        secret = (os.environ.get(env_key) or "").strip()
        if len(secret) >= 8:
            out = out.replace(secret, "[REDACTED_TOKEN]")
    return _URL_QUERY_RE.sub(r"\1?[REDACTED]", _URL_USERINFO_RE.sub(r"\1[REDACTED]@", out))


def _parse_ip(raw_host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(raw_host.strip("[]").split("%", 1)[0])
    except ValueError:
        return None


def _is_loopback_host(host: str) -> bool:
    norm = (host or "").strip().lower().rstrip(".")
    if norm == "localhost" or (norm.endswith(".localhost") and all(_DNS_LABEL_RE.match(lbl) for lbl in norm.split("."))):
        return True
    ip = _parse_ip(norm)
    if ip is None:
        return False
    return ip.ipv4_mapped.is_loopback if (isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped) else ip.is_loopback


def _is_public_ip(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return _is_public_ip(addr.ipv4_mapped)
    if (
        addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
        or addr.is_reserved or addr.is_unspecified or getattr(addr, "is_site_local", False) or not addr.is_global
    ):
        return False
    nets = _FORBIDDEN_IPV4_NETS if isinstance(addr, ipaddress.IPv4Address) else _FORBIDDEN_IPV6_NETS
    return not any(addr in net for net in nets)


def _get_env_proxies() -> dict[str, str]:
    raw = urllib.request.getproxies_environment()
    return {
        k.lower(): v
        for k, v in raw.items()
        if k.lower() in ("http", "https") and isinstance(v, str) and v.strip()
    }


def _has_env_proxy_for(scheme: str, host: str, port: int | None = None) -> bool:
    proxies = _get_env_proxies()
    if not proxies.get(scheme.lower()):
        return False
    hostport = f"{host}:{port}" if port is not None else host
    return not urllib.request.proxy_bypass_environment(hostport)


def _connect_pinned_ip(ip_str: str, port: int, timeout: float | None, source_address: tuple[str, int] | None = None) -> socket.socket:
    addr = ipaddress.ip_address(ip_str)
    family = socket.AF_INET6 if isinstance(addr, ipaddress.IPv6Address) else socket.AF_INET
    sockaddr = (ip_str, port, 0, 0) if family == socket.AF_INET6 else (ip_str, port)
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        if isinstance(timeout, (int, float)):
            sock.settimeout(timeout)
        if source_address:
            sock.bind(source_address)
        sock.connect(sockaddr)
        return sock
    except OSError:
        sock.close()
        raise


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, *args, pinned_ips: tuple[str, ...] = (), **kwargs) -> None:
        self._pinned_ips = pinned_ips
        super().__init__(host, *args, **kwargs)

    def connect(self) -> None:
        if not self._pinned_ips:
            super().connect()
            return
        last_err: OSError | None = None
        for ip in self._pinned_ips:
            try:
                self.sock = _connect_pinned_ip(ip, self.port, self.timeout, self.source_address)
                if self._tunnel_host:
                    self._tunnel()
                return
            except OSError as exc:
                last_err = exc
        raise last_err or OSError(f"Failed to connect to pinned IP for {self.host}")


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, *args, pinned_ips: tuple[str, ...] = (), **kwargs) -> None:
        self._pinned_ips = pinned_ips
        super().__init__(host, *args, **kwargs)

    def connect(self) -> None:
        if not self._pinned_ips:
            super().connect()
            return
        last_err: OSError | None = None
        for ip in self._pinned_ips:
            sock: socket.socket | None = None
            try:
                sock = _connect_pinned_ip(ip, self.port, self.timeout, self.source_address)
                if self._tunnel_host:
                    self.sock = sock
                    self._tunnel()
                self.sock = self._context.wrap_socket(sock, server_hostname=self._tunnel_host or self.host)
                return
            except OSError as exc:
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
                self.sock, last_err = None, exc
        raise last_err or OSError(f"Failed to establish TLS to pinned IP for {self.host}")


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, pinned_ips: tuple[str, ...] = ()) -> None:
        super().__init__()
        self._pinned_ips = pinned_ips

    def http_open(self, req: urllib.request.Request):
        return self.do_open(_PinnedHTTPConnection, req, pinned_ips=self._pinned_ips)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, context: ssl.SSLContext, pinned_ips: tuple[str, ...] = ()) -> None:
        super().__init__(context=context)
        self._pinned_ips = pinned_ips

    def https_open(self, req: urllib.request.Request):
        return self.do_open(_PinnedHTTPSConnection, req, context=self._context, pinned_ips=self._pinned_ips)


def _build_safe_opener(*, bypass_proxy: bool, pinned_ips: tuple[str, ...] = ()) -> urllib.request.OpenerDirector:
    """OpenerDirector with zero cookies, zero auto-redirects, zero file/ftp handlers, zero OS proxies."""
    opener = urllib.request.OpenerDirector()
    ctx = ssl.create_default_context()
    use_pin = bypass_proxy and bool(pinned_ips)
    proxy_map = {} if bypass_proxy else _get_env_proxies()
    for handler in (
        urllib.request.ProxyHandler(proxy_map),
        _PinnedHTTPHandler(pinned_ips) if use_pin else urllib.request.HTTPHandler(),
        _PinnedHTTPSHandler(ctx, pinned_ips) if use_pin else urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.HTTPErrorProcessor(),
    ):
        opener.add_handler(handler)
    return opener


def validate_remote_url_and_pin(
    url: str,
    *,
    allowed_loopback_origin: tuple[str, str, int] | None = None,
    enforce_standard_ports: bool = True,
) -> tuple[urllib.parse.SplitResult, tuple[str, ...]]:
    if not isinstance(url, str) or not url or len(url) > 8192:
        raise ValueError("Invalid remote URL")
    if any(ord(ch) <= 0x20 or ord(ch) >= 0x7F or ch in ("\\", "#") for ch in url):
        raise ValueError("URL contains forbidden characters")
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError(f"Unsupported URL scheme: {scheme or '<empty>'}")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc or not parsed.hostname:
        raise ValueError("URL userinfo is forbidden and hostname is required")
    host = parsed.hostname.lower().rstrip(".")
    if "%" in host:
        raise ValueError("Scoped IPv6 addresses are forbidden")
    port = parsed.port or (443 if scheme == "https" else 80)

    if _is_loopback_host(host):
        if allowed_loopback_origin is None or (scheme, host, port) != allowed_loopback_origin:
            raise ValueError("Refusing loopback/local URL for media fetch")
        ip = _parse_ip(host)
        if ip is not None:
            return parsed, (str(ip),)
        return parsed, ("127.0.0.1", "::1")

    if enforce_standard_ports and port not in STANDARD_HTTP_PORTS:
        raise ValueError(f"Refusing non-standard media port: {port}")
    if any(host == s or host.endswith("." + s) for s in BLOCKED_HOST_SUFFIXES):
        raise ValueError(f"Blocked internal hostname suffix: {host}")
    ip = _parse_ip(host)
    if ip is not None:
        if not _is_public_ip(ip):
            raise ValueError("Refusing non-public IP literal")
        return parsed, (str(ip),)
    labels = host.split(".")
    if len(labels) < 2 or not _PUBLIC_TLD_RE.match(labels[-1]) or not all(_DNS_LABEL_RE.match(lbl) for lbl in labels):
        raise ValueError(f"Invalid public DNS hostname: {host}")
    try:
        infos = socket.getaddrinfo(host, port, 0, socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError(f"DNS resolution failed for {host}") from exc
    pinned: list[str] = []
    for entry in infos:
        resolved = _parse_ip(str(entry[4][0]))
        if resolved is None or not _is_public_ip(resolved):
            raise ValueError(f"Host {host} resolved to non-public IP")
        ip_str = str(resolved)
        if ip_str not in pinned:
            pinned.append(ip_str)
    if not pinned:
        raise ValueError(f"No public IP addresses resolved for {host}")
    return parsed, tuple(pinned)


def validate_api_base(api_base: str) -> str:
    cleaned = api_base.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(cleaned)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower().rstrip(".")
    if (
        scheme not in {"http", "https"} or not host or parsed.query or parsed.fragment
        or parsed.username is not None or parsed.password is not None or "@" in parsed.netloc
    ):
        raise ValueError("Invalid --api-base URL")
    if _is_loopback_host(host):
        return cleaned
    if scheme != "https":
        raise ValueError("Refusing to send Bearer token over plaintext HTTP to non-loopback host")
    if any(host == s or host.endswith("." + s) for s in BLOCKED_HOST_SUFFIXES):
        raise ValueError("Refusing internal hostname for --api-base")
    ip = _parse_ip(host)
    if ip is not None and not _is_public_ip(ip):
        raise ValueError("Refusing non-public IP literal for --api-base")
    return cleaned


def validate_owner_token(raw: str) -> str:
    token = raw.strip()
    if not token:
        raise ValueError("Environment variable DOKITOOL_API_TOKEN (or legacy DOKITOOL_OWNER_TOKEN) is empty or unset")
    if len(token) < 32 or len(token) > 512 or any(ord(ch) < 33 or ord(ch) > 126 for ch in token):
        raise ValueError("API Bearer token must be 32-512 printable non-whitespace ASCII characters")
    return token


def sanitize_token(text: str, max_chars: int = 48) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]+', "_", text or "")
    cleaned = re.sub(r"\s+", "_", cleaned).strip("._ ")
    cleaned = cleaned[:max_chars].rstrip("._ ")
    if not cleaned or cleaned.upper() in WINDOWS_RESERVED:
        return "item"
    return cleaned


def extension_from_content_type(content_type: str | None) -> str | None:
    mime = str(content_type or "").split(";")[0].strip().lower()
    return MIME_EXTENSIONS.get(mime)


def infer_extension_from_result(
    metadata: dict | None,
    url: str = "",
    route_url: str = "",
) -> str | None:
    meta = metadata or {}
    raw_ext = str(meta.get("extension") or "").strip().lower().lstrip(".")
    raw_ext = CONTAINER_ALIASES.get(raw_ext, raw_ext)
    if raw_ext in KNOWN_MEDIA_EXTENSIONS:
        return raw_ext

    by_mime = extension_from_content_type(str(meta.get("mime_type") or ""))
    if by_mime:
        return by_mime

    raw_container = str(meta.get("container") or "").strip().lower().lstrip(".")
    raw_container = CONTAINER_ALIASES.get(raw_container, raw_container)
    if raw_container in KNOWN_MEDIA_EXTENSIONS:
        return raw_container

    for candidate_url in (url, route_url):
        if not candidate_url:
            continue
        path_ext = Path(urllib.parse.urlsplit(candidate_url).path).suffix.lower().lstrip(".")
        if path_ext in KNOWN_MEDIA_EXTENSIONS:
            return CONTAINER_ALIASES.get(path_ext, path_ext)
    return None


def sniff_extension_from_magic(head: bytes) -> str | None:
    if len(head) >= 8 and head[4:8] == b"ftyp":
        brand = head[8:12] if len(head) >= 12 else b""
        if brand in {b"M4A ", b"M4B "}:
            return "m4a"
        if brand == b"qt  ":
            return "mov"
        if brand in {b"heic", b"heix", b"hevc", b"hevx"}:
            return "heic"
        if brand in {b"avif", b"avis"}:
            return "avif"
        return "mp4"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    return None


def infer_extension(
    metadata: dict | None,
    url: str,
    content_type: str | None = None,
    head_bytes: bytes = b"",
    route_url: str = "",
) -> str:
    """Resolves extension in strict 4-step priority order:
    1. Parse/resolve result fields (metadata.extension / mime_type / container, or known URL suffix)
    2. Download HTTP response Content-Type header
    3. Leading magic bytes of the downloaded file (ftyp, JPEG, PNG, WebP, GIF)
    4. Fallback to 'bin'
    """
    return (
        infer_extension_from_result(metadata, url, route_url=route_url)
        or extension_from_content_type(content_type)
        or sniff_extension_from_magic(head_bytes)
        or "bin"
    )


def safe_output_path(output_dir: Path, filename: str) -> Path:
    if output_dir.is_symlink():
        raise ValueError("Output directory cannot be a symlink")
    if (
        not filename
        or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in filename)
        or "/" in filename or "\\" in filename or ":" in filename
        or filename.endswith((".", " "))
        or filename.split(".", 1)[0].upper() in WINDOWS_RESERVED
    ):
        raise ValueError(f"Unsafe output filename rejected: {filename}")
    root = output_dir.resolve()
    raw_target = root / filename
    if raw_target.is_symlink():
        raise ValueError(f"Symlink target rejected: {filename}")
    candidate = raw_target.resolve()
    if candidate.parent != root:
        raise ValueError(f"Unsafe output filename rejected: {filename}")
    return candidate


def _is_bilibili_akamai_cdn(host: str, path: str) -> bool:
    if not host.endswith(".akamaized.net"):
        return False
    first_label = host.split(".", 1)[0]
    return host.startswith("upos-") or "bili" in first_label or "/upgcxcode/" in path.lower()


def cdn_headers_for_url(url: str, byte_offset: int = 0, byte_end: int | None = None) -> dict[str, str]:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Refusing non-HTTP(S) media URL")
    host = parsed.hostname.lower()
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; DokiToolAgentExample/1.0)",
        "Accept": "*/*",
    }
    # Weibo raw CDN URLs require Referer: https://weibo.com/ (without Cookie).
    if host == "weibo.com" or host.endswith(".weibocdn.com") or host.endswith(".sinaimg.cn"):
        headers["Referer"] = "https://weibo.com/"
    # Bilibili media CDNs (incl. overseas Akamai UPOS nodes) require Referer: https://www.bilibili.com/ (without Cookie).
    elif (
        host == "bilivideo.com"
        or host.endswith(".bilivideo.com")
        or host == "bilivideo.cn"
        or host.endswith(".bilivideo.cn")
        or host == "hdslb.com"
        or host.endswith(".hdslb.com")
        or _is_bilibili_akamai_cdn(host, parsed.path)
    ):
        headers["Referer"] = "https://www.bilibili.com/"
    if byte_end is not None:
        headers["Range"] = f"bytes={byte_offset}-{byte_end}"
    elif byte_offset > 0:
        headers["Range"] = f"bytes={byte_offset}-"
    return headers


class AgentClient:
    def __init__(self, api_base: str, token: str, abort_event: threading.Event, timeout: float = 95.0) -> None:
        self.api_base = api_base
        self.token = token
        self.abort_event = abort_event
        self.timeout = timeout
        parsed_api = urllib.parse.urlsplit(api_base)
        api_host = (parsed_api.hostname or "").lower().rstrip(".")
        api_port = parsed_api.port or (443 if parsed_api.scheme.lower() == "https" else 80)
        self._allowed_loopback_origin: tuple[str, str, int] | None = (
            (parsed_api.scheme.lower(), api_host, api_port) if _is_loopback_host(api_host) else None
        )

    def open_safe_url(
        self,
        url: str,
        *,
        headers_fn,
        timeout: float,
        allow_redirects: bool,
        is_api: bool = False,
    ):
        """Open HTTP(S) URL with zero cookies, anti-SSRF IP pinning, and manual redirect re-validation."""
        current = url
        hops = 0
        prev_scheme: str | None = None
        while True:
            parsed, pinned_ips = validate_remote_url_and_pin(
                current,
                allowed_loopback_origin=self._allowed_loopback_origin if (is_api or hops == 0 or self._allowed_loopback_origin is not None) else None,
                enforce_standard_ports=not is_api,
            )
            scheme = parsed.scheme.lower()
            if hops > 0 and prev_scheme == "https" and scheme != "https":
                raise ValueError("Refusing HTTPS-to-HTTP redirect downgrade")
            prev_scheme = scheme
            host = (parsed.hostname or "").lower().rstrip(".")
            use_proxy = (not _is_loopback_host(host)) and _has_env_proxy_for(scheme, host, parsed.port)
            bypass = not use_proxy
            opener = _build_safe_opener(bypass_proxy=bypass, pinned_ips=pinned_ips if bypass else ())
            req = urllib.request.Request(current, headers=headers_fn(current, hops), method="GET")
            try:
                return opener.open(req, timeout=timeout), current
            except urllib.error.HTTPError as exc:
                if exc.code in {301, 302, 303, 307, 308}:
                    location = (exc.headers.get("Location") or "").strip() if exc.headers else ""
                    exc.close()
                    if not allow_redirects or not location or hops >= MAX_CDN_REDIRECTS:
                        raise ValueError(f"Redirect rejected or exceeded limit ({MAX_CDN_REDIRECTS})") from exc
                    current = urllib.parse.urljoin(current, location)
                    hops += 1
                    continue
                raise

    def api_get(self, path_and_query: str) -> dict:
        url = f"{self.api_base}{path_and_query}"
        transient_attempts = 0
        rate_limit_attempts = 0

        while True:
            if self.abort_event.is_set():
                raise FatalAuthError("Aborted due to earlier HTTP 401 authentication failure")

            try:
                resp, _ = self.open_safe_url(
                    url,
                    headers_fn=lambda _u, _h: {
                        "Authorization": f"Bearer {self.token}",
                        "Accept": "application/json",
                        "User-Agent": "DokiToolAgentBatchExample/1.0",
                    },
                    timeout=self.timeout,
                    allow_redirects=False,
                    is_api=True,
                )
                with resp:
                    raw_bytes = resp.read(MAX_API_JSON_BYTES + 1)
                    if len(raw_bytes) > MAX_API_JSON_BYTES:
                        raise PermanentAPIError(resp.status, "RESPONSE_TOO_LARGE", "API JSON response exceeded 8 MiB limit")
                    payload = json.loads(raw_bytes.decode("utf-8"))
                    if payload.get("code") != "OK":
                        err = payload.get("error") or {}
                        raise PermanentAPIError(
                            resp.status,
                            str(err.get("code") or payload.get("code") or "UNKNOWN"),
                            redact_sensitive(str(err.get("message") or "Unexpected non-OK response")),
                        )
                    return payload
            except urllib.error.HTTPError as exc:
                raw_body = exc.read(64 * 1024).decode("utf-8", errors="replace")
                exc.close()
                try:
                    body = json.loads(raw_body)
                except ValueError:
                    body = {}
                err = body.get("error") if isinstance(body.get("error"), dict) else {}
                code = str(err.get("code") or body.get("code") or f"HTTP_{exc.code}")
                message = redact_sensitive(str(err.get("message") or exc.reason or "HTTP error"))
                retryable = bool(err.get("retryable"))

                # CRITICAL: HTTP 401 returns code="INVALID_INPUT" and charges the anonymous
                # per-IP burst bucket. Stop the entire batch immediately.
                if exc.code == 401:
                    self.abort_event.set()
                    raise FatalAuthError(
                        f"HTTP 401 ({code}: {message}) - check DOKITOOL_API_TOKEN / DOKITOOL_OWNER_TOKEN and server config"
                    ) from exc

                if exc.code == 429:
                    rate_limit_attempts += 1
                    if rate_limit_attempts > 3:
                        raise PermanentAPIError(exc.code, code, f"{message} (retries exhausted)") from exc
                    retry_sec = err.get("retry_after_seconds")
                    if not isinstance(retry_sec, int) or retry_sec < 1:
                        header_val = exc.headers.get("Retry-After", "1") if exc.headers else "1"
                        retry_sec = int(header_val) if header_val.isdigit() else 1
                    delay = min(60.0, float(max(1, retry_sec))) + random.uniform(0.05, 0.25)
                    self._sleep(delay)
                    continue

                if exc.code == 503 and retryable and transient_attempts < 2:
                    transient_attempts += 1
                    retry_sec = err.get("retry_after_seconds")
                    if not isinstance(retry_sec, int) or retry_sec < 1:
                        header_val = exc.headers.get("Retry-After", "") if exc.headers else ""
                        retry_sec = int(header_val) if header_val.isdigit() else int(2 * transient_attempts)
                    delay = min(60.0, float(max(1, retry_sec))) + random.uniform(0.05, 0.25)
                    self._sleep(delay)
                    continue

                if exc.code in {502, 504} and retryable and transient_attempts < 2:
                    transient_attempts += 1
                    self._sleep(2.0 * transient_attempts + random.uniform(0.05, 0.25))
                    continue

                raise PermanentAPIError(exc.code, code, message) from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if transient_attempts < 2:
                    transient_attempts += 1
                    self._sleep(2.0 * transient_attempts)
                    continue
                raise PermanentAPIError(0, "NETWORK_ERROR", redact_sensitive(str(exc))) from exc

    def parse_url(self, share_url: str) -> dict:
        qs = urllib.parse.urlencode({"schema_version": "1.0", "url": share_url})
        return self.api_get(f"/api/parse?{qs}")

    def resolve_item(self, resolve_url: str) -> dict:
        parsed = urllib.parse.urlsplit((resolve_url or "").strip())
        if parsed.scheme or parsed.netloc or parsed.fragment or parsed.path != "/api/resolve" or not parsed.query:
            raise PermanentAPIError(400, "INVALID_RESOLVE_URL", "Refusing unexpected resolve_url path")
        return self.api_get(resolve_url.strip())

    def probe_throughput(self, routes: list[dict]) -> list[dict]:
        if len(routes) <= 1:
            return routes
        scored: list[tuple[float, int, dict]] = []
        for idx, route in enumerate(routes[:3]):
            start = time.monotonic()
            try:
                resp, _ = self.open_safe_url(
                    route["url"],
                    headers_fn=lambda u, _h: cdn_headers_for_url(u, 0, PROBE_BYTES - 1),
                    timeout=8.0,
                    allow_redirects=True,
                )
                with resp:
                    if resp.status not in {200, 206}:
                        scored.append((-1.0, idx, route))
                        continue
                    data = resp.read(PROBE_BYTES)
                    elapsed = max(0.001, time.monotonic() - start)
                    scored.append((len(data) / elapsed, idx, route))
            except Exception:
                scored.append((-1.0, idx, route))
        scored.sort(key=lambda entry: (-entry[0], entry[1]))
        probed_urls = {r["url"] for _, _, r in scored}
        ordered = [r for _, _, r in scored if _ >= 0] + [r for r in routes if r["url"] not in probed_urls]
        if not ordered:
            return routes
        # Keep failed routes at the tail as last-resort fallbacks
        failed = [r for rate, _, r in scored if rate < 0]
        return ordered + [r for r in failed if r not in ordered]

    def _sleep(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.abort_event.is_set():
                raise FatalAuthError("Aborted during backoff sleep")
            time.sleep(min(0.1, max(0.0, deadline - time.monotonic())))


def collect_file_routes(sources: list[dict], preferred_source_id: str | None = None) -> list[dict]:
    ordered_sources = list(sources)
    if preferred_source_id:
        ordered_sources.sort(key=lambda s: 0 if s.get("id") == preferred_source_id else 1)

    routes: list[dict] = []
    seen_urls: set[str] = set()
    for src in ordered_sources:
        if src.get("availability") == "unavailable":
            continue
        if src.get("access", "direct") == "relay":
            continue
        expires_at = src.get("expires_at")
        if is_expired(expires_at):
            continue
        size_bytes = src.get("size_bytes") if isinstance(src.get("size_bytes"), int) else None
        candidates = [src.get("url", ""), *(src.get("fallback_urls") or [])]
        for raw_url in candidates:
            if not raw_url or raw_url in seen_urls:
                continue
            seen_urls.add(raw_url)
            routes.append({
                "url": raw_url,
                "size_bytes": size_bytes,
                "expires_at": expires_at,
                "source_id": src.get("id") or "primary",
            })
    return routes


def extract_item_tasks(data: dict, item: dict, output_dir: Path) -> list[dict]:
    platform = sanitize_token(str(data.get("platform") or "media"), 24)
    raw_cid = str(data.get("content_id") or "")
    if not raw_cid:
        raw_cid = hashlib.sha256(str(data.get("source_url") or "").encode("utf-8")).hexdigest()[:12]
    content_id = sanitize_token(raw_cid, 36)
    item_id = sanitize_token(str(item.get("id") or f"item-{item.get('index', 1)}"), 36)
    stem = f"{platform}_{content_id}_{item_id}"

    variants = [v for v in (item.get("variants") or []) if v.get("state") != "deferred"]
    default_sel = item.get("default")

    if isinstance(default_sel, dict) and default_sel.get("variant_id"):
        target_variant = next((v for v in variants if v.get("id") == default_sel["variant_id"]), None)
        if target_variant and (target_variant.get("delivery") or {}).get("kind") == "file":
            routes = collect_file_routes(
                target_variant["delivery"].get("sources") or [],
                preferred_source_id=default_sel.get("source_id"),
            )
            safe_output_path(output_dir, f"{stem}.part")
            return [{
                "item_id": str(item.get("id") or item_id),
                "role": "main",
                "stem": stem,
                "output_dir": output_dir,
                "metadata": target_variant.get("metadata"),
                "result_url": str(default_sel.get("url") or (routes[0]["url"] if routes else "")),
                "routes": routes,
            }]

    if item.get("type") == "live_photo":
        pair_variant = next((v for v in variants if (v.get("delivery") or {}).get("kind") == "pair"), None)
        if pair_variant:
            tasks: list[dict] = []
            for res in pair_variant["delivery"].get("resources") or []:
                res_delivery = res.get("delivery") or {}
                if res_delivery.get("kind") != "file":
                    continue
                role = sanitize_token(str(res.get("role") or "part"), 16)
                routes = collect_file_routes(res_delivery.get("sources") or [])
                first_url = routes[0]["url"] if routes else ""
                role_stem = f"{stem}_{role}"
                safe_output_path(output_dir, f"{role_stem}.part")
                tasks.append({
                    "item_id": str(item.get("id") or item_id),
                    "role": role,
                    "stem": role_stem,
                    "output_dir": output_dir,
                    "metadata": res.get("metadata"),
                    "result_url": first_url,
                    "routes": routes,
                })
            return tasks

    file_variant = next((v for v in variants if (v.get("delivery") or {}).get("kind") == "file"), None)
    if file_variant:
        routes = collect_file_routes(file_variant["delivery"].get("sources") or [])
        first_url = routes[0]["url"] if routes else ""
        safe_output_path(output_dir, f"{stem}.part")
        return [{
            "item_id": str(item.get("id") or item_id),
            "role": "main",
            "stem": stem,
            "output_dir": output_dir,
            "metadata": file_variant.get("metadata"),
            "result_url": first_url,
            "routes": routes,
        }]

    return []


def parse_content_range_total(content_range: str, expected_start: int) -> tuple[bool, int | None]:
    match = re.match(r"^bytes\s+(\d+)-(\d+)/(\d+|\*)$", (content_range or "").strip(), re.I)
    if not match:
        return False, None
    start = int(match.group(1))
    if start != expected_start:
        return False, None
    total = int(match.group(3)) if match.group(3) != "*" else None
    return True, total


def find_existing_complete_file(
    output_dir: Path,
    stem: str,
    known_ext: str | None,
    expected_size: int | None,
) -> tuple[Path, int] | None:
    if known_ext:
        candidate = safe_output_path(output_dir, f"{stem}.{known_ext}")
        if candidate.is_file():
            existing = candidate.stat().st_size
            if existing > 0 and (expected_size is None or existing == expected_size):
                return candidate, existing
        return None

    prefix = f"{stem}."
    for entry in sorted(output_dir.iterdir(), key=lambda p: p.name):
        if not entry.is_file() or not entry.name.startswith(prefix):
            continue
        ext = entry.name[len(prefix):]
        if ext == "part" or ext not in KNOWN_MEDIA_EXTENSIONS:
            continue
        existing = entry.stat().st_size
        if existing > 0 and (expected_size is None or existing == expected_size):
            return safe_output_path(output_dir, entry.name), existing
    return None


def download_single_route(
    client: AgentClient,
    route: dict,
    task: dict,
) -> tuple[Path, int]:
    output_dir: Path = task["output_dir"]
    stem: str = task["stem"]
    metadata: dict | None = task.get("metadata")
    result_url: str = str(task.get("result_url") or "")
    part_path = safe_output_path(output_dir, f"{stem}.part")
    expected_size = route.get("size_bytes")
    if expected_size is not None and expected_size > MAX_MEDIA_BYTES:
        raise ValueError(f"Declared media size exceeds {MAX_MEDIA_BYTES} byte limit")
    known_ext = infer_extension_from_result(metadata, result_url, route_url=route["url"])

    if not part_path.is_file():
        existing = find_existing_complete_file(output_dir, stem, known_ext, expected_size)
        if existing is not None:
            return existing

    offset = part_path.stat().st_size if part_path.is_file() else 0
    if expected_size is not None and offset >= expected_size:
        part_path.unlink(missing_ok=True)
        offset = 0

    resp, final_url = client.open_safe_url(
        route["url"],
        headers_fn=lambda u, _h: cdn_headers_for_url(u, byte_offset=offset),
        timeout=45.0,
        allow_redirects=True,
    )
    with resp:
        status = resp.status
        resp_content_type = resp.headers.get("Content-Type", "") if resp.headers else ""
        mode = "wb"
        written = 0
        remote_total: int | None = None

        if offset > 0 and status == 206:
            ok_range, cr_total = parse_content_range_total(resp.headers.get("Content-Range", ""), offset)
            if ok_range:
                mode = "ab"
                written = offset
                remote_total = cr_total
            else:
                offset = 0
        elif status == 200:
            offset = 0
            cl = resp.headers.get("Content-Length", "")
            if cl.isdigit():
                remote_total = int(cl)
        else:
            raise urllib.error.HTTPError(final_url, status, "Unexpected CDN status", resp.headers, None)

        if remote_total is not None and remote_total > MAX_MEDIA_BYTES:
            raise ValueError(f"CDN Content-Length exceeds {MAX_MEDIA_BYTES} byte limit")

        with open(part_path, mode) as handle:
            while True:
                chunk = resp.read(CHUNK_BYTES)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_MEDIA_BYTES:
                    raise ValueError(f"Downloaded media exceeded {MAX_MEDIA_BYTES} byte limit")
                handle.write(chunk)
            handle.flush()

    target_total = expected_size if expected_size is not None else remote_total
    if written <= 0 or (target_total is not None and written != target_total):
        raise IOError(f"Incomplete download ({written} bytes vs expected {target_total})")

    with open(part_path, "rb") as head_handle:
        head_bytes = head_handle.read(MAGIC_PEEK_BYTES)

    resolved_ext = infer_extension(
        metadata,
        result_url,
        content_type=resp_content_type,
        head_bytes=head_bytes,
        route_url=final_url,
    )
    final_path = safe_output_path(output_dir, f"{stem}.{resolved_ext}")
    os.replace(part_path, final_path)
    return final_path, written


def download_with_failover(
    client: AgentClient,
    task: dict,
    probe_routes: bool,
) -> tuple[Path | None, int, bool]:
    """Returns (final_path, bytes_saved, saw_expired_status)."""
    routes = task["routes"]
    candidates = client.probe_throughput(routes) if probe_routes else routes
    saw_auth_or_gone = False
    last_err: Exception | None = None

    for route in candidates:
        if is_expired(route.get("expires_at"), margin_seconds=5):
            saw_auth_or_gone = True
            continue
        try:
            final_path, saved_bytes = download_single_route(client, route, task)
            return final_path, saved_bytes, False
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code in {403, 410}:
                saw_auth_or_gone = True
            continue
        except Exception as exc:
            last_err = exc
            continue

    if saw_auth_or_gone:
        return None, 0, True
    raise RuntimeError(f"All {len(candidates)} CDN routes failed: {redact_sensitive(str(last_err))}")


def process_share_input(
    client: AgentClient,
    share_input: str,
    output_dir: Path,
    probe_routes: bool,
) -> dict:
    envelope = client.parse_url(share_input)
    data = envelope["data"]
    platform = str(data.get("platform") or "")

    saved_files: list[dict] = []
    skipped_items: list[dict] = []

    for item in data.get("items") or []:
        if client.abort_event.is_set():
            raise FatalAuthError("Aborted")

        item_id = str(item.get("id") or "")
        state = item.get("state", "ready")
        active_data = data
        active_item = item
        resolve_url = item.get("resolve_url")

        if state == "deferred":
            if not isinstance(resolve_url, str) or not resolve_url:
                skipped_items.append({"item_id": item_id, "reason": "deferred_without_resolve_url"})
                continue
            resolved_env = client.resolve_item(resolve_url)
            active_data = resolved_env["data"]
            active_item = next(
                (it for it in (active_data.get("items") or []) if it.get("id") == item_id),
                active_item,
            )
            state = active_item.get("state", "ready")

        if state != "ready":
            err_code = ((active_item.get("error") or {}).get("code")) or state
            skipped_items.append({"item_id": item_id, "reason": str(err_code)})
            continue

        tasks = extract_item_tasks(active_data, active_item, output_dir)
        if not tasks:
            skipped_items.append({
                "item_id": item_id,
                "reason": str(active_item.get("default_unavailable_reason") or "unsupported_delivery"),
            })
            continue

        for task in tasks:
            if not task["routes"]:
                # All routes already expired; refresh once before giving up.
                final_path = None
                saw_expired = True
                nbytes = 0
            else:
                final_path, nbytes, saw_expired = download_with_failover(
                    client, task, probe_routes
                )

            if saw_expired and nbytes == 0:
                # Single re-parse / re-resolve refresh on 403/410 CDN signature expiry.
                refreshed_env = (
                    client.resolve_item(resolve_url)
                    if isinstance(resolve_url, str) and resolve_url
                    else client.parse_url(share_input)
                )
                refreshed_data = refreshed_env["data"]
                refreshed_item = next(
                    (it for it in (refreshed_data.get("items") or []) if it.get("id") == task["item_id"]),
                    None,
                )
                if refreshed_item is None:
                    raise RuntimeError(f"Item {task['item_id']} missing after refresh")
                refreshed_tasks = [
                    t for t in extract_item_tasks(refreshed_data, refreshed_item, output_dir)
                    if t["role"] == task["role"]
                ]
                if not refreshed_tasks or not refreshed_tasks[0]["routes"]:
                    raise RuntimeError(f"No valid CDN routes after refresh for {task['item_id']}")
                final_path, nbytes, still_expired = download_with_failover(
                    client, refreshed_tasks[0], probe_routes
                )
                if still_expired or nbytes == 0 or final_path is None:
                    raise RuntimeError(f"CDN still returned 403/410 after single refresh for {task['item_id']}")

            if final_path is None:
                raise RuntimeError(f"Missing resolved output path for {task['item_id']}")

            saved_files.append({
                "item_id": task["item_id"],
                "role": task["role"],
                "file": final_path.name,
                "bytes": nbytes,
            })

    return {
        "input": share_input,
        "status": "ok" if saved_files else "skipped",
        "platform": platform,
        "content_id": data.get("content_id"),
        "files": saved_files,
        "skipped_items": skipped_items,
        "updated_at": utc_now().isoformat(),
    }


def load_completed_inputs(manifest_path: Path) -> set[str]:
    done: set[str] = set()
    if not manifest_path.is_file():
        return done
    with open(manifest_path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if rec.get("status") == "ok" and isinstance(rec.get("input"), str):
                done.add(rec["input"])
    return done


def read_input_lines(input_path: Path) -> list[str]:
    lines: list[str] = []
    seen: set[str] = set()
    with open(input_path, "r", encoding="utf-8") as handle:
        for raw in handle:
            entry = raw.strip()
            if not entry or entry.startswith("#") or entry in seen:
                continue
            seen.add(entry)
            lines.append(entry)
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--api-base",
        default=os.environ.get("DOKITOOL_API_BASE", "https://snap.dokitool.com"),
        help="DokiTool API origin (default: $DOKITOOL_API_BASE or https://snap.dokitool.com)",
    )
    parser.add_argument("--input", required=True, type=Path, help="Text file with one share URL/text per line")
    parser.add_argument("--output-dir", required=True, type=Path, help="Directory to save downloaded media files")
    parser.add_argument("--manifest", type=Path, help="JSONL checkpoint file (default: <output-dir>/manifest.jsonl)")
    parser.add_argument("--concurrency", type=int, default=4, help="Concurrent workers (1..8, default: 4)")
    parser.add_argument(
        "--probe-routes",
        action="store_true",
        help="Probe initial throughput across multiple CDN sources before downloading",
    )
    args = parser.parse_args(argv)

    if args.concurrency < 1 or args.concurrency > 8:
        print("error: --concurrency must be between 1 and 8", file=sys.stderr)
        return 2

    try:
        api_base = validate_api_base(args.api_base)
        raw_token = os.environ.get("DOKITOOL_API_TOKEN") or os.environ.get("DOKITOOL_OWNER_TOKEN", "")
        token = validate_owner_token(raw_token)
    except ValueError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    if not args.input.is_file():
        print(f"error: input file not found: {args.input}", file=sys.stderr)
        return 2

    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_path: Path = args.manifest if args.manifest else (output_dir / "manifest.jsonl")
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    completed = load_completed_inputs(manifest_path)
    all_inputs = read_input_lines(args.input)
    pending = [item for item in all_inputs if item not in completed]

    if not pending:
        print(json.dumps({"total": len(all_inputs), "skipped_completed": len(completed), "processed": 0}))
        return 0

    abort_event = threading.Event()
    manifest_lock = threading.Lock()
    client = AgentClient(api_base=api_base, token=token, abort_event=abort_event)

    counts = {"ok": 0, "skipped": 0, "failed": 0}
    fatal_message: str | None = None

    def write_manifest_record(record: dict) -> None:
        with manifest_lock:
            with open(manifest_path, "a", encoding="utf-8") as mf:
                mf.write(json.dumps(record, ensure_ascii=False) + "\n")

    def worker(share_line: str) -> None:
        nonlocal fatal_message
        if abort_event.is_set():
            return
        try:
            record = process_share_input(client, share_line, output_dir, args.probe_routes)
            write_manifest_record(record)
            with manifest_lock:
                counts[record["status"]] = counts.get(record["status"], 0) + 1
        except FatalAuthError as exc:
            with manifest_lock:
                if fatal_message is None:
                    fatal_message = str(exc)
        except PermanentAPIError as exc:
            write_manifest_record({
                "input": share_line,
                "status": "failed",
                "http_status": exc.status,
                "error_code": exc.code,
                "message": exc.api_message,
                "updated_at": utc_now().isoformat(),
            })
            with manifest_lock:
                counts["failed"] += 1
        except Exception as exc:
            write_manifest_record({
                "input": share_line,
                "status": "failed",
                "error_code": "DOWNLOAD_FAILED",
                "message": redact_sensitive(str(exc)),
                "updated_at": utc_now().isoformat(),
            })
            with manifest_lock:
                counts["failed"] += 1

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(worker, line) for line in pending]
        for fut in as_completed(futures):
            fut.result()

    if fatal_message is not None:
        print(f"fatal authentication error: {fatal_message}", file=sys.stderr)
        return 3

    summary = {
        "total_inputs": len(all_inputs),
        "resumed_completed": len(completed),
        "ok": counts["ok"],
        "skipped": counts["skipped"],
        "failed": counts["failed"],
        "manifest": str(manifest_path),
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0 if counts["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
