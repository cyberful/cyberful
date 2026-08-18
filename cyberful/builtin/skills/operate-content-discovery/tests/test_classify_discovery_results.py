# ── Content Discovery Classification Tests ─────────────────────
# Verifies calibrated ffuf classification, malformed evidence rejection,
# deterministic CLI output, and workarea confinement.
# → cyberful/builtin/skills/operate-content-discovery/scripts/classify_discovery_results.py — implementation.
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
SCRIPT = SKILL_ROOT / "scripts" / "classify_discovery_results.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("classify_discovery_results", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load discovery classifier")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def ffuf_result(url: str, status: int, length: int) -> dict[str, object]:
    return {"url": url, "input": {"FUZZ": url.rsplit("/", 1)[-1]}, "status": status, "length": length, "words": 2, "lines": 1, "content-type": "text/html", "redirectlocation": ""}


class DiscoveryClassificationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def test_separates_baseline_like_and_differential_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "baseline.json").write_text(json.dumps({"results": [ffuf_result("https://example.invalid/random", 404, 120)]}), encoding="utf-8")
            (workspace / "scan.json").write_text(json.dumps({"results": [ffuf_result("https://example.invalid/missing", 404, 120), ffuf_result("https://example.invalid/admin", 200, 900)]}), encoding="utf-8")
            payload = {"sources": [
                {"id": "baseline", "path": "baseline.json", "profile": "anonymous", "mutation_axis": "path", "baseline": True},
                {"id": "scan", "path": "scan.json", "profile": "anonymous", "mutation_axis": "path", "baseline": False},
            ]}

            report = self.module.classify_manifest(payload, workspace, "a" * 64)

            self.assertEqual(report["summary"]["baseline_like"], 1)
            self.assertEqual(report["summary"]["differential_candidates"], 1)
            candidates = [item for item in report["results"] if item["classification"] == "differential-candidate"]
            self.assertEqual(candidates[0]["url"], "https://example.invalid/admin")

    def test_rejects_duplicate_sources_and_malformed_ffuf_results(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "bad.json").write_text(json.dumps({"results": [{"status": "200"}]}), encoding="utf-8")
            source = {"id": "same", "path": "bad.json", "profile": "p", "mutation_axis": "path", "baseline": False}
            with self.assertRaisesRegex(self.module.ClassificationError, "source ids must be unique"):
                self.module.classify_manifest({"sources": [source, source]}, workspace, "b" * 64)
            with self.assertRaisesRegex(self.module.ClassificationError, "non-negative integer"):
                self.module.classify_manifest({"sources": [source]}, workspace, "c" * 64)

    def test_cli_output_is_deterministic_and_confined(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            (workspace / "scan.json").write_text(json.dumps({"results": []}), encoding="utf-8")
            (workspace / "manifest.json").write_text(json.dumps({"sources": [{"id": "scan", "path": "scan.json", "profile": "p", "mutation_axis": "path", "baseline": False}]}), encoding="utf-8")
            command = [sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "manifest.json", "--output", "report.json"]
            first = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            rendered = (workspace / "report.json").read_text(encoding="utf-8")
            second = subprocess.run(command, check=False, capture_output=True, text=True)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((workspace / "report.json").read_text(encoding="utf-8"), rendered)

            overwrite = subprocess.run([*command[:-1], "scan.json"], check=False, capture_output=True, text=True)
            self.assertEqual(overwrite.returncode, 2)
            self.assertIn("must not replace", overwrite.stderr)

            traversal = subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--input", "../manifest.json"], check=False, capture_output=True, text=True)
            self.assertEqual(traversal.returncode, 2)
            self.assertIn("non-traversing", traversal.stderr)


if __name__ == "__main__":
    unittest.main()
