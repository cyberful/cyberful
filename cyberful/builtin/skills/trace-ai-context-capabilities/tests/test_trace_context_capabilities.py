# ── Context-Capability Trace Tests ───────────────────────────────
# Exercises deterministic edges, typed gaps, and invalid graph rejection.
# → cyberful/builtin/skills/trace-ai-context-capabilities/scripts/trace_context_capabilities.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from types import ModuleType


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "trace_context_capabilities.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("context_trace", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load context trace")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ContextTraceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_builds_deterministic_edges(self) -> None:
        payload = {"scope_id": "scope", "events": [{"id": "a", "type": "retrieval", "actor": "user", "tenant": "one", "parents": [], "edge": "retrieved_from", "payload_ref": "a.json"}, {"id": "b", "type": "tool-request", "actor": "user", "tenant": "two", "parents": ["a"], "edge": "requested", "payload_ref": "b.json"}]}
        report = self.module.trace(payload, "a" * 64)
        self.assertEqual(report["edges"], [{"from": "a", "to": "b", "type": "requested"}])
        self.assertEqual(report["leads"]["cross_tenant_event_ids"], ["b"])

    def test_preserves_unknown_parent_as_typed_gap(self) -> None:
        payload = {"scope_id": "scope", "events": [{"id": "b", "type": "tool-request", "actor": "user", "tenant": "one", "parents": ["missing"], "edge": "requested", "payload_ref": "b.json"}]}
        report = self.module.trace(payload, "b" * 64)
        self.assertEqual(report["edges"], [])
        self.assertEqual(report["gaps"], [{"kind": "missing-parent", "missing_parent_id": "missing", "child_id": "b", "edge": "requested"}])

    def test_rejects_duplicate_parent_and_self_edge(self) -> None:
        duplicate = {"scope_id": "scope", "events": [{"id": "b", "type": "tool-request", "actor": "user", "tenant": "one", "parents": ["a", "a"], "edge": "requested", "payload_ref": "b.json"}]}
        with self.assertRaisesRegex(self.module.TraceError, "parents must be unique"):
            self.module.trace(duplicate, "d" * 64)
        self_edge = {"scope_id": "scope", "events": [{"id": "a", "type": "retrieval", "actor": "user", "tenant": "one", "parents": ["a"], "edge": "retrieved_from", "payload_ref": "a.json"}]}
        with self.assertRaisesRegex(self.module.TraceError, "self-edge"):
            self.module.trace(self_edge, "e" * 64)

    def test_rejects_causal_cycle(self) -> None:
        payload = {"scope_id": "scope", "events": [{"id": "a", "type": "retrieval", "actor": "user", "tenant": "one", "parents": ["b"], "edge": "derived_from", "payload_ref": "a.json"}, {"id": "b", "type": "model-call", "actor": "user", "tenant": "one", "parents": ["a"], "edge": "contains", "payload_ref": "b.json"}]}
        with self.assertRaisesRegex(self.module.TraceError, "contains a cycle"):
            self.module.trace(payload, "f" * 64)

    def test_global_deadline_is_enforced(self) -> None:
        payload = {"scope_id": "scope", "events": [{"id": "a", "type": "retrieval", "actor": "user", "tenant": "one", "parents": [], "edge": "retrieved_from", "payload_ref": "a.json"}]}
        with self.assertRaisesRegex(self.module.TraceError, "global deadline"):
            self.module.trace(payload, "c" * 64, deadline_seconds=0)


if __name__ == "__main__":
    unittest.main()
