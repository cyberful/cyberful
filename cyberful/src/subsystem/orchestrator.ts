// ── Sequential Workflow Orchestrator ──────────────────────────────
// Advances any registered Pi-owned workflow through validated handoffs,
// preserving one in-process phase owner and one private gateway at a time.
// → cyberful/src/subsystem/phase-runner.ts — owns each phase execution lifecycle.
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import { Effect } from "effect"
import { SubsystemPhase } from "./phase"
import type { PhaseSpec, PhaseResult } from "./phase-runner"
import { SessionReportLog } from "@/session/report-log"
import type { SessionID } from "@/session/schema"
import type { Candidate as CompletionCandidate } from "./completion"
import type { RunTermination } from "./cli"
import type { PhaseFailure } from "./phase-runner"
import { decideRecovery, type RecoveryDecision } from "./recovery-policy"
import { reframeAuthorizedSecurityInput, supportsAuthorizationReframe } from "./security-reframe"

export interface AdvanceInput {
  sessionID: SessionID
  // The Expert phase the session is currently on (lastUser.agent).
  startPhase: string
  // The engagement objective / prior handoff brief seeding the first phase.
  objective: string
  workareaCwd: string
  // Namespace for semantic phase names and their gateway capability policy.
  workflow: string
  sourceRoot?: string
  home: string
  settingsDirectory: string
  path: { cwd: string; root: string }
  timeoutMs: number
  // Private gateway environment; never forwarded to the model.
  env?: Record<string, string>
  // A warning from an earlier phase remains visible in the terminal result.
  degraded?: boolean
}

export interface AdvanceDeps {
  runPhase: (spec: PhaseSpec) => Promise<PhaseResult>
  resolveClientName?: () => Promise<string | undefined>
}

export interface AdvanceOutcome {
  ranPhases: string[]
  phaseAttempts: ReadonlyArray<{
    readonly phase: string
    readonly attempt: number
    readonly provider?: string
    readonly providerAffinity?: "main" | "fallback"
    readonly termination: RunTermination
    readonly recovered: boolean
  }>
  handedTo?: string
  // Set when a phase failed its deliverable/process/handoff gate. No successor was started.
  haltedAt?: string
  // true when the run ended on its workflow's terminal Expert phase: no successor, the engagement ends.
  terminal: boolean
  outcome: "success" | "warning" | "blocked" | "failed"
  summary: string
  termination?: RunTermination
  failure?: PhaseFailure
  completion?: CompletionCandidate
}

// ── Handoffs Seed The Successor Without Copying A Transcript ─────────
// A successor receives the prior summary for orientation and reads workarea
// artifacts for complete evidence. The summary is therefore bounded before it
// enters the next prompt, preventing verbose output or an accidental stream dump
// from consuming that phase's context. Truncation remains explicit and directs
// the successor to the durable source rather than silently dropping detail.
// ──────────────────────────────────────────────────────────────
const SUMMARY_CAP = 6000
function capSummary(text: string): string {
  return text.length <= SUMMARY_CAP
    ? text
    : text.slice(0, SUMMARY_CAP) + "\n…(summary truncated — read the workarea for the full detail)"
}

function providerFailureSummary(phase: string, failure: NonNullable<PhaseResult["subsystemFailure"]>): string {
  const providerCode = failure.providerCode ? `, provider code ${failure.providerCode}` : ""
  const httpStatus = failure.httpStatus !== undefined ? `, HTTP ${failure.httpStatus}` : ""
  const detail = failure.detail ? `: ${failure.detail}` : "."
  return `The ${phase} phase stopped because its Pi provider failed (${failure.kind}${providerCode}${httpStatus})${detail}`
}

function rejectedPhase(phase: string, input: AdvanceInput, error: unknown): PhaseResult {
  const limitMs = input.timeoutMs > 0 ? input.timeoutMs : SubsystemPhase.DEFAULT_PHASE_BUDGET_MINUTES * 60_000
  const now = Date.now()
  const detail = error instanceof Error ? error.message : String(error)
  return {
    phase,
    ok: false,
    summary: `The ${phase} phase runner failed before returning a result: ${detail}`,
    exitCode: 1,
    timedOut: false,
    termination: "subsystem_failed",
    backend: "pi",
    durationMs: 0,
    limitMs,
    effectiveLimitMs: limitMs,
    deadlineAt: now + limitMs,
    warnings: [],
    phaseFailure: {
      phase,
      source: "lifecycle",
      class: "phase_runner_rejected",
      detail,
    },
  }
}

function interruptedOutcome(termination: RunTermination | undefined): "blocked" | "failed" {
  return termination === "budget_exhausted" || termination === "shutdown" ? "blocked" : "failed"
}

function phaseOutcome(result: PhaseResult): "blocked" | "failed" {
  return result.phaseFailure ? "failed" : interruptedOutcome(result.termination)
}

function attemptTranscript(filePath: string, attempt: number) {
  if (attempt === 1) return filePath
  return filePath.endsWith(".jsonl")
    ? `${filePath.slice(0, -".jsonl".length)}.attempt-${attempt}.jsonl`
    : `${filePath}.attempt-${attempt}`
}

function recoveryObjective(
  phase: string,
  objective: string,
  result: PhaseResult,
  authorizationReframe?: { readonly workflow: string; readonly clientName?: string },
) {
  const failure = result.subsystemFailure
  const upstream = result.phaseFailure?.source === "upstream"
  const recoveredInput = [
    objective,
    "",
    `Host recovery attempt for the ${phase} phase after a recoverable ${upstream ? "required-upstream" : "provider"} failure.`,
    upstream
      ? `Previous termination: ${result.termination}; upstream failure: ${result.phaseFailure?.class ?? "unknown"}.`
      : `Previous termination: ${result.termination}; provider failure: ${failure?.kind ?? "unknown"}${failure?.providerCode ? ` (${failure.providerCode})` : ""}.`,
    "Continue from the existing workarea, phase checkpoint, hypothesis registry, surface coverage, and tool-usage artifacts.",
    "Before new target activity, list the current hypothesis registry and reconcile every OPEN, TESTING, QUEUED, and terminal entry.",
    "Reconcile completed calls before acting. Do not repeat an operation that may already have produced a target-side effect.",
    "Complete the original deliverable and handoff contract with the remaining phase budget.",
  ].join("\n")
  return authorizationReframe && supportsAuthorizationReframe(authorizationReframe.workflow)
    ? reframeAuthorizedSecurityInput({
        workflow: authorizationReframe.workflow,
        originalInput: recoveredInput,
        ...(authorizationReframe.clientName ? { clientName: authorizationReframe.clientName } : {}),
      })
    : recoveredInput
}

export const runAndAdvance = Effect.fn("Expert.runAndAdvance")(function* (input: AdvanceInput, deps: AdvanceDeps) {
  let phase = input.startPhase
  let objective = input.objective
  let lastSummary = ""
  let degraded = input.degraded === true
  const ranPhases: string[] = []
  const phaseAttempts: AdvanceOutcome["phaseAttempts"][number][] = []
  let acceptedHandoff = false

  while (SubsystemPhase.isExpertPhase(input.workflow, phase)) {
    const baseTranscript = SessionReportLog.expertTranscriptFile(
      { directory: input.path.cwd, worktree: input.path.root },
      input.sessionID,
      phase,
      input.workflow,
    )
    const attempted = yield* Effect.promise(async (abort) => {
      let attempt = 1
      let route: "main" | "fallback" = "main"
      let attemptObjective = objective
      let remainingTimeoutMs = input.timeoutMs
      let budgetCarry: NonNullable<PhaseSpec["budgetCarry"]> = {
        approvalWaitMs: 0,
        retryWaitMs: 0,
        targetCooldownWaitMs: 0,
        phaseExtensionMs: 0,
        recoveryExtensionMs: 0,
        recoveryChainIDs: [],
      }
      const results: PhaseResult[] = []
      while (true) {
        const result: PhaseResult = await deps
          .runPhase({
            phase,
            workflow: input.workflow,
            sessionID: input.sessionID,
            workareaCwd: input.workareaCwd,
            sourceRoot: input.sourceRoot,
            home: input.home,
            settingsDirectory: input.settingsDirectory,
            objective: attemptObjective,
            timeoutMs: remainingTimeoutMs,
            attempt,
            providerRoute: route,
            budgetCarry,
            abort,
            env: input.env,
            handoff: { successor: SubsystemPhase.nextAfterExpertPhase(input.workflow, phase) },
            transcriptPath: attemptTranscript(baseTranscript, attempt),
          })
          .catch((error) => rejectedPhase(phase, input, error))
        results.push(result)
        const policy: PhaseResult["recoveryPolicy"] = result.recoveryPolicy
        const elapsedBudgetMs = Math.max(0, result.durationMs)
        const availableBudgetMs = attempt === 1 ? result.limitMs : remainingTimeoutMs
        remainingTimeoutMs = Math.max(0, availableBudgetMs - elapsedBudgetMs)
        budgetCarry = {
          approvalWaitMs: Math.max(budgetCarry.approvalWaitMs, result.approvalWaitMs ?? 0),
          retryWaitMs: Math.max(budgetCarry.retryWaitMs, result.retryWaitMs ?? 0),
          targetCooldownWaitMs: Math.max(budgetCarry.targetCooldownWaitMs, result.targetCooldownWaitMs ?? 0),
          phaseExtensionMs: Math.max(budgetCarry.phaseExtensionMs, result.retryCompensationMs ?? 0),
          recoveryExtensionMs: budgetCarry.recoveryExtensionMs ?? 0,
          recoveryChainIDs: budgetCarry.recoveryChainIDs ?? [],
        }
        const providerFailure = result.phaseFailure?.source === "provider" ? result.subsystemFailure : undefined
        const authorizationReframeAvailable =
          policy?.fallbackConfigured === false && supportsAuthorizationReframe(input.workflow)
        const recoveryChainID = providerFailure
          ? `recovery_${createHash("sha256")
              .update(`${input.sessionID}\0${phase}\0${attempt}\0${providerFailure.kind}`)
              .digest("hex")
              .slice(0, 24)}`
          : undefined
        const providerRecovery: RecoveryDecision | undefined =
          providerFailure && policy
            ? decideRecovery({
                scope: "phase_restart",
                sourceRoute: route,
                failure: providerFailure,
                enabled:
                  policy.enabled &&
                  (providerFailure.kind !== "security_policy_block" ||
                    authorizationReframeAvailable ||
                    policy.automaticSecurityBlockEnabled !== false),
                fallbackConfigured: policy.fallbackConfigured,
                useFallbackProvider:
                  providerFailure.providerCode === "active_tail_too_large" ||
                  providerFailure.providerCode === "tool_call_history_mismatch"
                    ? false
                    : providerFailure.kind === "security_policy_block" || policy.useFallbackProvider,
                alreadyRecovered: attempt > 1,
                remainingRuntimeMs: remainingTimeoutMs - Math.max(0, result.closeoutReserveMs ?? 0),
                recoveryBonusMs: policy.recoveryBonusMs ?? 300_000,
                bonusAlreadyGranted:
                  recoveryChainID !== undefined && (budgetCarry.recoveryChainIDs ?? []).includes(recoveryChainID),
                authorizationReframeAvailable,
              })
            : undefined
        // ── Every Phase Restart Needs Useful Residual Runtime ─────
        // Required-service failures used to bypass the shared admission policy,
        // so a failure at the deadline could start a replacement with only a few
        // milliseconds. Setup then consumed that remainder and produced a second
        // zero-duration budget failure. Upstream recovery stays on the main model
        // route and receives no time bonus, but now shares the same one-restart
        // and minimum-research-time contract as provider-owned recovery.
        //
        // @docs/concepts/execution-model.md
        // ────────────────────────────────────────────────────────────
        const upstreamFailure =
          result.phaseFailure?.source === "upstream" && result.phaseFailure.retryable === true
            ? {
                kind: "transport" as const,
                retryable: true,
                ...(result.phaseFailure.code ? { providerCode: result.phaseFailure.code } : {}),
              }
            : undefined
        const upstreamRecovery: RecoveryDecision | undefined =
          upstreamFailure && policy
            ? decideRecovery({
                scope: "phase_restart",
                sourceRoute: route,
                failure: upstreamFailure,
                enabled: policy.enabled,
                fallbackConfigured: policy.fallbackConfigured,
                useFallbackProvider: false,
                alreadyRecovered: attempt > 1,
                remainingRuntimeMs: remainingTimeoutMs - Math.max(0, result.closeoutReserveMs ?? 0),
                recoveryBonusMs: 0,
                bonusAlreadyGranted: false,
              })
            : undefined
        const recoverableFailure = providerRecovery?.kind === "admitted" || upstreamRecovery?.kind === "admitted"
        if (result.ok || !recoverableFailure || !policy?.enabled || attempt > policy.maxRestarts || abort.aborted)
          return { result, results }
        if (providerRecovery?.kind === "admitted" && providerRecovery.bonusMs > 0 && recoveryChainID) {
          remainingTimeoutMs += providerRecovery.bonusMs
          budgetCarry = {
            ...budgetCarry,
            recoveryExtensionMs: (budgetCarry.recoveryExtensionMs ?? 0) + providerRecovery.bonusMs,
            recoveryChainIDs: [...(budgetCarry.recoveryChainIDs ?? []), recoveryChainID],
          }
        }
        const clientName =
          providerRecovery?.kind === "admitted" &&
          providerRecovery.inputTreatment === "authorization_reframe" &&
          input.workflow === "pentest"
            ? await deps.resolveClientName?.().catch(() => undefined)
            : undefined
        attemptObjective = recoveryObjective(
          phase,
          objective,
          result,
          providerRecovery?.kind === "admitted" && providerRecovery.inputTreatment === "authorization_reframe"
            ? { workflow: input.workflow, ...(clientName ? { clientName } : {}) }
            : undefined,
        )
        route =
          providerRecovery?.kind === "admitted"
            ? providerRecovery.route
            : upstreamRecovery?.kind === "admitted"
              ? upstreamRecovery.route
              : "main"
        attempt++
      }
    })
    const result = attempted.result
    attempted.results.forEach((attemptResult, index) => {
      phaseAttempts.push({
        phase,
        attempt: index + 1,
        provider: attemptResult.agentRun?.provider,
        providerAffinity: attemptResult.agentRun?.providerAffinity,
        termination: attemptResult.termination,
        recovered: index < attempted.results.length - 1,
      })
    })
    ranPhases.push(phase)
    degraded ||= attempted.results.length > 1 || !result.ok || result.warnings.length > 0
    lastSummary =
      capSummary(result.summary.trim()) ||
      (result.subsystemFailure
        ? capSummary(providerFailureSummary(phase, result.subsystemFailure))
        : result.phaseFailure
          ? capSummary(result.phaseFailure.detail)
          : `(the ${phase} phase produced no textual summary)`)
    acceptedHandoff =
      result.ok &&
      result.handoff !== undefined &&
      result.handoff.successor === SubsystemPhase.nextAfterExpertPhase(input.workflow, phase)
    if (!acceptedHandoff) {
      const outcome = phaseOutcome(result)
      lastSummary =
        `[Expert phase ${outcome}: ${result.termination}; exit ${result.exitCode}. ` +
        `No successor was started.]\n${lastSummary}`
    }

    const next = SubsystemPhase.nextAfterExpertPhase(input.workflow, phase)
    if (!acceptedHandoff)
      return {
        ranPhases,
        phaseAttempts,
        haltedAt: phase,
        terminal: false,
        outcome: phaseOutcome(result),
        summary: lastSummary,
        termination: result.termination,
        ...(result.phaseFailure ? { failure: result.phaseFailure } : {}),
      } satisfies AdvanceOutcome

    if (!next)
      return {
        ranPhases,
        phaseAttempts,
        terminal: true,
        outcome: degraded ? "warning" : "success",
        summary: lastSummary,
        completion: result.handoff?.completion,
      } satisfies AdvanceOutcome

    if (!SubsystemPhase.isExpertPhase(input.workflow, next)) {
      return {
        ranPhases,
        phaseAttempts,
        haltedAt: phase,
        terminal: false,
        outcome: "failed",
        summary: `Invalid Pi workflow successor '${next}' after '${phase}'. No successor was started.\n${lastSummary}`,
        failure: {
          phase,
          source: "contract",
          class: "invalid_successor",
          code: next,
          detail: `The configured workflow cannot advance from '${phase}' to '${next}'.`,
        },
      } satisfies AdvanceOutcome
    }

    // ── A Validated Handoff Cannot Overlap Its Successor ────────────
    // The gateway records a requested successor, but the orchestrator advances
    // only after runPhase has validated that request and completed its lifecycle.
    // At this point the old in-process Pi worker owner has shut down and its
    // private gateway is gone.
    // Assigning the next phase here therefore preserves single-phase ownership,
    // including when the prior phase needed forced shutdown or cleanup warnings.
    // ──────────────────────────────────────────────────────────────
    phase = next
    objective = `The prior Expert phase (${ranPhases[ranPhases.length - 1]}) produced:\n${lastSummary}\n\nNow carry out the ${next} phase to completion.`
  }

  return {
    ranPhases,
    phaseAttempts,
    handedTo: phase,
    terminal: false,
    outcome: degraded ? "warning" : "success",
    summary: lastSummary,
  } satisfies AdvanceOutcome
})

export * as SubsystemOrchestrator from "./orchestrator"
