// ── Command Palette Visibility Tests ─────────────────────────────
// Protects the deliberate split between slash-only commands and the smaller
//   Ctrl-P surface after removing low-value terminal preference actions.
// → cyberful/src/cli/cmd/tui/component/command-palette.tsx — owns the filter.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { isCommandPaletteExcluded } from "./command-palette"

test("keeps slash-only and low-value preference commands out of Ctrl-P", () => {
  const excluded = [
    "agent.list",
    "cyberful.status",
    "terminal.title.toggle",
    "app.toggle.diffwrap",
    "app.toggle.session_directory_filter",
    "diff.open",
  ]

  for (const name of excluded) {
    expect(isCommandPaletteExcluded(name)).toBeTrue()
  }
})

test("retains ordinary commands and the fixed theme mode toggle in Ctrl-P", () => {
  expect(isCommandPaletteExcluded("session.new")).toBeFalse()
  expect(isCommandPaletteExcluded("theme.switch_mode")).toBeFalse()
  expect(isCommandPaletteExcluded("app.toggle.animations")).toBeFalse()
})
