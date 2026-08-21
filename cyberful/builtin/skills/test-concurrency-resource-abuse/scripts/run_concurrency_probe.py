#!/usr/bin/env python3
# ── Authorized Concurrency Probe ────────────────────────────────
# Sends synchronized HTTP requests within exact origin, count, concurrency, and
# deadline bounds through Cyberful's runtime route while retaining raw evidence.
# → cyberful/builtin/skills/test-concurrency-resource-abuse/assets/concurrency-probe.schema.json — input contract.
# → cyberful/builtin/skills/test-concurrency-resource-abuse/tests/test_run_concurrency_probe.py — forward tests.
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
import hashlib
import ipaddress
import json
import os
import re
import ssl
import stat
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Final
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urlsplit
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener


MAX_INPUT_BYTES: Final = 1_048_576
MAX_OUTPUT_BYTES: Final = 4_194_304
MAX_REQUESTS: Final = 64
MAX_CONCURRENCY: Final = 8
MAX_RESPONSE_BYTES: Final = 65_536
PROBE_TIMEOUT_SECONDS: Final = 60
PROXY_ENVIRONMENT: Final = {"http": "HTTP_PROXY", "https": "HTTPS_PROXY"}
CA_ENVIRONMENT: Final = ("SSL_CERT_FILE", "CURL_CA_BUNDLE")
DNS_LABEL: Final = re.compile(r"(?!-)[A-Za-z0-9-]{1,63}(?<!-)$")


class ProbeError(ValueError):
    """Raised when a probe violates authority, transport, or evidence bounds."""


class ForcedProxyHandler(ProxyHandler):
    """Proxy handler that never consults ambient proxy or no-proxy variables."""

    def proxy_open(self, request: Request, proxy: str, proxy_type: str) -> Any:
        parsed = urlsplit(proxy)
        request.set_proxy(parsed.netloc, parsed.scheme)
        if request.type == parsed.scheme:
            return None
        return self.parent.open(request, timeout=request.timeout)


def _workspace(value: str) -> Path:
    path = Path(value).resolve(strict=True)
    if not path.is_dir():
        raise ProbeError("workspace must be an existing directory")
    return path


def _confined(workspace: Path, value: str, *, exists: bool) -> Path:
    relative = Path(value)
    if not value or relative.is_absolute() or ".." in relative.parts:
        raise ProbeError("paths must be relative and non-traversing")
    cursor = workspace
    for part in relative.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ProbeError("symbolic links are not allowed")
    path = (workspace / relative).resolve(strict=exists)
    try:
        path.relative_to(workspace)
    except ValueError as error:
        raise ProbeError("path escapes workspace") from error
    return path


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
        raise ProbeError("input must be an object")
    return value, hashlib.sha256(raw).hexdigest()


def _parsed_url(value: Any, label: str) -> tuple[str, SplitResult]:
    if not isinstance(value, str) or not value or any(character.isspace() for character in value):
        raise ProbeError(f"{label} must be a non-empty URL without whitespace")
    parsed = urlsplit(value)
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
            ascii_host = host_value.encode("idna").decode("ascii").lower().rstrip(".")
        except UnicodeError as error:
            raise ProbeError(f"{label} contains an invalid hostname") from error
        labels = ascii_host.split(".")
        if not labels or any(not DNS_LABEL.fullmatch(item) for item in labels):
            raise ProbeError(f"{label} contains an invalid hostname")
        host = ascii_host
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


def _validated(payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if set(payload) != {"authority", "cases"}:
        raise ProbeError("input must contain exactly authority and cases")
    authority = payload["authority"]
    cases = payload["cases"]
    required_authority = {"scope_id", "allowed_origins", "max_requests", "max_concurrency"}
    if not isinstance(authority, dict) or set(authority) != required_authority:
        raise ProbeError("authority contract is malformed")
    origins = authority["allowed_origins"]
    if not isinstance(origins, list) or not origins:
        raise ProbeError("allowed_origins must be a non-empty array")
    normalized_origins: list[str] = []
    for index, item in enumerate(origins):
        canonical, _ = _origin(item, f"authority.allowed_origins[{index}]", declaration=True)
        normalized_origins.append(canonical)
    if len(set(normalized_origins)) != len(normalized_origins):
        raise ProbeError("allowed_origins must be unique")
    if not isinstance(authority["scope_id"], str) or not authority["scope_id"]:
        raise ProbeError("scope_id is required")
    if not isinstance(authority["max_requests"], int) or not 1 <= authority["max_requests"] <= MAX_REQUESTS:
        raise ProbeError("max_requests exceeds probe limits")
    if not isinstance(authority["max_concurrency"], int) or not 1 <= authority["max_concurrency"] <= MAX_CONCURRENCY:
        raise ProbeError("max_concurrency exceeds probe limits")
    if not isinstance(cases, list) or not cases:
        raise ProbeError("cases must be a non-empty array")
    normalized = []
    requests = 0
    for index, case in enumerate(cases):
        if not isinstance(case, dict) or set(case) != {"id", "url", "method", "headers", "body", "concurrency", "repetitions"}:
            raise ProbeError(f"cases[{index}] is malformed")
        if not isinstance(case["id"], str) or not case["id"]:
            raise ProbeError("case id is required")
        case_origin, endpoint = _origin(case["url"], f"cases[{index}].url")
        if case_origin not in normalized_origins:
            raise ProbeError(f"case URL is outside authority: {case['url']}")
        if case["method"] not in {"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"}:
            raise ProbeError("method is not allowed")
        headers = case["headers"]
        if not isinstance(headers, dict) or len(headers) > 32 or not all(isinstance(key, str) and isinstance(value, str) for key, value in headers.items()):
            raise ProbeError("headers must be a bounded string map")
        if any(key.lower() in {"authorization", "proxy-authorization", "cookie"} for key in headers):
            raise ProbeError("secret-bearing headers must come from environment")
        if not isinstance(case["body"], str) or len(case["body"].encode()) > 65_536:
            raise ProbeError("body exceeds its boundary")
        concurrency = case["concurrency"]
        repetitions = case["repetitions"]
        if not isinstance(concurrency, int) or not 1 <= concurrency <= authority["max_concurrency"]:
            raise ProbeError("case concurrency exceeds authority")
        if not isinstance(repetitions, int) or not 1 <= repetitions <= MAX_REQUESTS:
            raise ProbeError("case repetitions exceeds probe limits")
        requests += concurrency * repetitions
        normalized.append({**case, "endpoint_parts": endpoint})
    if requests > authority["max_requests"]:
        raise ProbeError("request count exceeds authority")
    return authority, normalized


def _request(case: dict[str, Any], barrier: threading.Barrier, deadline: float, context: ssl.SSLContext) -> dict[str, Any]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ProbeError("concurrency probe exceeded its global deadline")
    headers = dict(case["headers"])
    secret = os.environ.get("CYBERFUL_PROBE_AUTHORIZATION")
    if secret:
        headers["Authorization"] = secret
    body = case["body"].encode() if case["body"] else None
    request = Request(case["url"], data=body, headers=headers, method=case["method"])
    proxy = case["proxy"]
    proxy_handler = ForcedProxyHandler({"http": proxy, "https": proxy}) if proxy else ProxyHandler({})
    opener = build_opener(proxy_handler, HTTPSHandler(context=context))
    barrier.wait(timeout=remaining)
    started = time.monotonic()
    try:
        with opener.open(request, timeout=max(0.1, deadline - time.monotonic())) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            status = response.status
            response_headers = dict(response.headers.items())
    except HTTPError as error:
        raw = error.read(MAX_RESPONSE_BYTES + 1)
        status = error.code
        response_headers = dict(error.headers.items())
    except (URLError, TimeoutError, OSError) as error:
        return {"status": None, "duration_ms": round((time.monotonic() - started) * 1000), "headers": {}, "body_base64": "", "truncated": False, "error": str(error)[:1024]}
    truncated = len(raw) > MAX_RESPONSE_BYTES
    raw = raw[:MAX_RESPONSE_BYTES]
    return {"status": status, "duration_ms": round((time.monotonic() - started) * 1000), "headers": response_headers, "body_base64": base64.b64encode(raw).decode(), "truncated": truncated, "error": None}


def run_probe(payload: dict[str, Any], digest: str, workspace: Path, *, deadline_seconds: float = PROBE_TIMEOUT_SECONDS) -> dict[str, Any]:
    workspace = workspace.resolve(strict=True)
    authority, cases = _validated(payload)
    for case in cases:
        case["proxy"], case["proxy_environment"] = _runtime_proxy(case["endpoint_parts"])
    context, ca_source = _tls_context()
    deadline = time.monotonic() + deadline_seconds
    results = []
    raw_body_bytes = 0
    for case in cases:
        observations = []
        for _ in range(case["repetitions"]):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeError("concurrency probe exceeded its global deadline")
            barrier = threading.Barrier(case["concurrency"])
            with ThreadPoolExecutor(max_workers=case["concurrency"]) as executor:
                futures = [executor.submit(_request, case, barrier, deadline, context) for _ in range(case["concurrency"])]
                try:
                    batch = [future.result(timeout=max(0.1, deadline - time.monotonic())) for future in futures]
                except FutureTimeout as error:
                    for future in futures:
                        future.cancel()
                    raise ProbeError("concurrency probe exceeded its global deadline") from error
            if time.monotonic() > deadline:
                raise ProbeError("concurrency probe exceeded its global deadline")
            observations.extend(batch)
            raw_body_bytes += sum(len(item["body_base64"]) for item in batch)
            if raw_body_bytes > MAX_OUTPUT_BYTES // 2:
                raise ProbeError("raw response evidence exceeds the cumulative output boundary")
        results.append({"case_id": case["id"], "url": case["url"], "method": case["method"], "concurrency": case["concurrency"], "repetitions": case["repetitions"], "observations": observations})
    proxy_sources = sorted({case["proxy_environment"] for case in cases if case["proxy_environment"]})
    return {"format": "cyberful.concurrency-probe.raw.v1", "input_sha256": digest, "scope_id": authority["scope_id"], "environment": {"route": "runtime-http-proxy-or-literal-loopback", "proxy_environment": proxy_sources, "ca_source": ca_source, "direct_non_loopback": False, "telemetry_enabled": False}, "cases": results}


def _write(path: Path, report: dict[str, Any]) -> None:
    raw = (json.dumps(report, indent=2, sort_keys=True) + "\n").encode()
    if len(raw) > MAX_OUTPUT_BYTES:
        raise ProbeError("report exceeds output boundary")
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
            temporary = handle.name
            os.chmod(temporary, 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary:
            Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a bounded authorized HTTP concurrency probe.")
    parser.add_argument("--workspace", default=".")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        workspace = _workspace(args.workspace)
        source = _confined(workspace, args.input, exists=True)
        destination = _confined(workspace, args.output, exists=False)
        if source == destination or not destination.parent.is_dir():
            raise ProbeError("output must be distinct with an existing parent")
        payload, digest = _read(source)
        _write(destination, run_probe(payload, digest, workspace))
        return 0
    except (ProbeError, OSError, ssl.SSLError) as error:
        print(f"concurrency probe error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
