// ── Composer Status Header ─────────────────────────────────
// Renders the fixed shoulder above the session composer and derives compact
//   home, idle, generic-work, and live-phase status copy.
// → cyberful/src/cli/cmd/tui/component/prompt/index.tsx — supplies live session state and theme colors.
// → cyberful/src/cli/cmd/tui/context/running-phase.ts — owns active phase timing.
// @docs/user-guide/interface.md
// ────────────────────────────────

import type { RGBA } from "@opentui/core"
import { Show } from "solid-js"
import "opentui-spinner/solid"
import type { SessionStatus } from "@/server/client"
import { Locale } from "@/util/locale"
import type { RunningPhase } from "@tui/context/running-phase"
import { BOUNCING_BAR_FRAMES, BOUNCING_BAR_INTERVAL, bouncingBarColors } from "@tui/ui/spinner"

export type ComposerStatusView = {
  kind: "label" | "idle" | "working"
  text: string
}

export function compactActivityDuration(durationMs: number) {
  const total = Math.max(0, Math.floor(durationMs / 1_000))
  const seconds = (total % 60).toString().padStart(2, "0")
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}:${seconds}`
  return `${Math.floor(minutes / 60)}:${(minutes % 60).toString().padStart(2, "0")}:${seconds}`
}

export function composerStatusView(input: {
  label?: string
  sessionID?: string
  status: SessionStatus
  runningPhase?: RunningPhase
  now: number
}): ComposerStatusView {
  if (!input.sessionID) return { kind: "label", text: input.label ?? "Prompt" }
  if (input.runningPhase) {
    const activity = input.runningPhase.lastKind === "tool" ? "executing job" : "generating"
    const phase = Locale.titlecase(input.runningPhase.phase.replace(/^pentest-/, "").replaceAll("-", " "))
    const elapsed = compactActivityDuration(input.now - input.runningPhase.startedAt)
    return { kind: "working", text: `Working · ${elapsed} · ${phase} · ${activity}` }
  }
  if (input.status.type === "busy")
    return { kind: "working", text: input.status.message ? `Working · ${input.status.message}` : "Working" }
  return { kind: "idle", text: "○ Ready" }
}

export function ComposerStatusHeader(props: {
  status: ComposerStatusView
  borderColor: RGBA
  textColor: RGBA
  mutedColor: RGBA
  animationsEnabled: boolean
}) {
  return (
    <box width="100%" height={1} flexDirection="row" flexShrink={0} overflow="hidden">
      <text width={3} flexShrink={0} fg={props.borderColor} wrapMode="none" selectable={false}>
        {"┏━ "}
      </text>
      <Show when={props.status.kind === "working"}>
        <Show
          when={props.animationsEnabled}
          fallback={
            <text width={7} flexShrink={0} fg={props.borderColor} wrapMode="none" selectable={false}>
              {"[ == ] "}
            </text>
          }
        >
          <box width={7} flexShrink={0} flexDirection="row">
            <spinner
              frames={BOUNCING_BAR_FRAMES}
              interval={BOUNCING_BAR_INTERVAL}
              color={bouncingBarColors(props.mutedColor, props.borderColor)}
            />
            <text wrapMode="none" selectable={false}>
              {" "}
            </text>
          </box>
        </Show>
      </Show>
      <box height={1} flexGrow={1} minWidth={0} overflow="hidden">
        <text fg={props.status.kind === "idle" ? props.mutedColor : props.textColor} wrapMode="none" selectable={false}>
          <Show when={props.status.kind === "working"} fallback={props.status.text}>
            <span style={{ fg: props.textColor }}>Working</span>
            <span style={{ fg: props.mutedColor }}>{props.status.text.slice("Working".length)}</span>
          </Show>
        </text>
      </box>
    </box>
  )
}
