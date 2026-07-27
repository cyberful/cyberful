// ── Agentic Subsystem Projection ─────────────────────────────────
// Defines gateway descriptors, host dynamic tools, failures, and activity
// events shared by the Pi runtime, phase runner, journal, and live TUI.
// → cyberful/src/subsystem/agent-subsystem.ts — defines complete AgentRuns.
// ─────────────────────────────────────────────────────────────────

import type { ExpertBackend } from "@/dependency/config"
import type { SubsystemUsage } from "./usage"

export type SubsystemPermission = { kind: "readonly" | "workareaEdit" | "autonomous" }

export interface SubsystemMcpServer {
  name: string
  command: string
  args: readonly string[]
  // Registration-safe values only; engagement credentials belong in privateEnv.
  env: Readonly<Record<string, string>>
  privateEnv?: Readonly<Record<string, string>>
}

export interface SubsystemRunSpec {
  cwd: string
  permission: SubsystemPermission
  networkAccess?: boolean
  mcpServer?: SubsystemMcpServer
  markdownArtifacts?: readonly string[]
  stream?: boolean
  env?: Record<string, string>
  dynamicTools?: readonly DynamicToolDefinition[]
}

export interface DynamicToolDefinition {
  readonly type: "function"
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly deferLoading?: boolean
}

export interface DynamicToolResult {
  readonly success: boolean
  readonly text: string
}

export interface DynamicToolContext {
  readonly signal: AbortSignal
}

export interface DynamicTool {
  readonly definition: DynamicToolDefinition
  readonly execute: (input: unknown, context: DynamicToolContext) => Promise<DynamicToolResult>
}

export type SubsystemFailureKind =
  | "security_policy_block"
  | "timeout"
  | "rate_limit"
  | "authentication"
  | "capacity"
  | "network"
  | "unavailable"
  | "malformed_output"
  | "cancelled"
  | "transport"
  | "unknown"

export interface SubsystemFailure {
  readonly kind: SubsystemFailureKind
  readonly providerCode?: string
  readonly retryable: boolean
}

export type PhaseActivityActor = {
  id: string
  label?: string
  parentID?: string
}

export type PhaseActivityActorState = "started" | "active" | "interacted" | "completed" | "interrupted" | "failed"

type PhaseActivityContext = { actor?: PhaseActivityActor }

export type PhaseActivity = PhaseActivityContext &
  (
    | { kind: "text"; text: string }
    | { kind: "tool"; tool: string; input: unknown; callID: string }
    | { kind: "output"; text: string; callID: string }
    | { kind: "progress"; usage: SubsystemUsage.Snapshot }
    | {
        kind: "reasoning"
        itemID: string
        hasSummary: boolean
        hasContent: boolean
        hasDelta: boolean
      }
    | { kind: "agent"; actor: PhaseActivityActor; state: PhaseActivityActorState; transitionID: string }
  )

export interface AgenticSubsystemAdapter {
  readonly name: ExpertBackend
  readonly capabilities: {
    readonly dynamicTools: boolean
  }
  extractResultText(stdout: string): string
  streamActivities(event: unknown): PhaseActivity[]
  classifyFailure(completedRun: unknown): SubsystemFailure | undefined
}

export type Subsystem = AgenticSubsystemAdapter

// ── Actor References Resolve Inside One Subsystem Run ────────────
// A projection owns the readable actor registry for one phase. Later activity
// events may carry only an opaque ID; the projection restores the known label
// and parent without sharing identity state across concurrent phase owners.
// Lifecycle updates for actors never announced by the runtime are discarded.
// ─────────────────────────────────────────────────────────────────
export function createActivityActorProjection() {
  const actors = new Map<string, PhaseActivityActor>()
  return (activity: PhaseActivity): PhaseActivity | undefined => {
    const actor = activity.actor
    if (!actor) return activity
    if (actor.label) {
      const resolved = { ...actors.get(actor.id), ...actor }
      actors.set(actor.id, resolved)
      return { ...activity, actor: resolved }
    }
    const resolved = actors.get(actor.id)
    if (resolved) return { ...activity, actor: resolved }
    return activity.kind === "agent" ? undefined : activity
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

export const pi: Subsystem = {
  name: "pi",
  capabilities: {
    dynamicTools: true,
  },
  extractResultText(stdout) {
    const trimmed = stdout.trim()
    if (!trimmed) return ""
    let last: string | undefined
    let sawJSON = false
    for (const line of trimmed.split("\n")) {
      const event = parseJsonLine(line)
      if (event === undefined) continue
      sawJSON = true
      if (isRecord(event) && event.type === "result" && typeof event.result === "string") last = event.result
    }
    return last ?? (sawJSON ? "" : stdout)
  },
  classifyFailure(event) {
    if (!isRecord(event) || event.type !== "run_finished" || !isRecord(event.failure)) return
    const kind = event.failure.kind
    if (
      kind !== "security_policy_block" &&
      kind !== "timeout" &&
      kind !== "rate_limit" &&
      kind !== "authentication" &&
      kind !== "capacity" &&
      kind !== "network" &&
      kind !== "unavailable" &&
      kind !== "malformed_output" &&
      kind !== "cancelled" &&
      kind !== "unknown"
    )
      return
    return {
      kind,
      ...(typeof event.failure.providerCode === "string" ? { providerCode: event.failure.providerCode } : {}),
      retryable: event.failure.retryable === true,
    }
  },
  streamActivities(event) {
    if (!isRecord(event) || event.type !== "activity" || !isRecord(event.activity)) return []
    return [event.activity as PhaseActivity]
  },
}

export * as Subsystem from "./subsystem"
