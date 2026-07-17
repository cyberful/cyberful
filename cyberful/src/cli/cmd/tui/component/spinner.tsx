// ── Configurable Activity Spinner ────────────────────────────────
// Renders animated activity using the active theme or a quiet static fallback
//   when terminal animations are disabled in persistent preferences.
// ─────────────────────────────────────────────────────────────────

import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useAnimationsEnabled } from "../context/animation"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import "opentui-spinner/solid"

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner(props: { children?: JSX.Element; color?: RGBA }) {
  const { theme } = useTheme()
  const animationsEnabled = useAnimationsEnabled()
  const color = () => props.color ?? theme.textMuted
  return (
    <Show when={animationsEnabled()} fallback={<text fg={color()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
