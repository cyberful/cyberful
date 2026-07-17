// ── CAPTCHA Circuit Breaker Tests ────────────────────────────────
// Verifies that a human-intervention stop persists across phase gateways, blocks
// active tools, permits observation, and clears only after host verification.
// → cyberful/src/subsystem/gateway/circuit-breaker.ts — persists the tested state.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  acknowledgeCircuitBreaker,
  activateCircuitBreaker,
  circuitBreakerError,
  clearCircuitBreaker,
  readCircuitBreaker,
} from "./circuit-breaker"

describe("CAPTCHA circuit breaker", () => {
  test("survives phase changes and blocks active tools until host verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "captcha-circuit-"))
    const file = path.join(root, "state.json")
    try {
      await activateCircuitBreaker(file, "recon")
      expect((await readCircuitBreaker(file))?.surfacedAt).toBeUndefined()
      expect(await circuitBreakerError(file, "browser_navigate")).toContain("awaiting human")
      expect(await circuitBreakerError(file, "browser_captcha_status")).toBeUndefined()
      await activateCircuitBreaker(file, "recon", true)
      expect((await readCircuitBreaker(file))?.surfacedAt).toBeNumber()
      await acknowledgeCircuitBreaker(file)
      expect((await readCircuitBreaker(file))?.status).toBe("awaiting_verification")
      expect(await circuitBreakerError(file, "zap_http_request")).toContain("awaiting verification")
      await clearCircuitBreaker(file)
      expect(await circuitBreakerError(file, "browser_navigate")).toBeUndefined()
      const sibling = path.join(root, "second-gateway.json")
      await activateCircuitBreaker(sibling, "recon", true)
      expect(await circuitBreakerError(file, "browser_navigate")).toContain("awaiting human")
      await clearCircuitBreaker(sibling)
      expect(await circuitBreakerError(file, "browser_navigate")).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fails closed when persisted breaker state is malformed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "captcha-circuit-invalid-"))
    const file = path.join(root, "state.json")
    try {
      await writeFile(file, JSON.stringify({ kind: "captcha", status: "unexpected" }))
      await expect(circuitBreakerError(file, "browser_navigate")).rejects.toThrow(
        "CAPTCHA circuit breaker contains invalid state",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
