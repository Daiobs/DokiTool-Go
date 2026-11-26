#!/usr/bin/env python3
"""Dual-mode fail-closed supply-chain and vulnerability audit gate.

Modes:
  --offline      Deterministic, zero-network repository supply-chain audit:
                   1. frontend/package-lock.json: every non-root package entry
                      (excluding verified in-repo workspace links) MUST have
                      valid SRI integrity (sha512/sha384/sha256) and an
                      HTTPS resolved tarball URL on an allowed npm registry
                      (rejects git+, http://, file:, non-registry tarballs).
                   2. backend/go.mod & backend/go.sum: both exist and non-empty,
                      go.sum hashes well-formed, go.mod has pinned go/toolchain
                      versions and NO local/relative replace escapes.
                   3. .github/workflows/*.yml|*.yaml: every third-party `uses:`
                      reference MUST be pinned to a full 40-char lowercase hex
                      commit SHA (docker:// refs must pin @sha256:<64 hex>;
                      repo-local `./...` actions allowed).
                   4. scripts/supply-chain-exceptions.json: strict JSON array
                      schema with non-empty id/package/reason and valid ISO
                      date expires_on (YYYY-MM-DD); fails closed immediately if
                      any exception is expired (expires_on < today).

  --online-vuln  CI vulnerability scanner (fail-closed, never swallows errors):
                   1. Validates scripts/supply-chain-exceptions.json first.
                   2. Runs `npm --prefix frontend audit --omit=dev
                      --audit-level=high --json` and fails closed on tool
                      errors, invalid JSON, or any unexempted high/critical
                      production vulnerability.
                   3. Runs `govulncheck -json ./...` in `backend/` and fails
                      closed on missing binary, non-zero exit, malformed JSON
                      stream, or any unexempted reachable vulnerability.
                   4. Applies only valid, unexpired exceptions matching both
                      advisory ID (GHSA/CVE/GO/source) and affected package,
                      printing an explicit audit summary for every exemption.

Zero third-party dependencies (Python 3.9+ stdlib only).
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import datetime
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple
from urllib.parse import urlparse

DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXCEPTIONS_REL_PATH = Path("scripts/supply-chain-exceptions.json")
DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org"

ALLOWED_NPM_REGISTRY_HOSTS: Set[str] = {
    "registry.npmjs.org",
    "registry.npmmirror.com",
}

SRI_TOKEN_RE = re.compile(r"^sha(?:512|384|256)-[A-Za-z0-9+/]{16,}={0,2}$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
DOCKER_DIGEST_RE = re.compile(r"@sha256:[0-9a-f]{64}$")
GO_VERSION_RE = re.compile(r"^\d+\.\d+(?:\.\d+)?$")
GO_TOOLCHAIN_RE = re.compile(r"^go\d+\.\d+\.\d+$")
GOSUM_HASH_RE = re.compile(r"^h1:[A-Za-z0-9+/]{20,}={0,2}$")
GHSA_RE = re.compile(r"GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}", re.IGNORECASE)
CVE_RE = re.compile(r"CVE-\d{4}-\d{4,}", re.IGNORECASE)

BLOCK_SCALAR_HEADER_RE = re.compile(
    r"^(?P<indent>[ ]*)(?P<dash>-\s+)?[^:#\n]+:\s*[|>](?:[+-]\d?|\d[+-]?)?\s*(?:#.*)?$"
)
GOMOD_BLOCK_OPEN_RE = re.compile(r"^(require|replace|exclude|retract)\s*\((.*)$")
USES_LINE_RE = re.compile(r"^[ ]*(?:-\s+)?uses\s*:\s*(?P<value>.+?)\s*$")

REQUIRED_EXCEPTION_KEYS = frozenset({"id", "package", "reason", "expires_on"})
ALLOWED_EXCEPTION_KEYS = REQUIRED_EXCEPTION_KEYS | frozenset(
    {"ecosystem", "notes", "tracking_issue"}
)
ALLOWED_ECOSYSTEMS = frozenset({"npm", "go"})
HIGH_SEVERITIES = frozenset({"high", "critical"})
GOVULNCHECK_MESSAGE_KEYS = frozenset({"config", "progress", "osv", "finding", "sbom"})


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


CommandRunner = Callable[[Sequence[str], Path], CommandResult]


@dataclass(frozen=True)
class ExceptionEntry:
    id: str
    package: str
    reason: str
    expires_on: datetime.date
    ecosystem: Optional[str] = None
    notes: Optional[str] = None
    tracking_issue: Optional[str] = None


@dataclass(frozen=True)
class VulnFinding:
    ecosystem: str
    primary_id: str
    all_ids: Tuple[str, ...]
    package: str
    candidate_packages: Tuple[str, ...]
    severity: str
    title: str


@dataclass(frozen=True)
class ExemptedFinding:
    finding: VulnFinding
    exception: ExceptionEntry


@dataclass(frozen=True)
class OfflineCheckResult:
    passed: bool
    npm_packages_checked: int
    workflow_files_checked: int
    workflow_uses_checked: int
    exceptions_loaded: int
    violations: Tuple[str, ...]
    notices: Tuple[str, ...]


@dataclass(frozen=True)
class OnlineVulnResult:
    passed: bool
    npm_findings_total: int
    go_findings_total: int
    unexempted_findings: Tuple[VulnFinding, ...]
    exempted_findings: Tuple[ExemptedFinding, ...]
    violations: Tuple[str, ...]
    notices: Tuple[str, ...]


def parse_iso_date(raw: str, *, label: str = "date") -> datetime.date:
    if not isinstance(raw, str) or not ISO_DATE_RE.match(raw):
        raise ValueError(f"{label} must be an ISO date YYYY-MM-DD, got {raw!r}")
    try:
        return datetime.date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{label} is not a valid calendar date: {raw!r}") from exc


def utc_today() -> datetime.date:
    return datetime.datetime.now(datetime.timezone.utc).date()


def default_command_runner(cmd: Sequence[str], cwd: Path) -> CommandResult:
    proc = subprocess.run(
        list(cmd),
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=False,
    )
    return CommandResult(
        returncode=proc.returncode,
        stdout=proc.stdout,
        stderr=proc.stderr,
    )


def load_exceptions(
    exceptions_path: Path,
    today: datetime.date,
) -> Tuple[Tuple[ExceptionEntry, ...], Tuple[str, ...]]:
    violations: List[str] = []
    if not exceptions_path.is_file():
        return (
            (),
            (
                f"[exceptions-missing] required exceptions ledger not found: {exceptions_path}",
            ),
        )

    try:
        raw_text = exceptions_path.read_text(encoding="utf-8")
    except OSError as exc:
        return ((), (f"[exceptions-read-error] cannot read {exceptions_path}: {exc}",))

    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        return (
            (),
            (f"[exceptions-invalid-json] {exceptions_path}: {exc}",),
        )

    if not isinstance(payload, list):
        return (
            (),
            (
                f"[exceptions-schema] {exceptions_path} must be a JSON array "
                f"(expected [], got {type(payload).__name__})",
            ),
        )

    entries: List[ExceptionEntry] = []
    seen_keys: Set[Tuple[str, str, str]] = set()

    for idx, item in enumerate(payload):
        prefix = f"entry #{idx}"
        if not isinstance(item, dict):
            violations.append(
                f"[exceptions-schema] {prefix}: expected JSON object, got {type(item).__name__}"
            )
            continue

        unknown_keys = sorted(set(item.keys()) - ALLOWED_EXCEPTION_KEYS)
        if unknown_keys:
            violations.append(
                f"[exceptions-schema] {prefix}: unknown field(s): {', '.join(unknown_keys)}"
            )

        missing_keys = sorted(REQUIRED_EXCEPTION_KEYS - set(item.keys()))
        if missing_keys:
            violations.append(
                f"[exceptions-schema] {prefix}: missing required field(s): {', '.join(missing_keys)}"
            )
            continue

        entry_ok = True
        cleaned: Dict[str, str] = {}
        for field_name in ("id", "package", "reason", "expires_on"):
            val = item.get(field_name)
            if not isinstance(val, str) or not val.strip():
                violations.append(
                    f"[exceptions-schema] {prefix}: field {field_name!r} must be a non-empty string"
                )
                entry_ok = False
            else:
                cleaned[field_name] = val.strip()

        if not entry_ok:
            continue

        for no_ws_field in ("id", "package"):
            if any(ch.isspace() for ch in cleaned[no_ws_field]):
                violations.append(
                    f"[exceptions-schema] {prefix}: field {no_ws_field!r} must not contain whitespace: "
                    f"{cleaned[no_ws_field]!r}"
                )
                entry_ok = False

        ecosystem: Optional[str] = None
        if "ecosystem" in item:
            raw_eco = item["ecosystem"]
            if not isinstance(raw_eco, str) or raw_eco.strip().lower() not in ALLOWED_ECOSYSTEMS:
                violations.append(
                    f"[exceptions-schema] {prefix}: optional field 'ecosystem' must be one of "
                    f"{sorted(ALLOWED_ECOSYSTEMS)}, got {raw_eco!r}"
                )
                entry_ok = False
            else:
                ecosystem = raw_eco.strip().lower()

        notes: Optional[str] = None
        if "notes" in item:
            raw_notes = item["notes"]
            if not isinstance(raw_notes, str) or not raw_notes.strip():
                violations.append(
                    f"[exceptions-schema] {prefix}: optional field 'notes' must be a non-empty string"
                )
                entry_ok = False
            else:
                notes = raw_notes.strip()

        tracking_issue: Optional[str] = None
        if "tracking_issue" in item:
            raw_issue = item["tracking_issue"]
            if not isinstance(raw_issue, str) or not raw_issue.strip():
                violations.append(
                    f"[exceptions-schema] {prefix}: optional field 'tracking_issue' must be a non-empty string"
                )
                entry_ok = False
            else:
                tracking_issue = raw_issue.strip()

        try:
            expires_date = parse_iso_date(cleaned["expires_on"], label=f"{prefix}.expires_on")
        except ValueError as exc:
            violations.append(f"[exceptions-schema] {exc}")
            continue

        if expires_date < today:
            violations.append(
                f"[exceptions-expired] {prefix}: exception {cleaned['id']} for "
                f"{cleaned['package']} expired on {expires_date.isoformat()} "
                f"(today={today.isoformat()})"
            )
            continue

        if not entry_ok:
            continue

        dedupe_key = (
            cleaned["id"].lower(),
            cleaned["package"].lower(),
            ecosystem or "",
        )
        if dedupe_key in seen_keys:
            violations.append(
                f"[exceptions-duplicate] {prefix}: duplicate exception for "
                f"id={cleaned['id']!r}, package={cleaned['package']!r}"
            )
            continue
        seen_keys.add(dedupe_key)

        entries.append(
            ExceptionEntry(
                id=cleaned["id"],
                package=cleaned["package"],
                reason=cleaned["reason"],
                expires_on=expires_date,
                ecosystem=ecosystem,
                notes=notes,
                tracking_issue=tracking_issue,
            )
        )

    return tuple(entries), tuple(violations)


def _is_valid_sri(integrity: Any) -> bool:
    if not isinstance(integrity, str) or not integrity.strip():
        return False
    tokens = integrity.strip().split()
    return bool(tokens) and all(SRI_TOKEN_RE.match(tok) is not None for tok in tokens)


def _validate_npm_resolved_url(
    pkg_path: str,
    resolved: Any,
    allowed_hosts: Set[str],
) -> Optional[str]:
    if not isinstance(resolved, str) or not resolved.strip():
        return f"[npm-lock-resolved] {pkg_path}: missing or empty 'resolved' URL"

    url = resolved.strip()
    lower = url.lower()
    if lower.startswith(("git+", "git:", "file:", "http://", "ssh:", "github:", "npm:")):
        return (
            f"[npm-lock-resolved] {pkg_path}: forbidden non-registry dependency URL: {url!r}"
        )

    parsed = urlparse(url)
    if parsed.scheme != "https":
        return (
            f"[npm-lock-resolved] {pkg_path}: 'resolved' must use https://, got {url!r}"
        )
    if parsed.username is not None or parsed.password is not None:
        return (
            f"[npm-lock-resolved] {pkg_path}: 'resolved' must not embed credentials: {url!r}"
        )
    if parsed.port is not None:
        return (
            f"[npm-lock-resolved] {pkg_path}: 'resolved' must not specify custom port: {url!r}"
        )
    hostname = (parsed.hostname or "").lower()
    if hostname not in allowed_hosts:
        return (
            f"[npm-lock-resolved] {pkg_path}: host {hostname!r} is not an allowed npm registry "
            f"({', '.join(sorted(allowed_hosts))}): {url!r}"
        )
    if parsed.query or parsed.fragment:
        return (
            f"[npm-lock-resolved] {pkg_path}: 'resolved' tarball URL must not include query/fragment: {url!r}"
        )
    if "/-/" not in parsed.path or not parsed.path.endswith(".tgz"):
        return (
            f"[npm-lock-resolved] {pkg_path}: 'resolved' must point to an immutable registry .tgz tarball: {url!r}"
        )
    return None


def _is_verified_local_workspace_link(frontend_dir: Path, meta: Dict[str, Any]) -> bool:
    if meta.get("link") is not True:
        return False
    resolved = meta.get("resolved")
    if not isinstance(resolved, str) or not resolved.strip():
        return False
    raw = resolved.strip()
    if raw.lower().startswith("file:") or "://" in raw or raw.startswith(("/", "\\", "~")):
        return False
    rel_path = Path(raw)
    if rel_path.is_absolute() or ".." in rel_path.parts:
        return False
    try:
        frontend_resolved = frontend_dir.resolve()
        target_resolved = (frontend_dir / rel_path).resolve()
        target_resolved.relative_to(frontend_resolved)
    except (OSError, ValueError):
        return False
    return target_resolved.is_dir()


def check_npm_lockfile(
    repo_root: Path,
    allowed_hosts: Optional[Set[str]] = None,
) -> Tuple[int, Tuple[str, ...]]:
    hosts = ALLOWED_NPM_REGISTRY_HOSTS if allowed_hosts is None else allowed_hosts
    frontend_dir = repo_root / "frontend"
    lock_path = frontend_dir / "package-lock.json"
    violations: List[str] = []

    if not lock_path.is_file():
        return 0, (f"[npm-lock-missing] required lockfile not found: {lock_path}",)

    try:
        raw = lock_path.read_text(encoding="utf-8")
    except OSError as exc:
        return 0, (f"[npm-lock-read-error] cannot read {lock_path}: {exc}",)

    if not raw.strip():
        return 0, (f"[npm-lock-empty] lockfile is empty: {lock_path}",)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return 0, (f"[npm-lock-invalid-json] {lock_path}: {exc}",)

    if not isinstance(data, dict):
        return 0, (f"[npm-lock-schema] {lock_path} root must be a JSON object",)

    lockfile_version = data.get("lockfileVersion")
    if not isinstance(lockfile_version, int) or isinstance(lockfile_version, bool) or lockfile_version < 2:
        violations.append(
            f"[npm-lock-version] {lock_path}: expected lockfileVersion >= 2, got {lockfile_version!r}"
        )

    packages = data.get("packages")
    if not isinstance(packages, dict):
        violations.append(f"[npm-lock-schema] {lock_path}: missing 'packages' object")
        return 0, tuple(violations)

    checked = 0
    for pkg_path in sorted(packages.keys()):
        if pkg_path == "":
            continue
        meta = packages[pkg_path]
        if not isinstance(meta, dict):
            violations.append(
                f"[npm-lock-schema] {pkg_path}: package entry must be a JSON object"
            )
            continue

        if _is_verified_local_workspace_link(frontend_dir, meta):
            continue

        checked += 1
        if not _is_valid_sri(meta.get("integrity")):
            violations.append(
                f"[npm-lock-integrity] {pkg_path}: missing or invalid SRI integrity hash "
                f"(expected sha512/sha384/sha256-...): {meta.get('integrity')!r}"
            )

        resolved_err = _validate_npm_resolved_url(pkg_path, meta.get("resolved"), hosts)
        if resolved_err is not None:
            violations.append(resolved_err)

    if checked == 0:
        violations.append(
            f"[npm-lock-empty] {lock_path}: no non-root packages found under 'packages'"
        )

    return checked, tuple(violations)


def _strip_gomod_comment(line: str) -> str:
    idx = line.find("//")
    if idx != -1:
        return line[:idx]
    return line


def _is_local_replace_target(rhs_tokens: Sequence[str]) -> bool:
    if len(rhs_tokens) < 2:
        return True
    target = rhs_tokens[0]
    if target.startswith(("./", "../", ".", "/", "\\", "~")):
        return True
    if ":" in target:
        return True
    return False


def check_go_module_files(repo_root: Path) -> Tuple[str, ...]:
    violations: List[str] = []
    gomod_path = repo_root / "backend" / "go.mod"
    gosum_path = repo_root / "backend" / "go.sum"

    if not gomod_path.is_file():
        violations.append(f"[go-mod-missing] required file not found: {gomod_path}")
    if not gosum_path.is_file():
        violations.append(f"[go-sum-missing] required file not found: {gosum_path}")
    if violations:
        return tuple(violations)

    try:
        gomod_text = gomod_path.read_text(encoding="utf-8")
        gosum_text = gosum_path.read_text(encoding="utf-8")
    except OSError as exc:
        return (f"[go-mod-read-error] failed reading Go module files: {exc}",)

    if not gomod_text.strip():
        violations.append(f"[go-mod-empty] {gomod_path} is empty")
    if not gosum_text.strip():
        violations.append(f"[go-sum-empty] {gosum_path} is empty")

    sum_entries = 0
    for lineno, raw_line in enumerate(gosum_text.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) != 3 or not GOSUM_HASH_RE.match(parts[2]):
            violations.append(
                f"[go-sum-invalid] backend/go.sum:{lineno}: invalid checksum entry: {stripped!r}"
            )
            continue
        sum_entries += 1

    if gosum_text.strip() and sum_entries == 0:
        violations.append("[go-sum-empty] backend/go.sum contains no checksum entries")

    module_decl: Optional[str] = None
    go_version: Optional[str] = None
    toolchain_version: Optional[str] = None
    in_block: Optional[str] = None

    for lineno, raw_line in enumerate(gomod_text.splitlines(), start=1):
        line = _strip_gomod_comment(raw_line).strip()
        if not line:
            continue

        if in_block is not None:
            if line == ")":
                in_block = None
                continue
            if in_block == "replace":
                _check_replace_spec(line, lineno, violations)
            continue

        block_open = GOMOD_BLOCK_OPEN_RE.match(line)
        if block_open is not None:
            block_kind = block_open.group(1)
            rest = block_open.group(2).strip()
            if ")" in rest:
                inner = rest[: rest.rfind(")")].strip()
                if block_kind == "replace" and inner:
                    _check_replace_spec(inner, lineno, violations)
            else:
                in_block = block_kind
                if block_kind == "replace" and rest:
                    _check_replace_spec(rest, lineno, violations)
            continue

        tokens = line.split()
        directive = tokens[0]

        if directive == "module":
            if len(tokens) != 2:
                violations.append(
                    f"[go-mod-module] backend/go.mod:{lineno}: invalid module directive: {line!r}"
                )
            else:
                module_decl = tokens[1]
        elif directive == "go":
            if len(tokens) != 2 or not GO_VERSION_RE.match(tokens[1]):
                violations.append(
                    f"[go-mod-version] backend/go.mod:{lineno}: invalid go version directive: {line!r}"
                )
            else:
                go_version = tokens[1]
        elif directive == "toolchain":
            if len(tokens) != 2 or not GO_TOOLCHAIN_RE.match(tokens[1]):
                violations.append(
                    f"[go-mod-toolchain] backend/go.mod:{lineno}: toolchain must be pinned to exact "
                    f"goX.Y.Z release (rejects 'default'/'local'), got {line!r}"
                )
            else:
                toolchain_version = tokens[1]
        elif directive == "replace":
            spec = line[len("replace") :].strip()
            _check_replace_spec(spec, lineno, violations)

    if module_decl is None:
        violations.append("[go-mod-module] backend/go.mod missing 'module' declaration")
    if go_version is None:
        violations.append("[go-mod-version] backend/go.mod missing pinned 'go X.Y[.Z]' declaration")
    if toolchain_version is None:
        violations.append(
            "[go-mod-toolchain] backend/go.mod missing pinned 'toolchain goX.Y.Z' declaration"
        )

    return tuple(violations)


def _check_replace_spec(spec: str, lineno: int, violations: List[str]) -> None:
    if "=>" not in spec:
        violations.append(
            f"[go-mod-replace] backend/go.mod:{lineno}: malformed replace directive: {spec!r}"
        )
        return
    _, _, rhs = spec.partition("=>")
    rhs_tokens = rhs.strip().split()
    if not rhs_tokens or _is_local_replace_target(rhs_tokens):
        violations.append(
            f"[go-mod-local-replace] backend/go.mod:{lineno}: local/relative replace directive "
            f"is forbidden: {spec!r}"
        )


def _strip_yaml_scalar_comment(raw_value: str) -> str:
    value = raw_value.strip()
    if not value:
        return ""
    quote = value[0]
    if quote in ("'", '"'):
        end_idx = value.find(quote, 1)
        if end_idx != -1:
            return value[1:end_idx].strip()
        return value.strip()
    comment_idx = value.find(" #")
    if comment_idx != -1:
        value = value[:comment_idx]
    elif value.startswith("#"):
        return ""
    return value.strip()


def extract_workflow_uses(yaml_text: str) -> List[Tuple[int, str]]:
    """Extract (line_number, uses_ref) pairs from a GitHub Actions workflow YAML.

    Skips comment lines and multiline block scalars (`run: |`, `>`, etc.) using
    YAML indentation tracking so shell scripts mentioning `uses:` never trigger
    false positives.
    """
    results: List[Tuple[int, str]] = []
    block_key_indent: Optional[int] = None

    for lineno, raw_line in enumerate(yaml_text.splitlines(), start=1):
        stripped = raw_line.strip()
        leading_spaces = len(raw_line) - len(raw_line.lstrip(" "))

        if block_key_indent is not None:
            if not stripped:
                continue
            if leading_spaces <= block_key_indent:
                block_key_indent = None
            else:
                continue

        if not stripped or stripped.startswith("#"):
            continue

        block_match = BLOCK_SCALAR_HEADER_RE.match(raw_line)
        if block_match is not None:
            dash_part = block_match.group("dash") or ""
            block_key_indent = len(block_match.group("indent")) + len(dash_part)
            continue

        uses_match = USES_LINE_RE.match(raw_line)
        if uses_match is not None:
            ref = _strip_yaml_scalar_comment(uses_match.group("value"))
            if ref:
                results.append((lineno, ref))

    return results


def check_github_workflows(repo_root: Path) -> Tuple[int, int, Tuple[str, ...]]:
    workflows_dir = repo_root / ".github" / "workflows"
    if not workflows_dir.is_dir():
        return 0, 0, (f"[workflow-dir-missing] workflows directory not found: {workflows_dir}",)

    workflow_files = sorted(
        p
        for p in workflows_dir.iterdir()
        if p.is_file() and p.suffix.lower() in (".yml", ".yaml")
    )
    if not workflow_files:
        return 0, 0, (f"[workflow-files-missing] no *.yml/*.yaml files under {workflows_dir}",)

    violations: List[str] = []
    total_uses = 0

    for wf_path in workflow_files:
        rel = wf_path.relative_to(repo_root).as_posix()
        try:
            text = wf_path.read_text(encoding="utf-8")
        except OSError as exc:
            violations.append(f"[workflow-read-error] cannot read {rel}: {exc}")
            continue

        for lineno, ref in extract_workflow_uses(text):
            total_uses += 1
            if ref.startswith("./"):
                continue
            if ref.startswith("docker://"):
                if not DOCKER_DIGEST_RE.search(ref):
                    violations.append(
                        f"[workflow-unpinned-docker] {rel}:{lineno}: docker action must be pinned "
                        f"to @sha256:<64 hex>, got {ref!r}"
                    )
                continue

            action_path, sep, rev = ref.partition("@")
            if not sep or "/" not in action_path or any(ch.isspace() for ch in action_path):
                violations.append(
                    f"[workflow-invalid-uses] {rel}:{lineno}: malformed action reference {ref!r}"
                )
                continue
            if not SHA40_RE.match(rev):
                violations.append(
                    f"[workflow-unpinned-action] {rel}:{lineno}: action {action_path!r} must be "
                    f"pinned to a full 40-char lowercase hex commit SHA, got @{rev}"
                )

    return len(workflow_files), total_uses, tuple(violations)


def check_offline(
    repo_root: Path = DEFAULT_REPO_ROOT,
    *,
    exceptions_path: Optional[Path] = None,
    today: Optional[datetime.date] = None,
    allowed_npm_hosts: Optional[Set[str]] = None,
) -> OfflineCheckResult:
    effective_today = utc_today() if today is None else today
    effective_exceptions = (
        repo_root / DEFAULT_EXCEPTIONS_REL_PATH if exceptions_path is None else exceptions_path
    )

    violations: List[str] = []
    notices: List[str] = []

    npm_checked, npm_violations = check_npm_lockfile(repo_root, allowed_hosts=allowed_npm_hosts)
    violations.extend(npm_violations)

    go_violations = check_go_module_files(repo_root)
    violations.extend(go_violations)

    wf_files, wf_uses, wf_violations = check_github_workflows(repo_root)
    violations.extend(wf_violations)

    exceptions, exc_violations = load_exceptions(effective_exceptions, effective_today)
    violations.extend(exc_violations)

    for entry in exceptions:
        notices.append(
            f"active exception: id={entry.id} package={entry.package} "
            f"expires_on={entry.expires_on.isoformat()} reason={entry.reason}"
        )

    return OfflineCheckResult(
        passed=len(violations) == 0,
        npm_packages_checked=npm_checked,
        workflow_files_checked=wf_files,
        workflow_uses_checked=wf_uses,
        exceptions_loaded=len(exceptions),
        violations=tuple(violations),
        notices=tuple(notices),
    )


def _extract_advisory_ids_from_npm_via(adv: Dict[str, Any]) -> Tuple[str, ...]:
    ids: List[str] = []
    seen_lower: Set[str] = set()

    def _add(val: str) -> None:
        cleaned = val.strip()
        if not cleaned:
            return
        key = cleaned.lower()
        if key not in seen_lower:
            seen_lower.add(key)
            ids.append(cleaned)

    for field_name in ("ghsa_id", "github_advisory_id", "id", "cve"):
        val = adv.get(field_name)
        if isinstance(val, str):
            _add(val)

    cves = adv.get("cves")
    if isinstance(cves, list):
        for cve in cves:
            if isinstance(cve, str):
                _add(cve)

    for text_field in ("url", "title"):
        val = adv.get(text_field)
        if isinstance(val, str):
            for match in GHSA_RE.findall(val):
                _add(match.upper())
            for match in CVE_RE.findall(val):
                _add(match.upper())

    source = adv.get("source")
    if isinstance(source, (int, str)) and not isinstance(source, bool):
        _add(str(source))

    return tuple(ids)


def parse_npm_audit_output(
    result: CommandResult,
) -> Tuple[Tuple[VulnFinding, ...], Tuple[str, ...]]:
    violations: List[str] = []
    raw_stdout = result.stdout.strip()
    if not raw_stdout:
        stderr_note = result.stderr.strip() or "<empty stderr>"
        return (
            (),
            (
                f"[npm-audit-error] npm audit exited with code {result.returncode} and empty JSON output "
                f"(stderr: {stderr_note})",
            ),
        )

    try:
        payload = json.loads(raw_stdout)
    except json.JSONDecodeError as exc:
        return (
            (),
            (
                f"[npm-audit-invalid-json] failed to parse npm audit JSON output "
                f"(exit={result.returncode}): {exc}",
            ),
        )

    if not isinstance(payload, dict):
        return (
            (),
            (f"[npm-audit-schema] expected JSON object, got {type(payload).__name__}",),
        )

    if payload.get("error"):
        err_obj = payload["error"]
        if isinstance(err_obj, dict):
            code = err_obj.get("code", "UNKNOWN")
            summary = err_obj.get("summary") or err_obj.get("detail") or str(err_obj)
            detail = f"{code}: {summary}"
        else:
            detail = str(err_obj)
        return ((), (f"[npm-audit-error] npm audit reported error (exit={result.returncode}): {detail}",))

    findings_by_key: Dict[Tuple[str, str], VulnFinding] = {}

    if isinstance(payload.get("vulnerabilities"), dict):
        vulns_map: Dict[str, Any] = payload["vulnerabilities"]
        for pkg_name, entry in sorted(vulns_map.items()):
            if not isinstance(entry, dict):
                violations.append(
                    f"[npm-audit-schema] vulnerability entry for {pkg_name!r} is not an object"
                )
                continue

            entry_severity = str(entry.get("severity") or "").strip().lower()
            via = entry.get("via")
            if not isinstance(via, list):
                if entry_severity in HIGH_SEVERITIES:
                    synthetic_id = f"NPM-UNKNOWN-{pkg_name}"
                    findings_by_key[(synthetic_id.lower(), pkg_name.lower())] = VulnFinding(
                        ecosystem="npm",
                        primary_id=synthetic_id,
                        all_ids=(synthetic_id,),
                        package=pkg_name,
                        candidate_packages=(pkg_name,),
                        severity=entry_severity,
                        title="Unstructured high/critical npm audit vulnerability",
                    )
                continue

            advisory_dicts = [v for v in via if isinstance(v, dict)]
            string_refs = [v for v in via if isinstance(v, str)]

            for adv in advisory_dicts:
                adv_severity = str(adv.get("severity") or entry_severity).strip().lower()
                if adv_severity not in HIGH_SEVERITIES:
                    continue
                all_ids = _extract_advisory_ids_from_npm_via(adv)
                if not all_ids:
                    all_ids = (f"NPM-UNIDENTIFIED-{pkg_name}",)
                primary_id = all_ids[0]
                adv_pkg = str(adv.get("name") or adv.get("dependency") or pkg_name).strip() or pkg_name
                cand_pkgs = tuple(dict.fromkeys([adv_pkg, pkg_name]))
                title = str(adv.get("title") or adv.get("url") or primary_id).strip()
                key = (primary_id.lower(), adv_pkg.lower())
                if key not in findings_by_key:
                    findings_by_key[key] = VulnFinding(
                        ecosystem="npm",
                        primary_id=primary_id,
                        all_ids=all_ids,
                        package=adv_pkg,
                        candidate_packages=cand_pkgs,
                        severity=adv_severity,
                        title=title,
                    )

            if entry_severity in HIGH_SEVERITIES and not advisory_dicts:
                unresolved_refs = [ref for ref in string_refs if ref not in vulns_map]
                if not string_refs or unresolved_refs:
                    synthetic_id = f"NPM-UNKNOWN-{pkg_name}"
                    findings_by_key[(synthetic_id.lower(), pkg_name.lower())] = VulnFinding(
                        ecosystem="npm",
                        primary_id=synthetic_id,
                        all_ids=(synthetic_id,),
                        package=pkg_name,
                        candidate_packages=(pkg_name,),
                        severity=entry_severity,
                        title=f"Unresolved transitive {entry_severity} vulnerability",
                    )
    elif isinstance(payload.get("advisories"), dict):
        for adv_id, adv in sorted(payload["advisories"].items()):
            if not isinstance(adv, dict):
                continue
            severity = str(adv.get("severity") or "").strip().lower()
            if severity not in HIGH_SEVERITIES:
                continue
            all_ids = _extract_advisory_ids_from_npm_via(adv)
            if str(adv_id) not in all_ids:
                all_ids = all_ids + (str(adv_id),)
            primary_id = all_ids[0]
            pkg_name = str(adv.get("module_name") or "unknown").strip() or "unknown"
            title = str(adv.get("title") or primary_id).strip()
            key = (primary_id.lower(), pkg_name.lower())
            findings_by_key[key] = VulnFinding(
                ecosystem="npm",
                primary_id=primary_id,
                all_ids=all_ids,
                package=pkg_name,
                candidate_packages=(pkg_name,),
                severity=severity,
                title=title,
            )
    else:
        violations.append(
            "[npm-audit-schema] npm audit JSON missing 'vulnerabilities' or 'advisories' object"
        )

    metadata = payload.get("metadata")
    meta_high_crit = 0
    if isinstance(metadata, dict) and isinstance(metadata.get("vulnerabilities"), dict):
        mv = metadata["vulnerabilities"]
        for sev in ("high", "critical"):
            val = mv.get(sev, 0)
            if isinstance(val, int) and not isinstance(val, bool) and val > 0:
                meta_high_crit += val

    findings = tuple(findings_by_key.values())
    if not violations:
        if meta_high_crit > 0 and not findings:
            violations.append(
                f"[npm-audit-mismatch] metadata reports {meta_high_crit} high/critical vulnerability(s) "
                "but parser extracted 0 advisory entries (fail-closed)"
            )
        elif result.returncode != 0 and not findings:
            stderr_note = result.stderr.strip() or "<empty stderr>"
            violations.append(
                f"[npm-audit-exit-error] npm audit exited with code {result.returncode} "
                f"without high/critical findings in report (stderr: {stderr_note})"
            )

    return findings, tuple(violations)


def _decode_json_stream(text: str) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    decoder = json.JSONDecoder()
    idx = 0
    length = len(text)
    objects: List[Dict[str, Any]] = []

    while idx < length:
        while idx < length and text[idx].isspace():
            idx += 1
        if idx >= length:
            break
        try:
            obj, next_idx = decoder.raw_decode(text, idx)
        except json.JSONDecodeError as exc:
            return [], f"invalid JSON in govulncheck stream at offset {idx}: {exc}"
        if not isinstance(obj, dict):
            return [], f"expected JSON object in govulncheck stream, got {type(obj).__name__}"
        objects.append(obj)
        idx = next_idx

    return objects, None


def _read_local_go_module_path(repo_root: Path) -> Optional[str]:
    gomod_path = repo_root / "backend" / "go.mod"
    if not gomod_path.is_file():
        return None
    try:
        for raw_line in gomod_path.read_text(encoding="utf-8").splitlines():
            line = _strip_gomod_comment(raw_line).strip()
            parts = line.split()
            if len(parts) == 2 and parts[0] == "module":
                return parts[1]
    except OSError:
        return None
    return None


def parse_govulncheck_output(
    result: CommandResult,
    *,
    local_module_path: Optional[str] = None,
) -> Tuple[Tuple[VulnFinding, ...], Tuple[str, ...], Tuple[str, ...]]:
    violations: List[str] = []
    notices: List[str] = []

    if result.returncode != 0:
        stderr_note = result.stderr.strip() or result.stdout.strip() or "<empty output>"
        return (
            (),
            (
                f"[govulncheck-error] govulncheck exited with code {result.returncode}: "
                f"{stderr_note[:400]}",
            ),
            (),
        )

    if not result.stdout.strip():
        return ((), ("[govulncheck-empty] govulncheck produced empty stdout",), ())

    objects, parse_err = _decode_json_stream(result.stdout)
    if parse_err is not None:
        return ((), (f"[govulncheck-invalid-json] {parse_err}",), ())

    if not objects or not any(
        bool(set(obj.keys()) & GOVULNCHECK_MESSAGE_KEYS) for obj in objects
    ):
        return (
            (),
            ("[govulncheck-schema] stdout contained no recognized govulncheck JSON messages",),
            (),
        )

    scan_level: Optional[str] = None
    osv_by_id: Dict[str, Dict[str, Any]] = {}
    raw_findings: List[Dict[str, Any]] = []

    for obj in objects:
        cfg = obj.get("config")
        if isinstance(cfg, dict):
            raw_level = cfg.get("scan_level")
            if isinstance(raw_level, str) and raw_level.strip():
                scan_level = raw_level.strip().lower()

        osv = obj.get("osv")
        if isinstance(osv, dict) and isinstance(osv.get("id"), str) and osv["id"].strip():
            osv_by_id[osv["id"].strip()] = osv

        finding = obj.get("finding")
        if isinstance(finding, dict):
            raw_findings.append(finding)

    findings_by_key: Dict[Tuple[str, str], VulnFinding] = {}
    informational_osvs: Set[str] = set()

    for finding in raw_findings:
        osv_id = str(finding.get("osv") or "").strip()
        if not osv_id:
            violations.append("[govulncheck-schema] finding object missing 'osv' identifier")
            continue

        trace_raw = finding.get("trace")
        trace = [f for f in trace_raw if isinstance(f, dict)] if isinstance(trace_raw, list) else []

        has_function = any(isinstance(f.get("function"), str) and f["function"].strip() for f in trace)
        has_package = any(isinstance(f.get("package"), str) and f["package"].strip() for f in trace)

        if scan_level == "symbol" and not has_function:
            informational_osvs.add(osv_id)
            continue
        if scan_level == "package" and not (has_function or has_package):
            informational_osvs.add(osv_id)
            continue

        osv_entry = osv_by_id.get(osv_id, {})
        all_ids_list: List[str] = [osv_id]
        aliases = osv_entry.get("aliases")
        if isinstance(aliases, list):
            for alias in aliases:
                if isinstance(alias, str) and alias.strip() and alias.strip() not in all_ids_list:
                    all_ids_list.append(alias.strip())

        cand_pkgs: List[str] = []
        primary_pkg: Optional[str] = None

        for frame in trace:
            mod = frame.get("module")
            pkg = frame.get("package")
            is_local = isinstance(mod, str) and local_module_path is not None and mod == local_module_path
            if is_local:
                continue
            if isinstance(mod, str) and mod.strip():
                mod_clean = mod.strip()
                if primary_pkg is None:
                    primary_pkg = mod_clean
                if mod_clean not in cand_pkgs:
                    cand_pkgs.append(mod_clean)
            if isinstance(pkg, str) and pkg.strip():
                pkg_clean = pkg.strip()
                if primary_pkg is None:
                    primary_pkg = pkg_clean
                if pkg_clean not in cand_pkgs:
                    cand_pkgs.append(pkg_clean)

        affected = osv_entry.get("affected")
        if isinstance(affected, list):
            for aff in affected:
                if not isinstance(aff, dict):
                    continue
                pkg_obj = aff.get("package")
                if isinstance(pkg_obj, dict):
                    name = pkg_obj.get("name")
                    if isinstance(name, str) and name.strip():
                        name_clean = name.strip()
                        if primary_pkg is None:
                            primary_pkg = name_clean
                        if name_clean not in cand_pkgs:
                            cand_pkgs.append(name_clean)

        if primary_pkg is None:
            for frame in trace:
                for key in ("module", "package"):
                    val = frame.get(key)
                    if isinstance(val, str) and val.strip():
                        primary_pkg = val.strip()
                        if primary_pkg not in cand_pkgs:
                            cand_pkgs.append(primary_pkg)
                        break
                if primary_pkg is not None:
                    break

        if primary_pkg is None:
            primary_pkg = "unknown"
            cand_pkgs = ["unknown"]

        summary = str(osv_entry.get("summary") or osv_id).strip()
        dedupe_key = (osv_id.lower(), primary_pkg.lower())
        if dedupe_key not in findings_by_key:
            findings_by_key[dedupe_key] = VulnFinding(
                ecosystem="go",
                primary_id=osv_id,
                all_ids=tuple(all_ids_list),
                package=primary_pkg,
                candidate_packages=tuple(cand_pkgs),
                severity="high",
                title=summary,
            )

    actionable_osvs = {f.primary_id for f in findings_by_key.values()}
    for info_id in sorted(informational_osvs - actionable_osvs):
        notices.append(
            f"govulncheck informational (not called at scan_level={scan_level}): {info_id}"
        )

    return tuple(findings_by_key.values()), tuple(violations), tuple(notices)


def exception_matches_finding(exc: ExceptionEntry, finding: VulnFinding) -> bool:
    if exc.ecosystem is not None and exc.ecosystem != finding.ecosystem:
        return False
    id_set = {cid.lower() for cid in finding.all_ids}
    if exc.id.lower() not in id_set:
        return False
    pkg_set = {pkg.lower() for pkg in finding.candidate_packages}
    return exc.package.lower() in pkg_set


def check_online_vuln(
    repo_root: Path = DEFAULT_REPO_ROOT,
    *,
    exceptions_path: Optional[Path] = None,
    today: Optional[datetime.date] = None,
    runner: Optional[CommandRunner] = None,
    npm_bin: str = "npm",
    npm_registry: Optional[str] = DEFAULT_NPM_REGISTRY,
    govulncheck_bin: str = "govulncheck",
) -> OnlineVulnResult:
    effective_runner = default_command_runner if runner is None else runner
    effective_today = utc_today() if today is None else today
    effective_exceptions = (
        repo_root / DEFAULT_EXCEPTIONS_REL_PATH if exceptions_path is None else exceptions_path
    )

    exceptions, exc_violations = load_exceptions(effective_exceptions, effective_today)
    if exc_violations:
        return OnlineVulnResult(
            passed=False,
            npm_findings_total=0,
            go_findings_total=0,
            unexempted_findings=(),
            exempted_findings=(),
            violations=exc_violations,
            notices=(),
        )

    violations: List[str] = []
    notices: List[str] = []
    all_findings: List[VulnFinding] = []
    npm_count = 0
    go_count = 0

    frontend_dir = repo_root / "frontend"
    if not (frontend_dir / "package-lock.json").is_file():
        violations.append(
            f"[npm-audit-missing-lockfile] required file not found: {frontend_dir / 'package-lock.json'}"
        )
    else:
        npm_cmd = [
            npm_bin,
            "--prefix",
            str(frontend_dir),
            "audit",
            "--omit=dev",
            "--audit-level=high",
            "--json",
        ]
        if npm_registry:
            npm_cmd.append(f"--registry={npm_registry}")
        try:
            npm_res = effective_runner(npm_cmd, repo_root)
        except OSError as exc:
            violations.append(f"[npm-audit-exec-error] failed to run {npm_bin!r}: {exc}")
        else:
            npm_findings, npm_errs = parse_npm_audit_output(npm_res)
            violations.extend(npm_errs)
            npm_count = len(npm_findings)
            all_findings.extend(npm_findings)

    backend_dir = repo_root / "backend"
    if not (backend_dir / "go.mod").is_file():
        violations.append(
            f"[govulncheck-missing-gomod] required file not found: {backend_dir / 'go.mod'}"
        )
    else:
        go_cmd = [govulncheck_bin, "-json", "./..."]
        try:
            go_res = effective_runner(go_cmd, backend_dir)
        except OSError as exc:
            violations.append(
                f"[govulncheck-exec-error] failed to run {govulncheck_bin!r} "
                f"(install pinned golang.org/x/vuln/cmd/govulncheck): {exc}"
            )
        else:
            local_mod = _read_local_go_module_path(repo_root)
            go_findings, go_errs, go_notices = parse_govulncheck_output(
                go_res,
                local_module_path=local_mod,
            )
            violations.extend(go_errs)
            notices.extend(go_notices)
            go_count = len(go_findings)
            all_findings.extend(go_findings)

    unexempted: List[VulnFinding] = []
    exempted: List[ExemptedFinding] = []

    for finding in all_findings:
        matched_exc: Optional[ExceptionEntry] = None
        for entry in exceptions:
            if exception_matches_finding(entry, finding):
                matched_exc = entry
                break
        if matched_exc is not None:
            exempted.append(ExemptedFinding(finding=finding, exception=matched_exc))
            notices.append(
                f"EXEMPTED [{finding.ecosystem}] id={finding.primary_id} "
                f"(matched={matched_exc.id}) package={finding.package} "
                f"expires_on={matched_exc.expires_on.isoformat()} reason={matched_exc.reason}"
            )
        else:
            unexempted.append(finding)
            aliases_note = (
                f" (aliases={', '.join(finding.all_ids[1:])})" if len(finding.all_ids) > 1 else ""
            )
            violations.append(
                f"[online-vuln-unexempted] [{finding.ecosystem}] {finding.primary_id}{aliases_note} "
                f"package={finding.package} severity={finding.severity}: {finding.title}"
            )

    return OnlineVulnResult(
        passed=len(violations) == 0 and len(unexempted) == 0,
        npm_findings_total=npm_count,
        go_findings_total=go_count,
        unexempted_findings=tuple(unexempted),
        exempted_findings=tuple(exempted),
        violations=tuple(violations),
        notices=tuple(notices),
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Fail-closed supply-chain integrity (--offline) and online vulnerability "
            "(--online-vuln) audit gate."
        )
    )
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Run zero-network deterministic supply-chain checks.",
    )
    parser.add_argument(
        "--online-vuln",
        action="store_true",
        help="Run npm audit and govulncheck against scripts/supply-chain-exceptions.json.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        default=DEFAULT_REPO_ROOT,
        help="Repository root directory (defaults to repo root containing scripts/).",
    )
    parser.add_argument(
        "--exceptions-file",
        type=Path,
        default=None,
        help="Optional path to exceptions JSON ledger (defaults to <repo-root>/scripts/supply-chain-exceptions.json).",
    )
    parser.add_argument(
        "--today",
        type=str,
        default=None,
        help="Optional YYYY-MM-DD override for deterministic exception expiry checks.",
    )
    parser.add_argument(
        "--npm-registry",
        type=str,
        default=DEFAULT_NPM_REGISTRY,
        help=f"Registry URL passed to npm audit in --online-vuln mode (default: {DEFAULT_NPM_REGISTRY}).",
    )
    parser.add_argument(
        "--govulncheck-bin",
        type=str,
        default="govulncheck",
        help="Path or executable name for govulncheck (default: govulncheck).",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if not args.offline and not args.online_vuln:
        parser.error("must specify at least one mode: --offline and/or --online-vuln")

    try:
        effective_today = (
            utc_today() if args.today is None else parse_iso_date(args.today, label="--today")
        )
    except ValueError as exc:
        print(f"Supply-chain check FAILED: {exc}", file=sys.stderr)
        return 2

    repo_root = args.repo_root.resolve()
    exceptions_path = (
        args.exceptions_file.resolve() if args.exceptions_file is not None else None
    )

    overall_ok = True

    if args.offline:
        offline_res = check_offline(
            repo_root=repo_root,
            exceptions_path=exceptions_path,
            today=effective_today,
        )
        for note in offline_res.notices:
            print(f"NOTICE: {note}")
        if not offline_res.passed:
            overall_ok = False
            print(
                f"Supply-chain offline check FAILED ({len(offline_res.violations)} violation(s)):",
                file=sys.stderr,
            )
            for violation in offline_res.violations:
                print(f"  - {violation}", file=sys.stderr)
        else:
            print(
                f"Supply-chain offline check PASSED (npmPackages={offline_res.npm_packages_checked}, "
                f"workflowFiles={offline_res.workflow_files_checked}, "
                f"workflowUses={offline_res.workflow_uses_checked}, "
                f"exceptions={offline_res.exceptions_loaded})"
            )

    if args.online_vuln:
        online_res = check_online_vuln(
            repo_root=repo_root,
            exceptions_path=exceptions_path,
            today=effective_today,
            npm_registry=args.npm_registry,
            govulncheck_bin=args.govulncheck_bin,
        )
        for note in online_res.notices:
            print(f"AUDIT: {note}")
        if not online_res.passed:
            overall_ok = False
            print(
                f"Supply-chain online-vuln check FAILED ({len(online_res.violations)} violation(s), "
                f"unexempted={len(online_res.unexempted_findings)}, "
                f"exempted={len(online_res.exempted_findings)}):",
                file=sys.stderr,
            )
            for violation in online_res.violations:
                print(f"  - {violation}", file=sys.stderr)
        else:
            print(
                f"Supply-chain online-vuln check PASSED (npmFindings={online_res.npm_findings_total}, "
                f"goFindings={online_res.go_findings_total}, "
                f"exempted={len(online_res.exempted_findings)})"
            )

    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
