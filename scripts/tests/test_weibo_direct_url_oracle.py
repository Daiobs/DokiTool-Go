import copy
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
GO_MIGRATION_DIR = ROOT / "scripts" / "go-migration"
if str(GO_MIGRATION_DIR) not in sys.path:
    sys.path.insert(0, str(GO_MIGRATION_DIR))


def _load_check_module():
    spec = importlib.util.spec_from_file_location("dokitool_go_migration_check", GO_MIGRATION_DIR / "check.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CHECK = _load_check_module()
WEIBO_BASELINE = CHECK.read_json(CHECK.WEIBO)


def _sample_ok_case():
    for case in WEIBO_BASELINE["cases"]:
        if case["expected"]["normal"].get("code") == "OK":
            return case
    raise AssertionError("No OK case found in Weibo signed baseline")


def _inject_matching_direct_urls(envelope, case):
    clone = copy.deepcopy(envelope)
    verifier = CHECK._weibo_signed_verifier()
    given = case["input"]
    legacy_data = case["expected"]["legacy_response"]["data"]
    raw_urls = {entry["url"] for entry in legacy_data["video_backup"]}
    for item in clone["data"]["items"]:
        for variant in item["variants"]:
            for source in variant["delivery"]["sources"]:
                if source.get("access") == "relay" and source.get("url", "").startswith("/api/media/weibo?ticket="):
                    source["direct_url"] = verifier.checked_ticket(source, raw_urls, given["key"], given["now"])
    return clone


class WeiboDirectURLOracleTests(unittest.TestCase):
    def test_valid_direct_url_verified_and_stripped_without_mutating_input(self):
        case = _sample_ok_case()
        observed = _inject_matching_direct_urls(case["expected"]["normal"], case)
        snapshot = copy.deepcopy(observed)

        stripped, count = CHECK.verify_and_strip_weibo_direct_urls(observed, case, "normal")
        self.assertGreater(count, 0)
        self.assertTrue(CHECK.same_json(case["expected"]["normal"], stripped))
        self.assertTrue(CHECK.same_json(snapshot, observed), "original export must remain unmutated")

    def test_missing_direct_url_on_relay_source_is_rejected(self):
        case = _sample_ok_case()
        observed = copy.deepcopy(case["expected"]["normal"])
        with self.assertRaisesRegex(ValueError, "direct_url mismatch"):
            CHECK.verify_and_strip_weibo_direct_urls(observed, case, "normal")

    def test_mismatched_direct_url_against_ticket_is_rejected(self):
        case = _sample_ok_case()
        observed = _inject_matching_direct_urls(case["expected"]["normal"], case)
        observed["data"]["items"][0]["variants"][0]["delivery"]["sources"][0]["direct_url"] = (
            "https://f.video.weibocdn.com/tampered.mp4"
        )
        with self.assertRaisesRegex(ValueError, "direct_url mismatch"):
            CHECK.verify_and_strip_weibo_direct_urls(observed, case, "normal")

    def test_default_carrying_direct_url_is_rejected(self):
        case = _sample_ok_case()
        observed = _inject_matching_direct_urls(case["expected"]["normal"], case)
        observed["data"]["items"][0]["default"]["direct_url"] = "https://f.video.weibocdn.com/leaked.mp4"
        with self.assertRaisesRegex(ValueError, "item.default must not carry direct_url"):
            CHECK.verify_and_strip_weibo_direct_urls(observed, case, "normal")

    def test_non_relay_source_carrying_direct_url_is_rejected(self):
        case = _sample_ok_case()
        observed = _inject_matching_direct_urls(case["expected"]["normal"], case)
        observed["data"]["items"][0]["variants"][0]["delivery"]["sources"].append(
            {
                "id": "s-unavailable-test",
                "url": "https://evil.example.com/blocked.mp4",
                "availability": "unavailable",
                "direct_url": "https://f.video.weibocdn.com/should-not-exist.mp4",
            }
        )
        with self.assertRaisesRegex(ValueError, "Non-relay Weibo source"):
            CHECK.verify_and_strip_weibo_direct_urls(observed, case, "normal")

    def test_bad_ticket_signature_is_rejected(self):
        case = _sample_ok_case()
        observed = _inject_matching_direct_urls(case["expected"]["normal"], case)
        tampered_case = copy.deepcopy(case)
        tampered_case["input"]["key"] = "z" * 64
        with self.assertRaisesRegex(ValueError, "Ticket HMAC"):
            CHECK.verify_and_strip_weibo_direct_urls(observed, tampered_case, "normal")

    def test_verify_platform_exports_passes_and_catches_undeclared_diff(self):
        cases = []
        for case in WEIBO_BASELINE["cases"]:
            entry = {"id": case["id"]}
            for view in ("normal", "debug"):
                env = case["expected"][view]
                entry[view] = _inject_matching_direct_urls(env, case) if env.get("code") == "OK" else copy.deepcopy(env)
            cases.append(entry)

        with tempfile.TemporaryDirectory() as tmpdir:
            good_path = pathlib.Path(tmpdir) / "good.json"
            good_path.write_text(json.dumps({"cases": cases}, ensure_ascii=False), encoding="utf-8")
            result = CHECK.verify_platform_exports(good_path, CHECK.WEIBO, "weibo")
            self.assertTrue(result["passed"])
            self.assertEqual(result["cases"], len(WEIBO_BASELINE["cases"]))
            self.assertEqual(result["declared_differences"], 0)
            self.assertGreater(result["verified_direct_urls"], 0)

            bad_cases = copy.deepcopy(cases)
            for entry in bad_cases:
                if entry["normal"].get("code") == "OK":
                    entry["normal"]["data"]["title"] = "undeclared drift"
                    break
            bad_path = pathlib.Path(tmpdir) / "bad.json"
            bad_path.write_text(json.dumps({"cases": bad_cases}, ensure_ascii=False), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Undeclared weibo public response difference"):
                CHECK.verify_platform_exports(bad_path, CHECK.WEIBO, "weibo")


if __name__ == "__main__":
    unittest.main()
