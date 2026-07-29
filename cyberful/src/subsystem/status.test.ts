// ── Pi Subsystem Readiness Snapshot Tests ───────────────────────
// Verifies that configured provider authentication outcomes become the
// bounded public states rendered on the welcome screen.
// → cyberful/src/subsystem/status.ts — owns the readiness reduction under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import piAgentPackage from "@earendil-works/pi-agent-core/package.json"
import { Settings } from "@/config/settings"
import type { SubsystemStatus as AgentSubsystemStatus } from "./agent-subsystem"
import { SubsystemStatus } from "./status"

const settings = Settings.parse(`version: 1
agent:
  subsystem: pi
  main_provider: main
  fallback_provider: fallback
  subagents:
    enabled: true
    max_per_run: 4
    max_concurrent: 2
    max_depth: 2
  fallback:
    proactive:
      enabled: true
      percentage: 2
    automatic_security_block:
      enabled: true
  providers:
    main:
      adapter: openai-completions
      base_url: https://main.example/v1
      model: main-model
      auth:
        type: environment
        variable: MAIN_API_KEY
      context_window: 100000
      max_output_tokens: 10000
    fallback:
      adapter: openai-completions
      base_url: https://fallback.example/v1
      model: fallback-model
      auth:
        type: environment
        variable: FALLBACK_API_KEY
      context_window: 100000
      max_output_tokens: 10000
instructions:
  persona_roots: []
  skill_roots: []
  allow_project_discovery: false
`)

function subsystemStatus(options?: {
  mainAuthenticated?: boolean
  fallbackAuthenticated?: boolean
}): AgentSubsystemStatus {
  const mainAuthenticated = options?.mainAuthenticated ?? true
  const fallbackAuthenticated = options?.fallbackAuthenticated ?? true
  const errors = [
    ...(mainAuthenticated ? [] : ["Provider 'main' has no configured environment"]),
    ...(fallbackAuthenticated ? [] : ["Provider 'fallback' has no configured environment"]),
  ]
  return {
    ready: mainAuthenticated,
    degraded: mainAuthenticated && !fallbackAuthenticated,
    subsystem: "pi",
    providers: [
      {
        id: "main",
        model: "main-model",
        route: "main",
        authenticated: mainAuthenticated,
      },
      {
        id: "fallback",
        model: "fallback-model",
        route: "fallback",
        authenticated: fallbackAuthenticated,
      },
    ],
    errors,
  }
}

describe("subsystem readiness", () => {
  test("reports an authenticated Pi provider route", async () => {
    await expect(
      SubsystemStatus.inspect({
        settings,
        inspectSubsystem: async () => subsystemStatus(),
      }),
    ).resolves.toEqual({
      main: {
        name: "pi/main",
        model: "main-model",
        version: piAgentPackage.version,
        status: "available",
      },
    })
  })

  test("degrades when main works but the configured fallback is unavailable", async () => {
    const preflight = subsystemStatus({ fallbackAuthenticated: false })
    expect(preflight.ready).toBe(true)
    expect(preflight.degraded).toBe(true)

    await expect(
      SubsystemStatus.inspect({
        settings,
        inspectSubsystem: async () => subsystemStatus({ fallbackAuthenticated: false }),
      }),
    ).resolves.toEqual({
      main: {
        name: "pi/main",
        model: "main-model",
        version: piAgentPackage.version,
        status: "degraded",
      },
    })
  })

  test("reports unavailable for a failed main probe or unreadable settings", async () => {
    const failedPreflight = subsystemStatus({ mainAuthenticated: false })
    expect(failedPreflight.ready).toBe(false)
    expect(failedPreflight.degraded).toBe(false)

    const mainUnavailable = await SubsystemStatus.inspect({
      settings,
      inspectSubsystem: async () => failedPreflight,
    })
    expect(mainUnavailable).toEqual({
      main: {
        name: "pi/main",
        model: "main-model",
        version: piAgentPackage.version,
        status: "unavailable",
      },
    })

    const unconfigured = await SubsystemStatus.inspect({
      loadSettings: async () => {
        throw new Error("settings unavailable")
      },
    })
    expect(unconfigured).toEqual({
      main: {
        name: "pi",
        model: "unconfigured",
        version: piAgentPackage.version,
        status: "unavailable",
      },
    })
  })
})
