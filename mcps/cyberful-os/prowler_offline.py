#!/opt/prowler-venv/bin/python
# ── Offline Prowler Launcher ─────────────────────────────────────────
# Reports the locally installed Prowler package version without invoking its
# network-backed version probe, then delegates provider scans unchanged to the
# pinned virtual-environment entrypoint.
# → mcps/cyberful-os/Dockerfile — installs this launcher as the public command.
# ─────────────────────────────────────────────────────────────────────

import os
import sys
from importlib.metadata import PackageNotFoundError, version as package_version


REAL_PROWLER = "/opt/prowler-venv/bin/prowler"


def main(argv: list[str]) -> int:
    if len(argv) == 2 and argv[1] in {"-v", "--version"}:
        try:
            installed_version = package_version("prowler")
        except PackageNotFoundError as exc:
            raise RuntimeError("the pinned Prowler package is not installed") from exc
        print(f"Prowler {installed_version}")
        return 0

    os.execv(REAL_PROWLER, [REAL_PROWLER, *argv[1:]])
    raise RuntimeError("Prowler process replacement returned unexpectedly")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
