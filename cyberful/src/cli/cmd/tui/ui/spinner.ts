// ── Fixed-Width Status Animation ─────────────────────────────────
// Defines a six-cell bouncing bar and separate track and bar colors so animated
//   status never shifts neighboring terminal text.
// ─────────────────────────────────────────────────────────────────

import type { ColorInput } from "@opentui/core"
import type { ColorGenerator } from "opentui-spinner"
export const BOUNCING_BAR_INTERVAL = 80
export const BOUNCING_BAR_FRAMES = [
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
]

export function bouncingBarColors(bracket: ColorInput, bar: ColorInput): ColorGenerator {
  return (_frameIndex, charIndex, _totalFrames, totalChars) =>
    charIndex === 0 || charIndex === totalChars - 1 ? bracket : bar
}
