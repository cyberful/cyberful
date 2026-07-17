// ── Public TUI Control Surface Tests ────────────────────────────────
// Verifies that clients see only actionable TUI controls and cannot enter the
// removed request bridge, whose producer and response consumer never existed.
// → cyberful/src/server/routes/instance/httpapi/groups/tui.ts — declares the public routes.
// → cyberful/src/server/routes/instance/httpapi/handlers/tui.ts — implements actionable controls.
// ────────────────────────────────────────────────────────────────

import { expect, spyOn, test } from "bun:test"
import { OpenApi } from "effect/unstable/httpapi"
import { Default } from "@/server/server"
import { PublicApi } from "./public"

test("clients cannot call the orphaned TUI request bridge", async () => {
  const document = OpenApi.fromApi(PublicApi)
  expect(document.paths["/tui/append-prompt"]).toBeDefined()
  expect(document.paths["/tui/control/next"]).toBeUndefined()
  expect(document.paths["/tui/control/response"]).toBeUndefined()

  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    const next = await Default().app.request("http://cyberful.internal/tui/control/next?directory=/tmp")
    const response = await Default().app.request("http://cyberful.internal/tui/control/response?directory=/tmp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ignored: true }),
    })

    expect(next.status).toBe(404)
    expect(response.status).toBe(404)
  } finally {
    stderr.mockRestore()
  }
})
