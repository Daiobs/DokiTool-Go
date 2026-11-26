#!/usr/bin/env python3
"""Executable entrypoint and high-level Python facade for tools/dokitool-agent.

Zero third-party dependencies (Python 3.9+ standard library only).
Run directly from any working directory:
    python3 tools/dokitool-agent/dokitool_agent.py platforms
    python3 tools/dokitool-agent/dokitool_agent.py parse <share_url>
    python3 tools/dokitool-agent/dokitool_agent.py subtitles <share_url> --lang zh
    python3 tools/dokitool-agent/dokitool_agent.py mcp
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
from typing import Any, Sequence

_AGENT_DIR = str(Path(__file__).resolve().parent)
if _AGENT_DIR not in sys.path:
    sys.path.insert(0, _AGENT_DIR)

from api_client import DokiToolClient, summarize_parse_result, summarize_platforms
from cli import main as cli_main
from mcp_server import DokiToolMCPServer, MCP_PROTOCOL_VERSION
from security import DEFAULT_API_BASE, MAX_SUBTITLE_BYTES, SafeHTTPFetcher
from subtitles import extract_subtitles_from_data

__version__ = "1.0.0"
__all__ = (
    "__version__",
    "DEFAULT_API_BASE",
    "MCP_PROTOCOL_VERSION",
    "DokiToolClient",
    "DokiToolMCPServer",
    "SafeHTTPFetcher",
    "create_client",
    "create_mcp_server",
    "parse_and_summarize",
    "extract_subtitles_for_url",
    "summarize_platforms",
    "main",
)


def create_client(
    api_base: str | None = None,
    *,
    timeout: float = 60.0,
    max_retries: int = 3,
    no_proxy: bool = False,
) -> DokiToolClient:
    """Create an env-authenticated DokiToolClient using DOKITOOL_API_BASE/DOKITOOL_API_TOKEN."""
    resolved_base = api_base or os.environ.get("DOKITOOL_API_BASE", DEFAULT_API_BASE)
    return DokiToolClient(api_base=resolved_base, timeout=timeout, max_retries=max_retries, no_proxy=no_proxy)


def create_mcp_server(
    *,
    api_base: str | None = None,
    timeout: float = 60.0,
    no_proxy: bool = False,
    allow_write: bool = False,
    output_dir: str | Path | None = None,
    allow_ffmpeg: bool = False,
) -> DokiToolMCPServer:
    """Create a read-only-by-default stdio MCP server (writes/ffmpeg require explicit opt-in)."""
    client = create_client(api_base=api_base, timeout=timeout, no_proxy=no_proxy)
    resolved_out = Path(output_dir) if output_dir is not None else None
    return DokiToolMCPServer(
        client,
        allow_write=allow_write,
        output_dir=resolved_out,
        allow_ffmpeg=allow_ffmpeg,
    )


def parse_and_summarize(
    url: str,
    *,
    platform: str | None = None,
    debug: bool = False,
    include_raw: bool = False,
    client: DokiToolClient | None = None,
) -> dict[str, Any]:
    """Parse a single share URL and return a normalized Unified-v1 summary."""
    active_client = client or create_client()
    envelope = active_client.parse(url, platform=platform, debug=debug)
    return summarize_parse_result(envelope, include_raw=include_raw)


def extract_subtitles_for_url(
    url: str,
    *,
    platform: str | None = None,
    lang: str | None = None,
    track_kind: str = "all",
    output_format: str = "text",
    select_all: bool = False,
    list_only: bool = False,
    client: DokiToolClient | None = None,
) -> dict[str, Any]:
    """Parse a URL and extract matching public subtitle tracks directly on the client."""
    active_client = client or create_client()
    envelope = active_client.parse(url, platform=platform)
    return extract_subtitles_from_data(
        envelope["data"],
        active_client.fetcher,
        lang=lang,
        track_kind=track_kind,
        output_format=output_format,
        select_all=select_all,
        list_only=list_only,
        max_bytes=MAX_SUBTITLE_BYTES,
    )


def main(argv: Sequence[str] | None = None) -> int:
    return cli_main(argv)


if __name__ == "__main__":
    raise SystemExit(main())
