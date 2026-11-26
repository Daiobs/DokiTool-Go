"""Offline behavioral and security tests for DokiTool-Go upstream runtime watch."""
import base64
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).resolve().parents[1] / 'check-upstream-updates.py'
SPEC = importlib.util.spec_from_file_location('upstream_watch', SCRIPT)
watch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(watch)

NOW = dt.datetime(2026, 10, 29, 1, 0, tzinfo=dt.timezone.utc)
BOT = {'login': watch.BOT, 'type': 'Bot'}
PINNED = {'yt-dlp/yt-dlp': '2026.10.26', 'denoland/deno': '2.9.8'}


def api_release(ident, tag_name, published_at='2026-10-26T00:00:00Z', updated_at=None, *,
                draft=False, prerelease=False, name=None, target_commitish='main'):
    return {
        'id': ident,
        'tag_name': tag_name,
        'name': tag_name if name is None else name,
        'target_commitish': target_commitish,
        'draft': draft,
        'prerelease': prerelease,
        'published_at': published_at,
        'updated_at': updated_at if updated_at is not None else published_at,
    }


def seed_upstream_data():
    return {
        'yt-dlp/yt-dlp': {
            'releases': [
                api_release(101, '2026.10.26', '2026-10-26T00:00:00Z'),
                api_release(100, '2026.09.20', '2026-09-20T00:00:00Z'),
            ],
            'latest': api_release(101, '2026.10.26', '2026-10-26T00:00:00Z'),
        },
        'denoland/deno': {
            'releases': [
                api_release(201, 'v2.9.8', '2026-10-20T00:00:00Z'),
                api_release(200, 'v2.9.7', '2026-10-10T00:00:00Z'),
            ],
            'latest': api_release(201, 'v2.9.8', '2026-10-20T00:00:00Z'),
        },
    }


def build_state_from_upstreams(upstreams, observed_at='2026-10-28T01:00:00Z', local_drift=None):
    fake = FakeGitHub(upstreams)
    drift_by_repo = watch.normalize_local_drift(local_drift)
    return watch.normalize_state({
        'schema': watch.SCHEMA_VERSION,
        'observed_at': observed_at,
        'repositories': {
            repo: watch.collect_snapshot(fake, repo, drift_by_repo[repo])
            for repo in watch.UPSTREAMS
        },
    })


def managed_issue(state, issue_state='open'):
    return {
        'number': 17,
        'title': watch.TITLE,
        'user': copy.deepcopy(BOT),
        'body': 'Monitoring enabled.\n' + watch.state_marker(state),
        'state': issue_state,
    }


SYNTHETIC_YTDLP_SHA = '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795'
SYNTHETIC_DENO_SHA = '368bca08999e02c6911b8f248167b582276b1f547db5712b6e736d7eda1dbda7'


def write_synthetic_lock_files(
    dest_root,
    *,
    ytdlp_version='2026.10.26',
    ytdlp_linux_sha=SYNTHETIC_YTDLP_SHA,
    deno_version='2.9.8',
    deno_linux_sha=SYNTHETIC_DENO_SHA,
):
    files = {
        watch.YTDLP_SOURCE_REL: (
            'package ytengine\n\n'
            f'const PinnedVersion = "{ytdlp_version}"\n\n'
            'var OfficialSHA256Sums20261026 = map[string]string{\n'
            '\t"e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3": "yt-dlp",\n'
            f'\t"{ytdlp_linux_sha}": "yt-dlp_linux",\n'
            '}\n'
        ),
        watch.DENO_SOURCE_REL: (
            'package youtube\n\n'
            'const (\n'
            f'\tPinnedDenoVersion = "{deno_version}"\n'
            '\tPinnedEJSVersion  = "0.8.0"\n'
            ')\n\n'
            'var OfficialDenoSHA256Sums2098 = map[string]string{\n'
            f'\t"{deno_linux_sha}": "deno-x86_64-unknown-linux-gnu",\n'
            '\t"b484f780e5149ca05c673f1f79f7fb466f12a2295933bdad917af4a8a5c020e8": "deno-aarch64-unknown-linux-gnu",\n'
            '}\n'
        ),
        watch.RELEASE_BUILD_WORKFLOW_REL: (
            'name: Release build\n'
            'jobs:\n'
            '  build-and-publish:\n'
            '    steps:\n'
            f'      - name: Install pinned Deno {deno_version}\n'
            '        run: |\n'
            '          curl --fail --silent --show-error --location \\\n'
            f'            https://github.com/denoland/deno/releases/download/v{deno_version}/deno-x86_64-unknown-linux-gnu.zip \\\n'
            '            --output "$RUNNER_TEMP/deno/deno.zip"\n'
            f'          echo "{deno_linux_sha}  $RUNNER_TEMP/deno/deno" | sha256sum --check --strict\n'
            '          case "$first_line" in\n'
            f'            "deno {deno_version}"|"deno {deno_version} "*) ;;\n'
            '            *) exit 1 ;;\n'
            '          esac\n'
        ),
        watch.UPSTREAM_CANARY_WORKFLOW_REL: (
            'name: Upstream canary probe\n'
            'jobs:\n'
            '  canary:\n'
            '    steps:\n'
            f'      - name: Install pinned Deno {deno_version}\n'
            '        run: |\n'
            '          curl --fail --silent --show-error --location \\\n'
            f'            https://github.com/denoland/deno/releases/download/v{deno_version}/deno-x86_64-unknown-linux-gnu.zip \\\n'
            '            --output "$RUNNER_TEMP/deno/deno.zip"\n'
            f'          echo "{deno_linux_sha}  $RUNNER_TEMP/deno/deno" | sha256sum --check --strict\n'
            '          case "$first_line" in\n'
            f'            "deno {deno_version}"|"deno {deno_version} "*) ;;\n'
            '            *) exit 1 ;;\n'
            '          esac\n'
        ),
        watch.GATEWAY_ISOLATION_WORKFLOW_REL: (
            'name: Gateway isolation\n'
            'jobs:\n'
            '  controlled-gateway:\n'
            '    steps:\n'
            '      - name: Stage the pinned extractor\n'
            '        run: |\n'
            '          curl --fail --silent --show-error --location \\\n'
            f'            https://github.com/yt-dlp/yt-dlp/releases/download/{ytdlp_version}/yt-dlp_linux \\\n'
            '            --output "$RUNNER_TEMP/gateway-bin/yt-dlp_linux"\n'
            f'          echo \'{ytdlp_linux_sha}  \'"$RUNNER_TEMP/gateway-bin/yt-dlp_linux" | sha256sum --check --strict\n'
        ),
        watch.VALIDATION_REQUIREMENTS_REL: (
            '# Development/CI contract validation only.\n'
            'jsonschema>=4.17.3,<5\n'
            f'deno=={deno_version}\n'
        ),
    }
    for rel, content in files.items():
        target = dest_root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding='utf-8')


class FakeGitHub:
    def __init__(self, upstreams, issue=None):
        self.upstreams = copy.deepcopy(upstreams)
        self.issues = [copy.deepcopy(issue)] if issue else []
        self.comments = []
        self.writes = []
        self.reads = []
        self.fail_read = None
        self.fail_post = False
        self.fail_after_post = False
        self.fail_after_create = False

    def set_latest_stable(self, repo, release):
        rel = copy.deepcopy(release)
        self.upstreams[repo]['latest'] = copy.deepcopy(rel)
        existing = [r for r in self.upstreams[repo]['releases'] if r['id'] != rel['id']]
        self.upstreams[repo]['releases'] = [rel, *existing]

    def get(self, path):
        self.reads.append(path)
        if self.fail_read and self.fail_read in path:
            raise watch.WatchError('Synthetic API read failure')
        for repo, data in self.upstreams.items():
            if path == f'/repos/{repo}/releases/latest':
                return copy.deepcopy(data['latest'])
        raise AssertionError('Unexpected GET ' + path)

    def get_list(self, path):
        self.reads.append(path)
        if self.fail_read and self.fail_read in path:
            raise watch.WatchError('Synthetic API list failure')
        for repo, data in self.upstreams.items():
            if path == f'/repos/{repo}/releases?per_page={watch.RELEASES_PER_PAGE}':
                return copy.deepcopy(data['releases'][:watch.RELEASES_PER_PAGE])
        raise AssertionError('Unexpected GET list ' + path)

    def items(self, path):
        self.reads.append(path)
        if self.fail_read and self.fail_read in path:
            raise watch.WatchError('Synthetic API paginated read failure')
        if path.startswith('/repos/' + watch.TARGET + '/issues?'):
            return copy.deepcopy(self.issues)
        if '/issues/17/comments?' in path:
            return copy.deepcopy(self.comments)
        raise AssertionError('Unexpected paginated list ' + path)

    def request(self, method, path, data=None):
        if method == 'POST' and self.fail_post:
            raise watch.WatchError('Synthetic notification failure')
        self.writes.append((method, path, copy.deepcopy(data)))
        if method == 'PATCH':
            self.issues[0]['state'] = data['state']
            return copy.deepcopy(self.issues[0]), {}
        if path.endswith('/comments'):
            self.comments.append({'id': 100 + len(self.comments), 'user': copy.deepcopy(BOT), 'body': data['body']})
            if self.fail_after_post:
                self.fail_after_post = False
                raise watch.WatchError('Synthetic response loss after successful POST')
            return copy.deepcopy(self.comments[-1]), {}
        if method == 'POST' and path.endswith('/issues'):
            issue = {'number': 17, 'user': copy.deepcopy(BOT), 'state': 'open', **copy.deepcopy(data)}
            self.issues.append(issue)
            if self.fail_after_create:
                self.fail_after_create = False
                raise watch.WatchError('Synthetic response loss after Issue creation')
            return copy.deepcopy(issue), {}
        raise AssertionError('Unexpected mutation')


class PinnedVersionAndConsistencyTests(unittest.TestCase):
    def test_module_imports_cleanly_without_coupling_unittest_to_real_repo_locks(self):
        self.assertTrue(watch.ROOT.is_dir())
        self.assertEqual(len(watch.LOCK_FILES), 6)
        for rel in watch.LOCK_FILES:
            self.assertIn(rel.as_posix(), watch.UPGRADE_REMINDER)

    def test_synthetic_six_lock_files_pass_consistency_and_cli_without_token_or_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_synthetic_lock_files(root)
            pinned = watch.verify_local_pin_consistency(root)
            self.assertEqual(pinned, {'yt-dlp/yt-dlp': '2026.10.26', 'denoland/deno': '2.9.8'})
            self.assertEqual(
                watch.collect_local_pin_drift(root, pinned),
                {'yt-dlp/yt-dlp': [], 'denoland/deno': []},
            )

            stdout = io.StringIO()
            stderr = io.StringIO()
            with patch.dict(os.environ, {}, clear=True), \
                 patch.object(urllib.request.OpenerDirector, 'open', side_effect=AssertionError('Unexpected network call')), \
                 patch.object(sys, 'stdout', stdout), \
                 patch.object(sys, 'stderr', stderr):
                rc = watch.cli(['--check-local-pins', '--root', str(root)])
            self.assertEqual(rc, 0)
            self.assertEqual(stderr.getvalue(), '')
            report = json.loads(stdout.getvalue())
            self.assertEqual(
                report,
                {
                    'passed': True,
                    'lock_files': 6,
                    'pinned': {'yt-dlp/yt-dlp': '2026.10.26', 'denoland/deno': '2.9.8'},
                },
            )

            proc = subprocess.run(
                [sys.executable, '-B', str(SCRIPT), '--check-local-pins', '--root', str(root)],
                env={'PATH': os.environ.get('PATH', '')},
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(proc.stdout)['passed'], True)

    def test_accepts_ytdlp_patch_version_format(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            engine = root / watch.YTDLP_SOURCE_REL
            sandbox = root / watch.DENO_SOURCE_REL
            engine.parent.mkdir(parents=True, exist_ok=True)
            sandbox.parent.mkdir(parents=True, exist_ok=True)
            engine.write_text('package ytengine\nconst PinnedVersion = "2026.10.26.1"\n', encoding='utf-8')
            sandbox.write_text('package youtube\nconst (\n\tPinnedDenoVersion = "2.10.0"\n)\n', encoding='utf-8')
            self.assertEqual(
                watch.load_pinned_versions(root),
                {'yt-dlp/yt-dlp': '2026.10.26.1', 'denoland/deno': '2.10.0'},
            )

    def test_missing_or_corrupt_go_constants_raise_watch_error_and_fail_cli(self):
        bad_cases = [
            ('missing-files', None, None),
            ('missing-ytdlp-const', 'package ytengine\n', 'const PinnedDenoVersion = "2.9.8"\n'),
            ('missing-deno-const', 'const PinnedVersion = "2026.10.26"\n', 'package youtube\n'),
            ('v-prefixed-ytdlp', 'const PinnedVersion = "v2026.10.26"\n', 'const PinnedDenoVersion = "2.9.8"\n'),
            ('malformed-ytdlp', 'const PinnedVersion = "2026-10-26"\n', 'const PinnedDenoVersion = "2.9.8"\n'),
            ('v-prefixed-deno', 'const PinnedVersion = "2026.10.26"\n', 'const PinnedDenoVersion = "v2.9.8"\n'),
            ('prerelease-deno', 'const PinnedVersion = "2026.10.26"\n', 'const PinnedDenoVersion = "2.9.8-rc.1"\n'),
            ('duplicate-ytdlp', 'const PinnedVersion = "2026.10.26"\nconst PinnedVersion = "2026.10.27"\n', 'const PinnedDenoVersion = "2.9.8"\n'),
        ]
        for label, engine_src, sandbox_src in bad_cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                if engine_src is not None:
                    engine = root / watch.YTDLP_SOURCE_REL
                    engine.parent.mkdir(parents=True, exist_ok=True)
                    engine.write_text(engine_src, encoding='utf-8')
                if sandbox_src is not None:
                    sandbox = root / watch.DENO_SOURCE_REL
                    sandbox.parent.mkdir(parents=True, exist_ok=True)
                    sandbox.write_text(sandbox_src, encoding='utf-8')
                with self.assertRaises(watch.WatchError):
                    watch.load_pinned_versions(root)
                stderr = io.StringIO()
                with patch.object(sys, 'stderr', stderr):
                    self.assertEqual(watch.cli(['--check-local-pins', '--root', str(root)]), 1)
                self.assertIn('Upstream check failed:', stderr.getvalue())

    def test_synchronized_upgrade_across_all_five_lock_files_passes(self):
        new_ytdlp_sha = 'a' * 64
        new_deno_sha = 'b' * 64
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_synthetic_lock_files(
                root,
                ytdlp_version='2026.10.26.1',
                ytdlp_linux_sha=new_ytdlp_sha,
                deno_version='2.10.0',
                deno_linux_sha=new_deno_sha,
            )
            self.assertEqual(
                watch.verify_local_pin_consistency(root),
                {'yt-dlp/yt-dlp': '2026.10.26.1', 'denoland/deno': '2.10.0'},
            )
            stdout = io.StringIO()
            with patch.dict(os.environ, {}, clear=True), patch.object(sys, 'stdout', stdout):
                self.assertEqual(watch.cli(['--check-local-pins', '--root', str(root)]), 0)
            self.assertEqual(
                json.loads(stdout.getvalue())['pinned'],
                {'yt-dlp/yt-dlp': '2026.10.26.1', 'denoland/deno': '2.10.0'},
            )

    def test_detects_drift_across_all_five_lock_files_in_library_and_cli(self):
        wrong_sha = 'f' * 64
        mutations = [
            (
                'engine-bumped-ahead-of-gateway-workflow',
                watch.YTDLP_SOURCE_REL,
                lambda s: s.replace('const PinnedVersion = "2026.10.26"', 'const PinnedVersion = "2026.11.01"'),
                'yt-dlp/yt-dlp',
                '.github/workflows/gateway-isolation.yml',
            ),
            (
                'sandbox-bumped-ahead-of-workflows-and-requirements',
                watch.DENO_SOURCE_REL,
                lambda s: s.replace('PinnedDenoVersion = "2.9.8"', 'PinnedDenoVersion = "2.10.0"'),
                'denoland/deno',
                'scripts/requirements-validation.txt',
            ),
            (
                'release-build-deno-url-version',
                watch.RELEASE_BUILD_WORKFLOW_REL,
                lambda s: s.replace('/download/v2.9.8/', '/download/v2.9.7/'),
                'denoland/deno',
                '.github/workflows/release-build.yml',
            ),
            (
                'release-build-deno-assert-exact-branch',
                watch.RELEASE_BUILD_WORKFLOW_REL,
                lambda s: s.replace('"deno 2.9.8"|', '"deno 2.9.7"|'),
                'denoland/deno',
                '.github/workflows/release-build.yml',
            ),
            (
                'release-build-deno-assert-prefix-branch',
                watch.RELEASE_BUILD_WORKFLOW_REL,
                lambda s: s.replace('"deno 2.9.8 "', '"deno 2.9.7 "'),
                'denoland/deno',
                '.github/workflows/release-build.yml',
            ),
            (
                'release-build-deno-sha256',
                watch.RELEASE_BUILD_WORKFLOW_REL,
                lambda s: s.replace(SYNTHETIC_DENO_SHA, wrong_sha),
                'denoland/deno',
                '.github/workflows/release-build.yml',
            ),
            (
                'upstream-canary-deno-url-version',
                watch.UPSTREAM_CANARY_WORKFLOW_REL,
                lambda s: s.replace('/download/v2.9.8/', '/download/v2.9.7/'),
                'denoland/deno',
                '.github/workflows/upstream-canary.yml',
            ),
            (
                'upstream-canary-deno-assert-exact-branch',
                watch.UPSTREAM_CANARY_WORKFLOW_REL,
                lambda s: s.replace('"deno 2.9.8"|', '"deno 2.9.7"|'),
                'denoland/deno',
                '.github/workflows/upstream-canary.yml',
            ),
            (
                'upstream-canary-deno-sha256',
                watch.UPSTREAM_CANARY_WORKFLOW_REL,
                lambda s: s.replace(SYNTHETIC_DENO_SHA, wrong_sha),
                'denoland/deno',
                '.github/workflows/upstream-canary.yml',
            ),
            (
                'gateway-isolation-ytdlp-url-version',
                watch.GATEWAY_ISOLATION_WORKFLOW_REL,
                lambda s: s.replace('/download/2026.10.26/', '/download/2026.09.20/'),
                'yt-dlp/yt-dlp',
                '.github/workflows/gateway-isolation.yml',
            ),
            (
                'gateway-isolation-ytdlp-sha256',
                watch.GATEWAY_ISOLATION_WORKFLOW_REL,
                lambda s: s.replace(SYNTHETIC_YTDLP_SHA, wrong_sha),
                'yt-dlp/yt-dlp',
                '.github/workflows/gateway-isolation.yml',
            ),
            (
                'requirements-validation-deno-version',
                watch.VALIDATION_REQUIREMENTS_REL,
                lambda s: s.replace('deno==2.9.8', 'deno==2.9.7'),
                'denoland/deno',
                'scripts/requirements-validation.txt',
            ),
            (
                'requirements-validation-deno-non-exact',
                watch.VALIDATION_REQUIREMENTS_REL,
                lambda s: s.replace('deno==2.9.8', 'deno>=2.9.8'),
                'denoland/deno',
                'scripts/requirements-validation.txt',
            ),
            (
                'engine-missing-linux-sha256',
                watch.YTDLP_SOURCE_REL,
                lambda s: s.replace('"yt-dlp_linux"', '"yt-dlp_other"'),
                'yt-dlp/yt-dlp',
                'backend/internal/ytengine/engine.go',
            ),
            (
                'sandbox-missing-linux-sha256',
                watch.DENO_SOURCE_REL,
                lambda s: s.replace('"deno-x86_64-unknown-linux-gnu"', '"deno-other"'),
                'denoland/deno',
                'backend/internal/platform/youtube/ejs_sandbox.go',
            ),
        ]
        for label, rel, mutate, target_repo, expected_fragment in mutations:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                write_synthetic_lock_files(root)
                path = root / rel
                path.write_text(mutate(path.read_text(encoding='utf-8')), encoding='utf-8')
                drift = watch.collect_local_pin_drift(root)
                other_repo = 'yt-dlp/yt-dlp' if target_repo == 'denoland/deno' else 'denoland/deno'
                self.assertTrue(drift[target_repo], f'Expected drift for {label}')
                self.assertEqual(drift[other_repo], [])
                self.assertTrue(any(expected_fragment in item for item in drift[target_repo]))
                with self.assertRaises(watch.WatchError):
                    watch.verify_local_pin_consistency(root)
                stderr = io.StringIO()
                with patch.dict(os.environ, {}, clear=True), patch.object(sys, 'stderr', stderr):
                    self.assertEqual(watch.cli(['--check-local-pins', '--root', str(root)]), 1)
                self.assertIn('Local pin drift detected:', stderr.getvalue())
                self.assertIn(expected_fragment, stderr.getvalue())


class VersionOrderingTests(unittest.TestCase):
    def test_deno_semver_and_ytdlp_calver_ordering_and_hostile_tags(self):
        # Deno 3-part SemVer
        self.assertEqual(watch.parse_version_tuple('denoland/deno', '2.9.8'), (2, 9, 8))
        self.assertEqual(watch.compare_upstream_version('denoland/deno', 'v2.9.8', '2.9.8'), 'aligned')
        self.assertEqual(watch.compare_upstream_version('denoland/deno', '2.9.8', '2.9.8'), 'aligned')
        self.assertEqual(watch.compare_upstream_version('denoland/deno', 'v2.9.9', '2.9.8'), 'ahead')
        self.assertEqual(watch.compare_upstream_version('denoland/deno', 'v2.10.0', '2.9.8'), 'ahead')
        self.assertEqual(watch.compare_upstream_version('denoland/deno', 'v2.8.9', '2.9.8'), 'behind')
        self.assertEqual(watch.compare_upstream_version('denoland/deno', 'v2.9.7', '2.9.8'), 'behind')
        self.assertEqual(watch.upstream_status_label('denoland/deno', 'v2.8.9', '2.9.8'), '上游 latest 低于本地锁定')

        # yt-dlp 3/4-part zero-padded CalVer
        self.assertEqual(watch.parse_version_tuple('yt-dlp/yt-dlp', '2026.03.04'), (2026, 3, 4, 0))
        self.assertEqual(watch.parse_version_tuple('yt-dlp/yt-dlp', '2026.10.26'), (2026, 10, 26, 0))
        self.assertEqual(watch.parse_version_tuple('yt-dlp/yt-dlp', '2026.10.26.1'), (2026, 10, 26, 1))
        self.assertLess(
            watch.parse_version_tuple('yt-dlp/yt-dlp', '2026.10.26'),
            watch.parse_version_tuple('yt-dlp/yt-dlp', '2026.10.26.1'),
        )
        self.assertLess(
            watch.parse_version_tuple('yt-dlp/yt-dlp', '2026.10.26.1'),
            watch.parse_version_tuple('yt-dlp/yt-dlp', '2026.11.01'),
        )
        self.assertEqual(watch.compare_upstream_version('yt-dlp/yt-dlp', '2026.03.04', '2026.03.04'), 'aligned')
        self.assertEqual(watch.compare_upstream_version('yt-dlp/yt-dlp', '2026.03.04.1', '2026.03.04'), 'ahead')
        self.assertEqual(watch.compare_upstream_version('yt-dlp/yt-dlp', '2026.10.26.1', '2026.10.26'), 'ahead')
        self.assertEqual(watch.compare_upstream_version('yt-dlp/yt-dlp', '2026.10.26.10', '2026.10.26.2'), 'ahead')
        self.assertEqual(watch.compare_upstream_version('yt-dlp/yt-dlp', '2026.10.26', '2026.10.26.1'), 'behind')
        self.assertEqual(watch.compare_upstream_version('yt-dlp/yt-dlp', '2026.09.20', '2026.10.26'), 'behind')

        # Malformed or hostile tags degrade gracefully without raising
        for repo, locked, bad_tag in (
            ('denoland/deno', '2.9.8', 'v2.9.9-@Daiobs|[evil](https://evil.test)<script>'),
            ('denoland/deno', '2.9.8', 'v2.9'),
            ('yt-dlp/yt-dlp', '2026.10.26', 'v2026.10.26'),
            ('yt-dlp/yt-dlp', '2026.10.26', '2026.10.26.0'),
            ('yt-dlp/yt-dlp', '2026.10.26', '2026-10-26'),
        ):
            with self.subTest(repo=repo, bad_tag=bad_tag):
                self.assertEqual(watch.compare_upstream_version(repo, bad_tag, locked), 'unparseable')
                self.assertEqual(watch.upstream_status_label(repo, bad_tag, locked), '版本不一致（需人工核对）')


class WatchBehaviorTests(unittest.TestCase):
    def setUp(self):
        self.upstreams = seed_upstream_data()
        self.seed = build_state_from_upstreams(self.upstreams)
        self.pinned = copy.deepcopy(PINNED)

    def run_watch(self, api, **kwargs):
        return watch.run_check(api, self.pinned, now=NOW, **kwargs)

    def test_first_success_creates_assigned_issue_with_v2_state_and_summary_table(self):
        api = FakeGitHub(self.upstreams)
        result = self.run_watch(api)
        self.assertFalse(result['changed'])
        self.assertTrue(result['issue_created'])
        self.assertTrue(result['notification_posted'])
        method, path, payload = api.writes[0]
        self.assertEqual((method, path), ('POST', '/repos/Daiobs/DokiTool-Go/issues'))
        self.assertEqual(payload['title'], watch.TITLE)
        self.assertEqual(payload['assignees'], ['Daiobs'])
        self.assertIn('| 组件 | 当前锁定版本 | 上游最新正式版 | 发布时间 | 状态 |', payload['body'])
        self.assertIn('`2026.10.26`', payload['body'])
        self.assertIn('`2.9.8`', payload['body'])
        self.assertIn('已对齐', payload['body'])
        self.assertIn('SHA-256', payload['body'])
        self.assertIn('2026-10-29 09:00:00', payload['body'])
        self.assertIn(watch.MARKER, payload['body'])
        extracted = watch.extract_state(payload['body'])
        self.assertEqual(extracted['schema'], 2)
        self.assertEqual(extracted['repositories'], self.seed['repositories'])
        for repo in watch.UPSTREAMS:
            for rec in extracted['repositories'][repo]['releases']:
                self.assertNotIn('updated_at', rec)
        second = self.run_watch(api)
        self.assertFalse(second['changed'])
        self.assertEqual(len(api.writes), 1)

    def test_first_run_distinguishes_ahead_behind_and_unparseable_versions(self):
        # 1) Ahead (yt-dlp 4-part CalVer hotfix 2026.10.26.1 > 2026.10.26)
        api_ahead = FakeGitHub(self.upstreams)
        api_ahead.set_latest_stable('yt-dlp/yt-dlp', api_release(102, '2026.10.26.1', '2026-10-26T12:00:00Z'))
        res_ahead = self.run_watch(api_ahead)
        self.assertTrue(res_ahead['changed'])
        body_ahead = api_ahead.writes[0][2]['body']
        self.assertIn('发现新正式版', body_ahead)
        self.assertNotIn('上游 latest 低于本地锁定', body_ahead)

        # 2) Behind (Deno older-branch patch v2.8.9 < 2.9.8 without make_latest=false)
        api_behind = FakeGitHub(self.upstreams)
        api_behind.set_latest_stable('denoland/deno', api_release(202, 'v2.8.9', '2026-10-27T00:00:00Z'))
        res_behind = self.run_watch(api_behind)
        self.assertTrue(res_behind['changed'])
        body_behind = api_behind.writes[0][2]['body']
        self.assertIn('上游 latest 低于本地锁定', body_behind)
        self.assertNotIn('发现新正式版', body_behind)

        # 3) Unparseable tag on first run
        api_weird = FakeGitHub(self.upstreams)
        api_weird.set_latest_stable('denoland/deno', api_release(203, 'deno-custom-tag', '2026-10-28T00:00:00Z'))
        res_weird = self.run_watch(api_weird)
        self.assertTrue(res_weird['changed'])
        body_weird = api_weird.writes[0][2]['body']
        self.assertIn('版本不一致（需人工核对）', body_weird)
        self.assertNotIn('发现新正式版', body_weird)

    def test_unchanged_stable_releases_and_draft_or_canary_prereleases_do_not_notify(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        # Drafts (with published_at=None), nightly/canary prereleases, and asset download counts must be ignored.
        api.upstreams['yt-dlp/yt-dlp']['releases'].insert(
            0, api_release(901, '2026.10.29.nightly', published_at=None, updated_at='2026-10-29T00:00:00Z', draft=True)
        )
        api.upstreams['yt-dlp/yt-dlp']['releases'].insert(
            0, api_release(902, '2026.10.29-canary', '2026-10-29T00:00:00Z', prerelease=True)
        )
        api.upstreams['denoland/deno']['releases'].insert(
            0, api_release(903, 'v3.0.0-rc.1', '2026-10-29T00:00:00Z', prerelease=True)
        )
        api.upstreams['denoland/deno']['releases'][1]['assets'] = [{'download_count': 888888}]
        result = self.run_watch(api)
        self.assertFalse(result['changed'])
        self.assertFalse(result['notification_posted'])
        self.assertEqual(api.writes, [])
        for read_path in api.reads:
            self.assertNotIn('/git/ref/heads/', read_path)
            self.assertNotIn('/commits', read_path)

    def test_post_publish_updated_at_and_title_edits_produce_zero_noise(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        # Simulate post-publish asset upload (updated_at changes) and Release title/notes edit,
        # including racing between GET /releases?per_page=20 and GET /releases/latest.
        api.upstreams['denoland/deno']['releases'][0] = api_release(
            201,
            'v2.9.8',
            '2026-10-20T00:00:00Z',
            updated_at='2026-10-29T00:45:00Z',
            name='Deno 2.9.8 (Linux binaries uploaded)',
        )
        api.upstreams['denoland/deno']['latest'] = api_release(
            201,
            'v2.9.8',
            '2026-10-20T00:00:00Z',
            updated_at='2026-10-29T00:50:00Z',
            name='Deno 2.9.8 (All platform binaries uploaded)',
        )
        api.upstreams['yt-dlp/yt-dlp']['releases'][1] = api_release(
            100,
            '2026.09.20',
            '2026-09-20T00:00:00Z',
            updated_at='2026-10-29T00:40:00Z',
            name='yt-dlp 2026.09.20 (retroactive changelog typo fix)',
        )
        result = self.run_watch(api)
        self.assertNotEqual(
            self.seed['repositories']['denoland/deno'],
            watch.collect_snapshot(api, 'denoland/deno'),
        )
        self.assertFalse(result['changed'])
        self.assertFalse(result['notification_posted'])
        self.assertNotIn('正式版观察窗口更新', result['summary'])
        self.assertNotIn('正式版变更', result['summary'])
        self.assertEqual(api.writes, [])

        # Genuine mismatch of tag_name or published_at between /releases and /releases/latest still fails closed.
        api.upstreams['denoland/deno']['latest'] = api_release(
            201,
            'v2.9.8',
            '2026-10-21T00:00:00Z',
        )
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)

    def test_legacy_v2_state_with_updated_at_and_without_local_drift_is_accepted_without_noise(self):
        legacy_payload = {
            'schema': 2,
            'observed_at': '2026-10-28T01:00:00Z',
            'repositories': {
                'yt-dlp/yt-dlp': {
                    'latest_id': 101,
                    'latest_tag': '2026.10.26',
                    'latest_published_at': '2026-10-26T00:00:00Z',
                    'releases': [
                        {'id': 100, 'tag_name': '2026.09.20', 'published_at': '2026-09-20T00:00:00Z', 'updated_at': '2026-09-20T01:00:00Z'},
                        {'id': 101, 'tag_name': '2026.10.26', 'published_at': '2026-10-26T00:00:00Z', 'updated_at': '2026-10-26T01:00:00Z'},
                    ],
                },
                'denoland/deno': {
                    'latest_id': 201,
                    'latest_tag': 'v2.9.8',
                    'latest_published_at': '2026-10-20T00:00:00Z',
                    'releases': [
                        {'id': 200, 'tag_name': 'v2.9.7', 'published_at': '2026-10-10T00:00:00Z', 'updated_at': '2026-10-10T01:00:00Z'},
                        {'id': 201, 'tag_name': 'v2.9.8', 'published_at': '2026-10-20T00:00:00Z', 'updated_at': '2026-10-20T01:00:00Z'},
                    ],
                },
            },
        }
        encoded = base64.b64encode(json.dumps(legacy_payload, separators=(',', ':')).encode('utf-8')).decode('ascii')
        issue = {
            'number': 17,
            'title': watch.TITLE,
            'user': copy.deepcopy(BOT),
            'body': f'Legacy v2 state.\n{watch.MARKER}{encoded} -->',
            'state': 'open',
        }
        api = FakeGitHub(self.upstreams, issue)
        result = self.run_watch(api)
        self.assertFalse(result['changed'])
        self.assertEqual(api.writes, [])

    def test_canary_flood_pushing_20th_item_keeps_10_release_window_stable(self):
        many = seed_upstream_data()
        stable_15 = [
            api_release(300 + idx, f'v2.8.{idx}', f'2026-09-{idx + 1:02d}T00:00:00Z')
            for idx in reversed(range(15))
        ]
        many['denoland/deno']['releases'] = stable_15
        many['denoland/deno']['latest'] = copy.deepcopy(stable_15[0])
        seed = build_state_from_upstreams(many)
        api = FakeGitHub(many, managed_issue(seed))
        canaries = [
            api_release(500 + idx, f'v2.9.0-canary.{idx}', f'2026-10-{idx + 1:02d}T00:00:00Z', prerelease=True)
            for idx in range(6)
        ]
        api.upstreams['denoland/deno']['releases'] = canaries + stable_15
        result = self.run_watch(api)
        self.assertFalse(result['changed'])
        self.assertEqual(api.writes, [])

    def test_new_ytdlp_and_deno_stable_releases_post_comment_and_deduplicate(self):
        cases = [
            ('yt-dlp/yt-dlp', api_release(105, '2026.10.26.1', '2026-10-26T18:00:00Z', name='yt-dlp 2026.10.26.1'), '`2026.10.26`'),
            ('denoland/deno', api_release(205, 'v2.9.9', '2026-11-06T03:00:00Z', name='Deno 2.9.9'), '`2.9.8`'),
        ]
        for repo, new_rel, locked_cell in cases:
            with self.subTest(repo=repo):
                api = FakeGitHub(self.upstreams, managed_issue(self.seed))
                api.set_latest_stable(repo, new_rel)
                result = self.run_watch(api, run_url='https://github.com/Daiobs/DokiTool-Go/actions/runs/42')
                self.assertTrue(result['changed'])
                self.assertTrue(result['notification_posted'])
                self.assertEqual(len(api.writes), 1)
                method, path, payload = api.writes[0]
                self.assertEqual((method, path), ('POST', '/repos/Daiobs/DokiTool-Go/issues/17/comments'))
                body = payload['body']
                self.assertIn(locked_cell, body)
                self.assertIn(watch.safe_text(new_rel['tag_name']), body)
                self.assertIn('发现新正式版', body)
                self.assertIn('正式版新增', body)
                self.assertIn('SHA-256', body)
                self.assertIn('https://github.com/Daiobs/DokiTool-Go/actions/runs/42', body)
                saved = watch.extract_state(body)
                self.assertEqual(saved['repositories'][repo]['latest_tag'], new_rel['tag_name'])
                # Subsequent check without further upstream changes is a no-op.
                second = self.run_watch(api)
                self.assertFalse(second['changed'])
                self.assertEqual(len(api.writes), 1)

    def test_tag_or_published_at_mutation_and_release_retraction_report_ordered_status_once(self):
        # 1) Genuine release identity change (published_at changed for same release ID)
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        republished = api_release(201, 'v2.9.8', '2026-10-20T06:00:00Z')
        api.set_latest_stable('denoland/deno', republished)
        res_edit = self.run_watch(api)
        self.assertTrue(res_edit['changed'])
        self.assertIn('正式版变更', res_edit['summary'])
        self.assertIn('发布时间', res_edit['summary'])
        self.assertNotIn('更新时间', res_edit['summary'])
        self.assertFalse(self.run_watch(api)['changed'])

        # 2) Release retraction (v2.9.8 yanked back to v2.9.7 < 2.9.8)
        api2 = FakeGitHub(self.upstreams, managed_issue(self.seed))
        older = api_release(200, 'v2.9.7', '2026-10-10T00:00:00Z')
        api2.upstreams['denoland/deno']['releases'] = [older]
        api2.upstreams['denoland/deno']['latest'] = copy.deepcopy(older)
        res_retract = self.run_watch(api2)
        self.assertTrue(res_retract['changed'])
        self.assertIn('正式版撤回或移除', res_retract['summary'])
        self.assertIn('上游 latest 低于本地锁定', res_retract['summary'])
        self.assertNotIn('发现新正式版', res_retract['summary'])
        self.assertFalse(self.run_watch(api2)['changed'])

    def test_local_pin_drift_notifies_once_marks_summary_and_reports_resolution(self):
        drift = {
            'yt-dlp/yt-dlp': [],
            'denoland/deno': [
                '`.github/workflows/release-build.yml` Deno 下载版本（v2\\.9\\.7）与 Go 锁定版本 `v2.9.8` 不一致',
            ],
        }
        # Initial Issue creation when drift already exists on main
        initial_api = FakeGitHub(self.upstreams)
        init_res = self.run_watch(initial_api, local_drift=drift)
        self.assertTrue(init_res['changed'])
        self.assertTrue(init_res['issue_created'])
        self.assertIn('已对齐（本地配置漂移）', init_res['summary'])
        self.assertIn('本地配置漂移：', initial_api.writes[0][2]['body'])
        self.assertFalse(self.run_watch(initial_api, local_drift=drift)['changed'])

        # Incremental notification when drift appears after clean baseline
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        first = self.run_watch(api, local_drift=drift)
        self.assertTrue(first['changed'])
        self.assertTrue(first['notification_posted'])
        self.assertIn('已对齐（本地配置漂移）', first['summary'])
        self.assertIn('本地配置漂移：', first['summary'])
        self.assertEqual(len(api.writes), 1)
        saved_drift = watch.extract_state(api.writes[0][2]['body'])
        self.assertEqual(saved_drift['repositories']['denoland/deno']['local_drift'], drift['denoland/deno'])

        # Same drift on the following day does not spam another comment, while summary still flags drift.
        second = self.run_watch(api, local_drift=drift)
        self.assertFalse(second['changed'])
        self.assertIn('已对齐（本地配置漂移）', second['summary'])
        self.assertEqual(len(api.writes), 1)

        # Fixing the drift posts a single recovery comment and clears saved local_drift.
        resolved = self.run_watch(api, local_drift={'yt-dlp/yt-dlp': [], 'denoland/deno': []})
        self.assertTrue(resolved['changed'])
        self.assertIn('本地配置漂移已解除', resolved['summary'])
        self.assertNotIn('已对齐（本地配置漂移）', resolved['summary'])
        self.assertEqual(len(api.writes), 2)
        cleared_state = watch.extract_state(api.writes[1][2]['body'])
        self.assertEqual(cleared_state['repositories']['denoland/deno']['local_drift'], [])
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(len(api.writes), 2)

    def test_sliding_window_new_release_does_not_report_aged_out_release_as_retracted(self):
        full = seed_upstream_data()
        ten_releases = [
            api_release(300 + idx, f'v2.9.{idx}', f'2026-10-{idx + 1:02d}T00:00:00Z')
            for idx in reversed(range(10))
        ]
        full['denoland/deno']['releases'] = ten_releases
        full['denoland/deno']['latest'] = copy.deepcopy(ten_releases[0])
        seed = build_state_from_upstreams(full)
        api = FakeGitHub(full, managed_issue(seed))
        newest = api_release(310, 'v2.9.10', '2026-10-15T00:00:00Z')
        api.set_latest_stable('denoland/deno', newest)
        result = self.run_watch(api)
        self.assertTrue(result['changed'])
        self.assertIn('正式版新增', result['summary'])
        self.assertNotIn('正式版撤回或移除', result['summary'])

    def test_closed_issue_is_reused_and_only_reopened_for_a_change(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed, issue_state='closed'))
        self.run_watch(api)
        self.assertEqual(api.writes, [])
        api.set_latest_stable('yt-dlp/yt-dlp', api_release(109, '2026.11.09', '2026-11-09T00:00:00Z'))
        self.run_watch(api)
        self.assertEqual([x[0] for x in api.writes], ['PATCH', 'POST'])
        self.assertEqual(api.writes[0][2], {'state': 'open'})
        self.assertEqual(len(api.issues), 1)

    def test_human_state_comments_are_ignored_and_latest_bot_state_wins(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        api.comments = [
            {'id': 500, 'user': {'login': 'untrusted', 'type': 'User'}, 'body': watch.MARKER + 'bad -->'},
            {'id': 501, 'user': None, 'body': watch.MARKER + 'bad -->'},
        ]
        self.assertFalse(self.run_watch(api)['changed'])

        newer_upstreams = seed_upstream_data()
        newer_upstreams['denoland/deno']['releases'].insert(0, api_release(202, 'v2.9.9', '2026-10-29T00:00:00Z'))
        newer_upstreams['denoland/deno']['latest'] = api_release(202, 'v2.9.9', '2026-10-29T00:00:00Z')
        newer_state = build_state_from_upstreams(newer_upstreams, observed_at='2026-10-29T00:30:00Z')
        api.comments += [
            {'id': 2, 'user': copy.deepcopy(BOT), 'body': watch.state_marker(newer_state)},
            {'id': 1, 'user': copy.deepcopy(BOT), 'body': watch.state_marker(self.seed)},
        ]
        api.upstreams = copy.deepcopy(newer_upstreams)
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(api.writes, [])

    def test_malformed_bot_state_or_duplicate_managed_issue_fails_closed(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        api.comments = [{'id': 1, 'user': copy.deepcopy(BOT), 'body': watch.MARKER + 'invalid-base64! -->'}]
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(api.writes, [])

        api.comments = []
        api.issues.append(copy.deepcopy(api.issues[0]))
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)

    def test_nonbot_issue_cannot_supply_observation_state(self):
        fake_issue = managed_issue(self.seed)
        fake_issue['user'] = {'login': 'someone', 'type': 'User'}
        api = FakeGitHub(self.upstreams, fake_issue)
        result = self.run_watch(api)
        self.assertTrue(result['issue_created'])

    def test_missing_managed_issue_marker_does_not_create_duplicate(self):
        issue = managed_issue(self.seed)
        issue['body'] = 'The state marker was accidentally deleted.'
        api = FakeGitHub(self.upstreams, issue)
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(api.writes, [])
        self.assertEqual(len(api.issues), 1)

    def test_partial_read_failure_or_invalid_latest_does_not_notify_or_advance_state(self):
        for failure in ('denoland/deno/releases?per_page=', 'denoland/deno/releases/latest'):
            with self.subTest(failure=failure):
                api = FakeGitHub(self.upstreams, managed_issue(self.seed))
                api.set_latest_stable('yt-dlp/yt-dlp', api_release(108, '2026.11.08', '2026-11-08T00:00:00Z'))
                api.fail_read = failure
                with self.assertRaises(watch.WatchError):
                    self.run_watch(api)
                self.assertEqual(api.writes, [])

        # Latest endpoint returning a prerelease or missing target_commitish must fail closed.
        for bad_latest in (
            api_release(208, 'v3.0.0-rc.1', '2026-11-08T00:00:00Z', prerelease=True),
            api_release(208, 'v2.9.9', '2026-11-08T00:00:00Z', draft=True),
            api_release(208, 'v2.9.9', '2026-11-08T00:00:00Z', target_commitish=''),
        ):
            with self.subTest(bad_latest=bad_latest):
                api = FakeGitHub(self.upstreams, managed_issue(self.seed))
                api.upstreams['denoland/deno']['latest'] = bad_latest
                with self.assertRaises(watch.WatchError):
                    self.run_watch(api)
                self.assertEqual(api.writes, [])

    def test_failed_post_and_lost_response_preserve_idempotence(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        api.set_latest_stable('yt-dlp/yt-dlp', api_release(108, '2026.11.08', '2026-11-08T00:00:00Z'))
        api.fail_post = True
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(api.comments, [])
        api.fail_post = False
        api.fail_after_post = True
        with self.assertRaises(watch.WatchError):
            self.run_watch(api)
        self.assertEqual(len(api.comments), 1)
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(len(api.comments), 1)

    def test_dry_run_never_writes_even_when_verifying_or_changes_exist(self):
        api = FakeGitHub(self.upstreams)
        api.set_latest_stable('denoland/deno', api_release(209, 'v2.9.9', '2026-11-09T00:00:00Z'))
        result = self.run_watch(api, dry_run=True, verify_notification=True)
        self.assertTrue(result['changed'])
        self.assertEqual(api.writes, [])

    def test_explicit_notification_probe_has_no_state_marker(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        result = self.run_watch(api, verify_notification=True)
        self.assertFalse(result['changed'])
        self.assertTrue(result['notification_posted'])
        body = api.writes[0][2]['body']
        self.assertIn('不代表上游有新正式版', body)
        self.assertNotIn(watch.MARKER, body)
        self.assertFalse(self.run_watch(api)['changed'])
        self.assertEqual(len(api.writes), 1)

    def test_malicious_release_tags_and_names_are_escaped_and_marked_for_manual_review(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        malicious = api_release(
            299,
            'v2.9.9-@Daiobs|[evil](https://evil.test)<script>',
            '2026-11-10T00:00:00Z',
            name='Release @all <img src="x" onerror="alert(1)"> `cmd` [hijack](https://evil.test)',
        )
        api.set_latest_stable('denoland/deno', malicious)
        self.run_watch(api)
        body = api.writes[0][2]['body']
        # Strip the trailing HTML comment state marker before asserting no HTML tags remain in visible body.
        visible = body.split(watch.MARKER)[0]
        self.assertNotIn('@Daiobs', visible)
        self.assertNotIn('@all', visible)
        self.assertNotIn('<script>', visible)
        self.assertNotIn('<img', visible)
        self.assertNotIn('[evil](https://evil.test)', visible)
        self.assertNotIn('[hijack](https://evil.test)', visible)
        self.assertIn('&lt;script&gt;', visible)
        self.assertIn('&lt;img', visible)
        self.assertIn('\\[evil\\]\\(', visible)
        self.assertIn('\\`cmd\\`', visible)
        self.assertIn('版本不一致（需人工核对）', visible)
        self.assertNotIn('发现新正式版', visible)


class BoundaryAndSecurityTests(unittest.TestCase):
    def test_all_pages_are_read_and_external_or_cyclic_pagination_is_rejected(self):
        api = watch.GitHub('dummy-token')
        path = '/repos/' + watch.TARGET + '/issues/17/comments?per_page=100'
        next_url = 'https://api.github.com' + path + '&page=2'
        api.request = Mock(side_effect=[
            ([{'id': 1}], {'Link': '<' + next_url + '>; rel="next"'}),
            ([{'id': 2}], {}),
        ])
        self.assertEqual(api.items(path), [{'id': 1}, {'id': 2}])
        self.assertEqual(api.request.call_count, 2)

        api.request = Mock(return_value=([], {'Link': '<https://evil.test/steal>; rel="next"'}))
        with self.assertRaises(watch.WatchError):
            api.items(path)

        api.request = Mock(return_value=([], {'Link': '<https://api.github.com' + path + '>; rel="next"'}))
        with self.assertRaises(watch.WatchError):
            api.items(path)

    def test_only_target_issue_writes_are_allowed(self):
        opener = Mock()
        api = watch.GitHub('dummy-token', opener=opener)
        paths = [
            ('PUT', '/repos/Daiobs/DokiTool-Go/contents/README.md', {}),
            ('POST', '/repos/yt-dlp/yt-dlp/issues', {}),
            ('POST', '/repos/denoland/deno/issues', {}),
            ('POST', '/repos/Daiobs/DokiTool/issues', {}),
            ('POST', '/repos/Brilliant666/DokiTool-Go/issues', {}),
            ('PATCH', '/repos/Daiobs/DokiTool-Go/issues/17', {'body': 'overwrite'}),
            ('DELETE', '/repos/Daiobs/DokiTool-Go/issues/17', None),
        ]
        for method, path, payload in paths:
            with self.subTest(method=method, path=path):
                with self.assertRaises(watch.WatchError):
                    api.request(method, path, payload)
        opener.open.assert_not_called()

    def test_token_is_not_forwarded_to_another_host_path_traversal_or_redirect(self):
        bad_urls = [
            'http://api.github.com/repos/Daiobs/DokiTool-Go',
            'https://api.github.com.evil.test/repos/Daiobs/DokiTool-Go',
            'https://user@api.github.com/repos/Daiobs/DokiTool-Go',
            'https://api.github.com/repos/Daiobs/DokiTool',
            'https://api.github.com/repos/Brilliant666/DokiTool-Go',
            'https://api.github.com/repos/jiuhunwl/short_videos',
            'https://api.github.com/repos/Daiobs/DokiTool-Go/../../other/repo',
            'https://api.github.com/repos/Daiobs/DokiTool-Go#fragment',
        ]
        for url in bad_urls:
            with self.subTest(url=url), self.assertRaises(watch.WatchError):
                watch.validate_api_url(url)
        self.assertIsNone(watch.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test'))

    def test_environment_is_bound_to_dokitool_go_and_public_github(self):
        self.assertEqual(
            watch.environment({'GITHUB_RUN_ID': '123'}),
            'https://github.com/Daiobs/DokiTool-Go/actions/runs/123',
        )
        bad_envs = [
            {'GITHUB_REPOSITORY': 'Daiobs/DokiTool'},
            {'GITHUB_REPOSITORY': 'Brilliant666/DokiTool-Go'},
            {'GITHUB_REPOSITORY': 'other/repo'},
            {'GITHUB_REPOSITORY_OWNER': 'Brilliant666'},
            {'GITHUB_REPOSITORY_OWNER': 'other'},
            {'GITHUB_SERVER_URL': 'https://evil.test'},
            {'GITHUB_RUN_ID': '123/evil'},
        ]
        for env in bad_envs:
            with self.subTest(env=env), self.assertRaises(watch.WatchError):
                watch.environment(env)

    def test_safe_text_escapes_mentions_markdown_and_html(self):
        text = watch.safe_text('@Daiobs\n[click](https://evil.test) <script>alert("x")</script> `code` | col')
        self.assertNotIn('@', text)
        self.assertNotIn('\n', text)
        self.assertNotIn('<script>', text)
        self.assertIn('\\[click\\]\\(', text)
        self.assertIn('\\`code\\`', text)
        self.assertIn('\\|', text)
        self.assertIn('&quot;', text)

    def test_v1_schema_malformed_snapshot_and_oversized_notice_fail(self):
        seed = build_state_from_upstreams(seed_upstream_data())
        with self.assertRaises(watch.WatchError):
            watch.normalize_state({'schema': 1, 'observed_at': '2026-10-28T01:00:00Z', 'repositories': seed['repositories']})
        with self.assertRaises(watch.WatchError):
            watch.normalize_state({'schema': 2, 'observed_at': 'invalid', 'repositories': seed['repositories']})
        bad = copy.deepcopy(seed)
        bad['repositories']['yt-dlp/yt-dlp']['latest_id'] = 999999
        with self.assertRaises(watch.WatchError):
            watch.normalize_state(bad)
        bad_drift = copy.deepcopy(seed)
        bad_drift['repositories']['denoland/deno']['local_drift'] = 'not-a-list'
        with self.assertRaises(watch.WatchError):
            watch.normalize_state(bad_drift)
        with self.assertRaises(watch.WatchError):
            watch.make_body('table', 'x' * watch.MAX_BODY, seed, None)


class CliEntrypointTests(unittest.TestCase):
    def test_main_writes_step_summary_and_json_result_offline(self):
        upstreams = seed_upstream_data()
        seed = build_state_from_upstreams(upstreams)
        fake_api = FakeGitHub(upstreams, managed_issue(seed))
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            write_synthetic_lock_files(root)
            summary_path = Path(tmp) / 'step-summary.md'
            env = {
                'GITHUB_REPOSITORY': 'Daiobs/DokiTool-Go',
                'GITHUB_REPOSITORY_OWNER': 'Daiobs',
                'GITHUB_SERVER_URL': 'https://github.com',
                'GITHUB_RUN_ID': '98765',
                'GITHUB_TOKEN': 'test-token',
                'GITHUB_STEP_SUMMARY': str(summary_path),
            }
            stdout = io.StringIO()
            with patch.dict(os.environ, env, clear=True), \
                 patch.object(sys, 'argv', ['check-upstream-updates.py', '--dry-run', '--root', str(root)]), \
                 patch.object(watch, 'GitHub', return_value=fake_api), \
                 patch.object(sys, 'stdout', stdout):
                watch.main()
            parsed = json.loads(stdout.getvalue())
            self.assertFalse(parsed['changed'])
            self.assertTrue(parsed['dry_run'])
            summary_md = summary_path.read_text(encoding='utf-8')
            self.assertIn('## DokiTool-Go 上游运行时版本检查', summary_md)
            self.assertIn('https://github.com/Daiobs/DokiTool-Go/issues/17', summary_md)

    def test_cli_exits_nonzero_on_wrong_repository_or_missing_token_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_synthetic_lock_files(root)
            for extra_env, expected_err in (
                ({'GITHUB_REPOSITORY': 'Daiobs/DokiTool'}, 'Daiobs/DokiTool-Go'),
                ({'GITHUB_REPOSITORY': 'Brilliant666/DokiTool-Go'}, 'Daiobs/DokiTool-Go'),
                ({'GITHUB_REPOSITORY': 'Daiobs/DokiTool-Go'}, 'GITHUB_TOKEN is required'),
            ):
                with self.subTest(extra_env=extra_env):
                    env = {'PATH': os.environ.get('PATH', ''), **extra_env}
                    proc = subprocess.run(
                        [sys.executable, '-B', str(SCRIPT), '--dry-run', '--root', str(root)],
                        env=env,
                        text=True,
                        capture_output=True,
                        check=False,
                    )
                    self.assertEqual(proc.returncode, 1)
                    self.assertIn(expected_err, proc.stderr)

    def test_check_local_pins_rejects_combining_with_verify_notification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_synthetic_lock_files(root)
            proc = subprocess.run(
                [sys.executable, '-B', str(SCRIPT), '--check-local-pins', '--verify-notification', '--root', str(root)],
                env={'PATH': os.environ.get('PATH', '')},
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 1)
            self.assertIn('--check-local-pins cannot be combined with --verify-notification', proc.stderr)

    def test_end_to_end_drifted_repo_blocks_pr_gate_while_watch_mode_posts_issue_notification(self):
        scenarios = [
            (
                'requirements-deno-drift',
                watch.VALIDATION_REQUIREMENTS_REL,
                lambda s: s.replace('deno==2.9.8', 'deno==2.9.7'),
                'scripts/requirements-validation.txt',
            ),
            (
                'engine-bumped-ahead-of-gateway',
                watch.YTDLP_SOURCE_REL,
                lambda s: s.replace('const PinnedVersion = "2026.10.26"', 'const PinnedVersion = "2026.11.01"'),
                '.github/workflows/gateway-isolation.yml',
            ),
        ]
        for label, rel, mutate, expected_fragment in scenarios:
            with self.subTest(scenario=label), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / 'drifted-repo'
                write_synthetic_lock_files(root)
                target = root / rel
                target.write_text(mutate(target.read_text(encoding='utf-8')), encoding='utf-8')

                # 1) Offline library helpers used by normal watch mode succeed without WatchError.
                pinned = watch.load_pinned_versions(root)
                drift = watch.collect_local_pin_drift(root, pinned)
                self.assertTrue(any(drift.values()))

                # 2) PR gate CLI (--check-local-pins) fails closed with exit code 1.
                gate_proc = subprocess.run(
                    [sys.executable, '-B', str(SCRIPT), '--check-local-pins', '--root', str(root)],
                    env={'PATH': os.environ.get('PATH', '')},
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(gate_proc.returncode, 1)
                self.assertIn('Local pin drift detected:', gate_proc.stderr)
                self.assertIn(expected_fragment, gate_proc.stderr)

                # 3a) Normal watch mode (initial Issue creation) succeeds (exit 0) and writes "本地配置漂移".
                env = {
                    'GITHUB_REPOSITORY': 'Daiobs/DokiTool-Go',
                    'GITHUB_REPOSITORY_OWNER': 'Daiobs',
                    'GITHUB_SERVER_URL': 'https://github.com',
                    'GITHUB_TOKEN': 'test-token',
                }
                initial_api = FakeGitHub(seed_upstream_data())
                stdout_init = io.StringIO()
                with patch.dict(os.environ, env, clear=True), \
                     patch.object(watch, 'GitHub', return_value=initial_api), \
                     patch.object(sys, 'stdout', stdout_init):
                    rc_init = watch.cli(['--root', str(root)])
                self.assertEqual(rc_init, 0)
                init_result = json.loads(stdout_init.getvalue())
                self.assertTrue(init_result['issue_created'])
                self.assertTrue(init_result['notification_posted'])
                self.assertEqual(len(initial_api.writes), 1)
                issue_body = initial_api.writes[0][2]['body']
                self.assertIn('本地配置漂移', issue_body)
                self.assertIn(expected_fragment, issue_body)

                # 3b) Normal watch mode (incremental comment on existing managed Issue) succeeds (exit 0) and writes "本地配置漂移".
                upstreams = seed_upstream_data()
                clean_seed = build_state_from_upstreams(upstreams)
                comment_api = FakeGitHub(upstreams, managed_issue(clean_seed))
                stdout_comment = io.StringIO()
                with patch.dict(os.environ, env, clear=True), \
                     patch.object(watch, 'GitHub', return_value=comment_api), \
                     patch.object(sys, 'stdout', stdout_comment):
                    rc_comment = watch.cli(['--root', str(root)])
                self.assertEqual(rc_comment, 0)
                comment_result = json.loads(stdout_comment.getvalue())
                self.assertTrue(comment_result['changed'])
                self.assertTrue(comment_result['notification_posted'])
                self.assertEqual(len(comment_api.writes), 1)
                self.assertEqual(comment_api.writes[0][1], '/repos/Daiobs/DokiTool-Go/issues/17/comments')
                comment_body = comment_api.writes[0][2]['body']
                self.assertIn('本地配置漂移', comment_body)
                self.assertIn(expected_fragment, comment_body)


if __name__ == '__main__':
    unittest.main()
