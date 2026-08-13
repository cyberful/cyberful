// ── Cross-Workflow Hypothesis Registry Tests ────────────────────
// Verifies durable close-or-carry transitions, deduplication, finding links,
//   and phase-boundary verdict derivation across live and code workflows.
// → cyberful/src/subsystem/gateway/hypothesis-registry.ts — owns the registry.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  HYPOTHESIS_TOOL_DEF,
  HypothesisRegistry,
  HypothesisRegistryError,
  readHypothesisRegistryView,
} from "./hypothesis-registry"

async function temporaryWorkarea() {
  return await realpath(await mkdtemp(path.join(os.tmpdir(), "cyberful-hypotheses-")))
}

async function configureRewardPolicy(workarea: string) {
  await mkdir(path.join(workarea, "raw/policy"), { recursive: true })
  await Bun.write(
    path.join(workarea, "raw/policy/rewards.json"),
    JSON.stringify({
      version: 1,
      revision: "reward-r1",
      updated_at: "2026-08-13T00:00:00.000Z",
      kind: "MONETARY",
      source: { url: "https://target.test/policy", observed_at: "2026-08-13T00:00:00.000Z" },
      groups: [
        {
          id: "web",
          label: "Web targets",
          assets: ["target.test"],
          tiers: [
            { severity: "HIGH", minimum: 2_000, maximum: 4_000, currency: "USD" },
            { severity: "CRITICAL", minimum: 5_000, maximum: 10_000, currency: "USD" },
          ],
        },
      ],
    }),
  )
}

function bountyContext(input: {
  cluster: string
  impact?: string
  boundary?: string
  enforcementOwner?: string
  groupStatus?: "MAPPED" | "UNRESOLVED" | "NOT_APPLICABLE"
}) {
  return {
    cluster: input.cluster,
    impact_class: input.impact ?? "unauthorized account data read",
    boundary: input.boundary ?? "resource authorization",
    enforcement_owner: input.enforcementOwner ?? "API gateway",
    principals: ["external attacker"],
    objects: ["tester-owned account object"],
    oracle: { vulnerable: "the cross-boundary effect succeeds", secure: "the control rejects the effect" },
    test_cost: "LOW",
    reward: {
      target_severity: "HIGH",
      group_status: input.groupStatus ?? "MAPPED",
      ...(input.groupStatus === undefined || input.groupStatus === "MAPPED" ? { group_id: "web" } : {}),
      rationale: "This path could reach the official high-impact reward tier.",
    },
  }
}

function bountyHypothesis(id: string, context: ReturnType<typeof bountyContext>) {
  return {
    action: "record",
    id,
    owner: "bounty-root",
    description: `${id} target-specific authorization candidate`,
    root_cause: `${id} missing contextual authorization`,
    surface: `${id} account API`,
    discriminator: `${id} controlled cross-boundary differential`,
    bounty_context: context,
  }
}

async function disprove(registry: HypothesisRegistry, id: string) {
  await registry.handle({ action: "claim", id })
  return registry.handle({
    action: "update",
    id,
    state: "DISPROVED",
    evidence: [`${id} retained the secure control under the target-specific differential.`],
    evidence_refs: [`raw/evidence/${id}.json`],
    reason: "The controlled bypass did not reproduce.",
  })
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
      await expect(
        registry.handle({
          action: "update",
          id: "H-LIVE-1",
          state: "SUSPECTED",
          finding_id: "F-LIVE-1",
          evidence: ["A second tenant received the synthetic object's metadata."],
          reason: "The cross-tenant differential is positive and reproducible.",
        }),
      ).rejects.toThrow("must enter TESTING")
      await registry.handle({
        action: "claim",
        id: "H-LIVE-1",
        reason: "Revisit the suspected result under a fresh control.",
      })
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
      await registry.handle({
        action: "claim",
        id: "H-LIVE-1",
        reason: "Retest the suspected result under the same controls.",
      })
      const testing = await registry.get("H-LIVE-1")
      expect(testing).toMatchObject({ state: "TESTING" })
      expect(testing.finding_id).toBeUndefined()
      await registry.handle({
        action: "update",
        id: "H-LIVE-1",
        state: "DISPROVED",
        evidence: ["The repeated differential no longer reproduces under the same controls."],
        reason: "The retest invalidated the prior positive result.",
      })
      const disproved = await registry.get("H-LIVE-1")
      expect(disproved).toMatchObject({ state: "DISPROVED" })
      expect(disproved.finding_id).toBeUndefined()
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("makes exact record and same-state updates idempotent while merging new evidence", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      const record = {
        action: "record",
        id: "H-IDEM-1",
        owner: "exploit-root",
        description: "A stable authorization candidate",
        root_cause: "missing ownership check",
        surface: "object API",
        discriminator: "cross-tenant object differential",
        candidate_tools: ["browser_request"],
      }
      await registry.handle(record)
      const afterRecord = await registry.list()
      await registry.handle(record)
      expect((await registry.list()).revision).toBe(afterRecord.revision)

      await registry.handle({ action: "update", id: "H-IDEM-1", state: "TESTING" })
      const afterTesting = await registry.list()
      await registry.handle({ action: "update", id: "H-IDEM-1", state: "TESTING" })
      expect((await registry.list()).revision).toBe(afterTesting.revision)

      const suspected = {
        action: "update",
        id: "H-IDEM-1",
        state: "SUSPECTED",
        finding_id: "F-IDEM-1",
        evidence: ["The second tenant received the synthetic object."],
        evidence_refs: ["raw/evidence/one.json"],
        reason: "The controlled cross-tenant differential is positive.",
      }
      await registry.handle(suspected)
      const afterSuspected = await registry.list()
      await registry.handle(suspected)
      expect((await registry.list()).revision).toBe(afterSuspected.revision)
      expect((await registry.get("H-IDEM-1")).transitions).toHaveLength(3)

      await registry.handle({
        ...suspected,
        evidence: [
          "The second tenant received the synthetic object.",
          "A repeat control produced the same tenant differential.",
        ],
        evidence_refs: ["raw/evidence/one.json", "raw/evidence/two.json"],
      })
      const merged = await registry.get("H-IDEM-1")
      expect(merged.evidence).toEqual([
        "The second tenant received the synthetic object.",
        "A repeat control produced the same tenant differential.",
      ])
      expect(merged.evidence_refs).toEqual(["raw/evidence/one.json", "raw/evidence/two.json"])
      expect(merged.transitions).toHaveLength(3)
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
        state: "TESTING",
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
        activeHypotheses: [
          {
            id: "H-OWN-1",
            owner: "model-label-is-not-authoritative",
            ownerDisplayName: "api-monster",
            description: "A child-owned object boundary remains open",
            rootCause: "missing object authorization",
            surface: "project API",
            discriminator: "cross-tenant read differential",
            state: "OPEN",
          },
        ],
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

  test("claims active testing atomically and requires an explicit terminal-state revisit", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      const firstActor = { runID: "run_first", displayName: "first", kind: "subagent" } as const
      const secondActor = { runID: "run_second", displayName: "second", kind: "subagent" } as const
      await registry.handle({
        action: "record",
        id: "H-CLAIM-1",
        owner: "first",
        description: "A parser boundary needs a controlled discriminator",
        root_cause: "ambiguous dispatch",
        surface: "document parser",
        discriminator: "controlled parser differential",
        _cyberful_actor: firstActor,
      })

      await registry.handle({ action: "claim", id: "H-CLAIM-1", _cyberful_actor: firstActor })
      const claimedRevision = (await registry.list()).revision
      await registry.handle({ action: "claim", id: "H-CLAIM-1", _cyberful_actor: firstActor })
      expect((await registry.list()).revision).toBe(claimedRevision)

      const owned = await registry
        .handle({ action: "claim", id: "H-CLAIM-1", _cyberful_actor: secondActor })
        .catch((error) => error)
      expect(owned).toBeInstanceOf(HypothesisRegistryError)
      expect((owned as HypothesisRegistryError).toolError({ action: "claim" })).toMatchObject({
        code: "HYPOTHESIS_OWNED",
        current_state: "TESTING",
        owner_run_id: "run_first",
        allowed_actions: ["get", "list"],
      })

      await registry.handle({
        action: "update",
        id: "H-CLAIM-1",
        state: "UNTESTABLE",
        blocker: "The required fixture is not yet available.",
        blocker_reason: "TOOL_UNAVAILABLE",
        next_step: "Retry after preparing the fixture.",
        reason: "The current environment cannot execute the discriminator.",
        _cyberful_actor: firstActor,
      })
      await expect(registry.handle({ action: "claim", id: "H-CLAIM-1", _cyberful_actor: secondActor })).rejects.toThrow(
        "requires a non-empty claim reason",
      )
      const revisited = await registry.handle({
        action: "claim",
        id: "H-CLAIM-1",
        reason: "The missing fixture is now available.",
        _cyberful_actor: secondActor,
      })
      expect(revisited).toMatchObject({
        state: "TESTING",
        ownerRunID: "run_second",
      })
      expect("blocker" in revisited ? revisited.blocker : undefined).toBeUndefined()
      expect("next_step" in revisited ? revisited.next_step : undefined).toBeUndefined()
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("requires host-validated reward context on every Bug Bounty portfolio hypothesis", async () => {
    const workarea = await temporaryWorkarea()
    try {
      await configureRewardPolicy(workarea)
      const legacy = new HypothesisRegistry({ workarea, workflow: "bug-bounty", phase: "exploit" })
      await legacy.handle({
        action: "record",
        id: "BB-LEGACY",
        owner: "legacy-root",
        description: "A legacy candidate needs portfolio context",
        root_cause: "legacy authorization gap",
        surface: "legacy API",
        discriminator: "legacy controlled differential",
      })

      const registry = new HypothesisRegistry({
        workarea,
        workflow: "bug-bounty",
        phase: "exploit",
        noveltyContract: { required: true, mode: "bounty-portfolio" },
      })
      await expect(
        registry.handle({
          action: "record",
          id: "BB-MISSING",
          owner: "root",
          description: "Missing context candidate",
          root_cause: "missing context",
          surface: "account API",
          discriminator: "controlled differential",
        }),
      ).rejects.toThrow("bounty_context")
      await expect(registry.handle({ action: "claim", id: "BB-LEGACY" })).rejects.toThrow("set_bounty_context")
      await expect(
        registry.handle({
          ...bountyHypothesis("BB-BAD-GROUP", {
            ...bountyContext({ cluster: "bad-group" }),
            reward: {
              ...bountyContext({ cluster: "bad-group" }).reward,
              group_id: "invented",
            },
          }),
        }),
      ).rejects.toThrow("does not exist")
      await expect(
        registry.handle({
          ...bountyHypothesis("BB-BAD-TIER", {
            ...bountyContext({ cluster: "bad-tier" }),
            reward: {
              ...bountyContext({ cluster: "bad-tier" }).reward,
              target_severity: "LOW",
            },
          }),
        }),
      ).rejects.toThrow("does not publish a LOW tier")
      const agentAmountContext = bountyContext({ cluster: "agent-amount" })
      await expect(
        registry.handle({
          ...bountyHypothesis("BB-AGENT-AMOUNT", agentAmountContext),
          bounty_context: {
            ...agentAmountContext,
            reward: { ...agentAmountContext.reward, amount: 4_000 },
          },
        }),
      ).rejects.toThrow("unsupported field(s): amount")

      const unresolved = await registry.handle(
        bountyHypothesis("BB-UNRESOLVED", bountyContext({ cluster: "unresolved", groupStatus: "UNRESOLVED" })),
      )
      expect(unresolved).toMatchObject({
        bounty_context: {
          reward: { group_status: "UNRESOLVED", policy_kind: "MONETARY", policy_revision: "reward-r1" },
        },
      })
      const inventedUnresolvedTier = bountyContext({ cluster: "unresolved-tier", groupStatus: "UNRESOLVED" })
      await expect(
        registry.handle({
          ...bountyHypothesis("BB-UNRESOLVED-TIER", inventedUnresolvedTier),
          bounty_context: {
            ...inventedUnresolvedTier,
            reward: { ...inventedUnresolvedTier.reward, target_severity: "LOW" },
          },
        }),
      ).rejects.toThrow("does not publish a LOW tier")

      const legacyContext = bountyContext({ cluster: "legacy" })
      await registry.handle({
        action: "set_bounty_context",
        id: "BB-LEGACY",
        bounty_context: legacyContext,
        reason: "Upgrade the persisted candidate to the reward-aware contract.",
      })
      const correctedContext = { ...legacyContext, enforcement_owner: "legacy API service" }
      await registry.handle({
        action: "set_bounty_context",
        id: "BB-LEGACY",
        bounty_context: correctedContext,
        reason: "Correct the enforcement owner after reading the target architecture evidence.",
      })
      const upgraded = await registry.handle({ action: "claim", id: "BB-LEGACY" })
      expect(upgraded).toMatchObject({
        state: "TESTING",
        bounty_context: {
          cluster: "legacy",
          enforcement_owner: "legacy API service",
          reward: { policy_kind: "MONETARY" },
        },
        bounty_context_history: [
          { reason: "Upgrade the persisted candidate to the reward-aware contract.", context: legacyContext },
          {
            reason: "Correct the enforcement owner after reading the target architecture evidence.",
            context: correctedContext,
          },
        ],
      })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("accepts NOT_APPLICABLE only when no grouped reward policy is available", async () => {
    const unavailableWorkarea = await temporaryWorkarea()
    const monetaryWorkarea = await temporaryWorkarea()
    try {
      const unavailable = new HypothesisRegistry({
        workarea: unavailableWorkarea,
        workflow: "bug-bounty",
        phase: "recon",
        noveltyContract: { required: true, mode: "bounty-portfolio" },
      })
      expect(
        await unavailable.handle(
          bountyHypothesis(
            "BB-NOT-APPLICABLE",
            bountyContext({ cluster: "unpublished-reward", groupStatus: "NOT_APPLICABLE" }),
          ),
        ),
      ).toMatchObject({
        bounty_context: {
          reward: { group_status: "NOT_APPLICABLE", policy_kind: "UNAVAILABLE" },
        },
      })

      await configureRewardPolicy(monetaryWorkarea)
      const monetary = new HypothesisRegistry({
        workarea: monetaryWorkarea,
        workflow: "bug-bounty",
        phase: "recon",
        noveltyContract: { required: true, mode: "bounty-portfolio" },
      })
      await expect(
        monetary.handle(
          bountyHypothesis(
            "BB-WRONG-NOT-APPLICABLE",
            bountyContext({ cluster: "published-reward", groupStatus: "NOT_APPLICABLE" }),
          ),
        ),
      ).rejects.toThrow("only without a published grouped reward policy")
    } finally {
      await Promise.all([
        rm(unavailableWorkarea, { recursive: true, force: true }),
        rm(monetaryWorkarea, { recursive: true, force: true }),
      ])
    }
  })

  test("signals two strong negatives without blocking more tests and gates handoff on a later structural pivot", async () => {
    const workarea = await temporaryWorkarea()
    try {
      await configureRewardPolicy(workarea)
      const registry = new HypothesisRegistry({
        workarea,
        workflow: "bug-bounty",
        phase: "exploit",
        noveltyContract: { required: true, mode: "bounty-portfolio" },
      })
      const dominant = bountyContext({ cluster: "object-authorization" })
      await registry.handle(
        bountyHypothesis(
          "BB-EARLY-PIVOT",
          bountyContext({
            cluster: "identity-binding",
            impact: "account takeover",
            boundary: "identity binding",
            enforcementOwner: "identity service",
          }),
        ),
      )
      await registry.handle({ action: "claim", id: "BB-EARLY-PIVOT" })
      await registry.handle({
        action: "update",
        id: "BB-EARLY-PIVOT",
        state: "INCONCLUSIVE",
        evidence: ["The identity path produced an ambiguous target oracle before cluster convergence."],
        evidence_refs: ["raw/evidence/BB-EARLY-PIVOT.json"],
        blocker: "The response did not distinguish identity binding from session refresh.",
        next_step: "Repeat only if a later portfolio convergence makes this boundary strategically relevant.",
        reason: "The early structural path did not yet produce a conclusive verdict.",
      })
      await registry.handle(bountyHypothesis("BB-NEG-1", dominant))
      await registry.handle(bountyHypothesis("BB-NEG-2", dominant))
      expect(await disprove(registry, "BB-NEG-1")).not.toHaveProperty("convergence")
      expect(await disprove(registry, "BB-NEG-2")).toMatchObject({
        convergence: {
          cluster: "object-authorization",
          negative_hypothesis_ids: ["BB-NEG-1", "BB-NEG-2"],
        },
      })

      await registry.handle(bountyHypothesis("BB-SAME-3", dominant))
      await expect(registry.handle({ action: "claim", id: "BB-SAME-3" })).resolves.toMatchObject({
        state: "TESTING",
      })
      await registry.handle({
        action: "update",
        id: "BB-SAME-3",
        state: "DISPROVED",
        evidence: ["The third same-cluster discriminator also retained the secure control."],
        evidence_refs: ["raw/evidence/BB-SAME-3.json"],
        reason: "The additional same-cluster test did not reproduce.",
      })

      await expect(
        registry.handle({
          action: "synthesize",
          outcome: "diversified",
          summary: "A same-cluster candidate was incorrectly proposed as a pivot.",
          evidence: ["Three object-authorization variants retained the control."],
          pivots: [
            {
              hypothesis_id: "BB-SAME-3",
              compared_to_hypothesis_ids: ["BB-NEG-1", "BB-NEG-2"],
              changed_dimensions: ["impact_class"],
              distance_rationale: "Only the route changed.",
            },
          ],
        }),
      ).rejects.toThrow("does not differ")
      await expect(
        registry.handle({
          action: "synthesize",
          outcome: "diversified",
          summary: "An invented ID was proposed as a pivot.",
          evidence: ["The proposed pivot is not in the registry."],
          pivots: [
            {
              hypothesis_id: "BB-NOT-THERE",
              compared_to_hypothesis_ids: ["BB-NEG-1", "BB-NEG-2"],
              changed_dimensions: ["boundary"],
              distance_rationale: "Invented pivot.",
            },
          ],
        }),
      ).rejects.toThrow("does not identify")

      await registry.handle({
        action: "synthesize",
        outcome: "diversified",
        summary: "The structurally different identity path was tested too early to resolve later convergence.",
        evidence: ["The identity-service discriminator preceded the second object-authorization negative."],
        pivots: [
          {
            hypothesis_id: "BB-EARLY-PIVOT",
            compared_to_hypothesis_ids: ["BB-NEG-1", "BB-NEG-2"],
            changed_dimensions: ["impact_class", "boundary", "enforcement_owner"],
            distance_rationale: "The impact and enforcing service differ, but this claim predates convergence.",
          },
        ],
      })
      expect(await registry.handoffError("hacker")).toContain("later structural pivot")

      await registry.handle(
        bountyHypothesis(
          "BB-PIVOT",
          bountyContext({
            cluster: "object-authorization",
            impact: "account takeover",
            boundary: "identity binding",
            enforcementOwner: "identity service",
          }),
        ),
      )
      await disprove(registry, "BB-PIVOT")
      expect(await registry.handoffError("hacker")).toContain("later structural pivot")
      await registry.handle({
        action: "synthesize",
        outcome: "diversified",
        summary: "Pivoted from resource authorization to identity binding while retaining the declared causal cluster.",
        evidence: ["The identity-service discriminator exercised a different enforcement boundary."],
        pivots: [
          {
            hypothesis_id: "BB-PIVOT",
            compared_to_hypothesis_ids: ["BB-NEG-1", "BB-NEG-2"],
            changed_dimensions: ["impact_class", "boundary", "enforcement_owner"],
            distance_rationale: "The pivot changes both the account impact and the service enforcing identity.",
          },
        ],
      })
      expect(await registry.handoffError("hacker")).toBeUndefined()
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("accepts portfolio exhaustion only with terminal real hypotheses and target evidence", async () => {
    const workarea = await temporaryWorkarea()
    try {
      await configureRewardPolicy(workarea)
      const registry = new HypothesisRegistry({
        workarea,
        workflow: "bug-bounty",
        phase: "hacker",
        noveltyContract: { required: true, mode: "bounty-portfolio" },
      })
      const context = bountyContext({ cluster: "token-binding" })
      await registry.handle(bountyHypothesis("BB-EXH-1", context))
      await registry.handle(bountyHypothesis("BB-EXH-2", context))
      await disprove(registry, "BB-EXH-1")
      await disprove(registry, "BB-EXH-2")
      await expect(
        registry.handle({
          action: "synthesize",
          outcome: "exhausted",
          summary: "The cluster is exhausted.",
          evidence: ["Both target controls held."],
          exhausted_hypothesis_ids: ["BB-EXH-1", "BB-EXH-2"],
          exhaustion_rationale: "No distinct target oracle remains.",
        }),
      ).rejects.toThrow("evidence_refs")
      await expect(
        registry.handle({
          action: "synthesize",
          outcome: "exhausted",
          summary: "The cluster is exhausted, but the cited evidence is unrelated.",
          evidence: ["Both target controls held."],
          evidence_refs: ["raw/evidence/not-linked.json"],
          exhausted_hypothesis_ids: ["BB-EXH-1", "BB-EXH-2"],
          exhaustion_rationale: "No distinct target oracle remains.",
        }),
      ).rejects.toThrow("linked by its cited hypotheses")
      const synthesis = await registry.handle({
        action: "synthesize",
        outcome: "exhausted",
        summary: "The token-binding cluster is exhausted.",
        evidence: ["Both target-specific token-binding controls held under independent discriminators."],
        evidence_refs: ["raw/evidence/BB-EXH-1.json", "raw/evidence/BB-EXH-2.json"],
        exhausted_hypothesis_ids: ["BB-EXH-1", "BB-EXH-2"],
        exhaustion_rationale: "The two available enforcement paths share no remaining distinct authorized oracle.",
      })
      expect(synthesis).toMatchObject({ outcome: "exhausted", activeBlockingHypotheses: 0 })
      expect(await registry.handoffError("verify")).toBeUndefined()
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("requires explicit blocker evidence when no Bug Bounty hypothesis could be formulated", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({
        workarea,
        workflow: "bug-bounty",
        phase: "recon",
        noveltyContract: { required: true, mode: "bounty-portfolio" },
      })
      await expect(
        registry.handle({
          action: "synthesize",
          outcome: "exhausted",
          summary: "No candidate could be formulated.",
          evidence: ["The authorized target was unreachable throughout the bounded phase."],
          evidence_refs: ["raw/evidence/target-unreachable.json"],
          exhaustion_rationale: "No target behavior was available from which to derive a discriminator.",
        }),
      ).rejects.toThrow("no-candidate evidence references")

      expect(
        await registry.handle({
          action: "synthesize",
          outcome: "exhausted",
          summary: "No candidate could be formulated because the target never became observable.",
          evidence: ["Independent health checks recorded no authorized target response."],
          evidence_refs: ["raw/evidence/target-unreachable.json"],
          no_candidate_evidence_refs: ["raw/evidence/target-unreachable.json"],
          exhaustion_rationale: "The documented target block prevented formulation of a safe vulnerable/secure oracle.",
        }),
      ).toMatchObject({ outcome: "exhausted", activeBlockingHypotheses: 0 })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("rejects portfolio synthesis references from another Bug Bounty phase", async () => {
    const workarea = await temporaryWorkarea()
    try {
      await configureRewardPolicy(workarea)
      const recon = new HypothesisRegistry({
        workarea,
        workflow: "bug-bounty",
        phase: "recon",
        noveltyContract: { required: true, mode: "bounty-portfolio" },
      })
      await recon.handle(bountyHypothesis("BB-RECON-ONLY", bountyContext({ cluster: "recon-cluster" })))
      await disprove(recon, "BB-RECON-ONLY")

      const exploit = new HypothesisRegistry({
        workarea,
        workflow: "bug-bounty",
        phase: "exploit",
        noveltyContract: { required: true, mode: "bounty-portfolio" },
      })
      await exploit.handle(
        bountyHypothesis(
          "BB-EXPLOIT-PIVOT",
          bountyContext({
            cluster: "exploit-cluster",
            impact: "account takeover",
            boundary: "identity binding",
            enforcementOwner: "identity service",
          }),
        ),
      )
      await disprove(exploit, "BB-EXPLOIT-PIVOT")
      await expect(
        exploit.handle({
          action: "synthesize",
          outcome: "diversified",
          summary: "Cross-phase comparison must not satisfy the Exploit portfolio gate.",
          evidence: ["The named comparison belongs to Recon."],
          pivots: [
            {
              hypothesis_id: "BB-EXPLOIT-PIVOT",
              compared_to_hypothesis_ids: ["BB-RECON-ONLY"],
              changed_dimensions: ["impact_class"],
              distance_rationale: "The impact differs, but the comparison is phase-ineligible.",
            },
          ],
        }),
      ).rejects.toThrow("owned by bug-bounty/exploit")
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("advertises TESTING as an ordinary update before executed dispositions", () => {
    const alternatives = HYPOTHESIS_TOOL_DEF.inputSchema.oneOf as ReadonlyArray<{
      readonly properties?: { readonly state?: { readonly enum?: readonly string[] } }
    }>
    expect(alternatives.some((schema) => schema.properties?.state?.enum?.includes("TESTING"))).toBeTrue()
  })

  test("returns typed missing-id and invalid-transition reconciliation context", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      await registry.handle({
        action: "record",
        id: "H-TYPED-1",
        owner: "root",
        description: "A bounded candidate",
        root_cause: "missing check",
        surface: "API",
        discriminator: "controlled differential",
      })
      const missing = await registry.get("H-MISSING").catch((error) => error)
      expect(missing).toBeInstanceOf(HypothesisRegistryError)
      expect((missing as HypothesisRegistryError).toolError({ action: "get" })).toMatchObject({
        code: "HYPOTHESIS_NOT_FOUND",
        revision: 1,
        available_ids: ["H-TYPED-1"],
      })
      const invalid = await registry
        .handle({
          action: "update",
          id: "H-TYPED-1",
          state: "CONFIRMED",
          finding_id: "F-1",
          evidence: ["x"],
          reason: "x",
        })
        .catch((error) => error)
      expect(invalid).toBeInstanceOf(HypothesisRegistryError)
      expect((invalid as HypothesisRegistryError).toolError({ action: "update" })).toMatchObject({
        code: "HYPOTHESIS_TRANSITION_INVALID",
        current_state: "OPEN",
        requested_state: "CONFIRMED",
      })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })
})
