// ── Agent Recovery Admission Policy ─────────────────────────────
// Normalizes phase, delegated-run, and context recovery decisions so every
// provider route follows one budget, affinity, and retry contract.
// → cyberful/src/subsystem/pi-agent.ts — executes delegated recovery plans.
// → cyberful/src/subsystem/orchestrator.ts — executes phase recovery plans.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import type { Failure } from "./pi-security"

export interface RecoveryFailure {
  readonly kind: Failure["kind"] | "transport"
  readonly providerCode?: string
  readonly retryable: boolean
}

export type RecoveryCause =
  | "security_policy_block"
  | "retryable_provider_failure"
  | "context_rotation_failure"

export type RecoveryScope = "phase_restart" | "subagent_replacement" | "summary_recovery"

export type RecoveryDenialCode =
  | "recovery_not_applicable"
  | "recovery_disabled"
  | "fallback_unconfigured"
  | "recovery_exhausted"
  | "fallback_policy_block"
  | "insufficient_recovery_budget"

export interface RecoveryRequest {
  readonly scope: RecoveryScope
  readonly sourceRoute: "main" | "fallback"
  readonly failure: RecoveryFailure
  readonly enabled: boolean
  readonly fallbackConfigured: boolean
  readonly useFallbackProvider: boolean
  readonly alreadyRecovered: boolean
  readonly remainingRuntimeMs: number
  readonly remainingOutputTokens?: number
  readonly recoveryBonusMs: number
  readonly bonusAlreadyGranted: boolean
  readonly minimumResearchMs?: number
  readonly minimumOutputTokens?: number
  readonly authorizationReframeAvailable?: boolean
}

export type RecoveryDecision =
  | {
      readonly kind: "admitted"
      readonly cause: RecoveryCause
      readonly scope: RecoveryScope
      readonly route: "main" | "fallback"
      readonly quotaExempt: true
      readonly bonusMs: number
      readonly availableRuntimeMs: number
      readonly availableOutputTokens?: number
      readonly inputTreatment: "preserve" | "authorization_reframe"
    }
  | {
      readonly kind: "denied"
      readonly code: RecoveryDenialCode
      readonly cause?: RecoveryCause
      readonly scope: RecoveryScope
      readonly availableRuntimeMs: number
      readonly requiredRuntimeMs: number
      readonly availableOutputTokens?: number
      readonly requiredOutputTokens: number
    }

export const MINIMUM_RECOVERY_RESEARCH_MS = 60_000
export const MINIMUM_RECOVERY_OUTPUT_TOKENS = 1_024

function causeFor(failure: RecoveryFailure): RecoveryCause | undefined {
  if (failure.kind === "security_policy_block") return "security_policy_block"
  if (failure.kind === "capacity" && failure.providerCode === "context_rotation_failed")
    return "context_rotation_failure"
  if (failure.retryable) return "retryable_provider_failure"
  return undefined
}

// ── One Boundary Decides Every Automatic Recovery ───────────────
// A failed provider call cannot choose its own route or manufacture budget.
// The owner supplies normalized evidence and this pure decision applies the
// same no-ping-pong, single-replacement, and minimum-useful-budget invariants
// for roots, delegated runs, and semantic summaries. Security-policy evidence
// is handled directly because providers deliberately mark it non-retryable.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
export function decideRecovery(request: RecoveryRequest): RecoveryDecision {
  const cause = causeFor(request.failure)
  const minimumRuntimeMs = request.minimumResearchMs ?? MINIMUM_RECOVERY_RESEARCH_MS
  const minimumOutputTokens = request.minimumOutputTokens ?? MINIMUM_RECOVERY_OUTPUT_TOKENS
  const availableRuntimeMs = Math.max(
    0,
    Math.floor(request.remainingRuntimeMs + (request.bonusAlreadyGranted ? 0 : request.recoveryBonusMs)),
  )
  const common = {
    scope: request.scope,
    availableRuntimeMs,
    requiredRuntimeMs: minimumRuntimeMs,
    ...(request.remainingOutputTokens === undefined
      ? {}
      : { availableOutputTokens: Math.max(0, Math.floor(request.remainingOutputTokens)) }),
    requiredOutputTokens: minimumOutputTokens,
  } as const

  if (!cause) return { kind: "denied", code: "recovery_not_applicable", ...common }
  if (!request.enabled) return { kind: "denied", code: "recovery_disabled", cause, ...common }
  if (request.alreadyRecovered) return { kind: "denied", code: "recovery_exhausted", cause, ...common }
  if (request.sourceRoute === "fallback")
    return { kind: "denied", code: "fallback_policy_block", cause, ...common }

  const authorizationReframe =
    cause === "security_policy_block" &&
    !request.fallbackConfigured &&
    request.authorizationReframeAvailable === true
  const requiresFallback =
    !authorizationReframe && (cause === "security_policy_block" || request.useFallbackProvider)
  if (requiresFallback && !request.fallbackConfigured)
    return { kind: "denied", code: "fallback_unconfigured", cause, ...common }
  if (
    availableRuntimeMs < minimumRuntimeMs ||
    (request.remainingOutputTokens !== undefined && request.remainingOutputTokens < minimumOutputTokens)
  )
    return {
      kind: "denied",
      code: "insufficient_recovery_budget",
      cause,
      ...common,
    }

  return {
    kind: "admitted",
    cause,
    scope: request.scope,
    route: requiresFallback ? "fallback" : "main",
    inputTreatment: authorizationReframe ? "authorization_reframe" : "preserve",
    quotaExempt: true,
    bonusMs: request.bonusAlreadyGranted ? 0 : Math.max(0, Math.floor(request.recoveryBonusMs)),
    availableRuntimeMs,
    ...(request.remainingOutputTokens === undefined
      ? {}
      : { availableOutputTokens: Math.max(0, Math.floor(request.remainingOutputTokens)) }),
  }
}

export * as SubsystemRecoveryPolicy from "./recovery-policy"
