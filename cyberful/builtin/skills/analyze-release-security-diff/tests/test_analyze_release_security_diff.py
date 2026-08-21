# ── Release Security Diff Tests ─────────────────────────────
# Covers deterministic artifact deltas, strict schema and path confinement,
#   output and deadline boundaries, collision safety, and post-fsync refusal.
# → cyberful/builtin/skills/analyze-release-security-diff/scripts/analyze_release_security_diff.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from types import ModuleType
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analyze_release_security_diff.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("analyze_release_security_diff", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load release diff")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def artifact(path: str, digest: str, *, signer: str | None = "release@example.test") -> dict[str, object]:
    return {"path": path, "sha256": digest, "provenance_sha256": None, "signer": signer, "permissions": ["read"], "dependencies": []}


def request(baseline: str = "baseline.json", candidate: str = "candidate.json") -> dict[str, str]:
    return {"$schema": "assets/release-security-diff-input.schema.json", "baseline": baseline, "candidate": candidate}


class ReleaseSecurityDiffTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _releases(self, workspace: Path) -> None:
        before = {"release_id": "1.0", "source_revision": "aaa", "artifacts": [artifact("app", "a" * 64), artifact("removed", "b" * 64)]}
        after = {"release_id": "1.1", "source_revision": "bbb", "artifacts": [artifact("app", "c" * 64), artifact("added", "d" * 64)]}
        (workspace / "baseline.json").write_text(json.dumps(before))
        (workspace / "candidate.json").write_text(json.dumps(after))

    def test_deterministic_artifact_diff(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            self._releases(workspace)
            first = self.module.run_diff(request(), "c" * 64, workspace, deadline=time.monotonic() + 2)
            second = self.module.run_diff(request(), "c" * 64, workspace, deadline=time.monotonic() + 2)
        self.assertEqual(first, second)
        self.assertEqual([(row["path"], row["change"]) for row in first["changes"]], [("added", "added"), ("app", "changed"), ("removed", "removed")])
        self.assertEqual(first["changes"][1]["fields"], ["sha256"])

    def test_schema_same_file_and_symlink_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            self._releases(workspace)
            malformed = request()
            malformed["$schema"] = "wrong"
            with self.assertRaisesRegex(self.module.DiffError, "schema"):
                self.module.run_diff(malformed, "c" * 64, workspace, deadline=time.monotonic() + 2)
            with self.assertRaisesRegex(self.module.DiffError, "distinct"):
                self.module.run_diff(request("baseline.json", "baseline.json"), "c" * 64, workspace, deadline=time.monotonic() + 2)
            (workspace / "link.json").symlink_to(workspace / "baseline.json")
            with self.assertRaisesRegex(self.module.DiffError, "symbolic"):
                self.module.run_diff(request("link.json"), "c" * 64, workspace, deadline=time.monotonic() + 2)
            (workspace / "alias.json").hardlink_to(workspace / "baseline.json")
            with self.assertRaisesRegex(self.module.DiffError, "inode-distinct"):
                self.module.run_diff(request("baseline.json", "alias.json"), "c" * 64, workspace, deadline=time.monotonic() + 2)

    def test_output_deadline_collision_and_writer_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            self._releases(workspace)
            with self.assertRaisesRegex(self.module.DiffError, "output boundary"):
                self.module.run_diff(request(), "c" * 64, workspace, deadline=time.monotonic() + 2, output_limit=1)
            with self.assertRaisesRegex(self.module.DiffError, "deadline"):
                self.module.run_diff(request(), "c" * 64, workspace, deadline=time.monotonic() - 1)
            source = workspace / "input.json"
            original = json.dumps(request()).encode()
            source.write_bytes(original)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "input.json"]), 2)
            self.assertEqual(source.read_bytes(), original)
            destination = workspace / "evidence.json"
            with patch.object(self.module.time, "monotonic", side_effect=[0.0, 2.0]):
                with self.assertRaisesRegex(self.module.DiffError, "deadline"):
                    self.module._write(destination, {"value": "bounded"}, 1.0)
            self.assertFalse(destination.exists())

    def test_concurrent_destination_is_preserved_by_atomic_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "evidence.json"
            sentinel = b"concurrent-owner\n"
            real_link = os.link

            def racing_link(source: str, target: str, **options: object) -> None:
                destination.write_bytes(sentinel)
                real_link(source, target, **options)

            with patch.object(self.module.os, "link", side_effect=racing_link):
                with self.assertRaisesRegex(self.module.DiffError, "appeared"):
                    self.module._write(destination, {"value": "bounded"}, time.monotonic() + 2)
            self.assertEqual(destination.read_bytes(), sentinel)


if __name__ == "__main__":
    unittest.main()
