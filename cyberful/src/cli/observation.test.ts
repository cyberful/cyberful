// ── Public Observation Wire Tests ───────────────────────────────
// Proves the coding-agent stream is versioned, ordered, session-scoped, and
// redacts reasoning, raw tool I/O, and provider response details.
// → cyberful/src/cli/observation.ts — owns the public projection.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { Event } from "@/server/client"
import { createObservationEmitter, normalizeEventV1, type CyberfulObservationV1 } from "./observation"

describe("CyberfulObservationV1", () => {
  test("emits monotonic versioned envelopes", () => {
    const output: CyberfulObservationV1[] = []
    const emitter = createObservationEmitter({
      sessionID: "ses_test",
      write: (observation) => output.push(observation),
      now: () => new Date("2026-08-24T12:00:00.000Z"),
    })

    emitter.emit("session.opened", { workflow: "pentest" })
    emitter.emit("session.status", { status: { type: "busy", message: "Brief is running" } })

    expect(output.map((item) => item.sequence)).toEqual([1, 2])
    expect(output.every((item) => item.schemaVersion === 1 && item.timestamp === "2026-08-24T12:00:00.000Z")).toBe(true)
  })

  test("excludes reasoning activity", () => {
    const event = {
      id: "evt_reasoning",
      type: "session.next.subsystem.phase_activity",
      properties: {
        timestamp: Date.parse("2026-08-24T12:00:00.000Z"),
        sessionID: "ses_test",
        phase: "recon",
        subsystem: { name: "pi", version: "1", label: "Pi" },
        kind: "reasoning",
        text: "private reasoning",
        tool: "",
      },
    } satisfies Extract<Event, { type: "session.next.subsystem.phase_activity" }>

    expect(normalizeEventV1(event, "ses_test")).toBeUndefined()
  })

  test("projects completed tools without raw input, output, or metadata", () => {
    const event = {
      id: "evt_tool",
      type: "message.part.updated",
      properties: {
        sessionID: "ses_test",
        time: Date.parse("2026-08-24T12:00:02.000Z"),
        part: {
          id: "part_tool",
          sessionID: "ses_test",
          messageID: "msg_test",
          type: "tool",
          callID: "call_test",
          tool: "browser_navigate",
          state: {
            status: "completed",
            input: { token: "input-secret" },
            output: "output-secret",
            title: "Opened public documentation",
            metadata: { cookie: "metadata-secret" },
            time: { start: Date.parse("2026-08-24T12:00:01.000Z"), end: Date.parse("2026-08-24T12:00:02.000Z") },
          },
        },
      },
    } satisfies Extract<Event, { type: "message.part.updated" }>

    const candidate = normalizeEventV1(event, "ses_test")
    expect(candidate?.type).toBe("tool.finished")
    const serialized = JSON.stringify(candidate)
    expect(serialized).not.toContain("input-secret")
    expect(serialized).not.toContain("output-secret")
    expect(serialized).not.toContain("metadata-secret")
    expect(serialized).toContain("Opened public documentation")
  })

  test("redacts raw tool input and output packed into phase activity", () => {
    const base = {
      sessionID: "ses_test",
      phase: "recon",
      subsystem: { name: "pi", version: "1", label: "Pi" },
      timestamp: Date.parse("2026-08-24T12:00:02.000Z"),
    }
    const tool = {
      id: "evt_phase_tool",
      type: "session.next.subsystem.phase_activity",
      properties: {
        ...base,
        kind: "tool",
        text: JSON.stringify({ callID: "call_secret", input: { token: "input-secret" } }),
        tool: "browser_navigate",
      },
    } satisfies Extract<Event, { type: "session.next.subsystem.phase_activity" }>
    const output = {
      id: "evt_phase_output",
      type: "session.next.subsystem.phase_activity",
      properties: {
        ...base,
        kind: "output",
        text: "raw-output-secret",
        tool: "call_secret",
      },
    } satisfies Extract<Event, { type: "session.next.subsystem.phase_activity" }>

    const serialized = JSON.stringify([normalizeEventV1(tool, "ses_test"), normalizeEventV1(output, "ses_test")])
    expect(serialized).toContain("browser_navigate started")
    expect(serialized).toContain("Tool activity completed")
    expect(serialized).not.toContain("input-secret")
    expect(serialized).not.toContain("raw-output-secret")
    expect(serialized).not.toContain("call_secret")
  })

  test("does not emit incomplete question.presented requests", () => {
    const event = {
      id: "evt_presented",
      type: "question.presented",
      properties: {
        sessionID: "ses_test",
        requestID: "approval_test",
        presentedAt: Date.parse("2026-08-24T12:00:04.000Z"),
      },
    } satisfies Extract<Event, { type: "question.presented" }>

    expect(normalizeEventV1(event, "ses_test")).toBeUndefined()
  })

  test("projects retries without provider bodies, headers, or metadata", () => {
    const event = {
      id: "evt_retry",
      type: "session.next.retried",
      properties: {
        timestamp: Date.parse("2026-08-24T12:00:03.000Z"),
        sessionID: "ses_test",
        attempt: 2,
        error: {
          message: "bounded provider message",
          statusCode: 503,
          isRetryable: true,
          responseHeaders: { authorization: "header-secret" },
          responseBody: "body-secret",
          metadata: { request: "metadata-secret" },
        },
      },
    } satisfies Extract<Event, { type: "session.next.retried" }>

    const serialized = JSON.stringify(normalizeEventV1(event, "ses_test"))
    expect(serialized).toContain('"attempt":2')
    expect(serialized).toContain('"statusCode":503')
    expect(serialized).not.toContain("bounded provider message")
    expect(serialized).not.toContain("header-secret")
    expect(serialized).not.toContain("body-secret")
    expect(serialized).not.toContain("metadata-secret")
  })

  test("projects session errors without provider detail", () => {
    const event = {
      id: "evt_error",
      type: "session.error",
      properties: {
        sessionID: "ses_test",
        error: {
          name: "UnknownError",
          data: { message: "provider-response-secret" },
        },
      },
    } satisfies Extract<Event, { type: "session.error" }>

    const candidate = normalizeEventV1(event, "ses_test")
    expect(candidate).toMatchObject({ type: "session.error", data: { name: "UnknownError" } })
    expect(JSON.stringify(candidate)).not.toContain("provider-response-secret")
  })

  test("filters events from other sessions", () => {
    const event = {
      id: "evt_status",
      type: "session.status",
      properties: { sessionID: "ses_other", status: { type: "idle" } },
    } satisfies Extract<Event, { type: "session.status" }>

    expect(normalizeEventV1(event, "ses_test")).toBeUndefined()
  })
})
