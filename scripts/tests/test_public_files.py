"""Unit tests for scripts/check-public-files.py (--sync, --add, and security boundaries)."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts/check-public-files.py"

spec = importlib.util.spec_from_file_location("check_public_files", SCRIPT_PATH)
assert spec is not None and spec.loader is not None
cpf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cpf)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=repo,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class PublicFilesSyncTests(unittest.TestCase):
    def _init_repo(self, repo: Path) -> None:
        _git(repo, "init")
        _git(repo, "config", "user.email", "test@example.com")
        _git(repo, "config", "user.name", "Test")
        (repo / "src").mkdir()
        (repo / "src/a.txt").write_text("alpha\n", encoding="utf-8")
        initial_files = sorted([".gitignore", "public-files.json", "src/a.txt"])
        (repo / "public-files.json").write_text(
            json.dumps({"files": initial_files}, indent=2) + "\n",
            encoding="utf-8",
        )
        (repo / ".gitignore").write_text(cpf.ignore_text(initial_files), encoding="utf-8")
        _git(repo, "add", ".gitignore", "public-files.json", "src/a.txt")
        _git(repo, "commit", "-m", "init")

    def test_add_registers_new_file_and_rewrites_gitignore_without_sweeping_untracked(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            (repo / "src/b.txt").write_text("beta\n", encoding="utf-8")
            # Untracked local file must NEVER be swept in automatically.
            (repo / "local-scratch.txt").write_text("keep ignored\n", encoding="utf-8")

            rc = cpf.run_check(["--add", "src/b.txt"], root=repo)
            self.assertEqual(rc, 0)
            manifest = json.loads((repo / "public-files.json").read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["files"],
                [".gitignore", "public-files.json", "src/a.txt", "src/b.txt"],
            )
            self.assertNotIn("local-scratch.txt", manifest["files"])
            gitignore = (repo / ".gitignore").read_text(encoding="utf-8")
            self.assertIn("!/src/b.txt", gitignore)
            self.assertNotIn("local-scratch.txt", gitignore)

            _git(repo, "add", ".gitignore", "public-files.json", "src/b.txt")
            self.assertEqual(cpf.run_check(["--staged"], root=repo), 0)

    def test_sync_prunes_deleted_and_adds_staged_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            (repo / "src/c.txt").write_text("gamma\n", encoding="utf-8")
            (repo / "untracked.log").write_text("secret\n", encoding="utf-8")
            _git(repo, "rm", "src/a.txt")
            _git(repo, "add", "-f", "src/c.txt")

            rc = cpf.run_check(["--sync"], root=repo)
            self.assertEqual(rc, 0)
            manifest = json.loads((repo / "public-files.json").read_text(encoding="utf-8"))
            self.assertEqual(
                manifest["files"],
                [".gitignore", "public-files.json", "src/c.txt"],
            )
            _git(repo, "add", ".gitignore", "public-files.json")
            self.assertEqual(cpf.run_check(["--staged"], root=repo), 0)

    def test_security_rejections_fail_closed_without_mutating_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            before_manifest = (repo / "public-files.json").read_text(encoding="utf-8")
            before_ignore = (repo / ".gitignore").read_text(encoding="utf-8")

            (repo / ".env.local").write_text("TOKEN=secret\n", encoding="utf-8")
            (repo / "dist").mkdir()
            (repo / "dist/bundle.js").write_text("x\n", encoding="utf-8")
            (repo / "src/link.txt").symlink_to(repo / "src/a.txt")

            for bad_path in (".env.local", "dist/bundle.js", "src/link.txt", "../outside.txt", "src\\a.txt"):
                with self.subTest(bad_path=bad_path):
                    with self.assertRaises(ValueError):
                        cpf.run_check(["--add", bad_path], root=repo)
                    self.assertEqual((repo / "public-files.json").read_text(encoding="utf-8"), before_manifest)
                    self.assertEqual((repo / ".gitignore").read_text(encoding="utf-8"), before_ignore)

            # .env.example IS permitted.
            (repo / ".env.example").write_text("DOKITOOL_PORT=8080\n", encoding="utf-8")
            self.assertEqual(cpf.run_check(["--add", ".env.example"], root=repo), 0)


if __name__ == "__main__":
    unittest.main()
