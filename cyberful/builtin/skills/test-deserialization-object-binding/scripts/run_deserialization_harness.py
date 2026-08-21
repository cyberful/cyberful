#!/usr/bin/env python3
# ── Bounded Loopback Deserialization Harness ────────────────────────
# Sends harmless parser fixtures only to an exact authorized loopback origin
#   and records bounded raw transport evidence without claiming a differential.
# → cyberful/builtin/skills/test-deserialization-object-binding/scripts/manifest.json — execution limits and effects.
# → cyberful/builtin/skills/test-deserialization-object-binding/tests/test_run_deserialization_harness.py — loopback and boundary coverage.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
import errno
from functools import partial
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import resource
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Final
from urllib.parse import SplitResult, urlsplit


MAX_INPUT_BYTES: Final = 262_144
MAX_OUTPUT_BYTES: Final = 1_048_576
MAX_REQUESTS: Final = 8
MAX_BODY_BYTES: Final = 65_536
MAX_CAPTURE_BYTES: Final = 16_384
MAX_HEADER_BYTES: Final = 16_384
MAX_STDOUT_BYTES: Final = 64
MAX_STDERR_BYTES: Final = 4_096
MAX_TEXT: Final = 2_048
MAX_SECRET_BYTES: Final = 4_096
MAX_REQUEST_TIMEOUT_SECONDS: Final = 20
CAMPAIGN_TIMEOUT_SECONDS: Final = 120.0
SECRET_ENVIRONMENT: Final = frozenset(("CYBERFUL_LAB_AUTHORIZATION",))
FORMATS: Final = frozenset(("json", "yaml", "xml", "binary", "language-native", "custom"))
HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
PASSTHROUGH_ENVIRONMENT: Final = ("PATH", "TMPDIR")
NO_TELEMETRY_ENVIRONMENT: Final = {
    "DISABLE_UPDATE_CHECK": "true",
    "DO_NOT_TRACK": "1",
    "PDCP_API_KEY": "",
    "SEMGREP_SEND_METRICS": "off",
}


class HarnessError(ValueError):
    """Raised when input, authority, or execution violates the harness contract."""


@dataclass(frozen=True)
class Authority:
    authorization_reference: str
    allowed_origin: str
    max_requests: int
    request_timeout_seconds: int


@dataclass(frozen=True)
class DeserializationFixture:
    fixture_id: str
    format: str
    expected_boundary: str
    url: str
    content_type: str
    secret_headers: tuple[tuple[str, str], ...]
    body: bytes


@dataclass(frozen=True)
class ProcessResult:
    return_code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool
    limit_exceeded: str | None


def _text(value: Any, label: str, *, maximum: int = MAX_TEXT) -> str:
    if not isinstance(value, str) or not value.strip():
        raise HarnessError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 for character in normalized):
        raise HarnessError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _integer(value: Any, label: str, *, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise HarnessError(f"{label} must be an integer between {minimum} and {maximum}")
    return value


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise HarnessError("workspace must be an existing directory")
    return workspace


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise HarnessError("paths must be non-traversing and relative to the workspace")
    cursor = workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise HarnessError(f"path component is a symbolic link: {component}")
    resolved = (workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise HarnessError("path escapes the workspace") from error
    return resolved


def _read_json(workspace: Path, value: str) -> tuple[dict[str, Any], bytes, Path]:
    source = _confined_path(workspace, value, must_exist=True)
    metadata = source.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise HarnessError(f"input must be a regular file no larger than {MAX_INPUT_BYTES} bytes")
    raw = source.read_bytes()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise HarnessError("input must be UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise HarnessError("campaign input must be a JSON object")
    return payload, raw, source


def _parsed_http_url(value: str, label: str) -> SplitResult:
    parsed = urlsplit(_text(value, label))
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise HarnessError(f"{label} must be an HTTP(S) URL without credentials or fragment")
    try:
        parsed.port
    except ValueError as error:
        raise HarnessError(f"{label} contains an invalid port") from error
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise HarnessError(f"{label} must use a literal loopback IP instead of localhost")
    return parsed


def _origin(parsed: SplitResult) -> str:
    port = parsed.port or (80 if parsed.scheme == "http" else 443)
    host = (parsed.hostname or "").lower()
    authority = f"[{host}]" if ":" in host else host
    return f"{parsed.scheme.lower()}://{authority}:{port}"


def _is_loopback(parsed: SplitResult) -> bool:
    try:
        return ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        return False


def _secret_headers(value: Any, label: str) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, dict) or len(value) > len(SECRET_ENVIRONMENT):
        raise HarnessError(f"{label} must use only declared secret environment variables")
    normalized: list[tuple[str, str]] = []
    for raw_name, raw_environment in value.items():
        name = _text(raw_name, f"{label}.name", maximum=128)
        environment = _text(raw_environment, f"{label}.{name}", maximum=128)
        if not HEADER_NAME.fullmatch(name) or name.lower() in {"host", "content-length"} or environment not in SECRET_ENVIRONMENT:
            raise HarnessError(f"{label} contains an unsupported header or environment variable")
        normalized.append((name, environment))
    return tuple(sorted(normalized, key=lambda item: item[0].lower()))


def _body(value: Any, label: str) -> bytes:
    if not isinstance(value, str):
        raise HarnessError(f"{label} must be a base64 string")
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as error:
        raise HarnessError(f"{label} must be valid base64") from error
    if len(decoded) > MAX_BODY_BYTES:
        raise HarnessError(f"{label} exceeds the {MAX_BODY_BYTES}-byte limit")
    return decoded


# ── Complete Preflight Precedes Secret Resolution And Traffic ───
# Harness JSON can describe fixtures but cannot grant authority by itself. The
# runner validates affirmative loopback authority, every fixture, all limits,
# and every secret reference before reading secret values from the environment.
# This prevents a later invalid case from producing partial target traffic and
# keeps credentials outside serialized input and request evidence.
# ─────────────────────────────────────────────────────────────────
def _campaign(payload: dict[str, Any], workspace: Path) -> tuple[str, Authority, tuple[DeserializationFixture, ...]]:
    del workspace
    if set(payload) != {"$schema", "campaign_id", "authority", "fixtures"}:
        raise HarnessError("harness input contains missing or unknown fields")
    campaign_id = _text(payload["campaign_id"], "campaign_id", maximum=256)
    raw_authority = payload["authority"]
    required_authority = {"confirmed", "authorization_reference", "allowed_origin", "max_requests", "request_timeout_seconds"}
    if not isinstance(raw_authority, dict) or set(raw_authority) != required_authority or raw_authority["confirmed"] is not True:
        raise HarnessError("authority is malformed or unconfirmed")
    parsed_origin = _parsed_http_url(raw_authority["allowed_origin"], "authority.allowed_origin")
    if not _is_loopback(parsed_origin) or parsed_origin.path not in {"", "/"} or parsed_origin.query:
        raise HarnessError("authority.allowed_origin must be an exact loopback origin")
    allowed_origin = _origin(parsed_origin)
    max_requests = _integer(raw_authority["max_requests"], "authority.max_requests", minimum=1, maximum=MAX_REQUESTS)
    request_timeout = _integer(raw_authority["request_timeout_seconds"], "authority.request_timeout_seconds", minimum=1, maximum=MAX_REQUEST_TIMEOUT_SECONDS)
    raw_fixtures = payload["fixtures"]
    required_fixture = {"fixture_id", "format", "expected_boundary", "url", "content_type", "secret_headers", "body_base64"}
    if not isinstance(raw_fixtures, list) or not raw_fixtures or len(raw_fixtures) > max_requests:
        raise HarnessError("fixtures must be non-empty and not exceed authority.max_requests")
    secret_headers_by_fixture: list[tuple[tuple[str, str], ...]] = []
    for index, raw_fixture in enumerate(raw_fixtures):
        if not isinstance(raw_fixture, dict) or set(raw_fixture) != required_fixture:
            raise HarnessError(f"fixtures[{index}] contains missing or unknown fields")
        secret_headers_by_fixture.append(_secret_headers(raw_fixture["secret_headers"], f"fixtures[{index}].secret_headers"))
    fixtures: list[DeserializationFixture] = []
    for index, (raw_fixture, secret_headers) in enumerate(zip(raw_fixtures, secret_headers_by_fixture, strict=True)):
        label = f"fixtures[{index}]"
        url = _text(raw_fixture["url"], f"{label}.url")
        parsed = _parsed_http_url(url, f"{label}.url")
        if not _is_loopback(parsed) or _origin(parsed) != allowed_origin:
            raise HarnessError(f"{label}.url is outside the exact loopback authority")
        fixture_format = _text(raw_fixture["format"], f"{label}.format", maximum=32)
        if fixture_format not in FORMATS:
            raise HarnessError(f"{label}.format is unsupported")
        content_type = _text(raw_fixture["content_type"], f"{label}.content_type", maximum=256)
        if "\r" in content_type or "\n" in content_type:
            raise HarnessError(f"{label}.content_type contains a control character")
        fixtures.append(DeserializationFixture(
            _text(raw_fixture["fixture_id"], f"{label}.fixture_id", maximum=128),
            fixture_format,
            _text(raw_fixture["expected_boundary"], f"{label}.expected_boundary", maximum=256),
            url,
            content_type,
            secret_headers,
            _body(raw_fixture["body_base64"], f"{label}.body_base64"),
        ))
    if len({fixture.fixture_id for fixture in fixtures}) != len(fixtures):
        raise HarnessError("fixture_id values must be unique")
    authority = Authority(_text(raw_authority["authorization_reference"], "authority.authorization_reference"), allowed_origin, max_requests, request_timeout)
    return campaign_id, authority, tuple(fixtures)


def _resolved_secrets(fixtures: tuple[DeserializationFixture, ...]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for fixture in fixtures:
        for _, environment in fixture.secret_headers:
            if environment in resolved:
                continue
            secret = os.environ.get(environment)
            if not secret or len(secret.encode("utf-8")) > MAX_SECRET_BYTES or any(ord(character) < 32 or ord(character) == 127 for character in secret):
                raise HarnessError(f"required secret environment variable is absent or invalid: {environment}")
            resolved[environment] = secret
    return resolved


def _process_environment() -> dict[str, str]:
    environment = {key: os.environ[key] for key in PASSTHROUGH_ENVIRONMENT if os.environ.get(key)}
    environment.setdefault("PATH", "/usr/bin:/bin")
    environment.update({"LANG": "C", "LC_ALL": "C", **NO_TELEMETRY_ENVIRONMENT})
    return environment


def _signal_group(process_group: int, signal_number: int) -> None:
    try:
        os.killpg(process_group, signal_number)
    except ProcessLookupError:
        return
    except OSError as error:
        if error.errno != errno.ESRCH:
            raise


def _terminate_group(process: subprocess.Popen[bytes]) -> None:
    _signal_group(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    _signal_group(process.pid, signal.SIGKILL)
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired as error:
        raise HarnessError("curl process group could not be reaped") from error


def _limit_child_files(maximum: int) -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))


def _run_process(argv: list[str], deadline: float, monitored_files: tuple[tuple[Path, int, str], ...]) -> ProcessResult:
    file_limit = min((maximum for _, maximum, _ in monitored_files), default=MAX_CAPTURE_BYTES)
    try:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=_process_environment(), shell=False, start_new_session=True, preexec_fn=partial(_limit_child_files, file_limit))
    except (OSError, subprocess.SubprocessError) as error:
        raise HarnessError(f"could not start fixed curl command: {error}") from error
    if process.stdout is None or process.stderr is None:
        _terminate_group(process)
        raise HarnessError("curl output pipes were not created")
    streams = {process.stdout: ("stdout", MAX_STDOUT_BYTES), process.stderr: ("stderr", MAX_STDERR_BYTES)}
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    selector = selectors.DefaultSelector()
    for stream in streams:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    timed_out = False
    exceeded: str | None = None
    try:
        while selector.get_map() or process.poll() is None:
            for path, maximum, label in monitored_files:
                try:
                    if path.stat().st_size >= maximum:
                        exceeded = label
                        break
                except FileNotFoundError:
                    continue
            if exceeded is not None:
                _terminate_group(process)
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                _terminate_group(process)
                break
            for key, _ in selector.select(timeout=min(0.01, remaining)):
                stream = key.fileobj
                name, maximum = streams[stream]
                try:
                    chunk = os.read(stream.fileno(), 65_536)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(stream)
                    stream.close()
                    continue
                available = maximum - len(buffers[name])
                buffers[name].extend(chunk[:max(0, available)])
                if len(chunk) > available:
                    exceeded = name
                    _terminate_group(process)
                    break
            if exceeded is not None:
                break
        if process.poll() is None:
            process.wait(timeout=1.0)
    finally:
        selector.close()
        for stream in streams:
            if not stream.closed:
                stream.close()
        if process.poll() is None:
            _terminate_group(process)
    return ProcessResult(process.returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"]), timed_out, exceeded)


def _curl_quote(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _bounded_file(path: Path, maximum: int) -> tuple[bytes, bool, int]:
    if not path.exists():
        return b"", False, 0
    size = path.stat().st_size
    with path.open("rb") as stream:
        content = stream.read(maximum + 1)
    return content[:maximum], len(content) > maximum or size > maximum, size


def _redact(content: bytes, secrets: tuple[str, ...], maximum: int) -> tuple[bytes, int, bool]:
    redacted = content
    count = 0
    for secret in secrets:
        occurrences = redacted.count(secret.encode("utf-8"))
        if occurrences:
            redacted = redacted.replace(secret.encode("utf-8"), b"[REDACTED_SECRET]")
            count += occurrences
    return redacted[:maximum], count, len(redacted) > maximum


def _execute_fixture(fixture: DeserializationFixture, authority: Authority, secrets: dict[str, str], global_deadline: float) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="cyberful-deserialization-") as directory:
        temporary = Path(directory)
        headers_path = temporary / "headers.bin"
        body_path = temporary / "body.bin"
        request_path = temporary / "request.bin"
        config_path = temporary / "curl.conf"
        request_path.write_bytes(fixture.body)
        os.chmod(request_path, 0o600)
        resolved_headers = tuple((name, environment, secrets[environment]) for name, environment in fixture.secret_headers)
        config_lines = [f'header = "Content-Type: {_curl_quote(fixture.content_type)}"']
        config_lines.extend(f'header = "{_curl_quote(name)}: {_curl_quote(value)}"' for name, _, value in resolved_headers)
        config_path.write_text("\n".join(config_lines) + ("\n" if config_lines else ""), encoding="utf-8")
        os.chmod(config_path, 0o600)
        argv = [
            "curl", "--disable", "--silent", "--show-error", "--path-as-is", "--proto", "=http,https", "--proto-redir", "=http,https",
            "--request", "POST", "--url", fixture.url, "--connect-timeout", str(min(10, authority.request_timeout_seconds)),
            "--max-time", str(authority.request_timeout_seconds), "--max-filesize", str(MAX_CAPTURE_BYTES), "--dump-header", str(headers_path),
            "--output", str(body_path), "--write-out", "%{http_code}", "--config", str(config_path),
        ]
        argv.extend(("--proxy", ""))
        if fixture.body:
            argv.extend(("--data-binary", f"@{request_path}"))
        started = time.monotonic()
        deadline = min(global_deadline, started + authority.request_timeout_seconds + 2.0)
        process = _run_process(argv, deadline, ((headers_path, MAX_HEADER_BYTES, "response headers"), (body_path, MAX_CAPTURE_BYTES, "response body")))
        raw_headers, headers_truncated, header_size = _bounded_file(headers_path, MAX_HEADER_BYTES)
        raw_body, body_truncated, body_size = _bounded_file(body_path, MAX_CAPTURE_BYTES)
        secret_values = tuple(value for _, _, value in resolved_headers)
        raw_headers, header_redactions, redacted_headers_truncated = _redact(raw_headers, secret_values, MAX_HEADER_BYTES)
        raw_body, body_redactions, redacted_body_truncated = _redact(raw_body, secret_values, MAX_CAPTURE_BYTES)
        stderr, stderr_redactions, _ = _redact(process.stderr, secret_values, MAX_STDERR_BYTES)
        status_text = process.stdout.decode("ascii", errors="replace").strip()
        request_material = json.dumps({"method": "POST", "url": fixture.url, "content_type": fixture.content_type, "secret_header_hashes": [(name, hashlib.sha256(value.encode()).hexdigest()) for name, _, value in resolved_headers], "body_sha256": hashlib.sha256(fixture.body).hexdigest()}, sort_keys=True, separators=(",", ":")).encode()
        return {
            "fixture_id": fixture.fixture_id,
            "format": fixture.format,
            "expected_boundary": fixture.expected_boundary,
            "request": {
                "method": "POST",
                "url": fixture.url,
                "content_type": fixture.content_type,
                "secret_headers": [{"name": name, "environment": environment, "value_sha256": hashlib.sha256(value.encode()).hexdigest()} for name, environment, value in resolved_headers],
                "body_bytes": len(fixture.body),
                "body_sha256": hashlib.sha256(fixture.body).hexdigest(),
                "request_sha256": hashlib.sha256(request_material).hexdigest(),
            },
            "transport": {
                "return_code": process.return_code,
                "timed_out": process.timed_out,
                "limit_exceeded": process.limit_exceeded,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "http_status": int(status_text) if status_text.isdigit() and len(status_text) == 3 else None,
                "route": "direct-loopback",
                "stderr": stderr.decode("utf-8", errors="replace"),
                "stderr_redactions": stderr_redactions,
            },
            "response": {
                "headers_base64": base64.b64encode(raw_headers).decode(),
                "headers_bytes": header_size,
                "headers_truncated": headers_truncated or redacted_headers_truncated or process.limit_exceeded == "response headers",
                "headers_redactions": header_redactions,
                "body_base64": base64.b64encode(raw_body).decode(),
                "body_bytes": body_size,
                "body_truncated": body_truncated or redacted_body_truncated or process.limit_exceeded == "response body",
                "body_redactions": body_redactions,
            },
        }


def run_harness(payload: dict[str, Any], workspace: Path, source_sha256: str) -> dict[str, Any]:
    campaign_id, authority, fixtures = _campaign(payload, workspace)
    secrets = _resolved_secrets(fixtures)
    deadline = time.monotonic() + CAMPAIGN_TIMEOUT_SECONDS
    results: list[dict[str, Any]] = []
    for fixture in fixtures:
        results.append(_execute_fixture(fixture, authority, secrets, deadline))
        if time.monotonic() >= deadline:
            raise HarnessError("campaign exceeded its global deadline")
    return {
        "format": "cyberful.deserialization-evidence.v1",
        "campaign_id": campaign_id,
        "authorization_reference": authority.authorization_reference,
        "source_sha256": source_sha256,
        "limits": {"requests": authority.max_requests, "concurrency": 1, "request_timeout_seconds": authority.request_timeout_seconds, "campaign_timeout_seconds": int(CAMPAIGN_TIMEOUT_SECONDS), "network": "loopback"},
        "fixtures": results,
        "interpretation": "Raw bounded loopback harness observations only; prove unexpected reconstruction and a harmless effect before claiming unsafe deserialization or binding.",
    }


def _report_path(workspace: Path, value: str, source: Path) -> Path:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination == source or not destination.parent.is_dir():
        raise HarnessError("output must be distinct and have an existing parent")
    return destination


def _write_report(destination: Path, report: dict[str, Any]) -> None:
    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode()
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise HarnessError(f"rendered evidence exceeds {MAX_OUTPUT_BYTES} bytes")
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=destination.parent, prefix=f".{destination.name}.", delete=False) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary_name, 0o600)
            temporary.write(rendered)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, destination)
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run bounded deserialization fixtures against an authorized loopback lab.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw, source = _read_json(workspace, arguments.input)
        destination = _report_path(workspace, arguments.output, source)
        _write_report(destination, run_harness(payload, workspace, hashlib.sha256(raw).hexdigest()))
    except (HarnessError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
