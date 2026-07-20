// ── Transcript Completion Export Tests ───────────────────────────
// Protects the Markdown outcome, summary, workarea, and safe artifact links users
//   receive when exporting a completed workflow session.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { CompletionPart } from "@/server/client"
import { formatPart } from "./transcript"

describe("session transcript completion export", () => {
  test("serializes the durable card and its artifact links as Markdown", () => {
    const part = {
      id: "prt_completion",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "completion",
      workflow: "pentest",
      outcome: "warning",
      title: "Pentest completed with warnings",
      summaryMarkdown: "The PDF renderer failed; the source report is available.",
      workarea: "Client Portal",
      artifacts: [{ label: "Report [source]", path: "REPORT final.md", mime: "text/markdown", primary: true }],
      nextWorkflow: "ask",
    } satisfies CompletionPart

    expect(formatPart(part, { thinking: false, toolDetails: false, assistantMetadata: false })).toContain(
      [
        "## Pentest completed with warnings",
        "",
        "**Outcome:** warning",
        "",
        "The PDF renderer failed; the source report is available.",
        "",
        "**Artifacts**",
        "",
        "- [Report \\[source\\]](work/client-portal/REPORT%20final.md)",
      ].join("\n"),
    )
  })
})
