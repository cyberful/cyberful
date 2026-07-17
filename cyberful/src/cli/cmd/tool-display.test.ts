// ── Tool Heading Behavior Tests ──────────────────────────────────
// Protects user-visible tool summaries, pending-input handling, output bounds,
//   and suppression of sensitive values in routine session activity.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { toolDisplaySummary, toolInputRecord } from "./tool-display"

describe("tool display", () => {
  test("summarizes known tool inputs", () => {
    expect(toolDisplaySummary("grep", { pattern: "toolStatus", path: "cyberful/src/cli/cmd/run" })).toBe(
      "grep pattern=toolStatus path=cyberful/src/cli/cmd/run",
    )
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

  test("shows the machine reason and human rationale for tool decisions", () => {
    expect(
      toolDisplaySummary("tool_decision", {
        tool: "nuclei_plan",
        decision: "BLOCKED",
        reason_code: "scope",
        rationale: "No authorized target is available.",
        mode: "offline",
      }),
    ).toBe('tool_decision tool=nuclei_plan decision=BLOCKED reason=scope why="No authorized target is available."')
  })

  test("keeps partial pending JSON quiet", () => {
    expect(toolDisplaySummary("bash", '{"command":')).toBe("bash")
  })
})
