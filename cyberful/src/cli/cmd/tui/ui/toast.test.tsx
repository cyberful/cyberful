// ── Toast Ownership Regression Tests ─────────────────────────────
// Verifies that asynchronous notification updates reuse renderables without
//   creating ownerless Solid computations or losing their visible content.
// → cyberful/src/cli/cmd/tui/ui/toast.tsx — owns the stable surface under test.
// ─────────────────────────────────────────────────────────────────

import { expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { DEFAULT_THEME, resolveTheme } from "../context/theme"
import { ToastSurface, type ToastOptions } from "./toast"

test("an asynchronous toast update remains owned and visible", async () => {
  const [current, setCurrent] = createSignal<ToastOptions | null>(null)
  const warning = spyOn(console, "warn").mockImplementation(() => undefined)
  const view = await testRender(
    () => <ToastSurface current={current} theme={resolveTheme(DEFAULT_THEME, "dark")} width={() => 80} />,
    { width: 80, height: 12 },
  )

  try {
    await view.renderOnce()
    expect(view.captureCharFrame()).not.toContain("Creating a session failed")

    setCurrent({
      title: "Session",
      message: "Creating a session failed",
      variant: "error",
      duration: 5000,
    })
    await view.renderOnce()

    const frame = view.captureCharFrame()
    expect(frame).toContain("Session")
    expect(frame).toContain("Creating a session failed")
    expect(warning.mock.calls.flat().join(" ")).not.toContain("computations created outside")
  } finally {
    warning.mockRestore()
    view.renderer.destroy()
  }
})
