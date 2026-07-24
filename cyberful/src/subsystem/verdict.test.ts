// ── Live-Target Verdict Taxonomy Tests ──────────────────────────
// Verifies mutually exclusive verdict classes and explicit blocker evidence for
// hypotheses whose discriminating tests could not execute.
// → cyberful/src/subsystem/verdict.ts — owns handoff verdict validation.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { SubsystemVerdict } from "./verdict"

describe("live-target handoff verdicts", () => {
  test("keeps untestable and suspected evidence distinct", () => {
    const ledger = SubsystemVerdict.parse({
      confirmed: ["F-1"],
      disproved: ["D-1"],
      suspected: [{ id: "S-1", positive_evidence: "A repeatable cross-principal differential remained." }],
      inconclusive: [{ id: "I-1", ambiguity: "The valid control and probe produced overlapping timing." }],
      untestable: [
        {
          id: "U-1",
          blocker_reason: "OUT_OF_SCOPE_DEPENDENCY",
          next_step: "Repeat only after the storage origin is explicitly authorized.",
        },
      ],
    })

    expect(ledger && SubsystemVerdict.counts(ledger)).toEqual({
      confirmed: 1,
      disproved: 1,
      suspected: 1,
      inconclusive: 1,
      untestable: 1,
    })
  })

  test("rejects duplicate IDs and unstructured blockers", () => {
    expect(() =>
      SubsystemVerdict.parse({
        confirmed: ["same"],
        disproved: ["same"],
        suspected: [],
        inconclusive: [],
        untestable: [],
      }),
    ).toThrow("unique")
    expect(() =>
      SubsystemVerdict.parse({
        confirmed: [],
        disproved: [],
        suspected: [],
        inconclusive: [],
        untestable: [{ id: "U-1", blocker_reason: "BLOCKED", next_step: "later" }],
      }),
    ).toThrow("blocker_reason")
  })
})
