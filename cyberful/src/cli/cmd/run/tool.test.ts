// ── Interactive Tool Rendering Tests ─────────────────────────────
// Protects the headings, inline summaries, scrollback forms, and structured
//   snapshots users see for routine shell and file-edit tool activity.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import type { ToolPart } from "@/server/client"
import { SHELL_TOOL_ICON } from "../tool-display"
import { entryBody } from "./entry.body"
import { toolFrame, toolInlineInfo, toolScroll } from "./tool"
import type { StreamCommit } from "./types"

function bashPart(input: Record<string, unknown>): ToolPart {
  return {
    id: "part-bash",
    sessionID: "session",
    messageID: "message",
    type: "tool",
    callID: "call-bash",
    tool: "bash",
    state: {
      status: "running",
      input,
      title: "Shell",
      metadata: {},
      time: { start: 1 },
    },
  }
}

function bashCommit(part: ToolPart): StreamCommit {
  return {
    kind: "tool",
    source: "tool",
    text: "",
    phase: "start",
    partID: part.id,
    tool: part.tool,
    part,
    toolState: "running",
  }
}

describe("run tool display", () => {
  test("uses the codicon terminal glyph", () => {
    expect(SHELL_TOOL_ICON).toBe("\uea85")
  })

  test("uses the terminal icon for bash inline info", () => {
    expect(toolInlineInfo(bashPart({ command: "bun typecheck" })).icon).toBe(SHELL_TOOL_ICON)
  })

  test("uses the terminal icon for direct shell start entries", () => {
    expect(
      entryBody({
        kind: "tool",
        source: "tool",
        text: "Executing shell",
        phase: "start",
        partID: "shell:call",
        tool: "bash",
        toolState: "running",
        shell: {
          callID: "call",
          command: "bun typecheck",
        },
      }),
    ).toEqual({
      type: "text",
      content: `${SHELL_TOOL_ICON} bun typecheck`,
    })
  })

  test("uses the terminal icon in bash titles without changing command prompt lines", () => {
    expect(
      toolScroll(
        "start",
        toolFrame(
          bashCommit(
            bashPart({
              command: "bun typecheck",
            }),
          ),
          "",
        ),
      ),
    ).toBe(`${SHELL_TOOL_ICON} bun typecheck`)
    expect(
      toolScroll(
        "start",
        toolFrame(
          bashCommit(
            bashPart({
              command: "bun typecheck",
              description: "Typecheck",
              workdir: "cyberful",
            }),
          ),
          "",
        ),
      ),
    ).toBe(`${SHELL_TOOL_ICON} Typecheck in cyberful\n$ bun typecheck`)
  })

  test("strips terminal controls from generic MCP tool output", () => {
    expect(
      entryBody({
        kind: "tool",
        source: "tool",
        text: "\x1b[35mhttp://app.lexroom.ai\x1b[0m [200 OK]\rERROR Opening: http://api.lexroom.ai\x08",
        phase: "progress",
        partID: "part-mcp-whatweb",
        tool: "cyberful-os:whatweb",
        toolState: "completed",
      }),
    ).toEqual({
      type: "text",
      content: "http://app.lexroom.ai [200 OK]\nERROR Opening: http://api.lexroom.ai",
    })
  })

  test("renders direct shell html progress as code", () => {
    expect(
      entryBody({
        kind: "tool",
        source: "tool",
        text: '<!DOCTYPE html><html lang="it"><head><meta charSet="utf-8"/></head><body></body></html>',
        phase: "progress",
        partID: "shell:call",
        tool: "bash",
        toolState: "running",
        shell: {
          callID: "call",
          command: "curl -s https://example.com -o /tmp/login_page.html && cat /tmp/login_page.html",
        },
      }),
    ).toEqual({
      type: "code",
      content: '\n<!DOCTYPE html><html lang="it"><head><meta charSet="utf-8"/></head><body></body></html>',
      filetype: "html",
    })
  })

  test("renders detected generic tool output as code", () => {
    expect(
      entryBody({
        kind: "tool",
        source: "tool",
        text: '{"ok":true,"items":[1,2]}',
        phase: "progress",
        partID: "part-json",
        tool: "cyberful-os:metadata",
        toolState: "completed",
      }),
    ).toEqual({
      type: "code",
      content: '{"ok":true,"items":[1,2]}',
      filetype: "json",
    })

    expect(
      entryBody({
        kind: "tool",
        source: "tool",
        text: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new",
        phase: "progress",
        partID: "part-diff",
        tool: "cyberful-os:patch-preview",
        toolState: "completed",
      }),
    ).toEqual({
      type: "code",
      content: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new",
      filetype: "diff",
    })
  })

  test("keeps final bash status formatting as text", () => {
    expect(
      toolScroll(
        "final",
        toolFrame(
          {
            kind: "tool",
            source: "tool",
            text: "",
            phase: "final",
            partID: "part-bash",
            tool: "bash",
            toolState: "completed",
            part: {
              ...bashPart({ command: "bun typecheck" }),
              state: {
                status: "completed",
                input: { command: "bun typecheck" },
                metadata: {},
                output: "",
                title: "Shell",
                time: { start: 1, end: 2001 },
              },
            },
          },
          "",
        ),
      ),
    ).toBe("bash completed · 2.0s")
  })
})
