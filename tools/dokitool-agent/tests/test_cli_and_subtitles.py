"""Offline unit tests for CLI, API client backoff/auth, subtitles, and opt-in downloader."""
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
import dokitool_agent  # noqa: E402
import downloader  # noqa: E402
import mcp_server  # noqa: E402
import security  # noqa: E402
import subtitles  # noqa: E402

TEST_TOKEN = "T" * 40


def _sub_att(att_id: str, lang: str, title: str, kind: str, ext: str, mime: str, url: str) -> dict:
    return {
        "id": att_id, "role": "subtitle", "language": lang, "title": title, "track_kind": kind,
        "resource": {
            "id": f"res-{att_id}", "role": "subtitle",
            "metadata": {"container": ext, "extension": ext, "mime_type": mime},
            "delivery": {"kind": "file", "sources": [{"url": url}]},
        },
    }


def _sample_parse_envelope(cdn_base: str, *, expired_first: bool = False, mux_only: bool = False, deferred_p2: bool = False) -> dict:
    video_url = f"{cdn_base}/media/expired.mp4" if expired_first else f"{cdn_base}/media/video.mp4"
    if mux_only:
        variants = [{
            "id": "mux-1080p", "label": "1080p", "state": "ready",
            "delivery": {
                "kind": "mux", "output": {"container": "mp4", "extension": "mp4", "mime_type": "video/mp4"},
                "resources": [
                    {"id": "v1", "role": "video", "metadata": {"extension": "mp4"}, "delivery": {"kind": "file", "sources": [{"url": f"{cdn_base}/media/v.mp4"}]}},
                    {"id": "a1", "role": "audio", "metadata": {"extension": "m4a"}, "delivery": {"kind": "file", "sources": [{"url": f"{cdn_base}/media/a.m4a"}]}},
                ],
            },
        }]
        default_sel = None
    else:
        variants = [{
            "id": "v-1080p", "label": "1080p", "state": "ready",
            "metadata": {"extension": "mp4", "mime_type": "video/mp4", "width": 1920, "height": 1080, "has_audio": True},
            "delivery": {"kind": "file", "sources": [{"id": "s1", "url": video_url, "access": "direct"}]},
        }]
        default_sel = {"variant_id": "v-1080p", "source_id": "s1", "url": video_url, "access": "direct"}

    items = [{"id": "item-1", "type": "video", "state": "ready", "title": "Sample Video", "default": default_sel, "variants": variants}]
    if deferred_p2:
        items.append({
            "id": "item-2", "type": "video", "state": "deferred", "default": None,
            "default_unavailable_reason": "needs_resolve",
            "resolve_url": "/api/resolve?schema_version=1.0&platform=bilibili&url=https%3A%2F%2Fb23.tv%2Fdemo&item_id=item-2",
        })
    return {
        "schema_version": "1.0", "code": "OK",
        "data": {
            "platform": "youtube", "content_id": "vid12345678", "title": "Sample Video",
            "source_url": "https://www.youtube.com/watch?v=vid12345678",
            "refresh_url": "/api/parse?schema_version=1.0&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dvid12345678&refreshed=1",
            "items": items,
            "attachments": [
                _sub_att("sub-zh-auto", "zh-Hans", "Chinese (auto)", "auto", "vtt", "text/vtt", f"{cdn_base}/sub/zh_auto.vtt"),
                _sub_att("sub-zh-manual", "zh-Hans", "Chinese (manual)", "manual", "vtt", "text/vtt", f"{cdn_base}/sub/zh_manual.vtt"),
                _sub_att("sub-en-srt", "en-US", "English SRT", "manual", "srt", "application/x-subrip", f"{cdn_base}/sub/en.srt"),
                _sub_att("sub-oversize", "fr", "Oversize French", "manual", "vtt", "text/vtt", f"{cdn_base}/sub/oversize.vtt"),
            ],
        },
    }


class _MockServerState:
    def __init__(self) -> None:
        self.base_url = ""
        self.rate_limit_once = False
        self.cb_503_once = False
        self.require_auth = False
        self.auth_401_hits = 0
        self.last_auth_header: str | None = None


class _MockDokiToolHandler(BaseHTTPRequestHandler):
    state: _MockServerState

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def _send_json(self, status: int, payload: dict, extra_headers: dict[str, str] | None = None) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, content_type: str, body: bytes) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        self.state.last_auth_header = self.headers.get("Authorization")

        if parsed.path.startswith("/api/"):
            if self.state.require_auth and self.headers.get("Authorization") != f"Bearer {TEST_TOKEN}":
                self.state.auth_401_hits += 1
                self._send_json(401, {"schema_version": "1.0", "code": "INVALID_INPUT", "error": {"code": "INVALID_INPUT", "message": "Invalid token", "retryable": False}})
                return
            if self.state.rate_limit_once:
                self.state.rate_limit_once = False
                self._send_json(429, {"schema_version": "1.0", "code": "RATE_LIMITED", "error": {"code": "RATE_LIMITED", "message": "Slow down", "retryable": True, "retry_after_seconds": 1}}, {"Retry-After": "1"})
                return
            if self.state.cb_503_once:
                self.state.cb_503_once = False
                self._send_json(503, {"schema_version": "1.0", "code": "UPSTREAM_UNAVAILABLE", "error": {"code": "UPSTREAM_UNAVAILABLE", "message": "Circuit open", "retryable": True, "retry_after_seconds": 1}})
                return

        if parsed.path == "/api/platforms":
            self._send_json(200, {"schema_version": "1.0", "code": "OK", "data": {"platforms": [{"id": "douyin", "name": "Douyin", "site_url": "https://www.douyin.com/", "capabilities": ["video"]}]}})
        elif parsed.path == "/api/parse":
            target = (qs.get("url") or [""])[0]
            self._send_json(200, _sample_parse_envelope(self.state.base_url, expired_first=("expired" in target and "refreshed" not in qs), mux_only=("mux" in target), deferred_p2=("multi" in target)))
        elif parsed.path == "/api/resolve":
            env = _sample_parse_envelope(self.state.base_url)
            env["data"]["items"][0]["id"] = (qs.get("item_id") or ["item-2"])[0]
            self._send_json(200, env)
        elif parsed.path == "/sub/zh_manual.vtt":
            self._send_bytes("text/vtt; charset=utf-8", "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\n<c>你好</c> 世界\n\n00:00:02.000 --> 00:00:04.000\n你好 世界\n\n00:00:04.000 --> 00:00:06.000\n第二行字幕\n".encode("utf-8"))
        elif parsed.path == "/sub/zh_auto.vtt":
            self._send_bytes("text/vtt", b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nAuto line\n")
        elif parsed.path == "/sub/en.srt":
            self._send_bytes("application/x-subrip", b"1\n00:00:01,000 --> 00:00:03,500\nHello &amp; welcome\n")
        elif parsed.path == "/sub/oversize.vtt":
            self.send_response(200)
            self.send_header("Content-Type", "text/vtt")
            self.send_header("Content-Length", str(security.MAX_SUBTITLE_BYTES + 1))
            self.end_headers()
        elif parsed.path == "/media/expired.mp4":
            self.send_response(403)
            self.end_headers()
        elif parsed.path in ("/media/video.mp4", "/media/v.mp4", "/media/a.m4a"):
            self._send_bytes("video/mp4", b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"0" * 64)
        else:
            self.send_response(404)
            self.end_headers()


class CLIAndSubtitlesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state = _MockServerState()
        handler_cls = type("BoundHandler", (_MockDokiToolHandler,), {"state": self.state})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
        self.state.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.local_fetcher = security.SafeHTTPFetcher(timeout=5.0, url_validator=lambda u, **kw: urllib.parse.urlsplit(u))

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)

    def test_cli_rejects_token_flags_without_echoing_secret(self) -> None:
        secret = "SuperSecretTokenValue1234567890ABCDEF"
        for argv in (
            ["platforms", "--token", secret],
            ["platforms", f"--token={secret}"],
            ["parse", "-t", secret, "https://example.com/v/1"],
            ["parse", f"-t{secret}", "https://example.com/v/1"],
        ):
            with self.subTest(argv=argv):
                err = io.StringIO()
                with mock.patch("sys.stderr", err):
                    rc = cli.main(argv)
                self.assertEqual(rc, 2)
                self.assertNotIn(secret, err.getvalue())
                self.assertIn("DOKITOOL_API_TOKEN", err.getvalue())

    def test_cli_subcommands_and_opt_in_gates(self) -> None:
        err = io.StringIO()
        with mock.patch("sys.stderr", err):
            self.assertEqual(cli.main(["download", "--api-base", self.state.base_url, "https://example.com/v/1"]), 2)
            self.assertEqual(cli.main(["subtitles", "--api-base", self.state.base_url, "--output-dir", "/tmp", "https://example.com/v/1"]), 2)
        self.assertIn("--allow-write", err.getvalue())

        out = io.StringIO()
        with mock.patch("sys.stdout", out):
            rc = cli.main(["platforms", "--api-base", self.state.base_url])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out.getvalue())["count"], 1)

        out2 = io.StringIO()
        with mock.patch("sys.stdout", out2):
            rc2 = cli.main(["parse", "--api-base", self.state.base_url, "--resolve-item", "item-2", "https://b23.tv/multi"])
        self.assertEqual(rc2, 0)
        self.assertEqual(json.loads(out2.getvalue())["items"][0]["id"], "item-2")

    def test_api_client_auth_401_no_retry_and_429_503_backoff(self) -> None:
        sleeps: list[float] = []
        self.state.require_auth = True
        bad_client = api_client.DokiToolClient(self.state.base_url, token="X" * 40, sleep_fn=sleeps.append, fetcher=self.local_fetcher)
        with self.assertRaises(api_client.DokiToolAuthError):
            bad_client.list_platforms()
        self.assertEqual(self.state.auth_401_hits, 1)
        self.assertEqual(sleeps, [])

        ok_client = api_client.DokiToolClient(self.state.base_url, token=TEST_TOKEN, sleep_fn=sleeps.append, fetcher=self.local_fetcher)
        self.state.rate_limit_once = True
        self.state.cb_503_once = True
        self.assertEqual(ok_client.list_platforms()["code"], "OK")
        self.assertEqual(len(sleeps), 2)
        self.assertEqual(self.state.last_auth_header, f"Bearer {TEST_TOKEN}")

    def test_subtitle_track_kind_filtering_conversions_and_5mib_cap(self) -> None:
        data = _sample_parse_envelope(self.state.base_url)["data"]
        tracks = subtitles.discover_subtitle_tracks(data)
        self.assertEqual([t.id for t in tracks[:2]], ["sub-zh-manual", "sub-oversize"])
        self.assertEqual(tracks[-1].track_kind, "auto")

        self.assertEqual([t.id for t in subtitles.select_subtitle_tracks(tracks, lang="zh", track_kind="manual")], ["sub-zh-manual"])
        self.assertEqual([t.id for t in subtitles.select_subtitle_tracks(tracks, lang="zh", track_kind="auto")], ["sub-zh-auto"])
        self.assertEqual([t.id for t in subtitles.select_subtitle_tracks(tracks, lang="zh", track_kind="all", select_all=True)], ["sub-zh-manual", "sub-zh-auto"])

        res_txt = subtitles.extract_subtitles_from_data(data, self.local_fetcher, lang="zh", track_kind="manual", output_format="text")
        self.assertEqual(res_txt["tracks"][0]["content"], "你好 世界\n第二行字幕\n")

        res_srt = subtitles.extract_subtitles_from_data(data, self.local_fetcher, lang="zh", track_kind="manual", output_format="srt")
        self.assertIn("00:00:00,500 --> 00:00:02,000", res_srt["tracks"][0]["content"])

        res_vtt = subtitles.extract_subtitles_from_data(data, self.local_fetcher, lang="en", track_kind="manual", output_format="vtt")
        self.assertIn("WEBVTT", res_vtt["tracks"][0]["content"])
        self.assertIn("Hello & welcome", res_vtt["tracks"][0]["content"])

        with self.assertRaises(security.SizeLimitExceededError):
            subtitles.extract_subtitles_from_data(data, self.local_fetcher, lang="fr")

        ttml = '<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.500">Line 1<br/>Line 2</p></div></body></tt>'
        self.assertEqual(subtitles.render_subtitles(ttml, "ttml", "text"), ("Line 1\nLine 2\n", 1))

        srv3 = '<timedtext><body><p t="1000" d="1500"><s>Hello </s><s>world</s></p></body></timedtext>'
        srv3_srt, srv3_cnt = subtitles.render_subtitles(srv3, "srv3", "srt")
        self.assertEqual(srv3_cnt, 1)
        self.assertIn("00:00:01,000 --> 00:00:02,500\nHello world", srv3_srt)

        with self.assertRaises(security.SecurityError):
            subtitles.parse_cues("<!DOCTYPE foo [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><tt/>", "ttml")

        # Malformed / NaN / Inf XML timing attributes are safely ignored without crashing
        bad_xml = '<timedtext><body><p t="NaN" d="Inf">bad1</p><p t="abc" d="100">bad2</p><p t="1000" d="500">good</p></body></timedtext>'
        self.assertEqual(subtitles.render_subtitles(bad_xml, "srv3", "text"), ("good\n", 1))
        bad_legacy = '<transcript><text start="inf" dur="1">skip</text><text start="2.0" dur="bad">ok</text></transcript>'
        self.assertEqual(subtitles.render_subtitles(bad_legacy, "xml", "text"), ("ok\n", 1))

    def test_api_relative_path_validation_and_cli_oserror_handling(self) -> None:
        self.assertEqual(
            api_client._validate_api_relative_path("/api/parse?schema_version=1.0&url=https://example.com/v"),
            "/api/parse?schema_version=1.0&url=https://example.com/v",
        )
        for bad in (
            "/api/parse-evil?x=1", "/api/parse/extra?x=1", "/api/parse/%2e%2e/monitor",
            "//evil.example.com/api/parse?x=1", "https://evil.example.com/api/parse?x=1", "/api/stats",
        ):
            with self.assertRaises(security.SecurityError, msg=bad):
                api_client._validate_api_relative_path(bad)
        with self.assertRaises(security.SecurityError):
            api_client._validate_api_relative_path("/api/resolve", required_path="/api/resolve", require_query=True)

        err = io.StringIO()
        with mock.patch.object(api_client.DokiToolClient, "list_platforms", side_effect=PermissionError("denied https://x.test/a?sig=SECRET")):
            with mock.patch("sys.stderr", err):
                rc = cli.main(["platforms", "--api-base", self.state.base_url])
        self.assertEqual(rc, 1)
        self.assertNotIn("SECRET", err.getvalue())

    def test_opt_in_download_refresh_retry_and_ffmpeg_gate(self) -> None:
        client = api_client.DokiToolClient(self.state.base_url, fetcher=self.local_fetcher)
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "downloads"
            with self.assertRaises(security.SecurityError):
                downloader.download_media(client, "https://example.com/video/1", out_dir, allow_write=False)

            res = downloader.download_media(
                client, "https://example.com/video/expired", out_dir, allow_write=True,
                include_subtitles=True, subtitle_lang="zh", subtitle_kind="manual", subtitle_format="vtt",
            )
            self.assertEqual(len(res["files"]), 1)
            self.assertTrue((out_dir / res["files"][0]["file"]).is_file())
            self.assertEqual(len(res["subtitle_files"]), 1)
            self.assertTrue((out_dir / res["subtitle_files"][0]["file"]).is_file())

            with self.assertRaises(security.SecurityError):
                downloader.download_media(client, "https://example.com/video/1", out_dir, allow_write=True, filename="../escape.mp4")

            with self.assertRaises(downloader.DownloadError):
                downloader.download_media(client, "https://example.com/video/mux", out_dir, allow_write=True, allow_ffmpeg=False)

            captured_cmds: list[tuple[list[str], bool]] = []

            def _fake_ffmpeg(cmd, **kwargs):
                captured_cmds.append((list(cmd), bool(kwargs.get("shell"))))
                Path(cmd[-1]).write_bytes(b"MUXED_MP4_DATA")
                return subprocess.CompletedProcess(cmd, 0, b"", b"")

            with mock.patch("shutil.which", return_value="/usr/bin/ffmpeg"):
                mux_res = downloader.download_media(
                    client, "https://example.com/video/mux", out_dir, allow_write=True,
                    allow_ffmpeg=True, filename="muxed_out.mp4", subprocess_runner=_fake_ffmpeg,
                )
            self.assertEqual(len(captured_cmds), 1)
            cmd, used_shell = captured_cmds[0]
            self.assertFalse(used_shell)
            # -protocol_whitelist file must precede BOTH -i inputs
            self.assertEqual(cmd.count("-protocol_whitelist"), 2)
            self.assertEqual(mux_res["files"][0]["file"], "muxed_out.mp4")
            self.assertEqual((out_dir / "muxed_out.mp4").read_bytes(), b"MUXED_MP4_DATA")

            # mkv container maps to ffmpeg muxer name 'matroska', and leading '-' filename is rejected
            v_tmp, a_tmp = out_dir / "v_in.mp4", out_dir / "a_in.m4a"
            v_tmp.write_bytes(b"V")
            a_tmp.write_bytes(b"A")
            mkv_cmds: list[list[str]] = []

            def _fake_mkv(c, **kw):
                mkv_cmds.append(list(c))
                Path(c[-1]).write_bytes(b"MKV")
                return subprocess.CompletedProcess(c, 0, b"", b"")

            with mock.patch("shutil.which", return_value="/usr/bin/ffmpeg"):
                downloader._mux_with_ffmpeg(v_tmp, a_tmp, out_dir / "out.mkv", out_dir, "mkv", _fake_mkv)
                with self.assertRaises(security.SecurityError):
                    downloader._mux_with_ffmpeg(v_tmp, a_tmp, out_dir / "-evil.mp4", out_dir, "mp4", _fake_mkv)
            self.assertEqual(mkv_cmds[0][mkv_cmds[0].index("-f") + 1], "matroska")

            # Duplicate subtitle filenames are disambiguated rather than overwritten
            dup_saved = downloader.write_subtitle_files(
                [
                    {"language": "en", "track_kind": "manual", "output_format": "vtt", "content": "one"},
                    {"language": "en", "track_kind": "manual", "output_format": "vtt", "content": "two"},
                ],
                out_dir, allow_write=True, stem_prefix="dup",
            )
            self.assertEqual(len({f["file"] for f in dup_saved}), 2)
            self.assertEqual((out_dir / dup_saved[0]["file"]).read_text(encoding="utf-8"), "one")
            self.assertEqual((out_dir / dup_saved[1]["file"]).read_text(encoding="utf-8"), "two")

            # Extension allowlist: malicious metadata/URL suffixes fall back to magic sniffing or 'bin'
            raw_part = out_dir / "unknown.part"
            raw_part.write_bytes(b"NOT_A_KNOWN_MEDIA_MAGIC")
            mp4_part = out_dir / "mp4.part"
            mp4_part.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
            for bad_ext in ("exe", "bat", "ps1", "sh", "cmd", "html"):
                self.assertEqual(downloader._infer_ext({"extension": bad_ext}, {}, f"https://cdn.test/a.{bad_ext}", raw_part), "bin")
                self.assertEqual(downloader._infer_ext({"container": bad_ext}, {}, f"https://cdn.test/a.{bad_ext}", mp4_part), "mp4")
            self.assertEqual(downloader._infer_ext({"extension": "jpeg"}, {}, "https://cdn.test/a", raw_part), "jpg")
            self.assertEqual(downloader._infer_ext({"extension": "flac"}, {}, "https://cdn.test/a", raw_part), "flac")

            # Explicit --filename enforces strict passive allowlist (rejects scripts, dotfiles, extensionless)
            for bad_fn in (
                "payload.exe", "run.sh", "script.ps1", "drop.bat", "index.html",
                "sub/ok.mp4", "a\\b.mp4", ".bashrc", ".hidden.mp4", "script.py",
                "script.rb", "noext", "CON.mp4", "video.mp4:ads", "trail.mp4.",
            ):
                with self.assertRaises(security.SecurityError, msg=bad_fn):
                    downloader.download_media(client, "https://example.com/video/1", out_dir, allow_write=True, filename=bad_fn)

            # NV-16: default no-clobber refuses overwriting existing file unless overwrite=True
            no_clobber = out_dir / "keep.mp4"
            no_clobber.write_bytes(b"ORIGINAL_BYTES")
            with self.assertRaises(downloader.DownloadError):
                downloader.download_media(client, "https://example.com/video/1", out_dir, allow_write=True, filename="keep.mp4")
            self.assertEqual(no_clobber.read_bytes(), b"ORIGINAL_BYTES")
            downloader.download_media(
                client, "https://example.com/video/1", out_dir, allow_write=True, filename="keep.mp4", overwrite=True
            )
            self.assertNotEqual(no_clobber.read_bytes(), b"ORIGINAL_BYTES")

            # Subtitle writes disambiguate against existing files on disk when overwrite=False
            existing_sub = downloader.write_subtitle_files(
                [{"language": "en", "track_kind": "manual", "output_format": "vtt", "content": "three"}],
                out_dir, allow_write=True, stem_prefix="dup",
            )
            self.assertNotIn(existing_sub[0]["file"], {f["file"] for f in dup_saved})

            # CLI --no-proxy and --overwrite flags parse cleanly across subcommands
            args_parse = cli.build_parser().parse_args(["parse", "--no-proxy", "https://example.com/v/1"])
            args_mcp = cli.build_parser().parse_args(["mcp", "--no-proxy"])
            args_dl = cli.build_parser().parse_args(["download", "--allow-write", "--output-dir", str(out_dir), "--overwrite", "https://example.com/v/1"])
            self.assertTrue(args_parse.no_proxy and args_mcp.no_proxy and args_dl.overwrite)

    def test_p1_5_json3_nv17_budgets_nv18_bounds_and_p2_2_version_ssot(self) -> None:
        # P2-2: Single AGENT_VERSION SSOT across facade and MCP server
        self.assertEqual(dokitool_agent.__version__, security.AGENT_VERSION)
        self.assertEqual(mcp_server.SERVER_INFO["version"], security.AGENT_VERSION)

        # P1-5: json3 subtitle discovery & rendering
        json3_payload = json.dumps({
            "events": [
                {"tStartMs": 500, "dDurationMs": 1500, "segs": [{"utf8": "Hello "}, {"utf8": "JSON3"}]},
                {"tStartMs": 2500, "dDurationMs": 1000, "segs": [{"utf8": "Second line"}]},
            ]
        })
        txt, cnt = subtitles.render_subtitles(json3_payload, "json3", "text")
        self.assertEqual(cnt, 2)
        self.assertEqual(txt, "Hello JSON3\nSecond line\n")

        # NV-13: raw subtitle output rejects non-subtitle HTML/arbitrary text
        with self.assertRaises(security.SecurityError):
            subtitles.render_subtitles("<html><body>not subtitles</body></html>", "vtt", "raw")
        raw_ok, raw_cnt = subtitles.render_subtitles("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOk\n", "vtt", "raw")
        self.assertEqual(raw_cnt, 1)
        self.assertIn("WEBVTT", raw_ok)

        # NV-18: linear _INLINE_TAG_RE, XML nesting depth cap, no nested <p> amplification, output cap
        self.assertEqual(subtitles._clean_cue_text("<" * 50_000 + "ok"), "<" * 50_000 + "ok")
        deep_xml = "<tt>" + "<div>" * 40 + "<p begin='00:00:01.000' end='00:00:02.000'>x</p>" + "</div>" * 40 + "</tt>"
        with self.assertRaises(security.SecurityError):
            subtitles.parse_cues(deep_xml, "ttml")
        nested_p = "<tt><body><p begin='00:00:01.000' end='00:00:02.000'>outer<p begin='00:00:01.000' end='00:00:02.000'>inner</p></p></body></tt>"
        nested_cues = subtitles.parse_cues(nested_p, "ttml")
        self.assertEqual(len(nested_cues), 1)
        self.assertEqual(nested_cues[0].text, "outer")
        with self.assertRaises(security.SizeLimitExceededError):
            subtitles.render_subtitles("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n" + ("A" * 500), "vtt", "text", max_output_bytes=128)

        # NV-17: track fan-out cap, URL dedup, and total byte budget
        many_atts = [
            _sub_att(f"sub-{i}", "en", f"Track {i}", "manual", "vtt", "text/vtt", f"{self.state.base_url}/sub/zh_auto.vtt")
            for i in range(25)
        ]
        data = {"platform": "youtube", "content_id": "fanout", "title": "Fanout", "attachments": many_atts}
        fetch_calls = {"n": 0}
        orig_fetch = self.local_fetcher.fetch_bytes

        def _counting_fetch(*args, **kwargs):
            fetch_calls["n"] += 1
            return orig_fetch(*args, **kwargs)

        with mock.patch.object(self.local_fetcher, "fetch_bytes", side_effect=_counting_fetch):
            res = subtitles.extract_subtitles_from_data(data, self.local_fetcher, select_all=True, max_tracks=4)
        self.assertEqual(res["selected_count"], 4)
        self.assertTrue(res.get("truncated_tracks"))
        self.assertEqual(fetch_calls["n"], 1)
        with self.assertRaises(security.SizeLimitExceededError):
            subtitles.extract_subtitles_from_data(data, self.local_fetcher, select_all=True, max_tracks=4, max_total_bytes=60)

    def test_v452_cr09_pair_two_phase_commit_and_zero_self_conflict_on_refresh(self) -> None:
        pair_state = {"video_expired_once": True, "video_fail_always": False}
        img_bytes = b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"I" * 32
        vid_bytes = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"V" * 48

        class PairHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # noqa: A002
                return

            def do_GET(self) -> None:  # noqa: N802
                parsed = urllib.parse.urlsplit(self.path)
                origin = f"http://127.0.0.1:{self.server.server_port}"
                if parsed.path == "/api/parse":
                    qs = urllib.parse.parse_qs(parsed.query)
                    refreshed = "refreshed" in qs
                    vid_path = "/media/pair_vid_ok.mp4" if refreshed else "/media/pair_vid_exp.mp4"
                    payload = json.dumps({
                        "schema_version": "1.0",
                        "code": "OK",
                        "data": {
                            "platform": "xiaohongshu",
                            "content_id": "live1234",
                            "title": "Live Photo",
                            "source_url": "https://www.xiaohongshu.com/explore/live1234",
                            "refresh_url": "/api/parse?schema_version=1.0&url=https%3A%2F%2Fwww.xiaohongshu.com%2Fexplore%2Flive1234&refreshed=1",
                            "items": [{
                                "id": "live-1",
                                "type": "live_photo",
                                "state": "ready",
                                "variants": [{
                                    "id": "pair-main",
                                    "state": "ready",
                                    "delivery": {
                                        "kind": "pair",
                                        "resources": [
                                            {"id": "img", "role": "image", "metadata": {"extension": "jpg"}, "delivery": {"kind": "file", "sources": [{"url": f"{origin}/media/pair_img.jpg"}]}},
                                            {"id": "vid", "role": "video", "metadata": {"extension": "mp4"}, "delivery": {"kind": "file", "sources": [{"url": f"{origin}{vid_path}"}]}},
                                        ],
                                    },
                                }],
                            }],
                        },
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                if parsed.path == "/media/pair_img.jpg":
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(img_bytes)))
                    self.end_headers()
                    self.wfile.write(img_bytes)
                    return
                if parsed.path == "/media/pair_vid_exp.mp4":
                    if pair_state["video_fail_always"]:
                        self.send_response(500)
                        self.end_headers()
                        return
                    if pair_state["video_expired_once"]:
                        pair_state["video_expired_once"] = False
                        self.send_response(403)
                        self.end_headers()
                        return
                if parsed.path == "/media/pair_vid_ok.mp4":
                    self.send_response(200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Content-Length", str(len(vid_bytes)))
                    self.end_headers()
                    self.wfile.write(vid_bytes)
                    return
                self.send_response(404)
                self.end_headers()

        srv = ThreadingHTTPServer(("127.0.0.1", 0), PairHandler)
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            origin = f"http://127.0.0.1:{srv.server_port}"
            client = api_client.DokiToolClient(origin, fetcher=self.local_fetcher)
            with tempfile.TemporaryDirectory() as tmp:
                out_dir = Path(tmp) / "pair_ok"
                # 1) Image succeeds then video returns 403 -> refresh retries with overwrite=False (zero self-conflict!)
                res = downloader.download_media(
                    client, "https://www.xiaohongshu.com/explore/live1234", out_dir,
                    allow_write=True, overwrite=False,
                )
                self.assertEqual(len(res["files"]), 2)
                self.assertEqual((out_dir / res["files"][0]["file"]).read_bytes(), img_bytes)
                self.assertEqual((out_dir / res["files"][1]["file"]).read_bytes(), vid_bytes)
                self.assertEqual([p.name for p in out_dir.iterdir() if p.name.startswith(".")], [])

                # 2) Pre-existing video file with overwrite=False must fail BEFORE committing image (no stray files)
                out_nc = Path(tmp) / "pair_noclobber"
                out_nc.mkdir(parents=True, exist_ok=True)
                existing_vid = out_nc / "xiaohongshu_live1234_live-1_video.mp4"
                existing_vid.write_bytes(b"KEEP_ME")
                with self.assertRaises(downloader.DownloadError):
                    downloader.download_media(
                        client, "https://www.xiaohongshu.com/explore/live1234", out_nc,
                        allow_write=True, overwrite=False,
                    )
                self.assertEqual(existing_vid.read_bytes(), b"KEEP_ME")
                self.assertEqual([p.name for p in out_nc.iterdir()], [existing_vid.name])

                # 3) Hard failure on 2nd resource leaves zero committed or hidden temp files
                out_fail = Path(tmp) / "pair_fail"
                pair_state["video_fail_always"] = True
                with self.assertRaises(downloader.DownloadError):
                    downloader.download_media(
                        client, "https://www.xiaohongshu.com/explore/live1234", out_fail,
                        allow_write=True, overwrite=False,
                    )
                self.assertEqual(list(out_fail.iterdir()), [])
        finally:
            srv.shutdown()
            srv.server_close()
            th.join(timeout=2.0)

    def test_v452_cr10_subtitle_wall_clock_deadline_enforced_on_slow_drip_and_subsecond_budget(self) -> None:
        import time as _time

        class SlowDripHandler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args) -> None:  # noqa: A002
                return

            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/sub/drip.vtt":
                    self.send_response(200)
                    self.send_header("Content-Type", "text/vtt")
                    self.end_headers()
                    try:
                        self.wfile.write(b"WEBVTT\n\n")
                        self.wfile.flush()
                        for i in range(15):
                            _time.sleep(0.15)
                            self.wfile.write(f"00:00:{i:02d}.000 --> 00:00:{i:02d}.500\nline {i}\n\n".encode("utf-8"))
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        return
                    return
                self.send_response(404)
                self.end_headers()

        srv = ThreadingHTTPServer(("127.0.0.1", 0), SlowDripHandler)
        th = threading.Thread(target=srv.serve_forever, daemon=True)
        th.start()
        try:
            origin = f"http://127.0.0.1:{srv.server_port}"
            data = {
                "platform": "youtube",
                "content_id": "drip1",
                "title": "Slow Drip",
                "attachments": [
                    _sub_att("sub-drip", "en", "Drip", "manual", "vtt", "text/vtt", f"{origin}/sub/drip.vtt"),
                ],
            }
            t0 = _time.monotonic()
            with self.assertRaises(RuntimeError) as ctx:
                subtitles.extract_subtitles_from_data(data, self.local_fetcher, lang="en", total_timeout=0.35)
            elapsed = _time.monotonic() - t0
            self.assertIn("budget", str(ctx.exception).lower())
            self.assertLess(elapsed, 0.9, f"slow-drip subtitle exceeded wall-clock deadline: elapsed={elapsed:.3f}s")
        finally:
            srv.shutdown()
            srv.server_close()
            th.join(timeout=2.0)


if __name__ == "__main__":
    unittest.main()
