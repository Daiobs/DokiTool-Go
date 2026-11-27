"""Explicit opt-in local downloader and optional ffmpeg muxer strictly jailed to --output-dir.

Zero third-party dependencies (Python 3.9+ standard library only).
"""
from __future__ import annotations

import errno
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import stat
import subprocess
from typing import Any, Callable, Sequence
import urllib.parse

from api_client import DokiToolClient
from security import (
    HTTPStatusError, MAX_MEDIA_BYTES, MAX_SUBTITLE_BYTES, SecurityError,
    redact_sensitive, resolve_jailed_path, sanitize_filename_stem, validate_output_dir,
)
from subtitles import extract_subtitles_from_data

_MIME_EXTS = {
    "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-matroska": "mkv",
    "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/aac": "aac", "audio/webm": "webm", "audio/ogg": "ogg",
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
}
_ALLOWED_MEDIA_EXTS = frozenset({
    *_MIME_EXTS.values(), "jpeg", "flac", "wav", "opus", "m4v", "ts", "avif", "heic", "heif", "vtt", "srt", "ttml",
})
_ALLOWED_SUBTITLE_EXTS = frozenset({"txt", "vtt", "srt", "ttml", "srv3", "json3", "xml"})
_SAFE_MUX_FORMATS = {"mp4": "mp4", "mkv": "matroska", "matroska": "matroska", "webm": "webm", "mov": "mov"}


class DownloadError(RuntimeError):
    """Raised when media download or opt-in muxing fails."""


def _unlink_if_regular(path: Path | None) -> None:
    if path is not None and path.exists() and not path.is_symlink():
        path.unlink()


def _unlink_if_same_file(path: Path, expected_id: tuple[int, int]) -> None:
    try:
        st = os.lstat(path)
    except OSError:
        return
    if stat.S_ISREG(st.st_mode) and (st.st_dev, st.st_ino) == expected_id:
        try:
            path.unlink()
        except OSError:
            pass


def _commit_atomic_file(tmp_path: Path, final_path: Path, *, overwrite: bool) -> tuple[int, int]:
    """Atomically publish tmp_path to final_path; refuse clobber unless overwrite=True."""
    st = os.lstat(tmp_path)
    file_id = (st.st_dev, st.st_ino)
    if overwrite:
        os.replace(tmp_path, final_path)
        return file_id
    try:
        os.link(tmp_path, final_path)
    except FileExistsError as exc:
        raise DownloadError(
            f"Target file already exists (no-clobber default): {final_path.name}; pass --overwrite to replace"
        ) from exc
    except OSError as exc:
        if exc.errno in (errno.EPERM, errno.EXDEV, errno.ENOTSUP, getattr(errno, "EOPNOTSUPP", errno.ENOTSUP)):
            if final_path.exists() or final_path.is_symlink():
                raise DownloadError(
                    f"Target file already exists (no-clobber default): {final_path.name}; pass --overwrite to replace"
                ) from exc
            os.replace(tmp_path, final_path)
            return file_id
        raise
    else:
        tmp_path.unlink()
        return file_id


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


def _validate_explicit_filename(output_dir: Path, filename: str) -> Path:
    """Validate an explicit --filename target inside output_dir against a strict passive extension allowlist."""
    target = resolve_jailed_path(output_dir, filename, allow_subdirs=False)
    name = target.name
    if name.startswith(".") or name.startswith("-"):
        raise SecurityError("Refusing hidden dotfile or hyphen-prefixed target filename")
    ext = target.suffix.lower().lstrip(".")
    if not ext or ext not in _ALLOWED_MEDIA_EXTS:
        raise SecurityError(
            f"Refusing unsupported target filename extension: .{ext or '<none>'} (allowed passive media/subtitle formats only)"
        )
    return target


def _infer_ext(meta: dict[str, Any] | None, headers: dict[str, str], url: str, part_path: Path) -> str:
    meta = meta or {}
    for key in ("extension", "container"):
        val = str(meta.get(key) or "").strip().lower().lstrip(".")
        if val == "jpeg":
            val = "jpg"
        if val in _ALLOWED_MEDIA_EXTS:
            return val
    mime = (str(meta.get("mime_type") or "") or headers.get("content-type", "")).split(";")[0].strip().lower()
    if mime in _MIME_EXTS:
        return _MIME_EXTS[mime]
    path_ext = Path(urllib.parse.urlsplit(url).path).suffix.lower().lstrip(".")
    if path_ext == "jpeg":
        path_ext = "jpg"
    if path_ext in _ALLOWED_MEDIA_EXTS:
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


def _download_routes_to_staged_part(
    client: DokiToolClient, urls: list[str], output_dir: Path, stem: str,
    meta: dict[str, Any] | None, *, explicit_filename: str | None, max_bytes: int,
) -> tuple[Path, Path, int, bool]:
    """Download first succeeding route into a jailed hidden temp file without committing yet."""
    part_path = resolve_jailed_path(
        output_dir, f".{sanitize_filename_stem(stem, 52)}.{os.getpid()}.{secrets.token_hex(4)}.part", allow_subdirs=False
    )
    saw_expired = False
    last_err: Exception | None = None
    for url in urls:
        try:
            written, hdrs, final_url = client.fetcher.download_to_file(url, part_path, output_dir, max_bytes=max_bytes)
            if written <= 0:
                raise DownloadError("Downloaded file is empty")
            if explicit_filename is not None:
                final_path = _validate_explicit_filename(output_dir, explicit_filename)
            else:
                final_path = resolve_jailed_path(
                    output_dir, f"{stem}.{_infer_ext(meta, hdrs, final_url, part_path)}", allow_subdirs=False
                )
            return part_path, final_path, written, False
        except (SecurityError, DownloadError):
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
        return part_path, part_path, 0, True
    raise DownloadError(f"All {len(urls)} CDN routes failed: {redact_sensitive(str(last_err))}")


def _download_routes_atomic(
    client: DokiToolClient, urls: list[str], output_dir: Path, stem: str,
    meta: dict[str, Any] | None, *, explicit_filename: str | None, max_bytes: int,
    overwrite: bool = False,
) -> tuple[Path, int, bool]:
    """Download first succeeding route to a jailed temp file, then atomically commit."""
    part_path, final_path, written, expired = _download_routes_to_staged_part(
        client, urls, output_dir, stem, meta, explicit_filename=explicit_filename, max_bytes=max_bytes,
    )
    if expired:
        return part_path, 0, True
    try:
        _commit_atomic_file(part_path, final_path, overwrite=overwrite)
        return final_path, written, False
    except Exception:
        _unlink_if_regular(part_path)
        raise


def _mux_with_ffmpeg(
    video_path: Path, audio_path: Path, final_path: Path,
    output_dir: Path, container: str, subprocess_runner: Callable[..., Any],
    *, overwrite: bool = False,
) -> int:
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise DownloadError("ffmpeg binary was not found on PATH")
    mux_fmt = _SAFE_MUX_FORMATS.get((container or "").strip().lower(), "mp4")
    v_safe = resolve_jailed_path(output_dir, video_path.name, allow_subdirs=False)
    a_safe = resolve_jailed_path(output_dir, audio_path.name, allow_subdirs=False)
    f_safe = resolve_jailed_path(output_dir, final_path.name, allow_subdirs=False)
    tmp_out = resolve_jailed_path(output_dir, f".mux.{os.getpid()}.{secrets.token_hex(4)}.{f_safe.name}", allow_subdirs=False)
    for p in (v_safe, a_safe, f_safe, tmp_out):
        if str(p).startswith("-") or p.name.startswith("-") or ":" in p.name:
            raise SecurityError("Unsafe path rejected before ffmpeg invocation")
    if not overwrite and (f_safe.exists() or f_safe.is_symlink()):
        raise DownloadError(
            f"Target file already exists (no-clobber default): {f_safe.name}; pass --overwrite to replace"
        )
    cmd = [
        ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
        "-protocol_whitelist", "file", "-i", str(v_safe),
        "-protocol_whitelist", "file", "-i", str(a_safe),
        "-c", "copy", "-f", mux_fmt, str(tmp_out),
    ]
    try:
        proc = subprocess_runner(cmd, shell=False, check=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
        if getattr(proc, "returncode", 1) != 0:
            raw_err = getattr(proc, "stderr", b"")
            err_text = raw_err.decode("utf-8", errors="replace") if isinstance(raw_err, bytes) else str(raw_err)
            raise DownloadError(f"ffmpeg mux failed (exit {proc.returncode}): {redact_sensitive(err_text.strip())}")
        _commit_atomic_file(tmp_out, f_safe, overwrite=overwrite)
        return f_safe.stat().st_size
    finally:
        _unlink_if_regular(tmp_out)


def write_subtitle_files(
    extracted_tracks: Sequence[dict[str, Any]], output_dir: Path, *,
    allow_write: bool, stem_prefix: str = "subtitle", overwrite: bool = False,
) -> list[dict[str, Any]]:
    """Atomically save extracted subtitle payloads inside jailed output_dir."""
    if not allow_write:
        raise SecurityError("Local file write is disabled; pass --allow-write --output-dir <dir>")
    root = validate_output_dir(output_dir, create=True)
    saved: list[dict[str, Any]] = []
    used_names: set[str] = set()
    safe_prefix = sanitize_filename_stem(stem_prefix, 48)
    for idx, track in enumerate(extracted_tracks, start=1):
        lang = sanitize_filename_stem(str(track.get("language") or f"track{idx}"), 20)
        kind = sanitize_filename_stem(str(track.get("track_kind") or "sub"), 12)
        out_fmt = str(track.get("output_format") or "txt").lower()
        raw_ext = "txt" if out_fmt == "text" else (track.get("source_format") or "vtt" if out_fmt == "raw" else out_fmt)
        clean_ext = str(raw_ext or "").strip().lower().lstrip(".")
        ext = clean_ext if clean_ext in _ALLOWED_SUBTITLE_EXTS else "txt"
        filename = f"{safe_prefix}.{lang}.{kind}.{ext}"
        dup_n = 2
        while filename in used_names or (
            not overwrite and ((root / filename).exists() or (root / filename).is_symlink())
        ):
            filename = f"{safe_prefix}.{lang}.{kind}.{dup_n}.{ext}"
            dup_n += 1
        used_names.add(filename)
        target = resolve_jailed_path(root, filename, allow_subdirs=False)
        tmp = resolve_jailed_path(root, f".{filename}.{os.getpid()}.{secrets.token_hex(4)}.part", allow_subdirs=False)
        content_bytes = str(track.get("content") or "").encode("utf-8")
        if len(content_bytes) > MAX_SUBTITLE_BYTES:
            raise SecurityError(f"Subtitle file exceeds {MAX_SUBTITLE_BYTES} byte limit")
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(tmp, flags, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(content_bytes)
                handle.flush()
            _commit_atomic_file(tmp, target, overwrite=overwrite)
        finally:
            _unlink_if_regular(tmp)
        saved.append({"file": target.name, "bytes": len(content_bytes), "language": track.get("language"), "track_kind": track.get("track_kind")})
    return saved


def _download_variant_files(
    client: DokiToolClient, variant: dict[str, Any], preferred_source_id: str | None,
    root: Path, stem: str, *, explicit_filename: str | None, allow_ffmpeg: bool,
    max_media_bytes: int, subprocess_runner: Callable[..., Any], overwrite: bool = False,
) -> tuple[list[dict[str, Any]], bool]:
    delivery = variant.get("delivery") or {}
    kind = delivery.get("kind")
    if kind == "file":
        urls = _collect_direct_urls(delivery.get("sources") or [], preferred_source_id)
        if not urls:
            return [], True
        path, nbytes, expired = _download_routes_atomic(
            client, urls, root, stem, variant.get("metadata"),
            explicit_filename=explicit_filename, max_bytes=max_media_bytes, overwrite=overwrite,
        )
        return ([], True) if expired else ([{"role": "main", "file": path.name, "bytes": nbytes}], False)
    if kind == "pair":
        pair_stem = sanitize_filename_stem(Path(explicit_filename).stem, 48) if explicit_filename is not None else stem
        pair_resources: list[tuple[str, list[str], dict[str, Any] | None]] = []
        for res in delivery.get("resources") or []:
            res_del = res.get("delivery") or {}
            if res_del.get("kind") != "file":
                continue
            role = sanitize_filename_stem(str(res.get("role") or "part"), 16)
            urls = _collect_direct_urls(res_del.get("sources") or [])
            if not urls:
                return [], True
            pair_resources.append((role, urls, res.get("metadata")))

        # Two-phase commit: download all pair resources into hidden temp files first,
        # precheck all destination paths for no-clobber safety, then publish together.
        staged: list[tuple[str, Path, Path, int]] = []
        try:
            for role, urls, res_meta in pair_resources:
                part_path, final_path, nbytes, expired = _download_routes_to_staged_part(
                    client, urls, root, f"{pair_stem}_{role}", res_meta,
                    explicit_filename=None, max_bytes=max_media_bytes,
                )
                if expired:
                    return [], True
                staged.append((role, part_path, final_path, nbytes))

            seen_targets: set[str] = set()
            for _role, _part_path, final_path, _nbytes in staged:
                if final_path.name in seen_targets:
                    raise DownloadError(f"Duplicate pair output filename: {final_path.name}")
                seen_targets.add(final_path.name)
                if not overwrite and (final_path.exists() or final_path.is_symlink()):
                    raise DownloadError(
                        f"Target file already exists (no-clobber default): {final_path.name}; pass --overwrite to replace"
                    )

            saved: list[dict[str, Any]] = []
            committed: list[tuple[Path, tuple[int, int]]] = []
            try:
                for role, part_path, final_path, nbytes in staged:
                    file_id = _commit_atomic_file(part_path, final_path, overwrite=overwrite)
                    committed.append((final_path, file_id))
                    saved.append({"role": role, "file": final_path.name, "bytes": nbytes})
            except Exception:
                if not overwrite:
                    for path, file_id in committed:
                        _unlink_if_same_file(path, file_id)
                raise
            return saved, False
        finally:
            for _role, part_path, _final_path, _nbytes in staged:
                _unlink_if_regular(part_path)
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
        mux_nonce = secrets.token_hex(4)
        try:
            v_path, _, v_exp = _download_routes_atomic(
                client, v_urls, root, f"{stem}_video_tmp_{mux_nonce}", v_res.get("metadata"),
                explicit_filename=None, max_bytes=max_media_bytes, overwrite=True,
            )
            if v_exp:
                return [], True
            a_path, _, a_exp = _download_routes_atomic(
                client, a_urls, root, f"{stem}_audio_tmp_{mux_nonce}", a_res.get("metadata"),
                explicit_filename=None, max_bytes=max_media_bytes, overwrite=True,
            )
            if a_exp:
                return [], True
            out_meta = delivery.get("output") if isinstance(delivery.get("output"), dict) else {}
            raw_out_ext = str(out_meta.get("extension") or "mp4").strip().lower().lstrip(".")
            out_ext = raw_out_ext if raw_out_ext in _SAFE_MUX_FORMATS else "mp4"
            final_path = (
                _validate_explicit_filename(root, explicit_filename)
                if explicit_filename is not None
                else resolve_jailed_path(root, f"{stem}.{out_ext}", allow_subdirs=False)
            )
            nbytes = _mux_with_ffmpeg(
                v_path, a_path, final_path, root, str(out_meta.get("container") or out_ext).lower(),
                subprocess_runner, overwrite=overwrite,
            )
            return [{"role": "muxed", "file": final_path.name, "bytes": nbytes}], False
        finally:
            _unlink_if_regular(v_path)
            _unlink_if_regular(a_path)
    raise DownloadError(f"Unsupported delivery kind for local download: {kind}")


def download_media(
    client: DokiToolClient, share_url: str, output_dir: Path, *,
    allow_write: bool, allow_ffmpeg: bool = False, overwrite: bool = False, platform: str | None = None,
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
        explicit_target = _validate_explicit_filename(root, filename)
        if not overwrite and (explicit_target.exists() or explicit_target.is_symlink()):
            raise DownloadError(
                f"Target file already exists (no-clobber default): {explicit_target.name}; pass --overwrite to replace"
            )

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
        max_media_bytes=max_media_bytes, subprocess_runner=subprocess_runner, overwrite=overwrite,
    )
    if expired:
        data = client.refresh(data, fallback_url=share_url, item_resolve_url=resolve_url)["data"]
        item = _select_item(data, item.get("id"))
        variant, preferred_source_id = _select_variant(item, variant_id)
        files, still_expired = _download_variant_files(
            client, variant, preferred_source_id, root, stem,
            explicit_filename=filename, allow_ffmpeg=allow_ffmpeg,
            max_media_bytes=max_media_bytes, subprocess_runner=subprocess_runner, overwrite=overwrite,
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
            sub_files = write_subtitle_files(
                sub_res["tracks"], root, allow_write=True, stem_prefix=stem, overwrite=overwrite,
            )
    return {
        "platform": data.get("platform"), "content_id": data.get("content_id"),
        "item_id": item.get("id"), "variant_id": variant.get("id"),
        "output_dir": str(root), "files": files, "subtitle_files": sub_files,
    }
