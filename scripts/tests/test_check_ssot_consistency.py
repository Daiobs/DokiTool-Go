"""Controlled-failure unit tests for scripts/check-ssot-consistency.py."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts/check-ssot-consistency.py"
WATCH_TEST_PATH = ROOT / "scripts/tests/test_upstream_updates.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


SSOT = _load_module("dokitool_test_ssot_mod", SCRIPT_PATH)
WATCH_TESTS = _load_module("dokitool_test_watch_fixture_mod", WATCH_TEST_PATH)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _create_valid_repo(repo: Path) -> None:
    WATCH_TESTS.write_synthetic_lock_files(repo)

    ext_id = "ihamkldlkdibleacagiejklpfofapkpo"
    _write(
        repo / "frontend/src/core/extensionReleaseMeta.json",
        json.dumps({"version": "4.5.0", "extensionId": ext_id}, indent=2) + "\n",
    )
    _write(
        repo / "frontend/package.json",
        json.dumps(
            {
                "name": "dokitool-web",
                "version": "4.5.0",
                "dependencies": {
                    "@fortawesome/fontawesome-free": "6.7.2",
                    "mediabunny": "1.65.2",
                },
                "devDependencies": {"vite": "^5.0.0"},
            },
            indent=2,
        )
        + "\n",
    )
    _write(
        repo / "frontend/package-lock.json",
        json.dumps(
            {
                "name": "dokitool-web",
                "version": "4.5.0",
                "lockfileVersion": 3,
                "packages": {"": {"name": "dokitool-web", "version": "4.5.0"}},
            },
            indent=2,
        )
        + "\n",
    )
    _write(repo / "frontend/public/llms.txt", "# DokiTool\nChrome MV3 Extension v4.5.0\n")
    _write(
        repo / "README.md",
        "# DokiTool\nGo 1.27.4 | Chrome MV3 v4.5.0 | Mediabunny 1.65.2\n",
    )
    _write(repo / "docs/EXTENSION.md", "# Extension v4.5.0\n")
    _write(repo / "docs/RELEASE-RECEIPT.md", f"# Receipt v4.5.0 id={ext_id}\n")
    _write(
        repo / "NOTICE",
        "Mediabunny 1.65.2 https://github.com/Vanilagy/mediabunny/tree/v1.65.2\n",
    )
    _write(
        repo / "frontend/public/licenses/mediabunny-MPL-2.0.txt",
        "Mozilla Public License Version 2.0\n",
    )
    _write(
        repo / "backend/go.mod",
        "module example.com/dokitool/backend\n\ngo 1.27.0\n\ntoolchain go1.27.4\n",
    )
    # Enrich release-build.yml fixture with required Go/CGO/ref guards
    rel_wf = repo / ".github/workflows/release-build.yml"
    rel_wf.write_text(
        rel_wf.read_text(encoding="utf-8")
        + "    if: github.repository == 'Daiobs/DokiTool-Go' && github.ref == 'refs/heads/main'\n"
        + "          go-version-file: backend/go.mod\n"
        + "          CGO_ENABLED: '0'\n",
        encoding="utf-8",
    )
    _write(repo / "tools/dokitool-agent/security.py", 'AGENT_VERSION = "1.0.0"\n')
    _write(repo / "tools/dokitool-agent/dokitool_agent.py", "from security import AGENT_VERSION\n__version__ = AGENT_VERSION\n")
    _write(repo / "tools/dokitool-agent/mcp_server.py", 'from security import AGENT_VERSION\nINFO = {"version": AGENT_VERSION}\n')


class CheckSSOTConsistencyTests(unittest.TestCase):
    def test_valid_synthetic_repo_passes_library_and_cli(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_repo(repo)
            report = SSOT.run_all_checks(repo)
            self.assertTrue(report["passed"], msg=report["violations"])
            self.assertEqual(report["checks"], 6)
            self.assertEqual(report["summary"]["extension_version"], "4.5.0")
            self.assertEqual(report["summary"]["mediabunny_version"], "1.65.2")
            self.assertEqual(report["summary"]["go_toolchain"], "1.27.4")
            self.assertEqual(report["summary"]["runtime_lock_files"], 6)
            self.assertEqual(report["summary"]["agent_version"], "1.0.0")

            proc = subprocess.run(
                [sys.executable, "-B", str(SCRIPT_PATH), "--root", str(repo)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            self.assertTrue(json.loads(proc.stdout)["passed"])

    def test_controlled_failures_detect_each_ssot_drift(self) -> None:
        mutations = [
            (
                "package-json-version-drift",
                "frontend/package.json",
                lambda s: s.replace('"4.5.0"', '"4.4.1"'),
                "[ext-ssot]",
            ),
            (
                "package-json-name-drift",
                "frontend/package.json",
                lambda s: s.replace('"dokitool-web"', '"bk-sv-vue3"'),
                "[ext-ssot]",
            ),
            (
                "mediabunny-notice-drift",
                "NOTICE",
                lambda s: s.replace("1.65.2", "1.64.0"),
                "[mediabunny-ssot]",
            ),
            (
                "release-build-hardcoded-go-version",
                ".github/workflows/release-build.yml",
                lambda s: s.replace("go-version-file: backend/go.mod", "go-version: '1.27.4'"),
                "[go-ssot]",
            ),
            (
                "upstream-canary-deno-drift",
                ".github/workflows/upstream-canary.yml",
                lambda s: s.replace("/download/v2.9.8/", "/download/v2.9.7/"),
                "[runtime-pins]",
            ),
            (
                "hardcoded-mcp-version",
                "tools/dokitool-agent/mcp_server.py",
                lambda s: s.replace("AGENT_VERSION", '"1.0.0"'),
                "[agent-ssot]",
            ),
            (
                "docs-home-path-leak",
                "docs/EXTENSION.md",
                lambda s: s + "\nSee /Users/alice/dev/repo for details\n",
                "[docs-desensitize]",
            ),
            (
                "docs-local-proxy-leak",
                "README.md",
                lambda s: s + "\nProxy: http://127.0.0.1:7897\n",
                "[docs-desensitize]",
            ),
        ]
        for label, rel, mutate, expected_tag in mutations:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                repo = Path(tmp)
                _create_valid_repo(repo)
                target = repo / rel
                target.write_text(mutate(target.read_text(encoding="utf-8")), encoding="utf-8")
                report = SSOT.run_all_checks(repo)
                self.assertFalse(report["passed"], f"expected failure for {label}")
                self.assertTrue(
                    any(expected_tag in v for v in report["violations"]),
                    msg=f"{label}: expected {expected_tag} in {report['violations']}",
                )

    def test_narrative_docs_without_literal_versions_still_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_repo(repo)
            # Narrative Markdown prose should NOT be coupled to patch-level literal versions.
            _write(repo / "README.md", "# DokiTool\nZero-Cookie Media Downloader\n")
            _write(repo / "docs/EXTENSION.md", "# Chrome MV3 Extension\n")
            _write(repo / "docs/RELEASE-RECEIPT.md", "# Release Receipt Template\n")
            _write(repo / "frontend/public/llms.txt", "# DokiTool\n")
            report = SSOT.run_all_checks(repo)
            self.assertTrue(report["passed"], msg=report["violations"])

    def test_real_repo_passes_ssot_consistency(self) -> None:
        report = SSOT.run_all_checks(ROOT)
        self.assertTrue(report["passed"], msg=report["violations"])


if __name__ == "__main__":
    unittest.main()
