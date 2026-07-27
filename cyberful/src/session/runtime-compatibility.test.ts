// ── Persisted Session Runtime Compatibility Tests ────────────────
// Proves active Codex turns never become Pi turns while completed evidence
// remains available for a new, explicitly Pi-owned Ask exchange.
// → cyberful/src/session/runtime-compatibility.ts — owns the tested policy.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { ModelID, SubsystemID } from "@/subsystem/identity"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID } from "./schema"
import { SessionRuntimeCompatibility } from "./runtime-compatibility"

const sessionID = SessionID.make("ses_runtime_compatibility")
const modelID = ModelID.make("persisted-model")

function user(id: string, subsystemID: string, agent = "brief"): MessageV2.WithParts {
  const messageID = MessageID.make(id)
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created: Number(id.slice(-1)) || 0 },
      agent,
      model: {
        subsystemID: SubsystemID.make(subsystemID),
        modelID,
      },
    },
    parts: [
      {
        id: PartID.make(`prt_${id}`),
        sessionID,
        messageID,
        type: "text",
        text: "authorized task",
      },
    ],
  }
}

function terminalCompletion(parentID: MessageID, id = "msg_002"): MessageV2.WithParts {
  const messageID = MessageID.make(id)
  return {
    info: {
      id: messageID,
      sessionID,
      parentID,
      role: "assistant",
      time: { created: 2, completed: 3 },
      agent: "report",
      mode: "report",
      modelID,
      subsystemID: SubsystemID.make(SessionRuntimeCompatibility.LEGACY_CODEX_SUBSYSTEM_ID),
      path: { cwd: "/workarea", root: "/workarea" },
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.make(`prt_${id}`),
        sessionID,
        messageID,
        type: "completion",
        workflow: "pentest",
        outcome: "success",
        title: "Pentest complete",
        summaryMarkdown: "The completed result remains readable.",
        artifacts: [{ label: "Report", path: "reports/security-report.pdf", mime: "application/pdf" }],
        nextWorkflow: "ask",
      },
    ],
  }
}

describe("persisted session runtime compatibility", () => {
  test("admits a Pi-owned active turn", () => {
    const state = SessionRuntimeCompatibility.classify([user("msg_001", "pi-agent")])

    expect(state).toBe("pi-compatible")
    expect(SessionRuntimeCompatibility.canAppendPiPrompt(state)).toBe(true)
    expect(SessionRuntimeCompatibility.canExecuteWithPi(state)).toBe(true)
  })

  test("rejects append and execution for an active legacy Codex turn", () => {
    const state = SessionRuntimeCompatibility.classify([
      user("msg_001", SessionRuntimeCompatibility.LEGACY_CODEX_SUBSYSTEM_ID),
    ])

    expect(state).toBe("legacy-active")
    expect(SessionRuntimeCompatibility.canAppendPiPrompt(state)).toBe(false)
    expect(SessionRuntimeCompatibility.canExecuteWithPi(state)).toBe(false)
  })

  test("allows a new prompt after a terminal legacy completion without executing the old turn", () => {
    const legacy = user("msg_001", SessionRuntimeCompatibility.LEGACY_CODEX_SUBSYSTEM_ID)
    const state = SessionRuntimeCompatibility.classify([legacy, terminalCompletion(legacy.info.id)])

    expect(state).toBe("legacy-complete")
    expect(SessionRuntimeCompatibility.canAppendPiPrompt(state)).toBe(true)
    expect(SessionRuntimeCompatibility.canExecuteWithPi(state)).toBe(false)
  })

  test("does not let an older completion authorize a later unfinished legacy turn", () => {
    const completed = user("msg_001", SessionRuntimeCompatibility.LEGACY_CODEX_SUBSYSTEM_ID)
    const later = user("msg_003", SessionRuntimeCompatibility.LEGACY_CODEX_SUBSYSTEM_ID)
    const state = SessionRuntimeCompatibility.classify([
      completed,
      terminalCompletion(completed.info.id),
      later,
    ])

    expect(state).toBe("legacy-active")
    expect(SessionRuntimeCompatibility.canAppendPiPrompt(state)).toBe(false)
    expect(SessionRuntimeCompatibility.canExecuteWithPi(state)).toBe(false)
  })

  test("executes only after the new Ask turn is stamped with Pi provenance", () => {
    const legacy = user("msg_001", SessionRuntimeCompatibility.LEGACY_CODEX_SUBSYSTEM_ID)
    const state = SessionRuntimeCompatibility.classify([
      legacy,
      terminalCompletion(legacy.info.id),
      user("msg_003", "pi-agent", "ask"),
    ])

    expect(state).toBe("pi-compatible")
    expect(SessionRuntimeCompatibility.canExecuteWithPi(state)).toBe(true)
  })
})
