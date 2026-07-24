# ── cyberful-os MCP Framing ──────────────────────────────────────────
# Bounds JSON-RPC stdio lines before decoding and validates the request envelope
# independently from Docker execution and the public tool catalog.
# → mcps/cyberful-os/cyberful_os_mcp.py — owns request dispatch.
# ─────────────────────────────────────────────────────────────────────

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, BinaryIO, Callable, Iterator


@dataclass(frozen=True)
class InputLine:
    text: str | None = None
    error: str | None = None


def bounded_json_lines(stream: BinaryIO, max_bytes: int) -> Iterator[InputLine]:
    if type(max_bytes) is not int or max_bytes < 1:
        raise ValueError("max_bytes must be a positive integer")
    while True:
        raw = stream.readline(max_bytes + 1)
        if not raw:
            return
        has_newline = raw.endswith(b"\n")
        if len(raw) > max_bytes and not has_newline:
            while raw and not raw.endswith(b"\n"):
                raw = stream.readline(64 * 1024)
            yield InputLine(error=f"input line exceeds {max_bytes} bytes")
            continue
        payload = raw[:-1] if has_newline else raw
        if payload.endswith(b"\r"):
            payload = payload[:-1]
        try:
            yield InputLine(text=payload.decode("utf-8", errors="strict"))
        except UnicodeDecodeError:
            yield InputLine(error="input line is not valid UTF-8")


def request_envelope_error(message: Any, validate_json: Callable[[Any], None]) -> str | None:
    try:
        validate_json(message)
    except ValueError as exc:
        return str(exc).replace("invalid tool arguments at ", "invalid request at ", 1)
    if not isinstance(message, dict):
        return "request must be an object"
    if message.get("jsonrpc") != "2.0":
        return 'jsonrpc must equal "2.0"'
    method = message.get("method")
    if not isinstance(method, str) or not method or len(method) > 128:
        return "method must be a non-empty string of at most 128 characters"
    params = message.get("params")
    if "params" in message and not isinstance(params, dict):
        return "params must be an object"
    message_id = message.get("id")
    if "id" in message and message_id is not None and type(message_id) not in {str, int}:
        return "id must be a string, integer, null, or omitted"
    return None


def reject_nonfinite_json(value: str) -> None:
    raise ValueError(f"non-finite JSON number {value} is not allowed")
