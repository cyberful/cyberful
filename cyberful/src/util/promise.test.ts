// ── Terminal Promise Observation Tests ──────────────────────────
// Proves synchronous event callbacks can observe successful and failed short
//   tasks, including settlement, without producing routine test output.
// → cyberful/src/util/promise.ts — implements the observation boundary.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { observePromise } from "./promise"

describe("terminal promise observation", () => {
  test("delivers a successful event task and reports settlement once", async () => {
    const settled = Promise.withResolvers<void>()
    const values: number[] = []
    let settlements = 0

    observePromise(Promise.resolve(7), {
      fulfilled: (value) => values.push(value),
      rejected: () => {
        throw new Error("successful task was reported as failed")
      },
      settled: () => {
        settlements++
        settled.resolve()
      },
    })

    await settled.promise
    expect(values).toEqual([7])
    expect(settlements).toBe(1)
  })

  test("delivers a failed event task and reports settlement once", async () => {
    const settled = Promise.withResolvers<void>()
    const failure = new Error("clipboard unavailable")
    const failures: unknown[] = []
    let settlements = 0

    observePromise(Promise.reject(failure), {
      rejected: (error) => failures.push(error),
      settled: () => {
        settlements++
        settled.resolve()
      },
    })

    await settled.promise
    expect(failures).toEqual([failure])
    expect(settlements).toBe(1)
  })
})
