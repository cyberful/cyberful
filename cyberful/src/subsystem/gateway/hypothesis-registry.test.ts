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
  HYPOTHESIS_REGISTRY_PATH,
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

function oracle() {
  return {
    primary_observation: "The target's direct response to the controlled differential.",
    positive_condition: "The tested effect occurs only for the positive case.",
    negative_condition: "The target retains the expected control behavior.",
    invalid_condition: "Transport or fixture failure prevents comparison of the cases.",
    controls: ["Repeat the same request without the candidate trigger."],
  }
}

function testResult(
  match: "POSITIVE" | "NEGATIVE" | "INVALID" | "CONFLICT",
  observation: string,
  primaryEvidencePath: string,
  input: { derived?: readonly string[]; conflicts?: readonly string[]; interpretation?: string } = {},
) {
  return {
    match,
    observation,
    primary_evidence_paths: [primaryEvidencePath],
    derived_evidence_paths: input.derived ?? [],
    conflicts: input.conflicts ?? [],
    interpretation: input.interpretation ?? `The primary observation matches the ${match.toLowerCase()} condition.`,
  }
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
    oracle: oracle(),
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
    test_result: testResult(
      "NEGATIVE",
      `${id} retained the secure control under the target-specific differential.`,
      `raw/evidence/${id}.json`,
    ),
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
        oracle: oracle(),
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
        test_result: testResult(
          "POSITIVE",
          "The launch path is reachable and the expected authority guard does not dominate it.",
          "raw/evidence/H-CODE-1.json",
        ),
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
        oracle: oracle(),
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
          test_result: testResult(
            "POSITIVE",
            "A second tenant received the synthetic object's metadata.",
            "raw/evidence/H-LIVE-1.json",
          ),
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
        test_result: testResult(
          "POSITIVE",
          "A second tenant received the synthetic object's metadata.",
          "raw/evidence/H-LIVE-1.json",
        ),
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
        test_result: testResult(
          "NEGATIVE",
          "The repeated differential no longer reproduces under the same controls.",
          "raw/evidence/H-LIVE-1-retest.json",
        ),
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
        oracle: oracle(),
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
        test_result: testResult(
          "POSITIVE",
          "The second tenant received the synthetic object.",
          "raw/evidence/one.json",
        ),
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

  test("enforces the complete oracle-match matrix for executed dispositions", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      const states = ["SUSPECTED", "CONFIRMED", "DISPROVED", "INCONCLUSIVE"] as const
      const matches = ["POSITIVE", "NEGATIVE", "INVALID", "CONFLICT"] as const
      for (const disposition of states) {
        for (const match of matches) {
          const id = `H-MATRIX-${disposition}-${match}`
          await registry.handle({
            action: "record",
            id,
            owner: "root",
            description: `${disposition} with ${match}`,
            root_cause: "controlled matrix candidate",
            surface: "test boundary",
            discriminator: "compare the direct target observation with the declared conditions",
            oracle: oracle(),
          })
          await registry.handle({ action: "claim", id })
          const observation = `${id} produced a direct observation.`
          const update = registry.handle({
            action: "update",
            id,
            state: disposition,
            ...(disposition === "SUSPECTED" || disposition === "CONFIRMED" ? { finding_id: `F-${id}` } : {}),
            ...(disposition === "INCONCLUSIVE"
              ? { blocker: "The result does not resolve the oracle.", next_step: "Repeat with a valid control." }
              : {}),
            test_result: testResult(match, observation, `raw/evidence/${id}.json`, {
              conflicts: match === "CONFLICT" ? ["Primary and derived evidence disagree."] : [],
            }),
            reason: `${disposition} is evaluated against ${match}.`,
          })
          const allowed =
            ((disposition === "SUSPECTED" || disposition === "CONFIRMED") && match === "POSITIVE") ||
            (disposition === "DISPROVED" && match === "NEGATIVE") ||
            (disposition === "INCONCLUSIVE" && (match === "INVALID" || match === "CONFLICT"))
          if (allowed) await expect(update).resolves.toMatchObject({ state: disposition })
          else await expect(update).rejects.toThrow("test_result")
        }
      }
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("fills a legacy oracle at claim and keeps it immutable once testing starts", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      await registry.handle({
        action: "record",
        id: "H-LEGACY-ORACLE",
        owner: "root",
        description: "A legacy hypothesis without an oracle",
        root_cause: "legacy registry shape",
        surface: "legacy boundary",
        discriminator: "controlled differential",
        oracle: oracle(),
      })
      const registryPath = path.join(workarea, HYPOTHESIS_REGISTRY_PATH)
      const persisted = (await Bun.file(registryPath).json()) as { hypotheses: Array<{ oracle?: unknown }> }
      delete persisted.hypotheses[0]!.oracle
      await Bun.write(registryPath, `${JSON.stringify(persisted, null, 2)}\n`)

      await expect(registry.handle({ action: "claim", id: "H-LEGACY-ORACLE" })).rejects.toThrow(
        "requires oracle",
      )
      await expect(
        registry.handle({ action: "claim", id: "H-LEGACY-ORACLE", oracle: oracle() }),
      ).resolves.toMatchObject({ state: "TESTING", oracle: oracle() })
      await expect(
        registry.handle({
          action: "claim",
          id: "H-LEGACY-ORACLE",
          oracle: { ...oracle(), positive_condition: "A different positive condition." },
        }),
      ).rejects.toThrow("immutable")
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("preserves primary and derived CyberGym evidence when their interpretations disagree", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      for (const id of ["H-CYBERGYM-RESOLVED", "H-CYBERGYM-UNRESOLVED"]) {
        await registry.handle({
          action: "record",
          id,
          owner: "root",
          description: `${id} malformed-input experiment may trigger undefined behavior`,
          root_cause: "unchecked parser state",
          surface: "native parser",
          discriminator: "direct target exit and sanitizer output under the malformed fixture",
          oracle: oracle(),
        })
        await registry.handle({ action: "claim", id })
      }

      const observation = "The target returned exit_code 1 and emitted a UBSan diagnostic for the candidate input."
      const primaryPath = "raw/cybergym/submission.json"
      const derivedPath = "raw/classifiers/crash-verdict.json"
      const conflict = "The derived classifier returned INCONCLUSIVE despite the direct exit code and UBSan output."
      const resolved = await registry.handle({
        action: "update",
        id: "H-CYBERGYM-RESOLVED",
        state: "SUSPECTED",
        finding_id: "F-CYBERGYM-RESOLVED",
        test_result: testResult("POSITIVE", observation, primaryPath, {
          derived: [derivedPath],
          conflicts: [conflict],
          interpretation:
            "The raw target response satisfies the declared positive condition; the classifier is retained as conflicting derived evidence but does not replace the primary observation.",
        }),
        reason: "The declared target-level oracle is positive.",
      })
      expect(resolved).toMatchObject({
        evidence_refs: [primaryPath, derivedPath],
        transitions: [
          {},
          {},
          {
            test_result: {
              match: "POSITIVE",
              primary_evidence_paths: [primaryPath],
              derived_evidence_paths: [derivedPath],
              conflicts: [conflict],
            },
          },
        ],
      })

      await expect(
        registry.handle({
          action: "update",
          id: "H-CYBERGYM-UNRESOLVED",
          state: "INCONCLUSIVE",
          blocker: "The evidence conflict has not been resolved against the declared oracle.",
          next_step: "Inspect the raw runner and target process observations independently.",
          test_result: testResult("CONFLICT", observation, primaryPath, {
            derived: [derivedPath],
            interpretation: "The available evidence disagrees and no source has yet resolved the oracle.",
          }),
          reason: "The unresolved primary-versus-derived disagreement remains inconclusive.",
        }),
      ).rejects.toThrow("explicit conflict")

      await expect(
        registry.handle({
          action: "update",
          id: "H-CYBERGYM-UNRESOLVED",
          state: "INCONCLUSIVE",
          blocker: "The evidence conflict has not been resolved against the declared oracle.",
          next_step: "Inspect the raw runner and target process observations independently.",
          test_result: testResult("CONFLICT", observation, primaryPath, {
            derived: [derivedPath],
            conflicts: [conflict],
            interpretation: "The available evidence disagrees and no source has yet resolved the oracle.",
          }),
          reason: "The unresolved primary-versus-derived disagreement remains inconclusive.",
        }),
      ).resolves.toMatchObject({ state: "INCONCLUSIVE" })
    } finally {
      await rm(workarea, { recursive: true, force: true })
    }
  })

  test("rejects unsafe primary and derived evidence paths", async () => {
    const workarea = await temporaryWorkarea()
    try {
      const registry = new HypothesisRegistry({ workarea, workflow: "pentest", phase: "exploit" })
      await registry.handle({
        action: "record",
        id: "H-UNSAFE-PATH",
        owner: "root",
        description: "Evidence paths must remain inside the workarea",
        root_cause: "unsafe evidence reference",
        surface: "evidence boundary",
        discriminator: "validate the evidence path before recording the result",
        oracle: oracle(),
      })
      await registry.handle({ action: "claim", id: "H-UNSAFE-PATH" })
      for (const unsafePath of ["/tmp/result.json", "../result.json", "raw/../result.json", "raw//result.json"]) {
        await expect(
          registry.handle({
            action: "update",
            id: "H-UNSAFE-PATH",
            state: "DISPROVED",
            test_result: testResult("NEGATIVE", "The control held.", unsafePath),
            reason: "The control held.",
          }),
        ).rejects.toThrow("safe workarea-relative path")
      }
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
        oracle: oracle(),
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
        oracle: oracle(),
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
        test_result: testResult(
          "NEGATIVE",
          "The parser rejected every controlled malformed fixture before interpretation.",
          "raw/evidence/H-OWN-2.json",
        ),
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
        oracle: oracle(),
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
        oracle: oracle(),
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
          oracle: oracle(),
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
        test_result: testResult(
          "INVALID",
          "The identity path produced an ambiguous target oracle before cluster convergence.",
          "raw/evidence/BB-EARLY-PIVOT.json",
        ),
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
        test_result: testResult(
          "NEGATIVE",
          "The third same-cluster discriminator also retained the secure control.",
          "raw/evidence/BB-SAME-3.json",
        ),
        reason: "The additional same-cluster test did not reproduce.",
      })

      await expect(
        registry.handle({
          action: "synthesize",
          outcome: "diversified",
          summary: "The portfolio changed boundary but omitted its stopping rationale.",
          evidence: ["A distinct identity-service discriminator was already exercised."],
        }),
      ).rejects.toThrow("opportunity_closeout")

      await expect(
        registry.handle({
          action: "synthesize",
          outcome: "diversified",
          summary: "A same-cluster candidate was incorrectly proposed as a pivot.",
          evidence: ["Three object-authorization variants retained the control."],
          opportunity_closeout: "No untested route variant changes the impact or enforcing service.",
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
          opportunity_closeout: "The remaining named opportunity must resolve to a real hypothesis.",
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
        opportunity_closeout: "A later post-convergence pivot remains available and must still be exercised.",
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
        opportunity_closeout: "Remaining route variants share the tested enforcement owners and cannot change impact.",
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
          opportunity_closeout: "No distinct authorized token-binding discriminator remains.",
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
          opportunity_closeout: "No distinct authorized token-binding discriminator remains.",
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
        opportunity_closeout: "All authorized token-binding oracles are terminal; stronger tests require new authority.",
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
          opportunity_closeout: "Target unreachability blocks every authorized discriminator.",
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
          opportunity_closeout: "No reward path can be tested until the authorized target becomes observable.",
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
          opportunity_closeout: "The proposed comparison is not an Exploit-owned opportunity.",
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
        oracle: oracle(),
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
          test_result: testResult("POSITIVE", "x", "raw/evidence/H-TYPED-1.json"),
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
