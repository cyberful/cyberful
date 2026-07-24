// ── Target-Specific Novelty Ledger Tests ────────────────────────
// Verifies batch records, semantic convergence, cross-ledger provenance, and
//   the qualitative synthesis gate without numeric diversity requirements.
// → cyberful/src/subsystem/gateway/novelty-ledger.ts — owns the ledger.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NoveltyLedger } from "./novelty-ledger"

function hypothesis(id: string, rootCause: string) {
  return {
    id,
    title: `Probe ${id}`,
    root_cause: rootCause,
    enforcement_owner: `${rootCause} owner`,
    protocol: `${rootCause} protocol`,
    state_transition: `${rootCause} transition`,
    attacker_capability: `${rootCause} capability`,
    oracle: `${rootCause} oracle`,
    target_facts: [`Observed ${rootCause} on the target`],
  }
}

describe("novelty ledger", () => {
  test("signals convergence once and accepts evidence-backed synthesis", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-novelty-"))
    try {
      const ledger = new NoveltyLedger(root, "hacker", { required: true })
      await ledger.record({ action: "record", ...hypothesis("H1", "authorization") })
      const converged = await ledger.record({ action: "record", ...hypothesis("H2", "authorization") })
      expect(converged.antiConvergence.signal).toBe(true)
      const repeated = await ledger.record({ action: "record", ...hypothesis("H3", "authorization") })
      expect(repeated.antiConvergence.signal).toBe(false)
      expect(await ledger.handoffError()).toContain("contrarian synthesis missing")
      expect(
        await ledger.synthesize({
          action: "synthesize",
          outcome: "exhausted",
          contrarian_summary: "The target exposes one enforcement boundary after independent pivots.",
          evidence: ["Compared authenticated and unauthenticated state transitions on target-specific routes."],
          remaining_unknowns: ["Cross-service lifecycle race"],
        }),
      ).toMatchObject({ synthesisCompleted: true, distinctFamilies: 1 })
      expect(await ledger.handoffError()).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("records batches and distinguishes parent_id from cross-phase source_ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cyberful-novelty-source-"))
    try {
      const ledger = new NoveltyLedger(root, "exploit", { required: true })
      const result = await ledger.record({
        action: "record",
        records: [
          { ...hypothesis("EX-1", "authorization"), source_ref: { phase: "recon", kind: "candidate", id: "RC-1" } },
          { ...hypothesis("EX-2", "parser"), parent_id: "EX-1" },
        ],
      })
      expect(result.recorded).toEqual(["EX-1", "EX-2"])
      await expect(
        ledger.record({ action: "record", ...hypothesis("EX-3", "cache"), parent_id: "RC-1" }),
      ).rejects.toThrow("does not exist in phase 'exploit'")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
