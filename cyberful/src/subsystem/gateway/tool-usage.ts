// ── Local Gateway Tool Usage Ledger ──────────────────────────────
// Writes metadata-only gateway decisions and calls to private shards, then
// atomically rebuilds one engagement-local CSV without request or response content.
// → cyberful/src/subsystem/gateway/server.ts — records gateway decisions and outcomes.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"

const COLUMNS = [
  "time_iso",
  "phase",
  "agent",
  "event_type",
  "tool",
  "capability_status",
  "decision",
  "reason_code",
  "mode",
  "duration_ms",
  "outcome",
  "estimated_requests",
  "observed_requests",
  "peak_rps",
  "bytes_out",
  "marker_attested",
  "egress_blocked",
  "lead_count",
  "suspected_count",
  "confirmed_count",
  "error_class",
] as const

export interface ToolUsageEvent {
  event_type: "decision" | "call"
  tool: string
  capability_status?: "available" | "missing" | "degraded" | "unknown"
  decision?: "USE" | "SKIP" | "BLOCKED"
  reason_code?: string
  mode?: "offline" | "passive" | "active" | "unknown"
  duration_ms?: number
  outcome?: "ok" | "error" | "blocked"
  estimated_requests?: number
  observed_requests?: number
  peak_rps?: number
  bytes_out?: number
  marker_attested?: boolean
  egress_blocked?: boolean
  lead_count?: number
  suspected_count?: number
  confirmed_count?: number
  error_class?: string
}

function csv(value: unknown) {
  if (value === undefined || value === null) return ""
  const rendered = String(value)
  return /[",\r\n]/.test(rendered) ? `"${rendered.replaceAll('"', '""')}"` : rendered
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-") || "unknown"
}

export class ToolUsageRecorder {
  private readonly root = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  private readonly phase = process.env.CYBERFUL_SUBSYSTEM_PHASE?.trim() || "unknown"
  private readonly agent = process.env.CYBERFUL_SUBSYSTEM_LABEL?.trim() || this.phase
  private readonly directory = this.root ? path.join(this.root, "raw", "operations", "tool-usage") : undefined
  private readonly shard = this.directory
    ? path.join(this.directory, `${safeName(this.phase)}-${safeName(this.agent)}-${process.pid}.csv`)
    : undefined
  private queue: Promise<void> = Promise.resolve()
  private readonly failures: unknown[] = []

  constructor() {
    if (this.root && !path.isAbsolute(this.root))
      throw new Error("CYBERFUL_SUBSYSTEM_WORKAREA_ROOT must be an absolute path")
  }

  record(event: ToolUsageEvent) {
    if (!this.root || !this.directory || !this.shard) return Promise.resolve()
    const directory = this.directory
    const shard = this.shard
    const task = this.queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(shard, COLUMNS.join(",") + "\n", { flag: "wx", mode: 0o600 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
        },
      )
      const row: Record<string, unknown> = {
        time_iso: new Date().toISOString(),
        phase: this.phase,
        agent: this.agent,
        ...event,
      }
      await appendFile(shard, COLUMNS.map((column) => csv(row[column])).join(",") + "\n")
      await this.merge()
    })
    // Keep the queue usable after one failed write while retaining that failure for both the caller and
    // close(). A later event must not erase evidence that the audit trail was incomplete.
    this.queue = task.catch((error) => {
      this.failures.push(error)
    })
    return task
  }

  async close() {
    if (!this.root) return Promise.resolve()
    await this.queue
    try {
      await this.merge()
    } catch (error) {
      this.failures.push(error)
    }
    const failures = this.failures.splice(0)
    if (failures.length > 0) throw new AggregateError(failures, "tool usage audit could not be finalized")
  }

  private async merge() {
    if (!this.root || !this.directory) return
    const directory = this.directory
    const shards = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    // A gateway that made no auditable decisions never creates a shard directory; closing that idle
    // recorder has nothing to merge and is distinct from losing a directory after records were queued.
    if (!shards) return
    const rows = (
      await Promise.all(
        shards
          .filter((name) => name.endsWith(".csv"))
          .toSorted()
          .map((name) =>
            readFile(path.join(directory, name), "utf8").then((content) =>
              content.split(/\r?\n/).slice(1).filter(Boolean),
            ),
          ),
      )
    )
      .flat()
      .toSorted()
    const target = path.join(this.root, "raw", "operations", "tool-usage.csv")
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    let writeFailure: unknown
    try {
      await writeFile(temporary, [COLUMNS.join(","), ...rows, ""].join("\n"), { flag: "wx", mode: 0o600 })
      await rename(temporary, target)
    } catch (error) {
      writeFailure = error
    }
    try {
      await rm(temporary, { force: true })
    } catch (cleanupError) {
      if (writeFailure)
        throw new AggregateError([writeFailure, cleanupError], "tool usage merge and temporary-file cleanup failed")
      throw cleanupError
    }
    if (writeFailure) throw writeFailure
  }
}
