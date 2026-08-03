// ── Assistant Timestamp Tests ────────────────────────────────────────────
// Verifies stable persistence, splitting, and display of assistant time lines.
// → cyberful/src/session/assistant-timestamp.ts — implements the tested text contract.
// ──────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import {
  assistantDisplayTimeLine,
  assistantTimeLine,
  formatAssistantTimestamp,
  splitAssistantTimeLine,
} from "./assistant-timestamp"

describe("assistant timestamp", () => {
  test("formats assistant timestamps as persisted Time lines", () => {
    expect(formatAssistantTimestamp(1_800_000_000_000)).toBe("2027-01-15T08:00:00.000Z")
    expect(assistantTimeLine(1_800_000_000_000)).toBe("Time: 2027-01-15T08:00:00.000Z")
  })

  test("splits persisted Time lines for UI display", () => {
    const split = splitAssistantTimeLine("answer\n\nTime: 2027-01-15T08:00:00.000Z")

    expect(split.text).toBe("answer")
    expect(split.timestamp).toBe("2027-01-15T08:00:00.000Z")
    if (!split.timestamp) throw new Error("expected a persisted assistant timestamp")
    expect(assistantDisplayTimeLine(split.timestamp)).toBe("\uF43A 2027-01-15T08:00:00.000Z")
  })
})
