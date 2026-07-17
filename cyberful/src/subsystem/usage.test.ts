// ── Session Token Aggregation Tests ─────────────────────────────
// Verifies cumulative token snapshots across sequential and overlapping runtime
// processes without double-counting duplicate or stale observations.
// → cyberful/src/subsystem/usage.ts — owns provider-neutral aggregation.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemUsage } from "./usage"

describe("SubsystemUsage.createSessionCounter", () => {
  test("sums cumulative snapshots across sequential subsystem processes", () => {
    const counter = SubsystemUsage.createSessionCounter()
    const brief = {}
    const exploit = {}

    expect(counter.observe(brief, { generatedTokens: 120 })).toBe(120)
    expect(counter.observe(brief, { generatedTokens: 175 })).toBe(175)
    expect(counter.observe(exploit, { generatedTokens: 40 })).toBe(215)
  })

  test("does not double-count duplicate or stale concurrent snapshots", () => {
    const counter = SubsystemUsage.createSessionCounter()
    const firstRun = {}
    const secondRun = {}

    expect(counter.observe(firstRun, { generatedTokens: 80 })).toBe(80)
    expect(counter.observe(secondRun, { generatedTokens: 50 })).toBe(130)
    expect(counter.observe(firstRun, { generatedTokens: 80 })).toBe(130)
    expect(counter.observe(secondRun, { generatedTokens: 30 })).toBe(130)
    expect(counter.observe(firstRun, { generatedTokens: 125 })).toBe(175)
  })

  test("normalizes invalid provider values at the subsystem boundary", () => {
    const counter = SubsystemUsage.createSessionCounter()
    const run = {}

    expect(counter.observe(run, { generatedTokens: Number.NaN })).toBe(0)
    expect(counter.observe(run, { generatedTokens: -10 })).toBe(0)
    expect(counter.observe(run, { generatedTokens: 12.9 })).toBe(12)
  })

  test("reconciles full usage across distinct root and subagent threads", () => {
    const counter = SubsystemUsage.createSessionCounter()
    const audit = {}

    counter.observe(audit, {
      scopeID: "root",
      generatedTokens: 100,
      inputTokens: 300,
      reasoningTokens: 20,
      cacheReadTokens: 40,
    })
    counter.observe(audit, {
      scopeID: "child",
      generatedTokens: 25,
      inputTokens: 70,
      reasoningTokens: 5,
      cacheReadTokens: 10,
    })
    counter.observe(audit, { scopeID: "root", generatedTokens: 90, inputTokens: 250 })

    expect(counter.usage()).toEqual({
      input: 370,
      output: 125,
      reasoning: 25,
      cache: { read: 50, write: 0 },
    })
  })
})
