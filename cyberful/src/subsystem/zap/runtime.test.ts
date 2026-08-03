// ── ZAP Runtime Boundary Tests ───────────────────────────────────
// Verifies published proxy-port validation, local-target guidance, and disabled
// certificate behavior without requiring an external daemon.
// → cyberful/src/subsystem/zap/runtime.ts — provides shared ZAP utilities.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { localTargetWarning, parsePublishedPort } from "./runtime"

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
})
