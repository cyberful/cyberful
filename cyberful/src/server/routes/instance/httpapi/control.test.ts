// ── Control-Plane Logging Boundary Tests ─────────────────────────
// Verifies that routine client logging succeeds while attacker-controlled
// service names, messages, and metadata are rejected before reaching the
// process logger or creating unbounded in-memory work.
// → cyberful/src/server/routes/instance/httpapi/groups/control.ts — defines the input limits.
// → cyberful/src/server/routes/instance/httpapi/handlers/control.ts — writes accepted entries.
// ─────────────────────────────────────────────────────────────────

import { expect, spyOn, test } from "bun:test"
import { Default } from "@/server/server"

function logRequest(payload: unknown) {
  return Default().app.request("http://cyberful.internal/log", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
}

test("clients can write a bounded structured log entry", async () => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const response = await logRequest({
      service: "tui",
      level: "info",
      message: "session opened",
      extra: { session: "ses_123" },
    })
    expect(response.status).toBe(200)
  } finally {
    stderr.mockRestore()
  }
})

test("clients cannot submit unbounded logger dimensions or metadata", async () => {
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const service = await logRequest({ service: "s".repeat(129), level: "info", message: "entry" })
    const message = await logRequest({ service: "tui", level: "info", message: "m".repeat(16_385) })
    const extra = await logRequest({
      service: "tui",
      level: "info",
      message: "entry",
      extra: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key-${index}`, index])),
    })

    expect(service.status).toBe(400)
    expect(message.status).toBe(400)
    expect(extra.status).toBe(400)
  } finally {
    stderr.mockRestore()
  }
})
