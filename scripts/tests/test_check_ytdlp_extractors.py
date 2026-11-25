"""Unit tests for scripts/check-ytdlp-extractors.py."""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts/check-ytdlp-extractors.py"

spec = importlib.util.spec_from_file_location("check_ytdlp_extractors", SCRIPT_PATH)
assert spec is not None and spec.loader is not None
cye = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cye
spec.loader.exec_module(cye)


def _write_parser(repo: Path, body: str) -> Path:
    parser_path = repo / "backend/internal/platform/x/parser.go"
    parser_path.parent.mkdir(parents=True, exist_ok=True)
    with parser_path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(body)
    return parser_path


def _write_text_lf(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


SAMPLE_YTDLP_EXTRACTORS = "\n".join(
    [
        "generic",
        "youtube",
        "twitcasting",
        "twitter",
        "twitter:amplify",
        "twitter:broadcast",
        "twitter:card",
        "twitter:event",
        "twitter:shortener",
        "twitter:spaces",
        "vimeo",
    ]
) + "\n"


class CheckYtdlpExtractorsTests(unittest.TestCase):
    def test_live_repo_parser_matches_pinned_twitter_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            extractors_file = Path(tmp) / "extractors.txt"
            _write_text_lf(extractors_file, SAMPLE_YTDLP_EXTRACTORS)

            proc = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_PATH),
                    "--root",
                    str(ROOT),
                    "--extractors-file",
                    str(extractors_file),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            self.assertIn("PASSED", proc.stdout)
            self.assertIn("allowed=5, excluded=2, ytdlp_twitter=7", proc.stdout)

    def test_case_insensitive_and_currently_broken_suffix_stripped(self) -> None:
        lines = [
            "YouTube",
            "Twitter",
            "TWITTER:AMPLIFY",
            "twitter:broadcast (CURRENTLY BROKEN)",
            "twitter:card",
            "Twitter:Event (currently broken)",
            "twitter:shortener",
            "twitter:spaces (CURRENTLY BROKEN)",
            "twitcasting:live",
        ]
        res = cye.check_ytdlp_extractors(root=ROOT, extractor_lines=lines)
        self.assertTrue(res.passed, msg=res.errors)
        self.assertEqual(len(res.ytdlp_twitter), 7)
        self.assertIn("twitter:broadcast", res.ytdlp_twitter)
        self.assertIn("twitter:event", res.ytdlp_twitter)
        self.assertIn("twitter:spaces", res.ytdlp_twitter)

    def test_unclassified_new_twitter_extractor_fails(self) -> None:
        lines = SAMPLE_YTDLP_EXTRACTORS.splitlines() + ["twitter:community"]
        res = cye.check_ytdlp_extractors(root=ROOT, extractor_lines=lines)
        self.assertFalse(res.passed)
        self.assertTrue(
            any("unclassified" in err and "twitter:community" in err for err in res.errors),
            msg=res.errors,
        )

    def test_stale_go_extractor_fails(self) -> None:
        lines = [
            line
            for line in SAMPLE_YTDLP_EXTRACTORS.splitlines()
            if line != "twitter:event"
        ]
        res = cye.check_ytdlp_extractors(root=ROOT, extractor_lines=lines)
        self.assertFalse(res.passed)
        self.assertTrue(
            any("stale" in err and "twitter:event" in err for err in res.errors),
            msg=res.errors,
        )

    def test_overlap_between_allowed_and_excluded_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _write_parser(
                repo,
                """package x
func AllowedExtractors() []string {
\treturn []string{
\t\t"twitter",
\t\t"twitter:event",
\t}
}
func ExcludedExtractors() []string {
\treturn []string{
\t\t"twitter:event",
\t\t"twitter:shortener",
\t}
}
""",
            )
            res = cye.check_ytdlp_extractors(
                root=repo,
                extractor_lines=["twitter", "twitter:event", "twitter:shortener"],
            )
            self.assertFalse(res.passed)
            self.assertTrue(
                any("overlap" in err and "twitter:event" in err for err in res.errors),
                msg=res.errors,
            )

    def test_comments_in_go_parser_do_not_pollute_extractor_lists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _write_parser(
                repo,
                """package x
// Mention "twitter:commented" in doc comment.
func AllowedExtractors() []string {
\t/* Block comment with "twitter:fake" inside */
\treturn []string{
\t\t"twitter", // inline "twitter:ignored"
\t}
}
func ExcludedExtractors() []string {
\treturn []string{
\t\t"twitter:event",
\t\t"twitter:shortener",
\t}
}
""",
            )
            res = cye.check_ytdlp_extractors(
                root=repo,
                extractor_lines=["twitter", "twitter:event", "twitter:shortener"],
            )
            self.assertTrue(res.passed, msg=res.errors)
            self.assertEqual(res.allowed, ("twitter",))
            self.assertEqual(res.excluded, ("twitter:event", "twitter:shortener"))

    def test_missing_excluded_function_or_empty_ytdlp_output_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _write_parser(
                repo,
                """package x
func AllowedExtractors() []string {
\treturn []string{"twitter"}
}
""",
            )
            res_missing = cye.check_ytdlp_extractors(
                root=repo,
                extractor_lines=["twitter"],
            )
            self.assertFalse(res_missing.passed)
            self.assertTrue(
                any("ExcludedExtractors" in err for err in res_missing.errors),
                msg=res_missing.errors,
            )

        res_empty = cye.check_ytdlp_extractors(root=ROOT, extractor_lines=["youtube", "vimeo"])
        self.assertFalse(res_empty.passed)
        self.assertTrue(
            any("zero `twitter*` extractors" in err for err in res_empty.errors),
            msg=res_empty.errors,
        )

    def test_cli_ytdlp_binary_mode_pass_and_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            fake_ok = tmp_dir / "fake-ytdlp-ok.py"
            _write_text_lf(
                fake_ok,
                f"#!{sys.executable}\n"
                "import sys\n"
                "assert sys.argv[1:] == ['--list-extractors'], sys.argv\n"
                f"sys.stdout.write({SAMPLE_YTDLP_EXTRACTORS!r})\n",
            )
            os.chmod(fake_ok, stat.S_IRWXU)

            proc_ok = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_PATH),
                    "--root",
                    str(ROOT),
                    "--ytdlp",
                    str(fake_ok),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc_ok.returncode, 0, msg=proc_ok.stderr)
            self.assertIn("PASSED", proc_ok.stdout)

            fake_fail = tmp_dir / "fake-ytdlp-fail.py"
            _write_text_lf(
                fake_fail,
                f"#!{sys.executable}\n"
                "import sys\n"
                "sys.stderr.write('boom extractor failure\\n')\n"
                "raise SystemExit(2)\n",
            )
            os.chmod(fake_fail, stat.S_IRWXU)

            proc_fail = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_PATH),
                    "--root",
                    str(ROOT),
                    "--ytdlp",
                    str(fake_fail),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc_fail.returncode, 1)
            self.assertIn("boom extractor failure", proc_fail.stderr)

            proc_missing = subprocess.run(
                [
                    sys.executable,
                    "-B",
                    str(SCRIPT_PATH),
                    "--root",
                    str(ROOT),
                    "--ytdlp",
                    str(tmp_dir / "nonexistent-ytdlp"),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(proc_missing.returncode, 1)
            self.assertIn("not found", proc_missing.stderr)


if __name__ == "__main__":
    unittest.main()
