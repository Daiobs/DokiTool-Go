"""Offline unit tests for tools/dokitool-agent/security.py."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock
import urllib.parse

AGENT_DIR = Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

import security  # noqa: E402


def _fake_public_resolver(host: str, port: int, family: int = 0, socktype: int = 0):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", port))]


def _make_private_resolver(ip_str: str):
    fam = socket.AF_INET6 if ":" in ip_str else socket.AF_INET

    def _resolver(host: str, port: int, family: int = 0, socktype: int = 0):
        return [(fam, socket.SOCK_STREAM, 6, "", (ip_str, port))]

    return _resolver


class _CookieAndRedirectHandler(BaseHTTPRequestHandler):
    recorded_cookies: list[str | None] = []
    recorded_referers: list[str | None] = []
    recorded_auths: list[str | None] = []

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def do_GET(self) -> None:  # noqa: N802
        self.__class__.recorded_cookies.append(self.headers.get("Cookie"))
        self.__class__.recorded_referers.append(self.headers.get("Referer"))
        self.__class__.recorded_auths.append(self.headers.get("Authorization"))
        if self.path == "/set-cookie-redirect":
            self.send_response(302)
            self.send_header("Set-Cookie", "sid=secret-cookie-value; Path=/; HttpOnly")
            self.send_header("Location", "/after-redirect")
            self.end_headers()
            return
        if self.path == "/after-redirect":
            body = b"WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n"
            self.send_response(200)
            self.send_header("Set-Cookie", "second=another-secret; Path=/")
            self.send_header("Content-Type", "text/vtt")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/redirect-to-loopback":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:9/internal-secret")
            self.end_headers()
            return
        if self.path == "/oversize-cl":
            self.send_response(200)
            self.send_header("Content-Length", str(security.MAX_SUBTITLE_BYTES + 10))
            self.end_headers()
            return
        if self.path == "/oversize-stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            chunk = b"a" * 65536
            for _ in range(4):
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
            return
        self.send_response(404)
        self.end_headers()


class SecurityTests(unittest.TestCase):
    def test_load_api_token_env_only_and_priority(self) -> None:
        api_tok = "A" * 40
        owner_tok = "B" * 40
        self.assertIsNone(security.load_api_token(required=False, env={}))
        with self.assertRaises(security.SecurityError):
            security.load_api_token(required=True, env={})
        self.assertEqual(
            security.load_api_token(env={"DOKITOOL_API_TOKEN": api_tok, "DOKITOOL_OWNER_TOKEN": owner_tok}),
            api_tok,
        )
        self.assertEqual(
            security.load_api_token(env={"DOKITOOL_OWNER_TOKEN": owner_tok}),
            owner_tok,
        )
        bad_secret = "too-short-secret-value"
        with self.assertRaises(security.SecurityError) as ctx:
            security.load_api_token(env={"DOKITOOL_API_TOKEN": bad_secret})
        self.assertNotIn(bad_secret, str(ctx.exception))

    def test_validate_api_base(self) -> None:
        self.assertEqual(security.validate_api_base("https://snap.dokitool.com/"), "https://snap.dokitool.com")
        self.assertEqual(security.validate_api_base("http://127.0.0.1:8080/"), "http://127.0.0.1:8080")
        self.assertEqual(security.validate_api_base("http://localhost:8080"), "http://localhost:8080")
        self.assertEqual(security.validate_api_base("http://[::1]:8080"), "http://[::1]:8080")
        for bad in (
            "http://snap.dokitool.com",
            "https://user:pass@snap.dokitool.com",
            "https://snap.dokitool.com?foo=1",
            "https://snap.dokitool.com#frag",
            "https://service.internal",
            "https://10.0.0.1",
            "https://169.254.169.254",
            "file:///etc/passwd",
        ):
            with self.subTest(api_base=bad):
                with self.assertRaises(security.SecurityError):
                    security.validate_api_base(bad)

    def test_ssrf_rejects_private_loopback_metadata_and_bad_schemes(self) -> None:
        forbidden_urls = [
            "http://127.0.0.1/sub.vtt",
            "https://127.0.0.2:443/sub.vtt",
            "http://[::1]/sub.vtt",
            "http://[::ffff:127.0.0.1]/sub.vtt",
            "http://10.0.0.1/sub.vtt",
            "https://172.16.0.1/sub.vtt",
            "https://192.168.1.5/sub.vtt",
            "http://169.254.169.254/latest/meta-data/",
            "http://[fe80::1]/sub.vtt",
            "http://[fec0::1]/sub.vtt",
            "http://[fc00::1]/sub.vtt",
            "http://[fd12:3456::1]/sub.vtt",
            "http://100.64.0.1/sub.vtt",
            "http://192.88.99.1/sub.vtt",
            "http://0.0.0.0/sub.vtt",
            "http://[::]/sub.vtt",
            "https://localhost/sub.vtt",
            "https://api.localhost/sub.vtt",
            "https://printer.local/sub.vtt",
            "https://metadata.google.internal/computeMetadata/v1/",
            "http://127.1/sub.vtt",
            "file:///etc/passwd",
            "ftp://example.com/sub.vtt",
            "data:text/plain;base64,SGVsbG8=",
            "https://user:secret@example.com/sub.vtt",
            "https://example.com/sub.vtt#frag",
        ]
        for url in forbidden_urls:
            with self.subTest(url=url):
                with self.assertRaises(security.SecurityError):
                    security.validate_remote_url(url, allow_loopback=False, resolver=_fake_public_resolver)

    def test_ssrf_rejects_dns_resolved_non_public_ips(self) -> None:
        for ip_str in ("127.0.0.1", "10.0.0.5", "169.254.169.254", "100.64.1.2", "192.88.99.1", "::1", "fc00::1", "fe80::1", "fec0::1"):
            with self.subTest(resolved_ip=ip_str):
                with self.assertRaises(security.SecurityError):
                    security.validate_remote_url(
                        "https://cdn.example.com/track.vtt",
                        allow_loopback=False,
                        resolver=_make_private_resolver(ip_str),
                    )
        parsed = security.validate_remote_url(
            "https://cdn.example.com/track.vtt",
            allow_loopback=False,
            resolver=_fake_public_resolver,
        )
        self.assertEqual(parsed.hostname, "cdn.example.com")

    def test_narrow_bilibili_referer_policy(self) -> None:
        bili_urls = [
            "https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/12/34/video.m4s",
            "https://cn-sh-cm-01.bilivideo.cn/video.m4s",
            "https://upos-hz-mirrorakam.akamaized.net/video.m4s",
            "https://bili-overseas.akamaized.net/video.m4s",
            "https://edge-node.akamaized.net/upgcxcode/99/88/audio.m4s",
        ]
        for url in bili_urls:
            headers = security.build_media_headers(url, extra_headers={"Cookie": "bad=1", "Authorization": "Bearer X"})
            self.assertEqual(headers.get("Referer"), "https://www.bilibili.com/", msg=url)
            self.assertNotIn("Cookie", headers)
            self.assertNotIn("Authorization", headers)

        non_bili_urls = [
            "https://vod-progressive.akamaized.net/vimeo/video.mp4",
            "https://www.youtube.com/api/timedtext?v=abc12345678&fmt=vtt",
            "https://evil-bilivideo.com/video.mp4",
            "https://video.twimg.com/ext_tw_video/1/pu/vid/a.mp4",
        ]
        for url in non_bili_urls:
            headers = security.build_media_headers(url)
            self.assertNotIn("Referer", headers, msg=url)

    def test_zero_cookie_and_redirect_revalidation_and_size_caps(self) -> None:
        _CookieAndRedirectHandler.recorded_cookies = []
        _CookieAndRedirectHandler.recorded_referers = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _CookieAndRedirectHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            # 1) Real validator rejects direct loopback media fetch immediately.
            strict_fetcher = security.SafeHTTPFetcher(timeout=5.0)
            with self.assertRaises(security.SecurityError):
                strict_fetcher.fetch_bytes(f"http://127.0.0.1:{port}/after-redirect", max_bytes=1024)

            # 2) Redirect-to-loopback test: allow ONLY hop 1 synthetic host, then enforce real validator on hop 2.
            base = f"http://127.0.0.1:{port}"
            calls = {"n": 0}

            def _allow_hop1_only(url: str, **kwargs):
                calls["n"] += 1
                if calls["n"] == 1:
                    return urllib.parse.urlsplit(url)
                return security.validate_remote_url(url, allow_loopback=False, resolver=_fake_public_resolver)

            hop_fetcher = security.SafeHTTPFetcher(timeout=5.0, url_validator=_allow_hop1_only)
            with self.assertRaises(security.SecurityError):
                hop_fetcher.fetch_bytes(f"{base}/redirect-to-loopback", max_bytes=4096)
            self.assertEqual(calls["n"], 2)

            # 3) Zero-Cookie test across redirect + second request against same local server.
            local_fetcher = security.SafeHTTPFetcher(
                timeout=5.0,
                url_validator=lambda u, **kw: urllib.parse.urlsplit(u),
            )
            resp1 = local_fetcher.fetch_bytes(f"{base}/set-cookie-redirect", max_bytes=4096)
            self.assertEqual(resp1.status, 200)
            self.assertIn(b"WEBVTT", resp1.body)
            resp2 = local_fetcher.fetch_bytes(f"{base}/after-redirect", max_bytes=4096)
            self.assertEqual(resp2.status, 200)
            self.assertTrue(len(_CookieAndRedirectHandler.recorded_cookies) >= 3)
            self.assertTrue(all(c is None for c in _CookieAndRedirectHandler.recorded_cookies))

            # 3b) Defense-in-depth: Authorization stripped on redirect hops even if media_mode=False.
            _CookieAndRedirectHandler.recorded_auths = []
            local_fetcher.fetch_bytes(
                f"{base}/set-cookie-redirect", max_bytes=4096,
                headers={"Authorization": "Bearer TestHeaderToken"},
                allow_redirects=True, media_mode=False,
            )
            self.assertEqual(_CookieAndRedirectHandler.recorded_auths, ["Bearer TestHeaderToken", None])

            # 4) Size cap enforcement (Content-Length and streaming body).
            with self.assertRaises(security.SizeLimitExceededError):
                local_fetcher.fetch_bytes(f"{base}/oversize-cl", max_bytes=security.MAX_SUBTITLE_BYTES)
            with self.assertRaises(security.SizeLimitExceededError):
                local_fetcher.fetch_bytes(f"{base}/oversize-stream", max_bytes=100 * 1024)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2.0)

    def test_output_root_path_and_symlink_jail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp).resolve()
            out_dir = tmp_path / "out"
            out_dir.mkdir()
            outside = tmp_path / "outside.txt"
            outside.write_text("secret", encoding="utf-8")

            good = security.resolve_jailed_path(out_dir, "video_1.mp4")
            self.assertEqual(good, out_dir / "video_1.mp4")

            for bad_name in ("../outside.txt", "/etc/passwd", "sub/file.mp4", "..", ".", "a\\b.mp4", "", "bad\nname.mp4", "bad\rname.mp4", "bad\x7f.mp4"):
                with self.subTest(bad_name=bad_name):
                    with self.assertRaises(security.SecurityError):
                        security.resolve_jailed_path(out_dir, bad_name)

            # Leaf symlink escaping outside output_dir
            leaf_link = out_dir / "escape.mp4"
            leaf_link.symlink_to(outside)
            with self.assertRaises(security.SecurityError):
                security.resolve_jailed_path(out_dir, "escape.mp4")

            # Directory symlink escaping outside output_dir
            dir_link = out_dir / "dir_escape"
            dir_link.symlink_to(tmp_path)
            with self.assertRaises(security.SecurityError):
                security.resolve_jailed_path(out_dir, "dir_escape/outside.txt", allow_subdirs=True)

            # Output dir itself as symlink (even broken) is rejected
            broken_out = tmp_path / "broken_out"
            broken_out.symlink_to(tmp_path / "does_not_exist")
            with self.assertRaises(security.SecurityError):
                security.validate_output_dir(broken_out, create=True)

    def test_redact_sensitive_strips_tokens_and_signed_queries(self) -> None:
        secret = "SecretTokenValue1234567890ABCDEFGHIJ"
        with mock.patch.dict("os.environ", {"DOKITOOL_API_TOKEN": secret}, clear=False):
            raw = (
                f"Failed Authorization: Bearer {secret} fetching "
                "https://user:supersecret@cdn.example.com/video.mp4?sig=deadbeef&expires=1700000000"
            )
            cleaned = security.redact_sensitive(raw)
        self.assertNotIn(secret, cleaned)
        self.assertNotIn("deadbeef", cleaned)
        self.assertNotIn("supersecret", cleaned)
        self.assertIn("https://[REDACTED]@cdn.example.com/video.mp4?[REDACTED]", cleaned)
        self.assertIn("Bearer [REDACTED]", cleaned)


if __name__ == "__main__":
    unittest.main()
