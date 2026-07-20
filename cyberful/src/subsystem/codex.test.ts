// ── Codex Identity And Policy Tests ─────────────────────────────
// Verifies process identity transport, effort selection, persona delegation,
// and thread settings attestation at the worker and app-server boundaries.
// → cyberful/src/subsystem/codex.ts — owns the tested Codex-specific policy.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { CODEX_PINNED_VERSION } from "@/dependency/codex"
import { SubsystemCodex } from "./codex"

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message)
  return value
}

describe("Codex subsystem identity", () => {
  test("owns the display label derived from the detected runtime version", () => {
    expect(SubsystemCodex.descriptor("1.2.3")).toEqual({
      name: "codex",
      version: "1.2.3",
      label: "codex v1.2.3",
    })
  })

  test("round-trips the verified descriptor and mismatch note through the worker boundary", () => {
    const runtime = {
      ...SubsystemCodex.descriptor("0.145.0"),
      versionNote: `Codex 0.145.0 · atteso ${CODEX_PINNED_VERSION}`,
    }
    const env = SubsystemCodex.workerEnv(runtime)
    expect(SubsystemCodex.runtimeDescriptor(env)).toEqual({
      name: "codex",
      version: "0.145.0",
      label: "codex v0.145.0",
    })
    expect(SubsystemCodex.preflightNote(env)).toBe(runtime.versionNote)
  })

  test("uses the build-validated version when the preflight transport is unavailable", () => {
    expect(SubsystemCodex.runtimeDescriptor({})).toEqual({
      name: "codex",
      version: CODEX_PINNED_VERSION,
      label: `codex v${CODEX_PINNED_VERSION}`,
    })
  })
})

describe("Codex effort and persona delegation policy", () => {
  test("resolves effort only inside the Codex application", () => {
    expect(SubsystemCodex.effort({})).toBe("xhigh")
    expect(SubsystemCodex.effort({ CYBERFUL_SUBSYSTEM_EFFORT: " ultra " })).toBe("ultra")
  })

  test("strips persona frontmatter and defaults missing subagents to zero", () => {
    expect(SubsystemCodex.parsePersona("# Brief\n\nPolicy")).toEqual({ content: "# Brief\n\nPolicy", subagents: 0 })
    expect(SubsystemCodex.parsePersona("---\nsubagents: 3\n---\n# Recon\n")).toEqual({
      content: "# Recon",
      subagents: 3,
    })
  })

  test("rejects every explicit subagents value that is not a non-negative integer", () => {
    for (const value of ["-1", "1.5", '"2"'])
      expect(() => SubsystemCodex.parsePersona(`---\nsubagents: ${value}\n---\n# Persona`)).toThrow(
        "must be a non-negative integer",
      )
  })

  test("enables bounded concurrent delegation only for Ultra", () => {
    const enabled = SubsystemCodex.composeDeveloperInstructions(
      "---\nsubagents: 2\n---\n# Exploit",
      "shared posture",
      "ultra",
    )
    expect(enabled.delegationEnabled).toBe(true)
    expect(enabled.instructions).not.toContain("subagents: 2")
    expect(enabled.instructions).toContain("no more than 2 subagents active at the same time")
    expect(enabled.instructions).toContain(
      "explicitly require a direct subagent, you must attempt that bounded spawn once",
    )
    expect(enabled.instructions).toContain('fork_turns: "none"')
    expect(enabled.instructions).toContain("remain solely responsible for synthesis")

    const layered = SubsystemCodex.composeDeveloperInstructions(
      "# Exploit",
      ["shared posture", "host trust boundary"],
      "high",
    )
    expect(layered.instructions.indexOf("host trust boundary")).toBeGreaterThan(
      layered.instructions.indexOf("shared posture"),
    )

    const lowerEffort = SubsystemCodex.composeDeveloperInstructions(
      "---\nsubagents: 2\n---\n# Exploit",
      "shared posture",
      "high",
    )
    expect(lowerEffort.delegationEnabled).toBe(false)
    expect(lowerEffort.instructions).toContain("Do not spawn subagents")
    expect(SubsystemCodex.delegationInstructions(0, "ultra")).toContain("Do not spawn subagents")
  })
})

describe("Codex settings attestation", () => {
  const event = (effort: string | null, multiAgentMode = "explicitRequestOnly") => ({
    method: "thread/settings/updated",
    params: { threadId: "thr_1", threadSettings: { effort, multiAgentMode } },
  })

  test("decodes and accepts the effective Ultra settings reported by app-server", () => {
    const settings = requireValue(
      SubsystemCodex.threadSettings(event("ultra")),
      "valid app-server settings event was not decoded",
    )
    expect(settings).toEqual({ threadID: "thr_1", effort: "ultra", multiAgentMode: "explicitRequestOnly" })
    expect(SubsystemCodex.attestThreadSettings(settings, "ultra", "thr_1")).toBeUndefined()
  })

  test("rejects missing, mismatched, or non-explicit settings", () => {
    const missingEffort = requireValue(
      SubsystemCodex.threadSettings(event(null)),
      "settings event with a null effort was not decoded",
    )
    const mismatchedEffort = requireValue(
      SubsystemCodex.threadSettings(event("high")),
      "settings event with a high effort was not decoded",
    )
    const proactive = requireValue(
      SubsystemCodex.threadSettings(event("ultra", "proactive")),
      "settings event with proactive delegation was not decoded",
    )
    expect(SubsystemCodex.attestThreadSettings(missingEffort, "ultra", "thr_1")).toContain("resolved effort 'null'")
    expect(SubsystemCodex.attestThreadSettings(mismatchedEffort, "ultra", "thr_1")).toContain("expected 'ultra'")
    expect(SubsystemCodex.attestThreadSettings(proactive, "ultra", "thr_1")).toContain("expected 'explicitRequestOnly'")
    expect(SubsystemCodex.threadSettings({ method: "turn/started", params: {} })).toBeUndefined()
  })
})
