// ── TUI Home Route Tests ─────────────────────────────────────────
// Verifies welcome-screen overlay ordering and the semantic colors assigned to
//   primary subsystem and fallback readiness states.
// → cyberful/src/cli/cmd/tui/routes/home.tsx — owns the tested welcome surface.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Show, createSignal } from "solid-js"
import { PROMPT_OVERLAY_Z_INDEX } from "@tui/component/prompt/autocomplete"
import {
  HOME_STATUS_PANEL_BACKGROUND,
  HomePromptSurface,
  HomeWorkareaLayer,
  homePromptCanSubmit,
  homeRuntimePanelWidth,
  homeRuntimeStatusTone,
} from "./home"

test("a launch prompt waits for both workarea and persisted workflow selection", () => {
  expect(homePromptCanSubmit(true, true)).toBe(true)
  expect(homePromptCanSubmit(true, false)).toBe(false)
  expect(homePromptCanSubmit(false, true)).toBe(false)
})

test("runtime indicators use green, yellow, and red semantic tones", () => {
  expect(homeRuntimeStatusTone("available")).toBe("success")
  expect(homeRuntimeStatusTone("checking")).toBe("warning")
  expect(homeRuntimeStatusTone("degraded")).toBe("warning")
  expect(homeRuntimeStatusTone("disabled")).toBe("warning")
  expect(homeRuntimeStatusTone("unavailable")).toBe("error")
})

test("the runtime panel uses a dark translucent surface over the splash", () => {
  expect(HOME_STATUS_PANEL_BACKGROUND.r).toBeLessThan(0.1)
  expect(HOME_STATUS_PANEL_BACKGROUND.g).toBeLessThan(0.1)
  expect(HOME_STATUS_PANEL_BACKGROUND.b).toBeLessThan(0.1)
  expect(HOME_STATUS_PANEL_BACKGROUND.a).toBeGreaterThan(0)
  expect(HOME_STATUS_PANEL_BACKGROUND.a).toBeLessThan(1)
})

test("the runtime panel adds four columns to its longest row", () => {
  expect(
    homeRuntimePanelWidth([
      { title: "Subsystem", identity: "codex · gpt-5.6-sol", status: "available" },
      { title: "Fallback", identity: "deepseek-v4-flash", status: "available" },
    ]),
  ).toBe("Subsystem codex · gpt-5.6-sol on".length + 4)
})

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
