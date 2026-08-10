// ── Pi Agent Subsystem ───────────────────────────────────────────
// Runs complete root, delegated, and fallback AgentRuns inside one
// phase-scoped in-process Pi worker owner with host-owned routing and delegation policy.
// → cyberful/src/subsystem/agent-subsystem.ts — defines the public contract.
// → cyberful/src/subsystem/pi-context-compaction.ts — projects long transcripts safely.
// → cyberful/src/subsystem/pi-semantic-compaction.ts — validates durable semantic checkpoints.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import {
  Agent,
  estimateTokens,
  type AgentEvent as PiAgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core"
import type { AssistantMessage, ToolResultMessage, UserMessage, Usage } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import { Settings } from "@/config/settings"
import {
  createEvidenceManifest,
  listWorkareaFiles,
  readWorkareaFileChunk,
  replaceWorkareaFile,
  verifyEvidenceManifest,
} from "@/workarea"
import { SubsystemControl } from "./control"
import type {
  AgentEvent,
  AgentRunRecoverySummary,
  AgentRun,
  AgentRunID,
  AgentRunIdentity,
  AgentRunResult,
  AgentRunSpec,
  AgentRunTermination,
  AgentRunUsage,
  AgentSubsystem,
  AgentTaskCapsule,
  ChildPromptInput,
  ProviderAffinity,
  RecoveredHypothesis,
  RecoveredTestObject,
  SubsystemStatus,
} from "./agent-subsystem"
import type { PiModels } from "./pi-models"
import { PiAudit } from "./pi-audit"
import { PiReasoning } from "./pi-reasoning"
import { PiSecurity, type Failure } from "./pi-security"
import { PiSystemWire } from "./pi-system-wire"
import {
  compactAgentContext,
  contextCompactionNeed,
  EAGER_VIRTUALIZATION_BYTES,
  estimateAgentContextTokens,
  hasLargeHistoricalToolResult,
  projectAgentContext,
  type ContextArtifactReference,
  type ContextCompactionMode,
  type ContextCompactionResult,
  type ContextProjectionEntry,
} from "./pi-context-compaction"
import {
  buildRotationHistory,
  MODEL_SUMMARY_MAX_TOKENS,
  modelCheckpointRequest,
  parseModelCheckpoint,
  persistDeterministicCheckpoint,
  persistModelCheckpoint,
  type DeterministicContextCheckpoint,
  type SemanticProjection,
} from "./pi-semantic-compaction"
import { clearFallbackLedger, fallbackLedgerForSession, type PiFallbackLedger } from "./pi-fallback-ledger"
import type { PhaseActivity, PhaseActivityActor } from "./subsystem"
import type { ProviderCallKind, ProviderUsageLedger } from "./provider-usage"

function delegateTaskParameters(reasoningEfforts: readonly Settings.ReasoningEffort[]) {
  return Type.Object(
    {
      task: Type.String({
        minLength: 1,
        maxLength: 12_000,
        description: "Specific, bounded subtask for one complete delegated AgentRun.",
      }),
      expected_result: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4_000,
          description: "Concrete evidence, artifact, or structured answer the child must return.",
        }),
      ),
      context: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 12_000,
          description: "Minimum explicit context needed by the child; never include private reasoning.",
        }),
      ),
      artifacts: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), {
          maxItems: 64,
          description: "Workarea-relative artifacts the child should inspect or produce.",
        }),
      ),
      output_artifact: Type.String({
        minLength: 1,
        maxLength: 1_024,
        description:
          "Workarea-relative durable artifact the child must create or update. Partial output remains available after timeout or failure.",
      }),
      display_name: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 32,
          description: "Optional short kebab-case identity proposed for the child, such as api-monster.",
        }),
      ),
      emoji: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 16,
          description: "Optional single emoji grapheme proposed for the child.",
        }),
      ),
      reasoning_effort: Type.Optional(
        Type.String({
          enum: [...reasoningEfforts],
          description:
            "Choose one host-allowed effort for this child. Omission selects xhigh; request medium explicitly only for bounded evidence collection.",
        }),
      ),
    },
    { additionalProperties: false },
  )
}

const FallbackTaskParameters = Type.Object(
  {
    task: Type.String({
      minLength: 12,
      maxLength: 12_000,
      description:
        "One narrowly scoped operational subtask likely to encounter a provider cyber-policy block. Do not delegate the whole phase.",
    }),
    expected_result: Type.String({
      minLength: 3,
      maxLength: 4_000,
      description: "Concrete result or evidence this fallback delegation must return.",
    }),
    context: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 12_000,
        description: "Only the explicit context and artifact references required for the fallback task.",
      }),
    ),
    artifacts: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { maxItems: 64 })),
  },
  { additionalProperties: false },
)

const ToolSearchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        'Tool name or capability to find. Use "*" to enumerate the complete authorized catalog page by page.',
    }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 8 })),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 20,
        pattern: "^(0|[1-9][0-9]*)$",
        description: "Cursor returned by the previous tool_search call for the same query.",
      }),
    ),
  },
  { additionalProperties: false },
)

const WorkareaReadParameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 1_024,
      description: "Workarea-relative path to one existing regular text artifact.",
    }),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Zero-based byte offset returned by the previous workarea_read page.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 65_536,
        default: 65_536,
        description: "Maximum bytes to return from this page.",
      }),
    ),
  },
  { additionalProperties: false },
)

const WorkareaWriteParameters = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      maxLength: 1_024,
      description: "Exact workarea-relative deliverable path declared for this AgentRun.",
    }),
    content: Type.String({
      maxLength: 262_144,
      description: "Complete UTF-8 content that atomically replaces the declared deliverable.",
    }),
  },
  { additionalProperties: false },
)

const WorkareaListParameters = Type.Object(
  {
    prefix: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 1_024,
        description: "Existing workarea-relative directory to search; omit for the workarea root.",
      }),
    ),
    pattern: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description: "Bounded * and ? wildcard matched against relative paths and basenames.",
      }),
    ),
    max_depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 12, default: 4 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_024, default: 256 })),
  },
  { additionalProperties: false },
)

const EvidenceManifestParameters = Type.Union([
  Type.Object(
    {
      command: Type.Literal("create"),
      directory: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024, default: "." })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      command: Type.Literal("verify"),
      directory: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024, default: "." })),
    },
    { additionalProperties: false },
  ),
])

const DelegationStatusParameters = Type.Object({}, { additionalProperties: false })
const RECOVERY_SUMMARY_BYTES = 4_096
const WORKAREA_WRITE_BYTES = 262_144

type CatalogAgentTool = AgentTool & { readonly deferLoading?: boolean }

interface PiAgentSubsystemOptions {
  readonly settings: Settings.Info
  readonly registry: PiModels
  readonly fallbackLedger?: PiFallbackLedger
  readonly streamFn?: StreamFn
  readonly now?: () => number
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly createRunID?: () => AgentRunID
  readonly onPayload?: (payload: unknown, system: string, adapter: string) => unknown
  readonly onShutdown?: () => Promise<void>
  readonly usageLedger?: ProviderUsageLedger
}

interface RunState {
  readonly id: AgentRunID
  readonly spec: AgentRunSpec
  readonly resultPromise: Promise<AgentRunResult>
  readonly resolveResult: (result: AgentRunResult) => void
  readonly queue: EventQueue<AgentEvent>
  readonly rootQueue: EventQueue<AgentEvent>
  readonly children: Set<AgentRunID>
  readonly childResults: AgentRunResult[]
  readonly skillsRead: Set<string>
  readonly skillsUsed: Set<string>
  readonly actor: PhaseActivityActor
  agent?: Agent
  unregisterControl?: () => void
  timer?: ReturnType<typeof setTimeout>
  timerStartedAt?: number
  timerRemainingMs?: number
  removePauseListener?: () => void
  removeAbortListener?: () => void
  childStarts: number
  toolCalls: number
  fallbackAdmissions: number
  fallbackDescendants: number
  automaticFallbackUsed: boolean
  cumulativeUsage: AgentRunUsage
  providerRetryAttempt: number
  providerRetryActive: boolean
  providerCallKind: ProviderCallKind
  readonly contextArtifacts: Map<string, ContextArtifactReference>
  readonly contextProjections: Map<string, ContextProjectionEntry>
  contextInstalledHistory?: {
    readonly sourceMessageCount: number
    readonly messages: readonly AgentMessage[]
  }
  readonly contextRecoveryKeys: Set<string>
  contextRecoveryAttempted: boolean
  contextRecoveryProviderCallsRemaining?: number
  contextRotationGeneration: number
  contextCompactionEmergency: boolean
  contextRotationWatermark?: {
    readonly estimatedTokens: number
    readonly userMessages: number
  }
  lastProviderInputEstimate?: number
  retryWaitAbort?: AbortController
  finishProviderRetryAttempt?: () => void
  closeout: boolean
  closeoutRequested: boolean
  recoverySummary?: AgentRunRecoverySummary
  recoverySummaryWrite?: Promise<void>
  recoverySummaryWriteError?: string
  recoveryCheckpoint?: ContextArtifactReference
  lastHTTPStatus?: number
  lastTool?: {
    readonly name: string
    readonly input: unknown
  }
  cancellation?: "budget" | "cancel"
  finished: boolean
}

type ContextRotationEvent = Extract<AgentEvent, { type: "context_rotation" }>
type ContextRotationAttempt = ContextRotationEvent["attempts"][number]

const observedContextUpperBounds = new Map<string, number>()
const CONTEXT_CONTINUATION_RESERVE_TOKENS = 16_384

class ContextCheckpointError extends Error {
  readonly attempts: readonly ContextRotationAttempt[]

  constructor(message: string, attempts: readonly ContextRotationAttempt[]) {
    super(message)
    this.name = "ContextCheckpointError"
    this.attempts = attempts
  }
}

class ContextCapacityError extends Error {
  readonly code = "active_tail_too_large"

  constructor(message: string) {
    super(message)
    this.name = "ContextCapacityError"
  }
}

interface StartChildOptions {
  readonly role: "subagent" | "fallback"
  readonly route: ProviderAffinity
  readonly task: AgentTaskCapsule
  readonly mode?: "proactive" | "automatic"
  readonly quotaExempt?: boolean
  readonly sourceCallID?: string
  readonly reasoningEffort?: Settings.ReasoningEffort
  readonly reasoningSelection?: "parent" | "default"
  readonly recoveryOf?: AgentRunID
  readonly recoveryDeadlineAt?: number
  readonly recoveryOutputTokens?: number
  readonly proposedIdentity?: {
    readonly displayName?: string
    readonly emoji?: string
  }
}

const AGENT_IDENTITY_ADJECTIVES = [
  "api",
  "auth",
  "browser",
  "cipher",
  "cloud",
  "cookie",
  "data",
  "header",
  "parser",
  "route",
  "session",
  "token",
] as const
const AGENT_IDENTITY_NOUNS = [
  "comet",
  "dragon",
  "falcon",
  "guardian",
  "monster",
  "owl",
  "rocket",
  "scanner",
  "ship",
  "spark",
  "tiger",
  "voyager",
] as const
const AGENT_IDENTITY_EMOJIS = ["👾", "🚀", "🦉", "🐉", "🛰️", "🔭", "🛡️", "🧭", "⚡", "🔬"] as const
const AGENT_DISPLAY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const AGENT_EMOJI = /\p{Extended_Pictographic}/u

function validDisplayName(value: string | undefined): value is string {
  return value !== undefined && value.length <= 32 && AGENT_DISPLAY_NAME.test(value)
}

function validEmoji(value: string | undefined): value is string {
  if (!value || !AGENT_EMOJI.test(value)) return false
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)]
  return segments.length === 1 && segments[0]?.segment === value
}

function deterministicIdentity(task: AgentTaskCapsule): AgentRunIdentity {
  const digest = createHash("sha256")
    .update(task.objective)
    .update("\0")
    .update((task.artifacts ?? []).join("\0"))
    .update("\0")
    .update(task.outputArtifact ?? "")
    .digest()
  return {
    displayName: `${AGENT_IDENTITY_ADJECTIVES[digest[0]! % AGENT_IDENTITY_ADJECTIVES.length]}-${
      AGENT_IDENTITY_NOUNS[digest[1]! % AGENT_IDENTITY_NOUNS.length]
    }`,
    emoji: AGENT_IDENTITY_EMOJIS[digest[2]! % AGENT_IDENTITY_EMOJIS.length]!,
  }
}

class EventQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  readonly #values: T[] = []
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false

  push(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.#closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

function emptyUsage(): AgentRunUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function addUsage(total: AgentRunUsage, usage: Usage): AgentRunUsage {
  return {
    input: total.input + Math.max(0, usage.input),
    output: total.output + Math.max(0, usage.output),
    reasoning: total.reasoning + Math.max(0, usage.reasoning ?? 0),
    cacheRead: total.cacheRead + Math.max(0, usage.cacheRead),
    cacheWrite: total.cacheWrite + Math.max(0, usage.cacheWrite),
  }
}

function agentRunUsage(usage: Usage): AgentRunUsage {
  return addUsage(emptyUsage(), usage)
}

function emptyProviderUsage(): Usage {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function checkpointSourceGroups(messages: readonly AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role !== "assistant") {
      if (message.role !== "toolResult") groups.push([message])
      continue
    }
    const callIDs = new Set(message.content.flatMap((item) => (item.type === "toolCall" ? [item.id] : [])))
    const group: AgentMessage[] = [message]
    while (callIDs.size > 0 && messages[index + 1]?.role === "toolResult") {
      const result = messages[index + 1]!
      if (result.role !== "toolResult" || !callIDs.has(result.toolCallId)) break
      index++
      callIDs.delete(result.toolCallId)
      group.push(result)
    }
    groups.push(group)
  }
  return groups
}

function reducedCheckpointSource(messages: readonly AgentMessage[]): AgentMessage[] {
  const groups = checkpointSourceGroups(messages)
  const targetTokens = Math.max(
    1,
    Math.floor(messages.reduce((total, message) => total + estimateTokens(message), 0) / 2),
  )
  const retained: AgentMessage[][] = []
  let retainedTokens = 0
  for (const group of groups.toReversed()) {
    const groupTokens = group.reduce((total, message) => total + estimateTokens(message), 0)
    if (retained.length > 0 && retainedTokens + groupTokens > targetTokens) continue
    retained.unshift(group)
    retainedTokens += groupTokens
    if (retainedTokens >= targetTokens) break
  }
  return retained.flat()
}

function compactToolDescription(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim()
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`
}

function normalizedSearchTokens(value: string): readonly string[] {
  const infrastructure = new Set(["tool", "tools", "mcp", "cyberful", "os"])
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !infrastructure.has(token))
}

function toolSearchScore(tool: AgentTool, query: string): number | undefined {
  const normalizedQuery = query.toLowerCase().trim()
  const name = tool.name.toLowerCase()
  const label = tool.label.toLowerCase()
  const description = tool.description.toLowerCase()
  if (name === normalizedQuery) return 100_000
  if (label === normalizedQuery) return 90_000

  const tokens = normalizedSearchTokens(normalizedQuery)
  if (tokens.length === 0) return
  let score = name.startsWith(normalizedQuery) ? 20_000 : label.startsWith(normalizedQuery) ? 15_000 : 0
  let matched = 0
  let matchedWeight = 0
  for (const token of tokens) {
    if (name === token) {
      score += 8_000
      matched++
      matchedWeight += 4
      continue
    }
    if (name.startsWith(token)) {
      score += 5_000
      matched++
      matchedWeight += 4
      continue
    }
    if (name.includes(token)) {
      score += 3_000
      matched++
      matchedWeight += 3
      continue
    }
    if (label.includes(token)) {
      score += 1_200
      matched++
      matchedWeight += 2
      continue
    }
    if (description.includes(token)) {
      score += 250
      matched++
      matchedWeight += 1
    }
  }
  if (matched === 0) return
  const coverage = matched / tokens.length
  return score + Math.round(coverage * 1_000) + matchedWeight * 10
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Provider retry was cancelled"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs)
    timer.unref?.()
    signal.addEventListener("abort", aborted, { once: true })

    function done() {
      signal.removeEventListener("abort", aborted)
      resolve()
    }

    function aborted() {
      clearTimeout(timer)
      reject(signal.reason ?? new Error("Provider retry was cancelled"))
    }
  })
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return typeof message === "object" && message !== null && "role" in message && message.role === "assistant"
}

function assistantText(message: AssistantMessage | undefined): string {
  return (
    message?.content
      .flatMap((item) => (item.type === "text" ? [item.text] : []))
      .join("\n")
      .trim() ?? ""
  )
}

function boundedRecoveryNarrative(messages: readonly unknown[]): string | undefined {
  const narrative = PiAudit.redactText(assistantText(latestAssistant(messages))).trim()
  if (!narrative) return
  const bytes = Buffer.from(narrative)
  if (bytes.byteLength <= RECOVERY_SUMMARY_BYTES) return narrative
  return `${bytes
    .subarray(0, RECOVERY_SUMMARY_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/u, "")}… [summary truncated]`
}

function deterministicContextCheckpoint(
  state: RunState,
  messages: readonly AgentMessage[],
): DeterministicContextCheckpoint {
  const ledgerIDs = (toolName: "hypothesis" | "test_object") =>
    messages
      .flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((item) => {
              if (item.type !== "toolCall" || item.name !== toolName) return []
              const args = record(item.arguments)
              const value = toolName === "hypothesis" ? (args?.id ?? args?.hypothesis_id) : args?.id
              return typeof value === "string" && value.trim() ? [PiAudit.redactText(value.trim())] : []
            })
          : [],
      )
      .filter((value, index, all) => all.indexOf(value) === index)
      .slice(0, 128)
  const declaredArtifacts = [
    ...(state.spec.task.artifacts ?? []),
    ...(state.spec.task.outputArtifact ? [state.spec.task.outputArtifact] : []),
  ]
  const preservedArtifacts = [
    ...declaredArtifacts.map((artifact) => ({ path: PiAudit.redactText(artifact) })),
    ...[...state.contextArtifacts.values()].map((artifact) => ({
      path: PiAudit.redactText(artifact.path),
      sha256: artifact.sha256,
    })),
  ].filter((artifact, index, all) => all.findIndex((candidate) => candidate.path === artifact.path) === index)
  const recentQueue = messages.slice(-24).map((message) => ({
    role: message.role,
    ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
    ...(message.role === "toolResult" ? { toolCallID: message.toolCallId, toolName: message.toolName } : {}),
  }))
  const lastPublicOutput = boundedRecoveryNarrative(messages)
  return {
    task: {
      objective: PiAudit.redactText(state.spec.task.objective),
      ...(state.spec.task.expectedResult ? { expectedResult: PiAudit.redactText(state.spec.task.expectedResult) } : {}),
      ...(state.spec.task.context ? { context: PiAudit.redactText(state.spec.task.context) } : {}),
      artifacts: (state.spec.task.artifacts ?? []).map(PiAudit.redactText),
      ...(state.spec.task.outputArtifact ? { outputArtifact: PiAudit.redactText(state.spec.task.outputArtifact) } : {}),
    },
    preservedArtifacts,
    hypothesisIDs: ledgerIDs("hypothesis"),
    testObjectIDs: ledgerIDs("test_object"),
    completedToolCalls: messages
      .flatMap((message) =>
        message.role === "toolResult"
          ? [{ id: message.toolCallId, name: message.toolName, isError: message.isError }]
          : [],
      )
      .slice(-128),
    ...(lastPublicOutput ? { lastPublicOutput } : {}),
    recentQueue,
  }
}

const FAILURE_DETAIL_CAP = 1600

function boundedFailureDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const redacted = PiAudit.redactText(value).replaceAll(/\s+/g, " ").trim()
  if (!redacted) return
  return redacted.length <= FAILURE_DETAIL_CAP
    ? redacted
    : `${redacted.slice(0, FAILURE_DETAIL_CAP)}… [provider detail truncated]`
}

function failureWithDetail(failure: Failure | undefined, detail: unknown): Failure | undefined {
  const bounded = boundedFailureDetail(detail)
  return failure && bounded ? ({ ...failure, detail: bounded } as Failure) : failure
}

function latestAssistant(messages: readonly unknown[]): AssistantMessage | undefined {
  return messages.findLast(isAssistantMessage)
}

function resultText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content))
    return ""
  return result.content
    .flatMap((item) => {
      if (typeof item !== "object" || item === null || !("type" in item)) return []
      if (item.type === "text" && "text" in item && typeof item.text === "string") return [item.text]
      if (item.type === "image" && "mimeType" in item) return [`[image: ${String(item.mimeType)}]`]
      return []
    })
    .join("\n")
}

function auditedFailure(failure: Failure | undefined): Failure | undefined {
  if (!failure) return
  const providerCode = failure.providerCode ? PiAudit.redactText(failure.providerCode) : undefined
  const detail = boundedFailureDetail(failure.detail)
  return {
    ...failure,
    ...(providerCode ? { providerCode } : {}),
    ...(detail ? { detail } : {}),
  } as Failure
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function taskCapsule(input: {
  readonly task: string
  readonly expected_result?: string
  readonly context?: string
  readonly artifacts?: readonly string[]
  readonly outputArtifact?: string
}): AgentTaskCapsule {
  return {
    objective: input.task.trim(),
    ...(input.expected_result?.trim() ? { expectedResult: input.expected_result.trim() } : {}),
    ...(input.context?.trim() ? { context: input.context.trim() } : {}),
    ...(input.artifacts?.length ? { artifacts: input.artifacts.map((item) => item.trim()).filter(Boolean) } : {}),
    ...(input.outputArtifact ? { outputArtifact: input.outputArtifact } : {}),
  }
}

function delegatedArtifact(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/")
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")
  )
    throw new Error("delegate_task output_artifact must be a relative path inside the workarea")
  return normalized
}

function capsuleText(task: AgentTaskCapsule): string {
  return [
    "# Specific delegated objective",
    task.objective,
    ...(task.expectedResult ? ["", "# Expected result", task.expectedResult] : []),
    ...(task.context ? ["", "# Minimum explicit context", task.context] : []),
    ...(task.outputArtifact ? ["", "# Required durable output", task.outputArtifact] : []),
    ...(task.artifacts?.length
      ? ["", "# Relevant workarea artifacts", ...task.artifacts.map((item) => `- ${item}`)]
      : []),
  ].join("\n")
}

function providerObservation(
  adapter: string,
  provider: string,
  model: string,
  message: AssistantMessage | undefined,
  httpStatus?: number,
): PiSecurity.FailureObservation {
  let upstream: Record<string, unknown> | undefined =
    httpStatus === undefined ? undefined : { status: httpStatus, error: httpStatus >= 400 ? {} : undefined }

  // Pi 0.81 owns these exact strings when converting a structured Chat
  // Completions finish_reason. Exact adapter output is restored to a protocol
  // field; model prose cannot trigger this mapping.
  if (adapter === "openai-completions" && message?.stopReason === "error") {
    if (message.errorMessage === "Provider finish_reason: content_filter")
      upstream = { ...upstream, finishReason: "content_filter" }
    if (message.errorMessage === "Provider finish_reason: sensitive")
      upstream = { ...upstream, finishReason: "sensitive" }
  }

  return { adapter, provider, model, message, upstream }
}

function userMessages(spec: AgentRunSpec): UserMessage[] {
  return spec.prompt.messages.map((message) => ({
    role: "user",
    content: message.content,
    timestamp: Date.now(),
  }))
}

function closeoutMessage(spec: AgentRunSpec, timestamp: number): UserMessage {
  const deliverable = spec.task.outputArtifact ?? spec.task.artifacts?.[0]
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: [
          spec.handoffOwner ? "HOST-OWNED PHASE CLOSEOUT" : "HOST-OWNED AGENTRUN CLOSEOUT",
          "The active research portion of this run is over. Do not start or resume target traffic, scanning,",
          "lab execution, new analysis branches, or delegation. Use only already captured local evidence.",
          deliverable
            ? `Finish and reconcile the required deliverable '${deliverable}' now.`
            : "Finish and reconcile the assigned deliverable now.",
          "Read existing workarea-relative evidence with workarea_read; continue from next_offset when paginated.",
          deliverable
            ? `Use workarea_write to atomically replace exactly '${deliverable}' with the complete final content.`
            : "No atomic workarea writer is available because this run has no declared deliverable path.",
          "Update the hypothesis, finding, test-object, and coverage records to match the evidence.",
          spec.handoffOwner
            ? "Call handoff with a concise, explicit successor summary before the final deadline."
            : "Return a concise final summary before the final deadline.",
        ].join("\n"),
      },
    ],
    timestamp,
  }
}

function closeoutToolAllowed(name: string): boolean {
  if (
    [
      "handoff",
      "hypothesis",
      "finding",
      "code_finding",
      "test_object",
      "engagement_policy",
      "variable",
      "skill_read",
      "tool_search",
    ].includes(name)
  )
    return true
  return ["source_", "code_graph_", "artifact_", "workarea_", "coverage_", "report_"].some((prefix) =>
    name.startsWith(prefix),
  )
}

function validateSpec(spec: AgentRunSpec): void {
  if (!spec.sessionID.trim()) throw new Error("AgentRun sessionID is empty")
  if (!path.isAbsolute(spec.workarea)) throw new Error("AgentRun workarea must be absolute")
  if (!Number.isInteger(spec.depth) || spec.depth < 0) throw new Error("AgentRun depth must be a non-negative integer")
  if (spec.model.provider !== spec.provider)
    throw new Error(`AgentRun provider '${spec.provider}' does not own resolved model '${spec.model.id}'`)
  if (spec.prompt.manifest.role !== spec.role) throw new Error("AgentRun prompt role does not match its run role")
  if (spec.prompt.manifest.providerRoute !== spec.providerAffinity)
    throw new Error("AgentRun prompt provider route does not match provider affinity")
  if (spec.prompt.manifest.handoffOwner !== spec.handoffOwner)
    throw new Error("AgentRun prompt handoff ownership does not match host policy")
  if (spec.handoffOwner && spec.role !== "root") throw new Error("Only the original root AgentRun may own handoff")
  if (spec.role === "root" && spec.providerAffinity !== "main")
    throw new Error("The original root AgentRun must use main provider affinity")
  if (spec.role === "fallback" && spec.providerAffinity !== "fallback")
    throw new Error("A fallback AgentRun must use fallback provider affinity")
  if (spec.role === "root" && (spec.parentID || spec.phaseRootID))
    throw new Error("The original root AgentRun cannot declare a parent or pre-existing phase root")
  if (spec.role !== "root" && (!spec.parentID || !spec.phaseRootID))
    throw new Error("Delegated and fallback AgentRuns require parent and phase-root IDs")
  if (!spec.task.objective.trim()) throw new Error("AgentRun task objective is empty")
  if (!Number.isFinite(spec.budget.deadlineAt)) throw new Error("AgentRun deadline must be finite")
  if (
    spec.budget.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(spec.budget.maxOutputTokens) || spec.budget.maxOutputTokens <= 0)
  )
    throw new Error("AgentRun maxOutputTokens must be a positive safe integer")
}

function terminationFor(state: RunState, failure: Failure | undefined): AgentRunTermination {
  if (state.cancellation === "budget") return "budget_exhausted"
  if (state.cancellation === "cancel" || failure?.kind === "cancelled") return "cancelled"
  if (failure) return "provider_failed"
  return "completed"
}

export class PiAgentSubsystem implements AgentSubsystem {
  readonly id = "pi" as const
  readonly #settings: Settings.Info
  readonly #registry: PiModels
  readonly #streamFn: StreamFn
  readonly #now: () => number
  readonly #sleep: (delayMs: number, signal: AbortSignal) => Promise<void>
  readonly #random: () => number
  readonly #createRunID: () => AgentRunID
  readonly #fallbackLedger: PiFallbackLedger
  readonly #usageLedger?: ProviderUsageLedger

  readonly #onPayload?: PiAgentSubsystemOptions["onPayload"]
  readonly #onShutdown?: () => Promise<void>
  readonly #states = new Map<AgentRunID, RunState>()
  readonly #delegationWaiters = new Set<() => void>()

  #activeDelegatedRuns = 0
  #shuttingDown = false
  #shutdownPromise: Promise<void> | undefined

  constructor(options: PiAgentSubsystemOptions) {
    this.#settings = options.settings
    this.#registry = options.registry
    this.#streamFn = options.streamFn ?? options.registry.models.streamSimple.bind(options.registry.models)
    this.#now = options.now ?? Date.now
    this.#sleep = options.sleep ?? sleep
    this.#random = options.random ?? Math.random
    this.#createRunID = options.createRunID ?? (() => `run_${randomUUID()}`)
    this.#fallbackLedger = options.fallbackLedger ?? fallbackLedgerForSession(`worker_${randomUUID()}`)
    this.#usageLedger = options.usageLedger
    this.#onPayload = options.onPayload
    this.#onShutdown = options.onShutdown
  }

  async preflight(settings: Settings.Info): Promise<SubsystemStatus> {
    const routes = [
      { id: settings.agent.main_provider, route: "main" as const },
      ...(settings.agent.fallback_provider
        ? [{ id: settings.agent.fallback_provider, route: "fallback" as const }]
        : []),
    ]
    const providers: SubsystemStatus["providers"][number][] = []
    const errors: string[] = []
    let mainAuthenticated = false
    let fallbackAuthenticated = false
    for (const route of routes) {
      try {
        const model = this.#registry.model(route.id)
        const auth = await this.#registry.models.getAuth(model)
        if (route.route === "main") mainAuthenticated = Boolean(auth)
        if (route.route === "fallback") fallbackAuthenticated = Boolean(auth)
        providers.push({
          id: route.id,
          model: model.id,
          route: route.route,
          authenticated: Boolean(auth),
          context: this.#registry.contextCapacity(route.id),
          reasoningEffort: Settings.reasoningEffort(settings),
          effectiveReasoningEffort: PiReasoning.resolve(Settings.reasoningEffort(settings), model).effective,
          ...(auth?.source ? { authSource: auth.source } : {}),
        })
        if (!auth) {
          const login = settings.agent.providers[route.id]?.auth.type === "subscription"
            ? `; run 'cyberful auth login ${route.id}'`
            : ""
          errors.push(`Provider '${route.id}' has no configured ${settings.agent.providers[route.id]?.auth.type}${login}`)
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    const phaseRecovery = Settings.phaseRecoveryPolicy(settings)
    const fallbackRequired = Boolean(
      settings.agent.fallback_provider &&
        (settings.agent.fallback.proactive.enabled ||
          settings.agent.fallback.automatic_security_block.enabled ||
          (phaseRecovery.enabled && phaseRecovery.use_fallback_provider)),
    )
    const ready = mainAuthenticated && (!fallbackRequired || fallbackAuthenticated)
    return {
      ready,
      degraded: ready && errors.length > 0,
      subsystem: "pi",
      providers,
      errors,
    }
  }

  async start(spec: AgentRunSpec): Promise<AgentRun> {
    if (this.#shuttingDown) throw new Error("Pi agent subsystem is shutting down")
    validateSpec(spec)
    if (this.#fallbackLedger.sessionID !== spec.sessionID && !this.#fallbackLedger.sessionID.startsWith("worker_"))
      throw new Error("AgentRun session does not match its fallback quota ledger")
    const id = spec.id ?? this.#createRunID()
    if (this.#states.has(id)) throw new Error(`Duplicate AgentRun id '${id}'`)
    const rootID = spec.role === "root" ? id : spec.phaseRootID!
    const parent = spec.parentID ? this.#states.get(spec.parentID) : undefined
    if (spec.role !== "root" && !parent) throw new Error(`AgentRun parent '${spec.parentID}' is not active`)
    if (parent && parent.spec.phaseRootID !== undefined && parent.spec.phaseRootID !== rootID)
      throw new Error("AgentRun cannot change phase root")

    const queue = new EventQueue<AgentEvent>()
    const rootQueue = spec.role === "root" ? queue : this.#states.get(rootID)?.rootQueue
    if (!rootQueue) throw new Error(`AgentRun phase root '${rootID}' is not active`)
    const result = Promise.withResolvers<AgentRunResult>()
    const state: RunState = {
      id,
      spec: { ...spec, id, phaseRootID: spec.role === "root" ? undefined : rootID },
      resultPromise: result.promise,
      resolveResult: result.resolve,
      queue,
      rootQueue,
      children: new Set(),
      childResults: [],
      skillsRead: new Set(),
      skillsUsed: new Set(),
      actor: {
        id,
        label: spec.identity
          ? `${spec.identity.emoji} ${spec.identity.displayName}`
          : `${spec.role} · ${spec.provider}/${spec.model.id}`,
        ...(spec.identity
          ? {
              displayName: spec.identity.displayName,
              emoji: spec.identity.emoji,
            }
          : {}),
        role: spec.role,
        ...(spec.parentID ? { parentID: spec.parentID } : {}),
        ...(spec.sourceCallID ? { sourceCallID: spec.sourceCallID } : {}),
        provider: spec.provider,
        model: spec.model.id,
        startedAt: this.#now(),
        lastActivityAt: this.#now(),
        toolCalls: 0,
      },
      childStarts: 0,
      toolCalls: 0,
      fallbackAdmissions: 0,
      fallbackDescendants: 0,
      automaticFallbackUsed: false,
      cumulativeUsage: emptyUsage(),
      providerRetryAttempt: 0,
      providerRetryActive: false,
      providerCallKind: "generation",
      closeout: false,
      closeoutRequested: false,
      contextArtifacts: new Map(),
      contextProjections: new Map(),
      contextRecoveryKeys: new Set(),
      contextRecoveryAttempted: false,
      contextRotationGeneration: 0,
      contextCompactionEmergency: false,
      finished: false,
    }
    this.#states.set(id, state)
    parent?.children.add(id)
    if (spec.role !== "root") this.#activeDelegatedRuns++
    if (spec.providerAffinity === "main") {
      try {
        await this.#fallbackLedger.recordMainActor()
      } catch (error) {
        parent?.children.delete(id)
        if (spec.role !== "root") this.#activeDelegatedRuns = Math.max(0, this.#activeDelegatedRuns - 1)
        this.#states.delete(id)
        throw error
      }
    }

    const handle = this.#handle(state)
    if (spec.role === "root") {
      state.unregisterControl = SubsystemControl.register(spec.sessionID, {
        steer: async (request) => {
          const accepted = await handle.steer({ content: request.text })
          return { accepted, recipients: accepted ? 1 : 0 }
        },
      })
    }
    void this.#execute(state)
    return handle
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise
    this.#shuttingDown = true
    this.#notifyDelegationWaiters({ all: true })
    this.#shutdownPromise = (async () => {
      const roots = [...this.#states.values()].filter((state) => state.spec.role === "root")
      await Promise.allSettled(roots.map((state) => this.#cancelState(state, "Pi phase owner shutdown", "cancel")))
      await Promise.allSettled([...this.#states.values()].map((state) => state.resultPromise))
      await this.#onShutdown?.()
    })()
    return this.#shutdownPromise
  }

  #handle(state: RunState): AgentRun {
    return {
      id: state.id,
      events: state.queue,
      result: state.resultPromise,
      steer: async (message) => {
        const content = message.content.trim()
        if (!content || state.finished || state.cancellation || !state.agent) return false
        state.agent.steer({ role: "user", content, timestamp: this.#now() })
        return true
      },
      cancel: (reason) => this.#cancelState(state, reason, "cancel"),
    }
  }

  #emit(state: RunState, event: AgentEvent): void {
    const audited = PiAudit.redactValue(event) as AgentEvent
    state.queue.push(audited)
    if (state.rootQueue !== state.queue) state.rootQueue.push(audited)
  }

  #emitActivity(state: RunState, activity: PhaseActivity): void {
    const actor = {
      ...state.actor,
      ...activity.actor,
      lastActivityAt: this.#now(),
      toolCalls: state.toolCalls,
    }
    Object.assign(state.actor, actor)
    this.#emit(state, {
      type: "activity",
      runID: state.id,
      activity: { ...activity, actor },
    })
  }

  #recordProviderUsage(
    state: RunState,
    input: {
      readonly usage: Usage
      readonly provider?: string
      readonly model?: string
      readonly reasoningRequested?: Settings.ReasoningEffort
      readonly reasoningEffective?: string
      readonly callKind: ProviderCallKind
      readonly status: "completed" | "failed" | "cancelled"
      readonly attempt: number
    },
  ): void {
    const route = input.provider ?? state.spec.provider
    this.#usageLedger?.record({
      workflow: state.spec.prompt.manifest.workflow,
      phase: state.spec.prompt.manifest.phase,
      attempt: input.attempt,
      runID: state.id,
      ...(state.spec.parentID ? { parentRunID: state.spec.parentID } : {}),
      depth: state.spec.depth,
      runKind: state.spec.role,
      provider: this.#registry.adapter(route),
      route,
      model: input.model ?? state.spec.model.id,
      reasoningRequested: input.reasoningRequested ?? state.spec.reasoning.requested,
      reasoningEffective: input.reasoningEffective ?? state.spec.reasoning.effective,
      callKind: input.callKind,
      status: input.status,
      usage: agentRunUsage(input.usage),
      reportedTotalTokens: input.usage.totalTokens,
      telemetryComplete: [input.usage.input, input.usage.output, input.usage.cacheRead, input.usage.cacheWrite].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ),
    })
  }

  #retryFailure(state: RunState, message: AssistantMessage | undefined): Failure | undefined {
    if (!message) return
    return PiSecurity.classify(
      providerObservation(
        this.#registry.adapter(state.spec.provider),
        state.spec.provider,
        state.spec.model.id,
        message,
        state.lastHTTPStatus,
      ),
    )
  }

  #canRetryProvider(state: RunState, failure: Failure | undefined): failure is Failure {
    const policy = Settings.retryPolicy(this.#settings)
    return (
      policy.enabled &&
      failure?.retryable === true &&
      !(
        failure.kind === "capacity" &&
        (failure.providerCode === "context_length_exceeded" || failure.providerCode === "context_rotation_failed")
      ) &&
      state.providerRetryAttempt < policy.max_retries &&
      !state.cancellation &&
      this.#remainingBudget(state) > 0
    )
  }

  #emitProviderRetry(
    state: RunState,
    retry: {
      readonly state: Extract<AgentEvent, { type: "provider_retry" }>["state"]
      readonly attempt: number
      readonly delayMs?: number
      readonly attemptTimeoutMs?: number
      readonly failure?: Failure
    },
  ): void {
    const policy = Settings.retryPolicy(this.#settings)
    const budget = state.spec.budget.clock?.snapshot()
    this.#emit(state, {
      type: "provider_retry",
      runID: state.id,
      state: retry.state,
      attempt: retry.attempt,
      maxRetries: policy.max_retries,
      ...(retry.delayMs === undefined ? {} : { delayMs: retry.delayMs }),
      ...(retry.attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs: retry.attemptTimeoutMs }),
      ...(budget
        ? {
            retryWaitMs: Math.round(budget.retryWaitMs),
            compensationMs: Math.round(budget.retryCompensationMs),
            providerWaitMs: Math.round(budget.retryWaitMs),
            phaseExtensionMs: Math.round(budget.retryCompensationMs),
            phaseExtensionCapMs: Math.round(budget.retryCompensationCapMs),
            deadlineAt: Math.round(budget.deadlineAt),
            compensationCapReached: budget.retryCompensationCapReached,
          }
        : {}),
      ...(retry.failure ? { failure: retry.failure } : {}),
    })
    const code = retry.failure?.providerCode ? ` (${retry.failure.providerCode})` : ""
    const delay = retry.delayMs === undefined ? "" : ` after ${retry.delayMs} ms`
    this.#emitActivity(state, {
      kind: "status",
      text: `Provider retry ${retry.state}: attempt ${retry.attempt}/${policy.max_retries}${delay}${code}.`,
    })
  }

  #emitContextCompaction(
    state: RunState,
    eventState: Extract<AgentEvent, { type: "context_compaction" }>["state"],
    mode: ContextCompactionMode,
    stats: {
      readonly reason?: Extract<AgentEvent, { type: "context_compaction" }>["reason"]
      readonly estimatedTokensBefore: number
      readonly estimatedTokensAfter: number
      readonly triggerTokens: number
      readonly messagesRemoved: number
      readonly toolResultsVirtualized: number
      readonly artifactsPreserved: number
      readonly modelSummary?: boolean
      readonly summaryArtifact?: string
      readonly detail?: string
    },
  ): void {
    this.#emit(state, {
      type: "context_compaction",
      runID: state.id,
      state: eventState,
      mode,
      ...(stats.reason ? { reason: stats.reason } : {}),
      estimatedTokensBefore: stats.estimatedTokensBefore,
      estimatedTokensAfter: stats.estimatedTokensAfter,
      triggerTokens: stats.triggerTokens,
      messagesRemoved: stats.messagesRemoved,
      toolResultsVirtualized: stats.toolResultsVirtualized,
      artifactsPreserved: stats.artifactsPreserved,
      modelSummary: stats.modelSummary ?? false,
      ...(stats.summaryArtifact ? { summaryArtifact: stats.summaryArtifact } : {}),
      ...(stats.detail ? { detail: stats.detail } : {}),
    })
    const visible =
      eventState === "recovered" ||
      (mode === "proactive" && (eventState === "completed" || eventState === "noop" || eventState === "failed"))
    if (visible)
      this.#emitActivity(state, {
        kind: "status",
        text: JSON.stringify({
          contextCompaction: {
            state: eventState,
            mode,
            ...(stats.reason ? { reason: stats.reason } : {}),
            estimatedTokensBefore: stats.estimatedTokensBefore,
            estimatedTokensAfter: stats.estimatedTokensAfter,
            messagesRemoved: stats.messagesRemoved,
            toolResultsVirtualized: stats.toolResultsVirtualized,
            artifactsPreserved: stats.artifactsPreserved,
            modelSummary: stats.modelSummary ?? false,
            ...(stats.summaryArtifact ? { summaryArtifact: stats.summaryArtifact } : {}),
            ...(stats.detail ? { detail: stats.detail } : {}),
          },
        }),
      })
  }

  #contextRouteKey(state: RunState): string {
    return this.#contextRouteKeyFor(state.spec.sessionID, state.spec.provider)
  }

  #contextRouteKeyFor(sessionID: string, provider: string): string {
    return `${sessionID}:${provider}`
  }

  #contextLimits(state: RunState) {
    const policy = Settings.compactionPolicy(this.#settings)
    const observedContextUpperBound = observedContextUpperBounds.get(this.#contextRouteKey(state))
    const continuationReserveTokens = Math.min(CONTEXT_CONTINUATION_RESERVE_TOKENS, state.spec.model.maxTokens)
    const advertisedHardInputTokens = Math.max(1, state.spec.context.trustedRouteWindow - continuationReserveTokens)
    const hardInputTokens = Math.min(advertisedHardInputTokens, observedContextUpperBound ?? Number.POSITIVE_INFINITY)
    const effectiveOperationalWindow = Math.min(
      state.spec.context.operationalContextWindow,
      observedContextUpperBound ?? Number.POSITIVE_INFINITY,
    )
    const source =
      observedContextUpperBound !== undefined && observedContextUpperBound < state.spec.context.operationalContextWindow
        ? ("observed_upper_bound" as const)
        : state.spec.context.source
    return {
      catalogContextWindow: state.spec.context.catalogContextWindow,
      ...(state.spec.context.configuredContextWindow === undefined
        ? {}
        : { configuredContextWindow: state.spec.context.configuredContextWindow }),
      trustedRouteWindow: state.spec.context.trustedRouteWindow,
      ...(state.spec.context.configuredOperationalContextWindow === undefined
        ? {}
        : {
            configuredOperationalContextWindow: state.spec.context.configuredOperationalContextWindow,
          }),
      operationalContextWindow: state.spec.context.operationalContextWindow,
      ...(observedContextUpperBound === undefined ? {} : { observedContextUpperBound }),
      continuationReserveTokens,
      hardInputTokens,
      effectiveOperationalWindow,
      triggerTokens: Math.floor((effectiveOperationalWindow * policy.trigger_percentage) / 100),
      targetTokens: Math.floor((effectiveOperationalWindow * policy.target_percentage) / 100),
      source,
    }
  }

  #recordObservedContextUpperBound(state: RunState, failedInputTokens: number): number {
    return this.#recordObservedContextUpperBoundForRoute(state.spec.sessionID, state.spec.provider, failedInputTokens)
  }

  #recordObservedContextUpperBoundForRoute(sessionID: string, provider: string, failedInputTokens: number): number {
    const key = this.#contextRouteKeyFor(sessionID, provider)
    const capacity = this.#registry.contextCapacity(provider)
    const model = this.#registry.model(provider)
    const advertisedHardInputTokens = Math.max(
      1,
      capacity.trustedRouteWindow - Math.min(CONTEXT_CONTINUATION_RESERVE_TOKENS, model.maxTokens),
    )
    const current = Math.min(advertisedHardInputTokens, observedContextUpperBounds.get(key) ?? Number.POSITIVE_INFINITY)
    const learned = Math.max(1, Math.floor(failedInputTokens * 0.8))
    const next = Math.min(current, learned)
    observedContextUpperBounds.set(key, next)
    return next
  }

  #emitContextRotation(state: RunState, event: Omit<ContextRotationEvent, "type" | "runID">): void {
    this.#emit(state, {
      type: "context_rotation",
      runID: state.id,
      ...event,
    })
    if (event.state !== "started")
      this.#emitActivity(state, {
        kind: "status",
        text: JSON.stringify({
          contextCompaction: {
            state: event.state === "partial" ? "completed" : event.state,
            mode: event.mode,
            reason: event.reason ?? (event.state === "completed" ? "context_rotation" : "context_rotation_failed"),
            estimatedTokensBefore: event.estimatedTokensBefore,
            estimatedTokensAfter: event.estimatedTokensAfter,
            messagesRemoved: Math.max(0, event.sourceMessages - event.activeMessages),
            toolResultsVirtualized: event.toolResultsVirtualized,
            artifactsPreserved: event.artifactsPreserved,
            modelSummary: Boolean(event.checkpoint),
            ...(event.checkpoint ? { summaryArtifact: event.checkpoint.path } : {}),
            ...(event.detail ? { detail: event.detail } : {}),
          },
        }),
      })
  }

  // ── The Summarizer Produces Memory, Never Executes Work ─────────
  // A configured route receives a tool-free projection under the immutable
  // AgentRun system prompt. Context rejection permits one 50% source reduction;
  // a distinct active route may then make one final attempt. Every response is
  // charged to the run and recorded per attempt, but no security fallback or
  // tool surface is available. Persistence happens only after strict parsing.
  //
  // @docs/concepts/execution-model.md
  // ─────────────────────────────────────────────────────────────────
  async #modelContextCheckpoint(input: {
    readonly state: RunState
    readonly sourceMessages: readonly AgentMessage[]
    readonly deterministicMessages: readonly AgentMessage[]
    readonly generation: number
    readonly sourceEstimatedTokens: number
    readonly signal?: AbortSignal
  }): Promise<{
    readonly projection: SemanticProjection
    readonly attempts: readonly ContextRotationAttempt[]
  }> {
    const policy = Settings.compactionPolicy(this.#settings)
    const configuredProvider =
      policy.summarizer.provider === "inherit" ? input.state.spec.provider : policy.summarizer.provider
    const attempts: ContextRotationAttempt[] = []
    const plans: Array<{
      readonly provider: string
      readonly messages: readonly AgentMessage[]
      readonly reduced: boolean
    }> = [
      {
        provider: configuredProvider,
        messages: input.deterministicMessages,
        reduced: false,
      },
    ]
    let activeRouteQueued = configuredProvider === input.state.spec.provider
    let reducedRouteQueued = false
    const attestPayload = PiSystemWire.createOnPayload({ prompt: input.state.spec.prompt })

    while (plans.length > 0 && attempts.length < 3) {
      const plan = plans.shift()!
      const model = this.#registry.model(plan.provider)
      const reasoning = PiReasoning.resolve(policy.summarizer.reasoning_effort, model)
      const adapter = this.#registry.adapter(plan.provider)
      const source = plan.messages.filter(
        (message): message is UserMessage | AssistantMessage | ToolResultMessage =>
          message.role === "user" || message.role === "assistant" || message.role === "toolResult",
      )
      const checkpointMessages = [...source, modelCheckpointRequest()]
      const sourceEstimatedTokens = estimateAgentContextTokens({
        systemPrompt: input.state.spec.prompt.system,
        messages: checkpointMessages,
        tools: [],
      })
      const limit = input.state.spec.budget.maxOutputTokens
      const remainingOutput =
        limit === undefined ? MODEL_SUMMARY_MAX_TOKENS : limit - input.state.cumulativeUsage.output
      if (remainingOutput < 512)
        throw new Error("insufficient AgentRun output budget for a model-assisted context checkpoint")

      let response: AssistantMessage
      try {
        const stream = await this.#streamFn(
          model,
          {
            systemPrompt: input.state.spec.prompt.system,
            messages: checkpointMessages,
            tools: [],
          },
          {
            signal: input.signal,
            maxTokens: Math.min(MODEL_SUMMARY_MAX_TOKENS, model.maxTokens, remainingOutput),
            maxRetries: 0,
            sessionId: `${input.state.spec.sessionID}:${input.state.id}:context-rotation:${input.generation}:${attempts.length + 1}`,
            ...(reasoning.effective === "off" ? {} : { reasoning: reasoning.effective }),
            onPayload: (payload, streamedModel) => {
              const attested = attestPayload(payload, streamedModel)
              return this.#onPayload?.(attested, input.state.spec.prompt.system, adapter) ?? attested
            },
            onResponse: (httpResponse) => {
              input.state.lastHTTPStatus = httpResponse.status
            },
          },
        )
        response = await stream.result()
      } catch (error) {
        const failure = PiSecurity.classify({
          adapter,
          provider: plan.provider,
          model: model.id,
          upstream: error,
        })
        const isContextError = failure?.kind === "capacity" && failure.providerCode === "context_length_exceeded"
        if (isContextError)
          this.#recordObservedContextUpperBoundForRoute(
            input.state.spec.sessionID,
            plan.provider,
            sourceEstimatedTokens,
          )
        attempts.push({
          attempt: attempts.length + 1,
          provider: plan.provider,
          model: model.id,
          sourceMessages: source.length,
          sourceEstimatedTokens,
          outcome: isContextError ? "context_error" : "failed",
          detail: boundedFailureDetail(error instanceof Error ? error.message : String(error)),
        })
        if (isContextError && plan.provider === configuredProvider && !plan.reduced && !reducedRouteQueued) {
          plans.unshift({
            provider: plan.provider,
            messages: reducedCheckpointSource(input.deterministicMessages),
            reduced: true,
          })
          reducedRouteQueued = true
        } else if (!activeRouteQueued && plan.provider !== input.state.spec.provider) {
          plans.push({
            provider: input.state.spec.provider,
            messages: input.deterministicMessages,
            reduced: false,
          })
          activeRouteQueued = true
        }
        continue
      }

      this.#recordProviderUsage(input.state, {
        usage: response.usage,
        provider: plan.provider,
        model: model.id,
        reasoningRequested: policy.summarizer.reasoning_effort,
        reasoningEffective: reasoning.effective,
        callKind: "context-summary",
        status:
          response.stopReason === "error" ? "failed" : response.stopReason === "aborted" ? "cancelled" : "completed",
        attempt: attempts.length + 1,
      })
      input.state.cumulativeUsage = addUsage(input.state.cumulativeUsage, response.usage)
      const failure = PiSecurity.classify(
        providerObservation(adapter, plan.provider, model.id, response, input.state.lastHTTPStatus),
      )
      const isContextError = failure?.kind === "capacity" && failure.providerCode === "context_length_exceeded"
      const usage = agentRunUsage(response.usage)
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        if (isContextError)
          this.#recordObservedContextUpperBoundForRoute(
            input.state.spec.sessionID,
            plan.provider,
            sourceEstimatedTokens,
          )
        attempts.push({
          attempt: attempts.length + 1,
          provider: plan.provider,
          model: model.id,
          sourceMessages: source.length,
          sourceEstimatedTokens,
          outcome: isContextError ? "context_error" : "failed",
          usage,
          detail:
            boundedFailureDetail(response.errorMessage) ??
            `model-assisted context checkpoint stopped with '${response.stopReason}'`,
        })
        if (isContextError && plan.provider === configuredProvider && !plan.reduced && !reducedRouteQueued) {
          plans.unshift({
            provider: plan.provider,
            messages: reducedCheckpointSource(input.deterministicMessages),
            reduced: true,
          })
          reducedRouteQueued = true
        } else if (!activeRouteQueued && plan.provider !== input.state.spec.provider) {
          plans.push({
            provider: input.state.spec.provider,
            messages: input.deterministicMessages,
            reduced: false,
          })
          activeRouteQueued = true
        }
        continue
      }

      try {
        const checkpoint = parseModelCheckpoint({
          text: assistantText(response),
          sourceMessages: source,
          sanitize: PiAudit.redactText,
        })
        const projection = await persistModelCheckpoint({
          checkpoint,
          workarea: input.state.spec.workarea,
          runID: input.state.id,
          generation: input.generation,
          sourceMessageCount: input.sourceMessages.length,
          sourceEstimatedTokens: input.sourceEstimatedTokens,
          provider: plan.provider,
          model: model.id,
          reasoningEffort: policy.summarizer.reasoning_effort,
        })
        attempts.push({
          attempt: attempts.length + 1,
          provider: plan.provider,
          model: model.id,
          sourceMessages: source.length,
          sourceEstimatedTokens,
          outcome: "completed",
          usage,
        })
        return {
          projection,
          attempts,
        }
      } catch (error) {
        attempts.push({
          attempt: attempts.length + 1,
          provider: plan.provider,
          model: model.id,
          sourceMessages: source.length,
          sourceEstimatedTokens,
          outcome: "failed",
          usage,
          detail: boundedFailureDetail(error instanceof Error ? error.message : String(error)),
        })
        if (!activeRouteQueued && plan.provider !== input.state.spec.provider) {
          plans.push({
            provider: input.state.spec.provider,
            messages: input.deterministicMessages,
            reduced: false,
          })
          activeRouteQueued = true
        }
      }
    }
    const last = attempts.at(-1)
    throw new ContextCheckpointError(last?.detail ?? "all model-assisted context checkpoint attempts failed", attempts)
  }

  async #transformContext(
    state: RunState,
    messages: AgentMessage[],
    initialTools: readonly AgentTool[],
    signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const tools = state.agent?.state.tools ?? [...initialTools]
    const mode: ContextCompactionMode = state.contextCompactionEmergency ? "emergency" : "proactive"
    const policy = Settings.compactionPolicy(this.#settings)
    const installed = state.contextInstalledHistory
    const activeMessages =
      installed && installed.sourceMessageCount <= messages.length
        ? [...installed.messages, ...messages.slice(installed.sourceMessageCount)]
        : messages
    let providerMessages = projectAgentContext(activeMessages, state.contextProjections, mode)
    let estimatedTokens = estimateAgentContextTokens({
      systemPrompt: state.spec.prompt.system,
      messages: providerMessages,
      tools,
    })
    if (
      mode === "proactive" &&
      policy.enabled &&
      hasLargeHistoricalToolResult(activeMessages, state.contextProjections)
    ) {
      const eager = await compactAgentContext({
        need: {
          mode: "proactive",
          estimatedTokensBefore: estimatedTokens,
          triggerTokens: estimatedTokens,
          targetTokens: 0,
        },
        messages: activeMessages,
        systemPrompt: state.spec.prompt.system,
        tools,
        workarea: state.spec.workarea,
        runID: state.id,
        artifacts: state.contextArtifacts,
        projections: state.contextProjections,
        signal,
        minimumBytes: EAGER_VIRTUALIZATION_BYTES,
        excludeLatestToolResult: true,
      })
      providerMessages = eager.messages
      estimatedTokens = estimateAgentContextTokens({
        systemPrompt: state.spec.prompt.system,
        messages: providerMessages,
        tools,
      })
      if (eager.toolResultsVirtualized > 0)
        this.#emitContextCompaction(state, "completed", "proactive", {
          ...eager,
          estimatedTokensAfter: estimatedTokens,
        })
    }
    state.lastProviderInputEstimate = estimatedTokens
    const limits = this.#contextLimits(state)
    const need = contextCompactionNeed({
      mode,
      policy,
      operationalContextWindow: limits.effectiveOperationalWindow,
      estimatedTokens,
    })
    if (!need) return providerMessages

    const userMessageCount = activeMessages.filter(
      (message) =>
        message.role === "user" &&
        !(
          typeof message.content === "string" && message.content.startsWith("[Host-owned semantic context checkpoint]")
        ),
    ).length
    const watermark = state.contextRotationWatermark
    if (
      mode === "proactive" &&
      watermark !== undefined &&
      watermark.userMessages === userMessageCount &&
      estimatedTokens < watermark.estimatedTokens + 8_192
    )
      return providerMessages

    const generation = state.contextRotationGeneration + 1
    const summarizerProvider =
      policy.summarizer.provider === "inherit" ? state.spec.provider : policy.summarizer.provider
    const summarizerModel = this.#registry.model(summarizerProvider)
    const eventBase = {
      mode,
      generation,
      provider: state.spec.provider,
      model: state.spec.model.id,
      summarizerProvider,
      summarizerModel: summarizerModel.id,
      summarizerReasoningEffort: policy.summarizer.reasoning_effort,
      limits,
      estimatedTokensBefore: estimatedTokens,
      sourceMessages: activeMessages.length,
      summarizedMessages: 0,
      splitTurn: false,
    } as const

    if (!policy.model_summary) {
      state.contextRotationWatermark = {
        estimatedTokens,
        userMessages: userMessageCount,
      }
      this.#emitContextRotation(state, {
        ...eventBase,
        state: "failed",
        estimatedTokensAfter: estimatedTokens,
        activeMessages: activeMessages.length,
        toolResultsVirtualized: 0,
        artifactsPreserved: 0,
        attempts: [],
        reason: "disabled_model_summary",
        detail:
          "model_summary=false preserves deterministic tool-result archival only; active history may exhaust the provider context",
      })
      return providerMessages
    }

    this.#emitContextRotation(state, {
      ...eventBase,
      state: "started",
      estimatedTokensAfter: estimatedTokens,
      activeMessages: activeMessages.length,
      toolResultsVirtualized: 0,
      artifactsPreserved: 0,
      attempts: [],
    })

    let deterministicResult: ContextCompactionResult | undefined
    try {
      const result = await compactAgentContext({
        need,
        messages: activeMessages,
        systemPrompt: state.spec.prompt.system,
        tools,
        workarea: state.spec.workarea,
        runID: state.id,
        artifacts: state.contextArtifacts,
        projections: state.contextProjections,
        signal,
      })
      if (result.outcome === "failed" || result.outcome === "aborted") {
        throw new ContextCheckpointError(`deterministic context archival ${result.reason}`, [])
      }
      deterministicResult = result
      state.contextInstalledHistory = {
        sourceMessageCount: messages.length,
        messages: result.messages,
      }
      const deterministicAgent = state.agent
      if (!deterministicAgent) throw new Error("context rotation lost its active AgentRun")
      deterministicAgent.state.messages = result.messages
      state.lastProviderInputEstimate = estimateAgentContextTokens({
        systemPrompt: state.spec.prompt.system,
        messages: result.messages,
        tools,
      })

      const semantic = await this.#modelContextCheckpoint({
        state,
        sourceMessages: activeMessages,
        deterministicMessages: result.messages,
        generation,
        sourceEstimatedTokens: estimatedTokens,
        signal,
      })
      const checkpointTokens = estimateAgentContextTokens({
        systemPrompt: state.spec.prompt.system,
        messages: [semantic.projection.message],
        tools,
      })
      const recentTokenLimit = Math.max(0, need.targetTokens - checkpointTokens)
      const history = buildRotationHistory({
        messages: result.messages,
        checkpoint: semantic.projection.message,
        recentTokenLimit,
      })
      const estimatedTokensAfter = estimateAgentContextTokens({
        systemPrompt: state.spec.prompt.system,
        messages: history.messages,
        tools,
      })
      state.recoveryCheckpoint = semantic.projection.artifact

      if (estimatedTokensAfter >= limits.hardInputTokens) {
        state.contextRotationWatermark = {
          estimatedTokens,
          userMessages: userMessageCount,
        }
        this.#emitContextRotation(state, {
          ...eventBase,
          limits: this.#contextLimits(state),
          state: "failed",
          estimatedTokensAfter,
          activeMessages: history.activeMessages,
          summarizedMessages: history.summarizedMessages,
          splitTurn: history.splitTurn,
          toolResultsVirtualized: result.toolResultsVirtualized,
          artifactsPreserved: result.artifactsPreserved + 1,
          checkpoint: semantic.projection.artifact,
          attempts: semantic.attempts,
          reason: "active_tail_too_large",
          detail: `Rotated input estimate ${estimatedTokensAfter} reached the hard input limit ${limits.hardInputTokens}.`,
        })
        throw new ContextCapacityError(
          `active_tail_too_large: rotated input estimate ${estimatedTokensAfter} reaches hard input limit ${limits.hardInputTokens}`,
        )
      }

      const rotationState = estimatedTokensAfter > need.targetTokens ? ("partial" as const) : ("completed" as const)
      const activeAgent = state.agent
      if (!activeAgent) throw new Error("context rotation lost its active AgentRun")
      activeAgent.state.messages = history.messages
      state.contextInstalledHistory = {
        sourceMessageCount: messages.length,
        messages: history.messages,
      }
      state.contextRotationGeneration = generation
      const rotatedUserMessageCount = history.messages.slice(1).filter((message) => message.role === "user").length
      state.contextRotationWatermark =
        rotationState === "partial"
          ? {
              estimatedTokens: estimatedTokensAfter,
              userMessages: rotatedUserMessageCount,
            }
          : undefined
      state.lastProviderInputEstimate = estimatedTokensAfter
      this.#emitContextRotation(state, {
        ...eventBase,
        limits: this.#contextLimits(state),
        state: rotationState,
        estimatedTokensAfter,
        activeMessages: history.activeMessages,
        summarizedMessages: history.summarizedMessages,
        splitTurn: history.splitTurn,
        toolResultsVirtualized: result.toolResultsVirtualized,
        artifactsPreserved: result.artifactsPreserved + 1,
        checkpoint: semantic.projection.artifact,
        attempts: semantic.attempts,
        ...(rotationState === "partial" ? { reason: "target_unreachable" as const } : {}),
      })
      return history.messages
    } catch (error) {
      if (error instanceof ContextCapacityError) throw error
      state.contextRotationWatermark = {
        estimatedTokens,
        userMessages: userMessageCount,
      }
      const attempts = error instanceof ContextCheckpointError ? error.attempts : []
      if (deterministicResult && state.agent) {
        try {
          const checkpoint = await persistDeterministicCheckpoint({
            checkpoint: deterministicContextCheckpoint(state, deterministicResult.messages),
            workarea: state.spec.workarea,
            runID: state.id,
            generation,
            sourceMessageCount: deterministicResult.messages.length,
            sourceEstimatedTokens: estimatedTokens,
          })
          const checkpointTokens = estimateAgentContextTokens({
            systemPrompt: state.spec.prompt.system,
            messages: [checkpoint.message],
            tools,
          })
          const history = buildRotationHistory({
            messages: deterministicResult.messages,
            checkpoint: checkpoint.message,
            recentTokenLimit: Math.max(0, need.targetTokens - checkpointTokens),
          })
          const estimatedTokensAfter = estimateAgentContextTokens({
            systemPrompt: state.spec.prompt.system,
            messages: history.messages,
            tools,
          })
          state.agent.state.messages = history.messages
          state.contextInstalledHistory = {
            sourceMessageCount: messages.length,
            messages: history.messages,
          }
          state.contextRotationGeneration = generation
          state.lastProviderInputEstimate = estimatedTokensAfter
          state.recoveryCheckpoint = checkpoint.artifact
          state.contextRotationWatermark = {
            estimatedTokens: Math.max(estimatedTokens, estimatedTokensAfter),
            userMessages: userMessageCount,
          }
          this.#emitContextRotation(state, {
            ...eventBase,
            limits: this.#contextLimits(state),
            state: estimatedTokensAfter < limits.hardInputTokens ? "partial" : "failed",
            estimatedTokensAfter,
            activeMessages: history.activeMessages,
            summarizedMessages: history.summarizedMessages,
            splitTurn: history.splitTurn,
            toolResultsVirtualized: deterministicResult.toolResultsVirtualized,
            artifactsPreserved: deterministicResult.artifactsPreserved + 1,
            checkpoint: checkpoint.artifact,
            attempts,
            reason: "summary_failed",
            detail: boundedFailureDetail(error instanceof Error ? error.message : String(error)),
          })
          return history.messages
        } catch (fallbackError) {
          const installed = estimateAgentContextTokens({
            systemPrompt: state.spec.prompt.system,
            messages: deterministicResult.messages,
            tools,
          })
          state.lastProviderInputEstimate = installed
          state.contextInstalledHistory = {
            sourceMessageCount: messages.length,
            messages: deterministicResult.messages,
          }
          state.contextRotationWatermark = {
            estimatedTokens: Math.max(estimatedTokens, installed),
            userMessages: userMessageCount,
          }
          this.#emitContextRotation(state, {
            ...eventBase,
            limits: this.#contextLimits(state),
            state: "failed",
            estimatedTokensAfter: installed,
            activeMessages: deterministicResult.messages.length,
            toolResultsVirtualized: deterministicResult.toolResultsVirtualized,
            artifactsPreserved: deterministicResult.artifactsPreserved,
            attempts,
            reason: "summary_failed",
            detail: boundedFailureDetail(
              `${error instanceof Error ? error.message : String(error)}; deterministic checkpoint persistence failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
            ),
          })
          return deterministicResult.messages
        }
      }
      this.#emitContextRotation(state, {
        ...eventBase,
        limits: this.#contextLimits(state),
        state: "failed",
        estimatedTokensAfter: estimatedTokens,
        activeMessages: activeMessages.length,
        toolResultsVirtualized: 0,
        artifactsPreserved: 0,
        attempts,
        reason: "summary_failed",
        detail: boundedFailureDetail(error instanceof Error ? error.message : String(error)),
      })
      return providerMessages
    } finally {
      state.contextCompactionEmergency = false
    }
  }

  #contextRecoveryKey(state: RunState, failure: Failure | undefined): string | undefined {
    if (
      !Settings.compactionPolicy(this.#settings).enabled ||
      state.contextRecoveryAttempted ||
      failure?.kind !== "capacity" ||
      failure.providerCode !== "context_length_exceeded"
    )
      return
    const agent = state.agent
    const messages = agent?.state.messages
    if (!agent || !messages || messages.at(-1)?.role !== "assistant") return
    const retained = messages.slice(0, -1)
    const last = retained.at(-1)
    const estimated = estimateAgentContextTokens({
      systemPrompt: state.spec.prompt.system,
      messages: retained,
      tools: agent.state.tools,
    })
    return [
      retained.length,
      last?.role ?? "none",
      "timestamp" in (last ?? {}) ? String(last?.timestamp) : "none",
      estimated,
    ].join(":")
  }

  async #recoverContextFailure(
    state: RunState,
    failure: Failure | undefined,
  ): Promise<{ readonly attempted: boolean; readonly failure: Failure | undefined }> {
    const key = this.#contextRecoveryKey(state, failure)
    if (!key || state.contextRecoveryKeys.has(key) || state.cancellation || this.#remainingBudget(state) <= 0)
      return { attempted: false, failure }
    const agent = state.agent
    if (!agent) return { attempted: false, failure }

    state.contextRecoveryKeys.add(key)
    state.contextRecoveryAttempted = true
    const failedInputTokens =
      state.lastProviderInputEstimate ??
      estimateAgentContextTokens({
        systemPrompt: state.spec.prompt.system,
        messages: agent.state.messages.slice(0, -1),
        tools: agent.state.tools,
      })
    this.#recordObservedContextUpperBound(state, failedInputTokens)
    agent.state.messages = agent.state.messages.slice(0, -1)
    state.contextCompactionEmergency = true
    state.contextRecoveryProviderCallsRemaining = 1
    state.lastHTTPStatus = undefined
    state.providerCallKind = "recovery"
    try {
      await agent.continue()
    } catch (error) {
      return {
        attempted: true,
        failure: {
          kind: "capacity",
          providerCode: "context_rotation_failed",
          detail: boundedFailureDetail(error instanceof Error ? error.message : String(error)),
          retryable: false,
        },
      }
    } finally {
      state.contextRecoveryProviderCallsRemaining = undefined
      if (state.providerCallKind === "recovery") state.providerCallKind = "generation"
    }

    const next = this.#retryFailure(state, latestAssistant(agent.state.messages))
    if (next?.kind === "capacity" && next.providerCode === "context_length_exceeded")
      return {
        attempted: true,
        failure: {
          kind: "capacity",
          providerCode: "context_rotation_failed",
          detail:
            boundedFailureDetail(latestAssistant(agent.state.messages)?.errorMessage) ??
            "The provider rejected the single post-rotation recovery generation.",
          retryable: false,
        },
      }
    return { attempted: true, failure: next }
  }

  #retryDelayMs(attempt: number): number {
    const policy = Settings.retryPolicy(this.#settings)
    const ceiling = Math.min(policy.max_delay_ms, policy.base_delay_ms * 2 ** Math.max(0, attempt - 1))
    const draw = Math.min(1, Math.max(0, this.#random()))
    return Math.min(ceiling, Math.floor(draw * (ceiling + 1)))
  }

  #toolSet(state: RunState): AgentTool[] {
    const gatewayTools =
      state.spec.gatewayTools?.({
        id: state.id,
        role: state.spec.role,
        ...(state.spec.parentID ? { parentID: state.spec.parentID } : {}),
        ...(state.spec.identity ? { identity: state.spec.identity } : {}),
        handoffOwner: state.spec.handoffOwner,
        providerAffinity: state.spec.providerAffinity,
      }) ?? []
    const hostTools = [...state.spec.tools].filter(
      (tool) =>
        (state.spec.handoffOwner || tool.name !== "handoff") &&
        (state.spec.providerAffinity === "main" || tool.name !== "request_fallback_delegation"),
    )
    const eligibleGatewayTools = gatewayTools.filter(
      (tool) =>
        (state.spec.handoffOwner || tool.name !== "handoff") &&
        (state.spec.providerAffinity === "main" || tool.name !== "request_fallback_delegation"),
    )
    const allTools = [...hostTools, ...eligibleGatewayTools]
    const reserved = new Set([
      "delegate_task",
      "delegation_status",
      "request_fallback_delegation",
      "tool_search",
      "workarea_read",
      "workarea_write",
      "workarea_list",
      "evidence_manifest",
    ])
    for (const tool of allTools)
      if (reserved.has(tool.name)) throw new Error(`AgentRun tool name '${tool.name}' is reserved by Cyberful`)

    const names = new Set<string>()
    for (const tool of allTools) {
      if (names.has(tool.name)) throw new Error(`AgentRun exposes duplicate tool '${tool.name}'`)
      names.add(tool.name)
    }

    const immediate = [
      this.#workareaReadTool(state),
      this.#workareaListTool(state),
      this.#evidenceManifestTool(state),
      ...hostTools.filter((tool) => (tool as CatalogAgentTool).deferLoading !== true),
      ...eligibleGatewayTools.filter((tool) => tool.name === "handoff"),
    ]
    if (state.spec.task.outputArtifact ?? state.spec.task.artifacts?.[0]) immediate.push(this.#workareaWriteTool(state))
    const deferred = [
      ...hostTools.filter((tool) => (tool as CatalogAgentTool).deferLoading === true),
      ...eligibleGatewayTools.filter((tool) => tool.name !== "handoff"),
    ].toSorted((left, right) => left.name.localeCompare(right.name))

    if (state.spec.delegation.enabled && state.spec.prompt.manifest.delegationEnabled) {
      immediate.push(this.#delegateTool(state), this.#delegationStatusTool(state))
    }
    if (
      state.spec.providerAffinity === "main" &&
      state.spec.fallback.providerConfigured &&
      state.spec.fallback.proactiveEnabled
    ) {
      immediate.push(this.#fallbackTool(state))
    }
    if (deferred.length > 0) immediate.push(this.#toolSearchTool(state, deferred))
    return immediate
  }

  // ── Closeout Reads Stay Inside The Canonical Workarea ─────────
  // Delegated output is durable only if a closing AgentRun can inspect it
  // after research-capable tools have been withdrawn. This host-owned reader
  // uses the same canonical, no-symlink boundary as artifact expansion and
  // exposes bounded pages without granting shell, browser, or target access.
  // It is loaded eagerly so entering closeout never depends on tool discovery.
  //
  // @docs/concepts/execution-model.md
  // ─────────────────────────────────────────────────────────────────
  #workareaReadTool(state: RunState): AgentTool<typeof WorkareaReadParameters> {
    return {
      name: "workarea_read",
      label: "Read Workarea Artifact",
      description:
        "Read one bounded UTF-8 page from an existing regular file inside the current canonical workarea. Relative paths only; symlinks and escapes are rejected. Safe during closeout for output_artifact and local evidence reconciliation.",
      parameters: WorkareaReadParameters,
      executionMode: "sequential",
      execute: async (_callID, input) => {
        const chunk = await readWorkareaFileChunk(state.spec.workarea, input.path, {
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                path: input.path,
                content: chunk.content,
                offset: chunk.offset,
                end: chunk.end,
                total: chunk.total,
                ...(chunk.nextOffset === undefined ? {} : { next_offset: chunk.nextOffset }),
              }),
            },
          ],
          details: {
            hostOwned: true,
            path: input.path,
            offset: chunk.offset,
            end: chunk.end,
            total: chunk.total,
            nextOffset: chunk.nextOffset,
          },
        }
      },
    }
  }

  #workareaListTool(state: RunState): AgentTool<typeof WorkareaListParameters> {
    return {
      name: "workarea_list",
      label: "List Workarea Artifacts",
      description:
        "Discover regular workarea files by bounded directory prefix, wildcard pattern, depth, and result count. Symlinks and special files are never followed or returned.",
      parameters: WorkareaListParameters,
      executionMode: "sequential",
      execute: async (_callID, input) => {
        const result = await listWorkareaFiles(state.spec.workarea, {
          ...(input.prefix === undefined ? {} : { prefix: input.prefix }),
          ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
          ...(input.max_depth === undefined ? {} : { maxDepth: input.max_depth }),
          ...(input.limit === undefined ? {} : { maxResults: input.limit }),
        })
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { hostOwned: true, files: result.files.length, truncated: result.truncated },
        }
      },
    }
  }

  #evidenceManifestTool(state: RunState): AgentTool<typeof EvidenceManifestParameters> {
    return {
      name: "evidence_manifest",
      label: "Manage Evidence Manifest",
      description:
        "Create or verify a deterministic EVIDENCE.sha256 for one workarea directory. Entries are sorted relative regular files; the manifest and temporary files exclude themselves.",
      parameters: EvidenceManifestParameters,
      executionMode: "sequential",
      execute: async (_callID, input) => {
        const directory = input.directory ?? "."
        const result = input.command === "create"
          ? await createEvidenceManifest(state.spec.workarea, directory)
          : await verifyEvidenceManifest(state.spec.workarea, directory)
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { hostOwned: true, command: input.command, ...result },
        }
      },
    }
  }

  // ── Closeout Writes One Declared Deliverable Atomically ────────
  // The writer is intentionally narrower than shell access: one eager tool may
  // replace only the exact deliverable declared by the host. The shared
  // workarea primitive rejects links and escapes, writes an unpredictable
  // sibling with owner-only permissions, flushes it, and renames it atomically.
  // This remains available after research tools are disabled for closeout.
  //
  // @docs/concepts/execution-model.md
  // ────────────────────────────────────────────────────────────────
  #workareaWriteTool(state: RunState): AgentTool<typeof WorkareaWriteParameters> {
    const deliverable = delegatedArtifact(state.spec.task.outputArtifact ?? state.spec.task.artifacts?.[0] ?? "")
    return {
      name: "workarea_write",
      label: "Write AgentRun Deliverable",
      description:
        `Atomically replace the complete declared deliverable '${deliverable}' inside the canonical workarea. ` +
        "No other path is accepted. Safe during closeout; symlinks, escapes, and special files are rejected.",
      parameters: WorkareaWriteParameters,
      executionMode: "sequential",
      execute: async (_callID, input) => {
        const requested = delegatedArtifact(input.path)
        if (requested !== deliverable)
          throw new Error(`workarea_write may replace only the declared deliverable '${deliverable}'`)
        const content = Buffer.from(input.content, "utf8")
        if (content.byteLength > WORKAREA_WRITE_BYTES)
          throw new Error(`workarea_write content exceeds ${WORKAREA_WRITE_BYTES} UTF-8 bytes`)
        await replaceWorkareaFile(state.spec.workarea, deliverable, content, { mode: 0o600 })
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                path: deliverable,
                bytes: content.byteLength,
                sha256: createHash("sha256").update(content).digest("hex"),
              }),
            },
          ],
          details: {
            hostOwned: true,
            atomic: true,
            path: deliverable,
            bytes: content.byteLength,
          },
        }
      },
    }
  }

  #toolSearchTool(state: RunState, catalog: readonly AgentTool[]): AgentTool<typeof ToolSearchParameters> {
    const loaded = new Set<string>()
    return {
      name: "tool_search",
      label: "Search Cyberful Tools",
      description:
        'Search and load any authorized Cyberful/MCP tool by name or capability. No tool is excluded: use query "*" with the returned cursor to enumerate the full catalog.',
      parameters: ToolSearchParameters,
      executionMode: "sequential",
      execute: async (_callID, input) => {
        const offset = input.cursor === undefined ? 0 : Number(input.cursor)
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("tool_search cursor is invalid")
        const query = input.query.trim()
        const candidates =
          query === "*"
            ? [...catalog]
            : catalog
                .flatMap((tool) => {
                  const score = toolSearchScore(tool, query)
                  return score === undefined ? [] : [{ tool, score }]
                })
                .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
                .map((candidate) => candidate.tool)
        const limit = input.limit ?? 8
        const page = candidates.slice(offset, offset + limit)
        const additions = page.filter((tool) => !loaded.has(tool.name))
        const agent = state.agent
        if (!agent) throw new Error("tool_search requires an active AgentRun")
        if (additions.length > 0) {
          const activeNames = new Set(agent.state.tools.map((tool) => tool.name))
          agent.state.tools = [...agent.state.tools, ...additions.filter((tool) => !activeNames.has(tool.name))]
          additions.forEach((tool) => loaded.add(tool.name))
        }
        const nextOffset = offset + page.length
        const nextCursor = nextOffset < candidates.length ? String(nextOffset) : undefined
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                query,
                total: candidates.length,
                results: page.map((tool) => ({
                  name: tool.name,
                  label: tool.label,
                  description: compactToolDescription(tool.description),
                  loaded: true,
                })),
                ...(nextCursor ? { next_cursor: nextCursor } : {}),
              }),
            },
          ],
          details: {
            query,
            total: candidates.length,
            returned: page.length,
            nextCursor,
          },
          addedToolNames: additions.map((tool) => tool.name),
        }
      },
    }
  }

  #skillName(state: RunState, locator: string): string | undefined {
    const resolved = path.resolve(locator)
    return state.spec.skills.find((skill) => skill.name === locator || path.resolve(skill.location) === resolved)?.name
  }

  #delegateTool(state: RunState): AgentTool<ReturnType<typeof delegateTaskParameters>> {
    const parameters = delegateTaskParameters(state.spec.delegation.reasoningEfforts)
    return {
      name: "delegate_task",
      label: "Delegate Cyberful Task",
      description:
        "Create one complete child AgentRun for a bounded subtask. The child receives the full Cyberful contract, persona, skills, and phase tools but not this transcript. Omission uses xhigh; select medium explicitly only for deterministic evidence work.",
      parameters,
      execute: async (callID, input, signal) => {
        const requestedReasoning = input.reasoning_effort
        const selectedReasoning =
          requestedReasoning === undefined
            ? state.spec.delegation.defaultReasoningEffort
            : state.spec.delegation.reasoningEfforts.find((effort) => effort === requestedReasoning)
        if (!selectedReasoning) {
          throw new Error(
            `reasoning_effort_not_allowed: choose one of ${state.spec.delegation.reasoningEfforts.join(", ")}`,
          )
        }
        await this.#waitForChildCapacity(state, signal)
        const outputArtifact = delegatedArtifact(input.output_artifact)
        const child = await this.#startChild(state, {
          role: "subagent",
          route: state.spec.providerAffinity,
          task: taskCapsule({
            task: input.task,
            expected_result: input.expected_result,
            context: input.context,
            artifacts: input.artifacts,
            outputArtifact,
          }),
          sourceCallID: callID,
          reasoningEffort: selectedReasoning,
          reasoningSelection: requestedReasoning === undefined ? "default" : "parent",
          proposedIdentity: {
            displayName: input.display_name,
            emoji: input.emoji,
          },
        })
        const initialChildState = this.#states.get(child.id)
        const initialDeadlineAt = initialChildState?.spec.budget.deadlineAt
        const initialOutputBudget = initialChildState?.spec.budget.maxOutputTokens
        const initialResult = await child.result
        let result = initialResult
        const contextRecovery =
          initialResult.failure?.kind === "capacity" &&
          initialResult.failure.providerCode === "context_rotation_failed" &&
          initialResult.recoveryCheckpoint !== undefined
        const recoveryPolicy = Settings.phaseRecoveryPolicy(this.#settings)
        const fallbackRecovery =
          initialResult.providerAffinity === "main" &&
          initialResult.failure?.retryable === true &&
          recoveryPolicy.enabled &&
          recoveryPolicy.use_fallback_provider &&
          state.spec.fallback.providerConfigured
        if (!initialResult.recoveryOf && initialDeadlineAt !== undefined && (contextRecovery || fallbackRecovery)) {
          const remainingRuntimeMs = Math.min(initialDeadlineAt - this.#now(), this.#remainingBudget(state))
          const remainingOutputTokens =
            initialOutputBudget === undefined
              ? undefined
              : Math.max(0, initialOutputBudget - initialResult.usage.output)
          if (remainingRuntimeMs >= 1_000 && (remainingOutputTokens === undefined || remainingOutputTokens >= 512)) {
            const recoveryContext = [
              initialChildState?.spec.task.context,
              `Host-owned context recovery of AgentRun ${initialResult.id}.`,
              initialResult.recoveryCheckpoint
                ? `Read deterministic checkpoint ${initialResult.recoveryCheckpoint.path} (sha256 ${initialResult.recoveryCheckpoint.sha256}).`
                : "Reconcile the existing workarea and durable registries before continuing unfinished work.",
              initialResult.recoveredHypotheses.length > 0
                ? `Recovered hypothesis IDs: ${initialResult.recoveredHypotheses.map((item) => item.id).join(", ")}.`
                : undefined,
              initialResult.recoveredTestObjects.length > 0
                ? `Recovered test-object IDs: ${initialResult.recoveredTestObjects.map((item) => item.id).join(", ")}.`
                : undefined,
              "Do not automatically replay completed tool calls. Reuse durable evidence and continue only unfinished work.",
            ]
              .filter((value): value is string => Boolean(value))
              .join("\n\n")
              .slice(0, 12_000)
            try {
              const recovery = await this.#startChild(state, {
                role: "subagent",
                route: fallbackRecovery ? "fallback" : initialResult.providerAffinity,
                task: {
                  ...initialChildState?.spec.task,
                  objective: initialChildState?.spec.task.objective ?? input.task,
                  context: recoveryContext,
                  outputArtifact,
                },
                sourceCallID: callID,
                reasoningEffort: initialResult.reasoningEffort,
                reasoningSelection: initialResult.reasoningSelection ?? "default",
                recoveryOf: initialResult.id,
                recoveryDeadlineAt: initialDeadlineAt,
                ...(remainingOutputTokens === undefined ? {} : { recoveryOutputTokens: remainingOutputTokens }),
                proposedIdentity: initialResult.identity,
              })
              result = await recovery.result
            } catch (error) {
              this.#emitActivity(state, {
                kind: "status",
                text: `AgentRun recovery child could not start: ${boundedFailureDetail(
                  error instanceof Error ? error.message : String(error),
                )}`,
              })
            }
          } else {
            this.#emitActivity(state, {
              kind: "status",
              text: `AgentRun recovery child not started: residual budget is insufficient (${Math.max(0, Math.round(remainingRuntimeMs))} ms, ${remainingOutputTokens ?? "unbounded"} output tokens).`,
            })
          }
        }
        const artifact = await readWorkareaFileChunk(state.spec.workarea, outputArtifact, { limit: 1 })
          .then((file) => ({ path: outputArtifact, available: true, bytes: file.total }))
          .catch(() => ({ path: outputArtifact, available: false, bytes: 0 }))
        return {
          content: [
            {
              type: "text",
              text: [
                `Child AgentRun ${result.id} ${result.termination}.`,
                ...(result.recoveryOf
                  ? [`Recovery of ${result.recoveryOf}; original termination was ${initialResult.termination}.`]
                  : []),
                `Durable output: ${outputArtifact} (${artifact.available ? `${artifact.bytes} bytes` : "not created"}).`,
                result.recoveredHypotheses.length > 0
                  ? `Recovered hypotheses: ${result.recoveredHypotheses
                      .map((item) => `${item.id}${item.nextStep ? ` → ${item.nextStep}` : ""}`)
                      .join("; ")}.`
                  : "Recovered hypotheses: none.",
                result.recoveredTestObjects.length > 0
                  ? `Recovered test objects: ${result.recoveredTestObjects
                      .map(
                        (item) =>
                          `${item.id} (${item.state})${item.evidencePath && item.evidenceExists === false ? ` — missing evidence '${item.evidencePath}'` : ""}`,
                      )
                      .join("; ")}.`
                  : "Recovered test objects: none.",
                result.recoverySummary
                  ? [
                      `Automatic pre-abort summary (${result.recoverySummary.termination}):`,
                      result.recoverySummary.narrative ?? "No public assistant narrative was available.",
                      ...(result.recoverySummary.path ? [`Preserved at ${result.recoverySummary.path}.`] : []),
                    ].join("\n")
                  : "Automatic pre-abort summary: not required.",
                result.output || "The child returned no textual result.",
              ].join("\n\n"),
            },
          ],
          details: {
            runID: result.id,
            recoveryOf: result.recoveryOf,
            originalRunID: initialResult.id,
            originalFailure: initialResult.failure,
            recoveryCheckpoint: initialResult.recoveryCheckpoint,
            termination: result.termination,
            provider: result.provider,
            model: result.model,
            failure: result.failure,
            recoveredHypotheses: result.recoveredHypotheses,
            recoveredTestObjects: result.recoveredTestObjects,
            recoverySummary: result.recoverySummary,
            artifact,
          },
        }
      },
    }
  }

  #delegationStatusTool(state: RunState): AgentTool<typeof DelegationStatusParameters> {
    return {
      name: "delegation_status",
      label: "Cyberful Delegation Capacity",
      description:
        "Inspect current phase-owned subagent capacity, persona limits, remaining starts, and queued admissions before splitting parallel work.",
      parameters: DelegationStatusParameters,
      executionMode: "sequential",
      execute: async () => {
        const activeDirect = [...state.children]
          .map((id) => this.#states.get(id))
          .filter((child): child is RunState => child !== undefined && !child.finished).length
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                active_global: this.#activeDelegatedRuns,
                available_global: Math.max(0, state.spec.delegation.maxConcurrent - this.#activeDelegatedRuns),
                active_direct: activeDirect,
                persona_limit: state.spec.prompt.manifest.delegationLimit,
                starts_remaining: Math.max(0, state.spec.delegation.maxPerRun - state.childStarts),
                queued: this.#delegationWaiters.size,
                depth: state.spec.depth,
                max_depth: state.spec.delegation.maxDepth,
              }),
            },
          ],
          details: { activeDirect, queued: this.#delegationWaiters.size },
        }
      },
    }
  }

  #fallbackTool(state: RunState): AgentTool<typeof FallbackTaskParameters> {
    return {
      name: "request_fallback_delegation",
      label: "Request Fallback Delegation",
      description:
        "Request one narrowly scoped complete AgentRun on the host-selected fallback provider when this specific subtask is likely to encounter a cyber-policy block. This is scarce session capacity, not a general routing preference.",
      parameters: FallbackTaskParameters,
      execute: async (_callID, input) => {
        const task = taskCapsule(input)
        const admission = await this.#fallbackLedger.tryAdmitProactive(state.spec.fallback.proactivePercentage)
        const requestedAdmissions = admission.proactiveAdmissions - (admission.admitted ? 1 : 0)
        this.#emit(state, {
          type: "fallback",
          runID: state.id,
          mode: "proactive",
          state: "requested",
          quotaExempt: false,
          quota: {
            mainActorRuns: admission.mainActorRuns,
            admitted: requestedAdmissions,
            limit: admission.limit,
          },
        })
        if (!admission.admitted) {
          const reason = `Proactive fallback quota exhausted (${admission.proactiveAdmissions}/${admission.limit} admitted)`
          this.#emit(state, {
            type: "fallback",
            runID: state.id,
            mode: "proactive",
            state: "denied",
            quotaExempt: false,
            reason,
            quota: {
              mainActorRuns: admission.mainActorRuns,
              admitted: admission.proactiveAdmissions,
              limit: admission.limit,
            },
          })
          throw new Error(reason)
        }

        state.fallbackAdmissions++
        let child: AgentRun
        try {
          child = await this.#startChild(state, {
            role: "fallback",
            route: "fallback",
            task,
            mode: "proactive",
            quotaExempt: false,
          })
        } catch (error) {
          state.fallbackAdmissions--
          const rolledBack = await this.#fallbackLedger.rollbackProactiveAdmission().catch(() => ({
            mainActorRuns: admission.mainActorRuns,
            proactiveAdmissions: admission.proactiveAdmissions,
          }))
          this.#emit(state, {
            type: "fallback",
            runID: state.id,
            mode: "proactive",
            state: "denied",
            quotaExempt: false,
            reason: error instanceof Error ? error.message : String(error),
            quota: {
              mainActorRuns: rolledBack.mainActorRuns,
              admitted: rolledBack.proactiveAdmissions,
              limit: Math.floor((rolledBack.mainActorRuns * state.spec.fallback.proactivePercentage) / 100) + 1,
            },
          })
          throw error
        }
        this.#emit(state, {
          type: "fallback",
          runID: state.id,
          fallbackRunID: child.id,
          mode: "proactive",
          state: "approved",
          quotaExempt: false,
          quota: {
            mainActorRuns: admission.mainActorRuns,
            admitted: admission.proactiveAdmissions,
            limit: admission.limit,
          },
        })
        const result = await child.result
        this.#emit(state, {
          type: "fallback",
          runID: state.id,
          fallbackRunID: child.id,
          mode: "proactive",
          state: result.termination === "completed" ? "completed" : "failed",
          quotaExempt: false,
          ...(result.failure ? { reason: result.failure.kind } : {}),
          quota: {
            mainActorRuns: admission.mainActorRuns,
            admitted: admission.proactiveAdmissions,
            limit: admission.limit,
          },
          subtreeSize: 1 + result.fallbackDescendants,
        })
        return {
          content: [
            {
              type: "text",
              text: [
                `Fallback AgentRun ${result.id} ${result.termination}.`,
                result.output || "The fallback returned no textual result.",
              ].join("\n\n"),
            },
          ],
          details: {
            runID: result.id,
            termination: result.termination,
            provider: result.provider,
            model: result.model,
            failure: result.failure,
            quota: {
              mainActorRuns: admission.mainActorRuns,
              admitted: admission.proactiveAdmissions,
              limit: admission.limit,
            },
          },
        }
      },
    }
  }

  #remainingBudget(state: RunState): number {
    const stored = state.timerRemainingMs ?? Math.max(0, state.spec.budget.deadlineAt - this.#now())
    if (!state.timer || state.timerStartedAt === undefined) return Math.max(0, stored)
    return Math.max(0, stored - Math.max(0, this.#now() - state.timerStartedAt))
  }

  #canResumeAfterAutomaticFallback(state: RunState): boolean {
    if (state.finished || state.cancellation) return false
    if (this.#remainingBudget(state) > 0) return true
    state.cancellation = "budget"
    this.#captureRecoverySummary(state, "budget_exhausted")
    state.agent?.abort()
    return false
  }

  async #startChild(parent: RunState, options: StartChildOptions): Promise<AgentRun> {
    await this.#waitForChildCapacity(parent, undefined, Boolean(options.recoveryOf))
    if (parent.finished || parent.cancellation || parent.closeout)
      throw new Error("Parent AgentRun is no longer available for delegation")
    if (!options.recoveryOf && parent.childStarts >= parent.spec.delegation.maxPerRun)
      throw new Error(`run_limit: AgentRun child limit reached (${parent.spec.delegation.maxPerRun})`)
    if (parent.spec.depth >= parent.spec.delegation.maxDepth)
      throw new Error(`depth_limit: AgentRun maximum delegation depth reached (${parent.spec.delegation.maxDepth})`)
    const activeDirectChildren = [...parent.children]
      .map((id) => this.#states.get(id))
      .filter((child): child is RunState => child !== undefined && !child.finished).length
    if (options.role === "subagent" && activeDirectChildren >= parent.spec.prompt.manifest.delegationLimit)
      throw new Error(
        `persona_capacity: AgentRun persona concurrency limit reached (${parent.spec.prompt.manifest.delegationLimit})`,
      )
    if (this.#activeDelegatedRuns >= parent.spec.delegation.maxConcurrent)
      throw new Error(
        `global_capacity: AgentRun concurrent child limit reached (${parent.spec.delegation.maxConcurrent})`,
      )
    if (options.route === "fallback" && !parent.spec.fallback.providerConfigured)
      throw new Error("No fallback provider is configured")
    if (parent.spec.providerAffinity === "fallback" && options.route !== "fallback")
      throw new Error("A fallback-affine subtree cannot return to the main provider")

    const provider = options.route === "main" ? parent.spec.delegation.provider : this.#settings.agent.fallback_provider
    if (!provider) throw new Error("No fallback provider is configured")
    const model = this.#registry.model(provider)
    const selectedReasoning = options.reasoningEffort ?? parent.spec.delegation.defaultReasoningEffort
    if (!parent.spec.delegation.reasoningEfforts.includes(selectedReasoning))
      throw new Error(
        `reasoning_effort_not_allowed: choose one of ${parent.spec.delegation.reasoningEfforts.join(", ")}`,
      )
    const reasoning = PiReasoning.resolve(selectedReasoning, model)
    const generatedIdentity = deterministicIdentity(options.task)
    const proposed = options.proposedIdentity
    const baseIdentity: AgentRunIdentity = {
      displayName: validDisplayName(proposed?.displayName) ? proposed.displayName : generatedIdentity.displayName,
      emoji: validEmoji(proposed?.emoji) ? proposed.emoji : generatedIdentity.emoji,
    }
    const existingNames = new Set(
      [...this.#states.values()]
        .map((candidate) => candidate.spec.identity?.displayName)
        .filter((name): name is string => Boolean(name)),
    )
    let displayName = baseIdentity.displayName
    for (let suffix = 2; existingNames.has(displayName); suffix++)
      displayName = `${baseIdentity.displayName.slice(0, Math.max(1, 31 - String(suffix).length))}-${suffix}`
    const identity = { ...baseIdentity, displayName }
    const promptInput: ChildPromptInput = {
      role: options.role,
      providerRoute: options.route,
      task: options.task,
    }
    const prompt = parent.spec.compileChildPrompt(promptInput)
    const deadlineAt =
      options.recoveryDeadlineAt === undefined
        ? this.#now() + Math.min(this.#remainingBudget(parent), parent.spec.delegation.maxRuntimeMs)
        : Math.min(options.recoveryDeadlineAt, this.#now() + this.#remainingBudget(parent))
    if (deadlineAt <= this.#now()) throw new Error("context_recovery_budget_exhausted: no child runtime remains")
    if (options.recoveryOutputTokens !== undefined && options.recoveryOutputTokens <= 0)
      throw new Error("context_recovery_budget_exhausted: no child output budget remains")
    if (!options.recoveryOf) parent.childStarts++
    if (options.route === "fallback") parent.fallbackDescendants++
    const { recoveryOf: _parentRecoveryOf, ...inheritedSpec } = parent.spec

    return this.start({
      ...inheritedSpec,
      id: undefined,
      role: options.role,
      parentID: parent.id,
      sourceCallID: options.sourceCallID,
      ...(options.recoveryOf ? { recoveryOf: options.recoveryOf } : {}),
      identity,
      phaseRootID: parent.spec.role === "root" ? parent.id : parent.spec.phaseRootID,
      depth: parent.spec.depth + 1,
      provider,
      model,
      context: this.#registry.contextCapacity(provider),
      providerAffinity: options.route,
      reasoning,
      reasoningSelection: options.reasoningSelection ?? "default",
      prompt,
      task: options.task,
      handoffOwner: false,
      abort: parent.spec.abort,
      budget: {
        ...parent.spec.budget,
        deadlineAt,
        ...(options.recoveryOutputTokens === undefined ? {} : { maxOutputTokens: options.recoveryOutputTokens }),
      },
    })
  }

  async #waitForChildCapacity(parent: RunState, signal?: AbortSignal, quotaExempt = false): Promise<void> {
    while (true) {
      if (parent.finished || parent.cancellation || parent.closeout || signal?.aborted) {
        this.#notifyDelegationWaiters()
        throw new Error("cancelled: parent AgentRun is no longer available for delegation")
      }
      if (!quotaExempt && parent.childStarts >= parent.spec.delegation.maxPerRun) {
        this.#notifyDelegationWaiters()
        throw new Error(`run_limit: AgentRun child limit reached (${parent.spec.delegation.maxPerRun})`)
      }
      if (parent.spec.depth >= parent.spec.delegation.maxDepth) {
        this.#notifyDelegationWaiters()
        throw new Error(`depth_limit: AgentRun maximum delegation depth reached (${parent.spec.delegation.maxDepth})`)
      }
      const activeDirect = [...parent.children]
        .map((id) => this.#states.get(id))
        .filter((child): child is RunState => child !== undefined && !child.finished).length
      const personaAvailable = activeDirect < parent.spec.prompt.manifest.delegationLimit
      const globalAvailable = this.#activeDelegatedRuns < parent.spec.delegation.maxConcurrent
      if (personaAvailable && globalAvailable) return
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", cancelled)
          this.#delegationWaiters.delete(wake)
          resolve()
        }
        const cancelled = () => {
          this.#delegationWaiters.delete(wake)
          this.#notifyDelegationWaiters()
          reject(new Error("cancelled: delegation admission was cancelled"))
        }
        this.#delegationWaiters.add(wake)
        signal?.addEventListener("abort", cancelled, { once: true })
      })
    }
  }

  #notifyDelegationWaiters(options: { readonly all?: boolean } = {}) {
    const waiters = [...this.#delegationWaiters]
    for (const wake of options.all ? waiters : waiters.slice(0, 1)) wake()
  }

  async #automaticFallback(state: RunState, failure: Failure): Promise<boolean> {
    if (
      state.spec.providerAffinity !== "main" ||
      state.closeout ||
      state.automaticFallbackUsed ||
      !state.spec.fallback.providerConfigured ||
      !state.spec.fallback.automaticSecurityBlockEnabled ||
      !PiSecurity.isSecurityPolicyBlock(failure)
    )
      return false

    state.automaticFallbackUsed = true
    this.#emit(state, {
      type: "fallback",
      runID: state.id,
      mode: "automatic",
      state: "requested",
      quotaExempt: true,
      reason: failure.providerCode,
    })
    const recentTool = state.lastTool
      ? `Most recent host-observed tool request: ${state.lastTool.name} ${JSON.stringify(
          PiAudit.redactValue(state.lastTool.input),
        ).slice(0, 4_000)}`
      : undefined
    const automaticContext = [state.spec.task.context, recentTool].filter(Boolean).join("\n\n")
    const automaticTask: AgentTaskCapsule = {
      objective: [
        "Complete only the next provider-blocked operational step of this assigned task:",
        state.spec.task.objective.slice(0, 10_000),
      ].join("\n\n"),
      expectedResult:
        state.spec.task.expectedResult ??
        "Complete the provider-blocked operation and return its concrete result and preserved evidence to the parent.",
      ...(automaticContext ? { context: automaticContext } : {}),
      ...(state.spec.task.artifacts ? { artifacts: state.spec.task.artifacts } : {}),
    }

    let child: AgentRun
    try {
      child = await this.#startChild(state, {
        role: "fallback",
        route: "fallback",
        task: automaticTask,
        mode: "automatic",
        quotaExempt: true,
      })
    } catch (error) {
      this.#emit(state, {
        type: "fallback",
        runID: state.id,
        mode: "automatic",
        state: "denied",
        quotaExempt: true,
        reason: error instanceof Error ? error.message : String(error),
      })
      return false
    }

    this.#emit(state, {
      type: "fallback",
      runID: state.id,
      fallbackRunID: child.id,
      mode: "automatic",
      state: "approved",
      quotaExempt: true,
    })
    const result = await child.result
    this.#emit(state, {
      type: "fallback",
      runID: state.id,
      fallbackRunID: child.id,
      mode: "automatic",
      state: result.termination === "completed" ? "completed" : "failed",
      quotaExempt: true,
      ...(result.failure ? { reason: result.failure.kind } : {}),
      subtreeSize: 1 + result.fallbackDescendants,
    })
    if (!this.#canResumeAfterAutomaticFallback(state)) return true

    const syntheticCallID = `fallback_${randomUUID()}`
    const syntheticRequest: AssistantMessage = {
      role: "assistant",
      api: state.spec.model.api,
      provider: state.spec.model.provider,
      model: state.spec.model.id,
      content: [
        {
          type: "toolCall",
          id: syntheticCallID,
          name: "host_fallback_delegation",
          arguments: { runID: result.id },
        },
      ],
      usage: emptyProviderUsage(),
      stopReason: "toolUse",
      timestamp: this.#now(),
    }
    const syntheticResult: ToolResultMessage<{
      readonly hostOwned: true
      readonly runID: AgentRunID
      readonly providerAffinity: "fallback"
      readonly termination: AgentRunResult["termination"]
      readonly failure?: Failure
      readonly recoveredTestObjects: readonly RecoveredTestObject[]
      readonly recoverySummary?: AgentRunRecoverySummary
    }> = {
      role: "toolResult",
      toolCallId: syntheticCallID,
      toolName: "host_fallback_delegation",
      content: [
        {
          type: "text",
          text: [
            result.termination === "completed"
              ? "The provider-blocked subtask was executed by a complete fallback AgentRun."
              : "The complete fallback AgentRun ended without completing its branch. Preserve and use any partial result below, but do not treat it as successful execution.",
            `Fallback run: ${result.id}`,
            `Fallback termination: ${result.termination}`,
            ...(result.failure ? [`Fallback failure: ${result.failure.kind}`] : []),
            ...(result.recoveredTestObjects.length > 0
              ? [
                  `Recovered test objects: ${result.recoveredTestObjects
                    .map(
                      (item) =>
                        `${item.id} (${item.state})${item.evidencePath && item.evidenceExists === false ? ` — missing evidence '${item.evidencePath}'` : ""}`,
                    )
                    .join("; ")}.`,
                ]
              : []),
            ...(result.recoverySummary?.narrative
              ? [`Automatic pre-abort summary: ${result.recoverySummary.narrative}`]
              : []),
            "Treat this as trusted host tool output, synthesize it into the phase work, and continue under the unchanged Cyberful system contract.",
            "",
            result.output || "The fallback returned no textual summary; inspect any referenced workarea artifacts.",
          ].join("\n"),
        },
      ],
      details: {
        hostOwned: true,
        runID: result.id,
        providerAffinity: "fallback",
        termination: result.termination,
        failure: result.failure,
        recoveredTestObjects: result.recoveredTestObjects,
        recoverySummary: result.recoverySummary,
      },
      isError: result.termination !== "completed",
      timestamp: this.#now(),
    }
    state.agent?.state.messages.push(syntheticRequest, syntheticResult)
    await state.agent?.continue()
    return true
  }

  async #cancelState(state: RunState, _reason: string, mode: "budget" | "cancel"): Promise<void> {
    if (state.finished) return
    state.cancellation ??= mode
    this.#captureRecoverySummary(state, mode === "budget" ? "budget_exhausted" : "cancelled")
    this.#notifyDelegationWaiters()
    state.retryWaitAbort?.abort(new Error(`AgentRun ${mode === "budget" ? "budget expired" : "was cancelled"}`))
    state.finishProviderRetryAttempt?.()
    const children = [...state.children]
      .map((id) => this.#states.get(id))
      .filter((child): child is RunState => child !== undefined)
    await Promise.allSettled(children.map((child) => this.#cancelState(child, "Parent AgentRun cancelled", mode)))
    state.agent?.abort()
    await state.resultPromise
  }

  // ── A Child's Public Narrative Survives Forced Termination ─────
  // Budget and parent cancellation may interrupt a child before Pi can return
  // its final tool result to the root. Before aborting, the host copies only the
  // latest public assistant text, redacts and bounds it, then begins an atomic
  // workarea write. No reasoning, tool arguments, or provider payload enters the
  // recovery record. Finalization awaits the retained write before publishing
  // the child result, so the parent can use either the narrative or its path.
  //
  // @docs/concepts/execution-model.md
  // ────────────────────────────────────────────────────────────────
  #captureRecoverySummary(
    state: RunState,
    termination: Extract<AgentRunTermination, "budget_exhausted" | "cancelled">,
  ): void {
    if (state.spec.role === "root" || state.recoverySummary) return
    const summary: AgentRunRecoverySummary = {
      capturedAt: new Date(this.#now()).toISOString(),
      termination,
      ...(state.agent ? { narrative: boundedRecoveryNarrative(state.agent.state.messages) } : {}),
    }
    state.recoverySummary = summary
    const relativePath = `raw/operations/delegated-run-summaries/${createHash("sha256").update(state.id).digest("hex")}.json`
    state.recoverySummaryWrite = replaceWorkareaFile(
      state.spec.workarea,
      relativePath,
      `${JSON.stringify({
        version: 1,
        runID: state.id,
        parentRunID: state.spec.parentID,
        role: state.spec.role,
        ...summary,
      })}\n`,
      { mode: 0o600 },
    ).then(
      () => {
        state.recoverySummary = { ...summary, path: relativePath }
      },
      (error: unknown) => {
        state.recoverySummaryWriteError = boundedFailureDetail(error instanceof Error ? error.message : String(error))
      },
    )
  }

  #observePiEvent(state: RunState, event: PiAgentEvent): void {
    if (event.type === "agent_start") {
      this.#emitActivity(state, {
        kind: "agent",
        actor: state.actor,
        state: "active",
        transitionID: `${state.id}:agent-start`,
      })
      return
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent
      if (update.type === "thinking_start" || update.type === "thinking_delta" || update.type === "thinking_end")
        this.#emitActivity(state, {
          kind: "reasoning",
          itemID: `${state.id}:thinking:${update.contentIndex}`,
          hasSummary: false,
          hasContent: update.type === "thinking_end" && Boolean(update.content),
          hasDelta: update.type === "thinking_delta" && Boolean(update.delta),
        })
      return
    }
    if (event.type === "message_end" && isAssistantMessage(event.message)) {
      state.finishProviderRetryAttempt?.()
      const callKind = state.providerCallKind
      this.#recordProviderUsage(state, {
        usage: event.message.usage,
        callKind,
        status:
          event.message.stopReason === "error"
            ? "failed"
            : event.message.stopReason === "aborted"
              ? "cancelled"
              : "completed",
        attempt: Math.max(1, state.providerRetryAttempt + 1),
      })
      state.providerCallKind = "generation"
      const failure = this.#retryFailure(state, event.message)
      const contextRecoveryKey = this.#contextRecoveryKey(state, failure)
      const discardedAttempt =
        this.#canRetryProvider(state, failure) ||
        (contextRecoveryKey !== undefined && !state.contextRecoveryKeys.has(contextRecoveryKey))
      if (!discardedAttempt)
        for (const content of event.message.content) {
          if (content.type !== "text") continue
          const text = PiAudit.redactText(content.text)
          if (text) this.#emitActivity(state, { kind: "text", text })
        }
      state.cumulativeUsage = addUsage(state.cumulativeUsage, event.message.usage)
      this.#emitActivity(state, {
        kind: "progress",
        usage: {
          scopeID: state.id,
          inputTokens: state.cumulativeUsage.input,
          generatedTokens: state.cumulativeUsage.output,
          reasoningTokens: state.cumulativeUsage.reasoning,
          cacheReadTokens: state.cumulativeUsage.cacheRead,
          cacheWriteTokens: state.cumulativeUsage.cacheWrite,
        },
      })
      if (
        state.spec.budget.maxOutputTokens !== undefined &&
        state.cumulativeUsage.output >= state.spec.budget.maxOutputTokens &&
        event.message.stopReason !== "error" &&
        event.message.stopReason !== "aborted"
      ) {
        state.cancellation ??= "budget"
        state.agent?.abort()
      }
      if (state.providerRetryActive && event.message.stopReason !== "error" && event.message.stopReason !== "aborted") {
        this.#emitProviderRetry(state, {
          state: "succeeded",
          attempt: state.providerRetryAttempt,
        })
        state.providerRetryAttempt = 0
        state.providerRetryActive = false
      }
      return
    }
    if (event.type === "tool_execution_start") {
      state.toolCalls++
      state.lastTool = { name: event.toolName, input: event.args }
      this.#emitActivity(state, {
        kind: "tool",
        tool: event.toolName,
        input: PiAudit.redactToolInput(event.toolName, event.args),
        callID: event.toolCallId,
      })
      return
    }
    if (event.type === "tool_execution_update") {
      // Partial tool output can split a credential across arbitrary event
      // boundaries. Publish only the complete redacted result at
      // tool_execution_end, where credential-shaped values can be recognized.
      return
    }
    if (event.type === "tool_execution_end") {
      const details = record(event.result)?.details
      if (event.toolName === "skill_read" && !event.isError) {
        const skill = record(details)?.skill
        const kind = record(details)?.kind
        if (typeof skill === "string" && skill.trim()) {
          state.skillsUsed.add(skill)
          if (kind === "instructions") state.skillsRead.add(skill)
        }
      }
      if (
        event.toolName === "hypothesis" &&
        !event.isError &&
        record(details)?.synthesisOutcome === "exhausted" &&
        record(details)?.activeBlockingHypotheses === 0 &&
        state.spec.role === "root" &&
        state.spec.handoffOwner &&
        !state.closeout &&
        !state.cancellation
      ) {
        const remaining = this.#remainingBudget(state)
        state.closeout = true
        state.closeoutRequested = true
        this.#emit(state, {
          type: "phase_closeout",
          runID: state.id,
          state: "entered",
          cause: "hypothesis_exhausted",
          reserveMs: Math.min(remaining, Math.max(0, state.spec.budget.closeoutReserveMs ?? 0)),
          remainingMs: remaining,
          deadlineAt: Math.round(state.spec.budget.clock?.deadlineAt() ?? state.spec.budget.deadlineAt),
        })
        this.#emitActivity(state, {
          kind: "status",
          text: "Phase mode: closeout · hypothesis synthesis is exhausted with no OPEN/TESTING hypotheses · research tools disabled.",
        })
        this.#notifyDelegationWaiters({ all: true })
        state.agent?.abort()
        void Promise.allSettled(
          [...state.children]
            .map((id) => this.#states.get(id))
            .filter((child): child is RunState => child !== undefined)
            .map((child) => this.#cancelState(child, "Hypothesis synthesis requested closeout", "cancel")),
        )
      }
      if (event.toolName === "hypothesis" && !event.isError && record(details)?.synthesisOutcome === "diversified")
        this.#emitActivity(state, {
          kind: "status",
          text: "Hypothesis synthesis diversified: continue only with the recorded discriminators; avoid repeating converged work.",
        })
      this.#emitActivity(state, {
        kind: "output",
        text:
          PiAudit.redactText(resultText(event.result)) ||
          (event.isError ? "Tool execution failed." : "Tool execution completed."),
        callID: event.toolCallId,
      })
    }
  }

  async #execute(state: RunState): Promise<void> {
    const rootID = state.spec.role === "root" ? state.id : state.spec.phaseRootID!
    const contextLimits = this.#contextLimits(state)
    this.#emit(state, {
      type: "run_started",
      runID: state.id,
      ...(state.spec.parentID ? { parentID: state.spec.parentID } : {}),
      ...(state.spec.recoveryOf ? { recoveryOf: state.spec.recoveryOf } : {}),
      phaseRootID: rootID,
      role: state.spec.role,
      provider: state.spec.provider,
      model: state.spec.model.id,
      providerAffinity: state.spec.providerAffinity,
      ...(state.spec.identity ? { identity: state.spec.identity } : {}),
      reasoningEffort: state.spec.reasoning.requested,
      effectiveReasoningEffort: state.spec.reasoning.effective,
      ...(state.spec.reasoningSelection ? { reasoningSelection: state.spec.reasoningSelection } : {}),
      context: {
        catalogContextWindow: contextLimits.catalogContextWindow,
        ...(contextLimits.configuredContextWindow === undefined
          ? {}
          : { configuredContextWindow: contextLimits.configuredContextWindow }),
        trustedRouteWindow: contextLimits.trustedRouteWindow,
        ...(contextLimits.configuredOperationalContextWindow === undefined
          ? {}
          : {
              configuredOperationalContextWindow: contextLimits.configuredOperationalContextWindow,
            }),
        operationalContextWindow: contextLimits.operationalContextWindow,
        ...(contextLimits.observedContextUpperBound === undefined
          ? {}
          : { observedContextUpperBound: contextLimits.observedContextUpperBound }),
        continuationReserveTokens: contextLimits.continuationReserveTokens,
        hardInputTokens: contextLimits.hardInputTokens,
        effectiveOperationalWindow: contextLimits.effectiveOperationalWindow,
        source: contextLimits.source,
        warnings: state.spec.context.warnings,
      },
      promptSystemSha256: state.spec.prompt.manifest.systemSha256,
      promptManifest: state.spec.prompt.manifest,
    })
    this.#emitActivity(state, {
      kind: "agent",
      actor: state.actor,
      state: "started",
      transitionID: `${state.id}:created`,
    })
    for (const warning of state.spec.context.warnings)
      this.#emitActivity(state, {
        kind: "status",
        text: `Context configuration warning: ${warning}.`,
      })
    if (!Settings.compactionPolicy(this.#settings).model_summary)
      this.#emitActivity(state, {
        kind: "status",
        text: "Context rotation warning: model_summary=false disables semantic history rotation; only deterministic tool-result archival remains and context exhaustion is possible.",
      })

    // ── Every AgentRun Reserves Its Own Closeout ──────────────────
    // Root, delegated, and fallback runs inherit one closeout reserve inside
    // their existing deadline; the reserve never extends phase or child budget.
    // Root closeout remains the only event that changes global phase mode, while
    // a child closes only itself and its descendants. The interrupted turn then
    // resumes with local-only tools and any explicit task output artifact.
    // ────────────────────────────────────────────────────────────────
    state.timerRemainingMs = state.spec.budget.deadlineAt - this.#now()
    const stopBudgetTimer = () => {
      if (!state.timer) return
      clearTimeout(state.timer)
      state.timer = undefined
      if (state.timerStartedAt !== undefined)
        state.timerRemainingMs = Math.max(
          0,
          (state.timerRemainingMs ?? 0) - Math.max(0, this.#now() - state.timerStartedAt),
        )
      state.timerStartedAt = undefined
    }
    const enterReservedCloseout = (remainingMs: number, reserveMs: number, restartTimer: () => void) => {
      state.timerRemainingMs = remainingMs
      state.closeout = true
      state.closeoutRequested = true
      if (state.spec.role === "root" && state.spec.handoffOwner)
        this.#emit(state, {
          type: "phase_closeout",
          runID: state.id,
          state: "entered",
          cause: "reserve",
          reserveMs,
          remainingMs,
          deadlineAt: Math.round(state.spec.budget.clock?.deadlineAt() ?? state.spec.budget.deadlineAt),
        })
      const scope = state.spec.role === "root" && state.spec.handoffOwner ? "Phase" : "AgentRun"
      this.#emitActivity(state, {
        kind: "status",
        text: `${scope} mode: closeout · ${Math.ceil(remainingMs / 1_000)}s remaining · research tools disabled.`,
      })
      this.#notifyDelegationWaiters({ all: true })
      state.agent?.abort()
      void Promise.allSettled(
        [...state.children]
          .map((id) => this.#states.get(id))
          .filter((child): child is RunState => child !== undefined)
          .map((child) => this.#cancelState(child, `${scope} entered closeout`, "cancel")),
      )
      restartTimer()
    }
    const startBudgetTimer = () => {
      if (state.timer || state.finished || state.cancellation) return
      const remaining = state.timerRemainingMs ?? 0
      if (remaining <= 0) {
        state.cancellation = "budget"
        this.#captureRecoverySummary(state, "budget_exhausted")
        state.retryWaitAbort?.abort(new Error("AgentRun budget expired"))
        state.agent?.abort()
        return
      }
      const reserveMs = Math.min(remaining, Math.max(0, state.spec.budget.closeoutReserveMs ?? 0))
      const enteringCloseout = !state.closeout && reserveMs > 0
      const timerDurationMs = enteringCloseout ? Math.max(0, remaining - reserveMs) : remaining
      if (enteringCloseout && timerDurationMs <= 0) {
        enterReservedCloseout(remaining, reserveMs, startBudgetTimer)
        return
      }
      state.timerStartedAt = this.#now()
      state.timer = setTimeout(() => {
        state.timer = undefined
        state.timerStartedAt = undefined
        if (enteringCloseout) {
          enterReservedCloseout(reserveMs, reserveMs, startBudgetTimer)
          return
        }
        state.timerRemainingMs = 0
        state.cancellation ??= "budget"
        this.#captureRecoverySummary(state, "budget_exhausted")
        state.retryWaitAbort?.abort(new Error("AgentRun budget expired"))
        state.agent?.abort()
      }, timerDurationMs)
      state.timer.unref?.()
    }
    if (state.spec.budget.clock)
      state.removePauseListener = state.spec.budget.clock.subscribe((snapshot) => {
        if (snapshot.pending) stopBudgetTimer()
        else startBudgetTimer()
      })
    else startBudgetTimer()
    if (state.spec.abort) {
      const abort = () => {
        state.cancellation ??= "cancel"
        this.#captureRecoverySummary(state, "cancelled")
        state.retryWaitAbort?.abort(new Error("AgentRun was cancelled"))
        state.finishProviderRetryAttempt?.()
        state.agent?.abort()
      }
      state.spec.abort.addEventListener("abort", abort, { once: true })
      state.removeAbortListener = () => state.spec.abort?.removeEventListener("abort", abort)
      if (state.spec.abort.aborted) abort()
    }

    let failure: Failure | undefined
    let output = ""
    try {
      if (!state.cancellation) {
        const adapter = this.#registry.adapter(state.spec.provider)
        const attestPayload = PiSystemWire.createOnPayload({ prompt: state.spec.prompt })
        const initialTools = this.#toolSet(state)
        const agent = new Agent({
          initialState: {
            systemPrompt: state.spec.prompt.system,
            model: state.spec.model,
            thinkingLevel: state.spec.reasoning.transport,
            tools: initialTools,
            messages: [],
          },
          transformContext: (messages, signal) => this.#transformContext(state, messages, initialTools, signal),
          streamFn: (model, context, options) => {
            if (state.contextRecoveryProviderCallsRemaining !== undefined) {
              if (state.contextRecoveryProviderCallsRemaining <= 0)
                throw new Error("context_rotation_failed: emergency recovery permits one provider generation")
              state.contextRecoveryProviderCallsRemaining--
            }
            const limit = state.spec.budget.maxOutputTokens
            if (limit === undefined) return this.#streamFn(model, context, options)
            const remaining = Math.max(1, limit - state.cumulativeUsage.output)
            const requested = options?.maxTokens ?? model.maxTokens
            return this.#streamFn(model, context, {
              ...options,
              maxTokens: Math.min(model.maxTokens, requested, remaining),
            })
          },
          sessionId: `${state.spec.sessionID}:${state.id}`,
          toolExecution: "parallel",
          maxRetryDelayMs: 60_000,
          onPayload: (payload, model) => {
            const attested = attestPayload(payload, model)
            return this.#onPayload?.(attested, state.spec.prompt.system, adapter) ?? attested
          },
          onResponse: (response) => {
            state.lastHTTPStatus = response.status
          },
          prepareNextTurnWithContext: ({ context }) => ({
            context: {
              ...context,
              tools: state.agent?.state.tools ?? context.tools,
            },
          }),
          beforeToolCall: async ({ toolCall, args }) => {
            if (state.closeout && !closeoutToolAllowed(toolCall.name))
              return {
                block: true,
                reason:
                  "Closeout permits only local evidence reads, deliverable and ledger reconciliation, cleanup, and root-owned handoff.",
              }
            if (toolCall.name === "handoff" && !state.spec.handoffOwner)
              return { block: true, reason: "Only the original phase root AgentRun may call handoff." }
            if (toolCall.name === "request_fallback_delegation" && state.spec.providerAffinity === "fallback")
              return { block: true, reason: "Fallback-affine runs cannot request another provider route." }
            if (toolCall.name === "skill_read") {
              const request = record(args)
              const locator = typeof request?.skill === "string" ? request.skill.trim() : ""
              const requestedPath = typeof request?.path === "string" ? request.path.trim() : ""
              const skill = locator ? this.#skillName(state, locator) : undefined
              if (requestedPath && (!skill || !state.skillsRead.has(skill)))
                return {
                  block: true,
                  reason: "Read this skill's complete SKILL.md in this AgentRun before requesting package resources.",
                }
            }
          },
        })
        state.agent = agent
        agent.subscribe((event) => this.#observePiEvent(state, event))
        if (state.closeout) {
          state.closeoutRequested = false
          await agent.prompt([closeoutMessage(state.spec, this.#now())])
        } else {
          await agent.prompt(userMessages(state.spec))
          if (state.closeoutRequested && !state.cancellation) {
            const terminal = agent.state.messages.at(-1)
            if (isAssistantMessage(terminal) && terminal.stopReason === "aborted")
              agent.state.messages = agent.state.messages.slice(0, -1)
            state.closeoutRequested = false
            await agent.prompt([closeoutMessage(state.spec, this.#now())])
          }
        }

        let last = latestAssistant(agent.state.messages)
        failure = this.#retryFailure(state, last)
        const settleRecoverableFailure = async () => {
          while (!state.cancellation) {
            const recovery = await this.#recoverContextFailure(state, failure)
            if (recovery.attempted) {
              failure = recovery.failure
              last = latestAssistant(agent.state.messages)
              continue
            }
            if (!this.#canRetryProvider(state, failure)) break

            const messages = agent.state.messages
            if (messages.at(-1)?.role !== "assistant")
              throw new Error("Provider retry requires a terminal assistant error message")
            agent.state.messages = messages.slice(0, -1)
            last = latestAssistant(agent.state.messages)

            const attempt = state.providerRetryAttempt + 1
            const delayMs = Math.min(this.#retryDelayMs(attempt), this.#remainingBudget(state))
            const policy = Settings.retryPolicy(this.#settings)
            const releaseRetrySuspension = state.spec.budget.clock?.suspend("provider_retry")
            let attemptTimer: ReturnType<typeof setTimeout> | undefined
            let retrySuspensionActive = true
            const finishRetryAttempt = () => {
              if (!retrySuspensionActive) return
              retrySuspensionActive = false
              if (attemptTimer !== undefined) clearTimeout(attemptTimer)
              attemptTimer = undefined
              releaseRetrySuspension?.()
              if (state.finishProviderRetryAttempt === finishRetryAttempt) state.finishProviderRetryAttempt = undefined
            }
            state.finishProviderRetryAttempt = finishRetryAttempt
            this.#emitProviderRetry(state, {
              state: "scheduled",
              attempt,
              delayMs,
              attemptTimeoutMs: policy.attempt_timeout_ms,
              failure,
            })
            const retryWaitAbort = new AbortController()
            state.retryWaitAbort = retryWaitAbort
            try {
              await this.#sleep(delayMs, retryWaitAbort.signal)
            } catch (error) {
              if (!state.cancellation) {
                finishRetryAttempt()
                throw error
              }
            } finally {
              if (state.retryWaitAbort === retryWaitAbort) state.retryWaitAbort = undefined
            }
            if (state.cancellation) {
              this.#emitProviderRetry(state, { state: "cancelled", attempt, failure })
              finishRetryAttempt()
              break
            }

            state.providerRetryAttempt = attempt
            state.providerRetryActive = true
            state.providerCallKind = "retry"
            state.lastHTTPStatus = undefined
            this.#emitProviderRetry(state, {
              state: "attempting",
              attempt,
              attemptTimeoutMs: policy.attempt_timeout_ms,
              failure,
            })
            let attemptTimedOut = false
            attemptTimer = setTimeout(() => {
              attemptTimedOut = true
              agent.abort()
            }, policy.attempt_timeout_ms)
            attemptTimer.unref?.()
            try {
              await agent.continue()
              last = latestAssistant(agent.state.messages)
              failure = attemptTimedOut
                ? {
                    kind: "timeout",
                    providerCode: "retry_attempt_timeout",
                    detail: `Provider retry attempt exceeded ${policy.attempt_timeout_ms} ms.`,
                    retryable: true,
                  }
                : this.#retryFailure(state, last)
              if (attemptTimedOut)
                this.#emitProviderRetry(state, {
                  state: "timed_out",
                  attempt,
                  attemptTimeoutMs: policy.attempt_timeout_ms,
                  failure,
                })
            } finally {
              finishRetryAttempt()
              if (state.providerCallKind === "retry") state.providerCallKind = "generation"
            }
          }
        }
        await settleRecoverableFailure()
        if (state.closeoutRequested && !state.cancellation) {
          const terminal = agent.state.messages.at(-1)
          if (isAssistantMessage(terminal) && terminal.stopReason === "aborted")
            agent.state.messages = agent.state.messages.slice(0, -1)
          state.closeoutRequested = false
          await agent.prompt([closeoutMessage(state.spec, this.#now())])
          last = latestAssistant(agent.state.messages)
          failure = this.#retryFailure(state, last)
          await settleRecoverableFailure()
        }
        if (failure && (await this.#automaticFallback(state, failure))) {
          last = latestAssistant(agent.state.messages)
          failure = PiSecurity.classify(
            providerObservation(adapter, state.spec.provider, state.spec.model.id, last, state.lastHTTPStatus),
          )
          await settleRecoverableFailure()
        }
        if (failure?.retryable && state.providerRetryActive)
          this.#emitProviderRetry(state, {
            state: "exhausted",
            attempt: state.providerRetryAttempt,
            failure,
          })
        state.providerRetryActive = false
        failure = failureWithDetail(failure, last?.errorMessage)
        output = PiAudit.redactText(assistantText(last))
      }
    } catch (error) {
      failure = failure ??
        PiSecurity.classify({
          adapter: this.#registry.adapter(state.spec.provider),
          provider: state.spec.provider,
          model: state.spec.model.id,
          message: {
            stopReason: state.cancellation ? "aborted" : "error",
            diagnostics: [
              {
                error: {
                  code: typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
                  message: error instanceof Error ? error.message : String(error),
                },
              },
            ],
          },
        }) ?? { kind: "unknown", retryable: false }
      const last = state.agent ? latestAssistant(state.agent.state.messages) : undefined
      failure = failureWithDetail(
        failure,
        last?.errorMessage ?? (error instanceof Error ? error.message : String(error)),
      )
      output ||= state.agent ? PiAudit.redactText(assistantText(latestAssistant(state.agent.state.messages))) : ""
    } finally {
      state.finishProviderRetryAttempt?.()
      stopBudgetTimer()
      state.removePauseListener?.()
      state.removeAbortListener?.()
      state.unregisterControl?.()

      const children = [...state.children]
        .map((id) => this.#states.get(id))
        .filter((child): child is RunState => child !== undefined)
      if (state.cancellation)
        await Promise.allSettled(
          children.map((child) => this.#cancelState(child, "Parent finished", state.cancellation!)),
        )
      await Promise.allSettled(children.map((child) => child.resultPromise))
      state.fallbackDescendants += state.childResults.reduce((total, child) => total + child.fallbackDescendants, 0)
      state.fallbackAdmissions += state.childResults.reduce((total, child) => total + child.fallbackAdmissions, 0)
      failure = auditedFailure(failure)
      const termination = terminationFor(state, failure)
      const finalContextLimits = this.#contextLimits(state)
      await state.recoverySummaryWrite
      if (state.recoverySummaryWriteError)
        this.#emitActivity(state, {
          kind: "status",
          text: `Automatic pre-abort summary persistence failed: ${state.recoverySummaryWriteError}`,
        })
      let recoveredHypotheses: readonly RecoveredHypothesis[] = []
      if (state.spec.role !== "root" && state.spec.recoverHypothesisOwnership) {
        let ancestor = state.spec.parentID ? this.#states.get(state.spec.parentID) : undefined
        while (ancestor?.finished && ancestor.spec.parentID) ancestor = this.#states.get(ancestor.spec.parentID)
        if (ancestor && !ancestor.finished) {
          recoveredHypotheses = await state.spec
            .recoverHypothesisOwnership({
              fromRunID: state.id,
              to: {
                runID: ancestor.id,
                displayName: ancestor.spec.identity?.displayName ?? ancestor.spec.role,
                kind: ancestor.spec.role,
              },
              reason: "child_finished",
            })
            .catch((error) => {
              this.#emitActivity(state, {
                kind: "status",
                text: `Hypothesis ownership recovery failed: ${boundedFailureDetail(
                  error instanceof Error ? error.message : String(error),
                )}`,
              })
              return []
            })
          if (recoveredHypotheses.length > 0)
            this.#emitActivity(state, {
              kind: "status",
              text: `Hypothesis ownership recovered by ${ancestor.spec.identity?.displayName ?? ancestor.spec.role}: ${recoveredHypotheses
                .map((item) => item.id)
                .join(", ")}.`,
            })
        }
      }
      let recoveredTestObjects: readonly RecoveredTestObject[] = []
      if (state.spec.role !== "root" && state.spec.recoverTestObjects) {
        recoveredTestObjects = await state.spec.recoverTestObjects({ fromRunID: state.id }).catch((error) => {
          this.#emitActivity(state, {
            kind: "status",
            text: `Test-object ledger recovery failed: ${boundedFailureDetail(
              error instanceof Error ? error.message : String(error),
            )}`,
          })
          return []
        })
        if (recoveredTestObjects.length > 0) {
          const missingEvidence = recoveredTestObjects.filter(
            (item) => item.evidencePath && item.evidenceExists === false,
          )
          this.#emitActivity(state, {
            kind: "status",
            text: [
              `Test-object ledger recovered for the parent: ${recoveredTestObjects.map((item) => item.id).join(", ")}.`,
              ...(missingEvidence.length > 0
                ? [
                    `Missing referenced evidence: ${missingEvidence
                      .map((item) => `${item.id} → ${item.evidencePath}`)
                      .join(", ")}.`,
                  ]
                : []),
            ].join(" "),
          })
        }
      }
      const result: AgentRunResult = {
        id: state.id,
        ...(state.spec.parentID ? { parentID: state.spec.parentID } : {}),
        ...(state.spec.recoveryOf ? { recoveryOf: state.spec.recoveryOf } : {}),
        phaseRootID: rootID,
        role: state.spec.role,
        provider: state.spec.provider,
        model: state.spec.model.id,
        providerAffinity: state.spec.providerAffinity,
        ...(state.spec.identity ? { identity: state.spec.identity } : {}),
        reasoningEffort: state.spec.reasoning.requested,
        effectiveReasoningEffort: state.spec.reasoning.effective,
        ...(state.spec.reasoningSelection ? { reasoningSelection: state.spec.reasoningSelection } : {}),
        context: {
          catalogContextWindow: finalContextLimits.catalogContextWindow,
          ...(finalContextLimits.configuredContextWindow === undefined
            ? {}
            : { configuredContextWindow: finalContextLimits.configuredContextWindow }),
          trustedRouteWindow: finalContextLimits.trustedRouteWindow,
          ...(finalContextLimits.configuredOperationalContextWindow === undefined
            ? {}
            : {
                configuredOperationalContextWindow: finalContextLimits.configuredOperationalContextWindow,
              }),
          operationalContextWindow: finalContextLimits.operationalContextWindow,
          ...(finalContextLimits.observedContextUpperBound === undefined
            ? {}
            : { observedContextUpperBound: finalContextLimits.observedContextUpperBound }),
          continuationReserveTokens: finalContextLimits.continuationReserveTokens,
          hardInputTokens: finalContextLimits.hardInputTokens,
          effectiveOperationalWindow: finalContextLimits.effectiveOperationalWindow,
          source: finalContextLimits.source,
          warnings: state.spec.context.warnings,
        },
        output,
        termination,
        ...(failure ? { failure } : {}),
        usage: state.cumulativeUsage,
        promptManifest: state.spec.prompt.manifest,
        childRunIDs: [...state.children],
        skillsUsed: [...state.skillsUsed].toSorted(),
        toolCalls: state.toolCalls,
        fallbackAdmissions: state.fallbackAdmissions,
        fallbackDescendants: state.fallbackDescendants,
        recoveredHypotheses,
        recoveredTestObjects,
        ...(state.recoverySummary ? { recoverySummary: state.recoverySummary } : {}),
        ...(state.recoveryCheckpoint ? { recoveryCheckpoint: state.recoveryCheckpoint } : {}),
      }
      state.finished = true
      this.#emitActivity(state, {
        kind: "agent",
        actor: {
          ...state.actor,
          ...(failure ? { failure: failure.kind } : {}),
        },
        state:
          termination === "completed"
            ? "completed"
            : termination === "cancelled" || termination === "budget_exhausted"
              ? "interrupted"
              : "failed",
        transitionID: `${state.id}:finished`,
      })
      this.#emit(state, {
        type: "run_finished",
        runID: state.id,
        ...(state.spec.parentID ? { parentID: state.spec.parentID } : {}),
        ...(state.spec.recoveryOf ? { recoveryOf: state.spec.recoveryOf } : {}),
        role: state.spec.role,
        termination,
        ...(failure ? { failure } : {}),
        usage: state.cumulativeUsage,
        skillsUsed: [...state.skillsUsed].toSorted(),
        childRunIDs: [...state.children],
        fallbackAdmissions: state.fallbackAdmissions,
        fallbackDescendants: state.fallbackDescendants,
        toolCalls: state.toolCalls,
        recoveredHypotheses,
        recoveredTestObjects,
        ...(state.recoverySummary ? { recoverySummary: state.recoverySummary } : {}),
        ...(state.recoveryCheckpoint ? { recoveryCheckpoint: state.recoveryCheckpoint } : {}),
      })
      state.resolveResult(result)
      state.queue.close()
      if (state.spec.role === "root") state.rootQueue.close()
      if (state.spec.role !== "root") this.#activeDelegatedRuns = Math.max(0, this.#activeDelegatedRuns - 1)
      this.#notifyDelegationWaiters()
      const parent = state.spec.parentID ? this.#states.get(state.spec.parentID) : undefined
      parent?.childResults.push(result)
      this.#states.delete(state.id)
    }
  }
}

export function formatTaskCapsule(task: AgentTaskCapsule): string {
  return capsuleText(task)
}

export { clearFallbackLedger, fallbackLedgerForSession, type PiFallbackLedger }

export * as SubsystemPiAgent from "./pi-agent"
