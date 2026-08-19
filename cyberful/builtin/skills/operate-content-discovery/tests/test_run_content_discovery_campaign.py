# ── Content Discovery Campaign Tests ────────────────────────────
# Unit-tests bounded process behavior and forward-tests direct loopback and
# mission-routed synthetic proxy traffic.
# → cyberful/builtin/skills/operate-content-discovery/scripts/run_content_discovery_campaign.py — implementation.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import ModuleType


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_ROOT / "scripts" / "run_content_discovery_campaign.py"


def load_script() -> ModuleType:
    specification = importlib.util.spec_from_file_location("run_content_discovery_campaign", SCRIPT)
    if specification is None or specification.loader is None:
        raise RuntimeError("could not load content discovery campaign")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


class ContentDiscoveryCampaignTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_script()

    def _fixture(self, workspace: Path) -> tuple[Path, dict[str, object]]:
        fake = workspace / "fake_ffuf.py"
        fake.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import json, pathlib, sys
                if "-V" in sys.argv:
                    print("ffuf fixture 1.0")
                    raise SystemExit(0)
                output = pathlib.Path(sys.argv[sys.argv.index("-o") + 1])
                target = sys.argv[sys.argv.index("-u") + 1]
                output.write_text(json.dumps({"results": [{"url": target.replace("FUZZ", "admin"), "status": 200}]}), encoding="utf-8")
                print("fixture completed")
                """
            ),
            encoding="utf-8",
        )
        fake.chmod(0o700)
        (workspace / "words.txt").write_text("admin\nhealth\n", encoding="utf-8")
        config: dict[str, object] = {
            "$schema": "./content-discovery-campaign.schema.json",
            "authorization_reference": "synthetic-scope-reference",
            "allowed_origins": ["http://127.0.0.1:8765"],
            "target": "http://127.0.0.1:8765/FUZZ",
            "wordlist": "words.txt",
            "output_directory": "evidence",
            "request_limit": 2,
            "rate_per_second": 2,
            "concurrency": 1,
            "timeout_seconds": 5,
        }
        return fake, config

    def _run_cli(self, workspace: Path, config: dict[str, object]) -> subprocess.CompletedProcess[str]:
        (workspace / "config.json").write_text(json.dumps(config), encoding="utf-8")
        return subprocess.run([sys.executable, str(SCRIPT), "--workspace", str(workspace), "--config", "config.json"], check=False, capture_output=True, text=True)

    def test_unit_campaign_preserves_bounded_raw_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            record = self.module._run_campaign_for_test(config, workspace, str(fake))
            self.assertEqual(record["exit_code"], 0)
            self.assertEqual(record["tool_version"], "ffuf fixture 1.0")
            self.assertEqual(record["raw_output"]["path"], "evidence/ffuf-results.json")
            self.assertEqual((workspace / "evidence" / "ffuf-results.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual((workspace / "evidence" / "campaign-record.json").stat().st_mode & 0o777, 0o600)

    def test_ambient_environment_sentinel_does_not_reach_the_child(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            sentinel = workspace / "child-environment.json"
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import json, os, pathlib, sys
                    if "-V" in sys.argv:
                        print("ffuf fixture 1.0")
                        raise SystemExit(0)
                    pathlib.Path({str(sentinel)!r}).write_text(json.dumps({{name: os.environ.get(name) for name in ("CYBERFUL_TEST_SENTINEL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE")}}), encoding="utf-8")
                    output = pathlib.Path(sys.argv[sys.argv.index("-o") + 1])
                    output.write_text(json.dumps({{"results": []}}), encoding="utf-8")
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            with patch.dict(os.environ, {"CYBERFUL_TEST_SENTINEL": "must-not-leak", "HTTP_PROXY": "http://ambient:8080", "HTTPS_PROXY": "http://ambient:8443", "ALL_PROXY": "http://ambient:9000", "NO_PROXY": "*", "SSL_CERT_FILE": "/runtime/ca.pem", "SSL_CERT_DIR": "/ambient/ca", "CURL_CA_BUNDLE": "/runtime/curl-ca.pem"}, clear=False):
                self.module._run_campaign_for_test(config, workspace, str(fake))
            child_environment = json.loads(sentinel.read_text(encoding="utf-8"))
            self.assertIsNone(child_environment["CYBERFUL_TEST_SENTINEL"])
            self.assertIsNone(child_environment["HTTP_PROXY"])
            self.assertIsNone(child_environment["HTTPS_PROXY"])
            self.assertIsNone(child_environment["ALL_PROXY"])
            self.assertIsNone(child_environment["NO_PROXY"])
            self.assertEqual(child_environment["SSL_CERT_FILE"], "/runtime/ca.pem")
            self.assertIsNone(child_environment["SSL_CERT_DIR"])
            self.assertEqual(child_environment["CURL_CA_BUNDLE"], "/runtime/curl-ca.pem")

    def test_forward_loopback_origin_is_direct_even_with_a_proxy_trap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            received: list[str] = []
            proxy_received: list[str] = []

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self) -> None:
                    received.append(self.path)
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"synthetic")

                def log_message(self, format: str, *args: object) -> None:
                    return

            class ProxyTrapHandler(BaseHTTPRequestHandler):
                def do_GET(self) -> None:
                    proxy_received.append(self.path)
                    self.send_response(502)
                    self.end_headers()

                def log_message(self, format: str, *args: object) -> None:
                    return

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            proxy = ThreadingHTTPServer(("127.0.0.1", 0), ProxyTrapHandler)
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()
            port = server.server_address[1]
            fake = workspace / "forward_ffuf.py"
            fake.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import json, pathlib, sys, urllib.request
                    if "-V" in sys.argv:
                        print("ffuf forward fixture 1.0")
                        raise SystemExit(0)
                    target = sys.argv[sys.argv.index("-u") + 1].replace("FUZZ", "forward")
                    proxies = {"http": sys.argv[sys.argv.index("-x") + 1]} if "-x" in sys.argv else {}
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler(proxies))
                    with opener.open(target, timeout=2) as response:
                        status = response.status
                    pathlib.Path(sys.argv[sys.argv.index("-o") + 1]).write_text(json.dumps({"results": [{"url": target, "status": status}]}), encoding="utf-8")
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            (workspace / "words.txt").write_text("forward\n", encoding="utf-8")
            config = {
                "$schema": "./content-discovery-campaign.schema.json",
                "authorization_reference": "synthetic-loopback-scope",
                "allowed_origins": [f"http://127.0.0.1:{port}"],
                "target": f"http://127.0.0.1:{port}/FUZZ",
                "wordlist": "words.txt",
                "output_directory": "forward-evidence",
                "request_limit": 1,
                "rate_per_second": 1,
                "concurrency": 1,
                "timeout_seconds": 5,
            }
            try:
                with patch.dict(os.environ, {"HTTP_PROXY": f"http://127.0.0.1:{proxy.server_address[1]}"}, clear=False):
                    self.module._run_campaign_for_test(config, workspace, str(fake))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                proxy.shutdown()
                proxy.server_close()
                proxy_thread.join(timeout=2)
            self.assertEqual(received, ["/forward"])
            self.assertEqual(proxy_received, [])

    def test_rejects_missing_scope_reference_before_tool_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            sentinel = workspace / "called"
            fake.write_text(f'#!/usr/bin/env python3\nfrom pathlib import Path\nPath({str(sentinel)!r}).write_text("called")\n', encoding="utf-8")
            fake.chmod(0o700)
            config["authorization_reference"] = ""
            with self.assertRaisesRegex(self.module.CampaignError, "authorization_reference"):
                self.module._run_campaign_for_test(config, workspace, str(fake))
            self.assertFalse(sentinel.exists())

    def test_non_loopback_target_without_runtime_route_refuses_before_tool_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            sentinel = workspace / "called"
            fake.write_text(f'#!/usr/bin/env python3\nfrom pathlib import Path\nPath({str(sentinel)!r}).write_text("called")\n', encoding="utf-8")
            fake.chmod(0o700)
            config["allowed_origins"] = ["http://content.invalid:80"]
            config["target"] = "http://content.invalid/FUZZ"
            with patch.dict(os.environ, {"HTTP_PROXY": "", "HTTPS_PROXY": ""}, clear=False):
                with self.assertRaisesRegex(self.module.CampaignError, "no mission-bound HTTP_PROXY route"):
                    self.module._run_campaign_for_test(config, workspace, str(fake))
            self.assertFalse(sentinel.exists())

    def test_non_loopback_invalid_target_uses_synthetic_proxy_without_external_traffic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            proxy_received: list[str] = []

            class SyntheticProxyHandler(BaseHTTPRequestHandler):
                def do_GET(self) -> None:
                    proxy_received.append(self.path)
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"synthetic-proxy-response")

                def log_message(self, format: str, *args: object) -> None:
                    return

            proxy = ThreadingHTTPServer(("127.0.0.1", 0), SyntheticProxyHandler)
            proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
            proxy_thread.start()
            fake = workspace / "proxy_ffuf.py"
            fake.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import json, pathlib, sys, urllib.request
                    if "-V" in sys.argv:
                        print("ffuf proxy fixture 1.0")
                        raise SystemExit(0)
                    target = sys.argv[sys.argv.index("-u") + 1].replace("FUZZ", "proxied")
                    proxy = sys.argv[sys.argv.index("-x") + 1]
                    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy}))
                    with opener.open(target, timeout=2) as response:
                        status = response.status
                    pathlib.Path(sys.argv[sys.argv.index("-o") + 1]).write_text(json.dumps({"results": [{"url": target, "status": status}]}), encoding="utf-8")
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            (workspace / "words.txt").write_text("proxied\n", encoding="utf-8")
            config: dict[str, object] = {
                "$schema": "./content-discovery-campaign.schema.json",
                "authorization_reference": "synthetic-proxy-scope",
                "allowed_origins": ["http://content.invalid:80"],
                "target": "http://content.invalid/FUZZ",
                "wordlist": "words.txt",
                "output_directory": "proxy-evidence",
                "request_limit": 1,
                "rate_per_second": 1,
                "concurrency": 1,
                "timeout_seconds": 5,
            }
            try:
                with patch.dict(os.environ, {"HTTP_PROXY": f"http://127.0.0.1:{proxy.server_address[1]}"}, clear=False):
                    record = self.module._run_campaign_for_test(config, workspace, str(fake))
            finally:
                proxy.shutdown()
                proxy.server_close()
                proxy_thread.join(timeout=2)
            self.assertEqual(proxy_received, ["http://content.invalid/proxied"])
            self.assertEqual(record["authorization_reference"], "synthetic-proxy-scope")

    def test_runtime_proxy_may_use_a_docker_hostname(self) -> None:
        with patch.dict(os.environ, {"HTTP_PROXY": "http://cyberful-os:8080"}, clear=False):
            self.assertEqual(self.module._runtime_route("http://content.invalid/FUZZ"), ("HTTP_PROXY", "http://cyberful-os:8080"))

    def test_rejects_scheme_and_effective_port_outside_authorized_origins(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            config["allowed_origins"] = ["https://127.0.0.1:8765"]
            with self.assertRaisesRegex(self.module.CampaignError, "outside allowed_origins"):
                self.module._run_campaign_for_test(config, workspace, str(fake))
            config["allowed_origins"] = ["http://127.0.0.1:8766"]
            with self.assertRaisesRegex(self.module.CampaignError, "outside allowed_origins"):
                self.module._run_campaign_for_test(config, workspace, str(fake))

    def test_rejects_request_limit_secret_and_binary_injection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            config["request_limit"] = 1
            with self.assertRaisesRegex(self.module.CampaignError, "wordlist entries"):
                self.module._run_campaign_for_test(config, workspace, str(fake))
            config["request_limit"] = 2
            for field in ("authorization_header", "ffuf_binary", "proxy_url", "ca_bundle"):
                with self.subTest(field=field):
                    invalid = dict(config)
                    invalid[field] = "must-not-cross-model-boundary"
                    result = self._run_cli(workspace, invalid)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("config fields", result.stderr)
                    self.assertNotIn("must-not-cross-model-boundary", result.stderr)

    def test_timeout_cleans_up_the_tool_process(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            pid_file = workspace / "tool.pid"
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import os, pathlib, sys, time
                    if "-V" in sys.argv:
                        print("ffuf fixture 1.0")
                        raise SystemExit(0)
                    pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
                    time.sleep(30)
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            config["timeout_seconds"] = 1
            with self.assertRaisesRegex(self.module.CampaignError, "exceeded timeout_seconds=1"):
                self.module._run_campaign_for_test(config, workspace, str(fake))
            process_id = int(pid_file.read_text(encoding="utf-8"))
            with self.assertRaises(ProcessLookupError):
                os.kill(process_id, 0)

    def test_native_output_limit_stops_process_during_execution(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            fake, config = self._fixture(workspace)
            pid_file = workspace / "tool.pid"
            fake.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env python3
                    import os, pathlib, sys, time
                    if "-V" in sys.argv:
                        print("ffuf fixture 1.0")
                        raise SystemExit(0)
                    pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid()))
                    pathlib.Path(sys.argv[sys.argv.index("-o") + 1]).write_bytes(b"x" * 2048)
                    time.sleep(30)
                    """
                ),
                encoding="utf-8",
            )
            fake.chmod(0o700)
            self.module.MAX_OUTPUT_BYTES = 1024
            with self.assertRaisesRegex(self.module.CampaignError, "execution limit"):
                self.module._run_campaign_for_test(config, workspace, str(fake))
            process_id = int(pid_file.read_text(encoding="utf-8"))
            with self.assertRaises(ProcessLookupError):
                os.kill(process_id, 0)
            native_output = workspace / "evidence" / "ffuf-results.json"
            self.assertTrue(native_output.exists())
            self.assertLessEqual(native_output.stat().st_size, 1024)


if __name__ == "__main__":
    unittest.main()
