#!/usr/bin/env python3
# ── Bounded Request Normalization Harness ────────────────────────
# Runs safe HTTP-level normalization variants against exact authorized origins
#   and records bounded raw transport evidence without claiming a differential.
# → cyberful/builtin/skills/trace-request-normalization/scripts/manifest.json — execution limits and effects.
# → cyberful/builtin/skills/trace-request-normalization/tests/test_run_normalization_harness.py — loopback and boundary coverage.
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
MAX_REQUESTS: Final = 12
MAX_BODY_BYTES: Final = 65_536
MAX_CAPTURE_BYTES: Final = 16_384
MAX_HEADER_BYTES: Final = 16_384
MAX_STDOUT_BYTES: Final = 64
MAX_STDERR_BYTES: Final = 4_096
MAX_TEXT: Final = 2_048
MAX_HEADERS: Final = 32
MAX_SECRET_BYTES: Final = 4_096
MAX_RATE_PER_SECOND: Final = 4.0
MAX_REQUEST_TIMEOUT_SECONDS: Final = 20
CAMPAIGN_TIMEOUT_SECONDS: Final = 120.0
SECRET_ENVIRONMENT: Final = frozenset(("CYBERFUL_PROBE_AUTHORIZATION", "CYBERFUL_PROBE_COOKIE"))
SENSITIVE_HEADER_NAMES: Final = frozenset(("authorization", "cookie", "proxy-authorization"))
METHODS: Final = frozenset(("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"))
DIMENSIONS: Final = frozenset(("authority", "path", "query", "method", "field", "translation", "control"))
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
    allowed_origins: frozenset[str]
    max_requests: int
    requests_per_second: float
    request_timeout_seconds: int


@dataclass(frozen=True)
class RuntimeRoute:
    http_proxy: str | None
    https_proxy: str | None
    ca_bundle: Path | None


@dataclass(frozen=True)
class NormalizationCase:
    case_id: str
    dimension: str
    variant: str
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


def _number(value: Any, label: str, *, minimum: float, maximum: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not minimum <= float(value) <= maximum:
        raise HarnessError(f"{label} must be a number between {minimum} and {maximum}")
    return float(value)


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


def _headers(value: Any, label: str, secret_names: frozenset[str]) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, dict) or len(value) > MAX_HEADERS:
        raise HarnessError(f"{label} must contain at most {MAX_HEADERS} headers")
    normalized: list[tuple[str, str]] = []
    for raw_name, raw_value in value.items():
        name = _text(raw_name, f"{label}.name", maximum=128)
        header_value = _text(raw_value, f"{label}.{name}")
        if not HEADER_NAME.fullmatch(name) or name.lower() in {"host", "content-length"} | SENSITIVE_HEADER_NAMES | secret_names:
            raise HarnessError(f"{label} contains a forbidden header name: {name}")
        normalized.append((name, header_value))
    return tuple(sorted(normalized, key=lambda item: item[0].lower()))


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
# Campaign JSON can describe cases but cannot grant authority by itself. The
# runner validates affirmative authority, exact origins, every case, all limits,
# and every secret reference before reading secret values from the environment.
# This prevents a later invalid case from producing partial target traffic and
# keeps credentials outside serialized input and request evidence.
# ─────────────────────────────────────────────────────────────────
def _campaign(payload: dict[str, Any], workspace: Path) -> tuple[str, Authority, tuple[NormalizationCase, ...]]:
    if set(payload) != {"$schema", "campaign_id", "authority", "cases"}:
        raise HarnessError("campaign contains missing or unknown fields")
    campaign_id = _text(payload["campaign_id"], "campaign_id", maximum=256)
    raw_authority = payload["authority"]
    required_authority = {"confirmed", "authorization_reference", "allowed_origins", "max_requests", "requests_per_second", "request_timeout_seconds"}
    if not isinstance(raw_authority, dict) or set(raw_authority) != required_authority or raw_authority["confirmed"] is not True:
        raise HarnessError("authority is malformed or unconfirmed")
    raw_origins = raw_authority["allowed_origins"]
    if not isinstance(raw_origins, list) or not raw_origins or len(raw_origins) > 16:
        raise HarnessError("authority.allowed_origins must contain between 1 and 16 origins")
    parsed_origins = [_parsed_http_url(value, "authority.allowed_origins[]") for value in raw_origins]
    if any(parsed.path not in {"", "/"} or parsed.query for parsed in parsed_origins):
        raise HarnessError("authority.allowed_origins entries must be origins without path or query")
    allowed_origins = frozenset(_origin(parsed) for parsed in parsed_origins)
    max_requests = _integer(raw_authority["max_requests"], "authority.max_requests", minimum=1, maximum=MAX_REQUESTS)
    rate = _number(raw_authority["requests_per_second"], "authority.requests_per_second", minimum=0.1, maximum=MAX_RATE_PER_SECOND)
    request_timeout = _integer(raw_authority["request_timeout_seconds"], "authority.request_timeout_seconds", minimum=1, maximum=MAX_REQUEST_TIMEOUT_SECONDS)
    raw_cases = payload["cases"]
    required_case = {"case_id", "dimension", "variant", "method", "url", "headers", "secret_headers", "body_base64"}
    if not isinstance(raw_cases, list) or not raw_cases or len(raw_cases) > max_requests:
        raise HarnessError("cases must be non-empty and not exceed authority.max_requests")
    secret_headers_by_case: list[tuple[tuple[str, str], ...]] = []
    for index, raw_case in enumerate(raw_cases):
        if not isinstance(raw_case, dict) or set(raw_case) != required_case:
            raise HarnessError(f"cases[{index}] contains missing or unknown fields")
        secret_headers_by_case.append(_secret_headers(raw_case["secret_headers"], f"cases[{index}].secret_headers"))
    declared_secret_names = frozenset(name.lower() for entries in secret_headers_by_case for name, _ in entries)
    cases: list[NormalizationCase] = []
    for index, (raw_case, secret_headers) in enumerate(zip(raw_cases, secret_headers_by_case, strict=True)):
        label = f"cases[{index}]"
        url = _text(raw_case["url"], f"{label}.url")
        parsed = _parsed_http_url(url, f"{label}.url")
        if _origin(parsed) not in allowed_origins:
            raise HarnessError(f"{label}.url origin is outside authority.allowed_origins")
        method = _text(raw_case["method"], f"{label}.method", maximum=16).upper()
        dimension = _text(raw_case["dimension"], f"{label}.dimension", maximum=32)
        if method not in METHODS or dimension not in DIMENSIONS:
            raise HarnessError(f"{label} contains an unsupported method or dimension")
        cases.append(NormalizationCase(
            _text(raw_case["case_id"], f"{label}.case_id", maximum=128),
            dimension,
            _text(raw_case["variant"], f"{label}.variant", maximum=256),
            method,
            url,
            _headers(raw_case["headers"], f"{label}.headers", declared_secret_names),
            secret_headers,
            _body(raw_case["body_base64"], f"{label}.body_base64"),
        ))
    if len({case.case_id for case in cases}) != len(cases):
        raise HarnessError("case_id values must be unique")
    return campaign_id, Authority(_text(raw_authority["authorization_reference"], "authority.authorization_reference"), allowed_origins, max_requests, rate, request_timeout), tuple(cases)


def _runtime_route(cases: tuple[NormalizationCase, ...]) -> RuntimeRoute:
    schemes = {urlsplit(case.url).scheme.lower() for case in cases if not _is_loopback(urlsplit(case.url))}
    proxies: dict[str, str | None] = {"http": None, "https": None}
    for scheme in schemes:
        environment_name = f"{scheme.upper()}_PROXY"
        raw_proxy = os.environ.get(environment_name)
        if not raw_proxy:
            raise HarnessError(f"non-loopback {scheme} targets require the host-provided {environment_name} route")
        proxy = _parsed_http_url(raw_proxy, environment_name)
        if proxy.path not in {"", "/"} or proxy.query or proxy.port is None:
            raise HarnessError(f"{environment_name} must be an explicit proxy origin")
        proxies[scheme] = raw_proxy
    raw_ca = os.environ.get("CURL_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE")
    ca_bundle: Path | None = None
    if schemes:
        if not raw_ca:
            raise HarnessError("non-loopback targets require host-provided CURL_CA_BUNDLE or SSL_CERT_FILE")
        ca_bundle = Path(_text(raw_ca, "runtime CA bundle")).resolve(strict=True)
        metadata = ca_bundle.stat()
        if ca_bundle.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1_048_576:
            raise HarnessError("runtime CA bundle must be a bounded regular file")
    return RuntimeRoute(proxies["http"], proxies["https"], ca_bundle)


def _resolved_secrets(cases: tuple[NormalizationCase, ...]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for case in cases:
        for _, environment in case.secret_headers:
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


def _execute_case(case: NormalizationCase, authority: Authority, route: RuntimeRoute, secrets: dict[str, str], global_deadline: float) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="cyberful-normalization-") as directory:
        temporary = Path(directory)
        headers_path = temporary / "headers.bin"
        body_path = temporary / "body.bin"
        request_path = temporary / "request.bin"
        config_path = temporary / "curl.conf"
        request_path.write_bytes(case.body)
        os.chmod(request_path, 0o600)
        resolved_headers = tuple((name, environment, secrets[environment]) for name, environment in case.secret_headers)
        config_lines = [f'header = "{_curl_quote(name)}: {_curl_quote(value)}"' for name, value in case.headers]
        config_lines.extend(f'header = "{_curl_quote(name)}: {_curl_quote(value)}"' for name, _, value in resolved_headers)
        config_path.write_text("\n".join(config_lines) + ("\n" if config_lines else ""), encoding="utf-8")
        os.chmod(config_path, 0o600)
        argv = [
            "curl", "--disable", "--silent", "--show-error", "--path-as-is", "--proto", "=http,https", "--proto-redir", "=http,https",
            "--request", case.method, "--url", case.url, "--connect-timeout", str(min(10, authority.request_timeout_seconds)),
            "--max-time", str(authority.request_timeout_seconds), "--max-filesize", str(MAX_CAPTURE_BYTES), "--dump-header", str(headers_path),
            "--output", str(body_path), "--write-out", "%{http_code}", "--config", str(config_path),
        ]
        parsed_url = urlsplit(case.url)
        proxy_url = route.http_proxy if parsed_url.scheme == "http" else route.https_proxy
        if _is_loopback(parsed_url):
            argv.extend(("--proxy", ""))
        else:
            if proxy_url is None:
                raise HarnessError("non-loopback request lost its host-provided proxy route")
            argv.extend(("--proxy", proxy_url, "--noproxy", ""))
        if route.ca_bundle is not None:
            argv.extend(("--cacert", str(route.ca_bundle)))
        if case.body:
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
        request_material = json.dumps({"method": case.method, "url": case.url, "headers": case.headers, "secret_header_hashes": [(name, hashlib.sha256(value.encode()).hexdigest()) for name, _, value in resolved_headers], "body_sha256": hashlib.sha256(case.body).hexdigest()}, sort_keys=True, separators=(",", ":")).encode()
        return {
            "case_id": case.case_id,
            "dimension": case.dimension,
            "variant": case.variant,
            "request": {
                "method": case.method,
                "url": case.url,
                "headers": [{"name": name, "value": value} for name, value in case.headers],
                "secret_headers": [{"name": name, "environment": environment, "value_sha256": hashlib.sha256(value.encode()).hexdigest()} for name, environment, value in resolved_headers],
                "body_bytes": len(case.body),
                "body_sha256": hashlib.sha256(case.body).hexdigest(),
                "request_sha256": hashlib.sha256(request_material).hexdigest(),
            },
            "transport": {
                "return_code": process.return_code,
                "timed_out": process.timed_out,
                "limit_exceeded": process.limit_exceeded,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "http_status": int(status_text) if status_text.isdigit() and len(status_text) == 3 else None,
                "route": "direct-loopback" if _is_loopback(parsed_url) else "cyberful-os-proxy",
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


def run_campaign(payload: dict[str, Any], workspace: Path, source_sha256: str) -> dict[str, Any]:
    campaign_id, authority, cases = _campaign(payload, workspace)
    route = _runtime_route(cases)
    secrets = _resolved_secrets(cases)
    deadline = time.monotonic() + CAMPAIGN_TIMEOUT_SECONDS
    interval = 1.0 / authority.requests_per_second
    next_request = time.monotonic()
    results: list[dict[str, Any]] = []
    for case in cases:
        delay = next_request - time.monotonic()
        if delay > 0:
            if time.monotonic() + delay >= deadline:
                raise HarnessError("campaign deadline expired before the next request")
            time.sleep(delay)
        results.append(_execute_case(case, authority, route, secrets, deadline))
        if time.monotonic() >= deadline:
            raise HarnessError("campaign exceeded its global deadline")
        next_request = max(next_request + interval, time.monotonic())
    return {
        "format": "cyberful.normalization-evidence.v1",
        "campaign_id": campaign_id,
        "authorization_reference": authority.authorization_reference,
        "source_sha256": source_sha256,
        "limits": {"requests": authority.max_requests, "concurrency": 1, "requests_per_second": authority.requests_per_second, "request_timeout_seconds": authority.request_timeout_seconds, "campaign_timeout_seconds": int(CAMPAIGN_TIMEOUT_SECONDS)},
        "cases": results,
        "interpretation": "Raw bounded HTTP-level observations only; compare component-local interpretations before claiming a normalization or desynchronization flaw.",
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
    parser = argparse.ArgumentParser(description="Run bounded authorized HTTP normalization variants.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw, source = _read_json(workspace, arguments.input)
        destination = _report_path(workspace, arguments.output, source)
        _write_report(destination, run_campaign(payload, workspace, hashlib.sha256(raw).hexdigest()))
    except (HarnessError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
