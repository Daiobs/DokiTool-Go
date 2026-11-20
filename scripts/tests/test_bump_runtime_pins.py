"""Offline unit and security tests for scripts/bump-runtime-pins.py."""
import email.message
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import zipfile

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
BUMP_SCRIPT = SCRIPTS_DIR / 'bump-runtime-pins.py'
WATCH_SCRIPT = SCRIPTS_DIR / 'check-upstream-updates.py'

_BUMP_SPEC = importlib.util.spec_from_file_location('bump_runtime_pins', BUMP_SCRIPT)
bump = importlib.util.module_from_spec(_BUMP_SPEC)
_BUMP_SPEC.loader.exec_module(bump)


def _sha256_of_label(label):
    return hashlib.sha256(label.encode('utf-8')).hexdigest()


SEED_YTDLP_VERSION = '2026.10.26'
SEED_DENO_VERSION = '2.9.8'

SEED_YTDLP_HASHES = {
    'yt-dlp': 'e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3',
    'yt-dlp_linux': '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795',
    'yt-dlp_linux_aarch64': 'e87e9533e89fe5889abaa21f5114dfe7756d6aa6219b83551add04d48b18e483',
    'yt-dlp_macos': '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa',
    'yt-dlp.exe': 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d',
    'yt-dlp_arm64.exe': '0066dbac3c124028e2dcae2a197fccee33cd91f456313d24f7af89fd54590e98',
}

SEED_DENO_HASHES = {
    'deno-x86_64-unknown-linux-gnu': '368bca08999e02c6911b8f248167b582276b1f547db5712b6e736d7eda1dbda7',
    'deno-aarch64-unknown-linux-gnu': 'b484f780e5149ca05c673f1f79f7fb466f12a2295933bdad917af4a8a5c020e8',
    'deno-aarch64-apple-darwin': 'd1e99265e5e6ee096c5780d88ff7d3e6cfdf33b1953a118b4889cab8ca6980ba',
    'deno-x86_64-apple-darwin': '5d206ba69742549cc161db06e86f1d93c5622e1dbc8ba9d15a618e538fbc92f4',
}

NEXT_YTDLP_HASHES = {
    asset: _sha256_of_label(f'yt-dlp-next:{asset}')
    for asset in bump.REQUIRED_YTDLP_ASSETS
}

NEXT_DENO_HASHES = {
    asset: _sha256_of_label(f'deno-next-inner-binary:{asset}')
    for asset in bump.REQUIRED_DENO_ASSETS
}


def write_realistic_lock_files(
    dest_root,
    *,
    ytdlp_version=SEED_YTDLP_VERSION,
    ytdlp_hashes=None,
    deno_version=SEED_DENO_VERSION,
    deno_hashes=None,
):
    ytdlp_hashes = dict(SEED_YTDLP_HASHES if ytdlp_hashes is None else ytdlp_hashes)
    deno_hashes = dict(SEED_DENO_HASHES if deno_hashes is None else deno_hashes)
    ytdlp_entries = ''.join(
        f'\t"{ytdlp_hashes[asset]}": "{asset}",\n' for asset in bump.REQUIRED_YTDLP_ASSETS
    )
    deno_entries = ''.join(
        f'\t"{deno_hashes[asset]}": "{asset}",\n' for asset in bump.REQUIRED_DENO_ASSETS
    )
    files = {
        bump.YTDLP_SOURCE_REL: (
            'package ytengine\n\n'
            '// PinnedVersion is the locked yt-dlp release approved for this build.\n'
            f'const PinnedVersion = "{ytdlp_version}"\n\n'
            '// OfficialSHA256Sums contains the official SHA2-256SUMS for PinnedVersion.\n'
            'var OfficialSHA256Sums = map[string]string{\n'
            f'{ytdlp_entries}'
            '}\n'
        ),
        bump.DENO_SOURCE_REL: (
            'package youtube\n\n'
            'const (\n'
            f'\tPinnedDenoVersion = "{deno_version}"\n'
            '\tPinnedEJSVersion  = "0.8.0"\n'
            ')\n\n'
            'var OfficialDenoSHA256Sums = map[string]string{\n'
            f'{deno_entries}'
            '}\n'
        ),
        bump.RELEASE_BUILD_WORKFLOW_REL: (
            'name: Release build\n'
            'jobs:\n'
            '  build-and-publish:\n'
            '    steps:\n'
            f'      - name: Install pinned Deno {deno_version}\n'
            '        run: |\n'
            '          set -euo pipefail\n'
            '          curl --fail --silent --show-error --location \\\n'
            f'            https://github.com/denoland/deno/releases/download/v{deno_version}/deno-x86_64-unknown-linux-gnu.zip \\\n'
            '            --output "$RUNNER_TEMP/deno/deno.zip"\n'
            '          unzip -q -o "$RUNNER_TEMP/deno/deno.zip" -d "$RUNNER_TEMP/deno"\n'
            f'          echo "{deno_hashes["deno-x86_64-unknown-linux-gnu"]}  $RUNNER_TEMP/deno/deno" | sha256sum --check --strict\n'
            '          case "$first_line" in\n'
            f'            "deno {deno_version}"|"deno {deno_version} "*) ;;\n'
            '            *) exit 1 ;;\n'
            '          esac\n'
        ),
        bump.GATEWAY_ISOLATION_WORKFLOW_REL: (
            'name: Gateway isolation\n'
            'jobs:\n'
            '  controlled-gateway:\n'
            '    steps:\n'
            '      - name: Stage the pinned extractor for controlled proxy handshakes\n'
            '        run: |\n'
            '          curl --fail --silent --show-error --location \\\n'
            f'            https://github.com/yt-dlp/yt-dlp/releases/download/{ytdlp_version}/yt-dlp_linux \\\n'
            '            --output "$RUNNER_TEMP/gateway-bin/yt-dlp_linux"\n'
            f'          echo \'{ytdlp_hashes["yt-dlp_linux"]}  \'"$RUNNER_TEMP/gateway-bin/yt-dlp_linux" | sha256sum --check --strict\n'
        ),
        bump.VALIDATION_REQUIREMENTS_REL: (
            '# Development/CI contract validation only; not an application runtime dependency.\n'
            'jsonschema>=4.17.3,<5\n'
            f'deno=={deno_version}\n'
        ),
    }
    for rel, content in files.items():
        target = Path(dest_root) / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')


def snapshot_lock_bytes(root):
    return {rel: (Path(root) / rel).read_bytes() for rel in bump.LOCK_FILES}


def make_ytdlp_sums_text(hashes=None, *, include_extra_official_assets=True):
    hashes = NEXT_YTDLP_HASHES if hashes is None else hashes
    lines = [f'{hashes[asset]}  {asset}' for asset in bump.REQUIRED_YTDLP_ASSETS]
    if include_extra_official_assets:
        lines.append(f'{_sha256_of_label("yt-dlp.tar.gz")}  yt-dlp.tar.gz')
        lines.append(f'{_sha256_of_label("yt-dlp_min.exe")} *yt-dlp_min.exe')
    return '\n'.join(lines) + '\n'


def build_deno_zip_bytes(inner_payload, *, member_name='deno', unix_mode=stat.S_IFREG | 0o755, extra_members=()):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
        info = zipfile.ZipInfo(member_name)
        info.create_system = 3
        info.external_attr = (unix_mode & 0xFFFF) << 16
        zf.writestr(info, inner_payload)
        for extra_name, extra_data, extra_mode in extra_members:
            extra_info = zipfile.ZipInfo(extra_name)
            extra_info.create_system = 3
            extra_info.external_attr = (extra_mode & 0xFFFF) << 16
            zf.writestr(extra_info, extra_data)
    return buf.getvalue()


class _FakeHTTPResponse(io.BytesIO):
    def __init__(self, body_bytes, url, status=200, headers=None):
        super().__init__(body_bytes)
        self._url = url
        self.status = status
        self.code = status
        self.msg = f'HTTP {status}'
        msg = email.message.Message()
        for key, value in (headers or {}).items():
            msg[key] = value
        self.headers = msg

    def geturl(self):
        return self._url

    def info(self):
        return self.headers


class _MockHTTPSHandler(urllib.request.HTTPSHandler):
    """In-memory HTTPS/HTTP handler exercising real urllib OpenerDirector + redirect handler."""

    def __init__(self, routes):
        super().__init__()
        self.routes = dict(routes)
        self.requested_urls = []

    def https_open(self, req):
        return self._dispatch(req)

    def http_open(self, req):
        return self._dispatch(req)

    def _dispatch(self, req):
        url = req.full_url
        self.requested_urls.append(url)
        if url not in self.routes:
            raise AssertionError(f'Unexpected mock HTTP request to {url}')
        status, headers, body = self.routes[url]
        resp = _FakeHTTPResponse(body, url, status=status, headers=headers)
        if 200 <= status < 300:
            return resp
        return self.parent.error('http', req, resp, status, f'HTTP {status}', resp.headers)


class ArchitectureAndReuseTests(unittest.TestCase):
    def test_reuses_authoritative_watch_constants_and_never_imports_subprocess(self):
        self.assertIs(bump.YTDLP_VERSION_RE, bump._WATCH.YTDLP_VERSION_RE)
        self.assertIs(bump.DENO_VERSION_RE, bump._WATCH.DENO_VERSION_RE)
        self.assertIs(bump.SHA256_HEX_RE, bump._WATCH.SHA256_HEX_RE)
        self.assertEqual(bump.LOCK_FILES, bump._WATCH.LOCK_FILES)
        self.assertIs(bump.verify_local_pin_consistency, bump._WATCH.verify_local_pin_consistency)
        source_text = BUMP_SCRIPT.read_text(encoding='utf-8')
        self.assertNotIn('import subprocess', source_text)
        self.assertNotIn('os.system', source_text)


class OfflineBumpTests(unittest.TestCase):
    def test_ytdlp_only_bump_via_sums_file_updates_two_files_and_passes_consistency(self):
        for target_ver in ('2026.11.15', '2026.11.15.1'):
            with self.subTest(version=target_ver), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / 'repo'
                write_realistic_lock_files(root)
                before = snapshot_lock_bytes(root)
                sums_file = Path(tmp) / 'SHA2-256SUMS'
                sums_file.write_text(make_ytdlp_sums_text(), encoding='utf-8')

                result = bump.run_bump(
                    root,
                    ytdlp_version=target_ver,
                    ytdlp_sums_file=sums_file,
                )
                self.assertEqual(
                    result['changed_files'],
                    [
                        bump.YTDLP_SOURCE_REL.as_posix(),
                        bump.GATEWAY_ISOLATION_WORKFLOW_REL.as_posix(),
                    ],
                )
                self.assertEqual(
                    result['pinned'],
                    {'yt-dlp/yt-dlp': target_ver, 'denoland/deno': SEED_DENO_VERSION},
                )
                self.assertEqual(bump.verify_local_pin_consistency(root), result['pinned'])

                # Deno files must remain 100% byte-identical.
                after = snapshot_lock_bytes(root)
                for untouched in (
                    bump.DENO_SOURCE_REL,
                    bump.RELEASE_BUILD_WORKFLOW_REL,
                    bump.VALIDATION_REQUIREMENTS_REL,
                ):
                    self.assertEqual(after[untouched], before[untouched])

                engine_text = (root / bump.YTDLP_SOURCE_REL).read_text(encoding='utf-8')
                self.assertIn(f'const PinnedVersion = "{target_ver}"', engine_text)
                for asset, digest in NEXT_YTDLP_HASHES.items():
                    self.assertIn(f'\t"{digest}": "{asset}",', engine_text)

                gw_text = (root / bump.GATEWAY_ISOLATION_WORKFLOW_REL).read_text(encoding='utf-8')
                self.assertIn(f'/releases/download/{target_ver}/yt-dlp_linux', gw_text)
                self.assertIn(NEXT_YTDLP_HASHES['yt-dlp_linux'], gw_text)

    def test_deno_only_bump_via_sha256_and_zip_distinguishes_inner_binary_from_zip_archive(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Case A: --deno-zip proves inner deno binary SHA-256 != outer .zip SHA-256
            root_zip = Path(tmp) / 'repo-zip'
            write_realistic_lock_files(root_zip)
            before_zip = snapshot_lock_bytes(root_zip)
            zip_dir = Path(tmp) / 'zips'
            zip_dir.mkdir()

            expected_inner = {}
            outer_zip_shas = {}
            zip_args = []
            for asset in bump.REQUIRED_DENO_ASSETS:
                inner_bytes = f'ELF-FAKE-DENO-BINARY:{asset}:v2.10.1\n'.encode('utf-8')
                zip_bytes = build_deno_zip_bytes(inner_bytes)
                inner_sha = hashlib.sha256(inner_bytes).hexdigest()
                outer_sha = hashlib.sha256(zip_bytes).hexdigest()
                self.assertNotEqual(inner_sha, outer_sha)
                expected_inner[asset] = inner_sha
                outer_zip_shas[asset] = outer_sha
                zpath = zip_dir / f'{asset}.zip'
                zpath.write_bytes(zip_bytes)
                zip_args.append(f'{asset}={zpath}')

            res_zip = bump.run_bump(
                root_zip,
                deno_version='2.10.1',
                deno_zip_items=zip_args,
            )
            self.assertEqual(
                res_zip['changed_files'],
                [
                    bump.DENO_SOURCE_REL.as_posix(),
                    bump.RELEASE_BUILD_WORKFLOW_REL.as_posix(),
                    bump.VALIDATION_REQUIREMENTS_REL.as_posix(),
                ],
            )
            self.assertEqual(bump.verify_local_pin_consistency(root_zip)['denoland/deno'], '2.10.1')

            after_zip = snapshot_lock_bytes(root_zip)
            self.assertEqual(after_zip[bump.YTDLP_SOURCE_REL], before_zip[bump.YTDLP_SOURCE_REL])
            self.assertEqual(
                after_zip[bump.GATEWAY_ISOLATION_WORKFLOW_REL],
                before_zip[bump.GATEWAY_ISOLATION_WORKFLOW_REL],
            )

            sandbox_text = (root_zip / bump.DENO_SOURCE_REL).read_text(encoding='utf-8')
            rel_wf_text = (root_zip / bump.RELEASE_BUILD_WORKFLOW_REL).read_text(encoding='utf-8')
            reqs_text = (root_zip / bump.VALIDATION_REQUIREMENTS_REL).read_text(encoding='utf-8')
            for asset in bump.REQUIRED_DENO_ASSETS:
                self.assertIn(f'\t"{expected_inner[asset]}": "{asset}",', sandbox_text)
                self.assertNotIn(outer_zip_shas[asset], sandbox_text)
                self.assertNotIn(outer_zip_shas[asset], rel_wf_text)

            self.assertIn('- name: Install pinned Deno 2.10.1', rel_wf_text)
            self.assertIn('/releases/download/v2.10.1/deno-x86_64-unknown-linux-gnu.zip', rel_wf_text)
            self.assertIn(
                f'{expected_inner["deno-x86_64-unknown-linux-gnu"]}  $RUNNER_TEMP/deno/deno',
                rel_wf_text,
            )
            self.assertIn('"deno 2.10.1"|"deno 2.10.1 "*) ;;', rel_wf_text)
            self.assertIn('deno==2.10.1\n', reqs_text)

            # Case B: --deno-sha256 produces the exact same 3-file output
            root_hex = Path(tmp) / 'repo-hex'
            write_realistic_lock_files(root_hex)
            bump.run_bump(
                root_hex,
                deno_version='2.10.1',
                deno_sha256_items=[f'{asset}={expected_inner[asset]}' for asset in bump.REQUIRED_DENO_ASSETS],
            )
            self.assertEqual(snapshot_lock_bytes(root_hex), snapshot_lock_bytes(root_zip))

    def test_combined_five_file_bump_cli_and_check_local_pins_subprocesses(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            write_realistic_lock_files(root)

            cmd = [
                sys.executable,
                '-B',
                str(BUMP_SCRIPT),
                '--root',
                str(root),
                '--ytdlp-version',
                '2026.12.01',
                '--deno-version',
                '2.11.0',
            ]
            for asset, digest in NEXT_YTDLP_HASHES.items():
                cmd.extend(['--ytdlp-sha256', f'{asset}={digest}'])
            for asset, digest in NEXT_DENO_HASHES.items():
                cmd.extend(['--deno-sha256', f'{asset}={digest}'])

            proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            self.assertIn('Runtime pin update [APPLIED]', proc.stdout)
            self.assertIn('docs/go-migration/README.md', proc.stdout)
            self.assertIn('never auto-commits, pushes, or deploys', proc.stdout)

            gate = subprocess.run(
                [sys.executable, '-B', str(WATCH_SCRIPT), '--check-local-pins', '--root', str(root)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(gate.returncode, 0, msg=gate.stderr)

            # Second identical invocation is a clean no-op.
            after_first = snapshot_lock_bytes(root)
            second = bump.run_bump(
                root,
                ytdlp_version='2026.12.01',
                deno_version='2.11.0',
                ytdlp_sha256_items=[f'{k}={v}' for k, v in NEXT_YTDLP_HASHES.items()],
                deno_sha256_items=[f'{k}={v}' for k, v in NEXT_DENO_HASHES.items()],
            )
            self.assertEqual(second['changed_files'], [])
            self.assertEqual(second['diff'], '')
            self.assertEqual(snapshot_lock_bytes(root), after_first)

    def test_dry_run_outputs_unified_diff_and_leaves_disk_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            write_realistic_lock_files(root)
            before = snapshot_lock_bytes(root)
            sums_file = Path(tmp) / 'SHA2-256SUMS'
            sums_file.write_text(make_ytdlp_sums_text(), encoding='utf-8')

            proc = subprocess.run(
                [
                    sys.executable,
                    '-B',
                    str(BUMP_SCRIPT),
                    '--dry-run',
                    '--root',
                    str(root),
                    '--ytdlp-version',
                    '2026.11.20',
                    '--ytdlp-sums-file',
                    str(sums_file),
                    '--deno-version',
                    '2.10.2',
                    *[f'--deno-sha256={k}={v}' for k, v in NEXT_DENO_HASHES.items()],
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, msg=proc.stderr)
            self.assertIn('--- a/backend/internal/ytengine/engine.go', proc.stdout)
            self.assertIn('+++ b/.github/workflows/release-build.yml', proc.stdout)
            self.assertIn('DRY-RUN (no files written)', proc.stdout)
            self.assertEqual(snapshot_lock_bytes(root), before)


class FailClosedAndRollbackTests(unittest.TestCase):
    def test_invalid_versions_digests_and_asset_sets_fail_closed_with_zero_disk_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            write_realistic_lock_files(root)
            before = snapshot_lock_bytes(root)

            bad_cases = [
                ('no-target-version', []),
                (
                    'ytdlp-leading-v',
                    ['--ytdlp-version', 'v2026.11.01', *[f'--ytdlp-sha256={k}={v}' for k, v in NEXT_YTDLP_HASHES.items()]],
                ),
                (
                    'deno-leading-v',
                    ['--deno-version', 'v2.10.0', *[f'--deno-sha256={k}={v}' for k, v in NEXT_DENO_HASHES.items()]],
                ),
                (
                    'uppercase-sha256-rejected',
                    [
                        '--deno-version',
                        '2.10.0',
                        *(
                            f'--deno-sha256={k}={v.upper() if i == 0 else v}'
                            for i, (k, v) in enumerate(NEXT_DENO_HASHES.items())
                        ),
                    ],
                ),
                (
                    'short-sha256-rejected',
                    [
                        '--ytdlp-version',
                        '2026.11.01',
                        *(
                            f'--ytdlp-sha256={k}={"abcd" if i == 0 else v}'
                            for i, (k, v) in enumerate(NEXT_YTDLP_HASHES.items())
                        ),
                    ],
                ),
                (
                    'missing-ytdlp-asset',
                    [
                        '--ytdlp-version',
                        '2026.11.01',
                        *[f'--ytdlp-sha256={k}={v}' for k, v in list(NEXT_YTDLP_HASHES.items())[:-1]],
                    ],
                ),
                (
                    'duplicate-deno-asset',
                    [
                        '--deno-version',
                        '2.10.0',
                        *[f'--deno-sha256={k}={v}' for k, v in NEXT_DENO_HASHES.items()],
                        f'--deno-sha256=deno-aarch64-apple-darwin={NEXT_DENO_HASHES["deno-aarch64-apple-darwin"]}',
                    ],
                ),
                (
                    'unknown-asset',
                    ['--deno-version', '2.10.0', f'--deno-sha256=deno-pc-windows-msvc={_sha256_of_label("win")}'],
                ),
                (
                    'fetch-official-mixed-with-offline',
                    [
                        '--fetch-official',
                        '--deno-version',
                        '2.10.0',
                        *[f'--deno-sha256={k}={v}' for k, v in NEXT_DENO_HASHES.items()],
                    ],
                ),
            ]
            for label, argv in bad_cases:
                with self.subTest(case=label):
                    err_buf = io.StringIO()
                    with patch.object(sys, 'stderr', err_buf):
                        rc = bump.cli(['--root', str(root), *argv])
                    self.assertEqual(rc, 1)
                    self.assertEqual(snapshot_lock_bytes(root), before)

    def test_hostile_and_malformed_deno_zip_archives_are_rejected_without_disk_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            write_realistic_lock_files(root)
            before = snapshot_lock_bytes(root)
            zdir = Path(tmp) / 'bad-zips'
            zdir.mkdir()

            valid_others = {}
            for asset in bump.REQUIRED_DENO_ASSETS[1:]:
                p = zdir / f'ok-{asset}.zip'
                p.write_bytes(build_deno_zip_bytes(f'ok-{asset}'.encode('utf-8')))
                valid_others[asset] = p

            empty_buf = io.BytesIO()
            with zipfile.ZipFile(empty_buf, 'w'):
                pass

            hostile_zips = [
                ('zip-slip-parent', build_deno_zip_bytes(b'evil', member_name='../deno')),
                ('zip-slip-nested', build_deno_zip_bytes(b'evil', member_name='sub/../../deno')),
                ('zip-absolute-path', build_deno_zip_bytes(b'evil', member_name='/deno')),
                ('zip-backslash-path', build_deno_zip_bytes(b'evil', member_name='..\\deno')),
                ('missing-deno-member', build_deno_zip_bytes(b'wrong', member_name='README.md')),
                ('subdir-deno-member', build_deno_zip_bytes(b'wrong', member_name='bin/deno')),
                (
                    'multiple-members',
                    build_deno_zip_bytes(
                        b'binary',
                        extra_members=[('extra.txt', b'extra', stat.S_IFREG | 0o644)],
                    ),
                ),
                ('symlink-member', build_deno_zip_bytes(b'/etc/passwd', unix_mode=stat.S_IFLNK | 0o777)),
                ('zero-byte-deno', build_deno_zip_bytes(b'')),
                ('empty-archive', empty_buf.getvalue()),
                ('corrupt-not-a-zip', b'not-a-valid-zip-archive'),
            ]

            first_asset = bump.REQUIRED_DENO_ASSETS[0]
            for label, payload in hostile_zips:
                with self.subTest(case=label):
                    bad_path = zdir / f'{label}.zip'
                    bad_path.write_bytes(payload)
                    zip_items = [
                        f'{first_asset}={bad_path}',
                        *(f'{asset}={path}' for asset, path in valid_others.items()),
                    ]
                    with self.assertRaises(bump.BumpError):
                        bump.run_bump(root, deno_version='2.10.5', deno_zip_items=zip_items)
                    self.assertEqual(snapshot_lock_bytes(root), before)

            # Excessive uncompressed size check (without allocating 200 MiB in test).
            oversized = zdir / 'oversized.zip'
            oversized.write_bytes(build_deno_zip_bytes(b'x' * 4096))
            with self.assertRaisesRegex(bump.BumpError, 'uncompressed'):
                bump.compute_deno_binary_sha256_from_zip(oversized, max_uncompressed_bytes=1024)

    def test_missing_regex_anchors_or_preexisting_drift_fail_closed_before_writing(self):
        mutations = [
            ('missing-ytdlp-const', bump.YTDLP_SOURCE_REL, lambda s: s.replace('PinnedVersion', 'OtherConst')),
            ('missing-ytdlp-map', bump.YTDLP_SOURCE_REL, lambda s: s.replace('OfficialSHA256Sums', 'OtherSums')),
            ('missing-gateway-sha', bump.GATEWAY_ISOLATION_WORKFLOW_REL, lambda s: s.replace('sha256sum', 'md5sum')),
            ('missing-deno-const', bump.DENO_SOURCE_REL, lambda s: s.replace('PinnedDenoVersion', 'OtherDenoVer')),
            ('missing-deno-map', bump.DENO_SOURCE_REL, lambda s: s.replace('OfficialDenoSHA256Sums', 'OtherDenoSums')),
            ('missing-release-title', bump.RELEASE_BUILD_WORKFLOW_REL, lambda s: s.replace('Install pinned Deno', 'Setup Deno')),
            ('missing-release-assert', bump.RELEASE_BUILD_WORKFLOW_REL, lambda s: s.replace('"deno ', '"runtime ')),
            ('missing-reqs-deno', bump.VALIDATION_REQUIREMENTS_REL, lambda s: s.replace('deno==2.9.8\n', '')),
        ]
        for label, rel, mutate in mutations:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / 'repo'
                write_realistic_lock_files(root)
                target = root / rel
                target.write_text(mutate(target.read_text(encoding='utf-8')), encoding='utf-8')
                before = snapshot_lock_bytes(root)

                with self.assertRaises(bump.BumpError):
                    bump.run_bump(
                        root,
                        ytdlp_version='2026.11.30',
                        deno_version='2.10.3',
                        ytdlp_sha256_items=[f'{k}={v}' for k, v in NEXT_YTDLP_HASHES.items()],
                        deno_sha256_items=[f'{k}={v}' for k, v in NEXT_DENO_HASHES.items()],
                    )
                self.assertEqual(snapshot_lock_bytes(root), before)

        # Pre-existing drift in Deno blocks a yt-dlp-only bump during staged check before writing --root.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'drifted'
            write_realistic_lock_files(root)
            reqs = root / bump.VALIDATION_REQUIREMENTS_REL
            reqs.write_text(reqs.read_text(encoding='utf-8').replace('deno==2.9.8', 'deno==2.9.7'), encoding='utf-8')
            before = snapshot_lock_bytes(root)
            with self.assertRaisesRegex(bump.BumpError, 'Staged lock-file consistency check failed'):
                bump.run_bump(
                    root,
                    ytdlp_version='2026.11.30',
                    ytdlp_sha256_items=[f'{k}={v}' for k, v in NEXT_YTDLP_HASHES.items()],
                )
            self.assertEqual(snapshot_lock_bytes(root), before)

    def test_mid_flight_write_failure_rolls_back_earlier_files_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            write_realistic_lock_files(root)
            before = snapshot_lock_bytes(root)

            real_write = bump._write_file_atomic
            call_count = {'n': 0}

            def flaky_write(path, raw_bytes):
                call_count['n'] += 1
                if call_count['n'] == 3:
                    raise OSError('simulated disk full on 3rd lock file')
                return real_write(path, raw_bytes)

            with patch.object(bump, '_write_file_atomic', side_effect=flaky_write):
                with self.assertRaisesRegex(bump.BumpError, 'rolled back'):
                    bump.run_bump(
                        root,
                        ytdlp_version='2026.12.05',
                        deno_version='2.10.9',
                        ytdlp_sha256_items=[f'{k}={v}' for k, v in NEXT_YTDLP_HASHES.items()],
                        deno_sha256_items=[f'{k}={v}' for k, v in NEXT_DENO_HASHES.items()],
                    )
            self.assertEqual(snapshot_lock_bytes(root), before)


class FetchOfficialMockTransportTests(unittest.TestCase):
    def test_fetch_official_follows_allowlisted_redirects_verifies_sidecar_and_extracts_inner_deno(self):
        ytdlp_ver = '2026.12.10'
        deno_ver = '2.11.2'
        sums_bytes = make_ytdlp_sums_text().encode('utf-8')

        routes = {
            f'https://github.com/yt-dlp/yt-dlp/releases/download/{ytdlp_ver}/SHA2-256SUMS': (
                302,
                {'Location': 'https://objects.githubusercontent.com/github-production-release-asset/ytdlp-sums?sig=ok'},
                b'',
            ),
            'https://objects.githubusercontent.com/github-production-release-asset/ytdlp-sums?sig=ok': (
                200,
                {},
                sums_bytes,
            ),
        }

        expected_deno_inner = {}
        for idx, asset in enumerate(bump.REQUIRED_DENO_ASSETS):
            inner_bytes = f'OFFICIAL-DENO-INNER:{asset}:{deno_ver}'.encode('utf-8')
            zip_bytes = build_deno_zip_bytes(inner_bytes)
            zip_sha = hashlib.sha256(zip_bytes).hexdigest()
            expected_deno_inner[asset] = hashlib.sha256(inner_bytes).hexdigest()

            zip_gh_url = f'https://github.com/denoland/deno/releases/download/v{deno_ver}/{asset}.zip'
            cdn_host = (
                'release-assets.githubusercontent.com'
                if idx % 2 == 0
                else 'objects.githubusercontent.com'
            )
            zip_cdn_url = f'https://{cdn_host}/deno-assets/{asset}.zip?token=presigned'
            routes[zip_gh_url] = (302, {'Location': zip_cdn_url}, b'')
            routes[zip_cdn_url] = (200, {}, zip_bytes)

            sidecar_gh_url = zip_gh_url + '.sha256sum'
            if idx == 0:
                # Exercise optional 404 sidecar on first asset.
                routes[sidecar_gh_url] = (404, {}, b'Not Found')
            else:
                sidecar_cdn_url = f'https://{cdn_host}/deno-assets/{asset}.zip.sha256sum?token=presigned'
                routes[sidecar_gh_url] = (302, {'Location': sidecar_cdn_url}, b'')
                routes[sidecar_cdn_url] = (
                    200,
                    {},
                    f'{zip_sha}  ./target/release/{asset}.zip\n'.encode('utf-8'),
                )

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            write_realistic_lock_files(root)
            handler = _MockHTTPSHandler(routes)
            opener = bump.build_official_opener(handler)

            result = bump.run_bump(
                root,
                ytdlp_version=ytdlp_ver,
                deno_version=deno_ver,
                fetch_official=True,
                opener=opener,
            )
            self.assertEqual(result['mode'], 'official')
            self.assertEqual(len(result['changed_files']), 5)
            self.assertEqual(
                bump.verify_local_pin_consistency(root),
                {'yt-dlp/yt-dlp': ytdlp_ver, 'denoland/deno': deno_ver},
            )
            sandbox_text = (root / bump.DENO_SOURCE_REL).read_text(encoding='utf-8')
            for asset, inner_sha in expected_deno_inner.items():
                self.assertIn(f'\t"{inner_sha}": "{asset}",', sandbox_text)

    def test_fetch_official_blocks_untrusted_redirects_sidecar_mismatch_and_oversized_payloads(self):
        ytdlp_ver = '2026.12.11'
        gh_sums_url = f'https://github.com/yt-dlp/yt-dlp/releases/download/{ytdlp_ver}/SHA2-256SUMS'

        blocked_redirects = [
            ('evil-host', 'https://evil.example.org/SHA2-256SUMS'),
            ('lookalike-host', 'https://objects.githubusercontent.com.evil.test/SHA2-256SUMS'),
            ('http-downgrade', 'http://objects.githubusercontent.com/SHA2-256SUMS'),
            ('custom-port', 'https://objects.githubusercontent.com:8443/SHA2-256SUMS'),
            ('credentials-in-url', 'https://token:secret@objects.githubusercontent.com/SHA2-256SUMS'),
            ('path-traversal', 'https://objects.githubusercontent.com/assets/../SHA2-256SUMS'),
            ('url-fragment', 'https://objects.githubusercontent.com/SHA2-256SUMS#frag'),
        ]

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            write_realistic_lock_files(root)
            before = snapshot_lock_bytes(root)

            for label, bad_location in blocked_redirects:
                with self.subTest(redirect=label):
                    handler = _MockHTTPSHandler({
                        gh_sums_url: (302, {'Location': bad_location}, b''),
                        bad_location: (200, {}, make_ytdlp_sums_text().encode('utf-8')),
                    })
                    opener = bump.build_official_opener(handler)
                    with self.assertRaises(bump.BumpError):
                        bump.run_bump(root, ytdlp_version=ytdlp_ver, fetch_official=True, opener=opener)
                    self.assertEqual(handler.requested_urls, [gh_sums_url])
                    self.assertEqual(snapshot_lock_bytes(root), before)

            # Sidecar .zip.sha256sum mismatch rejects tampered zip before extracting inner binary.
            deno_ver = '2.11.3'
            first_asset = bump.REQUIRED_DENO_ASSETS[0]
            zip_url = f'https://github.com/denoland/deno/releases/download/v{deno_ver}/{first_asset}.zip'
            tampered_zip = build_deno_zip_bytes(b'tampered-deno-binary')
            wrong_zip_sha = '0' * 64
            sidecar_handler = _MockHTTPSHandler({
                zip_url + '.sha256sum': (200, {}, f'{wrong_zip_sha}  {first_asset}.zip\n'.encode('utf-8')),
                zip_url: (200, {}, tampered_zip),
            })
            with self.assertRaisesRegex(bump.BumpError, 'SHA-256 mismatch against .sha256sum'):
                bump.run_bump(
                    root,
                    deno_version=deno_ver,
                    fetch_official=True,
                    opener=bump.build_official_opener(sidecar_handler),
                )
            self.assertEqual(snapshot_lock_bytes(root), before)

            # Oversized text response (> MAX_TEXT_RESPONSE_BYTES) rejected fail-closed.
            oversize_handler = _MockHTTPSHandler({
                gh_sums_url: (200, {}, b'a' * (bump.MAX_TEXT_RESPONSE_BYTES + 64)),
            })
            with self.assertRaisesRegex(bump.BumpError, 'safety cap'):
                bump.run_bump(
                    root,
                    ytdlp_version=ytdlp_ver,
                    fetch_official=True,
                    opener=bump.build_official_opener(oversize_handler),
                )
            self.assertEqual(snapshot_lock_bytes(root), before)

            # Excessive redirect hops (> MAX_REDIRECTS) rejected fail-closed.
            chain_routes = {
                gh_sums_url: (302, {'Location': 'https://objects.githubusercontent.com/hop/1'}, b''),
            }
            for hop in range(1, bump.MAX_REDIRECTS + 2):
                chain_routes[f'https://objects.githubusercontent.com/hop/{hop}'] = (
                    302,
                    {'Location': f'https://objects.githubusercontent.com/hop/{hop + 1}'},
                    b'',
                )
            loop_handler = _MockHTTPSHandler(chain_routes)
            with self.assertRaisesRegex(bump.BumpError, 'redirect hops'):
                bump.run_bump(
                    root,
                    ytdlp_version=ytdlp_ver,
                    fetch_official=True,
                    opener=bump.build_official_opener(loop_handler),
                )
            self.assertEqual(snapshot_lock_bytes(root), before)


if __name__ == '__main__':
    unittest.main()
