#!/usr/bin/env python3
# ── Offline HTTP Traffic Evidence Analysis ──────────────────────
# Snapshots bounded HAR files and emits deterministic structural evidence
#   without replaying requests or copying captured secret values.
# → cyberful/builtin/skills/analyze-http-traffic-evidence/assets/http-traffic-analysis.schema.json — input contract.
# → cyberful/builtin/skills/analyze-http-traffic-evidence/tests/test_analyze_http_traffic_evidence.py — boundary tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
from typing import Any, Final
from urllib.parse import parse_qsl, urlsplit


MAX_CONFIG_BYTES: Final = 262_144
MAX_FILES: Final = 32
MAX_TRANSACTIONS: Final = 10_000
MAX_TOTAL_BYTES: Final = 33_554_432
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_TIMEOUT_SECONDS: Final = 60
FIELDS: Final = frozenset({"$schema", "analysis_id", "scope_reference", "traffic_files", "max_transactions", "max_total_bytes", "timeout_seconds", "output_limit_bytes"})


class AnalysisError(ValueError):
    """Raised when HTTP evidence violates the offline analysis contract."""


def _deadline(deadline: float, stage: str) -> None:
    if time.monotonic() >= deadline:
        raise AnalysisError(f"analysis deadline expired during {stage}")


def _text(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnalysisError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 for character in normalized):
        raise AnalysisError(f"{label} exceeds its text boundary")
    return normalized


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise AnalysisError(f"{label} must be between {minimum} and {maximum}")
    return value


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise AnalysisError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise AnalysisError("paths must be relative and non-traversing")
    cursor = workspace
    for component in requested.parts:
        cursor /= component
        if cursor.is_symlink():
            raise AnalysisError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise AnalysisError("path escapes workspace") from error
    return resolved


def _snapshot(path: Path, maximum: int, deadline: float) -> bytes:
    if maximum < 1:
        raise AnalysisError("traffic files exceed max_total_bytes")
    expected = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(expected.st_mode) or expected.st_size > maximum:
        raise AnalysisError(f"{path.name} must be a bounded regular non-symlink file")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise AnalysisError(f"{path.name} changed before snapshot")
        chunks: list[bytes] = []
        observed = 0
        while True:
            _deadline(deadline, "input snapshot")
            chunk = os.read(descriptor, min(65_536, maximum - observed + 1))
            if not chunk:
                break
            observed += len(chunk)
            if observed > maximum or observed > expected.st_size:
                raise AnalysisError(f"{path.name} exceeds its byte boundary")
            chunks.append(chunk)
        final = os.fstat(descriptor)
        if observed != expected.st_size or (final.st_dev, final.st_ino, final.st_size) != (expected.st_dev, expected.st_ino, expected.st_size):
            raise AnalysisError(f"{path.name} changed during snapshot")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AnalysisError(f"{label} must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise AnalysisError(f"{label} must contain a JSON object")
    return value


def _config(value: dict[str, Any]) -> tuple[str, str, list[str], int, int, int, int]:
    if set(value) != FIELDS or value["$schema"] != "./http-traffic-analysis.schema.json":
        raise AnalysisError("input fields or schema identity are invalid")
    files = value["traffic_files"]
    if not isinstance(files, list) or not 1 <= len(files) <= MAX_FILES:
        raise AnalysisError("traffic_files must be a bounded non-empty array")
    normalized = [_text(item, "traffic_files[]", 1024) for item in files]
    if len(set(normalized)) != len(normalized):
        raise AnalysisError("traffic_files must not contain duplicates")
    return (
        _text(value["analysis_id"], "analysis_id", 256),
        _text(value["scope_reference"], "scope_reference", 512),
        sorted(normalized),
        _integer(value["max_transactions"], "max_transactions", 1, MAX_TRANSACTIONS),
        _integer(value["max_total_bytes"], "max_total_bytes", 1, MAX_TOTAL_BYTES),
        _integer(value["timeout_seconds"], "timeout_seconds", 1, MAX_TIMEOUT_SECONDS),
        _integer(value["output_limit_bytes"], "output_limit_bytes", 1024, MAX_OUTPUT_BYTES),
    )


def _headers(value: Any, label: str) -> list[str]:
    if not isinstance(value, list) or len(value) > 512:
        raise AnalysisError(f"{label} must be a bounded array")
    names = []
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise AnalysisError(f"{label} contains a malformed header")
        names.append(_text(item["name"], f"{label}[].name", 256).lower())
    return sorted(set(filter(None, names)))


def _body_size(message: dict[str, Any], *, response: bool) -> int:
    candidates = [message.get("bodySize")]
    if response and isinstance(message.get("content"), dict):
        candidates.append(message["content"].get("size"))
    values = [value for value in candidates if isinstance(value, int) and not isinstance(value, bool) and value >= 0]
    return max(values, default=0)


def _origin(parsed: Any) -> str:
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise AnalysisError("HAR request URL must use HTTP(S) with a host")
    try:
        port = parsed.port
    except ValueError as error:
        raise AnalysisError("HAR request URL contains an invalid port") from error
    effective = port or (443 if parsed.scheme == "https" else 80)
    host = parsed.hostname.lower()
    rendered = f"[{host}]" if ":" in host else host
    return f"{parsed.scheme}://{rendered}:{effective}"


def _transaction(entry: Any, source: str, index: int) -> dict[str, Any]:
    if not isinstance(entry, dict) or not isinstance(entry.get("request"), dict) or not isinstance(entry.get("response"), dict):
        raise AnalysisError(f"{source} entry {index} is malformed")
    request = entry["request"]
    response = entry["response"]
    method = _text(request.get("method"), "request.method", 32).upper()
    raw_url = _text(request.get("url"), "request.url", 8192)
    parsed = urlsplit(raw_url)
    origin = _origin(parsed)
    request_headers = _headers(request.get("headers", []), "request.headers")
    response_headers = _headers(response.get("headers", []), "response.headers")
    query_names = {name for name, _ in parse_qsl(parsed.query, keep_blank_values=True)}
    query_string = request.get("queryString", [])
    if not isinstance(query_string, list) or len(query_string) > 512:
        raise AnalysisError("request.queryString must be bounded")
    for item in query_string:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise AnalysisError("request.queryString contains a malformed item")
        query_names.add(_text(item["name"], "request.queryString[].name", 256))
    status = _integer(response.get("status"), "response.status", 0, 999)
    redirect_origin: str | None = None
    redirect = response.get("redirectURL")
    if isinstance(redirect, str) and redirect.strip():
        redirect_origin = _origin(urlsplit(redirect.strip()))
    content = response.get("content", {})
    if not isinstance(content, dict):
        raise AnalysisError("response.content must be an object")
    mime_type = content.get("mimeType", "")
    if not isinstance(mime_type, str) or len(mime_type) > 256:
        raise AnalysisError("response mime type is malformed")
    tags = []
    if "authorization" in request_headers:
        tags.append("request-has-authorization-header")
    if "set-cookie" in response_headers:
        tags.append("response-sets-cookie")
    if redirect_origin is not None and redirect_origin != origin:
        tags.append("cross-origin-redirect")
    if status >= 500:
        tags.append("server-error-status")
    elif status >= 400:
        tags.append("client-error-status")
    return {
        "source": source,
        "entry_index": index,
        "method": method,
        "origin": origin,
        "path": parsed.path or "/",
        "query_names": sorted(query_names),
        "request": {"header_names": request_headers, "body_bytes": _body_size(request, response=False)},
        "status": status,
        "status_class": f"{status // 100}xx" if 100 <= status <= 599 else "other",
        "mime_type": mime_type.strip().lower(),
        "response": {"header_names": response_headers, "body_bytes": _body_size(response, response=True)},
        "redirect_origin": redirect_origin,
        "evidence_tags": sorted(tags),
    }


def _analyze(config: dict[str, Any], input_digest: str, workspace: Path, deadline: float) -> tuple[dict[str, Any], int]:
    workspace = workspace.resolve(strict=True)
    analysis_id, scope_reference, files, max_transactions, max_bytes, timeout, output_limit = _config(config)
    sources = []
    transactions = []
    total_bytes = 0
    for relative in files:
        _deadline(deadline, "HAR enumeration")
        path = _confined(workspace, relative, exists=True)
        raw = _snapshot(path, max_bytes - total_bytes, deadline)
        total_bytes += len(raw)
        if total_bytes > max_bytes:
            raise AnalysisError("traffic files exceed max_total_bytes")
        document = _json(raw, relative)
        log = document.get("log")
        entries = log.get("entries") if isinstance(log, dict) else None
        if not isinstance(entries, list):
            raise AnalysisError(f"{relative} must contain HAR log.entries")
        if len(transactions) + len(entries) > max_transactions:
            raise AnalysisError("HAR entries exceed max_transactions")
        for index, entry in enumerate(entries):
            _deadline(deadline, "HAR normalization")
            transactions.append(_transaction(entry, relative, index))
        sources.append({"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "transactions": len(entries)})
    method_counts = Counter(item["method"] for item in transactions)
    status_counts = Counter(item["status_class"] for item in transactions)
    tag_counts = Counter(tag for item in transactions for tag in item["evidence_tags"])
    report = {
        "format": "cyberful.http-traffic-evidence.v1",
        "analysis_id": analysis_id,
        "scope_reference": scope_reference,
        "input_sha256": input_digest,
        "sources": sources,
        "transactions": transactions,
        "summary": {"transactions": len(transactions), "methods": dict(sorted(method_counts.items())), "status_classes": dict(sorted(status_counts.items())), "evidence_tags": dict(sorted(tag_counts.items()))},
        "limits": {"transactions": max_transactions, "input_bytes": max_bytes, "output_bytes": output_limit, "timeout_seconds": timeout},
        "interpretation": "Tags describe captured HTTP structure only; they are not vulnerability or server-effect verdicts.",
    }
    return report, output_limit


def _write(path: Path, value: dict[str, Any], limit: int, deadline: float) -> None:
    _deadline(deadline, "evidence serialization")
    raw = f"{json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode("utf-8")
    if len(raw) > limit:
        raise AnalysisError("HTTP evidence exceeds output_limit_bytes")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        _deadline(deadline, "evidence publication")
        os.link(temporary, path)
        Path(temporary).unlink()
        temporary = None
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze bounded HAR evidence offline")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    started = time.monotonic()
    try:
        workspace = _workspace(arguments.workspace)
        source = _confined(workspace, arguments.input, exists=True)
        output = _confined(workspace, arguments.output, exists=False)
        if output.exists() or output == source or not output.parent.is_dir():
            raise AnalysisError("output must be new, distinct, and below an existing directory")
        raw = _snapshot(source, MAX_CONFIG_BYTES, started + MAX_TIMEOUT_SECONDS)
        config = _json(raw, "input")
        timeout = _integer(config.get("timeout_seconds"), "timeout_seconds", 1, MAX_TIMEOUT_SECONDS)
        deadline = started + timeout
        report, limit = _analyze(config, hashlib.sha256(raw).hexdigest(), workspace, deadline)
        _write(output, report, limit, deadline)
    except (AnalysisError, OSError) as error:
        print(f"HTTP evidence analysis error: {error}", file=sys.stderr)
        return 2
    print(output.relative_to(workspace).as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
