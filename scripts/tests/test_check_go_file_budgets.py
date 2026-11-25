"""Unit tests for scripts/check-go-file-budgets.py."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts/check-go-file-budgets.py"

spec = importlib.util.spec_from_file_location("check_go_file_budgets", SCRIPT_PATH)
assert spec is not None and spec.loader is not None
cgfb = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cgfb
spec.loader.exec_module(cgfb)


def _write_go_file(repo: Path, rel_path: str, line_count: int) -> Path:
    path = repo / rel_path
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["package sample"] + [f"// line {i}" for i in range(2, line_count + 1)]
    content = "\n".join(lines[:line_count]) + ("\n" if line_count > 0 else "")
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(content)
    return path


class CheckGoFileBudgetsTests(unittest.TestCase):
    def test_live_repo_passes_via_cli(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-B", str(SCRIPT_PATH), "--root", str(ROOT)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        self.assertIn("Go file budget check PASSED", proc.stdout)

    def test_new_files_within_default_limit_and_large_tests_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _write_go_file(repo, "backend/internal/pkg/exact.go", 800)
            _write_go_file(repo, "backend/cmd/tool/main.go", 200)
            _write_go_file(repo, "backend/internal/pkg/huge_test.go", 2500)

            res = cgfb.check_go_file_budgets(repo, legacy_ratchets={})
            self.assertTrue(res.passed, msg=res.violations)
            self.assertEqual(res.files_checked, 2)
            self.assertEqual(res.ratcheted_checked, 0)

    def test_new_file_exceeding_default_limit_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _write_go_file(repo, "backend/internal/pkg/too_big.go", 801)
            _write_go_file(repo, "backend/cmd/tool/also_big.go", 950)

            res = cgfb.check_go_file_budgets(repo, legacy_ratchets={})
            self.assertFalse(res.passed)
            self.assertEqual(len(res.violations), 2)
            self.assertTrue(any("too_big.go" in v and "801" in v for v in res.violations))
            self.assertTrue(any("also_big.go" in v and "950" in v for v in res.violations))

    def test_ratchet_ceiling_pass_and_exceed_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            rel = "backend/internal/api/handler.go"
            _write_go_file(repo, rel, 1100)

            ok = cgfb.check_go_file_budgets(repo, legacy_ratchets={rel: 1100})
            self.assertTrue(ok.passed, msg=ok.violations)
            self.assertEqual(ok.ratcheted_checked, 1)
            self.assertEqual(ok.notices, ())

            _write_go_file(repo, rel, 1101)
            fail = cgfb.check_go_file_budgets(repo, legacy_ratchets={rel: 1100})
            self.assertFalse(fail.passed)
            self.assertTrue(
                any("1101" in v and "1100" in v and rel in v for v in fail.violations),
                msg=fail.violations,
            )

    def test_ratcheted_file_shrunk_below_default_limit_passes_cleanly(self) -> None:
        """Wave 1 PR #56 shrinks youtube/helper.go to ~472 lines; must PASS cleanly."""
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            rel = "backend/internal/platform/youtube/helper.go"
            _write_go_file(repo, rel, 472)

            res = cgfb.check_go_file_budgets(repo, legacy_ratchets={rel: 1710})
            self.assertTrue(res.passed, msg=res.violations)
            self.assertEqual(res.ratcheted_checked, 1)
            self.assertEqual(len(res.notices), 1)
            self.assertIn("472", res.notices[0])
            self.assertIn(rel, res.notices[0])

    def test_deleted_ratcheted_file_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _write_go_file(repo, "backend/internal/api/alive.go", 120)
            missing = "backend/internal/api/deleted_legacy.go"

            res = cgfb.check_go_file_budgets(repo, legacy_ratchets={missing: 950})
            self.assertFalse(res.passed)
            self.assertTrue(
                any("go-file-ratchet-stale" in v and missing in v for v in res.violations),
                msg=res.violations,
            )

    def test_cli_root_flag_with_temp_repo_shrunk_and_violation_cases(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            # Create all registered legacy files; shrink ytengine/engine.go to 472 lines.
            shrunk_key = "backend/internal/ytengine/engine.go"
            self.assertIn(shrunk_key, cgfb.LEGACY_FILE_LINE_RATCHETS)
            for rel, ceiling in cgfb.LEGACY_FILE_LINE_RATCHETS.items():
                size = 472 if rel == shrunk_key else ceiling
                _write_go_file(repo, rel, size)

            ok_proc = subprocess.run(
                [sys.executable, "-B", str(SCRIPT_PATH), "--root", str(repo)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(ok_proc.returncode, 0, msg=ok_proc.stderr)
            self.assertIn("NOTICE:", ok_proc.stdout)
            self.assertIn(shrunk_key, ok_proc.stdout)
            self.assertIn("PASSED", ok_proc.stdout)

            # Adding an oversized unratcheted file must fail via CLI.
            _write_go_file(repo, "backend/internal/api/new_bloat.go", 805)
            bad_proc = subprocess.run(
                [sys.executable, "-B", str(SCRIPT_PATH), "--root", str(repo)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(bad_proc.returncode, 1)
            self.assertIn("new_bloat.go", bad_proc.stderr)

    def test_empty_root_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            res = cgfb.check_go_file_budgets(Path(tmp), legacy_ratchets={})
            self.assertFalse(res.passed)
            self.assertTrue(any("no non-test .go files found" in v for v in res.violations))


if __name__ == "__main__":
    unittest.main()
