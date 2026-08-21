#!/usr/bin/env python3
# ── Mission-Routed Prompt-Injection Probe ────────────────────────
# Sends matched control/candidate inputs through Cyberful's runtime route and
# retains bounded, secret-redacted evidence under model-supplied constraints.
# → cyberful/builtin/skills/test-ai-prompt-injection/assets/prompt-injection-probe.schema.json — input contract.
# → cyberful/builtin/skills/test-ai-prompt-injection/tests/test_run_prompt_injection_probe.py — forward tests.
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
import ssl
import stat
import sys
import tempfile
import time
from typing import Any, Final
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener


MAX_INPUT_BYTES: Final = 1_048_576
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_RESPONSE_BYTES: Final = 65_536
MAX_HEADER_BYTES: Final = 65_536
MAX_REQUESTS: Final = 40
MAX_RATE: Final = 10.0
MAX_EFFECTS: Final = 12
PROBE_TIMEOUT_SECONDS: Final = 60
AUTHORIZATION_ENV: Final = "CYBERFUL_AI_PROBE_AUTHORIZATION"
PROXY_ENVIRONMENT: Final = {"http": "HTTP_PROXY", "https": "HTTPS_PROXY"}
CA_ENVIRONMENT: Final = ("SSL_CERT_FILE", "CURL_CA_BUNDLE")
DNS_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")


class ProbeError(ValueError):
    """Raised when campaign constraints, transport, or evidence bounds fail."""


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


class ForcedProxyHandler(ProxyHandler):
    """Use the explicit runtime proxy without urllib's host bypass rules."""

    def proxy_open(self, request: Request, proxy: str, proxy_type: str) -> Any:
        parsed = urlsplit(proxy)
        request.set_proxy(parsed.netloc, parsed.scheme)
        if request.type == parsed.scheme:
            return None
        return self.parent.open(request, timeout=request.timeout)


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    relative = Path(value)
    if not value or relative.is_absolute() or ".." in relative.parts:
        raise ProbeError("paths must be relative and non-traversing")
    cursor = workspace
    for part in relative.parts:
        cursor /= part
        if cursor.is_symlink():
            raise ProbeError("symbolic links are not allowed")
    path = (workspace / relative).resolve(strict=exists)
    try:
        path.relative_to(workspace)
    except ValueError as error:
        raise ProbeError("path escapes workspace") from error
    return path


def _text(value: Any, label: str, *, maximum: int = 2048) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > maximum or any(ord(character) < 32 for character in value):
        raise ProbeError(f"{label} must be bounded non-empty text")
    return value


def _number(value: Any, label: str, minimum: float, maximum: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not minimum <= float(value) <= maximum:
        raise ProbeError(f"{label} must be between {minimum} and {maximum}")
    return float(value)


# ── Total URL And Runtime-Route Parsing ──────────────────────────
# Canonical origins are stable for DNS, IPv4, and bracketed IPv6. Only literal
# loopback endpoints may connect directly. Every other endpoint must use the
# loopback proxy injected by Cyberful after the model boundary.
# Malformed ports and non-canonical declarations fail before transport setup.
# ─────────────────────────────────────────────────────────────────
def _parsed_url(value: Any, label: str) -> tuple[str, SplitResult]:
    raw = _text(value, label, maximum=4096)
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise ProbeError(f"{label} has a malformed host or port") from error
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or "\\" in parsed.netloc:
        raise ProbeError(f"{label} must be HTTP(S) without credentials or fragment")
    host_value = parsed.hostname
    if "%" in host_value:
        raise ProbeError(f"{label} must not use a scoped IP literal")
    try:
        address = ipaddress.ip_address(host_value)
        host = f"[{address.compressed}]" if address.version == 6 else address.compressed
    except ValueError:
        try:
            ascii_host = host_value.encode("idna").decode("ascii").lower()
        except UnicodeError as error:
            raise ProbeError(f"{label} contains an invalid hostname") from error
        labels = ascii_host.rstrip(".").split(".")
        if not labels or any(not DNS_LABEL.fullmatch(item) for item in labels):
            raise ProbeError(f"{label} contains an invalid hostname")
        host = ascii_host.rstrip(".")
    effective_port = port or (443 if parsed.scheme == "https" else 80)
    return f"{parsed.scheme}://{host}:{effective_port}", parsed


def _origin(value: Any, label: str, *, declaration: bool = False) -> tuple[str, SplitResult]:
    canonical, parsed = _parsed_url(value, label)
    if declaration and (parsed.path not in {"", "/"} or parsed.query or value != canonical):
        raise ProbeError(f"{label} must be a canonical exact origin")
    return canonical, parsed


def _literal_loopback(parsed: SplitResult) -> bool:
    try:
        return ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        return False


def _runtime_proxy(endpoint: SplitResult) -> tuple[str | None, str | None]:
    if _literal_loopback(endpoint):
        return None, None
    environment = PROXY_ENVIRONMENT[endpoint.scheme]
    value = os.environ.get(environment)
    if not value:
        raise ProbeError(f"non-loopback endpoints require the Cyberful runtime route in {environment}")
    _, proxy = _origin(value, environment, declaration=True)
    if proxy.scheme != "http" or proxy.port is None or not _literal_loopback(proxy):
        raise ProbeError(f"{environment} must be an HTTP literal-loopback origin")
    return value, environment


def _tls_context() -> tuple[ssl.SSLContext, str]:
    selected = next(((name, os.environ[name]) for name in CA_ENVIRONMENT if os.environ.get(name)), None)
    if selected is not None:
        name, value = selected
        path = Path(value).resolve(strict=True)
        metadata = path.stat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4_194_304:
            raise ProbeError(f"{name} must identify a bounded regular CA bundle")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.load_verify_locations(cafile=str(path))
        return context, name
    paths = ssl.get_default_verify_paths()
    cafile = paths.openssl_cafile if paths.openssl_cafile and Path(paths.openssl_cafile).is_file() else None
    capath = paths.openssl_capath if paths.openssl_capath and Path(paths.openssl_capath).is_dir() else None
    if cafile is None and capath is None:
        raise ProbeError("compiled TLS trust store is unavailable")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cafile=cafile, capath=capath)
    return context, "compiled-default"


def _expiry(value: Any) -> datetime:
    raw = _text(value, "constraints.expires_at", maximum=64)
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as error:
        raise ProbeError("constraints.expires_at must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ProbeError("constraints.expires_at must include a timezone")
    normalized = parsed.astimezone(timezone.utc)
    if normalized <= datetime.now(timezone.utc):
        raise ProbeError("campaign constraints are expired")
    return normalized


def _validate(payload: dict[str, Any]) -> tuple[Constraints, list[dict[str, Any]]]:
    if set(payload) != {"constraints", "cases"}:
        raise ProbeError("input must contain exactly constraints and cases")
    raw = payload["constraints"]
    fields = {"authorization_reference", "expires_at", "allowed_origins", "max_requests", "requests_per_second", "allowed_effects", "actor_id", "tenant_id"}
    if not isinstance(raw, dict) or set(raw) != fields:
        raise ProbeError("campaign constraints are malformed")
    authorization_reference = _text(raw["authorization_reference"], "constraints.authorization_reference", maximum=1024)
    actor_id = _text(raw["actor_id"], "constraints.actor_id", maximum=512)
    tenant_id = _text(raw["tenant_id"], "constraints.tenant_id", maximum=512)
    expiry = _expiry(raw["expires_at"])
    origins = raw["allowed_origins"]
    if not isinstance(origins, list) or not 1 <= len(origins) <= 12:
        raise ProbeError("constraints.allowed_origins must contain between 1 and 12 origins")
    normalized_origins = [_origin(item, "constraints.allowed_origins[]", declaration=True)[0] for item in origins]
    if len(normalized_origins) != len(set(normalized_origins)):
        raise ProbeError("constraints.allowed_origins must be unique")
    maximum = raw["max_requests"]
    if not isinstance(maximum, int) or isinstance(maximum, bool) or not 2 <= maximum <= MAX_REQUESTS:
        raise ProbeError("constraints.max_requests exceeds probe limits")
    rate = _number(raw["requests_per_second"], "constraints.requests_per_second", 0.1, MAX_RATE)
    effects = raw["allowed_effects"]
    if not isinstance(effects, list) or not 1 <= len(effects) <= MAX_EFFECTS:
        raise ProbeError("constraints.allowed_effects must be a bounded non-empty array")
    normalized_effects = [_text(effect, "constraints.allowed_effects[]", maximum=128) for effect in effects]
    if len(normalized_effects) != len(set(normalized_effects)):
        raise ProbeError("constraints.allowed_effects must be unique")
    cases = payload["cases"]
    if not isinstance(cases, list) or not cases or len(cases) * 2 > maximum:
        raise ProbeError("matched request count exceeds campaign constraints")
    normalized: list[dict[str, Any]] = []
    identifiers: set[str] = set()
    required = {"id", "endpoint", "actor_id", "tenant_id", "effect", "control", "candidate", "marker"}
    for index, case in enumerate(cases):
        if not isinstance(case, dict) or set(case) != required:
            raise ProbeError(f"cases[{index}] is malformed")
        identifier = _text(case["id"], f"cases[{index}].id", maximum=512)
        if identifier in identifiers:
            raise ProbeError("case ids must be unique")
        identifiers.add(identifier)
        endpoint_origin, endpoint = _origin(case["endpoint"], f"cases[{index}].endpoint")
        if endpoint_origin not in normalized_origins:
            raise ProbeError(f"cases[{index}].endpoint is outside campaign constraints")
        case_actor = _text(case["actor_id"], f"cases[{index}].actor_id", maximum=512)
        case_tenant = _text(case["tenant_id"], f"cases[{index}].tenant_id", maximum=512)
        effect = _text(case["effect"], f"cases[{index}].effect", maximum=128)
        if case_actor != actor_id or case_tenant != tenant_id:
            raise ProbeError(f"cases[{index}] identity or tenant exceeds campaign constraints")
        if effect not in normalized_effects:
            raise ProbeError(f"cases[{index}].effect exceeds campaign constraints")
        normalized.append({
            "id": identifier,
            "endpoint": _text(case["endpoint"], f"cases[{index}].endpoint", maximum=4096),
            "endpoint_parts": endpoint,
            "actor_id": case_actor,
            "tenant_id": case_tenant,
            "effect": effect,
            "control": _text(case["control"], f"cases[{index}].control", maximum=65_536),
            "candidate": _text(case["candidate"], f"cases[{index}].candidate", maximum=65_536),
            "marker": _text(case["marker"], f"cases[{index}].marker", maximum=1024),
        })
    constraints = Constraints(authorization_reference, expiry, frozenset(normalized_origins), maximum, rate, frozenset(normalized_effects), actor_id, tenant_id)
    for case in normalized:
        case["proxy"], case["proxy_environment"] = _runtime_proxy(case["endpoint_parts"])
    return constraints, normalized


def _redact_bytes(value: bytes, secret: str | None) -> tuple[bytes, int]:
    if not secret:
        return value, 0
    encoded = secret.encode("utf-8")
    count = value.count(encoded)
    return value.replace(encoded, b"[REDACTED_SECRET]"), count


def _redact_text(value: str, secret: str | None) -> tuple[str, int]:
    redacted, count = _redact_bytes(value.encode("utf-8", errors="replace"), secret)
    return redacted.decode("utf-8", errors="replace"), count


def _response_headers(headers: Any, secret: str | None) -> tuple[list[dict[str, str]], int, int]:
    result: list[dict[str, str]] = []
    redactions = 0
    size = 0
    raw_size = 0
    for name, value in headers.items() if headers is not None else ():
        raw_size += len(str(name).encode()) + len(str(value).encode())
        redacted_name, name_count = _redact_text(str(name), secret)
        redacted_value, value_count = _redact_text(str(value), secret)
        size += len(redacted_name.encode()) + len(redacted_value.encode())
        if size > MAX_HEADER_BYTES:
            raise ProbeError("response headers exceed their evidence boundary")
        redactions += name_count + value_count
        result.append({"name": redacted_name, "value": redacted_value})
    return result, redactions, raw_size


def _send(endpoint: str, body: dict[str, str], deadline: float, expiry: datetime, context: ssl.SSLContext, proxy: str | None, secret: str | None) -> tuple[dict[str, Any], int]:
    if datetime.now(timezone.utc) >= expiry:
        raise ProbeError("campaign constraints expired during execution")
    started = time.monotonic()
    remaining = deadline - started
    if remaining <= 0:
        raise ProbeError("prompt-injection probe exceeded its global deadline")
    raw_request = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
    headers = {"Content-Type": "application/json"}
    if secret:
        headers["Authorization"] = secret
    request = Request(endpoint, data=raw_request, headers=headers, method="POST")
    proxy_handler = ForcedProxyHandler({"http": proxy, "https": proxy}) if proxy else ProxyHandler({})
    opener = build_opener(proxy_handler, HTTPSHandler(context=context))
    raw_error = ""
    try:
        with opener.open(request, timeout=max(0.1, remaining)) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            status, raw_headers, transport_error = response.status, response.headers, None
    except HTTPError as error:
        try:
            raw = error.read(MAX_RESPONSE_BYTES + 1)
            status, raw_headers, transport_error = error.code, error.headers, None
        finally:
            error.close()
    except (URLError, TimeoutError, OSError) as error:
        raw, status, raw_headers = b"", None, None
        raw_error = str(error)
        transport_error, _ = _redact_text(raw_error, secret)
        transport_error = transport_error[:2048]
    redacted_body, body_redactions = _redact_bytes(raw[:MAX_RESPONSE_BYTES], secret)
    response_headers, header_redactions, raw_header_bytes = _response_headers(raw_headers, secret)
    secret_record = {"environment": AUTHORIZATION_ENV, "sha256": hashlib.sha256(secret.encode()).hexdigest()} if secret else None
    observation = {
        "status": status,
        "headers": response_headers,
        "body_base64": base64.b64encode(redacted_body).decode(),
        "body_bytes": len(raw[:MAX_RESPONSE_BYTES]),
        "truncated": len(raw) > MAX_RESPONSE_BYTES,
        "redactions": {"headers": header_redactions, "body": body_redactions},
        "duration_ms": round((time.monotonic() - started) * 1000),
        "error": transport_error,
        "request": {"body_sha256": hashlib.sha256(raw_request).hexdigest(), "authorization": secret_record},
    }
    return observation, len(raw) + raw_header_bytes + len(raw_error.encode("utf-8", errors="replace"))


def _json_size(value: Any) -> int:
    return len((json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))


def _bounded_candidate(report: dict[str, Any], case: dict[str, Any], limit: int, source_bytes: int = 0) -> None:
    candidate = {**report, "cases": [*report["cases"], case]}
    if _json_size(candidate) + source_bytes > limit:
        raise ProbeError("raw response headers, body, error, or metadata exceed the cumulative output boundary")


def run_probe(payload: dict[str, Any], digest: str, workspace: Path, *, deadline_seconds: float = PROBE_TIMEOUT_SECONDS, evidence_limit_bytes: int = MAX_OUTPUT_BYTES) -> dict[str, Any]:
    workspace.resolve(strict=True)
    deadline = time.monotonic() + deadline_seconds
    constraints, cases = _validate(payload)
    context, ca_source = _tls_context()
    secret = os.environ.get(AUTHORIZATION_ENV)
    if secret is not None and (not secret or len(secret) > 16_384 or any(ord(character) < 33 or ord(character) > 126 for character in secret)):
        raise ProbeError(f"{AUTHORIZATION_ENV} is invalid")
    report: dict[str, Any] = {
        "format": "cyberful.ai-prompt-injection-probe.raw.v1",
        "input_sha256": digest,
        "authorization_reference": constraints.authorization_reference,
        "constraints": {"expires_at": constraints.expires_at.isoformat(), "max_requests": constraints.max_requests, "requests_per_second": constraints.requests_per_second, "actor_id": constraints.actor_id, "tenant_id": constraints.tenant_id, "allowed_effects": sorted(constraints.allowed_effects)},
        "transport": {"route": "cyberful-runtime-proxy-or-literal-loopback", "ca_source": ca_source, "direct_non_loopback": False},
        "cases": [],
    }
    if _json_size(report) > evidence_limit_bytes:
        raise ProbeError("report metadata exceeds the cumulative output boundary")
    interval = 1.0 / constraints.requests_per_second
    next_request_at = time.monotonic()
    source_evidence_bytes = 0
    for case in cases:
        observations: list[dict[str, Any]] = []
        case_record = {"case_id": case["id"], "endpoint": case["endpoint"], "actor_id": case["actor_id"], "tenant_id": case["tenant_id"], "effect": case["effect"], "marker": case["marker"], "observations": observations}
        _bounded_candidate(report, case_record, evidence_limit_bytes)
        for mode in ("control", "candidate"):
            delay = next_request_at - time.monotonic()
            if delay > 0:
                if time.monotonic() + delay >= deadline:
                    raise ProbeError("prompt-injection probe exceeded its global deadline")
                time.sleep(delay)
            observation, raw_evidence_bytes = _send(case["endpoint"], {"input": case[mode], "marker": case["marker"], "mode": mode, "actor_id": case["actor_id"], "tenant_id": case["tenant_id"], "effect": case["effect"]}, deadline, constraints.expires_at, context, case["proxy"], secret)
            staged = {**case_record, "observations": [*observations, {"mode": mode, **observation}]}
            _bounded_candidate(report, staged, evidence_limit_bytes, source_evidence_bytes + raw_evidence_bytes)
            observations.append({"mode": mode, **observation})
            source_evidence_bytes += raw_evidence_bytes
            next_request_at = max(next_request_at + interval, time.monotonic())
        report["cases"].append(case_record)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a mission-routed matched prompt-injection HTTP probe.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        workspace = Path(args.workspace).resolve(strict=True)
        source = _confined(workspace, args.input, exists=True)
        destination = _confined(workspace, args.output, exists=False)
        if destination == source or not destination.parent.is_dir():
            raise ProbeError("output must be distinct with an existing parent")
        if not stat.S_ISREG(source.stat().st_mode) or source.stat().st_size > MAX_INPUT_BYTES:
            raise ProbeError("input must be a bounded regular file")
        raw = source.read_bytes()
        payload = json.loads(raw.decode())
        if not isinstance(payload, dict):
            raise ProbeError("input must be a JSON object")
        report = run_probe(payload, hashlib.sha256(raw).hexdigest(), workspace)
        rendered = (json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()
        if len(rendered) > MAX_OUTPUT_BYTES:
            raise ProbeError("report exceeds output boundary")
        temporary: str | None = None
        try:
            with tempfile.NamedTemporaryFile("wb", dir=destination.parent, prefix=f".{destination.name}.", delete=False) as handle:
                temporary = handle.name
                os.chmod(temporary, 0o600)
                handle.write(rendered)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, destination)
            temporary = None
        finally:
            if temporary:
                Path(temporary).unlink(missing_ok=True)
        return 0
    except (ProbeError, OSError, ssl.SSLError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"prompt-injection probe error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
