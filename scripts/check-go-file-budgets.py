#!/usr/bin/env python3
"""Backend Go single-file line-count ratchet budget gate.

Scans all non-test Go source files under `backend/internal/**/*.go` and
`backend/cmd/**/*.go` (excluding `*_test.go`) and enforces:
  - Default max for any new non-test Go file: 800 lines.
  - Explicit `LEGACY_FILE_LINE_RATCHETS` locking every currently > 800-line
    file at `ceil_to_10(actual_lines + 50)` (+50 to +59 lines of breathing room
    for routine hotfixes, defensive nil/boundary checks, and comments, while
    still hard-blocking 60+ line feature bloat).
  - Cohesive Split Policy (anti-fragmentation):
    * Use the +50-line breathing buffer for routine small fixes and defensive
      guards.
    * NEVER carve out < 60-line non-domain grab-bag files (e.g. `*_helpers2.go`
      or `*_misc.go`) or delete useful comments / compress multiline guards
      solely to dodge a line cap.
    * Only split when a complete protocol or subsystem responsibility crosses
      its ceiling, creating cohesive domain-scoped files.
  - Shrinking a ratcheted file to <= 800 lines PASSES cleanly (emitting an
    informational notice so future refactors never break this gate).
  - Exceeding a ceiling OR leaving a deleted file in `LEGACY_FILE_LINE_RATCHETS`
    fails loudly with exit code 1.

Zero third-party dependencies (Python 3.9+ stdlib only).
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import sys
from typing import Dict, List, Mapping, Optional, Sequence, Set, Tuple

DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[1]
SCAN_DIRS: Tuple[str, ...] = ("backend/internal", "backend/cmd")
DEFAULT_MAX_LINES = 800

# Ceilings set to ceil_to_10(actual_lines + 50) (+50..+59 lines breathing buffer
# for routine fixes/guards/comments; split cohesively by domain once exceeded).
LEGACY_FILE_LINE_RATCHETS: Dict[str, int] = {
    "backend/cmd/dokitool/main.go": 900,
    "backend/cmd/loadtest/main.go": 1360,
    "backend/internal/api/admission.go": 1200,
    "backend/internal/api/apikeys.go": 1020,
    "backend/internal/api/handler.go": 1070,
    "backend/internal/fetch/fetch.go": 890,
    "backend/internal/platform/bilibili/shanghai.go": 920,
    "backend/internal/platform/x/parser.go": 1070,
    "backend/internal/platform/x/syndication.go": 1140,
    "backend/internal/ytengine/engine.go": 950,
    "backend/internal/ytengine/variants.go": 1410,
}


@dataclass(frozen=True)
class BudgetCheckResult:
    passed: bool
    files_checked: int
    ratcheted_checked: int
    violations: Tuple[str, ...]
    notices: Tuple[str, ...]


def count_lines(text: str) -> int:
    """Count lines consistently with POSIX `wc -l` (without splitting on Unicode LS/PS)."""
    if not text:
        return 0
    if text.endswith("\n"):
        text = text[:-1]
    return text.count("\n") + 1


def discover_go_files(root: Path, scan_dirs: Sequence[str] = SCAN_DIRS) -> List[Path]:
    """Return sorted non-test `.go` files under the configured scan directories."""
    files: List[Path] = []
    for rel_dir in scan_dirs:
        base = root / rel_dir
        if not base.is_dir():
            continue
        for path in base.rglob("*.go"):
            if not path.is_file():
                continue
            if path.name.endswith("_test.go"):
                continue
            files.append(path)
    files.sort(key=lambda p: p.relative_to(root).as_posix())
    return files


def check_go_file_budgets(
    root: Path = DEFAULT_REPO_ROOT,
    *,
    default_max_lines: int = DEFAULT_MAX_LINES,
    legacy_ratchets: Optional[Mapping[str, int]] = None,
    scan_dirs: Sequence[str] = SCAN_DIRS,
) -> BudgetCheckResult:
    ratchets: Mapping[str, int] = (
        LEGACY_FILE_LINE_RATCHETS if legacy_ratchets is None else legacy_ratchets
    )
    violations: List[str] = []
    notices: List[str] = []
    seen_ratchets: Set[str] = set()

    go_files = discover_go_files(root, scan_dirs=scan_dirs)
    if not go_files:
        violations.append(
            f"[go-file-budget] no non-test .go files found under {', '.join(scan_dirs)} in {root}"
        )

    for abs_path in go_files:
        rel = abs_path.relative_to(root).as_posix()
        line_count = count_lines(abs_path.read_text(encoding="utf-8"))
        if rel in ratchets:
            seen_ratchets.add(rel)
            ceiling = ratchets[rel]
            if line_count > ceiling:
                violations.append(
                    f"[go-file-ratchet] {rel}: {line_count} lines exceeds legacy ratchet ceiling of "
                    f"{ceiling} (default max {default_max_lines}; split/refactor instead of growing)"
                )
            elif line_count <= default_max_lines:
                notices.append(
                    f"{rel}: shrunk to {line_count} lines (<= {default_max_lines}); "
                    "eligible to remove from LEGACY_FILE_LINE_RATCHETS"
                )
        elif line_count > default_max_lines:
            violations.append(
                f"[go-file-budget] {rel}: {line_count} lines exceeds default max of "
                f"{default_max_lines} lines"
            )

    for rel in sorted(ratchets):
        if rel not in seen_ratchets:
            violations.append(
                f"[go-file-ratchet-stale] {rel}: entry in LEGACY_FILE_LINE_RATCHETS "
                "does not exist among scanned non-test Go files (remove stale entry)"
            )

    return BudgetCheckResult(
        passed=len(violations) == 0,
        files_checked=len(go_files),
        ratcheted_checked=len(seen_ratchets),
        violations=tuple(violations),
        notices=tuple(notices),
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Enforce single-file line-count ratchet budgets on non-test Go files under "
            "backend/internal and backend/cmd."
        )
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_REPO_ROOT,
        help="Repository root directory (defaults to repo root containing scripts/).",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    result = check_go_file_budgets(root=args.root.resolve())

    for note in result.notices:
        print(f"NOTICE: {note}")

    if not result.passed:
        print(
            f"Go file budget check FAILED ({len(result.violations)} violation(s)):",
            file=sys.stderr,
        )
        for violation in result.violations:
            print(f"  - {violation}", file=sys.stderr)
        return 1

    print(
        f"Go file budget check PASSED (files={result.files_checked}, "
        f"ratcheted={result.ratcheted_checked}, defaultMax={DEFAULT_MAX_LINES})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
