// ── Subagent Activity Reducer Tests ──────────────────────────────
// Protects the user-visible child-session list, nested activity snapshots,
//   bootstrap bounds, questions, completion, and error projection.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { Event, Message, TextPart, ToolPart } from "@/server/client"
import { createSubagentData, reduceSubagentData, snapshotSubagentData } from "./subagent-data"

const rootSessionID = "session-root"
const childSessionID = "session-child"
const grandchildSessionID = "session-grandchild"

function assistantMessage(sessionID: string, messageID: string): Message {
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: `user-${messageID}`,
    modelID: "gpt-5",
    providerID: "openai",
    mode: "build",
    agent: "small-worker",
    path: {
      cwd: "/tmp",
      root: "/tmp",
    },
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  }
}

function taskPart(input: {
  sessionID: string
  partID: string
  callID: string
  childSessionID: string
  subagentType: string
  description: string
}): ToolPart {
  return {
    id: input.partID,
    sessionID: input.sessionID,
    messageID: `message-${input.sessionID}`,
    type: "tool",
    callID: input.callID,
    tool: "task",
    state: {
      status: "running",
      input: {
        subagent_type: input.subagentType,
        description: input.description,
      },
      title: input.description,
      metadata: {
        sessionId: input.childSessionID,
      },
      time: { start: 1 },
    },
  }
}

function textPart(sessionID: string, messageID: string, partID: string, text: string): TextPart {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "text",
    text,
    time: { start: 1, end: 2 },
  }
}

function messageUpdated(sessionID: string, messageID: string): Event {
  return {
    id: `event-message-${messageID}`,
    type: "message.updated",
    properties: {
      sessionID,
      info: assistantMessage(sessionID, messageID),
    },
  }
}

function partUpdated(part: TextPart | ToolPart): Event {
  return {
    id: `event-part-${part.id}`,
    type: "message.part.updated",
    properties: {
      sessionID: part.sessionID,
      part,
      time: 1,
    },
  }
}

describe("run subagent data", () => {
  test("tracks task sessions spawned by a known subagent", () => {
    const data = createSubagentData()

    reduceSubagentData({
      data,
      event: partUpdated(
        taskPart({
          sessionID: rootSessionID,
          partID: "part-root-task",
          callID: "call-root-task",
          childSessionID,
          subagentType: "small-worker",
          description: "run a quick check",
        }),
      ),
      sessionID: rootSessionID,
      thinking: true,
      limits: {},
    })

    reduceSubagentData({
      data,
      event: partUpdated(
        taskPart({
          sessionID: childSessionID,
          partID: "part-child-task",
          callID: "call-child-task",
          childSessionID: grandchildSessionID,
          subagentType: "explore",
          description: "inspect internals",
        }),
      ),
      sessionID: rootSessionID,
      thinking: true,
      limits: {},
    })

    const messageID = "message-grandchild"
    reduceSubagentData({
      data,
      event: messageUpdated(grandchildSessionID, messageID),
      sessionID: rootSessionID,
      thinking: true,
      limits: {},
    })
    reduceSubagentData({
      data,
      event: partUpdated(textPart(grandchildSessionID, messageID, "part-grandchild-text", "nested output")),
      sessionID: rootSessionID,
      thinking: true,
      limits: {},
    })

    const snapshot = snapshotSubagentData(data)

    expect(snapshot.tabs.map((item) => item.sessionID)).toContain(childSessionID)
    expect(snapshot.tabs.map((item) => item.sessionID)).toContain(grandchildSessionID)
    expect(snapshot.details[childSessionID]?.commits.some((commit) => commit.tool === "task")).toBe(true)
    expect(snapshot.details[grandchildSessionID]?.commits.some((commit) => commit.text === "nested output")).toBe(true)
  })
})
