// ── Composer Status Header Tests ────────────────────────────
// Verifies status precedence, elapsed-time copy, static animation fallback,
//   and single-line truncation for the composer shoulder.
// → cyberful/src/cli/cmd/tui/component/prompt/status-header.tsx — owns the tested view.
// ────────────────────────────────

import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ComposerStatusHeader, compactActivityDuration, composerStatusView } from "./status-header"

describe("composer status view", () => {
  test("uses the home label and the idle session state", () => {
    expect(composerStatusView({ label: "Prompt", status: { type: "idle" }, now: 0 })).toEqual({
      kind: "label",
      text: "Prompt",
    })
    expect(composerStatusView({ sessionID: "s", status: { type: "idle" }, now: 0 })).toEqual({
      kind: "idle",
      text: "○ Ready",
    })
  })

  test("uses generic busy copy until a live phase takes precedence", () => {
    expect(composerStatusView({ sessionID: "s", status: { type: "busy" }, now: 0 }).text).toBe("Working")
    expect(
      composerStatusView({
        sessionID: "s",
        status: { type: "busy", message: "generating... 000123 tokens" },
        now: 0,
      }).text,
    ).toBe("Working · generating... 000123 tokens")
    expect(
      composerStatusView({
        sessionID: "s",
        status: { type: "busy", message: "starting" },
        runningPhase: { phase: "recon", startedAt: 1_000 },
        now: 46_000,
      }).text,
    ).toBe("Working · 0:45 · Recon · generating")
  })

  test("formats tool work, long durations, and future timestamps", () => {
    expect(
      composerStatusView({
        sessionID: "s",
        status: { type: "busy" },
        runningPhase: { phase: "code-audit", lastKind: "tool", startedAt: 0 },
        now: 3_661_000,
      }).text,
    ).toBe("Working · 1:01:01 · Code Audit · executing job")
    expect(compactActivityDuration(-1_000)).toBe("0:00")
  })
})

test("the static header stays on one row and truncates after the primary status", async () => {
  const color = RGBA.fromHex("#ffffff")
  const view = await testRender(
    () => (
      <box width={18} height={1}>
        <ComposerStatusHeader
          status={{ kind: "working", text: "Working · 0:45 · Recon · executing job" }}
          borderColor={color}
          textColor={color}
          mutedColor={color}
          animationsEnabled={false}
        />
      </box>
    ),
    { width: 18, height: 1 },
  )

  try {
    await view.renderOnce()
    const frame = view.captureCharFrame()
    expect(frame).toContain("┏━ [ == ] Working")
    expect(frame).not.toContain("Recon")
    expect(frame.trimEnd().split("\n")).toHaveLength(1)
  } finally {
    view.renderer.destroy()
  }
})

test("the header remains stable at compact, normal, and wide terminal widths", async () => {
  for (const width of [40, 80, 120]) {
    const borderColor = RGBA.fromHex(width === 40 ? "#00aaff" : "#005577")
    const textColor = RGBA.fromHex(width === 40 ? "#ffffff" : "#111111")
    const mutedColor = RGBA.fromHex(width === 40 ? "#777777" : "#888888")
    const view = await testRender(
      () => (
        <box width={width} height={1}>
          <ComposerStatusHeader
            status={{ kind: "working", text: "Working · 0:45 · Recon · executing job" }}
            borderColor={borderColor}
            textColor={textColor}
            mutedColor={mutedColor}
            animationsEnabled={false}
          />
        </box>
      ),
      { width, height: 1 },
    )

    try {
      await view.renderOnce()
      const frame = view.captureCharFrame()
      expect(frame).toContain("┏━ [ == ] Working")
      expect(frame.trimEnd().split("\n")).toHaveLength(1)
      if (width >= 80) expect(frame).toContain("Working · 0:45 · Recon · executing job")
      const spans = view.captureSpans().lines[0]?.spans ?? []
      const shoulder = spans.find((span) => span.text.includes("┏━"))
      const working = spans.find((span) => span.text === "Working")
      const details = spans.find((span) => span.text.includes("· 0:45"))
      expect(shoulder?.fg).toEqual(borderColor)
      expect(working?.fg).toEqual(textColor)
      expect(details?.fg).toEqual(mutedColor)
    } finally {
      view.renderer.destroy()
    }
  }
})
