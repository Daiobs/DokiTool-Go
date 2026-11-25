"""Offline behavioral and security unit tests for scripts/check-upstream-canary.py."""
from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'check-upstream-canary.py'
SPEC = importlib.util.spec_from_file_location('upstream_canary', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
canary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(canary)

NOW = dt.datetime(2026, 11, 25, 13, 30, 0, tzinfo=dt.timezone.utc)
BOT = {'login': canary.BOT, 'type': 'Bot'}
HUMAN = {'login': 'external-user', 'type': 'User'}


def make_deno_report(
    *,
    player_id: str = 'b485e332',
    tv_ok: bool = True,
    main_ok: bool = True,
    tv_error_code: str = '',
    main_error_code: str = '',
    discovery_error_code: str = '',
    elapsed_ms: int = 1230,
    deno_version: str = '2.9.8',
    ejs_version: str = '0.8.0',
) -> dict:
    overall = tv_ok and main_ok
    if overall:
        status = 'ok'
    elif not tv_ok and main_ok:
        status = 'degraded_tv_only'
    elif tv_ok and not main_ok:
        status = 'degraded_main_only'
    else:
        status = 'outage'
    return {
        'schema_version': '1.0',
        'player_id': player_id,
        'status': status,
        'tv_ok': tv_ok,
        'main_ok': main_ok,
        'tv_error_code': tv_error_code,
        'main_error_code': main_error_code,
        'discovery_error_code': discovery_error_code,
        'elapsed_ms': elapsed_ms,
        'deno_version': deno_version,
        'ejs_version': ejs_version,
        'overall_ok': overall,
    }


def make_smoke_report(
    *,
    youtube_status: str = 'PASS',
    youtube_code: str = 'OK',
    youtube_http: int = 200,
    youtube_elapsed_ms: int = 420,
    platforms_status: str = 'PASS',
    api_boundary_status: str = 'PASS',
) -> dict:
    checks = [
        {
            'id': 'platforms',
            'group': 'platforms',
            'status': platforms_status,
            'http_status': 200 if platforms_status == 'PASS' else 502,
            'code': 'OK' if platforms_status == 'PASS' else 'UPSTREAM_UNAVAILABLE',
            'elapsed_ms': 120,
            'retry_count': 0,
            'media_hostnames': [],
            'note': 'ok',
        },
        {
            'id': 'youtube_context',
            'group': 'youtube_context',
            'status': youtube_status,
            'http_status': youtube_http,
            'code': youtube_code,
            'elapsed_ms': youtube_elapsed_ms,
            'retry_count': 0,
            'media_hostnames': [],
            'note': 'ok',
        },
        {
            'id': 'api_boundary:stats_unauth_401',
            'group': 'api_boundary',
            'status': api_boundary_status,
            'http_status': 401 if api_boundary_status == 'PASS' else 200,
            'code': 'INVALID_INPUT' if api_boundary_status == 'PASS' else 'HTTP_200',
            'elapsed_ms': 90,
            'retry_count': 0,
            'media_hostnames': [],
            'note': 'ok',
        },
        {
            'id': 'api_boundary:unlisted_api_404',
            'group': 'api_boundary',
            'status': 'PASS',
            'http_status': 404,
            'code': 'INVALID_INPUT',
            'elapsed_ms': 85,
            'retry_count': 0,
            'media_hostnames': [],
            'note': 'ok',
        },
    ]
    fail_count = sum(1 for c in checks if c['status'] == 'FAIL')
    warn_count = sum(1 for c in checks if c['status'] == 'WARN')
    pass_count = sum(1 for c in checks if c['status'] == 'PASS')
    return {
        'schema_version': '1.0',
        'generated_at_utc': '2026-11-25T13:30:00Z',
        'target_host': 'snap.dokitool.com',
        'tier': 'tier-a',
        'passed': fail_count == 0,
        'summary': {
            'total': len(checks),
            'pass': pass_count,
            'warn': warn_count,
            'sample_stale': 0,
            'fail': fail_count,
            'skip': 0,
        },
        'checks': checks,
    }


def make_workflow_run(
    run_id: int,
    conclusion: str,
    *,
    created_at: str,
    event: str = 'schedule',
    status: str = 'completed',
    run_number: int = 1,
) -> dict:
    return {
        'id': run_id,
        'run_number': run_number,
        'event': event,
        'status': status,
        'conclusion': conclusion,
        'created_at': created_at,
    }


class FakeGitHub:
    """In-memory mock of GitHub API with strict desensitization and endpoint checks."""

    def __init__(self, *, issues=None, comments=None, workflow_runs=None) -> None:
        self.issues = copy.deepcopy(issues or [])
        self.comments = copy.deepcopy(comments or {})
        self.workflow_runs = copy.deepcopy(workflow_runs or [])
        self.writes = []
        self._next_issue_number = 100
        self._next_comment_id = 500

    def get(self, path: str) -> dict:
        canary.validate_api_url(path)
        if '/actions/workflows/' in path and '/runs' in path:
            return {'workflow_runs': copy.deepcopy(self.workflow_runs)}
        raise AssertionError(f'Unexpected GET {path}')

    def items(self, path: str) -> list:
        canary.validate_api_url(path)
        if '/comments' in path:
            num = int(path.split('/issues/')[1].split('/comments')[0])
            return copy.deepcopy(self.comments.get(num, []))
        if '/issues?' in path:
            return copy.deepcopy(self.issues)
        raise AssertionError(f'Unexpected paginated GET {path}')

    def request(self, method: str, path: str, data=None):
        canary.validate_api_url(path)
        if method == 'POST' and isinstance(data, dict):
            if 'title' in data:
                canary.assert_desensitized(data['title'], description='Issue title')
            if 'body' in data:
                canary.assert_desensitized(data['body'], description='Issue body/comment')
        self.writes.append((method, path, copy.deepcopy(data)))
        if method == 'POST' and path == '/repos/' + canary.TARGET + '/issues':
            num = self._next_issue_number
            self._next_issue_number += 1
            issue = {
                'number': num,
                'title': data['title'],
                'body': data['body'],
                'user': copy.deepcopy(BOT),
                'state': 'open',
            }
            self.issues.append(issue)
            self.comments.setdefault(num, [])
            return copy.deepcopy(issue), {}
        if method == 'POST' and '/comments' in path:
            num = int(path.split('/issues/')[1].split('/comments')[0])
            cid = self._next_comment_id
            self._next_comment_id += 1
            comment = {
                'id': cid,
                'body': data['body'],
                'user': copy.deepcopy(BOT),
            }
            self.comments.setdefault(num, []).append(comment)
            return copy.deepcopy(comment), {}
        if method == 'PATCH' and '/issues/' in path:
            num = int(path.split('/issues/')[1])
            for issue in self.issues:
                if issue['number'] == num:
                    issue['state'] = data['state']
                    return copy.deepcopy(issue), {}
            raise AssertionError(f'Issue #{num} not found')
        raise AssertionError(f'Unexpected {method} {path}')


class UpstreamCanaryTests(unittest.TestCase):
    def _write_reports(self, tmp: Path, deno_obj, smoke_obj):
        deno_path = tmp / 'deno.json'
        smoke_path = tmp / 'smoke.json'
        if deno_obj is not None:
            deno_path.write_text(
                deno_obj if isinstance(deno_obj, str) else json.dumps(deno_obj),
                encoding='utf-8',
            )
        if smoke_obj is not None:
            smoke_path.write_text(
                smoke_obj if isinstance(smoke_obj, str) else json.dumps(smoke_obj),
                encoding='utf-8',
            )
        return deno_path, smoke_path

    def test_healthy_run_and_warn_only_smoke_produce_zero_writes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            deno_path, smoke_path = self._write_reports(
                Path(td),
                make_deno_report(tv_ok=True, main_ok=True),
                make_smoke_report(youtube_status='WARN', youtube_code='LATENCY_WARN', youtube_elapsed_ms=2600),
            )
            deno = canary.load_deno_report(deno_path, exit_code=0)
            smoke = canary.load_smoke_report(smoke_path, exit_code=0)
            api = FakeGitHub()
            res = canary.evaluate_and_apply(deno=deno, smoke=smoke, api=api, now=NOW)
            self.assertTrue(res['overall_ok'])
            self.assertEqual(res['action'], 'healthy_noop')
            self.assertEqual(res['consecutive_failures'], 0)
            self.assertEqual(api.writes, [])

    def test_streak_1_failure_is_suppressed_but_cli_exits_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            deno_path, smoke_path = self._write_reports(
                Path(td),
                make_deno_report(tv_ok=True, main_ok=False, main_error_code='EJS_N_PROBE_FAILED'),
                make_smoke_report(),
            )
            api = FakeGitHub(
                workflow_runs=[
                    make_workflow_run(10, 'success', created_at='2026-11-25T01:30:00Z', run_number=10),
                ]
            )
            deno = canary.load_deno_report(deno_path, exit_code=1)
            smoke = canary.load_smoke_report(smoke_path, exit_code=0)
            res = canary.evaluate_and_apply(deno=deno, smoke=smoke, api=api, now=NOW)
            self.assertFalse(res['overall_ok'])
            self.assertEqual(res['consecutive_failures'], 1)
            self.assertEqual(res['action'], 'suppressed_debounce')
            self.assertEqual(api.writes, [])

            # CLI must exit non-zero (1) even when suppressed so Actions records conclusion=failure.
            out_buf = io.StringIO()
            with patch.dict(
                os.environ,
                {
                    'GITHUB_TOKEN': 'fake-test-value',
                    'GITHUB_REPOSITORY': canary.TARGET,
                    'GITHUB_REPOSITORY_OWNER': canary.OWNER,
                },
                clear=True,
            ), patch.object(canary, 'GitHub', return_value=api), patch('sys.stdout', out_buf):
                rc = canary.cli(
                    [
                        '--deno-report',
                        str(deno_path),
                        '--smoke-report',
                        str(smoke_path),
                        '--deno-exit-code',
                        '1',
                        '--smoke-exit-code',
                        '0',
                    ]
                )
            self.assertEqual(rc, 1)
            self.assertEqual(api.writes, [])

    def test_streak_2_opens_issue_streak_3_deduplicates_change_updates_and_recovery_closes(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            # Streak = 2 (prior scheduled run failed; manual workflow_dispatch success ignored)
            deno_p, smoke_p = self._write_reports(
                tmp,
                make_deno_report(
                    player_id='b485e332',
                    tv_ok=True,
                    main_ok=False,
                    main_error_code='EJS_N_PROBE_FAILED',
                    elapsed_ms=1100,
                ),
                make_smoke_report(),
            )
            api = FakeGitHub(
                workflow_runs=[
                    make_workflow_run(
                        22, 'success', created_at='2026-11-25T08:00:00Z', event='workflow_dispatch', run_number=22
                    ),
                    make_workflow_run(
                        21, 'cancelled', created_at='2026-11-25T04:00:00Z', event='schedule', run_number=21
                    ),
                    make_workflow_run(
                        20, 'failure', created_at='2026-11-25T01:30:00Z', event='schedule', run_number=20
                    ),
                    make_workflow_run(
                        19, 'success', created_at='2026-11-24T13:30:00Z', event='schedule', run_number=19
                    ),
                ]
            )
            res2 = canary.evaluate_and_apply(
                deno=canary.load_deno_report(deno_p, exit_code=1),
                smoke=canary.load_smoke_report(smoke_p, exit_code=0),
                api=api,
                now=NOW,
                run_url='https://github.com/Daiobs/DokiTool-Go/actions/runs/999',
            )
            self.assertEqual(res2['action'], 'issue_created')
            self.assertEqual(res2['consecutive_failures'], 2)
            self.assertEqual(res2['deno_status'], 'degraded_main_only')
            self.assertEqual(len(api.writes), 1)
            self.assertEqual(api.writes[0][0], 'POST')
            self.assertEqual(api.issues[0]['state'], 'open')
            self.assertIn(canary.MARKER, api.issues[0]['body'])
            fp_first = res2['fingerprint']

            # Streak = 3 with SAME failure (only elapsed_ms and time differ) -> DEDUPLICATED (no comment spam)
            deno_p3, smoke_p3 = self._write_reports(
                tmp,
                make_deno_report(
                    player_id='b485e332',
                    tv_ok=True,
                    main_ok=False,
                    main_error_code='EJS_N_PROBE_FAILED',
                    elapsed_ms=2890,
                ),
                make_smoke_report(youtube_elapsed_ms=910),
            )
            api.workflow_runs.insert(
                0,
                make_workflow_run(23, 'failure', created_at='2026-11-25T13:30:00Z', event='schedule', run_number=23),
            )
            res3 = canary.evaluate_and_apply(
                deno=canary.load_deno_report(deno_p3, exit_code=1),
                smoke=canary.load_smoke_report(smoke_p3, exit_code=0),
                api=api,
                now=NOW + dt.timedelta(hours=12),
            )
            self.assertEqual(res3['action'], 'deduplicated')
            self.assertEqual(res3['consecutive_failures'], 3)
            self.assertEqual(res3['fingerprint'], fp_first)
            self.assertEqual(len(api.writes), 1)

            # Streak = 4 with CHANGED failure (escalates to full tv+main outage) -> posts update comment
            deno_p4, smoke_p4 = self._write_reports(
                tmp,
                make_deno_report(
                    player_id='b485e332',
                    tv_ok=False,
                    main_ok=False,
                    tv_error_code='EJS_N_PROBE_FAILED',
                    main_error_code='EJS_N_PROBE_FAILED',
                ),
                make_smoke_report(youtube_status='FAIL', youtube_code='LATENCY_FAIL', youtube_elapsed_ms=6100),
            )
            res4 = canary.evaluate_and_apply(
                deno=canary.load_deno_report(deno_p4, exit_code=1),
                smoke=canary.load_smoke_report(smoke_p4, exit_code=1),
                api=api,
                now=NOW + dt.timedelta(hours=24),
            )
            self.assertEqual(res4['action'], 'issue_updated')
            self.assertNotEqual(res4['fingerprint'], fp_first)
            self.assertEqual(len(api.comments[100]), 1)

            # Recovery -> posts recovery comment AND closes the Issue
            deno_ok, smoke_ok = self._write_reports(tmp, make_deno_report(), make_smoke_report())
            res_rec = canary.evaluate_and_apply(
                deno=canary.load_deno_report(deno_ok, exit_code=0),
                smoke=canary.load_smoke_report(smoke_ok, exit_code=0),
                api=api,
                now=NOW + dt.timedelta(hours=36),
            )
            self.assertTrue(res_rec['overall_ok'])
            self.assertEqual(res_rec['action'], 'issue_closed')
            self.assertEqual(api.issues[0]['state'], 'closed')
            self.assertEqual(len(api.comments[100]), 2)

            # Subsequent healthy run while closed -> no-op
            writes_before = len(api.writes)
            res_noop = canary.evaluate_and_apply(
                deno=canary.load_deno_report(deno_ok, exit_code=0),
                smoke=canary.load_smoke_report(smoke_ok, exit_code=0),
                api=api,
                now=NOW + dt.timedelta(hours=48),
            )
            self.assertEqual(res_noop['action'], 'healthy_noop')
            self.assertEqual(len(api.writes), writes_before)

            # Future incident at streak=2 while closed -> reopens the single managed Issue
            res_reopen = canary.evaluate_and_apply(
                deno=canary.load_deno_report(deno_p4, exit_code=1),
                smoke=canary.load_smoke_report(smoke_p4, exit_code=1),
                api=api,
                now=NOW + dt.timedelta(hours=60),
                previous_conclusions=['failure'],
            )
            self.assertEqual(res_reopen['action'], 'issue_reopened')
            self.assertEqual(api.issues[0]['state'], 'open')

    def test_spoofed_non_bot_issue_and_forged_human_comment_ignored(self) -> None:
        spoofed_state = {
            'schema': 1,
            'status': 'failing',
            'fingerprint': '0123456789abcdef',
            'consecutive_failures': 99,
            'observed_at': '2026-11-24T00:00:00+00:00',
            'player_id': 'b485e332',
            'deno_status': 'outage',
            'smoke_ok': False,
        }
        spoofed_issue = {
            'number': 55,
            'title': canary.TITLE,
            'body': 'Spoofed alert\n' + canary.state_marker(spoofed_state),
            'user': copy.deepcopy(HUMAN),
            'state': 'open',
        }
        # Also include an upstream-watch Issue by github-actions[bot] with v2 watch marker (must be ignored!)
        watch_issue = {
            'number': 9,
            'title': 'DokiTool-Go 上游运行时版本检查',
            'body': 'Tracking\n<!-- dokitool-upstream-watch-state:v2:e30= -->',
            'user': copy.deepcopy(BOT),
            'state': 'open',
        }
        api = FakeGitHub(issues=[spoofed_issue, watch_issue])
        found_issue, found_state = canary.find_managed_issue(api)
        self.assertIsNone(found_issue)
        self.assertIsNone(found_state)

        # Now add a real bot Issue with a forged human comment trying to spoof the fingerprint.
        with tempfile.TemporaryDirectory() as td:
            deno_p, smoke_p = self._write_reports(
                Path(td),
                make_deno_report(tv_ok=False, main_ok=True, tv_error_code='FETCH_HTTP_ERROR'),
                make_smoke_report(),
            )
            deno = canary.load_deno_report(deno_p, exit_code=1)
            smoke = canary.load_smoke_report(smoke_p, exit_code=0)
            real_fp = canary.compute_failure_fingerprint(deno, smoke)
            real_issue = {
                'number': 88,
                'title': canary.TITLE,
                'body': 'Real alert\n'
                + canary.state_marker(
                    {
                        'schema': 1,
                        'status': 'failing',
                        'fingerprint': 'aaaaaaaaaaaaaaaa',
                        'consecutive_failures': 2,
                        'observed_at': '2026-11-24T13:30:00+00:00',
                        'player_id': '11112222',
                        'deno_status': 'degraded_main_only',
                        'smoke_ok': True,
                    }
                ),
                'user': copy.deepcopy(BOT),
                'state': 'open',
            }
            forged_comment = {
                'id': 701,
                'body': 'Forged\n'
                + canary.state_marker(
                    {
                        'schema': 1,
                        'status': 'failing',
                        'fingerprint': real_fp,
                        'consecutive_failures': 3,
                        'observed_at': '2026-11-25T01:30:00+00:00',
                        'player_id': 'b485e332',
                        'deno_status': 'degraded_tv_only',
                        'smoke_ok': True,
                    }
                ),
                'user': copy.deepcopy(HUMAN),
            }
            api2 = FakeGitHub(issues=[spoofed_issue, watch_issue, real_issue], comments={88: [forged_comment]})
            res = canary.evaluate_and_apply(deno=deno, smoke=smoke, api=api2, now=NOW, previous_conclusions=['failure'])
            # Because the forged human comment is ignored, bot still sees fingerprint 'aaaaaaaaaaaaaaaa' != real_fp
            self.assertEqual(res['action'], 'issue_updated')
            self.assertEqual(len(api2.comments[88]), 2)

    def test_desensitization_rejects_paths_ips_tokens_signed_params_and_urls(self) -> None:
        # Clean summary passes.
        clean = (
            '## 上游 Canary\n'
            '检查时间：2026-11-25 21:30:00（北京时间）\n'
            'Deno `2.9.8` Player `b485e332` Host `snap.dokitool.com`\n'
            '[查看 Actions 运行](https://github.com/Daiobs/DokiTool-Go/actions/runs/123456)\n'
        )
        self.assertEqual(canary.assert_desensitized(clean), clean)

        mac_path = '/' + 'Users' + '/alice/repo'
        linux_path = '/' + 'home' + '/runner/work'
        win_path = 'C:' + '\\' + 'Users' + '\\alice\\repo'
        file_uri = 'fi' + 'le://' + '/tmp/report.json'
        gemini_path = '.' + 'gemini' + '/antigravity/scratch'
        bearer_str = 'Bea' + 'rer ' + 'secret_tok_123'
        gh_tok = 'ghp' + '_1234567890abcdef'
        ipv4_str = '203' + '.0.113.42'
        ipv6_str = '2001' + ':db8::1'
        signed_url_1 = 'https://rr1.googlevideo.com/videoplayback?sig' + '=abc123'
        signed_param_1 = 'upsig' + '=deadbeef'
        signed_param_2 = 'ticket' + '=relay999'
        signed_param_3 = 'ip' + '=example'

        forbidden_samples = [
            ('mac path', f'failed at {mac_path}'),
            ('linux path', f'failed at {linux_path}'),
            ('win path', f'failed at {win_path}'),
            ('file uri', f'see {file_uri}'),
            ('gemini dir', f'artifact in {gemini_path}'),
            ('bearer', f'header {bearer_str}'),
            ('github token', f'leaked {gh_tok}'),
            ('ipv4', f'origin {ipv4_str} failed'),
            ('ipv6', f'origin [{ipv6_str}] failed'),
            ('non-allowlisted url', signed_url_1),
            ('upsig param', f'query {signed_param_1}'),
            ('ticket param', f'query {signed_param_2}'),
            ('ip param', f'query {signed_param_3}'),
        ]
        for label, sample in forbidden_samples:
            with self.subTest(case=label):
                with self.assertRaises(canary.DesensitizationError):
                    canary.assert_desensitized(sample)

        # Defense-in-depth inside FakeGitHub / GitHub.request: tainted body cannot be posted.
        api = FakeGitHub()
        with self.assertRaises(canary.DesensitizationError):
            api.request('POST', '/repos/' + canary.TARGET + '/issues', {'title': canary.TITLE, 'body': f'leak {ipv4_str}'})

    def test_missing_or_malformed_reports_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            missing = tmp / 'does-not-exist.json'
            malformed = tmp / 'bad.json'
            malformed.write_text('{not valid json', encoding='utf-8')
            inconsistent_deno = tmp / 'inconsistent_deno.json'
            inconsistent_deno.write_text(
                json.dumps(
                    {
                        'player_id': 'b485e332',
                        'tv_ok': False,
                        'main_ok': True,
                        'tv_error_code': 'EJS_N_PROBE_FAILED',
                        'main_error_code': '',
                        'elapsed_ms': 100,
                        'deno_version': '2.9.8',
                        'overall_ok': True,  # Lies: tv_ok is False!
                    }
                ),
                encoding='utf-8',
            )
            missing_group_smoke = tmp / 'missing_group_smoke.json'
            smoke_partial = make_smoke_report()
            smoke_partial['checks'] = [c for c in smoke_partial['checks'] if c['group'] != 'youtube_context']
            missing_group_smoke.write_text(json.dumps(smoke_partial), encoding='utf-8')

            # 1. Missing deno report fails closed
            d_miss = canary.load_deno_report(missing)
            self.assertFalse(d_miss['ok'])
            self.assertEqual(d_miss['report_error'], 'REPORT_MISSING')

            # 2. Malformed deno JSON fails closed
            d_bad = canary.load_deno_report(malformed)
            self.assertFalse(d_bad['ok'])
            self.assertEqual(d_bad['report_error'], 'REPORT_MALFORMED')

            # 3. Inconsistent deno overall_ok fails closed
            d_inc = canary.load_deno_report(inconsistent_deno)
            self.assertFalse(d_inc['ok'])
            self.assertEqual(d_inc['report_error'], 'REPORT_MALFORMED')

            # 4. Missing smoke report fails closed
            s_miss = canary.load_smoke_report(missing)
            self.assertFalse(s_miss['ok'])
            self.assertEqual(s_miss['report_error'], 'REPORT_MISSING')

            # 5. Malformed smoke JSON fails closed
            s_bad = canary.load_smoke_report(malformed)
            self.assertFalse(s_bad['ok'])
            self.assertEqual(s_bad['report_error'], 'REPORT_MALFORMED')

            # 6. Missing required group in smoke report fails closed
            s_grp = canary.load_smoke_report(missing_group_smoke)
            self.assertFalse(s_grp['ok'])
            self.assertEqual(s_grp['failed_checks'][0]['code'], 'MISSING_REQUIRED_GROUP')

            # 7. Non-zero exit code with green report still fails closed
            deno_ok_path, smoke_ok_path = self._write_reports(tmp, make_deno_report(), make_smoke_report())
            d_exit = canary.load_deno_report(deno_ok_path, exit_code=2)
            self.assertFalse(d_exit['ok'])
            self.assertEqual(d_exit['report_error'], 'PROBE_EXIT_2')
            s_exit = canary.load_smoke_report(smoke_ok_path, exit_code=1)
            self.assertFalse(s_exit['ok'])
            self.assertEqual(s_exit['failed_checks'][0]['code'], 'PROBE_EXIT_1')

            # 8. Missing report at streak=2 opens alert Issue with sanitized REPORT_MISSING code (zero paths!)
            api = FakeGitHub()
            res = canary.evaluate_and_apply(
                deno=d_miss,
                smoke=canary.load_smoke_report(smoke_ok_path, exit_code=0),
                api=api,
                now=NOW,
                previous_conclusions=['failure'],
            )
            self.assertFalse(res['overall_ok'])
            self.assertEqual(res['action'], 'issue_created')
            self.assertIn('REPORT_MISSING', api.issues[0]['body'])
            canary.assert_desensitized(api.issues[0]['body'])

    def test_dry_run_never_writes_even_at_streak_2(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            deno_p, smoke_p = self._write_reports(
                Path(td),
                make_deno_report(tv_ok=False, main_ok=True, tv_error_code='FETCH_TIMEOUT'),
                make_smoke_report(),
            )
            api = FakeGitHub(
                workflow_runs=[
                    make_workflow_run(1, 'failure', created_at='2026-11-25T01:30:00Z', event='schedule'),
                ]
            )
            res = canary.evaluate_and_apply(
                deno=canary.load_deno_report(deno_p, exit_code=1),
                smoke=canary.load_smoke_report(smoke_p, exit_code=0),
                api=api,
                dry_run=True,
                now=NOW,
            )
            self.assertFalse(res['overall_ok'])
            self.assertEqual(res['action'], 'dry_run_would_create_issue')
            self.assertEqual(api.writes, [])

    def test_api_url_method_and_environment_security_boundaries(self) -> None:
        self.assertEqual(
            canary.validate_api_url(canary.WORKFLOW_RUNS_PATH),
            'https://api.github.com' + canary.WORKFLOW_RUNS_PATH,
        )
        for bad_url in (
            'http://api.github.com/repos/Daiobs/DokiTool-Go/issues',
            'https://evil.example.com/repos/Daiobs/DokiTool-Go/issues',
            '/repos/Other/Repo/issues',
            '/repos/Daiobs/DokiTool-Go/../Other/issues',
            '/repos/Daiobs/DokiTool-Go/actions/secrets',
            '/repos/Daiobs/DokiTool-Go/issues#frag',
        ):
            with self.subTest(bad_url=bad_url):
                with self.assertRaises(canary.CanaryError):
                    canary.validate_api_url(bad_url)

        gh = canary.GitHub('test-token')
        with self.assertRaises(canary.CanaryError):
            gh.request('DELETE', '/repos/' + canary.TARGET + '/issues/1')
        with self.assertRaises(canary.CanaryError):
            gh.request('PATCH', '/repos/' + canary.TARGET + '/issues/1', {'title': 'hijack'})
        with self.assertRaises(canary.CanaryError):
            gh.request('POST', canary.WORKFLOW_RUNS_PATH, {'body': 'nope'})

        # Environment fork and server guards
        with self.assertRaises(canary.CanaryError):
            canary.environment({'GITHUB_REPOSITORY': 'fork/DokiTool-Go', 'GITHUB_REPOSITORY_OWNER': 'fork'})
        with self.assertRaises(canary.CanaryError):
            canary.environment({'GITHUB_SERVER_URL': 'https://evil.example.com'})
        with self.assertRaises(canary.CanaryError):
            canary.environment({'GITHUB_RUN_ID': '123/../../evil'})

        # Prior streak excludes current_run_id and sorts by created_at newest-first
        runs = [
            make_workflow_run(10, 'success', created_at='2026-11-24T01:30:00Z', run_number=10),
            make_workflow_run(12, 'failure', created_at='2026-11-25T01:30:00Z', run_number=12),
            make_workflow_run(11, 'timed_out', created_at='2026-11-24T13:30:00Z', run_number=11),
            make_workflow_run(13, 'success', created_at='2026-11-25T13:30:00Z', run_number=13),
        ]
        self.assertEqual(canary.count_prior_failure_streak(runs, current_run_id='13'), 2)
        self.assertIn('event=schedule', canary.WORKFLOW_RUNS_PATH)

    def test_cli_full_issue_lifecycle_and_step_summary_desensitization(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            tmp = Path(td)
            summary_file = tmp / 'step_summary.md'
            api = FakeGitHub(
                workflow_runs=[
                    make_workflow_run(50, 'failure', created_at='2026-11-25T01:30:00Z', event='schedule', run_number=50),
                ]
            )

            def run_cli_case(deno_obj, smoke_obj, deno_rc: int, smoke_rc: int):
                summary_file.write_text('', encoding='utf-8')
                deno_p, smoke_p = self._write_reports(tmp, deno_obj, smoke_obj)
                out_buf = io.StringIO()
                err_buf = io.StringIO()
                env = {
                    'GITHUB_TOKEN': 'fake-test-value',
                    'GITHUB_REPOSITORY': canary.TARGET,
                    'GITHUB_REPOSITORY_OWNER': canary.OWNER,
                    'GITHUB_RUN_ID': '45643359936',
                    'GITHUB_STEP_SUMMARY': str(summary_file),
                }
                with patch.dict(os.environ, env, clear=True), patch.object(
                    canary, 'GitHub', return_value=api
                ), patch('sys.stdout', out_buf), patch('sys.stderr', err_buf):
                    rc = canary.cli(
                        [
                            '--deno-report',
                            str(deno_p),
                            '--smoke-report',
                            str(smoke_p),
                            '--deno-exit-code',
                            str(deno_rc),
                            '--smoke-exit-code',
                            str(smoke_rc),
                        ]
                    )
                self.assertEqual(err_buf.getvalue(), '')
                payload = json.loads(out_buf.getvalue())
                summary_text = summary_file.read_text(encoding='utf-8')
                return rc, payload, summary_text

            # 1. streak=2 -> issue_created (rc=1, step summary includes allowlisted Issue URL)
            rc1, res1, sum1 = run_cli_case(
                make_deno_report(tv_ok=True, main_ok=False, main_error_code='EJS_N_PROBE_FAILED'),
                make_smoke_report(),
                1,
                0,
            )
            self.assertEqual(rc1, 1)
            self.assertEqual(res1['action'], 'issue_created')
            self.assertEqual(res1['issue_url'], 'https://github.com/Daiobs/DokiTool-Go/issues/100')
            self.assertIn('[告警 Issue](https://github.com/Daiobs/DokiTool-Go/issues/100)', sum1)

            # 2. Same failure while open -> deduplicated (rc=1, step summary keeps Issue URL)
            rc2, res2, sum2 = run_cli_case(
                make_deno_report(tv_ok=True, main_ok=False, main_error_code='EJS_N_PROBE_FAILED', elapsed_ms=2500),
                make_smoke_report(),
                1,
                0,
            )
            self.assertEqual(rc2, 1)
            self.assertEqual(res2['action'], 'deduplicated')
            self.assertEqual(res2['issue_url'], 'https://github.com/Daiobs/DokiTool-Go/issues/100')
            self.assertIn('[告警 Issue](https://github.com/Daiobs/DokiTool-Go/issues/100)', sum2)

            # 3. Changed failure fingerprint -> issue_updated (rc=1)
            rc3, res3, sum3 = run_cli_case(
                make_deno_report(
                    tv_ok=False,
                    main_ok=False,
                    tv_error_code='EJS_N_PROBE_FAILED',
                    main_error_code='EJS_N_PROBE_FAILED',
                ),
                make_smoke_report(),
                1,
                0,
            )
            self.assertEqual(rc3, 1)
            self.assertEqual(res3['action'], 'issue_updated')
            self.assertIn('[告警 Issue](https://github.com/Daiobs/DokiTool-Go/issues/100)', sum3)

            # 4. Recovery -> issue_closed (rc=0, step summary links the closed Issue)
            rc4, res4, sum4 = run_cli_case(make_deno_report(), make_smoke_report(), 0, 0)
            self.assertEqual(rc4, 0)
            self.assertEqual(res4['action'], 'issue_closed')
            self.assertEqual(res4['issue_url'], 'https://github.com/Daiobs/DokiTool-Go/issues/100')
            self.assertIn('[告警 Issue](https://github.com/Daiobs/DokiTool-Go/issues/100)', sum4)

            # 5. Post-close healthy run -> healthy_noop (rc=0, NO historical [告警 Issue] link!)
            rc5, res5, sum5 = run_cli_case(make_deno_report(), make_smoke_report(), 0, 0)
            self.assertEqual(rc5, 0)
            self.assertEqual(res5['action'], 'healthy_noop')
            self.assertIsNone(res5['issue_url'])
            self.assertNotIn('[告警 Issue]', sum5)

    def test_desensitization_allows_validated_base64_markers_with_tricky_substrings(self) -> None:
        valid_state = {
            'schema': 1,
            'status': 'failing',
            'fingerprint': '0123456789abcdef',
            'consecutive_failures': 2,
            'observed_at': '2026-11-25T13:30:00+00:00',
            'player_id': 'b485e332',
            'deno_status': 'degraded_main_only',
            'smoke_ok': True,
        }
        # Simulate base64 state markers ending in +ip= / /key= / /sig= that would trip
        # _SIGNED_PARAM_RE if scanned raw, while still validating the marker via extract_state.
        for suffix in ('+ip=', '/key=', '+sig='):
            synthetic_marker = canary.MARKER + 'AAAA' + suffix + ' -->'
            body = '## 上游 Canary 告警\n\n状态正常校验\n\n' + synthetic_marker
            with self.subTest(suffix=suffix):
                with patch.object(canary, 'extract_state', return_value=valid_state) as mock_extract:
                    self.assertEqual(canary.assert_desensitized(body), body)
                    mock_extract.assert_called_once_with(body)

                # Raw signed param outside the validated marker MUST still fail closed!
                tainted_body = body + '\nleaked ip' + '=example'
                with patch.object(canary, 'extract_state', return_value=valid_state):
                    with self.assertRaises(canary.DesensitizationError):
                        canary.assert_desensitized(tainted_body)

        # Malformed or duplicated marker without valid state MUST fail closed!
        with self.assertRaises(canary.DesensitizationError):
            canary.assert_desensitized('## Bad\n' + canary.MARKER + 'not-valid-base64!!! -->')
        real_marker = canary.state_marker(valid_state)
        with self.assertRaises(canary.DesensitizationError):
            canary.assert_desensitized('## Dup\n' + real_marker + '\n' + real_marker)

        # Allowlisted Issue URL passes; non-allowlisted Issue URL (wrong repo/query) fails!
        self.assertEqual(
            canary.assert_desensitized('[告警 Issue](https://github.com/Daiobs/DokiTool-Go/issues/61)'),
            '[告警 Issue](https://github.com/Daiobs/DokiTool-Go/issues/61)',
        )
        with self.assertRaises(canary.DesensitizationError):
            canary.assert_desensitized('[Bad](https://github.com/Daiobs/DokiTool-Go/issues/61?token=abc)')
        with self.assertRaises(canary.DesensitizationError):
            canary.assert_desensitized('[Bad](https://github.com/Other/Repo/issues/61)')


if __name__ == '__main__':
    unittest.main()
