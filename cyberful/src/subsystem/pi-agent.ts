// ── Pi Agent Subsystem ───────────────────────────────────────────
// Runs complete root, delegated, and fallback AgentRuns inside one
// phase-scoped in-process Pi worker owner with host-owned routing and delegation policy.
// → cyberful/src/subsystem/agent-subsystem.ts — defines the public contract.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { randomUUID } from "node:crypto"
import { Agent, type AgentEvent as PiAgentEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core"
import type { AssistantMessage, ToolResultMessage, UserMessage, Usage } from "@earendil-works/pi-ai"
import { Type } from "typebox"
import type { Settings } from "@/config/settings"
import { SubsystemControl } from "./control"
import type {
  AgentEvent,
  AgentRun,
  AgentRunID,
  AgentRunResult,
  AgentRunSpec,
  AgentRunTermination,
  AgentRunUsage,
  AgentSubsystem,
  AgentTaskCapsule,
  ChildPromptInput,
  ProviderAffinity,
  SubsystemStatus,
} from "./agent-subsystem"
import type { PiModels } from "./pi-models"
import { PiAudit } from "./pi-audit"
import { PiSecurity, type Failure } from "./pi-security"
import { PiSystemWire } from "./pi-system-wire"
import {
  clearFallbackLedger,
  fallbackLedgerForSession,
  type PiFallbackLedger,
} from "./pi-fallback-ledger"
import type { PhaseActivity, PhaseActivityActor } from "./subsystem"

const DelegateTaskParameters = Type.Object(
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
  },
  { additionalProperties: false },
)

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

interface PiAgentSubsystemOptions {
  readonly settings: Settings.Info
  readonly registry: PiModels
  readonly fallbackLedger?: PiFallbackLedger
  readonly streamFn?: StreamFn
  readonly now?: () => number
  readonly createRunID?: () => AgentRunID
  readonly onPayload?: (payload: unknown, system: string, adapter: string) => unknown
  readonly onShutdown?: () => Promise<void>
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
  lastHTTPStatus?: number
  lastTool?: {
    readonly name: string
    readonly input: unknown
  }
  cancellation?: "budget" | "cancel"
  finished: boolean
}

interface StartChildOptions {
  readonly role: "subagent" | "fallback"
  readonly route: ProviderAffinity
  readonly task: AgentTaskCapsule
  readonly mode?: "proactive" | "automatic"
  readonly quotaExempt?: boolean
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
  if (!failure?.providerCode) return failure
  const providerCode = PiAudit.redactText(failure.providerCode)
  return providerCode === failure.providerCode ? failure : ({ ...failure, providerCode } as Failure)
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
}): AgentTaskCapsule {
  return {
    objective: input.task.trim(),
    ...(input.expected_result?.trim() ? { expectedResult: input.expected_result.trim() } : {}),
    ...(input.context?.trim() ? { context: input.context.trim() } : {}),
    ...(input.artifacts?.length ? { artifacts: input.artifacts.map((item) => item.trim()).filter(Boolean) } : {}),
  }
}

function capsuleText(task: AgentTaskCapsule): string {
  return [
    "# Specific delegated objective",
    task.objective,
    ...(task.expectedResult ? ["", "# Expected result", task.expectedResult] : []),
    ...(task.context ? ["", "# Minimum explicit context", task.context] : []),
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
  if (spec.role === "root" && spec.providerAffinity !== "primary")
    throw new Error("The original root AgentRun must use primary provider affinity")
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
  readonly #createRunID: () => AgentRunID
  readonly #fallbackLedger: PiFallbackLedger

  readonly #onPayload?: PiAgentSubsystemOptions["onPayload"]
  readonly #onShutdown?: () => Promise<void>
  readonly #states = new Map<AgentRunID, RunState>()

  #activeDelegatedRuns = 0
  #shuttingDown = false
  #shutdownPromise: Promise<void> | undefined

  constructor(options: PiAgentSubsystemOptions) {
    this.#settings = options.settings
    this.#registry = options.registry
    this.#streamFn = options.streamFn ?? options.registry.models.streamSimple.bind(options.registry.models)
    this.#now = options.now ?? Date.now
    this.#createRunID = options.createRunID ?? (() => `run_${randomUUID()}`)
    this.#fallbackLedger = options.fallbackLedger ?? fallbackLedgerForSession(`worker_${randomUUID()}`)
    this.#onPayload = options.onPayload
    this.#onShutdown = options.onShutdown
  }

  async preflight(settings: Settings.Info): Promise<SubsystemStatus> {
    const routes = [
      { id: settings.agent.primary_provider, route: "primary" as const },
      ...(settings.agent.fallback_provider
        ? [{ id: settings.agent.fallback_provider, route: "fallback" as const }]
        : []),
    ]
    const providers: SubsystemStatus["providers"][number][] = []
    const errors: string[] = []
    let primaryAuthenticated = false
    for (const route of routes) {
      try {
        const model = this.#registry.model(route.id)
        const auth = await this.#registry.models.checkAuth(route.id)
        if (route.route === "primary") primaryAuthenticated = Boolean(auth)
        providers.push({
          id: route.id,
          model: model.id,
          route: route.route,
          authenticated: Boolean(auth),
          ...(auth?.source ? { authSource: auth.source } : {}),
        })
        if (!auth)
          errors.push(`Provider '${route.id}' has no configured ${settings.agent.providers[route.id]?.auth.type}`)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
    return {
      ready: primaryAuthenticated,
      degraded: primaryAuthenticated && errors.length > 0,
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
        label: `${spec.role} · ${spec.provider}/${spec.model.id}`,
        ...(spec.parentID ? { parentID: spec.parentID } : {}),
      },
      childStarts: 0,
      toolCalls: 0,
      fallbackAdmissions: 0,
      fallbackDescendants: 0,
      automaticFallbackUsed: false,
      cumulativeUsage: emptyUsage(),
      finished: false,
    }
    this.#states.set(id, state)
    parent?.children.add(id)
    if (spec.role !== "root") this.#activeDelegatedRuns++
    if (spec.providerAffinity === "primary") {
      try {
        await this.#fallbackLedger.recordPrimaryActor()
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
    this.#emit(state, {
      type: "activity",
      runID: state.id,
      activity: { ...activity, actor: state.actor },
    })
  }

  #toolSet(state: RunState): AgentTool[] {
    const gatewayTools =
      state.spec.gatewayTools?.({
        role: state.spec.role,
        handoffOwner: state.spec.handoffOwner,
        providerAffinity: state.spec.providerAffinity,
      }) ?? []
    const base = [...state.spec.tools, ...gatewayTools].filter(
      (tool) =>
        (state.spec.handoffOwner || tool.name !== "handoff") &&
        (state.spec.providerAffinity === "primary" || tool.name !== "request_fallback_delegation"),
    )
    const reserved = new Set(["delegate_task", "request_fallback_delegation"])
    for (const tool of base)
      if (reserved.has(tool.name)) throw new Error(`AgentRun tool name '${tool.name}' is reserved by Cyberful`)

    const names = new Set<string>()
    for (const tool of base) {
      if (names.has(tool.name)) throw new Error(`AgentRun exposes duplicate tool '${tool.name}'`)
      names.add(tool.name)
    }

    if (state.spec.delegation.enabled && state.spec.prompt.manifest.delegationEnabled) {
      base.push(this.#delegateTool(state))
    }
    if (
      state.spec.providerAffinity === "primary" &&
      state.spec.fallback.providerConfigured &&
      state.spec.fallback.proactiveEnabled
    ) {
      base.push(this.#fallbackTool(state))
    }
    return base
  }

  #skillName(state: RunState, locator: string): string | undefined {
    const resolved = path.resolve(locator)
    return state.spec.skills.find(
      (skill) => skill.name === locator || path.resolve(skill.location) === resolved,
    )?.name
  }

  #delegateTool(state: RunState): AgentTool<typeof DelegateTaskParameters> {
    return {
      name: "delegate_task",
      label: "Delegate Cyberful Task",
      description:
        "Create one complete child AgentRun for a bounded subtask. The child receives the full Cyberful contract, persona, skills, and phase tools but not this transcript.",
      parameters: DelegateTaskParameters,
      execute: async (_callID, input) => {
        const child = await this.#startChild(state, {
          role: "subagent",
          route: state.spec.providerAffinity,
          task: taskCapsule(input),
        })
        const result = await child.result
        return {
          content: [
            {
              type: "text",
              text: [
                `Child AgentRun ${result.id} ${result.termination}.`,
                result.output || "The child returned no textual result.",
              ].join("\n\n"),
            },
          ],
          details: {
            runID: result.id,
            termination: result.termination,
            provider: result.provider,
            model: result.model,
            failure: result.failure,
          },
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
        const admission = await this.#fallbackLedger.tryAdmitProactive(
          state.spec.fallback.proactivePercentage,
        )
        const requestedAdmissions = admission.proactiveAdmissions - (admission.admitted ? 1 : 0)
        this.#emit(state, {
          type: "fallback",
          runID: state.id,
          mode: "proactive",
          state: "requested",
          quotaExempt: false,
          quota: {
            primaryActorRuns: admission.primaryActorRuns,
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
              primaryActorRuns: admission.primaryActorRuns,
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
            primaryActorRuns: admission.primaryActorRuns,
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
              primaryActorRuns: rolledBack.primaryActorRuns,
              admitted: rolledBack.proactiveAdmissions,
              limit: Math.floor(
                (rolledBack.primaryActorRuns * state.spec.fallback.proactivePercentage) / 100,
              ) + 1,
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
            primaryActorRuns: admission.primaryActorRuns,
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
            primaryActorRuns: admission.primaryActorRuns,
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
              primaryActorRuns: admission.primaryActorRuns,
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
    state.agent?.abort()
    return false
  }

  async #startChild(parent: RunState, options: StartChildOptions): Promise<AgentRun> {
    if (parent.finished || parent.cancellation) throw new Error("Parent AgentRun is no longer active")
    if (parent.childStarts >= parent.spec.delegation.maxPerRun)
      throw new Error(`AgentRun child limit reached (${parent.spec.delegation.maxPerRun})`)
    if (parent.spec.depth >= parent.spec.delegation.maxDepth)
      throw new Error(`AgentRun maximum delegation depth reached (${parent.spec.delegation.maxDepth})`)
    const activeDirectChildren = [...parent.children]
      .map((id) => this.#states.get(id))
      .filter((child): child is RunState => child !== undefined && !child.finished).length
    if (options.role === "subagent" && activeDirectChildren >= parent.spec.prompt.manifest.delegationLimit)
      throw new Error(
        `AgentRun persona concurrency limit reached (${parent.spec.prompt.manifest.delegationLimit})`,
      )
    if (this.#activeDelegatedRuns >= parent.spec.delegation.maxConcurrent)
      throw new Error(`AgentRun concurrent child limit reached (${parent.spec.delegation.maxConcurrent})`)
    if (options.route === "fallback" && !parent.spec.fallback.providerConfigured)
      throw new Error("No fallback provider is configured")
    if (parent.spec.providerAffinity === "fallback" && options.route !== "fallback")
      throw new Error("A fallback-affine subtree cannot return to the primary provider")

    const provider =
      options.route === "primary" ? this.#settings.agent.primary_provider : this.#settings.agent.fallback_provider
    if (!provider) throw new Error("No fallback provider is configured")
    const model = this.#registry.model(provider)
    const promptInput: ChildPromptInput = {
      role: options.role,
      providerRoute: options.route,
      task: options.task,
    }
    const prompt = parent.spec.compileChildPrompt(promptInput)
    parent.childStarts++
    if (options.route === "fallback") parent.fallbackDescendants++

    return this.start({
      ...parent.spec,
      id: undefined,
      role: options.role,
      parentID: parent.id,
      phaseRootID: parent.spec.role === "root" ? parent.id : parent.spec.phaseRootID,
      depth: parent.spec.depth + 1,
      provider,
      model,
      providerAffinity: options.route,
      prompt,
      task: options.task,
      handoffOwner: false,
      abort: parent.spec.abort,
      budget: {
        ...parent.spec.budget,
        deadlineAt: this.#now() + this.#remainingBudget(parent),
      },
    })
  }

  async #automaticFallback(state: RunState, failure: Failure): Promise<boolean> {
    if (
      state.spec.providerAffinity !== "primary" ||
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
            "Treat this as trusted host tool output, synthesize it into the phase work, and continue under the unchanged Cyberful system contract.",
            "",
            result.output ||
              "The fallback returned no textual summary; inspect any referenced workarea artifacts.",
          ].join("\n"),
        },
      ],
      details: {
        hostOwned: true,
        runID: result.id,
        providerAffinity: "fallback",
        termination: result.termination,
        failure: result.failure,
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
    const children = [...state.children]
      .map((id) => this.#states.get(id))
      .filter((child): child is RunState => child !== undefined)
    await Promise.allSettled(children.map((child) => this.#cancelState(child, "Parent AgentRun cancelled", mode)))
    state.agent?.abort()
    await state.resultPromise
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
      return
    }
    if (event.type === "tool_execution_start") {
      state.toolCalls++
      state.lastTool = { name: event.toolName, input: event.args }
      this.#emitActivity(state, {
        kind: "tool",
        tool: event.toolName,
        input: PiAudit.redactValue(event.args),
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
      if (event.toolName === "skill_read" && !event.isError) {
        const details = record(event.result)?.details
        const skill = record(details)?.skill
        const kind = record(details)?.kind
        if (typeof skill === "string" && skill.trim()) {
          state.skillsUsed.add(skill)
          if (kind === "instructions") state.skillsRead.add(skill)
        }
      }
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
    this.#emit(state, {
      type: "run_started",
      runID: state.id,
      ...(state.spec.parentID ? { parentID: state.spec.parentID } : {}),
      phaseRootID: rootID,
      role: state.spec.role,
      provider: state.spec.provider,
      model: state.spec.model.id,
      providerAffinity: state.spec.providerAffinity,
      promptSystemSha256: state.spec.prompt.manifest.systemSha256,
      promptManifest: state.spec.prompt.manifest,
    })
    this.#emitActivity(state, {
      kind: "agent",
      actor: state.actor,
      state: "started",
      transitionID: `${state.id}:created`,
    })

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
    const startBudgetTimer = () => {
      if (state.timer || state.finished || state.cancellation) return
      const remaining = state.timerRemainingMs ?? 0
      if (remaining <= 0) {
        state.cancellation = "budget"
        state.agent?.abort()
        return
      }
      state.timerStartedAt = this.#now()
      state.timer = setTimeout(() => {
        state.timer = undefined
        state.timerRemainingMs = 0
        state.cancellation ??= "budget"
        state.agent?.abort()
      }, remaining)
      state.timer.unref?.()
    }
    if (state.spec.budget.pause)
      state.removePauseListener = state.spec.budget.pause.subscribe((snapshot) => {
        if (snapshot.pending) stopBudgetTimer()
        else startBudgetTimer()
      })
    else startBudgetTimer()
    if (state.spec.abort) {
      const abort = () => {
        state.cancellation ??= "cancel"
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
        const agent = new Agent({
          initialState: {
            systemPrompt: state.spec.prompt.system,
            model: state.spec.model,
            thinkingLevel: state.spec.model.reasoning ? "high" : "off",
            tools: this.#toolSet(state),
            messages: [],
          },
          streamFn: (model, context, options) => {
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
          beforeToolCall: async ({ toolCall, args }) => {
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
                  reason:
                    "Read this skill's complete SKILL.md in this AgentRun before requesting package resources.",
                }
            }
          },
        })
        state.agent = agent
        agent.subscribe((event) => this.#observePiEvent(state, event))
        await agent.prompt(userMessages(state.spec))

        let last = latestAssistant(agent.state.messages)
        failure = PiSecurity.classify(
          providerObservation(adapter, state.spec.provider, state.spec.model.id, last, state.lastHTTPStatus),
        )
        if (failure && (await this.#automaticFallback(state, failure))) {
          last = latestAssistant(agent.state.messages)
          failure = PiSecurity.classify(
            providerObservation(adapter, state.spec.provider, state.spec.model.id, last, state.lastHTTPStatus),
          )
        }
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
      output ||= state.agent ? PiAudit.redactText(assistantText(latestAssistant(state.agent.state.messages))) : ""
    } finally {
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
      state.fallbackDescendants += state.childResults.reduce(
        (total, child) => total + child.fallbackDescendants,
        0,
      )
      state.fallbackAdmissions += state.childResults.reduce(
        (total, child) => total + child.fallbackAdmissions,
        0,
      )
      failure = auditedFailure(failure)
      const termination = terminationFor(state, failure)
      const result: AgentRunResult = {
        id: state.id,
        ...(state.spec.parentID ? { parentID: state.spec.parentID } : {}),
        phaseRootID: rootID,
        role: state.spec.role,
        provider: state.spec.provider,
        model: state.spec.model.id,
        providerAffinity: state.spec.providerAffinity,
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
      }
      state.finished = true
      this.#emitActivity(state, {
        kind: "agent",
        actor: state.actor,
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
        termination,
        ...(failure ? { failure } : {}),
        usage: state.cumulativeUsage,
        skillsUsed: [...state.skillsUsed].toSorted(),
        childRunIDs: [...state.children],
        fallbackAdmissions: state.fallbackAdmissions,
        fallbackDescendants: state.fallbackDescendants,
        toolCalls: state.toolCalls,
      })
      state.resolveResult(result)
      state.queue.close()
      if (state.spec.role === "root") state.rootQueue.close()
      if (state.spec.role !== "root") this.#activeDelegatedRuns = Math.max(0, this.#activeDelegatedRuns - 1)
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
