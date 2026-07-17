// ── Generation Progress Experience Tests ────────────────────────
// Protects the status strings users see while a phase is generating, including
// delayed usage, padding, rate display, and styling segments.
// → cyberful/src/dependency/generation-progress.ts — owns the formatting contract.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { GenerationProgress } from "./generation-progress"

describe("GenerationProgress", () => {
  test("omits the counter when a provider has not reported usage yet", () => {
    expect(GenerationProgress.formatStatus(undefined, 24_000)).toBe("generating...")
  })

  test("pads the generated token count to the output token width", () => {
    expect(GenerationProgress.formatStatus(0, 24_000)).toBe("generating... 00000")
    expect(GenerationProgress.formatStatus(1, 24_000)).toBe("generating... 00001")
    expect(GenerationProgress.formatStatus(123, 24_000)).toBe("generating... 00123")
  })

  test("uses configured max output token digits", () => {
    expect(GenerationProgress.formatStatus(1, 4_096)).toBe("generating... 0001")
  })

  test("formats token rate", () => {
    expect(GenerationProgress.formatStatusWithRate(979, 33, 24_000)).toBe("generating... 00979 · 33 t/s")
  })

  test("parses leading zeros for display styling", () => {
    expect(GenerationProgress.parseStatus("generating... 00979 · 33 t/s")).toEqual({
      leadingZeros: "00",
      tokenDigits: "979",
    })
  })
})
