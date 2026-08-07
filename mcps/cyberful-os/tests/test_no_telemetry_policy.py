# ── cyberful-os No-Telemetry Environment Contract ──────────────────────
# Verifies a routine MCP tool invocation cannot override the image's mandatory
# update-check and metrics settings while retaining unrelated scan configuration.
# → mcps/cyberful-os/cyberful_os_mcp.py — constructs every container exec environment.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp_no_telemetry", ROOT / "cyberful_os_mcp.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load the cyberful-os MCP runtime")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)


class NoTelemetryEnvironmentTest(unittest.TestCase):
    def test_host_owned_proxy_becomes_standard_container_proxy_environment(self) -> None:
        with tempfile.TemporaryDirectory() as trust_directory:
            bundle = pathlib.Path(trust_directory) / "ca-bundle.pem"
            bundle.write_text("-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n")
            with (
                mock.patch.object(cyberful_os_mcp, "CORE_PROXY_TRUST_DIRECTORY", trust_directory),
                mock.patch.dict(
                    cyberful_os_mcp.os.environ,
                    {
                        "CYBERFUL_OS_HTTP_PROXY": "http://host.docker.internal:49152/",
                        "CYBERFUL_OS_CA_BUNDLE": str(bundle),
                    },
                    clear=True,
                ),
            ):
                inherited = cyberful_os_mcp.inherited_container_env(
                    {
                        "HTTPS_PROXY": "http://caller.invalid/",
                        "CURL_CA_BUNDLE": "/tmp/caller.pem",
                        "GIT_SSL_NO_VERIFY": "true",
                        "BUNDLE_SSL_CA_CERT": "/tmp/caller-bundler.pem",
                        "BUNDLE_SSL_VERIFY_MODE": "0",
                    }
                )

        self.assertEqual(inherited["HTTP_PROXY"], "http://host.docker.internal:49152/")
        self.assertEqual(inherited["HTTPS_PROXY"], inherited["HTTP_PROXY"])
        self.assertEqual(inherited["NO_PROXY"], "127.0.0.1,localhost")
        for name in (
            "SSL_CERT_FILE",
            "CURL_CA_BUNDLE",
            "REQUESTS_CA_BUNDLE",
            "GIT_SSL_CAINFO",
            "PIP_CERT",
            "NODE_EXTRA_CA_CERTS",
            "BUNDLE_SSL_CA_CERT",
        ):
            self.assertEqual(inherited[name], str(bundle))
        self.assertEqual(inherited["GIT_SSL_NO_VERIFY"], "false")
        self.assertEqual(inherited["NODE_USE_ENV_PROXY"], "1")
        self.assertEqual(inherited["BUNDLE_SSL_VERIFY_MODE"], "1")

    def test_proxy_and_bundle_are_an_indivisible_host_owned_pair(self) -> None:
        with mock.patch.dict(
            cyberful_os_mcp.os.environ,
            {"CYBERFUL_OS_HTTP_PROXY": "http://host.docker.internal:49152/"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "configured together"):
                cyberful_os_mcp.inherited_container_env(None)
        with mock.patch.dict(
            cyberful_os_mcp.os.environ,
            {"CYBERFUL_OS_CA_BUNDLE": "/run/cyberful/proxy-trust/ca-bundle.pem"},
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "configured together"):
                cyberful_os_mcp.inherited_container_env(None)

    def test_rejects_a_missing_host_owned_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as trust_directory:
            missing = pathlib.Path(trust_directory) / "missing.pem"
            with (
                mock.patch.object(cyberful_os_mcp, "CORE_PROXY_TRUST_DIRECTORY", trust_directory),
                mock.patch.dict(
                    cyberful_os_mcp.os.environ,
                    {
                        "CYBERFUL_OS_HTTP_PROXY": "http://host.docker.internal:49152/",
                        "CYBERFUL_OS_CA_BUNDLE": str(missing),
                    },
                    clear=True,
                ),
            ):
                with self.assertRaises(FileNotFoundError):
                    cyberful_os_mcp.inherited_container_env(None)

    def test_rejects_bundle_links_outside_paths_and_private_keys(self) -> None:
        with tempfile.TemporaryDirectory() as trust_directory, tempfile.TemporaryDirectory() as outside_directory:
            trust = pathlib.Path(trust_directory)
            outside = pathlib.Path(outside_directory) / "outside.pem"
            outside.write_text("-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n")
            link = trust / "linked.pem"
            link.symlink_to(outside)
            private = trust / "private.pem"
            private.write_text(
                "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n"
                "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n"
            )
            with mock.patch.object(cyberful_os_mcp, "CORE_PROXY_TRUST_DIRECTORY", trust_directory):
                with self.assertRaisesRegex(ValueError, "inside the engagement trust directory"):
                    cyberful_os_mcp.validated_ca_bundle(str(outside))
                with self.assertRaisesRegex(ValueError, "regular file"):
                    cyberful_os_mcp.validated_ca_bundle(str(link))
                with self.assertRaisesRegex(ValueError, "private key"):
                    cyberful_os_mcp.validated_ca_bundle(str(private))

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

        with mock.patch.dict(cyberful_os_mcp.os.environ, {}, clear=True):
            inherited = cyberful_os_mcp.inherited_container_env(requested)

        self.assertEqual(inherited["AWS_PROFILE"], "engagement")
        self.assertEqual(inherited, {"AWS_PROFILE": "engagement", **cyberful_os_mcp.NO_TELEMETRY_ENV})

    def test_evm_compiler_cache_is_engagement_owned_and_cannot_be_overridden(self) -> None:
        requested = {
            "HOME": "/root",
            "FOUNDRY_DIR": "/root/.foundry",
            "SVM_HOME": "/root/.svm",
            "XDG_CACHE_HOME": "/root/.cache",
        }
        with mock.patch.dict(
            cyberful_os_mcp.os.environ,
            {
                cyberful_os_mcp.EVM_RUNTIME_ID_ENV: "11111111-2222-4333-8444-555555555555",
                cyberful_os_mcp.WORKAREA_ROOT_ENV: "/tmp/cyberful-workarea",
            },
            clear=True,
        ):
            inherited = cyberful_os_mcp.inherited_container_env(requested)

        self.assertEqual(
            {name: inherited[name] for name in cyberful_os_mcp.EVM_FOUNDRY_ENV},
            cyberful_os_mcp.EVM_FOUNDRY_ENV,
        )

    def test_evm_compiler_cache_requires_a_valid_host_runtime(self) -> None:
        with mock.patch.dict(
            cyberful_os_mcp.os.environ,
            {
                cyberful_os_mcp.EVM_RUNTIME_ID_ENV: "caller-selected",
                cyberful_os_mcp.WORKAREA_ROOT_ENV: "/tmp/cyberful-workarea",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(ValueError, "invalid EVM runtime identity"):
                cyberful_os_mcp.inherited_container_env(None)


if __name__ == "__main__":
    unittest.main()
