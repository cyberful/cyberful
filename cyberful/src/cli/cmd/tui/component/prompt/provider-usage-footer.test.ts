// ── Provider Usage Footer Tests ─────────────────────────────────
// Verifies locale-aware compact values and the single root/subagent footer.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { compactTokenCount, providerUsageFooter } from "./provider-usage-footer"

describe("provider usage footer", () => {
  test("formats compact Italian root and subagent totals", () => {
    expect(compactTokenCount(2_030, "it-IT")).toBe("2,03K")
    expect(compactTokenCount(1_220_000, "it-IT")).toBe("1,22M")
    expect(compactTokenCount(50_130, "it-IT")).toBe("50,1K")
    expect(
      providerUsageFooter(
        {
          root: { input: 589_750, cacheRead: 8_190_000, cacheWrite: 0, generated: 54_710, reasoning: 1 },
          subagents: {
            input: 1_860_000,
            cacheRead: 44_380_000,
            cacheWrite: 0,
            generated: 133_770,
            reasoning: 40_000,
          },
          scopes: [],
        },
        "it-IT",
      )?.text,
    ).toBe("R 590K/8,19M/54,7K · S 1,86M/44,4M/134K")
  })
})
