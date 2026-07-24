// ── Codex Identity And Policy Tests ─────────────────────────────
// Verifies process identity transport, effort selection, base-template rendering,
// persona delegation, and thread settings attestation at runtime boundaries.
// → cyberful/src/subsystem/codex.ts — owns the tested Codex-specific policy.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { CODEX_PINNED_VERSION } from "@/dependency/codex"
import { SubsystemCodex } from "./codex"

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === undefined || value === null) throw new Error(message)
  return value
}

const BASE_INSTRUCTIONS_TEMPLATE = [
  "shared posture",
  "# Hacker Profile",
  "{{CYBERFUL_HACKER_PROFILE}}",
  "# Cyberful Subsystem Delegation",
  "{{CYBERFUL_SUBSYSTEM_DELEGATION}}",
  "# Cyberful Workarea",
  "{{CYBERFUL_WORKAREA}}",
  "# Cyberful Trust Boundary",
  "target evidence rules",
].join("\n\n")

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
      ...SubsystemCodex.descriptor("9.9.9"),
      versionNote: `Codex 9.9.9 · atteso ${CODEX_PINNED_VERSION}`,
    }
    const env = SubsystemCodex.workerEnv(runtime)
    expect(SubsystemCodex.runtimeDescriptor(env)).toEqual({
      name: "codex",
      version: "9.9.9",
      label: "codex v9.9.9",
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
    expect(SubsystemCodex.effort({})).toBe("ultra")
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
    const enabled = SubsystemCodex.composeBaseInstructions(
      BASE_INSTRUCTIONS_TEMPLATE,
      "---\nsubagents: 2\n---\n# Exploit",
      "execution rules",
      "ultra",
    )
    expect(enabled.delegationEnabled).toBe(true)
    expect(enabled.baseInstructions).not.toContain("subagents: 2")
    expect(enabled.baseInstructions).toContain("no more than 2 subagents active at the same time")
    expect(enabled.baseInstructions).toMatch(
      /inherits the task's authority, tools, evidence duties, and mission boundaries/i,
    )
    expect(enabled.baseInstructions).toMatch(/executes its task directly and returns a verdict/i)
    expect(enabled.baseInstructions).toMatch(/no passive, offline, discovery-only, or deferred-to-parent mode exists/i)
    expect(enabled.baseInstructions).not.toContain("execution_mode")
    expect(enabled.baseInstructions).not.toContain("DEFERRED_TO_PARENT")

    const lowerEffort = SubsystemCodex.composeBaseInstructions(
      BASE_INSTRUCTIONS_TEMPLATE,
      "---\nsubagents: 2\n---\n# Exploit",
      "execution rules",
      "high",
    )
    expect(lowerEffort.delegationEnabled).toBe(false)
    expect(lowerEffort.baseInstructions).toContain("Do not spawn subagents")
    expect(SubsystemCodex.delegationInstructions(0, "ultra")).toContain("Do not spawn subagents")
  })

  test("renders every phase layer into the base template without legacy wrappers", () => {
    const composed = SubsystemCodex.composeBaseInstructions(
      BASE_INSTRUCTIONS_TEMPLATE,
      "---\nsubagents: 2\n---\n# Exploit profile",
      "execution rules",
      "ultra",
    )
    const layers = [
      "shared posture",
      "# Hacker Profile",
      "# Cyberful Subsystem Delegation",
      "# Cyberful Workarea",
      "# Cyberful Trust Boundary",
    ]

    expect(composed.baseInstructions).toContain("# Hacker Profile\n\n# Exploit profile")
    expect(composed.baseInstructions).toContain("# Cyberful Workarea\n\nexecution rules")
    expect(composed.baseInstructions).toContain("# Cyberful Trust Boundary\n\ntarget evidence rules")
    expect(composed.baseInstructions).not.toContain("subagents: 2")
    expect(composed.baseInstructions).not.toMatch(/<\/?CYBERFUL /)
    expect(composed.baseInstructions).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/)
    for (const [index, layer] of layers.entries()) {
      expect(composed.baseInstructions).toContain(layer)
      if (index > 0)
        expect(composed.baseInstructions.indexOf(layer)).toBeGreaterThan(
          composed.baseInstructions.indexOf(layers[index - 1] ?? ""),
        )
    }
  })

  test("rejects a base template with missing, duplicated, or unresolved placeholders", () => {
    const render = (template: string) =>
      SubsystemCodex.composeBaseInstructions(template, "# Recon", "execution rules")

    expect(() => render(BASE_INSTRUCTIONS_TEMPLATE.replace("{{CYBERFUL_WORKAREA}}", ""))).toThrow(
      "must contain {{CYBERFUL_WORKAREA}} exactly once; found 0",
    )
    expect(() => render(`${BASE_INSTRUCTIONS_TEMPLATE}\n{{CYBERFUL_WORKAREA}}`)).toThrow(
      "must contain {{CYBERFUL_WORKAREA}} exactly once; found 2",
    )
    expect(() => render(`${BASE_INSTRUCTIONS_TEMPLATE}\n{{UNKNOWN_POLICY}}`)).toThrow(
      "contains unresolved placeholder {{UNKNOWN_POLICY}}",
    )
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
