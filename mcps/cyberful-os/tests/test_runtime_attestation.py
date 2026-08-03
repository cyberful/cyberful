# ── Unified Runtime Attestation Tests ────────────────────────────
# Pins architecture selection and required ZAP add-on coverage without needing
#   the heavyweight image filesystem during the local unit suite.
# → mcps/cyberful-os/runtime_attestation.py — performs the live image checks.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import unittest
from unittest.mock import patch

import runtime_attestation


class RuntimeAttestationTests(unittest.TestCase):
    def test_selects_the_native_ghidra_decompiler_directory(self) -> None:
        cases = (
            ("x86_64", "linux_x86_64"),
            ("amd64", "linux_x86_64"),
            ("aarch64", "linux_arm_64"),
            ("arm64", "linux_arm_64"),
        )
        for machine, expected in cases:
            with self.subTest(machine=machine), patch.object(
                runtime_attestation.platform,
                "machine",
                return_value=machine,
            ):
                self.assertEqual(runtime_attestation.expected_decompiler_directory(), expected)

    def test_rejects_an_architecture_without_a_native_manifest(self) -> None:
        with patch.object(runtime_attestation.platform, "machine", return_value="riscv64"):
            with self.assertRaisesRegex(RuntimeError, "unsupported runtime architecture"):
                runtime_attestation.expected_decompiler_directory()

    def test_attests_every_pinned_zap_addon_family(self) -> None:
        self.assertEqual(
            set(runtime_attestation.REQUIRED_ZAP_ADDONS),
            {
                "ascanrules",
                "spiderAjax",
                "authhelper",
                "graphql",
                "mcp",
                "oast",
                "openapi",
                "pscanrules",
                "reports",
                "websocket",
            },
        )


if __name__ == "__main__":
    unittest.main()
