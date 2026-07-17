// ── Terminal Theme Mode Detection Tests ──────────────────────────
// Protects explicit mode precedence, palette inference, and the stable default
//   used when a terminal cannot report appearance or background colors.
// → cyberful/src/cli/cmd/tui/theme-mode.ts — owns the detection policy.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import type { TerminalColors } from "@opentui/core"
import { detectThemeMode } from "./theme-mode"

function colors(background: string | null): TerminalColors {
  return {
    palette: [],
    defaultForeground: null,
    defaultBackground: background,
    cursorColor: null,
    mouseForeground: null,
    mouseBackground: null,
    tekForeground: null,
    tekBackground: null,
    highlightBackground: null,
    highlightForeground: null,
  }
}

test("uses the reported terminal appearance before background inference", () => {
  expect(detectThemeMode("dark", colors("#ffffff"))).toBe("dark")
  expect(detectThemeMode("light", colors("#000000"))).toBe("light")
})

test("infers light and dark modes when the terminal emits no appearance event", () => {
  expect(detectThemeMode(undefined, colors("#ffffff"))).toBe("light")
  expect(detectThemeMode(null, colors("#101418"))).toBe("dark")
  expect(detectThemeMode(undefined, { ...colors(null), palette: ["#f6f8fa"] })).toBe("light")
})

test("keeps the backward-compatible dark default without a usable palette", () => {
  expect(detectThemeMode(undefined)).toBe("dark")
  expect(detectThemeMode(undefined, colors(null))).toBe("dark")
})
