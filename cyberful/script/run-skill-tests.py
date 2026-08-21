#!/usr/bin/env python3
# ── Built-in Skill Test Runner ───────────────────────────────────
# Runs every first-party skill test file in an isolated subprocess so package
# names containing hyphens never depend on Python package import semantics.
# → cyberful/builtin/skills — owns the scripts and synthetic fixtures under test.
# → Makefile — includes this runner in the repository Python gate.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
import os
import signal
import subprocess
import sys
import unittest
from pathlib import Path


def _suite(test_file: Path) -> unittest.TestSuite:
    module_name = f"cyberful_skill_test_{test_file.parent.parent.name.replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, test_file)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {test_file}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return unittest.defaultTestLoader.loadTestsFromModule(module)


def _test_count(test_file: Path) -> int:
    return _suite(test_file).countTestCases()


def _run_one(test_file: Path) -> int:
    result = unittest.TextTestRunner(verbosity=2).run(_suite(test_file))
    return 0 if result.wasSuccessful() else 1


def _expected_tests(skill_root: Path) -> set[Path]:
    expected: set[Path] = set()
    for manifest_file in sorted(skill_root.glob("*/scripts/manifest.json")):
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        entrypoint = manifest.get("entrypoint")
        if not isinstance(entrypoint, str) or not entrypoint.endswith(".py"):
            raise RuntimeError(f"{manifest_file} must declare one Python entrypoint")
        expected.add(manifest_file.parents[1] / "tests" / f"test_{Path(entrypoint).stem}.py")
    return expected


def _run(test_file: Path, timeout_seconds: int) -> str | None:
    process = subprocess.Popen(
        [sys.executable, "-B", str(Path(__file__).resolve()), "--run-one", str(test_file)],
        cwd=test_file.parents[1],
        start_new_session=True,
    )
    try:
        return None if process.wait(timeout=timeout_seconds) == 0 else f"exit {process.returncode}"
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=2)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        return f"timeout after {timeout_seconds}s"


def main() -> int:
    sys.dont_write_bytecode = True
    skill_root = Path(__file__).resolve().parents[1] / "builtin" / "skills"
    tests = sorted(skill_root.glob("*/tests/test_*.py"))
    discovered = set(tests)
    expected = _expected_tests(skill_root)
    missing = sorted(expected - discovered)
    if missing:
        print("Missing built-in skill tests:", file=sys.stderr)
        for test_file in missing:
            print(f"- {test_file.relative_to(skill_root)}", file=sys.stderr)
        return 1
    if not tests:
        print("No built-in skill tests were discovered.", file=sys.stderr)
        return 1

    failures: list[tuple[Path, str]] = []
    for test_file in tests:
        count = _test_count(test_file)
        if count == 0:
            failures.append((test_file, "contains zero unittest cases"))
            continue
        failure = _run(test_file, 180)
        if failure:
            failures.append((test_file, failure))
    if failures:
        print("Failed built-in skill tests:", file=sys.stderr)
        for test_file, reason in failures:
            print(f"- {test_file.relative_to(skill_root)}: {reason}", file=sys.stderr)
        return 1
    print(f"Passed {len(tests)} built-in skill test files.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--run-one":
        raise SystemExit(_run_one(Path(sys.argv[2]).resolve(strict=True)))
    raise SystemExit(main())
