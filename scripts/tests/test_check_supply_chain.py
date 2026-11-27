"""Controlled-failure regression tests for scripts/check-supply-chain.py."""
from __future__ import annotations

import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from typing import Any, Dict, List, Optional, Sequence
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = ROOT / "scripts/check-supply-chain.py"

spec = importlib.util.spec_from_file_location("check_supply_chain", SCRIPT_PATH)
assert spec is not None and spec.loader is not None
csc = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = csc
spec.loader.exec_module(csc)

VALID_SHA512 = "sha512-" + ("A" * 86) + "=="
VALID_ACTION_SHA = "d23441a48e516b6c34aea4fa41551a30e30af803"
VALID_DOCKER_DIGEST = "0123456789abcdef" * 4


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def _create_valid_fixture_repo(
    repo: Path,
    *,
    npm_packages: Optional[Dict[str, Any]] = None,
    gomod_text: Optional[str] = None,
    gosum_text: Optional[str] = None,
    workflow_text: Optional[str] = None,
    exceptions: Optional[Any] = None,
) -> None:
    if npm_packages is None:
        npm_packages = {
            "": {"name": "fixture-web", "version": "1.0.0"},
            "node_modules/vue": {
                "version": "3.4.0",
                "resolved": "https://registry.npmjs.org/vue/-/vue-3.4.0.tgz",
                "integrity": VALID_SHA512,
            },
            "node_modules/pinia": {
                "version": "2.1.0",
                "resolved": "https://registry.npmmirror.com/pinia/-/pinia-2.1.0.tgz",
                "integrity": VALID_SHA512,
            },
        }
    lock_payload = {
        "name": "fixture-web",
        "version": "1.0.0",
        "lockfileVersion": 3,
        "requires": True,
        "packages": npm_packages,
    }
    _write_text(repo / "frontend/package-lock.json", json.dumps(lock_payload, indent=2) + "\n")

    if gomod_text is None:
        gomod_text = (
            "module github.com/example/fixture/backend\n\n"
            "go 1.27.0\n\n"
            "toolchain go1.27.3\n\n"
            "require golang.org/x/net v0.59.0\n"
        )
    if gosum_text is None:
        gosum_text = (
            "golang.org/x/net v0.59.0 h1:5zfYln+w5XCxwrnMMJPufRgNoXEaGxl0wo5GqPXyues=\n"
            "golang.org/x/net v0.59.0/go.mod h1:2DA/G1UfVbCpQPeWTmMPGY7Cs2PkBkwu743bVX5PIVg=\n"
        )
    _write_text(repo / "backend/go.mod", gomod_text)
    _write_text(repo / "backend/go.sum", gosum_text)

    if workflow_text is None:
        workflow_text = (
            "name: CI\n"
            "on: [pull_request]\n"
            "jobs:\n"
            "  build:\n"
            "    runs-on: ubuntu-24.04\n"
            "    steps:\n"
            f"      - uses: actions/checkout@{VALID_ACTION_SHA} # v6\n"
            "      - name: Inline script mentioning uses safely\n"
            "        run: |\n"
            "          echo 'uses: actions/checkout@v4'\n"
            "      - uses: ./local-action\n"
            f"      - uses: docker://alpine@sha256:{VALID_DOCKER_DIGEST}\n"
        )
    _write_text(repo / ".github/workflows/ci.yml", workflow_text)

    exc_payload = [] if exceptions is None else exceptions
    _write_text(
        repo / "scripts/supply-chain-exceptions.json",
        json.dumps(exc_payload, indent=2) + "\n",
    )


def _sample_npm_audit_vuln_json(
    *,
    pkg: str = "jszip",
    ghsa: str = "GHSA-1111-2222-3333",
    severity: str = "high",
    include_transitive_parent: bool = True,
) -> str:
    vulns: Dict[str, Any] = {
        pkg: {
            "name": pkg,
            "severity": severity,
            "isDirect": True,
            "via": [
                {
                    "source": 1109999,
                    "name": pkg,
                    "dependency": pkg,
                    "title": f"Simulated {severity} issue in {pkg}",
                    "url": f"https://github.com/advisories/{ghsa}",
                    "severity": severity,
                }
            ],
            "effects": ["parent-wrapper"] if include_transitive_parent else [],
        }
    }
    if include_transitive_parent:
        vulns["parent-wrapper"] = {
            "name": "parent-wrapper",
            "severity": severity,
            "isDirect": True,
            "via": [pkg],
            "effects": [],
        }
    return json.dumps(
        {
            "auditReportVersion": 2,
            "vulnerabilities": vulns,
            "metadata": {
                "vulnerabilities": {
                    "info": 0,
                    "low": 0,
                    "moderate": 0,
                    "high": 1 if severity == "high" else 0,
                    "critical": 1 if severity == "critical" else 0,
                    "total": 1,
                }
            },
        }
    )


def _sample_npm_audit_clean_json() -> str:
    return json.dumps(
        {
            "auditReportVersion": 2,
            "vulnerabilities": {},
            "metadata": {
                "vulnerabilities": {
                    "info": 0,
                    "low": 0,
                    "moderate": 0,
                    "high": 0,
                    "critical": 0,
                    "total": 0,
                }
            },
        }
    )


def _sample_govulncheck_stream(
    *,
    osv_id: Optional[str] = None,
    cve: str = "CVE-2026-99999",
    module: str = "golang.org/x/net",
    pkg: str = "golang.org/x/net/http2",
    called: bool = True,
) -> str:
    chunks: List[Dict[str, Any]] = [
        {
            "config": {
                "protocol_version": "v1.0.0",
                "scanner_name": "govulncheck",
                "scanner_version": "v1.1.4",
                "scan_level": "symbol",
            }
        },
        {"progress": {"message": "Scanning your code and packages..."}},
    ]
    if osv_id is not None:
        chunks.append(
            {
                "osv": {
                    "id": osv_id,
                    "aliases": [cve],
                    "summary": f"Simulated Go vulnerability in {pkg}",
                    "affected": [{"package": {"ecosystem": "Go", "name": module}}],
                }
            }
        )
        # Always include module-level finding (real govulncheck emits this too)
        chunks.append(
            {
                "finding": {
                    "osv": osv_id,
                    "fixed_version": "v0.60.0",
                    "trace": [{"module": module, "version": "v0.59.0"}],
                }
            }
        )
        if called:
            chunks.append(
                {
                    "finding": {
                        "osv": osv_id,
                        "fixed_version": "v0.60.0",
                        "trace": [
                            {
                                "module": module,
                                "version": "v0.59.0",
                                "package": pkg,
                                "function": "ServeConn",
                            },
                            {
                                "module": "github.com/example/fixture/backend",
                                "package": "github.com/example/fixture/backend/cmd/app",
                                "function": "main",
                            },
                        ],
                    }
                }
            )
    return "\n".join(json.dumps(obj, indent=2) for obj in chunks) + "\n"


class CheckSupplyChainOfflineTests(unittest.TestCase):
    def test_real_repo_passes_offline_via_cli(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-B", str(SCRIPT_PATH), "--offline", "--repo-root", str(ROOT)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, msg=proc.stderr)
        self.assertIn("Supply-chain offline check PASSED", proc.stdout)

    def test_real_repo_exceptions_ledger_valid_schema_and_unexpired(self) -> None:
        entries, violations = csc.load_exceptions(
            ROOT / "scripts/supply-chain-exceptions.json",
            csc.utc_today(),
        )
        self.assertEqual(violations, (), msg=violations)
        for entry in entries:
            self.assertGreaterEqual(entry.expires_on, csc.utc_today())
            self.assertTrue(entry.id)
            self.assertTrue(entry.package)
            self.assertTrue(entry.reason)

    def test_cli_requires_mode_flag(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-B", str(SCRIPT_PATH), "--repo-root", str(ROOT)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(proc.returncode, 0)

    def test_clean_fixture_passes_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(repo)
            res = csc.check_offline(repo, today=datetime.date(2026, 11, 26))
            self.assertTrue(res.passed, msg=res.violations)
            self.assertEqual(res.npm_packages_checked, 2)
            self.assertEqual(res.workflow_files_checked, 1)
            self.assertEqual(res.workflow_uses_checked, 3)

    def test_missing_integrity_in_package_lock_fails_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                npm_packages={
                    "": {"name": "fixture-web", "version": "1.0.0"},
                    "node_modules/missing-hash": {
                        "version": "1.0.0",
                        "resolved": "https://registry.npmjs.org/missing-hash/-/missing-hash-1.0.0.tgz",
                    },
                },
            )
            res = csc.check_offline(repo, today=datetime.date(2026, 11, 26))
            self.assertFalse(res.passed)
            self.assertTrue(
                any("npm-lock-integrity" in v and "missing-hash" in v for v in res.violations),
                msg=res.violations,
            )

    def test_weak_sha1_integrity_in_package_lock_fails_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                npm_packages={
                    "": {"name": "fixture-web", "version": "1.0.0"},
                    "node_modules/legacy-sha1": {
                        "version": "1.0.0",
                        "resolved": "https://registry.npmjs.org/legacy-sha1/-/legacy-sha1-1.0.0.tgz",
                        "integrity": "sha1-" + ("A" * 27) + "=",
                    },
                },
            )
            res = csc.check_offline(repo, today=datetime.date(2026, 11, 26))
            self.assertFalse(res.passed)
            self.assertTrue(
                any("npm-lock-integrity" in v and "legacy-sha1" in v for v in res.violations),
                msg=res.violations,
            )

    def test_forbidden_resolved_urls_in_package_lock_fail_offline(self) -> None:
        bad_urls = [
            "git+https://github.com/evil/pkg.git#main",
            "http://registry.npmjs.org/foo/-/foo-1.0.0.tgz",
            "file:../local-pkg",
            "https://evil.example.com/pkg/-/pkg-1.0.0.tgz",
            "https://registry.npmjs.org/pkg/latest",
        ]
        for bad_url in bad_urls:
            with self.subTest(bad_url=bad_url):
                with tempfile.TemporaryDirectory() as tmp:
                    repo = Path(tmp)
                    _create_valid_fixture_repo(
                        repo,
                        npm_packages={
                            "": {"name": "fixture-web", "version": "1.0.0"},
                            "node_modules/bad-dep": {
                                "version": "1.0.0",
                                "resolved": bad_url,
                                "integrity": VALID_SHA512,
                            },
                        },
                    )
                    proc = subprocess.run(
                        [
                            sys.executable,
                            "-B",
                            str(SCRIPT_PATH),
                            "--offline",
                            "--repo-root",
                            str(repo),
                            "--today",
                            "2026-11-26",
                        ],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(proc.returncode, 1, msg=f"expected failure for {bad_url}")
                    self.assertIn("npm-lock-resolved", proc.stderr)

    def test_floating_action_tags_fail_offline(self) -> None:
        floating_refs = [
            "actions/checkout@v4",
            "actions/setup-go@main",
            "actions/setup-node@master",
            "docker://alpine:latest",
        ]
        for bad_ref in floating_refs:
            with self.subTest(bad_ref=bad_ref):
                with tempfile.TemporaryDirectory() as tmp:
                    repo = Path(tmp)
                    _create_valid_fixture_repo(
                        repo,
                        workflow_text=(
                            "name: Bad\n"
                            "on: [push]\n"
                            "jobs:\n"
                            "  test:\n"
                            "    runs-on: ubuntu-24.04\n"
                            "    steps:\n"
                            f"      - uses: {bad_ref}\n"
                        ),
                    )
                    proc = subprocess.run(
                        [
                            sys.executable,
                            "-B",
                            str(SCRIPT_PATH),
                            "--offline",
                            "--repo-root",
                            str(repo),
                            "--today",
                            "2026-11-26",
                        ],
                        capture_output=True,
                        text=True,
                        check=False,
                    )
                    self.assertEqual(proc.returncode, 1, msg=f"expected failure for {bad_ref}")
                    self.assertIn("workflow-unpinned", proc.stderr)

    def test_go_mod_local_replace_and_unpinned_toolchain_fail_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                gomod_text=(
                    "module github.com/example/fixture/backend\n\n"
                    "go 1.27.0\n\n"
                    "toolchain default\n\n"
                    "replace golang.org/x/net => ../local-net\n"
                ),
            )
            res = csc.check_offline(repo, today=datetime.date(2026, 11, 26))
            self.assertFalse(res.passed)
            self.assertTrue(any("go-mod-toolchain" in v for v in res.violations), msg=res.violations)
            self.assertTrue(
                any("go-mod-local-replace" in v for v in res.violations),
                msg=res.violations,
            )

    def test_expired_and_malformed_exceptions_fail_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                exceptions=[
                    {
                        "id": "CVE-2026-10001",
                        "package": "jszip",
                        "reason": "Temporary wait for upstream patch",
                        "expires_on": "2026-11-25",
                    }
                ],
            )
            res = csc.check_offline(repo, today=datetime.date(2026, 11, 26))
            self.assertFalse(res.passed)
            self.assertTrue(any("exceptions-expired" in v for v in res.violations), msg=res.violations)

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                exceptions=[{"id": "CVE-2026-10001", "package": "jszip"}],
            )
            res = csc.check_offline(repo, today=datetime.date(2026, 11, 26))
            self.assertFalse(res.passed)
            self.assertTrue(any("exceptions-schema" in v for v in res.violations), msg=res.violations)


class CheckSupplyChainOnlineVulnTests(unittest.TestCase):
    def _make_runner(
        self,
        *,
        npm_result: csc.CommandResult,
        go_result: csc.CommandResult,
    ) -> csc.CommandRunner:
        def _runner(cmd: Sequence[str], cwd: Path) -> csc.CommandResult:
            del cwd
            exe = cmd[0]
            if exe == "npm":
                return npm_result
            if exe == "govulncheck":
                return go_result
            raise AssertionError(f"unexpected command: {cmd}")

        return _runner

    def test_unexempted_npm_and_go_vulns_fail_online_vuln(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(repo, exceptions=[])
            runner = self._make_runner(
                npm_result=csc.CommandResult(
                    returncode=1,
                    stdout=_sample_npm_audit_vuln_json(
                        pkg="jszip", ghsa="GHSA-1111-2222-3333", severity="critical"
                    ),
                    stderr="",
                ),
                go_result=csc.CommandResult(
                    returncode=0,
                    stdout=_sample_govulncheck_stream(
                        osv_id="GO-2026-4242",
                        cve="CVE-2026-99999",
                        module="golang.org/x/net",
                        called=True,
                    ),
                    stderr="",
                ),
            )
            res = csc.check_online_vuln(
                repo,
                today=datetime.date(2026, 11, 26),
                runner=runner,
            )
            self.assertFalse(res.passed)
            self.assertEqual(len(res.unexempted_findings), 2)
            self.assertTrue(any("GHSA-1111-2222-3333" in v for v in res.violations), msg=res.violations)
            self.assertTrue(any("GO-2026-4242" in v for v in res.violations), msg=res.violations)

    def test_expired_exception_fails_online_vuln(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                exceptions=[
                    {
                        "id": "CVE-2026-99999",
                        "package": "golang.org/x/net",
                        "reason": "Waiting on upstream release",
                        "expires_on": "2026-11-20",
                    }
                ],
            )
            runner = self._make_runner(
                npm_result=csc.CommandResult(returncode=0, stdout=_sample_npm_audit_clean_json(), stderr=""),
                go_result=csc.CommandResult(
                    returncode=0,
                    stdout=_sample_govulncheck_stream(
                        osv_id="GO-2026-4242",
                        cve="CVE-2026-99999",
                        module="golang.org/x/net",
                        called=True,
                    ),
                    stderr="",
                ),
            )
            res = csc.check_online_vuln(
                repo,
                today=datetime.date(2026, 11, 26),
                runner=runner,
            )
            self.assertFalse(res.passed)
            self.assertTrue(any("exceptions-expired" in v for v in res.violations), msg=res.violations)

    def test_valid_unexpired_exceptions_pass_and_emit_audit_summary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                exceptions=[
                    {
                        "id": "GHSA-1111-2222-3333",
                        "package": "jszip",
                        "reason": "Browser-only archive generation unaffected by path traversal vector",
                        "expires_on": "2026-12-31",
                        "ecosystem": "npm",
                    },
                    {
                        "id": "CVE-2026-99999",
                        "package": "golang.org/x/net",
                        "reason": "Fix pending next tls-client bump",
                        "expires_on": "2026-11-26",
                        "ecosystem": "go",
                    },
                ],
            )
            runner = self._make_runner(
                npm_result=csc.CommandResult(
                    returncode=1,
                    stdout=_sample_npm_audit_vuln_json(
                        pkg="jszip",
                        ghsa="GHSA-1111-2222-3333",
                        severity="high",
                        include_transitive_parent=True,
                    ),
                    stderr="",
                ),
                go_result=csc.CommandResult(
                    returncode=0,
                    stdout=_sample_govulncheck_stream(
                        osv_id="GO-2026-4242",
                        cve="CVE-2026-99999",
                        module="golang.org/x/net",
                        called=True,
                    ),
                    stderr="",
                ),
            )
            res = csc.check_online_vuln(
                repo,
                today=datetime.date(2026, 11, 26),
                runner=runner,
            )
            self.assertTrue(res.passed, msg=res.violations)
            self.assertEqual(len(res.unexempted_findings), 0)
            self.assertEqual(len(res.exempted_findings), 2)
            self.assertTrue(
                any("EXEMPTED [npm]" in n and "GHSA-1111-2222-3333" in n and "jszip" in n for n in res.notices),
                msg=res.notices,
            )
            self.assertTrue(
                any("EXEMPTED [go]" in n and "GO-2026-4242" in n and "CVE-2026-99999" in n for n in res.notices),
                msg=res.notices,
            )

    def test_exception_wrong_package_does_not_exempt_finding(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                exceptions=[
                    {
                        "id": "GHSA-1111-2222-3333",
                        "package": "unrelated-pkg",
                        "reason": "Should not match jszip",
                        "expires_on": "2026-12-31",
                    }
                ],
            )
            runner = self._make_runner(
                npm_result=csc.CommandResult(
                    returncode=1,
                    stdout=_sample_npm_audit_vuln_json(pkg="jszip", ghsa="GHSA-1111-2222-3333"),
                    stderr="",
                ),
                go_result=csc.CommandResult(
                    returncode=0,
                    stdout=_sample_govulncheck_stream(osv_id=None),
                    stderr="",
                ),
            )
            res = csc.check_online_vuln(
                repo,
                today=datetime.date(2026, 11, 26),
                runner=runner,
            )
            self.assertFalse(res.passed)
            self.assertEqual(len(res.unexempted_findings), 1)

    def test_scanner_errors_and_missing_govulncheck_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(repo, exceptions=[])

            def _missing_govulncheck(cmd: Sequence[str], cwd: Path) -> csc.CommandResult:
                del cwd
                if cmd[0] == "npm":
                    return csc.CommandResult(
                        returncode=1,
                        stdout=json.dumps({"error": {"code": "ENOAUDIT", "summary": "registry offline"}}),
                        stderr="",
                    )
                raise FileNotFoundError("govulncheck not found")

            res = csc.check_online_vuln(
                repo,
                today=datetime.date(2026, 11, 26),
                runner=_missing_govulncheck,
            )
            self.assertFalse(res.passed)
            self.assertTrue(any("npm-audit-error" in v for v in res.violations), msg=res.violations)
            self.assertTrue(
                any("govulncheck-exec-error" in v for v in res.violations),
                msg=res.violations,
            )

    def test_govulncheck_uncalled_symbol_is_informational_not_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(repo, exceptions=[])
            runner = self._make_runner(
                npm_result=csc.CommandResult(returncode=0, stdout=_sample_npm_audit_clean_json(), stderr=""),
                go_result=csc.CommandResult(
                    returncode=0,
                    stdout=_sample_govulncheck_stream(
                        osv_id="GO-2026-7777",
                        cve="CVE-2026-77777",
                        module="golang.org/x/net",
                        called=False,
                    ),
                    stderr="",
                ),
            )
            res = csc.check_online_vuln(
                repo,
                today=datetime.date(2026, 11, 26),
                runner=runner,
            )
            self.assertTrue(res.passed, msg=res.violations)
            self.assertEqual(res.go_findings_total, 0)
            self.assertTrue(any("GO-2026-7777" in n for n in res.notices), msg=res.notices)

    def test_main_online_vuln_prints_audit_summary_for_valid_exception(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                exceptions=[
                    {
                        "id": "GHSA-1111-2222-3333",
                        "package": "jszip",
                        "reason": "Tracked mitigation in progress",
                        "expires_on": "2026-12-31",
                    }
                ],
            )
            runner = self._make_runner(
                npm_result=csc.CommandResult(
                    returncode=1,
                    stdout=_sample_npm_audit_vuln_json(pkg="jszip", ghsa="GHSA-1111-2222-3333"),
                    stderr="",
                ),
                go_result=csc.CommandResult(
                    returncode=0,
                    stdout=_sample_govulncheck_stream(osv_id=None),
                    stderr="",
                ),
            )
            stdout_buf = io.StringIO()
            stderr_buf = io.StringIO()
            with mock.patch.object(csc, "default_command_runner", runner):
                with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                    rc = csc.main(
                        [
                            "--online-vuln",
                            "--repo-root",
                            str(repo),
                            "--today",
                            "2026-11-26",
                        ]
                    )
            self.assertEqual(rc, 0, msg=stderr_buf.getvalue())
            out = stdout_buf.getvalue()
            self.assertIn("AUDIT: EXEMPTED [npm]", out)
            self.assertIn("GHSA-1111-2222-3333", out)
            self.assertIn("Supply-chain online-vuln check PASSED", out)

    def test_npm_moderate_only_vuln_passes_when_audit_level_high(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(repo, exceptions=[])
            moderate_json = json.dumps(
                {
                    "auditReportVersion": 2,
                    "vulnerabilities": {
                        "minor-pkg": {
                            "name": "minor-pkg",
                            "severity": "moderate",
                            "via": [
                                {
                                    "source": 999999,
                                    "name": "minor-pkg",
                                    "title": "Moderate advisory",
                                    "url": "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
                                    "severity": "moderate",
                                }
                            ],
                        }
                    },
                    "metadata": {
                        "vulnerabilities": {
                            "info": 0,
                            "low": 0,
                            "moderate": 1,
                            "high": 0,
                            "critical": 0,
                            "total": 1,
                        }
                    },
                }
            )
            runner = self._make_runner(
                npm_result=csc.CommandResult(returncode=0, stdout=moderate_json, stderr=""),
                go_result=csc.CommandResult(
                    returncode=0,
                    stdout=_sample_govulncheck_stream(osv_id=None),
                    stderr="",
                ),
            )
            res = csc.check_online_vuln(repo, today=datetime.date(2026, 11, 26), runner=runner)
            self.assertTrue(res.passed, msg=res.violations)
            self.assertEqual(res.npm_findings_total, 0)

    def test_go_mod_replace_block_without_space_fails_offline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            _create_valid_fixture_repo(
                repo,
                gomod_text=(
                    "module github.com/example/fixture/backend\n\n"
                    "go 1.27.0\n\n"
                    "toolchain go1.27.3\n\n"
                    "replace(\n"
                    "\tgolang.org/x/net => ./vendored-net\n"
                    ")\n"
                ),
            )
            res = csc.check_offline(repo, today=datetime.date(2026, 11, 26))
            self.assertFalse(res.passed)
            self.assertTrue(
                any("go-mod-local-replace" in v for v in res.violations),
                msg=res.violations,
            )


if __name__ == "__main__":
    unittest.main()
