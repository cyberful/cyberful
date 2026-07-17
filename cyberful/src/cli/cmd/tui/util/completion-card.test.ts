// ── Completion Card Semantics Tests ──────────────────────────────
// Protects the status tone and badge users see for successful, warning, blocked,
//   and failed workflow completion outcomes.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { CompletionCard } from "./completion-card"

describe("completion card semantics", () => {
  test("maps every outcome to its status color and compact badge", () => {
    expect(
      Object.fromEntries(
        (["success", "warning", "blocked", "failed"] as const).map((outcome) => [
          outcome,
          [CompletionCard.tone(outcome), CompletionCard.statusLabel(outcome)],
        ]),
      ),
    ).toEqual({
      success: ["success", "COMPLETED"],
      warning: ["warning", "COMPLETED WITH WARNINGS"],
      blocked: ["warning", "BLOCKED"],
      failed: ["error", "FAILED"],
    })
  })
})
