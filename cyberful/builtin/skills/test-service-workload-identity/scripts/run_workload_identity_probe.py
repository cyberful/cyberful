#!/usr/bin/env python3
# ── Bounded Workload Identity Probe ─────────────────────────────
# Executes pre-authorized workload HTTP controls through a fixed curl command
#   and preserves bounded, secret-redacted raw transport evidence.
# → cyberful/builtin/skills/test-service-workload-identity/scripts/manifest.json — execution contract.
# → cyberful/builtin/skills/test-service-workload-identity/assets/workload-identity-probe.schema.json — input contract.
# → cyberful/builtin/skills/test-service-workload-identity/tests/test_run_workload_identity_probe.py — loopback and refusal coverage.
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
MAX_RESPONSE_BYTES: Final = 32_768
MAX_HEADER_BYTES: Final = 32_768
MAX_STDOUT_BYTES: Final = 64
MAX_STDERR_BYTES: Final = 4_096
MAX_VERSION_BYTES: Final = 4_096
MAX_TEXT: Final = 2_048
MAX_TIMEOUT_SECONDS: Final = 20
MAX_CAMPAIGN_SECONDS: Final = 120
MAX_RATE: Final = 4.0
METHODS: Final = frozenset(("GET", "HEAD", "POST"))
SECRET_ENVIRONMENT: Final = frozenset(("CYBERFUL_WORKLOAD_AUTHORIZATION", "CYBERFUL_WORKLOAD_ASSERTION"))
SENSITIVE_HEADERS: Final = frozenset(("authorization", "cookie", "proxy-authorization"))
PASSTHROUGH_ENVIRONMENT: Final = (
    "PATH", "TMPDIR", "SSL_CERT_FILE", "CURL_CA_BUNDLE", "HTTP_PROXY", "HTTPS_PROXY",
)
PROXY_ENVIRONMENT: Final = {"http": "HTTP_PROXY", "https": "HTTPS_PROXY"}
NO_TELEMETRY_ENVIRONMENT: Final = {
    "DISABLE_UPDATE_CHECK": "true",
    "DO_NOT_TRACK": "1",
    "GRYPE_CHECK_FOR_APP_UPDATE": "false",
    "PDCP_API_KEY": "",
    "SEMGREP_SEND_METRICS": "off",
    "SYFT_CHECK_FOR_APP_UPDATE": "false",
}
HEADER_NAME = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")


class ProbeError(ValueError):
    """Raised when input, authority, or execution violates the probe contract."""


@dataclass(frozen=True)
class Authority:
    authorization_reference: str
    allowed_origins: frozenset[str]
    max_requests: int
    requests_per_second: float
    request_timeout_seconds: int
    campaign_timeout_seconds: int


@dataclass(frozen=True)
class WorkloadCase:
    case_id: str
    workload: str
    issuer: str
    subject: str
    audience: str
    tenant: str | None
    expected_binding: str
    method: str
    url: str
    headers: tuple[tuple[str, str], ...]
    secret_headers: tuple[tuple[str, str], ...]
    body: bytes


@dataclass(frozen=True)
class ProcessResult:
    return_code: int
    stdout: bytes
    stderr: bytes
    timed_out: bool
    limit_exceeded: str | None


def _text(value: Any, label: str, *, maximum: int = MAX_TEXT, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ProbeError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 for character in normalized):
        raise ProbeError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _integer(value: Any, label: str, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ProbeError(f"{label} must be an integer between {minimum} and {maximum}")
    return value


def _number(value: Any, label: str, minimum: float, maximum: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ProbeError(f"{label} must be a number")
    normalized = float(value)
    if not minimum <= normalized <= maximum:
        raise ProbeError(f"{label} must be between {minimum} and {maximum}")
    return normalized


def _workspace(value: str) -> Path:
    workspace = Path(value).resolve(strict=True)
    if not workspace.is_dir():
        raise ProbeError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, must_exist: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise ProbeError("paths must be non-traversing and relative to the workspace")
    cursor = workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise ProbeError(f"path component is a symbolic link: {component}")
    resolved = (workspace / requested).resolve(strict=must_exist)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise ProbeError("path escapes the workspace") from error
    return resolved


def _read_json(workspace: Path, value: str) -> tuple[dict[str, Any], bytes, Path]:
    source = _confined(workspace, value, must_exist=True)
    metadata = source.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise ProbeError(f"input must be a regular file no larger than {MAX_INPUT_BYTES} bytes")
    raw = source.read_bytes()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProbeError("input must be UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise ProbeError("probe input must be a JSON object")
    return payload, raw, source


def _http_url(value: Any, label: str) -> tuple[str, SplitResult]:
    normalized = _text(value, label)
    assert isinstance(normalized, str)
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ProbeError(f"{label} must be an HTTP(S) URL without credentials or fragment")
    try:
        parsed.port
    except ValueError as error:
        raise ProbeError(f"{label} contains an invalid port") from error
    return normalized, parsed


def _origin(parsed: SplitResult) -> str:
    port = parsed.port or (80 if parsed.scheme == "http" else 443)
    return f"{parsed.scheme.lower()}://{parsed.hostname.lower()}:{port}"


def _loopback(parsed: SplitResult) -> bool:
    if parsed.hostname is None:
        return False
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return False


def _secret_headers(value: Any, label: str) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, dict) or len(value) > len(SECRET_ENVIRONMENT):
        raise ProbeError(f"{label} must use at most {len(SECRET_ENVIRONMENT)} declared secret variables")
    normalized: list[tuple[str, str]] = []
    for raw_name, raw_environment in value.items():
        name = _text(raw_name, f"{label}.name", maximum=128)
        environment = _text(raw_environment, f"{label}.{name}", maximum=128)
        assert isinstance(name, str) and isinstance(environment, str)
        if not HEADER_NAME.fullmatch(name) or name.lower() in {"host", "content-length"}:
            raise ProbeError(f"{label} contains a forbidden header name: {name}")
        if environment not in SECRET_ENVIRONMENT:
            raise ProbeError(f"{label} contains an undeclared secret variable")
        normalized.append((name, environment))
    return tuple(sorted(normalized, key=lambda item: item[0].lower()))


def _headers(value: Any, label: str, reserved: frozenset[str]) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, dict) or len(value) > 24:
        raise ProbeError(f"{label} must contain at most 24 headers")
    normalized: list[tuple[str, str]] = []
    for raw_name, raw_value in value.items():
        name = _text(raw_name, f"{label}.name", maximum=128)
        header_value = _text(raw_value, f"{label}.{name}")
        assert isinstance(name, str) and isinstance(header_value, str)
        if not HEADER_NAME.fullmatch(name) or name.lower() in {"host", "content-length"} | SENSITIVE_HEADERS | reserved:
            raise ProbeError(f"{label} contains a forbidden header name: {name}")
        normalized.append((name, header_value))
    return tuple(sorted(normalized, key=lambda item: item[0].lower()))


def _body(value: Any, label: str) -> bytes:
    if not isinstance(value, str):
        raise ProbeError(f"{label} must be a base64 string")
    try:
        decoded = base64.b64decode(value, validate=True)
    except ValueError as error:
        raise ProbeError(f"{label} must be valid base64") from error
    if len(decoded) > MAX_BODY_BYTES:
        raise ProbeError(f"{label} exceeds the {MAX_BODY_BYTES}-byte limit")
    return decoded


# ── Complete Preflight Precedes Secrets And Network ─────────────
# The campaign file cannot grant authority by itself. Exact normalized origins,
# an external engagement reference, request and rate ceilings, and every case
# are validated as one unit before environment secrets are resolved. External
# targets additionally require a mission-bound route inherited from cyberful-os
# after the model boundary. Campaign JSON can narrow origins and limits, but it
# cannot select a proxy, CA bundle, or direct host-network route.
# ─────────────────────────────────────────────────────────────────
def _campaign(payload: dict[str, Any]) -> tuple[str, Authority, tuple[WorkloadCase, ...]]:
    if set(payload) != {"$schema", "campaign_id", "authority", "cases"}:
        raise ProbeError("campaign must contain exactly $schema, campaign_id, authority, and cases")
    campaign_id = _text(payload["campaign_id"], "campaign_id", maximum=512)
    assert isinstance(campaign_id, str)
    raw_authority = payload["authority"]
    authority_fields = {"authorization_reference", "allowed_origins", "max_requests", "requests_per_second", "request_timeout_seconds", "campaign_timeout_seconds"}
    if not isinstance(raw_authority, dict) or set(raw_authority) != authority_fields:
        raise ProbeError("authority contains missing or unknown fields")
    authorization_reference = _text(raw_authority["authorization_reference"], "authority.authorization_reference", maximum=512)
    assert isinstance(authorization_reference, str)
    raw_origins = raw_authority["allowed_origins"]
    if not isinstance(raw_origins, list) or not 1 <= len(raw_origins) <= 8:
        raise ProbeError("authority.allowed_origins must contain between 1 and 8 origins")
    parsed_origins = [_http_url(value, "authority.allowed_origins[]")[1] for value in raw_origins]
    if any(parsed.path not in {"", "/"} or parsed.query for parsed in parsed_origins):
        raise ProbeError("authority.allowed_origins entries must be exact origins without path or query")
    allowed_origins = frozenset(_origin(parsed) for parsed in parsed_origins)
    if len(allowed_origins) != len(parsed_origins):
        raise ProbeError("authority.allowed_origins must not contain duplicate effective origins")
    max_requests = _integer(raw_authority["max_requests"], "authority.max_requests", 1, MAX_REQUESTS)
    requests_per_second = _number(raw_authority["requests_per_second"], "authority.requests_per_second", 0.1, MAX_RATE)
    request_timeout = _integer(raw_authority["request_timeout_seconds"], "authority.request_timeout_seconds", 1, MAX_TIMEOUT_SECONDS)
    campaign_timeout = _integer(raw_authority["campaign_timeout_seconds"], "authority.campaign_timeout_seconds", 1, MAX_CAMPAIGN_SECONDS)

    raw_cases = payload["cases"]
    if not isinstance(raw_cases, list) or not raw_cases or len(raw_cases) > max_requests:
        raise ProbeError("cases must be non-empty and must not exceed authority.max_requests")
    required = {"case_id", "workload", "issuer", "subject", "audience", "tenant", "expected_binding", "method", "url", "headers", "secret_headers", "body_base64"}
    cases: list[WorkloadCase] = []
    for index, value in enumerate(raw_cases):
        label = f"cases[{index}]"
        if not isinstance(value, dict) or set(value) != required:
            raise ProbeError(f"{label} contains missing or unknown fields")
        secret_headers = _secret_headers(value["secret_headers"], f"{label}.secret_headers")
        reserved = frozenset(name.lower() for name, _ in secret_headers)
        url, parsed = _http_url(value["url"], f"{label}.url")
        if _origin(parsed) not in allowed_origins:
            raise ProbeError(f"{label}.url origin is outside authority.allowed_origins")
        method = _text(value["method"], f"{label}.method", maximum=16)
        expected_binding = _text(value["expected_binding"], f"{label}.expected_binding", maximum=16)
        assert isinstance(method, str) and isinstance(expected_binding, str)
        if method not in METHODS:
            raise ProbeError(f"{label}.method is unsupported")
        if expected_binding not in {"accept", "reject"}:
            raise ProbeError(f"{label}.expected_binding must be accept or reject")
        cases.append(WorkloadCase(
            case_id=str(_text(value["case_id"], f"{label}.case_id", maximum=512)),
            workload=str(_text(value["workload"], f"{label}.workload", maximum=512)),
            issuer=str(_text(value["issuer"], f"{label}.issuer", maximum=512)),
            subject=str(_text(value["subject"], f"{label}.subject", maximum=512)),
            audience=str(_text(value["audience"], f"{label}.audience", maximum=512)),
            tenant=_text(value["tenant"], f"{label}.tenant", maximum=512, nullable=True),
            expected_binding=expected_binding,
            method=method,
            url=url,
            headers=_headers(value["headers"], f"{label}.headers", reserved),
            secret_headers=secret_headers,
            body=_body(value["body_base64"], f"{label}.body_base64"),
        ))
    case_ids = [case.case_id for case in cases]
    if len(case_ids) != len(set(case_ids)):
        raise ProbeError("case_id values must be unique")
    return campaign_id, Authority(authorization_reference, allowed_origins, max_requests, requests_per_second, request_timeout, campaign_timeout), tuple(cases)


def _runtime_routes(cases: tuple[WorkloadCase, ...]) -> dict[str, str]:
    routes: dict[str, str] = {}
    for case in cases:
        _, target = _http_url(case.url, f"cases[{case.case_id}].url")
        if _loopback(target):
            continue
        environment_name = PROXY_ENVIRONMENT[target.scheme]
        raw_proxy = os.environ.get(environment_name)
        if not raw_proxy:
            raise ProbeError(f"non-loopback {target.scheme} target has no mission-bound {environment_name} route")
        runtime_proxy, proxy = _http_url(raw_proxy, environment_name)
        if proxy.path not in {"", "/"} or proxy.query:
            raise ProbeError(f"{environment_name} must be an HTTP(S) proxy origin")
        routes[target.scheme] = runtime_proxy
    return routes


def _process_environment() -> dict[str, str]:
    environment = {name: os.environ[name] for name in PASSTHROUGH_ENVIRONMENT if os.environ.get(name)}
    environment.setdefault("PATH", "/usr/bin:/bin")
    environment.update({"LANG": "C", "LC_ALL": "C"})
    environment.update(NO_TELEMETRY_ENVIRONMENT)
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
    if process.poll() is not None:
        return
    _signal_group(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    _signal_group(process.pid, signal.SIGKILL)
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired as error:
        raise ProbeError("child process group could not be reaped") from error


# ── Streams Are Bounded During Child Execution ──────────────────
# Curl writes response material to monitored files and only a status code to
# stdout. Pipes and files are checked while the process runs; crossing a byte or
# global deadline terminates and reaps the whole process group immediately.
# This avoids first accumulating untrusted target output and then discovering
# that the evidence contract was exceeded.
# ─────────────────────────────────────────────────────────────────
def _set_child_file_limit(limit: int) -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (limit, limit))


def _run_process(
    argv: list[str],
    deadline: float,
    *,
    monitored_files: tuple[tuple[Path, int, str], ...] = (),
    stdout_bytes: int = MAX_STDOUT_BYTES,
) -> ProcessResult:
    if time.monotonic() >= deadline:
        raise ProbeError("global campaign deadline exceeded before child execution")
    file_size_limit = max((maximum for _, maximum, _ in monitored_files), default=0)
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_process_environment(),
            shell=False,
            start_new_session=True,
            preexec_fn=partial(_set_child_file_limit, file_size_limit) if file_size_limit else None,
        )
    except OSError as error:
        raise ProbeError(f"could not start fixed tool: {error}") from error
    if process.stdout is None or process.stderr is None:
        _terminate_group(process)
        raise ProbeError("child output pipes were not created")
    streams = {process.stdout: ("stdout", stdout_bytes), process.stderr: ("stderr", MAX_STDERR_BYTES)}
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    selector = selectors.DefaultSelector()
    for stream in streams:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    timed_out = False
    limit_exceeded: str | None = None
    try:
        while selector.get_map() or process.poll() is None:
            for filename, maximum, label in monitored_files:
                try:
                    size = filename.stat().st_size
                except FileNotFoundError:
                    continue
                if size >= maximum:
                    limit_exceeded = label
                    break
            if limit_exceeded is not None:
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
                    limit_exceeded = name
                    _terminate_group(process)
                    break
            if limit_exceeded is not None:
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
    return ProcessResult(process.returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"]), timed_out, limit_exceeded)


def _resolved_secrets(cases: tuple[WorkloadCase, ...]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for case in cases:
        for _, environment in case.secret_headers:
            if environment in resolved:
                continue
            secret = os.environ.get(environment)
            if not secret or len(secret) > 16_384 or any(character in secret for character in "\r\n"):
                raise ProbeError(f"required secret environment variable is absent or invalid: {environment}")
            resolved[environment] = secret
    return resolved


def _curl_quote(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _bounded_file(filename: Path, maximum: int) -> tuple[bytes, int, bool]:
    if not filename.exists():
        return b"", 0, False
    size = filename.stat().st_size
    with filename.open("rb") as stream:
        content = stream.read(maximum + 1)
    return content[:maximum], size, len(content) > maximum or size > maximum


def _redact(content: bytes, secrets: tuple[str, ...], maximum: int) -> tuple[bytes, int, bool]:
    redacted = content
    count = 0
    for secret in secrets:
        encoded = secret.encode("utf-8")
        count += redacted.count(encoded)
        redacted = redacted.replace(encoded, b"[REDACTED_SECRET]")
    return redacted[:maximum], count, len(redacted) > maximum


def _execute_case(case: WorkloadCase, authority: Authority, secrets: dict[str, str], routes: dict[str, str], deadline: float) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="cyberful-workload-probe-") as directory:
        temporary = Path(directory)
        headers_file = temporary / "headers.bin"
        body_file = temporary / "body.bin"
        request_file = temporary / "request.bin"
        config_file = temporary / "curl.conf"
        request_file.write_bytes(case.body)
        os.chmod(request_file, 0o600)
        secret_headers = tuple((name, environment, secrets[environment]) for name, environment in case.secret_headers)
        config_lines = [f'header = "{_curl_quote(name)}: {_curl_quote(value)}"' for name, value in case.headers]
        config_lines.extend(f'header = "{_curl_quote(name)}: {_curl_quote(secret)}"' for name, _, secret in secret_headers)
        config_file.write_text("\n".join(config_lines) + ("\n" if config_lines else ""), encoding="utf-8")
        os.chmod(config_file, 0o600)
        argv = [
            "curl", "--disable", "--silent", "--show-error", "--proto", "=http,https", "--proto-redir", "=http,https",
            "--request", case.method, "--url", case.url, "--connect-timeout", str(min(10, authority.request_timeout_seconds)),
            "--max-time", str(authority.request_timeout_seconds), "--max-filesize", str(MAX_RESPONSE_BYTES),
            "--dump-header", str(headers_file), "--output", str(body_file), "--write-out", "%{http_code}", "--config", str(config_file),
        ]
        _, target = _http_url(case.url, f"cases[{case.case_id}].url")
        if _loopback(target):
            argv.extend(("--proxy", ""))
        else:
            argv.extend(("--proxy", routes[target.scheme], "--noproxy", ""))
        if case.body:
            argv.extend(("--data-binary", f"@{request_file}"))
        started = time.monotonic()
        result = _run_process(argv, min(deadline, started + authority.request_timeout_seconds + 2), monitored_files=((headers_file, MAX_HEADER_BYTES, "response headers"), (body_file, MAX_RESPONSE_BYTES, "response body")))
        elapsed_ms = round((time.monotonic() - started) * 1000)
        raw_headers, header_size, headers_truncated = _bounded_file(headers_file, MAX_HEADER_BYTES)
        raw_body, body_size, body_truncated = _bounded_file(body_file, MAX_RESPONSE_BYTES)
        case_secrets = tuple(secret for _, _, secret in secret_headers)
        raw_headers, header_redactions, redacted_header_truncated = _redact(raw_headers, case_secrets, MAX_HEADER_BYTES)
        raw_body, body_redactions, redacted_body_truncated = _redact(raw_body, case_secrets, MAX_RESPONSE_BYTES)
        stderr, stderr_redactions, _ = _redact(result.stderr, case_secrets, MAX_STDERR_BYTES)
        status_text = result.stdout.decode("ascii", errors="replace").strip()
        status = int(status_text) if status_text.isdigit() and len(status_text) == 3 else None
        request_material = json.dumps({"method": case.method, "url": case.url, "headers": list(case.headers), "secret_header_hashes": [(name, hashlib.sha256(secret.encode()).hexdigest()) for name, _, secret in secret_headers], "body_sha256": hashlib.sha256(case.body).hexdigest()}, sort_keys=True, separators=(",", ":")).encode()
        return {
            "case_id": case.case_id,
            "workload": case.workload,
            "issuer": case.issuer,
            "subject": case.subject,
            "audience": case.audience,
            "tenant": case.tenant,
            "expected_binding": case.expected_binding,
            "request": {
                "method": case.method,
                "url": case.url,
                "headers": [{"name": name, "value": value} for name, value in case.headers],
                "secret_headers": [{"name": name, "environment": environment, "value_sha256": hashlib.sha256(secret.encode()).hexdigest()} for name, environment, secret in secret_headers],
                "body_bytes": len(case.body),
                "body_sha256": hashlib.sha256(case.body).hexdigest(),
                "request_sha256": hashlib.sha256(request_material).hexdigest(),
                "command": ["curl", "--request", case.method, "--url", case.url, "--config", "<secret-config>"],
            },
            "transport": {
                "return_code": result.return_code,
                "timed_out": result.timed_out,
                "limit_exceeded": result.limit_exceeded,
                "elapsed_ms": elapsed_ms,
                "http_status": status,
                "stderr": stderr.decode("utf-8", errors="replace"),
                "stderr_redactions": stderr_redactions,
            },
            "response": {
                "headers_base64": base64.b64encode(raw_headers).decode("ascii"),
                "headers_bytes": header_size,
                "headers_truncated": headers_truncated or redacted_header_truncated or result.limit_exceeded == "response headers",
                "headers_redactions": header_redactions,
                "body_base64": base64.b64encode(raw_body).decode("ascii"),
                "body_bytes": body_size,
                "body_truncated": body_truncated or redacted_body_truncated or result.limit_exceeded == "response body",
                "body_redactions": body_redactions,
            },
        }


def _tool_version(deadline: float) -> str:
    result = _run_process(
        ["curl", "--version"],
        min(deadline, time.monotonic() + 2),
        stdout_bytes=MAX_VERSION_BYTES,
    )
    if result.return_code != 0 or result.limit_exceeded or result.timed_out:
        raise ProbeError("could not record the fixed curl version")
    return result.stdout.decode("utf-8", errors="replace").splitlines()[0]


def _run_campaign(payload: dict[str, Any], raw: bytes, workspace: Path) -> dict[str, Any]:
    del workspace
    campaign_id, authority, cases = _campaign(payload)
    routes = _runtime_routes(cases)
    secrets = _resolved_secrets(cases)
    deadline = time.monotonic() + authority.campaign_timeout_seconds
    version = _tool_version(deadline)
    results: list[dict[str, Any]] = []
    next_request_at = time.monotonic()
    interval = 1.0 / authority.requests_per_second
    for case in cases:
        delay = next_request_at - time.monotonic()
        if delay > 0:
            if time.monotonic() + delay >= deadline:
                raise ProbeError("global campaign deadline exceeded before the next request")
            time.sleep(delay)
        result = _execute_case(case, authority, secrets, routes, deadline)
        results.append(result)
        next_request_at = max(next_request_at + interval, time.monotonic())
        if result["transport"]["timed_out"] or result["transport"]["limit_exceeded"] is not None:
            break
    return {
        "format": "cyberful.workload-identity-evidence.v1",
        "campaign_id": campaign_id,
        "authorization_reference": authority.authorization_reference,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "tool": {"name": "curl", "version": version},
        "limits": {"requests": authority.max_requests, "concurrency": 1, "requests_per_second": authority.requests_per_second, "request_timeout_seconds": authority.request_timeout_seconds, "campaign_timeout_seconds": authority.campaign_timeout_seconds, "output_bytes": MAX_OUTPUT_BYTES},
        "cases": results,
        "interpretation": "Raw bounded workload transport evidence only; compare identity bindings and protected effects before reaching a vulnerability conclusion.",
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], source: Path) -> None:
    destination = _confined(workspace, value, must_exist=False)
    if destination == source or not destination.parent.is_dir():
        raise ProbeError("output must differ from input and have an existing parent")
    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode("utf-8")
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise ProbeError(f"rendered evidence exceeds the {MAX_OUTPUT_BYTES}-byte limit")
    descriptor, temporary_name = tempfile.mkstemp(prefix=".workload-evidence-", dir=destination.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(rendered)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a bounded authorized workload identity probe.")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw, source = _read_json(workspace, arguments.input)
        report = _run_campaign(payload, raw, workspace)
        _write_report(workspace, arguments.output, report, source)
    except (OSError, ProbeError) as error:
        print(f"workload identity probe refused: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
