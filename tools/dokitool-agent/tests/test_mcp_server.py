"""Offline unit tests for tools/dokitool-agent/mcp_server.py (stdio JSON-RPC 2.0 MCP)."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
import urllib.parse

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import api_client  # noqa: E402
import cli  # noqa: E402
import mcp_server  # noqa: E402
import security  # noqa: E402


class _MCPMockHandler(BaseHTTPRequestHandler):
    base_url = ""

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/api/platforms":
            self._send_json(200, {
                "schema_version": "1.0",
                "code": "OK",
                "data": {"platforms": [{"id": "youtube", "name": "YouTube", "site_url": "https://www.youtube.com/", "capabilities": ["video"]}]},
            })
            return

        if parsed.path == "/api/parse":
            target = (qs.get("url") or [""])[0]
            if "auth-fail" in target:
                self._send_json(401, {
                    "schema_version": "1.0",
                    "code": "INVALID_INPUT",
                    "error": {"code": "INVALID_INPUT", "message": "Rejected https://cdn.example.com/a.mp4?sig=LEAKED_SIG", "retryable": False},
                })
                return
            if "mux" in target:
                variants = [{
                    "id": "mux-1",
                    "label": "1080p",
                    "state": "ready",
                    "delivery": {
                        "kind": "mux",
                        "output": {"container": "mp4", "extension": "mp4"},
                        "resources": [
                            {"id": "v", "role": "video", "delivery": {"kind": "file", "sources": [{"url": f"{self.base_url}/cdn/v.mp4"}]}},
                            {"id": "a", "role": "audio", "delivery": {"kind": "file", "sources": [{"url": f"{self.base_url}/cdn/a.m4a"}]}},
                        ],
                    },
                }]
                default_sel = None
            else:
                variants = [{
                    "id": "file-1",
                    "label": "720p",
                    "state": "ready",
                    "metadata": {"extension": "mp4", "mime_type": "video/mp4"},
                    "delivery": {"kind": "file", "sources": [{"id": "s1", "url": f"{self.base_url}/cdn/video.mp4"}]},
                }]
                default_sel = {"variant_id": "file-1", "source_id": "s1", "url": f"{self.base_url}/cdn/video.mp4"}

            self._send_json(200, {
                "schema_version": "1.0",
                "code": "OK",
                "data": {
                    "platform": "youtube",
                    "content_id": "mcp123",
                    "title": "MCP Sample",
                    "source_url": "https://www.youtube.com/watch?v=mcp123",
                    "items": [{"id": "item-1", "type": "video", "state": "ready", "default": default_sel, "variants": variants}],
                    "attachments": [{
                        "id": "sub-en",
                        "role": "subtitle",
                        "language": "en",
                        "title": "English",
                        "track_kind": "manual",
                        "resource": {
                            "id": "res-sub-en",
                            "role": "subtitle",
                            "metadata": {"container": "vtt", "extension": "vtt", "mime_type": "text/vtt"},
                            "delivery": {"kind": "file", "sources": [{"url": f"{self.base_url}/cdn/en.vtt"}]},
                        },
                    }],
                },
            })
            return

        if parsed.path == "/cdn/en.vtt":
            body = b"WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nMCP subtitle line\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/vtt")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path in ("/cdn/video.mp4", "/cdn/v.mp4", "/cdn/a.m4a"):
            body = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"X" * 32
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()


class MCPServerTests(unittest.TestCase):
    def setUp(self) -> None:
        handler_cls = type("BoundMCPHandler", (_MCPMockHandler,), {})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        handler_cls.base_url = self.base_url
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.local_fetcher = security.SafeHTTPFetcher(
            timeout=5.0,
            url_validator=lambda u, **kw: urllib.parse.urlsplit(u),
        )
        self.client = api_client.DokiToolClient(self.base_url, fetcher=self.local_fetcher)

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)

    def test_readonly_default_lifecycle_hides_and_rejects_download_and_stdout_json_purity(self) -> None:
        srv = mcp_server.DokiToolMCPServer(self.client, fetcher=self.local_fetcher)
        requests = [
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}}),
            json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "tools/list"}),
            json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "dokitool_download_media", "arguments": {"url": "https://example.com/v/1"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "dokitool_list_platforms", "arguments": {}}}),
            json.dumps({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "dokitool_parse_media", "arguments": {"url": "https://example.com/v/1"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "dokitool_extract_subtitles", "arguments": {"url": "https://example.com/v/1", "lang": "en", "track_kind": "manual", "format": "text"}}}),
            "{broken-json",
            json.dumps({"jsonrpc": "2.0", "id": 8, "method": "unknown/method"}),
        ]
        stdin = io.StringIO("\n".join(requests) + "\n")
        stdout = io.StringIO()
        stderr = io.StringIO()

        rc = srv.serve_forever(stdin=stdin, stdout=stdout, stderr=stderr)
        self.assertEqual(rc, 0)
        self.assertIn("mode=read-only", stderr.getvalue())

        # Every single stdout line MUST parse as clean JSON-RPC 2.0 (notifications emit no line).
        raw_lines = [line for line in stdout.getvalue().splitlines() if line]
        self.assertEqual(len(raw_lines), 9)
        responses = [json.loads(line) for line in raw_lines]
        by_id = {resp.get("id"): resp for resp in responses if resp.get("id") is not None}

        self.assertEqual(by_id[1]["result"]["serverInfo"]["name"], "dokitool-agent")
        self.assertEqual(by_id[2]["result"], {})

        tool_names = [t["name"] for t in by_id[3]["result"]["tools"]]
        self.assertEqual(
            tool_names,
            ["dokitool_list_platforms", "dokitool_parse_media", "dokitool_extract_subtitles"],
        )
        self.assertNotIn("dokitool_download_media", tool_names)

        # Explicitly calling dokitool_download_media in read-only mode MUST be rejected.
        self.assertIn("error", by_id[4])
        self.assertEqual(by_id[4]["error"]["code"], -32602)

        # Read-only tools succeed cleanly.
        self.assertFalse(by_id[5]["result"]["isError"])
        self.assertEqual(by_id[5]["result"]["structuredContent"]["count"], 1)
        self.assertFalse(by_id[6]["result"]["isError"])
        self.assertEqual(by_id[6]["result"]["structuredContent"]["platform"], "youtube")
        self.assertFalse(by_id[7]["result"]["isError"])
        self.assertEqual(by_id[7]["result"]["structuredContent"]["tracks"][0]["content"], "MCP subtitle line\n")

        # Parse error & unknown method
        parse_err = next(r for r in responses if r.get("id") is None)
        self.assertEqual(parse_err["error"]["code"], -32700)
        self.assertEqual(by_id[8]["error"]["code"], -32601)

    def test_opt_in_write_jail_symlink_escape_ffmpeg_gate_and_redaction(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp).resolve()
            out_dir = tmp_path / "mcp_out"
            out_dir.mkdir()
            outside_file = tmp_path / "outside.txt"
            outside_file.write_text("do-not-touch", encoding="utf-8")
            (out_dir / "sym_escape.mp4").symlink_to(outside_file)

            # Invalid flag combinations rejected at constructor and CLI level
            with self.assertRaises(security.SecurityError):
                mcp_server.DokiToolMCPServer(self.client, allow_write=True, output_dir=None)
            with self.assertRaises(security.SecurityError):
                mcp_server.DokiToolMCPServer(self.client, allow_write=False, output_dir=out_dir)
            with self.assertRaises(security.SecurityError):
                mcp_server.DokiToolMCPServer(self.client, allow_write=False, allow_ffmpeg=True)

            err_buf = io.StringIO()
            with mock.patch("sys.stderr", err_buf):
                self.assertEqual(cli.main(["mcp", "--api-base", self.base_url, "--allow-write"]), 2)
                self.assertEqual(cli.main(["mcp", "--api-base", self.base_url, "--allow-ffmpeg"]), 2)

            # Write-enabled (without ffmpeg)
            rw_srv = mcp_server.DokiToolMCPServer(
                self.client, allow_write=True, output_dir=out_dir, allow_ffmpeg=False, fetcher=self.local_fetcher
            )
            names = [t["name"] for t in rw_srv.tool_definitions()]
            self.assertIn("dokitool_download_media", names)

            # Valid jailed download succeeds
            ok_resp = rw_srv.handle_request({
                "jsonrpc": "2.0", "id": 10, "method": "tools/call",
                "params": {"name": "dokitool_download_media", "arguments": {"url": "https://example.com/v/1", "filename": "ok.mp4"}},
            })
            self.assertFalse(ok_resp["result"]["isError"])
            self.assertTrue((out_dir / "ok.mp4").is_file())

            # Path traversal and symlink escape rejected
            for bad_fn in ("../escape.mp4", "sym_escape.mp4", "/tmp/abs.mp4"):
                bad_resp = rw_srv.handle_request({
                    "jsonrpc": "2.0", "id": 11, "method": "tools/call",
                    "params": {"name": "dokitool_download_media", "arguments": {"url": "https://example.com/v/1", "filename": bad_fn}},
                })
                self.assertTrue(bad_resp["result"]["isError"], msg=bad_fn)
                self.assertEqual(bad_resp["result"]["structuredContent"]["error"]["code"], "SECURITY_ERROR")
            self.assertEqual(outside_file.read_text(encoding="utf-8"), "do-not-touch")

            # ffmpeg gate: blocked without --allow-ffmpeg
            mux_blocked = rw_srv.handle_request({
                "jsonrpc": "2.0", "id": 12, "method": "tools/call",
                "params": {"name": "dokitool_download_media", "arguments": {"url": "https://example.com/v/mux", "mux_with_ffmpeg": True}},
            })
            self.assertTrue(mux_blocked["result"]["isError"])
            self.assertEqual(mux_blocked["result"]["structuredContent"]["error"]["code"], "FFMPEG_DISABLED")

            # ffmpeg enabled: succeeds with shell=False
            def _fake_ffmpeg(cmd, **kwargs):
                self.assertFalse(kwargs.get("shell"))
                Path(cmd[-1]).write_bytes(b"MUXED")
                return subprocess.CompletedProcess(cmd, 0, b"", b"")

            ff_srv = mcp_server.DokiToolMCPServer(
                self.client,
                allow_write=True,
                output_dir=out_dir,
                allow_ffmpeg=True,
                fetcher=self.local_fetcher,
                subprocess_runner=_fake_ffmpeg,
            )
            # Even when server started with --allow-ffmpeg, per-call mux_with_ffmpeg=False/omitted MUST refuse mux!
            mux_per_call_blocked = ff_srv.handle_request({
                "jsonrpc": "2.0", "id": 125, "method": "tools/call",
                "params": {"name": "dokitool_download_media", "arguments": {"url": "https://example.com/v/mux", "filename": "no_mux.mp4"}},
            })
            self.assertTrue(mux_per_call_blocked["result"]["isError"])
            self.assertFalse((out_dir / "no_mux.mp4").exists())

            with mock.patch("shutil.which", return_value="/usr/bin/ffmpeg"):
                mux_ok = ff_srv.handle_request({
                    "jsonrpc": "2.0", "id": 13, "method": "tools/call",
                    "params": {"name": "dokitool_download_media", "arguments": {"url": "https://example.com/v/mux", "filename": "m.mp4", "mux_with_ffmpeg": True}},
                })
            self.assertFalse(mux_ok["result"]["isError"])
            self.assertEqual((out_dir / "m.mp4").read_bytes(), b"MUXED")

            # Non-string optional args return clean INVALID_INPUT tool error without crashing MCP
            for bad_args in (
                {"url": "https://example.com/v/1", "platform": 123},
                {"url": "https://example.com/v/1", "filename": 123},
                {"url": "https://example.com/v/1", "subtitle_lang": 42},
            ):
                bad_type_resp = rw_srv.handle_request({
                    "jsonrpc": "2.0", "id": 135, "method": "tools/call",
                    "params": {"name": "dokitool_download_media", "arguments": bad_args},
                })
                self.assertTrue(bad_type_resp["result"]["isError"])
                self.assertEqual(bad_type_resp["result"]["structuredContent"]["error"]["code"], "INVALID_INPUT")

            # OSError inside tool execution returns redacted TOOL_ERROR without crashing
            with mock.patch("mcp_server.download_media", side_effect=PermissionError("denied https://cdn.test/v?sig=OS_SECRET")):
                os_err_resp = rw_srv.handle_request({
                    "jsonrpc": "2.0", "id": 136, "method": "tools/call",
                    "params": {"name": "dokitool_download_media", "arguments": {"url": "https://example.com/v/1"}},
                })
            self.assertTrue(os_err_resp["result"]["isError"])
            self.assertEqual(os_err_resp["result"]["structuredContent"]["error"]["code"], "TOOL_ERROR")
            self.assertNotIn("OS_SECRET", json.dumps(os_err_resp))

            # Error redaction: signed query params & env token never leaked
            secret = "MCPSecretToken1234567890ABCDEFGHIJKLM"
            with mock.patch.dict("os.environ", {"DOKITOOL_API_TOKEN": secret}, clear=False):
                redacted = rw_srv.handle_request({
                    "jsonrpc": "2.0", "id": 14, "method": "tools/call",
                    "params": {"name": "dokitool_parse_media", "arguments": {"url": "https://example.com/auth-fail"}},
                })
            self.assertTrue(redacted["result"]["isError"])
            err_text = json.dumps(redacted)
            self.assertNotIn("LEAKED_SIG", err_text)
            self.assertNotIn(secret, err_text)

    def test_real_subprocess_stdio_mcp_stdout_purity(self) -> None:
        entry = AGENT_DIR / "dokitool_agent.py"
        payload = (
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}) + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}) + "\n"
        )
        proc = subprocess.run(
            [sys.executable, "-B", str(entry), "mcp", "--api-base", self.base_url],
            input=payload,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        lines = [line for line in proc.stdout.splitlines() if line]
        self.assertEqual(len(lines), 2)
        parsed = [json.loads(line) for line in lines]
        self.assertEqual(parsed[0]["id"], 1)
        tool_names = [t["name"] for t in parsed[1]["result"]["tools"]]
        self.assertEqual(tool_names, ["dokitool_list_platforms", "dokitool_parse_media", "dokitool_extract_subtitles"])
        self.assertIn("mode=read-only", proc.stderr)


if __name__ == "__main__":
    unittest.main()
