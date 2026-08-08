// ── Runtime Dependency Policy Tests ──────────────────────────────
// Exercises the environment-driven dependency policy users encounter when
// enabling browser, ZAP, Ghidra, and Pi phase execution in normal engagements.
// → cyberful/src/dependency/config.ts — implements the policy under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  cyberBrowserMcpCommand,
  cyberBrowserZapChainEnv,
  cyberGhidraBridgeCommand,
  cyberGhidraStartupTimeoutSeconds,
  cyberfulOsMcpCommand,
  cyberfulOsImage,
  cyberZapBridgeCommand,
  cyberZapProxyPort,
  cyberZapStartupTimeoutSeconds,
  expertSessionModel,
  expertRuntime,
  isExpertSessionModel,
  shouldChainBrowserThroughZap,
  shouldEnableCyberBrowserMcp,
  shouldEnableCyberGhidra,
  shouldEnableCyberZap,
  validateUnifiedRuntimeEnvironment,
} from "./config"

const ENV_KEYS = [
  "CYBER_BROWSER_MCP_COMMAND",
  "CYBER_BROWSER_MCP",
  "CYBER_BROWSER_MCP_ENABLED",
  "CYBER_BROWSER_MCP_ENTRY",
  "CYBER_BROWSER_PACKAGE_ROOT",
  "CYBER_BROWSER_BUN_REENTRY",
  "CYBERFUL_OS_IMAGE",
  "CYBERFUL_OS_CONTAINER",
  "CYBERFUL_OS_REQUIRE_ENGAGEMENT_CONTAINER",
  "CYBERFUL_OS_CA_BUNDLE",
  "CYBER_ZAP_ENABLED",
  "CYBER_BROWSER_THROUGH_ZAP",
  "CYBER_ZAP_IMAGE",
  "CYBER_ZAP_BRIDGE_IMAGE",
  "CYBER_ZAP_PROXY_PORT",
  "CYBER_ZAP_STARTUP_TIMEOUT_SECONDS",
  "CYBER_ZAP_CONTAINER",
  "CYBER_ZAP_PROXY_URL",
  "CYBER_ZAP_WORKAREA",
  "CYBER_ZAP_MCP_KEY",
  "CYBER_ZAP_API_KEY",
  "CYBER_GHIDRA_ENABLED",
  "CYBER_GHIDRA_IMAGE",
  "CYBER_GHIDRA_BRIDGE_IMAGE",
  "CYBER_GHIDRA_STARTUP_TIMEOUT_SECONDS",
  "CYBER_GHIDRA_CONTAINER",
  "CYBER_GHIDRA_MCP_KEY",
  "CYBER_BROWSER_PROXY_CA_SPKI",
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

async function withEnv<T>(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<T> | T) {
  const env = snapshotEnv()
  ENV_KEYS.forEach((key) => delete process.env[key])
  Object.assign(process.env, values)
  try {
    return await fn()
  } finally {
    restoreEnv(env)
  }
}

describe("Pi runtime config", () => {
  test("keeps Pi as immutable journal and execution identity", async () => {
    await withEnv({}, () => {
      expect(expertRuntime()).toEqual({ backend: "pi" })
      expect(expertSessionModel()).toEqual({
        subsystemID: "pi-agent",
        modelID: "configured-provider",
      })
      expect(isExpertSessionModel(expertSessionModel())).toBe(true)
      expect(isExpertSessionModel({ subsystemID: "openai", modelID: "gpt" })).toBe(false)
    })
  })
})

describe("unified cyberful-os launcher", () => {
  test("runs the MCP inside the engagement container without host Python", async () => {
    await withEnv(
      { CYBERFUL_OS_CONTAINER: "runtime", CYBERFUL_OS_REQUIRE_ENGAGEMENT_CONTAINER: "1" },
      () => {
        expect(cyberfulOsMcpCommand()).toEqual([
          "docker",
          "exec",
          "-i",
          "-w",
          "/workspace",
          "-e",
          "CYBERFUL_OS_IN_CONTAINER=1",
          "-e",
          "CYBERFUL_OS_MOUNT=/workspace",
          "-e",
          "CYBERFUL_SUBSYSTEM_WORKAREA_ROOT=/workspace",
          "-e",
          "CYBERFUL_OS_HTTP_PROXY",
          "-e",
          "CYBERFUL_OS_CA_BUNDLE",
          "runtime",
          "/opt/cyberful-os-venv/bin/python",
          "/opt/cyberful-os/cyberful_os_mcp.py",
        ])
      },
    )
  })
})

describe("browser MCP dependency config", () => {
  test("re-enters a packaged binary as Bun instead of requiring host Node", async () => {
    await withEnv(
      {
        CYBER_BROWSER_MCP_COMMAND: "/opt/cyberful",
        CYBER_BROWSER_MCP_ENTRY: "/var/cache/cyberful/browser/browser_mcp.mjs",
        CYBER_BROWSER_BUN_REENTRY: "1",
      },
      () => {
        expect(cyberBrowserMcpCommand()).toEqual([
          "/opt/cyberful",
          "/var/cache/cyberful/browser/browser_mcp.mjs",
        ])
      },
    )
  })

  test("uses an explicit command override", async () => {
    await withEnv({ CYBER_BROWSER_MCP_COMMAND: "/opt/cyber-browser" }, () => {
      expect(cyberBrowserMcpCommand()).toEqual(["/opt/cyber-browser"])
      expect(shouldEnableCyberBrowserMcp()).toBe(true)
    })
  })

  test("resolves the in-repo browser and enables by default", async () => {
    await withEnv({}, () => {
      expect(cyberBrowserMcpCommand()[0].endsWith("cyber-browser")).toBe(true)
      expect(shouldEnableCyberBrowserMcp()).toBe(true)
    })
  })

  test("stays disabled when explicitly turned off", async () => {
    await withEnv({ CYBER_BROWSER_MCP_COMMAND: "/opt/cyber-browser", CYBER_BROWSER_MCP_ENABLED: "0" }, () => {
      expect(shouldEnableCyberBrowserMcp()).toBe(false)
    })
  })
})

describe("ZAP dependency config", () => {
  test("is ready by default inside the unified image with a dynamic proxy port", async () => {
    await withEnv({}, () => {
      expect(shouldEnableCyberZap()).toBe(true)
      expect(shouldChainBrowserThroughZap()).toBe(true)
      expect(cyberfulOsImage()).toBe("cyberful-os:latest")
      expect(cyberZapProxyPort()).toBe(0)
      expect(cyberZapStartupTimeoutSeconds()).toBe(120)
    })
  })

  test("rejects separate images while retaining startup policy", async () => {
    await withEnv(
      {
        CYBER_ZAP_IMAGE: "registry.example/zap@sha256:test",
        CYBER_ZAP_BRIDGE_IMAGE: "registry.example/bridge@sha256:test",
        CYBER_ZAP_PROXY_PORT: "9191",
        CYBER_ZAP_STARTUP_TIMEOUT_SECONDS: "45",
      },
      () => {
        expect(() => validateUnifiedRuntimeEnvironment()).toThrow("CYBERFUL_OS_IMAGE")
        expect(cyberZapProxyPort()).toBe(9191)
        expect(cyberZapStartupTimeoutSeconds()).toBe(45)
      },
    )
  })

  test("rejects malformed ports, timeouts, and enablement switches", async () => {
    await withEnv({ CYBER_ZAP_PROXY_PORT: "9191junk" }, () =>
      expect(() => cyberZapProxyPort()).toThrow("decimal integer"),
    )
    await withEnv({ CYBER_ZAP_STARTUP_TIMEOUT_SECONDS: "3601" }, () =>
      expect(() => cyberZapStartupTimeoutSeconds()).toThrow("between 1 and 3600"),
    )
    await withEnv({ CYBER_ZAP_ENABLED: "enabled" }, () =>
      expect(() => shouldEnableCyberZap()).toThrow("CYBER_ZAP_ENABLED"),
    )
  })

  test("can disable ZAP or only its browser chain", async () => {
    await withEnv({ CYBER_ZAP_ENABLED: "0" }, () => {
      expect(shouldEnableCyberZap()).toBe(false)
      expect(shouldChainBrowserThroughZap()).toBe(false)
    })
    await withEnv({ CYBER_BROWSER_THROUGH_ZAP: "0" }, () => {
      expect(shouldEnableCyberZap()).toBe(true)
      expect(shouldChainBrowserThroughZap()).toBe(false)
    })
  })

  test("creates the browser chain only from a ready engagement descriptor", async () => {
    await withEnv({ CYBER_ZAP_PROXY_URL: "http://127.0.0.1:49152", CYBER_BROWSER_PROXY_CA_SPKI: "SPKIHASH=" }, () => {
      expect(cyberBrowserZapChainEnv()).toEqual({
        CYBER_BROWSER_PROXY: "http://127.0.0.1:49152",
        CYBER_BROWSER_PROXY_CA_SPKI: "SPKIHASH=",
      })
    })
    await withEnv({}, () => expect(cyberBrowserZapChainEnv()).toBeUndefined())
  })

  test("creates a bridge only after the engagement container exists", async () => {
    await withEnv({}, () => expect(cyberZapBridgeCommand()).toEqual([]))
    await withEnv({ CYBERFUL_OS_CONTAINER: "runtime" }, () => {
      expect(cyberZapBridgeCommand()).toEqual([
        "docker",
        "exec",
        "-i",
        "-e",
        "CYBER_ZAP_MCP_KEY",
        "-e",
        "CYBER_ZAP_API_KEY",
        "-e",
        "CYBER_ZAP_WORKAREA=/zap/wrk",
        "runtime",
        "node",
        "/opt/cyberful/zap/zap_bridge.mjs",
      ])
    })
  })
})

describe("Ghidra dependency config", () => {
  test("uses the unified image and a five-minute JVM startup window by default", async () => {
    await withEnv({}, () => {
      expect(shouldEnableCyberGhidra()).toBe(true)
      expect(cyberfulOsImage()).toBe("cyberful-os:latest")
      expect(cyberGhidraStartupTimeoutSeconds()).toBe(300)
      expect(cyberGhidraBridgeCommand()).toEqual([])
    })
  })

  test("creates a private bridge only for a live engagement container", async () => {
    await withEnv({ CYBERFUL_OS_CONTAINER: "runtime" }, () => {
      expect(cyberGhidraBridgeCommand()).toEqual([
        "docker",
        "exec",
        "-i",
        "-e",
        "CYBER_GHIDRA_MCP_KEY",
        "runtime",
        "/opt/cyberful-os-venv/bin/python",
        "/opt/cyberful/ghidra/ghidra_bridge.py",
      ])
    })
  })

  test("validates explicit enablement and startup policy", async () => {
    await withEnv({ CYBER_GHIDRA_ENABLED: "0" }, () => expect(shouldEnableCyberGhidra()).toBe(false))
    await withEnv({ CYBER_GHIDRA_ENABLED: "sometimes" }, () =>
      expect(() => shouldEnableCyberGhidra()).toThrow("CYBER_GHIDRA_ENABLED"),
    )
    await withEnv({ CYBER_GHIDRA_STARTUP_TIMEOUT_SECONDS: "29" }, () =>
      expect(() => cyberGhidraStartupTimeoutSeconds()).toThrow("between 30 and 3600"),
    )
  })
})
