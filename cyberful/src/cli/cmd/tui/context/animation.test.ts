// ── Global TUI Animation Policy Tests ───────────────────────────
// Protects the static startup boundary and the persisted enabled and disabled
//   states shared by splash, spinner, fade, and cycling-copy components.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { animationPreferenceEnabled } from "./animation"

describe("global TUI animation policy", () => {
  test("stays static until preferences load", () => {
    expect(animationPreferenceEnabled(false, true)).toBeFalse()
    expect(animationPreferenceEnabled(false, false)).toBeFalse()
  })

  test("follows the persisted preference after loading", () => {
    expect(animationPreferenceEnabled(true, true)).toBeTrue()
    expect(animationPreferenceEnabled(true, false)).toBeFalse()
  })
})
