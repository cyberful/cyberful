// ── Subsystem Readiness Snapshot Tests ──────────────────────────
// Verifies that Codex compatibility and authentication outcomes become the
// bounded public states rendered on the welcome screen.
// → cyberful/src/subsystem/status.ts — owns the readiness reduction under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemStatus } from "./status"

const runtime = { backend: "codex", command: "codex", model: "gpt-test" } as const

describe("subsystem readiness", () => {
  test("reports a compatible authenticated runtime", async () => {
    await expect(
      SubsystemStatus.inspect({
        runtime,
        inspectVersion: async () => ({ status: "match", version: "1.2.3" }),
        inspectLogin: async () => true,
      }),
    ).resolves.toEqual({
      primary: { name: "codex", model: "gpt-test", version: "1.2.3", status: "available" },
    })
  })

  test("uses warning and error states for degraded or failed probes", async () => {
    const degraded = await SubsystemStatus.inspect({
      runtime,
      inspectVersion: async () => ({ status: "mismatch", version: "2.0.0" }),
      inspectLogin: async () => true,
    })
    expect(degraded).toEqual({
      primary: { name: "codex", model: "gpt-test", version: "2.0.0", status: "degraded" },
    })

    const unavailable = await SubsystemStatus.inspect({
      runtime,
      inspectVersion: async () => {
        throw new Error("probe failed")
      },
      inspectLogin: async () => false,
    })
    expect(unavailable).toEqual({
      primary: { name: "codex", model: "gpt-test", status: "unavailable" },
    })
  })
})
