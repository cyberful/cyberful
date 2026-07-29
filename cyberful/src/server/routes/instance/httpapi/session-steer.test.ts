// ── Session Steering HTTP Contract Tests ────────────────────────
// Keeps the remote steering surface text-only, bounded, and distinct from the
// prompt endpoint that may start a new turn.
// → cyberful/src/server/routes/instance/httpapi/groups/session.ts — defines the route.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionPaths, SteerPayload } from "./groups/session"

describe("session steering HTTP contract", () => {
  test("exposes a dedicated route with only a text payload", () => {
    expect(SessionPaths.steer).toBe("/session/:sessionID/steer")
    expect(Object.keys(SteerPayload.fields)).toEqual(["text"])
    expect(Schema.decodeUnknownSync(SteerPayload)({ text: "Recheck the active page." })).toEqual({
      text: "Recheck the active page.",
    })
  })

  test("rejects empty, whitespace-only, and oversized steering text", () => {
    expect(() => Schema.decodeUnknownSync(SteerPayload)({ text: "" })).toThrow()
    expect(() => Schema.decodeUnknownSync(SteerPayload)({ text: "   " })).toThrow()
    expect(() => Schema.decodeUnknownSync(SteerPayload)({ text: "x".repeat(16_385) })).toThrow()
  })
})
