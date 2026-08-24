// ── Session Inspection HTTP Contract Tests ──────────────────────
// Keeps the coding-agent snapshot on one explicit route with a strict live
// source selector that generated clients can encode without ambiguity.
// → cyberful/src/server/routes/instance/httpapi/groups/session.ts — defines the route.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { InspectionQuery, SessionPaths } from "./groups/session"

describe("session inspection HTTP contract", () => {
  test("exposes the inspection route and decodes only explicit live selectors", () => {
    expect(SessionPaths.inspection).toBe("/session/:sessionID/inspection")
    expect(Schema.decodeUnknownSync(InspectionQuery)({ live: "true" })).toEqual({ live: true })
    expect(Schema.decodeUnknownSync(InspectionQuery)({ live: "false" })).toEqual({ live: false })
    expect(() => Schema.decodeUnknownSync(InspectionQuery)({ live: "yes" })).toThrow()
  })
})
