#!/usr/bin/env python3
"""Evaluate scheduled upstream canary reports and manage one debounced GitHub alert Issue.

Uses only the Python 3.9+ standard library. Never downloads or executes upstream code,
never sends Cookie headers or owner tokens, enforces fail-closed desensitization on every
outgoing Issue/comment payload, and applies 2-consecutive-failure debouncing with
fingerprint deduplication and automatic recovery closure.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import html
import ipaddress
import json
import os
from pathlib import Path
import re
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple
import urllib.error
import urllib.parse
import urllib.request

TARGET = 'Daiobs/DokiTool-Go'
OWNER = 'Daiobs'
BOT = 'github-actions[bot]'
WORKFLOW_FILE = 'upstream-canary.yml'
TITLE = 'DokiTool-Go 上游 Canary 巡检告警'
SCHEMA_VERSION = 1
MARKER = '<!-- dokitool-upstream-canary-state:v1:'
STATE_RE = re.compile(re.escape(MARKER) + r'([A-Za-z0-9+/=]+) -->')
DEFAULT_DEBOUNCE_THRESHOLD = 2
REQUIRED_SMOKE_GROUPS: Tuple[str, ...] = ('platforms', 'youtube_context', 'api_boundary')
WORKFLOW_RUNS_PATH = (
    f'/repos/{TARGET}/actions/workflows/{WORKFLOW_FILE}/runs?branch=main&event=schedule&status=completed&per_page=10'
)
MAX_REPORT_BYTES = 2 * 1024 * 1024
MAX_API_BYTES = 8 * 1024 * 1024
MAX_BODY_BYTES = 65000
SHANGHAI = dt.timezone(dt.timedelta(hours=8))

PLAYER_ID_RE = re.compile(r'^[0-9a-f]{8}\Z', re.ASCII)
ERROR_CODE_RE = re.compile(r'^[A-Z0-9_]{0,64}\Z', re.ASCII)
SEMVER_OPT_RE = re.compile(r'^(?:\d+\.\d+\.\d+)?\Z', re.ASCII)
FINGERPRINT_RE = re.compile(r'^[0-9a-f]{16}\Z', re.ASCII)
CHECK_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,80}\Z', re.ASCII)
GROUP_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,40}\Z', re.ASCII)
SMOKE_CODE_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,64}\Z', re.ASCII)
VALID_DENO_STATUSES = frozenset(
    {'ok', 'degraded_tv_only', 'degraded_main_only', 'outage', 'report_error', 'probe_exit_error'}
)
VALID_SMOKE_STATUSES = frozenset({'PASS', 'WARN', 'SAMPLE_STALE', 'FAIL', 'SKIP'})
FAILURE_CONCLUSIONS = frozenset({'failure', 'timed_out', 'startup_failure', 'action_required'})
IGNORED_CONCLUSIONS = frozenset({'cancelled', 'skipped', 'neutral'})

_URL_RE = re.compile(r'(?i)\b(?:https?|wss?|file)://[^\s"\'<>`|)\]]+')
_ALLOWED_GITHUB_URL_RE = re.compile(
    r'^https://github\.com/'
    + re.escape(TARGET)
    + r'(?:/(?:actions/runs/[0-9]+|issues/[1-9][0-9]*|blob/main/docs/[A-Za-z0-9_.-]+))?\Z',
    re.ASCII,
)
_LOCAL_PATH_RE = re.compile(
    r'(?i)(?:(?:^|[\s`"\'(\[,:])/(?:Users|home|var|tmp|opt)/|[A-Za-z]:\\|\bfile:/{2}|\.(?:gemini)/|\bbr(?:ain)/)'
)
_BEARER_RE = re.compile(r'(?i)\bBearer\s')
_GITHUB_TOKEN_RE = re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b')
_SENSITIVE_KEY_RE = re.compile(
    r'(?i)\b(?:owner_token|access_token|xsec_token|xsec_source|auth_key|hdnts|authorization|cookie)\s*[=:]'
)
_SIGNED_PARAM_RE = re.compile(
    r'(?i)(?:[?&]|\b)(?:sig|upsig|signature|sign|ticket|ip|expire|expires|token|key)\s*='
)
_IPV4_CANDIDATE_RE = re.compile(r'(?<![0-9A-Za-z.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9A-Za-z.])')
_IPV6_CANDIDATE_RE = re.compile(
    r'\[?(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:])\]?'
)

DENO_STATUS_LABELS = {
    'ok': '正常（tv + main 均通过）',
    'degraded_tv_only': '降级（tv 主变体失败，main 兜底通过）',
    'degraded_main_only': '降级（main 变体回归，tv 主变体通过）',
    'outage': '中断（tv 与 main 均失败）',
    'report_error': '报告异常（缺失或格式非法）',
    'probe_exit_error': '探针进程异常退出',
}


class CanaryError(RuntimeError):
    """Configuration, GitHub API, state integrity, or security boundary error."""


class DesensitizationError(CanaryError):
    """Raised fail-closed if sensitive data is detected in outgoing public text."""


def safe_text(value: Any, limit: int = 120) -> str:
    """Keep rendered strings free of mentions, Markdown injection, or raw HTML."""
    raw = ''.join(ch if ch.isprintable() else ' ' for ch in str(value))[:limit]
    raw = raw.replace('@', '＠')
    raw = re.sub(r'([\\`*_{}\[\]()#+.!|~\-])', r'\\\1', raw)
    return html.escape(raw, quote=True)


def checked_text(value: Any, description: str, maximum: int = 2048) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise CanaryError('Invalid ' + description)
    return value


def parse_timestamp(value: Any, description: str) -> dt.datetime:
    raw = checked_text(value, description, 64)
    normalized = raw[:-1] + '+00:00' if raw.endswith(('Z', 'z')) else raw
    try:
        parsed = dt.datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            raise ValueError('Timestamp lacks a timezone')
    except (AttributeError, TypeError, ValueError) as exc:
        raise CanaryError('Invalid ' + description) from exc
    return parsed


def _is_ip_literal(value: str) -> bool:
    candidate = value.strip()
    if candidate.startswith('[') and candidate.endswith(']'):
        candidate = candidate[1:-1]
    if '%' in candidate:
        candidate = candidate.split('%', 1)[0]
    if not candidate:
        return False
    try:
        ipaddress.ip_address(candidate)
        return True
    except ValueError:
        return False


def assert_desensitized(text: str, *, description: str = 'outgoing text') -> str:
    """Fail closed if local paths, IPs, tokens, signed URL params, or non-allowlisted URLs appear."""
    if not isinstance(text, str):
        raise DesensitizationError(f'{description} must be a string')
    if len(text.encode('utf-8')) > MAX_BODY_BYTES:
        raise DesensitizationError(f'{description} exceeds maximum byte size')
    scan_text = text
    if MARKER in scan_text:
        try:
            extract_state(scan_text)
        except CanaryError as exc:
            raise DesensitizationError(f'Invalid canary state marker in {description}: {exc}') from exc
        scan_text = STATE_RE.sub(' ', scan_text)
    if _LOCAL_PATH_RE.search(scan_text):
        raise DesensitizationError(f'Forbidden local filesystem path detected in {description}')
    if _BEARER_RE.search(scan_text):
        raise DesensitizationError(f'Forbidden Bearer credential marker detected in {description}')
    if _GITHUB_TOKEN_RE.search(scan_text):
        raise DesensitizationError(f'Forbidden token literal detected in {description}')
    if _SENSITIVE_KEY_RE.search(scan_text):
        raise DesensitizationError(f'Forbidden sensitive header/token key detected in {description}')
    if _SIGNED_PARAM_RE.search(scan_text):
        raise DesensitizationError(f'Forbidden signed URL parameter detected in {description}')
    for match in _URL_RE.finditer(scan_text):
        candidate_url = match.group(0).rstrip('.,;:')
        if not _ALLOWED_GITHUB_URL_RE.fullmatch(candidate_url):
            raise DesensitizationError(f'Forbidden non-allowlisted URL detected in {description}')
    for match in _IPV4_CANDIDATE_RE.finditer(scan_text):
        if _is_ip_literal(match.group(0)):
            raise DesensitizationError(f'Forbidden IPv4 literal detected in {description}')
    for match in _IPV6_CANDIDATE_RE.finditer(scan_text):
        token = match.group(0)
        inner = token[1:-1] if token.startswith('[') and token.endswith(']') else token
        if _is_ip_literal(inner):
            raise DesensitizationError(f'Forbidden IPv6 literal detected in {description}')
    return text


def normalize_state(state: Any) -> Dict[str, Any]:
    if not isinstance(state, dict) or state.get('schema') != SCHEMA_VERSION:
        raise CanaryError('Unsupported canary state schema')
    status = state.get('status')
    if status not in ('failing', 'recovered'):
        raise CanaryError('Invalid canary state status')
    fingerprint = state.get('fingerprint')
    if status == 'failing':
        if not isinstance(fingerprint, str) or not FINGERPRINT_RE.fullmatch(fingerprint):
            raise CanaryError('Failing canary state must carry a 16-hex fingerprint')
    else:
        if fingerprint not in ('', None):
            raise CanaryError('Recovered canary state must have an empty fingerprint')
        fingerprint = ''
    consecutive = state.get('consecutive_failures')
    if type(consecutive) is not int or consecutive < 0 or consecutive > 10000:
        raise CanaryError('Invalid consecutive_failures in canary state')
    observed_at = checked_text(state.get('observed_at'), 'canary observed_at', 64)
    parse_timestamp(observed_at, 'canary observed_at')
    player_id = state.get('player_id', '')
    if not isinstance(player_id, str) or (player_id != '' and not PLAYER_ID_RE.fullmatch(player_id)):
        raise CanaryError('Invalid player_id in canary state')
    deno_status = state.get('deno_status')
    if deno_status not in VALID_DENO_STATUSES:
        raise CanaryError('Invalid deno_status in canary state')
    smoke_ok = state.get('smoke_ok')
    if type(smoke_ok) is not bool:
        raise CanaryError('Invalid smoke_ok in canary state')
    normalized = {
        'schema': SCHEMA_VERSION,
        'status': status,
        'fingerprint': fingerprint,
        'consecutive_failures': consecutive,
        'observed_at': observed_at,
        'player_id': player_id,
        'deno_status': deno_status,
        'smoke_ok': smoke_ok,
    }
    raw_json = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    assert_desensitized(raw_json, description='canary state marker JSON')
    return normalized


def state_marker(state: Dict[str, Any]) -> str:
    raw = json.dumps(
        normalize_state(state), ensure_ascii=False, sort_keys=True, separators=(',', ':')
    ).encode('utf-8')
    return MARKER + base64.b64encode(raw).decode('ascii') + ' -->'


def extract_state(body: Any) -> Dict[str, Any]:
    if not isinstance(body, str) or MARKER not in body:
        raise CanaryError('Canary state marker is missing')
    matches = STATE_RE.findall(body)
    if len(matches) != 1 or body.count(MARKER) != 1:
        raise CanaryError('Canary state marker is malformed or duplicated')
    try:
        decoded = base64.b64decode(matches[0], validate=True).decode('utf-8')
        return normalize_state(json.loads(decoded))
    except (ValueError, UnicodeError) as exc:
        raise CanaryError('Canary state marker could not be decoded') from exc


def _read_bounded_json(path: Optional[Path]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if path is None:
        return None, 'REPORT_MISSING'
    try:
        with open(path, 'rb') as handle:
            raw = handle.read(MAX_REPORT_BYTES + 1)
    except FileNotFoundError:
        return None, 'REPORT_MISSING'
    except OSError:
        return None, 'REPORT_UNREADABLE'
    if not raw or len(raw) > MAX_REPORT_BYTES:
        return None, 'REPORT_MALFORMED'
    try:
        parsed = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, 'REPORT_MALFORMED'
    if not isinstance(parsed, dict):
        return None, 'REPORT_MALFORMED'
    return parsed, None


def _derive_deno_status(tv_ok: bool, main_ok: bool) -> str:
    if tv_ok and main_ok:
        return 'ok'
    if not tv_ok and main_ok:
        return 'degraded_tv_only'
    if tv_ok and not main_ok:
        return 'degraded_main_only'
    return 'outage'


def _deno_report_error(code: str) -> Dict[str, Any]:
    return {
        'ok': False,
        'status': 'report_error',
        'player_id': '',
        'tv_ok': False,
        'main_ok': False,
        'tv_error_code': code,
        'main_error_code': code,
        'discovery_error_code': code,
        'elapsed_ms': 0,
        'deno_version': '',
        'ejs_version': '',
        'report_error': code,
    }


def load_deno_report(path: Optional[Path], *, exit_code: Optional[int] = None) -> Dict[str, Any]:
    """Load and validate the sanitized Deno/EJS canary JSON report (fail-closed)."""
    data, read_err = _read_bounded_json(path)
    if read_err is not None or data is None:
        return _deno_report_error(read_err or 'REPORT_MISSING')

    player_id = data.get('player_id')
    tv_ok = data.get('tv_ok')
    main_ok = data.get('main_ok')
    tv_err = data.get('tv_error_code')
    main_err = data.get('main_error_code')
    disc_err = data.get('discovery_error_code', '')
    elapsed_ms = data.get('elapsed_ms')
    deno_version = data.get('deno_version')
    ejs_version = data.get('ejs_version', '')
    overall_ok = data.get('overall_ok')

    if (
        not isinstance(player_id, str)
        or (player_id != '' and not PLAYER_ID_RE.fullmatch(player_id))
        or type(tv_ok) is not bool
        or type(main_ok) is not bool
        or type(overall_ok) is not bool
        or overall_ok != (tv_ok and main_ok)
        or not isinstance(tv_err, str)
        or not ERROR_CODE_RE.fullmatch(tv_err)
        or not isinstance(main_err, str)
        or not ERROR_CODE_RE.fullmatch(main_err)
        or not isinstance(disc_err, str)
        or not ERROR_CODE_RE.fullmatch(disc_err)
        or type(elapsed_ms) is not int
        or elapsed_ms < 0
        or not isinstance(deno_version, str)
        or not SEMVER_OPT_RE.fullmatch(deno_version)
        or not isinstance(ejs_version, str)
        or not SEMVER_OPT_RE.fullmatch(ejs_version)
    ):
        return _deno_report_error('REPORT_MALFORMED')

    expected_status = _derive_deno_status(tv_ok, main_ok)
    raw_status = data.get('status')
    if raw_status is not None and raw_status != expected_status:
        return _deno_report_error('REPORT_MALFORMED')

    result = {
        'ok': overall_ok,
        'status': expected_status,
        'player_id': player_id,
        'tv_ok': tv_ok,
        'main_ok': main_ok,
        'tv_error_code': tv_err,
        'main_error_code': main_err,
        'discovery_error_code': disc_err,
        'elapsed_ms': elapsed_ms,
        'deno_version': deno_version,
        'ejs_version': ejs_version,
        'report_error': '',
    }

    if exit_code is not None and exit_code != 0 and result['ok']:
        code = f'PROBE_EXIT_{abs(int(exit_code))}'
        result.update(
            ok=False,
            status='probe_exit_error',
            report_error=code,
        )
    return result


def _smoke_report_error(code: str) -> Dict[str, Any]:
    return {
        'ok': False,
        'report_error': code,
        'checks': [],
        'failed_checks': [
            {
                'id': 'smoke_report',
                'group': 'smoke',
                'status': 'FAIL',
                'code': code,
                'http_status': None,
                'elapsed_ms': 0,
            }
        ],
        'warn_checks': [],
    }


def load_smoke_report(
    path: Optional[Path],
    *,
    exit_code: Optional[int] = None,
    required_groups: Sequence[str] = REQUIRED_SMOKE_GROUPS,
) -> Dict[str, Any]:
    """Load and validate the sanitized prod-smoke JSON report (fail-closed)."""
    data, read_err = _read_bounded_json(path)
    if read_err is not None or data is None:
        return _smoke_report_error(read_err or 'REPORT_MISSING')

    if data.get('schema_version') != '1.0':
        return _smoke_report_error('REPORT_MALFORMED')
    passed = data.get('passed')
    summary = data.get('summary')
    raw_checks = data.get('checks')
    if (
        type(passed) is not bool
        or not isinstance(summary, dict)
        or type(summary.get('fail')) is not int
        or summary['fail'] < 0
        or not isinstance(raw_checks, list)
        or not raw_checks
    ):
        return _smoke_report_error('REPORT_MALFORMED')

    checks: List[Dict[str, Any]] = []
    failed_checks: List[Dict[str, Any]] = []
    warn_checks: List[Dict[str, Any]] = []
    seen_active_groups = set()

    for entry in raw_checks:
        if not isinstance(entry, dict):
            return _smoke_report_error('REPORT_MALFORMED')
        cid = entry.get('id')
        group = entry.get('group')
        status = entry.get('status')
        code = entry.get('code')
        elapsed_ms = entry.get('elapsed_ms')
        http_status = entry.get('http_status')
        if (
            not isinstance(cid, str)
            or not CHECK_ID_RE.fullmatch(cid)
            or not isinstance(group, str)
            or not GROUP_ID_RE.fullmatch(group)
            or status not in VALID_SMOKE_STATUSES
            or not isinstance(code, str)
            or not SMOKE_CODE_RE.fullmatch(code)
            or type(elapsed_ms) is not int
            or elapsed_ms < 0
            or (http_status is not None and (type(http_status) is not int or not (100 <= http_status <= 599)))
        ):
            return _smoke_report_error('REPORT_MALFORMED')
        item = {
            'id': cid,
            'group': group,
            'status': status,
            'code': code,
            'http_status': http_status,
            'elapsed_ms': elapsed_ms,
        }
        checks.append(item)
        if status != 'SKIP':
            seen_active_groups.add(group)
        if status == 'FAIL':
            failed_checks.append(item)
        elif status == 'WARN':
            warn_checks.append(item)

    for req_group in required_groups:
        if req_group not in seen_active_groups:
            failed_checks.append(
                {
                    'id': f'missing_group:{req_group}',
                    'group': req_group,
                    'status': 'FAIL',
                    'code': 'MISSING_REQUIRED_GROUP',
                    'http_status': None,
                    'elapsed_ms': 0,
                }
            )

    if (not passed or summary['fail'] > 0) and not failed_checks:
        failed_checks.append(
            {
                'id': 'smoke_summary',
                'group': 'smoke',
                'status': 'FAIL',
                'code': 'SUMMARY_FAILED',
                'http_status': None,
                'elapsed_ms': 0,
            }
        )

    if exit_code is not None and exit_code != 0 and not failed_checks:
        failed_checks.append(
            {
                'id': 'smoke_process',
                'group': 'smoke',
                'status': 'FAIL',
                'code': f'PROBE_EXIT_{abs(int(exit_code))}',
                'http_status': None,
                'elapsed_ms': 0,
            }
        )

    return {
        'ok': len(failed_checks) == 0,
        'report_error': '',
        'checks': checks,
        'failed_checks': failed_checks,
        'warn_checks': warn_checks,
    }


def compute_failure_fingerprint(deno: Dict[str, Any], smoke: Dict[str, Any]) -> str:
    """Deterministic 16-hex failure fingerprint (excludes timestamps and elapsed_ms)."""
    if deno['ok'] and smoke['ok']:
        return ''
    canonical = {
        'deno': None
        if deno['ok']
        else {
            'status': deno['status'],
            'player_id': deno['player_id'],
            'tv_ok': deno['tv_ok'],
            'main_ok': deno['main_ok'],
            'tv_error_code': deno['tv_error_code'],
            'main_error_code': deno['main_error_code'],
            'discovery_error_code': deno['discovery_error_code'],
            'report_error': deno['report_error'],
        },
        'smoke': sorted(
            (
                item['id'],
                item['group'],
                item['status'],
                item['code'],
                item['http_status'],
            )
            for item in smoke['failed_checks']
        ),
    }
    raw = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()[:16]


def validate_api_url(path: str) -> str:
    url = 'https://api.github.com' + path if path.startswith('/') else path
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'api.github.com' or parsed.fragment:
        raise CanaryError('GitHub API URL must stay on api.github.com')
    if '..' in parsed.path.split('/'):
        raise CanaryError('GitHub API URL path traversal is not allowed')
    repo_root = '/repos/' + TARGET
    allowed_prefixes = (
        repo_root + '/issues',
        repo_root + '/actions/workflows/' + WORKFLOW_FILE + '/runs',
    )
    if not any(parsed.path == prefix or parsed.path.startswith(prefix + '/') for prefix in allowed_prefixes):
        raise CanaryError('GitHub API URL is outside the approved canary endpoints')
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):  # noqa: ANN001
        return None


class GitHub:
    def __init__(self, token: Optional[str], opener: Any = None) -> None:
        if not token:
            raise CanaryError('GITHUB_TOKEN is required')
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, method: str, path: str, data: Optional[Dict[str, Any]] = None) -> Tuple[Any, Any]:
        url = validate_api_url(path)
        endpoint = urllib.parse.urlsplit(url).path
        issue_root = '/repos/' + TARGET + '/issues'
        allowed_post = endpoint == issue_root or bool(
            re.fullmatch(re.escape(issue_root) + r'/[1-9][0-9]*/comments', endpoint)
        )
        allowed_patch = bool(
            re.fullmatch(re.escape(issue_root) + r'/[1-9][0-9]*', endpoint)
        ) and data in ({'state': 'open'}, {'state': 'closed'})
        if method != 'GET' and not (method == 'POST' and allowed_post) and not (method == 'PATCH' and allowed_patch):
            raise CanaryError('Only target repository canary Issue writes are permitted')

        if method == 'POST' and isinstance(data, dict):
            if 'title' in data:
                assert_desensitized(data['title'], description='Issue title')
            if 'body' in data:
                assert_desensitized(data['body'], description='Issue body/comment')

        headers = {
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + self.token,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'DokiTool-Go-Upstream-Canary',
        }
        payload = None
        if data is not None:
            payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        try:
            request = urllib.request.Request(url, data=payload, headers=headers, method=method)
            with self.opener.open(request, timeout=25) as response:
                raw = response.read(MAX_API_BYTES + 1)
                if len(raw) > MAX_API_BYTES:
                    raise CanaryError('GitHub API response exceeded the safe size limit')
                return json.loads(raw.decode('utf-8')), response.headers
        except urllib.error.HTTPError as error:
            raise CanaryError(f'GitHub API {method} failed with HTTP {error.code}') from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeError):
            raise CanaryError(f'GitHub API {method} failed or returned invalid JSON') from None

    def get(self, path: str) -> Dict[str, Any]:
        value = self.request('GET', path)[0]
        if not isinstance(value, dict):
            raise CanaryError('Expected a GitHub API object')
        return value

    def items(self, path: str) -> List[Any]:
        result: List[Any] = []
        seen = set()
        next_path: Optional[str] = path
        while next_path:
            url = validate_api_url(next_path)
            if url in seen or len(seen) >= 100:
                raise CanaryError('GitHub API pagination is incomplete or cyclic')
            seen.add(url)
            page, headers = self.request('GET', url)
            if not isinstance(page, list):
                raise CanaryError('Expected a paginated GitHub API list')
            result.extend(page)
            links = re.findall(r'<([^>]+)>\s*;\s*rel="next"', headers.get('Link', ''))
            if len(links) > 1:
                raise CanaryError('Ambiguous GitHub API pagination')
            next_path = links[0] if links else None
        return result


def is_bot(item: Any) -> bool:
    author = item.get('user') if isinstance(item, dict) else None
    return isinstance(author, dict) and author.get('login') == BOT and author.get('type') == 'Bot'


def find_managed_issue(api: Any) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Locate the single managed canary alert Issue strictly authored by github-actions[bot]."""
    query = urllib.parse.urlencode({'state': 'all', 'creator': BOT, 'per_page': 100})
    matches = [
        issue
        for issue in api.items('/repos/' + TARGET + '/issues?' + query)
        if isinstance(issue, dict)
        and 'pull_request' not in issue
        and is_bot(issue)
        and MARKER in (issue.get('body') or '')
    ]
    if len(matches) > 1:
        raise CanaryError('More than one managed upstream canary Issue exists')
    if not matches:
        return None, None
    issue = matches[0]
    if type(issue.get('number')) is not int or issue['number'] <= 0:
        raise CanaryError('Invalid managed canary Issue number')
    comments = api.items(f'/repos/{TARGET}/issues/{issue["number"]}/comments?per_page=100')
    for comment in comments:
        if not isinstance(comment, dict) or type(comment.get('id')) is not int or comment['id'] <= 0:
            raise CanaryError('Invalid Issue comment metadata')
    state: Optional[Dict[str, Any]] = None
    for comment in sorted(comments, key=lambda c: c['id'], reverse=True):
        if not is_bot(comment):
            continue
        body = comment.get('body') or ''
        if MARKER not in body:
            continue
        try:
            state = extract_state(body)
            break
        except CanaryError:
            continue
    if state is None:
        try:
            state = extract_state(issue.get('body'))
        except CanaryError:
            state = None
    return issue, state


def count_prior_failure_streak(
    workflow_runs: Sequence[Dict[str, Any]],
    *,
    current_run_id: Optional[str] = None,
) -> int:
    """Count consecutive prior failed completed scheduled workflow runs (newest-first)."""
    filtered: List[Tuple[dt.datetime, int, int, str]] = []
    for run in workflow_runs:
        if not isinstance(run, dict):
            raise CanaryError('Invalid workflow run metadata')
        run_id = run.get('id')
        if current_run_id is not None and str(run_id) == str(current_run_id):
            continue
        if run.get('status') != 'completed':
            continue
        if run.get('event') != 'schedule':
            continue
        created_at = parse_timestamp(run.get('created_at'), 'workflow run created_at')
        run_num = run.get('run_number') if type(run.get('run_number')) is int else 0
        ident = run_id if type(run_id) is int else 0
        conclusion = str(run.get('conclusion') or '').strip().lower()
        filtered.append((created_at, run_num, ident, conclusion))

    filtered.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    streak = 0
    for _, _, _, conclusion in filtered:
        if conclusion in IGNORED_CONCLUSIONS:
            continue
        if conclusion in FAILURE_CONCLUSIONS:
            streak += 1
        else:
            break
    return streak


def count_prior_failure_streak_from_conclusions(conclusions: Sequence[str]) -> int:
    streak = 0
    for raw in conclusions:
        conclusion = str(raw or '').strip().lower()
        if not conclusion or conclusion in IGNORED_CONCLUSIONS:
            continue
        if conclusion in FAILURE_CONCLUSIONS:
            streak += 1
        else:
            break
    return streak


def fetch_prior_failure_streak(
    api: Any,
    *,
    current_run_id: Optional[str] = None,
) -> int:
    payload = api.get(WORKFLOW_RUNS_PATH)
    runs = payload.get('workflow_runs')
    if not isinstance(runs, list):
        raise CanaryError('GitHub Actions runs response missing workflow_runs list')
    return count_prior_failure_streak(runs, current_run_id=current_run_id)


def render_summary_markdown(
    deno: Dict[str, Any],
    smoke: Dict[str, Any],
    *,
    observed_at: str,
    consecutive_failures: int,
    debounce_threshold: int,
    fingerprint: str,
    run_url: Optional[str] = None,
) -> str:
    observed = parse_timestamp(observed_at, 'observation timestamp').astimezone(SHANGHAI)
    overall_ok = deno['ok'] and smoke['ok']
    deno_label = DENO_STATUS_LABELS.get(deno['status'], safe_text(deno['status']))
    player_cell = f'`{deno["player_id"]}`' if deno['player_id'] else '`-`'
    deno_ver = f'`{deno["deno_version"]}`' if deno['deno_version'] else '`-`'
    tv_cell = 'PASS' if deno['tv_ok'] else f'FAIL (`{deno["tv_error_code"] or "UNKNOWN"}`)'
    main_cell = 'PASS' if deno['main_ok'] else f'FAIL (`{deno["main_error_code"] or "UNKNOWN"}`)'

    lines = [
        f'检查时间：{observed:%Y-%m-%d %H:%M:%S}（北京时间）',
        f'连续失败次数：`{consecutive_failures}`（防抖阈值：`{debounce_threshold}`）',
        f'故障指纹：`{fingerprint or "none"}`',
        '',
        '### 1. Deno / yt-dlp/ejs 零权限兼容性探针（YouTube `tv` + `main`）',
        '',
        '| 指标 | 结果 |',
        '| --- | --- |',
        f'| 综合状态 | {deno_label} |',
        f'| Player ID | {player_cell} |',
        f'| `tv` 变体（主路径） | {tv_cell} |',
        f'| `main` 变体（回退路径） | {main_cell} |',
        f'| Deno 版本 | {deno_ver} |',
        f'| 耗时 | `{deno["elapsed_ms"]}ms` |',
    ]
    if deno['discovery_error_code']:
        lines.append(f'| Discovery 错误码 | `{deno["discovery_error_code"]}` |')
    if deno['report_error']:
        lines.append(f'| 报告校验错误 | `{deno["report_error"]}` |')

    lines.extend(
        [
            '',
            '### 2. 线上只读冒烟（`platforms` / `youtube_context` / `api_boundary`）',
            '',
            '| 检查项 | 分组 | 状态 | HTTP | 错误码 | 耗时 |',
            '| --- | --- | --- | --- | --- | --- |',
        ]
    )
    rendered_items = list(smoke['checks'])
    for synthetic in smoke['failed_checks']:
        if synthetic not in rendered_items:
            rendered_items.append(synthetic)
    for item in rendered_items:
        http_cell = str(item['http_status']) if item['http_status'] is not None else '-'
        lines.append(
            f'| `{item["id"]}` | `{item["group"]}` | **{item["status"]}** | `{http_cell}` | `{item["code"]}` | `{item["elapsed_ms"]}ms` |'
        )

    if overall_ok:
        lines.extend(['', '全部上游 Canary 检查已恢复通过。'])
    else:
        lines.extend(
            [
                '',
                '排查指引：请先在 Actions 日志核对 `tv` / `main` 变体状态与 `/api/youtube/context` 延迟，'
                '切勿自动修改线上配置；如需升级 `yt-dlp` / `Deno` / `ejs`，请通过经人工审查的 PR 与正式发布 Issue 处理。',
            ]
        )

    if run_url:
        lines.extend(['', f'[查看 Actions 运行]({run_url})'])
    return '\n'.join(lines)


def make_issue_body(
    heading: str,
    summary_md: str,
    state: Dict[str, Any],
) -> str:
    body = '\n'.join([f'## {heading}', '', summary_md, '', state_marker(state)])
    return assert_desensitized(body, description='canary Issue body/comment')


def evaluate_and_apply(
    *,
    deno: Dict[str, Any],
    smoke: Dict[str, Any],
    api: Any = None,
    dry_run: bool = False,
    debounce_threshold: int = DEFAULT_DEBOUNCE_THRESHOLD,
    previous_conclusions: Optional[Sequence[str]] = None,
    now: Optional[dt.datetime] = None,
    run_url: Optional[str] = None,
    current_run_id: Optional[str] = None,
) -> Dict[str, Any]:
    if type(debounce_threshold) is not int or debounce_threshold < 1:
        raise CanaryError('debounce_threshold must be >= 1')

    observed_at = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc).isoformat()
    overall_ok = bool(deno['ok'] and smoke['ok'])
    fingerprint = compute_failure_fingerprint(deno, smoke)

    issue, prev_state = (find_managed_issue(api) if api is not None else (None, None))
    issue_open = issue is not None and issue.get('state') == 'open'
    issue_closed = issue is not None and issue.get('state') == 'closed'

    if overall_ok:
        consecutive_failures = 0
    elif previous_conclusions is not None:
        consecutive_failures = 1 + count_prior_failure_streak_from_conclusions(previous_conclusions)
    elif api is not None:
        consecutive_failures = 1 + fetch_prior_failure_streak(api, current_run_id=current_run_id)
    else:
        consecutive_failures = 1

    summary_md = render_summary_markdown(
        deno,
        smoke,
        observed_at=observed_at,
        consecutive_failures=consecutive_failures,
        debounce_threshold=debounce_threshold,
        fingerprint=fingerprint,
        run_url=run_url,
    )
    assert_desensitized(summary_md, description='canary summary markdown')

    existing_issue_url = f'https://github.com/{TARGET}/issues/{issue["number"]}' if issue else None
    result: Dict[str, Any] = {
        'overall_ok': overall_ok,
        'action': 'healthy_noop',
        'consecutive_failures': consecutive_failures,
        'debounce_threshold': debounce_threshold,
        'fingerprint': fingerprint,
        'deno_status': deno['status'],
        'player_id': deno['player_id'],
        'smoke_ok': smoke['ok'],
        'dry_run': dry_run,
        'issue_url': None,
        'summary_markdown': summary_md,
    }

    if overall_ok:
        if issue_open and issue is not None:
            result['issue_url'] = existing_issue_url
            new_state = normalize_state(
                {
                    'schema': SCHEMA_VERSION,
                    'status': 'recovered',
                    'fingerprint': '',
                    'consecutive_failures': 0,
                    'observed_at': observed_at,
                    'player_id': deno['player_id'],
                    'deno_status': deno['status'],
                    'smoke_ok': True,
                }
            )
            body = make_issue_body('上游 Canary 巡检已恢复', summary_md, new_state)
            if dry_run:
                result['action'] = 'dry_run_would_close_issue'
                return result
            if prev_state is None or prev_state.get('status') != 'recovered':
                api.request('POST', f'/repos/{TARGET}/issues/{issue["number"]}/comments', {'body': body})
            api.request('PATCH', f'/repos/{TARGET}/issues/{issue["number"]}', {'state': 'closed'})
            result['action'] = 'issue_closed'
        return result

    # Current run failed.
    new_state = normalize_state(
        {
            'schema': SCHEMA_VERSION,
            'status': 'failing',
            'fingerprint': fingerprint,
            'consecutive_failures': consecutive_failures,
            'observed_at': observed_at,
            'player_id': deno['player_id'],
            'deno_status': deno['status'],
            'smoke_ok': smoke['ok'],
        }
    )

    if issue_open and issue is not None:
        result['issue_url'] = existing_issue_url
        if (
            prev_state is not None
            and prev_state.get('status') == 'failing'
            and prev_state.get('fingerprint') == fingerprint
        ):
            result['action'] = 'deduplicated'
            return result
        body = make_issue_body('上游 Canary 告警状态变更', summary_md, new_state)
        if dry_run:
            result['action'] = 'dry_run_would_update_issue'
            return result
        api.request('POST', f'/repos/{TARGET}/issues/{issue["number"]}/comments', {'body': body})
        result['action'] = 'issue_updated'
        return result

    if consecutive_failures < debounce_threshold:
        result['action'] = 'suppressed_debounce'
        return result

    assert_desensitized(TITLE, description='Issue title')
    body = make_issue_body('上游 Canary 连续异常告警', summary_md, new_state)
    if issue is None:
        if dry_run:
            result['action'] = 'dry_run_would_create_issue'
            return result
        base_payload = {'title': TITLE, 'body': body, 'assignees': [OWNER]}
        try:
            created, _ = api.request(
                'POST',
                '/repos/' + TARGET + '/issues',
                {**base_payload, 'labels': ['blocked']},
            )
        except CanaryError as exc:
            if isinstance(exc, DesensitizationError) or 'HTTP 422' not in str(exc):
                raise
            created, _ = api.request('POST', '/repos/' + TARGET + '/issues', base_payload)
        if type(created.get('number')) is not int or created['number'] <= 0:
            raise CanaryError('Issue creation outcome is unknown')
        result['action'] = 'issue_created'
        result['issue_url'] = f'https://github.com/{TARGET}/issues/{created["number"]}'
        return result

    if issue_closed:
        result['issue_url'] = existing_issue_url
        if dry_run:
            result['action'] = 'dry_run_would_reopen_issue'
            return result
        api.request('PATCH', f'/repos/{TARGET}/issues/{issue["number"]}', {'state': 'open'})
        api.request('POST', f'/repos/{TARGET}/issues/{issue["number"]}/comments', {'body': body})
        result['action'] = 'issue_reopened'
        return result

    raise CanaryError('Unsupported managed Issue state')


def environment(env: Dict[str, str]) -> Tuple[Optional[str], Optional[str]]:
    if env.get('GITHUB_REPOSITORY', TARGET) != TARGET or env.get('GITHUB_REPOSITORY_OWNER', OWNER) != OWNER:
        raise CanaryError('Upstream canary may only run for Daiobs/DokiTool-Go')
    if env.get('GITHUB_SERVER_URL', 'https://github.com') != 'https://github.com':
        raise CanaryError('Only public github.com is supported')
    run_id = env.get('GITHUB_RUN_ID')
    if run_id is not None:
        if not re.fullmatch(r'[0-9]+', run_id):
            raise CanaryError('Invalid GitHub Actions run ID')
        return f'https://github.com/{TARGET}/actions/runs/{run_id}', run_id
    return None, None


def write_utf8_file(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(content)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deno-report', type=Path, required=True, help='Path to sanitized Deno/EJS canary JSON')
    parser.add_argument('--smoke-report', type=Path, required=True, help='Path to sanitized prod-smoke JSON')
    parser.add_argument('--deno-exit-code', type=int, default=None, help='Optional exit code of the Deno probe')
    parser.add_argument('--smoke-exit-code', type=int, default=None, help='Optional exit code of prod-smoke')
    parser.add_argument(
        '--debounce-threshold',
        type=int,
        default=DEFAULT_DEBOUNCE_THRESHOLD,
        help=f'Consecutive failed runs required before alerting (default: {DEFAULT_DEBOUNCE_THRESHOLD})',
    )
    parser.add_argument(
        '--previous-conclusions',
        default=None,
        help='Optional comma-separated prior scheduled run conclusions (newest-first) for offline testing/dry-run',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Evaluate reports and compute planned action without writing any GitHub Issue or comment',
    )
    parser.add_argument('--summary-out', type=Path, default=None, help='Optional path for sanitized Markdown summary')
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    run_url, current_run_id = environment(dict(os.environ))
    deno = load_deno_report(args.deno_report, exit_code=args.deno_exit_code)
    smoke = load_smoke_report(args.smoke_report, exit_code=args.smoke_exit_code)

    prev_conclusions: Optional[List[str]] = None
    if args.previous_conclusions is not None:
        prev_conclusions = [tok.strip() for tok in args.previous_conclusions.split(',') if tok.strip()]

    token = os.environ.get('GITHUB_TOKEN')
    api: Optional[GitHub] = None
    if token:
        api = GitHub(token)
    elif not args.dry_run:
        raise CanaryError('GITHUB_TOKEN is required unless --dry-run is set')

    result = evaluate_and_apply(
        deno=deno,
        smoke=smoke,
        api=api,
        dry_run=args.dry_run,
        debounce_threshold=args.debounce_threshold,
        previous_conclusions=prev_conclusions,
        run_url=run_url,
        current_run_id=current_run_id,
    )

    output_obj = {k: v for k, v in result.items() if k != 'summary_markdown'}
    print(json.dumps(output_obj, ensure_ascii=False, indent=2))

    summary_text = '## DokiTool-Go 上游 Canary 巡检\n\n' + result['summary_markdown'] + '\n'
    if result['issue_url']:
        summary_text += '\n[告警 Issue](' + result['issue_url'] + ')\n'
    assert_desensitized(summary_text, description='step summary')

    if args.summary_out is not None:
        write_utf8_file(args.summary_out, summary_text)

    summary_file = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary_file:
        with open(summary_file, 'a', encoding='utf-8', newline='\n') as handle:
            handle.write(summary_text)

    return 0 if result['overall_ok'] else 1


def cli(argv: Optional[Sequence[str]] = None) -> int:
    try:
        return main(argv)
    except (CanaryError, KeyError, TypeError, AttributeError, OSError, ValueError) as error:
        message = str(error) if isinstance(error, CanaryError) else 'Invalid canary configuration or report'
        print('Upstream canary evaluation failed: ' + message, file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(cli())
