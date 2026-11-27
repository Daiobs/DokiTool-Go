#!/usr/bin/env python3
"""Read-only production smoke checker for DokiTool-Go deployments.

Zero third-party dependencies (Python 3 standard library only, macOS + Windows).
Sends anonymous GET requests exclusively to --base-url, never sends Cookie or
Authorization headers, never fetches media CDN URLs, enforces >= 8.0s pacing
between normal /api/parse calls, retries transient third-party failures after
>= 10.0s (up to 3 attempts total), and scrubs all URLs, query parameters,
tokens, tickets, signatures, and IP addresses from JSON and Markdown outputs.
"""
from __future__ import annotations

import argparse
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import copy
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import http.client
import ipaddress
import json
from pathlib import Path
import re
import secrets
import socket
import ssl
import sys
import threading
import time
from typing import Any, Callable, Iterable
import urllib.parse
import urllib.request

SCHEMA_VERSION = "1.0"
DEFAULT_BASE_URL = "https://snap.dokitool.com"
DEFAULT_SAMPLES_PATH = Path(__file__).resolve().parent / "samples.json"

DEFAULT_MIN_PARSE_INTERVAL = 8.0
DEFAULT_RETRY_INTERVAL = 10.0
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_TIMEOUT_SECONDS = 50.0
DEFAULT_FRONTEND_CONCURRENCY = 6
MAX_FRONTEND_CONCURRENCY = 8
DEFAULT_IPV6_PROBE_TIMEOUT = 1.5
DEFAULT_IDLE_CONNECTION_TTL = 55.0
DEFAULT_YOUTUBE_CONTEXT_WARN_MS = 2000
DEFAULT_YOUTUBE_CONTEXT_FAIL_MS = 15000
MAX_HTTP_RESPONSE_BYTES = 16 * 1024 * 1024

VALID_TIERS: tuple[str, ...] = ("tier-a", "tier-b", "all")

PARSE_GROUPS: tuple[str, ...] = (
    "cache",
    "x_fast_path",
    "douyin_domestic",
    "direct_markers",
    "all_platforms",
    "tier_b_platforms",
)

DEFAULT_GROUPS: tuple[str, ...] = (
    "frontend_hashes",
    "platforms",
    "youtube_context",
    "cache",
    "x_fast_path",
    "douyin_domestic",
    "direct_markers",
    "all_platforms",
    "api_boundary",
)
ALL_GROUPS: tuple[str, ...] = (
    "frontend_hashes",
    "platforms",
    "youtube_context",
    "cache",
    "x_fast_path",
    "douyin_domestic",
    "direct_markers",
    "all_platforms",
    "tier_b_platforms",
    "api_boundary",
    "rate_limit",
)

_PLACEHOLDER_TITLE_RE = re.compile(
    r"^(?:P\d+|第?\s*\d+\s*[集话期話]|序列\s*\d+|未知标题|unknown\s*title|untitled|null|none)$",
    re.IGNORECASE,
)
_STALE_ERROR_CODES = frozenset(
    {
        "CONTENT_UNAVAILABLE",
        "NOT_FOUND",
        "CONTENT_NOT_FOUND",
        "MEDIA_NOT_FOUND",
        "VIDEO_UNAVAILABLE",
    }
)
_NON_STALE_PARSER_ERROR_CODES = frozenset(
    {
        "UPSTREAM_BLOCKED",
        "UPSTREAM_TIMEOUT",
        "UPSTREAM_UNAVAILABLE",
        "UPSTREAM_INVALID_RESPONSE",
        "RATE_LIMITED",
        "INTERNAL_ERROR",
        "INVALID_INPUT",
        "UNSUPPORTED_URL",
        "SCHEMA_VERSION_MISMATCH",
    }
)
_STALE_MESSAGE_RE = re.compile(
    r"(?:下架|已删除|不存在|已失效|稿件不可见|作品不可见|内容不可用|私密|video\s+unavailable|not\s+found|deleted|removed|private\s+video|gone|expired)",
    re.IGNORECASE,
)

FORBIDDEN_REQUEST_HEADERS = frozenset({
    "authorization",
    "cookie",
    "proxy-authorization",
    "set-cookie",
    "x-dokitool-client-ip",
    "x-dokitool-edge-key",
    "x-dokitool-token",
})

_URL_RE = re.compile(r"(?i)\b(?:https?|wss?|file|ftp)://[^\s\"'<>`|]+")
_SENSITIVE_TOKEN_RE = re.compile(
    r"(?i)\b(?:xsec_token|xsec_source|owner_token|access_token|auth_key|hdnts)"
    r"(?:\s*[=:]\s*[^\s&\"'<>`,;|)]+)?"
)
_BEARER_TOKEN_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_UNIX_HOME_PATH_RE = re.compile(r"(?:/Users/|/home/|/private/var/folders/)[^\s\"'<>`|)]+")
_WIN_HOME_PATH_RE = re.compile(r"(?i)[A-Za-z]:(?:\\{1,2}|/)Users(?:\\{1,2}|/)[^\s\"'<>`|)]+")
_TICKET_KV_RE = re.compile(r"(?i)\bticket\s*[=:]\s*[^\s&\"'<>`,;|)]+")
_SIGNATURE_KV_RE = re.compile(
    r"(?i)\b(?:sign|signature|sig|token|key|expires)\s*[=:]\s*[^\s&\"'<>`,;|)]+"
)
_RELAY_PATH_RE = re.compile(r"(?i)/api/media/[^\s\"'<>`|]*")
_QUERY_STRING_RE = re.compile(r"\?[A-Za-z0-9_%\-=&.+~:/]+")
_IPV4_CANDIDATE_RE = re.compile(r"(?<![0-9A-Za-z.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9A-Za-z.])")
_IPV6_CANDIDATE_RE = re.compile(
    r"\[?(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])\]?"
)


class SmokeError(RuntimeError):
    """Configuration, safety boundary, or redaction error."""


class RedactionViolationError(SmokeError):
    """Raised if unredacted URLs, tokens, query parameters, or IPs remain in output."""


@dataclass
class Clock:
    """Injectable monotonic clock and sleeper so unit tests run instantly."""

    now_fn: Callable[[], float] = time.monotonic
    sleep_fn: Callable[[float], None] = time.sleep
    utc_now_fn: Callable[[], datetime] = lambda: datetime.now(timezone.utc)

    def now(self) -> float:
        return self.now_fn()

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            self.sleep_fn(seconds)

    def utc_iso(self) -> str:
        return self.utc_now_fn().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class RawHttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes
    elapsed_ms: int

    def json_object(self) -> dict[str, Any]:
        try:
            decoded = json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("invalid JSON response body") from exc
        if not isinstance(decoded, dict):
            raise ValueError("JSON root must be an object")
        return decoded


@dataclass
class CheckResult:
    id: str
    group: str
    status: str  # PASS | WARN | SAMPLE_STALE | FAIL | SKIP
    http_status: int | None = None
    code: str = "-"
    elapsed_ms: int = 0
    retry_count: int = 0
    media_hostnames: list[str] = field(default_factory=list)
    note: str = ""

    def to_sanitized_dict(self) -> dict[str, Any]:
        if self.status not in ("PASS", "WARN", "SAMPLE_STALE", "FAIL", "SKIP"):
            raise SmokeError(f"invalid check status: {self.status}")
        hosts = sorted({sanitize_hostname(h) for h in self.media_hostnames if h})
        return {
            "id": sanitize_text(self.id),
            "group": sanitize_text(self.group),
            "status": self.status,
            "http_status": self.http_status,
            "code": sanitize_text(self.code or "-"),
            "elapsed_ms": max(0, int(self.elapsed_ms)),
            "retry_count": max(0, int(self.retry_count)),
            "media_hostnames": hosts,
            "note": sanitize_text(self.note),
        }


@dataclass
class SharedParseEntry:
    response: RawHttpResponse
    payload: dict[str, Any]
    retry_count: int


_RETRIABLE_STALE_CONN_ERRORS: tuple[type[BaseException], ...] = (
    http.client.RemoteDisconnected,
    http.client.BadStatusLine,
    http.client.CannotSendRequest,
    http.client.ResponseNotReady,
    BrokenPipeError,
    ConnectionResetError,
    ConnectionAbortedError,
    ssl.SSLEOFError,
    ssl.SSLZeroReturnError,
)


def _is_loopback_host(host: str) -> bool:
    candidate = (host or "").strip().lower().rstrip(".")
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    if candidate == "localhost":
        return True
    try:
        return ipaddress.ip_address(candidate).is_loopback
    except ValueError:
        return False


def _resolve_proxy_for_origin(scheme: str, host: str) -> tuple[str, int] | None:
    """Resolve an HTTP CONNECT / forwarding proxy from environment or OS settings.

    Loopback targets always bypass proxies. Proxy URLs containing credentials are
    rejected so Proxy-Authorization is never transmitted.
    """
    if _is_loopback_host(host):
        return None
    try:
        if urllib.request.proxy_bypass(host):
            return None
    except Exception:  # noqa: BLE001
        pass
    proxies = urllib.request.getproxies()
    raw_proxy = proxies.get(scheme)
    if not raw_proxy:
        return None
    candidate = raw_proxy.strip()
    if not candidate:
        return None
    if "://" not in candidate:
        candidate = f"http://{candidate}"
    parsed = urllib.parse.urlsplit(candidate)
    if parsed.username is not None or parsed.password is not None:
        raise SmokeError("proxy credentials are forbidden")
    if parsed.scheme != "http" or not parsed.hostname:
        return None
    return parsed.hostname, int(parsed.port or 80)


def _interleave_addrinfos_by_family(infos: list[Any]) -> list[Any]:
    """Interleave getaddrinfo tuples round-robin by address family (RFC 8305 order)."""
    buckets: dict[int, deque[Any]] = {}
    order: list[int] = []
    for info in infos:
        af = int(info[0])
        if af not in buckets:
            buckets[af] = deque()
            order.append(af)
        buckets[af].append(info)
    interleaved: list[Any] = []
    while order:
        next_order: list[int] = []
        for af in order:
            bucket = buckets[af]
            if bucket:
                interleaved.append(bucket.popleft())
            if bucket:
                next_order.append(af)
        order = next_order
    return interleaved


class _DualStackDialer:
    """Dual-stack TCP dialer with fast IPv6 fallback and per-host address-family caching."""

    def __init__(
        self,
        *,
        ipv6_probe_timeout: float = DEFAULT_IPV6_PROBE_TIMEOUT,
        getaddrinfo_fn: Callable[..., list[Any]] = socket.getaddrinfo,
        socket_factory: Callable[[int, int, int], Any] = socket.socket,
    ) -> None:
        self._ipv6_probe_timeout = max(0.05, float(ipv6_probe_timeout))
        self._getaddrinfo = getaddrinfo_fn
        self._socket_factory = socket_factory
        self._lock = threading.Lock()
        self._probe_locks: dict[tuple[str, int], threading.Lock] = {}
        self._preferred_families: dict[tuple[str, int], int] = {}
        self._fallback_keys: set[tuple[str, int]] = set()

    def preferred_family(self, host: str, port: int) -> int | None:
        key = (host.lower(), int(port))
        with self._lock:
            return self._preferred_families.get(key)

    def fallback_detected(self, host: str, port: int) -> bool:
        key = (host.lower(), int(port))
        with self._lock:
            return key in self._fallback_keys

    def _get_probe_lock(self, key: tuple[str, int]) -> threading.Lock:
        with self._lock:
            lock = self._probe_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._probe_locks[key] = lock
            return lock

    def _clear_preferred_family(self, key: tuple[str, int], expected: int) -> None:
        with self._lock:
            if self._preferred_families.get(key) == expected:
                del self._preferred_families[key]

    def _record_preferred_family(
        self,
        key: tuple[str, int],
        family: int,
        *,
        fell_back: bool,
    ) -> None:
        with self._lock:
            self._preferred_families[key] = family
            if fell_back:
                self._fallback_keys.add(key)

    def _dial_single_family(
        self,
        host: str,
        port: int,
        family: int,
        timeout: float | None,
        source_address: tuple[str, int] | None,
    ) -> Any:
        infos = self._getaddrinfo(host, port, family, socket.SOCK_STREAM)
        if not infos:
            raise OSError("getaddrinfo returns an empty list")
        last_err: OSError | None = None
        for af, socktype, proto, _canonname, sa in infos:
            sock = None
            try:
                sock = self._socket_factory(af, socktype, proto)
                if timeout is not None:
                    sock.settimeout(timeout)
                if source_address:
                    sock.bind(source_address)
                sock.connect(sa)
                return sock
            except OSError as exc:
                last_err = exc
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
        assert last_err is not None
        raise last_err

    def create_connection(
        self,
        address: tuple[str, int],
        timeout: float | None = DEFAULT_TIMEOUT_SECONDS,
        source_address: tuple[str, int] | None = None,
    ) -> Any:
        host, port = address
        key = (host.lower(), int(port))

        cached = self.preferred_family(host, port)
        if cached is not None:
            try:
                return self._dial_single_family(host, port, cached, timeout, source_address)
            except OSError:
                self._clear_preferred_family(key, cached)

        # Single-flight initial dual-stack discovery so concurrent cold-start workers
        # never trigger duplicate IPv6 fallback timeouts simultaneously.
        probe_lock = self._get_probe_lock(key)
        with probe_lock:
            cached = self.preferred_family(host, port)
            if cached is None:
                raw_infos = self._getaddrinfo(host, port, 0, socket.SOCK_STREAM)
                if not raw_infos:
                    raise OSError("getaddrinfo returns an empty list")
                ordered = _interleave_addrinfos_by_family(raw_infos)
                distinct_families = {int(info[0]) for info in ordered}
                failed_families: set[int] = set()
                last_err: OSError | None = None
                for idx, (af, socktype, proto, _canonname, sa) in enumerate(ordered):
                    has_alt_family_ahead = any(
                        int(other[0]) != int(af) for other in ordered[idx + 1 :]
                    )
                    if (
                        len(distinct_families) > 1
                        and has_alt_family_ahead
                        and int(af) == int(socket.AF_INET6)
                    ):
                        attempt_timeout = (
                            min(timeout, self._ipv6_probe_timeout)
                            if timeout is not None
                            else self._ipv6_probe_timeout
                        )
                    else:
                        attempt_timeout = timeout

                    sock = None
                    try:
                        sock = self._socket_factory(af, socktype, proto)
                        if attempt_timeout is not None:
                            sock.settimeout(attempt_timeout)
                        if source_address:
                            sock.bind(source_address)
                        sock.connect(sa)
                        if timeout is not None and attempt_timeout != timeout:
                            sock.settimeout(timeout)
                        fell_back = bool(failed_families - {int(af)})
                        self._record_preferred_family(key, int(af), fell_back=fell_back)
                        return sock
                    except OSError as exc:
                        last_err = exc
                        failed_families.add(int(af))
                        if sock is not None:
                            try:
                                sock.close()
                            except OSError:
                                pass
                assert last_err is not None
                raise last_err

        # Another thread cached the working family while we waited; dial concurrently.
        return self._dial_single_family(host, port, cached, timeout, source_address)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTP/1.1 Keep-Alive connection backed by _DualStackDialer."""

    def __init__(
        self,
        host: str,
        port: int | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        dialer: _DualStackDialer,
    ) -> None:
        super().__init__(host, port=port, timeout=timeout)
        self._dialer = dialer

    def connect(self) -> None:
        self.sock = self._dialer.create_connection(
            (self.host, self.port),
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            try:
                self._tunnel()
            except Exception:
                self.close()
                raise


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS/1.1 Keep-Alive connection backed by _DualStackDialer and verified TLS."""

    def __init__(
        self,
        host: str,
        port: int | None = None,
        *,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        context: ssl.SSLContext,
        dialer: _DualStackDialer,
    ) -> None:
        super().__init__(host, port=port, timeout=timeout, context=context)
        self._dialer = dialer

    def connect(self) -> None:
        raw_sock = self._dialer.create_connection(
            (self.host, self.port),
            self.timeout,
            self.source_address,
        )
        self.sock = raw_sock
        try:
            if self._tunnel_host:
                server_hostname = self._tunnel_host
                self._tunnel()
            else:
                server_hostname = self.host
            self.sock = self._context.wrap_socket(
                self.sock,
                server_hostname=server_hostname,
            )
        except Exception:
            self.close()
            raise


def _is_ip_literal(value: str) -> bool:
    candidate = value.strip()
    if candidate.startswith("[") and candidate.endswith("]"):
        candidate = candidate[1:-1]
    if "%" in candidate:
        candidate = candidate.split("%", 1)[0]
    if not candidate:
        return False
    try:
        ipaddress.ip_address(candidate)
        return True
    except ValueError:
        return False


def sanitize_hostname(raw_host: str) -> str:
    """Return a clean lowercase DNS hostname, or <ip-redacted> for IP literals."""
    host = (raw_host or "").strip().lower().rstrip(".")
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    if not host:
        return ""
    if _is_ip_literal(host):
        return "<ip-redacted>"
    # Never allow paths, queries, credentials, or ports inside a hostname field.
    for sep in ("/", "?", "#", "@", ":"):
        if sep in host:
            host = host.split(sep, 1)[0]
    if not host or _is_ip_literal(host):
        return "<ip-redacted>"
    return sanitize_text(host)


def _replace_ipv6_candidates(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        token = match.group(0)
        inner = token[1:-1] if token.startswith("[") and token.endswith("]") else token
        if _is_ip_literal(inner):
            return "<ip-redacted>"
        return token

    return _IPV6_CANDIDATE_RE.sub(repl, text)


def _replace_ipv4_candidates(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        token = match.group(0)
        if _is_ip_literal(token):
            return "<ip-redacted>"
        return token

    return _IPV4_CANDIDATE_RE.sub(repl, text)


def sanitize_text(value: str) -> str:
    """Scrub URLs, query parameters, tokens, Bearer headers, tickets, signatures, local paths, and IPs."""
    if not value:
        return ""
    out = str(value)
    out = _URL_RE.sub("<url-redacted>", out)
    out = _RELAY_PATH_RE.sub("/api/media/<relay-redacted>", out)
    out = _BEARER_TOKEN_RE.sub("<auth-redacted>", out)
    out = re.sub(r"(?i)\bBearer\b", "<auth-redacted>", out)
    out = _SENSITIVE_TOKEN_RE.sub("<token-redacted>", out)
    out = _TICKET_KV_RE.sub("<ticket-redacted>", out)
    out = _SIGNATURE_KV_RE.sub("<sig-redacted>", out)
    out = _QUERY_STRING_RE.sub("?<query-redacted>", out)
    out = _UNIX_HOME_PATH_RE.sub("<path-redacted>", out)
    out = _WIN_HOME_PATH_RE.sub("<path-redacted>", out)
    home_str = str(Path.home())
    if len(home_str) >= 4 and home_str in out:
        out = out.replace(home_str, "<home-redacted>")
    out = _replace_ipv4_candidates(out)
    out = _replace_ipv6_candidates(out)
    out = " ".join(out.splitlines()).strip()
    return out


def verify_redacted_output(rendered: str) -> None:
    """Fail closed if any URL, Bearer, token, ticket, query parameter, home path, or IP survived."""
    if _URL_RE.search(rendered):
        raise RedactionViolationError("unredacted URL detected in output")
    if re.search(r"(?i)\bBearer\b", rendered):
        raise RedactionViolationError("unredacted Bearer authorization marker detected in output")
    if re.search(r"(?i)\b(?:xsec_token|xsec_source|owner_token|access_token)\b", rendered):
        raise RedactionViolationError("unredacted token identifier detected in output")
    if re.search(r"(?i)\bticket\s*=", rendered):
        raise RedactionViolationError("unredacted relay ticket detected in output")
    if re.search(r"(?i)\b(?:sign|signature|sig|hdnts|auth_key)\s*=", rendered):
        raise RedactionViolationError("unredacted signature parameter detected in output")
    for qmatch in _QUERY_STRING_RE.finditer(rendered):
        if qmatch.group(0) != "?<query-redacted>":
            raise RedactionViolationError("unredacted query string detected in output")
    if _UNIX_HOME_PATH_RE.search(rendered) or _WIN_HOME_PATH_RE.search(rendered):
        raise RedactionViolationError("unredacted local home directory path detected in output")
    home_str = str(Path.home())
    if len(home_str) >= 4:
        json_escaped_home = json.dumps(home_str)[1:-1]
        if home_str in rendered or (json_escaped_home and json_escaped_home in rendered):
            raise RedactionViolationError("unredacted home directory path detected in output")
    for match in _IPV4_CANDIDATE_RE.finditer(rendered):
        if _is_ip_literal(match.group(0)):
            raise RedactionViolationError("unredacted IPv4 address detected in output")
    for match in _IPV6_CANDIDATE_RE.finditer(rendered):
        token = match.group(0)
        inner = token[1:-1] if token.startswith("[") and token.endswith("]") else token
        if _is_ip_literal(inner):
            raise RedactionViolationError("unredacted IPv6 address detected in output")


def parse_base_url(raw_base_url: str) -> tuple[str, str, str]:
    """Validate --base-url and return (normalized_origin, scheme, netloc)."""
    raw = (raw_base_url or "").strip()
    parsed = urllib.parse.urlsplit(raw)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or not parsed.hostname:
        raise SmokeError("invalid --base-url: expected https://<host>[:port] or http://<loopback>[:port]")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc:
        raise SmokeError("invalid --base-url: credentials in URL are forbidden")
    if parsed.query or parsed.fragment:
        raise SmokeError("invalid --base-url: query and fragment are forbidden")
    if parsed.path not in ("", "/"):
        raise SmokeError("invalid --base-url: base path must be root '/'")
    if parsed.scheme == "http" and not _is_loopback_host(parsed.hostname):
        raise SmokeError("invalid --base-url: use https:// for remote origins (http:// allowed only for loopback)")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    return origin, parsed.scheme, parsed.netloc


class OriginLockedClient:
    """Read-only, cookie-free, credential-free HTTP GET client locked to one origin.

    Maintains a thread-safe pool of persistent HTTP/1.1 Keep-Alive connections
    backed by _DualStackDialer (with fast IPv6 fallback and per-host address
    family caching), never follows HTTP redirects, and never stores cookies or
    credentials.
    """

    def __init__(
        self,
        base_url: str,
        *,
        clock: Clock | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        min_parse_interval: float = DEFAULT_MIN_PARSE_INTERVAL,
        pool_maxsize: int = DEFAULT_FRONTEND_CONCURRENCY,
        ipv6_probe_timeout: float = DEFAULT_IPV6_PROBE_TIMEOUT,
        idle_connection_ttl: float = DEFAULT_IDLE_CONNECTION_TTL,
        dialer: _DualStackDialer | None = None,
        ssl_context: ssl.SSLContext | None = None,
        use_env_proxies: bool = True,
    ) -> None:
        self.origin, self.scheme, self.netloc = parse_base_url(base_url)
        parsed = urllib.parse.urlsplit(self.origin)
        self.host = parsed.hostname or ""
        self.port = int(parsed.port or (443 if self.scheme == "https" else 80))
        self.target_host = sanitize_hostname(self.host)
        self.clock = clock or Clock()
        self.timeout_seconds = timeout_seconds
        self.min_parse_interval = min_parse_interval
        self.last_parse_ts: float | None = None
        self.last_pool_ts: dict[str, float] = {}

        self._pool_maxsize = max(1, int(pool_maxsize))
        self._idle_ttl = max(1.0, float(idle_connection_ttl))
        self._dialer = dialer or _DualStackDialer(ipv6_probe_timeout=ipv6_probe_timeout)
        self._ssl_context = (
            ssl_context
            if ssl_context is not None
            else (ssl.create_default_context() if self.scheme == "https" else None)
        )
        self._proxy: tuple[str, int] | None = (
            _resolve_proxy_for_origin(self.scheme, self.host) if use_env_proxies else None
        )
        self._pool_lock = threading.Lock()
        self._idle_conns: deque[tuple[http.client.HTTPConnection, float]] = deque()
        self._closed = False

    def __enter__(self) -> "OriginLockedClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        self.close()

    def close(self) -> None:
        with self._pool_lock:
            self._closed = True
            pending = list(self._idle_conns)
            self._idle_conns.clear()
        for conn, _idle_since in pending:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    def _new_connection(self) -> http.client.HTTPConnection:
        if self.scheme == "https":
            assert self._ssl_context is not None
            if self._proxy is not None:
                proxy_host, proxy_port = self._proxy
                conn = _PinnedHTTPSConnection(
                    proxy_host,
                    port=proxy_port,
                    timeout=self.timeout_seconds,
                    context=self._ssl_context,
                    dialer=self._dialer,
                )
                conn.set_tunnel(self.host, self.port)
                return conn
            return _PinnedHTTPSConnection(
                self.host,
                port=self.port,
                timeout=self.timeout_seconds,
                context=self._ssl_context,
                dialer=self._dialer,
            )

        if self._proxy is not None:
            proxy_host, proxy_port = self._proxy
            return _PinnedHTTPConnection(
                proxy_host,
                port=proxy_port,
                timeout=self.timeout_seconds,
                dialer=self._dialer,
            )
        return _PinnedHTTPConnection(
            self.host,
            port=self.port,
            timeout=self.timeout_seconds,
            dialer=self._dialer,
        )

    def _checkout_connection(self) -> tuple[http.client.HTTPConnection, bool]:
        now_wall = time.monotonic()
        stale: list[http.client.HTTPConnection] = []
        chosen: http.client.HTTPConnection | None = None
        with self._pool_lock:
            while self._idle_conns:
                conn, idle_since = self._idle_conns.pop()
                if conn.sock is None or (now_wall - idle_since) > self._idle_ttl:
                    stale.append(conn)
                    continue
                chosen = conn
                break
        for conn in stale:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        if chosen is not None:
            return chosen, True
        return self._new_connection(), False

    def _release_connection(
        self,
        conn: http.client.HTTPConnection,
        *,
        reusable: bool,
    ) -> None:
        if not reusable or conn.sock is None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            return
        now_wall = time.monotonic()
        evicted: http.client.HTTPConnection | None = None
        with self._pool_lock:
            if self._closed:
                evicted = conn
            elif len(self._idle_conns) >= self._pool_maxsize:
                evicted = conn
            else:
                self._idle_conns.append((conn, now_wall))
        if evicted is not None:
            try:
                evicted.close()
            except Exception:  # noqa: BLE001
                pass

    def get_raw(self, path_and_query: str, *, accept: str = "application/json") -> RawHttpResponse:
        if not path_and_query.startswith("/"):
            raise SmokeError("request path must start with '/'")
        if path_and_query.startswith("//"):
            raise SmokeError("protocol-relative paths are forbidden")
        if "\r" in path_and_query or "\n" in path_and_query:
            raise SmokeError("control characters in request path are forbidden")
        path_only = path_and_query.split("?", 1)[0]
        if path_only.startswith("/api/media"):
            raise SmokeError("fetching media relay endpoints is forbidden")

        full_url = self.origin + path_and_query
        parsed = urllib.parse.urlsplit(full_url)
        if (parsed.scheme, parsed.netloc) != (self.scheme, self.netloc):
            raise SmokeError("cross-origin request blocked by origin lock")
        if parsed.username is not None or parsed.password is not None:
            raise SmokeError("URL credentials blocked by origin lock")

        headers: dict[str, str] = {
            "Accept": accept,
            "Accept-Encoding": "identity",
            "User-Agent": "DokiTool-ProdSmoke/1.0",
            "Connection": "keep-alive",
        }
        if self.scheme == "http" and self._proxy is not None:
            request_target = full_url
            headers["Host"] = self.netloc
        else:
            request_target = path_and_query

        for header_name in headers:
            if header_name.lower() in FORBIDDEN_REQUEST_HEADERS or "token" in header_name.lower():
                raise SmokeError(f"forbidden credential header blocked: {header_name}")

        t0 = self.clock.now()
        conn, reused = self._checkout_connection()
        for attempt in range(2):
            try:
                conn.request("GET", request_target, headers=headers)
                resp = conn.getresponse()
                body = resp.read(MAX_HTTP_RESPONSE_BYTES + 1)
                if len(body) > MAX_HTTP_RESPONSE_BYTES:
                    raise SmokeError(
                        f"response body exceeded {MAX_HTTP_RESPONSE_BYTES} byte inspection limit"
                    )
                status = int(resp.status)
                resp_headers: dict[str, str] = {}
                for raw_k, raw_v in resp.getheaders():
                    lk = raw_k.lower()
                    if lk in resp_headers:
                        resp_headers[lk] = f"{resp_headers[lk]}, {raw_v}"
                    else:
                        resp_headers[lk] = raw_v
                conn_hdr = resp_headers.get("connection", "").lower()
                reusable = (
                    not resp.will_close
                    and "close" not in conn_hdr
                    and conn.sock is not None
                )
                self._release_connection(conn, reusable=reusable)
                elapsed_ms = max(0, int(round((self.clock.now() - t0) * 1000.0)))
                return RawHttpResponse(
                    status=status,
                    headers=resp_headers,
                    body=body,
                    elapsed_ms=elapsed_ms,
                )
            except _RETRIABLE_STALE_CONN_ERRORS:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
                if reused and attempt == 0:
                    conn = self._new_connection()
                    reused = False
                    continue
                raise
            except Exception:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
                raise
        raise SmokeError("unreachable HTTP request state")

    def get_parse(
        self,
        sample_url: str,
        *,
        paced: bool = True,
        pool: str = "parse",
    ) -> RawHttpResponse:
        if paced and self.last_parse_ts is not None:
            since_last = self.clock.now() - self.last_parse_ts
            if since_last < self.min_parse_interval:
                self.clock.sleep(self.min_parse_interval - since_last)

        query = urllib.parse.urlencode(
            [("schema_version", SCHEMA_VERSION), ("url", sample_url)]
        )
        try:
            return self.get_raw(f"/api/parse?{query}", accept="application/json")
        finally:
            finished = self.clock.now()
            self.last_parse_ts = finished
            if pool:
                self.last_pool_ts[pool] = finished

    def wait_for_pool_refill(self, pool: str, idle_refill_seconds: float) -> None:
        if idle_refill_seconds <= 0 or pool not in self.last_pool_ts:
            return
        elapsed = self.clock.now() - self.last_pool_ts[pool]
        if elapsed < idle_refill_seconds:
            self.clock.sleep(idle_refill_seconds - elapsed)


def iter_delivery_sources(delivery: Any) -> Iterable[dict[str, Any]]:
    """Yield every source dict inside a unified-v1 delivery tree."""
    if not isinstance(delivery, dict):
        return
    kind = delivery.get("kind")
    if kind in ("file", "hls", "dash"):
        sources = delivery.get("sources")
        if isinstance(sources, list):
            for src in sources:
                if isinstance(src, dict):
                    yield src
    elif kind == "segments":
        init_chunk = delivery.get("init")
        if isinstance(init_chunk, dict) and isinstance(init_chunk.get("sources"), list):
            for src in init_chunk["sources"]:
                if isinstance(src, dict):
                    yield src
        pieces = delivery.get("pieces")
        if isinstance(pieces, list):
            for piece in pieces:
                if isinstance(piece, dict) and isinstance(piece.get("sources"), list):
                    for src in piece["sources"]:
                        if isinstance(src, dict):
                            yield src
    elif kind in ("mux", "pair"):
        resources = delivery.get("resources")
        if isinstance(resources, list):
            for resource in resources:
                if isinstance(resource, dict):
                    yield from iter_delivery_sources(resource.get("delivery"))


def iter_item_media_urls(item: dict[str, Any]) -> Iterable[tuple[str, dict[str, Any], str]]:
    """Yield (url, source_meta_dict, location_kind) across variants, default, and cover."""
    variants = item.get("variants")
    if isinstance(variants, list):
        for variant in variants:
            if not isinstance(variant, dict) or variant.get("state") == "deferred":
                continue
            for src in iter_delivery_sources(variant.get("delivery")):
                raw_url = src.get("url")
                if isinstance(raw_url, str) and raw_url:
                    yield raw_url, src, "variant"
                fallbacks = src.get("fallback_urls")
                if isinstance(fallbacks, list):
                    for alt in fallbacks:
                        if isinstance(alt, str) and alt:
                            yield alt, src, "fallback"
    default_proj = item.get("default")
    if isinstance(default_proj, dict):
        raw_url = default_proj.get("url")
        if isinstance(raw_url, str) and raw_url:
            yield raw_url, default_proj, "default"
    cover = item.get("cover")
    if isinstance(cover, dict):
        raw_url = cover.get("url")
        if isinstance(raw_url, str) and raw_url:
            yield raw_url, cover, "cover"


def extract_media_hostnames(payload: dict[str, Any], target_host: str) -> list[str]:
    """Extract sorted deduplicated media hostnames ONLY (never URLs, paths, or tickets)."""
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    items = data.get("items")
    if not isinstance(items, list):
        return []
    hosts: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        for raw_url, _meta, _loc in iter_item_media_urls(item):
            if raw_url.startswith("/api/"):
                if target_host:
                    hosts.add(sanitize_hostname(target_host))
                continue
            parsed = urllib.parse.urlsplit(raw_url)
            if parsed.hostname:
                hosts.add(sanitize_hostname(parsed.hostname))
    hosts.discard("")
    return sorted(hosts)


def validate_parse_envelope(
    resp: RawHttpResponse,
    expected_platform: str | None = None,
    *,
    target_host: str = "",
) -> tuple[dict[str, Any], list[str]]:
    """Validate a 200 OK unified-v1 parse response and return (payload, media_hostnames)."""
    if resp.status != 200:
        code = "-"
        err_msg = ""
        try:
            err_obj = resp.json_object()
            code = str(err_obj.get("code") or "-")
            err_block = err_obj.get("error")
            if isinstance(err_block, dict) and isinstance(err_block.get("message"), str):
                err_msg = sanitize_text(err_block["message"])[:160]
        except ValueError:
            pass
        suffix = f": {err_msg}" if err_msg else ""
        raise AssertionError(
            f"expected HTTP 200, got HTTP {resp.status} (code={sanitize_text(code)}){suffix}"
        )
    payload = resp.json_object()
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise AssertionError(f"unexpected schema_version={payload.get('schema_version')!r}")
    code = str(payload.get("code") or "")
    if code != "OK":
        raise AssertionError(f"expected code='OK', got code={code!r}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise AssertionError("missing data object")
    actual_platform = str(data.get("platform") or "")
    if expected_platform and actual_platform != expected_platform:
        raise AssertionError(
            f"expected platform={expected_platform!r}, got {actual_platform!r}"
        )
    generated_at = data.get("generated_at")
    if not isinstance(generated_at, str) or not generated_at.strip():
        raise AssertionError("missing data.generated_at")
    title = str(data.get("title") or "").strip()
    if not title:
        raise AssertionError("quality assertion failed: data.title is missing or empty")
    if _PLACEHOLDER_TITLE_RE.fullmatch(title):
        raise AssertionError(
            f"quality assertion failed: data.title is placeholder {sanitize_text(title)!r}"
        )
    items = data.get("items")
    if not isinstance(items, list) or len(items) < 1:
        raise AssertionError("data.items is empty")
    ready_variant_sources = 0
    for item in items:
        if not isinstance(item, dict):
            raise AssertionError("item must be an object")
        if not isinstance(item.get("id"), str) or not item["id"]:
            raise AssertionError("item missing non-empty id")
        if item.get("type") not in ("video", "image", "live_photo", "audio"):
            raise AssertionError(f"invalid item.type={item.get('type')!r}")
        item_state = item.get("state", "ready")
        if item_state not in ("ready", "deferred", "unavailable"):
            raise AssertionError(f"invalid item.state={item_state!r}")
        if item_state == "deferred":
            resolve_url = item.get("resolve_url")
            if not isinstance(resolve_url, str) or not resolve_url.startswith("/api/"):
                raise AssertionError("deferred item missing valid /api/ resolve_url")
            continue
        if item_state == "unavailable":
            if not isinstance(item.get("error"), dict):
                raise AssertionError("unavailable item missing error object")
            continue
        variants = item.get("variants")
        if not isinstance(variants, list) or len(variants) < 1:
            raise AssertionError("ready item.variants is empty")
        for variant in variants:
            if isinstance(variant, dict) and variant.get("state") != "deferred":
                for src in iter_delivery_sources(variant.get("delivery")):
                    if isinstance(src.get("url"), str) and src["url"]:
                        ready_variant_sources += 1
    if ready_variant_sources < 1:
        raise AssertionError("no ready variant media sources found")
    hosts = extract_media_hostnames(payload, target_host)
    if not hosts:
        raise AssertionError("no media hostnames extracted from items")
    return payload, hosts


def load_samples(samples_path: Path, overrides: Iterable[str] = ()) -> dict[str, Any]:
    """Load samples.json and apply any --set-sample <key>=<url> overrides."""
    try:
        raw = json.loads(samples_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise SmokeError(f"cannot read samples file {samples_path.name}: {exc.strerror}") from exc
    except json.JSONDecodeError as exc:
        raise SmokeError(f"invalid JSON in samples file {samples_path.name}: line {exc.lineno}") from exc

    if not isinstance(raw, dict) or not isinstance(raw.get("platforms"), dict):
        raise SmokeError("samples file must define a 'platforms' object")
    config = copy.deepcopy(raw)

    for entry in overrides:
        if "=" not in entry:
            raise SmokeError("invalid --set-sample: expected <key>=<url>")
        key, url = entry.split("=", 1)
        key = key.strip()
        url = url.strip()
        if not key or not url:
            raise SmokeError("invalid --set-sample: key and url must be non-empty")
        parsed_url = urllib.parse.urlsplit(url)
        if parsed_url.scheme not in ("http", "https") or not parsed_url.netloc:
            raise SmokeError(f"invalid sample URL for key '{sanitize_text(key)}'")

        platforms = config["platforms"]
        tier_b_platforms = config.setdefault("tier_b_platforms", {})
        if key in platforms and isinstance(platforms[key], dict):
            platforms[key]["url"] = url
        elif key in tier_b_platforms and isinstance(tier_b_platforms[key], dict):
            tier_b_platforms[key]["url"] = url
        elif key.startswith("tier_b."):
            tb_key = key.split(".", 1)[1].strip()
            if not tb_key:
                raise SmokeError("invalid --set-sample: empty tier_b key")
            existing = tier_b_platforms.get(tb_key)
            pool = str(existing.get("pool") if isinstance(existing, dict) else "slow_parse")
            tier_b_platforms[tb_key] = {"url": url, "pool": pool, "tier": "tier_b"}
        elif key == "cache":
            base_key = str(config.get("cache_sample_key") or "kuaishou")
            base_pool = str(platforms.get(base_key, {}).get("pool") or "parse")
            platforms["__override_cache__"] = {"url": url, "pool": base_pool}
            config["cache_sample_key"] = "__override_cache__"
        elif key == "x_fast_path":
            platforms["__override_x_fast_path__"] = {"url": url, "pool": "slow_parse"}
            config["x_fast_path_key"] = "__override_x_fast_path__"
        elif key == "douyin_domestic":
            platforms["__override_douyin_domestic__"] = {"url": url, "pool": "parse"}
            config["douyin_domestic_key"] = "__override_douyin_domestic__"
        elif key.startswith("direct_markers."):
            plat = key.split(".", 1)[1]
            dm = config.setdefault("direct_marker_platforms", {})
            if plat not in dm or not isinstance(dm[plat], dict):
                raise SmokeError(f"unknown direct_markers platform: {sanitize_text(plat)}")
            override_key = f"__override_dm_{plat}__"
            base_pool = str(platforms.get(plat, {}).get("pool") or "parse")
            platforms[override_key] = {"url": url, "pool": base_pool}
            dm[plat]["sample_key"] = override_key
        else:
            raise SmokeError(f"unknown sample key in --set-sample: {sanitize_text(key)}")

    return config


def parse_group_list(raw_values: Iterable[str] | None) -> list[str]:
    if not raw_values:
        return []
    result: list[str] = []
    for item in raw_values:
        for token in item.split(","):
            name = token.strip()
            if not name:
                continue
            if name not in ALL_GROUPS:
                raise SmokeError(
                    f"unknown check group '{sanitize_text(name)}'; valid groups: {', '.join(ALL_GROUPS)}"
                )
            if name not in result:
                result.append(name)
    return result


def classify_sample_stale(resp: RawHttpResponse | None) -> tuple[bool, str, str]:
    """Distinguish upstream sample takedown/expiry (SAMPLE_STALE) from parser failure."""
    if resp is None or resp.status == 200:
        return False, "-", ""
    code = "-"
    message = ""
    try:
        obj = resp.json_object()
        if isinstance(obj.get("code"), str) and obj["code"]:
            code = obj["code"]
        err_block = obj.get("error")
        if isinstance(err_block, dict):
            if code == "-" and isinstance(err_block.get("code"), str):
                code = err_block["code"]
            if isinstance(err_block.get("message"), str):
                message = err_block["message"]
    except ValueError:
        pass

    if code in _NON_STALE_PARSER_ERROR_CODES:
        return False, code, ""
    if code in _STALE_ERROR_CODES:
        return True, code, sanitize_text(message)[:160]
    if resp.status in (404, 410) and _STALE_MESSAGE_RE.search(message):
        return True, code if code != "-" else f"HTTP_{resp.status}", sanitize_text(message)[:160]
    return False, code, ""


class SmokeRunner:
    """Executes selected smoke check groups with pacing, retry, and redaction."""

    def __init__(
        self,
        client: OriginLockedClient,
        samples: dict[str, Any],
        *,
        manifest_path: Path | None = None,
        only_groups: Iterable[str] = (),
        skip_groups: Iterable[str] = (),
        enable_rate_limit: bool = False,
        tier: str = "tier-a",
        tier_b_limit: int | None = None,
        youtube_context_warn_ms: int | None = None,
        youtube_context_fail_ms: int | None = None,
        strict_stale: bool = False,
        retry_interval: float = DEFAULT_RETRY_INTERVAL,
        max_attempts: int = DEFAULT_MAX_ATTEMPTS,
        frontend_concurrency: int = DEFAULT_FRONTEND_CONCURRENCY,
    ) -> None:
        self.client = client
        self.samples = samples
        self.manifest_path = manifest_path
        self.only_groups = parse_group_list(only_groups)
        self.skip_groups = set(parse_group_list(skip_groups))
        self.enable_rate_limit = enable_rate_limit
        if tier not in VALID_TIERS:
            raise SmokeError(f"invalid --tier {sanitize_text(tier)!r}; valid: {', '.join(VALID_TIERS)}")
        self.tier = tier
        if tier_b_limit is not None and int(tier_b_limit) < 1:
            raise SmokeError("invalid --tier-b-limit: must be >= 1")
        self.tier_b_limit = int(tier_b_limit) if tier_b_limit is not None else None
        yt_cfg = samples.get("youtube_context") if isinstance(samples.get("youtube_context"), dict) else {}
        warn_ms = (
            int(youtube_context_warn_ms)
            if youtube_context_warn_ms is not None
            else int(yt_cfg.get("warn_latency_ms", DEFAULT_YOUTUBE_CONTEXT_WARN_MS))
        )
        if warn_ms < 1:
            raise SmokeError("invalid --youtube-context-warn-ms: must be >= 1")
        if youtube_context_fail_ms is not None:
            fail_ms = int(youtube_context_fail_ms)
            if fail_ms < 1:
                raise SmokeError("invalid --youtube-context-fail-ms: must be >= 1")
            if fail_ms < warn_ms:
                raise SmokeError(
                    f"invalid --youtube-context-fail-ms ({fail_ms}): "
                    f"must be >= --youtube-context-warn-ms ({warn_ms})"
                )
        else:
            cfg_fail_ms = int(yt_cfg.get("fail_latency_ms", DEFAULT_YOUTUBE_CONTEXT_FAIL_MS))
            fail_ms = max(warn_ms, cfg_fail_ms)
        self.youtube_context_warn_ms = warn_ms
        self.youtube_context_fail_ms = fail_ms
        self.strict_stale = bool(strict_stale)
        self.retry_interval = retry_interval
        self.max_attempts = max(1, int(max_attempts))
        concurrency = int(frontend_concurrency)
        if concurrency < 1 or concurrency > MAX_FRONTEND_CONCURRENCY:
            raise SmokeError(
                f"invalid --frontend-concurrency {concurrency}: expected 1..{MAX_FRONTEND_CONCURRENCY}"
            )
        self.frontend_concurrency = concurrency
        self.shared_parses: dict[str, SharedParseEntry] = {}

    def _sample_entry(self, sample_key: str, *, tier_b: bool = False) -> tuple[str, str]:
        bucket = "tier_b_platforms" if tier_b else "platforms"
        platforms = self.samples.get(bucket, {})
        entry = platforms.get(sample_key)
        if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
            raise SmokeError(f"missing sample configuration for '{sanitize_text(sample_key)}'")
        return entry["url"], str(entry.get("pool") or ("slow_parse" if tier_b else "parse"))

    def _extract_status_code(self, resp: RawHttpResponse | None) -> tuple[int | None, str]:
        if resp is None:
            return None, "NETWORK_ERROR"
        code = "-"
        try:
            obj = resp.json_object()
            if isinstance(obj.get("code"), str) and obj["code"]:
                code = obj["code"]
        except ValueError:
            code = f"HTTP_{resp.status}"
        return resp.status, code

    def _run_parse_check(
        self,
        *,
        check_id: str,
        group: str,
        sample_key: str,
        expected_platform: str | None,
        extra_assertion: Callable[[dict[str, Any], list[str]], str] | None = None,
        tier_b: bool = False,
    ) -> CheckResult:
        sample_url, pool = self._sample_entry(sample_key, tier_b=tier_b)

        # Reuse an already-validated 200 OK response for the exact same sample URL if it
        # also satisfies this check's derived assertion; otherwise fall back to fresh retries.
        shared = self.shared_parses.get(sample_url)
        if shared is not None:
            try:
                _payload, hosts = validate_parse_envelope(
                    shared.response,
                    expected_platform,
                    target_host=self.client.target_host,
                )
                detail = (
                    extra_assertion(shared.payload, hosts)
                    if extra_assertion is not None
                    else f"items={len(shared.payload['data']['items'])}"
                )
                return CheckResult(
                    id=check_id,
                    group=group,
                    status="PASS",
                    http_status=shared.response.status,
                    code="OK",
                    elapsed_ms=shared.response.elapsed_ms,
                    retry_count=0,
                    media_hostnames=hosts,
                    note=f"{detail} (reused)",
                )
            except SmokeError:
                raise
            except Exception:  # noqa: BLE001
                pass

        last_resp: RawHttpResponse | None = None
        last_error = "check failed"
        last_hosts: list[str] = []
        total_elapsed_ms = 0

        for attempt in range(1, self.max_attempts + 1):
            if attempt > 1 or shared is not None:
                self.client.clock.sleep(self.retry_interval)
            try:
                resp = self.client.get_parse(sample_url, paced=True, pool=pool)
                last_resp = resp
                total_elapsed_ms = resp.elapsed_ms
                payload, hosts = validate_parse_envelope(
                    resp,
                    expected_platform,
                    target_host=self.client.target_host,
                )
                last_hosts = hosts
                detail = (
                    extra_assertion(payload, hosts)
                    if extra_assertion is not None
                    else f"items={len(payload['data']['items'])}"
                )
                retry_count = attempt - 1
                self.shared_parses[sample_url] = SharedParseEntry(
                    response=resp,
                    payload=payload,
                    retry_count=retry_count,
                )
                return CheckResult(
                    id=check_id,
                    group=group,
                    status="PASS",
                    http_status=resp.status,
                    code="OK",
                    elapsed_ms=total_elapsed_ms,
                    retry_count=retry_count,
                    media_hostnames=hosts,
                    note=detail,
                )
            except SmokeError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_error = sanitize_text(str(exc)) or exc.__class__.__name__

        http_status, code = self._extract_status_code(last_resp)
        is_stale, orig_code, stale_reason = classify_sample_stale(last_resp)
        if is_stale:
            suffix = f": {stale_reason}" if stale_reason else ""
            return CheckResult(
                id=check_id,
                group=group,
                status="SAMPLE_STALE",
                http_status=http_status,
                code="SAMPLE_STALE",
                elapsed_ms=total_elapsed_ms,
                retry_count=self.max_attempts - 1,
                media_hostnames=last_hosts,
                note=f"upstream sample stale/removed (backend_code={sanitize_text(orig_code)}; refresh sample URL){suffix}",
            )
        return CheckResult(
            id=check_id,
            group=group,
            status="FAIL",
            http_status=http_status,
            code=code,
            elapsed_ms=total_elapsed_ms,
            retry_count=self.max_attempts - 1,
            media_hostnames=last_hosts,
            note=last_error,
        )

    def check_frontend_hashes(self, *, explicitly_requested: bool) -> CheckResult:
        if self.manifest_path is None:
            if explicitly_requested:
                return CheckResult(
                    id="frontend_hashes",
                    group="frontend_hashes",
                    status="FAIL",
                    code="MISSING_MANIFEST",
                    note="--manifest is required when frontend_hashes is explicitly selected",
                )
            return CheckResult(
                id="frontend_hashes",
                group="frontend_hashes",
                status="SKIP",
                code="-",
                note="skipped (pass --manifest <release-manifest.json> to verify static SHA-256s)",
            )

        try:
            manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except OSError as exc:
            return CheckResult(
                id="frontend_hashes",
                group="frontend_hashes",
                status="FAIL",
                code="INVALID_MANIFEST",
                note=f"failed to read manifest {self.manifest_path.name}: {sanitize_text(exc.strerror or type(exc).__name__)}",
            )
        except json.JSONDecodeError as exc:
            return CheckResult(
                id="frontend_hashes",
                group="frontend_hashes",
                status="FAIL",
                code="INVALID_MANIFEST",
                note=f"invalid JSON in manifest {self.manifest_path.name}: line {exc.lineno}",
            )

        dist_files = manifest.get("frontend_dist_files") if isinstance(manifest, dict) else None
        if not isinstance(dist_files, dict) or not dist_files:
            return CheckResult(
                id="frontend_hashes",
                group="frontend_hashes",
                status="FAIL",
                code="INVALID_MANIFEST",
                note="manifest missing non-empty frontend_dist_files mapping",
            )

        targets: list[tuple[str, str, str]] = []
        if "index.html" in dist_files:
            targets.append(("/", "/", str(dist_files["index.html"]).lower()))
        for rel_path in sorted(dist_files.keys()):
            rel_str = str(rel_path).lstrip("/")
            encoded_segments = "/".join(
                urllib.parse.quote(seg, safe="-._~") for seg in rel_str.split("/")
            )
            targets.append((rel_str, "/" + encoded_segments, str(dist_files[rel_path]).lower()))

        t0 = self.client.clock.now()
        worker_count = min(self.frontend_concurrency, len(targets))

        def _verify_one(target: tuple[str, str, str]) -> tuple[str | None, int]:
            label, req_path, expected_sha = target
            try:
                resp = self.client.get_raw(req_path, accept="*/*")
            except SmokeError:
                raise
            except Exception as exc:  # noqa: BLE001
                return f"{label}:network_error({sanitize_text(str(exc))})", 0
            if resp.status != 200:
                return f"{label}:HTTP_{resp.status}", resp.status
            actual_sha = hashlib.sha256(resp.body).hexdigest()
            if actual_sha != expected_sha:
                return f"{label}:sha256_mismatch", 200
            return None, 200

        if worker_count <= 1:
            outcomes = [_verify_one(target) for target in targets]
        else:
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                outcomes = list(executor.map(_verify_one, targets))

        total_elapsed = max(0, int(round((self.client.clock.now() - t0) * 1000.0)))
        mismatches: list[str] = []
        last_status = 200
        for err_msg, status_code in outcomes:
            if err_msg is not None:
                mismatches.append(err_msg)
                if status_code != 200:
                    last_status = status_code

        release_tag = sanitize_text(str(manifest.get("release_tag") or "manifest"))
        if mismatches:
            preview = ", ".join(mismatches[:5])
            if len(mismatches) > 5:
                preview += f" (+{len(mismatches) - 5} more)"
            return CheckResult(
                id="frontend_hashes",
                group="frontend_hashes",
                status="FAIL",
                http_status=last_status or None,
                code="HASH_MISMATCH",
                elapsed_ms=total_elapsed,
                retry_count=0,
                note=f"{len(mismatches)}/{len(targets)} failed ({release_tag}): {preview}",
            )

        return CheckResult(
            id="frontend_hashes",
            group="frontend_hashes",
            status="PASS",
            http_status=200,
            code="OK",
            elapsed_ms=total_elapsed,
            retry_count=0,
            note=f"{len(targets)}/{len(targets)} static paths matched SHA-256 ({release_tag})",
        )

    def check_platforms(self) -> CheckResult:
        expected_ids = [str(p) for p in self.samples.get("expected_platforms", [])]
        try:
            resp = self.client.get_raw(
                f"/api/platforms?schema_version={SCHEMA_VERSION}",
                accept="application/json",
            )
        except Exception as exc:  # noqa: BLE001
            return CheckResult(
                id="platforms",
                group="platforms",
                status="FAIL",
                code="NETWORK_ERROR",
                note=sanitize_text(str(exc)),
            )

        if resp.status != 200:
            http_status, code = self._extract_status_code(resp)
            return CheckResult(
                id="platforms",
                group="platforms",
                status="FAIL",
                http_status=http_status,
                code=code,
                elapsed_ms=resp.elapsed_ms,
                note=f"expected HTTP 200, got HTTP {resp.status}",
            )

        try:
            payload = resp.json_object()
            if payload.get("schema_version") != SCHEMA_VERSION or payload.get("code") != "OK":
                raise AssertionError(f"unexpected envelope code={payload.get('code')!r}")
            data = payload.get("data")
            if not isinstance(data, dict):
                raise AssertionError("missing data object")
            platforms = data.get("platforms")
            if not isinstance(platforms, list):
                raise AssertionError("missing data.platforms list")
            actual_ids = [str(entry.get("id") or "") for entry in platforms if isinstance(entry, dict)]
            count = data.get("count")
            if (count is not None and count != len(expected_ids)) or len(actual_ids) != len(expected_ids):
                raise AssertionError(
                    f"expected {len(expected_ids)} platforms, got count={count!r} len={len(actual_ids)}"
                )
            if set(actual_ids) != set(expected_ids):
                missing = sorted(set(expected_ids) - set(actual_ids))
                extra = sorted(set(actual_ids) - set(expected_ids))
                raise AssertionError(f"platform ID mismatch missing={missing} extra={extra}")
        except Exception as exc:  # noqa: BLE001
            return CheckResult(
                id="platforms",
                group="platforms",
                status="FAIL",
                http_status=resp.status,
                code="CONTRACT_MISMATCH",
                elapsed_ms=resp.elapsed_ms,
                note=sanitize_text(str(exc)),
            )

        return CheckResult(
            id="platforms",
            group="platforms",
            status="PASS",
            http_status=200,
            code="OK",
            elapsed_ms=resp.elapsed_ms,
            note=f"count={len(actual_ids)}; all {len(expected_ids)} platform IDs verified",
        )

    def check_youtube_context(self) -> CheckResult:
        try:
            resp = self.client.get_raw(
                f"/api/youtube/context?schema_version={SCHEMA_VERSION}",
                accept="application/json",
            )
        except SmokeError:
            raise
        except Exception as exc:  # noqa: BLE001
            return CheckResult(
                id="youtube_context",
                group="youtube_context",
                status="FAIL",
                code="NETWORK_ERROR",
                note=sanitize_text(str(exc)),
            )

        if resp.status != 200:
            http_status, code = self._extract_status_code(resp)
            return CheckResult(
                id="youtube_context",
                group="youtube_context",
                status="FAIL",
                http_status=http_status,
                code=code,
                elapsed_ms=resp.elapsed_ms,
                note=f"expected HTTP 200 on /api/youtube/context, got HTTP {resp.status}",
            )

        try:
            payload = resp.json_object()
            if payload.get("schema_version") != SCHEMA_VERSION or payload.get("code") != "OK":
                raise AssertionError(f"unexpected envelope code={payload.get('code')!r}")
            data = payload.get("data")
            if not isinstance(data, dict):
                raise AssertionError("missing data object")
            player_id = str(data.get("player_id") or "").strip()
            if not player_id:
                raise AssertionError("missing non-empty data.player_id")
            expires_at = data.get("expires_at")
            if not isinstance(expires_at, (int, float, str)) or not str(expires_at).strip():
                raise AssertionError("missing data.expires_at")
        except Exception as exc:  # noqa: BLE001
            return CheckResult(
                id="youtube_context",
                group="youtube_context",
                status="FAIL",
                http_status=resp.status,
                code="CONTRACT_MISMATCH",
                elapsed_ms=resp.elapsed_ms,
                note=sanitize_text(str(exc)),
            )

        safe_pid = sanitize_text(player_id)[:16]
        if resp.elapsed_ms > self.youtube_context_fail_ms:
            return CheckResult(
                id="youtube_context",
                group="youtube_context",
                status="FAIL",
                http_status=200,
                code="LATENCY_FAIL",
                elapsed_ms=resp.elapsed_ms,
                note=(
                    f"player_id={safe_pid} latency {resp.elapsed_ms}ms exceeded "
                    f"fail threshold {self.youtube_context_fail_ms}ms"
                ),
            )
        if resp.elapsed_ms > self.youtube_context_warn_ms:
            return CheckResult(
                id="youtube_context",
                group="youtube_context",
                status="WARN",
                http_status=200,
                code="LATENCY_WARN",
                elapsed_ms=resp.elapsed_ms,
                note=(
                    f"player_id={safe_pid} latency {resp.elapsed_ms}ms exceeded "
                    f"warn threshold {self.youtube_context_warn_ms}ms (possible cold start)"
                ),
            )
        return CheckResult(
            id="youtube_context",
            group="youtube_context",
            status="PASS",
            http_status=200,
            code="OK",
            elapsed_ms=resp.elapsed_ms,
            note=f"player_id={safe_pid} warm (<= {self.youtube_context_warn_ms}ms)",
        )

    def check_cache(self) -> CheckResult:
        sample_key = str(self.samples.get("cache_sample_key") or "kuaishou")
        sample_url, pool = self._sample_entry(sample_key)
        expected_plat = sample_key if not sample_key.startswith("__") else None

        last_resp: RawHttpResponse | None = None
        last_error = "cache check failed"
        last_hosts: list[str] = []
        total_elapsed = 0

        for attempt in range(1, self.max_attempts + 1):
            if attempt > 1:
                self.client.clock.sleep(self.retry_interval)
            try:
                resp1 = self.client.get_parse(sample_url, paced=True, pool=pool)
                last_resp = resp1
                payload1, hosts1 = validate_parse_envelope(
                    resp1,
                    expected_plat,
                    target_host=self.client.target_host,
                )
                last_hosts = hosts1

                resp2 = self.client.get_parse(sample_url, paced=True, pool=pool)
                last_resp = resp2
                total_elapsed = resp1.elapsed_ms + resp2.elapsed_ms
                payload2, hosts2 = validate_parse_envelope(
                    resp2,
                    expected_plat,
                    target_host=self.client.target_host,
                )
                last_hosts = hosts2

                sha1 = hashlib.sha256(resp1.body).hexdigest()
                sha2 = hashlib.sha256(resp2.body).hexdigest()
                gen1 = payload1["data"]["generated_at"]
                gen2 = payload2["data"]["generated_at"]
                if sha1 != sha2 or gen1 != gen2:
                    raise AssertionError(
                        f"cache miss across 2 requests (sha_equal={sha1 == sha2}, generated_at_equal={gen1 == gen2})"
                    )

                retry_count = attempt - 1
                self.shared_parses[sample_url] = SharedParseEntry(
                    response=resp2,
                    payload=payload2,
                    retry_count=retry_count,
                )
                return CheckResult(
                    id="cache",
                    group="cache",
                    status="PASS",
                    http_status=200,
                    code="OK",
                    elapsed_ms=total_elapsed,
                    retry_count=retry_count,
                    media_hostnames=hosts2,
                    note=f"2x GET >={self.client.min_parse_interval:g}s apart byte-identical (sha256[:12]={sha2[:12]})",
                )
            except SmokeError:
                raise
            except Exception as exc:  # noqa: BLE001
                last_error = sanitize_text(str(exc)) or exc.__class__.__name__

        http_status, code = self._extract_status_code(last_resp)
        return CheckResult(
            id="cache",
            group="cache",
            status="FAIL",
            http_status=http_status,
            code=code,
            elapsed_ms=total_elapsed,
            retry_count=self.max_attempts - 1,
            media_hostnames=last_hosts,
            note=last_error,
        )

    def check_x_fast_path(self) -> CheckResult:
        sample_key = str(self.samples.get("x_fast_path_key") or "x")

        def assert_x_mp4(payload: dict[str, Any], _hosts: list[str]) -> str:
            mp4_count = 0
            for item in payload["data"]["items"]:
                for variant in item.get("variants", []):
                    if not isinstance(variant, dict) or variant.get("state") == "deferred":
                        continue
                    delivery = variant.get("delivery") or {}
                    meta = variant.get("metadata") or {}
                    is_mp4 = (
                        delivery.get("kind") == "file"
                        and (
                            meta.get("container") == "mp4"
                            or meta.get("extension") == "mp4"
                            or meta.get("mime_type") == "video/mp4"
                        )
                    )
                    if not is_mp4:
                        continue
                    for src in iter_delivery_sources(delivery):
                        raw_url = str(src.get("url") or "")
                        parsed = urllib.parse.urlsplit(raw_url)
                        host = (parsed.hostname or "").lower()
                        if parsed.scheme == "https" and (
                            host == "video.twimg.com" or host.endswith(".twimg.com")
                        ):
                            mp4_count += 1
                            break
            if mp4_count < 1:
                raise AssertionError("no https://video.twimg.com MP4 file variants found")
            return f"twimg HTTPS MP4 variants={mp4_count}"

        return self._run_parse_check(
            check_id="x_fast_path",
            group="x_fast_path",
            sample_key=sample_key,
            expected_platform="x",
            extra_assertion=assert_x_mp4,
        )

    def check_douyin_domestic(self) -> CheckResult:
        sample_key = str(self.samples.get("douyin_domestic_key") or "douyin")

        def assert_douyinvod(_payload: dict[str, Any], hosts: list[str]) -> str:
            domestic = [
                h for h in hosts if h == "douyinvod.com" or h.endswith(".douyinvod.com")
            ]
            if not domestic:
                raise AssertionError("no *.douyinvod.com domestic media hostname present")
            return f"domestic douyinvod.com hosts={len(domestic)}"

        return self._run_parse_check(
            check_id="douyin_domestic",
            group="douyin_domestic",
            sample_key=sample_key,
            expected_platform="douyin",
            extra_assertion=assert_douyinvod,
        )

    def check_direct_markers(self) -> list[CheckResult]:
        dm_cfg = self.samples.get("direct_marker_platforms", {})
        results: list[CheckResult] = []
        for plat, cfg in dm_cfg.items():
            if not isinstance(cfg, dict):
                continue
            sample_key = str(cfg.get("sample_key") or plat)
            suffixes = tuple(str(s).lower() for s in cfg.get("expected_allowed_suffixes", []))
            require_all_https = bool(cfg.get("require_all_direct_https"))

            def make_assertion(
                platform_name: str,
                allowed_suffixes: tuple[str, ...],
                strict_https: bool,
            ) -> Callable[[dict[str, Any], list[str]], str]:
                def _assert(payload: dict[str, Any], _hosts: list[str]) -> str:
                    allowed_sources = 0
                    variant_sources = 0
                    http_cleartext = 0
                    missing_marker = 0
                    for item in payload["data"]["items"]:
                        for raw_url, src_meta, loc in iter_item_media_urls(item):
                            if raw_url.startswith("/api/"):
                                continue
                            parsed = urllib.parse.urlsplit(raw_url)
                            scheme = parsed.scheme.lower()
                            host = (parsed.hostname or "").lower().rstrip(".")
                            if scheme == "http":
                                http_cleartext += 1
                                if src_meta.get("browser_fetch") == "allowed":
                                    raise AssertionError(
                                        "http:// source illegally marked browser_fetch=allowed"
                                    )
                            if loc == "variant":
                                variant_sources += 1
                                matches_suffix = any(
                                    host.endswith(suf if suf.startswith(".") else "." + suf)
                                    for suf in allowed_suffixes
                                )
                                if scheme == "https" and matches_suffix:
                                    if src_meta.get("browser_fetch") == "allowed":
                                        allowed_sources += 1
                                    else:
                                        missing_marker += 1
                    if strict_https and http_cleartext > 0:
                        raise AssertionError(
                            f"{platform_name} returned {http_cleartext} http:// media URLs (expected 100% https://)"
                        )
                    if missing_marker > 0:
                        raise AssertionError(
                            f"{platform_name} missing browser_fetch='allowed' on {missing_marker} verified CDN sources"
                        )
                    if allowed_sources < 1:
                        raise AssertionError(
                            f"{platform_name} had 0 https:// sources with browser_fetch='allowed'"
                        )
                    https_note = ", 100% https" if strict_https else ""
                    return f"browser_fetch=allowed on {allowed_sources}/{variant_sources} variant sources{https_note}"

                return _assert

            results.append(
                self._run_parse_check(
                    check_id=f"direct_markers:{plat}",
                    group="direct_markers",
                    sample_key=sample_key,
                    expected_platform=plat,
                    extra_assertion=make_assertion(plat, suffixes, require_all_https),
                )
            )
        return results

    def check_all_platforms(self) -> list[CheckResult]:
        expected_ids = [str(p) for p in self.samples.get("expected_platforms", [])]
        results: list[CheckResult] = []
        for plat in expected_ids:
            results.append(
                self._run_parse_check(
                    check_id=f"platform:{plat}",
                    group="all_platforms",
                    sample_key=plat,
                    expected_platform=plat,
                )
            )
        return results

    def check_tier_b_platforms(self) -> list[CheckResult]:
        tier_b_cfg = self.samples.get("tier_b_platforms")
        if not isinstance(tier_b_cfg, dict) or not tier_b_cfg:
            return [
                CheckResult(
                    id="tier_b_platforms",
                    group="tier_b_platforms",
                    status="SKIP",
                    note="no tier_b_platforms configured in samples.json",
                )
            ]
        keys = sorted(str(k) for k in tier_b_cfg.keys())
        if self.tier_b_limit is not None and self.tier_b_limit < len(keys):
            # Deterministic UTC day-of-year rotation across the Tier-B long-tail pool
            day_ordinal = self.client.clock.utc_now_fn().timetuple().tm_yday
            offset = day_ordinal % len(keys)
            rotated = keys[offset:] + keys[:offset]
            keys = rotated[: self.tier_b_limit]
        results: list[CheckResult] = []
        for site_key in keys:
            results.append(
                self._run_parse_check(
                    check_id=f"tier_b:{site_key}",
                    group="tier_b_platforms",
                    sample_key=site_key,
                    expected_platform=None,
                    tier_b=True,
                )
            )
        return results

    def _validate_boundary_error_response(
        self,
        *,
        check_id: str,
        resp: RawHttpResponse,
        expected_status: int,
        expected_code: str,
        pass_note: str,
    ) -> CheckResult:
        if resp.status != expected_status:
            http_status, actual_code = self._extract_status_code(resp)
            reported_code = actual_code if actual_code != "OK" else f"HTTP_{resp.status}"
            return CheckResult(
                id=check_id,
                group="api_boundary",
                status="FAIL",
                http_status=http_status,
                code=reported_code,
                elapsed_ms=resp.elapsed_ms,
                retry_count=0,
                note=f"expected HTTP {expected_status}, got HTTP {resp.status} (code={sanitize_text(actual_code)})",
            )

        raw_ct = str(resp.headers.get("content-type") or "").strip()
        media_type = raw_ct.split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            ct_display = sanitize_text(raw_ct) or "<missing>"
            return CheckResult(
                id=check_id,
                group="api_boundary",
                status="FAIL",
                http_status=resp.status,
                code="NON_JSON_RESPONSE",
                elapsed_ms=resp.elapsed_ms,
                retry_count=0,
                note=f"expected Content-Type application/json on HTTP {expected_status}, got {ct_display}",
            )

        try:
            payload = resp.json_object()
        except ValueError as exc:
            return CheckResult(
                id=check_id,
                group="api_boundary",
                status="FAIL",
                http_status=resp.status,
                code="NON_JSON_RESPONSE",
                elapsed_ms=resp.elapsed_ms,
                retry_count=0,
                note=f"HTTP {expected_status} body is not a valid JSON object: {sanitize_text(str(exc))}",
            )

        err_obj = payload.get("error")
        err_msg = err_obj.get("message") if isinstance(err_obj, dict) else None
        if (
            payload.get("schema_version") != SCHEMA_VERSION
            or payload.get("code") != expected_code
            or not isinstance(err_obj, dict)
            or err_obj.get("code") != expected_code
            or not isinstance(err_msg, str)
            or not err_msg.strip()
        ):
            sv = sanitize_text(str(payload.get("schema_version")))
            cd = sanitize_text(str(payload.get("code")))
            return CheckResult(
                id=check_id,
                group="api_boundary",
                status="FAIL",
                http_status=resp.status,
                code="CONTRACT_MISMATCH",
                elapsed_ms=resp.elapsed_ms,
                retry_count=0,
                note=(
                    f"unexpected HTTP {expected_status} error envelope "
                    f"(schema_version={sv!r}, code={cd!r})"
                ),
            )

        return CheckResult(
            id=check_id,
            group="api_boundary",
            status="PASS",
            http_status=expected_status,
            code=expected_code,
            elapsed_ms=resp.elapsed_ms,
            retry_count=0,
            note=pass_note,
        )

    def check_api_boundary(self) -> list[CheckResult]:
        results: list[CheckResult] = []

        # 1. GET /api/stats?schema_version=1.0 without Authorization -> 401 JSON.
        #    Does NOT count toward /api/parse's 8s pacing interval (last_parse_ts),
        #    but charges 1 anonymous visitor token on the backend 'parse' pool.
        stats_id = "api_boundary:stats_unauth_401"
        try:
            try:
                stats_resp = self.client.get_raw(
                    f"/api/stats?schema_version={SCHEMA_VERSION}",
                    accept="application/json",
                )
            finally:
                self.client.last_pool_ts["parse"] = self.client.clock.now()
            results.append(
                self._validate_boundary_error_response(
                    check_id=stats_id,
                    resp=stats_resp,
                    expected_status=401,
                    expected_code="INVALID_INPUT",
                    pass_note="GET /api/stats without Authorization rejected with 401 application/json",
                )
            )
        except SmokeError:
            raise
        except Exception as exc:  # noqa: BLE001
            results.append(
                CheckResult(
                    id=stats_id,
                    group="api_boundary",
                    status="FAIL",
                    code="NETWORK_ERROR",
                    note=sanitize_text(str(exc)),
                )
            )

        # 2. GET /api/<random_name> not in Caddy's @api whitelist -> 404 JSON.
        #    Does NOT count toward /api/parse's 8s pacing interval.
        unlisted_id = "api_boundary:unlisted_api_404"
        random_segment = f"smoke-unlisted-{secrets.token_hex(6)}"
        try:
            unlisted_resp = self.client.get_raw(
                f"/api/{random_segment}",
                accept="application/json",
            )
            results.append(
                self._validate_boundary_error_response(
                    check_id=unlisted_id,
                    resp=unlisted_resp,
                    expected_status=404,
                    expected_code="INVALID_INPUT",
                    pass_note="unlisted /api/<random> rejected with 404 application/json",
                )
            )
        except SmokeError:
            raise
        except Exception as exc:  # noqa: BLE001
            results.append(
                CheckResult(
                    id=unlisted_id,
                    group="api_boundary",
                    status="FAIL",
                    code="NETWORK_ERROR",
                    note=sanitize_text(str(exc)),
                )
            )

        return results

    def check_rate_limit(self) -> CheckResult:
        rl_cfg = self.samples.get("rate_limit", {})
        pool = str(rl_cfg.get("pool") or "slow_parse")
        idle_refill = float(rl_cfg.get("idle_refill_seconds", 21.0))
        urls = [str(u) for u in rl_cfg.get("urls", []) if u]
        if len(urls) < 2:
            return CheckResult(
                id="rate_limit",
                group="rate_limit",
                status="FAIL",
                code="INVALID_CONFIG",
                note="rate_limit requires at least 2 distinct URLs in samples.json",
            )

        self.client.wait_for_pool_refill(pool, idle_refill)

        ok_count = 0
        limited_count = 0
        max_retry_after = 0
        total_elapsed = 0
        unexpected: list[str] = []

        for idx, url in enumerate(urls, start=1):
            try:
                resp = self.client.get_parse(url, paced=False, pool=pool)
            except Exception as exc:  # noqa: BLE001
                unexpected.append(f"#{idx}:network_error({sanitize_text(str(exc))})")
                break
            total_elapsed += resp.elapsed_ms
            if resp.status == 200:
                try:
                    obj = resp.json_object()
                    if obj.get("code") == "OK":
                        ok_count += 1
                    else:
                        unexpected.append(f"#{idx}:200/{obj.get('code')}")
                except ValueError:
                    unexpected.append(f"#{idx}:200/invalid_json")
            elif resp.status == 429:
                try:
                    obj = resp.json_object()
                    err = obj.get("error") if isinstance(obj.get("error"), dict) else {}
                    retry_after = err.get("retry_after_seconds")
                    if (
                        obj.get("code") == "RATE_LIMITED"
                        and err.get("code") == "RATE_LIMITED"
                        and isinstance(retry_after, (int, float))
                        and retry_after > 0
                    ):
                        limited_count += 1
                        max_retry_after = max(max_retry_after, int(retry_after))
                    else:
                        unexpected.append(f"#{idx}:429/malformed_envelope")
                except ValueError:
                    unexpected.append(f"#{idx}:429/invalid_json")
            else:
                _, code = self._extract_status_code(resp)
                unexpected.append(f"#{idx}:HTTP_{resp.status}/{code}")

        if unexpected or ok_count < 1 or limited_count < 1:
            detail = f"200_ok={ok_count}, 429_limited={limited_count}"
            if unexpected:
                detail += f", unexpected={','.join(unexpected)}"
            return CheckResult(
                id="rate_limit",
                group="rate_limit",
                status="FAIL",
                http_status=429 if limited_count else 200,
                code="RATE_LIMIT_MISMATCH",
                elapsed_ms=total_elapsed,
                note=detail,
            )

        return CheckResult(
            id="rate_limit",
            group="rate_limit",
            status="PASS",
            http_status=429,
            code="RATE_LIMITED",
            elapsed_ms=total_elapsed,
            note=(
                f"burst={len(urls)}: {ok_count}x 200 OK then {limited_count}x 429 "
                f"RATE_LIMITED (retry_after_seconds={max_retry_after})"
            ),
        )

    def run(self) -> dict[str, Any]:
        only_set = set(self.only_groups)
        active_order = [g for g in ALL_GROUPS if g in only_set] if only_set else list(ALL_GROUPS)
        results: list[CheckResult] = []

        for group in active_order:
            if group in self.skip_groups:
                results.append(
                    CheckResult(
                        id=group,
                        group=group,
                        status="SKIP",
                        note="skipped via --skip",
                    )
                )
                continue

            if group == "frontend_hashes":
                results.append(
                    self.check_frontend_hashes(explicitly_requested=group in only_set)
                )
            elif group == "platforms":
                results.append(self.check_platforms())
            elif group == "youtube_context":
                results.append(self.check_youtube_context())
            elif group == "cache":
                if self.tier == "tier-b" and group not in only_set:
                    results.append(CheckResult(id="cache", group="cache", status="SKIP", note="skipped in --tier tier-b"))
                else:
                    results.append(self.check_cache())
            elif group == "x_fast_path":
                if self.tier == "tier-b" and group not in only_set:
                    results.append(CheckResult(id="x_fast_path", group="x_fast_path", status="SKIP", note="skipped in --tier tier-b"))
                else:
                    results.append(self.check_x_fast_path())
            elif group == "douyin_domestic":
                if self.tier == "tier-b" and group not in only_set:
                    results.append(CheckResult(id="douyin_domestic", group="douyin_domestic", status="SKIP", note="skipped in --tier tier-b"))
                else:
                    results.append(self.check_douyin_domestic())
            elif group == "direct_markers":
                if self.tier == "tier-b" and group not in only_set:
                    results.append(CheckResult(id="direct_markers", group="direct_markers", status="SKIP", note="skipped in --tier tier-b"))
                else:
                    results.extend(self.check_direct_markers())
            elif group == "all_platforms":
                if self.tier == "tier-b" and group not in only_set:
                    results.append(CheckResult(id="all_platforms", group="all_platforms", status="SKIP", note="skipped in --tier tier-b"))
                else:
                    results.extend(self.check_all_platforms())
            elif group == "tier_b_platforms":
                if self.tier in ("tier-b", "all") or group in only_set:
                    results.extend(self.check_tier_b_platforms())
                else:
                    results.append(
                        CheckResult(
                            id="tier_b_platforms",
                            group="tier_b_platforms",
                            status="SKIP",
                            note="disabled in --tier tier-a (pass --tier tier-b or --tier all to run)",
                        )
                    )
            elif group == "api_boundary":
                results.extend(self.check_api_boundary())
            elif group == "rate_limit":
                if not self.enable_rate_limit:
                    if group in only_set:
                        results.append(
                            CheckResult(
                                id="rate_limit",
                                group="rate_limit",
                                status="FAIL",
                                code="RATE_LIMIT_OPT_IN_REQUIRED",
                                note="pass --enable-rate-limit to execute rate_limit burst check",
                            )
                        )
                    else:
                        results.append(
                            CheckResult(
                                id="rate_limit",
                                group="rate_limit",
                                status="SKIP",
                                note="disabled by default (pass --enable-rate-limit to run)",
                            )
                        )
                else:
                    results.append(self.check_rate_limit())

        sanitized_items = [item.to_sanitized_dict() for item in results]
        summary = {
            "total": len(sanitized_items),
            "pass": sum(1 for item in sanitized_items if item["status"] == "PASS"),
            "warn": sum(1 for item in sanitized_items if item["status"] == "WARN"),
            "sample_stale": sum(1 for item in sanitized_items if item["status"] == "SAMPLE_STALE"),
            "fail": sum(1 for item in sanitized_items if item["status"] == "FAIL"),
            "skip": sum(1 for item in sanitized_items if item["status"] == "SKIP"),
        }
        passed = summary["fail"] == 0 and (
            not self.strict_stale or summary["sample_stale"] == 0
        )
        report = {
            "schema_version": SCHEMA_VERSION,
            "generated_at_utc": self.client.clock.utc_iso(),
            "target_host": self.client.target_host,
            "tier": self.tier,
            "passed": passed,
            "summary": summary,
            "checks": sanitized_items,
        }
        return report


def render_json_report(report: dict[str, Any]) -> str:
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    verify_redacted_output(rendered)
    return rendered


def _escape_md_cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ").strip()


def render_markdown_report(report: dict[str, Any]) -> str:
    summary = report["summary"]
    warn_count = summary.get("warn", 0)
    stale_count = summary.get("sample_stale", 0)
    lines = [
        (
            f"- 目标站点: `{_escape_md_cell(report['target_host'])}` | "
            f"生成时间 (UTC): `{_escape_md_cell(report['generated_at_utc'])}` | "
            f"汇总: `PASS={summary['pass']}, WARN={warn_count}, SAMPLE_STALE={stale_count}, "
            f"FAIL={summary['fail']}, SKIP={summary['skip']}`"
        ),
        "",
        "| 检查项 (`id`) | 分组 (`group`) | 结论 (`status`) | HTTP | `code` | 耗时 (ms) | 重试 (`retry_count`) | 媒体域名 (`media_hostnames`) | 说明 (`note`) |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for item in report["checks"]:
        http_cell = str(item["http_status"]) if item["http_status"] is not None else "-"
        hosts = item["media_hostnames"]
        hosts_cell = ", ".join(f"`{_escape_md_cell(h)}`" for h in hosts) if hosts else "-"
        lines.append(
            "| "
            + " | ".join(
                [
                    f"`{_escape_md_cell(item['id'])}`",
                    f"`{_escape_md_cell(item['group'])}`",
                    f"**{_escape_md_cell(item['status'])}**",
                    f"`{http_cell}`",
                    f"`{_escape_md_cell(item['code'])}`",
                    str(item["elapsed_ms"]),
                    str(item["retry_count"]),
                    hosts_cell,
                    _escape_md_cell(item["note"]),
                ]
            )
            + " |"
        )
    rendered = "\n".join(lines) + "\n"
    verify_redacted_output(rendered)
    return rendered


def write_utf8_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only production smoke checker for DokiTool-Go."
    )
    parser.add_argument(
        "--base-url",
        default=DEFAULT_BASE_URL,
        help=f"Target deployment origin (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--samples",
        type=Path,
        default=DEFAULT_SAMPLES_PATH,
        help="Path to samples.json (default: scripts/prod-smoke/samples.json)",
    )
    parser.add_argument(
        "--set-sample",
        action="append",
        default=[],
        metavar="KEY=URL",
        help="Override a sample URL at runtime (e.g. xiaohongshu=https://...); repeatable",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Path to release-manifest.json for frontend_hashes SHA-256 verification",
    )
    parser.add_argument(
        "--only",
        "--check",
        dest="only",
        action="append",
        default=[],
        help=f"Run only comma-separated check group(s): {', '.join(ALL_GROUPS)}",
    )
    parser.add_argument(
        "--skip",
        action="append",
        default=[],
        help=f"Skip comma-separated check group(s): {', '.join(ALL_GROUPS)}",
    )
    parser.add_argument(
        "--enable-rate-limit",
        action="store_true",
        help="Opt in to the unspaced burst rate_limit (HTTP 429) check (runs last)",
    )
    parser.add_argument(
        "--tier",
        choices=VALID_TIERS,
        default="tier-a",
        help="Platform tier selection: tier-a (14 core release platforms, default), tier-b (long-tail pool), or all",
    )
    parser.add_argument(
        "--tier-b-limit",
        type=int,
        default=None,
        help="Optional cap on Tier-B long-tail sites sampled per run (rotates daily by UTC day-of-year)",
    )
    parser.add_argument(
        "--youtube-context-warn-ms",
        type=int,
        default=None,
        help=f"Latency warning threshold (ms) for /api/youtube/context (default: {DEFAULT_YOUTUBE_CONTEXT_WARN_MS})",
    )
    parser.add_argument(
        "--youtube-context-fail-ms",
        type=int,
        default=None,
        help=(
            "Latency failure threshold (ms) for /api/youtube/context; must be >= 1 and >= warn threshold "
            f"(default: samples.json fail_latency_ms or {DEFAULT_YOUTUBE_CONTEXT_FAIL_MS})"
        ),
    )
    parser.add_argument(
        "--strict-stale",
        action="store_true",
        help="Treat SAMPLE_STALE upstream takedowns as a non-zero exit failure",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"Per-request HTTP timeout in seconds (default: {DEFAULT_TIMEOUT_SECONDS:g})",
    )
    parser.add_argument(
        "--frontend-concurrency",
        type=int,
        default=DEFAULT_FRONTEND_CONCURRENCY,
        help=(
            f"Worker threads and Keep-Alive pool size for frontend_hashes "
            f"(1..{MAX_FRONTEND_CONCURRENCY}, default: {DEFAULT_FRONTEND_CONCURRENCY})"
        ),
    )
    parser.add_argument(
        "--json-out",
        type=Path,
        default=None,
        help="Write sanitized JSON report to file (UTF-8)",
    )
    parser.add_argument(
        "--md-out",
        type=Path,
        default=None,
        help="Write sanitized Markdown conclusion table to file (UTF-8)",
    )
    parser.add_argument(
        "--format",
        choices=("both", "md", "json", "none"),
        default="both",
        help="Stdout output format (default: both)",
    )
    return parser


def main(argv: list[str] | None = None, *, clock: Clock | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    try:
        if args.frontend_concurrency < 1 or args.frontend_concurrency > MAX_FRONTEND_CONCURRENCY:
            raise SmokeError(
                f"invalid --frontend-concurrency {args.frontend_concurrency}: "
                f"expected 1..{MAX_FRONTEND_CONCURRENCY}"
            )
        samples = load_samples(args.samples, args.set_sample)
        with OriginLockedClient(
            args.base_url,
            clock=clock,
            timeout_seconds=args.timeout,
            min_parse_interval=DEFAULT_MIN_PARSE_INTERVAL,
            pool_maxsize=args.frontend_concurrency,
        ) as client:
            runner = SmokeRunner(
                client,
                samples,
                manifest_path=args.manifest,
                only_groups=args.only,
                skip_groups=args.skip,
                enable_rate_limit=args.enable_rate_limit,
                tier=args.tier,
                tier_b_limit=args.tier_b_limit,
                youtube_context_warn_ms=args.youtube_context_warn_ms,
                youtube_context_fail_ms=args.youtube_context_fail_ms,
                strict_stale=args.strict_stale,
                retry_interval=DEFAULT_RETRY_INTERVAL,
                max_attempts=DEFAULT_MAX_ATTEMPTS,
                frontend_concurrency=args.frontend_concurrency,
            )
            report = runner.run()
        json_text = render_json_report(report)
        md_text = render_markdown_report(report)

        if args.json_out is not None:
            write_utf8_file(args.json_out, json_text)
        if args.md_out is not None:
            write_utf8_file(args.md_out, md_text)

        if args.format == "md":
            sys.stdout.write(md_text)
        elif args.format == "json":
            sys.stdout.write(json_text)
        elif args.format == "both":
            sys.stdout.write(md_text)
            sys.stdout.write("\n```json\n")
            sys.stdout.write(json_text)
            sys.stdout.write("```\n")

        return 0 if report["passed"] else 1
    except SmokeError as exc:
        sys.stderr.write(f"prod-smoke error: {sanitize_text(str(exc))}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
