#!/usr/bin/env python3
"""Minimal standalone batch downloader for the DokiTool Personal Agent API.

Uses the Python 3.9+ standard library only (zero third-party or repo imports).
Reads the owner token exclusively from the DOKITOOL_OWNER_TOKEN environment
variable, sends it only via the Authorization: Bearer header (never in URL query
parameters, where tokens are ignored as anonymous visitor requests without error
while leaking into access logs and shell history), and never forwards
Authorization or Cookie headers to media CDNs.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import random
import re
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


def validate_api_base(api_base: str) -> str:
    cleaned = api_base.strip().rstrip("/")
    parsed = urllib.parse.urlsplit(cleaned)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    if scheme not in {"http", "https"} or not host or parsed.query or parsed.fragment:
        raise ValueError("Invalid --api-base URL")
    if scheme == "http" and host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("Refusing to send Bearer token over plaintext HTTP to non-loopback host")
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
    if re.fullmatch(r"[a-z0-9]{2,5}", raw_ext) and raw_ext != "bin":
        return raw_ext

    by_mime = extension_from_content_type(str(meta.get("mime_type") or ""))
    if by_mime:
        return by_mime

    raw_container = str(meta.get("container") or "").strip().lower().lstrip(".")
    raw_container = CONTAINER_ALIASES.get(raw_container, raw_container)
    if re.fullmatch(r"[a-z0-9]{2,5}", raw_container) and raw_container != "bin":
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
    root = output_dir.resolve()
    candidate = (root / filename).resolve()
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
        # Dedicated opener without HTTPCookieProcessor so zero cookies are ever stored or sent.
        self.cdn_opener = urllib.request.build_opener()

    def api_get(self, path_and_query: str) -> dict:
        url = f"{self.api_base}{path_and_query}"
        transient_attempts = 0
        rate_limit_attempts = 0

        while True:
            if self.abort_event.is_set():
                raise FatalAuthError("Aborted due to earlier HTTP 401 authentication failure")

            req = urllib.request.Request(
                url,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/json",
                    "User-Agent": "DokiToolAgentBatchExample/1.0",
                },
                method="GET",
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                    if payload.get("code") != "OK":
                        err = payload.get("error") or {}
                        raise PermanentAPIError(
                            resp.status,
                            str(err.get("code") or payload.get("code") or "UNKNOWN"),
                            str(err.get("message") or "Unexpected non-OK response"),
                        )
                    return payload
            except urllib.error.HTTPError as exc:
                raw_body = exc.read().decode("utf-8", errors="replace")
                try:
                    body = json.loads(raw_body)
                except ValueError:
                    body = {}
                err = body.get("error") if isinstance(body.get("error"), dict) else {}
                code = str(err.get("code") or body.get("code") or f"HTTP_{exc.code}")
                message = str(err.get("message") or exc.reason or "HTTP error")
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
            except (urllib.error.URLError, TimeoutError) as exc:
                if transient_attempts < 2:
                    transient_attempts += 1
                    self._sleep(2.0 * transient_attempts)
                    continue
                raise PermanentAPIError(0, "NETWORK_ERROR", str(exc)) from exc

    def parse_url(self, share_url: str) -> dict:
        qs = urllib.parse.urlencode({"schema_version": "1.0", "url": share_url})
        return self.api_get(f"/api/parse?{qs}")

    def resolve_item(self, resolve_url: str) -> dict:
        if not resolve_url.startswith("/api/resolve?"):
            raise PermanentAPIError(400, "INVALID_RESOLVE_URL", "Refusing unexpected resolve_url path")
        return self.api_get(resolve_url)

    def probe_throughput(self, routes: list[dict]) -> list[dict]:
        if len(routes) <= 1:
            return routes
        scored: list[tuple[float, int, dict]] = []
        for idx, route in enumerate(routes[:3]):
            start = time.monotonic()
            req = urllib.request.Request(
                route["url"],
                headers=cdn_headers_for_url(route["url"], 0, PROBE_BYTES - 1),
                method="GET",
            )
            try:
                with self.cdn_opener.open(req, timeout=8.0) as resp:
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
    opener: urllib.request.OpenerDirector,
    route: dict,
    task: dict,
) -> tuple[Path, int]:
    output_dir: Path = task["output_dir"]
    stem: str = task["stem"]
    metadata: dict | None = task.get("metadata")
    result_url: str = str(task.get("result_url") or "")
    part_path = safe_output_path(output_dir, f"{stem}.part")
    expected_size = route.get("size_bytes")
    known_ext = infer_extension_from_result(metadata, result_url, route_url=route["url"])

    if not part_path.is_file():
        existing = find_existing_complete_file(output_dir, stem, known_ext, expected_size)
        if existing is not None:
            return existing

    offset = part_path.stat().st_size if part_path.is_file() else 0
    if expected_size is not None and offset >= expected_size:
        part_path.unlink(missing_ok=True)
        offset = 0

    req = urllib.request.Request(
        route["url"],
        headers=cdn_headers_for_url(route["url"], byte_offset=offset),
        method="GET",
    )
    with opener.open(req, timeout=45.0) as resp:
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
            raise urllib.error.HTTPError(route["url"], status, "Unexpected CDN status", resp.headers, None)

        with open(part_path, mode) as handle:
            while True:
                chunk = resp.read(CHUNK_BYTES)
                if not chunk:
                    break
                handle.write(chunk)
                written += len(chunk)
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
        route_url=route["url"],
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
            final_path, saved_bytes = download_single_route(client.cdn_opener, route, task)
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
    raise RuntimeError(f"All {len(candidates)} CDN routes failed: {last_err}")


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
                "message": str(exc),
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
