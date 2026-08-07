// ── Tool Heading Behavior Tests ──────────────────────────────────
// Protects user-visible tool summaries, pending-input handling, output bounds,
//   and suppression of sensitive values in routine session activity.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { targetCooldownDisplay, toolDisplaySummary, toolInputRecord } from "./tool-display"

describe("tool display", () => {
  test("summarizes known tool inputs", () => {
    expect(toolDisplaySummary("grep", { pattern: "toolStatus", path: "cyberful/src/cli/cmd/run" })).toBe(
      "grep pattern=toolStatus path=cyberful/src/cli/cmd/run",
    )
    expect(toolDisplaySummary("target_cooldown", { origin: "https://app.example.test" })).toBe(
      "target_cooldown https://app.example.test duration=180s",
    )
    expect(
      toolDisplaySummary("target_cooldown", {
        origin: "https://app.example.test",
        duration_seconds: 360,
      }),
    ).toBe("target_cooldown https://app.example.test duration=360s")
  })

  test("parses pending raw JSON input", () => {
    const raw = '{"command":"bun typecheck","workdir":"cyberful"}'

    expect(toolInputRecord(raw)).toEqual({
      command: "bun typecheck",
      workdir: "cyberful",
    })
    expect(toolDisplaySummary("bash", raw)).toBe("bash bun typecheck workdir=cyberful")
    expect(toolDisplaySummary("shell", raw)).toBe("shell bun typecheck workdir=cyberful")
  })

  test("explains a target cooldown with bounded transport evidence", () => {
    expect(
      targetCooldownDisplay({
        origin: "https://app.example.test",
        duration_seconds: 240,
        transport_error: "empty_response",
        consecutive_transport_failures: 3,
        evidence_summary: "  The origin responded with 200, then three requests returned no HTTP status.  ",
      }),
    ).toEqual({
      origin: "https://app.example.test",
      durationSeconds: 240,
      reason: "empty response · 3 consecutive transport failures",
      evidence: "The origin responded with 200, then three requests returned no HTTP status.",
    })

    expect(
      targetCooldownDisplay({
        origin: "https://app.example.test",
        duration_seconds: 30,
        transport_error: "provider_error",
        consecutive_transport_failures: 1,
      }),
    ).toEqual({
      origin: "https://app.example.test",
      durationSeconds: 180,
      reason: undefined,
      evidence: undefined,
    })
  })

  test("bounds long shell commands in tool headings", () => {
    expect(toolDisplaySummary("shell", { command: `python3 -c ${"x".repeat(180)}` })).toBe(
      `shell python3 -c ${"x".repeat(66)}...`,
    )
  })

  test("keeps session-variable values out of tool headings", () => {
    expect(toolDisplaySummary("variable", { action: "set", name: "api_token", value: "secret" })).toBe(
      "variable action=set name=api_token",
    )
  })

  test("keeps partial pending JSON quiet", () => {
    expect(toolDisplaySummary("bash", '{"command":')).toBe("bash")
  })
})
