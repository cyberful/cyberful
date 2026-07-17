// ── PTY Input Boundary Tests ─────────────────────────────────────
// Protects routine terminal typing and UTF-8 websocket frames while ensuring
//   malformed binary input never reaches the owned pseudo-terminal process.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { handlePtyInput } from "./input"

describe("handlePtyInput", () => {
  test("forwards text input unchanged", async () => {
    const messages: string[] = []

    await Effect.runPromise(handlePtyInput({ onMessage: (message) => messages.push(message) }, "echo ok\n"))

    expect(messages).toEqual(["echo ok\n"])
  })

  test("decodes valid UTF-8 before forwarding binary input", async () => {
    const messages: string[] = []

    await Effect.runPromise(
      handlePtyInput({ onMessage: (message) => messages.push(message) }, new TextEncoder().encode("caffè\n")),
    )

    expect(messages).toEqual(["caffè\n"])
  })

  test("ignores invalid UTF-8 input", async () => {
    const messages: string[] = []

    await Effect.runPromise(handlePtyInput({ onMessage: (message) => messages.push(message) }, new Uint8Array([0xff])))

    expect(messages).toEqual([])
  })
})
