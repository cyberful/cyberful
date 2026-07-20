// ── Phase Approval Suspension Tests ──────────────────────────────
// Verifies nested pending decisions produce one pause interval and resume only
//   after the final answer settles.
// → cyberful/src/subsystem/approval-state.ts — owns the phase-local counter.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { SubsystemApprovalState } from "./approval-state"

test("nested approvals suspend once and resume after the final settlement", async () => {
  let now = 100
  const state = SubsystemApprovalState.create({ now: () => now })
  const transitions: Array<{ pending: boolean; count: number }> = []
  const unsubscribe = state.subscribe((snapshot) => transitions.push(snapshot))
  const first = Promise.withResolvers<void>()
  const second = Promise.withResolvers<void>()

  const firstWait = state.wait(() => first.promise)
  now = 130
  const secondWait = state.wait(() => second.promise)
  now = 180
  first.resolve()
  await firstWait
  expect(state.snapshot()).toEqual({ pending: true, count: 1 })
  expect(state.pausedMs()).toBe(80)

  now = 240
  second.resolve()
  await secondWait
  expect(state.snapshot()).toEqual({ pending: false, count: 0 })
  expect(state.pausedMs()).toBe(140)
  expect(transitions).toEqual([
    { pending: false, count: 0 },
    { pending: true, count: 1 },
    { pending: false, count: 0 },
  ])
  unsubscribe()
})

test("a rejected approval still resumes the phase clock", async () => {
  let now = 10
  const state = SubsystemApprovalState.create({ now: () => now })
  const waiting = state.wait(async () => {
    now = 45
    throw new Error("denied")
  })

  await expect(waiting).rejects.toThrow("denied")
  expect(state.snapshot()).toEqual({ pending: false, count: 0 })
  expect(state.pausedMs()).toBe(35)
})
