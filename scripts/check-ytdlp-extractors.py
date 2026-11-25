#!/usr/bin/env python3
"""Verify X/Twitter yt-dlp extractor classification has zero drift.

Parses AllowedExtractors() and ExcludedExtractors() from
backend/internal/platform/x/parser.go and asserts against the live
`yt-dlp --list-extractors` inventory (or an offline --extractors-file):
  1. Allowed ∩ Excluded == ∅ (and neither list has duplicates or empty entries)
  2. Allowed ∪ Excluded == {all twitter* extractors reported by yt-dlp}
     (case-insensitive, stripping trailing `(CURRENTLY BROKEN)` markers).

Zero third-party dependencies (Python 3.9+ stdlib only).
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import re
import subprocess
import sys
from typing import Iterable, List, Optional, Sequence, Set, Tuple

DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[1]
PARSER_REL_PATH = Path("backend/internal/platform/x/parser.go")
BROKEN_SUFFIX_RE = re.compile(r"\s*\(currently broken\)\s*$", re.IGNORECASE)
FUNC_HEADER_TEMPLATE = r"\bfunc\s+{name}\s*\(\s*\)\s*\[\s*\]\s*string\s*\{{"
STRING_LITERAL_RE = re.compile(r'"((?:\\.|[^"\\])*)"')


@dataclass(frozen=True)
class DriftCheckResult:
    passed: bool
    allowed: Tuple[str, ...]
    excluded: Tuple[str, ...]
    ytdlp_twitter: Tuple[str, ...]
    errors: Tuple[str, ...]


def strip_go_comments(source: str) -> str:
    """Strip Go // and /* */ comments while preserving string/raw-string literals."""
    out: List[str] = []
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if ch == '"':
            out.append(ch)
            i += 1
            while i < n:
                c = source[i]
                out.append(c)
                if c == "\\" and i + 1 < n:
                    i += 1
                    out.append(source[i])
                elif c == '"':
                    i += 1
                    break
                i += 1
        elif ch == "`":
            out.append(ch)
            i += 1
            while i < n:
                c = source[i]
                out.append(c)
                i += 1
                if c == "`":
                    break
        elif ch == "'":
            out.append(ch)
            i += 1
            while i < n:
                c = source[i]
                out.append(c)
                if c == "\\" and i + 1 < n:
                    i += 1
                    out.append(source[i])
                elif c == "'":
                    i += 1
                    break
                i += 1
        elif ch == "/" and nxt == "/":
            i += 2
            while i < n and source[i] != "\n":
                i += 1
        elif ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (source[i] == "*" and source[i + 1] == "/"):
                if source[i] == "\n":
                    out.append("\n")
                i += 1
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _extract_balanced_braces(text: str, open_brace_idx: int) -> str:
    depth = 0
    i = open_brace_idx
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            i += 1
            while i < n:
                if text[i] == "\\" and i + 1 < n:
                    i += 2
                    continue
                if text[i] == '"':
                    i += 1
                    break
                i += 1
            continue
        if ch == "`":
            i += 1
            while i < n and text[i] != "`":
                i += 1
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[open_brace_idx + 1 : i]
        i += 1
    raise ValueError("unterminated brace block in Go source")


def _extract_string_slice_func(cleaned_source: str, func_name: str) -> List[str]:
    pattern = re.compile(FUNC_HEADER_TEMPLATE.format(name=re.escape(func_name)))
    match = pattern.search(cleaned_source)
    if match is None:
        raise ValueError(f"missing `func {func_name}() []string` in {PARSER_REL_PATH.as_posix()}")

    open_brace_idx = match.end() - 1
    body = _extract_balanced_braces(cleaned_source, open_brace_idx)

    ret_match = re.search(r"\breturn\s+\[\s*\]\s*string\s*\{", body)
    if ret_match is None:
        raise ValueError(
            f"`func {func_name}() []string` does not return a `[]string{{...}}` literal"
        )
    slice_body = _extract_balanced_braces(body, ret_match.end() - 1)
    return [m.group(1) for m in STRING_LITERAL_RE.finditer(slice_body)]


def parse_go_extractor_lists(parser_path: Path) -> Tuple[List[str], List[str]]:
    """Parse AllowedExtractors() and ExcludedExtractors() from parser.go."""
    if not parser_path.is_file():
        raise FileNotFoundError(f"parser.go not found: {parser_path}")
    raw = parser_path.read_text(encoding="utf-8")
    cleaned = strip_go_comments(raw)
    allowed = _extract_string_slice_func(cleaned, "AllowedExtractors")
    excluded = _extract_string_slice_func(cleaned, "ExcludedExtractors")
    return allowed, excluded


def normalize_extractor_name(raw_line: str) -> str:
    """Normalize a yt-dlp extractor line (strip `(CURRENTLY BROKEN)` and lowercase)."""
    cleaned = BROKEN_SUFFIX_RE.sub("", raw_line.strip()).strip()
    return cleaned.lower()


def parse_ytdlp_twitter_extractors(lines: Iterable[str]) -> Set[str]:
    """Extract all case-insensitive `twitter*` extractor names from yt-dlp output."""
    found: Set[str] = set()
    for line in lines:
        name = normalize_extractor_name(line)
        if not name:
            continue
        if name.startswith("twitter"):
            found.add(name)
    return found


def load_extractors_from_binary(ytdlp_binary: Path, timeout_seconds: int = 60) -> List[str]:
    if not ytdlp_binary.is_file():
        raise FileNotFoundError(f"yt-dlp binary not found: {ytdlp_binary}")
    try:
        proc = subprocess.run(
            [str(ytdlp_binary), "--list-extractors"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
    except OSError as exc:
        raise RuntimeError(f"failed to execute yt-dlp binary {ytdlp_binary}: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(
            f"yt-dlp --list-extractors timed out after {timeout_seconds}s"
        ) from exc

    if proc.returncode != 0:
        stderr_snippet = proc.stderr.strip().splitlines()[-3:] if proc.stderr else []
        detail = " | ".join(stderr_snippet) or f"exit code {proc.returncode}"
        raise RuntimeError(f"yt-dlp --list-extractors failed ({detail})")
    return proc.stdout.splitlines()


def check_ytdlp_extractors(
    *,
    root: Path = DEFAULT_REPO_ROOT,
    extractor_lines: Iterable[str],
) -> DriftCheckResult:
    errors: List[str] = []
    parser_path = root / PARSER_REL_PATH

    try:
        raw_allowed, raw_excluded = parse_go_extractor_lists(parser_path)
    except (OSError, ValueError) as exc:
        return DriftCheckResult(
            passed=False,
            allowed=(),
            excluded=(),
            ytdlp_twitter=(),
            errors=(str(exc),),
        )

    def _validate_list(label: str, items: Sequence[str]) -> Tuple[List[str], Set[str]]:
        normalized_list: List[str] = []
        seen: Set[str] = set()
        for raw in items:
            norm = normalize_extractor_name(raw)
            if not norm:
                errors.append(f"{label} contains an empty extractor entry")
                continue
            if norm in seen:
                errors.append(f"{label} contains duplicate extractor {norm!r}")
                continue
            seen.add(norm)
            normalized_list.append(norm)
        return normalized_list, seen

    allowed_list, allowed_set = _validate_list("AllowedExtractors()", raw_allowed)
    excluded_list, excluded_set = _validate_list("ExcludedExtractors()", raw_excluded)

    if not allowed_set:
        errors.append("AllowedExtractors() must not be empty")

    ytdlp_twitter = parse_ytdlp_twitter_extractors(extractor_lines)
    if not ytdlp_twitter:
        errors.append(
            "yt-dlp extractor inventory contained zero `twitter*` extractors (refusing to pass fail-open)"
        )

    overlap = sorted(allowed_set & excluded_set)
    if overlap:
        errors.append(
            f"AllowedExtractors() ∩ ExcludedExtractors() must be empty, found overlap: {', '.join(overlap)}"
        )

    union = allowed_set | excluded_set
    unclassified = sorted(ytdlp_twitter - union)
    if unclassified:
        errors.append(
            "yt-dlp reports unclassified twitter* extractor(s) missing from AllowedExtractors()/ExcludedExtractors(): "
            + ", ".join(unclassified)
        )

    stale = sorted(union - ytdlp_twitter)
    if stale:
        errors.append(
            "AllowedExtractors()/ExcludedExtractors() lists stale extractor(s) absent from yt-dlp --list-extractors: "
            + ", ".join(stale)
        )

    return DriftCheckResult(
        passed=len(errors) == 0,
        allowed=tuple(sorted(allowed_set)),
        excluded=tuple(sorted(excluded_set)),
        ytdlp_twitter=tuple(sorted(ytdlp_twitter)),
        errors=tuple(errors),
    )


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Verify AllowedExtractors() and ExcludedExtractors() in "
            "backend/internal/platform/x/parser.go partition yt-dlp's twitter* extractors."
        )
    )
    source_group = parser.add_mutually_exclusive_group(required=True)
    source_group.add_argument(
        "--ytdlp",
        type=Path,
        help="Path to the pinned yt-dlp binary to invoke with --list-extractors.",
    )
    source_group.add_argument(
        "--extractors-file",
        type=Path,
        help="Path to a newline-delimited extractor list file (offline unit tests).",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_REPO_ROOT,
        help="Repository root containing backend/internal/platform/x/parser.go.",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_arg_parser().parse_args(argv)
    try:
        if args.ytdlp is not None:
            lines = load_extractors_from_binary(args.ytdlp)
        else:
            if not args.extractors_file.is_file():
                raise FileNotFoundError(
                    f"extractors file not found: {args.extractors_file}"
                )
            lines = args.extractors_file.read_text(encoding="utf-8").splitlines()
    except (OSError, RuntimeError) as exc:
        print(f"yt-dlp extractor drift check FAILED:\n  - {exc}", file=sys.stderr)
        return 1

    result = check_ytdlp_extractors(root=args.root.resolve(), extractor_lines=lines)
    if not result.passed:
        print(
            f"yt-dlp extractor drift check FAILED ({len(result.errors)} error(s)):",
            file=sys.stderr,
        )
        for err in result.errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print(
        "yt-dlp extractor drift check PASSED "
        f"(allowed={len(result.allowed)}, excluded={len(result.excluded)}, "
        f"ytdlp_twitter={len(result.ytdlp_twitter)})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
