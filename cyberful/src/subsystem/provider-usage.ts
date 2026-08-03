// ── Canonical Provider Usage Ledger ──────────────────────────────
// Records one append-only, locally auditable row per provider call and derives
// root/subagent views without trusting presentation counters.
// → cyberful/src/subsystem/pi-agent.ts — records provider completions.
// → cyberful/src/session/provider-usage.ts — exposes the compact TUI view.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { readFile } from "node:fs/promises"
import { appendWorkareaFile } from "@/workarea"
import type { AgentRunRole, AgentRunUsage } from "./agent-subsystem"
import type { Settings } from "@/config/settings"
import { isRecord } from "@/util/record"
import { canonicalTotal } from "./usage"

export const PROVIDER_USAGE_PATH = "raw/operations/provider-usage.jsonl"

export type ProviderCallKind = "generation" | "retry" | "context-summary" | "recovery"
export type ProviderCallStatus = "completed" | "failed" | "cancelled"

export interface ProviderUsageEntry {
  readonly id: string
  readonly timestamp: string
  readonly sessionID: string
  readonly workflow: string
  readonly phase: string
  readonly attempt: number
  readonly runID: string
  readonly parentRunID?: string
  readonly depth: number
  readonly runKind: AgentRunRole
  readonly provider: string
  readonly route: string
  readonly model: string
  readonly reasoningRequested: Settings.ReasoningEffort
  readonly reasoningEffective: string
  readonly callKind: ProviderCallKind
  readonly status: ProviderCallStatus
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly generatedTokens: number
  readonly reasoningTokens: number
  readonly requestInputTokens: number
  readonly canonicalVolume: number
  readonly reportedTotalTokens?: number
  readonly totalDivergence?: number
  readonly telemetryComplete: boolean
}

export interface ProviderUsageTotals {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly generated: number
  readonly reasoning: number
}

export interface ProviderUsageView {
  readonly root: ProviderUsageTotals
  readonly subagents: ProviderUsageTotals
  readonly scopes: readonly {
    readonly runID: string
    readonly parentRunID?: string
    readonly runKind: AgentRunRole
    readonly group: "root" | "subagents"
    readonly totals: ProviderUsageTotals
  }[]
}

type MutableTotals = {
  input: number
  cacheRead: number
  cacheWrite: number
  generated: number
  reasoning: number
}

const emptyTotals = (): MutableTotals => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  generated: 0,
  reasoning: 0,
})

function normalized(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0
}

function entry(value: unknown): ProviderUsageEntry | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.runID !== "string" ||
    typeof value.runKind !== "string"
  )
    return
  return value as unknown as ProviderUsageEntry
}

export class ProviderUsageLedger {
  readonly #workarea: string
  readonly #sessionID: string
  readonly #sequences = new Map<string, number>()
  #queue: Promise<void> = Promise.resolve()

  constructor(input: { readonly workarea: string; readonly sessionID: string }) {
    if (!path.isAbsolute(input.workarea))
      throw new Error("provider usage ledger requires an absolute workarea")
    this.#workarea = input.workarea
    this.#sessionID = input.sessionID
  }

  record(
    input: Omit<
      ProviderUsageEntry,
      | "id"
      | "timestamp"
      | "sessionID"
      | "inputTokens"
      | "cacheReadTokens"
      | "cacheWriteTokens"
      | "generatedTokens"
      | "reasoningTokens"
      | "requestInputTokens"
      | "canonicalVolume"
      | "reportedTotalTokens"
      | "totalDivergence"
      | "telemetryComplete"
    > & {
      readonly usage: AgentRunUsage
      readonly reportedTotalTokens?: number
      readonly telemetryComplete?: boolean
    },
  ) {
    const sequence = (this.#sequences.get(input.runID) ?? 0) + 1
    this.#sequences.set(input.runID, sequence)
    const usage = {
      input: normalized(input.usage.input),
      cacheRead: normalized(input.usage.cacheRead),
      cacheWrite: normalized(input.usage.cacheWrite),
      generated: normalized(input.usage.output),
      reasoning: normalized(input.usage.reasoning),
    }
    const volume = canonicalTotal({
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.generated,
    })
    const reportedTotal =
      input.reportedTotalTokens === undefined ? undefined : normalized(input.reportedTotalTokens)
    const row: ProviderUsageEntry = {
      id: `${input.runID}:${sequence}`,
      timestamp: new Date().toISOString(),
      sessionID: this.#sessionID,
      workflow: input.workflow,
      phase: input.phase,
      attempt: input.attempt,
      runID: input.runID,
      ...(input.parentRunID ? { parentRunID: input.parentRunID } : {}),
      depth: input.depth,
      runKind: input.runKind,
      provider: input.provider,
      route: input.route,
      model: input.model,
      reasoningRequested: input.reasoningRequested,
      reasoningEffective: input.reasoningEffective,
      callKind: input.callKind,
      status: input.status,
      inputTokens: usage.input,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      generatedTokens: usage.generated,
      reasoningTokens: usage.reasoning,
      requestInputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      canonicalVolume: volume,
      ...(reportedTotal === undefined
        ? {}
        : {
            reportedTotalTokens: reportedTotal,
            totalDivergence: reportedTotal - volume,
          }),
      telemetryComplete: input.telemetryComplete ?? true,
    }
    this.#queue = this.#queue.then(() =>
      appendWorkareaFile(this.#workarea, PROVIDER_USAGE_PATH, `${JSON.stringify(row)}\n`, {
        mode: 0o600,
      }).then(() => undefined),
    )
  }

  close() {
    return this.#queue
  }
}

export async function readProviderUsageView(
  workarea: string,
  sessionID?: string,
): Promise<ProviderUsageView> {
  const content = await readFile(path.join(workarea, PROVIDER_USAGE_PATH), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    },
  )
  const rows = new Map<string, ProviderUsageEntry>()
  for (const line of content.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = entry(JSON.parse(line))
      if (parsed && (sessionID === undefined || parsed.sessionID === sessionID))
        rows.set(parsed.id, parsed)
    } catch {
      // Preserve readable valid rows when a final interrupted write is partial.
    }
  }
  const runs = new Map([...rows.values()].map((item) => [item.runID, item]))
  const groups = new Map<string, "root" | "subagents">()
  const groupOf = (item: ProviderUsageEntry, seen = new Set<string>()): "root" | "subagents" => {
    const known = groups.get(item.runID)
    if (known) return known
    if (seen.has(item.runID)) return item.runKind === "root" ? "root" : "subagents"
    seen.add(item.runID)
    const group =
      item.runKind === "root"
        ? "root"
        : item.runKind === "subagent"
          ? "subagents"
          : item.parentRunID && runs.get(item.parentRunID)
            ? groupOf(runs.get(item.parentRunID)!, seen)
            : "root"
    groups.set(item.runID, group)
    return group
  }
  const scopeTotals = new Map<string, MutableTotals>()
  for (const item of rows.values()) {
    const target = scopeTotals.get(item.runID) ?? emptyTotals()
    target.input += normalized(item.inputTokens)
    target.cacheRead += normalized(item.cacheReadTokens)
    target.cacheWrite += normalized(item.cacheWriteTokens)
    target.generated += normalized(item.generatedTokens)
    target.reasoning += normalized(item.reasoningTokens)
    scopeTotals.set(item.runID, target)
  }
  const scopes = [...scopeTotals].map(([runID, totals]) => {
    const item = runs.get(runID)!
    return {
      runID,
      ...(item.parentRunID ? { parentRunID: item.parentRunID } : {}),
      runKind: item.runKind,
      group: groupOf(item),
      totals,
    }
  })
  const view = { root: emptyTotals(), subagents: emptyTotals() }
  for (const scope of scopes) {
    const target = view[scope.group]
    target.input += scope.totals.input
    target.cacheRead += scope.totals.cacheRead
    target.cacheWrite += scope.totals.cacheWrite
    target.generated += scope.totals.generated
    target.reasoning += scope.totals.reasoning
  }
  return { ...view, scopes }
}

export * as SubsystemProviderUsage from "./provider-usage"
