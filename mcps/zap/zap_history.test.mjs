// ── ZAP History Privacy Contract ────────────────────────────────────
// Verifies normal history views omit sensitive headers and bodies while an
// explicit evidence request stores content within the engagement workarea.
// → mcps/zap/zap_history.mjs — projects and stores recorded traffic.
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { messageMetadata, projectHistory, storeContentAddressed } from "./zap_history.mjs"

const message = {
  id: "7",
  timestamp: "2026-07-16T12:00:00Z",
  rtt: "42",
  requestHeader: "POST https://example.test/basket HTTP/1.1\r\nAuthorization: secret\r\n",
  requestBody: "private request",
  responseHeader: "HTTP/1.1 201 Created\r\nSet-Cookie: secret\r\n",
  responseBody: "private response",
}

describe("ZAP history projection", () => {
  test("returns useful metadata without headers or bodies by default", () => {
    expect(messageMetadata(message)).toEqual({
      id: "7",
      type: undefined,
      timestamp: "2026-07-16T12:00:00Z",
      rtt_ms: 42,
      method: "POST",
      url: "https://example.test/basket",
      status_code: 201,
      reason: "Created",
      request_header_bytes: Buffer.byteLength(message.requestHeader),
      request_body_bytes: Buffer.byteLength(message.requestBody),
      response_header_bytes: Buffer.byteLength(message.responseHeader),
      response_body_bytes: Buffer.byteLength(message.responseBody),
    })
    expect(JSON.stringify(projectHistory({ messages: [message] }))).not.toContain("secret")
  })

  test("can search complete content while returning only matching metadata", () => {
    const result = projectHistory(
      { messages: [message, { ...message, id: "8", responseBody: "other" }] },
      { search: "private response" },
    )
    expect(result.messages.map((item) => item.id)).toEqual(["7"])
    expect(result.cyberful_projection).toBe("metadata")
  })

  test("stores identical large values once by content hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-history-"))
    try {
      const first = await storeContentAddressed(root, new TextEncoder().encode("same"))
      const second = await storeContentAddressed(root, new TextEncoder().encode("same"))
      expect(first.saved).toBe(second.saved)
      expect(first.deduplicated).toBe(false)
      expect(second.deduplicated).toBe(true)
      expect(await readFile(path.join(root, first.saved), "utf8")).toBe("same")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
