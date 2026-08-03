// ── Host-Owned Handoff Snapshot ──────────────────────────────────
// Captures finding and hypothesis registries as separate phase-boundary
//   authorities and binds their stable revisions to one integrity digest.
// → cyberful/src/subsystem/gateway/server.ts — seals the snapshot before accepting handoff.
// → cyberful/src/subsystem/phase-runner.ts — validates the sealed snapshot after shutdown.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import { FindingRegistry } from "@/finding/registry"
import type { Hypothesis, HypothesisState } from "./gateway/hypothesis-registry"

const MAX_SNAPSHOT_ATTEMPTS = 3

export interface FindingVerdictSnapshot {
  readonly id: string
  readonly state: FindingRegistry.TechnicalState
}

export interface HypothesisVerdictSnapshot {
  readonly id: string
  readonly state: HypothesisState
  readonly findingID?: string
}

export interface HandoffSnapshotV2 {
  readonly version: 2
  readonly findingRegistryRevision: number
  readonly hypothesisRegistryRevision: number
  readonly findings: readonly FindingVerdictSnapshot[]
  readonly hypotheses: readonly HypothesisVerdictSnapshot[]
  readonly counts: {
    readonly findings: Readonly<Record<FindingRegistry.TechnicalState, number>>
    readonly hypotheses: Readonly<Record<HypothesisState, number>>
  }
  readonly digestSha256: string
}

export interface HypothesisSnapshotSource {
  snapshot(): Promise<{
    readonly revision: number
    readonly hypotheses: readonly Hypothesis[]
  }>
}

export class HandoffSnapshotError extends Error {
  readonly code: "HANDOFF_RECONCILIATION_FAILED" | "HANDOFF_SNAPSHOT_UNSTABLE"
  readonly ids: readonly string[]

  constructor(
    code: HandoffSnapshotError["code"],
    message: string,
    ids: readonly string[] = [],
  ) {
    super(message)
    this.name = "HandoffSnapshotError"
    this.code = code
    this.ids = ids
  }
}

const findingStates = ["SUSPECTED", "INCONCLUSIVE", "UNTESTABLE", "CONFIRMED", "DISPROVED"] as const
const hypothesisStates = [
  "OPEN",
  "QUEUED",
  "TESTING",
  "SUSPECTED",
  "CONFIRMED",
  "DISPROVED",
  "INCONCLUSIVE",
  "UNTESTABLE",
] as const

function countStates<const State extends string>(
  states: readonly State[],
  entries: readonly { readonly state: State }[],
): Readonly<Record<State, number>> {
  return Object.fromEntries(
    states.map((state) => [state, entries.filter((entry) => entry.state === state).length]),
  ) as Record<State, number>
}

function snapshotDigest(snapshot: Omit<HandoffSnapshotV2, "digestSha256">) {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
}

function currentFindings(registry: FindingRegistry.Registry, runID: string) {
  return registry.findings.flatMap((finding) => {
    const observation = finding.observations.findLast((candidate) => candidate.runID === runID)
    if (!observation) return []
    if (observation.review !== "ASSESSED")
      throw new HandoffSnapshotError(
        "HANDOFF_RECONCILIATION_FAILED",
        `Current finding '${finding.id}' has not been assessed.`,
        [finding.id],
      )
    return [{ id: finding.id, state: observation.disposition.state }]
  })
}

// ── Positive Hypotheses Resolve Into Finding Authority ───────────
// A finding and a hypothesis describe different facts: a durable observed issue
// can remain valid even when a narrower impact or bypass hypothesis is disproved.
// Only positive hypotheses therefore require a same-state finding link. The
// inverse is deliberately not required, preventing legitimate observations from
// disappearing merely because a distinct exploit hypothesis closed negatively.
//
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────
function validatePositiveLinks(
  findings: readonly FindingVerdictSnapshot[],
  hypotheses: readonly HypothesisVerdictSnapshot[],
) {
  const findingByID = new Map(findings.map((finding) => [finding.id, finding]))
  const invalid = hypotheses.filter((hypothesis) => {
    if (hypothesis.state !== "SUSPECTED" && hypothesis.state !== "CONFIRMED") return false
    if (!hypothesis.findingID) return true
    return findingByID.get(hypothesis.findingID)?.state !== hypothesis.state
  })
  if (invalid.length === 0) return
  throw new HandoffSnapshotError(
    "HANDOFF_RECONCILIATION_FAILED",
    `Positive hypotheses must link to current findings in the same state: ${invalid.map((item) => item.id).join(", ")}.`,
    invalid.map((item) => item.id),
  )
}

function buildSnapshot(input: {
  readonly findingRegistry: FindingRegistry.Registry
  readonly hypothesisRevision: number
  readonly hypotheses: readonly Hypothesis[]
  readonly runID: string
}): HandoffSnapshotV2 {
  const findings = currentFindings(input.findingRegistry, input.runID).toSorted((left, right) =>
    left.id.localeCompare(right.id),
  )
  const hypotheses = input.hypotheses
    .map((hypothesis) => ({
      id: hypothesis.id,
      state: hypothesis.state,
      ...(hypothesis.finding_id ? { findingID: hypothesis.finding_id } : {}),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id))
  validatePositiveLinks(findings, hypotheses)
  const unsigned = {
    version: 2,
    findingRegistryRevision: input.findingRegistry.revision,
    hypothesisRegistryRevision: input.hypothesisRevision,
    findings,
    hypotheses,
    counts: {
      findings: countStates(findingStates, findings),
      hypotheses: countStates(hypothesisStates, hypotheses),
    },
  } satisfies Omit<HandoffSnapshotV2, "digestSha256">
  return { ...unsigned, digestSha256: snapshotDigest(unsigned) }
}

// ── Cross-Registry Reads Must Stabilize Before Acceptance ────────
// Finding writes use a cross-process lock while hypotheses use the phase gateway's
// serialized writer, so no shared transaction spans both files. The handoff reads
// both revisions twice and accepts only a stable pair. A bounded retry handles a
// final concurrent update without waiting indefinitely; continued mutation remains
// a recoverable handoff error and leaves the phase owner alive.
// ─────────────────────────────────────────────────────────────────
export async function createHandoffSnapshot(input: {
  readonly findings: FindingRegistry.Store
  readonly hypotheses: HypothesisSnapshotSource
  readonly runID: string
}) {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS; attempt++) {
    const [findingBefore, hypothesisBefore] = await Promise.all([
      input.findings.read(),
      input.hypotheses.snapshot(),
    ])
    const [findingAfter, hypothesisAfter] = await Promise.all([
      input.findings.read(),
      input.hypotheses.snapshot(),
    ])
    if (
      findingBefore.revision === findingAfter.revision &&
      hypothesisBefore.revision === hypothesisAfter.revision
    )
      return buildSnapshot({
        findingRegistry: findingAfter,
        hypothesisRevision: hypothesisAfter.revision,
        hypotheses: hypothesisAfter.hypotheses,
        runID: input.runID,
      })
  }
  throw new HandoffSnapshotError(
    "HANDOFF_SNAPSHOT_UNSTABLE",
    "Finding or hypothesis state changed while handoff was being prepared; retry after outstanding work settles.",
  )
}

export function parseHandoffSnapshot(value: unknown): HandoffSnapshotV2 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== 2 ||
    typeof candidate.findingRegistryRevision !== "number" ||
    typeof candidate.hypothesisRegistryRevision !== "number" ||
    !Array.isArray(candidate.findings) ||
    !Array.isArray(candidate.hypotheses) ||
    typeof candidate.counts !== "object" ||
    candidate.counts === null ||
    typeof candidate.digestSha256 !== "string"
  )
    return
  const findings = candidate.findings.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    if (
      typeof item.id !== "string" ||
      typeof item.state !== "string" ||
      !findingStates.includes(item.state as FindingRegistry.TechnicalState)
    )
      return []
    return [{ id: item.id, state: item.state as FindingRegistry.TechnicalState }]
  })
  const hypotheses = candidate.hypotheses.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return []
    const item = entry as Record<string, unknown>
    if (
      typeof item.id !== "string" ||
      typeof item.state !== "string" ||
      !hypothesisStates.includes(item.state as HypothesisState) ||
      (item.findingID !== undefined && typeof item.findingID !== "string")
    )
      return []
    return [
      {
        id: item.id,
        state: item.state as HypothesisState,
        ...(typeof item.findingID === "string" ? { findingID: item.findingID } : {}),
      },
    ]
  })
  if (findings.length !== candidate.findings.length || hypotheses.length !== candidate.hypotheses.length) return
  const unsigned = {
    version: 2,
    findingRegistryRevision: candidate.findingRegistryRevision,
    hypothesisRegistryRevision: candidate.hypothesisRegistryRevision,
    findings,
    hypotheses,
    counts: candidate.counts as HandoffSnapshotV2["counts"],
  } satisfies Omit<HandoffSnapshotV2, "digestSha256">
  if (snapshotDigest(unsigned) !== candidate.digestSha256) return
  try {
    validatePositiveLinks(findings, hypotheses)
  } catch {
    return
  }
  return { ...unsigned, digestSha256: candidate.digestSha256 }
}

export * as SubsystemHandoffSnapshot from "./handoff-snapshot"
