// ── Bounded Process Output Tail Tests ────────────────────────────
// Verifies that routine process output stays intact while overflow retains only
// the final byte window and reports exactly how much content was discarded.
// → cyberful/src/util/bounded-output.ts — owns the retention primitive under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { BoundedByteTail } from "./bounded-output"

describe("bounded process output tail", () => {
  test("keeps routine output unchanged", () => {
    const output = new BoundedByteTail(16)
    output.append("hello")
    output.append(" world")

    expect(output.text()).toBe("hello world")
    expect(output.truncated).toBe(false)
    expect(output.droppedBytes).toBe(0)
  })

  test("retains the final bytes across incremental overflow", () => {
    const output = new BoundedByteTail(8)
    output.append("abcd")
    output.append("efgh")
    output.append("ijkl")

    expect(output.text()).toBe("efghijkl")
    expect(output.truncated).toBe(true)
    expect(output.droppedBytes).toBe(4)
  })

  test("copies only the bounded tail of one oversized chunk", () => {
    const output = new BoundedByteTail(5)
    output.append("old")
    output.append("0123456789")

    expect(output.text()).toBe("56789")
    expect(output.droppedBytes).toBe(8)
  })
})
