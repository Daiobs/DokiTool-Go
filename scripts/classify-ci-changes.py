#!/usr/bin/env python3
"""Fail-closed pull-request path classifier for GitHub Actions workflows.

Maps changed repository paths (from ``git diff --no-renames --name-only -z
<base>...<head>``) to boolean job gates:

- ``run_go``: triggers ``offline-contract`` (Go race suite + L1 golden fixtures
  offline contracts + cross-layer Go->frontend exports + Go builds) and
  ``xhs-dependency-review``.
- ``run_frontend``: triggers ``frontend-and-browser`` (typecheck, L1 + unit tests,
  production build + load budget, and headless Chrome delivery checks).
- ``run_l2_e2e``: triggers the full L2 real-extension 6-prototype + SW upgrade
  deadlock + filename-conflict adversarial headless Chrome E2E suite inside
  ``frontend-and-browser``.

``repo-contracts`` (inventory, Python scripts, smoke tests, OpenAPI, local pin
consistency, static unified schema) always runs independently on every PR.

Any unrecognized path, malformed path, empty diff, or git failure fails closed
with ``run_go=true``, ``run_frontend=true``, and ``run_l2_e2e=true``.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Iterable, Sequence

ROOT = Path(__file__).resolve().parent.parent
COMMIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")

# Paths whose changes can impact both Go and frontend layers or CI gating itself.
FULL_EXACT_PATHS = frozenset(
    {
        ".gitignore",
        "backend/config/platforms.json",
        "frontend/src/monitor/statsTypes.generated.ts",
        "frontend/scripts/test-pipixia-representation.mjs",
        "frontend/scripts/test-shanghai-original.mjs",
        "scripts/classify-ci-changes.py",
        "scripts/check-supply-chain.py",
        "scripts/supply-chain-exceptions.json",
        "scripts/check-ssot-consistency.py",
    }
)
FULL_PREFIXES = (
    ".github/workflows/",
    "docs/schema/",
    "tests/golden-fixtures/",
    "backend/internal/ytengine/",
)

# Frontend & browser-harness core paths that require full L1 + L2 real-extension E2E.
L2_E2E_FRONTEND_PREFIXES = (
    "frontend/src/core/",
    "frontend/src/downloads/",
    "frontend/public/downloads/",
    "frontend/src/extension/",
    "frontend/src/utils/youtube/",
    "frontend/tests/fixtures/download/",
)
L2_E2E_FRONTEND_EXACT_PATHS = frozenset(
    {
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/src/utils/youtubeHelperCore.js",
        "frontend/src/composables/useMediaDownload.ts",
        "frontend/src/services/extensionBridge.ts",
        "frontend/scripts/build-extension.mjs",
        "ops/examples/snap.caddy",
        "scripts/test-download-browser.mjs",
        "scripts/test-extension-e2e.mjs",
        "scripts/download-browser-session.mjs",
        "scripts/test-download-claim.mjs",
    }
)

# Paths outside backend/ that directly feed Go tests or Go export validation.
GO_EXACT_PATHS = frozenset(
    {
        "ops/examples/runtime.example.json",
        "scripts/requirements-validation.txt",
        "scripts/validate-unified-schema.py",
    }
)

# Paths outside frontend/ that directly feed frontend tests or browser fixtures.
FRONTEND_EXACT_PATHS = frozenset(
    {
        "ops/examples/snap.caddy",
        "scripts/test-download-browser.mjs",
        "scripts/test-extension-e2e.mjs",
        "scripts/download-browser-session.mjs",
        "scripts/test-download-claim.mjs",
        "scripts/prod-smoke/stage2_browser.mjs",
        "scripts/prod-smoke/test_stage2_browser.mjs",
    }
)

# Paths covered completely by repo-contracts (inventory/scripts/OpenAPI/docs).
REPO_ONLY_EXACT_PATHS = frozenset(
    {
        "Makefile",
        "README.md",
        "LICENSE",
        "NOTICE",
        "UPSTREAM.json",
        ".gitattributes",
        ".github/upstream-watch-baseline.json",
        "ops/examples/api-keys.example.json",
        "examples/agent_batch_download.py",
    }
)


@dataclass(frozen=True)
class Classification:
    run_go: bool
    run_frontend: bool
    run_l2_e2e: bool
    changed_count: int
    reason: str

    def to_dict(self) -> dict[str, object]:
        return {
            "run_go": self.run_go,
            "run_frontend": self.run_frontend,
            "run_l2_e2e": self.run_l2_e2e,
            "changed_count": self.changed_count,
            "reason": self.reason,
        }


def _normalize_path(raw: str) -> str | None:
    if not raw or "\x00" in raw or "\\" in raw:
        return None
    normalized = raw
    while normalized.startswith("./"):
        normalized = normalized[2:]
    if not normalized or normalized.startswith("/") or normalized.endswith("/"):
        return None
    parts = normalized.split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return normalized


def classify_paths(paths: Iterable[str]) -> Classification:
    raw_list = list(paths)
    if not raw_list:
        return Classification(
            run_go=True,
            run_frontend=True,
            run_l2_e2e=True,
            changed_count=0,
            reason="fail-closed: empty changed file list",
        )

    run_go = False
    run_frontend = False
    run_l2_e2e = False
    reasons: list[str] = []

    def add_reason(label: str) -> None:
        if label not in reasons:
            reasons.append(label)

    for raw in raw_list:
        path = _normalize_path(raw)
        if path is None:
            return Classification(
                run_go=True,
                run_frontend=True,
                run_l2_e2e=True,
                changed_count=len(raw_list),
                reason=f"fail-closed: invalid path {raw!r}",
            )

        if path in FULL_EXACT_PATHS or path.startswith(FULL_PREFIXES):
            run_go = True
            run_frontend = True
            run_l2_e2e = True
            add_reason(f"full:{path}")
            continue

        if path in L2_E2E_FRONTEND_EXACT_PATHS or path.startswith(L2_E2E_FRONTEND_PREFIXES):
            run_frontend = True
            run_l2_e2e = True
            add_reason("frontend-l2-core")
            continue

        if path.startswith("backend/internal/platform/"):
            run_go = True
            add_reason("go-platform-adapter")
            continue

        if path in GO_EXACT_PATHS or path.startswith("backend/"):
            run_go = True
            add_reason("go")
            continue

        if (
            path in FRONTEND_EXACT_PATHS
            or path.startswith("frontend/")
            or (path.startswith("scripts/") and path.endswith((".mjs", ".js")))
        ):
            run_frontend = True
            add_reason("frontend")
            continue

        if path in REPO_ONLY_EXACT_PATHS or path.startswith(("scripts/", "docs/", "tools/dokitool-agent/")):
            add_reason("repo-only")
            continue

        # Unknown top-level or ops path: fail closed so no gate is skipped blindly.
        return Classification(
            run_go=True,
            run_frontend=True,
            run_l2_e2e=True,
            changed_count=len(raw_list),
            reason=f"fail-closed: unclassified path {path}",
        )

    return Classification(
        run_go=run_go,
        run_frontend=run_frontend,
        run_l2_e2e=run_l2_e2e,
        changed_count=len(raw_list),
        reason=",".join(reasons) if reasons else "repo-only",
    )


def changed_files_from_git(repo_root: Path, base_sha: str, head_sha: str) -> tuple[list[str] | None, str | None]:
    if not COMMIT_SHA_RE.fullmatch(base_sha) or not COMMIT_SHA_RE.fullmatch(head_sha):
        return None, f"invalid commit SHA format (base={base_sha!r}, head={head_sha!r})"

    for label, sha in (("base", base_sha), ("head", head_sha)):
        check = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}"],
            cwd=repo_root,
            capture_output=True,
            text=True,
        )
        if check.returncode != 0:
            return None, f"{label} commit {sha} is unavailable in local git history"

    merge_base = subprocess.run(
        ["git", "merge-base", base_sha, head_sha],
        cwd=repo_root,
        capture_output=True,
        text=True,
    )
    if merge_base.returncode != 0 or not merge_base.stdout.strip():
        return None, f"could not compute merge-base for {base_sha}..{head_sha}"

    diff = subprocess.run(
        [
            "git",
            "-c",
            "core.quotepath=false",
            "diff",
            "--no-renames",
            "--name-only",
            "--diff-filter=ACDMRTUXB",
            "-z",
            f"{base_sha}...{head_sha}",
            "--",
        ],
        cwd=repo_root,
        capture_output=True,
    )
    if diff.returncode != 0:
        stderr = diff.stderr.decode("utf-8", errors="replace").strip()
        return None, f"git diff failed: {stderr or diff.returncode}"

    raw_items = [item for item in diff.stdout.split(b"\x00") if item]
    paths = [item.decode("utf-8", errors="surrogateescape") for item in raw_items]
    return paths, None


def write_github_output(output_path: Path, result: Classification) -> None:
    lines = [
        f"run_go={'true' if result.run_go else 'false'}\n",
        f"run_frontend={'true' if result.run_frontend else 'false'}\n",
        f"run_l2_e2e={'true' if result.run_l2_e2e else 'false'}\n",
        f"changed_count={result.changed_count}\n",
    ]
    with output_path.open("a", encoding="utf-8") as fh:
        fh.writelines(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Classify pull-request changed paths for fail-closed CI job gating."
    )
    parser.add_argument("--base", help="Pull request base commit SHA.")
    parser.add_argument("--head", help="Pull request head commit SHA.")
    parser.add_argument(
        "--repo",
        type=Path,
        default=ROOT,
        help="Git repository root (defaults to parent of scripts/).",
    )
    parser.add_argument(
        "--files-stdin",
        action="store_true",
        help="Read newline-delimited changed file paths from stdin instead of running git.",
    )
    parser.add_argument(
        "--github-output",
        type=Path,
        help="Optional GitHub Actions GITHUB_OUTPUT file path to append outputs to.",
    )
    args = parser.parse_args(argv)

    if args.files_stdin:
        paths = [line.rstrip("\r\n") for line in sys.stdin if line.rstrip("\r\n")]
        result = classify_paths(paths)
    else:
        if not args.base or not args.head:
            parser.error("Provide --base and --head, or pass --files-stdin")
        paths, err = changed_files_from_git(args.repo, args.base, args.head)
        if err is not None or paths is None:
            print(f"::warning::CI path classifier failing closed: {err}", file=sys.stderr)
            result = Classification(
                run_go=True,
                run_frontend=True,
                run_l2_e2e=True,
                changed_count=0,
                reason=f"fail-closed: {err}",
            )
        else:
            result = classify_paths(paths)

    if args.github_output is not None:
        write_github_output(args.github_output, result)

    print(json.dumps(result.to_dict(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
