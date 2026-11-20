#!/usr/bin/env python3
"""Synchronize pinned yt-dlp and Deno versions and SHA-256 digests across all 5 lock files.

Uses only the Python 3 standard library. Never executes downloaded or local binaries.
Reuses authoritative version/digest patterns and verify_local_pin_consistency from
scripts/check-upstream-updates.py so validation rules never drift.
"""
import argparse
import difflib
import hashlib
import importlib.util
import io
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile


def _load_watch_module():
    watch_path = Path(__file__).resolve().with_name('check-upstream-updates.py')
    spec = importlib.util.spec_from_file_location('dokitool_check_upstream_updates', watch_path)
    if spec is None or spec.loader is None:
        raise RuntimeError('Unable to load check-upstream-updates.py module spec')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_WATCH = _load_watch_module()

ROOT = _WATCH.ROOT
YTDLP_VERSION_RE = _WATCH.YTDLP_VERSION_RE
DENO_VERSION_RE = _WATCH.DENO_VERSION_RE
SHA256_HEX_RE = _WATCH.SHA256_HEX_RE
LOCK_FILES = _WATCH.LOCK_FILES
YTDLP_SOURCE_REL = _WATCH.YTDLP_SOURCE_REL
DENO_SOURCE_REL = _WATCH.DENO_SOURCE_REL
RELEASE_BUILD_WORKFLOW_REL = _WATCH.RELEASE_BUILD_WORKFLOW_REL
GATEWAY_ISOLATION_WORKFLOW_REL = _WATCH.GATEWAY_ISOLATION_WORKFLOW_REL
VALIDATION_REQUIREMENTS_REL = _WATCH.VALIDATION_REQUIREMENTS_REL
WatchError = _WATCH.WatchError
verify_local_pin_consistency = _WATCH.verify_local_pin_consistency
load_pinned_versions = _WATCH.load_pinned_versions

REQUIRED_YTDLP_ASSETS = (
    'yt-dlp',
    'yt-dlp_linux',
    'yt-dlp_linux_aarch64',
    'yt-dlp_macos',
    'yt-dlp.exe',
    'yt-dlp_arm64.exe',
)

REQUIRED_DENO_ASSETS = (
    'deno-x86_64-unknown-linux-gnu',
    'deno-aarch64-unknown-linux-gnu',
    'deno-aarch64-apple-darwin',
    'deno-x86_64-apple-darwin',
)

ALLOWED_INITIAL_HOST = 'github.com'
ALLOWED_REDIRECT_HOSTS = frozenset({
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
})
MAX_REDIRECTS = 5
DEFAULT_HTTP_TIMEOUT_SEC = 30
MAX_TEXT_RESPONSE_BYTES = 1 * 1024 * 1024
MAX_DENO_ZIP_BYTES = 160 * 1024 * 1024
MAX_DENO_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
STREAM_CHUNK_BYTES = 65536

_ENGINE_CONST_REPLACE_RE = re.compile(
    r'^([ \t]*const[ \t]+PinnedVersion[ \t]*=[ \t]*")([^"\r\n]*)("[ \t]*(?://.*)?)$',
    re.MULTILINE,
)
_ENGINE_MAP_REPLACE_RE = re.compile(
    r'\b(var[ \t]+OfficialSHA256Sums\w*[ \t]*=[ \t]*map\[string\]string\{)([^}]*)(\})'
)
_GATEWAY_URL_REPLACE_RE = re.compile(
    r'(https://github\.com/yt-dlp/yt-dlp/releases/download/)([^/\s"\']+)(/yt-dlp_linux\b)'
)
_GATEWAY_SHA_REPLACE_RE = re.compile(
    r'(echo[ \t]+["\']?)([^\s"\']+)([^\r\n|]*\byt-dlp_linux\b[^\r\n|]*\|[ \t]*sha256sum\b)'
)
_SANDBOX_CONST_REPLACE_RE = re.compile(
    r'^([ \t]*(?:const[ \t]+)?PinnedDenoVersion[ \t]*=[ \t]*")([^"\r\n]*)("[ \t]*(?://.*)?)$',
    re.MULTILINE,
)
_SANDBOX_MAP_REPLACE_RE = re.compile(
    r'\b(var[ \t]+OfficialDenoSHA256Sums\w*[ \t]*=[ \t]*map\[string\]string\{)([^}]*)(\})'
)
_RELEASE_STEP_TITLE_REPLACE_RE = re.compile(
    r'^([ \t]*-[ \t]+name:[ \t]+Install pinned Deno[ \t]+)(\S+)([ \t]*)$',
    re.MULTILINE,
)
_RELEASE_URL_REPLACE_RE = re.compile(
    r'(https://github\.com/denoland/deno/releases/download/)([^/\s"\']+)(/deno-x86_64-unknown-linux-gnu\.zip\b)'
)
_RELEASE_SHA_REPLACE_RE = re.compile(
    r'(echo[ \t]+["\']?)([^\s"\']+)([^\r\n|]*\bdeno/deno\b[^\r\n|]*\|[ \t]*sha256sum\b)'
)
_RELEASE_ASSERT_REPLACE_RE = re.compile(
    r'(["\']deno )([^\s"\'\r\n]+)( ?["\'])'
)
_SUMS_LINE_RE = re.compile(r'^([0-9a-f]{64})[ \t]+[* ]?([^\r\n]+)\Z', re.ASCII)
_SIDECAR_SHA_RE = re.compile(r'^([0-9a-fA-F]{64})(?:[ \t]+[* ]?([^\r\n]+))?\Z', re.ASCII)


class BumpError(RuntimeError):
    """Any validation, download, archive, or consistency failure aborts fail-closed."""


def validate_ytdlp_version(version):
    if not isinstance(version, str) or not YTDLP_VERSION_RE.fullmatch(version):
        raise BumpError(f'Invalid yt-dlp version {version!r}; expected YYYY.MM.DD or YYYY.MM.DD.N')
    return version


def validate_deno_version(version):
    if not isinstance(version, str) or not DENO_VERSION_RE.fullmatch(version):
        raise BumpError(f'Invalid Deno version {version!r}; expected X.Y.Z without leading "v"')
    return version


def validate_sha256_hex(digest, label='SHA-256 digest'):
    if not isinstance(digest, str) or not SHA256_HEX_RE.fullmatch(digest):
        raise BumpError(f'Invalid {label}: expected 64 lowercase hex characters')
    return digest


def _validate_complete_asset_hashes(hashes, required_assets, component_label):
    expected_set = set(required_assets)
    actual_set = set(hashes.keys())
    unknown = sorted(actual_set - expected_set)
    if unknown:
        raise BumpError(f'Unknown {component_label} asset(s): {", ".join(unknown)}')
    missing = [asset for asset in required_assets if asset not in hashes]
    if missing:
        raise BumpError(f'Missing required {component_label} asset(s): {", ".join(missing)}')
    normalized = {}
    seen_digests = {}
    for asset in required_assets:
        digest = validate_sha256_hex(hashes[asset], f'{component_label} SHA-256 for {asset}')
        if digest in seen_digests:
            raise BumpError(
                f'Duplicate {component_label} SHA-256 digest shared by {seen_digests[digest]} and {asset}'
            )
        seen_digests[digest] = asset
        normalized[asset] = digest
    return normalized


def parse_ytdlp_sums_text(text):
    """Parse official yt-dlp SHA2-256SUMS text and extract the 6 required release assets."""
    if not isinstance(text, str) or not text.strip():
        raise BumpError('yt-dlp SHA2-256SUMS content is empty')
    all_seen = {}
    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped:
            continue
        match = _SUMS_LINE_RE.fullmatch(stripped)
        if match is None:
            raise BumpError(f'Malformed SHA2-256SUMS line {lineno}')
        digest, asset_name = match.group(1), match.group(2).strip()
        if not asset_name or '/' in asset_name or '\\' in asset_name or any(ch.isspace() for ch in asset_name):
            raise BumpError(f'Unsafe or malformed asset name on SHA2-256SUMS line {lineno}')
        if asset_name in all_seen:
            raise BumpError(f'Duplicate asset {asset_name!r} in SHA2-256SUMS')
        all_seen[asset_name] = digest

    extracted = {asset: all_seen[asset] for asset in REQUIRED_YTDLP_ASSETS if asset in all_seen}
    return _validate_complete_asset_hashes(extracted, REQUIRED_YTDLP_ASSETS, 'yt-dlp')


def parse_kv_sha256_items(items, required_assets, component_label):
    allowed = set(required_assets)
    parsed = {}
    for raw in items:
        if not isinstance(raw, str) or '=' not in raw:
            raise BumpError(f'Invalid {component_label} --*-sha256 entry {raw!r}; expected <asset>=<hex>')
        asset, _, digest = raw.partition('=')
        if asset not in allowed:
            raise BumpError(f'Unknown {component_label} asset {asset!r}')
        if asset in parsed:
            raise BumpError(f'Duplicate {component_label} asset {asset!r}')
        parsed[asset] = validate_sha256_hex(digest, f'{component_label} SHA-256 for {asset}')
    return parsed


def _validate_zip_member_path(filename):
    if not isinstance(filename, str) or not filename:
        raise BumpError('Empty member filename in Deno zip archive')
    if '\x00' in filename or any(ord(ch) < 0x20 for ch in filename):
        raise BumpError('Control character in Deno zip member filename')
    if filename.startswith(('/', '\\')) or '\\' in filename or ':' in filename:
        raise BumpError(f'Unsafe zip member path in Deno archive: {filename!r}')
    parts = [part for part in filename.split('/') if part != '']
    if not parts or any(part in ('.', '..') for part in parts):
        raise BumpError(f'Unsafe zip member path (Zip Slip) in Deno archive: {filename!r}')


def _validate_zip_member_info(info):
    _validate_zip_member_path(info.filename)
    if info.flag_bits & 0x1:
        raise BumpError(f'Encrypted member is not allowed in Deno zip archive: {info.filename!r}')
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    if stat.S_ISLNK(unix_mode):
        raise BumpError(f'Symlink member is not allowed in Deno zip archive: {info.filename!r}')
    file_type = unix_mode & 0o170000
    if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise BumpError(f'Unsupported special file member in Deno zip archive: {info.filename!r}')
    if info.is_dir():
        raise BumpError(f'Unexpected directory member in Deno zip archive: {info.filename!r}')


def compute_deno_binary_sha256_from_zip(
    zip_source,
    *,
    max_zip_bytes=MAX_DENO_ZIP_BYTES,
    max_uncompressed_bytes=MAX_DENO_UNCOMPRESSED_BYTES,
):
    """Stream the inner 'deno' executable from a zip archive and return its SHA-256 hex digest.

    Never extracts files to disk, never executes anything, and never returns the outer .zip hash.
    """
    if isinstance(zip_source, (str, os.PathLike)):
        zip_path = Path(zip_source)
        try:
            st = zip_path.stat()
        except OSError as error:
            raise BumpError(f'Unable to stat Deno zip archive {zip_path.name}: {error}') from error
        if not stat.S_ISREG(st.st_mode):
            raise BumpError(f'Deno zip archive must be a regular file: {zip_path.name}')
        if st.st_size <= 0 or st.st_size > max_zip_bytes:
            raise BumpError(f'Deno zip archive size {st.st_size} is out of bounds')
        stream_ctx = zip_path.open('rb')
    elif hasattr(zip_source, 'read'):
        data = zip_source.read(max_zip_bytes + 1)
        if not isinstance(data, (bytes, bytearray)) or len(data) == 0 or len(data) > max_zip_bytes:
            raise BumpError('Deno zip archive stream is empty or exceeds maximum compressed size')
        stream_ctx = io.BytesIO(data)
    else:
        raise BumpError('Unsupported zip source type')

    try:
        with stream_ctx as raw_fp:
            with zipfile.ZipFile(raw_fp, mode='r') as zf:
                infos = zf.infolist()
                if not infos:
                    raise BumpError('Deno zip archive is empty; expected single "deno" binary member')
                for info in infos:
                    _validate_zip_member_info(info)
                if len(infos) != 1:
                    raise BumpError(
                        f'Expected single "deno" binary member in zip archive, found {len(infos)} members'
                    )
                target = infos[0]
                if target.filename != 'deno':
                    raise BumpError(
                        f'Missing "deno" binary member in zip archive (found {target.filename!r})'
                    )
                if target.file_size <= 0 or target.file_size > max_uncompressed_bytes:
                    raise BumpError(
                        f'Deno binary uncompressed size {target.file_size} is out of safe bounds'
                    )
                hasher = hashlib.sha256()
                total_read = 0
                with zf.open(target, mode='r') as member_fp:
                    while True:
                        chunk = member_fp.read(STREAM_CHUNK_BYTES)
                        if not chunk:
                            break
                        total_read += len(chunk)
                        if total_read > max_uncompressed_bytes:
                            raise BumpError('Deno zip member exceeded safe uncompressed byte limit while streaming')
                        hasher.update(chunk)
                if total_read != target.file_size or total_read <= 0:
                    raise BumpError('Deno zip member byte count did not match archive header')
                return hasher.hexdigest()
    except BumpError:
        raise
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, EOFError, RuntimeError) as error:
        raise BumpError(f'Invalid or corrupt Deno zip archive: {error}') from error


def parse_deno_sidecar_sha256(text, expected_zip_name):
    if not isinstance(text, str) or not text.strip():
        raise BumpError(f'Empty {expected_zip_name}.sha256sum response')
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) != 1:
        raise BumpError(f'Malformed {expected_zip_name}.sha256sum: expected single checksum line')
    match = _SIDECAR_SHA_RE.fullmatch(lines[0])
    if match is None:
        raise BumpError(f'Malformed {expected_zip_name}.sha256sum content')
    digest = validate_sha256_hex(match.group(1).lower(), f'{expected_zip_name}.sha256sum digest')
    raw_name = match.group(2)
    if raw_name is not None:
        cleaned = raw_name.strip().replace('\\', '/')
        if '..' in cleaned.split('/') or PurePosixPath(cleaned).name != expected_zip_name:
            raise BumpError(
                f'Filename mismatch in {expected_zip_name}.sha256sum: got {raw_name!r}'
            )
    return digest


def validate_official_url(url, *, allow_redirect_hosts=False):
    max_len = 8192 if allow_redirect_hosts else 2048
    if not isinstance(url, str) or not url or len(url) > max_len:
        raise BumpError('Invalid or oversized official release URL')
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https':
        raise BumpError(f'Official release URL must use HTTPS (got {parsed.scheme!r})')
    if parsed.username is not None or parsed.password is not None:
        raise BumpError('Official release URL must not include credentials')
    if parsed.port is not None:
        raise BumpError('Official release URL must not specify a non-default port')
    if parsed.fragment:
        raise BumpError('Official release URL must not include a URL fragment')
    host = (parsed.hostname or '').lower()
    if not host or parsed.netloc.lower() != host:
        raise BumpError('Malformed host in official release URL')
    path_segments = parsed.path.split('/')
    if '..' in path_segments or '.' in path_segments:
        raise BumpError('Path traversal is not allowed in official release URL')

    if allow_redirect_hosts:
        if host not in ALLOWED_REDIRECT_HOSTS:
            raise BumpError(f'Blocked redirect to untrusted host {host!r}')
        return url

    if host != ALLOWED_INITIAL_HOST:
        raise BumpError(f'Initial official download URL must target {ALLOWED_INITIAL_HOST!r}, got {host!r}')
    if parsed.query:
        raise BumpError('Initial official download URL must not contain query parameters')
    return url


def build_ytdlp_sums_url(ytdlp_version):
    validate_ytdlp_version(ytdlp_version)
    url = f'https://github.com/yt-dlp/yt-dlp/releases/download/{ytdlp_version}/SHA2-256SUMS'
    return validate_official_url(url, allow_redirect_hosts=False)


def build_deno_zip_url(deno_version, asset):
    validate_deno_version(deno_version)
    if asset not in REQUIRED_DENO_ASSETS:
        raise BumpError(f'Unknown Deno asset {asset!r}')
    url = f'https://github.com/denoland/deno/releases/download/v{deno_version}/{asset}.zip'
    return validate_official_url(url, allow_redirect_hosts=False)


class SafeGitHubReleaseRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Restricts every HTTP redirect hop strictly to HTTPS GitHub Release asset hosts."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if req.get_method() != 'GET':
            raise BumpError('Redirects are only permitted for GET requests')
        hops = getattr(req, '_dokitool_redirect_hops', 0) + 1
        if hops > MAX_REDIRECTS:
            raise BumpError(f'Exceeded maximum redirect hops ({MAX_REDIRECTS})')
        resolved = urllib.parse.urljoin(req.full_url, newurl)
        validate_official_url(resolved, allow_redirect_hosts=True)
        redirected = urllib.request.Request(
            resolved,
            headers={'User-Agent': 'DokiTool-Go-Runtime-Pin-Bumper'},
            method='GET',
        )
        redirected._dokitool_redirect_hops = hops
        return redirected


def build_official_opener(*extra_handlers):
    return urllib.request.build_opener(SafeGitHubReleaseRedirectHandler(), *extra_handlers)


class OfficialReleaseFetcher:
    """Controlled HTTPS-only fetcher for official yt-dlp and Deno GitHub Release artifacts."""

    def __init__(self, opener=None, timeout=DEFAULT_HTTP_TIMEOUT_SEC):
        self.opener = opener if opener is not None else build_official_opener()
        self.timeout = timeout

    def _get_bytes(self, url, *, max_bytes, allow_404=False):
        validate_official_url(url, allow_redirect_hosts=False)
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'DokiTool-Go-Runtime-Pin-Bumper'},
            method='GET',
        )
        req._dokitool_redirect_hops = 0
        try:
            with self.opener.open(req, timeout=self.timeout) as resp:
                resp_url = resp.geturl() if hasattr(resp, 'geturl') else url
                if resp_url:
                    validate_official_url(resp_url, allow_redirect_hosts=True)
                buf = bytearray()
                while True:
                    chunk = resp.read(STREAM_CHUNK_BYTES)
                    if not chunk:
                        break
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        raise BumpError(f'Official artifact response exceeded {max_bytes} byte safety cap')
                return bytes(buf)
        except BumpError:
            raise
        except urllib.error.HTTPError as error:
            if allow_404 and error.code == 404:
                return None
            raise BumpError(f'HTTP {error.code} while fetching official artifact {url}') from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
            raise BumpError(f'Network error while fetching official artifact {url}: {error}') from None

    def fetch_ytdlp_hashes(self, ytdlp_version):
        url = build_ytdlp_sums_url(ytdlp_version)
        raw = self._get_bytes(url, max_bytes=MAX_TEXT_RESPONSE_BYTES)
        try:
            text = raw.decode('utf-8')
        except UnicodeError as error:
            raise BumpError('yt-dlp SHA2-256SUMS response was not valid UTF-8') from error
        return parse_ytdlp_sums_text(text)

    def fetch_deno_hashes(self, deno_version, *, max_zip_bytes=MAX_DENO_ZIP_BYTES):
        validate_deno_version(deno_version)
        hashes = {}
        for asset in REQUIRED_DENO_ASSETS:
            zip_url = build_deno_zip_url(deno_version, asset)
            sidecar_url = validate_official_url(zip_url + '.sha256sum', allow_redirect_hosts=False)
            sidecar_raw = self._get_bytes(
                sidecar_url,
                max_bytes=MAX_TEXT_RESPONSE_BYTES,
                allow_404=True,
            )
            expected_zip_sha = None
            if sidecar_raw is not None:
                try:
                    sidecar_text = sidecar_raw.decode('utf-8')
                except UnicodeError as error:
                    raise BumpError(f'{asset}.zip.sha256sum response was not valid UTF-8') from error
                expected_zip_sha = parse_deno_sidecar_sha256(sidecar_text, f'{asset}.zip')

            zip_bytes = self._get_bytes(zip_url, max_bytes=max_zip_bytes)
            if expected_zip_sha is not None:
                actual_zip_sha = hashlib.sha256(zip_bytes).hexdigest()
                if actual_zip_sha != expected_zip_sha:
                    raise BumpError(
                        f'{asset}.zip SHA-256 mismatch against .sha256sum: '
                        f'got {actual_zip_sha}, expected {expected_zip_sha}'
                    )
            hashes[asset] = compute_deno_binary_sha256_from_zip(
                io.BytesIO(zip_bytes),
                max_zip_bytes=max_zip_bytes,
            )
        return _validate_complete_asset_hashes(hashes, REQUIRED_DENO_ASSETS, 'Deno')


def _replace_exact_count(pattern, repl, text, *, expected_count=None, min_count=1, description):
    updated, count = pattern.subn(repl, text)
    if expected_count is not None and count != expected_count:
        raise BumpError(f'Anchor mismatch for {description}: matched {count} times, expected {expected_count}')
    if count < min_count:
        raise BumpError(f'Missing anchor for {description}')
    return updated


def rewrite_engine_go(text, ytdlp_version, ytdlp_hashes):
    validate_ytdlp_version(ytdlp_version)
    hashes = _validate_complete_asset_hashes(ytdlp_hashes, REQUIRED_YTDLP_ASSETS, 'yt-dlp')
    updated = _replace_exact_count(
        _ENGINE_CONST_REPLACE_RE,
        lambda m: f'{m.group(1)}{ytdlp_version}{m.group(3)}',
        text,
        expected_count=1,
        description=f'PinnedVersion in {YTDLP_SOURCE_REL.as_posix()}',
    )
    entries_body = '\n' + ''.join(
        f'\t"{hashes[asset]}": "{asset}",\n' for asset in REQUIRED_YTDLP_ASSETS
    )
    updated = _replace_exact_count(
        _ENGINE_MAP_REPLACE_RE,
        lambda m: f'{m.group(1)}{entries_body}{m.group(3)}',
        updated,
        expected_count=1,
        description=f'OfficialSHA256Sums in {YTDLP_SOURCE_REL.as_posix()}',
    )
    return updated


def rewrite_gateway_workflow(text, ytdlp_version, ytdlp_linux_sha):
    validate_ytdlp_version(ytdlp_version)
    validate_sha256_hex(ytdlp_linux_sha, 'yt-dlp_linux SHA-256')
    rel = GATEWAY_ISOLATION_WORKFLOW_REL.as_posix()
    updated = _replace_exact_count(
        _GATEWAY_URL_REPLACE_RE,
        lambda m: f'{m.group(1)}{ytdlp_version}{m.group(3)}',
        text,
        min_count=1,
        description=f'yt-dlp_linux download URL in {rel}',
    )
    updated = _replace_exact_count(
        _GATEWAY_SHA_REPLACE_RE,
        lambda m: f'{m.group(1)}{ytdlp_linux_sha}{m.group(3)}',
        updated,
        expected_count=1,
        description=f'yt-dlp_linux sha256sum check in {rel}',
    )
    return updated


def rewrite_ejs_sandbox_go(text, deno_version, deno_hashes):
    validate_deno_version(deno_version)
    hashes = _validate_complete_asset_hashes(deno_hashes, REQUIRED_DENO_ASSETS, 'Deno')
    updated = _replace_exact_count(
        _SANDBOX_CONST_REPLACE_RE,
        lambda m: f'{m.group(1)}{deno_version}{m.group(3)}',
        text,
        expected_count=1,
        description=f'PinnedDenoVersion in {DENO_SOURCE_REL.as_posix()}',
    )
    entries_body = '\n' + ''.join(
        f'\t"{hashes[asset]}": "{asset}",\n' for asset in REQUIRED_DENO_ASSETS
    )
    updated = _replace_exact_count(
        _SANDBOX_MAP_REPLACE_RE,
        lambda m: f'{m.group(1)}{entries_body}{m.group(3)}',
        updated,
        expected_count=1,
        description=f'OfficialDenoSHA256Sums in {DENO_SOURCE_REL.as_posix()}',
    )
    return updated


def rewrite_release_build_workflow(text, deno_version, deno_linux_sha):
    validate_deno_version(deno_version)
    validate_sha256_hex(deno_linux_sha, 'deno-x86_64-unknown-linux-gnu SHA-256')
    rel = RELEASE_BUILD_WORKFLOW_REL.as_posix()
    updated = _replace_exact_count(
        _RELEASE_STEP_TITLE_REPLACE_RE,
        lambda m: f'{m.group(1)}{deno_version}{m.group(3)}',
        text,
        expected_count=1,
        description=f'Install pinned Deno step title in {rel}',
    )
    updated = _replace_exact_count(
        _RELEASE_URL_REPLACE_RE,
        lambda m: f'{m.group(1)}v{deno_version}{m.group(3)}',
        updated,
        min_count=1,
        description=f'Deno download URL in {rel}',
    )
    updated = _replace_exact_count(
        _RELEASE_SHA_REPLACE_RE,
        lambda m: f'{m.group(1)}{deno_linux_sha}{m.group(3)}',
        updated,
        expected_count=1,
        description=f'Deno sha256sum check in {rel}',
    )
    updated = _replace_exact_count(
        _RELEASE_ASSERT_REPLACE_RE,
        lambda m: f'{m.group(1)}{deno_version}{m.group(3)}',
        updated,
        min_count=1,
        description=f'Deno version assertion in {rel}',
    )
    return updated


def rewrite_validation_requirements(text, deno_version):
    validate_deno_version(deno_version)
    rel = VALIDATION_REQUIREMENTS_REL.as_posix()
    out_lines = []
    matched_count = 0
    for raw_line in text.splitlines(keepends=True):
        line_ending = ''
        body = raw_line
        if body.endswith('\r\n'):
            body, line_ending = body[:-2], '\r\n'
        elif body.endswith('\n'):
            body, line_ending = body[:-1], '\n'
        elif body.endswith('\r'):
            body, line_ending = body[:-1], '\r'

        code_part, sep, comment_part = body.partition('#')
        stripped_code = code_part.strip()
        if stripped_code and re.match(r'^deno(?![A-Za-z0-9_.-])(.*)$', stripped_code, re.IGNORECASE):
            matched_count += 1
            constraint = re.match(r'^deno(?![A-Za-z0-9_.-])(.*)$', stripped_code, re.IGNORECASE).group(1).strip()
            if re.fullmatch(r'==\s*\S+', constraint) is None:
                raise BumpError(f'Existing Deno requirement in {rel} is not an exact == pin')
            trailing_ws = code_part[len(code_part.rstrip()):]
            leading_ws = code_part[:len(code_part) - len(code_part.lstrip())]
            rebuilt = f'{leading_ws}deno=={deno_version}{trailing_ws}'
            if sep:
                rebuilt += f'#{comment_part}'
            out_lines.append(rebuilt + line_ending)
        else:
            out_lines.append(raw_line)

    if matched_count != 1:
        raise BumpError(f'Anchor mismatch for deno==<version> in {rel}: matched {matched_count} lines')
    return ''.join(out_lines)


def _write_file_atomic(path, raw_bytes):
    path = Path(path)
    mode = None
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError:
        mode = None
    fd, tmp_name = tempfile.mkstemp(prefix=f'.{path.name}.tmp-', dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, 'wb') as fp:
            fp.write(raw_bytes)
            fp.flush()
        if mode is not None:
            os.chmod(tmp_path, mode)
        os.replace(tmp_path, path)
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def _resolve_ytdlp_hashes_offline(sums_file, kv_items):
    if sums_file is not None and kv_items:
        raise BumpError('Cannot combine --ytdlp-sums-file and --ytdlp-sha256; choose one source')
    if sums_file is None and not kv_items:
        raise BumpError(
            'Offline yt-dlp update requires --ytdlp-sums-file <SHA2-256SUMS> or 6 --ytdlp-sha256 <asset>=<hex> flags '
            '(or pass --fetch-official)'
        )
    if sums_file is not None:
        sums_path = Path(sums_file)
        try:
            text = sums_path.read_text(encoding='utf-8')
        except (OSError, UnicodeError) as error:
            raise BumpError(f'Unable to read yt-dlp sums file {sums_path.name}: {error}') from error
        return parse_ytdlp_sums_text(text)
    parsed = parse_kv_sha256_items(kv_items, REQUIRED_YTDLP_ASSETS, 'yt-dlp')
    return _validate_complete_asset_hashes(parsed, REQUIRED_YTDLP_ASSETS, 'yt-dlp')


def _resolve_deno_hashes_offline(kv_items, zip_items):
    if not kv_items and not zip_items:
        raise BumpError(
            'Offline Deno update requires --deno-sha256 <asset>=<hex> and/or --deno-zip <asset>=<local.zip> '
            'covering all 4 required assets (or pass --fetch-official)'
        )
    hashes = parse_kv_sha256_items(kv_items, REQUIRED_DENO_ASSETS, 'Deno') if kv_items else {}
    allowed = set(REQUIRED_DENO_ASSETS)
    for raw in zip_items:
        if not isinstance(raw, str) or '=' not in raw:
            raise BumpError(f'Invalid --deno-zip entry {raw!r}; expected <asset>=<local.zip>')
        asset, _, raw_path = raw.partition('=')
        if asset not in allowed:
            raise BumpError(f'Unknown Deno asset {asset!r}')
        if asset in hashes:
            raise BumpError(f'Duplicate Deno asset {asset!r}')
        if not raw_path:
            raise BumpError(f'Missing zip path for Deno asset {asset!r}')
        hashes[asset] = compute_deno_binary_sha256_from_zip(Path(raw_path))
    return _validate_complete_asset_hashes(hashes, REQUIRED_DENO_ASSETS, 'Deno')


def run_bump(
    root=ROOT,
    *,
    ytdlp_version=None,
    deno_version=None,
    ytdlp_sums_file=None,
    ytdlp_sha256_items=(),
    deno_sha256_items=(),
    deno_zip_items=(),
    fetch_official=False,
    dry_run=False,
    opener=None,
):
    root = Path(root)
    if not root.is_dir():
        raise BumpError('Repository --root directory does not exist')

    if ytdlp_version is None and deno_version is None:
        raise BumpError('Specify at least one of --ytdlp-version or --deno-version')

    if ytdlp_version is not None:
        validate_ytdlp_version(ytdlp_version)
    elif ytdlp_sums_file is not None or ytdlp_sha256_items:
        raise BumpError('--ytdlp-sums-file / --ytdlp-sha256 require --ytdlp-version')

    if deno_version is not None:
        validate_deno_version(deno_version)
    elif deno_sha256_items or deno_zip_items:
        raise BumpError('--deno-sha256 / --deno-zip require --deno-version')

    if fetch_official and (ytdlp_sums_file is not None or ytdlp_sha256_items or deno_sha256_items or deno_zip_items):
        raise BumpError('--fetch-official cannot be combined with offline --*-sums-file / --*-sha256 / --deno-zip inputs')

    original_bytes = {}
    original_texts = {}
    for rel in LOCK_FILES:
        target = root / rel
        if not target.is_file() or target.is_symlink():
            raise BumpError(f'Missing or non-regular lock file: {rel.as_posix()}')
        try:
            raw = target.read_bytes()
            text = raw.decode('utf-8')
        except (OSError, UnicodeError) as error:
            raise BumpError(f'Unable to read lock file {rel.as_posix()}: {error}') from error
        original_bytes[rel] = raw
        original_texts[rel] = text

    try:
        previous_pinned = load_pinned_versions(root)
    except WatchError as error:
        raise BumpError(str(error)) from error

    fetcher = OfficialReleaseFetcher(opener=opener) if fetch_official else None

    ytdlp_hashes = None
    if ytdlp_version is not None:
        if fetch_official:
            ytdlp_hashes = fetcher.fetch_ytdlp_hashes(ytdlp_version)
        else:
            ytdlp_hashes = _resolve_ytdlp_hashes_offline(ytdlp_sums_file, ytdlp_sha256_items)

    deno_hashes = None
    if deno_version is not None:
        if fetch_official:
            deno_hashes = fetcher.fetch_deno_hashes(deno_version)
        else:
            deno_hashes = _resolve_deno_hashes_offline(deno_sha256_items, deno_zip_items)

    staged_texts = dict(original_texts)
    if ytdlp_version is not None:
        staged_texts[YTDLP_SOURCE_REL] = rewrite_engine_go(
            staged_texts[YTDLP_SOURCE_REL],
            ytdlp_version,
            ytdlp_hashes,
        )
        staged_texts[GATEWAY_ISOLATION_WORKFLOW_REL] = rewrite_gateway_workflow(
            staged_texts[GATEWAY_ISOLATION_WORKFLOW_REL],
            ytdlp_version,
            ytdlp_hashes['yt-dlp_linux'],
        )

    if deno_version is not None:
        staged_texts[DENO_SOURCE_REL] = rewrite_ejs_sandbox_go(
            staged_texts[DENO_SOURCE_REL],
            deno_version,
            deno_hashes,
        )
        staged_texts[RELEASE_BUILD_WORKFLOW_REL] = rewrite_release_build_workflow(
            staged_texts[RELEASE_BUILD_WORKFLOW_REL],
            deno_version,
            deno_hashes['deno-x86_64-unknown-linux-gnu'],
        )
        staged_texts[VALIDATION_REQUIREMENTS_REL] = rewrite_validation_requirements(
            staged_texts[VALIDATION_REQUIREMENTS_REL],
            deno_version,
        )

    with tempfile.TemporaryDirectory(prefix='dokitool-pin-stage-') as stage_dir:
        stage_root = Path(stage_dir)
        for rel in LOCK_FILES:
            dest = stage_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(staged_texts[rel].encode('utf-8'))
        try:
            verified_pinned = verify_local_pin_consistency(stage_root)
        except WatchError as error:
            raise BumpError(f'Staged lock-file consistency check failed: {error}') from error

    if ytdlp_version is not None and verified_pinned['yt-dlp/yt-dlp'] != ytdlp_version:
        raise BumpError('Staged yt-dlp version did not match requested version')
    if deno_version is not None and verified_pinned['denoland/deno'] != deno_version:
        raise BumpError('Staged Deno version did not match requested version')

    changed_rels = [rel for rel in LOCK_FILES if staged_texts[rel] != original_texts[rel]]
    diff_chunks = []
    for rel in changed_rels:
        posix_rel = rel.as_posix()
        diff_lines = difflib.unified_diff(
            original_texts[rel].splitlines(keepends=True),
            staged_texts[rel].splitlines(keepends=True),
            fromfile=f'a/{posix_rel}',
            tofile=f'b/{posix_rel}',
        )
        diff_chunks.append(''.join(diff_lines))
    unified_diff = ''.join(diff_chunks)

    if not dry_run and changed_rels:
        written = []
        try:
            for rel in changed_rels:
                _write_file_atomic(root / rel, staged_texts[rel].encode('utf-8'))
                written.append(rel)
            verify_local_pin_consistency(root)
        except Exception as error:
            rollback_errors = []
            for rel in reversed(written):
                try:
                    _write_file_atomic(root / rel, original_bytes[rel])
                except Exception as rb_err:
                    rollback_errors.append(f'{rel.as_posix()}: {rb_err}')
            if rollback_errors:
                raise BumpError(
                    f'Write failed ({error}); rollback encountered errors: {"; ".join(rollback_errors)}'
                ) from error
            if isinstance(error, BumpError):
                raise
            raise BumpError(f'Write failed and all modified lock files were rolled back: {error}') from error

    return {
        'dry_run': dry_run,
        'mode': 'official' if fetch_official else 'offline',
        'previous_pinned': previous_pinned,
        'pinned': verified_pinned,
        'changed_files': [rel.as_posix() for rel in changed_rels],
        'diff': unified_diff,
        'consistency_verified': True,
    }


def format_summary(result):
    action = 'DRY-RUN (no files written)' if result['dry_run'] else 'APPLIED'
    prev = result['previous_pinned']
    curr = result['pinned']
    lines = [
        f'Runtime pin update [{action}] (source: {result["mode"]}):',
        f'  yt-dlp/yt-dlp: {prev["yt-dlp/yt-dlp"]} -> {curr["yt-dlp/yt-dlp"]}',
        f'  denoland/deno: {prev["denoland/deno"]} -> {curr["denoland/deno"]}',
    ]
    if result['changed_files']:
        lines.append('  Changed lock files:')
        for rel in result['changed_files']:
            lines.append(f'    - {rel}')
    else:
        lines.append('  Changed lock files: none (already aligned)')
    lines.extend([
        f'  Self-check: verify_local_pin_consistency PASSED ({len(LOCK_FILES)} lock files synchronized)',
        '  Next steps & governance:',
        '    1. Review docs/go-migration/README.md (and PinnedEJSVersion / solver digests in '
        'backend/internal/platform/youtube/ejs_sandbox.go when upgrading yt-dlp) if applicable.',
        '    2. Run PR verification gates: python3 -B scripts/check-upstream-updates.py --check-local-pins, '
        'python3 -B -m unittest discover -s scripts/tests -v, '
        'and cd backend && GOTOOLCHAIN=local go test -race -count=1 ./...',
        '    3. Submit changes via a human-reviewed PR; this script never auto-commits, pushes, or deploys.',
    ])
    return '\n'.join(lines)


def build_arg_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--ytdlp-version',
        help='Target yt-dlp release version (YYYY.MM.DD or YYYY.MM.DD.N)',
    )
    parser.add_argument(
        '--deno-version',
        help='Target Deno release version (X.Y.Z, without leading "v")',
    )
    parser.add_argument(
        '--ytdlp-sums-file',
        type=Path,
        help='Offline path to official yt-dlp SHA2-256SUMS file',
    )
    parser.add_argument(
        '--ytdlp-sha256',
        action='append',
        default=[],
        metavar='ASSET=HEX',
        help='Offline repeatable SHA-256 override for each of the 6 required yt-dlp assets',
    )
    parser.add_argument(
        '--deno-sha256',
        action='append',
        default=[],
        metavar='ASSET=HEX',
        help='Offline repeatable SHA-256 of the extracted inner deno binary for each of the 4 required assets',
    )
    parser.add_argument(
        '--deno-zip',
        action='append',
        default=[],
        metavar='ASSET=ZIP_PATH',
        help='Offline repeatable path to official <asset>.zip (streams inner deno binary to compute SHA-256)',
    )
    parser.add_argument(
        '--fetch-official',
        action='store_true',
        help='Fetch official release checksums/archives over HTTPS from allowlisted GitHub Release hosts',
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Compute updates, run staged consistency check, and print unified diff without writing any files',
    )
    parser.add_argument(
        '--root',
        type=Path,
        default=ROOT,
        help='Repository root directory (defaults to checkout root)',
    )
    return parser


def main(argv=None):
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    result = run_bump(
        args.root,
        ytdlp_version=args.ytdlp_version,
        deno_version=args.deno_version,
        ytdlp_sums_file=args.ytdlp_sums_file,
        ytdlp_sha256_items=args.ytdlp_sha256,
        deno_sha256_items=args.deno_sha256,
        deno_zip_items=args.deno_zip,
        fetch_official=args.fetch_official,
        dry_run=args.dry_run,
    )
    if result['dry_run'] and result['diff']:
        sys.stdout.write(result['diff'])
        if not result['diff'].endswith('\n'):
            sys.stdout.write('\n')
    print(format_summary(result))
    return result


def cli(argv=None):
    try:
        main(argv)
    except BumpError as error:
        print(f'Runtime pin bump failed: {error}', file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'Runtime pin bump failed: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(cli())
