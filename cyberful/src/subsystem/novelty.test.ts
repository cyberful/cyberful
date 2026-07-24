// ── Adaptive Bug Bounty Novelty Contract Tests ─────────────────
// Verifies the contract enables a qualitative contrarian pass without reviving
//   numeric quotas, phase percentages, or administrative handoff thresholds.
// → cyberful/src/subsystem/novelty.ts — owns contract resolution.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemNovelty } from "./novelty"

describe("bug bounty novelty contract", () => {
  test("enables the qualitative contract", () => {
    expect(SubsystemNovelty.resolve({ $novelty: { hacker: { required: true } } }, "hacker")).toEqual({
      contract: { required: true },
    })
    expect(SubsystemNovelty.resolve({ $novelty: { recon: true } }, "recon")).toEqual({
      contract: { required: true },
    })
  })

  test("does not accept legacy numeric quota objects", () => {
    expect(
      SubsystemNovelty.resolve(
        { $novelty: { exploit: { reserved_percent: 30, minimum_hypotheses: 8 } } },
        "exploit",
      ),
    ).toEqual({ warning: "Novelty contract 'exploit' is invalid and was disabled." })
  })

  test("parses only the qualitative private gateway contract", () => {
    expect(SubsystemNovelty.parseEnvironment('{"required":true}')).toEqual({ required: true })
    expect(() => SubsystemNovelty.parseEnvironment('{"required":false}')).toThrow("invalid")
  })
})
