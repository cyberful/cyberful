// ── TUI Home Route Layering Tests ────────────────────────────────
// Reproduces the welcome screen's delayed workarea restore with the persistent
//   Solid markers that previously let it repaint prompt autocomplete rows.
// → cyberful/src/cli/cmd/tui/routes/home.tsx — keeps both layers mounted in paint order.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Show, createSignal } from "solid-js"
import { PROMPT_OVERLAY_Z_INDEX } from "@tui/component/prompt/autocomplete"
import { HomePromptSurface, HomeWorkareaLayer } from "./home"

test("a workarea loaded after mount stays below slash suggestions", async () => {
  const [workareaReady, setWorkareaReady] = createSignal(false)
  const [trailingFeatureReady] = createSignal(false)
  const view = await testRender(
    () => (
      <box width={30} height={6} flexDirection="column">
        <HomeWorkareaLayer visible={workareaReady()} borderColor="#888888" backgroundColor="#444444">
          <Show when={workareaReady()}>
            <text>Workarea obscures menu rows</text>
          </Show>
        </HomeWorkareaLayer>
        <HomePromptSurface onMouseDown={() => {}}>
          <box height={1} />
          <box
            position="absolute"
            top={-3}
            left={0}
            width={30}
            height={3}
            zIndex={PROMPT_OVERLAY_Z_INDEX}
            backgroundColor="#222222"
          >
            <text>{"/new      New session\n/sessions Switch session\n/workflows Switch workflow"}</text>
          </box>
        </HomePromptSurface>
        <Show when={trailingFeatureReady()}>
          <box />
        </Show>
      </box>
    ),
    { width: 30, height: 6 },
  )

  try {
    await view.renderOnce()
    setWorkareaReady(true)
    await view.renderOnce()
    const frame = view.captureCharFrame()
    expect(frame).toContain("/new      New session")
    expect(frame).toContain("/sessions Switch session")
    expect(frame).toContain("/workflows Switch workflow")
    expect(frame).not.toContain("Workarea obscures")
  } finally {
    view.renderer.destroy()
  }
})
