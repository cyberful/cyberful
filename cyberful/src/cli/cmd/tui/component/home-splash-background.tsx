// ── Home Splash Renderable ───────────────────────────────────────
// Adapts the splash painter to an OpenTUI framebuffer, schedules bounded frame
//   updates, follows the active theme, and stops requesting renders when the
//   component is destroyed.
// → cyberful/src/cli/cmd/tui/context/theme.tsx — supplies the active palette.
// ─────────────────────────────────────────────────────────────────

import {
  FrameBufferRenderable,
  RGBA,
  type OptimizedBuffer,
  type RenderContext,
  type RenderableOptions,
} from "@opentui/core"
import { extend } from "@opentui/solid"
import { Show } from "solid-js"
import { HomeSplashBackgroundPainter } from "./home-splash-background-render"
import { useAnimationsEnabled } from "../context/animation"
import { useTheme } from "../context/theme"

const SPLASH_FRAME_MS = 1000 / 12

type HomeSplashBackgroundOptions = RenderableOptions<FrameBufferRenderable> & {
  base?: RGBA
  primary?: RGBA
  accent?: RGBA
  animated?: boolean
}

export class HomeSplashBackgroundRenderable extends FrameBufferRenderable {
  private painter = new HomeSplashBackgroundPainter()
  private pendingDelta = 0
  private painted = false
  private animatedValue = true

  constructor(ctx: RenderContext, options: HomeSplashBackgroundOptions = {}) {
    const width = typeof options.width === "number" ? options.width : 1
    const height = typeof options.height === "number" ? options.height : 1
    const animated = options.animated ?? true
    super(ctx, {
      ...options,
      width,
      height,
      live: animated,
      respectAlpha: false,
    })

    this.animatedValue = animated
    if (options.width !== undefined && typeof options.width !== "number") this.width = options.width
    if (options.height !== undefined && typeof options.height !== "number") this.height = options.height
    this.painter.setBase(options.base)
    this.painter.setPrimary(options.primary)
    this.painter.setAccent(options.accent)
  }

  set base(value: RGBA | undefined) {
    if (!this.painter.setBase(value)) return
    this.painted = false
    this.requestRender()
  }

  set primary(value: RGBA | undefined) {
    if (!this.painter.setPrimary(value)) return
    this.painted = false
    this.requestRender()
  }

  set accent(value: RGBA | undefined) {
    if (!this.painter.setAccent(value)) return
    this.painted = false
    this.requestRender()
  }

  set animated(value: boolean) {
    if (this.animatedValue === value) return
    this.animatedValue = value
    this.pendingDelta = 0
    this.live = value
    this.requestRender()
  }

  protected override renderSelf(buffer: OptimizedBuffer, deltaTime = 0): void {
    if (!this.visible || this.isDestroyed) return

    if (this.animatedValue) this.pendingDelta += deltaTime
    if (!this.painted || (this.animatedValue && this.pendingDelta >= SPLASH_FRAME_MS)) {
      this.painter.render(this.frameBuffer, { deltaTime: this.animatedValue ? this.pendingDelta : 0 })
      this.pendingDelta = 0
      this.painted = true
    }
    super.renderSelf(buffer)
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    cyberful_home_splash_background: typeof HomeSplashBackgroundRenderable
  }
}

extend({ cyberful_home_splash_background: HomeSplashBackgroundRenderable })

export function HomeSplashBackgroundLayer(props: { enabled: boolean; base?: RGBA; primary?: RGBA; accent?: RGBA }) {
  return (
    <Show when={props.enabled}>
      <cyberful_home_splash_background
        id="home-splash"
        width="100%"
        height="100%"
        base={props.base}
        primary={props.primary}
        accent={props.accent}
        animated
      />
    </Show>
  )
}

export function HomeSplashBackground() {
  const animationsEnabled = useAnimationsEnabled()
  const { theme } = useTheme()
  return (
    <HomeSplashBackgroundLayer
      enabled={animationsEnabled()}
      base={theme.background}
      primary={theme.primary}
      accent={theme.accent}
    />
  )
}
