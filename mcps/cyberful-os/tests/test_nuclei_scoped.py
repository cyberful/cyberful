# ── Scoped Nuclei Execution Contract ─────────────────────────────────
# Verifies reviewed scanner plans become bounded argv and reject invalid or
# overbroad inputs before a user-triggered Nuclei scan reaches the container.
# → mcps/cyberful-os/cyberful_os_mcp.py — enforces the controlled scanner workflow.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import json
import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp_nuclei_scoped", ROOT / "cyberful_os_mcp.py")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)


def result(*, exit_code=0, stdout="", truncated=False):
    return cyberful_os_mcp.CommandResult(
        target="cyberful-os",
        command="nuclei",
        exit_code=exit_code,
        timed_out=False,
        duration_ms=1,
        stdout=stdout,
        stderr="",
        truncated=truncated,
    )


class NucleiScopedToolsTest(unittest.TestCase):
    def setUp(self):
        cyberful_os_mcp.NUCLEI_PLANS.clear()

    def test_plan_accepts_authorized_http_and_https_targets(self):
        templates = ["http/cves/CVE-2026-0001.yaml"]
        with mock.patch.object(cyberful_os_mcp, "_preview_nuclei_filters", return_value=(result(), templates)):
            for scheme in ("http", "https"):
                with self.subTest(scheme=scheme):
                    target = f"{scheme}://example.com"
                    response = cyberful_os_mcp.handle_nuclei_plan({"target": target, "tags": ["cve"]})

                    self.assertFalse(response["isError"])
                    self.assertEqual(json.loads(response["content"][0]["text"])["target"], target)

    def test_plan_requires_a_web_url_and_a_real_filter(self):
        self.assertTrue(cyberful_os_mcp.handle_nuclei_plan({"target": "ftp://example.com", "tags": ["cve"]})["isError"])
        self.assertTrue(cyberful_os_mcp.handle_nuclei_plan({"target": "https://example.com"})["isError"])
        self.assertTrue(
            cyberful_os_mcp.handle_nuclei_plan(
                {"target": "https://example.com", "tags": ["cve"], "args": ["-t", "/tmp/custom"]}
            )["isError"]
        )

    def test_plan_refuses_a_filter_above_the_hard_template_budget(self):
        templates = [f"http/cves/CVE-{index}.yaml" for index in range(41)]
        with mock.patch.object(cyberful_os_mcp, "_preview_nuclei_filters", return_value=(result(), templates)):
            response = cyberful_os_mcp.handle_nuclei_plan({"target": "https://example.com", "tags": ["cve"]})

        self.assertTrue(response["isError"])
        self.assertEqual(cyberful_os_mcp.NUCLEI_PLANS, {})

    def test_scoped_run_replays_only_the_attested_plan_with_fixed_bounds(self):
        templates = ["http/cves/CVE-2026-0001.yaml"]
        calls = []

        def execute(argv, **kwargs):
            calls.append(list(argv))
            return result()

        with mock.patch.object(cyberful_os_mcp, "_preview_nuclei_filters", return_value=(result(), templates)):
            planned = cyberful_os_mcp.handle_nuclei_plan(
                {"target": "https://example.com", "template_ids": ["CVE-2026-0001"], "rate_limit": 5}
            )
        plan_id = next(iter(cyberful_os_mcp.NUCLEI_PLANS))
        self.assertFalse(planned["isError"])

        with mock.patch.object(cyberful_os_mcp, "run_argv_in_container", side_effect=execute):
            executed = cyberful_os_mcp.handle_nuclei_run_scoped({"plan_id": plan_id})

        self.assertFalse(executed["isError"])
        command = next(call for call in calls if call and call[0] == "nuclei")
        self.assertEqual(command[:3], ["nuclei", "-u", "https://example.com"])
        self.assertIn("X-Request-ID: Bugcrowd", command)
        self.assertEqual(command[command.index("-rate-limit") + 1], "5")
        self.assertEqual(command[command.index("-c") + 1], "1")
        self.assertEqual(command[command.index("-bulk-size") + 1], "1")
        self.assertIn("-no-interactsh", command)
        self.assertNotIn(plan_id, cyberful_os_mcp.NUCLEI_PLANS)

    def test_scoped_run_rejects_raw_flag_injection(self):
        response = cyberful_os_mcp.handle_nuclei_run_scoped({"plan_id": "0" * 64, "args": ["-t", "/tmp/custom"]})
        self.assertTrue(response["isError"])


if __name__ == "__main__":
    unittest.main()
