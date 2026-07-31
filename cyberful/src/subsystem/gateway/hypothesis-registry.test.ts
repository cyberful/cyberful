// ── Cross-Workflow Hypothesis Registry Tests ────────────────────
// Verifies durable close-or-carry transitions, deduplication, finding links,
//   and phase-boundary verdict derivation across live and code workflows.
// → cyberful/src/subsystem/gateway/hypothesis-registry.ts — owns the registry.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HypothesisRegistry, readHypothesisRegistryView } from "./hypothesis-registry"

async function temporaryWorkarea() {
  return await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-hypotheses-")))
}

describe("hypothesis registry", () => {
  test("blocks unfinished work and carries one stable hypothesis across Code Audit phases", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const trace = new HypothesisRegistry({ workarea, workflow: "code-audit", phase: "trace" })
      const traceActor = {
        runID: "run_trace",
        displayName: "trace-root",
        kind: "root",
      }
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
        _cyberful_actor: traceActor,
      })
      expect(await trace.handoffError("hunt")).toContain("unfinished")
      await trace.handle({
        action: "update",
        id: "H-CODE-1",
        state: "QUEUED",
        next_phase: "hunt",
        next_step: "Inspect the complete guard context and sibling launch paths",
        _cyberful_actor: traceActor,
      })
      expect(await trace.handoffError("hunt")).toBeUndefined()

      const hunt = new HypothesisRegistry({ workarea, workflow: "code-audit", phase: "hunt" })
      const huntActor = {
        runID: "run_hunt",
        displayName: "hunt-root",
        kind: "root",
      }
      const reopened = await hunt.handle({
        action: "reopen",
        id: "H-CODE-1",
        owner: "hunt-root",
        _cyberful_actor: huntActor,
      })
      expect(reopened).toMatchObject({
        id: "H-CODE-1",
        phase: "hunt",
        state: "TESTING",
        ownerRunID: "run_hunt",
      })
      await hunt.handle({
        action: "update",
        id: "H-CODE-1",
        state: "SUSPECTED",
        finding_id: "F-CODE-1",
        evidence: ["The launch path is reachable and the expected authority guard does not dominate it."],
        evidence_refs: ["code-graph:path:manifest-to-release"],
        omitted_tools: [{ tool: "audit_lab", reason: "not_needed" }],
        reason: "Positive static reachability evidence warrants runtime validation.",
        _cyberful_actor: huntActor,
      })
      expect(await hunt.handoffError("attack")).toBeUndefined()
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("deduplicates semantic hypotheses", async () => {
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
      expect(await registry.get("H-LIVE-1")).toMatchObject({
        state: "SUSPECTED",
        finding_id: "F-LIVE-1",
      })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("counts active states and transfers child ownership through the host-only writer", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      const actor = {
        runID: "run_child",
        displayName: "api-monster",
        kind: "subagent",
      }
      await registry.handle({
        action: "record",
        id: "H-OWN-1",
        owner: "model-label-is-not-authoritative",
        description: "A child-owned object boundary remains open",
        root_cause: "missing object authorization",
        surface: "project API",
        discriminator: "cross-tenant read differential",
        _cyberful_actor: actor,
      })
      await registry.handle({
        action: "record",
        id: "H-OWN-2",
        owner: "child",
        description: "A second candidate was disproved",
        root_cause: "candidate parsing ambiguity",
        surface: "import parser",
        discriminator: "controlled malformed input",
        _cyberful_actor: actor,
      })
      await registry.handle({
        action: "update",
        id: "H-OWN-2",
        state: "DISPROVED",
        evidence: ["The parser rejected every controlled malformed fixture before interpretation."],
        reason: "The proposed primitive is not reachable.",
        _cyberful_actor: actor,
      })

      expect(await readHypothesisRegistryView(workarea, "pentest")).toMatchObject({
        activeCount: 1,
        countsByState: { OPEN: 1, DISPROVED: 1 },
      })

      const recovered = await registry.handle({
        action: "recover_ownership",
        fromRunID: "run_child",
        reason: "child_finished",
        _cyberful_host: true,
        _cyberful_actor: {
          runID: "run_root",
          displayName: "root",
          kind: "root",
        },
      })
      expect(recovered).toEqual([{ id: "H-OWN-1" }])
      const transferred = await registry.handle({ action: "get", id: "H-OWN-1" })
      expect(transferred).toMatchObject({
        ownerRunID: "run_root",
        ownerDisplayName: "root",
        ownerKind: "root",
      })
      expect(
        "ownershipTransitions" in transferred ? transferred.ownershipTransitions?.at(-1) : undefined,
      ).toMatchObject({
        fromRunID: "run_child",
        toRunID: "run_root",
        reason: "child_finished",
      })
      expect(
        await registry.handle({
          action: "recover_ownership",
          fromRunID: "run_child",
          reason: "child_finished",
          _cyberful_host: true,
          _cyberful_actor: {
            runID: "run_root",
            displayName: "root",
            kind: "root",
          },
        }),
      ).toEqual([])
      expect((await readHypothesisRegistryView(workarea, "pentest")).activeCount).toBe(1)
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })
})
