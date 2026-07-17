// ── Built-In Gateway Upstream Tests ─────────────────────────────
// Verifies that runtime configuration produces the intended cyberful-os, browser,
// and ZAP upstream descriptors without leaking unrelated host environment values.
// → cyberful/src/subsystem/upstream.ts — constructs the tested descriptors.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemUpstream } from "./upstream"

const ENV_KEYS = [
  "CYBER_BROWSER_MCP_COMMAND",
  "CYBER_BROWSER_MCP",
  "CYBER_BROWSER_MCP_ENABLED",
  "CYBER_ZAP_ENABLED",
  "CYBER_BROWSER_THROUGH_ZAP",
  "CYBER_ZAP_CONTAINER",
  "CYBERFUL_SUBSYSTEM_SESSION",
  "CYBER_ZAP_PROXY_URL",
  "CYBER_ZAP_MCP_KEY",
  "CYBER_ZAP_API_KEY",
  "CYBER_BROWSER_PROXY_CA_SPKI",
  "CYBERFUL_OS_DIR",
  "CYBERFUL_OS_IMAGE",
  "CYBERFUL_OS_CONTAINER",
] as const

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  ENV_KEYS.forEach((key) => {
    const value = snapshot[key]
    if (value === undefined) delete process.env[key]
    if (value !== undefined) process.env[key] = value
  })
}

describe("SubsystemUpstream.builtin", () => {
  test("registers the canonical cyberful-os image and container identities", () => {
    const env = snapshotEnv()
    try {
      delete process.env.CYBERFUL_OS_IMAGE
      delete process.env.CYBERFUL_OS_CONTAINER

      expect(SubsystemUpstream.builtin()["cyberful-os"].environment).toMatchObject({
        CYBERFUL_OS_IMAGE: "cyberful-os:latest",
        CYBERFUL_OS_CONTAINER: "cyberful-os",
      })
    } finally {
      restoreEnv(env)
    }
  })

  test("registers the isolated browser MCP", () => {
    const env = snapshotEnv()
    try {
      process.env.CYBER_BROWSER_MCP_COMMAND = "/opt/cyber-browser"
      delete process.env.CYBER_BROWSER_MCP_ENABLED

      const builtins = SubsystemUpstream.builtin()
      expect("browseros" in builtins).toBe(false)
      expect(builtins.browser).toMatchObject({
        type: "local",
        command: ["/opt/cyber-browser"],
        enabled: true,
        timeout: 305_000,
      })
      expect(builtins.browser.environment?.CYBER_BROWSER_HEADLESS).toBe("false")
    } finally {
      restoreEnv(env)
    }
  })

  test("disables the browser MCP explicitly", () => {
    const env = snapshotEnv()
    try {
      process.env.CYBER_BROWSER_MCP_COMMAND = "/opt/cyber-browser"
      process.env.CYBER_BROWSER_MCP_ENABLED = "0"
      expect(SubsystemUpstream.builtin().browser.enabled).toBe(false)
    } finally {
      restoreEnv(env)
    }
  })

  test("registers the disposable ZAP bridge after engagement readiness", () => {
    const env = snapshotEnv()
    try {
      process.env.CYBER_ZAP_CONTAINER = "zap-run"
      process.env.CYBERFUL_SUBSYSTEM_SESSION = "ses-run"
      const zap = SubsystemUpstream.builtin().zap
      expect(zap).toMatchObject({
        type: "local",
        enabled: true,
        timeout: 305_000,
        container: `cyberful-zap-bridge-ses-run-${process.pid}`,
      })
      expect(zap.command).toEqual(
        expect.arrayContaining([
          "--name",
          `cyberful-zap-bridge-ses-run-${process.pid}`,
          "org.cyberful.managed=zap-bridge",
          "org.cyberful.session=ses-run",
          "container:zap-run",
        ]),
      )
    } finally {
      restoreEnv(env)
    }
  })

  test("does not spawn a bridge when default-on ZAP degraded before readiness", () => {
    const env = snapshotEnv()
    try {
      delete process.env.CYBER_ZAP_ENABLED
      delete process.env.CYBER_ZAP_CONTAINER
      const zap = SubsystemUpstream.builtin().zap
      expect(zap.enabled).toBe(false)
      expect(zap.command).toEqual([])
    } finally {
      restoreEnv(env)
    }
  })

  test("routes the browser through ready ZAP with scoped CA trust", () => {
    const env = snapshotEnv()
    try {
      process.env.CYBER_BROWSER_MCP_COMMAND = "/opt/cyber-browser"
      process.env.CYBER_ZAP_PROXY_URL = "http://127.0.0.1:49152"
      process.env.CYBER_BROWSER_PROXY_CA_SPKI = "AAAAtestspkihashBBBB="
      const browser = SubsystemUpstream.builtin().browser
      expect(browser.environment?.CYBER_BROWSER_PROXY).toBe("http://127.0.0.1:49152")
      expect(browser.environment?.CYBER_BROWSER_PROXY_CA_SPKI).toBe("AAAAtestspkihashBBBB=")
    } finally {
      restoreEnv(env)
    }
  })

  test("leaves the browser direct when chaining is disabled", () => {
    const env = snapshotEnv()
    try {
      process.env.CYBER_BROWSER_MCP_COMMAND = "/opt/cyber-browser"
      process.env.CYBER_ZAP_PROXY_URL = "http://127.0.0.1:49152"
      process.env.CYBER_BROWSER_PROXY_CA_SPKI = "AAAAtestspkihashBBBB="
      process.env.CYBER_BROWSER_THROUGH_ZAP = "0"
      expect(SubsystemUpstream.builtin().browser.environment?.CYBER_BROWSER_PROXY).toBeUndefined()
    } finally {
      restoreEnv(env)
    }
  })
})
