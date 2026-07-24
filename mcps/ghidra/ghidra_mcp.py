#!/usr/bin/env python3
# ── Persistent Headless Ghidra MCP Service ───────────────────────
# Serves a bounded MCP surface over authenticated loopback streams, persists
# asynchronous jobs, and routes all Java work through one serialized PyGhidra owner.
# → mcps/ghidra/ghidra_engine.py — owns the Ghidra project and Java operations.
# → mcps/ghidra/ghidra_bridge.py — exposes one disposable stdio transport per phase.
# @docs/runtimes/ghidra.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import hmac
import json
import os
import queue
import signal
import socketserver
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

from ghidra_engine import EngineBusyError, GhidraEngine, InputError, append_json_line

MAX_LINE_BYTES = 1024 * 1024
MAX_TEXT_BYTES = 512 * 1024
MAX_PAGE = 500
TOOL_NAMES = {
    "ghidra_project",
    "ghidra_import",
    "ghidra_job",
    "ghidra_search",
    "ghidra_listing",
    "ghidra_decompile",
    "ghidra_xrefs",
    "ghidra_call_graph",
    "ghidra_annotations",
}


def object_schema(properties: dict[str, object], required: list[str]) -> dict[str, object]:
    return {
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": False,
    }


PAGE_PROPERTIES = {
    "offset": {"type": "integer", "minimum": 0, "default": 0},
    "limit": {"type": "integer", "minimum": 1, "maximum": MAX_PAGE, "default": 100},
}

TOOLS = [
    {
        "name": "ghidra_project",
        "description": "Inspect the persistent project, list imported programs, or write a durable checkpoint.",
        "inputSchema": object_schema(
            {"action": {"type": "string", "enum": ["status", "programs", "checkpoint"]}},
            ["action"],
        ),
    },
    {
        "name": "ghidra_import",
        "description": "Idempotently queue a workarea binary import by SHA-256, optionally followed by analysis.",
        "inputSchema": object_schema(
            {
                "source_path": {"type": "string", "minLength": 1, "maxLength": 4096},
                "name": {"type": "string", "minLength": 1, "maxLength": 180},
                "analyze": {"type": "boolean", "default": True},
            },
            ["source_path"],
        ),
    },
    {
        "name": "ghidra_job",
        "description": "Submit analysis or inspect, list, and cancel persistent asynchronous Ghidra jobs.",
        "inputSchema": object_schema(
            {
                "action": {"type": "string", "enum": ["submit", "status", "list", "cancel"]},
                "job_id": {"type": "string", "format": "uuid"},
                "program": {"type": "string", "maxLength": 181},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 86400, "default": 3600},
                **PAGE_PROPERTIES,
            },
            ["action"],
        ),
    },
    {
        "name": "ghidra_search",
        "description": "Search analyzed functions, symbols, or defined strings with stable pagination.",
        "inputSchema": object_schema(
            {
                "program": {"type": "string", "maxLength": 181},
                "kind": {"type": "string", "enum": ["functions", "symbols", "strings"]},
                "query": {"type": "string", "maxLength": 1024, "default": ""},
                **PAGE_PROPERTIES,
            },
            ["program", "kind"],
        ),
    },
    {
        "name": "ghidra_listing",
        "description": "Return bounded disassembly from a function name or hexadecimal address.",
        "inputSchema": object_schema(
            {
                "program": {"type": "string", "maxLength": 181},
                "selector": {"type": "string", "minLength": 1, "maxLength": 256},
                **PAGE_PROPERTIES,
            },
            ["program", "selector"],
        ),
    },
    {
        "name": "ghidra_decompile",
        "description": "Decompile one function selected by name or address with a finite timeout.",
        "inputSchema": object_schema(
            {
                "program": {"type": "string", "maxLength": 181},
                "selector": {"type": "string", "minLength": 1, "maxLength": 256},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 600, "default": 120},
            },
            ["program", "selector"],
        ),
    },
    {
        "name": "ghidra_xrefs",
        "description": "List references to or from a function or address with stable pagination.",
        "inputSchema": object_schema(
            {
                "program": {"type": "string", "maxLength": 181},
                "selector": {"type": "string", "minLength": 1, "maxLength": 256},
                "direction": {"type": "string", "enum": ["to", "from"]},
                **PAGE_PROPERTIES,
            },
            ["program", "selector", "direction"],
        ),
    },
    {
        "name": "ghidra_call_graph",
        "description": "Build a bounded directed call graph, optionally rooted at one function.",
        "inputSchema": object_schema(
            {
                "program": {"type": "string", "maxLength": 181},
                "root": {"type": "string", "minLength": 1, "maxLength": 256},
                "depth": {"type": "integer", "minimum": 0, "maximum": 5, "default": 2},
                **PAGE_PROPERTIES,
            },
            ["program"],
        ),
    },
    {
        "name": "ghidra_annotations",
        "description": "List durable annotations or transactionally add comments, bookmarks, and function renames.",
        "inputSchema": object_schema(
            {
                "action": {"type": "string", "enum": ["list", "comment", "bookmark", "rename"]},
                "program": {"type": "string", "maxLength": 181},
                "selector": {"type": "string", "minLength": 1, "maxLength": 256},
                "value": {"type": "string", "minLength": 1, "maxLength": 16384},
                "comment_type": {
                    "type": "string",
                    "enum": ["plate", "pre", "eol", "post", "repeatable"],
                    "default": "eol",
                },
                **PAGE_PROPERTIES,
            },
            ["action"],
        ),
    },
]


def read_records(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    records: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError as error:
                raise RuntimeError(f"job journal has invalid JSON at line {line_number}") from error
            if not isinstance(parsed, dict):
                raise RuntimeError(f"job journal has a non-object at line {line_number}")
            records.append(parsed)
    return records


class JobManager:
    """Persists every state transition and replays incomplete work after restart."""

    def __init__(self, engine: GhidraEngine, path: Path, start_worker: bool = True) -> None:
        self.engine = engine
        self.path = path
        self._lock = threading.Lock()
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._jobs: dict[str, dict[str, object]] = {}
        self._closed = False
        self._worker = threading.Thread(target=self._run, name="ghidra-job-worker", daemon=True)
        for record in read_records(path):
            job_id = record.get("id")
            if isinstance(job_id, str):
                self._jobs[job_id] = record
        recoverable = [
            job_id
            for job_id, record in self._jobs.items()
            if record.get("status") in {"queued", "running", "cancel_requested"}
        ]
        for job_id in recoverable:
            record = {**self._jobs[job_id], "status": "queued", "recovered": True, "updated_at": time.time()}
            self._jobs[job_id] = record
            append_json_line(self.path, record)
        if start_worker:
            self._worker.start()
            for job_id in recoverable:
                self._queue.put(job_id)

    def submit(self, kind: str, request: dict[str, object]) -> dict[str, object]:
        with self._lock:
            if self._closed:
                raise RuntimeError("Ghidra job manager is shutting down")
            for existing in self._jobs.values():
                if (
                    existing.get("kind") == kind
                    and existing.get("request") == request
                    and existing.get("status") in {"queued", "running", "cancel_requested"}
                ):
                    return dict(existing)
            now = time.time()
            record: dict[str, object] = {
                "id": str(uuid.uuid4()),
                "kind": kind,
                "status": "queued",
                "request": request,
                "created_at": now,
                "updated_at": now,
            }
            self._jobs[str(record["id"])] = record
            append_json_line(self.path, record)
            self._queue.put(str(record["id"]))
            return dict(record)

    def status(self, job_id: str) -> dict[str, object]:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                raise InputError(f"Ghidra job was not found: {job_id}")
            return dict(record)

    def list(self, offset: int, limit: int) -> dict[str, object]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda item: float(item.get("created_at", 0)), reverse=True)
            return {
                "items": [dict(item) for item in jobs[offset : offset + limit]],
                "offset": offset,
                "limit": limit,
                "total": len(jobs),
                "has_more": offset + limit < len(jobs),
            }

    def cancel(self, job_id: str) -> dict[str, object]:
        cancel_active = False
        with self._lock:
            current = self._jobs.get(job_id)
            if current is None:
                raise InputError(f"Ghidra job was not found: {job_id}")
            status = current.get("status")
            if status in {"succeeded", "failed", "cancelled"}:
                return dict(current)
            next_status = "cancelled" if status == "queued" else "cancel_requested"
            record = {**current, "status": next_status, "updated_at": time.time()}
            self._jobs[job_id] = record
            append_json_line(self.path, record)
            cancel_active = status in {"running", "cancel_requested"}
        if cancel_active:
            self.engine.cancel_active_operation()
        return dict(record)

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            running = [
                job_id
                for job_id, record in self._jobs.items()
                if record.get("status") in {"running", "cancel_requested"}
            ]
        for job_id in running:
            self.cancel(job_id)
        self._queue.put(None)
        if self._worker.is_alive():
            self._worker.join(timeout=10)

    def _transition(self, job_id: str, status: str, **fields: object) -> dict[str, object]:
        with self._lock:
            current = self._jobs[job_id]
            record = {**current, "status": status, "updated_at": time.time(), **fields}
            self._jobs[job_id] = record
            append_json_line(self.path, record)
            return record

    def _run(self) -> None:
        while True:
            job_id = self._queue.get()
            if job_id is None:
                return
            with self._lock:
                current = self._jobs.get(job_id)
                if current is None or current.get("status") == "cancelled":
                    continue
                request = current.get("request")
                kind = current.get("kind")
            if not isinstance(request, dict) or not isinstance(kind, str):
                self._transition(job_id, "failed", error="persistent job request is malformed")
                continue
            self._transition(job_id, "running", started_at=time.time())
            try:
                if kind == "import":
                    result = self.engine.import_program(
                        str(request["source_path"]),
                        str(request["name"]) if isinstance(request.get("name"), str) else None,
                        bool(request.get("analyze", True)),
                    )
                elif kind == "analyze":
                    result = self.engine.analyze_program(
                        str(request["program"]),
                        int(request.get("timeout_seconds", 3600)),
                    )
                else:
                    raise RuntimeError(f"unsupported persistent Ghidra job kind: {kind}")
                with self._lock:
                    cancelled = self._jobs[job_id].get("status") == "cancel_requested"
                self._transition(
                    job_id,
                    "cancelled" if cancelled else "succeeded",
                    result=result,
                    completed_at=time.time(),
                )
            except Exception as error:
                with self._lock:
                    cancelled = self._jobs[job_id].get("status") == "cancel_requested"
                self._transition(
                    job_id,
                    "cancelled" if cancelled else "failed",
                    error=str(error),
                    completed_at=time.time(),
                )


def require_string(args: dict[str, object], name: str, maximum: int = 4096) -> str:
    value = args.get(name)
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise InputError(f"{name} must be a non-empty string of at most {maximum} characters")
    return value


def optional_string(args: dict[str, object], name: str, maximum: int = 4096) -> str | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise InputError(f"{name} must be a non-empty string of at most {maximum} characters")
    return value


def integer(args: dict[str, object], name: str, default: int, minimum: int, maximum: int) -> int:
    value = args.get(name, default)
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise InputError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


class GhidraApplication:
    """Validates MCP calls before dispatching them to jobs or the engine."""

    def __init__(self, engine: GhidraEngine, jobs: JobManager) -> None:
        self.engine = engine
        self.jobs = jobs

    def call(self, name: str, args: object) -> dict[str, object]:
        if name not in TOOL_NAMES:
            raise InputError(f"unknown Ghidra tool: {name}")
        if not isinstance(args, dict) or any(not isinstance(key, str) for key in args):
            raise InputError("tool arguments must be a JSON object")
        handler: Callable[[dict[str, object]], dict[str, object]] = getattr(self, name)
        return handler(args)

    def ghidra_project(self, args: dict[str, object]) -> dict[str, object]:
        action = require_string(args, "action", 20)
        if action == "status":
            return self.engine.project_status()
        if action == "programs":
            return {"programs": self.engine.programs()}
        if action == "checkpoint":
            return self.engine.checkpoint()
        raise InputError("action must be status, programs, or checkpoint")

    def ghidra_import(self, args: dict[str, object]) -> dict[str, object]:
        source_path = require_string(args, "source_path")
        source = self.engine.resolve_source(source_path)
        digest = self.engine.source_digest(source)
        existing = self.engine.imported_program(digest)
        analyze = args.get("analyze", True)
        if not isinstance(analyze, bool):
            raise InputError("analyze must be a boolean")
        if existing and (not analyze or existing.get("analyzed") is True):
            return {"idempotent": True, "program": existing}
        request: dict[str, object] = {"source_path": source_path, "analyze": analyze}
        name = optional_string(args, "name", 180)
        if name:
            request["name"] = name
        return {"job": self.jobs.submit("import", request), "sha256": digest}

    def ghidra_job(self, args: dict[str, object]) -> dict[str, object]:
        action = require_string(args, "action", 20)
        if action == "list":
            return self.jobs.list(
                integer(args, "offset", 0, 0, 1_000_000),
                integer(args, "limit", 100, 1, MAX_PAGE),
            )
        if action in {"status", "cancel"}:
            job_id = require_string(args, "job_id", 64)
            try:
                uuid.UUID(job_id)
            except ValueError as error:
                raise InputError("job_id must be a UUID") from error
            return self.jobs.status(job_id) if action == "status" else self.jobs.cancel(job_id)
        if action == "submit":
            request = {
                "program": require_string(args, "program", 181),
                "timeout_seconds": integer(args, "timeout_seconds", 3600, 1, 86_400),
            }
            return self.jobs.submit("analyze", request)
        raise InputError("action must be submit, status, list, or cancel")

    def ghidra_search(self, args: dict[str, object]) -> dict[str, object]:
        return self.engine.search(
            require_string(args, "program", 181),
            require_string(args, "kind", 20),
            str(args.get("query", ""))[:1024],
            integer(args, "offset", 0, 0, 1_000_000),
            integer(args, "limit", 100, 1, MAX_PAGE),
        )

    def ghidra_listing(self, args: dict[str, object]) -> dict[str, object]:
        return self.engine.listing(
            require_string(args, "program", 181),
            require_string(args, "selector", 256),
            integer(args, "offset", 0, 0, 1_000_000),
            integer(args, "limit", 100, 1, MAX_PAGE),
        )

    def ghidra_decompile(self, args: dict[str, object]) -> dict[str, object]:
        return self.engine.decompile(
            require_string(args, "program", 181),
            require_string(args, "selector", 256),
            integer(args, "timeout_seconds", 120, 1, 600),
        )

    def ghidra_xrefs(self, args: dict[str, object]) -> dict[str, object]:
        return self.engine.xrefs(
            require_string(args, "program", 181),
            require_string(args, "selector", 256),
            require_string(args, "direction", 10),
            integer(args, "offset", 0, 0, 1_000_000),
            integer(args, "limit", 100, 1, MAX_PAGE),
        )

    def ghidra_call_graph(self, args: dict[str, object]) -> dict[str, object]:
        return self.engine.call_graph(
            require_string(args, "program", 181),
            optional_string(args, "root", 256),
            integer(args, "depth", 2, 0, 5),
            integer(args, "offset", 0, 0, 1_000_000),
            integer(args, "limit", 100, 1, MAX_PAGE),
        )

    def ghidra_annotations(self, args: dict[str, object]) -> dict[str, object]:
        action = require_string(args, "action", 20)
        if action == "list":
            return self.engine.annotations(
                optional_string(args, "program", 181),
                integer(args, "offset", 0, 0, 1_000_000),
                integer(args, "limit", 100, 1, MAX_PAGE),
            )
        return self.engine.annotate(
            require_string(args, "program", 181),
            action,
            require_string(args, "selector", 256),
            require_string(args, "value", 16_384),
            str(args.get("comment_type", "eol")),
        )


def mcp_text(value: object, error: bool = False) -> dict[str, object]:
    encoded = json.dumps(value, sort_keys=True, indent=2)
    if len(encoded.encode("utf-8")) > MAX_TEXT_BYTES:
        encoded = json.dumps(
            {"error": "Ghidra result exceeded the MCP response limit; request a smaller page or narrower query"},
            sort_keys=True,
        )
        error = True
    return {"content": [{"type": "text", "text": encoded}], **({"isError": True} if error else {})}


class Protocol:
    def __init__(self, application: GhidraApplication) -> None:
        self.application = application

    def handle(self, request: object) -> dict[str, object] | None:
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
            return self._error(None, -32600, "invalid JSON-RPC request")
        request_id = request.get("id")
        method = request.get("method")
        if not isinstance(method, str):
            return self._error(request_id, -32600, "JSON-RPC method is required")
        if request_id is None:
            return None
        try:
            if method == "initialize":
                params = request.get("params")
                protocol_version = params.get("protocolVersion") if isinstance(params, dict) else None
                result = {
                    "protocolVersion": protocol_version if isinstance(protocol_version, str) else "2025-11-25",
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "cyberful-ghidra", "version": "0.1.0"},
                }
            elif method == "ping":
                result = {}
            elif method == "tools/list":
                result = {"tools": TOOLS}
            elif method == "tools/call":
                params = request.get("params")
                if not isinstance(params, dict):
                    raise InputError("tools/call params must be an object")
                name = params.get("name")
                if not isinstance(name, str):
                    raise InputError("tools/call name must be a string")
                result = mcp_text(self.application.call(name, params.get("arguments", {})))
            else:
                return self._error(request_id, -32601, f"method not found: {method}")
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except (EngineBusyError, InputError, RuntimeError, ValueError) as error:
            if method == "tools/call":
                return {"jsonrpc": "2.0", "id": request_id, "result": mcp_text({"error": str(error)}, True)}
            return self._error(request_id, -32602, str(error))
        except Exception as error:
            print(f"unexpected Ghidra MCP error: {type(error).__name__}: {error}", file=sys.stderr)
            if method == "tools/call":
                return {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": mcp_text({"error": "internal Ghidra service error"}, True),
                }
            return self._error(request_id, -32603, "internal Ghidra service error")

    @staticmethod
    def _error(request_id: object, code: int, message: str) -> dict[str, object]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


class GhidraRequestHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        server = self.server
        if not isinstance(server, GhidraServer):
            return
        capability = self.rfile.readline(129)
        if len(capability) > 128 or not hmac.compare_digest(
            capability.rstrip(b"\r\n"),
            server.capability_key.encode("utf-8"),
        ):
            return
        while line := self.rfile.readline(MAX_LINE_BYTES + 1):
            if len(line) > MAX_LINE_BYTES:
                self._write(Protocol._error(None, -32600, "JSON-RPC message exceeds the size limit"))
                return
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                self._write(Protocol._error(None, -32700, "invalid JSON"))
                continue
            response = server.protocol.handle(request)
            if response is not None:
                self._write(response)

    def _write(self, value: object) -> None:
        self.wfile.write(json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n")
        self.wfile.flush()


class GhidraServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], capability_key: str, protocol: Protocol) -> None:
        self.capability_key = capability_key
        self.protocol = protocol
        super().__init__(address, GhidraRequestHandler)


def environment_path(name: str, fallback: str) -> Path:
    value = Path(os.environ.get(name, fallback))
    if not value.is_absolute():
        raise ValueError(f"{name} must be an absolute path")
    return value


def environment_port() -> int:
    value = os.environ.get("CYBER_GHIDRA_PORT", "47100")
    if not value.isdecimal() or not 1 <= int(value) <= 65_535:
        raise ValueError("CYBER_GHIDRA_PORT must be between 1 and 65535")
    return int(value)


def main() -> int:
    capability_key = os.environ.get("CYBER_GHIDRA_MCP_KEY", "")
    if not 32 <= len(capability_key) <= 128 or any(character.isspace() for character in capability_key):
        print("CYBER_GHIDRA_MCP_KEY is missing or malformed", file=sys.stderr)
        return 2
    host = os.environ.get("CYBER_GHIDRA_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1"}:
        print("CYBER_GHIDRA_HOST must be loopback", file=sys.stderr)
        return 2

    store = environment_path("CYBER_GHIDRA_STORE", "/ghidra/store")
    workarea = environment_path("CYBER_GHIDRA_WORKAREA", "/workspace")
    install = environment_path("GHIDRA_INSTALL_DIR", "/opt/ghidra")
    store.mkdir(mode=0o700, parents=True, exist_ok=True)
    (store / "home").mkdir(mode=0o700, exist_ok=True)
    engine = GhidraEngine(store, workarea, install)
    try:
        engine.start()
        jobs = JobManager(engine, store / "jobs.jsonl")
        application = GhidraApplication(engine, jobs)
        server = GhidraServer((host, environment_port()), capability_key, Protocol(application))
    except Exception as error:
        engine.close()
        print(f"could not start headless Ghidra: {error}", file=sys.stderr)
        return 1

    stopping = threading.Event()

    def stop(_signum: int, _frame: object) -> None:
        if stopping.is_set():
            return
        stopping.set()
        threading.Thread(target=server.shutdown, name="ghidra-shutdown", daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever(poll_interval=0.25)
        return 0
    finally:
        server.server_close()
        jobs.close()
        engine.close()


if __name__ == "__main__":
    raise SystemExit(main())
