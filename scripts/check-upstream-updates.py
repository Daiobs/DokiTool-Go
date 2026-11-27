#!/usr/bin/env python3
"""Observe official upstream runtime releases and notify through one repository Issue.

Uses only the Python standard library. No upstream source or binary is downloaded or run.
The notification and its observed state share one atomic Issue/comment POST.
"""
import argparse
import base64
import datetime as dt
import html
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGET = 'Daiobs/DokiTool-Go'
OWNER = 'Daiobs'
UPSTREAMS = ('yt-dlp/yt-dlp', 'denoland/deno')
BOT = 'github-actions[bot]'
TITLE = 'DokiTool-Go 上游运行时版本检查'
SCHEMA_VERSION = 2
MARKER = '<!-- dokitool-upstream-watch-state:v2:'
STATE_RE = re.compile(re.escape(MARKER) + r'([A-Za-z0-9+/=]+) -->')
YTDLP_VERSION_RE = re.compile(r'^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?\Z', re.ASCII)
DENO_VERSION_RE = re.compile(r'^\d+\.\d+\.\d+\Z', re.ASCII)
SHA256_HEX_RE = re.compile(r'^[0-9a-f]{64}\Z', re.ASCII)
YTDLP_SOURCE_REL = Path('backend/internal/ytengine/engine.go')
DENO_SOURCE_REL = Path('backend/internal/platform/youtube/ejs_sandbox.go')
RELEASE_BUILD_WORKFLOW_REL = Path('.github/workflows/release-build.yml')
UPSTREAM_CANARY_WORKFLOW_REL = Path('.github/workflows/upstream-canary.yml')
GATEWAY_ISOLATION_WORKFLOW_REL = Path('.github/workflows/gateway-isolation.yml')
VALIDATION_REQUIREMENTS_REL = Path('scripts/requirements-validation.txt')
LOCK_FILES = (
    YTDLP_SOURCE_REL,
    DENO_SOURCE_REL,
    RELEASE_BUILD_WORKFLOW_REL,
    UPSTREAM_CANARY_WORKFLOW_REL,
    GATEWAY_ISOLATION_WORKFLOW_REL,
    VALIDATION_REQUIREMENTS_REL,
)
YTDLP_CONST_RE = re.compile(r'^[ \t]*const[ \t]+PinnedVersion[ \t]*=[ \t]*"([^"\r\n]*)"[ \t]*(?://.*)?$', re.MULTILINE)
DENO_CONST_RE = re.compile(r'^[ \t]*(?:const[ \t]+)?PinnedDenoVersion[ \t]*=[ \t]*"([^"\r\n]*)"[ \t]*(?://.*)?$', re.MULTILINE)
YTDLP_HASH_MAP_RE = re.compile(r'\bvar[ \t]+OfficialSHA256Sums\w*[ \t]*=[ \t]*map\[string\]string\{([^}]*)\}')
YTDLP_LINUX_ENTRY_RE = re.compile(r'"([^"\r\n]*)"[ \t]*:[ \t]*"yt-dlp_linux"')
DENO_HASH_MAP_RE = re.compile(r'\bvar[ \t]+OfficialDenoSHA256Sums\w*[ \t]*=[ \t]*map\[string\]string\{([^}]*)\}')
DENO_LINUX_ENTRY_RE = re.compile(r'"([^"\r\n]*)"[ \t]*:[ \t]*"deno-x86_64-unknown-linux-gnu"')
RELEASE_BUILD_DENO_URL_RE = re.compile(
    r'https://github\.com/denoland/deno/releases/download/([^/\s"\']+)/deno-x86_64-unknown-linux-gnu\.zip'
)
RELEASE_BUILD_DENO_ASSERT_RE = re.compile(r'["\']deno ([^"\'\r\n]+?)["\']')
RELEASE_BUILD_DENO_SHA_RE = re.compile(
    r'echo[ \t]+["\']?([^\s"\']+)[^\r\n|]*\bdeno/deno\b[^\r\n|]*\|[ \t]*sha256sum\b'
)
GATEWAY_YTDLP_URL_RE = re.compile(
    r'https://github\.com/yt-dlp/yt-dlp/releases/download/([^/\s"\']+)/yt-dlp_linux\b'
)
GATEWAY_YTDLP_SHA_RE = re.compile(
    r'echo[ \t]+["\']?([^\s"\']+)[^\r\n|]*\byt-dlp_linux\b[^\r\n|]*\|[ \t]*sha256sum\b'
)
RELEASES_PER_PAGE = 20
STABLE_RELEASE_WINDOW = 10
MAX_BODY = 65000
SHANGHAI = dt.timezone(dt.timedelta(hours=8))
STATUS_LABELS = {
    'aligned': '已对齐',
    'ahead': '发现新正式版',
    'behind': '上游 latest 低于本地锁定',
    'unparseable': '版本不一致（需人工核对）',
}
UPGRADE_REMINDER = (
    '升级提醒：升级 `yt-dlp` 或 `Deno` 需通过经人工审查的 PR 同步更新源码、工作流与验证依赖中的锁定版本号及官方 SHA-256 校验摘要'
    '（`backend/internal/ytengine/engine.go`、`backend/internal/platform/youtube/ejs_sandbox.go`、'
    '`.github/workflows/release-build.yml`、`.github/workflows/upstream-canary.yml`、'
    '`.github/workflows/gateway-isolation.yml`、`scripts/requirements-validation.txt`）。'
    '本检查仅读取 GitHub 公开 Release 元数据并发送 Issue 通知，不下载执行上游产物，也不会自动修改仓库代码或部署。'
    '后续机器人评论携带最新观察状态；关闭此 Issue 不会停用检查。'
)


class WatchError(RuntimeError):
    """An incomplete or unsafe check must not advance notification state."""


def safe_text(value, limit=180):
    """Keep upstream strings from creating mentions, Markdown or HTML."""
    value = ''.join(c if c.isprintable() else ' ' for c in str(value))[:limit]
    value = value.replace('@', '＠')
    value = re.sub(r'([\\`*_{}\[\]()#+.!|~\-])', r'\\\1', value)
    return html.escape(value, quote=True)


def checked_text(value, description, maximum=2048):
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise WatchError('Invalid ' + description)
    return value


def parse_timestamp(value, description):
    raw = checked_text(value, description, 64)
    normalized = raw[:-1] + '+00:00' if raw.endswith(('Z', 'z')) else raw
    try:
        parsed = dt.datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            raise ValueError('Timestamp lacks a timezone')
    except (AttributeError, TypeError, ValueError) as error:
        raise WatchError('Invalid ' + description) from error
    return parsed


def _extract_go_constant(path, pattern, validator, description):
    try:
        source = path.read_text(encoding='utf-8')
    except (OSError, UnicodeError) as error:
        raise WatchError('Unable to read ' + description) from error
    matches = pattern.findall(source)
    if len(matches) != 1 or not validator.fullmatch(matches[0]):
        raise WatchError('Missing or malformed ' + description)
    return matches[0]


def validate_pinned_versions(pinned):
    if not isinstance(pinned, dict) or set(pinned) != set(UPSTREAMS):
        raise WatchError('Pinned versions must cover exactly the configured upstreams')
    ytdlp = pinned.get('yt-dlp/yt-dlp')
    deno = pinned.get('denoland/deno')
    if not isinstance(ytdlp, str) or not YTDLP_VERSION_RE.fullmatch(ytdlp):
        raise WatchError('Invalid pinned yt-dlp version')
    if not isinstance(deno, str) or not DENO_VERSION_RE.fullmatch(deno):
        raise WatchError('Invalid pinned Deno version')
    return {'yt-dlp/yt-dlp': ytdlp, 'denoland/deno': deno}


def load_pinned_versions(root=ROOT):
    root = Path(root)
    ytdlp = _extract_go_constant(
        root / YTDLP_SOURCE_REL,
        YTDLP_CONST_RE,
        YTDLP_VERSION_RE,
        'yt-dlp PinnedVersion in backend/internal/ytengine/engine.go',
    )
    deno = _extract_go_constant(
        root / DENO_SOURCE_REL,
        DENO_CONST_RE,
        DENO_VERSION_RE,
        'Deno PinnedDenoVersion in backend/internal/platform/youtube/ejs_sandbox.go',
    )
    return validate_pinned_versions({'yt-dlp/yt-dlp': ytdlp, 'denoland/deno': deno})


def comparable_version(repo, tag_name):
    checked = checked_text(tag_name, 'release tag', 256)
    if repo == 'denoland/deno' and len(checked) > 1 and checked[0] == 'v' and checked[1].isdigit():
        return checked[1:]
    return checked


def parse_version_tuple(repo, version_text):
    if not isinstance(version_text, str):
        return None
    if repo == 'denoland/deno':
        if not DENO_VERSION_RE.fullmatch(version_text):
            return None
        return tuple(int(part) for part in version_text.split('.'))
    if repo == 'yt-dlp/yt-dlp':
        if not YTDLP_VERSION_RE.fullmatch(version_text):
            return None
        parts = [int(part) for part in version_text.split('.')]
        if len(parts) == 3:
            parts.append(0)
        return tuple(parts)
    return None


def compare_upstream_version(repo, tag_name, locked_version):
    try:
        normalized = comparable_version(repo, tag_name)
    except WatchError:
        return 'unparseable'
    upstream_tuple = parse_version_tuple(repo, normalized)
    locked_tuple = parse_version_tuple(repo, locked_version)
    if upstream_tuple is None or locked_tuple is None:
        return 'unparseable'
    if upstream_tuple > locked_tuple:
        return 'ahead'
    if upstream_tuple < locked_tuple:
        return 'behind'
    if normalized != locked_version:
        return 'unparseable'
    return 'aligned'


def upstream_status_label(repo, tag_name, locked_version, drift=()):
    status = STATUS_LABELS[compare_upstream_version(repo, tag_name, locked_version)]
    if drift:
        return f'{status}（本地配置漂移）'
    return status


def _read_repo_text(path):
    try:
        return path.read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        return None


def _extract_map_sha256(source, map_re, entry_re):
    blocks = map_re.findall(source)
    if len(blocks) != 1:
        return None
    entries = entry_re.findall(blocks[0])
    if len(entries) != 1 or not SHA256_HEX_RE.fullmatch(entries[0]):
        return None
    return entries[0]


def _collect_deno_workflow_drift(root, wf_path_rel, deno_ver, deno_linux_sha, drift):
    wf_rel = wf_path_rel.as_posix()
    wf_text = _read_repo_text(root / wf_path_rel)
    if wf_text is None:
        drift['denoland/deno'].append(f'无法读取 `{wf_rel}`')
        return
    expected_deno_tag = f'v{deno_ver}'
    url_tags = RELEASE_BUILD_DENO_URL_RE.findall(wf_text)
    if not url_tags:
        drift['denoland/deno'].append(f'`{wf_rel}` 未找到 Deno Linux x86_64 下载地址')
    else:
        for found_tag in dict.fromkeys(url_tags):
            if found_tag != expected_deno_tag:
                drift['denoland/deno'].append(
                    f'`{wf_rel}` Deno 下载版本（{safe_text(found_tag, 80)}）'
                    f'与 Go 锁定版本 `{expected_deno_tag}` 不一致'
                )
    raw_asserts = RELEASE_BUILD_DENO_ASSERT_RE.findall(wf_text)
    normalized_asserts = [item[:-1] if item.endswith(' ') else item for item in raw_asserts]
    if not normalized_asserts:
        drift['denoland/deno'].append(f'`{wf_rel}` 未找到 `deno <version>` 版本断言')
    else:
        for found_ver in dict.fromkeys(normalized_asserts):
            if found_ver != deno_ver:
                drift['denoland/deno'].append(
                    f'`{wf_rel}` Deno 版本断言（deno {safe_text(found_ver, 80)}）'
                    f'与 Go 锁定版本 `deno {deno_ver}` 不一致'
                )
    sha_matches = RELEASE_BUILD_DENO_SHA_RE.findall(wf_text)
    if len(sha_matches) != 1:
        drift['denoland/deno'].append(f'`{wf_rel}` 缺失或无法唯一解析 Deno Linux x86_64 SHA-256 校验行')
    else:
        found_sha = sha_matches[0].lower()
        if not SHA256_HEX_RE.fullmatch(found_sha):
            drift['denoland/deno'].append(
                f'`{wf_rel}` Deno Linux x86_64 SHA-256（{safe_text(sha_matches[0], 80)}）格式非法'
            )
        elif deno_linux_sha is not None and found_sha != deno_linux_sha:
            drift['denoland/deno'].append(
                f'`{wf_rel}` Deno Linux x86_64 SHA-256（`{found_sha}`）'
                f'与 `{DENO_SOURCE_REL.as_posix()}`（`{deno_linux_sha}`）不一致'
            )


def collect_local_pin_drift(root=ROOT, pinned=None):
    """Inspect all 6 repository lock files and return drift warnings per upstream."""
    root = Path(root)
    pinned = load_pinned_versions(root) if pinned is None else validate_pinned_versions(pinned)
    ytdlp_ver = pinned['yt-dlp/yt-dlp']
    deno_ver = pinned['denoland/deno']
    drift = {'yt-dlp/yt-dlp': [], 'denoland/deno': []}

    ytdlp_linux_sha = None
    engine_text = _read_repo_text(root / YTDLP_SOURCE_REL)
    if engine_text is None:
        drift['yt-dlp/yt-dlp'].append(f'无法读取 `{YTDLP_SOURCE_REL.as_posix()}`')
    else:
        const_matches = YTDLP_CONST_RE.findall(engine_text)
        if len(const_matches) != 1:
            drift['yt-dlp/yt-dlp'].append(f'`{YTDLP_SOURCE_REL.as_posix()}` 缺失或重复定义 `PinnedVersion`')
        elif const_matches[0] != ytdlp_ver:
            drift['yt-dlp/yt-dlp'].append(
                f'`{YTDLP_SOURCE_REL.as_posix()}` 中 `PinnedVersion`（{safe_text(const_matches[0], 80)}）'
                f'与预期锁定版本 `{ytdlp_ver}` 不一致'
            )
        ytdlp_linux_sha = _extract_map_sha256(engine_text, YTDLP_HASH_MAP_RE, YTDLP_LINUX_ENTRY_RE)
        if ytdlp_linux_sha is None:
            drift['yt-dlp/yt-dlp'].append(
                f'`{YTDLP_SOURCE_REL.as_posix()}` 缺失或无法唯一解析 `OfficialSHA256Sums*` 中的 `yt-dlp_linux` SHA-256'
            )

    deno_linux_sha = None
    sandbox_text = _read_repo_text(root / DENO_SOURCE_REL)
    if sandbox_text is None:
        drift['denoland/deno'].append(f'无法读取 `{DENO_SOURCE_REL.as_posix()}`')
    else:
        const_matches = DENO_CONST_RE.findall(sandbox_text)
        if len(const_matches) != 1:
            drift['denoland/deno'].append(f'`{DENO_SOURCE_REL.as_posix()}` 缺失或重复定义 `PinnedDenoVersion`')
        elif const_matches[0] != deno_ver:
            drift['denoland/deno'].append(
                f'`{DENO_SOURCE_REL.as_posix()}` 中 `PinnedDenoVersion`（{safe_text(const_matches[0], 80)}）'
                f'与预期锁定版本 `{deno_ver}` 不一致'
            )
        deno_linux_sha = _extract_map_sha256(sandbox_text, DENO_HASH_MAP_RE, DENO_LINUX_ENTRY_RE)
        if deno_linux_sha is None:
            drift['denoland/deno'].append(
                f'`{DENO_SOURCE_REL.as_posix()}` 缺失或无法唯一解析 `OfficialDenoSHA256Sums*` 中的'
                ' `deno-x86_64-unknown-linux-gnu` SHA-256'
            )

    _collect_deno_workflow_drift(root, RELEASE_BUILD_WORKFLOW_REL, deno_ver, deno_linux_sha, drift)
    _collect_deno_workflow_drift(root, UPSTREAM_CANARY_WORKFLOW_REL, deno_ver, deno_linux_sha, drift)

    gateway_wf_rel = GATEWAY_ISOLATION_WORKFLOW_REL.as_posix()
    gateway_wf_text = _read_repo_text(root / GATEWAY_ISOLATION_WORKFLOW_REL)
    if gateway_wf_text is None:
        drift['yt-dlp/yt-dlp'].append(f'无法读取 `{gateway_wf_rel}`')
    else:
        url_vers = GATEWAY_YTDLP_URL_RE.findall(gateway_wf_text)
        if not url_vers:
            drift['yt-dlp/yt-dlp'].append(f'`{gateway_wf_rel}` 未找到 `yt-dlp_linux` 下载地址')
        else:
            for found_ver in dict.fromkeys(url_vers):
                if found_ver != ytdlp_ver:
                    drift['yt-dlp/yt-dlp'].append(
                        f'`{gateway_wf_rel}` yt-dlp 下载版本（{safe_text(found_ver, 80)}）'
                        f'与 Go 锁定版本 `{ytdlp_ver}` 不一致'
                    )
        sha_matches = GATEWAY_YTDLP_SHA_RE.findall(gateway_wf_text)
        if len(sha_matches) != 1:
            drift['yt-dlp/yt-dlp'].append(f'`{gateway_wf_rel}` 缺失或无法唯一解析 `yt-dlp_linux` SHA-256 校验行')
        else:
            found_sha = sha_matches[0].lower()
            if not SHA256_HEX_RE.fullmatch(found_sha):
                drift['yt-dlp/yt-dlp'].append(
                    f'`{gateway_wf_rel}` yt-dlp_linux SHA-256（{safe_text(sha_matches[0], 80)}）格式非法'
                )
            elif ytdlp_linux_sha is not None and found_sha != ytdlp_linux_sha:
                drift['yt-dlp/yt-dlp'].append(
                    f'`{gateway_wf_rel}` yt-dlp_linux SHA-256（`{found_sha}`）'
                    f'与 `{YTDLP_SOURCE_REL.as_posix()}`（`{ytdlp_linux_sha}`）不一致'
                )

    reqs_rel = VALIDATION_REQUIREMENTS_REL.as_posix()
    reqs_text = _read_repo_text(root / VALIDATION_REQUIREMENTS_REL)
    if reqs_text is None:
        drift['denoland/deno'].append(f'无法读取 `{reqs_rel}`')
    else:
        deno_reqs = []
        for raw_line in reqs_text.splitlines():
            cleaned = raw_line.split('#', 1)[0].strip()
            if not cleaned:
                continue
            match = re.match(r'^deno(?![A-Za-z0-9_.-])(.*)$', cleaned, re.IGNORECASE)
            if match:
                deno_reqs.append((cleaned, match.group(1).strip()))
        if len(deno_reqs) != 1:
            drift['denoland/deno'].append(f'`{reqs_rel}` 缺失或重复声明 `deno=={deno_ver}`')
        else:
            raw_spec, constraint = deno_reqs[0]
            exact_match = re.fullmatch(r'==\s*(\S+)', constraint)
            if exact_match is None:
                drift['denoland/deno'].append(
                    f'`{reqs_rel}` Deno 依赖项（{safe_text(raw_spec, 80)}）未使用精确版本锁定 `deno=={deno_ver}`'
                )
            elif exact_match.group(1) != deno_ver:
                drift['denoland/deno'].append(
                    f'`{reqs_rel}` Deno 锁定版本（deno=={safe_text(exact_match.group(1), 80)}）'
                    f'与 Go 锁定版本 `deno=={deno_ver}` 不一致'
                )

    return drift


def verify_local_pin_consistency(root=ROOT):
    """Fail closed with WatchError if any of the 6 local lock files drift out of sync."""
    pinned = load_pinned_versions(root)
    drift = collect_local_pin_drift(root, pinned)
    problems = [f'{repo}: {detail}' for repo in UPSTREAMS for detail in drift[repo]]
    if problems:
        raise WatchError('Local pin drift detected: ' + '; '.join(problems))
    return pinned


def normalize_local_drift(local_drift):
    if local_drift is None:
        return {repo: [] for repo in UPSTREAMS}
    if not isinstance(local_drift, dict) or not set(local_drift).issubset(set(UPSTREAMS)):
        raise WatchError('Invalid local drift mapping')
    normalized = {}
    for repo in UPSTREAMS:
        items = local_drift.get(repo, [])
        if not isinstance(items, list) or any(not isinstance(x, str) or not (0 < len(x) <= 512) for x in items):
            raise WatchError('Invalid local drift entries')
        normalized[repo] = list(items)
    return normalized


def _release_identity(record):
    return (record['id'], record['tag_name'], record['published_at'])


def _snapshot_identity(snapshot):
    return (
        snapshot['latest_id'],
        snapshot['latest_tag'],
        snapshot['latest_published_at'],
        [_release_identity(record) for record in snapshot['releases']],
    )


def normalize_release_record(release):
    if not isinstance(release, dict):
        raise WatchError('Invalid release metadata')
    ident = release.get('id')
    if type(ident) is not int or ident <= 0:
        raise WatchError('Invalid release ID')
    tag_name = checked_text(release.get('tag_name'), 'release tag', 256)
    published_at = checked_text(release.get('published_at'), 'release published timestamp', 64)
    parse_timestamp(published_at, 'release published timestamp')
    raw_name = release.get('name')
    if raw_name is not None and not isinstance(raw_name, str):
        raise WatchError('Invalid release name')
    clean_name = raw_name.strip()[:256] if isinstance(raw_name, str) else ''
    record = {
        'id': ident,
        'tag_name': tag_name,
        'published_at': published_at,
    }
    if clean_name and clean_name != tag_name:
        record['name'] = clean_name
    return record


def normalize_snapshot(snapshot):
    """Only stable official release fields and local drift warnings enter the fingerprint."""
    if not isinstance(snapshot, dict):
        raise WatchError('Invalid repository snapshot')
    latest_id = snapshot.get('latest_id')
    if type(latest_id) is not int or latest_id <= 0:
        raise WatchError('Invalid latest release ID')
    latest_tag = checked_text(snapshot.get('latest_tag'), 'latest release tag', 256)
    latest_published_at = checked_text(snapshot.get('latest_published_at'), 'latest release timestamp', 64)
    parse_timestamp(latest_published_at, 'latest release timestamp')
    raw_releases = snapshot.get('releases')
    if not isinstance(raw_releases, list) or not (1 <= len(raw_releases) <= STABLE_RELEASE_WINDOW):
        raise WatchError('Incomplete or oversized stable releases snapshot')
    by_id = {}
    for item in raw_releases:
        record = normalize_release_record(item)
        if record['id'] in by_id:
            raise WatchError('Duplicate release ID in snapshot')
        by_id[record['id']] = record
    latest_entry = by_id.get(latest_id)
    if latest_entry is None or latest_entry['tag_name'] != latest_tag or latest_entry['published_at'] != latest_published_at:
        raise WatchError('Latest release metadata does not match snapshot releases')
    raw_drift = snapshot.get('local_drift')
    if raw_drift is None:
        local_drift = []
    elif isinstance(raw_drift, list) and all(isinstance(item, str) and 0 < len(item) <= 512 for item in raw_drift):
        local_drift = list(raw_drift)
    else:
        raise WatchError('Invalid local drift record in snapshot')
    return {
        'latest_id': latest_id,
        'latest_tag': latest_tag,
        'latest_published_at': latest_published_at,
        'releases': sorted(by_id.values(), key=lambda x: x['id']),
        'local_drift': local_drift,
    }


def normalize_state(state):
    if not isinstance(state, dict) or state.get('schema') != SCHEMA_VERSION:
        raise WatchError('Unsupported observation state schema')
    repos = state.get('repositories')
    if not isinstance(repos, dict) or set(repos) != set(UPSTREAMS):
        raise WatchError('Observation state does not cover exactly the two upstreams')
    observed_at = checked_text(state.get('observed_at'), 'observation timestamp', 64)
    parse_timestamp(observed_at, 'observation timestamp')
    return {
        'schema': SCHEMA_VERSION,
        'observed_at': observed_at,
        'repositories': {name: normalize_snapshot(repos[name]) for name in UPSTREAMS},
    }


def state_marker(state):
    raw = json.dumps(normalize_state(state), ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return MARKER + base64.b64encode(raw).decode('ascii') + ' -->'


def extract_state(body):
    if not isinstance(body, str) or MARKER not in body:
        raise WatchError('Observation state marker is missing')
    matches = STATE_RE.findall(body)
    if len(matches) != 1 or body.count(MARKER) != 1:
        raise WatchError('Observation state marker is malformed or duplicated')
    try:
        return normalize_state(json.loads(base64.b64decode(matches[0], validate=True).decode('utf-8')))
    except (ValueError, UnicodeError) as error:
        raise WatchError('Observation state could not be decoded') from error


def validate_api_url(path):
    url = 'https://api.github.com' + path if path.startswith('/') else path
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'api.github.com' or parsed.fragment:
        raise WatchError('GitHub API URL must stay on api.github.com')
    if '..' in parsed.path.split('/'):
        raise WatchError('GitHub API URL path traversal is not allowed')
    roots = tuple('/repos/' + name for name in (TARGET, *UPSTREAMS))
    if not any(parsed.path == root or parsed.path.startswith(root + '/') for root in roots):
        raise WatchError('GitHub API URL is outside the approved repositories')
    return url


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None


class GitHub:
    def __init__(self, token, opener=None):
        if not token:
            raise WatchError('GITHUB_TOKEN is required')
        self.token = token
        self.opener = opener or urllib.request.build_opener(NoRedirect())

    def request(self, method, path, data=None):
        url = validate_api_url(path)
        endpoint = urllib.parse.urlsplit(url).path
        issue_root = '/repos/' + TARGET + '/issues'
        allowed_post = endpoint == issue_root or re.fullmatch(re.escape(issue_root) + r'/[1-9][0-9]*/comments', endpoint)
        allowed_patch = re.fullmatch(re.escape(issue_root) + r'/[1-9][0-9]*', endpoint) and data == {'state': 'open'}
        if method != 'GET' and not (method == 'POST' and allowed_post) and not (method == 'PATCH' and allowed_patch):
            raise WatchError('Only target repository Issue notifications may be written')
        headers = {
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + self.token,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'DokiTool-Go-Upstream-Watch',
        }
        payload = None
        if data is not None:
            payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        try:
            request = urllib.request.Request(url, data=payload, headers=headers, method=method)
            with self.opener.open(request, timeout=25) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
                if len(raw) > 8 * 1024 * 1024:
                    raise WatchError('GitHub API response exceeded the safe size limit')
                return json.loads(raw.decode('utf-8')), response.headers
        except urllib.error.HTTPError as error:
            raise WatchError(f'GitHub API {method} failed with HTTP {error.code}; keep saved state and re-read it before retrying') from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, UnicodeError):
            raise WatchError(f'GitHub API {method} was not confirmed or returned invalid JSON; re-read saved notifications before retrying') from None

    def get(self, path):
        value = self.request('GET', path)[0]
        if not isinstance(value, dict):
            raise WatchError('Expected a GitHub API object')
        return value

    def get_list(self, path):
        value = self.request('GET', path)[0]
        if not isinstance(value, list):
            raise WatchError('Expected a GitHub API list')
        return value

    def items(self, path):
        result, seen = [], set()
        while path:
            url = validate_api_url(path)
            if url in seen or len(seen) >= 1000:
                raise WatchError('GitHub API pagination is incomplete or cyclic')
            seen.add(url)
            page, headers = self.request('GET', url)
            if not isinstance(page, list):
                raise WatchError('Expected a paginated GitHub API list')
            result.extend(page)
            links = re.findall(r'<([^>]+)>\s*;\s*rel="next"', headers.get('Link', ''))
            if len(links) > 1:
                raise WatchError('Ambiguous GitHub API pagination')
            path = links[0] if links else None
        return result


def collect_snapshot(api, repo, local_drift=()):
    prefix = '/repos/' + repo
    raw_releases = api.get_list(f'{prefix}/releases?per_page={RELEASES_PER_PAGE}')
    latest = api.get(f'{prefix}/releases/latest')
    if latest.get('draft') is not False or latest.get('prerelease') is not False:
        raise WatchError('Latest upstream release must be a non-draft stable release')
    checked_text(latest.get('target_commitish'), 'latest release target_commitish', 256)
    latest_record = normalize_release_record(latest)

    by_id = {}
    for entry in raw_releases:
        if not isinstance(entry, dict):
            raise WatchError('Invalid release metadata')
        draft = entry.get('draft')
        prerelease = entry.get('prerelease')
        if type(draft) is not bool or type(prerelease) is not bool:
            raise WatchError('Missing release draft or prerelease status')
        if draft or prerelease:
            continue
        if 'target_commitish' in entry:
            checked_text(entry.get('target_commitish'), 'release target_commitish', 256)
        record = normalize_release_record(entry)
        if record['id'] in by_id:
            raise WatchError('Duplicate release ID in upstream response')
        by_id[record['id']] = record

    if latest_record['id'] in by_id and _release_identity(by_id[latest_record['id']]) != _release_identity(latest_record):
        raise WatchError('Inconsistent release metadata between releases list and latest')
    by_id[latest_record['id']] = latest_record

    ordered = sorted(
        by_id.values(),
        key=lambda r: (parse_timestamp(r['published_at'], 'release published timestamp'), r['id']),
        reverse=True,
    )
    selected = ordered[:STABLE_RELEASE_WINDOW]
    if all(r['id'] != latest_record['id'] for r in selected):
        selected = [*selected[:-1], latest_record]
    return normalize_snapshot({
        'latest_id': latest_record['id'],
        'latest_tag': latest_record['tag_name'],
        'latest_published_at': latest_record['published_at'],
        'releases': selected,
        'local_drift': list(local_drift),
    })


def is_bot(item):
    author = item.get('user') if isinstance(item, dict) else None
    return isinstance(author, dict) and author.get('login') == BOT and author.get('type') == 'Bot'


def find_issue(api):
    query = urllib.parse.urlencode({'state': 'all', 'creator': BOT, 'per_page': 100})
    matches = [
        issue for issue in api.items('/repos/' + TARGET + '/issues?' + query)
        if isinstance(issue, dict) and 'pull_request' not in issue and issue.get('title') == TITLE and is_bot(issue)
    ]
    if len(matches) > 1:
        raise WatchError('More than one managed upstream tracking Issue exists')
    if not matches:
        return None, None
    issue = matches[0]
    if type(issue.get('number')) is not int or issue['number'] <= 0:
        raise WatchError('Invalid tracking Issue number')
    state = extract_state(issue.get('body'))
    comments = api.items(f'/repos/{TARGET}/issues/{issue["number"]}/comments?per_page=100')
    for comment in comments:
        if not isinstance(comment, dict) or type(comment.get('id')) is not int or comment['id'] <= 0:
            raise WatchError('Invalid Issue comment metadata')
    for comment in sorted(comments, key=lambda c: c['id']):
        if is_bot(comment) and MARKER in (comment.get('body') or ''):
            state = extract_state(comment['body'])
    return issue, state


def _release_sort_key(record):
    return (parse_timestamp(record['published_at'], 'release published timestamp'), record['id'])


def _format_release_label(record):
    title = record.get('name')
    if title:
        return f'{safe_text(record["tag_name"])}（{safe_text(title)}）'
    return safe_text(record['tag_name'])


def describe_changes(repo, pinned_version, old, new):
    lines = []
    if (old['latest_id'], old['latest_tag'], old['latest_published_at']) != (
        new['latest_id'], new['latest_tag'], new['latest_published_at']
    ):
        status = STATUS_LABELS[compare_upstream_version(repo, new['latest_tag'], pinned_version)]
        lines.append(
            f'最新正式版：{safe_text(old["latest_tag"])} → {safe_text(new["latest_tag"])}'
            f'（当前锁定：`{pinned_version}`；状态：{status}）'
        )
    before = {x['id']: x for x in old['releases']}
    after = {x['id']: x for x in new['releases']}
    old_full = len(old['releases']) >= STABLE_RELEASE_WINDOW
    new_full = len(new['releases']) >= STABLE_RELEASE_WINDOW
    old_oldest = min(_release_sort_key(x) for x in old['releases'])
    new_oldest = min(_release_sort_key(x) for x in new['releases'])

    for ident in sorted(set(before) | set(after)):
        a, b = before.get(ident), after.get(ident)
        if a is not None and b is not None:
            if _release_identity(a) == _release_identity(b):
                continue
            lines.append(
                f'正式版变更：{_format_release_label(b)}（ID {ident}；发布时间 {safe_text(b["published_at"])}）'
            )
        elif a is None:
            if old_full and _release_sort_key(b) < old_oldest:
                continue
            lines.append(
                f'正式版新增：{_format_release_label(b)}（ID {ident}；发布时间 {safe_text(b["published_at"])}）'
            )
        else:
            if new_full and _release_sort_key(a) < new_oldest:
                continue
            lines.append(f'正式版撤回或移除：{_format_release_label(a)}（ID {ident}）')
    if _snapshot_identity(old) != _snapshot_identity(new) and not lines:
        lines.append(f'正式版观察窗口更新：当前最新正式版 {safe_text(new["latest_tag"])}（ID {new["latest_id"]}）')

    old_drift = old.get('local_drift', [])
    new_drift = new.get('local_drift', [])
    if new_drift != old_drift:
        if new_drift:
            lines.extend(f'本地配置漂移：{detail}' for detail in new_drift)
        else:
            lines.append('本地配置漂移已解除：仓库内锁定版本与 SHA-256 校验已恢复一致')
    elif new_drift and lines:
        lines.extend(f'本地配置漂移（待修复）：{detail}' for detail in new_drift)
    return lines


def make_summary_table(pinned, current):
    rows = [
        '| 组件 | 当前锁定版本 | 上游最新正式版 | 发布时间 | 状态 |',
        '| --- | --- | --- | --- | --- |',
    ]
    for repo in UPSTREAMS:
        snap = current['repositories'][repo]
        locked = pinned[repo]
        status = upstream_status_label(repo, snap['latest_tag'], locked, snap.get('local_drift', ()))
        published = parse_timestamp(snap['latest_published_at'], 'latest release timestamp').astimezone(dt.timezone.utc)
        rows.append(
            f'| [{repo}](https://github.com/{repo}) | `{locked}` | {safe_text(snap["latest_tag"])}'
            f' | {published:%Y-%m-%d %H:%M:%S} UTC | {status} |'
        )
    return '\n'.join(rows)


def report_initial_divergence(pinned, current):
    sections = []
    for repo in UPSTREAMS:
        snap = current['repositories'][repo]
        locked = pinned[repo]
        relation = compare_upstream_version(repo, snap['latest_tag'], locked)
        drift = snap.get('local_drift', [])
        if relation == 'aligned' and not drift:
            continue
        latest_rec = next((r for r in snap['releases'] if r['id'] == snap['latest_id']), None)
        label = _format_release_label(latest_rec) if latest_rec else safe_text(snap['latest_tag'])
        bullets = []
        if relation == 'ahead':
            bullets.append(
                f'- 首次观察发现新正式版：本地锁定 `{locked}`，上游最新正式版 {label}'
                f'（ID {snap["latest_id"]}；发布时间 {safe_text(snap["latest_published_at"])}；状态：{STATUS_LABELS[relation]}）'
            )
        elif relation == 'behind':
            bullets.append(
                f'- 首次观察发现上游 latest 低于本地锁定：本地锁定 `{locked}`，上游最新正式版 {label}'
                f'（ID {snap["latest_id"]}；发布时间 {safe_text(snap["latest_published_at"])}；状态：{STATUS_LABELS[relation]}）'
            )
        elif relation == 'unparseable':
            bullets.append(
                f'- 首次观察发现上游正式版标签格式异常：本地锁定 `{locked}`，上游最新正式版 {label}'
                f'（ID {snap["latest_id"]}；发布时间 {safe_text(snap["latest_published_at"])}；状态：{STATUS_LABELS[relation]}）'
            )
        bullets.extend(f'- 本地配置漂移：{detail}' for detail in drift)
        lines = [
            f'### [{repo}](https://github.com/{repo})',
            '',
            *bullets,
            '',
            f'[查看上游 Releases](https://github.com/{repo}/releases)',
        ]
        sections.append('\n'.join(lines))
    return '\n\n'.join(sections)


def report_changes(pinned, previous, current):
    sections = []
    for repo in UPSTREAMS:
        old, new = previous['repositories'][repo], current['repositories'][repo]
        changes = describe_changes(repo, pinned[repo], old, new)
        if changes:
            lines = [
                f'### [{repo}](https://github.com/{repo})',
                '',
                *('- ' + line for line in changes),
                '',
                f'[查看上游 Releases](https://github.com/{repo}/releases)',
            ]
            sections.append('\n'.join(lines))
    return '\n\n'.join(sections)


def make_body(table, change_sections, current, run_url, initial=False):
    heading = '上游运行时版本检查已启用' if initial else '发现上游正式版更新'
    observed = parse_timestamp(current['observed_at'], 'observation timestamp').astimezone(SHANGHAI)
    detail = change_sections or '本次没有发现相对已知基线的新正式版。此 Issue 用于保存观察状态并接收后续正式版更新通知。'
    parts = [
        f'## {heading}',
        '',
        f'检查时间：{observed:%Y-%m-%d %H:%M:%S}（北京时间）。',
        '',
        table,
        '',
        detail,
        '',
        UPGRADE_REMINDER,
    ]
    if run_url:
        parts.extend(['', f'[查看 Actions 运行]({run_url})'])
    parts.extend(['', state_marker(current)])
    body = '\n'.join(parts)
    if len(body.encode('utf-8')) > MAX_BODY:
        raise WatchError('Notification exceeds the Issue body limit; state was not advanced')
    return body


def run_check(api, pinned, *, dry_run=False, verify_notification=False, now=None, run_url=None, local_drift=None):
    pinned = validate_pinned_versions(pinned)
    drift_by_repo = normalize_local_drift(local_drift)
    issue, previous = find_issue(api)
    observed_at = (now or dt.datetime.now(dt.timezone.utc)).isoformat()
    current = normalize_state({
        'schema': SCHEMA_VERSION,
        'observed_at': observed_at,
        'repositories': {
            repo: collect_snapshot(api, repo, drift_by_repo[repo])
            for repo in UPSTREAMS
        },
    })
    table = make_summary_table(pinned, current)
    if previous is None:
        change_sections = report_initial_divergence(pinned, current)
    else:
        change_sections = report_changes(pinned, previous, current)
    changed = bool(change_sections)
    summary = table + '\n\n' + (change_sections or '两个上游正式版均无新变化。')
    issue_url = f'https://github.com/{TARGET}/issues/{issue["number"]}' if issue else None
    result = {
        'changed': changed,
        'issue_created': False,
        'notification_posted': False,
        'dry_run': dry_run,
        'issue_url': issue_url,
        'summary': summary,
    }
    if dry_run:
        return result
    if issue is None:
        body = make_body(table, change_sections, current, run_url, initial=True)
        created, _ = api.request(
            'POST',
            '/repos/' + TARGET + '/issues',
            {'title': TITLE, 'body': body, 'assignees': [OWNER]},
        )
        if type(created.get('number')) is not int or created['number'] <= 0:
            raise WatchError('Issue creation outcome is unknown; inspect the next run before retrying')
        result.update(
            issue_created=True,
            notification_posted=True,
            issue_url=f'https://github.com/{TARGET}/issues/{created["number"]}',
        )
    elif changed:
        body = make_body(table, change_sections, current, run_url)
        if issue.get('state') == 'closed':
            api.request('PATCH', f'/repos/{TARGET}/issues/{issue["number"]}', {'state': 'open'})
        # The human notification and observed snapshot are persisted in one POST.
        api.request('POST', f'/repos/{TARGET}/issues/{issue["number"]}/comments', {'body': body})
        result['notification_posted'] = True
    elif verify_notification:
        api.request(
            'POST',
            f'/repos/{TARGET}/issues/{issue["number"]}/comments',
            {'body': '通知通道验证：本条用于验证 GitHub Actions 的 Issue 通知权限，不代表上游有新正式版，也不改变观察状态。'},
        )
        result['notification_posted'] = True
    return result


def environment(env):
    if env.get('GITHUB_REPOSITORY', TARGET) != TARGET or env.get('GITHUB_REPOSITORY_OWNER', OWNER) != OWNER:
        raise WatchError('This watcher may only run for Daiobs/DokiTool-Go')
    if env.get('GITHUB_SERVER_URL', 'https://github.com') != 'https://github.com':
        raise WatchError('Only public github.com is supported')
    run_id = env.get('GITHUB_RUN_ID')
    if run_id is not None and not re.fullmatch(r'[0-9]+', run_id):
        raise WatchError('Invalid GitHub Actions run ID')
    return f'https://github.com/{TARGET}/actions/runs/{run_id}' if run_id else None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true', help='Read and report without writing any Issue or comment')
    parser.add_argument('--verify-notification', action='store_true', help='Send an explicitly labeled notification-channel check')
    parser.add_argument(
        '--check-local-pins',
        action='store_true',
        help='Verify all 6 local runtime version/SHA-256 lock files offline without network or GITHUB_TOKEN',
    )
    parser.add_argument('--root', type=Path, default=ROOT, help='Repository root directory (defaults to checkout root)')
    args = parser.parse_args(argv)
    root = Path(args.root)
    if args.check_local_pins:
        if args.verify_notification:
            raise WatchError('--check-local-pins cannot be combined with --verify-notification')
        pinned = verify_local_pin_consistency(root)
        print(json.dumps({
            'passed': True,
            'lock_files': len(LOCK_FILES),
            'pinned': pinned,
        }, ensure_ascii=False, indent=2))
        return
    run_url = environment(os.environ)
    pinned = load_pinned_versions(root)
    local_drift = collect_local_pin_drift(root, pinned)
    result = run_check(
        GitHub(os.environ.get('GITHUB_TOKEN')),
        pinned,
        dry_run=args.dry_run,
        verify_notification=args.verify_notification,
        run_url=run_url,
        local_drift=local_drift,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    summary_file = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary_file:
        with open(summary_file, 'a', encoding='utf-8') as output:
            output.write('## DokiTool-Go 上游运行时版本检查\n\n' + result['summary'] + '\n')
            if result['issue_url']:
                output.write('\n[通知 Issue](' + result['issue_url'] + ')\n')


def cli(argv=None):
    try:
        main(argv)
    except (WatchError, KeyError, TypeError, AttributeError, OSError, ValueError) as error:
        # Do not echo HTTP response bodies, headers, tokens or upstream payloads.
        message = str(error) if isinstance(error, WatchError) else 'Invalid local configuration or upstream response; state was not advanced'
        print('Upstream check failed: ' + message, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(cli())
