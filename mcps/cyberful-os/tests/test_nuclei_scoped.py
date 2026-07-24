# ── Unrestricted Nuclei Execution Contract ──────────────────────────
# Verifies Nuclei exposes one complete CLI without Cyberful caps or scoped-plan
#   gates, while the repository-required update-check suppression is automatic.
# → mcps/cyberful-os/cyberful_os_mcp.py — owns the CLI registry and argv boundary.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp_nuclei", ROOT / "cyberful_os_mcp.py")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)


class NucleiToolsTest(unittest.TestCase):
    def test_registry_exposes_cli_and_optional_preview_only(self):
        names = {entry[0] for entry in cyberful_os_mcp.TOOL_REGISTRY}
        self.assertIn("nuclei", names)
        self.assertIn("nuclei_templates", names)
        self.assertNotIn("nuclei_plan", names)
        self.assertNotIn("nuclei_run_scoped", names)

    def test_raw_flags_are_preserved_without_caps_or_exclusions(self):
        spec = next(item for item in cyberful_os_mcp.CLI_TOOL_SPECS if item.name == "nuclei")
        supplied = [
            "-u", "https://example.test", "-rate-limit", "9000", "-c", "500",
            "-tags", "fuzz,headless,intrusive", "-interactsh-server", "oast.example.test",
            "-follow-redirects",
        ]
        argv, stdin_bytes, error = cyberful_os_mcp._argv_from_args(spec, {"args": supplied})

        self.assertIsNone(error)
        self.assertIsNone(stdin_bytes)
        self.assertEqual(argv[0:2], ["nuclei", "-disable-update-check"])
        self.assertEqual(argv[2:], supplied)
        self.assertNotIn("-exclude-tags", argv)
        self.assertNotIn("-no-interactsh", argv)

    def test_update_check_flag_is_not_duplicated(self):
        spec = next(item for item in cyberful_os_mcp.CLI_TOOL_SPECS if item.name == "nuclei")
        argv, _, error = cyberful_os_mcp._argv_from_args(
            spec,
            {"args": ["-disable-update-check", "-u", "https://example.test"]},
        )

        self.assertIsNone(error)
        self.assertEqual(argv.count("-disable-update-check"), 1)


if __name__ == "__main__":
    unittest.main()
