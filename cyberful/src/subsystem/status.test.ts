// ── Subsystem Readiness Snapshot Tests ──────────────────────────
// Verifies that primary compatibility, authentication, and fallback preflight
//   outcomes become the bounded public states rendered on the welcome screen.
// → cyberful/src/subsystem/status.ts — owns the readiness reduction under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemStatus } from "./status"

const runtime = { backend: "codex", command: "codex", model: "gpt-test" } as const

describe("subsystem readiness", () => {
  test("reports a compatible authenticated primary and reachable fallback", async () => {
    await expect(
      SubsystemStatus.inspect("/workspace", {
        runtime,
        inspectVersion: async () => ({ status: "match", version: "1.2.3" }),
        inspectLogin: async () => true,
        inspectFallback: async () => ({
          status: "available",
          config: {
            version: 1,
            enabled: true,
            protocol: "openai-responses",
            baseUrl: "http://127.0.0.1:8000/v1",
            model: "local-model",
            systemPrompt: "test",
          },
        }),
      }),
    ).resolves.toEqual({
      primary: { name: "codex", model: "gpt-test", version: "1.2.3", status: "available" },
      fallback: { model: "local-model", status: "available" },
    })
  })

  test("uses warning and error states for degraded or failed probes", async () => {
    const degraded = await SubsystemStatus.inspect("/workspace", {
      runtime,
      inspectVersion: async () => ({ status: "mismatch", version: "2.0.0" }),
      inspectLogin: async () => true,
      inspectFallback: async () => ({
        status: "disabled",
        reason: "missing",
        warning: "fallback-server.yaml is missing; local fallback inference is disabled for this run.",
      }),
    })
    expect(degraded).toEqual({
      primary: { name: "codex", model: "gpt-test", version: "2.0.0", status: "degraded" },
      fallback: { status: "disabled" },
    })

    const unavailable = await SubsystemStatus.inspect("/workspace", {
      runtime,
      inspectVersion: async () => {
        throw new Error("probe failed")
      },
      inspectLogin: async () => false,
      inspectFallback: async () => {
        throw new Error("invalid fallback configuration")
      },
    })
    expect(unavailable).toEqual({
      primary: { name: "codex", model: "gpt-test", status: "unavailable" },
      fallback: { status: "unavailable" },
    })
  })
})
