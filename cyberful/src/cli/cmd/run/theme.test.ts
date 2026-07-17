// ── Direct-Mode Theme Fallback Tests ─────────────────────────────
// Ensures direct mode preserves a reported light appearance when terminal
//   palette detection is empty or fails before interactive rendering starts.
// → cyberful/src/cli/cmd/run/theme.ts — owns direct-mode palette resolution.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import type { CliRenderer, TerminalColors } from "@opentui/core"
import { RUN_THEME_FALLBACK, RUN_THEME_FALLBACK_LIGHT, resolveRunTheme } from "./theme"

function emptyColors(): TerminalColors {
  return {
    palette: [],
    defaultForeground: null,
    defaultBackground: null,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("uses the light fallback when a light terminal has no background color", async () => {
  const renderer = {
    themeMode: "light" as const,
    getPalette: async () => emptyColors(),
  } satisfies Pick<CliRenderer, "getPalette" | "themeMode">

  expect(await resolveRunTheme(renderer)).toBe(RUN_THEME_FALLBACK_LIGHT)
})

test("keeps mode-specific fallbacks when palette detection fails", async () => {
  const light = {
    themeMode: "light" as const,
    getPalette: async () => Promise.reject(new Error("palette unavailable")),
  } satisfies Pick<CliRenderer, "getPalette" | "themeMode">
  const dark = {
    themeMode: "dark" as const,
    getPalette: async () => Promise.reject(new Error("palette unavailable")),
  } satisfies Pick<CliRenderer, "getPalette" | "themeMode">

  expect(await resolveRunTheme(light)).toBe(RUN_THEME_FALLBACK_LIGHT)
  expect(await resolveRunTheme(dark)).toBe(RUN_THEME_FALLBACK)
})
