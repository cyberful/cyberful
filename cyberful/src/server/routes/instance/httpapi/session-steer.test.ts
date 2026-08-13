// ── Session Steering HTTP Contract Tests ────────────────────────
// Keeps the remote steering surface text-only, bounded, and distinct from the
// prompt endpoint that may start a new turn.
// → cyberful/src/server/routes/instance/httpapi/groups/session.ts — defines the route.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionPaths, SteeringReceipt, SteerPayload } from "./groups/session"

describe("session steering HTTP contract", () => {
  test("exposes a dedicated route with bounded text and an optional steering mode", () => {
    expect(SessionPaths.steer).toBe("/session/:sessionID/steer")
    expect(Object.keys(SteerPayload.fields)).toEqual(["text", "mode"])
    expect(Schema.decodeUnknownSync(SteerPayload)({ text: "Recheck the active page." })).toEqual({
      text: "Recheck the active page.",
    })
    expect(Schema.decodeUnknownSync(SteerPayload)({ text: "Stop children.", mode: "focus" })).toEqual({
      text: "Stop children.",
      mode: "focus",
    })
  })

  test("rejects empty, whitespace-only, and oversized steering text", () => {
    expect(() => Schema.decodeUnknownSync(SteerPayload)({ text: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SteerPayload)({ text: "   " })).toThrow()
    expect(() => Schema.decodeUnknownSync(SteerPayload)({ text: "x".repeat(16_385) })).toThrow()
    expect(() => Schema.decodeUnknownSync(SteerPayload)({ text: "valid", mode: "interrupt" })).toThrow()
  })

  test("defines stable queue and lifecycle receipt states", () => {
    expect(
      Schema.decodeUnknownSync(SteeringReceipt)({
        id: "steer_1",
        accepted: true,
        recipients: 1,
        mode: "queue",
        state: "queued",
        runID: "run_1",
        acceptedAt: "2026-08-10T00:00:00.000Z",
      }),
    ).toMatchObject({ id: "steer_1", accepted: true, state: "queued" })
  })
})
