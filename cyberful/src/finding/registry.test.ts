// ── Workarea Finding Registry Tests ──────────────────────────────
// Protects durable cross-run finding history, transition validation, atomic
//   concurrency, and the canonical workarea file boundary.
// → cyberful/src/finding/registry.ts — owns the tested registry.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { chmod, mkdtemp, readFile, realpath, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { expect, test } from "bun:test"
import { FindingRegistry } from "./registry"

async function workarea() {
  const root = await mkdtemp(path.join(tmpdir(), "cyberful-findings-"))
  await chmod(root, 0o700)
  return realpath(root)
}

function context(runID: string, phase = "exploit") {
  return { runID, workflow: "pentest" as const, phase }
}

test("persists one stable finding across runs without promoting historical proof", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  await store.startRun({ id: "ses_first", workflow: "pentest" })
  const recorded = await store.execute(
    {
      action: "record",
      key: "AUTH-1",
      title: "Replayable assertion",
      positive_evidence: "The same signed assertion reached the callback twice.",
      summary: "Replay signal observed.",
      severity: "HIGH",
      evidence_paths: ["raw/auth/replay.json"],
    },
    context("ses_first"),
  )
  expect(recorded).toMatchObject({ aliases: ["AUTH-1"], observations: [{ runID: "ses_first" }] })
  await store.finishRun({ id: "ses_first", status: "COMPLETED" })

  await store.startRun({ id: "ses_second", workflow: "pentest" })
  const before = await store.list("ses_second")
  expect(before).toHaveLength(1)
  expect(before[0]?.historical).toBe(true)
  expect(before[0]?.currentRun).toBeUndefined()

  await store.execute(
    { action: "revisit", id: "AUTH-1", plan: "Replay with a fresh browser.", summary: "Re-test started." },
    context("ses_second", "recon"),
  )
  const after = await store.get("AUTH-1")
  expect(after?.observations.map((item) => item.runID)).toEqual(["ses_first", "ses_second"])
  expect(after?.observations.at(-1)).toMatchObject({
    review: "IN_REVIEW",
    carriedState: "SUSPECTED",
  })
})

test("serializes concurrent records without losing either revision", async () => {
  const root = await workarea()
  const first = new FindingRegistry.Store(root, { workarea: "target" })
  const second = new FindingRegistry.Store(root, { workarea: "target" })
  await first.startRun({ id: "ses_run", workflow: "pentest" })
  await Promise.all([
    first.execute(
      {
        action: "record",
        key: "A-1",
        title: "First",
        positive_evidence: "Positive target evidence for the first finding.",
        severity: "HIGH",
      },
      context("ses_run"),
    ),
    second.execute(
      {
        action: "record",
        key: "B-1",
        title: "Second",
        positive_evidence: "Positive target evidence for the second finding.",
        severity: "LOW",
      },
      context("ses_run"),
    ),
  ])
  const registry = await first.read()
  expect(registry.findings.map((item) => item.aliases[0]).toSorted()).toEqual(["A-1", "B-1"])
  expect(registry.revision).toBe(3)
  await expect(first.execute({ action: "alias", id: "A-1", alias: "B-1" }, context("ses_run"))).rejects.toThrow(
    "already belongs",
  )
})

test("requires explicit supported transitions and allows disproved findings to reopen", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  await store.startRun({ id: "ses_run", workflow: "pentest" })
  await expect(
    store.execute(
      { action: "record", key: "UNRATED-1", title: "Missing rating", positive_evidence: "A real signal." },
      context("ses_run"),
    ),
  ).rejects.toThrow("severity")
  await store.execute(
    {
      action: "record",
      key: "AUTH-1",
      title: "Replay",
      positive_evidence: "A repeatable callback signal.",
      severity: "HIGH",
    },
    context("ses_run"),
  )
  await store.execute(
    {
      action: "update",
      id: "AUTH-1",
      state: "DISPROVED",
      disproof: "The control reproduced the same behavior.",
      summary: "Benign control explained the signal.",
    },
    context("ses_run"),
  )
  await expect(
    store.execute(
      {
        action: "update",
        id: "AUTH-1",
        state: "CONFIRMED",
        proof: "Direct effect.",
        summary: "Unexpected direct confirmation.",
      },
      context("ses_run"),
    ),
  ).rejects.toThrow("cannot transition from DISPROVED to CONFIRMED")
  await store.execute(
    {
      action: "update",
      id: "AUTH-1",
      state: "SUSPECTED",
      positive_evidence: "A product change introduced a distinct signal.",
      summary: "Reopened after new evidence.",
    },
    context("ses_run"),
  )
  expect((await store.get("AUTH-1"))?.observations.at(-1)).toMatchObject({
    disposition: { state: "SUSPECTED" },
  })
  await store.execute(
    {
      action: "update",
      id: "AUTH-1",
      state: "CONFIRMED",
      proof: "The distinct signal now produces a repeatable security effect.",
      summary: "Confirmed after reopening.",
    },
    context("ses_run", "verify"),
  )
  await store.execute(
    {
      action: "update",
      id: "AUTH-1",
      state: "UNTESTABLE",
      blocker_kind: "TOOL_UNAVAILABLE",
      blocker_reason: "The independent verification environment is unavailable.",
      next_step: "Repeat the control when the independent environment is restored.",
      summary: "The prior confirmation cannot currently be independently reproduced.",
      verification: "DEMOTE",
      verification_rationale: "Independent verification could not execute.",
    },
    context("ses_run", "verify"),
  )
  expect((await store.get("AUTH-1"))?.observations.at(-1)).toMatchObject({
    disposition: { state: "UNTESTABLE" },
    severity: "HIGH",
    verification: { result: "DEMOTE" },
  })
})

test("returns typed reconciliation context for missing ids and invalid decisions", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  await store.startRun({ id: "ses_typed", workflow: "pentest" })
  const missing = await store.get("MISSING").catch((error) => error)
  expect(missing).toBeInstanceOf(FindingRegistry.FindingRegistryError)
  expect((missing as FindingRegistry.FindingRegistryError).toolError({ action: "get" })).toMatchObject({
    code: "FINDING_NOT_FOUND",
    revision: 1,
    available_ids: [],
  })
  const invalid = await store
    .execute(
      {
        action: "record",
        key: "AUTH-TYPED",
        title: "Typed decision",
        positive_evidence: "A bounded positive signal.",
        severity: "MEDIUM",
        verification: "SURVIVES",
        verification_rationale: "Requested too early.",
      },
      context("ses_typed"),
    )
    .catch((error) => error)
  expect(invalid).toBeInstanceOf(FindingRegistry.FindingRegistryError)
  expect((invalid as FindingRegistry.FindingRegistryError).toolError({ action: "record" })).toMatchObject({
    code: "FINDING_TRANSITION_INVALID",
    path: "finding.verification",
    current_state: "SUSPECTED",
    requested_state: "SURVIVES",
    allowed_states: ["CONFIRMED"],
  })
})

test("refuses unsafe evidence paths and does not overwrite invalid or linked registries", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  await store.startRun({ id: "ses_run", workflow: "pentest" })
  await expect(
    store.execute(
      {
        action: "record",
        key: "A-1",
        title: "Unsafe",
        positive_evidence: "Positive evidence.",
        severity: "HIGH",
        evidence_paths: ["../outside"],
      },
      context("ses_run"),
    ),
  ).rejects.toThrow("safe workarea-relative")

  const registryPath = path.join(root, FindingRegistry.REGISTRY_PATH)
  const original = await readFile(registryPath, "utf8")
  const unknownVersion = { ...JSON.parse(original), schema_version: 2 }
  await Bun.write(registryPath, JSON.stringify(unknownVersion))
  await expect(store.read()).rejects.toThrow()
  expect(JSON.parse(await readFile(registryPath, "utf8"))).toMatchObject({ schema_version: 2 })

  await Bun.write(registryPath, "{")
  await expect(store.read()).rejects.toThrow("invalid JSON")
  expect(await readFile(registryPath, "utf8")).toBe("{")

  await Bun.write(registryPath, original)
  const outside = path.join(await workarea(), "registry.json")
  await Bun.write(outside, original)
  await Bun.file(registryPath).delete()
  await symlink(outside, registryPath)
  await expect(store.read()).rejects.toThrow("regular file")
  expect((await stat(outside)).isFile()).toBe(true)
})

test("writes the registry with owner-only permissions", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  await store.startRun({ id: "ses_run", workflow: "pentest" })
  expect((await stat(path.join(root, FindingRegistry.REGISTRY_PATH))).mode & 0o777).toBe(0o600)
  expect((await stat(path.dirname(path.join(root, FindingRegistry.REGISTRY_PATH)))).isDirectory()).toBe(true)
})

test("imports existing Code Graph findings as history and mirrors later Verify decisions", async () => {
  const root = await workarea()
  const store = new FindingRegistry.Store(root, { workarea: "target" })
  await store.startRun({ id: "ses_current", workflow: "code-audit" })
  await store.syncCodeGraph(
    [],
    { runID: "ses_current", workflow: "code-audit", phase: "legacy-import" },
    { historical: true },
  )
  expect((await store.read()).runs.map((run) => run.id)).toEqual(["ses_current"])
  const base = {
    id: "a".repeat(64),
    title: "Unsafe authorization",
    weakness: "CWE-862",
    severity: "high" as const,
    confidence: "high" as const,
    evidence: [{ description: "A privileged sink is reachable without the expected guard." }],
  }
  await store.syncCodeGraph(
    [{ ...base, status: "suspected", updatedAt: "2026-01-01T00:00:00.000Z" }],
    { runID: "ses_current", workflow: "code-audit", phase: "hunt" },
    { historical: true },
  )
  expect((await store.list("ses_current"))[0]).toMatchObject({ historical: true })

  await store.syncCodeGraph(
    [
      {
        ...base,
        status: "dismissed",
        updatedAt: "2026-01-02T00:00:00.000Z",
        transitionReason: "The caller always applies the guard.",
      },
    ],
    { runID: "ses_current", workflow: "code-audit", phase: "verify" },
  )
  const finding = await store.get(base.id)
  expect(finding?.origin).toEqual({ workflow: "code-audit", source: "code-graph", sourceID: base.id })
  expect(finding?.observations.map((item) => item.runID)).toEqual(["legacy:code-graph", "ses_current"])
  expect(finding?.observations.at(-1)).toMatchObject({
    disposition: { state: "DISPROVED" },
    verification: { result: "DEMOTE" },
  })
})
