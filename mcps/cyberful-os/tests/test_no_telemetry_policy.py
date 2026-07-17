# ── cyberful-os No-Telemetry Environment Contract ──────────────────────
# Verifies a routine MCP tool invocation cannot override the image's mandatory
# update-check and metrics settings while retaining unrelated scan configuration.
# → mcps/cyberful-os/cyberful_os_mcp.py — constructs every container exec environment.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp_no_telemetry", ROOT / "cyberful_os_mcp.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load the cyberful-os MCP runtime")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)


class NoTelemetryEnvironmentTest(unittest.TestCase):
    def test_tool_environment_cannot_reenable_background_traffic(self) -> None:
        requested = {
            "AWS_PROFILE": "engagement",
            "DISABLE_UPDATE_CHECK": "false",
            "DO_NOT_TRACK": "0",
            "GRYPE_CHECK_FOR_APP_UPDATE": "true",
            "PDCP_API_KEY": "caller-supplied",
            "SEMGREP_SEND_METRICS": "on",
            "SYFT_CHECK_FOR_APP_UPDATE": "true",
        }

        inherited = cyberful_os_mcp.inherited_container_env(requested)

        self.assertEqual(inherited["AWS_PROFILE"], "engagement")
        self.assertEqual(inherited, {"AWS_PROFILE": "engagement", **cyberful_os_mcp.NO_TELEMETRY_ENV})


if __name__ == "__main__":
    unittest.main()
