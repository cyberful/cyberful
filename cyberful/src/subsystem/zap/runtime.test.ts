// ── ZAP Runtime Boundary Tests ───────────────────────────────────
// Verifies published proxy-port validation, local-target guidance, and disabled
// runtime behavior without requiring an external daemon.
// → cyberful/src/subsystem/zap/runtime.ts — owns engagement ZAP resources.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { localTargetWarning, parsePublishedPort, startEngagement } from "./runtime"

describe("ZAP engagement runtime", () => {
  test("accepts only a concrete published loopback port", () => {
    expect(parsePublishedPort("127.0.0.1:49152\n")).toBe(49152)
    expect(parsePublishedPort("[::1]:8443")).toBe(8443)
    expect(() => parsePublishedPort("8080/tcp -> 0.0.0.0:0")).toThrow("invalid ZAP proxy mapping")
  })

  test("detects host-loopback targets without changing the supplied objective", () => {
    expect(localTargetWarning("Assess https://localhost:3000/app in scope")).toContain(
      "https://host.docker.internal:3000",
    )
    expect(localTargetWarning("Assess http://127.0.0.1:8080/api in scope")).toContain(
      "http://host.docker.internal:8080",
    )
    expect(localTargetWarning("Assess https://target.example")).toBeUndefined()
  })

  test("an explicit disable skips Docker and returns a direct clean runtime", async () => {
    const previous = process.env.CYBER_ZAP_ENABLED
    process.env.CYBER_ZAP_ENABLED = "0"
    try {
      const runtime = await startEngagement({ sessionID: "disabled", workarea: "/tmp" })
      expect(runtime.env).toEqual({})
      expect(runtime.degraded).toBe(false)
      await runtime.stop()
    } finally {
      if (previous === undefined) delete process.env.CYBER_ZAP_ENABLED
      if (previous !== undefined) process.env.CYBER_ZAP_ENABLED = previous
    }
  })
})
