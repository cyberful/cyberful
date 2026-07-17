// ── Browser Preflight Boundary Tests ────────────────────────────
// Verifies strict skip policy, timeout reaping, and output limits using silent
//   local children instead of downloading a browser during the test.
// → cyberful/src/dependency/browser-preflight.ts — owns provisioning policy.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { installChromium, shouldSkipBrowserPreflight } from "./browser-preflight"

describe("browser preflight boundary", () => {
  test("accepts explicit boolean spellings and rejects malformed policy", () => {
    expect(shouldSkipBrowserPreflight({ CYBERFUL_SKIP_BROWSER_PREFLIGHT: "yes" })).toBe(true)
    expect(shouldSkipBrowserPreflight({ CYBERFUL_SKIP_BROWSER_PREFLIGHT: "false" })).toBe(false)
    expect(() => shouldSkipBrowserPreflight({ CYBERFUL_SKIP_BROWSER_PREFLIGHT: "sometimes" })).toThrow("must be one of")
  })

  test("times out and reaps a silent Chromium installer", async () => {
    await expect(
      installChromium([process.execPath, "-e", "setInterval(() => {}, 1_000)"], process.env, {
        timeoutMs: 25,
      }),
    ).rejects.toThrow("Chromium install timed out after 25ms")
  })

  test("terminates an installer that exceeds its output budget", async () => {
    await expect(
      installChromium([process.execPath, "-e", 'process.stdout.write("x".repeat(4096))'], process.env, {
        maxOutputBytes: 128,
      }),
    ).rejects.toThrow("Could not execute Chromium installer")
  })
})
