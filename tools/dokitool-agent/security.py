"""Security primitives for dokitool-agent: anti-SSRF, zero-Cookie HTTP, path jail, and redaction.

Zero third-party dependencies (Python 3.9+ standard library only).
"""
from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import os
from pathlib import Path
import re
import socket
import ssl
from typing import Any, Callable, Mapping, Sequence
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_API_BASE = "https://snap.dokitool.com"
DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; DokiToolAgent/1.0)"
MAX_URL_LENGTH, MAX_REDIRECTS = 8192, 5
MAX_JSON_BYTES, MAX_SUBTITLE_BYTES = 8 * 1024 * 1024, 5 * 1024 * 1024
MAX_MEDIA_BYTES, MAX_ERROR_BODY_BYTES, STREAM_CHUNK_BYTES = 2 * 1024 * 1024 * 1024, 64 * 1024, 64 * 1024

BLOCKED_HOST_SUFFIXES = (
    "localhost", "local", "internal", "localdomain", "home.arpa",
    "invalid", "lan", "corp", "intranet", "private",
)
_FORBIDDEN_IPV4_NETS = tuple(ipaddress.ip_network(c) for c in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16",
    "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
))
_FORBIDDEN_IPV6_NETS = tuple(ipaddress.ip_network(c) for c in (
    "::/128", "::1/128", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64",
    "2001::/32", "2001:2::/48", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8",
))
_WINDOWS_RESERVED = frozenset({
    "CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10)),
})
_BEARER_RE = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{4,}")
_URL_QUERY_RE = re.compile(r"(https?://[^\s?#\"'<>]+)\?[^\s#\"'<>]+")
_DNS_LABEL_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
_PUBLIC_TLD_RE = re.compile(r"^(?:[a-z]{2,}|xn--[a-z0-9-]{2,})$")


class SecurityError(ValueError):
    """Raised on SSRF, redirect, credential, or path-jail violation."""


class SizeLimitExceededError(SecurityError):
    """Raised when an HTTP response exceeds its configured hard byte cap."""


class HTTPStatusError(RuntimeError):
    """Raised on HTTP >= 400 with bounded response body and sanitized message."""

    def __init__(self, status: int, url: str, headers: Mapping[str, str], body: bytes) -> None:
        self.status = status
        self.url = url
        self.headers = {k.lower(): v for k, v in headers.items()}
        self.body = body
        super().__init__(f"HTTP {status} for {redact_sensitive(url)}")


@dataclass(frozen=True)
class FetchResponse:
    status: int
    url: str
    headers: dict[str, str]
    body: bytes


def redact_sensitive(text: str, extra_secrets: Sequence[str] = ()) -> str:
    """Strip Bearer headers, env tokens, and URL query strings from logs and errors."""
    out = _BEARER_RE.sub("Bearer [REDACTED]", str(text or ""))
    env_vals = [(os.environ.get(k) or "").strip() for k in ("DOKITOOL_API_TOKEN", "DOKITOOL_OWNER_TOKEN")]
    secrets = [s for s in (*extra_secrets, *env_vals) if s and len(s) >= 8]
    for secret in sorted(set(secrets), key=len, reverse=True):
        out = out.replace(secret, "[REDACTED_TOKEN]")
    return _URL_QUERY_RE.sub(r"\1?[REDACTED]", out)


def validate_token(raw: str) -> str:
    """Validate DokiTool Bearer token format without echoing the secret on error."""
    token = raw.strip()
    if not (32 <= len(token) <= 512) or any(ord(ch) < 33 or ord(ch) > 126 for ch in token):
        raise SecurityError("API Bearer token must be 32-512 printable non-whitespace ASCII characters")
    return token


def load_api_token(*, required: bool = False, env: Mapping[str, str] | None = None) -> str | None:
    """Read token strictly from DOKITOOL_API_TOKEN (fallback DOKITOOL_OWNER_TOKEN)."""
    source = os.environ if env is None else env
    raw = (source.get("DOKITOOL_API_TOKEN") or source.get("DOKITOOL_OWNER_TOKEN") or "").strip()
    if not raw:
        if required:
            raise SecurityError("Set DOKITOOL_API_TOKEN (or DOKITOOL_OWNER_TOKEN) in the environment")
        return None
    return validate_token(raw)


def _parse_ip(raw_host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(raw_host.strip("[]").split("%", 1)[0])
    except ValueError:
        return None


def is_loopback_host(host: str) -> bool:
    norm = (host or "").strip().lower().rstrip(".")
    if norm == "localhost":
        return True
    ip = _parse_ip(norm)
    if ip is None:
        return False
    return ip.ipv4_mapped.is_loopback if (isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped) else ip.is_loopback


def is_public_ip(addr: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True strictly for globally routable public unicast IPv4/IPv6 addresses."""
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return is_public_ip(addr.ipv4_mapped)
    if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast or addr.is_reserved or addr.is_unspecified or not addr.is_global:
        return False
    nets = _FORBIDDEN_IPV4_NETS if isinstance(addr, ipaddress.IPv4Address) else _FORBIDDEN_IPV6_NETS
    return not any(addr in net for net in nets)


def _check_blocked_suffix(host: str) -> None:
    if any(host == s or host.endswith("." + s) for s in BLOCKED_HOST_SUFFIXES):
        raise SecurityError(f"Blocked internal/local hostname suffix: {host}")


def _validate_url_syntax(raw_url: str) -> urllib.parse.SplitResult:
    if not isinstance(raw_url, str) or not raw_url or len(raw_url) > MAX_URL_LENGTH:
        raise SecurityError("URL must be a non-empty string within length limits")
    if any(ord(ch) <= 0x20 or ord(ch) >= 0x7F or ch in ("\\", "#") for ch in raw_url):
        raise SecurityError("URL contains forbidden control, whitespace, backslash, or fragment characters")
    parsed = urllib.parse.urlsplit(raw_url)
    if parsed.scheme.lower() not in ("http", "https"):
        raise SecurityError(f"Unsupported URL scheme: {parsed.scheme or '<empty>'}")
    if parsed.username is not None or parsed.password is not None or "@" in parsed.netloc or not parsed.hostname:
        raise SecurityError("URL userinfo is forbidden and hostname is required")
    try:
        port = parsed.port
    except ValueError as exc:
        raise SecurityError("URL contains an invalid port") from exc
    if port is not None and not (1 <= port <= 65535):
        raise SecurityError("URL port out of range")
    return parsed


def validate_api_base(api_base: str) -> str:
    """Validate --api-base: public https:// host OR loopback http(s)://127.0.0.1|localhost|::1."""
    cleaned = (api_base or "").strip().rstrip("/")
    parsed = _validate_url_syntax(cleaned)
    if parsed.query or parsed.fragment:
        raise SecurityError("--api-base must not contain query parameters or fragments")
    host = (parsed.hostname or "").lower().rstrip(".")
    if is_loopback_host(host):
        return cleaned
    if parsed.scheme.lower() != "https":
        raise SecurityError("Refusing plaintext http:// --api-base for non-loopback host")
    _check_blocked_suffix(host)
    ip = _parse_ip(host)
    if ip is not None and not is_public_ip(ip):
        raise SecurityError("Refusing non-public IP literal for --api-base")
    return cleaned


def validate_remote_url(
    url: str, *, allow_loopback: bool = False, resolve_dns: bool = True,
    resolver: Callable[..., list[Any]] | None = None,
) -> urllib.parse.SplitResult:
    """Enforce secondary anti-SSRF validation (scheme, userinfo, suffix, IP literal, DNS)."""
    parsed = _validate_url_syntax(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if "%" in host:
        raise SecurityError("Scoped IPv6 addresses are forbidden")
    if is_loopback_host(host):
        if allow_loopback:
            return parsed
        raise SecurityError("Loopback address is forbidden for media/subtitle fetch")
    _check_blocked_suffix(host)
    ip = _parse_ip(host)
    if ip is not None:
        if not is_public_ip(ip):
            raise SecurityError("Non-public IP literal is forbidden")
        return parsed
    labels = host.split(".")
    if len(labels) < 2 or not _PUBLIC_TLD_RE.match(labels[-1]) or not all(_DNS_LABEL_RE.match(lbl) for lbl in labels):
        raise SecurityError(f"Invalid public DNS hostname: {host}")
    if resolve_dns:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        try:
            infos = (resolver or socket.getaddrinfo)(host, port, 0, socket.SOCK_STREAM)
        except OSError as exc:
            raise SecurityError(f"DNS resolution failed for host {host}") from exc
        if not infos:
            raise SecurityError(f"DNS resolution returned no addresses for host {host}")
        for entry in infos:
            resolved_ip = _parse_ip(str(entry[4][0]))
            if resolved_ip is None or not is_public_ip(resolved_ip):
                raise SecurityError(f"Host {host} resolved to non-public IP address")
    return parsed


def is_bilibili_media_host(url: str) -> bool:
    """Narrow Bilibili CDN matcher (bilivideo.com/.cn and Bilibili Akamai UPOS/upgcxcode only)."""
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if host in ("bilivideo.com", "bilivideo.cn") or host.endswith((".bilivideo.com", ".bilivideo.cn")):
        return True
    if host.endswith(".akamaized.net"):
        first = host.split(".", 1)[0]
        return host.startswith("upos-") or "bili" in first or "/upgcxcode/" in parsed.path.lower()
    return False


def build_media_headers(url: str, *, extra_headers: Mapping[str, str] | None = None) -> dict[str, str]:
    """Build zero-Cookie CDN headers with narrow Bilibili Referer only."""
    headers = {"User-Agent": DEFAULT_USER_AGENT, "Accept": "*/*"}
    if is_bilibili_media_host(url):
        headers["Referer"] = "https://www.bilibili.com/"
    for key, value in (extra_headers or {}).items():
        if key.lower().strip() not in ("cookie", "authorization", "proxy-authorization", "referer"):
            headers[key] = value
    return headers


def sanitize_filename_stem(text: str, max_chars: int = 64) -> str:
    cleaned = re.sub(r"_+", "_", re.sub(r"[^A-Za-z0-9._-]+", "_", text or "")).strip("._-")[:max_chars].strip("._-")
    return "media" if (not cleaned or cleaned.upper() in _WINDOWS_RESERVED) else cleaned


def validate_output_dir(output_dir: str | Path, *, create: bool = False) -> Path:
    raw = str(output_dir)
    if not raw.strip() or "\x00" in raw:
        raise SecurityError("Output directory must be a non-empty valid path")
    path = Path(raw)
    if path.is_symlink():
        raise SecurityError("Output directory itself cannot be a symlink")
    root = path.resolve()
    if create:
        root.mkdir(parents=True, exist_ok=True)
    if not root.exists() or not root.is_dir():
        raise SecurityError(f"Output directory does not exist or is not a directory: {root}")
    return root


def resolve_jailed_path(output_dir: Path, relative_target: str | Path, *, allow_subdirs: bool = False) -> Path:
    """Canonicalize and strictly jail a relative filename inside output_dir (reject .. and symlinks)."""
    root = validate_output_dir(output_dir, create=False)
    raw = str(relative_target or "")
    if not raw or "\x00" in raw or "\\" in raw or raw.startswith(("~", "/")) or re.match(r"^[A-Za-z]:", raw):
        raise SecurityError("Invalid target filename: absolute, empty, drive, or backslash path rejected")
    rel = Path(raw)
    if rel.is_absolute() or not rel.parts or any(p in ("", ".", "..") for p in rel.parts):
        raise SecurityError("Path traversal segments are forbidden")
    if not allow_subdirs and len(rel.parts) != 1:
        raise SecurityError("Subdirectory paths are not permitted for target filename")
    cursor = root
    for part in rel.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise SecurityError("Symlink component inside output directory is forbidden")
    candidate = cursor.resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise SecurityError("Resolved path escapes output directory") from exc
    if candidate == root:
        raise SecurityError("Target path cannot equal output directory root")
    return candidate


def _build_safe_opener(*, bypass_proxy: bool) -> urllib.request.OpenerDirector:
    """Build OpenerDirector with NO cookies, NO auto-redirects, NO file/ftp handlers."""
    opener = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.ProxyHandler({}) if bypass_proxy else urllib.request.ProxyHandler(),
        urllib.request.HTTPHandler(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.HTTPErrorProcessor(),
    ):
        opener.add_handler(handler)
    return opener


def _lower_headers(raw_headers: Any) -> dict[str, str]:
    return {k.lower(): v for k, v in (raw_headers.items() if raw_headers else [])}


def _stream_bounded(resp: Any, max_bytes: int, sink: Callable[[bytes], Any], *, check_complete: bool = False) -> tuple[int, dict[str, str]]:
    hdrs = _lower_headers(resp.headers)
    cl_raw = hdrs.get("content-length", "").strip()
    if cl_raw.isdigit() and int(cl_raw) > max_bytes:
        raise SizeLimitExceededError(f"Response Content-Length exceeds {max_bytes} byte limit")
    total = 0
    while True:
        chunk = resp.read(min(STREAM_CHUNK_BYTES, max_bytes - total + 1))
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise SizeLimitExceededError(f"Response body exceeded {max_bytes} byte limit")
        sink(chunk)
    if check_complete and cl_raw.isdigit() and total != int(cl_raw):
        raise IOError(f"Truncated download ({total} bytes vs Content-Length {cl_raw})")
    return total, hdrs


class SafeHTTPFetcher:
    """Zero-Cookie, anti-SSRF, redirect-validating, size-bounded HTTP fetcher."""

    def __init__(
        self, *, timeout: float = 30.0, max_redirects: int = MAX_REDIRECTS,
        resolver: Callable[..., list[Any]] | None = None,
        url_validator: Callable[..., urllib.parse.SplitResult] | None = None,
        opener_factory: Callable[[bool], urllib.request.OpenerDirector] | None = None,
    ) -> None:
        self.timeout, self.max_redirects, self._resolver = timeout, max_redirects, resolver
        self._url_validator = url_validator or validate_remote_url
        self._opener_factory = opener_factory or (lambda bypass: _build_safe_opener(bypass_proxy=bypass))

    def _open_with_redirects(
        self, url: str, *, headers: Mapping[str, str] | None, allow_loopback: bool,
        allow_redirects: bool, media_mode: bool, timeout: float | None,
    ) -> tuple[Any, str]:
        current, hops, req_timeout = url, 0, (self.timeout if timeout is None else timeout)
        while True:
            parsed = self._url_validator(
                current, allow_loopback=(allow_loopback if hops == 0 else False),
                resolve_dns=True, resolver=self._resolver,
            )
            req_headers = build_media_headers(current, extra_headers=headers) if media_mode else {
                k: v for k, v in (headers or {}).items() if k.lower().strip() != "cookie"
            }
            opener = self._opener_factory(is_loopback_host(parsed.hostname or ""))
            try:
                return opener.open(urllib.request.Request(current, headers=req_headers, method="GET"), timeout=req_timeout), current
            except urllib.error.HTTPError as exc:
                hdrs = _lower_headers(exc.headers)
                if exc.code in (301, 302, 303, 307, 308):
                    location = hdrs.get("location", "").strip()
                    exc.close()
                    if not allow_redirects:
                        raise SecurityError(f"Redirects are forbidden for this request (HTTP {exc.code})") from exc
                    if not location or hops >= self.max_redirects:
                        raise SecurityError(f"Redirect rejected or exceeded limit ({self.max_redirects})") from exc
                    current, hops = urllib.parse.urljoin(current, location), hops + 1
                    continue
                try:
                    err_body = exc.read(MAX_ERROR_BODY_BYTES)
                except Exception:
                    err_body = b""
                finally:
                    exc.close()
                raise HTTPStatusError(exc.code, current, hdrs, err_body) from exc

    def fetch_bytes(
        self, url: str, *, max_bytes: int, headers: Mapping[str, str] | None = None,
        allow_loopback: bool = False, allow_redirects: bool = True,
        media_mode: bool = True, timeout: float | None = None,
    ) -> FetchResponse:
        resp, final_url = self._open_with_redirects(
            url, headers=headers, allow_loopback=allow_loopback,
            allow_redirects=allow_redirects, media_mode=media_mode, timeout=timeout,
        )
        try:
            chunks: list[bytes] = []
            _, hdrs = _stream_bounded(resp, max_bytes, chunks.append)
            return FetchResponse(int(getattr(resp, "status", 200)), final_url, hdrs, b"".join(chunks))
        finally:
            resp.close()

    def download_to_file(
        self, url: str, dest_part_path: Path, output_dir: Path, *,
        max_bytes: int = MAX_MEDIA_BYTES, headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> tuple[int, dict[str, str], str]:
        safe_part = resolve_jailed_path(output_dir, dest_part_path.name, allow_subdirs=False)
        resp, final_url = self._open_with_redirects(
            url, headers=headers, allow_loopback=False, allow_redirects=True, media_mode=True, timeout=timeout,
        )
        try:
            with open(safe_part, "wb") as handle:
                written, hdrs = _stream_bounded(resp, max_bytes, handle.write, check_complete=True)
                handle.flush()
            return written, hdrs, final_url
        except Exception:
            if safe_part.exists() and not safe_part.is_symlink():
                safe_part.unlink()
            raise
        finally:
            resp.close()
