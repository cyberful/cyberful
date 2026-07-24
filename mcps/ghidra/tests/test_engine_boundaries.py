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


if __name__ == "__main__":
    unittest.main()
