#!/usr/bin/env python3
"""Offline unit tests for scripts/prod-smoke/smoke.py (zero external network)."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.parse

SMOKE_DIR = Path(__file__).resolve().parent
if str(SMOKE_DIR) not in sys.path:
    sys.path.insert(0, str(SMOKE_DIR))

import smoke  # noqa: E402


class FakeClock(smoke.Clock):
    """Thread-safe deterministic virtual clock with recorded sleep intervals."""

    def __init__(self, initial: float = 1000.0) -> None:
        self._lock = threading.Lock()
        self.current = initial
        self.sleeps: list[float] = []
        super().__init__(
            now_fn=self._now,
            sleep_fn=self._sleep,
            utc_now_fn=lambda: datetime(2026, 11, 15, 5, 0, 0, tzinfo=timezone.utc),
        )

    def _now(self) -> float:
        with self._lock:
            return self.current

    def _sleep(self, seconds: float) -> None:
        with self._lock:
            self.sleeps.append(seconds)
            self.current += seconds

    def advance(self, seconds: float) -> None:
        with self._lock:
            self.current += seconds


def make_envelope(
    platform: str,
    *,
    generated_at: str = "2026-11-15T05:00:00Z",
    title: str | None = None,
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
        "weibo": ("https://f.video.weibocdn.com/o0/wb.mp4?Expires=1900000000&ssig=wbsecret", "blocked"),
        "pipixia": ("https://v3-ppx.ppxvod.com/ppx/video.mp4?br=1000", "allowed"),
        "pipigx": ("https:// video.pipigx.com/pp/video.mp4".replace(" ", ""), None),
        "zuiyou": ("https://tbvideo.ixiaochuan.cn/zy/video.mp4", None),
        "pinterest": ("https://v1.pinimg.com/videos/mc/720p/aa/bb/pin.mp4", None),
        "tiktok": ("https://v16-web-newkey.tiktokcdn.com/video/tos/tt.mp4", "blocked"),
        "x": ("https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/x.mp4?tag=12", None),
        "youtube": ("https://rr1---sn-abc.googlevideo.com/videoplayback?expire=999&sig=ytsig", None),
        "instagram": ("https://scontent.cdninstagram.com/v/t50.2886-16/ig.mp4?_nc_ht=ig", None),
        "facebook": ("https://video.xx.fbcdn.net/v/t42.1790-2/fb.mp4?efg=abc", None),
        "tumblr": ("https://va.media.tumblr.com/tumblr_sample.mp4", None),
    }
    chosen_url, default_bf = default_hosts.get(
        platform, ("https://cdn.example.com/v.mp4", None)
    )
    if media_url is not None:
        chosen_url = media_url
    chosen_bf = default_bf if browser_fetch is None else (
        None if browser_fetch == "__OMIT__" else browser_fetch
    )

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
            "title": f"Smoke sample {platform}" if title is None else title,
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
        }
        self.platforms: list[str] = list(
            json.loads((SMOKE_DIR / "samples.json").read_text(encoding="utf-8"))[
                "expected_platforms"
            ]
        )
        self.parse_Requests: list[dict] = []
        self.all_requests: list[dict] = []
        self.custom_parse_handler = None
        self.custom_stats_handler = None
        self.custom_unlisted_api_handler = None
        self.custom_youtube_context_handler = None
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

                if parsed.path == "/api/youtube/context":
                    if outer.custom_youtube_context_handler is not None:
                        status, payload = outer.custom_youtube_context_handler(rec)
                    else:
                        status = 200
                        payload = {
                            "schema_version": "1.0",
                            "code": "OK",
                            "data": {
                                "player_id": "a1b2c3d4",
                                "expires_at": "2026-11-15T11:00:00Z",
                            },
                        }
                    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                    return

                if parsed.path == "/api/stats":
                    if outer.custom_stats_handler is not None:
                        status, content_type, raw_body = outer.custom_stats_handler(rec)
                    else:
                        status = 401
                        content_type = "application/json; charset=utf-8"
                        raw_body = json.dumps(
                            {
                                "schema_version": "1.0",
                                "code": "INVALID_INPUT",
                                "error": {
                                    "code": "INVALID_INPUT",
                                    "message": "认证凭据无效",
                                },
                            },
                            ensure_ascii=False,
                        ).encode("utf-8")
                    self.send_response(status)
                    if content_type is not None:
                        self.send_header("Content-Type", content_type)
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Set-Cookie", "stats_cookie=forbidden; Path=/")
                    self.end_headers()
                    self.wfile.write(raw_body)
                    return

                if parsed.path.startswith("/api/"):
                    if outer.custom_unlisted_api_handler is not None:
                        status, content_type, raw_body = outer.custom_unlisted_api_handler(rec)
                    else:
                        status = 404
                        content_type = "application/json; charset=utf-8"
                        raw_body = json.dumps(
                            {
                                "schema_version": "1.0",
                                "code": "INVALID_INPUT",
                                "error": {
                                    "code": "INVALID_INPUT",
                                    "message": "接口不存在",
                                },
                            },
                            ensure_ascii=False,
                        ).encode("utf-8")
                    self.send_response(status)
                    if content_type is not None:
                        self.send_header("Content-Type", content_type)
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Set-Cookie", "api404_cookie=forbidden; Path=/")
                    self.end_headers()
                    self.wfile.write(raw_body)
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
            "pinterest.com": "pinterest",
            "pin.it": "pinterest",
            "tiktok.com": "tiktok",
            "x.com": "x",
            "youtube.com": "youtube",
            "instagram.com": "instagram",
            "facebook.com": "facebook",
            "tumblr.com": "tumblr",
            "vimeo.com": "vimeo",
            "reddit.com": "reddit",
            "soundcloud.com": "soundcloud",
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
            # tier_b_platforms and rate_limit are SKIP by default under --tier tier-a
            self.assertEqual(report["summary"]["skip"], 2)
            # 1 frontend + 1 platforms + 1 youtube_context + 1 cache + 1 x + 1 dy_dom + 4 dm + 16 platforms + 2 api_boundary = 28 PASS
            self.assertEqual(report["summary"]["pass"], 28)

            # Verify api_boundary runs strictly AFTER all parse check groups and BEFORE rate_limit
            groups_in_order = [c["group"] for c in report["checks"]]
            api_boundary_indices = [
                i for i, g in enumerate(groups_in_order) if g == "api_boundary"
            ]
            self.assertEqual(len(api_boundary_indices), 2)
            last_parse_group_idx = max(
                i for i, g in enumerate(groups_in_order) if g in smoke.PARSE_GROUPS
            )
            rate_limit_idx = groups_in_order.index("rate_limit")
            self.assertGreater(min(api_boundary_indices), last_parse_group_idx)
            self.assertLess(max(api_boundary_indices), rate_limit_idx)

            by_id = {c["id"]: c for c in report["checks"]}
            self.assertEqual(by_id["api_boundary:stats_unauth_401"]["status"], "PASS")
            self.assertEqual(by_id["api_boundary:stats_unauth_401"]["http_status"], 401)
            self.assertEqual(by_id["api_boundary:unlisted_api_404"]["status"], "PASS")
            self.assertEqual(by_id["api_boundary:unlisted_api_404"]["http_status"], 404)

            # Verify >= 8.0s pacing across all /api/parse calls (17 total: 2 cache + 15 unique platforms)
            self.assertEqual(len(srv.parse_Requests), 17)
            timestamps = [r["timestamp"] for r in srv.parse_Requests]
            for prev_ts, next_ts in zip(timestamps, timestamps[1:]):
                self.assertGreaterEqual(next_ts - prev_ts, 8.0)

            # Verify api_boundary requests ran after the last /api/parse without any 8s pacing sleep
            last_parse_ts = srv.parse_Requests[-1]["timestamp"]
            stats_reqs = [r for r in srv.all_requests if r["path"] == "/api/stats"]
            unlisted_reqs = [
                r for r in srv.all_requests if r["path"].startswith("/api/smoke-unlisted-")
            ]
            self.assertEqual(len(stats_reqs), 1)
            self.assertEqual(stats_reqs[0]["query"], {"schema_version": "1.0"})
            self.assertEqual(len(unlisted_reqs), 1)
            self.assertGreater(stats_reqs[0]["timestamp"], last_parse_ts)
            self.assertLess(stats_reqs[0]["timestamp"] - last_parse_ts, 1.0)
            self.assertLess(
                unlisted_reqs[0]["timestamp"] - stats_reqs[0]["timestamp"], 1.0
            )

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
            self.assertEqual(by_id["api_boundary:stats_unauth_401"], "PASS")
            self.assertEqual(by_id["api_boundary:unlisted_api_404"], "PASS")
            self.assertEqual(by_id["cache"], "SKIP")
            self.assertEqual(by_id["all_platforms"], "SKIP")

            # Also verify --skip api_boundary marks api_boundary as SKIP without sending /api/stats
            srv.all_requests.clear()
            rc_skip_ab, out_skip_ab, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "platforms,api_boundary",
                    "--skip",
                    "api_boundary",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_skip_ab, 0)
            by_id_ab = {c["id"]: c["status"] for c in json.loads(out_skip_ab)["checks"]}
            self.assertEqual(by_id_ab["platforms"], "PASS")
            self.assertEqual(by_id_ab["api_boundary"], "SKIP")
            self.assertEqual(
                [r for r in srv.all_requests if r["path"] != "/api/platforms"], []
            )

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
                            "title": "抖音实况混合样本",
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

    def test_api_boundary_ordering_and_zero_parse_pacing(self) -> None:
        # 1. Static group constants enforce default-enabled ordering after all parse groups and before rate_limit
        self.assertIn("api_boundary", smoke.DEFAULT_GROUPS)
        ab_idx = smoke.ALL_GROUPS.index("api_boundary")
        rl_idx = smoke.ALL_GROUPS.index("rate_limit")
        self.assertLess(ab_idx, rl_idx)
        for parse_group in smoke.PARSE_GROUPS:
            self.assertLess(smoke.ALL_GROUPS.index(parse_group), ab_idx)
        self.assertLess(smoke.ALL_GROUPS.index("platforms"), ab_idx)

        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            # 2. Running douyin_domestic (1 /api/parse) + api_boundary triggers ZERO 8s pacing sleeps
            rc1, out1, err1 = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "douyin_domestic,api_boundary",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc1, 0, msg=err1 or out1)
            self.assertEqual(clock.sleeps, [])
            self.assertEqual(len(srv.parse_Requests), 1)
            unlisted_paths_1 = [
                r["path"]
                for r in srv.all_requests
                if r["path"].startswith("/api/smoke-unlisted-")
            ]
            self.assertEqual(len(unlisted_paths_1), 1)

            # 3. Second run generates a fresh random unlisted /api/<random> path and still sends 0 auth headers
            srv.all_requests.clear()
            rc2, out2, err2 = self._run_cli(
                ["--base-url", srv.base_url, "--only", "api_boundary", "--format", "json"],
                clock,
            )
            self.assertEqual(rc2, 0, msg=err2 or out2)
            self.assertEqual(clock.sleeps, [])
            unlisted_paths_2 = [
                r["path"]
                for r in srv.all_requests
                if r["path"].startswith("/api/smoke-unlisted-")
            ]
            self.assertEqual(len(unlisted_paths_2), 1)
            self.assertNotEqual(unlisted_paths_1[0], unlisted_paths_2[0])
            for req in srv.all_requests:
                self.assertNotIn("authorization", req["headers"])
                self.assertNotIn("cookie", req["headers"])

            # 4. Even if --only passes rate_limit,api_boundary,x_fast_path out of order,
            #    execution is canonical: x_fast_path -> api_boundary -> rate_limit
            srv.all_requests.clear()
            burst_count = {"n": 0}

            def burst_handler(_sample_url: str, _rec: dict):
                burst_count["n"] += 1
                if burst_count["n"] <= 5:
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
            rc3, out3, err3 = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "rate_limit,api_boundary,x_fast_path",
                    "--enable-rate-limit",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc3, 0, msg=err3 or out3)
            rep3 = json.loads(out3)
            self.assertEqual(
                [c["id"] for c in rep3["checks"]],
                [
                    "x_fast_path",
                    "api_boundary:stats_unauth_401",
                    "api_boundary:unlisted_api_404",
                    "rate_limit",
                ],
            )
            # Wire order: 1st parse (x_fast_path) -> /api/stats -> /api/smoke-unlisted-* -> 6 burst parses
            wire_paths = [r["path"] for r in srv.all_requests]
            self.assertEqual(wire_paths[0], "/api/parse")
            self.assertEqual(wire_paths[1], "/api/stats")
            self.assertTrue(wire_paths[2].startswith("/api/smoke-unlisted-"))
            self.assertEqual(wire_paths[3:], ["/api/parse"] * 6)

    def test_api_boundary_failure_paths(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            stats_failures = [
                (
                    "stats_200_open",
                    200,
                    "application/json; charset=utf-8",
                    b'{"schema_version":"1.0","code":"OK","data":{}}',
                    200,
                ),
                (
                    "stats_404_missing_caddy_whitelist",
                    404,
                    "application/json; charset=utf-8",
                    b'{"schema_version":"1.0","code":"INVALID_INPUT","error":{"code":"INVALID_INPUT","message":"not found"}}',
                    404,
                ),
                (
                    "stats_401_plain_text",
                    401,
                    "text/plain; charset=utf-8",
                    b"Unauthorized",
                    401,
                ),
                (
                    "stats_401_html",
                    401,
                    "text/html; charset=utf-8",
                    b"<html><body>401 Unauthorized</body></html>",
                    401,
                ),
                (
                    "stats_401_invalid_json_body",
                    401,
                    "application/json",
                    b"not valid json",
                    401,
                ),
                (
                    "stats_401_bad_envelope",
                    401,
                    "application/json",
                    b'{"error":"unauthorized"}',
                    401,
                ),
            ]
            for label, st_code, ct, body, expected_http in stats_failures:
                with self.subTest(stats_case=label):
                    srv.custom_stats_handler = lambda _r, s=st_code, c=ct, b=body: (s, c, b)
                    srv.custom_unlisted_api_handler = None
                    rc, out, _ = self._run_cli(
                        ["--base-url", srv.base_url, "--only", "api_boundary", "--format", "json"],
                        clock,
                    )
                    self.assertEqual(rc, 1)
                    by_id = {c["id"]: c for c in json.loads(out)["checks"]}
                    self.assertEqual(by_id["api_boundary:stats_unauth_401"]["status"], "FAIL")
                    self.assertEqual(
                        by_id["api_boundary:stats_unauth_401"]["http_status"], expected_http
                    )
                    self.assertEqual(by_id["api_boundary:unlisted_api_404"]["status"], "PASS")

            unlisted_failures = [
                (
                    "unlisted_200_spa_html_leak",
                    200,
                    "text/html; charset=utf-8",
                    b"<!doctype html><title>SPA</title>",
                    200,
                ),
                (
                    "unlisted_200_json",
                    200,
                    "application/json; charset=utf-8",
                    b'{"schema_version":"1.0","code":"OK","data":{}}',
                    200,
                ),
                (
                    "unlisted_404_plain_text",
                    404,
                    "text/plain; charset=utf-8",
                    b"404 page not found\n",
                    404,
                ),
                (
                    "unlisted_404_html",
                    404,
                    "text/html; charset=utf-8",
                    b"<html><body>404 Not Found</body></html>",
                    404,
                ),
                (
                    "unlisted_404_missing_content_type",
                    404,
                    None,
                    b'{"schema_version":"1.0","code":"INVALID_INPUT","error":{"code":"INVALID_INPUT","message":"no ct"}}',
                    404,
                ),
                (
                    "unlisted_404_invalid_json_body",
                    404,
                    "application/json; charset=utf-8",
                    b"<html>404 disguised as json</html>",
                    404,
                ),
                (
                    "unlisted_404_non_object_json",
                    404,
                    "application/json; charset=utf-8",
                    b'["not","an","object"]',
                    404,
                ),
                (
                    "unlisted_404_bad_envelope",
                    404,
                    "application/json; charset=utf-8",
                    b'{"schema_version":"1.0","code":"OK"}',
                    404,
                ),
            ]
            for label, st_code, ct, body, expected_http in unlisted_failures:
                with self.subTest(unlisted_case=label):
                    srv.custom_stats_handler = None
                    srv.custom_unlisted_api_handler = lambda _r, s=st_code, c=ct, b=body: (s, c, b)
                    rc, out, _ = self._run_cli(
                        ["--base-url", srv.base_url, "--only", "api_boundary", "--format", "json"],
                        clock,
                    )
                    self.assertEqual(rc, 1)
                    by_id = {c["id"]: c for c in json.loads(out)["checks"]}
                    self.assertEqual(by_id["api_boundary:stats_unauth_401"]["status"], "PASS")
                    self.assertEqual(by_id["api_boundary:unlisted_api_404"]["status"], "FAIL")
                    self.assertEqual(
                        by_id["api_boundary:unlisted_api_404"]["http_status"], expected_http
                    )

    def test_keep_alive_connection_reuse_for_sequential_requests(self) -> None:
        clock = FakeClock()

        class KeepAliveServer:
            def __init__(self) -> None:
                self.lock = threading.Lock()
                self.tcp_accepts = 0
                self.requests_seen: list[dict] = []
                outer = self

                class Handler(BaseHTTPRequestHandler):
                    protocol_version = "HTTP/1.1"

                    def log_message(self, fmt: str, *args) -> None:  # noqa: ANN002
                        return

                    def do_GET(self) -> None:  # noqa: N802
                        headers_lower = {k.lower(): v for k, v in self.headers.items()}
                        with outer.lock:
                            outer.requests_seen.append(
                                {"path": self.path, "headers": headers_lower}
                            )
                        if self.path == "/redirect":
                            body = b"moved"
                            self.send_response(302)
                            self.send_header("Location", "https://evil.example.com/")
                            self.send_header("Content-Length", str(len(body)))
                            self.send_header("Connection", "keep-alive")
                            self.end_headers()
                            self.wfile.write(body)
                            return
                        body = f"ok:{self.path}".encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "text/plain; charset=utf-8")
                        self.send_header("Set-Cookie", "sid=must_never_be_stored; Path=/")
                        self.send_header("Content-Length", str(len(body)))
                        self.send_header("Connection", "keep-alive")
                        self.end_headers()
                        self.wfile.write(body)

                class CountingHTTPServer(ThreadingHTTPServer):
                    allow_reuse_address = True

                    def server_bind(self) -> None:
                        self.socket.bind(self.server_address)
                        self.server_address = self.socket.getsockname()
                        self.server_name = "127.0.0.1"
                        self.server_port = int(self.server_address[1])

                    def get_request(self):  # noqa: ANN202
                        conn, addr = super().get_request()
                        with outer.lock:
                            outer.tcp_accepts += 1
                        return conn, addr

                self._httpd = CountingHTTPServer(("127.0.0.1", 0), Handler)
                self.base_url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
                self._thread = threading.Thread(
                    target=self._httpd.serve_forever,
                    kwargs={"poll_interval": 0.01},
                    daemon=True,
                )

            def __enter__(self) -> "KeepAliveServer":
                self._thread.start()
                return self

            def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
                self._httpd.shutdown()
                self._httpd.server_close()
                self._thread.join(timeout=5.0)

        with KeepAliveServer() as srv:
            with smoke.OriginLockedClient(srv.base_url, clock=clock, pool_maxsize=4) as client:
                for i in range(10):
                    resp = client.get_raw(f"/item/{i}", accept="text/plain")
                    self.assertEqual(resp.status, 200)
                    self.assertEqual(resp.body, f"ok:/item/{i}".encode("utf-8"))
                redir = client.get_raw("/redirect", accept="*/*")
                self.assertEqual(redir.status, 302)
                self.assertEqual(redir.headers.get("location"), "https://evil.example.com/")
                after = client.get_raw("/after", accept="text/plain")
                self.assertEqual(after.status, 200)

            self.assertEqual(srv.tcp_accepts, 1)
            self.assertEqual(len(srv.requests_seen), 12)
            for req in srv.requests_seen:
                self.assertNotIn("cookie", req["headers"])
                self.assertNotIn("authorization", req["headers"])

    def test_frontend_hashes_concurrent_keep_alive_pool_and_deterministic_errors(self) -> None:
        clock = FakeClock()

        class StaticKeepAliveServer:
            def __init__(self, files: dict[str, bytes], delay_s: float = 0.015) -> None:
                self.files = dict(files)
                self.delay_s = delay_s
                self.lock = threading.Lock()
                self.tcp_accepts = 0
                self.in_flight = 0
                self.peak_in_flight = 0
                outer = self

                class Handler(BaseHTTPRequestHandler):
                    protocol_version = "HTTP/1.1"

                    def log_message(self, fmt: str, *args) -> None:  # noqa: ANN002
                        return

                    def do_GET(self) -> None:  # noqa: N802
                        with outer.lock:
                            outer.in_flight += 1
                            outer.peak_in_flight = max(outer.peak_in_flight, outer.in_flight)
                        try:
                            if outer.delay_s > 0:
                                time.sleep(outer.delay_s)
                            rel = "index.html" if self.path == "/" else self.path.lstrip("/")
                            rel = urllib.parse.unquote(rel)
                            if rel in outer.files:
                                body = outer.files[rel]
                                self.send_response(200)
                                self.send_header("Content-Type", "application/octet-stream")
                                self.send_header("Content-Length", str(len(body)))
                                self.send_header("Connection", "keep-alive")
                                self.end_headers()
                                self.wfile.write(body)
                            else:
                                self.send_response(404)
                                self.send_header("Content-Length", "0")
                                self.send_header("Connection", "keep-alive")
                                self.end_headers()
                        finally:
                            with outer.lock:
                                outer.in_flight -= 1

                class CountingHTTPServer(ThreadingHTTPServer):
                    allow_reuse_address = True

                    def server_bind(self) -> None:
                        self.socket.bind(self.server_address)
                        self.server_address = self.socket.getsockname()
                        self.server_name = "127.0.0.1"
                        self.server_port = int(self.server_address[1])

                    def get_request(self):  # noqa: ANN202
                        conn, addr = super().get_request()
                        with outer.lock:
                            outer.tcp_accepts += 1
                        return conn, addr

                self._httpd = CountingHTTPServer(("127.0.0.1", 0), Handler)
                self.base_url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
                self._thread = threading.Thread(
                    target=self._httpd.serve_forever,
                    kwargs={"poll_interval": 0.01},
                    daemon=True,
                )

            def __enter__(self) -> "StaticKeepAliveServer":
                self._thread.start()
                return self

            def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
                self._httpd.shutdown()
                self._httpd.server_close()
                self._thread.join(timeout=5.0)

        files = {"index.html": b"<!doctype html>ok"}
        for i in range(30):
            files[f"assets/chunk-{i:02d}.js"] = f"console.log({i});".encode("utf-8")

        with tempfile.TemporaryDirectory() as tmp, StaticKeepAliveServer(files) as srv:
            manifest_path = Path(tmp) / "release-manifest.json"
            manifest_path.write_text(
                json.dumps(
                    {
                        "schema_version": "1.0",
                        "release_tag": "build-pooltest",
                        "frontend_dist_files": {
                            rel: hashlib.sha256(content).hexdigest()
                            for rel, content in files.items()
                        },
                    }
                ),
                encoding="utf-8",
            )

            rc, out, err = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "frontend_hashes",
                    "--manifest",
                    str(manifest_path),
                    "--frontend-concurrency",
                    "5",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc, 0, msg=err or out)
            rep = json.loads(out)
            self.assertEqual(rep["checks"][0]["status"], "PASS")
            self.assertIn("32/32 static paths matched SHA-256", rep["checks"][0]["note"])
            # 32 requests served over at most 5 reused Keep-Alive TCP connections
            self.assertLessEqual(srv.tcp_accepts, 5)
            self.assertGreaterEqual(srv.peak_in_flight, 2)

            # Corrupt two files and confirm mismatch ordering is deterministic (sorted path order)
            srv.files["assets/chunk-20.js"] = b"corrupted-20"
            srv.files["assets/chunk-03.js"] = b"corrupted-03"
            rc2, out2, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "frontend_hashes",
                    "--manifest",
                    str(manifest_path),
                    "--frontend-concurrency",
                    "5",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc2, 1)
            note2 = json.loads(out2)["checks"][0]["note"]
            self.assertIn(
                "assets/chunk-03.js:sha256_mismatch, assets/chunk-20.js:sha256_mismatch",
                note2,
            )

            # Out-of-range --frontend-concurrency rejected cleanly
            for bad in ("0", "9"):
                rc_bad, _, err_bad = self._run_cli(
                    [
                        "--base-url",
                        srv.base_url,
                        "--only",
                        "frontend_hashes",
                        "--manifest",
                        str(manifest_path),
                        "--frontend-concurrency",
                        bad,
                    ],
                    clock,
                )
                self.assertEqual(rc_bad, 1)
                self.assertIn("invalid --frontend-concurrency", err_bad)

    def test_stale_keep_alive_connection_retries_once_transparently(self) -> None:
        clock = FakeClock()

        class DropAfterFirstKeepAliveServer:
            def __init__(self) -> None:
                self.lock = threading.Lock()
                self.tcp_accepts = 0
                outer = self

                class Handler(BaseHTTPRequestHandler):
                    protocol_version = "HTTP/1.1"

                    def log_message(self, fmt: str, *args) -> None:  # noqa: ANN002
                        return

                    def do_GET(self) -> None:  # noqa: N802
                        with outer.lock:
                            conn_num = outer.tcp_accepts
                        body = f"conn={conn_num}:path={self.path}".encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "text/plain")
                        self.send_header("Content-Length", str(len(body)))
                        # Advertise keep-alive on conn #1, then immediately close server-side
                        # to simulate an upstream idle disconnect before request #2.
                        self.send_header("Connection", "keep-alive")
                        self.end_headers()
                        self.wfile.write(body)
                        self.wfile.flush()
                        if conn_num == 1:
                            self.close_connection = True

                class CountingHTTPServer(ThreadingHTTPServer):
                    allow_reuse_address = True

                    def server_bind(self) -> None:
                        self.socket.bind(self.server_address)
                        self.server_address = self.socket.getsockname()
                        self.server_name = "127.0.0.1"
                        self.server_port = int(self.server_address[1])

                    def get_request(self):  # noqa: ANN202
                        conn, addr = super().get_request()
                        with outer.lock:
                            outer.tcp_accepts += 1
                        return conn, addr

                self._httpd = CountingHTTPServer(("127.0.0.1", 0), Handler)
                self.base_url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
                self._thread = threading.Thread(
                    target=self._httpd.serve_forever,
                    kwargs={"poll_interval": 0.01},
                    daemon=True,
                )

            def __enter__(self) -> "DropAfterFirstKeepAliveServer":
                self._thread.start()
                return self

            def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
                self._httpd.shutdown()
                self._httpd.server_close()
                self._thread.join(timeout=5.0)

        with DropAfterFirstKeepAliveServer() as srv:
            with smoke.OriginLockedClient(srv.base_url, clock=clock, pool_maxsize=2) as client:
                r1 = client.get_raw("/first", accept="text/plain")
                self.assertEqual(r1.status, 200)
                self.assertEqual(r1.body, b"conn=1:path=/first")
                time.sleep(0.03)
                r2 = client.get_raw("/second", accept="text/plain")
                self.assertEqual(r2.status, 200)
                self.assertEqual(r2.body, b"conn=2:path=/second")
                r3 = client.get_raw("/third", accept="text/plain")
                self.assertEqual(r3.status, 200)
                self.assertEqual(r3.body, b"conn=2:path=/third")
            self.assertEqual(srv.tcp_accepts, 2)

    def test_dual_stack_ipv6_timeout_fallback_and_family_caching(self) -> None:
        lock = threading.Lock()
        attempts: list[tuple[int, str, float | None]] = []
        fail_v6 = {"enabled": True}
        fail_v4 = {"enabled": False}

        v6_infos = [
            (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("2001:db8::1", 443, 0, 0)),
            (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("2001:db8::2", 443, 0, 0)),
        ]
        v4_infos = [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("198.51.100.10", 443)),
        ]

        def fake_getaddrinfo(_host, _port, family=0, _type=0):  # noqa: ANN001, ANN202
            if family == socket.AF_INET6:
                return list(v6_infos)
            if family == socket.AF_INET:
                return list(v4_infos)
            return list(v6_infos) + list(v4_infos)

        class FakeSocket:
            def __init__(self, af: int, _socktype: int, _proto: int) -> None:
                self.family = af
                self.timeout: float | None = None
                self.closed = False
                self.connected_addr = None

            def settimeout(self, t: float | None) -> None:
                self.timeout = t

            def connect(self, sa) -> None:  # noqa: ANN001
                with lock:
                    attempts.append((self.family, str(sa[0]), self.timeout))
                    block_v6 = fail_v6["enabled"]
                    block_v4 = fail_v4["enabled"]
                if self.family == socket.AF_INET6 and block_v6:
                    time.sleep(0.02)
                    raise TimeoutError("simulated IPv6 SYN timeout")
                if self.family == socket.AF_INET and block_v4:
                    raise OSError("simulated IPv4 unreachable")
                self.connected_addr = sa

            def close(self) -> None:
                self.closed = True

        dialer = smoke._DualStackDialer(
            ipv6_probe_timeout=1.5,
            getaddrinfo_fn=fake_getaddrinfo,
            socket_factory=FakeSocket,
        )

        # 1. Cold-start concurrent fan-out (6 threads): single-flight discovery probes
        #    IPv6 ONCE with capped 1.5s timeout, falls back to IPv4, restores full 50s
        #    timeout, and caches AF_INET for all remaining threads.
        with ThreadPoolExecutor(max_workers=6) as pool:
            sockets = list(
                pool.map(
                    lambda _: dialer.create_connection(("snap.dokitool.com", 443), timeout=50.0),
                    range(6),
                )
            )
        self.assertEqual(len(sockets), 6)
        for s in sockets:
            self.assertEqual(s.family, socket.AF_INET)
            self.assertEqual(s.timeout, 50.0)
        self.assertEqual(dialer.preferred_family("snap.dokitool.com", 443), socket.AF_INET)
        self.assertTrue(dialer.fallback_detected("snap.dokitool.com", 443))

        v6_attempts = [a for a in attempts if a[0] == socket.AF_INET6]
        v4_attempts = [a for a in attempts if a[0] == socket.AF_INET]
        self.assertEqual(len(v6_attempts), 1)
        self.assertEqual(v6_attempts[0][2], 1.5)
        self.assertEqual(len(v4_attempts), 6)

        # 2. Five more reconnects stay pinned to AF_INET with ZERO new IPv6 attempts.
        for _ in range(5):
            s = dialer.create_connection(("snap.dokitool.com", 443), timeout=50.0)
            self.assertEqual(s.family, socket.AF_INET)
        self.assertEqual(sum(1 for a in attempts if a[0] == socket.AF_INET6), 1)

        # 3. If cached AF_INET later fails and AF_INET6 recovers, cache invalidates & switches cleanly.
        fail_v6["enabled"] = False
        fail_v4["enabled"] = True
        s_recovered = dialer.create_connection(("snap.dokitool.com", 443), timeout=50.0)
        self.assertEqual(s_recovered.family, socket.AF_INET6)
        self.assertEqual(s_recovered.timeout, 50.0)
        self.assertEqual(dialer.preferred_family("snap.dokitool.com", 443), socket.AF_INET6)

    def test_proxy_credentials_rejected_and_loopback_bypasses_proxy(self) -> None:
        with mock.patch.object(
            smoke.urllib.request,
            "getproxies",
            return_value={"https": "http://user:secret@proxy.example.com:8080"},
        ), mock.patch.object(smoke.urllib.request, "proxy_bypass", return_value=False):
            with self.assertRaisesRegex(smoke.SmokeError, "proxy credentials are forbidden"):
                smoke._resolve_proxy_for_origin("https", "snap.dokitool.com")

            # Loopback addresses always bypass environment proxies
            self.assertIsNone(smoke._resolve_proxy_for_origin("http", "127.0.0.1"))
            self.assertIsNone(smoke._resolve_proxy_for_origin("http", "localhost"))
            self.assertIsNone(smoke._resolve_proxy_for_origin("http", "::1"))

        with mock.patch.object(
            smoke.urllib.request,
            "getproxies",
            return_value={"https": "http://127.0.0.1:7897"},
        ), mock.patch.object(smoke.urllib.request, "proxy_bypass", return_value=False):
            self.assertEqual(
                smoke._resolve_proxy_for_origin("https", "snap.dokitool.com"),
                ("127.0.0.1", 7897),
            )

    def test_l4_title_quality_assertions_reject_empty_and_placeholders(self) -> None:
        clock = FakeClock()
        bad_titles = ["", "   ", "P1", "p12", "第1集", "未知标题", "Unknown Title", "序列 01"]
        for bad_title in bad_titles:
            with self.subTest(title=bad_title):
                payload = make_envelope("bilibili", title=bad_title)
                resp = smoke.RawHttpResponse(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=json.dumps(payload).encode("utf-8"),
                    elapsed_ms=25,
                )
                with self.assertRaisesRegex(AssertionError, "quality assertion failed"):
                    smoke.validate_parse_envelope(resp, "bilibili", target_host="snap.dokitool.com")

        good_payload = make_envelope("bilibili", title="【技术实录】全链路架构演进")
        good_resp = smoke.RawHttpResponse(
            status=200,
            headers={"content-type": "application/json"},
            body=json.dumps(good_payload).encode("utf-8"),
            elapsed_ms=25,
        )
        parsed, hosts = smoke.validate_parse_envelope(
            good_resp, "bilibili", target_host="snap.dokitool.com"
        )
        self.assertEqual(parsed["data"]["title"], "【技术实录】全链路架构演进")
        self.assertTrue(hosts)

    def test_l4_youtube_context_latency_warn_and_fail_thresholds(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            # 1. Warm fast response -> PASS
            rc, out, err = self._run_cli(
                ["--base-url", srv.base_url, "--only", "youtube_context", "--format", "json"],
                clock,
            )
            self.assertEqual(rc, 0, msg=err or out)
            rep = json.loads(out)
            self.assertEqual(rep["checks"][0]["status"], "PASS")
            self.assertEqual(rep["summary"]["warn"], 0)

            # 2. Slow response exceeding warn threshold (2000ms) -> WARN (non-failing)
            def slow_warn(_rec):
                clock.advance(2.5)
                return 200, {
                    "schema_version": "1.0",
                    "code": "OK",
                    "data": {"player_id": "slow1234", "expires_at": "2026-11-15T11:00:00Z"},
                }

            srv.custom_youtube_context_handler = slow_warn
            rc_warn, out_warn, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "youtube_context",
                    "--youtube-context-warn-ms",
                    "2000",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_warn, 0)
            rep_warn = json.loads(out_warn)
            self.assertEqual(rep_warn["checks"][0]["status"], "WARN")
            self.assertEqual(rep_warn["checks"][0]["code"], "LATENCY_WARN")
            self.assertEqual(rep_warn["summary"]["warn"], 1)

            # 3. Severely stalled response exceeding fail threshold (15000ms) -> FAIL
            def slow_fail(_rec):
                clock.advance(16.0)
                return 200, {
                    "schema_version": "1.0",
                    "code": "OK",
                    "data": {"player_id": "cold9999", "expires_at": "2026-11-15T11:00:00Z"},
                }

            srv.custom_youtube_context_handler = slow_fail
            rc_fail, out_fail, _ = self._run_cli(
                ["--base-url", srv.base_url, "--only", "youtube_context", "--format", "json"],
                clock,
            )
            self.assertEqual(rc_fail, 1)
            rep_fail = json.loads(out_fail)
            self.assertEqual(rep_fail["checks"][0]["status"], "FAIL")
            self.assertEqual(rep_fail["checks"][0]["code"], "LATENCY_FAIL")

    def test_youtube_context_fail_ms_cli_override_and_validation(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            def latency_handler(delay_seconds: float):
                def _handler(_rec):
                    clock.advance(delay_seconds)
                    return 200, {
                        "schema_version": "1.0",
                        "code": "OK",
                        "data": {"player_id": "a1b2c3d4", "expires_at": "2026-11-15T11:00:00Z"},
                    }
                return _handler

            # 1. Default None keeps backward-compatible samples.json fail_latency_ms (15000ms):
            #    6000ms with --youtube-context-warn-ms 1500 stays WARN (rc=0).
            srv.custom_youtube_context_handler = latency_handler(6.0)
            rc_default, out_default, err_default = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "youtube_context",
                    "--youtube-context-warn-ms",
                    "1500",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_default, 0, msg=err_default or out_default)
            rep_default = json.loads(out_default)
            self.assertEqual(rep_default["checks"][0]["status"], "WARN")
            self.assertEqual(rep_default["checks"][0]["code"], "LATENCY_WARN")

            # 2. Explicit --youtube-context-fail-ms 5000: 2500ms stays WARN, 5500ms breaches to FAIL.
            srv.custom_youtube_context_handler = latency_handler(2.5)
            rc_warn, out_warn, err_warn = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "youtube_context",
                    "--youtube-context-warn-ms",
                    "1500",
                    "--youtube-context-fail-ms",
                    "5000",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_warn, 0, msg=err_warn or out_warn)
            rep_warn = json.loads(out_warn)
            self.assertEqual(rep_warn["checks"][0]["status"], "WARN")
            self.assertEqual(rep_warn["checks"][0]["code"], "LATENCY_WARN")

            srv.custom_youtube_context_handler = latency_handler(5.5)
            rc_fail, out_fail, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "youtube_context",
                    "--youtube-context-warn-ms",
                    "1500",
                    "--youtube-context-fail-ms",
                    "5000",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_fail, 1)
            rep_fail = json.loads(out_fail)
            self.assertEqual(rep_fail["checks"][0]["status"], "FAIL")
            self.assertEqual(rep_fail["checks"][0]["code"], "LATENCY_FAIL")
            self.assertIn("5000ms", rep_fail["checks"][0]["note"])

            # 3. Equal warn and fail thresholds are valid and fail when exceeded.
            srv.custom_youtube_context_handler = latency_handler(2.5)
            rc_eq, out_eq, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "youtube_context",
                    "--youtube-context-warn-ms",
                    "2000",
                    "--youtube-context-fail-ms",
                    "2000",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_eq, 1)
            self.assertEqual(json.loads(out_eq)["checks"][0]["status"], "FAIL")

            # 4. Invalid --youtube-context-fail-ms (< 1 or < warn_ms) rejected cleanly.
            for bad_args in (
                ["--youtube-context-fail-ms", "0"],
                ["--youtube-context-fail-ms", "-50"],
                ["--youtube-context-warn-ms", "2000", "--youtube-context-fail-ms", "1500"],
                ["--youtube-context-fail-ms", "1500"],  # default warn_ms from samples.json is 2000
            ):
                with self.subTest(bad_args=bad_args):
                    rc_bad, _, err_bad = self._run_cli(
                        [
                            "--base-url",
                            srv.base_url,
                            "--only",
                            "youtube_context",
                            *bad_args,
                            "--format",
                            "json",
                        ],
                        clock,
                    )
                    self.assertEqual(rc_bad, 1)
                    self.assertIn("invalid --youtube-context-fail-ms", err_bad)

    def test_l4_tier_a_and_tier_b_stratification_and_rotation(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            # Default --tier tier-a skips tier_b_platforms
            rc_a, out_a, err_a = self._run_cli(
                ["--base-url", srv.base_url, "--tier", "tier-a", "--format", "json"],
                clock,
            )
            self.assertEqual(rc_a, 0, msg=err_a or out_a)
            rep_a = json.loads(out_a)
            self.assertEqual(rep_a["tier"], "tier-a")
            tb_checks_a = [c for c in rep_a["checks"] if c["group"] == "tier_b_platforms"]
            self.assertEqual(len(tb_checks_a), 1)
            self.assertEqual(tb_checks_a[0]["status"], "SKIP")

            # --tier tier-b with --tier-b-limit 2 runs rotated subset and skips Tier-A parse groups
            rc_b, out_b, err_b = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--tier",
                    "tier-b",
                    "--tier-b-limit",
                    "2",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_b, 0, msg=err_b or out_b)
            rep_b = json.loads(out_b)
            self.assertEqual(rep_b["tier"], "tier-b")
            tb_checks_b = [c for c in rep_b["checks"] if c["group"] == "tier_b_platforms"]
            self.assertEqual(len(tb_checks_b), 2)
            self.assertTrue(all(c["status"] == "PASS" for c in tb_checks_b))
            all_plat_b = [c for c in rep_b["checks"] if c["group"] == "all_platforms"]
            self.assertEqual(len(all_plat_b), 1)
            self.assertEqual(all_plat_b[0]["status"], "SKIP")

            # --tier all executes BOTH Tier-A 16 core platforms and full Tier-B pool
            rc_all, out_all, err_all = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--tier",
                    "all",
                    "--only",
                    "all_platforms,tier_b_platforms",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_all, 0, msg=err_all or out_all)
            rep_all = json.loads(out_all)
            self.assertEqual(
                sum(1 for c in rep_all["checks"] if c["group"] == "all_platforms" and c["status"] == "PASS"),
                16,
            )
            self.assertEqual(
                sum(1 for c in rep_all["checks"] if c["group"] == "tier_b_platforms" and c["status"] == "PASS"),
                3,
            )

    def test_samples_json_matches_platforms_json_ssot(self) -> None:
        repo_root = SMOKE_DIR.parents[1]
        catalog = json.loads((repo_root / "backend/config/platforms.json").read_text(encoding="utf-8"))
        catalog_ids = [str(entry["id"]) for entry in catalog]
        samples = json.loads((SMOKE_DIR / "samples.json").read_text(encoding="utf-8"))
        expected_ids = [str(pid) for pid in samples.get("expected_platforms", [])]
        sample_platforms = samples.get("platforms", {})
        self.assertEqual(set(expected_ids), set(catalog_ids))
        self.assertEqual(len(expected_ids), len(catalog_ids))
        for pid in expected_ids:
            self.assertIn(pid, sample_platforms, msg=f"samples.json platforms missing entry for {pid!r}")
            self.assertTrue(str(sample_platforms[pid].get("url") or "").startswith(("http://", "https://")))

    def test_l4_sample_stale_distinguished_from_parser_failure_with_redaction(self) -> None:
        clock = FakeClock()
        with FakeDokiServer(clock) as srv:
            def custom_parse(sample_url: str, _rec: dict):
                plat = srv.detect_platform(sample_url)
                if plat == "bilibili":
                    # Simulate deleted/takedown video with sensitive URL/token in upstream message
                    return 404, {
                        "schema_version": "1.0",
                        "code": "CONTENT_UNAVAILABLE",
                        "error": {
                            "code": "CONTENT_UNAVAILABLE",
                            "message": "稿件已下架 https://api.bilibili.com/x?xsec_token=SECRET999 from 203.0.113.5",
                        },
                    }
                if plat == "xiaohongshu":
                    return 502, {
                        "schema_version": "1.0",
                        "code": "UPSTREAM_BLOCKED",
                        "error": {
                            "code": "UPSTREAM_BLOCKED",
                            "message": "上游网关风控拦截",
                        },
                    }
                return 200, make_envelope(plat)

            srv.custom_parse_handler = custom_parse

            # 1. Stale Bilibili sample + real XHS parser outage -> bilibili=SAMPLE_STALE, xhs=FAIL
            rc, out, err = self._run_cli(
                ["--base-url", srv.base_url, "--only", "all_platforms", "--format", "json"],
                clock,
            )
            self.assertEqual(rc, 1)
            rep = json.loads(out)
            by_id = {c["id"]: c for c in rep["checks"]}
            self.assertEqual(by_id["platform:bilibili"]["status"], "SAMPLE_STALE")
            self.assertEqual(by_id["platform:bilibili"]["code"], "SAMPLE_STALE")
            self.assertEqual(by_id["platform:xiaohongshu"]["status"], "FAIL")
            self.assertEqual(by_id["platform:xiaohongshu"]["code"], "UPSTREAM_BLOCKED")
            self.assertEqual(rep["summary"]["sample_stale"], 1)
            self.assertEqual(rep["summary"]["fail"], 1)
            # Redaction verified: sensitive URL, xsec_token, and IP scrubbed from SAMPLE_STALE note
            self.assertNotIn("SECRET999", out)
            self.assertNotIn("203.0.113.5", out)
            self.assertNotIn("https://", out)

            # 2. Only SAMPLE_STALE (no real parser failure): default exits 0, --strict-stale exits 1
            def stale_only(sample_url: str, _rec: dict):
                plat = srv.detect_platform(sample_url)
                if plat == "bilibili":
                    return 404, {
                        "schema_version": "1.0",
                        "code": "CONTENT_UNAVAILABLE",
                        "error": {"code": "CONTENT_UNAVAILABLE", "message": "视频已下架"},
                    }
                return 200, make_envelope(plat)

            srv.custom_parse_handler = stale_only
            rc_soft, out_soft, _ = self._run_cli(
                ["--base-url", srv.base_url, "--only", "all_platforms", "--format", "md"],
                clock,
            )
            self.assertEqual(rc_soft, 0)
            self.assertIn("SAMPLE_STALE=1", out_soft)
            self.assertIn("**SAMPLE_STALE**", out_soft)

            rc_strict, out_strict, _ = self._run_cli(
                [
                    "--base-url",
                    srv.base_url,
                    "--only",
                    "all_platforms",
                    "--strict-stale",
                    "--format",
                    "json",
                ],
                clock,
            )
            self.assertEqual(rc_strict, 1)
            self.assertEqual(json.loads(out_strict)["passed"], False)


if __name__ == "__main__":
    unittest.main()
