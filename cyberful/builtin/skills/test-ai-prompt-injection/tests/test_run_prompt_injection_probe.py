# ── Prompt-Injection Probe Tests ────────────────────────────────
# Exercises runtime-proxied forward requests, secret redaction, cumulative
#   evidence bounds, total origin parsing, and zero-network constraint refusal.
# → cyberful/builtin/skills/test-ai-prompt-injection/scripts/run_prompt_injection_probe.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import ModuleType
from typing import Any


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_prompt_injection_probe.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("prompt_probe", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load prompt probe")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class Handler(BaseHTTPRequestHandler):
    bodies: list[dict[str, str]] = []
    delay = 0.0
    reflected_secret = ""
    large_header = ""

    def do_POST(self) -> None:  # noqa: N802
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        type(self).bodies.append(json.loads(raw))
        time.sleep(type(self).delay)
        self.send_response(200)
        if type(self).reflected_secret:
            self.send_header("X-Reflected-Authorization", type(self).reflected_secret)
        if type(self).large_header:
            self.send_header("X-Large-Evidence", type(self).large_header)
        body = json.dumps({"received": True, "echo": type(self).reflected_secret}).encode()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def log_message(self, format: str, *args: object) -> None:
        return


def campaign(origin: str, *, endpoint: str | None = None, cases: int = 1) -> dict[str, Any]:
    expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    return {
        "constraints": {
            "authorization_reference": "mission://synthetic-test",
            "expires_at": expires,
            "allowed_origins": [origin],
            "max_requests": cases * 2,
            "requests_per_second": 10,
            "allowed_effects": ["model-output"],
            "actor_id": "tester-a",
            "tenant_id": "tenant-a",
        },
        "cases": [
            {
                "id": f"case-{index}",
                "endpoint": endpoint or f"{origin}/evaluate/{index}",
                "actor_id": "tester-a",
                "tenant_id": "tenant-a",
                "effect": "model-output",
                "control": "control",
                "candidate": "candidate",
                "marker": f"MARK-{index}",
            }
            for index in range(cases)
        ],
    }


class PromptProbeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()
        Handler.bodies = []
        Handler.delay = 0.0
        Handler.reflected_secret = ""
        Handler.large_header = ""

    def _server(self) -> tuple[ThreadingHTTPServer, threading.Thread, str]:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread, f"http://127.0.0.1:{server.server_port}"

    def test_runtime_proxy_forwards_non_loopback_without_external_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            server, thread, proxy = self._server()
            try:
                origin = "http://target.invalid:80"
                with patch.dict(os.environ, {"HTTP_PROXY": proxy}, clear=True):
                    report = self.module.run_probe(campaign(origin), "a" * 64, Path(directory), deadline_seconds=3)
                self.assertEqual([body["mode"] for body in Handler.bodies], ["control", "candidate"])
                self.assertEqual([item["status"] for item in report["cases"][0]["observations"]], [200, 200])
                self.assertTrue(all(body["actor_id"] == "tester-a" for body in Handler.bodies))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_missing_expired_limit_and_effect_refuse_with_zero_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            server, thread, origin = self._server()
            try:
                payloads = []
                missing = campaign(origin)
                del missing["constraints"]["authorization_reference"]
                payloads.append((missing, "malformed"))
                expired = campaign(origin)
                expired["constraints"]["expires_at"] = "2000-01-01T00:00:00Z"
                payloads.append((expired, "expired"))
                limited = campaign(origin)
                limited["constraints"]["max_requests"] = 1
                payloads.append((limited, "max_requests"))
                effect = campaign(origin)
                effect["cases"][0]["effect"] = "tool-effect"
                payloads.append((effect, "effect"))
                for payload, message in payloads:
                    with self.subTest(message=message), patch.dict(os.environ, {}, clear=True):
                        with self.assertRaisesRegex(self.module.ProbeError, message):
                            self.module.run_probe(payload, "b" * 64, Path(directory), deadline_seconds=3)
                self.assertEqual(Handler.bodies, [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_reflected_secret_is_redacted_from_headers_body_and_request(self) -> None:
        secret = "environment-only-secret"
        Handler.reflected_secret = secret
        with tempfile.TemporaryDirectory() as directory:
            server, thread, origin = self._server()
            try:
                with patch.dict(os.environ, {self.module.AUTHORIZATION_ENV: secret}, clear=True):
                    report = self.module.run_probe(campaign(origin), "c" * 64, Path(directory), deadline_seconds=3)
                rendered = json.dumps(report)
                self.assertNotIn(secret, rendered)
                observation = report["cases"][0]["observations"][0]
                self.assertGreater(observation["redactions"]["headers"], 0)
                self.assertGreater(observation["redactions"]["body"], 0)
                self.assertEqual(observation["request"]["authorization"]["environment"], self.module.AUTHORIZATION_ENV)
                self.assertEqual(len(observation["request"]["authorization"]["sha256"]), 64)
                redacted_error, count = self.module._redact_text(f"transport {secret}", secret)
                self.assertEqual((redacted_error, count), ("transport [REDACTED_SECRET]", 1))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_large_headers_across_responses_hit_cumulative_budget_before_append(self) -> None:
        Handler.large_header = "x" * 4096
        with tempfile.TemporaryDirectory() as directory:
            server, thread, origin = self._server()
            try:
                with patch.dict(os.environ, {}, clear=True):
                    with self.assertRaisesRegex(self.module.ProbeError, "cumulative output"):
                        self.module.run_probe(campaign(origin, cases=2), "d" * 64, Path(directory), deadline_seconds=3, evidence_limit_bytes=12_000)
                self.assertGreater(len(Handler.bodies), 0)
                self.assertLess(len(Handler.bodies), 4)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_origin_parser_handles_ipv6_and_rejects_malformed_or_named_loopback(self) -> None:
        canonical, parsed = self.module._origin("http://[::1]:8080", "origin", declaration=True)
        self.assertEqual(canonical, "http://[::1]:8080")
        self.assertTrue(self.module._literal_loopback(parsed))
        with self.assertRaisesRegex(self.module.ProbeError, "malformed"):
            self.module._origin("http://127.0.0.1:99999", "origin")
        _, named = self.module._origin("http://localhost:8080", "origin")
        self.assertFalse(self.module._literal_loopback(named))

    def test_global_deadline_is_not_reset_between_matched_requests(self) -> None:
        Handler.delay = 0.3
        with tempfile.TemporaryDirectory() as directory:
            server, thread, origin = self._server()
            try:
                with patch.dict(os.environ, {}, clear=True):
                    with self.assertRaisesRegex(self.module.ProbeError, "global deadline"):
                        self.module.run_probe(campaign(origin), "e" * 64, Path(directory), deadline_seconds=0.1)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
