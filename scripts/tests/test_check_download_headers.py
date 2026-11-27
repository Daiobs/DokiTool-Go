"""Unit tests for scripts/check-download-headers.py and ops/examples/snap.caddy 304 protection."""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import threading
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts/check-download-headers.py"
CADDY_PATH = REPO_ROOT / "ops/examples/snap.caddy"

_SPEC = importlib.util.spec_from_file_location("check_download_headers", SCRIPT_PATH)
assert _SPEC and _SPEC.loader
check_download_headers = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(check_download_headers)


def _start_mock_server(*, return_304_on: set[str] | None = None, expose_etag: bool = False):
    bad_paths = return_304_on or set()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):  # noqa: A002
            return

        def do_GET(self):  # noqa: N802
            path = self.path
            base_path = path.split("?", 1)[0]
            has_cond = bool(self.headers.get("If-None-Match") or self.headers.get("If-Modified-Since"))

            if base_path in bad_paths and has_cond:
                self.send_response(304)
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Cache-Control", "no-store")
                if expose_etag:
                    self.send_header("ETag", '"fixed-mtime-etag"')
                    self.send_header("Last-Modified", check_download_headers.FIXED_BUILD_MTIME_HTTP)
                self.end_headers()
                return

            if base_path == "/":
                body = b"<!doctype html><html><body>DokiTool</body></html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Cache-Control", "no-store")
                if expose_etag:
                    self.send_header("ETag", '"fixed-mtime-etag"')
                    self.send_header("Last-Modified", check_download_headers.FIXED_BUILD_MTIME_HTTP)
                self.end_headers()
                self.wfile.write(body)
                return

            if base_path == "/helper/extension-version.json":
                body = json.dumps({
                    "version": "4.5.1",
                    "download_url": "/helper/dokitool-chrome-extension.zip",
                    "sha256": "0" * 64,
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Cache-Control", "no-store")
                if expose_etag:
                    self.send_header("ETag", '"fixed-mtime-ext-etag"')
                    self.send_header("Last-Modified", check_download_headers.FIXED_BUILD_MTIME_HTTP)
                self.end_headers()
                self.wfile.write(body)
                return

            if base_path == "/downloads/bridge.html":
                body = b'<!doctype html><html><body><div id="dokitool-download-bridge"></div></body></html>'
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("X-Frame-Options", "SAMEORIGIN")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return

            if base_path in (
                "/downloads/worker.js",
                "/downloads/task-store.js",
                "/downloads/decoded-length.js",
                "/downloads/media-format.js",
                "/downloads/tbvideo.js",
            ):
                body = b"// worker module\n"
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)
                return

            self.send_response(404)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("X-Frame-Options", "DENY")
            self.end_headers()
            self.wfile.write(b"not found")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


class CheckDownloadHeadersTest(unittest.TestCase):
    def test_compliant_server_passes_all_18_checks_including_conditional_200(self) -> None:
        server, base_url = _start_mock_server()
        try:
            report = check_download_headers.run_checks(base_url, timeout=5, proxies={})
            self.assertTrue(report["passed"], json.dumps(report, indent=2))
            self.assertEqual(len(report["checks"]), 18)
            cond_home = [c for c in report["checks"] if c["path"] == "/" and c.get("conditions")]
            cond_ext = [
                c
                for c in report["checks"]
                if c["path"] == "/helper/extension-version.json" and c.get("conditions")
            ]
            self.assertEqual(len(cond_home), 2)
            self.assertEqual(len(cond_ext), 2)
            for item in cond_home + cond_ext:
                self.assertEqual(item["status"], 200)
                self.assertEqual(
                    item["conditions"]["If-Modified-Since"],
                    "Thu, 01 Jan 2026 00:00:00 GMT",
                )
        finally:
            server.shutdown()
            server.server_close()

    def test_fixed_mtime_304_on_home_fails_closed(self) -> None:
        server, base_url = _start_mock_server(return_304_on={"/"}, expose_etag=True)
        try:
            report = check_download_headers.run_checks(base_url, timeout=5, proxies={})
            self.assertFalse(report["passed"])
            failed_home = [
                c
                for c in report["checks"]
                if c["path"] == "/" and c.get("conditions") and not c["passed"]
            ]
            self.assertEqual(len(failed_home), 2)
            self.assertTrue(all(c["status"] == 304 for c in failed_home))
        finally:
            server.shutdown()
            server.server_close()

    def test_fixed_mtime_304_on_extension_version_json_fails_closed(self) -> None:
        server, base_url = _start_mock_server(
            return_304_on={"/helper/extension-version.json"}, expose_etag=True
        )
        try:
            report = check_download_headers.run_checks(base_url, timeout=5, proxies={})
            self.assertFalse(report["passed"])
            failed_ext = [
                c
                for c in report["checks"]
                if c["path"] == "/helper/extension-version.json"
                and c.get("conditions")
                and not c["passed"]
            ]
            self.assertEqual(len(failed_ext), 2)
            self.assertTrue(all(c["status"] == 304 for c in failed_ext))
            self.assertTrue(
                any(
                    c["conditions"].get("If-None-Match") == '"fixed-mtime-ext-etag"'
                    for c in failed_ext
                )
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_snap_caddy_strips_conditional_headers_for_non_hashed_static_and_preserves_immutable_assets(
        self,
    ) -> None:
        caddy = CADDY_PATH.read_text(encoding="utf-8")
        self.assertIn("@non_hashed_static {", caddy)
        self.assertIn("request_header @non_hashed_static -If-None-Match", caddy)
        self.assertIn("request_header @non_hashed_static -If-Modified-Since", caddy)
        self.assertIn("@no_store_static path / /index.html /helper/extension-version.json", caddy)
        self.assertIn("header @no_store_static -ETag", caddy)
        self.assertIn("header @no_store_static -Last-Modified", caddy)
        self.assertIn("@no_store_entry path / /index.html /helper/extension-version.json", caddy)
        self.assertIn('header @no_store_entry Cache-Control "no-store"', caddy)
        self.assertIn('header @versioned Cache-Control "public, max-age=31536000, immutable"', caddy)


if __name__ == "__main__":
    unittest.main()
