# ── cyberful-os Capability Attestation Contract ─────────────────────────
# Verifies the advertised catalog remains aligned with required runtime tools,
# optional families, and strict initialization behavior users depend upon.
# → mcps/cyberful-os/cyberful_os_mcp.py — publishes and verifies the capability report.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import os
import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp_capabilities", ROOT / "cyberful_os_mcp.py")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)


# ── A Catalog Entry Is A Build And Runtime Promise ───────────────────
# These tests pin the mechanism that prevents a stale image from advertising
# absent families. The Docker build executes the same catalog verifier, while
# strict runtime initialization fails a phase if an independently selected
# image still drifts from the registry.
# ─────────────────────────────────────────────────────────────────────


class CapabilityReportTest(unittest.TestCase):
    def test_specialist_audit_and_fuzzing_families_are_required(self):
        names = {spec.name for spec in cyberful_os_mcp.CLI_TOOL_SPECS}
        expected = {
            "afl_clang_fast",
            "afl_fuzz",
            "cloudsplaining",
            "gitleaks",
            "grype",
            "jazzer",
            "kube_bench",
            "kubectl",
            "libfuzzer_clang",
            "prowler",
            "semgrep",
            "syft",
        }

        self.assertTrue(expected <= names)
        self.assertFalse(any(spec.optional for spec in cyberful_os_mcp.CLI_TOOL_SPECS if spec.name in expected))

    def test_every_missing_required_catalog_entry_degrades_the_image(self):
        report = cyberful_os_mcp._capability_report({}, {})
        required = {
            spec.name for spec in (*cyberful_os_mcp.CLI_TOOL_SPECS, *cyberful_os_mcp.LIBRARY_TOOL_SPECS)
            if not spec.optional
        }
        optional = {
            spec.name for spec in (*cyberful_os_mcp.CLI_TOOL_SPECS, *cyberful_os_mcp.LIBRARY_TOOL_SPECS)
            if spec.optional
        }

        self.assertEqual(report["status"], "degraded")
        self.assertEqual(set(report["missing"]), required)
        self.assertEqual(
            {tool["name"] for tool in report["tools"] if tool["status"] == "optional-disabled"},
            optional,
        )

    def test_optional_tools_may_be_disabled_but_required_tools_may_not(self):
        commands = {spec.command: f"/usr/bin/{spec.command}" for spec in cyberful_os_mcp.CLI_TOOL_SPECS if not spec.optional}
        modules = {spec.module: f"/opt/venv/{spec.module}.py" for spec in cyberful_os_mcp.LIBRARY_TOOL_SPECS if not spec.optional}
        report = cyberful_os_mcp._capability_report(commands, modules)

        self.assertEqual(report["status"], "available")
        self.assertEqual(report["missing"], [])
        self.assertGreaterEqual(report["optional_disabled"], 1)

    def test_optional_disabled_tools_are_diagnostic_only_not_exposed(self):
        previous = cyberful_os_mcp.PREFLIGHT_REPORT
        cyberful_os_mcp.PREFLIGHT_REPORT = {
            "tools": [{"name": "jeb", "status": "optional-disabled"}],
        }
        try:
            exposed = {name for name, _, _, _ in cyberful_os_mcp._exposed_tool_registry()}
            self.assertNotIn("jeb", exposed)
            self.assertIn("nuclei", exposed)
            self.assertIn("capability_attestation", exposed)
        finally:
            cyberful_os_mcp.PREFLIGHT_REPORT = previous

    def test_fallback_profiles_use_versioned_first_party_roles(self):
        self.assertEqual(cyberful_os_mcp._fallback_tool_roles("shell"), ["shell"])
        self.assertEqual(cyberful_os_mcp._fallback_tool_roles("tool_inventory"), ["evidence"])
        self.assertIn("active", cyberful_os_mcp._fallback_tool_roles("requests"))
        self.assertIn("evidence", cyberful_os_mcp._fallback_tool_roles("requests"))
        self.assertIn("recon", cyberful_os_mcp._fallback_tool_roles("nmap"))
        self.assertNotIn("active", cyberful_os_mcp._fallback_tool_roles("nmap"))
        self.assertIn("active", cyberful_os_mcp._fallback_tool_roles("afl_fuzz"))
        self.assertIn("evidence", cyberful_os_mcp._fallback_tool_roles("tcpdump"))
        self.assertEqual(cyberful_os_mcp._fallback_tool_roles("wordlists"), [])

    def test_failed_smoke_probe_degrades_an_otherwise_complete_catalog(self):
        commands = {spec.command: f"/usr/bin/{spec.command}" for spec in cyberful_os_mcp.CLI_TOOL_SPECS}
        modules = {spec.module: f"/opt/venv/{spec.module}.py" for spec in cyberful_os_mcp.LIBRARY_TOOL_SPECS}
        report = cyberful_os_mcp._capability_report(commands, modules, {"metasploit": {"ok": False}})

        self.assertEqual(report["status"], "degraded")
        self.assertEqual(report["missing"], [])
        self.assertEqual(report["failed_smoke"], ["metasploit"])

    def test_strict_runtime_preflight_blocks_a_partial_phase(self):
        degraded = {"status": "degraded", "missing": ["msfconsole"], "failed_smoke": []}
        with mock.patch.object(cyberful_os_mcp, "PREFLIGHT_REPORT", None), mock.patch.dict(
            os.environ, {cyberful_os_mcp.STRICT_PREFLIGHT_ENV: "1"}
        ), mock.patch.object(
            cyberful_os_mcp, "container_capability_report", return_value=degraded
        ), mock.patch.object(cyberful_os_mcp, "_write_capability_attestation"):
            with self.assertRaisesRegex(RuntimeError, "msfconsole"):
                cyberful_os_mcp.ensure_strict_preflight()

    def test_docker_build_cannot_drop_the_catalog_verifier(self):
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        copy_at = dockerfile.index("COPY cyberful_os_mcp.py /opt/cyberful-os/cyberful_os_mcp.py")
        verify_at = dockerfile.index("python3 /opt/cyberful-os/cyberful_os_mcp.py --verify-capabilities")
        workdir_at = dockerfile.index("WORKDIR /workspace")

        self.assertLess(copy_at, verify_at)
        self.assertLess(verify_at, workdir_at)
        self.assertIn("msfconsole -q -x 'version; exit'", dockerfile[verify_at:workdir_at])
        self.assertIn("nuclei -version", dockerfile[verify_at:workdir_at])
        for smoke in (
            "semgrep --version",
            "syft version",
            "grype version",
            "gitleaks version",
            "prowler -v",
            "kubectl version --client=true",
            "kube-bench version",
            "jazzer --version",
            "afl-fuzz -h",
            "clang --version",
        ):
            self.assertIn(smoke, dockerfile[verify_at:workdir_at])


if __name__ == "__main__":
    unittest.main()
