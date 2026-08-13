// ── Live Phase Run-State Artifact Tests ─────────────────────────
// Verifies that bounded AgentRun health replaces one atomic operator view.
// → cyberful/src/subsystem/run-state-artifact.ts — owns the materialized state.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SubsystemPhaseBudgetClock } from "./phase-budget-clock"
import { RunStateArtifact, recordTerminalCleanup } from "./run-state-artifact"

describe("run-state artifact", () => {
  test("materializes terminal actor and budget state without transcript content", async () => {
    const workarea = await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-run-state-")))
    let clockNow = Date.now()
    const budgetClock = SubsystemPhaseBudgetClock.create({
      deadlineAt: clockNow + 60_000,
      retryCompensationCapMs: 30_000,
      now: () => clockNow,
    })
    try {
      const state = new RunStateArtifact({
        workarea,
        workflow: "pentest",
        phase: "recon",
        deadlineAt: clockNow + 60_000,
        budgetClock,
      })
      await state.observe({
        type: "run_started",
        runID: "run-1",
        phaseRootID: "run-1",
        role: "root",
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        providerAffinity: "main",
        reasoningEffort: "ultra",
        effectiveReasoningEffort: "max",
        context: {
          catalogContextWindow: 272_000,
          trustedRouteWindow: 272_000,
          operationalContextWindow: 256_000,
          continuationReserveTokens: 16_384,
          hardInputTokens: 255_616,
          effectiveOperationalWindow: 256_000,
          source: "catalog_default",
          warnings: [],
        },
        promptSystemSha256: "sha256",
        promptManifest: {
          workflow: "pentest",
          phase: "recon",
          personaID: "pentest/recon",
          role: "root",
          providerRoute: "main",
          systemSha256: "sha256",
          componentHashes: {},
          delegationEnabled: true,
          delegationLimit: 1,
          handoffOwner: true,
        },
      })
      const releaseRetry = budgetClock.suspend("provider_retry")
      clockNow += 2_000
      releaseRetry()
      const releaseCooldown = budgetClock.suspend("target_cooldown")
      clockNow += 3_000
      releaseCooldown()
      await state.observe({
        type: "provider_retry",
        runID: "run-1",
        state: "succeeded",
        attempt: 1,
        maxRetries: 3,
        retryWaitMs: 2_000,
        compensationMs: 2_000,
        deadlineAt: budgetClock.deadlineAt(),
        compensationCapReached: false,
      })
      await state.observe({
        type: "recovery",
        runID: "run-1",
        recoveryRunID: "run-2",
        chainID: "recovery-1",
        scope: "subagent_replacement",
        cause: "security_policy_block",
        state: "started",
        sourceRoute: "main",
        destinationRoute: "fallback",
        quotaExempt: true,
        bonusMs: 300_000,
        availableRuntimeMs: 360_000,
        deadlineAt: clockNow + 360_000,
      })
      await state.observe({
        type: "steering",
        runID: "run-1",
        steeringID: "steer-1",
        mode: "queue",
        state: "applied",
        acceptedAt: "2026-08-10T00:00:00.000Z",
        appliedAt: "2026-08-10T00:00:01.000Z",
      })
      budgetClock.grantRecoveryExtension("recovery-1", 300_000)
      await state.observe({
        type: "run_finished",
        runID: "run-1",
        role: "root",
        termination: "provider_failed",
        terminationCause: "security_policy_block",
        failure: { kind: "timeout", providerCode: "23", retryable: true },
        usage: { input: 100, output: 20, reasoning: 10, cacheRead: 0, cacheWrite: 0 },
        skillsUsed: [],
        childRunIDs: [],
        fallbackAdmissions: 0,
        fallbackDescendants: 0,
        toolCalls: 3,
      })
      await state.close()
      await recordTerminalCleanup({
        workarea,
        sessionID: "ses-1",
        state: "closed_with_cleanup_errors",
        removed: ["expert-removed"],
        remaining: ["expert-survivor"],
        terminal: {
          phase: "hacker",
          outcome: "failed",
          termination: "spawn_failed",
          failure: { source: "upstream", class: "required_upstream_unavailable" },
        },
      })
      const artifact = JSON.parse(
        await readFile(path.join(workarea, "raw/operations/run-state.json"), "utf8"),
      )
      expect(artifact).toMatchObject({
        workflow: "pentest",
        phase: "hacker",
        status: "failed",
        session_outcome: "failed",
        termination: "spawn_failed",
        failure: { source: "upstream", class: "required_upstream_unavailable" },
        retry_wait_ms: 2_000,
        target_cooldown_wait_ms: 3_000,
        retry_compensation_ms: 2_000,
        retry_compensation_cap_ms: 30_000,
        retry_compensation_cap_reached: false,
        recovery_extension_ms: 300_000,
        phase_extension_ms: 302_000,
        session_id: "ses-1",
        session_status: "closed_with_cleanup_errors",
        cleanup: {
          state: "failed",
          removed: ["expert-removed"],
          remaining: ["expert-survivor"],
        },
        retry: {
          state: "succeeded",
          retry_wait_ms: 2_000,
          compensation_ms: 2_000,
        },
        actors: [
          {
            id: "run-1",
            status: "failed",
            termination: "provider_failed",
            termination_cause: "security_policy_block",
            tool_calls: 3,
            reasoning_effort: "ultra",
            effective_reasoning_effort: "max",
            failure: { kind: "timeout", providerCode: "23" },
          },
        ],
        recoveries: [
          {
            chain_id: "recovery-1",
            state: "started",
            cause: "security_policy_block",
            source_route: "main",
            destination_route: "fallback",
            bonus_ms: 300_000,
          },
        ],
        steering: [{ id: "steer-1", state: "applied", mode: "queue", run_id: "run-1" }],
      })
      expect(JSON.stringify(artifact)).not.toContain("transcript")
    } finally {
      budgetClock.close()
      await rm(workarea, { recursive: true, force: true })
    }
  })
})
