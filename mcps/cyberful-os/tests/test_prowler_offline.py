# ── Offline Prowler Launcher Contract ────────────────────────────────
# Verifies routine version inspection remains local while real provider scans
# retain their exact argument vector through process replacement.
# → mcps/cyberful-os/prowler_offline.py — implements the tested launcher boundary.
# ─────────────────────────────────────────────────────────────────────

import importlib.util
import io
import pathlib
import unittest
from contextlib import redirect_stdout
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prowler_offline", ROOT / "prowler_offline.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load the offline Prowler launcher")
prowler_offline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prowler_offline)


class OfflineProwlerLauncherTest(unittest.TestCase):
    def test_image_smoke_reaches_only_the_offline_launcher(self) -> None:
        dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        copy_at = dockerfile.index("COPY prowler_offline.py /usr/local/bin/prowler")

        self.assertNotIn("ln -sf /opt/prowler-venv/bin/prowler", dockerfile)
        self.assertNotIn("prowler -v", dockerfile[:copy_at])
        self.assertIn("prowler -v", dockerfile[copy_at:])

    def test_version_flags_read_only_installed_metadata(self) -> None:
        for flag in ("-v", "--version"):
            with self.subTest(flag=flag), mock.patch.object(
                prowler_offline, "package_version", return_value="5.33.2"
            ) as read_version, mock.patch.object(prowler_offline.os, "execv") as execv:
                output = io.StringIO()
                with redirect_stdout(output):
                    exit_code = prowler_offline.main(["prowler", flag])

                self.assertEqual(exit_code, 0)
                self.assertEqual(output.getvalue(), "Prowler 5.33.2\n")
                read_version.assert_called_once_with("prowler")
                execv.assert_not_called()

    def test_scan_arguments_are_delegated_without_a_shell(self) -> None:
        with mock.patch.object(prowler_offline.os, "execv", side_effect=OSError("exec stopped")) as execv:
            with self.assertRaisesRegex(OSError, "exec stopped"):
                prowler_offline.main(["prowler", "aws", "--services", "iam", "s3"])

        execv.assert_called_once_with(
            prowler_offline.REAL_PROWLER,
            [prowler_offline.REAL_PROWLER, "aws", "--services", "iam", "s3"],
        )


if __name__ == "__main__":
    unittest.main()
