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


class ToolSchemaBoundaryTest(unittest.TestCase):
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
            sys.modules["requests"] = types.SimpleNamespace(request=request)
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

        with mock.patch.object(cyberful_os_mcp, "run_argv_in_container", run_embedded):
            result = cyberful_os_mcp.handle_requests_tool({
                "url": "https://target.invalid/data",
                "max_body_chars": 5,
            })

        payload = _stdout_json(result)
        self.assertEqual(payload["body"], "abcde")
        self.assertTrue(payload["body_truncated"])
        self.assertEqual(response.chunks_read, 1)
        self.assertTrue(request_options["stream"])

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
