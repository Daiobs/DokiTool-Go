#!/usr/bin/env python3
"""Zero-config fail-closed repository hygiene & forbidden-file guard.

Scans all tracked/staged paths from `git ls-files -z` and rejects:
1. Unsafe relative paths, symlinks, symlink/junction ancestors, or files escaping the repo root;
2. Local/generated/dependency directories (`.git`, `.local`, `.tools`, `.gemini`,
   `node_modules`, `__pycache__`, `artifacts`, `evidence`, `dist`, `dist-extension`, `scratch`);
3. Sensitive configuration or key material (`.env` / `.env.*` other than `.env.example`,
   `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, non-example `api-keys.json`,
   `ops/*credential*`, and non-example credential/secret config files);
4. High-confidence leaked credentials inside tracked UTF-8 text files (private key headers,
   GitHub PATs, AWS Access Key IDs, non-placeholder Bearer or DokiTool API/Owner tokens);
5. Compiled artifacts (`*.pyc`, `*.pyo`, `*.so`, `*.dylib`, `*.dll`, `*.exe`, `*.test`)
   and oversized files (> 5 MiB).

Zero third-party dependencies (Python 3.9+ stdlib only).
"""
from __future__ import annotations

import argparse
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Sequence

ROOT = Path(__file__).resolve().parents[1]
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_TESTDATA_JSON_SCAN_BYTES = 256 * 1024

FORBIDDEN_DIR_PARTS = frozenset({
    '.git',
    '.local',
    '.tools',
    '.gemini',
    'node_modules',
    '__pycache__',
    'artifacts',
    'evidence',
    'dist',
    'dist-extension',
    'scratch',
})

SENSITIVE_EXTENSIONS = frozenset({'.pem', '.key', '.p12', '.pfx'})
CREDENTIAL_CONFIG_SUFFIXES = frozenset({'.txt', '.json', '.conf', '.cfg', '.ini', '.yaml', '.yml'})
SAFE_CREDENTIAL_NAME_DIRS = frozenset({'docs', 'tests', 'testdata'})
FORBIDDEN_ARTIFACT_EXTENSIONS = frozenset({'.pyc', '.pyo', '.so', '.dylib', '.dll', '.exe', '.test'})

CONTENT_SCAN_EXEMPT_PATHS = frozenset({
    'scripts/check-public-files.py',
    'scripts/tests/test_public_files.py',
    'scripts/check-ssot-consistency.py',
    'scripts/tests/test_check_ssot_consistency.py',
})

HIGH_CONFIDENCE_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ('private-key', re.compile(r'-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----')),
    ('github-pat', re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{22,})\b')),
    ('aws-access-key', re.compile(r'\bAKIA[0-9A-Z]{16}\b')),
    (
        'bearer-token',
        re.compile(
            r'Authorization:\s*Bearer\s+'
            r'(?!<|\$|EXAMPLE|YOUR|TOKEN|REDACTED|PLACEHOLDER|DUMMY|FAKE|TEST[_-])'
            r'[A-Za-z0-9._~+/=-]{24,}',
            re.IGNORECASE,
        ),
    ),
    (
        'dokitool-token',
        re.compile(
            r'''\bDOKITOOL_(?:OWNER|API)_TOKEN\s*=\s*['"]?'''
            r'(?!<|\$|EXAMPLE|YOUR|TOKEN|REDACTED|PLACEHOLDER|CHANGE_ME|REPLACE|DUMMY|FAKE|TEST[_-])'
            r'[A-Za-z0-9._~+/=-]{16,}',
            re.IGNORECASE,
        ),
    ),
)


def git(*arguments: str, root: Path = ROOT) -> bytes:
    return subprocess.check_output(
        ['git', '-c', f'safe.directory={root.as_posix()}', *arguments],
        cwd=root,
    )


def _check_sensitive_or_artifact_name(relative: PurePosixPath) -> None:
    name = relative.name
    lower = name.lower()
    if (lower == '.env' or lower.startswith('.env.')) and lower != '.env.example':
        raise ValueError(f'Only .env.example is allowed: {relative.as_posix()}')
    if lower.startswith('id_rsa') or lower.startswith('id_ed25519'):
        raise ValueError(f'Private SSH key material is forbidden: {relative.as_posix()}')
    if lower == 'api-keys.json' or (
        'api-keys' in lower and lower.endswith('.json') and not lower.endswith('.example.json')
    ):
        raise ValueError(f'Non-example API key file is forbidden: {relative.as_posix()}')
    suffix = relative.suffix.lower()
    if suffix in SENSITIVE_EXTENSIONS:
        raise ValueError(f'Sensitive key/certificate file is forbidden: {relative.as_posix()}')
    if suffix in FORBIDDEN_ARTIFACT_EXTENSIONS:
        raise ValueError(f'Compiled/binary artifact is forbidden: {relative.as_posix()}')
    is_example = '.example.' in lower or lower.endswith('.example')
    in_safe_dir = any(part in SAFE_CREDENTIAL_NAME_DIRS for part in relative.parts[:-1])
    if not is_example and not in_safe_dir:
        if relative.parts[0] == 'ops' and 'credential' in lower:
            raise ValueError(f'Credential file under ops/ is forbidden: {relative.as_posix()}')
        if ('secret' in lower or 'credential' in lower) and suffix in CREDENTIAL_CONFIG_SUFFIXES:
            raise ValueError(f'Sensitive credential/secret config file is forbidden: {relative.as_posix()}')


def _check_high_confidence_secrets(relative: PurePosixPath, source: Path, size: int) -> None:
    rel_posix = relative.as_posix()
    if rel_posix in CONTENT_SCAN_EXEMPT_PATHS:
        return
    if (
        relative.suffix.lower() == '.json'
        and 'testdata' in relative.parts[:-1]
        and size > MAX_TESTDATA_JSON_SCAN_BYTES
    ):
        return
    raw = source.read_bytes()
    if b'\x00' in raw[:8192]:
        return
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        return
    for label, pattern in HIGH_CONFIDENCE_SECRET_PATTERNS:
        if pattern.search(text):
            raise ValueError(f'High-confidence credential pattern ({label}) detected in {rel_posix}')


def validate_paths(paths: Sequence[str], *, root: Path = ROOT) -> None:
    if not paths or list(paths) != sorted(set(paths)):
        raise ValueError('tracked file list must be nonempty, sorted, and free of duplicates')
    resolved_root = root.resolve()
    for name in paths:
        relative = PurePosixPath(name)
        if '\\' in name or relative.is_absolute() or '..' in relative.parts or relative.as_posix() != name:
            raise ValueError(f'Invalid relative path: {name}')
        if any(part in FORBIDDEN_DIR_PARTS for part in relative.parts):
            raise ValueError(f'Forbidden directory in repository index: {name}')
        _check_sensitive_or_artifact_name(relative)
        source = root / name
        if source.is_symlink():
            raise ValueError(f'Symlink is not permitted: {name}')
        for ancestor in source.parents:
            if ancestor == root:
                break
            if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
                raise ValueError(f'Linked parent is not permitted: {name}')
        if not source.is_file() or not source.resolve().is_relative_to(resolved_root):
            raise ValueError(f'Missing or external file: {name}')
        size = source.stat().st_size
        if size > MAX_FILE_BYTES:
            raise ValueError(
                f'Oversized file exceeds {MAX_FILE_BYTES} byte limit ({size} bytes): {name}'
            )
        _check_high_confidence_secrets(relative, source, size)


def run_check(argv: Sequence[str] | None = None, *, root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--staged',
        action='store_true',
        help='Also require tracked working tree files to have zero unstaged diffs against the Git index',
    )
    args = parser.parse_args(argv)

    tracked = sorted(
        name.decode('utf-8')
        for name in git('ls-files', '-z', root=root).split(b'\0')
        if name
    )
    validate_paths(tracked, root=root)

    if args.staged:
        unstaged = git('diff', '--name-only', '-z', root=root)
        if unstaged:
            raise ValueError('Tracked working files differ from the reviewed index')

    print(
        f'Public file guard verified: {len(tracked)} tracked files'
        + ('; working tree clean' if args.staged else '')
    )
    return 0


def main() -> int:
    return run_check()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f'Public file guard failed: {error}', file=sys.stderr)
        sys.exit(1)
