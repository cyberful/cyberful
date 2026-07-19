// ── Blocking Question Keyboard Tests ─────────────────────────────
// Protects the terminal-wide Ctrl+C exit gesture while a question owns focus,
//   including modifier combinations that must remain ordinary question input.
// → cyberful/src/cli/cmd/run/question.shared.ts — classifies question key input.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { questionExitKey } from "./question.shared"

test("Ctrl+C remains an exit gesture while a question blocks the footer", () => {
  expect(questionExitKey({ name: "c", ctrl: true })).toBe(true)
  expect(questionExitKey({ name: "c", ctrl: true, shift: true })).toBe(false)
  expect(questionExitKey({ name: "c" })).toBe(false)
  expect(questionExitKey({ name: "escape" })).toBe(false)
})
