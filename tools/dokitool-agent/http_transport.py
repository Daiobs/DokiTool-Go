"""Zero-Cookie, DNS-rebinding-resistant HTTP transport for dokitool-agent.

Zero third-party dependencies (Python 3.9+ standard library only).
"""
from __future__ import annotations

import http.client
import ipaddress
import os
from pathlib import Path
import socket
import ssl
import time
from typing import Any, Callable, Mapping, Sequence
import urllib.error
import urllib.parse
import urllib.request

from security import (
    FetchResponse, HTTPStatusError, MAX_ERROR_BODY_BYTES, MAX_MEDIA_BYTES, MAX_REDIRECTS,
    STANDARD_HTTP_PORTS, STREAM_CHUNK_BYTES, SecurityError, SizeLimitExceededError,
    build_media_headers, is_loopback_host, resolve_jailed_path, validate_and_resolve_remote_url,
)


def _connect_pinned_ip(
    ip_str: str, port: int, timeout: Any, source_address: tuple[str, int] | None = None
) -> socket.socket:
    """Connect directly to an already-validated numeric IP without re-querying DNS."""
    addr = ipaddress.ip_address(ip_str)
    family = socket.AF_INET6 if isinstance(addr, ipaddress.IPv6Address) else socket.AF_INET
    sockaddr: tuple[Any, ...] = (ip_str, port, 0, 0) if family == socket.AF_INET6 else (ip_str, port)
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
    """HTTPConnection dialing pre-validated IP(s) while preserving original Host header."""

    def __init__(self, host: str, *args: Any, pinned_ips: Sequence[str] = (), **kwargs: Any) -> None:
        self._pinned_ips = tuple(pinned_ips)
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
    """HTTPSConnection dialing pre-validated IP(s) while preserving SNI and cert host."""

    def __init__(self, host: str, *args: Any, pinned_ips: Sequence[str] = (), **kwargs: Any) -> None:
        self._pinned_ips = tuple(pinned_ips)
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
                server_hostname = self._tunnel_host or self.host
                self.sock = self._context.wrap_socket(sock, server_hostname=server_hostname)
                return
            except OSError as exc:
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
                self.sock, last_err = None, exc
        raise last_err or OSError(f"Failed to establish TLS to pinned IP for {self.host}")


class PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, pinned_ips: Sequence[str] = ()) -> None:
        super().__init__()
        self._pinned_ips = tuple(pinned_ips)

    def http_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_PinnedHTTPConnection, req, pinned_ips=self._pinned_ips)


class PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, context: ssl.SSLContext | None = None, pinned_ips: Sequence[str] = ()) -> None:
        super().__init__(context=context)
        self._pinned_ips = tuple(pinned_ips)

    def https_open(self, req: urllib.request.Request) -> Any:
        return self.do_open(_PinnedHTTPSConnection, req, context=self._context, pinned_ips=self._pinned_ips)


def _get_env_proxies() -> dict[str, str]:
    """Read HTTP(S) proxies strictly from process environment variables, never OS system settings."""
    raw = urllib.request.getproxies_environment()
    return {
        k.lower(): v
        for k, v in raw.items()
        if k.lower() in ("http", "https") and isinstance(v, str) and v.strip()
    }


def has_env_proxy_for(scheme: str, host: str, port: int | None = None) -> bool:
    """Return True if an environment HTTP(S) proxy applies to the target host."""
    proxies = _get_env_proxies()
    if not proxies.get(scheme.lower()):
        return False
    hostport = f"{host}:{port}" if port is not None else host
    return not urllib.request.proxy_bypass_environment(hostport)


def build_safe_opener(*, bypass_proxy: bool, pinned_ips: Sequence[str] = ()) -> urllib.request.OpenerDirector:
    """Build OpenerDirector with NO cookies, NO auto-redirects, NO file/ftp handlers, NO OS proxies."""
    opener = urllib.request.OpenerDirector()
    ctx = ssl.create_default_context()
    use_pin = bypass_proxy and bool(pinned_ips)
    proxy_map = {} if bypass_proxy else _get_env_proxies()
    handlers = (
        urllib.request.ProxyHandler(proxy_map),
        PinnedHTTPHandler(pinned_ips) if use_pin else urllib.request.HTTPHandler(),
        PinnedHTTPSHandler(context=ctx, pinned_ips=pinned_ips) if use_pin else urllib.request.HTTPSHandler(context=ctx),
        urllib.request.HTTPDefaultErrorHandler(),
        urllib.request.HTTPErrorProcessor(),
    )
    for handler in handlers:
        opener.add_handler(handler)
    return opener


class SafeRedirectHandler:
    """Validates redirect hops; each hop is re-validated and IP-pinned by SafeHTTPFetcher."""

    def __init__(self, max_redirects: int = MAX_REDIRECTS) -> None:
        self.max_redirects = max_redirects

    def resolve_next_url(
        self, current_url: str, status: int, headers: Mapping[str, str], *, hops: int, allow_redirects: bool
    ) -> str:
        if not allow_redirects:
            raise SecurityError(f"Redirects are forbidden for this request (HTTP {status})")
        location = headers.get("location", "").strip()
        if not location or hops >= self.max_redirects:
            raise SecurityError(f"Redirect rejected or exceeded limit ({self.max_redirects})")
        return urllib.parse.urljoin(current_url, location)


def _lower_headers(raw_headers: Any) -> dict[str, str]:
    return {k.lower(): v for k, v in (raw_headers.items() if raw_headers else [])}


def _remaining_timeout(req_timeout: float, deadline: float | None) -> float:
    if deadline is None:
        return req_timeout
    rem = deadline - time.monotonic()
    if rem <= 0:
        raise TimeoutError("HTTP request exceeded total time budget")
    return min(req_timeout, rem)


def _set_response_socket_timeout(resp: Any, timeout_s: float) -> None:
    """Dynamically tighten the underlying socket timeout on an open HTTPResponse."""
    clamped = max(0.001, float(timeout_s))
    candidates: list[Any] = []
    fp = getattr(resp, "fp", None)
    if fp is not None:
        raw = getattr(fp, "raw", None)
        if raw is not None:
            candidates.append(getattr(raw, "_sock", None))
            candidates.append(raw)
        candidates.append(fp)
    candidates.append(getattr(resp, "_sock", None))
    candidates.append(getattr(resp, "sock", None))
    for obj in candidates:
        setter = getattr(obj, "settimeout", None)
        if callable(setter):
            try:
                setter(clamped)
                return
            except OSError:
                return


def _stream_bounded(
    resp: Any, max_bytes: int, sink: Callable[[bytes], Any], *,
    check_complete: bool = False,
    deadline: float | None = None,
    req_timeout: float | None = None,
) -> tuple[int, dict[str, str]]:
    hdrs = _lower_headers(resp.headers)
    cl_raw = hdrs.get("content-length", "").strip()
    if cl_raw.isdigit() and int(cl_raw) > max_bytes:
        raise SizeLimitExceededError(f"Response Content-Length exceeds {max_bytes} byte limit")
    read_fn = getattr(resp, "read1", None) if deadline is not None else None
    if not callable(read_fn):
        read_fn = resp.read
    total = 0
    while True:
        if deadline is not None:
            rem = deadline - time.monotonic()
            if rem <= 0:
                raise TimeoutError("HTTP response exceeded total time budget")
            effective_timeout = min(req_timeout, rem) if req_timeout is not None else rem
            _set_response_socket_timeout(resp, effective_timeout)
        try:
            chunk = read_fn(min(STREAM_CHUNK_BYTES, max_bytes - total + 1))
        except (socket.timeout, TimeoutError) as exc:
            raise TimeoutError("HTTP response read exceeded total time budget") from exc
        if deadline is not None and time.monotonic() > deadline:
            raise TimeoutError("HTTP response exceeded total time budget")
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
    """Zero-Cookie, anti-SSRF, IP-pinning, redirect-validating, size-bounded HTTP fetcher."""

    def __init__(
        self, *, timeout: float = 30.0, max_redirects: int = MAX_REDIRECTS, no_proxy: bool = False,
        resolver: Callable[..., list[Any]] | None = None, url_validator: Callable[..., Any] | None = None,
        opener_factory: Callable[[bool], urllib.request.OpenerDirector] | None = None,
        allowed_media_ports: frozenset[int] | None = STANDARD_HTTP_PORTS,
        allowed_loopback_origin: tuple[str, str, int] | None = None,
    ) -> None:
        self.timeout, self.max_redirects, self.no_proxy = timeout, max_redirects, bool(no_proxy)
        self._resolver, self._url_validator, self._opener_factory = resolver, url_validator, opener_factory
        self._allowed_media_ports = allowed_media_ports
        self._allowed_loopback_origin = allowed_loopback_origin
        self._redirects = SafeRedirectHandler(max_redirects=max_redirects)

    def _validate_hop(
        self, url: str, *, allow_loopback: bool, media_mode: bool,
        enforce_standard_ports: bool | None = None,
    ) -> tuple[urllib.parse.SplitResult, tuple[str, ...]]:
        if self._url_validator is None:
            use_std_ports = media_mode if enforce_standard_ports is None else enforce_standard_ports
            ports = self._allowed_media_ports if use_std_ports else None
            return validate_and_resolve_remote_url(
                url, allow_loopback=allow_loopback, resolve_dns=True,
                resolver=self._resolver, allowed_ports=ports,
                allowed_loopback_origin=self._allowed_loopback_origin,
            )
        res = self._url_validator(url, allow_loopback=allow_loopback, resolve_dns=True, resolver=self._resolver)
        return (res[0], tuple(res[1])) if (isinstance(res, tuple) and len(res) == 2) else (res, ())

    def _open_with_redirects(
        self, url: str, *, headers: Mapping[str, str] | None = None,
        headers_fn: Callable[[str, int], Mapping[str, str]] | None = None,
        allow_loopback: bool = False, allow_redirects: bool = True,
        media_mode: bool = True, enforce_standard_ports: bool | None = None,
        timeout: float | None = None,
        deadline: float | None = None,
    ) -> tuple[Any, str]:
        current, hops, req_timeout = url, 0, (self.timeout if timeout is None else timeout)
        prev_scheme: str | None = None
        while True:
            hop_timeout = _remaining_timeout(req_timeout, deadline)
            hop_allow_loopback = (
                (allow_loopback if hops == 0 else False)
                if self._allowed_loopback_origin is None
                else True
            )
            parsed, pinned_ips = self._validate_hop(
                current, allow_loopback=hop_allow_loopback, media_mode=media_mode,
                enforce_standard_ports=enforce_standard_ports,
            )
            curr_scheme = parsed.scheme.lower()
            if hops > 0 and prev_scheme == "https" and curr_scheme != "https":
                raise SecurityError("Refusing HTTPS-to-HTTP redirect downgrade")
            prev_scheme = curr_scheme
            stripped = ("cookie", "authorization", "proxy-authorization") if hops > 0 else ("cookie",)
            raw_headers = headers_fn(current, hops) if headers_fn is not None else headers
            req_headers = build_media_headers(current, extra_headers=raw_headers) if media_mode else {
                k: v for k, v in (raw_headers or {}).items() if k.lower().strip() not in stripped
            }
            host = (parsed.hostname or "").lower().rstrip(".")
            use_proxy = (not self.no_proxy) and (not is_loopback_host(host)) and has_env_proxy_for(curr_scheme, host, parsed.port)
            bypass = not use_proxy
            opener = self._opener_factory(bypass) if self._opener_factory is not None else build_safe_opener(bypass_proxy=bypass, pinned_ips=pinned_ips if bypass else ())
            hop_timeout = _remaining_timeout(req_timeout, deadline)
            try:
                resp = opener.open(urllib.request.Request(current, headers=req_headers, method="GET"), timeout=hop_timeout)
                if deadline is not None and time.monotonic() >= deadline:
                    resp.close()
                    raise TimeoutError("HTTP request exceeded total time budget")
                return resp, current
            except urllib.error.HTTPError as exc:
                hdrs = _lower_headers(exc.headers)
                if exc.code in (301, 302, 303, 307, 308):
                    exc.close()
                    current = self._redirects.resolve_next_url(current, exc.code, hdrs, hops=hops, allow_redirects=allow_redirects)
                    hops += 1
                    continue
                try:
                    err_body = exc.read(MAX_ERROR_BODY_BYTES)
                except Exception:
                    err_body = b""
                finally:
                    exc.close()
                raise HTTPStatusError(exc.code, current, hdrs, err_body) from exc
            except urllib.error.URLError as exc:
                if isinstance(exc.reason, (socket.timeout, TimeoutError)) or (
                    deadline is not None and time.monotonic() >= deadline
                ):
                    raise TimeoutError("HTTP request exceeded total time budget") from exc
                raise
            except (socket.timeout, TimeoutError) as exc:
                raise TimeoutError("HTTP request exceeded total time budget") from exc

    def open_url(
        self, url: str, *, headers: Mapping[str, str] | None = None,
        headers_fn: Callable[[str, int], Mapping[str, str]] | None = None,
        allow_loopback: bool = False, allow_redirects: bool = True,
        media_mode: bool = True, enforce_standard_ports: bool | None = None,
        timeout: float | None = None,
        deadline: float | None = None,
    ) -> tuple[Any, str]:
        """Open a validated, IP-pinned HTTP(S) response stream with redirect enforcement."""
        return self._open_with_redirects(
            url, headers=headers, headers_fn=headers_fn, allow_loopback=allow_loopback,
            allow_redirects=allow_redirects, media_mode=media_mode,
            enforce_standard_ports=enforce_standard_ports, timeout=timeout, deadline=deadline,
        )

    def fetch_bytes(
        self, url: str, *, max_bytes: int, headers: Mapping[str, str] | None = None,
        allow_loopback: bool = False, allow_redirects: bool = True, media_mode: bool = True,
        timeout: float | None = None, deadline: float | None = None,
    ) -> FetchResponse:
        req_timeout = self.timeout if timeout is None else timeout
        resp, final_url = self._open_with_redirects(
            url, headers=headers, allow_loopback=allow_loopback, allow_redirects=allow_redirects,
            media_mode=media_mode, timeout=req_timeout, deadline=deadline,
        )
        try:
            chunks: list[bytes] = []
            _, hdrs = _stream_bounded(
                resp, max_bytes, chunks.append, deadline=deadline, req_timeout=req_timeout,
            )
            return FetchResponse(int(getattr(resp, "status", 200)), final_url, hdrs, b"".join(chunks))
        finally:
            resp.close()

    def download_to_file(
        self, url: str, dest_part_path: Path, output_dir: Path, *,
        max_bytes: int = MAX_MEDIA_BYTES, headers: Mapping[str, str] | None = None,
        timeout: float | None = None, deadline: float | None = None,
    ) -> tuple[int, dict[str, str], str]:
        safe_part = resolve_jailed_path(output_dir, dest_part_path.name, allow_subdirs=False)
        req_timeout = self.timeout if timeout is None else timeout
        resp, final_url = self._open_with_redirects(
            url, headers=headers, allow_loopback=False, allow_redirects=True,
            media_mode=True, timeout=req_timeout, deadline=deadline,
        )
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(safe_part, flags, 0o600)
            with os.fdopen(fd, "wb") as handle:
                written, hdrs = _stream_bounded(
                    resp, max_bytes, handle.write, check_complete=True,
                    deadline=deadline, req_timeout=req_timeout,
                )
                handle.flush()
            return written, hdrs, final_url
        except Exception:
            if safe_part.exists() and not safe_part.is_symlink():
                safe_part.unlink()
            raise
        finally:
            resp.close()
