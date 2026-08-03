// ── One-Shot Tool Presentation Tests ─────────────────────────────
// Protects compact terminal summaries for completed shell, patch, and todo
// activity emitted by the non-interactive run command.
// → cyberful/src/cli/cmd/run/tool.ts — owns the presentation rules.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@/server/client"
import { SHELL_TOOL_ICON } from "../tool-display"
import { toolInlineInfo } from "./tool"

function toolPart(tool: string, input: Record<string, unknown>, output = ""): ToolPart {
  return {
    id: `part-${tool}`,
    sessionID: "session",
    messageID: "message",
    type: "tool",
    callID: `call-${tool}`,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
      metadata: tool === "apply_patch" ? { files: [{ filePath: "src/a.ts" }] } : {},
      time: { start: 1, end: 2 },
    },
  }
}

describe("one-shot tool display", () => {
  test("shows completed shell output as a terminal block", () => {
    expect(toolInlineInfo(toolPart("bash", { command: "bun typecheck" }, "ok"))).toEqual({
      icon: SHELL_TOOL_ICON,
      title: "bun typecheck",
      mode: "block",
      body: "ok",
    })
  })

  test("summarizes patches and todo state", () => {
    expect(toolInlineInfo(toolPart("apply_patch", {})).title).toBe("Patch 1 file")
    expect(
      toolInlineInfo(
        toolPart("todowrite", {
          todos: [
            { status: "completed", content: "inspect" },
            { status: "in_progress", content: "simplify" },
          ],
        }),
      ).body,
    ).toBe("[✓] inspect\n[•] simplify")
  })
})
