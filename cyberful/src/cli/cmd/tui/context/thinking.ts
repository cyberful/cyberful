// ── Reasoning Display Preferences ────────────────────────────────
// Parses reasoning disclosure headings, bounds collapsed previews, and persists
//   the user's show or hide mode through TUI preferences.
// ─────────────────────────────────────────────────────────────────

import { createMemo } from "solid-js"
import { useKV } from "./kv"

export type ThinkingMode = "show" | "hide"

const MODES: readonly ThinkingMode[] = ["show", "hide"] as const
export const THINKING_PREVIEW_LINES = 8

// ── A Leading Bold Block Is Disclosure Metadata ──────────────────
// Responses reasoning summaries may begin with a bold title followed by a blank
// line and body. That title is presentation metadata rather than body Markdown,
// including while streaming has delivered the complete title but no body yet.
// Splitting it here lets every feed render the same disclosure header without
// modifying or guessing at subsequent reasoning content.
// ─────────────────────────────────────────────────────────────────
export function reasoningSummary(text: string) {
  const content = text.trim()
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/)
  if (!match) return { title: null, body: content }
  return { title: match[1].trim(), body: content.slice(match[0].length).trimEnd() }
}

export function reasoningPreview(text: string, maxLines = THINKING_PREVIEW_LINES) {
  const lines = text.split(/\r?\n/)
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join("\n").trimEnd()
}

export function isThinkingMode(value: unknown): value is ThinkingMode {
  return value === "show" || value === "hide"
}

// Cycle order matches the slash command: show → hide → show.
export function nextThinkingMode(current: ThinkingMode): ThinkingMode {
  const idx = MODES.indexOf(current)
  return MODES[(idx + 1) % MODES.length] ?? "show"
}

export function useThinkingMode() {
  const kv = useKV()
  // ── Legacy Visibility Migrates Before Default Seeding ──────────
  // The provider mounts children only after preferences load, making raw reads
  // stable here. Inspecting the old boolean before `signal` seeds `hide` lets an
  // explicit prior choice survive migration, while first-time users receive the
  // collapsed default. The obsolete `minimal` value also normalizes at this boundary.
  // ─────────────────────────────────────────────────────────────────
  const previousThinkingMode = kv.get("thinking_mode")
  const legacy = kv.get("thinking_visibility")
  const [stored, set] = kv.signal("thinking_mode", "hide")

  if (previousThinkingMode === undefined) {
    if (legacy === true) set("show")
    else if (legacy === false) set("hide")
  }

  if (previousThinkingMode === "minimal") set("hide")

  const mode = createMemo<ThinkingMode>(() => {
    const value = stored()
    return isThinkingMode(value) ? value : "hide"
  })

  return {
    mode,
    set,
  }
}
