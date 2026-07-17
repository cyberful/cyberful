// ── Session Phase Epoch Tests ─────────────────────────────────────
// Verifies phase-epoch derivation across prompts, continuations, and terminal states.
// → cyberful/src/session/phase-epoch.ts — implements the tested boundary derivation.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "./schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionPhaseEpoch } from "./phase-epoch"
import type { MessageV2 } from "./message-v2"

const sessionID = SessionID.make("ses_epoch")
const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("model") }

function user(id: string, agent: string, created: number, metadata?: Record<string, unknown>, synthetic = false) {
  const info = {
    id: MessageID.make(id),
    sessionID,
    role: "user" as const,
    time: { created },
    agent,
    model,
    metadata,
  }
  return {
    info,
    parts: synthetic
      ? [
          {
            id: PartID.make(`prt_${id}`),
            messageID: info.id,
            sessionID,
            type: "text" as const,
            text: "internal continuation",
            synthetic: true,
          },
        ]
      : [],
  } satisfies MessageV2.WithParts
}

function assistant(
  id: string,
  parentID: string,
  agent: string,
  created: number,
  input: { completed?: number; finish?: string; error?: MessageV2.Assistant["error"] } = {},
): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role: "assistant" as const,
      time: { created, completed: input.completed },
      parentID: MessageID.make(parentID),
      modelID: model.modelID,
      providerID: model.providerID,
      mode: "all",
      agent,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: input.finish,
      error: input.error,
    },
    parts: [],
  }
}

function epoch(messages: MessageV2.WithParts[]) {
  const result = SessionPhaseEpoch.derive(messages)
  if (!result) throw new Error("expected messages to define a phase epoch")
  return result
}

describe("SessionPhaseEpoch", () => {
  test("keeps synthetic, steer and fallback continuations in one epoch", () => {
    const snapshot = SessionPhaseEpoch.derive([
      user("msg_01", "exploit", 100),
      assistant("msg_02", "msg_01", "exploit", 110, { completed: 120, finish: "tool-calls" }),
      user("msg_04", "exploit", 140, { delivery: "immediate" }),
      user("msg_05", "exploit", 150, { model_router: { fallback: true } }),
      user("msg_06", "exploit", 160, undefined, true),
    ])

    expect(snapshot).toMatchObject({
      agent: "exploit",
      firstUserMessageID: "msg_01",
      enteredAt: 100,
      completionCount: 1,
    })
  })

  test("starts a new epoch for a real idle objective on the same agent", () => {
    const snapshot = SessionPhaseEpoch.derive([
      user("msg_01", "hacker", 100),
      assistant("msg_02", "msg_01", "hacker", 110, { completed: 120, finish: "stop" }),
      user("msg_03", "hacker", 200),
    ])

    expect(snapshot).toMatchObject({
      firstUserMessageID: "msg_03",
      enteredAt: 200,
      completionCount: 0,
    })
  })

  test("handoff and reverse handoff each create a fresh epoch", () => {
    const snapshot = SessionPhaseEpoch.derive([
      user("msg_01", "pentest-recon", 100),
      user("msg_02", "exploit", 200),
      user("msg_03", "pentest-recon", 300),
    ])

    expect(snapshot).toMatchObject({ agent: "pentest-recon", firstUserMessageID: "msg_03", enteredAt: 300 })
  })

  test("counts only successful completed turns, including tool-only completions", () => {
    const snapshot = SessionPhaseEpoch.derive([
      user("msg_01", "exploit", 100),
      assistant("msg_02", "msg_01", "exploit", 110),
      assistant("msg_03", "msg_01", "exploit", 120, {
        completed: 130,
        finish: "error",
        error: { name: "UnknownError", data: { message: "fixture failure" } },
      }),
      assistant("msg_04", "msg_01", "exploit", 140, { completed: 150, finish: "tool-calls" }),
      assistant("msg_05", "msg_01", "other", 160, { completed: 170, finish: "stop" }),
    ])

    expect(snapshot?.completionCount).toBe(1)
  })

  test("applies grace before distinguishing waiting from ready", () => {
    const waiting = epoch([user("msg_01", "exploit", 100)])
    const ready = epoch([
      user("msg_01", "exploit", 100),
      assistant("msg_02", "msg_01", "exploit", 110, { completed: 120, finish: "stop" }),
    ])

    expect(SessionPhaseEpoch.eligibility(waiting, 199, 100)).toBe("grace")
    expect(SessionPhaseEpoch.eligibility(waiting, 200, 100)).toBe("waiting")
    expect(SessionPhaseEpoch.eligibility(ready, 200, 100)).toBe("ready")
  })

  test("invalidates a pending steer only when its phase epoch changed", () => {
    const initial = [user("msg_01", "exploit", 100)]
    const expected = epoch(initial)
    const continuation = SessionPhaseEpoch.derive([
      ...initial,
      user("msg_02", "exploit", 120, { delivery: "immediate" }),
    ])
    const nextObjective = SessionPhaseEpoch.derive([...initial, user("msg_03", "exploit", 140)])

    expect(SessionPhaseEpoch.same(continuation, expected)).toBe(true)
    expect(SessionPhaseEpoch.same(nextObjective, expected)).toBe(false)
  })

  test("keeps the canonical epoch anchored before a compacted continuation tail", () => {
    const first = user("msg_01", "exploit", 100)
    const compactedContinuation = user("msg_03", "exploit", 300, {
      synthetic: true,
    })
    const canonical = SessionPhaseEpoch.derive([
      first,
      assistant("msg_02", "msg_01", "exploit", 200, { completed: 250, finish: "stop" }),
      compactedContinuation,
    ])
    const compactedTailOnly = SessionPhaseEpoch.derive([compactedContinuation])

    expect(canonical?.firstUserMessageID).toBe(MessageID.make("msg_01"))
    expect(compactedTailOnly?.firstUserMessageID).toBe(MessageID.make("msg_03"))
    expect(SessionPhaseEpoch.same(canonical, compactedTailOnly)).toBe(false)
  })
})
