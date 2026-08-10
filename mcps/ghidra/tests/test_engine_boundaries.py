# ── Ghidra Engine Filesystem Boundary Tests ──────────────────────
# Verifies that binary imports remain inside the read-only engagement workarea
# and that project metadata stays in a separate host-owned store.
# → mcps/ghidra/ghidra_engine.py — enforces the tested containment boundary.
# @docs/runtimes/ghidra.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_ROOT))

from ghidra_engine import GhidraEngine, InputError  # noqa: E402


class FakeAddress:
    def __init__(self, value: str) -> None:
        self.value = value

    def __str__(self) -> str:
        return self.value


class FakeFunction:
    def __init__(self, name: str, entry: str, signature: str) -> None:
        self.name = name
        self.entry = FakeAddress(entry)
        self.signature = signature

    def getName(self, qualified: bool = False) -> str:
        return f"scope::{self.name}" if qualified else self.name

    def getEntryPoint(self) -> FakeAddress:
        return self.entry

    def getSignature(self) -> str:
        return self.signature


class FakeFunctionManager:
    def __init__(self, functions: list[FakeFunction]) -> None:
        self.functions = functions

    def getFunctions(self, _forward: bool) -> list[FakeFunction]:
        return self.functions


class FakeProgram:
    def __init__(self, functions: list[FakeFunction]) -> None:
        self.manager = FakeFunctionManager(functions)

    def getFunctionManager(self) -> FakeFunctionManager:
        return self.manager


class EngineBoundaryTests(unittest.TestCase):
    def test_accepts_plain_workarea_files_and_rejects_escapes_and_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / "store"
            workarea = root / "workarea"
            install = root / "ghidra"
            store.mkdir()
            workarea.mkdir()
            install.mkdir()
            fixture = workarea / "fixture.bin"
            fixture.write_bytes(b"\x7fELFfixture")
            outside = root / "outside.bin"
            outside.write_bytes(b"outside")
            (workarea / "link.bin").symlink_to(outside)
            engine = GhidraEngine(store, workarea, install)

            self.assertEqual(engine.resolve_source("fixture.bin"), fixture.resolve())
            with self.assertRaises(InputError):
                engine.resolve_source("../outside.bin")
            with self.assertRaises(InputError):
                engine.resolve_source("link.bin")
            with self.assertRaises(InputError):
                engine.resolve_source(str(fixture))

    def test_project_status_does_not_retain_the_serialization_lock(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for child in ["store", "workarea", "ghidra"]:
                (root / child).mkdir()
            engine = GhidraEngine(root / "store", root / "workarea", root / "ghidra")
            self.assertFalse(engine.project_status()["busy"])
            with engine.exclusive():
                self.assertFalse(engine.project_status()["busy"])
            with engine.exclusive():
                pass

    def test_function_selector_accepts_signatures_and_never_guesses_duplicate_names(self) -> None:
        engine = object.__new__(GhidraEngine)
        first = FakeFunction("parse", "00401000", "int parse(char *)")
        second = FakeFunction("parse", "00402000", "int parse(bytes *)")
        program = FakeProgram([first, second])

        resolved, _address, canonical = engine._resolve_selector(program, "int parse(bytes *)", True)
        self.assertIs(resolved, second)
        self.assertEqual(canonical, "00402000")
        with self.assertRaisesRegex(InputError, "ambiguous") as context:
            engine._resolve_selector(program, "parse", True)
        self.assertIn("00401000", str(context.exception))
        self.assertIn("00402000", str(context.exception))


if __name__ == "__main__":
    unittest.main()
