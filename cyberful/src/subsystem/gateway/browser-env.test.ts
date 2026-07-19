// ── Gateway Browser Environment Tests ───────────────────────────
// Verifies owner-private environment loading, pinned-profile fallback decisions,
// and secret filtering for each built-in upstream process.
// → cyberful/src/subsystem/gateway/server.ts — owns these gateway boundaries.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// resolveBrowserUpstreamEnv is a pure decision function; importing ./server has no load-time side effects
// (its DB client is lazy and main() only runs as an entrypoint), so a plain dynamic import is safe here.
const {
  browserProfileToolDefinition,
  loadPrivateGatewayEnvironment,
  resolveBrowserUpstreamEnv,
  selectBrowserProfileUpstream,
  upstreamProcessEnv,
} = await import("./server")

function environmentValue(name: string): string | undefined {
  return process.env[name]
}

test("gateway loads the owner-private environment file before binding its session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cyberful-gateway-env-test-"))
  const previous = process.env.CYBERFUL_TEST_PRIVATE
  try {
    const file = path.join(directory, "environment.json")
    await writeFile(file, JSON.stringify({ CYBERFUL_TEST_PRIVATE: "loaded" }))
    delete process.env.CYBERFUL_TEST_PRIVATE
    await loadPrivateGatewayEnvironment(file)
    expect(environmentValue("CYBERFUL_TEST_PRIVATE")).toBe("loaded")
  } finally {
    if (previous === undefined) delete process.env.CYBERFUL_TEST_PRIVATE
    else process.env.CYBERFUL_TEST_PRIVATE = previous
    await rm(directory, { recursive: true, force: true })
  }
})

// Locks browser-profile routing for the one gateway owned by a phase.
describe("resolveBrowserUpstreamEnv", () => {
  const TEMP = "/tmp/expert-browser-x"
  const ARTIFACTS = "/home/u/artifacts"

  test("pinned profile with no live holder → reuse it for the login", () => {
    const r = resolveBrowserUpstreamEnv({
      dedicated: "/home/u/.chrome",
      artifactsDir: ARTIFACTS,
      tempProfileDir: TEMP,
    })
    expect(r.set).toEqual({
      CYBER_BROWSER_USER_DATA_DIR: "/home/u/.chrome",
      CYBER_BROWSER_ARTIFACTS_DIR: ARTIFACTS,
    })
  })

  test("a locked pinned profile falls back to a per-session temp profile", () => {
    const r = resolveBrowserUpstreamEnv({
      dedicated: "/home/u/.chrome",
      artifactsDir: ARTIFACTS,
      livePort: 4321,
      tempProfileDir: TEMP,
    })
    expect(r.set).toEqual({
      CYBER_BROWSER_USER_DATA_DIR: TEMP,
      CYBER_BROWSER_ARTIFACTS_DIR: path.join(TEMP, "artifacts"),
    })
  })

  test("nothing set → a per-session temp profile", () => {
    const r = resolveBrowserUpstreamEnv({ artifactsDir: ARTIFACTS, tempProfileDir: TEMP })
    expect(r.set).toEqual({
      CYBER_BROWSER_USER_DATA_DIR: TEMP,
      CYBER_BROWSER_ARTIFACTS_DIR: path.join(TEMP, "artifacts"),
    })
  })
})

describe("browser profile tool routing", () => {
  const definition = {
    name: "browser_navigate",
    description: "Open a URL.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  }
  const call = async () => ({ content: [] })
  const candidates = [
    { def: definition, capability: "browser" as const, browserProfile: 1 as const, call },
    { def: definition, capability: "browser" as const, browserProfile: 2 as const, call },
  ]

  test("advertises one optional selector without changing the underlying browser schema", () => {
    const advertised = browserProfileToolDefinition(definition, [1, 2])
    expect(advertised.inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { profile: { type: "integer", enum: [1, 2], default: 1 } },
    })
    expect(definition.inputSchema.properties).not.toHaveProperty("profile")
  })

  test("defaults to profile one and strips the gateway-only selector before forwarding", () => {
    expect(selectBrowserProfileUpstream(candidates, { url: "https://example.test" })).toEqual({
      upstream: candidates[0],
      args: { url: "https://example.test" },
    })
    expect(selectBrowserProfileUpstream(candidates, { profile: 2, url: "https://example.test" })).toEqual({
      upstream: candidates[1],
      args: { url: "https://example.test" },
    })
  })

  test("rejects invalid or unavailable profile identities", () => {
    expect(() => selectBrowserProfileUpstream(candidates, { profile: "2" })).toThrow("integer from 1 through 5")
    expect(() => selectBrowserProfileUpstream(candidates, { profile: 5 })).toThrow("profile 5 is unavailable")
  })
})

describe("upstreamProcessEnv", () => {
  test("confines engagement keys to the ZAP bridge", () => {
    const inherited = {
      PATH: "/usr/bin",
      CYBER_ZAP_API_KEY: "api-secret",
      CYBER_ZAP_MCP_KEY: "mcp-secret",
    }
    expect(upstreamProcessEnv("zap", inherited)).toMatchObject(inherited)
    expect(upstreamProcessEnv("browser", inherited)).toEqual({ PATH: "/usr/bin" })
    expect(upstreamProcessEnv("cyberful-os", inherited)).toEqual({ PATH: "/usr/bin" })
  })
})
