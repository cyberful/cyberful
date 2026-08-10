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
  dismissCircuitBreaker,
  readCircuitBreaker,
} from "./circuit-breaker"

const challenged = { profile: 2 as const, origin: "https://example.test", pageID: "page-7" }

describe("CAPTCHA circuit breaker", () => {
  test("pauses only the challenged profile and origin until original-page verification", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "captcha-circuit-"))
    const file = path.join(root, "state.json")
    try {
      const activation = await activateCircuitBreaker(file, "recon", challenged, true)
      expect((await readCircuitBreaker(file))?.surfacedAt).toBeNumber()
      expect(await circuitBreakerError(file, "browser_click", challenged)).toContain("profile 2")
      expect(await circuitBreakerError(file, "browser_click", { ...challenged, profile: 1 as const })).toBeUndefined()
      expect(await circuitBreakerError(file, "browser_navigate", { ...challenged, origin: "https://other.test" })).toBeUndefined()
      expect(await circuitBreakerError(file, "zap_http_request", challenged)).toBeUndefined()
      expect(await circuitBreakerError(file, "browser_captcha_status", challenged)).toBeUndefined()
      expect(await acknowledgeCircuitBreaker(file, activation)).toBe(true)
      expect(await clearCircuitBreaker(file, { ...challenged, pageID: "page-other" })).toBe(false)
      expect(await clearCircuitBreaker(file, challenged)).toBe(true)
      expect(await circuitBreakerError(file, "browser_click", challenged)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("lets an explicit human false-positive decision clear the active scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "captcha-circuit-dismiss-"))
    const file = path.join(root, "state.json")
    try {
      const activation = await activateCircuitBreaker(file, "recon", challenged, true)
      expect(await dismissCircuitBreaker(file, activation)).toBe(true)
      expect((await readCircuitBreaker(file))?.status).toBe("cleared")
      expect(await circuitBreakerError(file, "browser_click", challenged)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("isolates a search challenge from every numbered target profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "captcha-circuit-search-"))
    const file = path.join(root, "state.json")
    const search = { profile: "search" as const, origin: "https://html.duckduckgo.com", pageID: "search-page" }
    try {
      await activateCircuitBreaker(file, "recon", search, false)
      expect(await circuitBreakerError(file, "web_search", search)).toContain("profile search")
      expect(await circuitBreakerError(file, "browser_click", { ...search, profile: 1 })).toBeUndefined()
      expect(await circuitBreakerError(file, "browser_captcha_status", search)).toBeUndefined()
      expect(await clearCircuitBreaker(file, search)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not apply a late human answer to a replacement challenge", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "captcha-circuit-stale-answer-"))
    const file = path.join(root, "state.json")
    try {
      const original = await activateCircuitBreaker(file, "recon", challenged, true)
      const replacement = await activateCircuitBreaker(
        file,
        "recon",
        { profile: 3 as const, origin: "https://other.test", pageID: "page-8" },
        true,
      )
      expect(await dismissCircuitBreaker(file, original)).toBe(false)
      expect(await acknowledgeCircuitBreaker(file, original)).toBe(false)
      expect(await readCircuitBreaker(file)).toEqual(replacement)
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
