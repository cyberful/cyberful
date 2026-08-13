# ── cyberful-os MCP Boundary Contract ──────────────────────────────────
# Exercises schema rejection, bounded stdio framing, streamed HTTP retention,
# and capped wordlist traversal through the production MCP entrypoints.
# Malformed requests must fail before Docker work and broad inputs must remain
# finite without hiding that their result was truncated.
# → mcps/cyberful-os/cyberful_os_mcp.py — validates and dispatches cyberful-os tools.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import io
import json
import os
import pathlib
import re
import sys
import tempfile
import types
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cyberful_os_mcp_boundaries", ROOT / "cyberful_os_mcp.py")
cyberful_os_mcp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = cyberful_os_mcp
SPEC.loader.exec_module(cyberful_os_mcp)


def _stdout_json(result):
    text = result["content"][0]["text"]
    return json.loads(text.split("\nstdout:\n", 1)[1])


def _run_embedded_locally(argv, **kwargs):
    return cyberful_os_mcp.run_process(
        [sys.executable, *argv[1:]],
        timeout_seconds=5,
        max_output_bytes=1024 * 1024,
        stdin=kwargs["stdin"],
    )


class _FakeRequestException(Exception):
    pass


def _embedded_requests_runner(response, request_options):
    def request(**kwargs):
        request_options.update(kwargs)
        return response

    def run_embedded(argv, **kwargs):
        previous_stdin = sys.stdin
        previous_stdout = sys.stdout
        previous_requests = sys.modules.get("requests")
        capture = io.StringIO()
        sys.stdin = io.StringIO(kwargs["stdin"].decode("utf-8"))
        sys.stdout = capture
        sys.modules["requests"] = types.SimpleNamespace(
            request=request,
            exceptions=types.SimpleNamespace(RequestException=_FakeRequestException),
        )
        try:
            exec(compile(argv[2], "<requests-tool>", "exec"), {})
        finally:
            sys.stdin = previous_stdin
            sys.stdout = previous_stdout
            if previous_requests is None:
                sys.modules.pop("requests", None)
            else:
                sys.modules["requests"] = previous_requests
        return cyberful_os_mcp.CommandResult(
            target="cyberful-os",
            command="python3",
            exit_code=0,
            timed_out=False,
            duration_ms=1,
            stdout=capture.getvalue(),
            stderr="",
            truncated=False,
        )

    return run_embedded


class ToolSchemaBoundaryTest(unittest.TestCase):
    @staticmethod
    def _minimal_schema_value(schema):
        if "enum" in schema:
            return schema["enum"][0]
        if schema.get("type") == "string":
            return "fixture"
        if schema.get("type") == "integer":
            return schema.get("minimum", 1)
        if schema.get("type") == "number":
            return schema.get("minimum", 1)
        if schema.get("type") == "boolean":
            return False
        if schema.get("type") == "array":
            return [ToolSchemaBoundaryTest._minimal_schema_value(schema.get("items", {}))]
        if schema.get("type") == "object":
            return {}
        return None

    def test_registry_pairs_every_unique_public_name_with_a_handler_and_schema(self):
        registry = cyberful_os_mcp._exposed_tool_registry()
        names = [entry[0] for entry in registry]

        self.assertEqual(len(names), len(set(names)))
        self.assertGreater(len(names), 100)
        for name, description, schema, handler in registry:
            with self.subTest(tool=name):
                self.assertRegex(name, r"^[a-z0-9_]+$")
                self.assertTrue(description)
                self.assertEqual(schema.get("type"), "object")
                self.assertFalse(schema.get("additionalProperties", True))
                self.assertTrue(callable(handler))

    def test_complete_catalog_matches_every_declared_cyberful_os_tool_and_count(self):
        catalog = (ROOT.parents[1] / "docs" / "runtimes" / "tool-catalog.md").read_text(encoding="utf-8")
        rows = set(re.findall(r"^\| `([^`]+)` \|", catalog, re.MULTILINE))
        cli_names = {spec.name for spec in cyberful_os_mcp.CLI_TOOL_SPECS}
        library_names = {spec.name for spec in cyberful_os_mcp.LIBRARY_TOOL_SPECS}
        workflow_names = set(cyberful_os_mcp.native_security.OPERATIONS)
        utility_names = {"capability_attestation", "nuclei_templates", "shell", "tool_inventory", "wordlists"}
        declared = cli_names | library_names | workflow_names | utility_names

        self.assertEqual(declared - rows, set())
        self.assertEqual(len(cli_names), 202)
        self.assertEqual(len(workflow_names), 13)
        self.assertEqual(len(declared), 223)
        self.assertIn("202 cyberful-os CLI tools", catalog)
        self.assertIn("13 cyberful-os managed workflows", catalog)

    def test_shell_schema_remains_the_bounded_fallback_contract(self):
        shell = next(entry for entry in cyberful_os_mcp._exposed_tool_registry() if entry[0] == "shell")
        schema = shell[2]

        self.assertEqual(schema["required"], ["command"])
        self.assertEqual(
            set(schema["properties"]),
            {"command", "cwd", "timeout_seconds", "max_output_bytes", "env", "accepted_exit_codes", "egress"},
        )
        self.assertEqual(schema["properties"]["timeout_seconds"]["default"], cyberful_os_mcp.DEFAULT_TIMEOUT_SECONDS)
        self.assertEqual(schema["properties"]["timeout_seconds"]["maximum"], cyberful_os_mcp.MAX_TIMEOUT_SECONDS)
        self.assertEqual(
            schema["properties"]["max_output_bytes"]["default"],
            cyberful_os_mcp.DEFAULT_MAX_OUTPUT_BYTES,
        )
        self.assertEqual(schema["properties"]["max_output_bytes"]["maximum"], cyberful_os_mcp.MAX_OUTPUT_BYTES)

    def test_rejects_wrong_types_and_unknown_fields_before_docker(self):
        wrong_type = cyberful_os_mcp.handle_tool_call({
            "name": "tool_inventory",
            "arguments": {"include_status": False, "timeout_seconds": "5"},
        })
        unknown_field = cyberful_os_mcp.handle_tool_call({
            "name": "tool_inventory",
            "arguments": {"include_status": False, "unexpected": True},
        })

        self.assertTrue(wrong_type["isError"])
        self.assertIn("arguments.timeout_seconds: expected an integer", wrong_type["content"][0]["text"])
        self.assertTrue(unknown_field["isError"])
        self.assertIn("unknown property unexpected", unknown_field["content"][0]["text"])

    def test_native_operation_schemas_reject_incomplete_and_cross_operation_arguments(self):
        with mock.patch.object(cyberful_os_mcp, "ensure_container") as ensure_container:
            missing = cyberful_os_mcp.handle_tool_call({
                "name": "native_lab",
                "arguments": {"operation": "start_process", "lab_id": "fixture"},
            })
            crossed = cyberful_os_mcp.handle_tool_call({
                "name": "archive_extract",
                "arguments": {"operation": "inspect", "path": "/workspace/a.zip", "output": "/workspace/out"},
            })

        self.assertTrue(missing["isError"])
        self.assertIn("exactly one operation schema", missing["content"][0]["text"])
        self.assertTrue(crossed["isError"])
        self.assertIn("exactly one operation schema", crossed["content"][0]["text"])
        ensure_container.assert_not_called()

    def test_every_native_operation_schema_accepts_its_documented_required_properties(self):
        for tool_name, operations in cyberful_os_mcp.native_security.OPERATION_FIELDS.items():
            schema = cyberful_os_mcp.native_security.SCHEMAS[tool_name]
            with self.subTest(tool=tool_name):
                self.assertFalse(schema["additionalProperties"])
            for operation, (_fields, required) in operations.items():
                arguments = {"operation": operation}
                arguments.update({
                    field: self._minimal_schema_value(cyberful_os_mcp.native_security.SCHEMA_FIELDS[field])
                    for field in required
                })
                with self.subTest(tool=tool_name, operation=operation):
                    self.assertEqual(cyberful_os_mcp.validate_tool_arguments(schema, arguments), arguments)

        firefox_schema = cyberful_os_mcp.native_security.SCHEMAS["firefox_lab"]
        with self.assertRaises(ValueError):
            cyberful_os_mcp.validate_tool_arguments(
                firefox_schema,
                {"operation": "status", "unexpected": True},
            )

    def test_accepts_a_valid_inventory_call_without_starting_docker(self):
        with mock.patch.object(cyberful_os_mcp, "ensure_container") as ensure_container:
            result = cyberful_os_mcp.handle_tool_call({
                "name": "tool_inventory",
                "arguments": {"include_status": False},
            })

        self.assertFalse(result["isError"])
        self.assertGreater(json.loads(result["content"][0]["text"])["count"], 0)
        ensure_container.assert_not_called()

    def test_environment_booleans_are_explicit(self):
        name = "CYBERFUL_OS_BOOLEAN_BOUNDARY_TEST"
        with mock.patch.dict(os.environ, {name: "off"}, clear=False):
            self.assertFalse(cyberful_os_mcp.env_bool(name, True))
        with mock.patch.dict(os.environ, {name: "sometimes"}, clear=False):
            with self.assertRaisesRegex(ValueError, "must be one of"):
                cyberful_os_mcp.env_bool(name, False)

    def test_rejects_invalid_command_environment_before_process_start(self):
        with mock.patch.object(cyberful_os_mcp, "run_argv_in_container") as run_command:
            result = cyberful_os_mcp.handle_tool_call({
                "name": "nmap",
                "arguments": {"env": {"BAD=NAME": "value"}},
            })

        self.assertTrue(result["isError"])
        self.assertIn("invalid environment variable name", result["content"][0]["text"])
        run_command.assert_not_called()

    def test_rejects_multiple_egress_hosts_before_shell_execution(self):
        with mock.patch.object(cyberful_os_mcp, "run_in_container") as run_command:
            result = cyberful_os_mcp.handle_tool_call({
                "name": "shell",
                "arguments": {
                    "command": "true",
                    "egress": {"host": ["one.example.test", "two.example.test"]},
                },
            })

        self.assertTrue(result["isError"])
        error = json.loads(result["content"][0]["text"])["error"]
        self.assertEqual(error["code"], "INVALID_TOOL_ARGUMENTS")
        self.assertIn("expected string", error["hint"])
        run_command.assert_not_called()

    def test_shell_dispatch_preserves_command_cwd_timeout_output_and_environment(self):
        completed = cyberful_os_mcp.CommandResult(
            target="cyberful-os",
            command="printf stable",
            exit_code=0,
            timed_out=False,
            duration_ms=1,
            stdout="stable",
            stderr="",
            truncated=False,
        )
        with mock.patch.object(cyberful_os_mcp, "run_in_container", return_value=completed) as run_command:
            result = cyberful_os_mcp.handle_tool_call({
                "name": "shell",
                "arguments": {
                    "command": "printf stable",
                    "cwd": "/workspace/project",
                    "timeout_seconds": 17,
                    "max_output_bytes": 8192,
                    "env": {"CYBERFUL_TEST": "stable"},
                },
            })

        self.assertFalse(result["isError"])
        run_command.assert_called_once_with(
            "printf stable",
            cwd="/workspace/project",
            timeout_seconds=17,
            max_output_bytes=8192,
            extra_env={"CYBERFUL_TEST": "stable"},
        )

    def test_shell_accepts_declared_benign_nonzero_exit_codes(self):
        completed = cyberful_os_mcp.CommandResult(
            target="cyberful-os",
            command="grep absent fixture",
            exit_code=1,
            timed_out=False,
            duration_ms=1,
            stdout="",
            stderr="",
            truncated=False,
        )
        with mock.patch.object(cyberful_os_mcp, "run_in_container", return_value=completed):
            accepted = cyberful_os_mcp.handle_tool_call({
                "name": "shell",
                "arguments": {"command": "grep absent fixture", "accepted_exit_codes": [0, 1]},
            })
            rejected = cyberful_os_mcp.handle_tool_call({
                "name": "shell",
                "arguments": {"command": "grep absent fixture"},
            })

        self.assertFalse(accepted["isError"])
        self.assertIn("accepted_exit_code: true", accepted["content"][0]["text"])
        self.assertTrue(rejected["isError"])

    def test_shell_does_not_infer_egress_from_static_url_literals(self):
        metadata = cyberful_os_mcp._shell_egress_metadata(
            "rg 'https://www.w3.org/TR/CSP3/' local-source.js",
            None,
            120,
        )
        local = cyberful_os_mcp._shell_egress_metadata("rg fixture local-source.js", {"network": False}, 120)
        declared = cyberful_os_mcp._shell_egress_metadata(
            "curl --config request.txt",
            {"network": True, "host": "example.test", "method": "get", "path_family": "/api/123"},
            120,
        )

        self.assertEqual(metadata["observability"], "degraded")
        self.assertNotIn("host", metadata)
        self.assertEqual(local["observability"], "not_applicable")
        self.assertNotIn("host", local)
        self.assertEqual(declared["observability"], "declared")
        self.assertEqual(declared["host"], "example.test")
        self.assertEqual(declared["method"], "GET")


class StdioBoundaryTest(unittest.TestCase):
    def test_discards_an_oversized_line_and_resumes_at_the_next_request(self):
        records = list(cyberful_os_mcp.bounded_json_lines(io.BytesIO(b"123456789\n{}\n"), max_bytes=8))

        self.assertEqual(records[0].error, "input line exceeds 8 bytes")
        self.assertEqual(records[1].text, "{}")


class RetainedInputTest(unittest.TestCase):
    def test_html_parser_refuses_to_accumulate_an_oversized_match(self):
        class Element:
            name = "p"
            attrs = {}

            @staticmethod
            def get_text(*_args, **_kwargs):
                return "x" * (cyberful_os_mcp.MAX_LIBRARY_RESULT_CHARS + 100)

        class Soup:
            @staticmethod
            def select(_selector, **_kwargs):
                return [Element()]

        def beautiful_soup(*_args, **_kwargs):
            return Soup()

        def run_embedded(argv, **kwargs):
            previous_stdin = sys.stdin
            previous_stdout = sys.stdout
            previous_bs4 = sys.modules.get("bs4")
            capture = io.StringIO()
            sys.stdin = io.StringIO(kwargs["stdin"].decode("utf-8"))
            sys.stdout = capture
            sys.modules["bs4"] = types.SimpleNamespace(BeautifulSoup=beautiful_soup)
            try:
                exec(compile(argv[2], "<bs4-tool>", "exec"), {})
            finally:
                sys.stdin = previous_stdin
                sys.stdout = previous_stdout
                if previous_bs4 is None:
                    sys.modules.pop("bs4", None)
                else:
                    sys.modules["bs4"] = previous_bs4
            return cyberful_os_mcp.CommandResult(
                target="cyberful-os",
                command="python3",
                exit_code=0,
                timed_out=False,
                duration_ms=1,
                stdout=capture.getvalue(),
                stderr="",
                truncated=False,
            )

        with mock.patch.object(cyberful_os_mcp, "run_argv_in_container", run_embedded):
            result = cyberful_os_mcp.handle_bs4_tool({"html": "<p>x</p>", "selector": "p"})

        payload = _stdout_json(result)
        self.assertEqual(payload["items"], [])
        self.assertTrue(payload["result_truncated"])

    def test_requests_stops_decoding_after_the_requested_character_budget(self):
        request_options = {}

        class Response:
            url = "https://target.invalid/data"
            status_code = 200
            reason = "OK"
            headers = {"content-type": "text/plain"}
            encoding = "utf-8"
            history = []
            chunks_read = 0

            class Elapsed:
                @staticmethod
                def total_seconds():
                    return 0.01

            elapsed = Elapsed()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_content(self, **_kwargs):
                for chunk in (b"abcdefgh", b"ijklmnop"):
                    self.chunks_read += 1
                    yield chunk

        response = Response()

        with mock.patch.object(
            cyberful_os_mcp,
            "run_argv_in_container",
            _embedded_requests_runner(response, request_options),
        ):
            result = cyberful_os_mcp.handle_requests_tool({
                "url": "https://target.invalid/data",
                "max_body_chars": 5,
            })

        payload = _stdout_json(result)
        self.assertEqual(payload["body"], "abcde")
        self.assertTrue(payload["body_truncated"])
        self.assertEqual(response.chunks_read, 1)
        self.assertTrue(request_options["stream"])

    def test_requests_keeps_an_http_denial_when_body_streaming_degrades(self):
        request_options = {}

        class Response:
            url = "https://target.invalid/admin"
            status_code = 403
            reason = "Forbidden"
            headers = {"content-type": "text/plain"}
            encoding = "utf-8"
            history = []

            class Elapsed:
                @staticmethod
                def total_seconds():
                    return 0.01

            elapsed = Elapsed()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def iter_content(self, **_kwargs):
                yield b"partial denial"
                raise _FakeRequestException("stream reset after headers")

        response = Response()
        with mock.patch.object(
            cyberful_os_mcp,
            "run_argv_in_container",
            _embedded_requests_runner(response, request_options),
        ):
            result = cyberful_os_mcp.handle_requests_tool({
                "url": "https://target.invalid/admin",
                "method": "GET",
            })

        payload = _stdout_json(result)
        self.assertFalse(result["isError"])
        self.assertEqual(payload["status_code"], 403)
        self.assertFalse(payload["body_complete"])
        self.assertEqual(payload["body_error"], "_FakeRequestException")
        self.assertEqual(result["_meta"][cyberful_os_mcp.EGRESS_META_KEY]["status"], 403)

    def test_wordlist_scan_reports_when_a_broad_directory_hits_its_entry_cap(self):
        with tempfile.TemporaryDirectory() as root:
            for index in range(1001):
                pathlib.Path(root, f"empty-{index}").mkdir()

            with mock.patch.object(cyberful_os_mcp, "run_argv_in_container", _run_embedded_locally):
                result = cyberful_os_mcp.handle_wordlists({
                    "paths": [root],
                    "preview_lines": 0,
                    "max_files": 1,
                })

        payload = _stdout_json(result)
        self.assertEqual(payload["scanned_entries"], 1000)
        self.assertTrue(payload["scan_truncated"])
        self.assertFalse(payload["file_limit_reached"])

    def test_wordlist_preview_reads_only_a_bounded_file_prefix(self):
        with tempfile.TemporaryDirectory() as root:
            wordlist = pathlib.Path(root, "oversized.txt")
            wordlist.write_bytes(b"x" * (cyberful_os_mcp.MAX_WORDLIST_PREVIEW_FILE_BYTES + 100))

            with mock.patch.object(cyberful_os_mcp, "run_argv_in_container", _run_embedded_locally):
                result = cyberful_os_mcp.handle_wordlists({
                    "paths": [str(wordlist)],
                    "preview_lines": 1,
                    "max_files": 1,
                })

        payload = _stdout_json(result)
        self.assertEqual(
            len(payload["files"][0]["preview"][0]),
            cyberful_os_mcp.MAX_WORDLIST_PREVIEW_FILE_BYTES,
        )
        self.assertTrue(payload["files"][0]["preview_truncated"])


if __name__ == "__main__":
    unittest.main()
