// ── TUI Frame Batcher Tests ──────────────────────────────────────
// Verifies burst coalescing and source order independently from Solid rendering.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { FrameBatcher } from "./frame-batcher"

describe("TUI frame batching", () => {
  test("one hundred same-session events commit once and retain exact order", () => {
    const scheduled: Array<() => void> = []
    const commits: Array<{ key: string; values: readonly number[] }> = []
    const batcher = new FrameBatcher<string, number>(
      16,
      (key, values) => commits.push({ key, values }),
      {
        schedule: (callback) => {
          scheduled.push(callback)
          return callback
        },
        cancel: () => {},
      },
    )

    for (let index = 0; index < 100; index++) batcher.add("session-1", index)
    expect(scheduled).toHaveLength(1)
    scheduled[0]!()
    expect(commits).toEqual([{ key: "session-1", values: Array.from({ length: 100 }, (_, index) => index) }])
  })

  test("different sessions receive independent frame commits", () => {
    const scheduled: Array<() => void> = []
    const keys: string[] = []
    const batcher = new FrameBatcher<string, string>(
      16,
      (key) => keys.push(key),
      {
        schedule: (callback) => {
          scheduled.push(callback)
          return callback
        },
        cancel: () => {},
      },
    )
    batcher.add("a", "one")
    batcher.add("b", "two")
    scheduled.forEach((callback) => callback())
    expect(keys).toEqual(["a", "b"])
  })
})
