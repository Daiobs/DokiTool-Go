"""Offline unit tests for tools/dokitool-agent/security.py."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
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

import http_transport  # noqa: E402
import security  # noqa: E402


_PROXY_ENV_KEYS = (
    "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
)


def _clean_proxy_env(overrides: dict[str, str] | None = None) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in _PROXY_ENV_KEYS}
    if overrides:
        env.update(overrides)
    return env


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
    recorded_hosts: list[str | None] = []

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def do_GET(self) -> None:  # noqa: N802
        self.__class__.recorded_cookies.append(self.headers.get("Cookie"))
        self.__class__.recorded_referers.append(self.headers.get("Referer"))
        self.__class__.recorded_auths.append(self.headers.get("Authorization"))
        self.__class__.recorded_hosts.append(self.headers.get("Host"))
        if self.path == "/redirect-hop2":
            port = self.server.server_address[1]
            self.send_response(302)
            self.send_header("Location", f"http://hop2.example.com:{port}/after-redirect")
            self.end_headers()
            return
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
            "http://127.0.0.1/sub.vtt", "https://127.0.0.2:443/sub.vtt",
            "http://[::1]/sub.vtt", "http://[::ffff:127.0.0.1]/sub.vtt",
            "http://10.0.0.1/sub.vtt", "https://172.16.0.1/sub.vtt", "https://192.168.1.5/sub.vtt",
            "http://169.254.169.254/latest/meta-data/", "http://[fe80::1]/sub.vtt",
            "http://[fec0::1]/sub.vtt", "http://[fc00::1]/sub.vtt", "http://[fd12:3456::1]/sub.vtt",
            "http://100.64.0.1/sub.vtt", "http://192.88.99.1/sub.vtt", "http://0.0.0.0/sub.vtt",
            "http://[::]/sub.vtt", "https://localhost/sub.vtt", "https://api.localhost/sub.vtt",
            "https://printer.local/sub.vtt", "https://metadata.google.internal/computeMetadata/v1/",
            "http://127.1/sub.vtt", "file:///etc/passwd", "ftp://example.com/sub.vtt",
            "data:text/plain;base64,SGVsbG8=", "https://user:secret@example.com/sub.vtt",
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
            "https://i0.hdslb.com/bfs/archive/cover.jpg",
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

            for bad_name in (
                "../outside.txt", "/etc/passwd", "sub/file.mp4", "..", ".", "a\\b.mp4", "",
                "bad\nname.mp4", "bad\rname.mp4", "bad\x7f.mp4",
                "video.mp4:stream", "C:drive.mp4", "trailing.", "trailing ",
                "CON.mp4", "NUL.txt", "COM1.vtt", "lpt9.mkv",
            ):
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

    def test_direct_ip_pinning_blocks_dns_rebinding_preserves_host_sni_and_no_proxy(self) -> None:
        _CookieAndRedirectHandler.recorded_hosts = []
        server = ThreadingHTTPServer(("127.0.0.1", 0), _CookieAndRedirectHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            # 1) DNS flips from public IP on call 1 to 127.0.0.1 on call 2; transport must dial call-1 IP only.
            rebind_calls = {"n": 0}

            def _rebinding_resolver(host: str, p: int, family: int = 0, socktype: int = 0):
                rebind_calls["n"] += 1
                if host == "hop2.example.com":
                    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", p))]
                ip = "93.184.216.34" if rebind_calls["n"] == 1 else "127.0.0.1"
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, p))]

            dialed: list[tuple[str, int]] = []
            real_connect = http_transport._connect_pinned_ip

            def _intercept_dial(ip_str: str, p: int, timeout, source_address=None):
                dialed.append((ip_str, p))
                return real_connect("127.0.0.1", port, timeout, source_address)

            # Also set HTTP_PROXY in a clean env to prove --no-proxy bypasses env proxy and enforces IP pinning.
            clean_env = _clean_proxy_env({"HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9"})
            with mock.patch.dict("os.environ", clean_env, clear=True), \
                 mock.patch.object(http_transport, "_connect_pinned_ip", side_effect=_intercept_dial), \
                 mock.patch("socket.getaddrinfo", side_effect=AssertionError("connect must not re-query DNS")):
                self.assertTrue(http_transport.has_env_proxy_for("http", "rebind.example.com", port))
                fetcher = http_transport.SafeHTTPFetcher(
                    timeout=5.0, no_proxy=True, resolver=_rebinding_resolver,
                    allowed_media_ports=frozenset({80, 443, port}),
                )
                resp = fetcher.fetch_bytes(f"http://rebind.example.com:{port}/redirect-hop2", max_bytes=4096)
            self.assertEqual(resp.status, 200)
            self.assertEqual(dialed, [("93.184.216.34", port), ("1.1.1.1", port)])
            self.assertEqual(_CookieAndRedirectHandler.recorded_hosts, [f"rebind.example.com:{port}", f"hop2.example.com:{port}"])

            # 2) HTTPS pinned connection dials validated numeric IP while preserving original SNI server_hostname.
            fake_ctx, fake_sock, fake_tls = mock.MagicMock(), mock.MagicMock(), mock.MagicMock()
            fake_ctx.wrap_socket.return_value = fake_tls
            with mock.patch.object(http_transport, "_connect_pinned_ip", return_value=fake_sock) as mock_dial:
                conn = http_transport._PinnedHTTPSConnection("sni.example.com", 443, context=fake_ctx, pinned_ips=("93.184.216.34",))
                conn.connect()
            mock_dial.assert_called_once_with("93.184.216.34", 443, conn.timeout, conn.source_address)
            fake_ctx.wrap_socket.assert_called_once_with(fake_sock, server_hostname="sni.example.com")
            self.assertIs(conn.sock, fake_tls)

            # 3) Loopback localhost API fetch resolves and pins loopback numeric IP without re-querying DNS at connect.
            lb_dialed: list[tuple[str, int]] = []
            with mock.patch.object(http_transport, "_connect_pinned_ip", side_effect=lambda ip, p, t, s=None: (lb_dialed.append((ip, p)), real_connect(ip, p, t, s))[1]), \
                 mock.patch("socket.getaddrinfo", side_effect=AssertionError("localhost connect must use pinned IP")):
                lb_fetcher = http_transport.SafeHTTPFetcher(timeout=5.0, resolver=_make_private_resolver("127.0.0.1"))
                lb_resp = lb_fetcher.fetch_bytes(f"http://localhost:{port}/after-redirect", max_bytes=4096, allow_loopback=True, media_mode=False)
            self.assertEqual(lb_resp.status, 200)
            self.assertEqual(lb_dialed, [("127.0.0.1", port)])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2.0)

    def test_proxy_env_case_isolation_and_localhost_pinning_validation(self) -> None:
        # R66-02: uppercase/lowercase proxy overrides and NO_PROXY matching under isolated env.
        with mock.patch.dict("os.environ", _clean_proxy_env({"HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9", "http_proxy": ""}), clear=True):
            self.assertFalse(http_transport.has_env_proxy_for("http", "rebind.example.com", 80))
            self.assertTrue(http_transport.has_env_proxy_for("https", "rebind.example.com", 443))
        with mock.patch.dict("os.environ", _clean_proxy_env({"HTTP_PROXY": "http://127.0.0.1:9", "NO_PROXY": ".example.com"}), clear=True):
            self.assertFalse(http_transport.has_env_proxy_for("http", "rebind.example.com", 80))
            self.assertTrue(http_transport.has_env_proxy_for("http", "cdn.other.org", 80))
        with mock.patch.dict("os.environ", _clean_proxy_env({"http_proxy": "http://127.0.0.1:9", "no_proxy": "other.org"}), clear=True):
            self.assertTrue(http_transport.has_env_proxy_for("http", "rebind.example.com", 80))
            self.assertFalse(http_transport.has_env_proxy_for("http", "cdn.other.org", 80))
        # R66-03: localhost / *.localhost loopback pinning and fail-closed on non-loopback /etc/hosts override.
        self.assertEqual(security.validate_and_resolve_remote_url("http://127.0.0.1:8080/x", allow_loopback=True)[1], ("127.0.0.1",))
        self.assertEqual(security.validate_and_resolve_remote_url("http://[::1]:8080/x", allow_loopback=True)[1], ("::1",))
        self.assertEqual(security.validate_and_resolve_remote_url("http://localhost:8080/x", allow_loopback=True, resolve_dns=False)[1], ("127.0.0.1", "::1"))
        self.assertEqual(security.validate_and_resolve_remote_url("http://api.localhost:8080/x", allow_loopback=True, resolve_dns=False)[1], ("127.0.0.1", "::1"))
        multi_lb = lambda h, p, f=0, s=0: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", p)), (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", p)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", p))]
        self.assertEqual(security.validate_and_resolve_remote_url("http://localhost:8080/x", allow_loopback=True, resolver=multi_lb)[1], ("127.0.0.1", "::1"))
        for bad_ip in ("93.184.216.34", "10.0.0.1", "169.254.169.254"):
            with self.assertRaises(security.SecurityError):
                security.validate_and_resolve_remote_url("http://localhost:8080/x", allow_loopback=True, resolver=_make_private_resolver(bad_ip))

    def test_nv13_env_only_proxy_standard_ports_and_https_downgrade_protection(self) -> None:
        # 1) OS-level proxies must NEVER override empty process env proxies (IP pinning preserved).
        with mock.patch.dict("os.environ", _clean_proxy_env(), clear=True), \
             mock.patch("urllib.request.getproxies", return_value={"https": "http://os-proxy.internal:8080"}):
            self.assertFalse(http_transport.has_env_proxy_for("https", "cdn.example.com", 443))
            opener = http_transport.build_safe_opener(bypass_proxy=False, pinned_ips=("93.184.216.34",))
            proxy_handlers = [h for h in opener.handlers if isinstance(h, http_transport.urllib.request.ProxyHandler)]
            self.assertTrue(all(h.proxies == {} for h in proxy_handlers))

        # 2) Non-standard remote ports are rejected by default in media_mode.
        strict_fetcher = http_transport.SafeHTTPFetcher(timeout=5.0, resolver=_fake_public_resolver)
        with self.assertRaises(security.SecurityError):
            strict_fetcher.fetch_bytes("https://cdn.example.com:8443/track.vtt", max_bytes=1024)
        with self.assertRaises(security.SecurityError):
            strict_fetcher.fetch_bytes("http://cdn.example.com:6379/", max_bytes=1024)

        # 3) HTTPS -> HTTP redirect downgrade is rejected.
        import io
        def _fake_downgrade_opener(_bypass: bool):
            class _DowngradeOpener:
                def open(self, req, timeout=None):
                    raise http_transport.urllib.error.HTTPError(
                        req.full_url, 302, "Found", {"Location": "http://cdn.example.com/plain.vtt"}, io.BytesIO(b"")
                    )
            return _DowngradeOpener()

        dg_fetcher = http_transport.SafeHTTPFetcher(
            timeout=5.0, resolver=_fake_public_resolver, opener_factory=_fake_downgrade_opener,
        )
        with self.assertRaises(security.SecurityError) as ctx:
            dg_fetcher.fetch_bytes("https://cdn.example.com/start.vtt", max_bytes=1024)
        self.assertIn("downgrade", str(ctx.exception).lower())

    def test_nv14_batch_example_anti_ssrf_and_strict_extension_allowlist(self) -> None:
        import importlib.util
        batch_path = AGENT_DIR.parent.parent / "examples" / "agent_batch_download.py"
        spec = importlib.util.spec_from_file_location("agent_batch_download_sec", batch_path)
        assert spec and spec.loader
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        # Rejects non-media executable extensions in API metadata
        for bad_ext in ("exe", "sh", "bat", "ps1", "html"):
            self.assertIsNone(mod.infer_extension_from_result({"extension": bad_ext}, "", ""))
            self.assertIsNone(mod.infer_extension_from_result({"container": bad_ext}, "", ""))
        self.assertEqual(mod.infer_extension_from_result({"extension": "mp4"}, "", ""), "mp4")

        # Blocks loopback/private/metadata/file/non-standard port media URLs in production mode
        for bad_url in (
            "http://127.0.0.1:8080/secret",
            "http://169.254.169.254/latest/meta-data/",
            "https://10.0.0.1/video.mp4",
            "file:///etc/passwd",
            "https://cdn.example.com:8443/video.mp4",
        ):
            with self.assertRaises(ValueError, msg=bad_url):
                mod.validate_remote_url_and_pin(bad_url)

        # Rejects remote HTTP or userinfo in --api-base
        with self.assertRaises(ValueError):
            mod.validate_api_base("http://snap.dokitool.com")
        with self.assertRaises(ValueError):
            mod.validate_api_base("https://user:pass@snap.dokitool.com")

        # Redacts query strings and tokens in error records
        scrubbed = mod.redact_sensitive("failed https://cdn.example.com/a.mp4?sig=SECRET123 Bearer AbCdEf123456")
        self.assertNotIn("SECRET123", scrubbed)
        self.assertNotIn("AbCdEf123456", scrubbed)


if __name__ == "__main__":
    unittest.main()
