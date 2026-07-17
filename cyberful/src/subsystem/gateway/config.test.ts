// ── Private Phase Gateway Configuration Test ────────────────────
// Verifies that only approved browser and per-run values enter the owner-private
// gateway environment while unrelated host secrets remain absent.
// → cyberful/src/subsystem/gateway/config.ts — constructs the tested MCP descriptor.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"

import { SubsystemGateway } from "./config"

test("phase gateways receive the host browser profile contract and keep per-run precedence", () => {
  const names = [
    "CYBER_BROWSER_CHANNEL",
    "CYBER_BROWSER_USER_DATA_DIR",
    "CYBER_BROWSER_CLEAR_COOKIES_ON_START",
    "CYBER_BROWSER_HEADLESS",
    "CYBERFUL_TEST_HOST_SECRET",
  ] as const
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  try {
    process.env.CYBER_BROWSER_CHANNEL = "chrome"
    process.env.CYBER_BROWSER_USER_DATA_DIR = "/profiles/authenticated"
    process.env.CYBER_BROWSER_CLEAR_COOKIES_ON_START = "false"
    process.env.CYBERFUL_TEST_HOST_SECRET = "must-not-cross"
    delete process.env.CYBER_BROWSER_HEADLESS

    const server = SubsystemGateway.gatewayMcpServer("ses_1", {
      proxy: true,
      phase: "recon",
      env: { CYBER_BROWSER_HEADLESS: "true" },
    })

    expect(server.privateEnv?.CYBER_BROWSER_CHANNEL).toBe("chrome")
    expect(server.privateEnv?.CYBER_BROWSER_USER_DATA_DIR).toBe("/profiles/authenticated")
    expect(server.privateEnv?.CYBER_BROWSER_CLEAR_COOKIES_ON_START).toBe("false")
    expect(server.privateEnv?.CYBER_BROWSER_HEADLESS).toBe("true")
    expect(server.privateEnv?.CYBERFUL_SUBSYSTEM_PHASE).toBe("recon")
    expect(server.privateEnv?.CYBERFUL_TEST_HOST_SECRET).toBeUndefined()
  } finally {
    for (const name of names) {
      const value = previous[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
