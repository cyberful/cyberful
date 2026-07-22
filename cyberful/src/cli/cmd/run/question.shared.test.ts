// ── Blocking Question Keyboard Tests ─────────────────────────────
// Protects the terminal-wide Ctrl+C exit gesture while a question owns focus,
//   including modifier combinations that must remain ordinary question input.
// → cyberful/src/cli/cmd/run/question.shared.ts — classifies question key input.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { createQuestionBodyState, questionDecline, questionExitKey, questionReady } from "./question.shared"

test("Ctrl+C remains an exit gesture while a question blocks the footer", () => {
  expect(questionExitKey({ name: "c", ctrl: true })).toBe(true)
  expect(questionExitKey({ name: "c", ctrl: true, shift: true })).toBe(false)
  expect(questionExitKey({ name: "c" })).toBe(false)
  expect(questionExitKey({ name: "escape" })).toBe(false)
})

test("question dismissal requires a visible second Escape", () => {
  const initial = createQuestionBodyState("que_decline_guard", 0)
  const armed = questionDecline(initial, 100)
  expect(armed.confirmed).toBe(false)
  expect(armed.state.declineArmedAt).toBe(100)

  const repeatedInTheSameInputBurst = questionDecline(armed.state, 107)
  expect(repeatedInTheSameInputBurst.confirmed).toBe(false)
  expect(repeatedInTheSameInputBurst.state).toBe(armed.state)

  const confirmed = questionDecline(armed.state, 400)
  expect(confirmed.confirmed).toBe(true)
  expect(confirmed.state.declineArmedAt).toBeUndefined()
})

test("an expired dismissal confirmation re-arms instead of rejecting", () => {
  const armed = questionDecline(createQuestionBodyState("que_decline_expiry", 0), 100)
  const expired = questionDecline(armed.state, 5_101)
  expect(expired.confirmed).toBe(false)
  expect(expired.state.declineArmedAt).toBe(5_101)
})

test("decisive input remains disabled during the presentation floor", () => {
  const state = createQuestionBodyState("que_presentation_floor", 100)
  expect(questionReady(state, 107)).toBe(false)
  expect(questionReady(state, 350)).toBe(true)
})
