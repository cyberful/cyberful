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
  const assessmentReviewValues = (tool: typeof writable) => {
    const actions = tool.definition.inputSchema as {
      readonly oneOf: Array<{
        readonly properties?: {
          readonly action?: { readonly enum?: readonly string[] }
          readonly assessment?: { readonly properties?: { readonly review?: { readonly enum?: readonly string[] } } }
        }
      }>
    }
    return actions.oneOf.find((schema) => schema.properties?.action?.enum?.includes("set_attack_assessment"))
      ?.properties?.assessment?.properties?.review?.enum
  }
  expect(assessmentReviewValues(writable)).toEqual(["NOT_REVIEWED"])
  expect(
    assessmentReviewValues(SessionFinding.dynamicTool(store, { ...run, phase: "verify" }, { readonly: false })),
  ).toEqual(["NOT_REVIEWED", "ACCEPTED", "REVISED", "REJECTED"])
  expect(
    await writable.execute(
      {
        action: "record",
        key: "BBP-014",
        title: "Missing device-flow binding",
        positive_evidence: [
          "The callback accepted a challenge without the expected initial binding.",
          " A negative control kept the expected binding. ",
          "The callback accepted a challenge without the expected initial binding.",
        ],
        severity: "HIGH",
      },
      { signal },
    ),
  ).toMatchObject({ success: true })
  expect(await store.get("BBP-014")).toMatchObject({
    observations: [
      {
        disposition: {
          state: "SUSPECTED",
          positiveEvidence:
            "The callback accepted a challenge without the expected initial binding.\nA negative control kept the expected binding.",
        },
      },
    ],
  })

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
  ).toMatchObject({ success: false })
  const readonlyError = JSON.parse(
    (
      await readonly.execute(
        {
          action: "update",
          id: "BBP-014",
          state: "DISPROVED",
          disproof: "A control explained the behavior.",
          summary: "Rejected.",
        },
        { signal },
      )
    ).text,
  )
  expect(readonlyError).toMatchObject({
    error: {
      code: "FINDING_READ_ONLY",
      retryable: true,
    },
  })
  expect((await store.get("BBP-014"))?.observations).toHaveLength(1)
  expect(revisions).toEqual([1, 2])
})

test("returns one reward-aware maturation bundle and persists its conservative upside", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  const run = { runID: "ses_maturation", workflow: "bug-bounty" as const, phase: "exploit" }
  await store.startRun({ id: run.runID, workflow: run.workflow })
  const notices: SessionFinding.MaturationNotice[] = []
  const tool = SessionFinding.dynamicTool(store, run, {
    readonly: false,
    rewardPolicy: async () => ({
      version: 1,
      revision: "reward-r1",
      updated_at: "2026-08-10T08:00:00.000Z",
      kind: "MONETARY",
      source: {
        url: "https://security.example.test/program",
        observed_at: "2026-08-10T08:00:00.000Z",
      },
      groups: [
        {
          id: "web",
          label: "Web",
          assets: ["app.example.test"],
          tiers: [
            { severity: "MEDIUM", minimum: 500, maximum: 1_000, currency: "USD" },
            { severity: "HIGH", minimum: 3_000, maximum: 5_000, currency: "USD" },
          ],
        },
      ],
    }),
    onMaturation: (notice) => notices.push(notice),
  })
  const record = {
    action: "record",
    key: "BBP-REWARD-001",
    title: "Cross-tenant export disclosure",
    positive_evidence: "A controlled tenant retrieved the other tester tenant's export metadata.",
    severity: "MEDIUM",
  }

  const first = await tool.execute(record, { signal })
  expect(first.success).toBe(true)
  expect(JSON.parse(first.text).maturation_advisory).toMatchObject({
    currentSeverity: "MEDIUM",
    targetSeverity: "HIGH",
    checkpoint: {
      reward: {
        current: { minimum: 500, maximum: 1_000, currency: "USD" },
        target: { minimum: 3_000, maximum: 5_000, currency: "USD" },
        upside: { minimum: 2_000, maximum: 4_500, currency: "USD" },
      },
    },
  })
  expect(notices).toHaveLength(1)
  expect(JSON.parse(first.text).maturation_advisory).toEqual(notices[0])
  expect(notices[0]?.checkpoint.questions).toHaveLength(4)
  expect(notices[0]?.checkpoint.questions.join(" ")).toContain("published schedule")
  expect((await store.get("BBP-REWARD-001")).observations[0]?.maturation?.checkpoint?.reward?.upside).toMatchObject({
    minimum: 2_000,
    maximum: 4_500,
  })

  const repeated = await tool.execute(record, { signal })
  expect(repeated.success).toBe(true)
  expect(JSON.parse(repeated.text).maturation_advisory).toBeUndefined()
  expect(notices).toHaveLength(1)
  expect((await store.get("BBP-REWARD-001")).observations).toHaveLength(1)
})

test("validates maturation lifecycle fields and keeps Pentest checkpoints technical", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  const run = { runID: "ses_pentest_maturation", workflow: "pentest" as const, phase: "exploit" }
  await store.startRun({ id: run.runID, workflow: run.workflow })
  const notices: SessionFinding.MaturationNotice[] = []
  const tool = SessionFinding.dynamicTool(store, run, {
    readonly: false,
    onMaturation: (notice) => notices.push(notice),
  })
  await tool.execute(
    {
      action: "record",
      key: "PT-001",
      title: "Authorization boundary weakness",
      positive_evidence: "A controlled low-privilege identity reached an administrator-only object.",
      severity: "MEDIUM",
    },
    { signal },
  )
  expect(notices[0]?.checkpoint.questions).toHaveLength(3)
  expect(notices[0]?.checkpoint.reward).toBeUndefined()

  const invalid = await tool.execute(
    {
      action: "update",
      id: "PT-001",
      state: "SUSPECTED",
      positive_evidence: "The boundary remains reachable.",
      summary: "Impact expansion remains under test.",
      maturation: {
        status: "PURSUE",
        current_impact: "One administrator-only object is exposed.",
        target_severity: "HIGH",
      },
    },
    { signal },
  )
  expect(invalid.success).toBe(false)
  expect(JSON.parse(invalid.text).error.hint).toContain("evidence_gap")
})

test("keeps technical maturation available when the stored reward policy is unreadable", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  const run = { runID: "ses_reward_degraded", workflow: "bug-bounty" as const, phase: "recon" }
  await store.startRun({ id: run.runID, workflow: run.workflow })
  const result = await SessionFinding.dynamicTool(store, run, {
    readonly: false,
    rewardPolicy: async () => {
      throw new Error("invalid reward policy JSON")
    },
  }).execute(
    {
      action: "record",
      key: "BBP-DEGRADED-001",
      title: "Supported authorization weakness",
      positive_evidence: "A controlled identity crossed the expected object boundary.",
      severity: "MEDIUM",
    },
    { signal },
  )

  expect(result.success).toBe(true)
  expect(JSON.parse(result.text)).toMatchObject({
    reward_policy_warning: expect.stringContaining("technical maturation continues"),
    maturation_advisory: { checkpoint: { questions: expect.any(Array) } },
  })
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

test("keeps negative backlog verdicts without admitting unregistered positive findings", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  const runID = "ses_backlog_verdict"
  await store.startRun({ id: runID, workflow: "bug-bounty" })
  await store.execute(
    {
      action: "record",
      key: "BBP-021",
      title: "Pre-trust process launch",
      positive_evidence: "A marker process appeared before the trust decision.",
      severity: "MEDIUM",
    },
    { runID, workflow: "bug-bounty", phase: "exploit" },
  )

  expect(
    await findingHandoffWarning(store, {
      runID,
      workflow: "bug-bounty",
      phase: "exploit",
      verdicts: {
        ...emptyInventory,
        suspected: [{ id: "BBP-021", positiveEvidence: "The marker appeared before trust." }],
        disproved: ["CCODE-MCP-TRUST-001"],
        inconclusive: [{ id: "CCODE-MCP-TRANSPORT-002", ambiguity: "The transport closed before the oracle." }],
        untestable: [
          {
            id: "CCODE-MCP-AUTHORITY-003",
            blockerReason: "AUTHORITY_REQUIRED",
            nextStep: "Repeat with an authorized organization administrator.",
          },
        ],
      },
    }),
  ).toBeUndefined()

  expect(
    await findingHandoffWarning(store, {
      runID,
      workflow: "bug-bounty",
      phase: "exploit",
      verdicts: { ...emptyInventory, disproved: ["BBP-021-TYPO"] },
    }),
  ).toBe(
    "Finding registry and handoff verdict inventory diverge (unregistered-positive 0, duplicate 0, state 0, missing 1).",
  )

  expect(
    await findingHandoffWarning(store, {
      runID,
      workflow: "bug-bounty",
      phase: "exploit",
      verdicts: {
        ...emptyInventory,
        confirmed: ["CCODE-MCP-TRUST-001"],
        suspected: [{ id: "BBP-021", positiveEvidence: "The marker appeared before trust." }],
      },
    }),
  ).toBe(
    "Finding registry and handoff verdict inventory diverge (unregistered-positive 1, duplicate 0, state 0, missing 0).",
  )
})
