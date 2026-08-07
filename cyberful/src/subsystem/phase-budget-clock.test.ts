// ── Phase Budget Clock Tests ────────────────────────────────────
// Verifies overlapping approval, retry, and target-cooldown accounting plus
//   exact effective deadline compensation for the phase-owned clock.
// → cyberful/src/subsystem/phase-budget-clock.ts — owns the behavior under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemPhaseBudgetClock } from "./phase-budget-clock"

describe("PhaseBudgetClock", () => {
  test("returns the exact retry interval to active execution", () => {
    let now = 1_000
    const clock = SubsystemPhaseBudgetClock.create({
      deadlineAt: 601_000,
      retryCompensationCapMs: 1_800_000,
      now: () => now,
    })

    const release = clock.suspend("provider_retry")
    now += 360_000
    release()

    expect(clock.snapshot()).toMatchObject({
      pending: false,
      retryWaitMs: 360_000,
      retryCompensationMs: 360_000,
      pausedMs: 360_000,
      deadlineAt: 961_000,
      retryCompensationCapReached: false,
    })
    clock.close()
  })

  test("counts overlapping retry and approval intervals once in the deadline", () => {
    let now = 0
    const clock = SubsystemPhaseBudgetClock.create({
      deadlineAt: 10_000,
      retryCompensationCapMs: 30_000,
      now: () => now,
    })

    const retry = clock.suspend("provider_retry")
    now = 2_000
    const approval = clock.suspend("approval")
    now = 5_000
    retry()
    now = 7_000
    approval()

    expect(clock.snapshot()).toMatchObject({
      pausedMs: 7_000,
      retryWaitMs: 5_000,
      retryCompensationMs: 5_000,
      approvalWaitMs: 5_000,
      deadlineAt: 17_000,
    })
    clock.close()
  })

  test("records the full retry wait while stopping compensation at the 15-minute cap", () => {
    let now = 0
    const clock = SubsystemPhaseBudgetClock.create({
      deadlineAt: 600_000,
      retryCompensationCapMs: 900_000,
      now: () => now,
    })

    const release = clock.suspend("provider_retry")
    now = 2_400_000
    release()

    expect(clock.snapshot()).toMatchObject({
      retryWaitMs: 2_400_000,
      retryCompensationMs: 900_000,
      pausedMs: 900_000,
      deadlineAt: 1_500_000,
      retryCompensationCapReached: true,
    })
    clock.close()
  })

  test("inherits cumulative waits without extending a replacement owner's fresh deadline twice", () => {
    let now = 10_000
    const clock = SubsystemPhaseBudgetClock.create({
      deadlineAt: 70_000,
      retryCompensationCapMs: 900_000,
      initialApprovalWaitMs: 2_000,
      initialRetryWaitMs: 12_000,
      initialTargetCooldownWaitMs: 180_000,
      initialRetryCompensationMs: 10_000,
      now: () => now,
    })

    expect(clock.snapshot()).toMatchObject({
      deadlineAt: 70_000,
      pausedMs: 0,
      approvalWaitMs: 2_000,
      retryWaitMs: 12_000,
      targetCooldownWaitMs: 180_000,
      retryCompensationMs: 10_000,
    })

    const release = clock.suspend("provider_retry")
    now += 5_000
    release()

    expect(clock.snapshot()).toMatchObject({
      deadlineAt: 75_000,
      pausedMs: 5_000,
      retryWaitMs: 17_000,
      retryCompensationMs: 15_000,
    })
    clock.close()
  })

  test("pauses for target cooldown and counts overlap with provider retry only once", () => {
    let now = 0
    const clock = SubsystemPhaseBudgetClock.create({
      deadlineAt: 20_000,
      retryCompensationCapMs: 30_000,
      now: () => now,
    })

    const cooldown = clock.suspend("target_cooldown")
    now = 2_000
    const retry = clock.suspend("provider_retry")
    now = 5_000
    retry()
    now = 7_000
    cooldown()

    expect(clock.snapshot()).toMatchObject({
      pending: false,
      pausedMs: 7_000,
      targetCooldownWaitMs: 7_000,
      retryWaitMs: 3_000,
      retryCompensationMs: 3_000,
      deadlineAt: 27_000,
    })
    clock.close()
  })
})
