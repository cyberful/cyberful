// ── Agent Recovery Admission Tests ──────────────────────────────
// Protects route affinity, useful residual budgets, and one-time recovery
// bonuses across phase, delegated-run, and summary ownership boundaries.
// → cyberful/src/subsystem/recovery-policy.ts — owns the decisions under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { decideRecovery } from "./recovery-policy"

const securityBlock = {
  kind: "security_policy_block",
  providerCode: "cyberPolicy",
  evidence: "codex_error_code",
  retryable: false,
} as const

const base = {
  scope: "subagent_replacement",
  sourceRoute: "main",
  failure: securityBlock,
  enabled: true,
  fallbackConfigured: true,
  useFallbackProvider: true,
  alreadyRecovered: false,
  remainingRuntimeMs: 10_000,
  remainingOutputTokens: 4_096,
  recoveryBonusMs: 300_000,
  bonusAlreadyGranted: false,
} as const

describe("automatic recovery admission", () => {
  test("admits a structured non-retryable policy block with one deterministic bonus", () => {
    expect(decideRecovery(base)).toMatchObject({
      kind: "admitted",
      cause: "security_policy_block",
      route: "fallback",
      quotaExempt: true,
      bonusMs: 300_000,
      availableRuntimeMs: 310_000,
    })
  })

  test("does not grant a second bonus to the same recovery chain", () => {
    expect(decideRecovery({ ...base, bonusAlreadyGranted: true })).toMatchObject({
      kind: "denied",
      code: "insufficient_recovery_budget",
      availableRuntimeMs: 10_000,
    })
  })

  test("never returns a fallback-affine failure to main", () => {
    expect(decideRecovery({ ...base, sourceRoute: "fallback" })).toMatchObject({
      kind: "denied",
      code: "fallback_policy_block",
    })
  })

  test("reports an exact residual output budget limitation", () => {
    expect(decideRecovery({ ...base, remainingOutputTokens: 512 })).toMatchObject({
      kind: "denied",
      code: "insufficient_recovery_budget",
      availableOutputTokens: 512,
      requiredOutputTokens: 1_024,
    })
  })

  test("keeps ordinary retryable recovery on main when fallback routing is disabled", () => {
    expect(
      decideRecovery({
        ...base,
        failure: { kind: "network", providerCode: "ECONNRESET", retryable: true },
        useFallbackProvider: false,
      }),
    ).toMatchObject({
      kind: "admitted",
      cause: "retryable_provider_failure",
      route: "main",
      inputTreatment: "preserve",
    })
  })

  test("admits one authorization-reframed main-route retry when no fallback exists", () => {
    expect(
      decideRecovery({
        ...base,
        fallbackConfigured: false,
        authorizationReframeAvailable: true,
      }),
    ).toMatchObject({
      kind: "admitted",
      cause: "security_policy_block",
      route: "main",
      inputTreatment: "authorization_reframe",
    })
  })

  test("does not invent a same-route security recovery without an eligible workflow reframe", () => {
    expect(decideRecovery({ ...base, fallbackConfigured: false })).toMatchObject({
      kind: "denied",
      code: "fallback_unconfigured",
    })
  })
})
