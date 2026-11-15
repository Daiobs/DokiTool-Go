#!/usr/bin/env python3
"""Offline unit tests for scripts/prod-smoke/smoke.py (zero external network)."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
import urllib.parse

SMOKE_DIR = Path(__file__).resolve().parent
if str(SMOKE_DIR) not in sys.path:
    sys.path.insert(0, str(SMOKE_DIR))

import smoke  # noqa: E402


class FakeClock(smoke.Clock):
    """Deterministic virtual clock with recorded sleep intervals."""

    def __init__(self, initial: float = 1000.0) -> None:
        self.current = initial
        self.sleeps: list[float] = []
        super().__init__(
            now_fn=self._now,
            sleep_fn=self._sleep,
            utc_now_fn=lambda: datetime(2026, 11, 15, 5, 0, 0, tzinfo=timezone.utc),
        )

    def _now(self) -> float:
        return self.current

    def _sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.current += seconds

    def advance(self, seconds: float) -> None:
        self.current += seconds


def make_envelope(
    platform: str,
    *,
    generated_at: str = "2026-11-15T05:00:00Z",
    media_url: str | None = None,
    browser_fetch: str | None = None,
    access: str = "direct",
    delivery_kind: str = "file",
    container: str = "mp4",
    cover_url: str | None = None,
) -> dict:
    default_hosts = {
        "douyin": ("https://v26-cold.douyinvod.com/abc/video.mp4?sign=dysecret", "allowed"),
        "kuaishou": ("https://alimov2.a.kwimgs.com/upic/ks.mp4?pkey=kssecret", "allowed"),
        "bilibili": ("https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/bili.m4s?e=1", None),
        "xiaohongshu": ("https://sns-web-i10.rednotecdn.com/spectrum/xhs.jpg?sign=xhssecret", "allowed"),
        "toutiao": ("https://v3-tt.ixigua.com/tt/video.mp4?token=ttsecret", None),
        "weibo": ("/api/media/weibo?ticket=wbsecretticket999", None),
        "pipixia": ("https://v3-ppx.ppxvod.com/ppx/video.mp4?br=1000", "allowed"),
        "pipigx": ("https:// video.pipigx.com/pp/video.mp4".replace(" ", ""), None),
        "zuiyou": ("https://tbvideo.ixiaochuan.cn/zy/video.mp4", None),
        "x": ("https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/x.mp4?tag=12", None),
        "youtube": ("https://rr1---sn-abc.googlevideo.com/videoplayback?expire=999&sig=ytsig", None),
        "instagram": ("https://scontent.cdninstagram.com/v/t50.2886-16/ig.mp4?_nc_ht=ig", None),
        "facebook": ("https://video.xx.fbcdn.net/v/t42.1790-2/fb.mp4?efg=abc", None),
        "tumblr": ("https://va.media.tumblr.com/tumblr_sample.mp4", None),
        "dailymotion": ("https://proxy-01.dailymotion.com/sec(secret)/video/dm.mp4", None),
    }
    chosen_url, default_bf = default_hosts.get(
        platform, ("https://cdn.example.com/v.mp4", None)
    )
    if media_url is not None:
        chosen_url = media_url
    chosen_bf = default_bf if browser_fetch is None else (
        None if browser_fetch == "__OMIT__" else browser_fetch
    )
    if platform == "weibo" and media_url is None:
        access = "relay"

    source: dict = {"id": "s-1", "url": chosen_url, "access": access}
    if chosen_bf:
        source["browser_fetch"] = chosen_bf

    if delivery_kind == "mux":
        delivery = {
            "kind": "mux",
            "resources": [
                {
                    "id": "video",
                    "role": "video",
                    "metadata": {"container": "mp4", "evidence": "upstream"},
                    "delivery": {"kind": "file", "sources": [source]},
                },
                {
                    "id": "audio",
                    "role": "audio",
                    "metadata": {"container": "m4a", "evidence": "upstream"},
                    "delivery": {"kind": "file", "sources": [dict(source, id="s-2")]},
                },
            ],
        }
    elif delivery_kind == "segments":
        delivery = {
            "kind": "segments",
            "pieces": [{"index": 1, "sources": [source]}],
        }
    else:
        delivery = {"kind": delivery_kind, "sources": [source]}

    item: dict = {
        "id": f"{platform}-item-1",
        "type": "image" if platform == "xiaohongshu" and chosen_url.endswith(".jpg?sign=xhssecret") else "video",
        "variants": [
            {
                "id": "v-1",
                "state": "ready",
                "metadata": {"container": container, "extension": container, "evidence": "upstream"},
                "delivery": delivery,
            }
        ],
    }
    if delivery_kind == "file":
        default_obj: dict = {
            "variant_id": "v-1",
            "source_id": "s-1",
            "url": chosen_url,
            "access": access,
        }
        item["default"] = default_obj
    if cover_url:
        item["cover"] = {"url": cover_url, "access": "direct"}

    return {
        "schema_version": "1.0",
        "code": "OK",
        "data": {
            "platform": platform,
            "generated_at": generated_at,
            "items": [item],
        },
    }


class FakeDokiServer:
    """Thread-safe fake DokiTool-Go HTTP server bound to 127.0.0.1:0."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.lock = threading.Lock()
        self.static_files: dict[str, bytes] = {
            "index.html": b"<!doctype html><title>DokiTool</title>\n",
            "assets/app.js": b"console.log('dokitool');\n",
            "helper/dokitool-youtube.user.js": b"// ==UserScript==\n// @name DokiTool\n",
        }
        self.platforms: list[str] = list(
            json.loads((SMOKE_DIR / "samples.json").read_text(encoding="utf-8"))[
                "expected_platforms"
            ]
        )
        self.parse_Requests: list[dict] = []
        self.all_requests: list[dict] = []
        self.custom_parse_handler = None
        self.redirect_on_platforms = False

        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, fmt: str, *args) -> None:  # noqa: ANN002
                return

            def do_GET(self) -> None:  # noqa: N802
                outer.clock.advance(0.01)
                headers_lower = {k.lower(): v for k, v in self.headers.items()}
                parsed = urllib.parse.urlsplit(self.path)
                query = dict(urllib.parse.parse_qsl(parsed.query))
                rec = {
                    "path": parsed.path,
                    "raw_path": self.path,
                    "query": query,
                    "headers": headers_lower,
                    "timestamp": outer.clock.now(),
                }
                with outer.lock:
                    outer.all_requests.append(rec)

                if parsed.path == "/api/platforms":
                    if outer.redirect_on_platforms:
                        self.send_response(302)
                        self.send_header("Location", "https://evil.example.com/steal")
                        self.end_headers()
                        return
                    payload = {
                        "schema_version": "1.0",
                        "code": "OK",
                        "data": {
                            "platforms": [{"id": pid} for pid in outer.platforms],
                        },
                    }
                    body = json.dumps(payload).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Set-Cookie", "session=must_never_be_echoed; Path=/")
                    self.end_headers()
                    self.wfile.write(body)
                    return

                if parsed.path == "/api/parse":
                    with outer.lock:
                        outer.parse_Requests.append(rec)
                    sample_url = query.get("url", "")
                    if outer.custom_parse_handler is not None:
                        status, payload = outer.custom_parse_handler(sample_url, rec)
                    else:
                        plat = outer.detect_platform(sample_url)
                        status, payload = 200, make_envelope(plat)
                    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Set-Cookie", "parse_cookie=forbidden; Path=/")
                    self.end_headers()
                    self.wfile.write(body)
                    return

                rel = "index.html" if parsed.path == "/" else parsed.path.lstrip("/")
                rel = urllib.parse.unquote(rel)
                if rel in outer.static_files:
                    data = outer.static_files[rel]
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Set-Cookie", "static_cookie=forbidden; Path=/")
                    self.end_headers()
                    self.wfile.write(data)
                    return

                self.send_response(404)
                self.end_headers()

        class FastHTTPServer(ThreadingHTTPServer):
            allow_reuse_address = True

            def server_bind(self) -> None:
                # Skip socket.getfqdn() reverse-DNS lookup on macOS/Windows loopback
                self.socket.bind(self.server_address)
                self.server_address = self.socket.getsockname()
                self.server_name = "127.0.0.1"
                self.server_port = int(self.server_address[1])

        self._httpd = FastHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self._httpd.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            kwargs={"poll_interval": 0.01},
            daemon=True,
        )

    def detect_platform(self, url: str) -> str:
        mapping = {
            "douyin.com": "douyin",
            "kuaishou.com": "kuaishou",
            "bilibili.com": "bilibili",
            "xhslink.com": "xiaohongshu",
            "xiaohongshu.com": "xiaohongshu",
            "toutiao.com": "toutiao",
            "weibo.com": "weibo",
            "pipix.com": "pipixia",
            "pipigx.com": "pipigx",
            "xiaochuankeji.cn": "zuiyou",
            "x.com": "x",
            "youtube.com": "youtube",
            "instagram.com": "instagram",
            "facebook.com": "facebook",
            "tumblr.com": "tumblr",
            "dailymotion.com": "dailymotion",
        }
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
        for suffix, plat in mapping.items():
            if host == suffix or host.endswith("." + suffix):
                return plat
        return "douyin"

    def write_manifest(self, directory: Path) -> Path:
        manifest = {
            "schema_version": "1.0",
            "release_tag": "build-test123",
            "frontend_dist_files": {
                rel: hashlib.sha256(content).hexdigest()
                for rel, content in self.static_files.items()
            },
        }
        path = directory / "release-manifest.json"
        path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return path

    def __enter__(self) -> "FakeDokiServer":
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5.0)


class ProdSmokeUnitTests(unittest.TestCase):
    def _run_cli(self, argv: list[str], clock: FakeClock) -> tuple[int, str, str]:
        out_buf = io.StringIO()
        err_buf = io.StringIO()
        old_out, old_err = sys.stdout, sys.stderr
        try:
            sys.stdout, sys.stderr = out_buf, err_buf
            rc = smoke.main(argv, clock=clock)
        finally:
            sys.stdout, sys.stderr = old_out, old_err
        return rc, out_buf.getvalue(), err_buf.getvalue()

    def test_full_default_run_with_manifest_passes_and_enforces_pacing_and_privacy(self) -> None:
        clock = FakeClock()
        with tempfile.TemporaryDirectory() as tmp, FakeDokiServer(clock) as srv:
            tmp_dir = Path(tmp)
            manifest_path = srv.write_manifest(tmp_dir)
            json_out = tmp_dir / "report.json"
            md_out = tmp_dir / "report.md"

            rc, stdout, stderr = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--manifest",
                    str(manifest_path),
                    "--json-out",
                    str(json_out),
                    "--md-out",
                    str(md_out),
                ],
                clock,
            )

            self.assertEqual(rc, 0, msg=stderr)
            self.assertEqual(stderr, "")
            report = json.loads(json_out.read_text(encoding="utf-8"))
            md_text = md_out.read_text(encoding="utf-8")
            self.assertTrue(report["passed"])
            self.assertEqual(report["summary"]["fail"], 0)
            # rate_limit is SKIP by default
            self.assertEqual(report["summary"]["skip"], 1)
            # 1 frontend + 1 platforms + 1 cache + 1 x + 1 dy_dom + 4 dm + 15 platforms = 24 PASS
            self.assertEqual(report["summary"]["pass"], 24)

            # Verify >= 8.0s pacing across all /api/parse calls (16 total: 2 cache + 14 unique platforms)
            self.assertEqual(len(srv.parse_Requests), 16)
            timestamps = [r["timestamp"] for r in srv.parse_Requests]
            for prev_ts, next_ts in zip(timestamps, timestamps[1:]):
                self.assertGreaterEqual(next_ts - prev_ts, 8.0)

            # Verify zero Cookie / Authorization headers even though server sent Set-Cookie on every response
            for req in srv.all_requests:
                self.assertNotIn("cookie", req["headers"])
                self.assertNotIn("authorization", req["headers"])
                self.assertFalse(req["path"].startswith("/api/media"))

            # Verify strict redaction on JSON, Markdown, and combined stdout
            for text in (json_out.read_text(encoding="utf-8"), md_text, stdout):
                smoke.verify_redacted_output(text)
                self.assertNotIn("http://", text)
                self.assertNotIn("https://", text)
                self.assertNotIn("127.0.0.1", text)
                self.assertNotIn("wbsecretticket999", text)
                self.assertNotIn("xhssecret", text)
                self.assertNotIn("dysecret", text)

    def test_frontend_hashes_skip_vs_explicit_fail_and_mismatch_fail(self) -> None:
        clock = FakeClock()
        with tempfile.TemporaryDirectory() as tmp, FakeDokiServer(clock) as srv:
            tmp_dir = Path(tmp)
            # 1. Default without --manifest skips frontend_hashes cleanly
            rc, out, _ = self._run_cli(
                ["--base-url", srv.base_url, "--only", "platforms", "--format", "json"],
                clock,
            )
            self.assertEqual(rc, 0)
            self.assertEqual(json.loads(out)["summary"]["fail"], 0)

            # 2. Explicit --only frontend_hashes without --manifest MUST fail
            rc2, out2, _ = self._run_cli(
                ["--base-url", srv.base_url, "--only", "frontend_hashes", "--format", "json"],
                clock,
            )
            self.assertEqual(rc2, 1)
            rep2 = json.loads(out2)
            self.assertEqual(rep2["checks"][0]["status"], "FAIL")
            self.assertEqual(rep2["checks"][0]["code"], "MISSING_MANIFEST")

            # 3. Tampered asset bytes fail SHA-256 verification
            manifest_path = srv.write_manifest(tmp_dir)
            srv.static_files["assets/app.js"] = b"tampered!\n"
            rc3, out3, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "frontend_hashes",
                    "--manifest",
                    str(manifest_path),
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc3, 1)
            rep3 = json.loads(out3)
            self.assertEqual(rep3["checks"][0]["status"], "FAIL")
            self.assertEqual(rep3["checks"][0]["code"], "HASH_MISMATCH")

    def test_retry_logic_counts_and_10s_interval(self) -> None:
        clock = FakeClock()
        attempts_by_plat: dict[str, int] = {}

        def flaky_handler(sample_url: str, _rec: dict):
            plat = "x" if "x.com" in sample_url else "douyin"
            attempts_by_plat[plat] = attempts_by_plat.get(plat, 0) + 1
            n = attempts_by_plat[plat]
            if plat == "x" and n < 2:
                return 502, {"schema_version": "1.0", "code": "UPSTREAM_ERROR"}
            if plat == "douyin":
                return 504, {"schema_version": "1.0", "code": "UPSTREAM_TIMEOUT"}
            return 200, make_envelope(plat)

        with FakeDokiServer(clock) as srv:
            srv.custom_parse_handler = flaky_handler
            rc, out, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "x_fast_path,douyin_domestic",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc, 1)
            rep = json.loads(out)
            by_id = {c["id"]: c for c in rep["checks"]}
            # x passed on 2nd try -> retry_count == 1
            self.assertEqual(by_id["x_fast_path"]["status"], "PASS")
            self.assertEqual(by_id["x_fast_path"]["retry_count"], 1)
            # douyin failed all 3 tries -> retry_count == 2
            self.assertEqual(by_id["douyin_domestic"]["status"], "FAIL")
            self.assertEqual(by_id["douyin_domestic"]["retry_count"], 2)
            self.assertEqual(attempts_by_plat["douyin"], 3)
            self.assertGreaterEqual(sum(1 for s in clock.sleeps if s >= 10.0), 3)

    def test_direct_markers_and_douyin_domestic_and_x_fast_path_assertions(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            # 1. Xiaohongshu returning cleartext http:// URL fails direct_markers
            def bad_handler(sample_url: str, _rec: dict):
                plat = srv.detect_platform(sample_url)
                if plat == "xiaohongshu":
                    return 200, make_envelope(
                        "xiaohongshu",
                        media_url="http://sns-video-bd.xhscdn.com/cleartext.mp4",
                        browser_fetch="__OMIT__",
                    )
                if plat == "douyin":
                    return 200, make_envelope(
                        "douyin",
                        media_url="https://v16-webapp-prime.tiktok.com/overseas.mp4",
                        browser_fetch="__OMIT__",
                    )
                if plat == "x":
                    return 200, make_envelope(
                        "x",
                        media_url="https://video.twimg.com/ext_tw_video/1/pl/master.m3u8",
                        delivery_kind="hls",
                        container="m3u8",
                    )
                return 200, make_envelope(plat)

            srv.custom_parse_handler = bad_handler
            rc, out, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "x_fast_path,douyin_domestic,direct_markers",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc, 1)
            rep = json.loads(out)
            by_id = {c["id"]: c for c in rep["checks"]}
            self.assertEqual(by_id["x_fast_path"]["status"], "FAIL")
            self.assertEqual(by_id["douyin_domestic"]["status"], "FAIL")
            self.assertEqual(by_id["direct_markers:xiaohongshu"]["status"], "FAIL")
            self.assertEqual(by_id["direct_markers:douyin"]["status"], "FAIL")
            self.assertEqual(by_id["direct_markers:kuaishou"]["status"], "PASS")
            self.assertEqual(by_id["direct_markers:pipixia"]["status"], "PASS")

    def test_cache_fails_when_uncached_timestamps_differ(self) -> None:
        clock = FakeClock()
        counter = {"n": 0}

        def uncached_handler(sample_url: str, _rec: dict):
            counter["n"] += 1
            plat = srv.detect_platform(sample_url)
            return 200, make_envelope(plat, generated_at=f"2026-11-15T05:00:{counter['n']:02d}Z")

        with FakeDokiServer(clock) as srv:
            srv.custom_parse_handler = uncached_handler
            rc, out, _ = self._run_cli(
                ["--base-url", srv.base_url, "--only", "cache", "--format", "json"],
                clock,
            )
            self.assertEqual(rc, 1)
            rep = json.loads(out)
            self.assertEqual(rep["checks"][0]["status"], "FAIL")
            self.assertEqual(rep["checks"][0]["retry_count"], 2)
            self.assertEqual(counter["n"], 6)

    def test_rate_limit_opt_in_guard_and_burst_429(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            # Without --enable-rate-limit, --only rate_limit fails closed without sending requests
            rc_guard, out_guard, _ = self._run_cli(
                ["--base-url", srv.base_url, "--only", "rate_limit", "--format", "json"],
                clock,
            )
            self.assertEqual(rc_guard, 1)
            self.assertEqual(len(srv.parse_Requests), 0)
            self.assertEqual(
                json.loads(out_guard)["checks"][0]["code"], "RATE_LIMIT_OPT_IN_REQUIRED"
            )

            burst_seen = {"n": 0}

            def burst_handler(sample_url: str, _rec: dict):
                if "1575560063510810624" in sample_url and burst_seen["n"] == 0:
                    # First call during x_fast_path; then burst starts
                    pass
                burst_seen["n"] += 1
                # Calls 1 (x_fast_path) + Calls 2..5 (burst #1..#4) -> 200; Calls 6..7 (burst #5..#6) -> 429
                if burst_seen["n"] <= 5:
                    return 200, make_envelope("x")
                return 429, {
                    "schema_version": "1.0",
                    "code": "RATE_LIMITED",
                    "error": {
                        "code": "RATE_LIMITED",
                        "message": "请求过于频繁",
                        "retry_after_seconds": 5,
                    },
                }

            srv.custom_parse_handler = burst_handler
            rc, out, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "x_fast_path,rate_limit",
                    "--enable-rate-limit",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc, 0)
            rep = json.loads(out)
            by_id = {c["id"]: c for c in rep["checks"]}
            self.assertEqual(by_id["x_fast_path"]["status"], "PASS")
            self.assertEqual(by_id["rate_limit"]["status"], "PASS")
            # Pool refill wait >= 21s happened before burst
            self.assertTrue(any(s >= 21.0 for s in clock.sleeps))

    def test_set_sample_and_redaction_of_hostile_upstream_errors(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            def hostile_handler(_sample_url: str, _rec: dict):
                raise RuntimeError("never reached")

            # Return HTTP 502 whose error JSON leaks URLs, xsec_token, ticket, and IPs
            def leak_handler(_sample_url: str, _rec: dict):
                return 502, {
                    "schema_version": "1.0",
                    "code": "UPSTREAM_ERROR",
                    "error": {
                        "code": "UPSTREAM_ERROR",
                        "message": (
                            "upstream https://sns-video-bd.xhscdn.com/a.mp4?sign=SIG_99&xsec_token=XSEC_SECRET_77 "
                            "ticket=RELAY_TICKET_88 from 203.0.113.55 and [2001:db8::ff00:42:8329]"
                        ),
                    },
                }

            _ = hostile_handler
            srv.custom_parse_handler = leak_handler
            rc, stdout, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "direct_markers",
                    "--set-sample",
                    "xiaohongshu=https://www.xiaohongshu.com/explore/66abc?xsec_token=XSEC_SECRET_77&xsec_source=pc_feed",
                    "--format",
                    "both",
                ],
                clock,
            )
            self.assertEqual(rc, 1)
            # Also test sanitize_text directly on the hostile message
            scrubbed = smoke.sanitize_text(
                "failed https://sns-video-bd.xhscdn.com/a.mp4?sign=SIG_99&xsec_token=XSEC_SECRET_77 "
                "xsec_token=RAW_TOK ticket=RELAY_TICKET_88 /api/media/weibo?ticket=ABC "
                "ip4=203.0.113.55 ip6=[2001:db8::ff00:42:8329]"
            )
            smoke.verify_redacted_output(scrubbed)
            smoke.verify_redacted_output(stdout)
            for forbidden in (
                "XSEC_SECRET_77",
                "xsec_token",
                "SIG_99",
                "RELAY_TICKET_88",
                "203.0.113.55",
                "2001:db8::ff00:42:8329",
                "https://",
                "http://",
            ):
                self.assertNotIn(forbidden, scrubbed)
                self.assertNotIn(forbidden, stdout)

    def test_origin_lock_and_redirect_blocking(self) -> None:
        clock = FakeClock()
        # Rejects URL credentials and paths in --base-url
        with self.assertRaises(smoke.SmokeError):
            smoke.OriginLockedClient("https://user:secret@snap.dokitool.com", clock=clock)
        with self.assertRaises(smoke.SmokeError):
            smoke.OriginLockedClient("https://snap.dokitool.com/subpath", clock=clock)

        with FakeDokiServer(clock) as srv:
            client = smoke.OriginLockedClient(srv.base_url, clock=clock)
            with self.assertRaises(smoke.SmokeError):
                client.get_raw("/api/media/weibo?ticket=abc")
            with self.assertRaises(smoke.SmokeError):
                client.get_raw("//evil.example.com/path")

            # 302 redirect on /api/platforms is blocked and never followed
            srv.redirect_on_platforms = True
            rc, out, _ = self._run_cli(
                ["--base-url", srv.base_url, "--only", "platforms", "--format", "json"],
                clock,
            )
            self.assertEqual(rc, 1)
            rep = json.loads(out)
            self.assertEqual(rep["checks"][0]["status"], "FAIL")
            self.assertEqual(rep["checks"][0]["http_status"], 302)

    def test_skip_flag_and_invalid_group_rejected(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            rc, out, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--skip",
                    "cache,x_fast_path,douyin_domestic,direct_markers,all_platforms",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc, 0)
            rep = json.loads(out)
            self.assertEqual(len(srv.parse_Requests), 0)
            by_id = {c["id"]: c["status"] for c in rep["checks"]}
            self.assertEqual(by_id["platforms"], "PASS")
            self.assertEqual(by_id["cache"], "SKIP")
            self.assertEqual(by_id["all_platforms"], "SKIP")

            rc_bad, _, err_bad = self._run_cli(
                ["--base-url", srv.base_url, "--only", "nonexistent_group"],
                clock,
            )
            self.assertEqual(rc_bad, 1)
            self.assertIn("unknown check group", err_bad)

    def test_live_photo_deferred_unavailable_and_douyin_subdomain_direct_markers(self) -> None:
        clock = FakeClock()

        # 1. Invalid item.type='live' is rejected by validate_parse_envelope
        bad_live_payload = make_envelope("douyin")
        bad_live_payload["data"]["items"][0]["type"] = "live"
        bad_resp = smoke.RawHttpResponse(
            status=200,
            headers={},
            body=json.dumps(bad_live_payload).encode("utf-8"),
            elapsed_ms=5,
        )
        with self.assertRaisesRegex(AssertionError, "invalid item.type='live'"):
            smoke.validate_parse_envelope(bad_resp, expected_platform="douyin")

        # 2. Multi-item post (ready + deferred without variants + unavailable without variants)
        #    and Douyin live_photo (delivery.kind='pair' with unmarked .douyinpic.com still image,
        #    unmarked apex douyinvod.com source, and marked v26-cold.douyinvod.com motion video)
        with FakeDokiServer(clock) as srv:
            def schema_edge_handler(sample_url: str, _rec: dict):
                plat = srv.detect_platform(sample_url)
                if plat == "bilibili":
                    env = make_envelope("bilibili")
                    env["data"]["items"].extend(
                        [
                            {
                                "id": "bili-p2",
                                "type": "video",
                                "index": 2,
                                "default": None,
                                "state": "deferred",
                                "resolve_url": "/api/resolve?schema_version=1.0&item_id=bili-p2",
                                "default_unavailable_reason": "needs_resolve",
                            },
                            {
                                "id": "bili-p3",
                                "type": "video",
                                "index": 3,
                                "default": None,
                                "state": "unavailable",
                                "default_unavailable_reason": "unavailable",
                                "error": {
                                    "code": "CONTENT_UNAVAILABLE",
                                    "message": "part unavailable",
                                },
                            },
                        ]
                    )
                    return 200, env
                if plat == "douyin":
                    return 200, {
                        "schema_version": "1.0",
                        "code": "OK",
                        "data": {
                            "platform": "douyin",
                            "generated_at": "2026-11-15T05:00:00Z",
                            "items": [
                                {
                                    "id": "dy-live-1",
                                    "type": "live_photo",
                                    "state": "ready",
                                    "default": None,
                                    "default_unavailable_reason": "processing_required",
                                    "variants": [
                                        {
                                            "id": "live-pair-1",
                                            "state": "ready",
                                            "delivery": {
                                                "kind": "pair",
                                                "resources": [
                                                    {
                                                        "id": "still",
                                                        "role": "image",
                                                        "delivery": {
                                                            "kind": "file",
                                                            "sources": [
                                                                {
                                                                    "id": "img-1",
                                                                    "url": "https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/still.jpeg?x-expires=1",
                                                                    "access": "direct",
                                                                },
                                                                {
                                                                    "id": "apex-1",
                                                                    "url": "https://douyinvod.com/apex-not-subdomain.mp4",
                                                                    "access": "direct",
                                                                },
                                                            ],
                                                        },
                                                    },
                                                    {
                                                        "id": "motion",
                                                        "role": "motion",
                                                        "delivery": {
                                                            "kind": "file",
                                                            "sources": [
                                                                {
                                                                    "id": "vid-1",
                                                                    "url": "https://v26-cold.douyinvod.com/obj/motion.mp4?sign=dy",
                                                                    "access": "direct",
                                                                    "browser_fetch": "allowed",
                                                                }
                                                            ],
                                                        },
                                                    },
                                                ],
                                            },
                                        }
                                    ],
                                }
                            ],
                        },
                    }
                return 200, make_envelope(plat)

            srv.custom_parse_handler = schema_edge_handler
            rc, out, err = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "direct_markers,douyin_domestic,all_platforms",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc, 0, msg=err or out)
            rep = json.loads(out)
            by_id = {c["id"]: c for c in rep["checks"]}
            self.assertEqual(by_id["direct_markers:douyin"]["status"], "PASS")
            self.assertIn("1/3 variant sources", by_id["direct_markers:douyin"]["note"])
            self.assertEqual(by_id["douyin_domestic"]["status"], "PASS")
            self.assertEqual(by_id["platform:bilibili"]["status"], "PASS")
            self.assertEqual(by_id["platform:douyin"]["status"], "PASS")

            # 3. Missing browser_fetch='allowed' on a real *.douyinvod.com subdomain still FAILS
            def unmarked_subdomain_handler(sample_url: str, _rec: dict):
                plat = srv.detect_platform(sample_url)
                if plat == "douyin":
                    return 200, make_envelope(
                        "douyin",
                        media_url="https://v26-cold.douyinvod.com/obj/unmarked.mp4",
                        browser_fetch="__OMIT__",
                    )
                return 200, make_envelope(plat)

            srv.custom_parse_handler = unmarked_subdomain_handler
            rc2, out2, _ = self._run_cli(
                ["--base-url", srv.base_url, "--only", "direct_markers", "--format", "json"],
                clock,
            )
            self.assertEqual(rc2, 1)
            by_id2 = {c["id"]: c for c in json.loads(out2)["checks"]}
            self.assertEqual(by_id2["direct_markers:douyin"]["status"], "FAIL")
            self.assertIn("missing browser_fetch='allowed'", by_id2["direct_markers:douyin"]["note"])


if __name__ == "__main__":
    unittest.main()
