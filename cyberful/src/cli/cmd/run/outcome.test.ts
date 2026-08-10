// ── One-Shot Run Outcome Tests ──────────────────────────────────
// Proves terminal workflow state, rather than HTTP transport success, controls
//   the exit status exposed to one-shot automation.
// → cyberful/src/cli/cmd/run/outcome.ts — owns the tested interpretation.
// ───────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { completionExitCode } from "./outcome"

describe("one-shot completion exit status", () => {
  test.each([
    ["success", 0],
    ["warning", 0],
    ["blocked", 1],
    ["failed", 1],
  ] as const)("maps %s to %d", (outcome, exitCode) => {
    expect(completionExitCode({ parts: [{ type: "completion", outcome }] })).toBe(exitCode)
  })

  test("ignores responses without an authoritative completion", () => {
    expect(completionExitCode({ parts: [{ type: "text", text: "done" }] })).toBeUndefined()
    expect(completionExitCode(undefined)).toBeUndefined()
  })
})
