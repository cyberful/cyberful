#!/usr/bin/env python3
# ── Authenticated Ghidra MCP Byte Bridge ─────────────────────────
# Connects stdio to the private Ghidra TCP listener after presenting the
# engagement capability key. It never parses, logs, or persists MCP payloads.
# → mcps/ghidra/ghidra_mcp.py — accepts the private authenticated stream.
# @docs/runtimes/ghidra.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import os
import selectors
import signal
import socket
import sys
from types import FrameType

MAX_KEY_LENGTH = 128
READ_SIZE = 64 * 1024


def environment_port() -> int:
    source = os.environ.get("CYBER_GHIDRA_PORT", "47100")
    if not source.isdecimal():
        raise ValueError("CYBER_GHIDRA_PORT must be a decimal integer")
    port = int(source)
    if port < 1 or port > 65_535:
        raise ValueError("CYBER_GHIDRA_PORT must be between 1 and 65535")
    return port


def capability_key() -> str:
    key = os.environ.get("CYBER_GHIDRA_MCP_KEY", "")
    if not 32 <= len(key) <= MAX_KEY_LENGTH or any(character.isspace() for character in key):
        raise ValueError("CYBER_GHIDRA_MCP_KEY is missing or malformed")
    return key


def write_all(writer: object, payload: bytes) -> None:
    if hasattr(writer, "sendall"):
        writer.sendall(payload)  # type: ignore[union-attr]
        return
    stream = writer
    stream.write(payload)  # type: ignore[union-attr]
    stream.flush()  # type: ignore[union-attr]


def bridge() -> None:
    host = os.environ.get("CYBER_GHIDRA_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1"}:
        raise ValueError("CYBER_GHIDRA_HOST must be loopback")
    connection = socket.create_connection((host, environment_port()), timeout=10)
    connection.settimeout(None)
    write_all(connection, capability_key().encode("utf-8") + b"\n")

    selector = selectors.DefaultSelector()
    selector.register(sys.stdin.buffer, selectors.EVENT_READ, "stdin")
    selector.register(connection, selectors.EVENT_READ, "socket")
    stdin_open = True

    def stop(_signum: int, _frame: FrameType | None) -> None:
        connection.close()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        while True:
            for key, _mask in selector.select():
                if key.data == "stdin":
                    chunk = os.read(sys.stdin.fileno(), READ_SIZE)
                    if chunk:
                        write_all(connection, chunk)
                        continue
                    selector.unregister(sys.stdin.buffer)
                    stdin_open = False
                    connection.shutdown(socket.SHUT_WR)
                    continue
                chunk = connection.recv(READ_SIZE)
                if not chunk:
                    return
                write_all(sys.stdout.buffer, chunk)
            if not stdin_open and connection.fileno() < 0:
                return
    finally:
        selector.close()
        connection.close()


def main() -> int:
    try:
        bridge()
        return 0
    except (OSError, ValueError) as error:
        print(f"ghidra bridge failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
