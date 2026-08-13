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
import type { RecoveryCause, RecoveryDenialCode, RecoveryScope } from "./recovery-policy"
import type { ModelContextCapacity } from "./pi-models"
import type { ReasoningPlan } from "./pi-reasoning"
import type { PhaseActivity, SubsystemMcpServer } from "./subsystem"
import type { Controller as PhaseBudgetClock } from "./phase-budget-clock"

export type AgentRunID = string
export type AgentRunRole = "root" | "subagent" | "fallback"
export type ProviderAffinity = "main" | "fallback"
export type AgentRunTermination = "completed" | "budget_exhausted" | "cancelled" | "provider_failed" | "failed"
export type AgentRunCancellationCause =
  | "budget_expired"
  | "parent_closeout"
  | "operator_focus"
  | "phase_shutdown"
  | "user_cancel"
export type AgentRunTerminationCause = AgentRunCancellationCause | Failure["kind"] | "completed" | "runtime_failure"
export type AgentSteeringMode = "queue" | "focus"
export type AgentSteeringState = "accepted" | "queued" | "applied" | "superseded" | "rejected"

export interface AgentSteeringReceipt {
  readonly id: string
  readonly accepted: boolean
  readonly recipients: number
  readonly mode: AgentSteeringMode
  readonly state: AgentSteeringState
  readonly runID?: AgentRunID
  readonly acceptedAt: string
  readonly appliedAt?: string
  readonly reason?: string
}

export interface AgentRunIdentity {
  readonly displayName: string
  readonly emoji: string
}

export interface SubsystemStatus {
  /** The mandatory main route can start an AgentRun. */
  readonly ready: boolean
  /** Optional configured capacity is unavailable while the main route remains ready. */
  readonly degraded: boolean
  readonly subsystem: "pi"
  readonly providers: ReadonlyArray<{
    readonly id: string
    readonly model: string
    readonly route: ProviderRoute
    readonly authenticated: boolean
    readonly context?: ModelContextCapacity
    readonly reasoningEffort?: Settings.ReasoningEffort
    readonly effectiveReasoningEffort?: ReasoningPlan["effective"]
    readonly authSource?: string
  }>
  readonly errors: readonly string[]
}

export interface AgentRunBudget {
  readonly deadlineAt: number
  readonly maxOutputTokens?: number
  readonly clock?: PhaseBudgetClock
  readonly closeoutReserveMs?: number
}

export interface DelegationLimits {
  readonly enabled: boolean
  readonly provider: string
  readonly reasoningEfforts: readonly Settings.ReasoningEffort[]
  readonly defaultReasoningEffort: Settings.ReasoningEffort
  readonly maxPerRun: number
  readonly maxConcurrent: number
  readonly maxDepth: number
  readonly maxRuntimeMs: number
}

export interface FallbackPolicy {
  readonly providerConfigured: boolean
  readonly proactiveEnabled: boolean
  readonly proactivePercentage: number
  readonly automaticSecurityBlockEnabled: boolean
  readonly recoveryBonusMs?: number
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
  readonly outputArtifact?: string
}

export interface RecoveredHypothesis {
  readonly id: string
  readonly nextStep?: string
}

export interface RecoveredTestObject {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly state:
    | "planned"
    | "not_created"
    | "created"
    | "oracle_checked"
    | "cleanup_attempted"
    | "cleaned"
    | "residual"
  readonly phase: string
  readonly evidencePath?: string
  readonly evidenceExists?: boolean
  readonly note?: string
  readonly residualReason?: string
}

export interface AgentRunRecoverySummary {
  readonly capturedAt: string
  readonly termination: "budget_exhausted" | "cancelled"
  readonly narrative?: string
  readonly path?: string
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
  readonly sourceCallID?: string
  readonly recoveryOf?: AgentRunID
  readonly identity?: AgentRunIdentity
  readonly phaseRootID?: AgentRunID
  readonly depth: number
  readonly provider: string
  readonly model: Model<Api>
  readonly context: ModelContextCapacity
  readonly providerAffinity: ProviderAffinity
  readonly reasoning: ReasoningPlan
  readonly reasoningSelection?: "parent" | "default"
  readonly prompt: CompiledAgentPrompt
  readonly compileChildPrompt: (input: ChildPromptInput) => CompiledAgentPrompt
  readonly task: AgentTaskCapsule
  readonly workarea: string
  readonly gateway?: SubsystemMcpServer
  readonly tools: readonly AgentTool[]
  readonly gatewayTools?: (run: {
    readonly id: AgentRunID
    readonly role: AgentRunRole
    readonly parentID?: AgentRunID
    readonly identity?: AgentRunIdentity
    readonly handoffOwner: boolean
    readonly providerAffinity: ProviderAffinity
  }) => readonly AgentTool[]
  readonly recoverHypothesisOwnership?: (input: {
    readonly fromRunID: AgentRunID | "*"
    readonly to: {
      readonly runID: AgentRunID
      readonly displayName: string
      readonly kind: AgentRunRole
    }
    readonly reason: "phase_recovery" | "child_finished"
  }) => Promise<readonly RecoveredHypothesis[]>
  readonly recoverTestObjects?: (input: { readonly fromRunID: AgentRunID }) => Promise<readonly RecoveredTestObject[]>
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
      readonly recoveryOf?: AgentRunID
      readonly phaseRootID: AgentRunID
      readonly role: AgentRunRole
      readonly provider: string
      readonly model: string
      readonly providerAffinity: ProviderAffinity
      readonly identity?: AgentRunIdentity
      readonly reasoningEffort: Settings.ReasoningEffort
      readonly effectiveReasoningEffort: ReasoningPlan["effective"]
      readonly reasoningSelection?: "parent" | "default"
      readonly context: {
        readonly catalogContextWindow: number
        readonly configuredContextWindow?: number
        readonly trustedRouteWindow: number
        readonly configuredOperationalContextWindow?: number
        readonly operationalContextWindow: number
        readonly observedContextUpperBound?: number
        readonly continuationReserveTokens: number
        readonly hardInputTokens: number
        readonly effectiveOperationalWindow: number
        readonly source: ModelContextCapacity["source"] | "observed_upper_bound"
        readonly warnings: readonly string[]
      }
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
        readonly mainActorRuns: number
        readonly admitted: number
        readonly limit: number
      }
      readonly subtreeSize?: number
    }
  | {
      readonly type: "recovery"
      readonly runID: AgentRunID
      readonly recoveryRunID?: AgentRunID
      readonly chainID: string
      readonly scope: RecoveryScope
      readonly cause: RecoveryCause
      readonly state: "requested" | "admitted" | "started" | "completed" | "failed" | "cancelled" | "denied"
      readonly sourceRoute: ProviderAffinity
      readonly destinationRoute?: ProviderAffinity
      readonly quotaExempt: true
      readonly bonusMs: number
      readonly availableRuntimeMs: number
      readonly availableOutputTokens?: number
      readonly deadlineAt?: number
      readonly denialCode?: RecoveryDenialCode
      readonly termination?: AgentRunTermination
      readonly terminationCause?: AgentRunTerminationCause
    }
  | {
      readonly type: "steering"
      readonly runID: AgentRunID
      readonly steeringID: string
      readonly mode: AgentSteeringMode
      readonly state: AgentSteeringState
      readonly acceptedAt: string
      readonly appliedAt?: string
      readonly reason?: string
    }
  | {
      readonly type: "provider_retry"
      readonly runID: AgentRunID
      readonly state: "scheduled" | "attempting" | "succeeded" | "timed_out" | "exhausted" | "cancelled"
      readonly attempt: number
      readonly maxRetries: number
      readonly delayMs?: number
      readonly attemptTimeoutMs?: number
      readonly retryWaitMs?: number
      readonly compensationMs?: number
      readonly providerWaitMs?: number
      readonly phaseExtensionMs?: number
      readonly phaseExtensionCapMs?: number
      readonly deadlineAt?: number
      readonly compensationCapReached?: boolean
      readonly failure?: Failure
    }
  | {
      readonly type: "phase_closeout"
      readonly runID: AgentRunID
      readonly state: "entered"
      readonly cause?: "reserve" | "hypothesis_exhausted"
      readonly reserveMs: number
      readonly remainingMs: number
      readonly deadlineAt: number
    }
  | {
      readonly type: "context_compaction"
      readonly runID: AgentRunID
      readonly state: "scheduled" | "started" | "completed" | "noop" | "recovered" | "failed"
      readonly mode: "proactive" | "emergency"
      readonly reason?:
        | "virtualized"
        | "reused"
        | "no_candidates"
        | "persistence_error"
        | "aborted"
        | "model_summary"
        | "model_summary_failed"
      readonly estimatedTokensBefore: number
      readonly estimatedTokensAfter: number
      readonly triggerTokens: number
      readonly messagesRemoved: number
      readonly toolResultsVirtualized: number
      readonly artifactsPreserved: number
      readonly modelSummary: boolean
      readonly summaryArtifact?: string
      readonly detail?: string
    }
  | {
      readonly type: "context_rotation"
      readonly runID: AgentRunID
      readonly state: "started" | "completed" | "completed_with_fallback" | "partial" | "failed"
      readonly mode: "proactive" | "emergency"
      readonly generation: number
      readonly provider: string
      readonly model: string
      readonly summarizerProvider: string
      readonly summarizerModel: string
      readonly summarizerReasoningEffort: Settings.ReasoningEffort
      readonly limits: {
        readonly catalogContextWindow: number
        readonly configuredContextWindow?: number
        readonly trustedRouteWindow: number
        readonly configuredOperationalContextWindow?: number
        readonly operationalContextWindow: number
        readonly observedContextUpperBound?: number
        readonly continuationReserveTokens: number
        readonly hardInputTokens: number
        readonly effectiveOperationalWindow: number
        readonly triggerTokens: number
        readonly targetTokens: number
        readonly source: ModelContextCapacity["source"] | "observed_upper_bound"
      }
      readonly estimatedTokensBefore: number
      readonly estimatedTokensAfter: number
      readonly sourceMessages: number
      readonly activeMessages: number
      readonly summarizedMessages: number
      readonly splitTurn: boolean
      readonly toolResultsVirtualized: number
      readonly artifactsPreserved: number
      readonly checkpoint?: {
        readonly path: string
        readonly sha256: string
      }
      readonly checkpointKind?: "model_summary" | "deterministic_fallback"
      readonly attempts: readonly {
        readonly attempt: number
        readonly provider: string
        readonly model: string
        readonly sourceMessages: number
        readonly sourceEstimatedTokens: number
        readonly outcome: "completed" | "context_error" | "failed"
        readonly usage?: AgentRunUsage
        readonly detail?: string
      }[]
      readonly reason?: "target_unreachable" | "active_tail_too_large" | "summary_failed" | "disabled_model_summary"
      readonly detail?: string
    }
  | {
      readonly type: "run_finished"
      readonly runID: AgentRunID
      readonly parentID?: AgentRunID
      readonly recoveryOf?: AgentRunID
      readonly role: AgentRunRole
      readonly termination: AgentRunTermination
      readonly terminationCause?: AgentRunTerminationCause
      readonly failure?: Failure
      readonly usage: AgentRunUsage
      readonly skillsUsed: readonly string[]
      readonly childRunIDs: readonly AgentRunID[]
      readonly fallbackAdmissions: number
      readonly fallbackDescendants: number
      readonly toolCalls: number
      readonly recoveredHypotheses?: readonly RecoveredHypothesis[]
      readonly recoveredTestObjects?: readonly RecoveredTestObject[]
      readonly recoverySummary?: AgentRunRecoverySummary
      readonly recoveryCheckpoint?: {
        readonly path: string
        readonly sha256: string
      }
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
  readonly recoveryOf?: AgentRunID
  readonly phaseRootID: AgentRunID
  readonly role: AgentRunRole
  readonly provider: string
  readonly model: string
  readonly providerAffinity: ProviderAffinity
  readonly identity?: AgentRunIdentity
  readonly reasoningEffort: Settings.ReasoningEffort
  readonly effectiveReasoningEffort: ReasoningPlan["effective"]
  readonly reasoningSelection?: "parent" | "default"
  readonly context: Extract<AgentEvent, { type: "run_started" }>["context"]
  readonly output: string
  readonly termination: AgentRunTermination
  readonly terminationCause: AgentRunTerminationCause
  readonly failure?: Failure
  readonly usage: AgentRunUsage
  readonly promptManifest: CompiledAgentPrompt["manifest"]
  readonly childRunIDs: readonly AgentRunID[]
  readonly skillsUsed: readonly string[]
  readonly toolCalls: number
  readonly fallbackAdmissions: number
  readonly fallbackDescendants: number
  readonly recoveredHypotheses: readonly RecoveredHypothesis[]
  readonly recoveredTestObjects: readonly RecoveredTestObject[]
  readonly recoverySummary?: AgentRunRecoverySummary
  readonly recoveryCheckpoint?: {
    readonly path: string
    readonly sha256: string
  }
}

export interface AgentRun {
  readonly id: AgentRunID
  readonly events: AsyncIterable<AgentEvent>
  steer(message: {
    readonly content: string
    readonly mode?: AgentSteeringMode
    readonly id?: string
    readonly acceptedAt?: string
  }): Promise<AgentSteeringReceipt>
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
