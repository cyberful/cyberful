// ── Status Animation Tests ───────────────────────────────────────
// Protects fixed-width motion and independent bracket coloring so routine busy
//   indicators never shift adjacent status text or lose theme contrast.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { BOUNCING_BAR_FRAMES, BOUNCING_BAR_INTERVAL, bouncingBarColors } from "./spinner"

describe("bouncingBar", () => {
  test("uses the fixed-width Rich frame sequence and timing", () => {
    expect(BOUNCING_BAR_INTERVAL).toBe(80)
    expect(BOUNCING_BAR_FRAMES).toEqual([
      "[    ]",
      "[=   ]",
      "[==  ]",
      "[=== ]",
      "[====]",
      "[ ===]",
      "[  ==]",
      "[   =]",
      "[    ]",
      "[   =]",
      "[  ==]",
      "[ ===]",
      "[====]",
      "[=== ]",
      "[==  ]",
      "[=   ]",
    ])
    expect(BOUNCING_BAR_FRAMES.every((frame) => frame.length === 6)).toBe(true)
  })

  test("styles brackets separately from the moving equals", () => {
    const bracket = RGBA.fromHex("#555555")
    const bar = RGBA.fromHex("#ffffff")
    const color = bouncingBarColors(bracket, bar)

    expect(color(0, 0, 16, 6)).toBe(bracket)
    expect(color(0, 1, 16, 6)).toBe(bar)
    expect(color(0, 5, 16, 6)).toBe(bracket)
  })
})
