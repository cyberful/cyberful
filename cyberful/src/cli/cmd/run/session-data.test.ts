// ── Interactive Session Reducer Tests ────────────────────────────
// Protects routine event replay, streamed text and tool projection, questions,
//   interruption, subagent activity, and footer commit ordering seen by users.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Event, QuestionRequest, TextPart, ToolPart } from "@/server/client"
import { coalesceFooterCommitQueue } from "./footer"
import { createSessionData, reduceSessionData } from "./session-data"
import { replaySession } from "./session-replay"
import { createSubagentData, reduceSubagentData, snapshotSubagentData } from "./subagent-data"
import type { StreamCommit } from "./types"

const parentSessionID = "session-parent"
const childSessionID = "session-child"
const messageID = "message-assistant"
const partID = "part-text"

function assistantMessage(sessionID: string): AssistantMessage {
  return {
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: "message-user",
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

function textPart(sessionID: string): TextPart {
  return {
    id: partID,
    sessionID,
    messageID,
    type: "text",
    text: "",
    time: { start: 1 },
  }
}

function messageUpdated(sessionID: string): Event {
  return {
    id: `event-message-${sessionID}`,
    type: "message.updated",
    properties: {
      sessionID,
      info: assistantMessage(sessionID),
    },
  }
}

function finalMessageUpdated(sessionID: string): Event {
  return {
    id: `event-message-final-${sessionID}`,
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        ...assistantMessage(sessionID),
        time: { created: 1, completed: 1_800_000_000_000 },
        finish: "stop",
      },
    },
  }
}

function partUpdated(sessionID: string): Event {
  return {
    id: `event-part-${sessionID}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      part: textPart(sessionID),
      time: 1,
    },
  }
}

function completedPartUpdated(sessionID: string): Event {
  return {
    id: `event-part-completed-${sessionID}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      part: {
        ...textPart(sessionID),
        text: "done\n\nTime: 2027-01-15T08:00:00.000Z",
        time: { start: 1, end: 1_800_000_000_000 },
      },
      time: 1,
    },
  }
}

function textDelta(sessionID: string, delta: string, mode?: "append" | "replace"): Event {
  return {
    id: `event-delta-${sessionID}-${delta}`,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID,
      partID,
      field: "text",
      delta,
      ...(mode ? { mode } : {}),
    },
  }
}

function runningTaskPart(): ToolPart {
  return {
    id: "part-task",
    sessionID: parentSessionID,
    messageID: "message-parent",
    type: "tool",
    callID: "call-task",
    tool: "task",
    state: {
      status: "running",
      input: {
        subagent_type: "small-worker",
        description: "run a quick check",
      },
      title: "Subagent",
      metadata: {
        sessionId: childSessionID,
      },
      time: { start: 1 },
    },
  }
}

function questionRequest(id = "que_manual"): QuestionRequest {
  return {
    id,
    sessionID: parentSessionID,
    questions: [
      {
        header: "Choice",
        question: "Which fallback should be used?",
        options: [{ label: "Fallback", description: "Use the alternate path" }],
      },
    ],
  }
}

describe("run session data", () => {
  test("emits one terminal timestamp commit after final assistant updates", () => {
    const data = createSessionData()

    reduceSessionData({
      data,
      event: messageUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    reduceSessionData({
      data,
      event: partUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    reduceSessionData({
      data,
      event: textDelta(parentSessionID, "done"),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })

    const final = reduceSessionData({
      data,
      event: finalMessageUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(final.commits).toEqual([
      {
        kind: "assistant",
        text: "\uF43A 2027-01-15T08:00:00.000Z",
        phase: "final",
        source: "assistant",
        messageID,
        timestamp: true,
      },
    ])

    const duplicate = reduceSessionData({
      data,
      event: finalMessageUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(duplicate.commits).toEqual([])
  })

  test("emits skill learned commits for direct run sessions", () => {
    const data = createSessionData()

    const learned = reduceSessionData({
      data,
      event: {
        id: "event-skill-learned",
        type: "session.next.skill.learned",
        properties: {
          sessionID: parentSessionID,
          timestamp: new Date(2026, 11, 11, 12, 34).getTime(),
          skills: ["IDOR", "SQL"],
        },
      },
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(learned.commits).toEqual([
      {
        kind: "system",
        text: "✦ Skill learned: IDOR, SQL",
        phase: "final",
        source: "system",
      },
    ])

    const duplicate = reduceSessionData({
      data,
      event: {
        id: "event-skill-learned",
        type: "session.next.skill.learned",
        properties: {
          sessionID: parentSessionID,
          timestamp: new Date(2026, 11, 11, 12, 34).getTime(),
          skills: ["IDOR", "SQL"],
        },
      },
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(duplicate.commits).toEqual([])
  })

  test("converts persisted Time part updates to one terminal timestamp commit", () => {
    const data = createSessionData()

    reduceSessionData({
      data,
      event: messageUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    reduceSessionData({
      data,
      event: partUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    reduceSessionData({
      data,
      event: textDelta(parentSessionID, "done"),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })

    const part = reduceSessionData({
      data,
      event: completedPartUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(part.commits).toEqual([
      {
        kind: "assistant",
        text: "\uF43A 2027-01-15T08:00:00.000Z",
        phase: "final",
        source: "assistant",
        messageID,
        timestamp: true,
      },
    ])

    const final = reduceSessionData({
      data,
      event: finalMessageUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(final.commits).toEqual([])
  })

  test("replays completed assistant timestamps from message completion time", () => {
    const replay = replaySession({
      messages: [
        {
          info: {
            ...assistantMessage(parentSessionID),
            time: { created: 1, completed: 1_800_000_000_000 },
            finish: "stop",
          },
          parts: [
            {
              ...textPart(parentSessionID),
              text: "done",
              time: { start: 1, end: 2 },
            },
          ],
        },
      ],
      questions: [],
      thinking: true,
      limits: {},
    })

    expect(replay.commits).toEqual([
      {
        kind: "assistant",
        text: "done",
        phase: "progress",
        source: "assistant",
        messageID,
        partID,
      },
      {
        kind: "assistant",
        text: "\uF43A 2027-01-15T08:00:00.000Z",
        phase: "final",
        source: "assistant",
        messageID,
        timestamp: true,
      },
    ])
  })

  test("emits full replacement commits for text replacement deltas", () => {
    const data = createSessionData()

    reduceSessionData({
      data,
      event: messageUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    reduceSessionData({
      data,
      event: partUpdated(parentSessionID),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })

    const first = reduceSessionData({
      data,
      event: textDelta(parentSessionID, "draft one", "replace"),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(first.commits).toHaveLength(1)
    expect(first.commits[0]?.text).toBe("draft one")
    expect(first.commits[0]?.mode).toBe("replace")

    const second = reduceSessionData({
      data,
      event: textDelta(parentSessionID, "final", "replace"),
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(second.commits).toHaveLength(1)
    expect(second.commits[0]?.text).toBe("final")
    expect(second.commits[0]?.mode).toBe("replace")
  })

  test("replaces subagent progress frames instead of appending snapshots", () => {
    const data = createSubagentData()

    reduceSubagentData({
      data,
      event: {
        id: "event-task-running",
        type: "message.part.updated",
        properties: {
          sessionID: parentSessionID,
          part: runningTaskPart(),
          time: 1,
        },
      },
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })

    for (const event of [
      messageUpdated(childSessionID),
      partUpdated(childSessionID),
      textDelta(childSessionID, "draft one", "replace"),
      textDelta(childSessionID, "final", "replace"),
    ]) {
      reduceSubagentData({
        data,
        event,
        sessionID: parentSessionID,
        thinking: true,
        limits: {},
      })
    }

    const detail = snapshotSubagentData(data).details[childSessionID]
    expect(detail?.commits).toHaveLength(1)
    expect(detail?.commits[0]?.text).toBe("final")
    expect(detail?.commits[0]?.mode).toBe("replace")
  })

  test("shows and clears question footer blockers", () => {
    const data = createSessionData()

    const questionAsked = reduceSessionData({
      data,
      event: { id: "event-question-asked", type: "question.asked", properties: questionRequest() },
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(questionAsked.footer?.view?.type).toBe("question")

    const questionReplied = reduceSessionData({
      data,
      event: {
        id: "event-question-replied",
        type: "question.replied",
        properties: { sessionID: parentSessionID, requestID: "que_manual", answers: [["Fallback"]] },
      },
      sessionID: parentSessionID,
      thinking: true,
      limits: {},
    })
    expect(questionReplied.footer?.view?.type).toBe("prompt")
  })
})

describe("run footer commit coalescing", () => {
  test("keeps only the latest queued replacement snapshot for the same text part", () => {
    const queue: StreamCommit[] = []

    coalesceFooterCommitQueue(queue, replacementCommit("draft one"))
    coalesceFooterCommitQueue(queue, replacementCommit("draft two"))

    expect(queue).toHaveLength(1)
    expect(queue[0]?.text).toBe("draft two")
    expect(queue[0]?.mode).toBe("replace")
  })

  test("appends normal deltas after a queued replacement snapshot", () => {
    const queue: StreamCommit[] = []

    coalesceFooterCommitQueue(queue, replacementCommit("draft"))
    coalesceFooterCommitQueue(queue, { ...replacementCommit(" plus"), mode: undefined })

    expect(queue).toHaveLength(1)
    expect(queue[0]?.text).toBe("draft plus")
    expect(queue[0]?.mode).toBe("replace")
  })
})

function replacementCommit(text: string): StreamCommit {
  return {
    kind: "assistant",
    text,
    phase: "progress",
    mode: "replace",
    source: "assistant",
    messageID,
    partID,
  }
}
