// ── PTY Connection Ticket Tests ──────────────────────────────────
// Protects the browser's normal terminal handshake by proving a ticket works
//   once for its issuing terminal and cannot cross sessions or be replayed.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { PtyID } from "./schema"
import { make } from "./ticket"

describe("PTY connection tickets", () => {
  test("consumes one ticket exactly once for its issuing terminal", async () => {
    const service = await Effect.runPromise(make())
    const scope = { ptyID: PtyID.ascending(), directory: "/workspace/one" }
    const token = await Effect.runPromise(service.issue(scope))

    expect(await Effect.runPromise(service.consume({ ...scope, ticket: token.ticket }))).toBe(true)
    expect(await Effect.runPromise(service.consume({ ...scope, ticket: token.ticket }))).toBe(false)
  })

  test("does not consume a ticket presented for another terminal", async () => {
    const service = await Effect.runPromise(make())
    const issued = { ptyID: PtyID.ascending(), directory: "/workspace/one" }
    const token = await Effect.runPromise(service.issue(issued))

    expect(
      await Effect.runPromise(
        service.consume({ ptyID: PtyID.ascending(), directory: issued.directory, ticket: token.ticket }),
      ),
    ).toBe(false)
    expect(await Effect.runPromise(service.consume({ ...issued, ticket: token.ticket }))).toBe(true)
  })
})
