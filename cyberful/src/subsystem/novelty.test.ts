// ── Adaptive Novelty Contract Tests ────────────────────────────
// Verifies qualitative and bounty-portfolio modes without reviving numeric
//   quotas, phase percentages, or automatic hypothesis ranking.
// → cyberful/src/subsystem/novelty.ts — owns contract resolution.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemNovelty } from "./novelty"

describe("novelty contract", () => {
  test("enables the qualitative contract", () => {
    expect(SubsystemNovelty.resolve({ $novelty: { hacker: { required: true } } }, "hacker")).toEqual({
      contract: { required: true, mode: "qualitative" },
    })
    expect(SubsystemNovelty.resolve({ $novelty: { recon: true } }, "recon")).toEqual({
      contract: { required: true, mode: "qualitative" },
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

  test("parses both supported private gateway contract modes", () => {
    expect(SubsystemNovelty.parseEnvironment('{"required":true}')).toEqual({
      required: true,
      mode: "qualitative",
    })
    expect(SubsystemNovelty.parseEnvironment('{"required":true,"mode":"bounty-portfolio"}')).toEqual({
      required: true,
      mode: "bounty-portfolio",
    })
    expect(() => SubsystemNovelty.parseEnvironment('{"required":false}')).toThrow("invalid")
  })
})
