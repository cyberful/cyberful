// ── Provider Usage Footer Tests ─────────────────────────────────
// Verifies locale-aware compact values and the single root/subagent footer.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { compactTokenCount, providerUsageFooter } from "./provider-usage-footer"

describe("provider usage footer", () => {
  test("formats compact Italian root and subagent totals", () => {
    expect(compactTokenCount(2_030, "it-IT")).toBe("2,03K")
    expect(compactTokenCount(1_220_000, "it-IT")).toBe("1,22M")
    expect(compactTokenCount(50_130, "it-IT")).toBe("50,13K")
    expect(
      providerUsageFooter(
        {
          root: { input: 2_030, cacheRead: 1_220_000, cacheWrite: 0, generated: 50_130, reasoning: 1 },
          subagents: {
            input: 2_030,
            cacheRead: 1_220_000,
            cacheWrite: 0,
            generated: 50_130,
            reasoning: 40_000,
          },
          scopes: [],
        },
        "it-IT",
      )?.text,
    ).toBe("R> i:2,03K c:1,22M g:50,13K | S> i:2,03K c:1,22M g:50,13K")
  })
})
