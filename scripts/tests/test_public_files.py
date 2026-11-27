"""Unit tests for zero-config scripts/check-public-files.py forbidden-file guard."""
from __future__ import annotations

import importlib.util
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


class PublicFilesGuardTests(unittest.TestCase):
    def _init_repo(self, repo: Path) -> None:
        _git(repo, "init")
        _git(repo, "config", "user.email", "test@example.com")
        _git(repo, "config", "user.name", "Test")
        (repo / "src").mkdir()
        (repo / "src/a.txt").write_text("alpha\n", encoding="utf-8")
        (repo / ".gitignore").write_text("node_modules/\nfrontend/dist-extension/\n.env.*\n!.env.example\n", encoding="utf-8")
        _git(repo, "add", ".gitignore", "src/a.txt")
        _git(repo, "commit", "-m", "init")

    def test_zero_config_new_source_and_allowed_examples_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            (repo / "src/new_module.ts").write_text("export const ok = true;\n", encoding="utf-8")
            (repo / ".env.example").write_text("DOKITOOL_PORT=8080\n", encoding="utf-8")
            (repo / "ops/examples").mkdir(parents=True)
            (repo / "ops/examples/api-keys.example.json").write_text('{"keys":[]}\n', encoding="utf-8")
            # Untracked local scratch file should not affect tracked index guard.
            (repo / "local-scratch.log").write_text("untracked\n", encoding="utf-8")

            _git(repo, "add", "src/new_module.ts", ".env.example", "ops/examples/api-keys.example.json")
            self.assertEqual(cpf.run_check([], root=repo), 0)
            self.assertEqual(cpf.run_check(["--staged"], root=repo), 0)

            # Unstaged modification to a tracked file must fail under --staged.
            (repo / "src/a.txt").write_text("modified-unstaged\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Tracked working files differ"):
                cpf.run_check(["--staged"], root=repo)

    def test_forbidden_dirs_secrets_artifacts_symlinks_and_oversized_fail_closed(self) -> None:
        cases = [
            ("frontend/dist-extension/manifest.json", b'{"manifest_version":3}\n', "Forbidden directory"),
            ("node_modules/pkg/index.js", b"module.exports = {};\n", "Forbidden directory"),
            (".gemini/cache.json", b"{}\n", "Forbidden directory"),
            ("scratch/tmp.txt", b"x\n", "Forbidden directory"),
            (".env.production", b"TOKEN=secret\n", "Only .env.example"),
            ("ops/server.key", b"PRIVATE KEY\n", "Sensitive key/certificate"),
            ("ops/cert.pem", b"CERT\n", "Sensitive key/certificate"),
            ("ops/id_ed25519", b"SSH KEY\n", "Private SSH key"),
            ("ops/api-keys.json", b'{"keys":[]}\n', "Non-example API key"),
            ("backend/app.test", b"ELF", "Compiled/binary artifact"),
            ("scripts/mod.pyc", b"PYC", "Compiled/binary artifact"),
        ]
        for rel_path, content, err_pattern in cases:
            with self.subTest(rel_path=rel_path):
                with tempfile.TemporaryDirectory() as tmp:
                    repo = Path(tmp)
                    self._init_repo(repo)
                    target = repo / rel_path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
                    _git(repo, "add", "-f", rel_path)
                    with self.assertRaisesRegex(ValueError, err_pattern):
                        cpf.run_check(["--staged"], root=repo)

    def test_symlink_and_oversized_binary_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            link = repo / "src/link.txt"
            link.symlink_to(repo / "src/a.txt")
            _git(repo, "add", "-f", "src/link.txt")
            with self.assertRaisesRegex(ValueError, "Symlink is not permitted"):
                cpf.run_check(["--staged"], root=repo)

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            big = repo / "src/huge.bin"
            big.write_bytes(b"0" * (cpf.MAX_FILE_BYTES + 1))
            _git(repo, "add", "-f", "src/huge.bin")
            with self.assertRaisesRegex(ValueError, "Oversized file"):
                cpf.run_check(["--staged"], root=repo)


if __name__ == "__main__":
    unittest.main()
