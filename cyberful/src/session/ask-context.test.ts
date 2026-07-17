// ── Ask Context Selection Tests ────────────────────────────────────────────
// Verifies that ask prompts receive bounded, ordered history and the prior run outcome.
// → cyberful/src/session/ask-context.ts — selects and renders the tested context.
// ───────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID, SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { ASK_HISTORY_CHARACTERS, SessionAskContext } from "./ask-context"

const sessionID = SessionID.make("ses_ask")
const providerID = ProviderID.make("codex")
const modelID = ModelID.make("test")

function user(index: number): MessageV2.WithParts {
  const id = MessageID.make(`msg_u${index}`)
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: index * 2 },
      agent: "ask",
      model: { providerID, modelID },
    },
    parts: [{ id: PartID.make(`prt_u${index}`), sessionID, messageID: id, type: "text", text: `question ${index}` }],
  }
}

function assistant(index: number): MessageV2.WithParts {
  const id = MessageID.make(`msg_a${index}`)
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: MessageID.make(`msg_u${index}`),
      time: { created: index * 2 + 1, completed: index * 2 + 2 },
      agent: "ask",
      mode: "ask",
      modelID,
      providerID,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{ id: PartID.make(`prt_a${index}`), sessionID, messageID: id, type: "text", text: `answer ${index}` }],
  }
}

describe("Ask explicit context", () => {
  test("keeps the latest eight exchanges and the previous completion card", () => {
    const completionMessage = assistant(0)
    completionMessage.info.agent = "brief"
    completionMessage.parts = [
      {
        id: PartID.make("prt_completion"),
        sessionID,
        messageID: completionMessage.info.id,
        type: "completion",
        workflow: "pentest",
        outcome: "success",
        title: "Pentest complete",
        summaryMarkdown: "Three low findings.",
        artifacts: [{ label: "Report", path: "reports/security-report.pdf", mime: "application/pdf" }],
        nextWorkflow: "ask",
      },
    ]
    const history = Array.from({ length: 10 }, (_, index) => [user(index + 1), assistant(index + 1)]).flat()
    const context = SessionAskContext.buildAskContext(
      [completionMessage, ...history, user(99)],
      MessageID.make("msg_u99"),
    )
    expect(context).toContain("Pentest complete")
    expect(context).toContain("question 10")
    expect(context).not.toContain("question 1\n")
    expect(context.length).toBeLessThanOrEqual(ASK_HISTORY_CHARACTERS)
  })

  test("caps an oversized newest exchange instead of reintroducing older turns", () => {
    const old = user(1)
    const latest = assistant(2)
    const firstPart = latest.parts[0]
    if (!firstPart) throw new Error("expected the assistant fixture to contain one part")
    latest.parts[0] = {
      ...firstPart,
      type: "text",
      text: "x".repeat(ASK_HISTORY_CHARACTERS * 2),
    }
    const context = SessionAskContext.buildAskContext([old, latest, user(99)], MessageID.make("msg_u99"))
    expect(context.length).toBe(ASK_HISTORY_CHARACTERS)
    expect(context).not.toContain("question 1")
    expect(context.endsWith("…")).toBe(true)
  })
})
