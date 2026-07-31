// ── Phase Analysis And Tool Opportunity Ledger ──────────────────
// Persists model-authored test intentions beside host-observed tool facts so
//   handoff can reject abandoned analysis without inventing coverage quotas.
// An unresolved scope decision is accepted only for one concrete action/asset
// pair after authoritative sources and a resolution attempt are recorded.
// → cyberful/src/subsystem/gateway/server.ts — exposes and enforces the ledger.
// @docs/concepts/execution-model.md
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { isRecord } from "@/util/record"

const OUTCOMES = ["confirmed", "suspected", "disproved", "inconclusive", "untestable", "unresolved"] as const
const OMISSION_REASONS = [
  "not_discovered",
  "not_loaded",
  "selection_error",
  "tool_failure",
  "timeout",
  "policy_scope",
  "contention",
  "budget",
  "duplicate_capability",
  "not_needed",
] as const

type Outcome = (typeof OUTCOMES)[number]
type OmissionReason = (typeof OMISSION_REASONS)[number]

interface RegisteredEntry {
  readonly version: 1
  readonly type: "registered"
  readonly time_iso: string
  readonly phase: string
  readonly id: string
  readonly objective: string
  readonly discriminator: string
  readonly surface: string
  readonly candidate_tools: readonly string[]
}

interface ResolvedEntry {
  readonly version: 1
  readonly type: "resolved"
  readonly time_iso: string
  readonly phase: string
  readonly id: string
  readonly outcome: Outcome
  readonly evidence: readonly string[]
  readonly blocker?: string
  readonly omitted_tools: ReadonlyArray<{ readonly tool: string; readonly reason: OmissionReason }>
  readonly unresolved?: {
    readonly exact_action: string
    readonly asset: string
    readonly required_rule: string
    readonly sources_checked: readonly string[]
    readonly ambiguity: string
    readonly resolution_attempt: string
    readonly next_step: string
  }
}

interface ReconciledEntry {
  readonly version: 1
  readonly type: "reconciled"
  readonly time_iso: string
  readonly phase: string
  readonly open_ids: readonly string[]
}

interface ToolEntry {
  readonly version: 1
  readonly type: "tool"
  readonly time_iso: string
  readonly phase: string
  readonly tool: string
  readonly state: "authorized" | "called"
  readonly outcome?: "ok" | "error" | "blocked"
}

type Entry = RegisteredEntry | ResolvedEntry | ReconciledEntry | ToolEntry

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim().replace(/\s+/g, " ")
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (normalized.length > maximum) throw new Error(`${label} must contain at most ${maximum} characters`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} must not contain control characters`)
  return normalized
}

function identifier(value: unknown): string {
  const id = boundedText(value, "analysis id", 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id))
    throw new Error("analysis id must use letters, numbers, dot, colon, underscore, or dash")
  return id
}

function textArray(value: unknown, label: string, maximumItems: number, required = false): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems)
    throw new Error(`${label} must be an array of at most ${maximumItems} strings`)
  const items = value.map((item, index) => boundedText(item, `${label}[${index}]`, 500))
  if (required && items.length === 0) throw new Error(`${label} must not be empty`)
  return items
}

function parseEntry(value: unknown): Entry | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") return
  if (typeof value.time_iso !== "string" || typeof value.phase !== "string") return
  if (value.type === "registered" && typeof value.id === "string") return value as unknown as RegisteredEntry
  if (value.type === "resolved" && typeof value.id === "string") return value as unknown as ResolvedEntry
  if (value.type === "reconciled" && Array.isArray(value.open_ids)) return value as unknown as ReconciledEntry
  if (value.type === "tool" && typeof value.tool === "string") return value as unknown as ToolEntry
}

function unresolvedEvidence(value: unknown): ResolvedEntry["unresolved"] {
  if (!isRecord(value)) throw new Error("unresolved outcome requires unresolved evidence")
  return {
    exact_action: boundedText(value.exact_action, "unresolved exact_action", 500),
    asset: boundedText(value.asset, "unresolved asset", 500),
    required_rule: boundedText(value.required_rule, "unresolved required_rule", 500),
    sources_checked: textArray(value.sources_checked, "unresolved sources_checked", 20, true),
    ambiguity: boundedText(value.ambiguity, "unresolved ambiguity", 1_000),
    resolution_attempt: boundedText(value.resolution_attempt, "unresolved resolution_attempt", 1_000),
    next_step: boundedText(value.next_step, "unresolved next_step", 1_000),
  }
}

export class AnalysisLedger {
  readonly #phase: string
  readonly #file: string
  #queue: Promise<void> = Promise.resolve()

  constructor(workareaRoot: string, phase: string) {
    if (!path.isAbsolute(workareaRoot)) throw new Error("analysis ledger requires an absolute workarea root")
    this.#phase = boundedText(phase, "analysis phase", 80)
    this.#file = path.join(workareaRoot, "raw", "operations", "execution-ledger", `${phase}.jsonl`)
  }

  async handle(args: Record<string, unknown>) {
    if (args.action === "status") return this.status()
    if (args.action === "reconcile") {
      const status = await this.status()
      if (status.open_ids.length > 0)
        throw new Error(`analysis reconciliation has open entries: ${status.open_ids.join(", ")}`)
      await this.#append({ version: 1, type: "reconciled", time_iso: new Date().toISOString(), phase: this.#phase, open_ids: [] })
      return { ok: true, ...status }
    }
    if (args.action === "register") {
      const entry: RegisteredEntry = {
        version: 1,
        type: "registered",
        time_iso: new Date().toISOString(),
        phase: this.#phase,
        id: identifier(args.id),
        objective: boundedText(args.objective, "analysis objective", 1_000),
        discriminator: boundedText(args.discriminator, "analysis discriminator", 1_000),
        surface: boundedText(args.surface, "analysis surface", 500),
        candidate_tools: textArray(args.candidate_tools, "analysis candidate_tools", 30),
      }
      const entries = await this.#entries()
      if (entries.some((item) => item.type === "registered" && item.id === entry.id))
        throw new Error(`analysis entry '${entry.id}' already exists`)
      await this.#append(entry)
      return { ok: true, id: entry.id }
    }
    if (args.action === "resolve") {
      const id = identifier(args.id)
      const entries = await this.#entries()
      if (!entries.some((item) => item.type === "registered" && item.id === id))
        throw new Error(`analysis entry '${id}' is not registered`)
      if (entries.some((item) => item.type === "resolved" && item.id === id))
        throw new Error(`analysis entry '${id}' is already resolved`)
      if (!OUTCOMES.includes(args.outcome as Outcome)) throw new Error("analysis outcome is invalid")
      const omissions = Array.isArray(args.omitted_tools) ? args.omitted_tools : []
      const omittedTools = omissions.map((item, index) => {
        if (!isRecord(item)) throw new Error(`omitted_tools[${index}] must be an object`)
        const reason = boundedText(item.reason, `omitted_tools[${index}].reason`, 80)
        if (!OMISSION_REASONS.includes(reason as OmissionReason))
          throw new Error(`omitted_tools[${index}].reason is invalid`)
        return {
          tool: boundedText(item.tool, `omitted_tools[${index}].tool`, 160),
          reason: reason as OmissionReason,
        }
      })
      const outcome = args.outcome as Outcome
      const entry: ResolvedEntry = {
        version: 1,
        type: "resolved",
        time_iso: new Date().toISOString(),
        phase: this.#phase,
        id,
        outcome,
        evidence: textArray(args.evidence, "analysis evidence", 50, outcome !== "untestable" && outcome !== "unresolved"),
        ...(args.blocker === undefined ? {} : { blocker: boundedText(args.blocker, "analysis blocker", 1_000) }),
        omitted_tools: omittedTools,
        ...(outcome === "unresolved" ? { unresolved: unresolvedEvidence(args.unresolved) } : {}),
      }
      if ((outcome === "untestable" || outcome === "unresolved") && !entry.blocker)
        throw new Error(`${outcome} outcome requires a typed blocker`)
      await this.#append(entry)
      return { ok: true, id, outcome }
    }
    throw new Error("analysis_ledger action must be register, resolve, status, or reconcile")
  }

  async recordAuthorized(tools: readonly string[]) {
    const existing = new Set(
      (await this.#entries())
        .filter((entry): entry is ToolEntry => entry.type === "tool" && entry.state === "authorized")
        .map((entry) => entry.tool),
    )
    await this.#appendMany(
      [...new Set(tools)]
        .filter((tool) => !existing.has(tool))
        .map((tool): ToolEntry => ({
          version: 1,
          type: "tool",
          time_iso: new Date().toISOString(),
          phase: this.#phase,
          tool,
          state: "authorized",
        })),
    )
  }

  recordTool(tool: string, outcome?: "ok" | "error" | "blocked") {
    return this.#append({
      version: 1,
      type: "tool",
      time_iso: new Date().toISOString(),
      phase: this.#phase,
      tool: boundedText(tool, "tool name", 160),
      state: "called",
      ...(outcome ? { outcome } : {}),
    })
  }

  async status() {
    await this.#queue
    const entries = await this.#entries()
    const registered = entries.filter((entry): entry is RegisteredEntry => entry.type === "registered")
    const resolved = new Set(entries.filter((entry): entry is ResolvedEntry => entry.type === "resolved").map((entry) => entry.id))
    const open = registered.filter((entry) => !resolved.has(entry.id)).map((entry) => entry.id)
    const authorized = new Set(entries.filter((entry): entry is ToolEntry => entry.type === "tool" && entry.state === "authorized").map((entry) => entry.tool))
    const called = new Set(entries.filter((entry): entry is ToolEntry => entry.type === "tool" && entry.state === "called").map((entry) => entry.tool))
    const lastAnalysis = entries.findLastIndex((entry) => entry.type === "registered" || entry.type === "resolved")
    const lastReconciliation = entries.findLastIndex((entry) => entry.type === "reconciled")
    return {
      phase: this.#phase,
      registered: registered.length,
      resolved: resolved.size,
      open_ids: open,
      authorized_tools: [...authorized].toSorted(),
      called_tools: [...called].toSorted(),
      authorized_not_called: [...authorized].filter((tool) => !called.has(tool)).toSorted(),
      reconciled: lastReconciliation >= lastAnalysis && lastReconciliation >= 0,
    }
  }

  async handoffError() {
    const status = await this.status()
    if (status.open_ids.length > 0) return `analysis ledger has unresolved entries: ${status.open_ids.join(", ")}`
    if (status.registered > 0 && !status.reconciled)
      return "analysis ledger requires reconcile after all registered entries are resolved"
  }

  close() {
    return this.#queue
  }

  async #entries(): Promise<Entry[]> {
    const content = await readFile(this.#file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = parseEntry(JSON.parse(line))
          return entry ? [entry] : []
        } catch (error) {
          if (error instanceof SyntaxError) return []
          throw error
        }
      })
  }

  #append(entry: Entry) {
    return this.#appendMany([entry])
  }

  #appendMany(entries: readonly Entry[]) {
    if (entries.length === 0) return Promise.resolve()
    const pending = this.#queue.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 })
      await appendFile(this.#file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 })
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }
}

export const ANALYSIS_LEDGER_TOOL_DEF = {
  name: "analysis_ledger",
  description:
    "Register and reconcile concrete test hypotheses, discriminators, evidence, blockers, scope uncertainty, and reasons for omitting relevant tools. UNRESOLVED is valid only for one exact action and asset after an evidenced resolution attempt.",
  inputSchema: {
    type: "object" as const,
    additionalProperties: true,
    properties: {
      action: { type: "string", enum: ["register", "resolve", "status", "reconcile"] },
      id: { type: "string" },
      objective: { type: "string" },
      discriminator: { type: "string" },
      surface: { type: "string" },
      candidate_tools: { type: "array", items: { type: "string" } },
      outcome: { type: "string", enum: OUTCOMES },
      evidence: { type: "array", items: { type: "string" } },
      blocker: { type: "string" },
      omitted_tools: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: { tool: { type: "string" }, reason: { type: "string", enum: OMISSION_REASONS } },
          required: ["tool", "reason"],
        },
      },
      unresolved: {
        type: "object",
        additionalProperties: false,
        properties: {
          exact_action: { type: "string" },
          asset: { type: "string" },
          required_rule: { type: "string" },
          sources_checked: { type: "array", items: { type: "string" } },
          ambiguity: { type: "string" },
          resolution_attempt: { type: "string" },
          next_step: { type: "string" },
        },
      },
    },
    required: ["action"],
  },
}

export * as GatewayAnalysisLedger from "./analysis-ledger"
