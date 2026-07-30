// ── Cross-Workflow Hypothesis Registry Tests ────────────────────
// Verifies durable close-or-carry transitions, deduplication, finding links,
//   and phase-boundary verdict derivation across live and code workflows.
// → cyberful/src/subsystem/gateway/hypothesis-registry.ts — owns the registry.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HypothesisRegistry } from "./hypothesis-registry"

async function temporaryWorkarea() {
  return await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-hypotheses-")))
}

describe("hypothesis registry", () => {
  test("blocks unfinished work and carries one stable hypothesis across Code Audit phases", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const trace = new HypothesisRegistry({ workarea, workflow: "code-audit", phase: "trace" })
      await trace.handle({
        action: "record",
        id: "H-CODE-1",
        owner: "trace-root",
        description: "Untrusted manifest input may reach a release command",
        root_cause: "missing authority check",
        surface: "release pipeline",
        discriminator: "guard dominance between manifest parser and process launch",
        candidate_tools: ["code_graph_path"],
        graph_refs: ["node:manifest", "node:release"],
      })
      expect(await trace.handoffError("hunt")).toContain("unfinished")
      await trace.handle({
        action: "update",
        id: "H-CODE-1",
        state: "QUEUED",
        next_phase: "hunt",
        next_step: "Inspect the complete guard context and sibling launch paths",
      })
      expect(await trace.handoffError("hunt")).toBeUndefined()

      const hunt = new HypothesisRegistry({ workarea, workflow: "code-audit", phase: "hunt" })
      const reopened = await hunt.handle({ action: "reopen", id: "H-CODE-1", owner: "hunt-root" })
      expect(reopened).toMatchObject({ id: "H-CODE-1", phase: "hunt", state: "TESTING" })
      await hunt.handle({
        action: "update",
        id: "H-CODE-1",
        state: "SUSPECTED",
        finding_id: "F-CODE-1",
        evidence: ["The launch path is reachable and the expected authority guard does not dominate it."],
        evidence_refs: ["code-graph:path:manifest-to-release"],
        omitted_tools: [{ tool: "audit_lab", reason: "not_needed" }],
        reason: "Positive static reachability evidence warrants runtime validation.",
      })
      expect(await hunt.handoffError("attack")).toBeUndefined()
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("deduplicates semantic hypotheses and derives the legacy verdict inventory", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      const candidate = {
        action: "record",
        owner: "exploit-root",
        description: "Cross-tenant object read may bypass ownership",
        root_cause: "ownership checked only on list",
        surface: "project API",
        discriminator: "tenant-specific read differential",
      }
      await registry.handle({ ...candidate, id: "H-LIVE-1" })
      await expect(registry.handle({ ...candidate, id: "H-LIVE-2" })).rejects.toThrow("duplicates")
      await registry.handle({
        action: "update",
        id: "H-LIVE-1",
        state: "SUSPECTED",
        finding_id: "F-LIVE-1",
        evidence: ["A second tenant received the synthetic object's metadata."],
        reason: "The cross-tenant differential is positive and reproducible.",
      })
      expect(await registry.verdictInventory()).toMatchObject({
        suspected: [{ id: "F-LIVE-1" }],
        confirmed: [],
        disproved: [],
      })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })
})
