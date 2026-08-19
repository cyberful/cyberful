# ── Secret Propagation Trace Tests ──────────────────────────
# Covers deterministic digest matching, secret-free evidence, path confinement,
#   strict schema, collision safety, output caps, and end-to-end deadlines.
# → cyberful/builtin/skills/trace-secret-propagation/scripts/trace_secret_propagation.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import hashlib
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
SCRIPT = ROOT / "scripts" / "trace_secret_propagation.py"
SECRET = "synthetic-secret-value"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("trace_secret_propagation", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load secret trace")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


def request(path: str = "snapshot.json") -> dict[str, object]:
    return {
        "$schema": "assets/secret-propagation-input.schema.json",
        "artifacts": [{"id": "artifact-a", "path": path, "system": "service-a", "captured_at": "2026-08-18T00:00:00Z"}],
        "markers": [{
            "id": "marker-a", "sha256": hashlib.sha256(SECRET.encode()).hexdigest(),
            "allowed_locations": [{"artifact_id": "artifact-a", "pointer_prefix": "/allowed"}],
        }],
    }


class SecretPropagationTraceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_deterministic_trace_preserves_only_digest_and_pointer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "snapshot.json").write_text(json.dumps({"allowed": SECRET, "unexpected": [SECRET]}))
            document = request()
            first = self.module.run_trace(document, "a" * 64, workspace, deadline=time.monotonic() + 2)
            second = self.module.run_trace(document, "a" * 64, workspace, deadline=time.monotonic() + 2)
        self.assertEqual(first, second)
        self.assertEqual(first["counts"]["unexpected"], 1)
        self.assertEqual([entry["pointer"] for entry in first["occurrences"]], ["/allowed", "/unexpected/0"])
        self.assertNotIn(SECRET, json.dumps(first))

    def test_invalid_schema_and_symlink_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            outside = workspace / "outside.json"
            outside.write_text("{}")
            link = workspace / "link.json"
            link.symlink_to(outside)
            malformed = request()
            malformed["$schema"] = "https://example.invalid/schema"
            with self.assertRaisesRegex(self.module.TraceError, "schema"):
                self.module.run_trace(malformed, "a" * 64, workspace, deadline=time.monotonic() + 2)
            with self.assertRaisesRegex(self.module.TraceError, "symbolic"):
                self.module.run_trace(request("link.json"), "a" * 64, workspace, deadline=time.monotonic() + 2)

    def test_output_boundary_and_expired_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "snapshot.json").write_text(json.dumps({"value": SECRET}))
            with self.assertRaisesRegex(self.module.TraceError, "output boundary"):
                self.module.run_trace(request(), "a" * 64, workspace, deadline=time.monotonic() + 2, output_limit=1)
            with self.assertRaisesRegex(self.module.TraceError, "deadline"):
                self.module.run_trace(request(), "a" * 64, workspace, deadline=time.monotonic() - 1)

    def test_every_json_node_is_iteratively_bounded_and_hardlink_aliases_refuse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "snapshot.json").write_text(json.dumps({"values": list(range(20))}))
            with patch.object(self.module, "MAX_NODES", 10):
                with self.assertRaisesRegex(self.module.TraceError, "node count"):
                    self.module.run_trace(request(), "a" * 64, workspace, deadline=time.monotonic() + 2)
            alias = workspace / "alias.json"
            alias.hardlink_to(workspace / "snapshot.json")
            document = request()
            document["artifacts"].append({"id": "artifact-b", "path": "alias.json", "system": "service-b", "captured_at": "2026-08-18T01:00:00Z"})
            with self.assertRaisesRegex(self.module.TraceError, "inode-distinct"):
                self.module.run_trace(document, "a" * 64, workspace, deadline=time.monotonic() + 2)

    def test_canonical_collision_preserves_input_and_writer_checks_after_fsync(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "snapshot.json").write_text(json.dumps({"value": SECRET}))
            source = workspace / "input.json"
            original = json.dumps(request()).encode()
            source.write_bytes(original)
            result = self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "input.json"])
            self.assertEqual(result, 2)
            self.assertEqual(source.read_bytes(), original)
            destination = workspace / "evidence.json"
            with patch.object(self.module.time, "monotonic", side_effect=[0.0, 2.0]):
                with self.assertRaisesRegex(self.module.TraceError, "deadline"):
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
                with self.assertRaisesRegex(self.module.TraceError, "appeared"):
                    self.module._write(destination, {"value": "bounded"}, time.monotonic() + 2)
            self.assertEqual(destination.read_bytes(), sentinel)


if __name__ == "__main__":
    unittest.main()
