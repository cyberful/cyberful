// ── Tool Activity Labels ─────────────────────────────────────────
// Re-exports shared tool summaries and renders a theme-aware multicolor
//   cyberful-os label while preserving bounded labels for every other tool.
// ─────────────────────────────────────────────────────────────────

import { CYBERFUL_OS_TOOL_ID, toolDisplayText } from "@/cli/cmd/tool-display"
import { useTheme } from "@tui/context/theme"

export {
  SHELL_TOOL_ICON,
  toolDisplayDetails,
  toolDisplaySummary,
  toolDisplayText,
  toolInputRecord,
} from "@/cli/cmd/tool-display"

export function ToolDisplayLabel(props: { name: string; input?: string; prefix?: string }) {
  const { theme } = useTheme()
  if (props.name !== CYBERFUL_OS_TOOL_ID) {
    return (
      <>
        {props.prefix}
        {toolDisplayText(props.name, props.input)}
      </>
    )
  }

  const colors = [theme.error, theme.warning, theme.accent, theme.success, theme.primary]

  return (
    <>
      {props.prefix}
      <span style={{ fg: colors[0] }}>C</span>
      <span style={{ fg: colors[1] }}>y</span>
      <span style={{ fg: colors[2] }}>b</span>
      <span style={{ fg: colors[3] }}>e</span>
      <span style={{ fg: colors[4] }}>r</span>
      OS{props.input ? ` ${props.input}` : ""}
    </>
  )
}
