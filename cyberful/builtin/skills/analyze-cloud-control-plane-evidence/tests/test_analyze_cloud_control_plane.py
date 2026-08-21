# ── Cloud Control-Plane Analyzer Tests ──────────────────────
# Covers normalized drift, determinism, strict input and path confinement,
#   output limits, global deadlines, collision safety, and post-fsync checks.
# → cyberful/builtin/skills/analyze-cloud-control-plane-evidence/scripts/analyze_cloud_control_plane.py — implementation.
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
SCRIPT = ROOT / "scripts" / "analyze_cloud_control_plane.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("analyze_cloud_control_plane", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load cloud analyzer")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def resource(identifier: str, *, public: bool = False) -> dict[str, object]:
    return {"id": identifier, "kind": "bucket", "region": "eu-west-1", "public": public, "principals": [], "policy_sha256": None, "encrypted": True, "logging": True, "lifecycle": "active"}


def request(before: str = "before.json", after: str = "after.json") -> dict[str, object]:
    return {
        "$schema": "assets/cloud-control-plane-input.schema.json",
        "snapshots": [
            {"id": "before", "path": before, "provider": "aws", "account": "111", "captured_at": "2026-08-18T10:00:00Z"},
            {"id": "after", "path": after, "provider": "aws", "account": "111", "captured_at": "2026-08-18T11:00:00Z"},
        ],
    }


class CloudControlPlaneTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _snapshots(self, workspace: Path) -> None:
        (workspace / "before.json").write_text(json.dumps({"resources": [resource("a"), resource("removed")]}))
        (workspace / "after.json").write_text(json.dumps({"resources": [resource("a", public=True), resource("added")]}))

    def test_deterministic_added_removed_and_changed_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            self._snapshots(workspace)
            first = self.module.analyze(request(), "b" * 64, workspace, deadline=time.monotonic() + 2)
            second = self.module.analyze(request(), "b" * 64, workspace, deadline=time.monotonic() + 2)
        self.assertEqual(first, second)
        self.assertEqual([(row["resource_id"], row["change"]) for row in first["transitions"]], [("a", "changed"), ("added", "added"), ("removed", "removed")])
        self.assertEqual(first["transitions"][0]["fields"], ["public"])

    def test_schema_identity_sequence_and_symlink_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            self._snapshots(workspace)
            malformed = request()
            malformed["$schema"] = "wrong"
            with self.assertRaisesRegex(self.module.AnalysisError, "schema"):
                self.module.analyze(malformed, "b" * 64, workspace, deadline=time.monotonic() + 2)
            identity = request()
            identity["snapshots"][1]["account"] = "222"
            with self.assertRaisesRegex(self.module.AnalysisError, "provider and account"):
                self.module.analyze(identity, "b" * 64, workspace, deadline=time.monotonic() + 2)
            (workspace / "link.json").symlink_to(workspace / "before.json")
            with self.assertRaisesRegex(self.module.AnalysisError, "symbolic"):
                self.module.analyze(request("link.json"), "b" * 64, workspace, deadline=time.monotonic() + 2)
            (workspace / "alias.json").hardlink_to(workspace / "before.json")
            with self.assertRaisesRegex(self.module.AnalysisError, "inode-distinct"):
                self.module.analyze(request("before.json", "alias.json"), "b" * 64, workspace, deadline=time.monotonic() + 2)

    def test_output_limit_deadline_and_collision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            self._snapshots(workspace)
            with self.assertRaisesRegex(self.module.AnalysisError, "output boundary"):
                self.module.analyze(request(), "b" * 64, workspace, deadline=time.monotonic() + 2, output_limit=1)
            with self.assertRaisesRegex(self.module.AnalysisError, "deadline"):
                self.module.analyze(request(), "b" * 64, workspace, deadline=time.monotonic() - 1)
            source = workspace / "input.json"
            original = json.dumps(request()).encode()
            source.write_bytes(original)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "input.json"]), 2)
            self.assertEqual(source.read_bytes(), original)
            destination = workspace / "evidence.json"
            with patch.object(self.module.time, "monotonic", side_effect=[0.0, 2.0]):
                with self.assertRaisesRegex(self.module.AnalysisError, "deadline"):
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
                with self.assertRaisesRegex(self.module.AnalysisError, "appeared"):
                    self.module._write(destination, {"value": "bounded"}, time.monotonic() + 2)
            self.assertEqual(destination.read_bytes(), sentinel)


if __name__ == "__main__":
    unittest.main()
