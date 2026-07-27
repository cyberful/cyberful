// ── Agent Subsystem Runtime Contract ─────────────────────────────
// Defines provider-neutral phase owners and complete root, delegated, and
// fallback AgentRuns without exposing a provider's native conversation API.
// → cyberful/src/subsystem/pi-agent.ts — implements the contract with Pi.
// ─────────────────────────────────────────────────────────────────

import type { AgentTool } from "@earendil-works/pi-agent-core"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { Settings } from "@/config/settings"
import type { PromptSkill } from "./prompt-compiler"
import type { CompiledAgentPrompt, ProviderRoute } from "./prompt-compiler"
import type { Failure } from "./pi-security"
import type { PhaseActivity, SubsystemMcpServer } from "./subsystem"

export type AgentRunID = string
export type AgentRunRole = "root" | "subagent" | "fallback"
export type ProviderAffinity = "primary" | "fallback"
export type AgentRunTermination = "completed" | "budget_exhausted" | "cancelled" | "provider_failed" | "failed"

export interface SubsystemStatus {
  /** The mandatory primary route can start an AgentRun. */
  readonly ready: boolean
  /** Optional configured capacity is unavailable while the primary remains ready. */
  readonly degraded: boolean
  readonly subsystem: "pi"
  readonly providers: ReadonlyArray<{
    readonly id: string
    readonly model: string
    readonly route: ProviderRoute
    readonly authenticated: boolean
    readonly authSource?: string
  }>
  readonly errors: readonly string[]
}

export interface AgentRunBudget {
  readonly deadlineAt: number
  readonly maxOutputTokens?: number
  readonly pause?: {
    readonly subscribe: (listener: (snapshot: { readonly pending: boolean }) => void) => () => void
  }
}

export interface DelegationLimits {
  readonly enabled: boolean
  readonly maxPerRun: number
  readonly maxConcurrent: number
  readonly maxDepth: number
}

export interface FallbackPolicy {
  readonly providerConfigured: boolean
  readonly proactiveEnabled: boolean
  readonly proactivePercentage: number
  readonly automaticSecurityBlockEnabled: boolean
}

export interface TranscriptPolicy {
  readonly enabled: boolean
  readonly includeSystemMessage: false
  readonly redactCredentials: true
}

export interface AgentTaskCapsule {
  readonly objective: string
  readonly expectedResult?: string
  readonly context?: string
  readonly artifacts?: readonly string[]
}

export interface ChildPromptInput {
  readonly role: Exclude<AgentRunRole, "root">
  readonly providerRoute: ProviderRoute
  readonly task: AgentTaskCapsule
}

export interface AgentRunSpec {
  readonly id?: AgentRunID
  readonly sessionID: string
  readonly role: AgentRunRole
  readonly parentID?: AgentRunID
  readonly phaseRootID?: AgentRunID
  readonly depth: number
  readonly provider: string
  readonly model: Model<Api>
  readonly providerAffinity: ProviderAffinity
  readonly prompt: CompiledAgentPrompt
  readonly compileChildPrompt: (input: ChildPromptInput) => CompiledAgentPrompt
  readonly task: AgentTaskCapsule
  readonly workarea: string
  readonly gateway?: SubsystemMcpServer
  readonly tools: readonly AgentTool[]
  readonly gatewayTools?: (run: {
    readonly role: AgentRunRole
    readonly handoffOwner: boolean
    readonly providerAffinity: ProviderAffinity
  }) => readonly AgentTool[]
  readonly skills: readonly PromptSkill[]
  readonly budget: AgentRunBudget
  readonly abort?: AbortSignal
  readonly delegation: DelegationLimits
  readonly handoffOwner: boolean
  readonly transcript: TranscriptPolicy
  readonly fallback: FallbackPolicy
}

export type AgentEvent =
  | {
      readonly type: "run_started"
      readonly runID: AgentRunID
      readonly parentID?: AgentRunID
      readonly phaseRootID: AgentRunID
      readonly role: AgentRunRole
      readonly provider: string
      readonly model: string
      readonly providerAffinity: ProviderAffinity
      readonly promptSystemSha256: string
      readonly promptManifest: CompiledAgentPrompt["manifest"]
    }
  | {
      readonly type: "activity"
      readonly runID: AgentRunID
      readonly activity: PhaseActivity
    }
  | {
      readonly type: "fallback"
      readonly runID: AgentRunID
      readonly fallbackRunID?: AgentRunID
      readonly mode: "proactive" | "automatic"
      readonly state: "requested" | "approved" | "denied" | "completed" | "failed"
      readonly quotaExempt: boolean
      readonly reason?: string
      readonly quota?: {
        readonly primaryActorRuns: number
        readonly admitted: number
        readonly limit: number
      }
      readonly subtreeSize?: number
    }
  | {
      readonly type: "run_finished"
      readonly runID: AgentRunID
      readonly termination: AgentRunTermination
      readonly failure?: Failure
      readonly usage: AgentRunUsage
      readonly skillsUsed: readonly string[]
      readonly childRunIDs: readonly AgentRunID[]
      readonly fallbackAdmissions: number
      readonly fallbackDescendants: number
      readonly toolCalls: number
    }

export interface AgentRunUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface AgentRunResult {
  readonly id: AgentRunID
  readonly parentID?: AgentRunID
  readonly phaseRootID: AgentRunID
  readonly role: AgentRunRole
  readonly provider: string
  readonly model: string
  readonly providerAffinity: ProviderAffinity
  readonly output: string
  readonly termination: AgentRunTermination
  readonly failure?: Failure
  readonly usage: AgentRunUsage
  readonly promptManifest: CompiledAgentPrompt["manifest"]
  readonly childRunIDs: readonly AgentRunID[]
  readonly skillsUsed: readonly string[]
  readonly toolCalls: number
  readonly fallbackAdmissions: number
  readonly fallbackDescendants: number
}

export interface AgentRun {
  readonly id: AgentRunID
  readonly events: AsyncIterable<AgentEvent>
  steer(message: { readonly content: string }): Promise<boolean>
  cancel(reason: string): Promise<void>
  readonly result: Promise<AgentRunResult>
}

export interface AgentSubsystem {
  readonly id: "pi"
  preflight(settings: Settings.Info): Promise<SubsystemStatus>
  start(spec: AgentRunSpec): Promise<AgentRun>
  shutdown(): Promise<void>
}

export * as AgentSubsystemContract from "./agent-subsystem"
