# ── Packet Capture Evidence Tests ───────────────────────────────
# Covers classic PCAP parsing, deterministic protocol summaries, malformed
#   records, symlink confinement, collision, deadline, and output bounds.
# → cyberful/builtin/skills/analyze-network-packet-captures/scripts/analyze_network_packet_captures.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import time
from types import ModuleType
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "analyze_network_packet_captures.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("analyze_network_packet_captures", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load PCAP analyzer")
    module = importlib.util.module_from_spec(specification)
    sys.modules[specification.name] = module
    specification.loader.exec_module(module)
    return module


class PacketCaptureEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _fixture(self, workspace: Path) -> tuple[dict[str, object], bytes]:
        ethernet_ipv4_tcp = b"\x00" * 12 + b"\x08\x00" + b"\x45" + b"\x00" * 8 + b"\x06" + b"\x00" * 30
        global_header = b"\xd4\xc3\xb2\xa1" + struct.pack("<HHiIII", 2, 4, 0, 0, 65535, 1)
        packet = struct.pack("<IIII", 10, 5, len(ethernet_ipv4_tcp), len(ethernet_ipv4_tcp)) + ethernet_ipv4_tcp
        (workspace / "session.pcap").write_bytes(global_header + packet)
        config: dict[str, object] = {"$schema": "./packet-capture-analysis.schema.json", "analysis_id": "fixture-pcap", "scope_reference": "scope:pcap", "capture_files": ["session.pcap"], "max_packets": 8, "max_total_bytes": 65536, "timeout_seconds": 5, "output_limit_bytes": 65536}
        raw = f"{json.dumps(config, sort_keys=True)}\n".encode()
        return config, raw

    def test_cli_is_deterministic_and_counts_protocol_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, raw = self._fixture(workspace)
            (workspace / "input.json").write_bytes(raw)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "one.json"]), 0)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "two.json"]), 0)
            first = json.loads((workspace / "one.json").read_text())
            second = json.loads((workspace / "two.json").read_text())
            self.assertEqual(first, second)
            self.assertEqual(first["summary"]["packets"], 1)
            self.assertEqual(first["summary"]["protocol_counts"]["tcp"], 1)
            self.assertEqual(first["captures"][0]["timestamp_precision"], "microseconds")

    def test_malformed_record_and_symlink_refuse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, _ = self._fixture(workspace)
            capture = workspace / "session.pcap"
            capture.write_bytes(capture.read_bytes()[:-1])
            with self.assertRaisesRegex(self.module.AnalysisError, "invalid packet"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            target = workspace / "target.pcap"
            target.write_bytes(b"x")
            (workspace / "link.pcap").symlink_to(target)
            config["capture_files"] = ["link.pcap"]
            with self.assertRaisesRegex(self.module.AnalysisError, "symbolic"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)

    def test_collision_preserves_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            _, raw = self._fixture(workspace)
            path = workspace / "input.json"
            path.write_bytes(raw)
            self.assertEqual(self.module.main(["--workspace", str(workspace), "--input", "input.json", "--output", "input.json"]), 2)
            self.assertEqual(path.read_bytes(), raw)

    def test_deadline_packet_and_output_limits_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, _ = self._fixture(workspace)
            with self.assertRaisesRegex(self.module.AnalysisError, "deadline"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() - 1)
            config["max_packets"] = 0
            with self.assertRaisesRegex(self.module.AnalysisError, "max_packets"):
                self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            config["max_packets"] = 8
            config["output_limit_bytes"] = 1024
            report, limit = self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            with self.assertRaisesRegex(self.module.AnalysisError, "output_limit"):
                self.module._write(workspace / "small.json", report, limit, time.monotonic() + 5)
            self.assertFalse((workspace / "small.json").exists())

    def test_atomic_publish_never_replaces_a_racing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            config, _ = self._fixture(workspace)
            report, _ = self.module._analyze(config, "0" * 64, workspace, time.monotonic() + 5)
            destination = workspace / "raced.json"
            original_link = self.module.os.link

            def race(source: str, target: Path) -> None:
                Path(target).write_bytes(b"racer")
                original_link(source, target)

            with patch.object(self.module.os, "link", side_effect=race):
                with self.assertRaises(FileExistsError):
                    self.module._write(destination, report, 65536, time.monotonic() + 5)
            self.assertEqual(destination.read_bytes(), b"racer")


if __name__ == "__main__":
    unittest.main()
