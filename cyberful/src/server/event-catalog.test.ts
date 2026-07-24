// ── Public Event Catalog Contract Tests ──────────────────────────
// Verifies generated API schemas contain representative legacy, projected, and
// Event payloads regardless of module import order, then reject definitions
// added after that public contract has been sealed.
// → cyberful/src/server/event-catalog.ts — loads and seals the complete catalog.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { Event } from "@/event"
import { OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { PublicApi } from "@/server/routes/instance/httpapi/public"

test("the public schema contains every event family before the catalog is sealed", () => {
  const document = JSON.stringify(OpenApi.fromApi(PublicApi))

  expect(document).toContain("pty.created")
  expect(document).toContain("session.created")
  expect(document).toContain("message.part.updated")
  expect(document).toContain("session.next.text.delta")
  expect(document).toContain("finding.registry.updated")
  expect(document).toContain("/session/{sessionID}/findings")
})

test("late event definitions cannot diverge from the published schema", () => {
  expect(() =>
    Event.define({
      type: "test.late.event",
      schema: { value: Schema.String },
    }),
  ).toThrow("catalog is frozen")
})
