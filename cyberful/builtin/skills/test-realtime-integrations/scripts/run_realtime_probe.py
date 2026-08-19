#!/usr/bin/env python3
# ── Bounded Realtime Integration Probe ──────────────────────────
# Executes authorized webhook, callback, SSE, or WebSocket-handshake probes
#   through curl and preserves bounded raw transport evidence without verdicts.
# → cyberful/builtin/skills/test-realtime-integrations/scripts/manifest.json — execution contract and hard limits.
# → cyberful/builtin/skills/test-realtime-integrations/assets/realtime-probe.schema.json — probe input.
# → cyberful/builtin/skills/test-realtime-integrations/tests/test_run_realtime_probe.py — boundary and loopback coverage.
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
MAX_CAPTURE_BYTES: Final = 24_576
MAX_HEADER_BYTES: Final = 24_576
MAX_STDOUT_BYTES: Final = 64
MAX_STDERR_BYTES: Final = 4_096
MAX_TEXT: Final = 2_048
MAX_HEADERS: Final = 32
MAX_TIMEOUT_SECONDS: Final = 30
MAX_RATE_PER_SECOND: Final = 4.0
MAX_SECRET_BYTES: Final = 4_096
CAMPAIGN_TIMEOUT_SECONDS: Final = 180.0
SECRET_ENVIRONMENT: Final = frozenset(("CYBERFUL_PROBE_AUTHORIZATION", "CYBERFUL_PROBE_COOKIE", "CYBERFUL_WEBHOOK_SIGNATURE"))
SENSITIVE_HEADER_NAMES: Final = frozenset(("authorization", "cookie", "proxy-authorization"))
PASSTHROUGH_ENVIRONMENT: Final = ("PATH", "TMPDIR")
NO_TELEMETRY_ENVIRONMENT: Final = {
    "DISABLE_UPDATE_CHECK": "true",
    "DO_NOT_TRACK": "1",
    "GRYPE_CHECK_FOR_APP_UPDATE": "false",
    "PDCP_API_KEY": "",
    "SEMGREP_SEND_METRICS": "off",
    "SYFT_CHECK_FOR_APP_UPDATE": "false",
}
KINDS: Final = frozenset(("webhook", "callback", "sse", "websocket-handshake"))
METHODS: Final = frozenset(("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"))
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


@dataclass(frozen=True)
class RuntimeRoute:
    http_proxy: str | None
    https_proxy: str | None
    ca_bundle: Path | None


@dataclass(frozen=True)
class RealtimeCase:
    probe_id: str
    kind: str
    principal: str
    tenant: str
    channel: str
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
        raise ProbeError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 for character in normalized):
        raise ProbeError(f"{label} exceeds its text boundary or contains control characters")
    return normalized


def _integer(value: Any, label: str, *, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ProbeError(f"{label} must be an integer between {minimum} and {maximum}")
    return value


def _number(value: Any, label: str, *, minimum: float, maximum: float) -> float:
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


def _confined_path(workspace: Path, value: str, *, must_exist: bool) -> Path:
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
    source = _confined_path(workspace, value, must_exist=True)
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


def _parsed_http_url(value: str, label: str) -> SplitResult:
    normalized = _text(value, label)
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ProbeError(f"{label} must be an HTTP(S) URL without credentials or fragment")
    try:
        parsed.port
    except ValueError as error:
        raise ProbeError(f"{label} contains an invalid port") from error
    if parsed.hostname.lower() == "localhost" or parsed.hostname.lower().endswith(".localhost"):
        raise ProbeError(f"{label} must use a literal IP address for loopback")
    return parsed


def _origin(parsed: SplitResult) -> str:
    default_port = 80 if parsed.scheme == "http" else 443
    hostname = parsed.hostname.lower()
    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    return f"{parsed.scheme.lower()}://{rendered_host}:{parsed.port or default_port}"


def _is_loopback(parsed: SplitResult) -> bool:
    try:
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return False


def _headers(value: Any, label: str, secret_names: frozenset[str]) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, dict) or len(value) > MAX_HEADERS:
        raise ProbeError(f"{label} must be an object with at most {MAX_HEADERS} headers")
    normalized: list[tuple[str, str]] = []
    for raw_name, raw_value in value.items():
        name = _text(raw_name, f"{label}.name", maximum=128)
        header_value = _text(raw_value, f"{label}.{name}")
        if not HEADER_NAME.fullmatch(name) or name.lower() in {"host", "content-length"} | SENSITIVE_HEADER_NAMES | secret_names:
            raise ProbeError(f"{label} contains a forbidden header name: {name}")
        normalized.append((name, header_value))
    return tuple(sorted(normalized, key=lambda item: item[0].lower()))


def _secret_headers(value: Any, label: str) -> tuple[tuple[str, str], ...]:
    if not isinstance(value, dict) or len(value) > len(SECRET_ENVIRONMENT):
        raise ProbeError(f"{label} must be an object using declared secret environment variables")
    normalized: list[tuple[str, str]] = []
    for raw_name, raw_environment in value.items():
        name = _text(raw_name, f"{label}.name", maximum=128)
        environment = _text(raw_environment, f"{label}.{name}", maximum=128)
        if not HEADER_NAME.fullmatch(name) or environment not in SECRET_ENVIRONMENT:
            raise ProbeError(f"{label} contains an unsupported header or environment variable")
        if name.lower() in {"host", "content-length"}:
            raise ProbeError(f"{label} contains a forbidden secret header name: {name}")
        normalized.append((name, environment))
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


# ── The Complete Probe Set Is Authorized Atomically ─────────────
# Realtime systems often retain connections, retry callbacks, or fan out an
# event after the initiating request returns. The runner therefore validates
# exact origins, authorization reference, total request count, rate, and timeout
# for every case before starting any child. These values are defense in depth:
# the plan cannot grant authority or select transport. Non-loopback traffic uses
# only the proxy and trust route supplied by the Cyberful runtime after preflight.
# ─────────────────────────────────────────────────────────────────
def _probe_plan(payload: dict[str, Any], workspace: Path) -> tuple[str, Authority, tuple[RealtimeCase, ...]]:
    if set(payload) != {"$schema", "campaign_id", "authority", "probes"}:
        raise ProbeError("probe plan must contain exactly $schema, campaign_id, authority, and probes")
    campaign_id = _text(payload["campaign_id"], "campaign_id")
    authority_value = payload["authority"]
    required_authority = {"authorization_reference", "allowed_origins", "max_requests", "requests_per_second", "request_timeout_seconds"}
    if not isinstance(authority_value, dict) or set(authority_value) != required_authority:
        raise ProbeError("authority contains missing or unknown fields")
    authorization_reference = _text(authority_value["authorization_reference"], "authority.authorization_reference")
    raw_origins = authority_value["allowed_origins"]
    if not isinstance(raw_origins, list) or not raw_origins or len(raw_origins) > 16:
        raise ProbeError("authority.allowed_origins must contain between 1 and 16 origins")
    parsed_origins = [_parsed_http_url(value, "authority.allowed_origins[]") for value in raw_origins]
    if any(parsed.path not in {"", "/"} or parsed.query for parsed in parsed_origins):
        raise ProbeError("authority.allowed_origins entries must be origins without path or query")
    allowed_origins = frozenset(_origin(parsed) for parsed in parsed_origins)
    max_requests = _integer(authority_value["max_requests"], "authority.max_requests", minimum=1, maximum=MAX_REQUESTS)
    requests_per_second = _number(authority_value["requests_per_second"], "authority.requests_per_second", minimum=0.1, maximum=MAX_RATE_PER_SECOND)
    request_timeout_seconds = _integer(authority_value["request_timeout_seconds"], "authority.request_timeout_seconds", minimum=1, maximum=MAX_TIMEOUT_SECONDS)

    raw_probes = payload["probes"]
    if not isinstance(raw_probes, list) or not raw_probes or len(raw_probes) > max_requests:
        raise ProbeError("probes must be non-empty and must not exceed authority.max_requests")
    probes: list[RealtimeCase] = []
    required_probe = {"probe_id", "kind", "principal", "tenant", "channel", "method", "url", "headers", "secret_headers", "body_base64"}
    secret_headers_by_probe: list[tuple[tuple[str, str], ...]] = []
    for index, raw_probe in enumerate(raw_probes):
        label = f"probes[{index}]"
        if not isinstance(raw_probe, dict) or set(raw_probe) != required_probe:
            raise ProbeError(f"{label} contains missing or unknown fields")
        secret_headers_by_probe.append(_secret_headers(raw_probe["secret_headers"], f"{label}.secret_headers"))
    declared_secret_names = frozenset(name.lower() for headers in secret_headers_by_probe for name, _ in headers)
    for index, (raw_probe, secret_headers) in enumerate(zip(raw_probes, secret_headers_by_probe, strict=True)):
        label = f"probes[{index}]"
        kind = _text(raw_probe["kind"], f"{label}.kind", maximum=32)
        if kind not in KINDS:
            raise ProbeError(f"{label}.kind is unsupported")
        method = _text(raw_probe["method"], f"{label}.method", maximum=16).upper()
        if method not in METHODS or kind in {"sse", "websocket-handshake"} and method != "GET":
            raise ProbeError(f"{label}.method is incompatible with its probe kind")
        url = _text(raw_probe["url"], f"{label}.url")
        parsed_url = _parsed_http_url(url, f"{label}.url")
        if _origin(parsed_url) not in allowed_origins:
            raise ProbeError(f"{label}.url origin is outside authority.allowed_origins")
        headers = list(_headers(raw_probe["headers"], f"{label}.headers", declared_secret_names))
        lower_names = {name.lower() for name, _ in headers}
        if kind == "sse" and "accept" not in lower_names:
            headers.append(("Accept", "text/event-stream"))
        if kind == "websocket-handshake":
            additions = (("Connection", "Upgrade"), ("Upgrade", "websocket"), ("Sec-WebSocket-Version", "13"), ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="))
            headers.extend((name, value) for name, value in additions if name.lower() not in lower_names)
        probes.append(RealtimeCase(
            probe_id=_text(raw_probe["probe_id"], f"{label}.probe_id"),
            kind=kind,
            principal=_text(raw_probe["principal"], f"{label}.principal"),
            tenant=_text(raw_probe["tenant"], f"{label}.tenant"),
            channel=_text(raw_probe["channel"], f"{label}.channel"),
            method=method,
            url=url,
            headers=tuple(sorted(headers, key=lambda item: item[0].lower())),
            secret_headers=secret_headers,
            body=_body(raw_probe["body_base64"], f"{label}.body_base64"),
        ))
    probe_ids = [probe.probe_id for probe in probes]
    if len(probe_ids) != len(set(probe_ids)):
        raise ProbeError("probe_id values must be unique")
    return campaign_id, Authority(authorization_reference, allowed_origins, max_requests, requests_per_second, request_timeout_seconds), tuple(probes)


def _runtime_route(probes: tuple[RealtimeCase, ...]) -> RuntimeRoute:
    schemes = {urlsplit(probe.url).scheme.lower() for probe in probes if not _is_loopback(urlsplit(probe.url))}
    proxies: dict[str, str | None] = {"http": None, "https": None}
    for scheme in schemes:
        environment_name = f"{scheme.upper()}_PROXY"
        raw_proxy = os.environ.get(environment_name)
        if not raw_proxy:
            raise ProbeError(f"non-loopback {scheme} targets require the host-provided {environment_name} route")
        proxy = _parsed_http_url(raw_proxy, environment_name)
        if proxy.path not in {"", "/"} or proxy.query or proxy.port is None:
            raise ProbeError(f"{environment_name} must be an explicit proxy origin")
        proxies[scheme] = raw_proxy
    raw_ca = os.environ.get("CURL_CA_BUNDLE") or os.environ.get("SSL_CERT_FILE")
    ca_bundle: Path | None = None
    if schemes:
        if not raw_ca:
            raise ProbeError("non-loopback targets require host-provided CURL_CA_BUNDLE or SSL_CERT_FILE")
        ca_bundle = Path(_text(raw_ca, "runtime CA bundle")).resolve(strict=True)
        metadata = ca_bundle.stat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1_048_576:
            raise ProbeError("runtime CA bundle must be a regular file no larger than 1048576 bytes")
    return RuntimeRoute(proxies["http"], proxies["https"], ca_bundle)


def _curl_quote(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _process_environment() -> dict[str, str]:
    environment = {key: os.environ[key] for key in PASSTHROUGH_ENVIRONMENT if os.environ.get(key)}
    environment.setdefault("PATH", "/usr/bin:/bin")
    environment.update({"LANG": "C", "LC_ALL": "C"})
    environment.update(NO_TELEMETRY_ENVIRONMENT)
    return environment


def _signal_process_group(process_group: int, signal_number: int) -> None:
    try:
        os.killpg(process_group, signal_number)
    except ProcessLookupError:
        return
    except OSError as error:
        if error.errno != errno.ESRCH:
            raise


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    process_group = process.pid
    _signal_process_group(process_group, signal.SIGTERM)
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    _signal_process_group(process_group, signal.SIGKILL)
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired as error:
        raise ProbeError("curl process group could not be reaped") from error


def _limit_child_files(maximum: int) -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (maximum, maximum))


def _run_process(
    argv: list[str],
    timeout_seconds: float,
    *,
    monitored_files: tuple[tuple[Path, int, str], ...] = (),
) -> ProcessResult:
    file_limit = min((maximum for _, maximum, _ in monitored_files), default=MAX_CAPTURE_BYTES)
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=_process_environment(),
            shell=False,
            start_new_session=True,
            preexec_fn=partial(_limit_child_files, file_limit),
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise ProbeError(f"could not start curl: {error}") from error
    if process.stdout is None or process.stderr is None:
        _terminate_process_group(process)
        raise ProbeError("curl output pipes were not created")
    streams = {process.stdout: ("stdout", MAX_STDOUT_BYTES), process.stderr: ("stderr", MAX_STDERR_BYTES)}
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    selector = selectors.DefaultSelector()
    for stream in streams:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout_seconds
    timed_out = False
    limit_exceeded: str | None = None
    try:
        while selector.get_map() or process.poll() is None:
            for path, maximum, label in monitored_files:
                try:
                    size = path.stat().st_size
                except FileNotFoundError:
                    continue
                if size >= maximum:
                    limit_exceeded = label
                    break
            if limit_exceeded is not None:
                _terminate_process_group(process)
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                _terminate_process_group(process)
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
                    _terminate_process_group(process)
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
            _terminate_process_group(process)
    return ProcessResult(process.returncode, bytes(buffers["stdout"]), bytes(buffers["stderr"]), timed_out, limit_exceeded)


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
        encoded = secret.encode("utf-8")
        occurrences = redacted.count(encoded)
        if occurrences:
            redacted = redacted.replace(encoded, b"[REDACTED_SECRET]")
            count += occurrences
    return redacted[:maximum], count, len(redacted) > maximum


def _resolved_secrets(probes: tuple[RealtimeCase, ...]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for probe in probes:
        for _, environment in probe.secret_headers:
            if environment in resolved:
                continue
            secret = os.environ.get(environment)
            if not secret or len(secret.encode("utf-8")) > MAX_SECRET_BYTES or any(ord(character) < 32 or ord(character) == 127 for character in secret):
                raise ProbeError(f"required secret environment variable is absent or invalid: {environment}")
            resolved[environment] = secret
    return resolved


def _execute_probe(probe: RealtimeCase, authority: Authority, route: RuntimeRoute, secret_values: dict[str, str], global_deadline: float) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="cyberful-realtime-probe-") as directory:
        temporary = Path(directory)
        headers_path = temporary / "headers.bin"
        body_path = temporary / "body.bin"
        request_body_path = temporary / "request.bin"
        config_path = temporary / "curl.conf"
        request_body_path.write_bytes(probe.body)
        os.chmod(request_body_path, 0o600)
        config_lines = [f'header = "{_curl_quote(name)}: {_curl_quote(value)}"' for name, value in probe.headers]
        resolved_headers = tuple((name, environment, secret_values[environment]) for name, environment in probe.secret_headers)
        config_lines.extend(f'header = "{_curl_quote(name)}: {_curl_quote(secret)}"' for name, _, secret in resolved_headers)
        config_path.write_text("\n".join(config_lines) + ("\n" if config_lines else ""), encoding="utf-8")
        os.chmod(config_path, 0o600)
        argv = [
            "curl", "--disable", "--silent", "--show-error", "--proto", "=http,https", "--proto-redir", "=http,https",
            "--request", probe.method, "--url", probe.url, "--connect-timeout", str(min(10, authority.request_timeout_seconds)),
            "--max-time", str(authority.request_timeout_seconds), "--max-filesize", str(MAX_CAPTURE_BYTES), "--dump-header", str(headers_path),
            "--output", str(body_path), "--write-out", "%{http_code}", "--config", str(config_path),
        ]
        parsed_url = urlsplit(probe.url)
        proxy_url = route.http_proxy if parsed_url.scheme == "http" else route.https_proxy
        if _is_loopback(parsed_url):
            argv.extend(("--proxy", ""))
        else:
            if proxy_url is None:
                raise ProbeError("non-loopback request lost its host-provided proxy route")
            argv.extend(("--proxy", proxy_url, "--noproxy", ""))
        if route.ca_bundle is not None:
            argv.extend(("--cacert", str(route.ca_bundle)))
        if probe.body:
            argv.extend(("--data-binary", f"@{request_body_path}"))
        started = time.monotonic()
        remaining = global_deadline - started
        if remaining <= 0:
            raise ProbeError("probe campaign exceeded its global deadline")
        process = _run_process(
            argv,
            min(authority.request_timeout_seconds + 2.0, remaining),
            monitored_files=((headers_path, MAX_HEADER_BYTES, "response headers"), (body_path, MAX_CAPTURE_BYTES, "response body")),
        )
        elapsed_ms = round((time.monotonic() - started) * 1000)
        raw_headers, headers_truncated, header_size = _bounded_file(headers_path, MAX_HEADER_BYTES)
        raw_body, body_truncated, body_size = _bounded_file(body_path, MAX_CAPTURE_BYTES)
        status_text = process.stdout.decode("ascii", errors="replace").strip()
        status = int(status_text) if status_text.isdigit() and len(status_text) == 3 else None
        secret_values_for_probe = tuple(secret for _, _, secret in resolved_headers)
        raw_headers, header_redactions, redacted_headers_truncated = _redact(raw_headers, secret_values_for_probe, MAX_HEADER_BYTES)
        raw_body, body_redactions, redacted_body_truncated = _redact(raw_body, secret_values_for_probe, MAX_CAPTURE_BYTES)
        stderr, stderr_redactions, _ = _redact(process.stderr, secret_values_for_probe, MAX_STDERR_BYTES)
        headers_truncated = headers_truncated or redacted_headers_truncated or process.limit_exceeded == "response headers"
        body_truncated = body_truncated or redacted_body_truncated or process.limit_exceeded == "response body"
        request_material = json.dumps({
            "method": probe.method,
            "url": probe.url,
            "headers": list(probe.headers),
            "secret_header_hashes": [(name, hashlib.sha256(secret.encode("utf-8")).hexdigest()) for name, _, secret in resolved_headers],
            "body_sha256": hashlib.sha256(probe.body).hexdigest(),
        }, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return {
            "probe_id": probe.probe_id,
            "kind": probe.kind,
            "principal": probe.principal,
            "tenant": probe.tenant,
            "channel": probe.channel,
            "request": {
                "method": probe.method,
                "url": probe.url,
                "headers": [{"name": name, "value": value} for name, value in probe.headers],
                "secret_headers": [{"name": name, "environment": environment, "value_sha256": hashlib.sha256(secret.encode("utf-8")).hexdigest()} for name, environment, secret in resolved_headers],
                "body_bytes": len(probe.body),
                "body_sha256": hashlib.sha256(probe.body).hexdigest(),
                "request_sha256": hashlib.sha256(request_material).hexdigest(),
            },
            "transport": {
                "return_code": process.return_code,
                "timed_out": process.timed_out,
                "limit_exceeded": process.limit_exceeded,
                "elapsed_ms": elapsed_ms,
                "http_status": status,
                "route": "direct-loopback" if _is_loopback(parsed_url) else "cyberful-os-proxy",
                "stderr": stderr.decode("utf-8", errors="replace"),
                "stderr_redactions": stderr_redactions,
            },
            "response": {
                "headers_base64": base64.b64encode(raw_headers).decode("ascii"),
                "headers_bytes": header_size,
                "headers_truncated": headers_truncated,
                "headers_redactions": header_redactions,
                "body_base64": base64.b64encode(raw_body).decode("ascii"),
                "body_bytes": body_size,
                "body_truncated": body_truncated,
                "body_redactions": body_redactions,
            },
        }


def run_probe(payload: dict[str, Any], workspace: Path, source_sha256: str) -> dict[str, Any]:
    campaign_id, authority, probes = _probe_plan(payload, workspace)
    route = _runtime_route(probes)
    secret_values = _resolved_secrets(probes)
    results: list[dict[str, Any]] = []
    next_request_at = time.monotonic()
    interval = 1.0 / authority.requests_per_second
    deadline = time.monotonic() + CAMPAIGN_TIMEOUT_SECONDS
    for probe in probes:
        delay = next_request_at - time.monotonic()
        if delay > 0:
            if time.monotonic() + delay >= deadline:
                raise ProbeError("probe campaign deadline expired before the next request")
            time.sleep(delay)
        results.append(_execute_probe(probe, authority, route, secret_values, deadline))
        if time.monotonic() >= deadline:
            raise ProbeError("probe campaign exceeded its global deadline")
        next_request_at = max(next_request_at + interval, time.monotonic())
    return {
        "format": "cyberful.realtime-probe-evidence.v1",
        "campaign_id": campaign_id,
        "authorization_reference": authority.authorization_reference,
        "source_sha256": source_sha256,
        "limits": {"requests": authority.max_requests, "concurrency": 1, "requests_per_second": authority.requests_per_second, "request_timeout_seconds": authority.request_timeout_seconds, "campaign_timeout_seconds": int(CAMPAIGN_TIMEOUT_SECONDS)},
        "probes": results,
        "interpretation": "Raw bounded transport evidence only; apply protocol delivery, retry, freshness, signature, channel, and current-authorization semantics before reaching a vulnerability conclusion.",
    }


def _write_report(workspace: Path, value: str, report: dict[str, Any], source: Path) -> None:
    destination = _confined_path(workspace, value, must_exist=False)
    if destination == source:
        raise ProbeError("output must not replace the source probe plan")
    if not destination.parent.is_dir():
        raise ProbeError("output parent must be an existing directory")
    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode("utf-8")
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise ProbeError(f"rendered evidence exceeds the {MAX_OUTPUT_BYTES}-byte limit")
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
    parser = argparse.ArgumentParser(description="Run bounded authorized realtime integration probes.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw, source = _read_json(workspace, arguments.input)
        report = run_probe(payload, workspace, hashlib.sha256(raw).hexdigest())
        _write_report(workspace, arguments.output, report, source)
    except (ProbeError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
