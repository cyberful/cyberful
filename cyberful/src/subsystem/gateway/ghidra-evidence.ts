// ── Automatic Ghidra Evidence Capture ────────────────────────────
// Stores bounded, redacted Ghidra tool results as content-addressed workarea
// evidence while leaving the authoritative project in its host-owned store.
// → cyberful/src/subsystem/gateway/server.ts — records successful upstream calls.
// @docs/runtimes/ghidra.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash } from "node:crypto"
import { lstat, readFile } from "node:fs/promises"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { replaceWorkareaFile } from "@/workarea"

const INDEX_PATH = "raw/ghidra/index.json"
const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_RECORDS = 10_000
const MAX_OBJECT_BYTES = 512 * 1024

interface EvidenceIndex {
  readonly version: 1
  readonly records: readonly EvidenceRecord[]
}

interface EvidenceRecord {
  readonly sha256: string
  readonly path: string
  readonly tool: string
  readonly phase: string
  readonly is_error: boolean
  readonly recorded_at: string
}

async function readIndex(workarea: string): Promise<EvidenceIndex> {
  const filename = path.join(workarea, INDEX_PATH)
  const metadata = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!metadata) return { version: 1, records: [] }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_INDEX_BYTES)
    throw new Error("Ghidra evidence index is unsafe")
  const parsed: unknown = JSON.parse(await readFile(filename, "utf8"))
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("records" in parsed) ||
    !Array.isArray(parsed.records) ||
    parsed.records.length > MAX_RECORDS
  )
    throw new Error("Ghidra evidence index is malformed")
  return parsed as EvidenceIndex
}

// ── One Recorder Serializes The Workarea Index ──────────────────
// MCP calls may complete concurrently even though PyGhidra serializes Java work.
// Each result object is independently content-addressed, but the shared index is
// a read-modify-replace boundary. A gateway-owned promise tail orders those
// replacements without a process-global lock and close waits for the final write,
// preventing phase teardown from dropping an acknowledged evidence record.
// ─────────────────────────────────────────────────────────────────
export class GhidraEvidenceRecorder {
  private tail = Promise.resolve()

  constructor(
    private readonly workarea: string,
    private readonly phase: string,
  ) {}

  record(tool: string, argumentsValue: Record<string, unknown>, result: CallToolResult): Promise<EvidenceRecord> {
    const task = this.tail.then(async () => {
      const payload = {
        version: 1,
        tool,
        phase: this.phase,
        arguments: argumentsValue,
        result,
      }
      const encoded = `${JSON.stringify(payload, null, 2)}\n`
      if (Buffer.byteLength(encoded) > MAX_OBJECT_BYTES)
        throw new Error("Ghidra evidence object exceeds the 512 KiB workarea limit")
      const sha256 = createHash("sha256").update(encoded).digest("hex")
      const objectPath = `raw/ghidra/objects/${sha256}.json`
      await replaceWorkareaFile(this.workarea, objectPath, encoded)
      const index = await readIndex(this.workarea)
      const existing = index.records.find((record) => record.sha256 === sha256)
      if (existing) return existing
      if (index.records.length >= MAX_RECORDS)
        throw new Error(`Ghidra evidence index supports at most ${MAX_RECORDS} records`)
      const record: EvidenceRecord = {
        sha256,
        path: objectPath,
        tool,
        phase: this.phase,
        is_error: result.isError === true,
        recorded_at: new Date().toISOString(),
      }
      await replaceWorkareaFile(
        this.workarea,
        INDEX_PATH,
        `${JSON.stringify({ version: 1, records: [...index.records, record] }, null, 2)}\n`,
      )
      return record
    })
    this.tail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async close() {
    await this.tail
  }
}
