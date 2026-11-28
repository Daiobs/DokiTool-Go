#!/usr/bin/env python3
"""Fail-closed repository-wide SSOT consistency and public-docs desensitization gate.

Zero third-party dependencies (Python 3.9+ stdlib only). Runs on every PR inside
the always-on ``repo-contracts`` job so version metadata, dependency alignment,
runtime pins, and public documentation never drift silently out of sync.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]

SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
EXT_ID_RE = re.compile(r"^[a-p]{32}$")
GO_TOOLCHAIN_RE = re.compile(r"^[ \t]*toolchain[ \t]+go(\d+\.\d+\.\d+)[ \t]*$", re.MULTILINE)
AGENT_VER_RE = re.compile(r"^AGENT_VERSION(?:\s*:\s*str)?\s*=\s*['\"](\d+\.\d+\.\d+)['\"]", re.MULTILINE)

DESENSITIZATION_PATTERNS: Tuple[Tuple[str, re.Pattern[str]], ...] = (
    ("macos-home-path", re.compile(r"/Users/[A-Za-z0-9._-]+/")),
    ("linux-home-path", re.compile(r"/home/[A-Za-z0-9._-]+/")),
    ("windows-user-path", re.compile(r"C:\\Users\\[A-Za-z0-9._-]+\\")),
    ("file-uri", re.compile(r"file:///")),
    ("gemini-dir", re.compile(r"\.gemini/")),
    ("local-proxy-port", re.compile(r"127\.0\.0\.1:7897")),
    ("brain-uuid-path", re.compile(r"brain/[0-9a-f]{8}-[0-9a-f]{4}-")),
    (
        "raw-bearer-token",
        re.compile(r"Authorization:\s*Bearer\s+(?!<|\$|EXAMPLE|YOUR|TOKEN|REDACTED)[A-Za-z0-9._-]{24,}"),
    ),
)


def _read_text(path: Path) -> Optional[str]:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None


def _read_json(path: Path) -> Tuple[Optional[Any], Optional[str]]:
    raw = _read_text(path)
    if raw is None:
        return None, f"Unable to read {path}"
    try:
        return json.loads(raw), None
    except json.JSONDecodeError as exc:
        return None, f"Invalid JSON in {path}: {exc}"


def _load_upstream_watch(root: Path):
    watch_path = root / "scripts/check-upstream-updates.py"
    if not watch_path.is_file():
        watch_path = Path(__file__).resolve().with_name("check-upstream-updates.py")
    spec = importlib.util.spec_from_file_location("dokitool_ssot_upstream_watch", watch_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load {watch_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_extension_and_web_ssot(root: Path) -> Tuple[Dict[str, str], List[str]]:
    violations: List[str] = []
    meta_rel = Path("frontend/src/core/extensionReleaseMeta.json")
    meta, err = _read_json(root / meta_rel)
    if err or not isinstance(meta, dict):
        return {}, [f"[ext-ssot] {err or 'extensionReleaseMeta.json must be a JSON object'}"]

    ext_ver = meta.get("version")
    ext_id = meta.get("extensionId")
    if not isinstance(ext_ver, str) or not SEMVER_RE.fullmatch(ext_ver):
        violations.append(f"[ext-ssot] {meta_rel.as_posix()}: invalid semver version {ext_ver!r}")
    if not isinstance(ext_id, str) or not EXT_ID_RE.fullmatch(ext_id):
        violations.append(f"[ext-ssot] {meta_rel.as_posix()}: invalid extensionId {ext_id!r}")
    if violations:
        return {}, violations

    pkg_rel = Path("frontend/package.json")
    pkg, pkg_err = _read_json(root / pkg_rel)
    if pkg_err or not isinstance(pkg, dict):
        violations.append(f"[ext-ssot] {pkg_err or 'frontend/package.json must be a JSON object'}")
    else:
        if pkg.get("name") != "dokitool-web":
            violations.append(f"[ext-ssot] {pkg_rel.as_posix()}: name must be 'dokitool-web', got {pkg.get('name')!r}")
        if pkg.get("version") != ext_ver:
            violations.append(
                f"[ext-ssot] {pkg_rel.as_posix()}: version {pkg.get('version')!r} != extensionReleaseMeta {ext_ver!r}"
            )
        deps = pkg.get("dependencies") if isinstance(pkg.get("dependencies"), dict) else {}
        dev_deps = pkg.get("devDependencies") if isinstance(pkg.get("devDependencies"), dict) else {}
        for req_dep in ("mediabunny", "@fortawesome/fontawesome-free"):
            if req_dep not in deps:
                violations.append(f"[ext-ssot] {pkg_rel.as_posix()}: runtime bundle dep {req_dep!r} must be in dependencies")
            if req_dep in dev_deps:
                violations.append(f"[ext-ssot] {pkg_rel.as_posix()}: {req_dep!r} must not remain in devDependencies")

    lock_rel = Path("frontend/package-lock.json")
    lock, lock_err = _read_json(root / lock_rel)
    if lock_err or not isinstance(lock, dict):
        violations.append(f"[ext-ssot] {lock_err or 'frontend/package-lock.json must be a JSON object'}")
    else:
        if lock.get("name") != "dokitool-web" or lock.get("version") != ext_ver:
            violations.append(
                f"[ext-ssot] {lock_rel.as_posix()}: top-level name/version ({lock.get('name')!r}, {lock.get('version')!r}) "
                f"!= ('dokitool-web', {ext_ver!r})"
            )
        root_pkg = (lock.get("packages") or {}).get("") if isinstance(lock.get("packages"), dict) else None
        if not isinstance(root_pkg, dict) or root_pkg.get("name") != "dokitool-web" or root_pkg.get("version") != ext_ver:
            violations.append(
                f"[ext-ssot] {lock_rel.as_posix()}: packages[''] name/version mismatch against ('dokitool-web', {ext_ver!r})"
            )

    return {"extension_version": ext_ver, "extension_id": ext_id}, violations


def check_mediabunny_parity(root: Path) -> Tuple[Dict[str, str], List[str]]:
    violations: List[str] = []
    pkg, err = _read_json(root / "frontend/package.json")
    if err or not isinstance(pkg, dict):
        return {}, [f"[mediabunny-ssot] {err or 'invalid frontend/package.json'}"]
    deps = pkg.get("dependencies") if isinstance(pkg.get("dependencies"), dict) else {}
    raw_ver = deps.get("mediabunny")
    if not isinstance(raw_ver, str):
        return {}, ["[mediabunny-ssot] frontend/package.json dependencies.mediabunny is missing"]
    mb_ver = raw_ver.lstrip("^~").strip()
    if not SEMVER_RE.fullmatch(mb_ver):
        return {}, [f"[mediabunny-ssot] invalid mediabunny semver {raw_ver!r}"]

    notice_text = _read_text(root / "NOTICE")
    if notice_text is None:
        violations.append("[mediabunny-ssot] unable to read NOTICE")
    elif f"Mediabunny {mb_ver}" not in notice_text or f"mediabunny/tree/v{mb_ver}" not in notice_text:
        violations.append(f"[mediabunny-ssot] NOTICE does not match Mediabunny {mb_ver}")

    mpl_rel = Path("frontend/public/licenses/mediabunny-MPL-2.0.txt")
    if not (root / mpl_rel).is_file():
        violations.append(f"[mediabunny-ssot] missing {mpl_rel.as_posix()} license text")

    return {"mediabunny_version": mb_ver}, violations


def check_go_toolchain_parity(root: Path) -> Tuple[Dict[str, str], List[str]]:
    violations: List[str] = []
    gomod_text = _read_text(root / "backend/go.mod")
    if gomod_text is None:
        return {}, ["[go-ssot] unable to read backend/go.mod"]
    matches = GO_TOOLCHAIN_RE.findall(gomod_text)
    if len(matches) != 1:
        return {}, ["[go-ssot] backend/go.mod must declare a single exact 'toolchain goX.Y.Z' directive"]
    go_ver = matches[0]

    wf_rel = Path(".github/workflows/release-build.yml")
    wf_text = _read_text(root / wf_rel)
    if wf_text is None:
        violations.append(f"[go-ssot] unable to read {wf_rel.as_posix()}")
    else:
        if "go-version-file: backend/go.mod" not in wf_text:
            violations.append(f"[go-ssot] {wf_rel.as_posix()} must use 'go-version-file: backend/go.mod'")
        if re.search(r"^\s*go-version\s*:", wf_text, re.MULTILINE):
            violations.append(f"[go-ssot] {wf_rel.as_posix()} must not hardcode 'go-version:'")
        if re.search(r"grep\s+-F\s+['\"]go\d+\.\d+", wf_text):
            violations.append(f"[go-ssot] {wf_rel.as_posix()} must not hardcode a Go version in grep check")
        if not re.search(r"CGO_ENABLED:\s*['\"]?0['\"]?", wf_text):
            violations.append(f"[go-ssot] {wf_rel.as_posix()} build step must set CGO_ENABLED: '0'")
        if "github.ref == 'refs/heads/main'" not in wf_text:
            violations.append(f"[go-ssot] {wf_rel.as_posix()} must restrict execution to refs/heads/main")

    return {"go_toolchain": go_ver}, violations


def check_upstream_runtime_pins(root: Path) -> Tuple[Dict[str, Any], List[str]]:
    try:
        watch = _load_upstream_watch(root)
        pinned = watch.verify_local_pin_consistency(root)
        return {"runtime_pins": pinned, "runtime_lock_files": len(watch.LOCK_FILES)}, []
    except Exception as exc:
        return {}, [f"[runtime-pins] {exc}"]


def check_agent_version_ssot(root: Path) -> Tuple[Dict[str, str], List[str]]:
    violations: List[str] = []
    sec_rel = Path("tools/dokitool-agent/security.py")
    cli_rel = Path("tools/dokitool-agent/dokitool_agent.py")
    mcp_rel = Path("tools/dokitool-agent/mcp_server.py")

    sec_text = _read_text(root / sec_rel)
    if sec_text is None:
        return {}, [f"[agent-ssot] unable to read {sec_rel.as_posix()}"]
    ver_matches = AGENT_VER_RE.findall(sec_text)
    if len(ver_matches) != 1:
        return {}, [f"[agent-ssot] {sec_rel.as_posix()} must define a single AGENT_VERSION constant"]
    agent_ver = ver_matches[0]

    cli_text = _read_text(root / cli_rel)
    if cli_text is None or "AGENT_VERSION" not in cli_text:
        violations.append(f"[agent-ssot] {cli_rel.as_posix()} must import and reuse AGENT_VERSION")

    mcp_text = _read_text(root / mcp_rel)
    if mcp_text is None or "AGENT_VERSION" not in mcp_text:
        violations.append(f"[agent-ssot] {mcp_rel.as_posix()} must import and reuse AGENT_VERSION")
    elif re.search(r'"version"\s*:\s*"\d+\.\d+\.\d+"', mcp_text):
        violations.append(f"[agent-ssot] {mcp_rel.as_posix()} must not hardcode a literal serverInfo version string")

    return {"agent_version": agent_ver}, violations


def check_public_docs_desensitization(root: Path) -> Tuple[Dict[str, int], List[str]]:
    violations: List[str] = []
    targets: List[Path] = []
    for rel in (Path("README.md"), Path("NOTICE"), Path("frontend/public/llms.txt")):
        candidate = root / rel
        if candidate.is_file():
            targets.append(candidate)
    for folder in (root / "docs", root / "tools/dokitool-agent"):
        if folder.is_dir():
            targets.extend(sorted(p for p in folder.rglob("*.md") if p.is_file()))

    for path in targets:
        text = _read_text(path)
        rel_str = path.relative_to(root).as_posix()
        if text is None:
            violations.append(f"[docs-desensitize] unable to read {rel_str}")
            continue
        for label, pattern in DESENSITIZATION_PATTERNS:
            if pattern.search(text):
                violations.append(f"[docs-desensitize] {rel_str} matched prohibited pattern '{label}'")

    return {"docs_scanned": len(targets)}, violations


def check_platform_catalog_ssot(root: Path) -> Tuple[Dict[str, Any], List[str]]:
    violations: List[str] = []
    catalog_rel = Path("backend/config/platforms.json")
    catalog, cat_err = _read_json(root / catalog_rel)
    if cat_err or not isinstance(catalog, list) or not catalog:
        return {}, [f"[platform-ssot] {cat_err or 'backend/config/platforms.json must be a non-empty JSON array'}"]

    catalog_ids: List[str] = []
    for entry in catalog:
        pid = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(pid, str) or not pid.strip():
            violations.append(f"[platform-ssot] {catalog_rel.as_posix()} contains an entry without valid 'id'")
            continue
        catalog_ids.append(pid.strip().lower())
    catalog_set = set(catalog_ids)

    samples_rel = Path("scripts/prod-smoke/samples.json")
    samples, samples_err = _read_json(root / samples_rel)
    if samples_err or not isinstance(samples, dict):
        violations.append(f"[platform-ssot] {samples_err or 'scripts/prod-smoke/samples.json must be a JSON object'}")
    else:
        raw_expected = samples.get("expected_platforms")
        if not isinstance(raw_expected, list):
            violations.append(f"[platform-ssot] {samples_rel.as_posix()}: expected_platforms must be a JSON array")
        else:
            expected_ids = [str(p).strip().lower() for p in raw_expected]
            if len(expected_ids) != len(set(expected_ids)):
                violations.append(f"[platform-ssot] {samples_rel.as_posix()}: expected_platforms contains duplicates")
            expected_set = set(expected_ids)
            missing_in_samples = sorted(catalog_set - expected_set)
            extra_in_samples = sorted(expected_set - catalog_set)
            if missing_in_samples or extra_in_samples:
                violations.append(
                    f"[platform-ssot] {samples_rel.as_posix()} expected_platforms drift vs {catalog_rel.as_posix()}: "
                    f"missing={missing_in_samples} extra={extra_in_samples}"
                )
        sample_entries = samples.get("platforms")
        if not isinstance(sample_entries, dict):
            violations.append(f"[platform-ssot] {samples_rel.as_posix()}: platforms must be a JSON object")
        else:
            for pid in sorted(catalog_set):
                entry = sample_entries.get(pid)
                url = entry.get("url") if isinstance(entry, dict) else None
                if not isinstance(url, str) or not url.startswith(("http://", "https://")):
                    violations.append(
                        f"[platform-ssot] {samples_rel.as_posix()}: missing valid sample url for core platform {pid!r}"
                    )

    generic_rel = Path("backend/internal/platform/ytgeneric/generic_named.go")
    generic_text = _read_text(root / generic_rel)
    if generic_text is None:
        violations.append(f"[platform-ssot] unable to read {generic_rel.as_posix()}")
    else:
        for pid in sorted(catalog_set):
            yt_family = "twitter" if pid == "x" else pid
            if f'"-{yt_family}.*"' not in generic_text:
                violations.append(
                    f"[platform-ssot] {generic_rel.as_posix()}: GenericExtractorArgs missing exclusion \"-{yt_family}.*\" for {pid!r}"
                )
            if f'"{pid}":' not in generic_text:
                violations.append(
                    f"[platform-ssot] {generic_rel.as_posix()}: blockedNormalizedPlatforms missing {pid!r}"
                )
            if pid != "x" and f'"{yt_family}",' not in generic_text:
                violations.append(
                    f"[platform-ssot] {generic_rel.as_posix()}: blockedCoreExtractorFamilies missing {yt_family!r}"
                )

    return {"core_platforms": len(catalog_set)}, violations


def run_all_checks(root: Path = ROOT) -> Dict[str, Any]:
    root = Path(root)
    summary: Dict[str, Any] = {}
    violations: List[str] = []
    for fn in (
        check_extension_and_web_ssot,
        check_mediabunny_parity,
        check_go_toolchain_parity,
        check_upstream_runtime_pins,
        check_agent_version_ssot,
        check_platform_catalog_ssot,
        check_public_docs_desensitization,
    ):
        part, errs = fn(root)
        summary.update(part)
        violations.extend(errs)
    return {
        "passed": len(violations) == 0,
        "checks": 7,
        "summary": summary,
        "violations": violations,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="Repository root directory (defaults to checkout root)",
    )
    args = parser.parse_args(argv)
    report = run_all_checks(args.root)
    if report["passed"]:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    for item in report["violations"]:
        print(f"SSOT violation: {item}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
