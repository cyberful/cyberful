// ── Code Graph Host Service ─────────────────────────────────────────────────
// Exposes the single integration facade used by gateway tools and workflows:
// validated incremental indexing/query, finding lifecycle operations, embedded
// language manifest inspection, and contained SARIF/evidence exports. It owns
// database lifetime and private filesystem permissions for the workarea.
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path"
import { chmod, lstat, mkdir, open, realpath, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { replaceWorkareaFile } from "../workarea"
import { CodeGraphEngine, normalizeCodeGraphEngineLimits, type CodeGraphIndexProgress } from "./engine"
import { FindingLedger } from "./ledger"
import { createDefaultLanguageRegistry, languageManifestFor, type LanguageRegistry } from "./registry"
import { CodeGraphStore } from "./store"
import { parseGraphQuery, parseIndexOptions } from "./validation"
import type {
  FindingFilter,
  FindingTransition,
  FindingTransitionRecord,
  GraphQuery,
  IndexOptions,
  SecurityFinding,
  SecurityFindingInput,
} from "./types"

export interface CreateCodeGraphServiceOptions {
  readonly sourceRoot: string
  readonly workareaRoot: string
  readonly registry?: LanguageRegistry
  readonly maxFileBytes?: number
  readonly maxFiles?: number
  readonly maxGraphRecords?: number
  readonly readConcurrency?: number
  readonly now?: () => Date
}

export interface CodeGraphExportResult {
  readonly path: string
  readonly sha256: string
  readonly bytes: number
}

export interface FindingIntegrityState {
  readonly findings: readonly SecurityFinding[]
  readonly transitions: readonly FindingTransitionRecord[]
}

export interface CodeGraphService {
  readonly databasePath: string
  readonly progressPath: string
  readonly sourceRoot: string
  readonly workareaRoot: string
  index(input?: unknown, signal?: AbortSignal): ReturnType<CodeGraphEngine["index"]>
  query(input: unknown): ReturnType<CodeGraphEngine["query"]>
  recordFinding(input: unknown): ReturnType<FindingLedger["record"]>
  getFinding(id: unknown): ReturnType<CodeGraphStore["finding"]>
  listFindings(input?: unknown): ReturnType<FindingLedger["list"]>
  findingIntegrityState(): FindingIntegrityState
  transitionFinding(input: unknown): ReturnType<FindingLedger["transition"]>
  exportSarif(outputPath?: unknown, integrity?: FindingIntegrityState): Promise<CodeGraphExportResult>
  exportEvidence(outputPath?: unknown, integrity?: FindingIntegrityState): Promise<CodeGraphExportResult>
  languageManifest(): ReturnType<typeof languageManifestFor>
  close(): Promise<void>
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function normalizedExportPath(value: unknown, fallback: string) {
  if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 4_096))
    throw new Error("Code graph export path must be a non-empty string.")
  const normalized = (value === undefined ? fallback : value).replaceAll("\\", "/").replace(/^\.\//, "")
  if (path.posix.isAbsolute(normalized) || normalized.split("/").includes(".."))
    throw new Error("Code graph export path must stay relative to the workarea.")
  return normalized
}

async function chmodIfExists(filePath: string, mode: number) {
  if (process.platform === "win32") return
  try {
    await lstat(filePath)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  await chmod(filePath, mode)
}

async function restrictDatabase(databasePath: string) {
  await Promise.all([
    chmodIfExists(databasePath, 0o600),
    chmodIfExists(`${databasePath}-wal`, 0o600),
    chmodIfExists(`${databasePath}-shm`, 0o600),
  ])
}

async function fileSize(filePath: string) {
  try {
    return (await stat(filePath)).size
  } catch (error) {
    if (isMissing(error)) return 0
    throw error
  }
}

// ── Index Progress Is A Local, Durable Operational Signal ──────────────────
// A large repository can spend meaningful time in inventory, decoding, graph
// analysis, or the atomic SQLite commit. The model-facing MCP result arrives
// only after all of those stages, so it cannot distinguish work from a stall.
// A tiny atomically replaced workarea record exposes stage counters plus host
// RSS and SQLite/WAL size without sending telemetry or weakening isolation.
// ─────────────────────────────────────────────────────────────────────────────

interface CodeGraphProgressArtifact extends CodeGraphIndexProgress {
  readonly status: "running" | "complete" | "failed"
  readonly startedAt: string
  readonly updatedAt: string
  readonly resources: {
    readonly rssBytes: number
    readonly databaseBytes: number
    readonly walBytes: number
  }
}

async function plainDirectory(root: string, relative: string) {
  let current = root
  for (const segment of relative.split("/").filter(Boolean)) {
    current = path.join(current, segment)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink() || !metadata.isDirectory())
        throw new Error(`Code graph output directory is not a plain directory: ${current}`)
    } catch (error) {
      if (!isMissing(error)) throw error
      await mkdir(current, { mode: 0o700 })
    }
    const canonical = await realpath(current)
    if (!contained(root, canonical)) throw new Error(`Code graph output directory escapes the workarea: ${current}`)
    current = canonical
  }
  return current
}

async function prepareDatabaseFile(databasePath: string) {
  try {
    const metadata = await lstat(databasePath)
    if (metadata.isSymbolicLink() || !metadata.isFile())
      throw new Error("Code graph database path must be a plain file.")
    await chmodIfExists(databasePath, 0o600)
    return
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const handle = await open(
    databasePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  await handle.close()
}

async function writeJson(workareaRoot: string, outputPath: unknown, fallback: string, value: unknown) {
  const relative = normalizedExportPath(outputPath, fallback)
  const segments = relative.split("/").filter(Boolean)
  const filename = segments.pop()
  if (!filename) throw new Error("Code graph export path must name a file.")
  const directory = await plainDirectory(workareaRoot, segments.join("/"))
  const destination = path.join(directory, filename)
  try {
    const metadata = await lstat(destination)
    if (metadata.isSymbolicLink() || !metadata.isFile())
      throw new Error("Code graph export destination must be a plain file.")
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  const content = `${JSON.stringify(value, null, 2)}\n`
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(content, { encoding: "utf8" })
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(destination, 0o600)
  return {
    path: destination,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
  } satisfies CodeGraphExportResult
}

// ── One Facade Owns Engine, Ledger, And Filesystem Lifetime ────────────────
// Gateway phases receive no raw SQLite handle and cannot choose a database
// location. The facade validates unknown payloads, confines every artifact to
// the workarea, waits for the serialized index queue during shutdown, and then
// closes the store. This creates one explicit owner for writes and cleanup even
// when cancellation races a terminal export or phase handoff.
// ─────────────────────────────────────────────────────────────────────────────

export async function createCodeGraphService(options: CreateCodeGraphServiceOptions): Promise<CodeGraphService> {
  const limits = normalizeCodeGraphEngineLimits(options)
  const sourceRoot = await realpath(path.resolve(options.sourceRoot))
  const sourceMetadata = await lstat(sourceRoot)
  if (!sourceMetadata.isDirectory()) throw new Error("Code graph sourceRoot must be a directory.")
  const requestedWorkarea = path.resolve(options.workareaRoot)
  await mkdir(requestedWorkarea, { recursive: true, mode: 0o700 })
  const workareaMetadata = await lstat(requestedWorkarea)
  if (workareaMetadata.isSymbolicLink() || !workareaMetadata.isDirectory())
    throw new Error("Code graph workareaRoot must be a plain directory.")
  const workareaRoot = await realpath(requestedWorkarea)
  await chmodIfExists(workareaRoot, 0o700)
  const graphRoot = await plainDirectory(workareaRoot, "raw/code-graph")
  const databasePath = path.join(graphRoot, "index.sqlite")
  const progressPath = path.join(graphRoot, "progress.json")
  await prepareDatabaseFile(databasePath)
  const registry = options.registry ?? createDefaultLanguageRegistry()
  const store = new CodeGraphStore(databasePath)
  await restrictDatabase(databasePath)
  const clock = options.now ?? (() => new Date())
  let indexStartedAt = clock().toISOString()
  const persistProgress = async (progress: CodeGraphIndexProgress) => {
    const updatedAt = clock().toISOString()
    if (progress.stage === "inventory" && progress.completed === 0) indexStartedAt = updatedAt
    const [databaseBytes, walBytes] = await Promise.all([fileSize(databasePath), fileSize(`${databasePath}-wal`)])
    const artifact = {
      ...progress,
      status: progress.stage === "complete" ? "complete" : progress.stage === "failed" ? "failed" : "running",
      startedAt: indexStartedAt,
      updatedAt,
      resources: {
        rssBytes: process.memoryUsage().rss,
        databaseBytes,
        walBytes,
      },
    } satisfies CodeGraphProgressArtifact
    await replaceWorkareaFile(workareaRoot, "raw/code-graph/progress.json", `${JSON.stringify(artifact, null, 2)}\n`, {
      mode: 0o600,
    })
  }
  const engine = new CodeGraphEngine({
    sourceRoot,
    store,
    registry,
    excludedRoots: contained(sourceRoot, workareaRoot) ? [workareaRoot] : [],
    ...limits,
    now: options.now,
    onProgress: persistProgress,
  })
  const ledger = new FindingLedger(store, options.now)
  let closed = false

  const assertOpen = () => {
    if (closed) throw new Error("Code graph service is closed.")
  }

  return {
    databasePath,
    progressPath,
    sourceRoot,
    workareaRoot,
    async index(input?: unknown, signal?: AbortSignal) {
      assertOpen()
      const parsed = parseIndexOptions(input)
      const optionsWithSignal: IndexOptions = signal ? { ...parsed, signal } : parsed
      const result = await engine.index(optionsWithSignal)
      await restrictDatabase(databasePath)
      return result
    },
    query(input: unknown) {
      assertOpen()
      return engine.query(parseGraphQuery(input))
    },
    recordFinding(input: unknown) {
      assertOpen()
      return ledger.record(input)
    },
    getFinding(id: unknown) {
      assertOpen()
      if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
        throw new Error("Finding id must be a SHA-256 identifier.")
      return store.finding(id)
    },
    listFindings(input?: unknown) {
      assertOpen()
      return ledger.list(input)
    },
    findingIntegrityState() {
      assertOpen()
      return { findings: store.findings(), transitions: store.transitions() }
    },
    transitionFinding(input: unknown) {
      assertOpen()
      return ledger.transition(input)
    },
    async exportSarif(outputPath?: unknown, integrity?: FindingIntegrityState) {
      assertOpen()
      return writeJson(
        workareaRoot,
        outputPath,
        path.join("raw", "code-graph", "findings.sarif"),
        ledger.sarif(integrity?.findings),
      )
    },
    async exportEvidence(outputPath?: unknown, integrity?: FindingIntegrityState) {
      assertOpen()
      return writeJson(
        workareaRoot,
        outputPath,
        path.join("raw", "code-graph", "evidence.json"),
        ledger.evidence(integrity),
      )
    },
    languageManifest() {
      assertOpen()
      return languageManifestFor(registry)
    },
    async close() {
      if (closed) return
      closed = true
      await engine.idle()
      store.close()
    },
  }
}

export type { FindingFilter, FindingTransition, GraphQuery, IndexOptions, SecurityFindingInput }
