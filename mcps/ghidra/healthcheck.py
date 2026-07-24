#!/usr/bin/env python3
# ── Private Ghidra Runtime Health Probe ──────────────────────────
# Proves that the loopback listener accepts the engagement capability and can
# complete an MCP ping without publishing any host port.
# → mcps/ghidra/ghidra_mcp.py — serves the checked protocol.
# @docs/runtimes/ghidra.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import json
import os
import socket


def main() -> int:
    key = os.environ.get("CYBER_GHIDRA_MCP_KEY", "")
    port = int(os.environ.get("CYBER_GHIDRA_PORT", "47100"))
    if not key:
        return 1
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1) as connection:
            connection.sendall(key.encode("utf-8") + b"\n")
            connection.sendall(b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
            response = connection.makefile("rb").readline(4096)
        parsed = json.loads(response)
        return 0 if parsed.get("id") == 1 and parsed.get("result") == {} else 1
    except (OSError, ValueError, json.JSONDecodeError):
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
