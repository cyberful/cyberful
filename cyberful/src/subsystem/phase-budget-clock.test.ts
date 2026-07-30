// ── Phase Budget Clock Tests ────────────────────────────────────
// Verifies overlapping suspension accounting, retry caps, and exact effective
//   deadline compensation for the phase-owned active-execution clock.
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

  test("records the full retry wait while stopping compensation at the 30-minute cap", () => {
    let now = 0
    const clock = SubsystemPhaseBudgetClock.create({
      deadlineAt: 600_000,
      retryCompensationCapMs: 1_800_000,
      now: () => now,
    })

    const release = clock.suspend("provider_retry")
    now = 2_400_000
    release()

    expect(clock.snapshot()).toMatchObject({
      retryWaitMs: 2_400_000,
      retryCompensationMs: 1_800_000,
      pausedMs: 1_800_000,
      deadlineAt: 2_400_000,
      retryCompensationCapReached: true,
    })
    clock.close()
  })
})
