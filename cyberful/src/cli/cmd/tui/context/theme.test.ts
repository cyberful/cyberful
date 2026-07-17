// ── Built-In Theme Contrast Tests ────────────────────────────────
// Verifies that Cyberful's resolved light palette remains complete and readable
//   across ordinary text, semantic states, selections, borders, and diff rows.
// → cyberful/src/cli/cmd/tui/context/theme/cyberful.json — defines the palette.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import type { RGBA } from "@opentui/core"
import { DEFAULT_THEME, resolveTheme, resolveToolOutputTheme } from "./theme"

function luminance(color: RGBA) {
  const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

function contrast(foreground: RGBA, background: RGBA) {
  const brighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (brighter + 0.05) / (darker + 0.05)
}

test("Cyberful light text and semantic colors remain readable on the main surface", () => {
  const theme = resolveTheme(DEFAULT_THEME, "light")
  const readable = [
    theme.primary,
    theme.secondary,
    theme.accent,
    theme.error,
    theme.warning,
    theme.success,
    theme.info,
    theme.text,
    theme.textMuted,
    theme.markdownText,
    theme.markdownHeading,
    theme.markdownLink,
    theme.markdownCode,
    theme.syntaxComment,
    theme.syntaxKeyword,
    theme.syntaxFunction,
    theme.syntaxVariable,
    theme.syntaxString,
    theme.syntaxNumber,
    theme.syntaxType,
    theme.syntaxOperator,
    theme.syntaxPunctuation,
  ]

  for (const color of readable) {
    expect(contrast(color, theme.background)).toBeGreaterThanOrEqual(4.5)
  }
})

test("Cyberful light selections, borders, and diff rows retain their contrast", () => {
  const theme = resolveTheme(DEFAULT_THEME, "light")

  expect(contrast(theme.selectedListItemText, theme.primary)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(theme.border, theme.background)).toBeGreaterThanOrEqual(3)
  expect(contrast(theme.borderActive, theme.background)).toBeGreaterThanOrEqual(3)
  expect(contrast(theme.diffAdded, theme.diffAddedBg)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(theme.diffRemoved, theme.diffRemovedBg)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(theme.diffContext, theme.diffContextBg)).toBeGreaterThanOrEqual(4.5)
})

test("Cyberful resolves light surfaces independently from the dark palette", () => {
  const light = resolveTheme(DEFAULT_THEME, "light")
  const dark = resolveTheme(DEFAULT_THEME, "dark")

  expect(luminance(light.background)).toBeGreaterThan(luminance(light.backgroundPanel))
  expect(luminance(light.backgroundPanel)).toBeGreaterThan(luminance(light.backgroundElement))
  expect(luminance(light.backgroundMenu)).toBeGreaterThan(0.8)
  expect(luminance(light.background)).toBeGreaterThan(luminance(dark.background))
  expect(luminance(light.text)).toBeLessThan(luminance(dark.text))
})

test("tool output syntax follows light mode instead of retaining dark-only colors", () => {
  const theme = resolveToolOutputTheme("light")

  expect(contrast(theme.text, theme.background)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(theme.textMuted, theme.background)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(theme.syntaxVariable, theme.background)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(theme.syntaxString, theme.background)).toBeGreaterThanOrEqual(4.5)
  expect(contrast(theme.syntaxKeyword, theme.background)).toBeGreaterThanOrEqual(4.5)
})
