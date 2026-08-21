# ── Network Recon Campaign Tests ────────────────────────────────
# Exercises real loopback TCP traffic, preflight authority denial, output caps,
# and global-deadline process-group cleanup.
# → cyberful/builtin/skills/operate-network-recon/scripts/run_network_recon_campaign.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import os
import socketserver
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_network_recon_campaign.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("network_campaign", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load network campaign")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CountingHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.server.connection_count += 1  # type: ignore[attr-defined]
        self.request.recv(128)


class CountingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), CountingHandler)
        self.connection_count = 0


class NetworkCampaignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _executable(self, workspace: Path) -> Path:
        fake = workspace / "trusted-nmap-fixture"
        fake.write_text(textwrap.dedent("""\
            #!/usr/bin/env python3
            import socket, sys
            if "--version" in sys.argv:
                print("nmap fixture 1.0")
                raise SystemExit(0)
            host = sys.argv[-1]
            ports = sys.argv[sys.argv.index("-p") + 1]
            for port in ports.split(","):
                with socket.create_connection((host, int(port)), timeout=2) as connection:
                    connection.sendall(b"cyberful-probe")
            print('<nmaprun args="loopback"/>')
        """), encoding="utf-8")
        fake.chmod(0o700)
        return fake

    def test_authorized_loopback_campaign_makes_real_tcp_connection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake = self._executable(workspace)
            server = CountingServer()
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                payload = {"authority": {"scope_id": "scope", "allowed_hosts": ["127.0.0.1"], "allowed_ports": [port], "max_requests": 1}, "targets": [{"host": "127.0.0.1", "ports": [port]}]}
                report = self.module.run_campaign(payload, "a" * 64, executable=str(fake), deadline_seconds=3)
                self.assertEqual(report["executions"][0]["exit_code"], 0)
                self.assertEqual(report["tool"]["version"], "nmap fixture 1.0")
                self.assertEqual(server.connection_count, 1)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_preflight_rejection_makes_zero_connections(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake = self._executable(workspace)
            server = CountingServer()
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                port = server.server_address[1]
                payload = {"authority": {"scope_id": "scope", "allowed_hosts": ["127.0.0.2"], "allowed_ports": [port], "max_requests": 1}, "targets": [{"host": "127.0.0.1", "ports": [port]}]}
                with self.assertRaisesRegex(self.module.CampaignError, "outside authority"):
                    self.module.run_campaign(payload, "b" * 64, executable=str(fake), deadline_seconds=3)
                self.assertEqual(server.connection_count, 0)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_global_deadline_terminates_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            pid_file = workspace / "pid"
            fake = workspace / "slow-nmap"
            fake.write_text(textwrap.dedent(f"""\
                #!/usr/bin/env python3
                import os, pathlib, time
                pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
                time.sleep(30)
            """), encoding="utf-8")
            fake.chmod(0o700)
            payload = {"authority": {"scope_id": "scope", "allowed_hosts": ["127.0.0.1"], "allowed_ports": [1], "max_requests": 1}, "targets": [{"host": "127.0.0.1", "ports": [1]}]}
            with self.assertRaisesRegex(self.module.CampaignError, "global deadline"):
                self.module.run_campaign(payload, "c" * 64, executable=str(fake), deadline_seconds=0.8)
            process_id = int(pid_file.read_text(encoding="utf-8"))
            with self.assertRaises(ProcessLookupError):
                os.kill(process_id, 0)

    def test_output_cap_terminates_tool(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake = workspace / "noisy-nmap"
            fake.write_text("#!/usr/bin/env python3\nimport sys\nsys.stdout.write('x' * 5000000)\n", encoding="utf-8")
            fake.chmod(0o700)
            payload = {"authority": {"scope_id": "scope", "allowed_hosts": ["127.0.0.1"], "allowed_ports": [1], "max_requests": 1}, "targets": [{"host": "127.0.0.1", "ports": [1]}]}
            with self.assertRaisesRegex(self.module.CampaignError, "output boundary"):
                self.module.run_campaign(payload, "d" * 64, executable=str(fake), deadline_seconds=3)

    def test_cli_rejects_traversal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            code = self.module.main(["--workspace", directory, "--input", "../plan.json", "--output", "out.json"])
            self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
