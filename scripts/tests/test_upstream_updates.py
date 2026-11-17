"""Offline behavioral and security tests for DokiTool-Go upstream runtime watch."""
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


def build_state_from_upstreams(upstreams, observed_at='2026-10-28T01:00:00Z'):
    fake = FakeGitHub(upstreams)
    return watch.normalize_state({
        'schema': watch.SCHEMA_VERSION,
        'observed_at': observed_at,
        'repositories': {repo: watch.collect_snapshot(fake, repo) for repo in watch.UPSTREAMS},
    })


def managed_issue(state, issue_state='open'):
    return {
        'number': 17,
        'title': watch.TITLE,
        'user': copy.deepcopy(BOT),
        'body': 'Monitoring enabled.\n' + watch.state_marker(state),
        'state': issue_state,
    }


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


class PinnedVersionExtractionTests(unittest.TestCase):
    def test_loads_real_repo_pinned_versions(self):
        pinned = watch.load_pinned_versions()
        self.assertEqual(pinned, {'yt-dlp/yt-dlp': '2026.10.26', 'denoland/deno': '2.9.8'})

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

    def test_missing_or_corrupt_go_constants_raise_watch_error(self):
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
        self.assertEqual((method, path), ('POST', '/repos/Brilliant666/DokiTool-Go/issues'))
        self.assertEqual(payload['title'], watch.TITLE)
        self.assertEqual(payload['assignees'], ['Brilliant666'])
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
        second = self.run_watch(api)
        self.assertFalse(second['changed'])
        self.assertEqual(len(api.writes), 1)

    def test_first_run_reports_divergence_when_upstream_already_ahead_of_pinned(self):
        api = FakeGitHub(self.upstreams)
        api.set_latest_stable('yt-dlp/yt-dlp', api_release(102, '2026.11.01', '2026-11-01T00:00:00Z'))
        result = self.run_watch(api)
        self.assertTrue(result['changed'])
        self.assertTrue(result['issue_created'])
        body = api.writes[0][2]['body']
        self.assertIn('发现新正式版', body)
        self.assertIn('`2026.10.26`', body)
        self.assertIn(watch.safe_text('2026.11.01'), body)

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
            ('yt-dlp/yt-dlp', api_release(105, '2026.11.05', '2026-11-05T02:00:00Z', name='yt-dlp 2026.11.05'), '`2026.10.26`'),
            ('denoland/deno', api_release(205, 'v2.9.9', '2026-11-06T03:00:00Z', name='Deno 2.9.9'), '`2.9.8`'),
        ]
        for repo, new_rel, locked_cell in cases:
            with self.subTest(repo=repo):
                api = FakeGitHub(self.upstreams, managed_issue(self.seed))
                api.set_latest_stable(repo, new_rel)
                result = self.run_watch(api, run_url='https://github.com/Brilliant666/DokiTool-Go/actions/runs/42')
                self.assertTrue(result['changed'])
                self.assertTrue(result['notification_posted'])
                self.assertEqual(len(api.writes), 1)
                method, path, payload = api.writes[0]
                self.assertEqual((method, path), ('POST', '/repos/Brilliant666/DokiTool-Go/issues/17/comments'))
                body = payload['body']
                self.assertIn(locked_cell, body)
                self.assertIn(watch.safe_text(new_rel['tag_name']), body)
                self.assertIn('发现新正式版', body)
                self.assertIn('正式版新增', body)
                self.assertIn('SHA-256', body)
                self.assertIn('https://github.com/Brilliant666/DokiTool-Go/actions/runs/42', body)
                saved = watch.extract_state(body)
                self.assertEqual(saved['repositories'][repo]['latest_tag'], new_rel['tag_name'])
                # Subsequent check without further upstream changes is a no-op.
                second = self.run_watch(api)
                self.assertFalse(second['changed'])
                self.assertEqual(len(api.writes), 1)

    def test_stable_release_edit_and_retraction_are_reported_once(self):
        # 1) Release edit (updated_at changes)
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        edited = api_release(201, 'v2.9.8', '2026-10-20T00:00:00Z', updated_at='2026-10-29T00:30:00Z')
        api.set_latest_stable('denoland/deno', edited)
        res_edit = self.run_watch(api)
        self.assertTrue(res_edit['changed'])
        self.assertIn('正式版变更', res_edit['summary'])
        self.assertFalse(self.run_watch(api)['changed'])

        # 2) Release retraction (v2.9.8 yanked back to v2.9.7)
        api2 = FakeGitHub(self.upstreams, managed_issue(self.seed))
        older = api_release(200, 'v2.9.7', '2026-10-10T00:00:00Z')
        api2.upstreams['denoland/deno']['releases'] = [older]
        api2.upstreams['denoland/deno']['latest'] = copy.deepcopy(older)
        res_retract = self.run_watch(api2)
        self.assertTrue(res_retract['changed'])
        self.assertIn('正式版撤回或移除', res_retract['summary'])
        self.assertFalse(self.run_watch(api2)['changed'])

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

    def test_malicious_release_tags_and_names_are_escaped_in_notifications(self):
        api = FakeGitHub(self.upstreams, managed_issue(self.seed))
        malicious = api_release(
            299,
            'v2.9.9-@Brilliant666|[evil](https://evil.test)<script>',
            '2026-11-10T00:00:00Z',
            name='Release @all <img src="x" onerror="alert(1)"> `cmd` [hijack](https://evil.test)',
        )
        api.set_latest_stable('denoland/deno', malicious)
        self.run_watch(api)
        body = api.writes[0][2]['body']
        # Strip the trailing HTML comment state marker before asserting no HTML tags remain in visible body.
        visible = body.split(watch.MARKER)[0]
        self.assertNotIn('@Brilliant666', visible)
        self.assertNotIn('@all', visible)
        self.assertNotIn('<script>', visible)
        self.assertNotIn('<img', visible)
        self.assertNotIn('[evil](https://evil.test)', visible)
        self.assertNotIn('[hijack](https://evil.test)', visible)
        self.assertIn('&lt;script&gt;', visible)
        self.assertIn('&lt;img', visible)
        self.assertIn('\\[evil\\]\\(', visible)
        self.assertIn('\\`cmd\\`', visible)


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
            ('PUT', '/repos/Brilliant666/DokiTool-Go/contents/README.md', {}),
            ('POST', '/repos/yt-dlp/yt-dlp/issues', {}),
            ('POST', '/repos/denoland/deno/issues', {}),
            ('PATCH', '/repos/Brilliant666/DokiTool-Go/issues/17', {'body': 'overwrite'}),
            ('DELETE', '/repos/Brilliant666/DokiTool-Go/issues/17', None),
        ]
        for method, path, payload in paths:
            with self.subTest(method=method, path=path):
                with self.assertRaises(watch.WatchError):
                    api.request(method, path, payload)
        opener.open.assert_not_called()

    def test_token_is_not_forwarded_to_another_host_path_traversal_or_redirect(self):
        bad_urls = [
            'http://api.github.com/repos/Brilliant666/DokiTool-Go',
            'https://api.github.com.evil.test/repos/Brilliant666/DokiTool-Go',
            'https://user@api.github.com/repos/Brilliant666/DokiTool-Go',
            'https://api.github.com/repos/Brilliant666/DokiTool',
            'https://api.github.com/repos/jiuhunwl/short_videos',
            'https://api.github.com/repos/Brilliant666/DokiTool-Go/../../other/repo',
            'https://api.github.com/repos/Brilliant666/DokiTool-Go#fragment',
        ]
        for url in bad_urls:
            with self.subTest(url=url), self.assertRaises(watch.WatchError):
                watch.validate_api_url(url)
        self.assertIsNone(watch.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.test'))

    def test_environment_is_bound_to_dokitool_go_and_public_github(self):
        self.assertEqual(
            watch.environment({'GITHUB_RUN_ID': '123'}),
            'https://github.com/Brilliant666/DokiTool-Go/actions/runs/123',
        )
        bad_envs = [
            {'GITHUB_REPOSITORY': 'Brilliant666/DokiTool'},
            {'GITHUB_REPOSITORY': 'other/repo'},
            {'GITHUB_REPOSITORY_OWNER': 'other'},
            {'GITHUB_SERVER_URL': 'https://evil.test'},
            {'GITHUB_RUN_ID': '123/evil'},
        ]
        for env in bad_envs:
            with self.subTest(env=env), self.assertRaises(watch.WatchError):
                watch.environment(env)

    def test_safe_text_escapes_mentions_markdown_and_html(self):
        text = watch.safe_text('@Brilliant666\n[click](https://evil.test) <script>alert("x")</script> `code` | col')
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
        with self.assertRaises(watch.WatchError):
            watch.make_body('table', 'x' * watch.MAX_BODY, seed, None)


class CliEntrypointTests(unittest.TestCase):
    def test_main_writes_step_summary_and_json_result_offline(self):
        upstreams = seed_upstream_data()
        seed = build_state_from_upstreams(upstreams)
        fake_api = FakeGitHub(upstreams, managed_issue(seed))
        with tempfile.TemporaryDirectory() as tmp:
            summary_path = Path(tmp) / 'step-summary.md'
            env = {
                'GITHUB_REPOSITORY': 'Brilliant666/DokiTool-Go',
                'GITHUB_REPOSITORY_OWNER': 'Brilliant666',
                'GITHUB_SERVER_URL': 'https://github.com',
                'GITHUB_RUN_ID': '98765',
                'GITHUB_TOKEN': 'test-token',
                'GITHUB_STEP_SUMMARY': str(summary_path),
            }
            stdout = io.StringIO()
            with patch.dict(os.environ, env, clear=True), \
                 patch.object(sys, 'argv', ['check-upstream-updates.py', '--dry-run']), \
                 patch.object(watch, 'GitHub', return_value=fake_api), \
                 patch.object(sys, 'stdout', stdout):
                watch.main()
            parsed = json.loads(stdout.getvalue())
            self.assertFalse(parsed['changed'])
            self.assertTrue(parsed['dry_run'])
            summary_md = summary_path.read_text(encoding='utf-8')
            self.assertIn('## DokiTool-Go 上游运行时版本检查', summary_md)
            self.assertIn('https://github.com/Brilliant666/DokiTool-Go/issues/17', summary_md)

    def test_cli_exits_nonzero_on_wrong_repository_or_missing_token_offline(self):
        for extra_env, expected_err in (
            ({'GITHUB_REPOSITORY': 'Brilliant666/DokiTool'}, 'Brilliant666/DokiTool-Go'),
            ({'GITHUB_REPOSITORY': 'Brilliant666/DokiTool-Go'}, 'GITHUB_TOKEN is required'),
        ):
            with self.subTest(extra_env=extra_env):
                env = {'PATH': os.environ.get('PATH', ''), **extra_env}
                proc = subprocess.run(
                    [sys.executable, '-B', str(SCRIPT), '--dry-run'],
                    env=env,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(proc.returncode, 1)
                self.assertIn(expected_err, proc.stderr)


if __name__ == '__main__':
    unittest.main()
