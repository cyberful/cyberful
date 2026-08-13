// ── Live Phase Header State Tests ─────────────────────────
// Verifies phase timing recovery, phase changes, activity labels, and cleanup
//   for the live composer header.
// → cyberful/src/cli/cmd/tui/context/running-phase.ts — owns the tested fold.
// ────────────────────────────────

import { describe, expect, test } from "bun:test"
import { foldRunningPhase } from "./running-phase"

describe("live phase header state", () => {
  test("uses the authoritative start timestamp and preserves it across activity", () => {
    const started = foldRunningPhase(undefined, { phase: "recon", kind: "start", timestamp: 1_000 })
    const progressed = foldRunningPhase(started, { phase: "recon", kind: "progress", timestamp: 2_000 })
    const tool = foldRunningPhase(progressed, { phase: "recon", kind: "tool", timestamp: 3_000 })

    expect(tool).toEqual({ phase: "recon", lastKind: "tool", startedAt: 1_000 })
  })

  test("recovers a missed start from the first visible frame", () => {
    expect(foldRunningPhase(undefined, { phase: "exploit", kind: "text", timestamp: 4_000 })).toEqual({
      phase: "exploit",
      lastKind: "text",
      startedAt: 4_000,
    })
  })

  test("resets timing on an observed phase change and clears on end", () => {
    const recon = { phase: "recon", lastKind: "tool", startedAt: 1_000 }
    const exploit = foldRunningPhase(recon, { phase: "exploit", kind: "status", timestamp: 8_000 })

    expect(exploit).toEqual({ phase: "exploit", startedAt: 8_000 })
    expect(foldRunningPhase(exploit, { phase: "exploit", kind: "end", timestamp: 9_000 })).toBeUndefined()
  })
})
