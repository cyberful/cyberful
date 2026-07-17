// ── Human Duration Experience Tests ──────────────────────────────
// Protects compact elapsed-time labels users see across millisecond, minute,
// hour, and multi-day boundaries.
// → cyberful/src/util/locale.ts — implements the formatting contract under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { duration } from "./locale"

describe("human-readable duration", () => {
  test("preserves the remaining hours after complete days", () => {
    expect(duration(90_061_000)).toBe("1d 1h")
  })

  test("uses the most useful adjacent units during normal activity", () => {
    expect(duration(61_000)).toBe("1m 1s")
    expect(duration(3_660_000)).toBe("1h 1m")
  })
})
