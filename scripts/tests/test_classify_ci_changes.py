#!/usr/bin/env python3
"""Unit tests for scripts/classify-ci-changes.py."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts" / "classify-ci-changes.py"


def load_module():
    spec = importlib.util.spec_from_file_location("classify_ci_changes", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


MOD = load_module()


class ClassifyPathsTests(unittest.TestCase):
    def test_scripts_and_docs_only_skip_go_and_frontend(self) -> None:
        cases = [
            ["scripts/prod-smoke/smoke.py", "scripts/prod-smoke/test_smoke.py"],
            ["scripts/check-public-files.py", "scripts/tests/test_public_files.py"],
            ["docs/openapi.json", "docs/API.md", "docs/CONFIGURATION.md"],
            ["README.md", "ops/examples/api-keys.example.json", "examples/agent_batch_download.py"],
        ]
        for paths in cases:
            with self.subTest(paths=paths):
                res = MOD.classify_paths(paths)
                self.assertFalse(res.run_go)
                self.assertFalse(res.run_frontend)
                self.assertEqual(res.changed_count, len(paths))

    def test_frontend_only_skips_go_and_runs_frontend(self) -> None:
        cases = [
            ["frontend/src/App.vue", "frontend/src/styles/main.css"],
            ["frontend/tests/ui-download-contract.test.mjs"],
            ["frontend/src/composables/useDownloadManager.ts", "docs/API.md"],
            ["ops/examples/snap.caddy"],
            ["scripts/test-download-browser.mjs"],
        ]
        for paths in cases:
            with self.subTest(paths=paths):
                res = MOD.classify_paths(paths)
                self.assertFalse(res.run_go)
                self.assertTrue(res.run_frontend)

    def test_backend_only_runs_go_and_skips_frontend(self) -> None:
        cases = [
            ["backend/internal/ytengine/engine.go"],
            ["backend/internal/api/stats_snapshot.go", "backend/internal/api/cache_test.go"],
            ["backend/docs/视频解析统一JSON格式3.0.md"],
            ["ops/examples/runtime.example.json"],
            ["scripts/requirements-validation.txt"],
            ["scripts/validate-unified-schema.py"],
        ]
        for paths in cases:
            with self.subTest(paths=paths):
                res = MOD.classify_paths(paths)
                self.assertTrue(res.run_go)
                self.assertFalse(res.run_frontend)

    def test_cross_layer_contracts_and_workflows_run_full_suite(self) -> None:
        full_triggers = [
            ".github/workflows/go-migration.yml",
            ".github/workflows/gateway-isolation.yml",
            ".github/workflows/php-oracle.yml",
            "public-files.json",
            ".gitignore",
            "docs/schema/unified-v1/unified-v1.schema.json",
            "docs/schema/unified-v1/examples/01-douyin-quality-and-cdn.json",
            "backend/config/platforms.json",
            "frontend/src/monitor/statsTypes.generated.ts",
            "frontend/scripts/test-pipixia-representation.mjs",
            "frontend/scripts/test-shanghai-original.mjs",
            "scripts/classify-ci-changes.py",
        ]
        for path in full_triggers:
            with self.subTest(path=path):
                res = MOD.classify_paths([path])
                self.assertTrue(res.run_go, f"{path} must trigger run_go")
                self.assertTrue(res.run_frontend, f"{path} must trigger run_frontend")

    def test_mixed_backend_and_frontend_runs_both(self) -> None:
        res = MOD.classify_paths([
            "backend/internal/api/handler.go",
            "frontend/src/components/VideoCard.vue",
        ])
        self.assertTrue(res.run_go)
        self.assertTrue(res.run_frontend)

    def test_fail_closed_on_empty_unknown_or_malformed_paths(self) -> None:
        bad_cases = [
            [],
            ["ops/release/deploy.sh"],
            ["unknown-root-file.txt"],
            ["../escape.py"],
            ["/abs/path.go"],
            ["scripts\\prod-smoke\\smoke.py"],
            [""],
        ]
        for paths in bad_cases:
            with self.subTest(paths=paths):
                res = MOD.classify_paths(paths)
                self.assertTrue(res.run_go)
                self.assertTrue(res.run_frontend)
                self.assertTrue(res.reason.startswith("fail-closed:"))


class GitIntegrationTests(unittest.TestCase):
    def _git(self, repo: Path, *args: str) -> str:
        proc = subprocess.run(
            ["git", *args],
            cwd=repo,
            check=True,
            capture_output=True,
            text=True,
        )
        return proc.stdout.strip()

    def test_three_dot_diff_ignores_concurrent_main_commits_and_handles_utf8_and_renames(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._git(repo, "init", "-b", "main")
            self._git(repo, "config", "user.name", "Test")
            self._git(repo, "config", "user.email", "test@example.invalid")

            (repo / "backend/docs").mkdir(parents=True)
            (repo / "frontend/src").mkdir(parents=True)
            (repo / "scripts").mkdir(parents=True)
            (repo / "backend/docs/视频解析统一JSON格式3.0.md").write_text("v1\n", encoding="utf-8")
            (repo / "frontend/src/App.vue").write_text("<template/>\n", encoding="utf-8")
            (repo / "scripts/tool.py").write_text("print(1)\n", encoding="utf-8")
            self._git(repo, "add", ".")
            self._git(repo, "commit", "-m", "init")

            # Create PR branch changing only frontend/src/App.vue.
            self._git(repo, "checkout", "-b", "pr-frontend")
            (repo / "frontend/src/App.vue").write_text("<template>ok</template>\n", encoding="utf-8")
            self._git(repo, "commit", "-am", "frontend tweak")
            pr_head = self._git(repo, "rev-parse", "HEAD")

            # Advance main independently with a backend change.
            self._git(repo, "checkout", "main")
            (repo / "backend/docs/视频解析统一JSON格式3.0.md").write_text("v2\n", encoding="utf-8")
            self._git(repo, "commit", "-am", "main backend doc change")
            main_head = self._git(repo, "rev-parse", "HEAD")

            # Three-dot diff base...head should only see frontend/src/App.vue.
            gh_out = repo / "github_output.txt"
            proc = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_PATH),
                    "--repo",
                    str(repo),
                    "--base",
                    main_head,
                    "--head",
                    pr_head,
                    "--github-output",
                    str(gh_out),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["run_go"], False)
            self.assertEqual(payload["run_frontend"], True)
            self.assertEqual(payload["changed_count"], 1)
            output_text = gh_out.read_text(encoding="utf-8")
            self.assertIn("run_go=false\n", output_text)
            self.assertIn("run_frontend=true\n", output_text)

            # Moving a backend file into docs/ must still trigger run_go via --no-renames.
            self._git(repo, "checkout", "-b", "pr-move-backend")
            (repo / "docs").mkdir(exist_ok=True)
            self._git(repo, "mv", "backend/docs/视频解析统一JSON格式3.0.md", "docs/moved.md")
            self._git(repo, "commit", "-m", "move backend doc")
            move_head = self._git(repo, "rev-parse", "HEAD")
            paths, err = MOD.changed_files_from_git(repo, main_head, move_head)
            self.assertIsNone(err)
            assert paths is not None
            self.assertIn("backend/docs/视频解析统一JSON格式3.0.md", paths)
            self.assertIn("docs/moved.md", paths)
            res = MOD.classify_paths(paths)
            self.assertTrue(res.run_go)
            self.assertFalse(res.run_frontend)

    def test_missing_commit_or_invalid_sha_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._git(repo, "init", "-b", "main")
            for base_arg, head_arg in (
                ("--not-a-sha", "deadbeef"),
                ("0" * 40, "1" * 40),
            ):
                with self.subTest(base=base_arg, head=head_arg):
                    gh_out = repo / f"github_output_{head_arg}.txt"
                    proc = subprocess.run(
                        [
                            sys.executable,
                            "-B",
                            str(SCRIPT_PATH),
                            "--repo",
                            str(repo),
                            f"--base={base_arg}",
                            f"--head={head_arg}",
                            f"--github-output={gh_out}",
                        ],
                        check=True,
                        capture_output=True,
                        text=True,
                    )
                    payload = json.loads(proc.stdout)
                    self.assertTrue(payload["run_go"])
                    self.assertTrue(payload["run_frontend"])
                    self.assertIn("fail-closed:", payload["reason"])
                    self.assertIn("run_go=true\n", gh_out.read_text(encoding="utf-8"))
                    self.assertIn("run_frontend=true\n", gh_out.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
