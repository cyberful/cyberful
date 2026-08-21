// ── ZAP History Privacy Contract ────────────────────────────────────
// Verifies normal history views omit sensitive headers and bodies, oversized
// pages shrink safely, and explicit evidence persists in the engagement root.
// → mcps/zap/zap_history.mjs — projects and stores recorded traffic.
// @docs/runtimes/zap.md
// ────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { adaptiveHistoryProjection, messageMetadata, projectHistory, storeContentAddressed } from "./zap_history.mjs"

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

  test("retrieves one metadata page through smaller bounded ZAP reads", async () => {
    const calls = []
    const result = await adaptiveHistoryProjection(
      async ({ start, count }) => {
        calls.push({ start, count })
        if (count > 50) throw new Error("ZAP API core:view:messages exceeded the 25000000-byte response limit")
        return {
          messages: Array.from({ length: Math.min(count, 120 - start) }, (_, index) => ({
            ...message,
            id: String(start + index),
          })),
        }
      },
      { start: 0, count: 120 },
    )

    expect(calls).toEqual([
      { start: 0, count: 100 },
      { start: 0, count: 50 },
      { start: 50, count: 50 },
      { start: 100, count: 20 },
    ])
    expect(result).toMatchObject({
      returned: 120,
      requested_count: 120,
      scanned: 120,
      next_start: 120,
      upstream_page_size: 50,
      page_size_reduced: true,
    })
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("advances filtered pagination by scanned messages rather than matches", async () => {
    const source = Array.from({ length: 5 }, (_, index) => ({
      ...message,
      id: String(index),
      responseBody: index % 2 === 0 ? "needle" : "other",
    }))
    const result = await adaptiveHistoryProjection(
      async ({ start, count }) => ({ messages: source.slice(start, start + count) }),
      { start: 1, count: 4, search: "needle", maxMetadataPageSize: 2 },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["2", "4"])
    expect(result).toMatchObject({ returned: 2, scanned: 4, next_start: 5 })
  })

  test("keeps complete bodies to one adaptively reduced page", async () => {
    const calls = []
    const result = await adaptiveHistoryProjection(
      async ({ start, count }) => {
        calls.push({ start, count })
        if (count > 2) throw new Error("ZAP API core:view:messages exceeded the 25000000-byte response limit")
        return { messages: [{ ...message, id: String(start) }, { ...message, id: String(start + 1) }] }
      },
      { start: 10, count: 8, includeBodies: true },
    )

    expect(calls).toEqual([
      { start: 10, count: 8 },
      { start: 10, count: 4 },
      { start: 10, count: 2 },
    ])
    expect(result).toMatchObject({
      cyberful_projection: "complete",
      returned: 2,
      requested_count: 8,
      scanned: 2,
      next_start: 12,
      upstream_page_size: 2,
      page_size_reduced: true,
    })
    expect(result.messages[0].requestBody).toBe("private request")
  })

  test("preserves the response-size failure when one message is still too large", async () => {
    const oversized = new Error("ZAP API core:view:messages exceeded the 25000000-byte response limit")
    await expect(
      adaptiveHistoryProjection(async () => Promise.reject(oversized), { count: 1 }),
    ).rejects.toThrow(oversized.message)
  })

  test("stores identical large values once by content hash", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zap-history-"))
    try {
      const first = await storeContentAddressed(root, new TextEncoder().encode("same"))
      const second = await storeContentAddressed(root, new TextEncoder().encode("same"))
      expect(first.saved).toBe(second.saved)
      expect(first.saved).toMatch(/^raw\/zap\/history\/objects\/[a-f0-9]{64}\.json$/)
      expect(first.deduplicated).toBe(false)
      expect(second.deduplicated).toBe(true)
      expect(await readFile(path.join(root, first.saved), "utf8")).toBe("same")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
