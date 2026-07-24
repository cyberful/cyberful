#!/usr/bin/env python3
# ── Persistent PyGhidra Analysis Engine ──────────────────────────
# Owns one headless JVM and one durable Ghidra project, serializing every Java
# API operation while exposing bounded reverse-engineering primitives.
# → mcps/ghidra/ghidra_mcp.py — validates MCP input and schedules this engine.
# @docs/runtimes/ghidra.md
# ─────────────────────────────────────────────────────────────────

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import threading
from pathlib import Path
from typing import Iterator

ADDRESS_PATTERN = re.compile(r"^(?:0x)?[0-9a-fA-F]{1,16}$")
PROGRAM_PATTERN = re.compile(r"^/[A-Za-z0-9_.@+-]{1,180}$")
NAME_PATTERN = re.compile(r"^[A-Za-z_?$@.][A-Za-z0-9_?$@.:+-]{0,179}$")
MAX_BINARY_BYTES = 2 * 1024 * 1024 * 1024
MAX_DECOMPILE_CHARACTERS = 200_000
MAX_LISTING_ITEMS = 500
MAX_GRAPH_NODES = 500


class EngineBusyError(RuntimeError):
    """Raised when the serialized JVM owner is executing a background job."""


class InputError(ValueError):
    """Raised when an analysis selector cannot be resolved safely."""


def node_is_contained(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    encoded = json.dumps(value, sort_keys=True, indent=2) + "\n"
    with temporary.open("x", encoding="utf-8") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def append_json_line(path: Path, value: object) -> None:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8") as stream:
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())


class GhidraEngine:
    """One serialized owner for PyGhidra's non-thread-safe headless APIs."""

    def __init__(self, store_root: Path, workarea_root: Path, install_dir: Path) -> None:
        self.store_root = store_root.resolve(strict=True)
        self.workarea_root = workarea_root.resolve(strict=True)
        self.install_dir = install_dir.resolve(strict=True)
        self.project_root = self.store_root / "project"
        self.project_root.mkdir(mode=0o700, exist_ok=True)
        self.manifest_path = self.store_root / "manifest.json"
        self.annotations_path = self.store_root / "annotations.jsonl"
        self.checkpoint_path = self.store_root / "checkpoint.json"
        self._operation_lock = threading.RLock()
        self._monitor_lock = threading.Lock()
        self._active_monitor: object | None = None
        self._pyghidra: object | None = None
        self._project: object | None = None
        self._manifest = self._read_manifest()

    def _read_manifest(self) -> dict[str, object]:
        if not self.manifest_path.exists():
            return {"schema": 1, "programs": {}}
        with self.manifest_path.open("r", encoding="utf-8") as stream:
            parsed = json.load(stream)
        if not isinstance(parsed, dict) or parsed.get("schema") != 1 or not isinstance(parsed.get("programs"), dict):
            raise RuntimeError("Ghidra manifest is malformed or unsupported")
        return parsed

    def start(self) -> None:
        import pyghidra

        pyghidra.start(install_dir=self.install_dir)
        create = not (self.project_root / "Cyberful.gpr").exists()
        self._project = pyghidra.open_project(self.project_root, "Cyberful", create=create)
        self._pyghidra = pyghidra

    def close(self) -> None:
        project = self._project
        self._project = None
        if project is not None:
            project.close()

    @contextlib.contextmanager
    def exclusive(self, wait: bool = False) -> Iterator[None]:
        acquired = self._operation_lock.acquire(blocking=wait)
        if not acquired:
            raise EngineBusyError("Ghidra is busy with a background job; query ghidra_job and retry when it is idle")
        try:
            yield
        finally:
            self._operation_lock.release()

    def cancel_active_operation(self) -> None:
        with self._monitor_lock:
            monitor = self._active_monitor
        if monitor is not None:
            monitor.cancel()

    @contextlib.contextmanager
    def _monitor(self, timeout_seconds: int | None = None) -> Iterator[object]:
        pyghidra = self._require_pyghidra()
        monitor = pyghidra.task_monitor(timeout_seconds)
        with self._monitor_lock:
            self._active_monitor = monitor
        try:
            yield monitor
        finally:
            with self._monitor_lock:
                if self._active_monitor is monitor:
                    self._active_monitor = None

    def _require_pyghidra(self) -> object:
        if self._pyghidra is None or self._project is None:
            raise RuntimeError("PyGhidra engine has not started")
        return self._pyghidra

    def resolve_source(self, relative_path: str) -> Path:
        if not relative_path or Path(relative_path).is_absolute() or "\x00" in relative_path:
            raise InputError("source_path must be a relative path inside the engagement workarea")
        source = (self.workarea_root / relative_path).resolve(strict=True)
        if not node_is_contained(self.workarea_root, source) or not source.is_file() or source.is_symlink():
            raise InputError("source_path must resolve to a plain file inside the engagement workarea")
        if source.stat().st_size > MAX_BINARY_BYTES:
            raise InputError(f"binary exceeds the {MAX_BINARY_BYTES}-byte import limit")
        return source

    def source_digest(self, source: Path) -> str:
        digest = hashlib.sha256()
        with source.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        return digest.hexdigest()

    def imported_program(self, digest: str) -> dict[str, object] | None:
        programs = self._manifest["programs"]
        if not isinstance(programs, dict):
            raise RuntimeError("Ghidra manifest programs are malformed")
        item = programs.get(digest)
        return dict(item) if isinstance(item, dict) else None

    def programs(self) -> list[dict[str, object]]:
        programs = self._manifest["programs"]
        if not isinstance(programs, dict):
            raise RuntimeError("Ghidra manifest programs are malformed")
        return sorted(
            (dict(item) for item in programs.values() if isinstance(item, dict)),
            key=lambda item: str(item.get("program", "")),
        )

    def project_status(self) -> dict[str, object]:
        idle = self._operation_lock.acquire(blocking=False)
        if idle:
            self._operation_lock.release()
        return {
            "project": "Cyberful",
            "programs": self.programs(),
            "busy": not idle,
        }

    def checkpoint(self) -> dict[str, object]:
        import time

        with self.exclusive():
            value = {
                "schema": 1,
                "created_at": time.time(),
                "manifest_sha256": hashlib.sha256(self.manifest_path.read_bytes()).hexdigest()
                if self.manifest_path.exists()
                else None,
            }
            atomic_json(self.checkpoint_path, value)
            return value

    def import_program(self, source_path: str, requested_name: str | None, analyze: bool) -> dict[str, object]:
        source = self.resolve_source(source_path)
        digest = self.source_digest(source)
        existing = self.imported_program(digest)
        if existing:
            if analyze and not existing.get("analyzed"):
                self.analyze_program(str(existing["program"]))
                existing = self.imported_program(digest)
            return {"idempotent": True, **(existing or {})}

        base_name = requested_name or source.name
        safe_name = re.sub(r"[^A-Za-z0-9_.@+-]", "_", base_name).strip("._")[:150] or "program"
        program_name = f"{safe_name}-{digest[:12]}"
        program_path = f"/{program_name}"
        pyghidra = self._require_pyghidra()
        with self.exclusive(wait=True), self._monitor() as monitor:
            loader = pyghidra.program_loader().project(self._project).source(str(source)).name(program_name)
            with loader.load() as load_results:
                load_results.save(monitor)
            record: dict[str, object] = {
                "program": program_path,
                "sha256": digest,
                "source_path": source_path,
                "size": source.stat().st_size,
                "analyzed": False,
            }
            programs = self._manifest["programs"]
            if not isinstance(programs, dict):
                raise RuntimeError("Ghidra manifest programs are malformed")
            programs[digest] = record
            atomic_json(self.manifest_path, self._manifest)
            if analyze:
                self._analyze_locked(program_path)
            return {"idempotent": False, **(self.imported_program(digest) or record)}

    def analyze_program(self, program_path: str, timeout_seconds: int = 3600) -> dict[str, object]:
        with self.exclusive(wait=True):
            return self._analyze_locked(program_path, timeout_seconds)

    def _analyze_locked(self, program_path: str, timeout_seconds: int = 3600) -> dict[str, object]:
        pyghidra = self._require_pyghidra()
        normalized = self._program_path(program_path)
        with pyghidra.program_context(self._project, normalized) as program, self._monitor(timeout_seconds) as monitor:
            analysis_log = str(pyghidra.analyze(program, monitor))
            program.save("Cyberful automated analysis", pyghidra.task_monitor())
        programs = self._manifest["programs"]
        if isinstance(programs, dict):
            for item in programs.values():
                if isinstance(item, dict) and item.get("program") == normalized:
                    item["analyzed"] = True
                    item["analysis_log_tail"] = analysis_log[-8_192:]
                    break
        atomic_json(self.manifest_path, self._manifest)
        return {"program": normalized, "analyzed": True, "analysis_log_tail": analysis_log[-8_192:]}

    def search(
        self,
        program_path: str,
        kind: str,
        query: str,
        offset: int,
        limit: int,
    ) -> dict[str, object]:
        normalized = self._program_path(program_path)
        lowered = query.casefold()
        with self.exclusive(), self._program(normalized) as program:
            if kind == "functions":
                items = [
                    {
                        "name": str(function.getName()),
                        "entry": str(function.getEntryPoint()),
                        "external": bool(function.isExternal()),
                        "thunk": bool(function.isThunk()),
                    }
                    for function in program.getFunctionManager().getFunctions(True)
                    if lowered in str(function.getName()).casefold()
                ]
            elif kind == "symbols":
                items = [
                    {
                        "name": str(symbol.getName()),
                        "address": str(symbol.getAddress()),
                        "type": str(symbol.getSymbolType()),
                        "source": str(symbol.getSource()),
                    }
                    for symbol in program.getSymbolTable().getAllSymbols(True)
                    if lowered in str(symbol.getName()).casefold()
                ]
            elif kind == "strings":
                items = []
                for data in program.getListing().getDefinedData(True):
                    if not data.hasStringValue():
                        continue
                    value = str(data.getValue())
                    if lowered in value.casefold():
                        items.append({"address": str(data.getAddress()), "value": value[:4_096]})
            else:
                raise InputError("kind must be functions, symbols, or strings")
        return self._page(items, offset, limit)

    def listing(self, program_path: str, selector: str, offset: int, limit: int) -> dict[str, object]:
        normalized = self._program_path(program_path)
        with self.exclusive(), self._program(normalized) as program:
            function = self._find_function(program, selector)
            address = function.getEntryPoint() if function is not None else self._address(program, selector)
            instructions = program.getListing().getInstructions(address, True)
            items = []
            skipped = 0
            for instruction in instructions:
                if function is not None and not function.getBody().contains(instruction.getAddress()):
                    break
                if skipped < offset:
                    skipped += 1
                    continue
                if len(items) >= limit:
                    break
                raw = bytes((int(value) & 0xFF for value in instruction.getBytes())).hex()
                items.append(
                    {
                        "address": str(instruction.getAddress()),
                        "bytes": raw,
                        "mnemonic": str(instruction.getMnemonicString()),
                        "text": str(instruction),
                    }
                )
        return {"items": items, "offset": offset, "limit": limit, "has_more": len(items) == limit}

    def decompile(self, program_path: str, selector: str, timeout_seconds: int) -> dict[str, object]:
        normalized = self._program_path(program_path)
        with self.exclusive(), self._program(normalized) as program, self._monitor(timeout_seconds) as monitor:
            function = self._required_function(program, selector)
            from ghidra.app.decompiler import DecompInterface

            decompiler = DecompInterface()
            try:
                if not decompiler.openProgram(program):
                    raise RuntimeError(
                        f"Ghidra decompiler could not open the program: {decompiler.getLastMessage()}"
                    )
                result = decompiler.decompileFunction(function, timeout_seconds, monitor)
                if not result.decompileCompleted():
                    raise RuntimeError(f"Ghidra decompilation failed: {result.getErrorMessage()}")
                text = str(result.getDecompiledFunction().getC())
            finally:
                decompiler.dispose()
        truncated = len(text) > MAX_DECOMPILE_CHARACTERS
        return {
            "program": normalized,
            "function": str(function.getName()),
            "entry": str(function.getEntryPoint()),
            "decompiled": text[:MAX_DECOMPILE_CHARACTERS],
            "truncated": truncated,
        }

    def xrefs(self, program_path: str, selector: str, direction: str, offset: int, limit: int) -> dict[str, object]:
        normalized = self._program_path(program_path)
        with self.exclusive(), self._program(normalized) as program:
            function = self._find_function(program, selector)
            address = function.getEntryPoint() if function is not None else self._address(program, selector)
            manager = program.getReferenceManager()
            references = (
                manager.getReferencesTo(address)
                if direction == "to"
                else manager.getReferencesFrom(address)
                if direction == "from"
                else None
            )
            if references is None:
                raise InputError("direction must be to or from")
            items = [
                {
                    "from": str(reference.getFromAddress()),
                    "to": str(reference.getToAddress()),
                    "type": str(reference.getReferenceType()),
                    "primary": bool(reference.isPrimary()),
                }
                for reference in references
            ]
        return self._page(items, offset, limit)

    def call_graph(
        self,
        program_path: str,
        root: str | None,
        depth: int,
        offset: int,
        limit: int,
    ) -> dict[str, object]:
        normalized = self._program_path(program_path)
        with self.exclusive(), self._program(normalized) as program, self._monitor(120) as monitor:
            manager = program.getFunctionManager()
            roots = [self._required_function(program, root)] if root else list(manager.getFunctions(True))
            nodes: dict[str, dict[str, object]] = {}
            edges: list[dict[str, str]] = []
            queue: list[tuple[object, int]] = [(function, 0) for function in roots]
            visited: set[str] = set()
            while queue and len(nodes) < MAX_GRAPH_NODES:
                function, level = queue.pop(0)
                entry = str(function.getEntryPoint())
                if entry in visited:
                    continue
                visited.add(entry)
                nodes[entry] = {"id": entry, "name": str(function.getName()), "external": bool(function.isExternal())}
                if level >= depth:
                    continue
                for called in function.getCalledFunctions(monitor):
                    called_entry = str(called.getEntryPoint())
                    edges.append({"from": entry, "to": called_entry})
                    if called_entry not in visited:
                        queue.append((called, level + 1))
            page = edges[offset : offset + limit]
        return {
            "nodes": list(nodes.values()),
            "edges": page,
            "offset": offset,
            "limit": limit,
            "total_edges": len(edges),
            "has_more": offset + limit < len(edges),
            "truncated_nodes": len(nodes) >= MAX_GRAPH_NODES and bool(queue),
        }

    def annotate(
        self,
        program_path: str,
        action: str,
        selector: str,
        value: str,
        comment_type: str = "eol",
    ) -> dict[str, object]:
        normalized = self._program_path(program_path)
        with self.exclusive(), self._program(normalized) as program, self._monitor() as monitor:
            function = self._find_function(program, selector)
            address = function.getEntryPoint() if function is not None else self._address(program, selector)
            with self._require_pyghidra().transaction(program, f"Cyberful {action}"):
                if action == "comment":
                    from ghidra.program.model.listing import CodeUnit

                    kinds = {
                        "plate": CodeUnit.PLATE_COMMENT,
                        "pre": CodeUnit.PRE_COMMENT,
                        "eol": CodeUnit.EOL_COMMENT,
                        "post": CodeUnit.POST_COMMENT,
                        "repeatable": CodeUnit.REPEATABLE_COMMENT,
                    }
                    if comment_type not in kinds:
                        raise InputError("comment_type must be plate, pre, eol, post, or repeatable")
                    program.getListing().setComment(address, kinds[comment_type], value)
                elif action == "bookmark":
                    program.getBookmarkManager().setBookmark(address, "Cyberful", "Analysis", value)
                elif action == "rename":
                    from ghidra.program.model.symbol import SourceType

                    if function is None:
                        raise InputError("rename requires a function name or function address")
                    if not NAME_PATTERN.fullmatch(value):
                        raise InputError("rename value is not a valid function name")
                    function.setName(value, SourceType.USER_DEFINED)
                else:
                    raise InputError("action must be comment, bookmark, or rename")
            program.save(f"Cyberful {action}", monitor)
        record = {
            "program": normalized,
            "action": action,
            "address": str(address),
            "selector": selector,
            "value": value,
            "comment_type": comment_type if action == "comment" else None,
        }
        append_json_line(self.annotations_path, record)
        return record

    def annotations(self, program_path: str | None, offset: int, limit: int) -> dict[str, object]:
        items: list[dict[str, object]] = []
        if self.annotations_path.exists():
            with self.annotations_path.open("r", encoding="utf-8") as stream:
                for line in stream:
                    parsed = json.loads(line)
                    if isinstance(parsed, dict) and (program_path is None or parsed.get("program") == program_path):
                        items.append(parsed)
        return self._page(items, offset, limit)

    @contextlib.contextmanager
    def _program(self, program_path: str) -> Iterator[object]:
        pyghidra = self._require_pyghidra()
        with pyghidra.program_context(self._project, program_path) as program:
            yield program

    def _program_path(self, value: str) -> str:
        normalized = value if value.startswith("/") else f"/{value}"
        if not PROGRAM_PATTERN.fullmatch(normalized):
            raise InputError("program must be a simple absolute Ghidra project path")
        if not any(item.get("program") == normalized for item in self.programs()):
            raise InputError(f"program is not present in this project: {normalized}")
        return normalized

    def _address(self, program: object, selector: str) -> object:
        if not ADDRESS_PATTERN.fullmatch(selector):
            raise InputError("selector must be a function name or hexadecimal address")
        canonical = selector[2:] if selector.lower().startswith("0x") else selector
        address = program.getAddressFactory().getDefaultAddressSpace().getAddress(int(canonical, 16))
        if address is None:
            raise InputError(f"address is not valid in this program: {selector}")
        return address

    def _find_function(self, program: object, selector: str | None) -> object | None:
        if selector is None:
            return None
        manager = program.getFunctionManager()
        if ADDRESS_PATTERN.fullmatch(selector):
            address = self._address(program, selector)
            return manager.getFunctionAt(address) or manager.getFunctionContaining(address)
        for function in manager.getFunctions(True):
            if str(function.getName()) == selector:
                return function
        return None

    def _required_function(self, program: object, selector: str | None) -> object:
        if not selector:
            raise InputError("a function name or address is required")
        function = self._find_function(program, selector)
        if function is None:
            raise InputError(f"function was not found: {selector}")
        return function

    @staticmethod
    def _page(items: list[dict[str, object]], offset: int, limit: int) -> dict[str, object]:
        bounded_limit = min(limit, MAX_LISTING_ITEMS)
        return {
            "items": items[offset : offset + bounded_limit],
            "offset": offset,
            "limit": bounded_limit,
            "total": len(items),
            "has_more": offset + bounded_limit < len(items),
        }
