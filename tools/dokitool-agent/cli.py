#!/usr/bin/env python3
"""Command-line interface for dokitool-agent (platforms, parse, subtitles, download, mcp).

Zero third-party dependencies (Python 3.9+ standard library only).
Tokens are read strictly from environment variables (DOKITOOL_API_TOKEN / DOKITOOL_OWNER_TOKEN);
passing --token or -t on the command line is explicitly rejected.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Any, Sequence

_MODULE_DIR = str(Path(__file__).resolve().parent)
if _MODULE_DIR not in sys.path:
    sys.path.insert(0, _MODULE_DIR)

from api_client import (
    DokiToolAPIError,
    DokiToolAuthError,
    DokiToolClient,
    summarize_parse_result,
    summarize_platforms,
)
from downloader import DownloadError, download_media, write_subtitle_files
from mcp_server import DokiToolMCPServer
from security import DEFAULT_API_BASE, MAX_SUBTITLE_BYTES, SecurityError, redact_sensitive
from subtitles import extract_subtitles_from_data


def _has_forbidden_token_flag(argv: Sequence[str]) -> bool:
    for arg in argv:
        if arg == "--":
            break
        if arg in ("--token", "-t") or arg.startswith("--token=") or (arg.startswith("-t") and len(arg) > 2):
            return True
    return False


def _add_shared_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--api-base",
        default=os.environ.get("DOKITOOL_API_BASE", DEFAULT_API_BASE),
        help="DokiTool API origin (default: $DOKITOOL_API_BASE or https://snap.dokitool.com)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="HTTP timeout in seconds (default: 60)",
    )
    parser.add_argument(
        "--format",
        choices=("json", "text"),
        default="json",
        help="CLI output format (default: json)",
    )
    parser.add_argument(
        "--no-proxy",
        action="store_true",
        help="Bypass HTTP_PROXY/HTTPS_PROXY and enforce direct IP-pinned connections",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dokitool-agent",
        description="Zero-dependency DokiTool Agent CLI & default read-only stdio MCP server.",
        allow_abbrev=False,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_plat = sub.add_parser("platforms", help="List enabled platforms on the DokiTool instance", allow_abbrev=False)
    _add_shared_args(p_plat)

    p_parse = sub.add_parser("parse", help="Parse a single share URL or share text", allow_abbrev=False)
    _add_shared_args(p_parse)
    p_parse.add_argument("url", help="Share URL or share text containing a URL")
    p_parse.add_argument("--platform", help="Optional platform ID (default: auto-routing)")
    p_parse.add_argument("--debug", action="store_true", help="Request debug diagnostic view")
    p_parse.add_argument("--resolve-item", help="Resolve a specific deferred item_id via /api/resolve")
    p_parse.add_argument("--raw", action="store_true", help="Include raw Unified-v1 JSON envelope")

    p_sub = sub.add_parser("subtitles", help="Discover and extract public subtitle tracks", allow_abbrev=False)
    _add_shared_args(p_sub)
    p_sub.add_argument("url", help="Share URL or share text containing a URL")
    p_sub.add_argument("--platform", help="Optional platform ID")
    p_sub.add_argument("--lang", help="Language code or comma-separated list (e.g. zh,en)")
    p_sub.add_argument("--track-kind", choices=("all", "manual", "auto"), default="all")
    p_sub.add_argument("--sub-format", choices=("text", "vtt", "srt", "raw"), default="text")
    p_sub.add_argument("--list-only", action="store_true", help="Only list available subtitle tracks")
    p_sub.add_argument("--all-tracks", action="store_true", help="Fetch all matching subtitle tracks")
    p_sub.add_argument("--allow-write", action="store_true", help="Explicit opt-in to write subtitle files locally")
    p_sub.add_argument("--output-dir", type=Path, help="Jailed directory for writing subtitle files (requires --allow-write)")

    p_dl = sub.add_parser("download", help="Download media locally (explicit --allow-write --output-dir required)", allow_abbrev=False)
    _add_shared_args(p_dl)
    p_dl.add_argument("url", help="Share URL or share text containing a URL")
    p_dl.add_argument("--platform", help="Optional platform ID")
    p_dl.add_argument("--item-id", help="Optional item ID to download")
    p_dl.add_argument("--variant-id", help="Optional variant ID to download")
    p_dl.add_argument("--filename", help="Optional target basename strictly inside --output-dir")
    p_dl.add_argument("--allow-write", action="store_true", help="Required explicit opt-in to write files")
    p_dl.add_argument("--output-dir", type=Path, help="Required jailed output directory")
    p_dl.add_argument("--allow-ffmpeg", action="store_true", help="Explicit opt-in to run local ffmpeg for mux variants")
    p_dl.add_argument("--with-subtitles", action="store_true", help="Also fetch and save matching subtitles")
    p_dl.add_argument("--lang", help="Subtitle language filter when --with-subtitles is set")
    p_dl.add_argument("--track-kind", choices=("all", "manual", "auto"), default="all")
    p_dl.add_argument("--sub-format", choices=("text", "vtt", "srt", "raw"), default="vtt")

    p_mcp = sub.add_parser("mcp", help="Run JSON-RPC 2.0 stdio MCP server (read-only by default)", allow_abbrev=False)
    p_mcp.add_argument(
        "--api-base",
        default=os.environ.get("DOKITOOL_API_BASE", DEFAULT_API_BASE),
        help="DokiTool API origin (default: $DOKITOOL_API_BASE or https://snap.dokitool.com)",
    )
    p_mcp.add_argument("--timeout", type=float, default=60.0, help="HTTP timeout in seconds (default: 60)")
    p_mcp.add_argument("--no-proxy", action="store_true", help="Bypass HTTP_PROXY/HTTPS_PROXY and enforce direct IP-pinned connections")
    p_mcp.add_argument("--allow-write", action="store_true", help="Explicit opt-in to expose dokitool_download_media")
    p_mcp.add_argument("--output-dir", type=Path, help="Jailed output root for opt-in writes (requires --allow-write)")
    p_mcp.add_argument("--allow-ffmpeg", action="store_true", help="Explicit opt-in to allow ffmpeg muxing in MCP downloads")
    return parser


def _emit_output(payload: dict[str, Any], fmt: str, text_renderer: Any = None) -> None:
    if fmt == "text" and text_renderer is not None:
        sys.stdout.write(text_renderer(payload))
    else:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    sys.stdout.flush()


def _render_platforms_text(summary: dict[str, Any]) -> str:
    lines = [f"{p['id']}\t{p.get('name') or ''}\t{','.join(p.get('capabilities') or [])}" for p in summary["platforms"]]
    return ("\n".join(lines) + "\n") if lines else ""


def _render_parse_text(summary: dict[str, Any]) -> str:
    lines = [
        f"platform: {summary.get('platform')}",
        f"title: {summary.get('title') or ''}",
        f"items: {len(summary.get('items') or [])}",
        f"subtitles: {len(summary.get('subtitles') or [])}",
    ]
    for item in summary.get("items") or []:
        default_url = (item.get("default") or {}).get("url") if isinstance(item.get("default"), dict) else None
        lines.append(f"- {item.get('id')} [{item.get('type')}/{item.get('state')}] default={default_url or 'none'}")
    return "\n".join(lines) + "\n"


def _render_subtitles_text(result: dict[str, Any]) -> str:
    tracks = result.get("tracks") or []
    if len(tracks) == 1:
        return str(tracks[0].get("content") or "")
    if not tracks:
        lines = [
            f"{t['language']}\t{t['track_kind']}\t{t['format']}\t{t['title']}"
            for t in (result.get("available_tracks") or [])
        ]
        return ("\n".join(lines) + "\n") if lines else "No matching subtitle tracks.\n"
    blocks = [f"=== {t['language']} ({t['track_kind']}) ===\n{t['content']}" for t in tracks]
    return "\n".join(blocks)


def _cmd_parse(client: DokiToolClient, args: argparse.Namespace) -> int:
    env = client.parse(args.url, platform=args.platform, debug=args.debug)
    if args.resolve_item:
        items = env.get("data", {}).get("items") or []
        target = next((it for it in items if isinstance(it, dict) and it.get("id") == args.resolve_item), None)
        if target is None:
            raise DokiToolAPIError(404, "CONTENT_UNAVAILABLE", f"Item not found: {args.resolve_item}")
        if target.get("state") == "deferred" and target.get("resolve_url"):
            env = client.resolve(target["resolve_url"])
    _emit_output(summarize_parse_result(env, include_raw=args.raw), args.format, _render_parse_text)
    return 0


def _cmd_subtitles(client: DokiToolClient, args: argparse.Namespace) -> int:
    if args.allow_write and args.output_dir is None:
        sys.stderr.write("error: --allow-write requires --output-dir\n")
        return 2
    if args.output_dir is not None and not args.allow_write:
        sys.stderr.write("error: writing subtitle files requires explicit --allow-write alongside --output-dir\n")
        return 2
    env = client.parse(args.url, platform=args.platform)
    result = extract_subtitles_from_data(
        env["data"],
        client.fetcher,
        lang=args.lang,
        track_kind=args.track_kind,
        output_format=args.sub_format,
        select_all=args.all_tracks,
        list_only=args.list_only,
        max_bytes=MAX_SUBTITLE_BYTES,
    )
    if args.allow_write and args.output_dir is not None and result["tracks"]:
        prefix = f"{result.get('platform') or 'media'}_{result.get('content_id') or 'sub'}"
        result["saved_files"] = write_subtitle_files(
            result["tracks"], args.output_dir, allow_write=True, stem_prefix=prefix
        )
    _emit_output(result, args.format, _render_subtitles_text)
    return 0


def _cmd_download(client: DokiToolClient, args: argparse.Namespace) -> int:
    if not args.allow_write or args.output_dir is None:
        sys.stderr.write("error: download requires both --allow-write and --output-dir <dir>\n")
        return 2
    result = download_media(
        client,
        args.url,
        args.output_dir,
        allow_write=True,
        allow_ffmpeg=args.allow_ffmpeg,
        platform=args.platform,
        item_id=args.item_id,
        variant_id=args.variant_id,
        filename=args.filename,
        include_subtitles=args.with_subtitles,
        subtitle_lang=args.lang,
        subtitle_kind=args.track_kind,
        subtitle_format=args.sub_format,
    )
    _emit_output(result, args.format)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    if _has_forbidden_token_flag(raw_argv):
        sys.stderr.write(
            "error: --token/-t CLI flag is forbidden for security; set DOKITOOL_API_TOKEN "
            "(or DOKITOOL_OWNER_TOKEN) in the environment instead\n"
        )
        return 2

    parser = build_parser()
    try:
        args = parser.parse_args(raw_argv)
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 2

    try:
        client = DokiToolClient(api_base=args.api_base, timeout=args.timeout, no_proxy=bool(getattr(args, "no_proxy", False)))
        if args.command == "platforms":
            _emit_output(summarize_platforms(client.list_platforms()), args.format, _render_platforms_text)
            return 0
        if args.command == "parse":
            return _cmd_parse(client, args)
        if args.command == "subtitles":
            return _cmd_subtitles(client, args)
        if args.command == "download":
            return _cmd_download(client, args)
        if args.command == "mcp":
            if (args.allow_write and args.output_dir is None) or (args.output_dir is not None and not args.allow_write):
                sys.stderr.write("error: MCP opt-in writes require both --allow-write and --output-dir <dir>\n")
                return 2
            if args.allow_ffmpeg and not (args.allow_write and args.output_dir is not None):
                sys.stderr.write("error: --allow-ffmpeg requires --allow-write and --output-dir <dir>\n")
                return 2
            server = DokiToolMCPServer(
                client,
                allow_write=args.allow_write,
                output_dir=args.output_dir,
                allow_ffmpeg=args.allow_ffmpeg,
            )
            return server.serve_forever()
        return 2
    except DokiToolAuthError as exc:
        sys.stderr.write(f"auth error: {redact_sensitive(str(exc))}\n")
        return 3
    except SecurityError as exc:
        sys.stderr.write(f"security error: {redact_sensitive(str(exc))}\n")
        return 2
    except (DokiToolAPIError, DownloadError, ValueError, OSError, RuntimeError) as exc:
        sys.stderr.write(f"error: {redact_sensitive(str(exc))}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
