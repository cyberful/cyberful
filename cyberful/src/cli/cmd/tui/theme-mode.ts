// ── Terminal Theme Mode Detection ────────────────────────────────
// Chooses light or dark appearance from an explicit renderer report or the
//   measured terminal background, with a stable fallback for unknown palettes.
// → cyberful/src/cli/cmd/tui/app.tsx — seeds the full-screen TUI theme.
// → cyberful/src/cli/cmd/run/theme.ts — resolves direct-mode fallback colors.
// ─────────────────────────────────────────────────────────────────

import { RGBA, type TerminalColors } from "@opentui/core"

export type ThemeMode = "dark" | "light"

// ── Explicit Terminal Intent Wins Over Palette Inference ─────────
// Some terminals report their appearance directly, while others expose only a
// default background through palette queries. The explicit event is authoritative
// because a user may intentionally pair a light declaration with a customized
// background. Palette luminance fills only the missing-event path, and malformed
// or absent colors retain dark as the backward-compatible startup default.
// ─────────────────────────────────────────────────────────────────
export function detectThemeMode(
  reported: unknown,
  colors?: Pick<TerminalColors, "defaultBackground" | "palette">,
): ThemeMode {
  if (reported === "dark" || reported === "light") return reported

  const background = colors?.defaultBackground ?? colors?.palette[0]
  if (!background) return "dark"

  try {
    const { r, g, b } = RGBA.fromHex(background)
    return 0.299 * r + 0.587 * g + 0.114 * b > 0.5 ? "light" : "dark"
  } catch {
    return "dark"
  }
}
