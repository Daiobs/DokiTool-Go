"""Client-side subtitle discovery, bounded fetching, and VTT/SRT/TTML/SRV3 extraction.

Uses Unified-v1 Attachment.track_kind ("manual" | "auto") and Python 3.9+ stdlib only.
"""
from __future__ import annotations

from dataclasses import dataclass
import html
import re
from typing import Any, Sequence
import urllib.parse
import xml.etree.ElementTree as ET

from security import (
    HTTPStatusError,
    MAX_SUBTITLE_BYTES,
    SafeHTTPFetcher,
    SecurityError,
    SizeLimitExceededError,
    redact_sensitive,
)

FORMAT_RANK = {"vtt": 1, "srt": 2, "ttml": 3, "srv3": 4, "xml": 5}
_MIME_TO_FORMAT = {
    "text/vtt": "vtt", "application/x-subrip": "srt", "text/srt": "srt",
    "application/ttml+xml": "ttml", "application/xml": "xml", "text/xml": "xml",
}
_VALID_TRACK_KINDS = frozenset({"all", "manual", "auto"})
_VALID_OUTPUT_FORMATS = frozenset({"text", "vtt", "srt", "raw"})
_VTT_TIME_RE = re.compile(
    r"(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})"
)
_INLINE_TAG_RE = re.compile(r"<[^>]+>")
_CLOCK_RE = re.compile(r"^(?:(\d{1,2}):)?(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$")
_OFFSET_RE = re.compile(r"^(\d+(?:\.\d+)?)(h|m|s|ms)$", re.IGNORECASE)
_XML_UNSAFE_RE = re.compile(r"<!(?:DOCTYPE|ENTITY)\b", re.IGNORECASE)


@dataclass(frozen=True)
class SubtitleTrack:
    id: str
    language: str
    title: str
    track_kind: str
    source_format: str
    mime_type: str
    urls: tuple[str, ...]

    def to_metadata_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "language": self.language, "title": self.title,
            "track_kind": self.track_kind, "format": self.source_format,
            "mime_type": self.mime_type, "url": self.urls[0] if self.urls else "",
        }


@dataclass(frozen=True)
class SubtitleCue:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True)
class ExtractedSubtitle:
    track: SubtitleTrack
    output_format: str
    content: str
    cue_count: int
    bytes_fetched: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.track.id, "language": self.track.language, "title": self.track.title,
            "track_kind": self.track.track_kind, "source_format": self.track.source_format,
            "output_format": self.output_format, "cue_count": self.cue_count,
            "bytes_fetched": self.bytes_fetched, "content": self.content,
        }


def _normalize_lang(lang: str) -> str:
    return (lang or "").strip().replace("_", "-").lower()


def _infer_track_format(meta: dict[str, Any], primary_url: str) -> str:
    for key in ("extension", "container"):
        val = str(meta.get(key) or "").strip().lower().lstrip(".")
        if val in FORMAT_RANK:
            return val
    mime = str(meta.get("mime_type") or "").split(";")[0].strip().lower()
    if mime in _MIME_TO_FORMAT:
        return _MIME_TO_FORMAT[mime]
    parsed = urllib.parse.urlsplit(primary_url)
    fmt = (urllib.parse.parse_qs(parsed.query).get("fmt") or [""])[0].strip().lower()
    if fmt in FORMAT_RANK:
        return fmt
    suffix = parsed.path.rsplit(".", 1)[-1].lower() if "." in parsed.path else ""
    return suffix if suffix in FORMAT_RANK else "vtt"


def discover_subtitle_tracks(data: dict[str, Any]) -> list[SubtitleTrack]:
    """Extract subtitle attachments from unified-v1 data, ordered manual > auto and vtt > srt > ttml > srv3."""
    attachments = data.get("attachments") if isinstance(data.get("attachments"), list) else []
    indexed: list[tuple[int, int, int, SubtitleTrack]] = []
    for pos, att in enumerate(attachments):
        if not isinstance(att, dict) or att.get("role") != "subtitle":
            continue
        res = att.get("resource") if isinstance(att.get("resource"), dict) else {}
        delivery = res.get("delivery") if isinstance(res.get("delivery"), dict) else {}
        if delivery.get("kind") != "file":
            continue
        urls: list[str] = []
        seen: set[str] = set()
        for src in (delivery.get("sources") or []):
            if not isinstance(src, dict) or src.get("access", "direct") == "relay" or src.get("availability") == "unavailable":
                continue
            for raw_url in [src.get("url"), *(src.get("fallback_urls") or [])]:
                if isinstance(raw_url, str) and raw_url and raw_url not in seen:
                    seen.add(raw_url)
                    urls.append(raw_url)
        if not urls:
            continue
        meta = res.get("metadata") if isinstance(res.get("metadata"), dict) else {}
        kind_raw = str(att.get("track_kind") or "").strip().lower()
        track_kind = kind_raw if kind_raw in ("manual", "auto") else "unknown"
        fmt = _infer_track_format(meta, urls[0])
        lang = str(att.get("language") or "").strip()
        track = SubtitleTrack(
            id=str(att.get("id") or f"sub-{pos + 1}"),
            language=lang,
            title=str(att.get("title") or lang or att.get("id") or "subtitle").strip(),
            track_kind=track_kind,
            source_format=fmt,
            mime_type=str(meta.get("mime_type") or ""),
            urls=tuple(urls),
        )
        kind_rank = 0 if track_kind == "manual" else (1 if track_kind == "auto" else 2)
        indexed.append((kind_rank, FORMAT_RANK.get(fmt, 99), pos, track))
    indexed.sort(key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in indexed]


def _lang_match_rank(track_lang: str, requested_langs: list[str]) -> tuple[int, int] | None:
    if not requested_langs:
        return (0, 0)
    norm_track = _normalize_lang(track_lang)
    if not norm_track:
        return None
    for idx, req in enumerate(requested_langs):
        if norm_track == req:
            return (idx, 0)
        if norm_track.startswith(req + "-"):
            return (idx, 1)
    return None


def select_subtitle_tracks(
    tracks: Sequence[SubtitleTrack],
    *,
    lang: str | None = None,
    track_kind: str = "all",
    preferred_format: str | None = None,
    select_all: bool = False,
) -> list[SubtitleTrack]:
    """Filter and rank subtitle tracks by track_kind, language (exact > prefix), and format."""
    kind = (track_kind or "all").strip().lower()
    if kind not in _VALID_TRACK_KINDS:
        raise ValueError(f"Unsupported track_kind {track_kind!r}; expected one of all, manual, auto")
    req_langs = [_normalize_lang(part) for part in (lang or "").split(",") if _normalize_lang(part)]
    pref_fmt = (preferred_format or "").strip().lower()

    scored: list[tuple[tuple[int, int, int, int, int], SubtitleTrack]] = []
    for idx, track in enumerate(tracks):
        if kind != "all" and track.track_kind != kind:
            continue
        lang_rank = _lang_match_rank(track.language, req_langs)
        if lang_rank is None:
            continue
        kind_rank = 0 if track.track_kind == "manual" else (1 if track.track_kind == "auto" else 2)
        fmt_pref = 0 if (pref_fmt and track.source_format == pref_fmt) else 1
        key = (lang_rank[0], lang_rank[1], kind_rank, fmt_pref, FORMAT_RANK.get(track.source_format, 99) * 1000 + idx)
        scored.append((key, track))
    scored.sort(key=lambda pair: pair[0])
    ordered = [track for _, track in scored]
    return ordered if (select_all or not ordered) else [ordered[0]]


def _hms_to_ms(hours: str | None, minutes: str, seconds: str, frac: str | None) -> int:
    ms_str = (frac or "0").ljust(3, "0")[:3]
    return ((int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds)) * 1000) + int(ms_str)


def _parse_xml_time_ms(raw: str | None) -> int:
    text = (raw or "").strip()
    if not text:
        return 0
    m = _CLOCK_RE.match(text)
    if m:
        return _hms_to_ms(m.group(1), m.group(2), m.group(3), m.group(4))
    m = _OFFSET_RE.match(text)
    if m:
        mult = {"h": 3600000.0, "m": 60000.0, "s": 1000.0, "ms": 1.0}[m.group(2).lower()]
        return int(round(float(m.group(1)) * mult))
    try:
        return int(round(float(text) * 1000.0))
    except ValueError:
        return 0


def _clean_cue_text(raw: str) -> str:
    stripped = _INLINE_TAG_RE.sub("", html.unescape(html.unescape(raw or "")))
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in stripped.splitlines()]
    return "\n".join(line for line in lines if line)


def _parse_vtt_or_srt(raw_text: str) -> list[SubtitleCue]:
    normalized = raw_text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    cues: list[SubtitleCue] = []
    for block in re.split(r"\n{2,}", normalized):
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines or lines[0].strip().upper().startswith(("WEBVTT", "NOTE", "STYLE", "REGION")):
            continue
        time_idx, match = -1, None
        for i, line in enumerate(lines[:2]):
            m = _VTT_TIME_RE.search(line)
            if m:
                time_idx, match = i, m
                break
        if match is None or time_idx < 0:
            continue
        start_ms = _hms_to_ms(match.group(1), match.group(2), match.group(3), match.group(4))
        end_ms = _hms_to_ms(match.group(5), match.group(6), match.group(7), match.group(8))
        text = _clean_cue_text("\n".join(lines[time_idx + 1:]))
        if text:
            cues.append(SubtitleCue(start_ms=start_ms, end_ms=max(end_ms, start_ms), text=text))
    return cues


def _extract_xml_element_text(elem: ET.Element) -> str:
    parts: list[str] = [elem.text] if elem.text else []
    for child in elem:
        tag = child.tag.rsplit("}", 1)[-1].lower()
        parts.append("\n" if tag == "br" else _extract_xml_element_text(child))
        if child.tail:
            parts.append(child.tail)
    return "".join(parts)


def _parse_xml_subtitles(raw_text: str) -> list[SubtitleCue]:
    cleaned = raw_text.lstrip("\ufeff").strip()
    if _XML_UNSAFE_RE.search(cleaned):
        raise SecurityError("XML subtitle payload contains forbidden DOCTYPE/ENTITY declaration")
    try:
        root = ET.fromstring(cleaned)
    except ET.ParseError:
        return []
    cues: list[SubtitleCue] = []
    for elem in root.iter():
        tag = elem.tag.rsplit("}", 1)[-1].lower()
        if tag == "p":
            if "t" in elem.attrib:
                start_ms = int(float(elem.attrib.get("t", "0")))
                end_ms = start_ms + max(0, int(float(elem.attrib.get("d", "0"))))
            elif "begin" in elem.attrib:
                start_ms = _parse_xml_time_ms(elem.attrib.get("begin"))
                end_ms = (
                    _parse_xml_time_ms(elem.attrib.get("end"))
                    if "end" in elem.attrib
                    else start_ms + _parse_xml_time_ms(elem.attrib.get("dur"))
                )
            else:
                continue
            text = _clean_cue_text(_extract_xml_element_text(elem))
            if text:
                cues.append(SubtitleCue(start_ms=start_ms, end_ms=max(end_ms, start_ms), text=text))
        elif tag == "text" and "start" in elem.attrib:
            start_ms = int(round(float(elem.attrib.get("start", "0")) * 1000.0))
            dur_ms = int(round(float(elem.attrib.get("dur", "0")) * 1000.0))
            text = _clean_cue_text(_extract_xml_element_text(elem))
            if text:
                cues.append(SubtitleCue(start_ms=start_ms, end_ms=start_ms + max(0, dur_ms), text=text))
    return cues


def parse_cues(raw_text: str, source_format: str) -> list[SubtitleCue]:
    fmt = (source_format or "").strip().lower()
    if fmt in ("ttml", "srv3", "xml") or raw_text.lstrip("\ufeff").lstrip().startswith("<"):
        return _parse_xml_subtitles(raw_text)
    return _parse_vtt_or_srt(raw_text)


def _format_ts(ms: int, *, sep: str) -> str:
    hours, rem = divmod(max(0, int(ms)), 3600000)
    minutes, rem = divmod(rem, 60000)
    seconds, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{sep}{millis:03d}"


def render_subtitles(raw_text: str, source_format: str, output_format: str = "text") -> tuple[str, int]:
    """Normalize and render subtitle payload into text, vtt, srt, or raw."""
    out_fmt = (output_format or "text").strip().lower()
    if out_fmt not in _VALID_OUTPUT_FORMATS:
        raise ValueError(f"Unsupported output format {output_format!r}; expected text, vtt, srt, or raw")
    normalized_raw = raw_text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    cues = parse_cues(normalized_raw, source_format)
    if out_fmt == "raw":
        return normalized_raw, len(cues)
    if out_fmt == "vtt":
        blocks = ["WEBVTT", *(f"{_format_ts(c.start_ms, sep='.')} --> {_format_ts(c.end_ms, sep='.')}\n{c.text}" for c in cues)]
        return "\n\n".join(blocks) + "\n", len(cues)
    if out_fmt == "srt":
        blocks = [f"{i}\n{_format_ts(c.start_ms, sep=',')} --> {_format_ts(c.end_ms, sep=',')}\n{c.text}" for i, c in enumerate(cues, 1)]
        return ("\n\n".join(blocks) + "\n") if blocks else "", len(cues)
    lines: list[str] = []
    for cue in cues:
        for line in cue.text.splitlines():
            clean = line.strip()
            if clean and (not lines or lines[-1] != clean):
                lines.append(clean)
    return ("\n".join(lines) + "\n") if lines else "", len(cues)


def fetch_and_extract_track(
    track: SubtitleTrack,
    fetcher: SafeHTTPFetcher,
    *,
    output_format: str = "text",
    max_bytes: int = MAX_SUBTITLE_BYTES,
) -> ExtractedSubtitle:
    """Directly fetch a subtitle track with anti-SSRF, zero-Cookie, and 5 MiB hard cap."""
    last_err: Exception | None = None
    for url in track.urls:
        try:
            resp = fetcher.fetch_bytes(url, max_bytes=max_bytes, allow_loopback=False, allow_redirects=True, media_mode=True)
            rendered, cue_count = render_subtitles(resp.body.decode("utf-8", errors="replace"), track.source_format, output_format)
            return ExtractedSubtitle(track, output_format, rendered, cue_count, len(resp.body))
        except (SecurityError, SizeLimitExceededError):
            raise
        except (HTTPStatusError, OSError) as exc:
            last_err = exc
    raise RuntimeError(f"Failed to fetch subtitle track {track.id}: {redact_sensitive(str(last_err))}")


def extract_subtitles_from_data(
    data: dict[str, Any],
    fetcher: SafeHTTPFetcher,
    *,
    lang: str | None = None,
    track_kind: str = "all",
    output_format: str = "text",
    select_all: bool = False,
    list_only: bool = False,
    max_bytes: int = MAX_SUBTITLE_BYTES,
) -> dict[str, Any]:
    """High-level subtitle discovery + optional bounded client-side extraction."""
    available = discover_subtitle_tracks(data)
    selected = select_subtitle_tracks(available, lang=lang, track_kind=track_kind, select_all=select_all)
    result: dict[str, Any] = {
        "platform": data.get("platform"),
        "content_id": data.get("content_id"),
        "title": data.get("title"),
        "available_count": len(available),
        "available_tracks": [t.to_metadata_dict() for t in available],
        "selected_count": len(selected),
    }
    if list_only or not selected:
        result["tracks"] = []
        return result
    result["tracks"] = [
        fetch_and_extract_track(track, fetcher, output_format=output_format, max_bytes=max_bytes).to_dict()
        for track in selected
    ]
    return result
