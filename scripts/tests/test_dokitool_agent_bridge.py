"""Bridge unittest discovery from scripts/tests into tools/dokitool-agent/tests.

Allows CI workflows running `python3 -m unittest discover -s scripts/tests -p 'test_*.py'`
to automatically execute the offline `tools/dokitool-agent` test suite without
mutating global `sys.path` permanently or writing bytecode into `tools/`.
"""
from __future__ import annotations

from pathlib import Path
import sys
import unittest

REPO_ROOT = Path(__file__).resolve().parents[2]
AGENT_DIR = REPO_ROOT / "tools" / "dokitool-agent"
AGENT_TESTS_DIR = AGENT_DIR / "tests"
MIN_DISCOVERED_AGENT_TESTS = 19

_LAST_LOAD_TESTS_AGENT_COUNT: int | None = None


def _iter_test_cases(suite: unittest.TestSuite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _iter_test_cases(item)
        else:
            yield item


def _discover_agent_tests() -> unittest.TestSuite:
    saved_sys_path = list(sys.path)
    saved_dont_write_bytecode = sys.dont_write_bytecode
    agent_dir_str = str(AGENT_DIR)
    try:
        sys.dont_write_bytecode = True
        if agent_dir_str not in sys.path:
            sys.path.insert(0, agent_dir_str)
        bridge_loader = unittest.TestLoader()
        return bridge_loader.discover(
            start_dir=str(AGENT_TESTS_DIR),
            pattern="test_*.py",
            top_level_dir=str(AGENT_TESTS_DIR),
        )
    finally:
        sys.path[:] = saved_sys_path
        sys.dont_write_bytecode = saved_dont_write_bytecode


class TestDokiToolAgentBridgeDiscovery(unittest.TestCase):
    """Guard against silent 0-test green runs when agent tests move or fail import."""

    def test_discovers_minimum_agent_test_count(self) -> None:
        self.assertTrue(
            AGENT_TESTS_DIR.is_dir(),
            msg=f"expected agent test directory at {AGENT_TESTS_DIR}",
        )
        discovered = _discover_agent_tests()
        failed_imports = [
            test.id()
            for test in _iter_test_cases(discovered)
            if type(test).__name__ in ("_FailedTest", "ModuleImportFailure")
        ]
        self.assertEqual(
            failed_imports,
            [],
            msg=f"agent test discovery hit import failures: {failed_imports}",
        )
        discovered_count = discovered.countTestCases()
        self.assertGreaterEqual(
            discovered_count,
            MIN_DISCOVERED_AGENT_TESTS,
            msg=(
                f"expected at least {MIN_DISCOVERED_AGENT_TESTS} discovered tests under "
                f"{AGENT_TESTS_DIR}, found {discovered_count}"
            ),
        )
        if _LAST_LOAD_TESTS_AGENT_COUNT is not None:
            self.assertGreaterEqual(
                _LAST_LOAD_TESTS_AGENT_COUNT,
                MIN_DISCOVERED_AGENT_TESTS,
                msg=(
                    f"load_tests mounted {_LAST_LOAD_TESTS_AGENT_COUNT} agent tests "
                    f"(minimum required: {MIN_DISCOVERED_AGENT_TESTS})"
                ),
            )


def load_tests(
    loader: unittest.TestLoader,
    standard_tests: unittest.TestSuite,
    pattern: str | None,
) -> unittest.TestSuite:
    global _LAST_LOAD_TESTS_AGENT_COUNT
    del loader, pattern
    suite = unittest.TestSuite()
    suite.addTests(standard_tests)

    if not AGENT_TESTS_DIR.is_dir():
        _LAST_LOAD_TESTS_AGENT_COUNT = 0
        return suite

    discovered = _discover_agent_tests()
    _LAST_LOAD_TESTS_AGENT_COUNT = discovered.countTestCases()
    suite.addTests(discovered)
    return suite
