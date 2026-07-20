// ── Focused Input Clear Control ──────────────────────────────────
// Renders the shared white action that empties a focused TUI editor.
// → cyberful/src/cli/cmd/tui/routes/home.tsx — clears the workarea field.
// → cyberful/src/cli/cmd/tui/component/prompt/index.tsx — clears the composer.
// ─────────────────────────────────────────────────────────────────

import { Show } from "solid-js"

export function ClearInput(props: { id?: string; visible: boolean; onClear: () => void }) {
  return (
    <Show when={props.visible}>
      <box id={props.id} flexShrink={0} onMouseUp={props.onClear}>
        <text fg="#FFFFFF" selectable={false}>
          ×
        </text>
      </box>
    </Show>
  )
}
