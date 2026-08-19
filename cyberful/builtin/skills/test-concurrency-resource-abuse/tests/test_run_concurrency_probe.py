# ── Concurrency Probe Tests ─────────────────────────────────────
# Exercises direct loopback and runtime-proxied Docker-hostname routes, rejects
# payload transport controls before I/O, and enforces the global deadline.
# → cyberful/builtin/skills/test-concurrency-resource-abuse/scripts/run_concurrency_probe.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "run_concurrency_probe.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("concurrency_probe", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load concurrency probe")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Handler(BaseHTTPRequestHandler):
    connections = 0
    delay = 0.0

    def do_POST(self) -> None:  # noqa: N802
        type(self).connections += 1
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        time.sleep(type(self).delay)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"accepted":true}')

    def log_message(self, format: str, *args: object) -> None:
        return


class TrapHandler(Handler):
    connections = 0


class ConcurrencyProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()
        Handler.connections = 0
        Handler.delay = 0.0
        TrapHandler.connections = 0
        TrapHandler.delay = 0.0

    def _payload(self, origin: str, *, concurrency: int = 2) -> dict[str, object]:
        return {"authority": {"scope_id": "scope", "allowed_origins": [origin], "max_requests": concurrency, "max_concurrency": concurrency}, "cases": [{"id": "race", "url": f"{origin}/redeem", "method": "POST", "headers": {"Content-Type": "application/json"}, "body": "{}", "concurrency": concurrency, "repetitions": 1}]}

    def test_literal_loopback_is_direct_and_does_not_hit_runtime_proxy_trap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            trap = ThreadingHTTPServer(("127.0.0.1", 0), TrapHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            trap_thread = threading.Thread(target=trap.serve_forever, daemon=True)
            thread.start()
            trap_thread.start()
            try:
                origin = f"http://127.0.0.1:{server.server_port}"
                proxy = f"http://127.0.0.1:{trap.server_port}"
                with patch.dict(os.environ, {"HTTP_PROXY": proxy}, clear=True):
                    report = self.module.run_probe(self._payload(origin), "a" * 64, workspace, deadline_seconds=3)
                observations = report["cases"][0]["observations"]
                self.assertEqual([item["status"] for item in observations], [200, 200])
                self.assertEqual(Handler.connections, 2)
                self.assertEqual(TrapHandler.connections, 0)
                self.assertEqual(report["environment"]["proxy_environment"], [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                trap.shutdown()
                trap.server_close()
                trap_thread.join(timeout=2)

    def test_docker_hostname_routes_only_through_standard_runtime_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            proxy_server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=proxy_server.serve_forever, daemon=True)
            thread.start()
            try:
                origin = "http://cyberful-target:80"
                proxy = f"http://127.0.0.1:{proxy_server.server_port}"
                with patch.dict(os.environ, {"HTTP_PROXY": proxy}, clear=True):
                    report = self.module.run_probe(self._payload(origin, concurrency=1), "b" * 64, workspace, deadline_seconds=3)
                self.assertEqual(Handler.connections, 1)
                self.assertEqual(report["cases"][0]["observations"][0]["status"], 200)
                self.assertEqual(report["environment"]["proxy_environment"], ["HTTP_PROXY"])
                self.assertFalse(report["environment"]["direct_non_loopback"])
            finally:
                proxy_server.shutdown()
                proxy_server.server_close()
                thread.join(timeout=2)

    def test_preflight_rejection_makes_zero_connections(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                origin = f"http://127.0.0.1:{server.server_port}"
                payload = self._payload(origin, concurrency=1)
                payload["cases"][0]["url"] = f"http://127.0.0.1:{server.server_port + 1}/redeem"  # type: ignore[index]
                with self.assertRaisesRegex(self.module.ProbeError, "outside authority"):
                    self.module.run_probe(payload, "c" * 64, workspace, deadline_seconds=3)
                self.assertEqual(Handler.connections, 0)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_non_loopback_without_runtime_route_refuses_before_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            trap = ThreadingHTTPServer(("127.0.0.1", 0), TrapHandler)
            thread = threading.Thread(target=trap.serve_forever, daemon=True)
            thread.start()
            try:
                payload = self._payload("http://cyberful-target:80", concurrency=1)
                with patch.dict(os.environ, {}, clear=True):
                    with self.assertRaisesRegex(self.module.ProbeError, "runtime route in HTTP_PROXY"):
                        self.module.run_probe(payload, "d" * 64, workspace, deadline_seconds=1)
                self.assertEqual(TrapHandler.connections, 0)
            finally:
                trap.shutdown()
                trap.server_close()
                thread.join(timeout=2)

    def test_payload_cannot_select_ca_or_proxy_and_rejection_makes_zero_connections(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            trap = ThreadingHTTPServer(("127.0.0.1", 0), TrapHandler)
            thread = threading.Thread(target=trap.serve_forever, daemon=True)
            thread.start()
            try:
                origin = "http://cyberful-target:80"
                proxy = f"http://127.0.0.1:{trap.server_port}"
                for field, value in (("ca_file", "ca.pem"), ("proxy", proxy)):
                    payload = self._payload(origin, concurrency=1)
                    payload["authority"][field] = value  # type: ignore[index]
                    with self.subTest(field=field), patch.dict(os.environ, {"HTTP_PROXY": proxy}, clear=True):
                        with self.assertRaisesRegex(self.module.ProbeError, "authority contract is malformed"):
                            self.module.run_probe(payload, "e" * 64, workspace, deadline_seconds=1)
                self.assertEqual(TrapHandler.connections, 0)
            finally:
                trap.shutdown()
                trap.server_close()
                thread.join(timeout=2)

    def test_origin_parser_handles_ipv6_malformed_ports_and_named_loopback(self) -> None:
        canonical, parsed = self.module._origin("http://[::1]:8080", "origin", declaration=True)
        self.assertEqual(canonical, "http://[::1]:8080")
        self.assertTrue(self.module._literal_loopback(parsed))
        with self.assertRaisesRegex(self.module.ProbeError, "malformed port"):
            self.module._origin("http://127.0.0.1:99999", "origin")
        _, named = self.module._origin("http://localhost:8080", "origin")
        self.assertFalse(self.module._literal_loopback(named))

    def test_global_deadline_is_not_reset_per_request(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            Handler.delay = 1.0
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                origin = f"http://127.0.0.1:{server.server_port}"
                with patch.dict(os.environ, {}, clear=True):
                    with self.assertRaisesRegex(self.module.ProbeError, "global deadline"):
                        self.module.run_probe(self._payload(origin, concurrency=1), "f" * 64, workspace, deadline_seconds=0.2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
