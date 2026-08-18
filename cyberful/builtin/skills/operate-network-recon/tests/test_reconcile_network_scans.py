# ── Network Scan Reconciliation Tests ───────────────────────────
# Exercises real Nmap and Masscan fixture parsing, stable disagreement output,
# malformed XML rejection, and workspace path confinement.
# → cyberful/builtin/skills/operate-network-recon/scripts/reconcile_network_scans.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "reconcile_network_scans.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("reconcile_network_scans", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load network reconciliation helper")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class NetworkReconciliationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_reconciles_scanners_without_hiding_state_disagreement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "nmap.xml").write_text(
                """<?xml version="1.0"?><nmaprun><host><address addr="00:11:22:33:44:55" addrtype="mac"/><address addr="192.0.2.10" addrtype="ipv4"/><hostnames><hostname name="app.example"/></hostnames><ports><port protocol="tcp" portid="443"><state state="open" reason="syn-ack"/><service name="https" product="edge" tunnel="ssl"/></port></ports></host></nmaprun>""",
                encoding="utf-8",
            )
            (workspace / "masscan.json").write_text(
                json.dumps([{"ip": "192.0.2.10", "ports": [{"port": 443, "proto": "tcp", "status": "closed"}]}]),
                encoding="utf-8",
            )
            payload = {
                "sources": [
                    {"id": "nmap", "kind": "nmap-xml", "path": "nmap.xml", "vantage": "lab", "observed_at": "t1"},
                    {"id": "masscan", "kind": "masscan-json", "path": "masscan.json", "vantage": "lab", "observed_at": "t2"},
                ]
            }

            report = self.module.reconcile_manifest(payload, workspace, "a" * 64)

            self.assertEqual(report["summary"]["endpoint_count"], 1)
            self.assertEqual(report["summary"]["disagreement_count"], 1)
            self.assertEqual(report["disagreements"][0]["states"], ["closed", "open"])
            self.assertEqual(report["endpoints"][1]["hostname"], "app.example")

    def test_rejects_entity_declarations_and_duplicate_source_ids(self) -> None:
        with self.assertRaisesRegex(self.module.ReconciliationError, "DTD or entity"):
            self.module._parse_nmap(b"<!DOCTYPE x [<!ENTITY y 'z'>]><nmaprun/>", {"id": "x", "kind": "nmap-xml", "vantage": "v", "observed_at": "t"})

        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            source = workspace / "nmap.xml"
            source.write_text("<nmaprun/>", encoding="utf-8")
            repeated = {"id": "same", "kind": "nmap-xml", "path": "nmap.xml", "vantage": "v", "observed_at": "t"}
            with self.assertRaisesRegex(self.module.ReconciliationError, "source ids must be unique"):
                self.module.reconcile_manifest({"sources": [repeated, repeated]}, workspace, "b" * 64)

    def test_cli_is_deterministic_and_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "nmap.xml").write_text("<nmaprun/>", encoding="utf-8")
            (workspace / "manifest.json").write_text(
                json.dumps({"sources": [{"id": "nmap", "kind": "nmap-xml", "path": "nmap.xml", "vantage": "lab", "observed_at": "t"}]}),
                encoding="utf-8",
            )
            command = [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "manifest.json", "--output", "report.json"]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            rendered = (workspace / "report.json").read_text(encoding="utf-8")
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((workspace / "report.json").read_text(encoding="utf-8"), rendered)

            overwrite = subprocess.run([*command[:-1], "nmap.xml"], check=False, capture_output=True, text=True)
            self.assertEqual(overwrite.returncode, 2)
            self.assertIn("must not replace", overwrite.stderr)

            traversal = subprocess.run(
                [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "../manifest.json"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(traversal.returncode, 2)
            self.assertIn("non-traversing", traversal.stderr)


if __name__ == "__main__":
    unittest.main()
