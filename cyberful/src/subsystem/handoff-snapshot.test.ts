// ── Handoff Snapshot Regression Tests ────────────────────────────
// Protects phase advancement when a valid finding and a narrower disproved
//   hypothesis coexist, and rejects broken positive finding links.
// → cyberful/src/subsystem/handoff-snapshot.ts — owns the tested boundary.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FindingRegistry } from "@/finding/registry"
import { HypothesisRegistry } from "./gateway/hypothesis-registry"
import {
  createHandoffSnapshot,
  HandoffSnapshotError,
  parseHandoffSnapshot,
} from "./handoff-snapshot"

async function temporaryWorkarea() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-handoff-snapshot-")))
}

async function recordFinding(
  store: FindingRegistry.Store,
  run: FindingRegistry.RunContext,
  key: string,
  state: "SUSPECTED" | "CONFIRMED",
) {
  const recorded = (await store.execute(
    {
      action: "record",
      key,
      title: `Finding ${key}`,
      positive_evidence: [`Evidence for ${key}`, `Independent confirmation for ${key}`],
      severity: "LOW",
    },
    run,
  )) as FindingRegistry.Finding
  if (state === "CONFIRMED")
    await store.execute(
      {
        action: "update",
        id: recorded.id,
        state: "CONFIRMED",
        proof: `Confirmed proof for ${key}`,
        summary: `Confirmed ${key}`,
      },
      run,
    )
  return recorded.id
}

async function beginTesting(hypotheses: HypothesisRegistry, id: string) {
  await hypotheses.handle({ action: "update", id, state: "TESTING" })
}

describe("host-owned handoff snapshots", () => {
  test("keeps a confirmed observation when its narrower bypass hypothesis is disproved", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const run = { runID: "ses_contractbot", workflow: "pentest" as const, phase: "exploit" }
      const findings = new FindingRegistry.Store(workarea, { workarea: "contractbot" })
      await findings.startRun({ id: run.runID, workflow: run.workflow })
      const confirmed = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          recordFinding(findings, run, `F-CONFIRMED-${index + 1}`, "CONFIRMED"),
        ),
      )
      const suspected = await recordFinding(findings, run, "F-SUSPECTED-1", "SUSPECTED")
      const hypotheses = new HypothesisRegistry({
        workarea,
        workflow: run.workflow,
        phase: run.phase,
      })
      for (const [index, findingID] of confirmed.slice(0, 5).entries()) {
        const id = `H-CONFIRMED-${index + 1}`
        await hypotheses.handle({
          action: "record",
          id,
          owner: "exploit-root",
          description: `Positive mechanism ${index + 1}`,
          root_cause: "missing boundary control",
          surface: `surface-${index + 1}`,
          discriminator: `positive differential ${index + 1}`,
        })
        await beginTesting(hypotheses, id)
        await hypotheses.handle({
          action: "update",
          id,
          state: "CONFIRMED",
          finding_id: findingID,
          evidence: [`Positive evidence ${index + 1}`],
          reason: "The mechanism is confirmed.",
        })
      }
      await hypotheses.handle({
        action: "record",
        id: "H-SUSPECTED-1",
        owner: "exploit-root",
        description: "One provisional mechanism",
        root_cause: "possible missing boundary control",
        surface: "provisional surface",
        discriminator: "provisional differential",
      })
      await beginTesting(hypotheses, "H-SUSPECTED-1")
      await hypotheses.handle({
        action: "update",
        id: "H-SUSPECTED-1",
        state: "SUSPECTED",
        finding_id: suspected,
        evidence: ["The provisional differential is positive."],
        reason: "The impact needs independent verification.",
      })
      await hypotheses.handle({
        action: "record",
        id: "H-QUOTA-BYPASS",
        owner: "exploit-root",
        description: "The inconsistent quota may permit a bypass",
        root_cause: "inconsistent entitlement displays",
        surface: "contract creation",
        discriminator: "attempt the first record beyond the enforced quota",
      })
      await beginTesting(hypotheses, "H-QUOTA-BYPASS")
      await hypotheses.handle({
        action: "update",
        id: "H-QUOTA-BYPASS",
        state: "DISPROVED",
        evidence: ["The first record beyond the actual entitlement was rejected."],
        reason: "The inconsistency remains visible but no bypass exists.",
      })

      const snapshot = await createHandoffSnapshot({
        findings,
        hypotheses,
        runID: run.runID,
      })

      expect(snapshot.counts.findings).toMatchObject({ CONFIRMED: 6, SUSPECTED: 1 })
      expect(snapshot.counts.hypotheses).toMatchObject({ CONFIRMED: 5, SUSPECTED: 1, DISPROVED: 1 })
      expect(snapshot.findings.map((finding) => finding.id)).toContain(confirmed[5])
      expect(parseHandoffSnapshot(snapshot)).toEqual(snapshot)
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("rejects a positive hypothesis linked to a missing finding", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const findings = new FindingRegistry.Store(workarea, { workarea: "target" })
      await findings.startRun({ id: "ses_missing", workflow: "pentest" })
      const hypotheses = new HypothesisRegistry({
        workarea,
        workflow: "pentest",
        phase: "exploit",
      })
      await hypotheses.handle({
        action: "record",
        id: "H-MISSING",
        owner: "exploit-root",
        description: "A positive hypothesis has no durable finding",
        root_cause: "missing registry admission",
        surface: "project API",
        discriminator: "positive response differential",
      })
      await beginTesting(hypotheses, "H-MISSING")
      await hypotheses.handle({
        action: "update",
        id: "H-MISSING",
        state: "CONFIRMED",
        finding_id: "F-NOT-RECORDED",
        evidence: ["The positive differential was reproduced."],
        reason: "The mechanism is confirmed.",
      })

      await expect(
        createHandoffSnapshot({ findings, hypotheses, runID: "ses_missing" }),
      ).rejects.toMatchObject({
        code: "HANDOFF_RECONCILIATION_FAILED",
        ids: ["H-MISSING"],
      } satisfies Partial<HandoffSnapshotError>)
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })
})
