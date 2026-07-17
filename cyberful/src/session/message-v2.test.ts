// ── Session Message Selection Tests ─────────────────────────────────────
// Verifies phase-aware message head selection and immediate-versus-deferred delivery.
// → cyberful/src/session/message-v2.ts — implements the tested message queries.
// ─────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, SessionID } from "./schema"
import { MessageV2 } from "./message-v2"

const sessionID = SessionID.make("ses_test")
const providerID = ProviderID.make("test")
const modelID = ModelID.make("test-model")

function user(id: string, delivery?: "immediate" | "deferred"): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID, modelID },
      metadata: delivery ? { delivery } : undefined,
    },
    parts: [],
  }
}

function assistant(id: string, parentID: string): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "assistant",
      parentID: MessageID.make(parentID),
      modelID,
      providerID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 2, completed: 3 },
      finish: "stop",
    },
    parts: [],
  }
}

describe("MessageV2 continuation metadata", () => {
  test("carries only phase-owned prompt metadata", () => {
    expect(
      MessageV2.continuationMetadata({
        think: "max",
        workarea: "launchdarkly",
        expert_engagement_status: "completed_with_warnings",
      }),
    ).toEqual({
      think: "max",
      workarea: "launchdarkly",
      expert_engagement_status: "completed_with_warnings",
    })
  })

  test("is empty before phase-owned metadata exists", () => {
    expect(MessageV2.continuationMetadata(undefined)).toEqual({})
  })
})

describe("MessageV2 delivery helpers", () => {
  test("deferred user messages are excluded from active latest state", () => {
    const messages = [user("msg_001"), assistant("msg_002", "msg_001"), user("msg_003", "deferred")]

    expect(MessageV2.active(messages).map((msg) => msg.info.id)).toEqual([
      MessageID.make("msg_001"),
      MessageID.make("msg_002"),
    ])
    expect(MessageV2.latest(messages).user?.id).toBe(MessageID.make("msg_001"))
  })

  test("deferred user messages are promoted FIFO", () => {
    const messages = [user("msg_004", "deferred"), user("msg_003", "deferred")]
    const next = MessageV2.nextDeferred(messages)

    expect(next?.info.id).toBe(MessageID.make("msg_003"))
    if (!next) throw new Error("Expected one deferred user message")
    expect(MessageV2.promoteDeferredUser(next.info).metadata?.delivery).toBeUndefined()
  })

  test("immediate user messages remain visible while deferred messages wait", () => {
    const messages = [
      user("msg_001"),
      assistant("msg_002", "msg_001"),
      user("msg_003", "immediate"),
      user("msg_004", "deferred"),
    ]

    expect(MessageV2.latest(messages).user?.id).toBe(MessageID.make("msg_003"))
    expect(MessageV2.active(messages).map((msg) => msg.info.id)).toEqual([
      MessageID.make("msg_001"),
      MessageID.make("msg_002"),
      MessageID.make("msg_003"),
    ])
  })
})

describe("MessageV2 persistence boundaries", () => {
  test("round-trips pagination cursors and rejects malformed client input", () => {
    const value = { id: MessageID.make("msg_cursor"), time: 42 }

    expect(MessageV2.cursor.decode(MessageV2.cursor.encode(value))).toEqual(value)
    expect(() => MessageV2.cursor.decode(Buffer.from("not-json").toString("base64url"))).toThrow()
  })

  test("rejects malformed parts read from persistence", () => {
    expect(() => MessageV2.decodePart({ type: "text", text: "missing identity" })).toThrow()
  })
})
