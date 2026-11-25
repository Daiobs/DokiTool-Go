"""Pure-stdlib JSON-RPC 2.0 stdio MCP server for dokitool-agent.

100% read-only by default. File writes and ffmpeg execution require explicit opt-in flags.
Stdout emits strictly newline-delimited JSON-RPC 2.0 responses; diagnostics go to stderr.
"""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
from typing import Any, Callable, TextIO

from api_client import DokiToolAPIError, DokiToolClient, summarize_parse_result, summarize_platforms
from downloader import DownloadError, download_media
from security import MAX_SUBTITLE_BYTES, SafeHTTPFetcher, SecurityError, redact_sensitive, validate_output_dir
from subtitles import extract_subtitles_from_data

MCP_PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "dokitool-agent", "version": "1.0.0"}

_READ_ONLY_TOOLS: tuple[dict[str, Any], ...] = (
    {
        "name": "dokitool_list_platforms",
        "description": "List enabled media platforms and capabilities on the configured DokiTool API instance (read-only).",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "dokitool_parse_media",
        "description": "Parse a single share URL or share text into normalized Unified-v1 media items, variants, and subtitle track metadata (read-only).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Share URL or share text containing a URL."},
                "platform": {"type": "string", "description": "Optional platform ID (omit or 'all' for auto-routing)."},
                "debug": {"type": "boolean", "description": "Include full diagnostic variants view."},
                "resolve_item_id": {"type": "string", "description": "Optional deferred item_id to resolve via /api/resolve."},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
    {
        "name": "dokitool_extract_subtitles",
        "description": "Discover and directly fetch public subtitle tracks (<= 5 MiB cap, zero-Cookie, anti-SSRF) rendered as plain text, VTT, SRT, or raw (read-only).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Share URL or share text containing a URL."},
                "platform": {"type": "string", "description": "Optional platform ID."},
                "lang": {"type": "string", "description": "Preferred BCP-47 language code or comma-separated priority list (e.g. 'zh,en')."},
                "track_kind": {"type": "string", "enum": ["all", "manual", "auto"], "default": "all"},
                "format": {"type": "string", "enum": ["text", "vtt", "srt", "raw"], "default": "text"},
                "all_tracks": {"type": "boolean", "default": False},
                "list_only": {"type": "boolean", "default": False},
            },
            "required": ["url"],
            "additionalProperties": False,
        },
    },
)

_DOWNLOAD_TOOL: dict[str, Any] = {
    "name": "dokitool_download_media",
    "description": "Download media (and optional subtitles) directly from CDN into the server's configured jailed --output-dir (explicit opt-in only).",
    "inputSchema": {
        "type": "object",
        "properties": {
            "url": {"type": "string", "description": "Share URL or share text."},
            "platform": {"type": "string", "description": "Optional platform ID."},
            "item_id": {"type": "string", "description": "Optional item ID to download."},
            "variant_id": {"type": "string", "description": "Optional variant ID to download."},
            "filename": {"type": "string", "description": "Optional target basename strictly inside --output-dir (no slashes or '..')."},
            "include_subtitles": {"type": "boolean", "default": False},
            "subtitle_lang": {"type": "string"},
            "subtitle_kind": {"type": "string", "enum": ["all", "manual", "auto"], "default": "all"},
            "subtitle_format": {"type": "string", "enum": ["text", "vtt", "srt", "raw"], "default": "vtt"},
            "mux_with_ffmpeg": {"type": "boolean", "default": False},
        },
        "required": ["url"],
        "additionalProperties": False,
    },
}


def _jsonrpc_result(req_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _jsonrpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": redact_sensitive(message)},
    }


def _tool_ok(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
        "structuredContent": payload,
        "isError": False,
    }


def _tool_error(message: str, *, code: str = "ERROR") -> dict[str, Any]:
    safe_msg = redact_sensitive(message)
    payload = {"error": {"code": code, "message": safe_msg}}
    return {
        "content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}],
        "structuredContent": payload,
        "isError": True,
    }


class DokiToolMCPServer:
    """Stdio MCP server exposing read-only DokiTool tools by default, with explicit opt-in write."""

    def __init__(
        self,
        client: DokiToolClient,
        *,
        allow_write: bool = False,
        output_dir: Path | None = None,
        allow_ffmpeg: bool = False,
        fetcher: SafeHTTPFetcher | None = None,
        subprocess_runner: Callable[..., Any] = subprocess.run,
    ) -> None:
        if allow_write and output_dir is None:
            raise SecurityError("--allow-write requires --output-dir")
        if output_dir is not None and not allow_write:
            raise SecurityError("--output-dir requires --allow-write")
        if allow_ffmpeg and not (allow_write and output_dir is not None):
            raise SecurityError("--allow-ffmpeg requires both --allow-write and --output-dir")

        self.client = client
        self.allow_write = bool(allow_write and output_dir is not None)
        self.output_dir = validate_output_dir(output_dir, create=True) if self.allow_write and output_dir else None
        self.allow_ffmpeg = bool(allow_ffmpeg and self.allow_write)
        self.fetcher = fetcher or client.fetcher
        self._subprocess_runner = subprocess_runner

    def tool_definitions(self) -> list[dict[str, Any]]:
        tools = [dict(tool) for tool in _READ_ONLY_TOOLS]
        if self.allow_write and self.output_dir is not None:
            tools.append(dict(_DOWNLOAD_TOOL))
        return tools

    def _call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if name == "dokitool_list_platforms":
            return _tool_ok(summarize_platforms(self.client.list_platforms()))

        if name == "dokitool_parse_media":
            raw_url = arguments.get("url")
            if not isinstance(raw_url, str) or not raw_url.strip():
                return _tool_error("Missing required string argument: url", code="INVALID_INPUT")
            url = raw_url.strip()
            env = self.client.parse(
                url,
                platform=arguments.get("platform") if isinstance(arguments.get("platform"), str) else None,
                debug=bool(arguments.get("debug", False)),
            )
            resolve_item_id = arguments.get("resolve_item_id")
            if isinstance(resolve_item_id, str) and resolve_item_id.strip():
                items = env.get("data", {}).get("items") or []
                target = next((it for it in items if isinstance(it, dict) and it.get("id") == resolve_item_id), None)
                if target and target.get("state") == "deferred" and target.get("resolve_url"):
                    env = self.client.resolve(target["resolve_url"])
            return _tool_ok(summarize_parse_result(env))

        if name == "dokitool_extract_subtitles":
            raw_url = arguments.get("url")
            if not isinstance(raw_url, str) or not raw_url.strip():
                return _tool_error("Missing required string argument: url", code="INVALID_INPUT")
            url = raw_url.strip()
            env = self.client.parse(
                url,
                platform=arguments.get("platform") if isinstance(arguments.get("platform"), str) else None,
            )
            res = extract_subtitles_from_data(
                env["data"],
                self.fetcher,
                lang=arguments.get("lang") if isinstance(arguments.get("lang"), str) else None,
                track_kind=str(arguments.get("track_kind") or "all"),
                output_format=str(arguments.get("format") or "text"),
                select_all=bool(arguments.get("all_tracks", False)),
                list_only=bool(arguments.get("list_only", False)),
                max_bytes=MAX_SUBTITLE_BYTES,
            )
            return _tool_ok(res)

        if name == "dokitool_download_media":
            raw_url = arguments.get("url")
            if not isinstance(raw_url, str) or not raw_url.strip():
                return _tool_error("Missing required string argument: url", code="INVALID_INPUT")
            url = raw_url.strip()
            want_ffmpeg = bool(arguments.get("mux_with_ffmpeg", False))
            if want_ffmpeg and not self.allow_ffmpeg:
                return _tool_error(
                    "ffmpeg muxing is disabled; restart MCP server with --allow-ffmpeg",
                    code="FFMPEG_DISABLED",
                )
            assert self.output_dir is not None
            res = download_media(
                self.client,
                url,
                self.output_dir,
                allow_write=self.allow_write,
                allow_ffmpeg=self.allow_ffmpeg,
                platform=arguments.get("platform"),
                item_id=arguments.get("item_id"),
                variant_id=arguments.get("variant_id"),
                filename=arguments.get("filename"),
                include_subtitles=bool(arguments.get("include_subtitles", False)),
                subtitle_lang=arguments.get("subtitle_lang"),
                subtitle_kind=str(arguments.get("subtitle_kind") or "all"),
                subtitle_format=str(arguments.get("subtitle_format") or "vtt"),
                subprocess_runner=self._subprocess_runner,
            )
            return _tool_ok(res)

        return _tool_error(f"Unknown tool: {name}", code="UNKNOWN_TOOL")

    def handle_request(self, request: dict[str, Any]) -> dict[str, Any] | None:
        if not isinstance(request, dict):
            return _jsonrpc_error(None, -32600, "Invalid Request")
        req_id = request.get("id")
        is_notification = "id" not in request
        method = request.get("method")
        params = request.get("params") if isinstance(request.get("params"), dict) else {}

        if not isinstance(method, str) or not method:
            return None if is_notification else _jsonrpc_error(req_id, -32600, "Invalid Request: missing method")

        if method.startswith("notifications/"):
            return None

        if method == "initialize":
            client_proto = params.get("protocolVersion")
            proto = client_proto if isinstance(client_proto, str) and client_proto.strip() else MCP_PROTOCOL_VERSION
            return _jsonrpc_result(req_id, {
                "protocolVersion": proto,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
            })

        if method == "ping":
            return _jsonrpc_result(req_id, {})

        if method == "tools/list":
            return _jsonrpc_result(req_id, {"tools": self.tool_definitions()})

        if method == "tools/call":
            name = params.get("name")
            arguments = params.get("arguments")
            if not isinstance(name, str) or not name:
                return _jsonrpc_error(req_id, -32602, "Invalid params: missing tool name")
            if arguments is None:
                arguments = {}
            if not isinstance(arguments, dict):
                return _jsonrpc_error(req_id, -32602, "Invalid params: arguments must be an object")

            if name == "dokitool_download_media" and not (self.allow_write and self.output_dir is not None):
                return _jsonrpc_error(
                    req_id,
                    -32602,
                    "Tool 'dokitool_download_media' is disabled in read-only mode (start with --allow-write --output-dir)",
                )
            known_names = {tool["name"] for tool in self.tool_definitions()}
            if name not in known_names:
                return _jsonrpc_error(req_id, -32602, f"Unknown or disabled tool: {name}")

            try:
                result = self._call_tool(name, arguments)
            except SecurityError as exc:
                result = _tool_error(str(exc), code="SECURITY_ERROR")
            except DokiToolAPIError as exc:
                result = _tool_error(str(exc), code=exc.code)
            except (DownloadError, ValueError, RuntimeError) as exc:
                result = _tool_error(str(exc), code="TOOL_ERROR")
            return _jsonrpc_result(req_id, result)

        return None if is_notification else _jsonrpc_error(req_id, -32601, f"Method not found: {method}")

    def handle_message(self, raw_line: str) -> dict[str, Any] | None:
        text = raw_line.strip()
        if not text:
            return None
        try:
            payload = json.loads(text)
        except ValueError:
            return _jsonrpc_error(None, -32700, "Parse error")
        return self.handle_request(payload)

    def serve_forever(
        self,
        stdin: TextIO | None = None,
        stdout: TextIO | None = None,
        stderr: TextIO | None = None,
    ) -> int:
        in_stream = sys.stdin if stdin is None else stdin
        out_stream = sys.stdout if stdout is None else stdout
        err_stream = sys.stderr if stderr is None else stderr

        mode = "read-write" if self.allow_write else "read-only"
        err_stream.write(
            f"[dokitool-agent] MCP stdio server ready (mode={mode}, ffmpeg={self.allow_ffmpeg}, api={self.client.api_base})\n"
        )
        err_stream.flush()

        for line in in_stream:
            response = self.handle_message(line)
            if response is not None:
                out_stream.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
                out_stream.flush()
        return 0
