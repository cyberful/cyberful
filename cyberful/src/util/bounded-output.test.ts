// ── Bounded Process Output Tests ─────────────────────────────────
// Verifies bounded prefix and tail retention, including truncation across
// multiple chunks while streams continue draining discarded process output.
// → cyberful/src/util/bounded-output.ts — owns the retention primitive under test.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { BoundedByteTail, readBoundedPrefix } from "./bounded-output"

test("bounded prefix drains the stream and retains only its first bytes", async () => {
  let drained = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("abcd"))
      controller.enqueue(new TextEncoder().encode("efgh"))
      drained = true
      controller.close()
    },
  })

  expect(await readBoundedPrefix(stream, 6)).toEqual({ text: "abcdef", truncated: true })
  expect(drained).toBe(true)
})

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
