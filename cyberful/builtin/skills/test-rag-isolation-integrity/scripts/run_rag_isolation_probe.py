#!/usr/bin/env python3
# ── Bounded RAG Isolation Probe ────────────────────────────
# Sends preflighted synthetic retrieval cases through the Cyberful-owned route
#   and records secret-redacted raw transport evidence without judging impact.
# → cyberful/builtin/skills/test-rag-isolation-integrity/assets/rag-isolation-probe.schema.json — input boundary.
# → cyberful/builtin/skills/test-rag-isolation-integrity/assets/rag-isolation-evidence.schema.json — evidence.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import errno
import hashlib
import ipaddress
import json
import os
from pathlib import Path
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


INPUT_SCHEMA: Final = "assets/rag-isolation-probe.schema.json"
MAX_INPUT_BYTES: Final = 262_144
MAX_OUTPUT_BYTES: Final = 1_048_576
MAX_REQUEST_BODY_BYTES: Final = 65_536
MAX_CAPTURE_BYTES: Final = 65_536
MAX_STREAM_BYTES: Final = 8_192
MAX_SECRET_BYTES: Final = 4_096
MAX_CA_BUNDLE_BYTES: Final = 4_194_304
MAX_REQUESTS: Final = 8
MAX_RATE: Final = 4.0
GLOBAL_TIMEOUT_SECONDS: Final = 60.0
REQUEST_TIMEOUT_SECONDS: Final = 15
SECRET_ENVIRONMENT: Final = "CYBERFUL_RAG_AUTHORIZATION"
PASSTHROUGH_ENVIRONMENT: Final = ("PATH", "TMPDIR")


class ProbeError(ValueError):
    """Raised when a probe violates an input, authority, or execution boundary."""


@dataclass(frozen=True)
class Attribution:
    authorization_reference: str
    allowed_origins: frozenset[str]
    actor_id: str
    tenant_id: str


@dataclass(frozen=True)
class Limits:
    max_requests: int
    requests_per_second: float


@dataclass(frozen=True)
class RagCase:
    case_id: str
    endpoint: str
    query: str
    corpus_id: str
    actor_id: str
    tenant_id: str
    marker_ids: tuple[str, ...]


@dataclass(frozen=True)
class RuntimeRoute:
    proxies: tuple[tuple[str, str], ...]
    trust_environment: str | None
    ca_bundle: bytes | None


@dataclass(frozen=True)
class ProcessResult:
    return_code: int
    stderr: bytes
    timed_out: bool
    limit_exceeded: bool


def _text(value: Any, label: str, maximum: int = 4_096) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ProbeError(f"{label} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > maximum or any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise ProbeError(f"{label} exceeds its boundary or contains control characters")
    return normalized


def _workspace(value: str) -> Path:
    workspace = Path(os.path.realpath(Path(value).resolve(strict=True)))
    if not workspace.is_dir():
        raise ProbeError("workspace must be an existing directory")
    return workspace


def _confined(workspace: Path, value: str, *, must_exist: bool) -> Path:
    workspace = Path(os.path.realpath(workspace))
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise ProbeError("paths must be relative and non-traversing")
    cursor = workspace
    for component in requested.parts:
        cursor = cursor / component
        if cursor.is_symlink():
            raise ProbeError("symbolic links are not accepted")
    resolved_path = (workspace / requested).resolve(strict=must_exist)
    resolved = Path(os.path.realpath(resolved_path)) if must_exist else resolved_path
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise ProbeError("path escapes workspace") from error
    return resolved


# ── Descriptor Identity Pins Security-Sensitive Reads ────────────
# Canonical paths establish reporting and collision identity, but path checks
# alone cannot prevent a file swap between validation and reading. Each input
# and host-owned CA is therefore opened with O_NOFOLLOW, matched against lstat
# by device and inode, read through that descriptor under a byte cap, and then
# rechecked before the descriptor closes.
# ─────────────────────────────────────────────────────────────────
def _read_bounded_regular(path: Path, maximum: int, label: str) -> tuple[bytes, Path, tuple[int, int]]:
    try:
        before = os.lstat(path)
        canonical = Path(os.path.realpath(path))
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    except OSError as error:
        raise ProbeError(f"{label} must be an existing non-symlink regular file") from error
    try:
        opened = os.fstat(descriptor)
        after = os.lstat(path)
        after_canonical = Path(os.path.realpath(path))
        identity = (opened.st_dev, opened.st_ino)
        if (
            not stat.S_ISREG(before.st_mode)
            or not stat.S_ISREG(opened.st_mode)
            or not stat.S_ISREG(after.st_mode)
            or (before.st_dev, before.st_ino) != identity
            or (after.st_dev, after.st_ino) != identity
            or after_canonical != canonical
            or opened.st_size > maximum
        ):
            raise ProbeError(f"{label} changed during open or is not a bounded regular file")
        content = bytearray()
        while len(content) <= maximum:
            chunk = os.read(descriptor, min(65_536, maximum + 1 - len(content)))
            if not chunk:
                break
            content.extend(chunk)
        final = os.fstat(descriptor)
        if (final.st_dev, final.st_ino) != identity or final.st_size != opened.st_size or len(content) != opened.st_size or len(content) > maximum:
            raise ProbeError(f"{label} changed while being read or exceeds its boundary")
        return bytes(content), canonical, identity
    finally:
        os.close(descriptor)


def _read_input(workspace: Path, value: str) -> tuple[dict[str, Any], bytes, Path]:
    source = _confined(workspace, value, must_exist=True)
    raw, source, _ = _read_bounded_regular(source, MAX_INPUT_BYTES, "input")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProbeError("input must be UTF-8 JSON") from error
    if not isinstance(payload, dict):
        raise ProbeError("input must be a JSON object")
    return payload, raw, source


def _http_url(value: Any, label: str) -> SplitResult:
    parsed = urlsplit(_text(value, label))
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ProbeError(f"{label} must be an HTTP(S) URL without credentials or fragment")
    try:
        parsed.port
    except ValueError as error:
        raise ProbeError(f"{label} has an invalid port") from error
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if hostname == "localhost" or hostname.endswith(".localhost"):
        raise ProbeError(f"{label} must use a literal loopback IP")
    return parsed


def _origin(parsed: SplitResult) -> str:
    host = (parsed.hostname or "").lower()
    authority = f"[{host}]" if ":" in host else host
    return f"{parsed.scheme.lower()}://{authority}:{parsed.port or (80 if parsed.scheme == 'http' else 443)}"


def _loopback(parsed: SplitResult) -> bool:
    try:
        return ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        return False


# ── Full Preflight Before Runtime Route Or Secret Resolution ────
# The model can supply attribution, exact origins, cases, and tighter limits. It
# cannot select a proxy, trust root, command, arbitrary header, or credential.
# Every case is validated before route or secret environment variables are read,
# so an invalid trailing case cannot leave partial traffic. Non-loopback traffic
# then fails closed unless the Cyberful runtime supplies both proxy and trust.
# ─────────────────────────────────────────────────────────────────
def _validated(payload: dict[str, Any]) -> tuple[Attribution, Limits, tuple[RagCase, ...]]:
    if set(payload) != {"$schema", "attribution", "limits", "cases"} or payload.get("$schema") != INPUT_SCHEMA:
        raise ProbeError("input contains missing or unknown fields, or an invalid $schema")
    attribution = payload["attribution"]
    if not isinstance(attribution, dict) or set(attribution) != {"authorization_reference", "expires_at", "allowed_origins", "actor_id", "tenant_id"}:
        raise ProbeError("attribution contains missing or unknown fields")
    expires_at = _text(attribution["expires_at"], "attribution.expires_at", 64)
    try:
        expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProbeError("attribution.expires_at must be an ISO-8601 timestamp") from error
    if expires.tzinfo is None or expires.astimezone(timezone.utc) <= datetime.now(timezone.utc):
        raise ProbeError("attribution has expired")
    raw_origins = attribution["allowed_origins"]
    if not isinstance(raw_origins, list) or not 1 <= len(raw_origins) <= 8:
        raise ProbeError("attribution.allowed_origins must contain 1..8 origins")
    parsed_origins = tuple(_http_url(value, "attribution.allowed_origins[]") for value in raw_origins)
    if any(parsed.path not in {"", "/"} or parsed.query or parsed.port is None for parsed in parsed_origins):
        raise ProbeError("allowed origins must include an explicit port and no path or query")
    allowed_origins = frozenset(_origin(parsed) for parsed in parsed_origins)
    if len(allowed_origins) != len(raw_origins):
        raise ProbeError("allowed origins must be unique after normalization")
    limits = payload["limits"]
    if not isinstance(limits, dict) or set(limits) != {"max_requests", "requests_per_second"}:
        raise ProbeError("limits contain missing or unknown fields")
    max_requests = limits["max_requests"]
    rate = limits["requests_per_second"]
    if not isinstance(max_requests, int) or isinstance(max_requests, bool) or not 1 <= max_requests <= MAX_REQUESTS:
        raise ProbeError("limits.max_requests must be an integer between 1 and 8")
    if not isinstance(rate, (int, float)) or isinstance(rate, bool) or not 0 < float(rate) <= MAX_RATE:
        raise ProbeError("limits.requests_per_second must be greater than zero and at most 4")
    raw_cases = payload["cases"]
    case_fields = {"id", "endpoint", "query", "corpus_id", "actor_id", "tenant_id", "marker_ids"}
    if not isinstance(raw_cases, list) or not 1 <= len(raw_cases) <= max_requests:
        raise ProbeError("cases must contain 1..limits.max_requests entries")
    cases: list[RagCase] = []
    for index, raw_case in enumerate(raw_cases):
        if not isinstance(raw_case, dict) or set(raw_case) != case_fields:
            raise ProbeError(f"cases[{index}] contains missing or unknown fields")
        endpoint = _text(raw_case["endpoint"], f"cases[{index}].endpoint")
        parsed = _http_url(endpoint, f"cases[{index}].endpoint")
        if _origin(parsed) not in allowed_origins:
            raise ProbeError(f"cases[{index}].endpoint is outside allowed origins")
        marker_ids = raw_case["marker_ids"]
        if not isinstance(marker_ids, list) or len(marker_ids) > 32:
            raise ProbeError(f"cases[{index}].marker_ids must contain at most 32 values")
        normalized_markers = tuple(_text(value, f"cases[{index}].marker_ids[]", 128) for value in marker_ids)
        if len(set(normalized_markers)) != len(normalized_markers):
            raise ProbeError(f"cases[{index}].marker_ids must be unique")
        case = RagCase(
            _text(raw_case["id"], f"cases[{index}].id", 128), endpoint,
            _text(raw_case["query"], f"cases[{index}].query", 16_384),
            _text(raw_case["corpus_id"], f"cases[{index}].corpus_id", 256),
            _text(raw_case["actor_id"], f"cases[{index}].actor_id", 256),
            _text(raw_case["tenant_id"], f"cases[{index}].tenant_id", 256), normalized_markers,
        )
        if case.actor_id != attribution["actor_id"] or case.tenant_id != attribution["tenant_id"]:
            raise ProbeError(f"cases[{index}] identity does not match attribution")
        encoded = json.dumps(_request_document(case), sort_keys=True, separators=(",", ":")).encode()
        if len(encoded) > MAX_REQUEST_BODY_BYTES:
            raise ProbeError(f"cases[{index}] request body exceeds its boundary")
        cases.append(case)
    if len({case.case_id for case in cases}) != len(cases):
        raise ProbeError("case ids must be unique")
    return Attribution(
        _text(attribution["authorization_reference"], "attribution.authorization_reference", 1_024),
        allowed_origins, _text(attribution["actor_id"], "attribution.actor_id", 256),
        _text(attribution["tenant_id"], "attribution.tenant_id", 256),
    ), Limits(max_requests, float(rate)), tuple(cases)


def _request_document(case: RagCase) -> dict[str, Any]:
    return {"actor_id": case.actor_id, "corpus_id": case.corpus_id, "marker_ids": list(case.marker_ids), "query": case.query, "tenant_id": case.tenant_id}


def _runtime_route(cases: tuple[RagCase, ...]) -> RuntimeRoute:
    schemes = {urlsplit(case.endpoint).scheme for case in cases if not _loopback(urlsplit(case.endpoint))}
    proxies: list[tuple[str, str]] = []
    for scheme in sorted(schemes):
        name = f"{scheme.upper()}_PROXY"
        value = os.environ.get(name)
        if not value:
            raise ProbeError(f"non-loopback {scheme} targets require host-provided {name}")
        parsed = _http_url(value, name)
        if parsed.port is None or parsed.path not in {"", "/"} or parsed.query:
            raise ProbeError(f"{name} must be an explicit proxy origin")
        proxies.append((scheme, value))
    if not schemes:
        return RuntimeRoute(tuple(), None, None)
    trust_name = "CURL_CA_BUNDLE" if os.environ.get("CURL_CA_BUNDLE") else "SSL_CERT_FILE" if os.environ.get("SSL_CERT_FILE") else None
    if trust_name is None:
        raise ProbeError("non-loopback targets require a host-provided CA bundle")
    ca_path = Path(_text(os.environ[trust_name], trust_name))
    ca_bundle, _, _ = _read_bounded_regular(ca_path, MAX_CA_BUNDLE_BYTES, "runtime CA bundle")
    return RuntimeRoute(tuple(proxies), trust_name, ca_bundle)


def _secret() -> str:
    value = os.environ.get(SECRET_ENVIRONMENT)
    if not value or len(value.encode()) > MAX_SECRET_BYTES or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ProbeError(f"{SECRET_ENVIRONMENT} is absent or invalid")
    return value


def _child_environment(secret: str, proxy: tuple[str, str] | None = None, ca_bundle: Path | None = None) -> dict[str, str]:
    environment = {name: os.environ[name] for name in PASSTHROUGH_ENVIRONMENT if os.environ.get(name)}
    environment.setdefault("PATH", "/usr/bin:/bin")
    environment.update({
        "LANG": "C", "LC_ALL": "C", "DO_NOT_TRACK": "1", "DISABLE_UPDATE_CHECK": "true",
        "NO_PROXY": "", "no_proxy": "", "ALL_PROXY": "", "all_proxy": "", SECRET_ENVIRONMENT: secret,
    })
    if proxy is not None and proxy[0] not in {"HTTP_PROXY", "HTTPS_PROXY"}:
        raise ProbeError("child proxy environment is not allowlisted")
    if proxy is not None:
        environment[proxy[0]] = proxy[1]
    if ca_bundle is not None:
        environment["CURL_CA_BUNDLE"] = str(ca_bundle)
    return environment


def _signal_group(process_group: int, signal_number: int) -> str:
    try:
        os.killpg(process_group, signal_number)
        return "sent"
    except ProcessLookupError:
        return "gone"
    except OSError as error:
        if error.errno == errno.ESRCH:
            return "gone"
        if error.errno == errno.EPERM:
            return "denied"
        raise


def _terminate_group(process: subprocess.Popen[bytes]) -> None:
    term_result = _signal_group(process.pid, signal.SIGTERM)
    if term_result == "denied" and process.poll() is None:
        raise ProbeError("curl process group denied termination while the leader remained live")
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    kill_result = _signal_group(process.pid, signal.SIGKILL)
    if kill_result == "denied" and process.poll() is None:
        raise ProbeError("curl process group denied forced termination while the leader remained live")
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired as error:
        raise ProbeError("curl process group could not be reaped") from error


def _file_limit() -> None:
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_CAPTURE_BYTES, MAX_CAPTURE_BYTES))


def _run_process(argv: list[str], input_path: Path, environment: dict[str, str], deadline: float, captures: tuple[Path, Path]) -> ProcessResult:
    with input_path.open("rb") as request_stream:
        try:
            process = subprocess.Popen(
                argv, stdin=request_stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=environment, shell=False, start_new_session=True, preexec_fn=_file_limit,
            )
        except (OSError, subprocess.SubprocessError) as error:
            raise ProbeError(f"could not start fixed curl command: {error}") from error
        if process.stdout is None or process.stderr is None:
            _terminate_group(process)
            raise ProbeError("curl output pipes were not created")
        selector = selectors.DefaultSelector()
        buffers = {process.stdout: bytearray(), process.stderr: bytearray()}
        limits = {process.stdout: 64, process.stderr: MAX_STREAM_BYTES}
        for stream in buffers:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ)
        timed_out = False
        exceeded = False
        try:
            while selector.get_map() or process.poll() is None:
                if any(path.exists() and path.stat().st_size >= MAX_CAPTURE_BYTES for path in captures):
                    exceeded = True
                    _terminate_group(process)
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    _terminate_group(process)
                    break
                for key, _ in selector.select(timeout=min(0.01, remaining)):
                    stream = key.fileobj
                    try:
                        chunk = os.read(stream.fileno(), 65_536)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(stream)
                        stream.close()
                        continue
                    available = limits[stream] - len(buffers[stream])
                    buffers[stream].extend(chunk[:max(0, available)])
                    if len(chunk) > available:
                        exceeded = True
                        _terminate_group(process)
                        break
                if exceeded:
                    break
            if process.poll() is None:
                process.wait(timeout=1.0)
        finally:
            selector.close()
            for stream in buffers:
                if not stream.closed:
                    stream.close()
            _terminate_group(process)
        return ProcessResult(process.returncode, bytes(buffers[process.stderr]), timed_out, exceeded)


def _redact(content: bytes, secret: str) -> tuple[bytes, bool]:
    redacted = content.replace(secret.encode(), b"[REDACTED_SECRET]")
    return redacted[:MAX_CAPTURE_BYTES], len(redacted) > MAX_CAPTURE_BYTES


def _capture(path: Path, secret: str) -> tuple[bytes, bool]:
    if not path.exists():
        return b"", False
    size = path.stat().st_size
    with path.open("rb") as stream:
        content = stream.read(MAX_CAPTURE_BYTES + 1)
    redacted, redaction_truncated = _redact(content, secret)
    return redacted, size >= MAX_CAPTURE_BYTES or len(content) > MAX_CAPTURE_BYTES or redaction_truncated


def _command(case: RagCase, route: RuntimeRoute, headers_path: Path, body_path: Path) -> list[str]:
    parsed = urlsplit(case.endpoint)
    argv = [
        "curl", "--disable", "--silent", "--show-error", "--path-as-is", "--proto", "=http,https",
        "--proto-redir", "=http,https", "--max-redirs", "0", "--request", "POST", "--connect-timeout", "5",
        "--max-time", str(REQUEST_TIMEOUT_SECONDS), "--dump-header", str(headers_path), "--output", str(body_path),
        "--header", "Content-Type: application/json", "--variable", f"%{SECRET_ENVIRONMENT}",
        "--expand-header", f"Authorization: {{{{{SECRET_ENVIRONMENT}}}}}", "--data-binary", "@-", "--url", case.endpoint,
    ]
    if _loopback(parsed):
        argv.extend(("--proxy", ""))
    else:
        proxies = dict(route.proxies)
        proxy_environment = f"{parsed.scheme.upper()}_PROXY"
        if parsed.scheme not in proxies:
            raise ProbeError("non-loopback request lost runtime route")
        argv.extend(("--variable", f"%{proxy_environment}", "--expand-proxy", f"{{{{{proxy_environment}}}}}", "--noproxy", ""))
        if route.ca_bundle is None:
            raise ProbeError("non-loopback request lost runtime trust")
    return argv


def _write_private(path: Path, content: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _execute(case: RagCase, route: RuntimeRoute, secret: str, deadline: float) -> dict[str, Any]:
    request = json.dumps(_request_document(case), sort_keys=True, separators=(",", ":")).encode()
    with tempfile.TemporaryDirectory(prefix="cyberful-rag-probe-") as directory:
        temporary = Path(directory)
        request_path = temporary / "request.json"
        headers_path = temporary / "headers.bin"
        body_path = temporary / "body.bin"
        _write_private(request_path, request)
        parsed = urlsplit(case.endpoint)
        proxy = None if _loopback(parsed) else (f"{parsed.scheme.upper()}_PROXY", dict(route.proxies)[parsed.scheme])
        ca_path: Path | None = None
        if proxy is not None and route.ca_bundle is not None:
            ca_path = temporary / "ca.pem"
            _write_private(ca_path, route.ca_bundle)
        started = time.monotonic()
        result = _run_process(
            _command(case, route, headers_path, body_path), request_path, _child_environment(secret, proxy, ca_path),
            min(deadline, started + REQUEST_TIMEOUT_SECONDS + 2), (headers_path, body_path),
        )
        headers, headers_truncated = _capture(headers_path, secret)
        body, body_truncated = _capture(body_path, secret)
        stderr, stderr_truncated = _redact(result.stderr, secret)
        return {
            "case_id": case.case_id, "endpoint": case.endpoint, "corpus_id": case.corpus_id,
            "actor_id": case.actor_id, "tenant_id": case.tenant_id, "marker_ids": list(case.marker_ids),
            "request_sha256": hashlib.sha256(request).hexdigest(),
            "route": "direct-loopback" if _loopback(urlsplit(case.endpoint)) else "runtime-http-proxy",
            "exit_code": result.return_code, "duration_ms": max(0, round((time.monotonic() - started) * 1_000)),
            "headers_base64": base64.b64encode(headers).decode(), "body_base64": base64.b64encode(body).decode(),
            "stderr_base64": base64.b64encode(stderr).decode(),
            "truncated": result.timed_out or result.limit_exceeded or headers_truncated or body_truncated or stderr_truncated,
        }


def run_probe(payload: dict[str, Any], source_sha256: str, deadline: float) -> dict[str, Any]:
    attribution, limits, cases = _validated(payload)
    route = _runtime_route(cases)
    secret = _secret()
    executions: list[dict[str, Any]] = []
    interval = 1.0 / limits.requests_per_second
    next_request = time.monotonic()
    for case in cases:
        delay = next_request - time.monotonic()
        if delay > 0:
            if time.monotonic() + delay >= deadline:
                raise ProbeError("global deadline expired before the next request")
            time.sleep(delay)
        executions.append(_execute(case, route, secret, deadline))
        if time.monotonic() >= deadline:
            raise ProbeError("global deadline expired")
        next_request = max(next_request + interval, time.monotonic())
    return {
        "format": "cyberful.rag-isolation-probe.raw.v1", "input_sha256": source_sha256,
        "authorization_reference": attribution.authorization_reference,
        "transport": {
            "route": "runtime-http-proxy-or-literal-loopback", "direct_non_loopback": False,
            "proxy_environment": [f"{scheme.upper()}_PROXY" for scheme, _ in route.proxies],
            "trust_environment": route.trust_environment,
        },
        "executions": executions,
    }


def _destination(workspace: Path, value: str, source: Path) -> Path:
    destination = _confined(workspace, value, must_exist=False)
    if destination == source or destination.exists() or not destination.parent.is_dir():
        raise ProbeError("output must be new, distinct from input, and have an existing parent")
    return destination


def _write(destination: Path, report: dict[str, Any], deadline: float) -> None:
    rendered = f"{json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False)}\n".encode()
    if len(rendered) > MAX_OUTPUT_BYTES or time.monotonic() >= deadline:
        raise ProbeError("rendered evidence exceeds its boundary or deadline")
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=destination.parent, prefix=f".{destination.name}.", delete=False) as temporary:
            temporary_name = temporary.name
            os.chmod(temporary_name, 0o600)
            temporary.write(rendered)
            temporary.flush()
            os.fsync(temporary.fileno())
        if time.monotonic() >= deadline:
            raise ProbeError("global deadline expired before evidence publication")
        try:
            os.link(temporary_name, destination, follow_symlinks=False)
        except FileExistsError as error:
            raise ProbeError("output appeared during evidence publication") from error
        Path(temporary_name).unlink()
        temporary_name = None
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run bounded authorized RAG isolation cases.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(sys.argv[1:] if argv is None else argv)
    deadline = time.monotonic() + GLOBAL_TIMEOUT_SECONDS
    try:
        workspace = _workspace(arguments.workspace)
        payload, raw, source = _read_input(workspace, arguments.input)
        destination = _destination(workspace, arguments.output, source)
        _write(destination, run_probe(payload, hashlib.sha256(raw).hexdigest(), deadline), deadline)
    except (ProbeError, OSError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
