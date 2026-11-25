"""Explicit opt-in local downloader and optional ffmpeg muxer strictly jailed to --output-dir.

Zero third-party dependencies (Python 3.9+ standard library only).
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any, Callable, Sequence
import urllib.parse

from api_client import DokiToolClient
from security import (
    HTTPStatusError,
    MAX_MEDIA_BYTES,
    MAX_SUBTITLE_BYTES,
    SecurityError,
    redact_sensitive,
    resolve_jailed_path,
    sanitize_filename_stem,
    validate_output_dir,
)
from subtitles import extract_subtitles_from_data

_MIME_EXTS = {
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv",
    "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/aac": "aac", "audio/webm": "webm", "audio/ogg": "ogg",
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
}
_SAFE_MUX_CONTAINERS = frozenset({"mp4", "mkv", "webm", "mov"})
_EXT_RE = re.compile(r"^[a-z0-9]{2,5}$")


class DownloadError(RuntimeError):
    """Raised when media download or opt-in muxing fails."""


def _unlink_if_regular(path: Path | None) -> None:
    if path is not None and path.exists() and not path.is_symlink():
        path.unlink()


def _sniff_magic_ext(path: Path) -> str | None:
    try:
        with open(path, "rb") as handle:
            head = handle.read(32)
    except OSError:
        return None
    if len(head) >= 8 and head[4:8] == b"ftyp":
        brand = head[8:12] if len(head) >= 12 else b""
        return "m4a" if brand in (b"M4A ", b"M4B ") else ("mov" if brand == b"qt  " else "mp4")
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "gif"
    return "webm" if head.startswith(b"\x1a\x45\xdf\xa3") else None


def _infer_ext(meta: dict[str, Any] | None, headers: dict[str, str], url: str, part_path: Path) -> str:
    meta = meta or {}
    for key in ("extension", "container"):
        val = str(meta.get(key) or "").strip().lower().lstrip(".")
        if _EXT_RE.fullmatch(val) and val != "bin":
            return "jpg" if val == "jpeg" else val
    mime = (str(meta.get("mime_type") or "") or headers.get("content-type", "")).split(";")[0].strip().lower()
    if mime in _MIME_EXTS:
        return _MIME_EXTS[mime]
    path_ext = Path(urllib.parse.urlsplit(url).path).suffix.lower().lstrip(".")
    if path_ext in _MIME_EXTS.values():
        return path_ext
    return _sniff_magic_ext(part_path) or "bin"


def _collect_direct_urls(sources: list[Any], preferred_source_id: str | None = None) -> list[str]:
    ordered = [s for s in sources if isinstance(s, dict)]
    if preferred_source_id:
        ordered.sort(key=lambda s: 0 if s.get("id") == preferred_source_id else 1)
    urls: list[str] = []
    seen: set[str] = set()
    for src in ordered:
        if src.get("availability") == "unavailable" or src.get("access", "direct") == "relay":
            continue
        for raw in [src.get("url"), *(src.get("fallback_urls") or [])]:
            if isinstance(raw, str) and raw and raw not in seen:
                seen.add(raw)
                urls.append(raw)
    return urls


def _select_item(data: dict[str, Any], item_id: str | None) -> dict[str, Any]:
    items = [it for it in (data.get("items") or []) if isinstance(it, dict)]
    if not items:
        raise DownloadError("Parse result contains no media items")
    if item_id:
        match = next((it for it in items if it.get("id") == item_id), None)
        if match is None:
            raise DownloadError(f"Item not found: {item_id}")
        return match
    default_id = data.get("default_item_id")
    return next((it for it in items if default_id and it.get("id") == default_id), items[0])


def _select_variant(item: dict[str, Any], variant_id: str | None) -> tuple[dict[str, Any], str | None]:
    variants = [v for v in (item.get("variants") or []) if isinstance(v, dict) and v.get("state") != "deferred"]
    if not variants:
        raise DownloadError("Selected item has no ready variants")
    if variant_id:
        match = next((v for v in variants if v.get("id") == variant_id), None)
        if match is None:
            raise DownloadError(f"Variant not found: {variant_id}")
        return match, None
    default_sel = item.get("default")
    if isinstance(default_sel, dict) and default_sel.get("variant_id"):
        match = next((v for v in variants if v.get("id") == default_sel["variant_id"]), None)
        if match is not None:
            return match, default_sel.get("source_id")
    for kind in ("file", "pair", "mux"):
        match = next((v for v in variants if (v.get("delivery") or {}).get("kind") == kind), None)
        if match is not None:
            return match, None
    return variants[0], None


def _default_stem(data: dict[str, Any], item: dict[str, Any]) -> str:
    platform = sanitize_filename_stem(str(data.get("platform") or "media"), 20)
    raw_cid = str(data.get("content_id") or "") or hashlib.sha256(str(data.get("source_url") or "").encode()).hexdigest()[:12]
    return f"{platform}_{sanitize_filename_stem(raw_cid, 28)}_{sanitize_filename_stem(str(item.get('id') or 'item1'), 24)}"


def _download_routes_atomic(
    client: DokiToolClient, urls: list[str], output_dir: Path, stem: str,
    meta: dict[str, Any] | None, *, explicit_filename: str | None, max_bytes: int,
) -> tuple[Path, int, bool]:
    """Download first succeeding route to a jailed temp file, then atomically os.replace."""
    part_path = resolve_jailed_path(output_dir, f".{sanitize_filename_stem(stem, 60)}.{os.getpid()}.part", allow_subdirs=False)
    saw_expired = False
    last_err: Exception | None = None
    for url in urls:
        try:
            written, hdrs, final_url = client.fetcher.download_to_file(url, part_path, output_dir, max_bytes=max_bytes)
            if written <= 0:
                raise DownloadError("Downloaded file is empty")
            target_name = explicit_filename if explicit_filename is not None else f"{stem}.{_infer_ext(meta, hdrs, final_url, part_path)}"
            final_path = resolve_jailed_path(output_dir, target_name, allow_subdirs=False)
            os.replace(part_path, final_path)
            return final_path, written, False
        except SecurityError:
            _unlink_if_regular(part_path)
            raise
        except HTTPStatusError as exc:
            _unlink_if_regular(part_path)
            last_err = exc
            if exc.status in (403, 410):
                saw_expired = True
        except Exception as exc:
            _unlink_if_regular(part_path)
            last_err = exc
    if saw_expired:
        return part_path, 0, True
    raise DownloadError(f"All {len(urls)} CDN routes failed: {redact_sensitive(str(last_err))}")


def _mux_with_ffmpeg(
    video_path: Path, audio_path: Path, final_path: Path,
    output_dir: Path, container: str, subprocess_runner: Callable[..., Any],
) -> int:
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise DownloadError("ffmpeg binary was not found on PATH")
    safe_container = container if container in _SAFE_MUX_CONTAINERS else "mp4"
    v_safe = resolve_jailed_path(output_dir, video_path.name, allow_subdirs=False)
    a_safe = resolve_jailed_path(output_dir, audio_path.name, allow_subdirs=False)
    f_safe = resolve_jailed_path(output_dir, final_path.name, allow_subdirs=False)
    tmp_out = resolve_jailed_path(output_dir, f".mux.{os.getpid()}.{f_safe.name}", allow_subdirs=False)
    for p in (v_safe, a_safe, tmp_out):
        if str(p).startswith("-") or ":" in p.name:
            raise SecurityError("Unsafe path rejected before ffmpeg invocation")
    cmd = [
        ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-protocol_whitelist", "file", "-i", str(v_safe), "-i", str(a_safe),
        "-c", "copy", "-f", safe_container, str(tmp_out),
    ]
    try:
        proc = subprocess_runner(cmd, shell=False, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        if getattr(proc, "returncode", 1) != 0:
            raw_err = getattr(proc, "stderr", b"")
            err_text = raw_err.decode("utf-8", errors="replace") if isinstance(raw_err, bytes) else str(raw_err)
            raise DownloadError(f"ffmpeg mux failed (exit {proc.returncode}): {redact_sensitive(err_text.strip())}")
        os.replace(tmp_out, f_safe)
        return f_safe.stat().st_size
    finally:
        _unlink_if_regular(tmp_out)


def write_subtitle_files(
    extracted_tracks: Sequence[dict[str, Any]], output_dir: Path, *,
    allow_write: bool, stem_prefix: str = "subtitle",
) -> list[dict[str, Any]]:
    """Atomically save extracted subtitle payloads inside jailed output_dir."""
    if not allow_write:
        raise SecurityError("Local file write is disabled; pass --allow-write --output-dir <dir>")
    root = validate_output_dir(output_dir, create=True)
    saved: list[dict[str, Any]] = []
    safe_prefix = sanitize_filename_stem(stem_prefix, 48)
    for idx, track in enumerate(extracted_tracks, start=1):
        lang = sanitize_filename_stem(str(track.get("language") or f"track{idx}"), 20)
        kind = sanitize_filename_stem(str(track.get("track_kind") or "sub"), 12)
        out_fmt = str(track.get("output_format") or "txt").lower()
        raw_ext = "txt" if out_fmt == "text" else (track.get("source_format") or "vtt" if out_fmt == "raw" else out_fmt)
        filename = f"{safe_prefix}.{lang}.{kind}.{sanitize_filename_stem(str(raw_ext), 8)}"
        target = resolve_jailed_path(root, filename, allow_subdirs=False)
        tmp = resolve_jailed_path(root, f".{filename}.{os.getpid()}.part", allow_subdirs=False)
        content_bytes = str(track.get("content") or "").encode("utf-8")
        try:
            with open(tmp, "wb") as handle:
                handle.write(content_bytes)
                handle.flush()
            os.replace(tmp, target)
        finally:
            _unlink_if_regular(tmp)
        saved.append({"file": target.name, "bytes": len(content_bytes), "language": track.get("language"), "track_kind": track.get("track_kind")})
    return saved


def _download_variant_files(
    client: DokiToolClient, variant: dict[str, Any], preferred_source_id: str | None,
    root: Path, stem: str, *, explicit_filename: str | None, allow_ffmpeg: bool,
    max_media_bytes: int, subprocess_runner: Callable[..., Any],
) -> tuple[list[dict[str, Any]], bool]:
    delivery = variant.get("delivery") or {}
    kind = delivery.get("kind")
    if kind == "file":
        urls = _collect_direct_urls(delivery.get("sources") or [], preferred_source_id)
        if not urls:
            return [], True
        path, nbytes, expired = _download_routes_atomic(
            client, urls, root, stem, variant.get("metadata"),
            explicit_filename=explicit_filename, max_bytes=max_media_bytes,
        )
        return ([], True) if expired else ([{"role": "main", "file": path.name, "bytes": nbytes}], False)
    if kind == "pair":
        saved: list[dict[str, Any]] = []
        for res in delivery.get("resources") or []:
            res_del = res.get("delivery") or {}
            if res_del.get("kind") != "file":
                continue
            role = sanitize_filename_stem(str(res.get("role") or "part"), 16)
            urls = _collect_direct_urls(res_del.get("sources") or [])
            if not urls:
                return [], True
            path, nbytes, expired = _download_routes_atomic(
                client, urls, root, f"{stem}_{role}", res.get("metadata"),
                explicit_filename=None, max_bytes=max_media_bytes,
            )
            if expired:
                return [], True
            saved.append({"role": role, "file": path.name, "bytes": nbytes})
        return saved, False
    if kind == "mux":
        if not allow_ffmpeg:
            raise DownloadError("Selected variant requires muxing; restart or invoke with --allow-ffmpeg")
        resources = delivery.get("resources") or []
        v_res = next((r for r in resources if r.get("role") == "video"), None)
        a_res = next((r for r in resources if r.get("role") == "audio"), None)
        if not v_res or not a_res:
            raise DownloadError("Mux variant is missing video or audio resource")
        v_urls = _collect_direct_urls((v_res.get("delivery") or {}).get("sources") or [])
        a_urls = _collect_direct_urls((a_res.get("delivery") or {}).get("sources") or [])
        if not v_urls or not a_urls:
            return [], True
        v_path, a_path = None, None
        try:
            v_path, _, v_exp = _download_routes_atomic(
                client, v_urls, root, f"{stem}_video_tmp", v_res.get("metadata"),
                explicit_filename=None, max_bytes=max_media_bytes,
            )
            if v_exp:
                return [], True
            a_path, _, a_exp = _download_routes_atomic(
                client, a_urls, root, f"{stem}_audio_tmp", a_res.get("metadata"),
                explicit_filename=None, max_bytes=max_media_bytes,
            )
            if a_exp:
                return [], True
            out_meta = delivery.get("output") if isinstance(delivery.get("output"), dict) else {}
            out_ext = sanitize_filename_stem(str(out_meta.get("extension") or "mp4"), 8)
            final_path = resolve_jailed_path(root, explicit_filename or f"{stem}.{out_ext}", allow_subdirs=False)
            nbytes = _mux_with_ffmpeg(v_path, a_path, final_path, root, str(out_meta.get("container") or out_ext).lower(), subprocess_runner)
            return [{"role": "muxed", "file": final_path.name, "bytes": nbytes}], False
        finally:
            _unlink_if_regular(v_path)
            _unlink_if_regular(a_path)
    raise DownloadError(f"Unsupported delivery kind for local download: {kind}")


def download_media(
    client: DokiToolClient, share_url: str, output_dir: Path, *,
    allow_write: bool, allow_ffmpeg: bool = False, platform: str | None = None,
    item_id: str | None = None, variant_id: str | None = None, filename: str | None = None,
    include_subtitles: bool = False, subtitle_lang: str | None = None,
    subtitle_kind: str = "all", subtitle_format: str = "vtt",
    max_media_bytes: int = MAX_MEDIA_BYTES, subprocess_runner: Callable[..., Any] = subprocess.run,
) -> dict[str, Any]:
    """Parse, optionally resolve/refresh once, and atomically save media inside jailed output_dir."""
    if not allow_write:
        raise SecurityError("Local file write is disabled; explicit --allow-write --output-dir is required")
    root = validate_output_dir(output_dir, create=True)
    if filename is not None:
        resolve_jailed_path(root, filename, allow_subdirs=False)

    data = client.parse(share_url, platform=platform)["data"]
    item = _select_item(data, item_id)
    resolve_url = item.get("resolve_url")
    if item.get("state") == "deferred":
        if not isinstance(resolve_url, str) or not resolve_url:
            raise DownloadError("Deferred item cannot be downloaded without resolve_url")
        data = client.resolve(resolve_url)["data"]
        item = _select_item(data, item.get("id"))
    if item.get("state", "ready") != "ready":
        raise DownloadError(f"Item is not ready (state={item.get('state')})")

    variant, preferred_source_id = _select_variant(item, variant_id)
    stem = _default_stem(data, item)
    files, expired = _download_variant_files(
        client, variant, preferred_source_id, root, stem,
        explicit_filename=filename, allow_ffmpeg=allow_ffmpeg,
        max_media_bytes=max_media_bytes, subprocess_runner=subprocess_runner,
    )
    if expired:
        data = client.refresh(data, fallback_url=share_url, item_resolve_url=resolve_url)["data"]
        item = _select_item(data, item.get("id"))
        variant, preferred_source_id = _select_variant(item, variant_id)
        files, still_expired = _download_variant_files(
            client, variant, preferred_source_id, root, stem,
            explicit_filename=filename, allow_ffmpeg=allow_ffmpeg,
            max_media_bytes=max_media_bytes, subprocess_runner=subprocess_runner,
        )
        if still_expired or not files:
            raise DownloadError("CDN links remained expired (403/410) after refresh")

    sub_files: list[dict[str, Any]] = []
    if include_subtitles:
        sub_res = extract_subtitles_from_data(
            data, client.fetcher, lang=subtitle_lang, track_kind=subtitle_kind,
            output_format=subtitle_format, max_bytes=MAX_SUBTITLE_BYTES,
        )
        if sub_res["tracks"]:
            sub_files = write_subtitle_files(sub_res["tracks"], root, allow_write=True, stem_prefix=stem)
    return {
        "platform": data.get("platform"), "content_id": data.get("content_id"),
        "item_id": item.get("id"), "variant_id": variant.get("id"),
        "output_dir": str(root), "files": files, "subtitle_files": sub_files,
    }
