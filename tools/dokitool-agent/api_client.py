"""Unified-v1 API client and normalized summary builders for dokitool-agent.

Zero third-party dependencies (Python 3.9+ standard library only).
"""
from __future__ import annotations

import json
import random
import time
from typing import Any, Callable
import urllib.error
import urllib.parse

from security import (
    DEFAULT_API_BASE,
    DEFAULT_USER_AGENT,
    HTTPStatusError,
    MAX_JSON_BYTES,
    SafeHTTPFetcher,
    SecurityError,
    load_api_token,
    redact_sensitive,
    validate_api_base,
    validate_token,
)

SCHEMA_VERSION = "1.0"
_VALID_API_PATHS = frozenset({"/api/platforms", "/api/parse", "/api/resolve"})


class DokiToolAPIError(RuntimeError):
    """Unified-v1 API failure with sanitized error message."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        retry_after: int | None = None,
    ) -> None:
        clean_msg = redact_sensitive(message)
        super().__init__(f"HTTP {status} {code}: {clean_msg}")
        self.status = status
        self.code = code
        self.api_message = clean_msg
        self.retryable = retryable
        self.retry_after = retry_after


class DokiToolAuthError(DokiToolAPIError):
    """Raised immediately on HTTP 401 so callers stop without exhausting IP burst limits."""


def _validate_api_relative_path(
    path_and_query: str,
    *,
    required_path: str | None = None,
    require_query: bool = False,
) -> str:
    cleaned = (path_and_query or "").strip()
    if not cleaned or any(ord(ch) <= 0x20 or ord(ch) >= 0x7F or ch in ("\\", "#") for ch in cleaned):
        raise SecurityError("Invalid API relative path")
    if cleaned.startswith("//"):
        raise SecurityError("API path must be a clean same-origin relative /api/ path")
    parsed = urllib.parse.urlsplit(cleaned)
    if parsed.scheme or parsed.netloc or parsed.fragment:
        raise SecurityError("API path must not contain scheme, host, or fragment")
    decoded_path = urllib.parse.unquote(parsed.path)
    if ".." in parsed.path.split("/") or ".." in decoded_path.split("/") or "//" in parsed.path:
        raise SecurityError("Path traversal segments are forbidden in API path")
    if required_path is not None:
        if parsed.path != required_path:
            raise SecurityError(f"Expected exact API path {required_path}")
    elif parsed.path not in _VALID_API_PATHS:
        raise SecurityError(f"Unsupported API path: {parsed.path}")
    if require_query and not parsed.query:
        raise SecurityError(f"API path {parsed.path} requires query parameters")
    return cleaned


def _parse_error_payload(body: bytes, status: int) -> tuple[str, str, bool, int | None]:
    raw_text = body.decode("utf-8", errors="replace")
    try:
        payload = json.loads(raw_text) if raw_text else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    err = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    code = str(err.get("code") or payload.get("code") or f"HTTP_{status}")
    message = str(err.get("message") or f"HTTP {status} error")
    retryable = bool(err.get("retryable"))
    retry_after = err.get("retry_after_seconds")
    if not isinstance(retry_after, int) or retry_after < 1:
        retry_after = None
    return code, redact_sensitive(message), retryable, retry_after


def _compute_backoff(
    attempt: int,
    *,
    retry_after: int | None,
    headers: dict[str, str],
    base_delay: float = 1.0,
) -> float:
    if retry_after is not None and retry_after >= 1:
        wait = float(min(60, retry_after))
    else:
        hdr = headers.get("retry-after", "").strip()
        if hdr.isdigit() and int(hdr) >= 1:
            wait = float(min(60, int(hdr)))
        else:
            wait = min(60.0, base_delay * (2 ** max(0, attempt - 1)))
    return wait + random.uniform(0.05, 0.25)


class DokiToolClient:
    """Client for DokiTool Unified Media v1 endpoints with env-only Bearer auth and backoff."""

    def __init__(
        self,
        api_base: str = DEFAULT_API_BASE,
        *,
        token: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 3,
        no_proxy: bool = False,
        sleep_fn: Callable[[float], None] = time.sleep,
        fetcher: SafeHTTPFetcher | None = None,
    ) -> None:
        self.api_base = validate_api_base(api_base)
        self._token = validate_token(token) if token is not None else load_api_token(required=False)
        self.timeout = timeout
        self.max_retries = max(0, int(max_retries))
        self.no_proxy = bool(no_proxy)
        self._sleep = sleep_fn
        self.fetcher = fetcher or SafeHTTPFetcher(timeout=timeout, no_proxy=self.no_proxy)

    @property
    def has_token(self) -> bool:
        return bool(self._token)

    def _auth_headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json", "User-Agent": DEFAULT_USER_AGENT}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    def api_get(self, path_and_query: str) -> dict[str, Any]:
        rel = _validate_api_relative_path(path_and_query)
        url = f"{self.api_base}{rel}"
        rate_attempts = 0
        transient_attempts = 0

        while True:
            try:
                resp = self.fetcher.fetch_bytes(
                    url,
                    max_bytes=MAX_JSON_BYTES,
                    headers=self._auth_headers(),
                    allow_loopback=True,
                    allow_redirects=False,
                    media_mode=False,
                    timeout=self.timeout,
                )
            except HTTPStatusError as exc:
                code, message, retryable, retry_after = _parse_error_payload(exc.body, exc.status)
                if exc.status == 401:
                    raise DokiToolAuthError(
                        401,
                        code,
                        f"{message} (verify DOKITOOL_API_TOKEN / DOKITOOL_OWNER_TOKEN)",
                        retryable=False,
                    ) from exc
                if exc.status == 429:
                    rate_attempts += 1
                    if rate_attempts <= self.max_retries:
                        self._sleep(
                            _compute_backoff(rate_attempts, retry_after=retry_after, headers=exc.headers)
                        )
                        continue
                    raise DokiToolAPIError(
                        429, code, f"{message} (rate limit retries exhausted)",
                        retryable=True, retry_after=retry_after,
                    ) from exc
                if exc.status == 503 and retryable and code != "SERVICE_NOT_CONFIGURED":
                    transient_attempts += 1
                    if transient_attempts <= self.max_retries:
                        self._sleep(
                            _compute_backoff(
                                transient_attempts,
                                retry_after=retry_after,
                                headers=exc.headers,
                                base_delay=1.5,
                            )
                        )
                        continue
                if exc.status in (502, 504) and retryable:
                    transient_attempts += 1
                    if transient_attempts <= min(2, self.max_retries):
                        self._sleep(
                            _compute_backoff(
                                transient_attempts,
                                retry_after=retry_after,
                                headers=exc.headers,
                                base_delay=1.5,
                            )
                        )
                        continue
                raise DokiToolAPIError(
                    exc.status, code, message, retryable=retryable, retry_after=retry_after
                ) from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                transient_attempts += 1
                if transient_attempts <= min(2, self.max_retries):
                    self._sleep(min(10.0, 1.0 * (2 ** (transient_attempts - 1))))
                    continue
                raise DokiToolAPIError(0, "NETWORK_ERROR", redact_sensitive(str(exc)), retryable=True) from exc

            try:
                payload = json.loads(resp.body.decode("utf-8"))
            except (UnicodeDecodeError, ValueError) as exc:
                raise DokiToolAPIError(resp.status, "INVALID_JSON", "Server returned malformed JSON") from exc
            if not isinstance(payload, dict):
                raise DokiToolAPIError(resp.status, "INVALID_JSON", "Server returned non-object JSON")
            if payload.get("code") != "OK":
                err = payload.get("error") if isinstance(payload.get("error"), dict) else {}
                raise DokiToolAPIError(
                    resp.status,
                    str(err.get("code") or payload.get("code") or "UNKNOWN"),
                    str(err.get("message") or "API returned non-OK code"),
                    retryable=bool(err.get("retryable")),
                )
            return payload

    def list_platforms(self) -> dict[str, Any]:
        qs = urllib.parse.urlencode({"schema_version": SCHEMA_VERSION})
        return self.api_get(f"/api/platforms?{qs}")

    def parse(self, url: str, *, platform: str | None = None, debug: bool = False) -> dict[str, Any]:
        cleaned = (url or "").strip()
        if not cleaned:
            raise DokiToolAPIError(400, "INVALID_INPUT", "URL or share text must not be empty")
        params: dict[str, str] = {"schema_version": SCHEMA_VERSION, "url": cleaned}
        if platform and platform.strip().lower() != "all":
            params["platform"] = platform.strip()
        if debug:
            params["debug"] = "1"
        qs = urllib.parse.urlencode(params)
        return self.api_get(f"/api/parse?{qs}")

    def resolve(self, resolve_url: str) -> dict[str, Any]:
        rel = _validate_api_relative_path(resolve_url, required_path="/api/resolve", require_query=True)
        return self.api_get(rel)

    def refresh(
        self,
        data: dict[str, Any],
        *,
        fallback_url: str | None = None,
        item_resolve_url: str | None = None,
    ) -> dict[str, Any]:
        """Refresh expired URLs via resolve_url -> data.refresh_url -> re-parse fallback."""
        if isinstance(item_resolve_url, str) and item_resolve_url.strip():
            return self.resolve(item_resolve_url)
        refresh_url = data.get("refresh_url")
        if isinstance(refresh_url, str) and refresh_url.strip():
            rel = _validate_api_relative_path(refresh_url, required_path="/api/parse", require_query=True)
            return self.api_get(rel)
        target_url = fallback_url or (data.get("source_url") if isinstance(data.get("source_url"), str) else None)
        if target_url:
            return self.parse(target_url)
        raise DokiToolAPIError(400, "REFRESH_UNAVAILABLE", "No resolve_url, refresh_url, or source_url available")


def summarize_platforms(envelope: dict[str, Any]) -> dict[str, Any]:
    data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
    raw_list = data.get("platforms") if isinstance(data.get("platforms"), list) else []
    platforms = [
        {
            "id": p.get("id"),
            "name": p.get("name"),
            "site_url": p.get("site_url"),
            "capabilities": list(p.get("capabilities") or []),
        }
        for p in raw_list
        if isinstance(p, dict)
    ]
    return {"count": len(platforms), "platforms": platforms}


def _summarize_variant(variant: dict[str, Any]) -> dict[str, Any]:
    meta = variant.get("metadata") if isinstance(variant.get("metadata"), dict) else {}
    delivery = variant.get("delivery") if isinstance(variant.get("delivery"), dict) else {}
    sources = delivery.get("sources") if isinstance(delivery.get("sources"), list) else []
    resources = delivery.get("resources") if isinstance(delivery.get("resources"), list) else []
    out: dict[str, Any] = {
        "id": variant.get("id"),
        "label": variant.get("label"),
        "state": variant.get("state", "ready"),
        "delivery_kind": delivery.get("kind"),
        "source_count": len(sources) if sources else len(resources),
    }
    for key in ("width", "height", "fps", "has_audio", "video_codec", "audio_codec", "extension", "mime_type"):
        if key in meta:
            out[key] = meta[key]
    return out


def _summarize_subtitles(attachments: list[Any]) -> list[dict[str, Any]]:
    tracks: list[dict[str, Any]] = []
    for att in attachments:
        if not isinstance(att, dict) or att.get("role") != "subtitle":
            continue
        res = att.get("resource") if isinstance(att.get("resource"), dict) else {}
        meta = res.get("metadata") if isinstance(res.get("metadata"), dict) else {}
        delivery = res.get("delivery") if isinstance(res.get("delivery"), dict) else {}
        sources = delivery.get("sources") if isinstance(delivery.get("sources"), list) else []
        primary_url = sources[0].get("url") if sources and isinstance(sources[0], dict) else None
        tracks.append({
            "id": att.get("id"),
            "language": att.get("language") or "",
            "title": att.get("title") or att.get("language") or "",
            "track_kind": att.get("track_kind") or "unknown",
            "format": meta.get("extension") or meta.get("container") or "",
            "mime_type": meta.get("mime_type") or "",
            "url": primary_url,
        })
    return tracks


def summarize_parse_result(envelope: dict[str, Any], *, include_raw: bool = False) -> dict[str, Any]:
    """Produce a compact, agent-friendly view of a unified-v1 parse/resolve envelope."""
    data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
    raw_items = data.get("items") if isinstance(data.get("items"), list) else []
    items_summary: list[dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        variants = item.get("variants") if isinstance(item.get("variants"), list) else []
        entry: dict[str, Any] = {
            "id": item.get("id"),
            "type": item.get("type"),
            "state": item.get("state", "ready"),
            "title": item.get("title"),
            "duration_ms": item.get("duration_ms"),
            "default": item.get("default"),
            "variants": [_summarize_variant(v) for v in variants if isinstance(v, dict)],
        }
        if item.get("resolve_url"):
            entry["resolve_url"] = item["resolve_url"]
        if item.get("default_unavailable_reason"):
            entry["default_unavailable_reason"] = item["default_unavailable_reason"]
        if isinstance(item.get("error"), dict):
            entry["error"] = item["error"]
        items_summary.append(entry)

    author = data.get("author") if isinstance(data.get("author"), dict) else None
    summary: dict[str, Any] = {
        "platform": data.get("platform"),
        "content_id": data.get("content_id"),
        "title": data.get("title"),
        "author": {"id": author.get("id"), "name": author.get("name")} if author else None,
        "source_url": data.get("source_url"),
        "generated_at": data.get("generated_at"),
        "refresh_url": data.get("refresh_url"),
        "default_item_id": data.get("default_item_id"),
        "items": items_summary,
        "subtitles": _summarize_subtitles(data.get("attachments") or []),
    }
    if envelope.get("warnings"):
        summary["warnings"] = envelope["warnings"]
    if include_raw:
        summary["raw"] = envelope
    return summary
