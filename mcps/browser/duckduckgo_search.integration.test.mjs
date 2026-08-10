// ── Opt-In Live DuckDuckGo Search Probe ────────────────────────
// Exercises the real HTML surface only when explicitly requested, keeping the
// ordinary CI suite independent from external network and markup availability.
// → mcps/browser/browser_mcp.mjs — owns the browser-backed search operation.
// ─────────────────────────────────────────────────────────────────

import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, test } from "bun:test"

const liveEnabled = process.env.CYBERFUL_TEST_LIVE_DUCKDUCKGO === "1"

test.skipIf(!liveEnabled)("returns structured results from DuckDuckGo HTML", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-live-duckduckgo-"))
  const keys = [
    "CYBER_BROWSER_PROFILE_ID",
    "CYBER_BROWSER_USER_DATA_DIR",
    "CYBER_BROWSER_ARTIFACTS_DIR",
    "CYBER_BROWSER_HEADLESS",
    "CYBER_BROWSER_PROXY",
    "CYBER_BROWSER_PROXY_CA_SPKI",
  ]
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  let browser
  try {
    process.env.CYBER_BROWSER_PROFILE_ID = "search"
    process.env.CYBER_BROWSER_USER_DATA_DIR = path.join(root, "profile")
    process.env.CYBER_BROWSER_ARTIFACTS_DIR = path.join(root, "artifacts")
    process.env.CYBER_BROWSER_HEADLESS = "true"
    delete process.env.CYBER_BROWSER_PROXY
    delete process.env.CYBER_BROWSER_PROXY_CA_SPKI
    browser = await import(`./browser_mcp.mjs?live-duckduckgo=${Date.now()}`)
    const result = await browser.handleToolCall({
      name: "web_search",
      arguments: { query: "DuckDuckGo privacy", max_results: 3, safe_search: "moderate", timeout_ms: 30_000 },
    })
    expect(result.isError).not.toBe(true)
    const payload = JSON.parse(result.content[0].text)
    expect(payload).toMatchObject({ engine: "duckduckgo", profile: "search", query: "DuckDuckGo privacy" })
    expect(payload.results.length).toBeGreaterThan(0)
    expect(payload.results.length).toBeLessThanOrEqual(3)
  } finally {
    await browser?.handleToolCall({ name: "browser_close", arguments: {} })
    for (const key of keys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
