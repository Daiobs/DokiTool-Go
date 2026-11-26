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


def load_tests(
    loader: unittest.TestLoader,
    standard_tests: unittest.TestSuite,
    pattern: str | None,
) -> unittest.TestSuite:
    del loader, pattern
    suite = unittest.TestSuite()
    suite.addTests(standard_tests)

    if not AGENT_TESTS_DIR.is_dir():
        return suite

    saved_sys_path = list(sys.path)
    saved_dont_write_bytecode = sys.dont_write_bytecode
    agent_dir_str = str(AGENT_DIR)
    try:
        sys.dont_write_bytecode = True
        if agent_dir_str not in sys.path:
            sys.path.insert(0, agent_dir_str)
        bridge_loader = unittest.TestLoader()
        discovered = bridge_loader.discover(
            start_dir=str(AGENT_TESTS_DIR),
            pattern="test_*.py",
            top_level_dir=str(AGENT_TESTS_DIR),
        )
        suite.addTests(discovered)
    finally:
        sys.path[:] = saved_sys_path
        sys.dont_write_bytecode = saved_dont_write_bytecode

    return suite
