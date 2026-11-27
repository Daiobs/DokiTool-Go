"""Regression tests for root Makefile targets (R78-01..R78-03)."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest


REPO_ROOT = Path(__file__).resolve().parents[2]
MAKEFILE = REPO_ROOT / "Makefile"


def _pid_alive(pid: int) -> bool:
    """Return True if pid exists and is not a zombie."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    res = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)],
        capture_output=True,
        text=True,
        check=False,
    )
    stat = res.stdout.strip()
    return bool(stat) and not stat.startswith("Z")


def _wait_file_int(path: Path, timeout: float = 5.0) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if path.exists():
            raw = path.read_text(encoding="utf-8").strip()
            if raw.isdigit():
                return int(raw)
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for integer PID in {path}")


def _wait_pid_dead(pid: int, timeout: float = 4.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.05)
    return not _pid_alive(pid)


def _py_sleep_with_pidfile(pid_file: Path, *, spawn_grandchild: Path | None = None) -> str:
    if spawn_grandchild is not None:
        code = (
            "import os, subprocess, sys, time; "
            f"open({str(pid_file)!r}, 'w').write(str(os.getpid())); "
            "gc = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
            f"open({str(spawn_grandchild)!r}, 'w').write(str(gc.pid)); "
            "gc.wait()"
        )
    else:
        code = (
            "import os, time; "
            f"open({str(pid_file)!r}, 'w').write(str(os.getpid())); "
            "time.sleep(60)"
        )
    return f'{sys.executable} -c "{code}"'


def _py_wait_then_exit(marker_file: Path, exit_code: int) -> str:
    code = (
        "import os, sys, time; "
        f"p = {str(marker_file)!r}; d = time.monotonic() + 5.0; "
        "exec('while not os.path.exists(p) and time.monotonic() < d:\\n time.sleep(0.05)'); "
        f"sys.exit({exit_code})"
    )
    return f'{sys.executable} -c "{code}"'


@unittest.skipIf(os.name != "posix" or not shutil.which("make"), "POSIX make required")
class MakefileRegressionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp(prefix="dokitool-makefile-test-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_dev_terminates_peer_and_descendants_when_one_service_fails(self) -> None:
        peer_pid_file = self.tmpdir / "peer.pid"
        grandchild_pid_file = self.tmpdir / "grandchild.pid"
        frontend_cmd = _py_sleep_with_pidfile(
            peer_pid_file, spawn_grandchild=grandchild_pid_file
        )
        backend_cmd = _py_wait_then_exit(grandchild_pid_file, 7)

        # Spawn a sibling in the caller's process group to prove `make dev` never invokes `kill 0`.
        sibling = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
        )
        try:
            proc = subprocess.run(
                [
                    "make",
                    "-f",
                    str(MAKEFILE),
                    "dev",
                    f"DEV_BACKEND_CMD={backend_cmd}",
                    f"DEV_FRONTEND_CMD={frontend_cmd}",
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                timeout=15,
            )
            self.assertNotEqual(
                proc.returncode,
                0,
                f"make dev must fail non-zero when a service fails: {proc.stderr}",
            )
            peer_pid = _wait_file_int(peer_pid_file, timeout=1.0)
            grandchild_pid = _wait_file_int(grandchild_pid_file, timeout=1.0)
            self.assertTrue(_wait_pid_dead(peer_pid), f"peer PID {peer_pid} survived")
            self.assertTrue(
                _wait_pid_dead(grandchild_pid),
                f"grandchild PID {grandchild_pid} survived",
            )
            self.assertIsNone(
                sibling.poll(),
                "sibling process in caller pgid must NOT be killed (no kill 0)",
            )
        finally:
            if sibling.poll() is None:
                sibling.terminate()
                try:
                    sibling.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    sibling.kill()
                    sibling.wait(timeout=3)

    def test_dev_exits_nonzero_and_cleans_up_even_when_peer_exits_zero(self) -> None:
        backend_pid_file = self.tmpdir / "backend.pid"
        backend_cmd = _py_sleep_with_pidfile(backend_pid_file)
        frontend_cmd = _py_wait_then_exit(backend_pid_file, 0)
        proc = subprocess.run(
            [
                "make",
                "-f",
                str(MAKEFILE),
                "dev",
                f"DEV_BACKEND_CMD={backend_cmd}",
                f"DEV_FRONTEND_CMD={frontend_cmd}",
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertNotEqual(
            proc.returncode,
            0,
            "unexpected early exit(0) of a dev service must return non-zero",
        )
        backend_pid = _wait_file_int(backend_pid_file, timeout=1.0)
        self.assertTrue(_wait_pid_dead(backend_pid), f"backend PID {backend_pid} survived")

    def test_dev_handles_sigint_sigterm_and_duplicate_signals_without_recursion(self) -> None:
        # Test both direct SIGTERM to `make` (only `make` receives it, proving our trap
        # and cleanup actually terminate the child trees) and process-group SIGINT (Ctrl-C).
        scenarios = [
            ("SIGTERM_direct", signal.SIGTERM, False),
            ("SIGINT_pgroup", signal.SIGINT, True),
        ]
        for label, sig, use_pgroup in scenarios:
            with self.subTest(scenario=label):
                b_pid_file = self.tmpdir / f"b_{label}.pid"
                f_pid_file = self.tmpdir / f"f_{label}.pid"
                gc_pid_file = self.tmpdir / f"gc_{label}.pid"
                b_cmd = _py_sleep_with_pidfile(b_pid_file)
                f_cmd = _py_sleep_with_pidfile(f_pid_file, spawn_grandchild=gc_pid_file)
                proc = subprocess.Popen(
                    [
                        "make",
                        "-f",
                        str(MAKEFILE),
                        "dev",
                        f"DEV_BACKEND_CMD={b_cmd}",
                        f"DEV_FRONTEND_CMD={f_cmd}",
                    ],
                    cwd=REPO_ROOT,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    start_new_session=True,
                )
                try:
                    b_pid = _wait_file_int(b_pid_file)
                    f_pid = _wait_file_int(f_pid_file)
                    gc_pid = _wait_file_int(gc_pid_file)
                    # Deliver twice rapidly to verify cleared trap & idempotent cleanup.
                    if use_pgroup:
                        os.killpg(proc.pid, sig)
                        time.sleep(0.05)
                        try:
                            os.killpg(proc.pid, sig)
                        except ProcessLookupError:
                            pass
                    else:
                        proc.send_signal(sig)
                        time.sleep(0.05)
                        try:
                            proc.send_signal(sig)
                        except ProcessLookupError:
                            pass
                    rc = proc.wait(timeout=10)
                    self.assertNotEqual(rc, 0)
                    self.assertTrue(_wait_pid_dead(b_pid), f"backend PID {b_pid} survived {label}")
                    self.assertTrue(_wait_pid_dead(f_pid), f"frontend PID {f_pid} survived {label}")
                    self.assertTrue(_wait_pid_dead(gc_pid), f"grandchild PID {gc_pid} survived {label}")
                finally:
                    if proc.poll() is None:
                        os.killpg(proc.pid, signal.SIGKILL)
                        proc.wait(timeout=5)
                    if proc.stdout:
                        proc.stdout.close()
                    if proc.stderr:
                        proc.stderr.close()

    def test_check_fails_closed_without_jsonschema_by_default(self) -> None:
        # Block `import jsonschema` via PYTHONPATH so the test is deterministic even
        # when the host Python has jsonschema installed.
        site_dir = self.tmpdir / "no_jsonschema_site"
        site_dir.mkdir()
        (site_dir / "jsonschema.py").write_text(
            "raise ModuleNotFoundError('No module named jsonschema (blocked by test)')\n",
            encoding="utf-8",
        )
        wrapper = self.tmpdir / "python_no_jsonschema.sh"
        wrapper.write_text(
            f"#!/bin/sh\nPYTHONPATH={str(site_dir)!r}${{PYTHONPATH:+:$PYTHONPATH}} exec {sys.executable!r} \"$@\"\n",
            encoding="utf-8",
        )
        wrapper.chmod(0o755)

        proc = subprocess.run(
            ["make", "-f", str(MAKEFILE), "check", f"PYTHON={wrapper}"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertNotEqual(
            proc.returncode,
            0,
            "make check must fail closed when jsonschema is unavailable",
        )
        combined = proc.stdout + proc.stderr
        self.assertIn("jsonschema", combined)
        self.assertIn("PYTHON=", combined)
        self.assertIn("ALLOW_PARTIAL_SCHEMA=1", combined)

    def test_makefile_build_injects_commit_sha_version_and_notes_local_scope(self) -> None:
        content = MAKEFILE.read_text(encoding="utf-8")
        non_comment = "\n".join(
            line for line in content.splitlines() if not line.lstrip().startswith("#")
        )
        self.assertIn("VERSION ?= $(shell git rev-parse HEAD 2>/dev/null || echo dev)", non_comment)
        self.assertIn('-ldflags "-X main.version=$(VERSION)"', non_comment)
        self.assertIn("release-build.yml", content)
        self.assertNotIn("kill 0", non_comment)


if __name__ == "__main__":
    unittest.main()
