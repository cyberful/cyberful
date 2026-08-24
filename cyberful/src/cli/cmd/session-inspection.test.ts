// ── Session Watch Lifecycle Tests ───────────────────────────────
// Exercises already-terminal sessions, Report-frame ordering, reconnection
// resnapshots, outcome exits, and stream cancellation through an injected client.
// → cyberful/src/cli/cmd/session-inspection.ts — owns watch orchestration.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { ControlPlaneClient, Event, SessionInspectionV1 } from "@/server/client"
import type { CyberfulObservationV1 } from "../observation"
import { watchSession } from "./session-inspection"

function snapshot(input: { terminal?: boolean; outcome?: "success" | "warning" | "blocked" | "failed" } = {}): SessionInspectionV1 {
  return {
    schemaVersion: 1,
    generatedAt: input.terminal ? "2026-08-24T12:00:10.000Z" : "2026-08-24T12:00:00.000Z",
    source: { mode: "live", connection: "connected", reliable: true, status: { type: input.terminal ? "idle" : "busy" } },
    session: {
      id: "ses_watch_test",
      slug: "watch-test",
      projectID: "project-test",
      directory: "/authorized/lab",
      title: "Watch test",
      workflow: "pentest",
      agent: "report",
      version: "0.4.0",
      time: { created: 1, updated: 2 },
    },
    lifecycle: {
      version: 2,
      workflow: "pentest",
      phase: "report",
      attempt: 1,
      status: input.terminal ? "completed" : "running",
      mode: input.terminal ? "closeout" : "work",
      ...(input.terminal ? { sessionStatus: "closed" as const, sessionOutcome: input.outcome ?? "success" } : {}),
      deadlineAt: "2026-08-24T12:15:00.000Z",
      budgetRemainingMs: 1_000,
      closeoutReserveMs: 300_000,
      closeoutRemainingMs: 0,
      lastProgressAt: "2026-08-24T12:00:09.000Z",
      updatedAt: input.terminal ? "2026-08-24T12:00:10.000Z" : "2026-08-24T12:00:00.000Z",
      freshnessMs: 0,
      recoveries: [],
      steering: [],
      ...(input.terminal
        ? { cleanup: { state: "completed" as const, removed: [], remaining: [], completedAt: "2026-08-24T12:00:10.000Z" } }
        : {}),
    },
    actors: { running: input.terminal ? 0 : 1, completed: input.terminal ? 1 : 0, failed: 0, total: 1, active: [] },
    approvals: [],
    ...(input.terminal
      ? {
          completion: {
            workflow: "pentest",
            outcome: input.outcome ?? "success",
            title: "Report ready",
            summaryMarkdown: "The final report is ready.",
            artifacts: [{ label: "Report", path: "REPORT.pdf", mime: "application/pdf", primary: true }],
            lastPhase: "report",
          },
        }
      : {}),
    diagnostics: [],
  }
}

function textEvent(): Extract<Event, { type: "message.part.updated" }> {
  return {
    id: "evt_text",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_watch_test",
      time: Date.parse("2026-08-24T12:00:09.000Z"),
      part: {
        id: "prt_report_text",
        sessionID: "ses_watch_test",
        messageID: "msg_report",
        type: "text",
        text: "Final Report frame",
        time: { start: Date.parse("2026-08-24T12:00:08.000Z"), end: Date.parse("2026-08-24T12:00:09.000Z") },
      },
    },
  }
}

function statusEvent(status: "busy" | "idle"): Extract<Event, { type: "session.status" }> {
  return {
    id: `evt_${status}`,
    type: "session.status",
    properties: { sessionID: "ses_watch_test", status: status === "busy" ? { type: "busy" } : { type: "idle" } },
  }
}

function fakeClient(input: {
  snapshots: SessionInspectionV1[]
  streams?: Array<AsyncGenerator<Event>>
  onSubscribe?: () => void
}): ControlPlaneClient {
  return {
    session: {
      inspection: async () => ({ data: input.snapshots.shift() }),
    },
    event: {
      subscribe: async () => {
        input.onSubscribe?.()
        const stream = input.streams?.shift()
        if (!stream) throw new Error("unexpected event subscription")
        return { stream }
      },
    },
  } as unknown as ControlPlaneClient
}

async function* events(items: readonly Event[], closed?: () => void): AsyncGenerator<Event> {
  try {
    for (const event of items) yield event
  } finally {
    closed?.()
  }
}

describe("session watch", () => {
  test("does not treat a stale completion as terminal while the live session is busy", async () => {
    const initial = snapshot({ terminal: true })
    initial.source.status = { type: "busy" }
    const output: CyberfulObservationV1[] = []
    let subscriptions = 0
    await watchSession({
      sdk: fakeClient({
        snapshots: [initial, snapshot({ terminal: true })],
        streams: [events([statusEvent("idle")])],
        onSubscribe: () => subscriptions++,
      }),
      sessionID: "ses_watch_test",
      signal: new AbortController().signal,
      write: (observation) => output.push(observation),
    })

    expect(subscriptions).toBe(1)
    expect(output.map((item) => item.type)).toEqual(["session.snapshot", "session.status", "session.snapshot"])
  })

  test("emits initial and terminal snapshots without subscribing when the session already ended", async () => {
    const output: CyberfulObservationV1[] = []
    let subscriptions = 0
    let exitCode: number | undefined
    await watchSession({
      sdk: fakeClient({ snapshots: [snapshot({ terminal: true, outcome: "warning" })], onSubscribe: () => subscriptions++ }),
      sessionID: "ses_watch_test",
      signal: new AbortController().signal,
      write: (observation) => output.push(observation),
      onOutcome: (code) => {
        exitCode = code
      },
    })

    expect(subscriptions).toBe(0)
    expect(output.map((item) => item.type)).toEqual(["session.snapshot", "session.snapshot"])
    expect(output.map((item) => (item.type === "session.snapshot" ? item.data.reason : undefined))).toEqual([
      "initial",
      "terminal",
    ])
    expect(exitCode).toBe(0)
  })

  test("delivers the final Report frame before the idle status and terminal snapshot", async () => {
    const output: CyberfulObservationV1[] = []
    let closed = false
    let exitCode: number | undefined
    await watchSession({
      sdk: fakeClient({
        snapshots: [snapshot(), snapshot({ terminal: true, outcome: "blocked" })],
        streams: [events([textEvent(), statusEvent("idle")], () => (closed = true))],
      }),
      sessionID: "ses_watch_test",
      signal: new AbortController().signal,
      write: (observation) => output.push(observation),
      onOutcome: (code) => {
        exitCode = code
      },
    })

    expect(output.map((item) => item.type)).toEqual([
      "session.snapshot",
      "assistant.text",
      "session.status",
      "session.snapshot",
    ])
    const last = output.at(-1)
    expect(last?.type === "session.snapshot" ? last.data.reason : undefined).toBe("terminal")
    expect(closed).toBe(true)
    expect(exitCode).toBe(1)
  })

  test("backs off and resnapshots after a stream ends before terminal state", async () => {
    const output: CyberfulObservationV1[] = []
    const delays: number[] = []
    await watchSession({
      sdk: fakeClient({
        snapshots: [snapshot(), snapshot(), snapshot({ terminal: true })],
        streams: [events([]), events([statusEvent("idle")])],
      }),
      sessionID: "ses_watch_test",
      signal: new AbortController().signal,
      write: (observation) => output.push(observation),
      sleep: async (delay) => {
        delays.push(delay)
      },
    })

    expect(delays).toEqual([1_000])
    const snapshots = output.filter(
      (item): item is Extract<CyberfulObservationV1, { type: "session.snapshot" }> => item.type === "session.snapshot",
    )
    expect(snapshots.map((item) => item.data.reason)).toEqual(["initial", "reconnected", "terminal"])
  })

  test("closes from a terminal reconnect snapshot without waiting for another idle event", async () => {
    const output: CyberfulObservationV1[] = []
    const delays: number[] = []
    let subscriptions = 0
    await watchSession({
      sdk: fakeClient({
        snapshots: [snapshot(), snapshot({ terminal: true })],
        streams: [events([])],
        onSubscribe: () => subscriptions++,
      }),
      sessionID: "ses_watch_test",
      signal: new AbortController().signal,
      write: (observation) => output.push(observation),
      sleep: async (delay) => {
        delays.push(delay)
      },
    })

    expect(subscriptions).toBe(1)
    expect(delays).toEqual([1_000])
    const reasons = output.flatMap((item) => (item.type === "session.snapshot" ? [item.data.reason] : []))
    expect(reasons).toEqual(["initial", "reconnected", "terminal"])
  })

  test("cancels and closes the active stream", async () => {
    const abort = new AbortController()
    let closed = false
    const output: CyberfulObservationV1[] = []
    await watchSession({
      sdk: fakeClient({
        snapshots: [snapshot()],
        streams: [events([statusEvent("busy"), statusEvent("busy")], () => (closed = true))],
      }),
      sessionID: "ses_watch_test",
      signal: abort.signal,
      write: (observation) => {
        output.push(observation)
        if (observation.type === "session.status") abort.abort(new Error("test cancellation"))
      },
    })

    expect(closed).toBe(true)
    expect(output.map((item) => item.type)).toEqual(["session.snapshot", "session.status"])
  })
})
