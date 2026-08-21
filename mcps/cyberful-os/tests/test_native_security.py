# ── Native Security Laboratory Contract Tests ────────────────────
# Exercises bounded state, lifecycle cleanup, evidence, and proxy enforcement
#   without requiring the heavyweight cyberful-os image.
# → mcps/cyberful-os/native_security.py — implements the tested operations.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import bz2
import gzip
import io
import lzma
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import MagicMock, call, patch
import zipfile

import native_security


class NativeSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temporary.name).resolve()
        self.patches = (
            patch.object(native_security, "WORKSPACE", self.workspace),
            patch.object(native_security, "STATE", self.workspace / "raw" / "native-security"),
            patch.object(native_security, "LABS", self.workspace / ".cyberful-native" / "labs"),
            patch.object(native_security, "SNAPSHOTS", self.workspace / ".cyberful-native" / "snapshots"),
            patch.dict(os.environ, {"CYBERFUL_OS_IN_CONTAINER": "1"}, clear=False),
        )
        for active_patch in self.patches:
            active_patch.start()

    def tearDown(self) -> None:
        native_security.shutdown()
        for active_patch in reversed(self.patches):
            active_patch.stop()
        self.temporary.cleanup()

    def test_firmware_manifest_is_workspace_bounded_and_recorded(self) -> None:
        source = self.workspace / "firmware"
        source.mkdir()
        (source / "version.txt").write_text("1.2.3\n", encoding="utf-8")
        result = native_security.invoke("firmware_lab", {"operation": "manifest", "path": str(source)})
        self.assertEqual(result["files"][0]["path"], "version.txt")
        self.assertTrue((self.workspace / result["evidence_path"]).is_file())
        with self.assertRaisesRegex(ValueError, "inside /workspace"):
            native_security.invoke("firmware_lab", {"operation": "manifest", "path": "/etc"})

    def test_native_lab_owns_processes_and_snapshots(self) -> None:
        native_security.invoke("native_lab", {"operation": "create", "lab_id": "owned"})
        started = native_security.invoke(
            "native_lab",
            {"operation": "start_process", "lab_id": "owned", "process_id": "wait", "argv": ["sleep", "30"]},
        )
        self.assertGreater(started["pid"], 0)
        native_security.invoke("native_lab", {"operation": "snapshot", "lab_id": "owned", "snapshot_id": "one"})
        stopped = native_security.invoke("native_lab", {"operation": "stop_process", "lab_id": "owned", "process_id": "wait"})
        self.assertTrue(stopped["stopped"])
        native_security.invoke("native_lab", {"operation": "destroy", "lab_id": "owned"})

    def test_native_debug_launch_starts_inferior_before_returning(self) -> None:
        target = self.workspace / "target"
        target.write_bytes(b"fixture")
        debugger = MagicMock()
        debugger.pid = 4242
        debugger.poll.return_value = None
        with (
            patch.object(native_security.subprocess, "Popen", return_value=debugger),
            patch.object(native_security, "_command", return_value="gdb-multiarch"),
            patch.object(
                native_security,
                "_gdb_read",
                side_effect=[
                    '=thread-group-added,id="i1"\n(gdb)\n',
                    "1^done\n(gdb)\n",
                    "2^done\n(gdb)\n",
                    '3^done\n*running,thread-id="all"\n*stopped,reason="breakpoint-hit"\n(gdb)\n',
                ],
            ),
        ):
            result = native_security.invoke(
                "native_debug",
                {"operation": "launch", "session_id": "started", "path": str(target), "target_args": ["one", "two words"]},
            )

        self.assertIn('*stopped,reason="breakpoint-hit"', result["output"])
        self.assertEqual(
            debugger.stdin.write.call_args_list,
            [
                call('1-interpreter-exec console "handle SIGSYS stop print nopass"\n'),
                call('2-exec-arguments "one" "two words"\n'),
                call('3-interpreter-exec console "starti"\n'),
            ],
        )
        self.assertIs(native_security.DEBUGGERS["started"], debugger)
        native_security.DEBUGGERS.pop("started")

    def test_native_debug_launch_failure_reaps_session(self) -> None:
        target = self.workspace / "target"
        target.write_bytes(b"fixture")
        debugger = MagicMock()
        debugger.pid = 4242
        debugger.poll.return_value = None
        with (
            patch.object(native_security.subprocess, "Popen", return_value=debugger),
            patch.object(native_security, "_command", return_value="gdb-multiarch"),
            patch.object(native_security, "_gdb_read", side_effect=["(gdb)\n", '1^error,msg="cannot configure"\n(gdb)\n']),
            self.assertRaisesRegex(ValueError, "debugger command failed"),
        ):
            native_security.invoke("native_debug", {"operation": "launch", "session_id": "failed", "path": str(target)})

        self.assertNotIn("failed", native_security.DEBUGGERS)
        debugger.stdin.write.assert_has_calls([
            call('1-interpreter-exec console "handle SIGSYS stop print nopass"\n'),
            call("-gdb-exit\n"),
        ])
        debugger.wait.assert_called_once_with(timeout=5)

    def test_remote_timing_requires_the_host_owned_proxy(self) -> None:
        with patch.dict(os.environ, {"HTTP_PROXY": "", "HTTPS_PROXY": ""}, clear=False):
            with self.assertRaisesRegex(ValueError, "host-owned HTTP proxy"):
                native_security.invoke(
                    "protocol_campaign",
                    {
                        "operation": "paired_timing",
                        "control_url": "https://example.com/control",
                        "candidate_url": "https://example.com/candidate",
                    },
                )

    def test_crash_deduplication_groups_normalized_reports(self) -> None:
        reports = self.workspace / "crashes"
        reports.mkdir()
        (reports / "one.txt").write_text("ASAN heap-use-after-free at 0x1234 pid 41\n", encoding="utf-8")
        (reports / "two.txt").write_text("ASAN heap-use-after-free at 0xabcd pid 99\n", encoding="utf-8")
        result = native_security.invoke("crash_triage", {"operation": "deduplicate", "path": str(reports)})
        self.assertEqual(result["result"]["files"], 2)
        self.assertEqual(result["result"]["groups"][0]["count"], 2)

    def test_appliance_operations_return_operation_specific_results(self) -> None:
        observations = [
            {"asset": "a", "banner": "Widget v1.2.3"},
            {"asset": "b", "banner": "Widget v1.2.3 build 7.8"},
        ]
        compared = native_security.invoke("appliance_fingerprint", {"operation": "compare_assets", "observations": observations})
        inferred = native_security.invoke("appliance_fingerprint", {"operation": "infer_version", "observations": observations})
        self.assertEqual(compared["result"]["shared_versions"], ["v1.2.3"])
        support = {item["version"]: item["support"] for item in inferred["result"]["candidates"]}
        self.assertEqual(support["v1.2.3"], 2)

    def test_fuzz_coverage_requires_a_target_and_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "requires path and argv"):
            native_security.invoke("fuzz_campaign", {"operation": "coverage", "campaign_id": "missing"})

    def test_native_static_analysis_rejects_elf_before_running_source_analyzers(self) -> None:
        binary = self.workspace / "fixture"
        binary.write_bytes(b"\x7fELF\x02\x01\x01\x00" + b"binary-fixture")

        with patch.object(native_security, "_run") as run:
            result = native_security.invoke(
                "native_static_analysis",
                {"operation": "run_checks", "path": str(binary), "timeout_seconds": 30},
            )

        run.assert_not_called()
        self.assertEqual(result["result"]["status"], "unsupported")
        self.assertEqual(result["result"]["input_kind"], "elf-binary")
        self.assertEqual(result["result"]["analyzers_invoked"], [])
        self.assertTrue((self.workspace / result["evidence_path"]).is_file())

    def test_native_static_analysis_runs_cppcheck_for_cpp_source(self) -> None:
        source = self.workspace / "fixture.cpp"
        source.write_text("int main() { return 0; }\n", encoding="utf-8")

        with patch.object(native_security, "_run", return_value={"exit_code": 0}) as run:
            result = native_security.invoke(
                "native_static_analysis",
                {"operation": "run_checks", "path": str(source), "timeout_seconds": 30},
            )

        run.assert_called_once_with(
            ["cppcheck", "--enable=warning,style,performance,portability", "--template=gcc", str(source)],
            timeout=30,
        )
        self.assertEqual(result["result"]["cppcheck"]["exit_code"], 0)

    def test_harness_validation_rejects_shell_syntax_before_process_start(self) -> None:
        source = self.workspace / "broken.sh"
        source.write_text("if true; then\n", encoding="utf-8")

        result = native_security.invoke("harness_validate", {"operation": "shell", "path": str(source)})

        self.assertFalse(result["valid"])
        with patch.object(native_security, "_automatic_harness_validation", return_value=result), patch.object(native_security.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(ValueError, "mandatory harness validation failed"):
                native_security.invoke(
                    "native_lab",
                    {"operation": "start_process", "lab_id": "validated", "argv": ["bash", str(source)]},
                )
        popen.assert_not_called()

    def test_archive_extract_retries_prepended_zip_with_native_7zip_and_publishes_atomically(self) -> None:
        source = self.workspace / "omni.ja"
        ordinary = self.workspace / "ordinary.zip"
        with zipfile.ZipFile(ordinary, "w") as archive:
            archive.writestr("modules/fixture.js", "ok")
        source.write_bytes(b"optimized-prefix" + ordinary.read_bytes())
        output = self.workspace / "omni"

        def run(argv, **_kwargs):
            if argv[0] == "unzip":
                return {"argv": argv, "exit_code": 2, "stdout": "", "stderr": "prepended bytes"}
            destination = Path(next(item[2:] for item in argv if item.startswith("-o")))
            (destination / "modules").mkdir(parents=True)
            (destination / "modules" / "fixture.js").write_text("ok", encoding="utf-8")
            return {"argv": argv, "exit_code": 0, "stdout": "ok", "stderr": ""}

        with patch.object(native_security, "_command", side_effect=lambda name: name), patch.object(native_security, "_run", side_effect=run):
            result = native_security.invoke(
                "archive_extract",
                {"operation": "extract", "path": str(source), "output": str(output)},
            )

        self.assertEqual(result["engine"], "7zz")
        self.assertTrue((output / "modules" / "fixture.js").is_file())
        self.assertEqual(list(self.workspace.glob(".cyberful-archive-*")), [])

    def test_archive_extract_rejects_zip_traversal_before_subprocess_start(self) -> None:
        source = self.workspace / "hostile.zip"
        with zipfile.ZipFile(source, "w") as archive:
            archive.writestr("../escaped.txt", "escaped")

        with patch.object(native_security, "_run") as run:
            with self.assertRaisesRegex(ValueError, "escapes its destination"):
                native_security.invoke(
                    "archive_extract",
                    {"operation": "extract", "path": str(source), "output": str(self.workspace / "zip-output")},
                )

        run.assert_not_called()
        self.assertFalse((self.workspace / "escaped.txt").exists())

    def test_archive_extract_inspects_and_extracts_tar_gzip_by_signature(self) -> None:
        source = self.workspace / "renamed-package.bin"
        payload = b"multi-format archive\n"
        with tarfile.open(source, "w:gz") as archive:
            member = tarfile.TarInfo("source/fixture.txt")
            member.size = len(payload)
            archive.addfile(member, io.BytesIO(payload))

        inspected = native_security.invoke("archive_extract", {"operation": "inspect", "path": str(source)})
        output = self.workspace / "unpacked"
        extracted = native_security.invoke(
            "archive_extract",
            {"operation": "extract", "path": str(source), "output": str(output)},
        )

        self.assertEqual(inspected["format"], "tar.gz")
        self.assertEqual(inspected["engine"], "tarfile")
        self.assertEqual(inspected["entries_preview"][0]["path"], "source/fixture.txt")
        self.assertEqual(extracted["format"], "tar.gz")
        self.assertEqual((output / "source" / "fixture.txt").read_bytes(), payload)
        self.assertEqual(list(self.workspace.glob(".cyberful-archive-*")), [])

    def test_archive_extract_distinguishes_tar_variants_and_nested_zip_bytes(self) -> None:
        fixtures = (("w", "tar"), ("w:bz2", "tar.bz2"), ("w:xz", "tar.xz"))
        for index, (mode, format_name) in enumerate(fixtures):
            with self.subTest(format=format_name):
                source = self.workspace / f"variant-{index}.bin"
                payload = b"PK\x03\x04nested archive bytes"
                with tarfile.open(source, mode) as archive:
                    member = tarfile.TarInfo("nested.bin")
                    member.size = len(payload)
                    archive.addfile(member, io.BytesIO(payload))
                output = self.workspace / f"variant-{index}"

                inspected = native_security.invoke("archive_extract", {"operation": "inspect", "path": str(source)})
                native_security.invoke(
                    "archive_extract",
                    {"operation": "extract", "path": str(source), "output": str(output)},
                )

                self.assertEqual(inspected["format"], format_name)
                self.assertEqual((output / "nested.bin").read_bytes(), payload)

    def test_archive_extract_rejects_tar_traversal_without_partial_output(self) -> None:
        source = self.workspace / "hostile.tar"
        with tarfile.open(source, "w") as archive:
            member = tarfile.TarInfo("../escaped.txt")
            member.size = 7
            archive.addfile(member, io.BytesIO(b"escaped"))
        output = self.workspace / "unpacked"

        with self.assertRaisesRegex(ValueError, "escapes its destination"):
            native_security.invoke(
                "archive_extract",
                {"operation": "extract", "path": str(source), "output": str(output)},
            )

        self.assertFalse(output.exists())
        self.assertFalse((self.workspace / "escaped.txt").exists())
        self.assertEqual(list(self.workspace.glob(".cyberful-archive-*")), [])

    def test_archive_extract_rejects_tar_links_during_inspection(self) -> None:
        source = self.workspace / "linked.tar"
        with tarfile.open(source, "w") as archive:
            member = tarfile.TarInfo("outside")
            member.type = tarfile.SYMTYPE
            member.linkname = "/etc/passwd"
            archive.addfile(member)

        with self.assertRaisesRegex(ValueError, "link or special member"):
            native_security.invoke("archive_extract", {"operation": "inspect", "path": str(source)})

    def test_archive_extract_handles_a_bounded_single_gzip_stream(self) -> None:
        source = self.workspace / "fixture.txt.gz"
        with gzip.open(source, "wb") as archive:
            archive.write(b"single stream\n")
        output = self.workspace / "stream"

        result = native_security.invoke(
            "archive_extract",
            {"operation": "extract", "path": str(source), "output": str(output)},
        )

        self.assertEqual(result["format"], "gzip")
        self.assertEqual(result["engine"], "gzip")
        self.assertEqual((output / "fixture.txt").read_bytes(), b"single stream\n")

    def test_archive_extract_handles_bzip2_and_xz_streams(self) -> None:
        fixtures = (("bzip2", ".bz2", bz2.open), ("xz", ".xz", lzma.open))
        for format_name, suffix, opener in fixtures:
            with self.subTest(format=format_name):
                source = self.workspace / f"{format_name}.txt{suffix}"
                with opener(source, "wb") as archive:
                    archive.write(format_name.encode("utf-8"))
                inspected = native_security.invoke("archive_extract", {"operation": "inspect", "path": str(source)})
                output = self.workspace / f"{format_name}-output"
                extracted = native_security.invoke(
                    "archive_extract",
                    {"operation": "extract", "path": str(source), "output": str(output)},
                )

                self.assertEqual(inspected["entries_preview"][0]["size"], len(format_name))
                self.assertEqual(extracted["format"], format_name)
                self.assertEqual((output / f"{format_name}.txt").read_text(encoding="utf-8"), format_name)

    def test_archive_extract_rejects_malformed_and_oversized_streams(self) -> None:
        malformed = self.workspace / "malformed.gz"
        malformed.write_bytes(b"\x1f\x8bnot-gzip")
        with self.assertRaisesRegex(ValueError, "archive stream failed with gzip"):
            native_security.invoke("archive_extract", {"operation": "inspect", "path": str(malformed)})

        oversized = self.workspace / "oversized.gz"
        with gzip.open(oversized, "wb") as archive:
            archive.write(b"12345")
        output = self.workspace / "oversized-output"
        with patch.object(native_security, "MAX_ARCHIVE_FILE_SIZE", 4):
            with self.assertRaisesRegex(ValueError, "per-file safety bound"):
                native_security.invoke(
                    "archive_extract",
                    {"operation": "extract", "path": str(oversized), "output": str(output)},
                )
        self.assertFalse(output.exists())
        self.assertEqual(list(self.workspace.glob(".cyberful-archive-*")), [])

    def test_archive_extract_validates_7zip_members_before_extraction(self) -> None:
        source = self.workspace / "fixture.7z"
        source.write_bytes(b"7z\xbc\xaf'\x1cfixture")
        output = self.workspace / "seven"
        listing = {
            "argv": ["7zz", "l"],
            "exit_code": 0,
            "stdout": "----------\nPath = source/fixture.c\nSize = 12\nAttributes = A\n",
            "stderr": "",
        }

        def run(argv, **_kwargs):
            if argv[1] == "l":
                return listing
            destination = Path(next(item[2:] for item in argv if item.startswith("-o")))
            (destination / "source").mkdir()
            (destination / "source" / "fixture.c").write_text("int main(){}", encoding="utf-8")
            return {"argv": argv, "exit_code": 0, "stdout": "ok", "stderr": ""}

        with patch.object(native_security, "_command", side_effect=lambda name: name), patch.object(native_security, "_run", side_effect=run):
            result = native_security.invoke(
                "archive_extract",
                {"operation": "extract", "path": str(source), "output": str(output)},
            )

        self.assertEqual(result["format"], "7z")
        self.assertEqual(result["engine"], "7zz")
        self.assertTrue((output / "source" / "fixture.c").is_file())

    def test_archive_extract_rejects_7zip_traversal_before_extraction(self) -> None:
        source = self.workspace / "hostile.7z"
        source.write_bytes(b"7z\xbc\xaf'\x1cfixture")
        listing = {
            "argv": ["7zz", "l"],
            "exit_code": 0,
            "stdout": "----------\nPath = ../escaped\nSize = 1\nAttributes = A\n",
            "stderr": "",
        }

        with patch.object(native_security, "_command", return_value="7zz"), patch.object(native_security, "_run", return_value=listing) as run:
            with self.assertRaisesRegex(ValueError, "escapes its destination"):
                native_security.invoke(
                    "archive_extract",
                    {"operation": "extract", "path": str(source), "output": str(self.workspace / "seven")},
                )

        run.assert_called_once()

    def test_archive_extract_cleans_up_after_7zip_subprocess_failure(self) -> None:
        source = self.workspace / "broken.7z"
        source.write_bytes(b"7z\xbc\xaf'\x1cfixture")
        listing = {
            "argv": ["7zz", "l"],
            "exit_code": 0,
            "stdout": "----------\nPath = source.c\nSize = 12\nAttributes = A\n",
            "stderr": "",
        }
        failure = {"argv": ["7zz", "x"], "exit_code": 2, "stdout": "", "stderr": "data error"}
        output = self.workspace / "broken-output"

        with patch.object(native_security, "_command", return_value="7zz"), patch.object(native_security, "_run", side_effect=[listing, failure]):
            with self.assertRaisesRegex(ValueError, "data error"):
                native_security.invoke(
                    "archive_extract",
                    {"operation": "extract", "path": str(source), "output": str(output)},
                )

        self.assertFalse(output.exists())
        self.assertEqual(list(self.workspace.glob(".cyberful-archive-*")), [])

    def test_archive_extract_expands_tar_zstd_as_a_tar_tree(self) -> None:
        source = self.workspace / "fixture.tar.zst"
        source.write_bytes(b"\x28\xb5\x2f\xfdfixture")
        output = self.workspace / "zstd-output"
        listing = {
            "argv": ["7zz", "l"],
            "exit_code": 0,
            "stdout": "----------\nPath = fixture.tar\nSize = 10240\nAttributes = A\n",
            "stderr": "",
        }

        def run(argv, **_kwargs):
            if argv[1] == "l":
                return listing
            destination = Path(next(item[2:] for item in argv if item.startswith("-o")))
            with tarfile.open(destination / "fixture.tar", "w") as archive:
                member = tarfile.TarInfo("source/fixture.c")
                member.size = 12
                archive.addfile(member, io.BytesIO(b"int main(){}"))
            return {"argv": argv, "exit_code": 0, "stdout": "ok", "stderr": ""}

        with patch.object(native_security, "_command", return_value="7zz"), patch.object(native_security, "_run", side_effect=run):
            inspected = native_security.invoke("archive_extract", {"operation": "inspect", "path": str(source)})
            result = native_security.invoke(
                "archive_extract",
                {"operation": "extract", "path": str(source), "output": str(output)},
            )

        self.assertEqual(inspected["engine"], "7zz+tarfile")
        self.assertEqual(inspected["entries_preview"][0]["path"], "source/fixture.c")
        self.assertEqual(result["format"], "tar.zst")
        self.assertEqual(result["engine"], "7zz+tarfile")
        self.assertEqual((output / "source" / "fixture.c").read_bytes(), b"int main(){}")
        self.assertEqual(list(self.workspace.glob(".cyberful-archive-*")), [])

    def test_debugger_sigsys_is_nopass_until_explicitly_changed(self) -> None:
        debugger = MagicMock()
        debugger.pid = 4242
        debugger.poll.return_value = None
        native_security.DEBUGGERS["signals"] = debugger
        native_security.DEBUGGER_STATES["signals"] = {
            "state": "stopped",
            "next_token": 1,
            "signal_policy": {"SIGSYS": {"stop": True, "print": True, "pass": False}},
        }
        with patch.object(native_security, "_gdb_read", return_value="1^done\n(gdb)\n"):
            result = native_security.invoke(
                "native_debug",
                {"operation": "signal_policy", "session_id": "signals", "signal": "SIGSYS", "pass": True},
            )

        self.assertTrue(result["signal_policy"]["SIGSYS"]["pass"])
        debugger.stdin.write.assert_called_once_with(
            '1-interpreter-exec console "handle SIGSYS stop print pass"\n'
        )
        native_security.DEBUGGERS.pop("signals")
        native_security.DEBUGGER_STATES.pop("signals")

    def test_marionette_normalizes_values_and_permission_requires_readback(self) -> None:
        sock = MagicMock()
        session = {"socket": sock, "next_id": 1, "context": "chrome"}
        with patch.object(native_security, "_marionette_packet", return_value=[1, 1, None, {"value": ["one", {"two": 2}]}]):
            self.assertEqual(native_security._marionette_command(session, "WebDriver:Example", {}), ["one", {"two": 2}])

        firefox = MagicMock()
        firefox.poll.return_value = None
        native_security.FIREFOX_SESSIONS["permission"] = {
            "firefox": firefox,
            "context": "content",
        }
        methods: list[str] = []

        def permission_command(_session: dict[str, object], method: str, _params: dict[str, object]) -> int | None:
            methods.append(method)
            return 1 if method == "WebDriver:ExecuteScript" else None

        with patch.object(native_security, "_marionette_command", side_effect=permission_command):
            result = native_security.invoke(
                "firefox_lab",
                {
                    "operation": "set_permission",
                    "session_id": "permission",
                    "origin": "https://example.test",
                    "permission": "clipboard-read",
                    "action": 1,
                },
            )
        self.assertEqual(result["result"], 1)
        self.assertEqual(methods, ["Marionette:SetContext", "WebDriver:ExecuteScript", "Marionette:SetContext"])
        native_security.FIREFOX_SESSIONS.pop("permission")

    def test_firefox_bidi_endpoint_is_consumed_verbatim_and_must_be_loopback(self) -> None:
        root = "ws://127.0.0.1:9222"
        session = "ws://127.0.0.1:9222/session/fixture"

        self.assertEqual(native_security._firefox_websocket_url({"webSocketUrl": root}), root)
        self.assertEqual(
            native_security._firefox_websocket_url({"capabilities": {"webSocketUrl": session}}),
            session,
        )
        with self.assertRaisesRegex(ValueError, "loopback"):
            native_security._firefox_websocket_url({"webSocketUrl": "ws://example.com:9222/session"})

    def test_firefox_handoff_to_bidi_preserves_owned_process_and_is_idempotent(self) -> None:
        firefox = MagicMock()
        firefox.pid = 4242
        firefox.poll.return_value = None
        sock = MagicMock()
        session = {
            "firefox": firefox,
            "socket": sock,
            "context": "content",
            "web_socket_url": "ws://127.0.0.1:9222/session/fixture",
            "handles": ["before"],
            "executable": Path("/workspace/firefox"),
            "build_sha256": "a" * 64,
        }
        native_security.FIREFOX_SESSIONS["bidi"] = session

        with (
            patch.object(native_security, "_marionette_command", return_value=["one", "two"]) as command,
            patch.object(native_security, "_firefox_process_identity", return_value={"inventory_state": "observed"}),
        ):
            result = native_security.invoke("firefox_lab", {"operation": "handoff_bidi", "session_id": "bidi"})
            repeated = native_security.invoke("firefox_lab", {"operation": "handoff_bidi", "session_id": "bidi"})
            with self.assertRaisesRegex(ValueError, "handed off"):
                native_security.invoke(
                    "firefox_lab",
                    {"operation": "navigate", "session_id": "bidi", "url": "about:blank"},
                )

        command.assert_called_once_with(session, "WebDriver:GetWindowHandles", {})
        sock.close.assert_called_once_with()
        self.assertFalse(result["marionette_active"])
        self.assertEqual(result["handles"], ["one", "two"])
        self.assertTrue(repeated["already_handed_off"])
        self.assertIsNone(firefox.poll())
        native_security.FIREFOX_SESSIONS.pop("bidi")

    def test_navigation_uses_content_context_and_restores_chrome(self) -> None:
        firefox = MagicMock()
        firefox.poll.return_value = None
        native_security.FIREFOX_SESSIONS["navigate"] = {"firefox": firefox, "context": "chrome"}
        methods: list[str] = []

        def navigation_command(_session: dict[str, object], method: str, _params: dict[str, object]) -> None:
            methods.append(method)

        with patch.object(native_security, "_marionette_command", side_effect=navigation_command):
            result = native_security.invoke(
                "firefox_lab",
                {"operation": "navigate", "session_id": "navigate", "url": "about:blank"},
            )

        self.assertEqual(result["context"], "content")
        self.assertEqual(methods, ["Marionette:SetContext", "WebDriver:Navigate", "Marionette:SetContext"])
        self.assertEqual(native_security.FIREFOX_SESSIONS["navigate"]["context"], "chrome")
        native_security.FIREFOX_SESSIONS.pop("navigate")

    def test_clipboard_owner_waits_for_targets_readiness(self) -> None:
        owner = MagicMock()
        owner.pid = 4242
        owner.poll.return_value = None
        readiness = subprocess.CompletedProcess(
            args=["xclip"],
            returncode=0,
            stdout=b"TARGETS\nUTF8_STRING\n",
            stderr=b"",
        )
        with (
            patch.object(native_security.subprocess, "Popen", return_value=owner),
            patch.object(native_security.subprocess, "run", return_value=readiness),
            patch.object(native_security, "_command", return_value="xclip"),
        ):
            result = native_security._set_clipboard_owner("fixture", ":99", b"synthetic")

        self.assertIs(result, owner)
        owner.stdin.write.assert_called_once_with(b"synthetic")
        owner.stdin.close.assert_called_once_with()
        self.assertIs(native_security.CLIPBOARD_OWNERS.pop("fixture"), owner)


if __name__ == "__main__":
    unittest.main()
