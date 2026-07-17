// ── Read-Only Source Boundary ─────────────────────────────────────
// Exposes bounded inventory, read, search, and snapshot operations for the
// project source while keeping every write inside the phase workarea.
// → cyberful/src/subsystem/gateway/server.ts — publishes these operations to phases.
// ─────────────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { verifySourceImport } from "./source-import"

const MAX_FILES = 50_000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_READ_BYTES = 512 * 1024
const MAX_SEARCH_RESULTS = 200
const HASH_CONCURRENCY = 32
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".tox",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "work",
])

export const SOURCE_TOOL_DEFS = [
  {
    name: "source_inventory",
    description:
      "Inventory the authorized project source without following symlinks. Returns bounded paths, language, size, and SHA-256 metadata; it never writes to the project.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        prefix: { type: "string", description: "Optional relative directory beneath the project source." },
      },
    },
  },
  {
    name: "source_read",
    description:
      "Read a bounded UTF-8 source range from the authorized project. Binary files, symlinks, and paths outside the source root are rejected.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
  },
  {
    name: "source_search",
    description:
      "Search bounded text source using a literal string or a safe JavaScript regular expression. Results contain paths, line numbers, and short matching lines.",
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        regex: { type: "boolean", default: false },
        prefix: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: MAX_SEARCH_RESULTS },
      },
      required: ["query"],
    },
  },
  {
    name: "source_snapshot",
    description:
      "Materialize a deterministic read-only analysis snapshot under raw/source-snapshot in the workarea and return its manifest. The original checkout is never modified.",
    inputSchema: { type: "object" as const, additionalProperties: false, properties: {} },
  },
] as const

export type SourceToolName = (typeof SOURCE_TOOL_DEFS)[number]["name"]

export interface SourceToolContext {
  readonly sourceRoot: string
  readonly workareaRoot: string
}

interface SourceEntry {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly language: string
}

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".adb": "ada",
  ".ads": "ada",
  ".asm": "assembly",
  ".action": "ros-action",
  ".bash": "bash",
  ".bazel": "bazel",
  ".bzl": "bazel",
  ".c": "c",
  ".cairo": "cairo",
  ".cc": "cpp",
  ".circom": "circom",
  ".clar": "clarity",
  ".clj": "clojure",
  ".cmake": "cmake",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".cu": "cuda",
  ".cuh": "cuda",
  ".cxx": "cpp",
  ".dts": "device-tree",
  ".dtsi": "device-tree",
  ".dart": "dart",
  ".erl": "erlang",
  ".ex": "elixir",
  ".exs": "elixir",
  ".fs": "fsharp",
  ".fsi": "fsharp",
  ".fsx": "fsharp",
  ".go": "go",
  ".h": "c-header",
  ".hcl": "hcl",
  ".hh": "cpp-header",
  ".hpp": "cpp-header",
  ".hs": "haskell",
  ".java": "java",
  ".jl": "julia",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".lua": "lua",
  ".ld": "linker-script",
  ".m": "objective-c-or-matlab",
  ".matlab": "matlab",
  ".md": "markdown",
  ".mk": "make",
  ".ml": "ocaml",
  ".mlx": "matlab",
  ".mm": "objective-cpp",
  ".move": "move",
  ".msg": "ros-message",
  ".noir": "noir",
  ".nr": "noir",
  ".php": "php",
  ".pl": "perl",
  ".proto": "protobuf",
  ".ps1": "powershell",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".s": "assembly",
  ".scala": "scala",
  ".scilla": "scilla",
  ".sh": "bash",
  ".sol": "solidity",
  ".sql": "sql",
  ".st": "iec-structured-text",
  ".srv": "ros-service",
  ".sv": "systemverilog",
  ".svh": "systemverilog",
  ".sway": "sway",
  ".swift": "swift",
  ".tf": "terraform",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".v": "verilog",
  ".vhd": "vhdl",
  ".vhdl": "vhdl",
  ".vy": "vyper",
  ".wat": "webassembly",
  ".wasm": "webassembly-binary",
  ".xml": "xml",
  ".xacro": "xacro",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zig": "zig",
}

function sourceRoots(): SourceToolContext | undefined {
  const sourceRoot = process.env.CYBERFUL_SUBSYSTEM_SOURCE_ROOT?.trim()
  const workareaRoot = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  if (!sourceRoot || !workareaRoot || !path.isAbsolute(sourceRoot) || !path.isAbsolute(workareaRoot)) return
  return { sourceRoot: path.resolve(sourceRoot), workareaRoot: path.resolve(workareaRoot) }
}

export async function effectiveSourceRoot(
  configuredSourceRoot: string,
  workareaRoot: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const canonicalWorkarea = await realpath(workareaRoot)
  const rawRoot = path.join(canonicalWorkarea, "raw")
  const importRoot = path.join(rawRoot, "source-import")
  const imported = path.join(canonicalWorkarea, "raw", "source-import", "repository")
  const manifestPath = path.join(importRoot, "manifest.json")
  for (const directory of [rawRoot, importRoot]) {
    const metadata = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!metadata) return realpath(configuredSourceRoot)
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("source import path contains a non-directory or symlink")
  }
  const [repositoryMetadata, manifest] = await Promise.all([
    lstat(imported).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    }),
    lstat(manifestPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    }),
  ])
  if (!repositoryMetadata && !manifest) return realpath(configuredSourceRoot)
  if (!repositoryMetadata?.isDirectory() || repositoryMetadata.isSymbolicLink())
    throw new Error("source import repository is missing, non-directory, or symlink")
  const resolved = await realpath(imported)
  if (!isContained(canonicalWorkarea, resolved)) throw new Error("source import resolves outside the workarea")
  if (!manifest?.isFile() || manifest.isSymbolicLink()) throw new Error("source import manifest is missing or unsafe")
  await verifySourceImport(resolved, manifestPath, environment)
  return resolved
}

function isContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function requestedRelativePath(value: unknown) {
  if (value === undefined || value === "") return ""
  if (typeof value !== "string" || path.isAbsolute(value)) throw new Error("source path must be relative")
  const normalized = path.normalize(value)
  if (normalized.split(path.sep).includes("..")) throw new Error("source path escapes the project root")
  if (normalized.split(path.sep).some((segment) => EXCLUDED_DIRECTORIES.has(segment.toLowerCase())))
    throw new Error("source path enters an excluded directory")
  return normalized === "." ? "" : normalized
}

async function containedExistingPath(root: string, relative: string) {
  const candidate = path.resolve(root, relative)
  if (!isContained(root, candidate)) throw new Error("source path escapes the project root")
  let current = root
  for (const segment of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const entry = await lstat(current)
    if (entry.isSymbolicLink()) throw new Error("source path may not contain symlinks")
  }
  const resolved = await realpath(candidate)
  const resolvedRoot = await realpath(root)
  if (!isContained(resolvedRoot, resolved)) throw new Error("source path resolves outside the project root")
  return resolved
}

async function ensurePlainWorkareaDirectory(root: string, relative: string) {
  let current = root
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment)
    const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!existing) await mkdir(current, { mode: 0o700 })
    const created = await lstat(current)
    if (!created.isDirectory() || created.isSymbolicLink())
      throw new Error("snapshot path contains a non-directory or symlink")
    const resolved = await realpath(current)
    if (!isContained(root, resolved)) throw new Error("snapshot path resolves outside the workarea")
  }
  return current
}

function languageFor(file: string) {
  const basename = path.basename(file).toLowerCase()
  if (basename === "dockerfile") return "dockerfile"
  if (basename === "cmakelists.txt") return "cmake"
  if (basename === "makefile") return "make"
  if (basename.endsWith(".urdf") || basename.endsWith(".urdf.xacro")) return "urdf-xacro"
  if (basename.endsWith(".sdf")) return "sdf"
  if (basename.endsWith(".launch") || basename.endsWith(".launch.xml")) return "ros-launch"
  return LANGUAGE_BY_EXTENSION[path.extname(basename)] ?? "text-or-unknown"
}

async function candidateFiles(root: string, relativePrefix = "") {
  const start = await containedExistingPath(root, relativePrefix)
  const startInfo = await lstat(start)
  if (startInfo.isSymbolicLink()) throw new Error("source prefix may not be a symlink")
  const files: string[] = []
  const directories = startInfo.isDirectory() ? [start] : []
  if (startInfo.isFile()) files.push(start)
  while (directories.length > 0 && files.length < MAX_FILES) {
    const directory = directories.pop()
    if (!directory) break
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) directories.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const info = await lstat(absolute)
      if (info.size <= MAX_SOURCE_BYTES) files.push(absolute)
      if (files.length >= MAX_FILES) break
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

async function mapBounded<T, R>(items: readonly T[], operation: (item: T) => Promise<R>) {
  const output: R[] = []
  for (let offset = 0; offset < items.length; offset += HASH_CONCURRENCY) {
    output.push(...(await Promise.all(items.slice(offset, offset + HASH_CONCURRENCY).map(operation))))
  }
  return output
}

async function inventory(context: SourceToolContext, prefix: string): Promise<SourceEntry[]> {
  const files = await candidateFiles(context.sourceRoot, prefix)
  return mapBounded(files, async (file) => {
    const bytes = await readFile(file)
    return {
      path: path.relative(context.sourceRoot, file).replaceAll(path.sep, "/"),
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      language: languageFor(file),
    }
  })
}

function textFile(bytes: Buffer) {
  return !bytes.includes(0)
}

async function handleInventory(context: SourceToolContext, args: Record<string, unknown>) {
  const files = await inventory(context, requestedRelativePath(args.prefix))
  const languages = Object.entries(
    files.reduce<Record<string, number>>((counts, file) => {
      counts[file.language] = (counts[file.language] ?? 0) + 1
      return counts
    }, {}),
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([language, count]) => ({ language, count }))
  return { root: ".", files, languages, truncated: files.length >= MAX_FILES }
}

async function handleRead(context: SourceToolContext, args: Record<string, unknown>) {
  const relative = requestedRelativePath(args.path)
  if (!relative) throw new Error("source_read requires path")
  const file = await containedExistingPath(context.sourceRoot, relative)
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("source_read requires a regular file")
  if (info.size > MAX_READ_BYTES) throw new Error(`source file exceeds ${MAX_READ_BYTES} bytes`)
  const bytes = await readFile(file)
  if (!textFile(bytes)) throw new Error("source_read does not return binary files")
  const lines = bytes.toString("utf8").split(/\r?\n/)
  const start = Number.isInteger(args.start_line) ? Math.max(1, Number(args.start_line)) : 1
  const requestedEnd = Number.isInteger(args.end_line) ? Number(args.end_line) : Math.min(lines.length, start + 499)
  const end = Math.min(lines.length, start + 499, Math.max(start, requestedEnd))
  return {
    path: relative.replaceAll(path.sep, "/"),
    start_line: start,
    end_line: end,
    total_lines: lines.length,
    text: lines.slice(start - 1, end).join("\n"),
    truncated: end < lines.length,
  }
}

async function handleSearch(context: SourceToolContext, args: Record<string, unknown>) {
  if (typeof args.query !== "string" || !args.query || args.query.length > 500)
    throw new Error("source_search query must contain 1-500 characters")
  const query = args.query
  const limit = Number.isInteger(args.max_results)
    ? Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(args.max_results)))
    : MAX_SEARCH_RESULTS
  let matcher: (line: string) => boolean
  if (args.regex === true) {
    if (/\([^)]*[*+][^)]*\)[*+{]|\\[1-9]/.test(query))
      throw new Error("source_search rejects nested quantifiers and backreferences")
    const expression = new RegExp(query, "u")
    matcher = (line) => expression.test(line)
  } else {
    matcher = (line) => line.includes(query)
  }
  const files = await candidateFiles(context.sourceRoot, requestedRelativePath(args.prefix))
  const results: { path: string; line: number; text: string }[] = []
  for (const file of files) {
    const bytes = await readFile(file)
    if (!textFile(bytes)) continue
    const lines = bytes.toString("utf8").split(/\r?\n/)
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line === undefined || !matcher(line)) continue
      results.push({
        path: path.relative(context.sourceRoot, file).replaceAll(path.sep, "/"),
        line: index + 1,
        text: line.slice(0, 1_000),
      })
      if (results.length >= limit) return { results, truncated: true }
    }
  }
  return { results, truncated: false }
}

// ── Snapshot Writes Never Cross Back Into Source ─────────────────
// A source checkout may itself contain the workarea. Inventory excludes that
// reserved directory, and every destination is derived from the separately
// validated workarea root. Building in a sibling temporary directory permits
// an atomic replacement without exposing a half-copied tree to later phases.
//
// ─────────────────────────────────────────────────────────────────

async function handleSnapshot(context: SourceToolContext) {
  const rawRoot = await ensurePlainWorkareaDirectory(context.workareaRoot, "raw")
  const snapshotRoot = path.join(rawRoot, "source-snapshot")
  if (!isContained(context.workareaRoot, snapshotRoot)) throw new Error("snapshot path escapes the workarea")
  const temporary = `${snapshotRoot}.${process.pid}.${randomUUID()}.tmp`
  const files = await inventory(context, "")
  await rm(temporary, { recursive: true, force: true })
  await mkdir(path.join(temporary, "tree"), { recursive: true, mode: 0o700 })
  try {
    for (const entry of files) {
      const source = await containedExistingPath(context.sourceRoot, entry.path)
      const destination = path.join(temporary, "tree", entry.path)
      if (!isContained(path.join(temporary, "tree"), destination)) throw new Error("snapshot file escaped its root")
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await copyFile(source, destination)
    }
    const digest = createHash("sha256")
    for (const entry of files) digest.update(`${entry.sha256}  ${entry.path}\n`)
    const manifest = {
      version: 1,
      created_at: new Date().toISOString(),
      source_root: context.sourceRoot,
      tree: "tree",
      file_count: files.length,
      sha256: digest.digest("hex"),
      excluded_directories: [...EXCLUDED_DIRECTORIES].sort(),
      files,
    }
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
    })
    await rm(snapshotRoot, { recursive: true, force: true })
    await rename(temporary, snapshotRoot)
    return {
      ...manifest,
      source_root: undefined,
      snapshot_path: path.relative(context.workareaRoot, snapshotRoot).replaceAll(path.sep, "/"),
      manifest_path: path
        .relative(context.workareaRoot, path.join(snapshotRoot, "manifest.json"))
        .replaceAll(path.sep, "/"),
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

export function sourceToolsAvailable() {
  return sourceRoots() !== undefined
}

export function isSourceTool(name: string): name is SourceToolName {
  return SOURCE_TOOL_DEFS.some((tool) => tool.name === name)
}

export async function handleSourceTool(name: SourceToolName, args: Record<string, unknown>) {
  const context = sourceRoots()
  if (!context) throw new Error("source tools require absolute source and workarea roots")
  const workareaRoot = await realpath(context.workareaRoot)
  const canonical = {
    sourceRoot: await effectiveSourceRoot(context.sourceRoot, workareaRoot),
    workareaRoot,
  }
  switch (name) {
    case "source_inventory":
      return handleInventory(canonical, args)
    case "source_read":
      return handleRead(canonical, args)
    case "source_search":
      return handleSearch(canonical, args)
    case "source_snapshot":
      return handleSnapshot(canonical)
  }
}
