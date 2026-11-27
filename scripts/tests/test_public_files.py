"""Unit tests for zero-config scripts/check-public-files.py forbidden-file guard."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import sys
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

    def test_high_confidence_credential_content_and_names_fail_closed(self) -> None:
        # Build synthetic secret payloads dynamically so no literal secret strings live in source.
        private_key_payload = (
            "-----BEGIN " + "OPENSSH PRIVATE KEY-----\n"
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n"
            "-----END " + "OPENSSH PRIVATE KEY-----\n"
        )
        gh_pat_payload = "token=" + ("ghp_" + "A1b2C3d4E5f6" * 3) + "\n"
        gh_fine_pat_payload = "token=" + ("github_pat_" + "z9Y8x7W6v5U4" * 2) + "\n"
        aws_key_payload = "aws_id=" + ("AKIA" + "0123456789ABCDEF") + "\n"
        bearer_payload = "Authorization: Bearer " + ("live_prod_bearer_" + "9f8e7d6c5b4a3210") + "\n"
        owner_tok_payload = "DOKITOOL_OWNER_TOKEN=" + ("live_owner_secret_" + "1234567890abcdef") + "\n"
        api_tok_payload = 'DOKITOOL_API_TOKEN="' + ("live_api_secret_" + "fedcba0987654321") + '"\n'

        cases = [
            # R77-01 review scenario: ops/production-credentials.txt with simulated key/token
            ("ops/production-credentials.txt", private_key_payload, "Credential file under ops/"),
            ("ops/production-credentials.txt", "plain notes\n", "Credential file under ops/"),
            ("config/prod-secrets.json", '{"k":"v"}\n', "Sensitive credential/secret config file"),
            # Arbitrary filenames caught purely by high-confidence content signatures
            ("notes/deploy.txt", private_key_payload, r"High-confidence credential pattern \(private-key\)"),
            ("notes/ci.txt", gh_pat_payload, r"High-confidence credential pattern \(github-pat\)"),
            ("notes/ci-fine.txt", gh_fine_pat_payload, r"High-confidence credential pattern \(github-pat\)"),
            ("notes/cloud.txt", aws_key_payload, r"High-confidence credential pattern \(aws-access-key\)"),
            ("notes/curl.txt", bearer_payload, r"High-confidence credential pattern \(bearer-token\)"),
            ("notes/env-backup.txt", owner_tok_payload, r"High-confidence credential pattern \(dokitool-token\)"),
            ("notes/api-env.txt", api_tok_payload, r"High-confidence credential pattern \(dokitool-token\)"),
        ]
        for rel_path, text_content, err_pattern in cases:
            with self.subTest(rel_path=rel_path, err_pattern=err_pattern):
                with tempfile.TemporaryDirectory() as tmp:
                    repo = Path(tmp)
                    self._init_repo(repo)
                    target = repo / rel_path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(text_content, encoding="utf-8")
                    _git(repo, "add", "-f", rel_path)
                    with self.assertRaisesRegex(ValueError, err_pattern):
                        cpf.run_check(["--staged"], root=repo)

        # CLI subprocess check for the exact review scenario (non-zero exit code).
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            target = repo / "ops/production-credentials.txt"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(private_key_payload, encoding="utf-8")
            _git(repo, "add", "-f", "ops/production-credentials.txt")
            # Copy script into temp repo to exercise the CLI entrypoint against repo root.
            (repo / "scripts").mkdir(parents=True, exist_ok=True)
            (repo / "scripts/check-public-files.py").write_text(
                SCRIPT_PATH.read_text(encoding="utf-8"), encoding="utf-8"
            )
            _git(repo, "add", "scripts/check-public-files.py")
            proc = subprocess.run(
                [sys.executable, "-B", str(repo / "scripts/check-public-files.py"), "--staged"],
                cwd=repo,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("Public file guard failed:", proc.stderr)

    def test_example_templates_placeholders_and_binaries_have_zero_false_positives(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._init_repo(repo)
            (repo / "ops/examples").mkdir(parents=True)
            (repo / "ops/examples/credentials.example.json").write_text(
                '{"token": "<your-token-from-secret-store>"}\n', encoding="utf-8"
            )
            (repo / "docs").mkdir(parents=True)
            (repo / "docs/auth.md").write_text(
                "Authorization: Bearer <token>\n"
                "Authorization: Bearer $DOKITOOL_API_TOKEN\n"
                "Authorization: Bearer EXAMPLE_TOKEN_VALUE_1234567890123456\n"
                "Authorization: Bearer REDACTED_TOKEN_VALUE_1234567890123456\n"
                "DOKITOOL_OWNER_TOKEN=<your-owner-token-from-secret-store>\n"
                "DOKITOOL_API_TOKEN=$DOKITOOL_API_TOKEN\n"
                "DOKITOOL_OWNER_TOKEN=example_owner_token_value_123456\n"
                "DOKITOOL_API_TOKEN=test_fixture_token_1234567890\n",
                encoding="utf-8",
            )
            # Binary file with NUL bytes is skipped cleanly by UTF-8 content scan.
            (repo / "src/logo.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
            _git(repo, "add", "ops/examples/credentials.example.json", "docs/auth.md", "src/logo.png")
            self.assertEqual(cpf.run_check(["--staged"], root=repo), 0)


if __name__ == "__main__":
    unittest.main()
