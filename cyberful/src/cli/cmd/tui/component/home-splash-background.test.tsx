// ── Home Splash Animation Tests ────────────────────────────────
// Verifies that the splash animation flag controls OpenTUI live rendering
//   instead of merely freezing the painter while frames keep being scheduled.
// → cyberful/src/cli/cmd/tui/component/home-splash-background.tsx — owns the renderable.
// ──────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { HomeSplashBackgroundLayer, HomeSplashBackgroundRenderable } from "./home-splash-background"

test("disabled animations remove the splash layer", async () => {
  const [enabled, setEnabled] = createSignal(false)
  const view = await testRender(() => <HomeSplashBackgroundLayer enabled={enabled()} />, { width: 20, height: 8 })

  try {
    await view.renderOnce()
    expect(view.renderer.root.findDescendantById("home-splash")).toBeUndefined()

    setEnabled(true)
    await view.renderOnce()
    expect(view.renderer.root.findDescendantById("home-splash")).toBeInstanceOf(HomeSplashBackgroundRenderable)

    setEnabled(false)
    await view.renderOnce()
    expect(view.renderer.root.findDescendantById("home-splash")).toBeUndefined()
  } finally {
    view.renderer.destroy()
  }
})

test("disabled splash does not keep the renderer live", async () => {
  const view = await testRender(
    () => <cyberful_home_splash_background id="splash" width="100%" height="100%" animated={false} />,
    { width: 20, height: 8 },
  )

  try {
    await view.renderOnce()
    const splash = view.renderer.root.findDescendantById("splash")
    expect(splash).toBeInstanceOf(HomeSplashBackgroundRenderable)
    if (!(splash instanceof HomeSplashBackgroundRenderable)) throw new Error("splash renderable missing")

    expect(splash.live).toBe(false)
    expect(splash.liveCount).toBe(0)

    splash.animated = true
    expect(splash.live).toBe(true)
    expect(splash.liveCount).toBe(1)

    splash.animated = false
    expect(splash.live).toBe(false)
    expect(splash.liveCount).toBe(0)
  } finally {
    view.renderer.destroy()
  }
})
