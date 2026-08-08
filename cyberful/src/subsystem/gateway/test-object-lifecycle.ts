// ── Test Object Lifecycle Ledger ────────────────────────────────
// Persists host-validated state transitions for synthetic records created while
// testing, so cleanup and deliberate residue remain visible across phase handoffs.
// → cyberful/src/subsystem/gateway/server.ts — exposes the ledger as a phase tool.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises"
import { isRecord } from "@/util/record"

export const STATES = [
  "planned",
  "not_created",
  "created",
  "oracle_checked",
  "cleanup_attempted",
  "cleaned",
  "residual",
] as const
export type State = (typeof STATES)[number]

interface Entry {
  readonly version: 1
  readonly time_iso: string
  readonly phase: string
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly state: State
  readonly evidence_path?: string
  readonly note?: string
  readonly residual_reason?: string
  readonly actor_run_id?: string
  readonly actor_display_name?: string
  readonly actor_role?: "root" | "subagent" | "fallback"
}

export interface Snapshot {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly state: State
  readonly phase: string
  readonly evidencePath?: string
  readonly note?: string
  readonly residualReason?: string
  readonly actorRunID?: string
  readonly actorDisplayName?: string
  readonly actorRole?: "root" | "subagent" | "fallback"
  readonly evidenceExists?: boolean
}

interface HostActor {
  readonly runID: string
  readonly displayName: string
  readonly kind: "root" | "subagent" | "fallback"
}

const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  planned: ["not_created", "created"],
  not_created: [],
  created: ["oracle_checked", "cleanup_attempted", "residual"],
  oracle_checked: ["cleanup_attempted", "residual"],
  cleanup_attempted: ["cleaned", "residual"],
  cleaned: [],
  residual: [],
}

const TERMINAL = new Set<State>(["not_created", "cleaned", "residual"])

function isState(value: unknown): value is State {
  return typeof value === "string" && STATES.some((state) => state === value)
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (normalized.length > maximum) throw new Error(`${label} must contain at most ${maximum} characters`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} must not contain control characters`)
  return normalized
}

function objectID(value: unknown): string {
  const id = boundedText(value, "test_object id", 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id))
    throw new Error("test_object id must use letters, numbers, dot, colon, underscore, or dash")
  return id
}

function relativeEvidencePath(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const candidate = boundedText(value, "test_object evidence_path", 1_024).replaceAll("\\", "/")
  if (path.posix.isAbsolute(candidate) || candidate.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("test_object evidence_path must be a safe workarea-relative path")
  return candidate
}

function hostActor(value: unknown): HostActor | undefined {
  if (!isRecord(value)) return
  if (
    typeof value.runID !== "string" ||
    typeof value.displayName !== "string" ||
    (value.kind !== "root" && value.kind !== "subagent" && value.kind !== "fallback")
  )
    return
  return {
    runID: boundedText(value.runID, "test_object actor runID", 256),
    displayName: boundedText(value.displayName, "test_object actor display name", 160),
    kind: value.kind,
  }
}

function parseEntry(value: unknown): Entry | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  if (
    typeof value.time_iso !== "string" ||
    typeof value.phase !== "string" ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.label !== "string" ||
    !isState(value.state)
  )
    return undefined
  return {
    version: 1,
    time_iso: value.time_iso,
    phase: value.phase,
    id: value.id,
    kind: value.kind,
    label: value.label,
    state: value.state,
    ...(typeof value.evidence_path === "string" ? { evidence_path: value.evidence_path } : {}),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
    ...(typeof value.residual_reason === "string" ? { residual_reason: value.residual_reason } : {}),
    ...(typeof value.actor_run_id === "string" ? { actor_run_id: value.actor_run_id } : {}),
    ...(typeof value.actor_display_name === "string" ? { actor_display_name: value.actor_display_name } : {}),
    ...(value.actor_role === "root" || value.actor_role === "subagent" || value.actor_role === "fallback"
      ? { actor_role: value.actor_role }
      : {}),
  }
}

function snapshot(entry: Entry): Snapshot {
  return {
    id: entry.id,
    kind: entry.kind,
    label: entry.label,
    state: entry.state,
    phase: entry.phase,
    ...(entry.evidence_path ? { evidencePath: entry.evidence_path } : {}),
    ...(entry.note ? { note: entry.note } : {}),
    ...(entry.residual_reason ? { residualReason: entry.residual_reason } : {}),
    ...(entry.actor_run_id ? { actorRunID: entry.actor_run_id } : {}),
    ...(entry.actor_display_name ? { actorDisplayName: entry.actor_display_name } : {}),
    ...(entry.actor_role ? { actorRole: entry.actor_role } : {}),
  }
}

// ── Cleanup State Cannot Be Skipped Or Reopened ─────────────────
// The first record establishes intent before target state exists. Later records
// follow only observable lifecycle edges; cleaned and residual are terminal so a
// phase cannot erase residue by relabelling an object. Handoff checks the latest
// entry for every object and rejects only forgotten lifecycle work, never the
// target operation itself or a deliberately recorded residual object.
// ─────────────────────────────────────────────────────────────────
export class TestObjectLifecycleLedger {
  readonly #workareaRoot: string
  readonly #file: string
  readonly #phase: string
  #queue: Promise<void> = Promise.resolve()

  constructor(workareaRoot: string, phase: string) {
    if (!path.isAbsolute(workareaRoot)) throw new Error("test object ledger requires an absolute workarea root")
    this.#workareaRoot = workareaRoot
    this.#file = path.join(workareaRoot, "raw", "operations", "test-object-lifecycle.jsonl")
    this.#phase = boundedText(phase, "test object phase", 80)
  }

  async transition(args: Record<string, unknown>): Promise<Snapshot> {
    const pending = this.#queue.then(async () => {
      const id = objectID(args.id)
      if (!isState(args.state))
        throw new Error(`test_object state must be one of ${STATES.join(", ")}`)
      const state = args.state
      const current = (await this.list()).find((item) => item.id === id)
      if (!current && state !== "planned") throw new Error(`test_object '${id}' must begin in planned state`)
      if (current && !TRANSITIONS[current.state].includes(state))
        throw new Error(`test_object '${id}' cannot transition from ${current.state} to ${state}`)
      const kind = current?.kind ?? boundedText(args.kind, "test_object kind", 80)
      const label = current?.label ?? boundedText(args.label, "test_object label", 160)
      if (current && args.kind !== undefined && boundedText(args.kind, "test_object kind", 80) !== current.kind)
        throw new Error(`test_object '${id}' kind cannot change after planning`)
      if (current && args.label !== undefined && boundedText(args.label, "test_object label", 160) !== current.label)
        throw new Error(`test_object '${id}' label cannot change after planning`)
      const residualReason =
        state === "residual" ? boundedText(args.residual_reason, "test_object residual_reason", 2_000) : undefined
      const evidencePath = relativeEvidencePath(args.evidence_path) ?? current?.evidencePath
      const actor = hostActor(args._cyberful_actor) ??
        (current?.actorRunID && current.actorDisplayName && current.actorRole
          ? { runID: current.actorRunID, displayName: current.actorDisplayName, kind: current.actorRole }
          : undefined)
      const entry: Entry = {
        version: 1,
        time_iso: new Date().toISOString(),
        phase: this.#phase,
        id,
        kind,
        label,
        state,
        ...(evidencePath ? { evidence_path: evidencePath } : {}),
        ...(args.note === undefined ? {} : { note: boundedText(args.note, "test_object note", 2_000) }),
        ...(residualReason ? { residual_reason: residualReason } : {}),
        ...(actor
          ? {
              actor_run_id: actor.runID,
              actor_display_name: actor.displayName,
              actor_role: actor.kind,
            }
          : {}),
      }
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
      await writeFile(this.#file, "", { flag: "a", mode: 0o600 })
      await appendFile(this.#file, `${JSON.stringify(entry)}\n`)
      return snapshot(entry)
    })
    this.#queue = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  async list(): Promise<readonly Snapshot[]> {
    const content = await readFile(this.#file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    const latest = new Map<string, Entry>()
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error("test object lifecycle ledger contains invalid JSON", { cause: error })
        throw error
      }
      const entry = parseEntry(parsed)
      if (!entry) throw new Error("test object lifecycle ledger contains an invalid entry")
      latest.set(entry.id, entry)
    }
    return Promise.all(
      [...latest.values()].map(async (entry) => {
        const item = snapshot(entry)
        return item.evidencePath
          ? { ...item, evidenceExists: await this.#evidenceExists(item.evidencePath) }
          : item
      }),
    ).then((items) => items.toSorted((left, right) => left.id.localeCompare(right.id)))
  }

  async recover(fromRunID: unknown): Promise<readonly Snapshot[]> {
    const runID = boundedText(fromRunID, "test_object recovery runID", 256)
    return (await this.list()).filter((item) => item.actorRunID === runID)
  }

  async handoffError(): Promise<string | undefined> {
    const objects = await this.list()
    const open = objects.filter((item) => !TERMINAL.has(item.state))
    if (open.length > 0)
      return `test object lifecycle is incomplete for: ${open.map((item) => `${item.id} (${item.state})`).join(", ")}`
    const missingEvidence = objects.filter((item) => item.evidencePath && item.evidenceExists === false)
    return missingEvidence.length > 0
      ? `test object lifecycle references missing evidence: ${missingEvidence
          .map((item) => `${item.id} (${item.evidencePath})`)
          .join(", ")}`
      : undefined
  }

  async #evidenceExists(relativePath: string): Promise<boolean> {
    let current = this.#workareaRoot
    const segments = relativePath.split("/")
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment)
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (!info || info.isSymbolicLink()) return false
      if (index < segments.length - 1 && !info.isDirectory()) return false
      if (index === segments.length - 1) return info.isFile()
    }
    return false
  }
}

export const TEST_OBJECT_TOOL_DEF = {
  name: "test_object",
  description:
    "Record or inspect every synthetic target object: planned → not_created, or planned → created → oracle_checked/cleanup_attempted → cleaned/residual. Record residual explicitly when the product offers no cleanup. Handoff refuses forgotten non-terminal objects.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: ["transition", "list"] },
      id: { type: "string", maxLength: 128 },
      kind: { type: "string", maxLength: 80 },
      label: { type: "string", maxLength: 160 },
      state: { type: "string", enum: STATES },
      evidence_path: { type: "string", maxLength: 1_024 },
      note: { type: "string", maxLength: 2_000 },
      residual_reason: { type: "string", maxLength: 2_000 },
    },
    required: ["action"],
  },
}

export function testObjectLifecycleFromEnvironment(): TestObjectLifecycleLedger | undefined {
  const workarea = process.env.CYBERFUL_SUBSYSTEM_WORKAREA_ROOT?.trim()
  const phase = process.env.CYBERFUL_SUBSYSTEM_PHASE?.trim()
  return workarea && phase ? new TestObjectLifecycleLedger(workarea, phase) : undefined
}

export * as TestObjectLifecycle from "./test-object-lifecycle"
