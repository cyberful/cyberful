// ── Session Finding Registry Contract Tests ─────────────────────
// Protects the Report read boundary, live revision publication, and phase
//   handoff reconciliation against the authoritative workarea registry.
// → cyberful/src/session/finding.ts — exposes the dynamic tool.
// → cyberful/src/session/prompt.ts — rejects divergent phase handoffs.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { chmod, mkdtemp, realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"
import { FindingRegistry } from "@/finding/registry"
import { SubsystemVerdict } from "@/subsystem/verdict"
import { findingHandoffWarning } from "./finding-handoff"
import { SessionFinding } from "./finding"

async function workarea() {
  const root = await mkdtemp(path.join(tmpdir(), "cyberful-session-findings-"))
  await chmod(root, 0o700)
  return realpath(root)
}

const signal = new AbortController().signal
const emptyInventory: SubsystemVerdict.Ledger = {
  confirmed: [],
  disproved: [],
  suspected: [],
  inconclusive: [],
  untestable: [],
}

test("publishes revisions and keeps the Report finding tool read-only", async () => {
  const root = await workarea()
  const revisions: number[] = []
  const store = new FindingRegistry.Store(root, {
    workarea: "target",
    onUpdated: (revision) => {
      revisions.push(revision)
    },
  })
  const run = { runID: "ses_tool", workflow: "bug-bounty" as const, phase: "exploit" }
  await store.startRun({ id: run.runID, workflow: run.workflow })

  const writable = SessionFinding.dynamicTool(store, run, { readonly: false })
  expect(
    await writable.execute(
      {
        action: "record",
        key: "BBP-014",
        title: "Missing device-flow binding",
        positive_evidence: "The callback accepted a challenge without the expected initial binding.",
        severity: "HIGH",
      },
      { signal },
    ),
  ).toMatchObject({ success: true })

  const readonly = SessionFinding.dynamicTool(store, { ...run, phase: "report" }, { readonly: true })
  expect(
    await readonly.execute(
      {
        action: "update",
        id: "BBP-014",
        state: "DISPROVED",
        disproof: "A control explained the behavior.",
        summary: "Rejected.",
      },
      { signal },
    ),
  ).toEqual({
    success: false,
    text: "The finding registry is read-only in Report; use list or get.",
  })
  expect((await store.get("BBP-014"))?.observations).toHaveLength(1)
  expect(revisions).toEqual([1, 2])
})

test("reconciles Exploit handoffs and requires final Bug Bounty Verify decisions", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  const runID = "ses_reconcile"
  await store.startRun({ id: runID, workflow: "bug-bounty" })
  await store.execute(
    {
      action: "record",
      key: "BBP-014",
      title: "Missing device-flow binding",
      positive_evidence: "The challenge was accepted without the expected initial binding.",
      severity: "HIGH",
    },
    { runID, workflow: "bug-bounty", phase: "exploit" },
  )
  await store.execute(
    { action: "alias", id: "BBP-014", alias: "AUTH-DEVICE" },
    { runID, workflow: "bug-bounty", phase: "exploit" },
  )

  expect(
    await findingHandoffWarning(store, {
      runID,
      workflow: "bug-bounty",
      phase: "exploit",
      verdicts: {
        ...emptyInventory,
        suspected: [{ id: "BBP-014", positiveEvidence: "The challenge was accepted." }],
      },
    }),
  ).toBeUndefined()
  expect(
    await findingHandoffWarning(store, {
      runID,
      workflow: "bug-bounty",
      phase: "exploit",
      verdicts: { ...emptyInventory, confirmed: ["BBP-014"] },
    }),
  ).toContain("diverge")
  expect(
    await findingHandoffWarning(store, {
      runID,
      workflow: "bug-bounty",
      phase: "exploit",
      verdicts: {
        ...emptyInventory,
        suspected: [
          { id: "BBP-014", positiveEvidence: "The challenge was accepted." },
          { id: "AUTH-DEVICE", positiveEvidence: "The challenge was accepted." },
        ],
      },
    }),
  ).toContain("duplicate 1")
  expect(
    await findingHandoffWarning(store, {
      runID,
      workflow: "bug-bounty",
      phase: "verify",
    }),
  ).toContain("without final Verify decisions")

  await store.execute(
    {
      action: "update",
      id: "BBP-014",
      state: "CONFIRMED",
      proof: "A safe control reproduced the victim-side account binding.",
      summary: "The binding weakness survives verification.",
      severity: "HIGH",
      verification: "SURVIVES",
      verification_rationale: "The exploit and negative control produce distinct, repeatable outcomes.",
      submission: "SUBMISSION_READY",
      submission_rationale: "The affected flow is in scope and the impact is reproducible.",
    },
    { runID, workflow: "bug-bounty", phase: "verify" },
  )
  expect(
    await findingHandoffWarning(store, {
      runID,
      workflow: "bug-bounty",
      phase: "verify",
    }),
  ).toBeUndefined()
})
