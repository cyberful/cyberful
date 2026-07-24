// ── Scoped CAPTCHA Circuit Breaker Tests ────────────────────────
// Verifies that only the challenged browser profile and origin pause while
// unrelated browser scopes and non-browser tools continue.
// → cyberful/src/subsystem/gateway/circuit-breaker.ts — owns the state.
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

const challenged = { profile: 2, origin: "https://example.test", pageID: "page-7" }

describe("CAPTCHA circuit breaker", () => {
  test("pauses only the challenged profile and origin until original-page verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "captcha-circuit-"))
    const file = path.join(root, "state.json")
    try {
      await activateCircuitBreaker(file, "recon", challenged, true)
      expect((await readCircuitBreaker(file))?.surfacedAt).toBeNumber()
      expect(await circuitBreakerError(file, "browser_click", challenged)).toContain("profile 2")
      expect(await circuitBreakerError(file, "browser_click", { ...challenged, profile: 1 })).toBeUndefined()
      expect(await circuitBreakerError(file, "browser_navigate", { ...challenged, origin: "https://other.test" })).toBeUndefined()
      expect(await circuitBreakerError(file, "zap_http_request", challenged)).toBeUndefined()
      expect(await circuitBreakerError(file, "browser_captcha_status", challenged)).toBeUndefined()
      await acknowledgeCircuitBreaker(file)
      expect(await clearCircuitBreaker(file, { ...challenged, pageID: "page-other" })).toBe(false)
      expect(await clearCircuitBreaker(file, challenged)).toBe(true)
      expect(await circuitBreakerError(file, "browser_click", challenged)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects malformed persisted scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "captcha-circuit-invalid-"))
    const file = path.join(root, "state.json")
    try {
      await writeFile(file, JSON.stringify({ kind: "captcha", status: "awaiting_human" }))
      await expect(circuitBreakerError(file, "browser_navigate", challenged)).rejects.toThrow(
        "CAPTCHA circuit breaker contains invalid state",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
