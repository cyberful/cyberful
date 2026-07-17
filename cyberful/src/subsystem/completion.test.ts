// ── Completion Candidate Contract Tests ─────────────────────────
// Verifies that model-provided completion summaries are normalized and that
// unsafe or absolute artifact paths cannot escape the engagement workarea.
// → cyberful/src/subsystem/completion.ts — validates completion candidates.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemCompletion } from "./completion"

describe("completion candidate", () => {
  test("normalizes compact presentation and rejects unsafe artifact paths", () => {
    expect(
      SubsystemCompletion.parseCandidate({
        title: "  Client pentest complete  ",
        summaryMarkdown: "**3** low findings",
        artifacts: [
          { label: "Report", path: "reports/security-report.pdf" },
          { label: "Outside", path: "../secret" },
        ],
      }),
    ).toEqual({
      title: "Client pentest complete",
      summaryMarkdown: "**3** low findings",
      artifacts: [{ label: "Report", path: "reports/security-report.pdf" }],
    })
    expect(SubsystemCompletion.normalizeTitle("x".repeat(100), "fallback").length).toBe(80)
    expect(SubsystemCompletion.normalizeSummary("1\n2\n3\n4\n5\n6", "fallback")).toBe("1\n2\n3\n4\n5")
    expect(SubsystemCompletion.normalizeSummary("x".repeat(500), "fallback").length).toBe(240)
  })
})
