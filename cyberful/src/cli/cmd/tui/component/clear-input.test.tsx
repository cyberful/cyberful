// ── Focused Input Clear Control Tests ────────────────────────────
// Verifies that focus reveals the white clear action and a click empties the editor.
// → cyberful/src/cli/cmd/tui/component/clear-input.tsx — owns the tested control.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import type { TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { ClearInput } from "./clear-input"

test("focus reveals a white clear action that empties the editor", async () => {
  let input: TextareaRenderable | undefined
  const [focused, setFocused] = createSignal(false)
  const view = await testRender(
    () => (
      <box width={12} height={1} flexDirection="row">
        <textarea
          flexGrow={1}
          height={1}
          initialValue="draft"
          ref={(renderable: TextareaRenderable) => (input = renderable)}
          on:focused={() => setFocused(true)}
          on:blurred={() => setFocused(false)}
        />
        <ClearInput
          id="clear-input"
          visible={focused()}
          onClear={() => {
            input?.setText("")
            input?.focus()
          }}
        />
      </box>
    ),
    { width: 12, height: 1 },
  )

  try {
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("×")
    const editor = input
    if (!editor) throw new Error("textarea is missing")

    editor.focus()
    await view.renderOnce()
    expect(view.captureCharFrame()).toContain("×")
    const clear = view.renderer.root.findDescendantById("clear-input")
    if (!clear) throw new Error("clear input control is missing")
    const glyph = view
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("×"))
    expect(glyph && [glyph.fg.r, glyph.fg.g, glyph.fg.b, glyph.fg.a]).toEqual([1, 1, 1, 1])

    await view.mockMouse.click(clear.screenX, clear.screenY, 0, { delayMs: 0 })
    expect(editor.plainText).toBe("")
    expect(editor.focused).toBe(true)

    editor.blur()
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("×")
  } finally {
    view.renderer.destroy()
  }
})
