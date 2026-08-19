#!/usr/bin/env python3
# ── Authorized SOAP XML Probe ───────────────────────────────────
# Executes bounded SOAP 1.1 or 1.2 curl cases after validating campaign
#   constraints, runtime transport, trust, secret handling, and evidence.
# → cyberful/builtin/skills/test-soap-xml-services/assets/soap-xml-probe.schema.json — input contract.
# → cyberful/builtin/skills/test-soap-xml-services/tests/test_run_soap_xml_probe.py — forward tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Final
from urllib.parse import SplitResult, urlsplit


TRUSTED_COMMAND: Final = "curl"
AUTHORIZATION_ENV: Final = "CYBERFUL_SOAP_AUTHORIZATION"
PROXY_ENVIRONMENT: Final = {"http": "HTTP_PROXY", "https": "HTTPS_PROXY"}
TRUST_ENVIRONMENT: Final = ("SSL_CERT_FILE", "CURL_CA_BUNDLE")
MAX_INPUT_BYTES: Final = 1_048_576
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_REQUESTS: Final = 20
MAX_RATE: Final = 10.0
MAX_STREAM_BYTES: Final = 1_048_576
PROBE_TIMEOUT_SECONDS: Final = 60
READ_CHUNK_BYTES: Final = 65_536
DNS_LABEL: Final = re.compile(r"(?!-)[A-Za-z0-9-]{1,63}(?<!-)$")
HEADER_NAME: Final = re.compile(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")


class ProbeError(ValueError):
    """Raised when a probe violates campaign, transport, or evidence bounds."""


@dataclass(frozen=True)
class Constraints:
    authorization_reference: str
    expires_at: datetime
    allowed_origins: frozenset[str]
    max_requests: int
    requests_per_second: float
    allowed_effects: frozenset[str]
    actor_id: str
    tenant_id: str


@dataclass(frozen=True)
class ProbeCase:
    identifier: str
    endpoint_url: str
    endpoint: SplitResult
    soap_version: str
    action: str
    envelope: str
    headers: tuple[tuple[str, str], ...]
    effect: str
    actor_id: str
    tenant_id: str


@dataclass(frozen=True)
class Transport:
    proxy: str | None
    proxy_environment: str | None
    trust_path: Path | None
    trust_environment: str | None


# ── Transport Follows Complete Campaign Validation ──────────────
# JSON constraints can narrow origins, identities, effects, request count, and
# rate, but they cannot establish network authority. Only the host-owned runtime
# proxy permits a non-loopback endpoint, while literal loopback remains direct.
# Trust paths and credentials are resolved from canonical environment variables
# after every case passes preflight, keeping them beyond the model boundary.
# ─────────────────────────────────────────────────────────────────


def _workspace(value: str) -> Path:
    path = Path(value).resolve(strict=True)
    if not path.is_dir():
        raise ProbeError("workspace must be an existing directory")
    return path


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    requested = Path(value)
    if not value or requested.is_absolute() or ".." in requested.parts:
        raise ProbeError("paths must be relative and non-traversing")
    cursor = workspace
    for part in requested.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ProbeError("symbolic links are not allowed")
    resolved = (workspace / requested).resolve(strict=exists)
    try:
        resolved.relative_to(workspace)
    except ValueError as error:
        raise ProbeError("path escapes workspace") from error
    return resolved


def _read(path: Path) -> tuple[dict[str, Any], str]:
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_INPUT_BYTES:
        raise ProbeError("input must be a bounded regular file")
    raw = path.read_bytes()
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProbeError("input must be UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ProbeError("input must contain a JSON object")
    return value, hashlib.sha256(raw).hexdigest()


def _text(value: Any, label: str, maximum: int, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value) or len(value.encode()) > maximum:
        raise ProbeError(f"{label} must be a bounded string")
    return value


def _control_free(value: Any, label: str, maximum: int, *, allow_empty: bool = False) -> str:
    normalized = _text(value, label, maximum, allow_empty=allow_empty)
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized):
        raise ProbeError(f"{label} must not contain control characters")
    return normalized


def _xml_text(value: Any, label: str, maximum: int) -> str:
    normalized = _text(value, label, maximum)
    if any((ord(character) < 32 and character not in "\t\n\r") or ord(character) == 127 for character in normalized):
        raise ProbeError(f"{label} contains a forbidden XML control character")
    return normalized


def _origin(value: Any, label: str, *, declaration: bool = False) -> tuple[str, SplitResult]:
    raw = _text(value, label, 4096)
    if any(character.isspace() for character in raw):
        raise ProbeError(f"{label} must not contain whitespace")
    parsed = urlsplit(raw)
    try:
        port = parsed.port
    except ValueError as error:
        raise ProbeError(f"{label} contains a malformed port") from error
    if parsed.scheme not in PROXY_ENVIRONMENT or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ProbeError(f"{label} must be an HTTP(S) URL without credentials or fragment")
    host_value = parsed.hostname
    try:
        address = ipaddress.ip_address(host_value)
        host = f"[{address.compressed}]" if address.version == 6 else address.compressed
    except ValueError:
        try:
            host = host_value.encode("idna").decode("ascii").lower().rstrip(".")
        except UnicodeError as error:
            raise ProbeError(f"{label} contains an invalid hostname") from error
        if not host or any(not DNS_LABEL.fullmatch(item) for item in host.split(".")):
            raise ProbeError(f"{label} contains an invalid hostname")
    effective_port = port or (443 if parsed.scheme == "https" else 80)
    canonical = f"{parsed.scheme}://{host}:{effective_port}"
    if declaration and (parsed.path not in {"", "/"} or parsed.query or raw != canonical):
        raise ProbeError(f"{label} must be a canonical exact origin")
    return canonical, parsed


def _literal_loopback(parsed: SplitResult) -> bool:
    try:
        return ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        return False


def _expiry(value: Any) -> datetime:
    raw = _text(value, "constraints.expires_at", 64)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProbeError("constraints.expires_at must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ProbeError("constraints.expires_at must include a timezone")
    if parsed <= datetime.now(timezone.utc):
        raise ProbeError("campaign constraints are expired")
    return parsed


def _validated(payload: dict[str, Any]) -> tuple[Constraints, list[ProbeCase]]:
    if set(payload) != {"constraints", "cases"}:
        raise ProbeError("input must contain exactly constraints and cases")
    raw_constraints = payload["constraints"]
    raw_cases = payload["cases"]
    required = {"authorization_reference", "expires_at", "allowed_origins", "max_requests", "requests_per_second", "allowed_effects", "actor_id", "tenant_id"}
    if not isinstance(raw_constraints, dict) or set(raw_constraints) != required:
        raise ProbeError("campaign constraints are malformed")
    origins = raw_constraints["allowed_origins"]
    if not isinstance(origins, list) or not 1 <= len(origins) <= MAX_REQUESTS:
        raise ProbeError("allowed_origins must be a bounded non-empty array")
    normalized_origins = [_origin(item, f"constraints.allowed_origins[{index}]", declaration=True)[0] for index, item in enumerate(origins)]
    if len(set(normalized_origins)) != len(normalized_origins):
        raise ProbeError("allowed_origins must not contain duplicates")
    effects = raw_constraints["allowed_effects"]
    if not isinstance(effects, list) or not 1 <= len(effects) <= 8:
        raise ProbeError("allowed_effects must be a bounded non-empty array")
    normalized_effects = [_text(item, "constraints.allowed_effects", 64) for item in effects]
    if len(set(normalized_effects)) != len(normalized_effects):
        raise ProbeError("allowed_effects must not contain duplicates")
    maximum = raw_constraints["max_requests"]
    rate = raw_constraints["requests_per_second"]
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= MAX_REQUESTS:
        raise ProbeError("max_requests exceeds the probe boundary")
    if not isinstance(rate, (int, float)) or isinstance(rate, bool) or not 0 < float(rate) <= MAX_RATE:
        raise ProbeError("requests_per_second exceeds the probe boundary")
    actor_id = _text(raw_constraints["actor_id"], "constraints.actor_id", 256)
    tenant_id = _text(raw_constraints["tenant_id"], "constraints.tenant_id", 256)
    constraints = Constraints(
        _text(raw_constraints["authorization_reference"], "constraints.authorization_reference", 1024),
        _expiry(raw_constraints["expires_at"]),
        frozenset(normalized_origins),
        maximum,
        float(rate),
        frozenset(normalized_effects),
        actor_id,
        tenant_id,
    )
    if not isinstance(raw_cases, list) or not 1 <= len(raw_cases) <= maximum:
        raise ProbeError("cases exceed campaign request limits")
    cases: list[ProbeCase] = []
    identifiers: set[str] = set()
    case_fields = {"id", "endpoint", "soap_version", "action", "envelope", "headers", "effect", "actor_id", "tenant_id"}
    forbidden_headers = {"authorization", "proxy-authorization", "cookie", "content-length", "content-type", "host", "soapaction"}
    for index, raw_case in enumerate(raw_cases):
        if not isinstance(raw_case, dict) or set(raw_case) != case_fields:
            raise ProbeError(f"cases[{index}] is malformed")
        identifier = _text(raw_case["id"], f"cases[{index}].id", 128)
        if identifier in identifiers:
            raise ProbeError("case identifiers must not collide")
        identifiers.add(identifier)
        endpoint_url = _text(raw_case["endpoint"], f"cases[{index}].endpoint", 4096)
        origin, endpoint = _origin(endpoint_url, f"cases[{index}].endpoint")
        if origin not in constraints.allowed_origins:
            raise ProbeError(f"cases[{index}].endpoint exceeds campaign constraints")
        soap_version = raw_case["soap_version"]
        if soap_version not in {"1.1", "1.2"}:
            raise ProbeError(f"cases[{index}].soap_version is unsupported")
        action = _control_free(raw_case["action"], f"cases[{index}].action", 1024, allow_empty=True)
        envelope = _xml_text(raw_case["envelope"], f"cases[{index}].envelope", 65_536)
        headers = raw_case["headers"]
        if not isinstance(headers, dict) or len(headers) > 16:
            raise ProbeError(f"cases[{index}].headers must be a bounded object")
        normalized_headers: list[tuple[str, str]] = []
        for name, value in sorted(headers.items()):
            if not isinstance(name, str) or not HEADER_NAME.fullmatch(name) or name.lower() in forbidden_headers:
                raise ProbeError(f"cases[{index}] contains forbidden or malformed headers")
            normalized_headers.append((name, _control_free(value, f"cases[{index}].headers.{name}", 1024, allow_empty=True)))
        effect = _text(raw_case["effect"], f"cases[{index}].effect", 64)
        case_actor = _text(raw_case["actor_id"], f"cases[{index}].actor_id", 256)
        case_tenant = _text(raw_case["tenant_id"], f"cases[{index}].tenant_id", 256)
        if effect not in constraints.allowed_effects or case_actor != actor_id or case_tenant != tenant_id:
            raise ProbeError(f"cases[{index}] exceeds campaign effect, actor, or tenant constraints")
        cases.append(ProbeCase(identifier, endpoint_url, endpoint, soap_version, action, envelope, tuple(normalized_headers), effect, case_actor, case_tenant))
    return constraints, cases


def _transport(case: ProbeCase) -> Transport:
    proxy: str | None = None
    proxy_environment: str | None = None
    if not _literal_loopback(case.endpoint):
        proxy_environment = PROXY_ENVIRONMENT[case.endpoint.scheme]
        proxy = os.environ.get(proxy_environment)
        if not proxy:
            raise ProbeError(f"non-loopback endpoints require the Cyberful runtime route in {proxy_environment}")
        _, parsed_proxy = _origin(proxy, proxy_environment, declaration=True)
        if parsed_proxy.scheme != "http" or parsed_proxy.port is None:
            raise ProbeError(f"{proxy_environment} must be a canonical HTTP runtime origin with an explicit port")
    selected = next(((name, os.environ[name]) for name in TRUST_ENVIRONMENT if os.environ.get(name)), None)
    trust_path: Path | None = None
    trust_environment: str | None = None
    if selected is not None:
        trust_environment, raw_path = selected
        declared_path = Path(raw_path)
        if declared_path.is_symlink():
            raise ProbeError(f"{trust_environment} must identify a bounded regular CA bundle")
        trust_path = declared_path.resolve(strict=True)
        metadata = trust_path.stat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4_194_304:
            raise ProbeError(f"{trust_environment} must identify a bounded regular CA bundle")
    if not _literal_loopback(case.endpoint) and trust_path is None:
        raise ProbeError("non-loopback endpoints require a Cyberful runtime CA bundle")
    return Transport(proxy, proxy_environment, trust_path, trust_environment)


def _child_environment(transport: Transport, secret: str | None) -> dict[str, str]:
    environment = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR") if name in os.environ}
    if transport.proxy and transport.proxy_environment:
        environment[transport.proxy_environment] = transport.proxy
    if transport.trust_path and transport.trust_environment:
        environment[transport.trust_environment] = str(transport.trust_path)
    if secret:
        environment[AUTHORIZATION_ENV] = secret
    environment["NO_COLOR"] = "1"
    return environment


def _build_command(case: ProbeCase, transport: Transport, secret: str | None, remaining_seconds: float) -> list[str]:
    command = [TRUSTED_COMMAND, "--disable", "--silent", "--show-error", "--include", "--proto", "=http,https", "--proto-redir", "=http,https", "--max-redirs", "0", "--request", "POST", "--connect-timeout", str(max(1, min(10, int(remaining_seconds)))), "--max-time", str(max(1, int(remaining_seconds)))]
    if transport.proxy:
        command.extend(["--proxy", transport.proxy])
    else:
        command.extend(["--noproxy", "*"])
    if transport.trust_path is not None:
        command.extend(["--cacert", str(transport.trust_path)])
    if case.soap_version == "1.1":
        command.extend(["--header", "Content-Type: text/xml; charset=utf-8", "--header", f'SOAPAction: "{case.action}"'])
    else:
        command.extend(["--header", f'Content-Type: application/soap+xml; charset=utf-8; action="{case.action}"'])
    for name, value in case.headers:
        command.extend(["--header", f"{name}: {value}"])
    if secret:
        command.extend(["--variable", f"%{AUTHORIZATION_ENV}", "--expand-header", "Authorization: {{" + AUTHORIZATION_ENV + "}}"])
    command.extend(["--data-binary", "@-", "--url", case.endpoint_url])
    return command


def _terminate(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired as error:
        raise ProbeError("curl process group did not terminate") from error


def _execute(command: list[str], environment: dict[str, str], deadline: float, output_limit: int, stdin_bytes: bytes) -> tuple[int, int, bytes, bytes]:
    if output_limit <= 0:
        raise ProbeError("SOAP evidence output budget is exhausted")
    if len(stdin_bytes) > 65_536:
        raise ProbeError("SOAP envelope exceeds the stdin boundary")
    started = time.monotonic()
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, start_new_session=True, shell=False)
    stdout = bytearray()
    stderr = bytearray()
    selector = selectors.DefaultSelector()
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    stdin_offset = 0
    failure: ProbeError | None = None
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = ProbeError("SOAP probe exceeded its global deadline")
                break
            for key, _ in selector.select(timeout=min(remaining, 0.2)):
                if key.data == "stdin":
                    try:
                        written = os.write(key.fileobj.fileno(), stdin_bytes[stdin_offset : stdin_offset + READ_CHUNK_BYTES])
                    except BrokenPipeError:
                        written = len(stdin_bytes) - stdin_offset
                    stdin_offset += written
                    if stdin_offset >= len(stdin_bytes):
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
                chunk = os.read(key.fileobj.fileno(), READ_CHUNK_BYTES)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if len(chunk) > output_limit - len(stdout) - len(stderr):
                    failure = ProbeError("raw curl output exceeds the remaining output boundary")
                    break
                (stdout if key.data == "stdout" else stderr).extend(chunk)
            if failure is not None:
                break
        if failure is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failure = ProbeError("SOAP probe exceeded its global deadline")
            else:
                try:
                    process.wait(timeout=remaining)
                except subprocess.TimeoutExpired:
                    failure = ProbeError("SOAP probe exceeded its global deadline")
    finally:
        selector.close()
        _terminate(process)
        if not process.stdin.closed:
            process.stdin.close()
        process.stdout.close()
        process.stderr.close()
    if failure is not None:
        raise failure
    return process.returncode, round((time.monotonic() - started) * 1000), bytes(stdout), bytes(stderr)


def _redact(value: bytes, secret: str | None) -> bytes:
    return value.replace(secret.encode(), b"[REDACTED_SECRET]") if secret else value


def _recorded_command(command: list[str], envelope: str, secret: str | None) -> list[str]:
    envelope_marker = f"[ENVELOPE sha256={hashlib.sha256(envelope.encode()).hexdigest()}]"
    recorded: list[str] = []
    replace_next = False
    for argument in command:
        if replace_next:
            recorded.append(envelope_marker)
            replace_next = False
        else:
            recorded.append(argument.replace(secret, "[REDACTED_SECRET]") if secret else argument)
            replace_next = argument == "--data-binary"
    return recorded


def _serialized_size(value: dict[str, Any]) -> int:
    return len((json.dumps(value, indent=2, sort_keys=True) + "\n").encode())


def run_probe(
    payload: dict[str, Any],
    digest: str,
    *,
    deadline_seconds: float = PROBE_TIMEOUT_SECONDS,
    evidence_limit_bytes: int = MAX_OUTPUT_BYTES,
    deadline: float | None = None,
) -> dict[str, Any]:
    deadline = time.monotonic() + deadline_seconds if deadline is None else deadline
    constraints, cases = _validated(payload)
    transports = [_transport(case) for case in cases]
    secret = os.environ.get(AUTHORIZATION_ENV)
    if secret is not None and (not secret or len(secret.encode()) > 16_384 or any(ord(character) < 32 or ord(character) == 127 for character in secret)):
        raise ProbeError(f"{AUTHORIZATION_ENV} must be a bounded non-empty secret")
    if not 1 <= evidence_limit_bytes <= MAX_OUTPUT_BYTES:
        raise ProbeError("evidence output limit exceeds the probe boundary")
    if time.monotonic() >= deadline:
        raise ProbeError("SOAP probe exceeded its global deadline")
    report: dict[str, Any] = {
        "format": "cyberful.soap-xml-probe.raw.v1",
        "input_sha256": digest,
        "authorization_reference": constraints.authorization_reference,
        "transport": {
            "route": "runtime-http-proxy-or-literal-loopback",
            "direct_non_loopback": False,
            "proxy_environment": sorted({item.proxy_environment for item in transports if item.proxy_environment}),
            "trust_environment": next((item.trust_environment for item in transports if item.trust_environment), None),
        },
        "executions": [],
    }
    next_start = time.monotonic()
    for case, transport in zip(cases, transports, strict=True):
        if datetime.now(timezone.utc) >= constraints.expires_at:
            raise ProbeError("campaign constraints expired during execution")
        delay = next_start - time.monotonic()
        if delay > 0:
            if time.monotonic() + delay >= deadline:
                raise ProbeError("SOAP probe exceeded its global deadline")
            time.sleep(delay)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProbeError("SOAP probe exceeded its global deadline")
        command = _build_command(case, transport, secret, remaining)
        current_size = _serialized_size(report)
        raw_budget = min(MAX_STREAM_BYTES, max(0, (evidence_limit_bytes - current_size - 4096) * 3 // 4))
        exit_code, duration_ms, raw_stdout, raw_stderr = _execute(command, _child_environment(transport, secret), deadline, raw_budget, case.envelope.encode())
        stdout = _redact(raw_stdout, secret)
        stderr = _redact(raw_stderr, secret)
        authorization = {"environment": AUTHORIZATION_ENV, "sha256": hashlib.sha256(secret.encode()).hexdigest()} if secret else None
        execution = {
            "case_id": case.identifier,
            "endpoint": case.endpoint_url,
            "soap_version": case.soap_version,
            "action": case.action,
            "effect": case.effect,
            "actor_id": case.actor_id,
            "tenant_id": case.tenant_id,
            "argv": _recorded_command(command, case.envelope, secret),
            "environment": {"proxy": transport.proxy_environment, "trust": transport.trust_environment, "authorization": authorization},
            "exit_code": exit_code,
            "duration_ms": duration_ms,
            "stdout_base64": base64.b64encode(stdout).decode(),
            "stderr_base64": base64.b64encode(stderr).decode(),
            "stdout_sha256": hashlib.sha256(stdout).hexdigest(),
            "stderr_sha256": hashlib.sha256(stderr).hexdigest(),
        }
        candidate = {**report, "executions": [*report["executions"], execution]}
        if _serialized_size(candidate) > evidence_limit_bytes:
            raise ProbeError("SOAP evidence exceeds the cumulative output boundary")
        report = candidate
        next_start = max(next_start, time.monotonic()) + 1 / constraints.requests_per_second
    if time.monotonic() >= deadline:
        raise ProbeError("SOAP probe exceeded its global deadline")
    return report


def _write(path: Path, value: dict[str, Any], deadline: float) -> None:
    if time.monotonic() >= deadline:
        raise ProbeError("SOAP probe exceeded its global deadline")
    if path.exists():
        raise ProbeError("output path already exists")
    rendered = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
    if len(rendered) > MAX_OUTPUT_BYTES:
        raise ProbeError("SOAP evidence exceeds the output boundary")
    if time.monotonic() >= deadline:
        raise ProbeError("SOAP probe exceeded its global deadline")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        if time.monotonic() >= deadline:
            raise ProbeError("SOAP probe exceeded its global deadline")
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run bounded authorized SOAP probes with fixed curl.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args(argv)
    try:
        deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS
        workspace = _workspace(arguments.workspace)
        source = _confined(workspace, arguments.input, exists=True)
        destination = _confined(workspace, arguments.output, exists=False)
        if source == destination or destination.exists() or not destination.parent.is_dir():
            raise ProbeError("output must be new, distinct, and below an existing directory")
        payload, digest = _read(source)
        if time.monotonic() >= deadline:
            raise ProbeError("SOAP probe exceeded its global deadline")
        report = run_probe(payload, digest, deadline=deadline)
        _write(destination, report, deadline)
        return 0
    except (ProbeError, OSError) as error:
        print(f"SOAP probe error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
