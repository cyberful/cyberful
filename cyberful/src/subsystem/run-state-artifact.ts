// ── Live Phase Run-State Artifact ────────────────────────────────
// Materializes root, child, retry, closeout, and terminal cleanup state into one
//   bounded atomic document without exposing sensitive transcript content.
// → cyberful/src/subsystem/pi-phase-runtime.ts — feeds authoritative AgentRun events.
// → cyberful/src/session/prompt.ts — records the verified session cleanup verdict.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import type { AgentEvent } from "./agent-subsystem"
import type { Controller as PhaseBudgetClock } from "./phase-budget-clock"
import { readWorkareaFileChunk, replaceWorkareaFile } from "@/workarea"
import { isRecord } from "@/util/record"

const RUN_STATE_PATH = "raw/operations/run-state.json"

interface ActorState {
  readonly id: string
  readonly parent_id?: string
  readonly recovery_of?: string
  readonly role?: string
  readonly provider?: string
  readonly model?: string
  readonly reasoning_effort?: string
  readonly effective_reasoning_effort?: string
  readonly reasoning_selection?: "parent" | "default"
  readonly context?: Extract<AgentEvent, { type: "run_started" }>["context"]
  readonly status: "running" | "completed" | "failed"
  readonly last_activity_at: string
  readonly tool_calls: number
  readonly termination?: string
  readonly failure?: unknown
}

export class RunStateArtifact {
  readonly #workarea: string
  readonly #workflow: string
  readonly #phase: string
  readonly #attempt: number
  readonly #deadlineAt: number
  readonly #budgetClock?: PhaseBudgetClock
  readonly #closeoutReserveMs: number
  readonly #actors = new Map<string, ActorState>()
  #mode: "work" | "closeout" = "work"

  #status: "starting" | "running" | "completed" | "failed" = "starting"

  #termination?: string

  #failure?: unknown
  #lastProgressAt = new Date().toISOString()
  #retry?: {
    readonly run_id: string
    readonly state: string
    readonly attempt: number
    readonly attempt_timeout_ms?: number
    readonly retry_wait_ms?: number
    readonly compensation_ms?: number
    readonly deadline_at?: string
    readonly compensation_cap_reached?: boolean
    readonly failure?: unknown
  }
  #queue: Promise<void> = Promise.resolve()

  constructor(input: {
    readonly workarea: string
    readonly workflow: string
    readonly phase: string
    readonly attempt?: number
    readonly deadlineAt: number
    readonly budgetClock?: PhaseBudgetClock
    readonly closeoutReserveMs?: number
  }) {
    this.#workarea = input.workarea
    this.#workflow = input.workflow
    this.#phase = input.phase
    this.#attempt = input.attempt ?? 1
    this.#deadlineAt = input.deadlineAt
    this.#budgetClock = input.budgetClock
    this.#closeoutReserveMs = input.closeoutReserveMs ?? 0
  }

  start() {
    return this.#persist()
  }

  fail(input: { readonly termination: string; readonly failure?: unknown }) {
    this.#status = "failed"
    this.#termination = input.termination
    this.#failure = input.failure
    this.#lastProgressAt = new Date().toISOString()
    return this.#persist()
  }

  observe(event: AgentEvent) {
    const now = new Date().toISOString()
    if (event.type === "activity" && event.activity.kind === "reasoning") return Promise.resolve()
    if (event.type === "run_started") {
      this.#status = "running"
      this.#actors.set(event.runID, {
        id: event.runID,
        ...(event.parentID ? { parent_id: event.parentID } : {}),
        ...(event.recoveryOf ? { recovery_of: event.recoveryOf } : {}),
        role: event.role,
        provider: event.provider,
        model: event.model,
        reasoning_effort: event.reasoningEffort,
        effective_reasoning_effort: event.effectiveReasoningEffort,
        ...(event.reasoningSelection ? { reasoning_selection: event.reasoningSelection } : {}),
        context: event.context,
        status: "running",
        last_activity_at: now,
        tool_calls: 0,
      })
      this.#lastProgressAt = now
    } else if (event.type === "activity") {
      const previous = this.#actors.get(event.runID)
      if (previous) {
        const toolCalls = event.activity.kind === "tool" ? previous.tool_calls + 1 : previous.tool_calls
        this.#actors.set(event.runID, { ...previous, last_activity_at: now, tool_calls: toolCalls })
      }
      if (event.activity.kind !== "progress" && event.activity.kind !== "reasoning") this.#lastProgressAt = now
    } else if (event.type === "provider_retry") {
      this.#retry = {
        run_id: event.runID,
        state: event.state,
        attempt: event.attempt,
        ...(event.attemptTimeoutMs ? { attempt_timeout_ms: event.attemptTimeoutMs } : {}),
        ...(event.retryWaitMs !== undefined ? { retry_wait_ms: event.retryWaitMs } : {}),
        ...(event.compensationMs !== undefined ? { compensation_ms: event.compensationMs } : {}),
        ...(event.deadlineAt !== undefined ? { deadline_at: new Date(event.deadlineAt).toISOString() } : {}),
        ...(event.compensationCapReached !== undefined
          ? { compensation_cap_reached: event.compensationCapReached }
          : {}),
        ...(event.failure ? { failure: event.failure } : {}),
      }
      this.#lastProgressAt = now
    } else if (event.type === "phase_closeout") {
      this.#mode = "closeout"
      this.#lastProgressAt = now
    } else if (event.type === "run_finished") {
      const previous = this.#actors.get(event.runID)
      this.#actors.set(event.runID, {
        id: event.runID,
        ...(previous?.parent_id ? { parent_id: previous.parent_id } : {}),
        ...(previous?.recovery_of ? { recovery_of: previous.recovery_of } : {}),
        ...(previous?.role ? { role: previous.role } : {}),
        ...(previous?.provider ? { provider: previous.provider } : {}),
        ...(previous?.model ? { model: previous.model } : {}),
        ...(previous?.reasoning_effort ? { reasoning_effort: previous.reasoning_effort } : {}),
        ...(previous?.effective_reasoning_effort
          ? { effective_reasoning_effort: previous.effective_reasoning_effort }
          : {}),
        ...(previous?.reasoning_selection ? { reasoning_selection: previous.reasoning_selection } : {}),
        ...(previous?.context ? { context: previous.context } : {}),
        status: event.termination === "completed" ? "completed" : "failed",
        last_activity_at: now,
        tool_calls: event.toolCalls,
        termination: event.termination,
        ...(event.failure ? { failure: event.failure } : {}),
      })
      this.#lastProgressAt = now
      if (!previous?.parent_id) {
        this.#status = event.termination === "completed" ? "completed" : "failed"
        this.#termination = event.termination
        this.#failure = event.failure
      }
    }
    return this.#persist()
  }

  close() {
    return this.#queue
  }

  #persist() {
    const budget = this.#budgetClock?.snapshot()
    const deadlineAt = budget?.deadlineAt ?? this.#deadlineAt
    const pending = this.#queue.then(() =>
      replaceWorkareaFile(
        this.#workarea,
        RUN_STATE_PATH,
        `${JSON.stringify(
          {
            version: 1,
            workflow: this.#workflow,
            phase: this.#phase,
            attempt: this.#attempt,
            status: this.#status,
            ...(this.#termination ? { termination: this.#termination } : {}),
            ...(this.#failure ? { failure: this.#failure } : {}),
            mode: this.#mode,
            deadline_at: new Date(deadlineAt).toISOString(),
            budget_remaining_ms: Math.max(0, deadlineAt - Date.now()),
            closeout_reserve_ms: this.#closeoutReserveMs,
            closeout_remaining_ms:
              this.#mode === "closeout" ? Math.max(0, Math.min(this.#closeoutReserveMs, deadlineAt - Date.now())) : 0,
            ...(budget
              ? {
                  approval_wait_ms: Math.round(budget.approvalWaitMs),
                  human_wait_ms: Math.round(budget.approvalWaitMs),
                  retry_wait_ms: Math.round(budget.retryWaitMs),
                  provider_wait_ms: Math.round(budget.retryWaitMs),
                  target_cooldown_wait_ms: Math.round(budget.targetCooldownWaitMs),
                  retry_compensation_ms: Math.round(budget.retryCompensationMs),
                  phase_extension_ms: Math.round(budget.retryCompensationMs),
                  retry_compensation_cap_ms: budget.retryCompensationCapMs,
                  phase_extension_cap_ms: budget.retryCompensationCapMs,
                  retry_compensation_cap_reached: budget.retryCompensationCapReached,
                }
              : {}),
            last_progress_at: this.#lastProgressAt,
            updated_at: new Date().toISOString(),
            actors: [...this.#actors.values()],
            ...(this.#retry ? { retry: this.#retry } : {}),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      ).then(() => undefined),
    )
    this.#queue = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
}

// ── Session Closure Includes Its Cleanup Verdict ────────────────
// Phase actors finish before engagement-scoped Docker resources are reaped, so
// the live writer cannot know the terminal cleanup result. The session finalizer
// updates the same bounded artifact only after label verification completes.
// A failed cleanup is represented as closed-with-errors rather than silently
// presenting a clean terminal state while disposable resources remain alive.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
export async function recordTerminalCleanup(input: {
  readonly workarea: string
  readonly sessionID: string
  readonly state: "closed" | "closed_with_cleanup_errors"
  readonly removed: readonly string[]
  readonly remaining: readonly string[]
  readonly terminal?: {
    readonly phase?: string
    readonly outcome: "success" | "warning" | "blocked" | "failed"
    readonly termination?: string
    readonly failure?: unknown
  }
}): Promise<void> {
  const chunk = await readWorkareaFileChunk(input.workarea, RUN_STATE_PATH)
  if (chunk.nextOffset !== undefined) throw new Error("run-state artifact is too large for terminal cleanup update")
  let decoded: unknown
  try {
    decoded = JSON.parse(chunk.content)
  } catch (error) {
    throw new Error("run-state artifact is invalid JSON during terminal cleanup", { cause: error })
  }
  if (!isRecord(decoded)) throw new Error("run-state artifact must contain an object")
  const updatedAt = new Date().toISOString()
  await replaceWorkareaFile(
    input.workarea,
    RUN_STATE_PATH,
    `${JSON.stringify(
      {
        ...decoded,
        session_id: input.sessionID,
        session_status: input.state,
        ...(input.terminal
          ? {
              ...(input.terminal.phase ? { phase: input.terminal.phase } : {}),
              status:
                input.terminal.outcome === "success" || input.terminal.outcome === "warning"
                  ? "completed"
                  : input.terminal.outcome,
              session_outcome: input.terminal.outcome,
              ...(input.terminal.termination ? { termination: input.terminal.termination } : {}),
              ...(input.terminal.failure ? { failure: input.terminal.failure } : {}),
            }
          : {}),
        cleanup: {
          state: input.state === "closed" ? "completed" : "failed",
          removed: [...input.removed],
          remaining: [...input.remaining],
          completed_at: updatedAt,
        },
        updated_at: updatedAt,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
}

export * as SubsystemRunStateArtifact from "./run-state-artifact"
