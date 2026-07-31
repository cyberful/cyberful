// ── Safe ZAP History Replay Contract ─────────────────────────────
// Verifies bounded mutations preserve captured authentication and destination
//   while rebuilding query, JSON body, and content length deterministically.
// → mcps/zap/zap_history_replay.mjs — owns replay mutation validation.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { replayRequest } from "./zap_history_replay.mjs"

const captured = {
  url: "https://api.example.test/kms/decrypt?version=1",
  requestHeader: [
    "POST /kms/decrypt?version=1 HTTP/1.1",
    "Host: api.example.test",
    "Authorization: Bearer private-token",
    "Content-Type: application/json",
    "Content-Length: 36",
    "",
  ].join("\r\n"),
  requestBody: JSON.stringify({ timestamp: 1, ciphertext: "abc" }),
  tls: "true",
}

describe("ZAP history replay mutation", () => {
  test("mutates bounded fields while preserving authority, path, method, and captured auth", () => {
    const replay = replayRequest(captured, {
      query_mutations: [{ op: "set", name: "version", value: "2" }],
      header_mutations: [{ op: "set", name: "X-Test-Case", value: "kms-replay" }],
      json_body_mutations: [{ op: "replace", path: "/timestamp", value: 2 }],
    })

    expect(replay.targetUrl).toBe("https://api.example.test/kms/decrypt?version=2")
    expect(replay.request).toContain("POST https://api.example.test/kms/decrypt?version=2 HTTP/1.1")
    expect(replay.request).toContain("Authorization: Bearer private-token")
    expect(replay.request).toContain("X-Test-Case: kms-replay")
    expect(replay.request).toContain('{"timestamp":2,"ciphertext":"abc"}')
    expect(replay.request.match(/Content-Length:/g)).toHaveLength(1)
    expect(JSON.stringify(replay.mutationSummary)).not.toContain("private-token")
  })

  test("rejects destination ownership changes and invalid JSON mutation", () => {
    expect(() =>
      replayRequest(captured, { header_mutations: [{ op: "set", name: "Host", value: "other.test" }] }),
    ).toThrow("host-owned")
    expect(() =>
      replayRequest({ ...captured, requestBody: "not-json" }, {
        json_body_mutations: [{ op: "replace", path: "/timestamp", value: 2 }],
      }),
    ).toThrow("valid captured JSON")
  })
})
