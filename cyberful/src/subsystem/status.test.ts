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
  primary_provider: primary
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
    primary:
      adapter: openai-completions
      base_url: https://primary.example/v1
      model: primary-model
      auth:
        type: environment
        variable: PRIMARY_API_KEY
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
  primaryAuthenticated?: boolean
  fallbackAuthenticated?: boolean
}): AgentSubsystemStatus {
  const primaryAuthenticated = options?.primaryAuthenticated ?? true
  const fallbackAuthenticated = options?.fallbackAuthenticated ?? true
  const errors = [
    ...(primaryAuthenticated ? [] : ["Provider 'primary' has no configured environment"]),
    ...(fallbackAuthenticated ? [] : ["Provider 'fallback' has no configured environment"]),
  ]
  return {
    ready: primaryAuthenticated,
    degraded: primaryAuthenticated && !fallbackAuthenticated,
    subsystem: "pi",
    providers: [
      {
        id: "primary",
        model: "primary-model",
        route: "primary",
        authenticated: primaryAuthenticated,
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
      primary: {
        name: "pi/primary",
        model: "primary-model",
        version: piAgentPackage.version,
        status: "available",
      },
    })
  })

  test("degrades when primary works but the configured fallback is unavailable", async () => {
    const preflight = subsystemStatus({ fallbackAuthenticated: false })
    expect(preflight.ready).toBe(true)
    expect(preflight.degraded).toBe(true)

    await expect(
      SubsystemStatus.inspect({
        settings,
        inspectSubsystem: async () => subsystemStatus({ fallbackAuthenticated: false }),
      }),
    ).resolves.toEqual({
      primary: {
        name: "pi/primary",
        model: "primary-model",
        version: piAgentPackage.version,
        status: "degraded",
      },
    })
  })

  test("reports unavailable for a failed primary probe or unreadable settings", async () => {
    const failedPreflight = subsystemStatus({ primaryAuthenticated: false })
    expect(failedPreflight.ready).toBe(false)
    expect(failedPreflight.degraded).toBe(false)

    const primaryUnavailable = await SubsystemStatus.inspect({
      settings,
      inspectSubsystem: async () => failedPreflight,
    })
    expect(primaryUnavailable).toEqual({
      primary: {
        name: "pi/primary",
        model: "primary-model",
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
      primary: {
        name: "pi",
        model: "unconfigured",
        version: piAgentPackage.version,
        status: "unavailable",
      },
    })
  })
})
