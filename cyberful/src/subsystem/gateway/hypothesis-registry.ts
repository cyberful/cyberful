// ── Cross-Workflow Hypothesis Registry ──────────────────────────
// Persists investigation questions and their lifecycle once per workarea so
//   Pentest, Bug Bounty, and Code Audit phases share one durable backlog, while
//   Bug Bounty research adds official reward context and portfolio convergence.
// → cyberful/src/subsystem/gateway/server.ts — exposes the phase-scoped tool and handoff gate.
// → cyberful/src/finding/registry.ts — remains the separate authority for reportable findings.
// @docs/concepts/execution-model.md
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isRecord } from "@/util/record"
import { replaceWorkareaFile } from "@/workarea"
import { BLOCKER_REASONS, type BlockerReason } from "../verdict"
import type { Contract as NoveltyContract } from "../novelty"
import { readRewardPolicy, type RewardPolicyKind, type RewardSeverity } from "./reward-policy"

export const HYPOTHESIS_REGISTRY_PATH = "raw/hypotheses/registry.json"

const STATES = [
  "OPEN",
  "QUEUED",
  "TESTING",
  "SUSPECTED",
  "CONFIRMED",
  "DISPROVED",
  "INCONCLUSIVE",
  "UNTESTABLE",
] as const
export type HypothesisState = (typeof STATES)[number]
const ACTIVE_HYPOTHESIS_STATES = ["OPEN", "QUEUED", "TESTING", "SUSPECTED"] as const
const EXECUTED_DISPOSITIONS = ["SUSPECTED", "CONFIRMED", "DISPROVED", "INCONCLUSIVE"] as const
const ORACLE_MATCHES = ["POSITIVE", "NEGATIVE", "INVALID", "CONFLICT"] as const
const TERMINAL_PORTFOLIO_STATES = ["SUSPECTED", "CONFIRMED", "DISPROVED", "INCONCLUSIVE", "UNTESTABLE"] as const
const TEST_COSTS = ["LOW", "MEDIUM", "HIGH"] as const
const REWARD_GROUP_STATUSES = ["MAPPED", "UNRESOLVED", "NOT_APPLICABLE"] as const
const REWARD_SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const
const PIVOT_DIMENSIONS = ["impact_class", "boundary", "enforcement_owner"] as const
const OMISSION_REASONS = [
  "not_discovered",
  "not_loaded",
  "selection_error",
  "tool_failure",
  "timeout",
  "policy_scope",
  "contention",
  "budget",
  "duplicate_capability",
  "not_needed",
] as const
type OmissionReason = (typeof OMISSION_REASONS)[number]

export interface HypothesisOracle {
  readonly primary_observation: string
  readonly positive_condition: string
  readonly negative_condition: string
  readonly invalid_condition: string
  readonly controls: readonly string[]
}

export type HypothesisOracleMatch = (typeof ORACLE_MATCHES)[number]

export interface HypothesisTestResult {
  readonly match: HypothesisOracleMatch
  readonly observation: string
  readonly primary_evidence_paths: readonly string[]
  readonly derived_evidence_paths: readonly string[]
  readonly conflicts: readonly string[]
  readonly interpretation: string
}

interface ScopeResolution {
  readonly exact_action: string
  readonly asset: string
  readonly required_rule: string
  readonly sources_checked: readonly string[]
  readonly ambiguity: string
  readonly resolution_attempt: string
  readonly next_step: string
}

interface Transition {
  readonly time_iso: string
  readonly revision?: number
  readonly phase: string
  readonly owner: string
  readonly from?: HypothesisState
  readonly to: HypothesisState
  readonly evidence: readonly string[]
  readonly reason?: string
  readonly test_result?: HypothesisTestResult
}

interface OwnershipTransition {
  readonly time_iso: string
  readonly fromRunID?: string
  readonly toRunID: string
  readonly toDisplayName: string
  readonly toKind: "root" | "subagent" | "fallback"
  readonly reason: "recorded" | "claimed" | "phase_recovery" | "child_finished"
}

type TestCost = (typeof TEST_COSTS)[number]
type RewardGroupStatus = (typeof REWARD_GROUP_STATUSES)[number]
type PivotDimension = (typeof PIVOT_DIMENSIONS)[number]

export interface BountyContext {
  readonly cluster: string
  readonly impact_class: string
  readonly boundary: string
  readonly enforcement_owner: string
  readonly principals: readonly string[]
  readonly objects: readonly string[]
  readonly oracle: {
    readonly vulnerable: string
    readonly secure: string
  }
  readonly test_cost: TestCost
  readonly reward: {
    readonly target_severity: RewardSeverity
    readonly group_status: RewardGroupStatus
    readonly group_id?: string
    readonly rationale: string
    readonly policy_kind: RewardPolicyKind
    readonly policy_revision?: string
  }
}

interface BountyContextHistoryEntry {
  readonly time_iso: string
  readonly phase: string
  readonly reason: string
  readonly context: BountyContext
}

export interface Hypothesis {
  readonly id: string
  readonly fingerprint_sha256: string
  readonly workflow: string
  readonly phase: string
  readonly owner: string
  readonly ownerRunID?: string
  readonly ownerDisplayName?: string
  readonly ownerKind?: "root" | "subagent" | "fallback"
  readonly description: string
  readonly root_cause: string
  readonly surface: string
  readonly discriminator: string
  readonly oracle?: HypothesisOracle
  readonly candidate_tools: readonly string[]
  readonly omitted_tools: ReadonlyArray<{ readonly tool: string; readonly reason: OmissionReason }>
  readonly state: HypothesisState
  readonly evidence: readonly string[]
  readonly evidence_refs: readonly string[]
  readonly blocker?: string
  readonly blocker_reason?: BlockerReason
  readonly next_step?: string
  readonly next_phase?: string
  readonly finding_id?: string
  readonly scope_resolution?: ScopeResolution
  readonly graph_refs: readonly string[]
  readonly transitions: readonly Transition[]
  readonly ownershipTransitions?: readonly OwnershipTransition[]
  readonly bounty_context?: BountyContext
  readonly bounty_context_history?: readonly BountyContextHistoryEntry[]
}

interface SynthesisPivot {
  readonly hypothesis_id: string
  readonly compared_to_hypothesis_ids: readonly string[]
  readonly changed_dimensions: readonly PivotDimension[]
  readonly distance_rationale: string
}

interface Synthesis {
  readonly time_iso: string
  readonly phase: string
  readonly outcome: "diversified" | "exhausted"
  readonly summary: string
  readonly evidence: readonly string[]
  readonly remaining_unknowns: readonly string[]
  readonly opportunity_closeout?: string
  readonly evidence_refs?: readonly string[]
  readonly pivots?: readonly SynthesisPivot[]
  readonly exhausted_hypothesis_ids?: readonly string[]
  readonly exhaustion_rationale?: string
  readonly no_candidate_evidence_refs?: readonly string[]
}

interface Registry {
  readonly version: 1
  readonly revision: number
  readonly updated_at: string
  readonly hypotheses: readonly Hypothesis[]
  readonly syntheses: readonly Synthesis[]
}

export interface HypothesisRegistryView {
  readonly revision: number
  readonly workflow: string
  readonly activeCount: number
  readonly countsByState: Readonly<Record<HypothesisState, number>>
  readonly activeHypotheses: ReadonlyArray<{
    readonly id: string
    readonly phase: string
    readonly owner: string
    readonly ownerDisplayName?: string
    readonly description: string
    readonly rootCause: string
    readonly surface: string
    readonly discriminator: string
    readonly oracle?: HypothesisOracle
    readonly latestTestResult?: HypothesisTestResult
    readonly candidateTools: readonly string[]
    readonly omittedTools: ReadonlyArray<{ readonly tool: string; readonly reason: string }>
    readonly state: HypothesisState
    readonly evidence: readonly string[]
    readonly evidenceRefs: readonly string[]
    readonly blocker?: string
    readonly blockerReason?: string
    readonly nextStep?: string
    readonly nextPhase?: string
    readonly findingID?: string
    readonly graphRefs: readonly string[]
    readonly transitions: ReadonlyArray<{
      readonly time: string
      readonly phase: string
      readonly owner: string
      readonly from?: HypothesisState
      readonly to: HypothesisState
      readonly evidence: readonly string[]
      readonly reason?: string
      readonly testResult?: HypothesisTestResult
    }>
  }>
}

interface HostActor {
  readonly runID: string
  readonly displayName: string
  readonly kind: "root" | "subagent" | "fallback"
}

export class HypothesisRegistryError extends Error {
  readonly path = "hypothesis"
  readonly retryable = true

  constructor(
    readonly code: "HYPOTHESIS_NOT_FOUND" | "HYPOTHESIS_TRANSITION_INVALID" | "HYPOTHESIS_OWNED",
    message: string,
    readonly context: {
      readonly revision: number
      readonly currentState?: string
      readonly requestedState?: string
      readonly allowedStates?: readonly string[]
      readonly availableIDs?: readonly string[]
      readonly ownerRunID?: string
      readonly allowedActions?: readonly string[]
      readonly recoveryCalls?: readonly Readonly<Record<string, unknown>>[]
    },
  ) {
    super(message)
    this.name = "HypothesisRegistryError"
  }

  toolError(received: unknown) {
    return {
      code: this.code,
      path: this.path,
      expected: "an existing hypothesis id and a permitted advertised state transition",
      receivedType: Array.isArray(received) ? "array" : received === null ? "null" : typeof received,
      retryable: this.retryable,
      hint: this.message,
      revision: this.context.revision,
      ...(this.context.currentState ? { current_state: this.context.currentState } : {}),
      ...(this.context.requestedState ? { requested_state: this.context.requestedState } : {}),
      ...(this.context.allowedStates ? { allowed_states: this.context.allowedStates } : {}),
      ...(this.context.availableIDs ? { available_ids: this.context.availableIDs } : {}),
      ...(this.context.ownerRunID ? { owner_run_id: this.context.ownerRunID } : {}),
      ...(this.context.allowedActions ? { allowed_actions: this.context.allowedActions } : {}),
      recovery_calls:
        this.context.recoveryCalls ??
        (this.code === "HYPOTHESIS_NOT_FOUND"
          ? [{ action: "list" }]
          : [{ action: "get", id: "<hypothesis-id>" }]),
    }
  }
}

function missingHypothesis(registry: Registry, id: string) {
  return new HypothesisRegistryError("HYPOTHESIS_NOT_FOUND", `hypothesis '${id}' does not exist`, {
    revision: registry.revision,
    availableIDs: registry.hypotheses.map((item) => item.id).slice(0, 50),
  })
}

function invalidHypothesisTransition(
  registry: Registry,
  previous: Hypothesis,
  requestedState: string,
  allowedStates: readonly string[],
  message: string,
) {
  return new HypothesisRegistryError("HYPOTHESIS_TRANSITION_INVALID", message, {
    revision: registry.revision,
    currentState: previous.state,
    requestedState,
    allowedStates,
    allowedActions: ["get", "claim", "update"],
    recoveryCalls: [
      { action: "get", id: previous.id },
      { action: "claim", id: previous.id, reason: "<required-when-revisiting>" },
    ],
  })
}

function ownedHypothesis(registry: Registry, previous: Hypothesis, actor: HostActor) {
  return new HypothesisRegistryError(
    "HYPOTHESIS_OWNED",
    `hypothesis '${previous.id}' is already TESTING under AgentRun '${previous.ownerRunID}' and cannot be claimed by '${actor.runID}'`,
    {
      revision: registry.revision,
      currentState: previous.state,
      requestedState: "TESTING",
      ownerRunID: previous.ownerRunID,
      allowedActions: ["get", "list"],
      recoveryCalls: [
        { action: "get", id: previous.id },
        { action: "list", state: "TESTING" },
      ],
    },
  )
}

function emptyRegistry(): Registry {
  return {
    version: 1,
    revision: 0,
    updated_at: new Date(0).toISOString(),
    hypotheses: [],
    syntheses: [],
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`)
  const normalized = value.trim().replace(/\s+/g, " ")
  if (!normalized) throw new Error(`${label} must not be empty`)
  if (normalized.length > maximum) throw new Error(`${label} must contain at most ${maximum} characters`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} must not contain control characters`)
  return normalized
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  return value === undefined ? undefined : boundedText(value, label, maximum)
}

function identifier(value: unknown, label: string): string {
  const id = boundedText(value, label, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id))
    throw new Error(`${label} must use letters, numbers, dot, colon, underscore, or dash`)
  return id
}

function textArray(value: unknown, label: string, maximumItems: number): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maximumItems)
    throw new Error(`${label} must be an array of at most ${maximumItems} strings`)
  return [...new Set(value.map((item, index) => boundedText(item, `${label}[${index}]`, 1_000)))]
}

function requiredTextArray(value: unknown, label: string, maximumItems: number): readonly string[] {
  const values = textArray(value, label, maximumItems)
  if (values.length === 0) throw new Error(`${label} must contain at least one entry`)
  return values
}

function evidencePath(value: unknown, label: string): string {
  const candidate = boundedText(value, label, 1_024).replaceAll("\\", "/")
  if (path.posix.isAbsolute(candidate) || candidate.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error(`${label} must be a safe workarea-relative path`)
  return candidate
}

function evidencePaths(value: unknown, label: string, maximumItems: number, required = false): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems || (required && value.length === 0))
    throw new Error(
      `${label} must be an array of ${required ? `1 to ${maximumItems}` : `at most ${maximumItems}`} safe workarea-relative paths`,
    )
  return [...new Set(value.map((item, index) => evidencePath(item, `${label}[${index}]`)))]
}

function exactObject(value: unknown, label: string, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`)
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key))
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported field(s): ${unexpected.join(", ")}`)
  return value
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new Error(`${label} must be one of ${values.join(", ")}`)
  return value as Values[number]
}

function hypothesisOracle(value: unknown): HypothesisOracle {
  const input = exactObject(value, "hypothesis oracle", [
    "primary_observation",
    "positive_condition",
    "negative_condition",
    "invalid_condition",
    "controls",
  ])
  if (!Array.isArray(input.controls)) throw new Error("hypothesis oracle.controls must be an array")
  return {
    primary_observation: boundedText(input.primary_observation, "hypothesis oracle.primary_observation", 1_000),
    positive_condition: boundedText(input.positive_condition, "hypothesis oracle.positive_condition", 1_000),
    negative_condition: boundedText(input.negative_condition, "hypothesis oracle.negative_condition", 1_000),
    invalid_condition: boundedText(input.invalid_condition, "hypothesis oracle.invalid_condition", 1_000),
    controls: textArray(input.controls, "hypothesis oracle.controls", 20),
  }
}

// ── Primary Evidence Remains The Authority ──────────────────────
// The registry preserves raw observations separately from parser, scanner, and
// classifier output. Derived evidence may inform interpretation, but any
// disagreement remains explicit in the same immutable test transition.
// State validation then binds the declared oracle match to its disposition.
// ────────────────────────────────────────────────────────────────
function hypothesisTestResult(value: unknown): HypothesisTestResult {
  const input = exactObject(value, "hypothesis test_result", [
    "match",
    "observation",
    "primary_evidence_paths",
    "derived_evidence_paths",
    "conflicts",
    "interpretation",
  ])
  if (!Array.isArray(input.conflicts)) throw new Error("hypothesis test_result.conflicts must be an array")
  const result = {
    match: enumValue(input.match, "hypothesis test_result.match", ORACLE_MATCHES),
    observation: boundedText(input.observation, "hypothesis test_result.observation", 4_000),
    primary_evidence_paths: evidencePaths(
      input.primary_evidence_paths,
      "hypothesis test_result.primary_evidence_paths",
      50,
      true,
    ),
    derived_evidence_paths: evidencePaths(
      input.derived_evidence_paths,
      "hypothesis test_result.derived_evidence_paths",
      50,
    ),
    conflicts: textArray(input.conflicts, "hypothesis test_result.conflicts", 20),
    interpretation: boundedText(input.interpretation, "hypothesis test_result.interpretation", 4_000),
  }
  if (result.match === "CONFLICT" && result.conflicts.length === 0)
    throw new Error("CONFLICT hypothesis test_result requires at least one explicit conflict")
  return result
}

function validateTestResult(state: HypothesisState, result: HypothesisTestResult | undefined): void {
  if (!EXECUTED_DISPOSITIONS.some((candidate) => candidate === state)) return
  if (!result) throw new Error(`${state} hypothesis requires test_result`)
  if ((state === "SUSPECTED" || state === "CONFIRMED") && result.match !== "POSITIVE")
    throw new Error(`${state} hypothesis requires a POSITIVE test_result`)
  if (state === "DISPROVED" && result.match !== "NEGATIVE")
    throw new Error("DISPROVED hypothesis requires a NEGATIVE test_result")
  if (state === "INCONCLUSIVE" && result.match !== "INVALID" && result.match !== "CONFLICT")
    throw new Error("INCONCLUSIVE hypothesis requires an INVALID or CONFLICT test_result")
}

function latestTestResult(hypothesis: Hypothesis): HypothesisTestResult | undefined {
  return hypothesis.transitions.findLast((transition) => transition.test_result)?.test_result
}

async function bountyContext(value: unknown, workarea: string): Promise<BountyContext> {
  const input = exactObject(value, "hypothesis bounty_context", [
    "cluster",
    "impact_class",
    "boundary",
    "enforcement_owner",
    "principals",
    "objects",
    "oracle",
    "test_cost",
    "reward",
  ])
  const oracle = exactObject(input.oracle, "hypothesis bounty_context.oracle", ["vulnerable", "secure"])
  const reward = exactObject(input.reward, "hypothesis bounty_context.reward", [
    "target_severity",
    "group_status",
    "group_id",
    "rationale",
  ])
  const targetSeverity = enumValue(
    reward.target_severity,
    "hypothesis bounty_context.reward.target_severity",
    REWARD_SEVERITIES,
  )
  const groupStatus = enumValue(
    reward.group_status,
    "hypothesis bounty_context.reward.group_status",
    REWARD_GROUP_STATUSES,
  )
  const groupID = optionalText(reward.group_id, "hypothesis bounty_context.reward.group_id", 100)
  const policy = await readRewardPolicy(workarea)
  const policyKind = policy?.kind ?? "UNAVAILABLE"
  const publishedGroups = policyKind === "MONETARY" || policyKind === "POINTS"

  if (groupStatus === "MAPPED") {
    if (!publishedGroups || !groupID)
      throw new Error("MAPPED bounty reward context requires a published MONETARY or POINTS group_id")
    const group = policy?.groups.find((candidate) => candidate.id === groupID)
    if (!group) throw new Error(`bounty reward group '${groupID}' does not exist in the current official policy`)
    if (!group.tiers.some((tier) => tier.severity === targetSeverity))
      throw new Error(`bounty reward group '${groupID}' does not publish a ${targetSeverity} tier`)
  }
  if (groupStatus === "UNRESOLVED") {
    if (!publishedGroups || groupID)
      throw new Error("UNRESOLVED bounty reward context requires a published grouped policy and no group_id")
    if (!policy?.groups.some((group) => group.tiers.some((tier) => tier.severity === targetSeverity)))
      throw new Error(`the official grouped reward policy does not publish a ${targetSeverity} tier`)
  }
  if (groupStatus === "NOT_APPLICABLE" && (publishedGroups || groupID))
    throw new Error("NOT_APPLICABLE bounty reward context is valid only without a published grouped reward policy")

  return {
    cluster: identifier(input.cluster, "hypothesis bounty_context.cluster"),
    impact_class: boundedText(input.impact_class, "hypothesis bounty_context.impact_class", 500),
    boundary: boundedText(input.boundary, "hypothesis bounty_context.boundary", 500),
    enforcement_owner: boundedText(input.enforcement_owner, "hypothesis bounty_context.enforcement_owner", 500),
    principals: requiredTextArray(input.principals, "hypothesis bounty_context.principals", 20),
    objects: requiredTextArray(input.objects, "hypothesis bounty_context.objects", 20),
    oracle: {
      vulnerable: boundedText(oracle.vulnerable, "hypothesis bounty_context.oracle.vulnerable", 1_000),
      secure: boundedText(oracle.secure, "hypothesis bounty_context.oracle.secure", 1_000),
    },
    test_cost: enumValue(input.test_cost, "hypothesis bounty_context.test_cost", TEST_COSTS),
    reward: {
      target_severity: targetSeverity,
      group_status: groupStatus,
      ...(groupID ? { group_id: groupID } : {}),
      rationale: boundedText(reward.rationale, "hypothesis bounty_context.reward.rationale", 1_000),
      policy_kind: policyKind,
      ...(policy ? { policy_revision: policy.revision } : {}),
    },
  }
}

function mergeUnique(previous: readonly string[], additions: readonly string[], label: string): readonly string[] {
  const merged = [...new Set([...previous, ...additions])]
  if (merged.length > 50) throw new Error(`${label} must contain at most 50 unique entries`)
  return merged
}

function mergeOmissions(
  previous: Hypothesis["omitted_tools"],
  additions: Hypothesis["omitted_tools"],
): Hypothesis["omitted_tools"] {
  return [
    ...previous,
    ...additions.filter(
      (omission) =>
        !previous.some(
          (previousOmission) =>
            previousOmission.tool === omission.tool && previousOmission.reason === omission.reason,
        ),
    ),
  ]
}

function state(value: unknown): HypothesisState {
  if (typeof value !== "string" || !STATES.some((candidate) => candidate === value))
    throw new Error(`hypothesis state must be one of ${STATES.join(", ")}`)
  return value as HypothesisState
}

function hostActor(value: unknown): HostActor | undefined {
  if (!isRecord(value)) return
  const kind = value.kind
  if (kind !== "root" && kind !== "subagent" && kind !== "fallback") return
  return {
    runID: identifier(value.runID, "hypothesis host actor runID"),
    displayName: boundedText(value.displayName, "hypothesis host actor displayName", 160),
    kind,
  }
}

function reassignedOwnership(
  previous: Hypothesis,
  actor: HostActor | undefined,
  time: string,
  reason: "claimed" | "phase_recovery" | "child_finished",
): Partial<
  Pick<Hypothesis, "ownerRunID" | "ownerDisplayName" | "ownerKind" | "ownershipTransitions">
> {
  if (!actor) return {}
  return {
    ownerRunID: actor.runID,
    ownerDisplayName: actor.displayName,
    ownerKind: actor.kind,
    ...(actor.runID === previous.ownerRunID
      ? {}
      : {
          ownershipTransitions: [
            ...(previous.ownershipTransitions ?? []),
            {
              time_iso: time,
              ...(previous.ownerRunID ? { fromRunID: previous.ownerRunID } : {}),
              toRunID: actor.runID,
              toDisplayName: actor.displayName,
              toKind: actor.kind,
              reason,
            },
          ],
        }),
  }
}

function isActiveHypothesisState(
  value: HypothesisState,
): value is (typeof ACTIVE_HYPOTHESIS_STATES)[number] {
  return ACTIVE_HYPOTHESIS_STATES.some((candidate) => candidate === value)
}

function isTerminalPortfolioState(value: HypothesisState): boolean {
  return TERMINAL_PORTFOLIO_STATES.some((candidate) => candidate === value)
}

function transitionTime(hypothesis: Hypothesis, state: HypothesisState): number | undefined {
  const transition = hypothesis.transitions.findLast((candidate) => candidate.to === state)
  if (!transition) return undefined
  const time = Date.parse(transition.time_iso)
  return Number.isFinite(time) ? time : undefined
}

function transitionRevision(hypothesis: Hypothesis, state: HypothesisState): number | undefined {
  return hypothesis.transitions.findLast((candidate) => candidate.to === state)?.revision
}

function isStrongNegative(hypothesis: Hypothesis): boolean {
  return (
    hypothesis.state === "DISPROVED" &&
    hypothesis.transitions.some((transition) => transition.to === "TESTING") &&
    transitionTime(hypothesis, "DISPROVED") !== undefined
  )
}

interface ConvergenceSignal {
  readonly cluster: string
  readonly negative_hypothesis_ids: readonly [string, string]
}

function convergences(registry: Registry, workflow: string, phase: string): readonly ConvergenceSignal[] {
  const groups = new Map<string, Hypothesis[]>()
  for (const hypothesis of registry.hypotheses) {
    if (
      hypothesis.workflow !== workflow ||
      hypothesis.phase !== phase ||
      !hypothesis.bounty_context ||
      !isStrongNegative(hypothesis)
    )
      continue
    const grouped = groups.get(hypothesis.bounty_context.cluster) ?? []
    grouped.push(hypothesis)
    groups.set(hypothesis.bounty_context.cluster, grouped)
  }
  return [...groups.entries()].flatMap(([cluster, hypotheses]) => {
    const ordered = hypotheses.toSorted(
      (left, right) => transitionTime(left, "DISPROVED")! - transitionTime(right, "DISPROVED")!,
    )
    return ordered.length < 2 ? [] : [{ cluster, negative_hypothesis_ids: [ordered[0]!.id, ordered[1]!.id] as const }]
  })
}

function newlyDetectedConvergence(
  previous: Registry,
  next: Registry,
  workflow: string,
  phase: string,
): ConvergenceSignal | undefined {
  const previousClusters = new Set(convergences(previous, workflow, phase).map((candidate) => candidate.cluster))
  return convergences(next, workflow, phase).find((candidate) => !previousClusters.has(candidate.cluster))
}

function phaseHypothesis(
  registry: Registry,
  workflow: string,
  phase: string,
  value: unknown,
  label: string,
): Hypothesis {
  const id = identifier(value, label)
  const hypothesis = registry.hypotheses.find(
    (candidate) => candidate.id === id && candidate.workflow === workflow && candidate.phase === phase,
  )
  if (!hypothesis) throw new Error(`${label} '${id}' does not identify a hypothesis owned by ${workflow}/${phase}`)
  return hypothesis
}

function pivotValue(hypothesis: Hypothesis, dimension: PivotDimension): string {
  const context = hypothesis.bounty_context
  if (!context) throw new Error(`hypothesis '${hypothesis.id}' requires bounty_context`)
  return context[dimension]
}

function parseSynthesisPivots(
  value: unknown,
  registry: Registry,
  workflow: string,
  phase: string,
): readonly SynthesisPivot[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20)
    throw new Error("diversified bounty synthesis requires between one and 20 pivots")
  return value.map((candidate, index) => {
    const input = exactObject(candidate, `hypothesis synthesis pivots[${index}]`, [
      "hypothesis_id",
      "compared_to_hypothesis_ids",
      "changed_dimensions",
      "distance_rationale",
    ])
    const pivot = phaseHypothesis(
      registry,
      workflow,
      phase,
      input.hypothesis_id,
      `hypothesis synthesis pivots[${index}].hypothesis_id`,
    )
    if (!pivot.bounty_context) throw new Error(`pivot hypothesis '${pivot.id}' requires bounty_context`)
    if (!pivot.transitions.some((transition) => transition.to === "TESTING"))
      throw new Error(`pivot hypothesis '${pivot.id}' must be claimed into TESTING before synthesis`)
    const comparedIDs = requiredTextArray(
      input.compared_to_hypothesis_ids,
      `hypothesis synthesis pivots[${index}].compared_to_hypothesis_ids`,
      20,
    ).map((id) => identifier(id, `hypothesis synthesis pivots[${index}].compared_to_hypothesis_ids`))
    if (comparedIDs.includes(pivot.id)) throw new Error(`pivot hypothesis '${pivot.id}' cannot compare to itself`)
    const compared = comparedIDs.map((id) =>
      phaseHypothesis(
        registry,
        workflow,
        phase,
        id,
        `hypothesis synthesis pivots[${index}].compared_to_hypothesis_ids`,
      ),
    )
    if (compared.some((hypothesis) => !hypothesis.bounty_context))
      throw new Error(`every comparison for pivot hypothesis '${pivot.id}' requires bounty_context`)
    if (!Array.isArray(input.changed_dimensions) || input.changed_dimensions.length === 0)
      throw new Error(`hypothesis synthesis pivots[${index}].changed_dimensions must not be empty`)
    const dimensions = [
      ...new Set(
        input.changed_dimensions.map((dimension) =>
          enumValue(dimension, `hypothesis synthesis pivots[${index}].changed_dimensions`, PIVOT_DIMENSIONS),
        ),
      ),
    ]
    const structurallyDifferent = dimensions.some((dimension) =>
      compared.every((hypothesis) => pivotValue(pivot, dimension) !== pivotValue(hypothesis, dimension)),
    )
    if (!structurallyDifferent)
      throw new Error(
        `pivot hypothesis '${pivot.id}' does not differ from its comparison set on impact_class, boundary, or enforcement_owner`,
      )
    return {
      hypothesis_id: pivot.id,
      compared_to_hypothesis_ids: comparedIDs,
      changed_dimensions: dimensions,
      distance_rationale: boundedText(
        input.distance_rationale,
        `hypothesis synthesis pivots[${index}].distance_rationale`,
        1_000,
      ),
    }
  })
}

function synthesisResolvesConvergence(
  synthesis: Synthesis,
  convergence: ConvergenceSignal,
  registry: Registry,
  workflow: string,
  phase: string,
): boolean {
  if (synthesis.outcome === "exhausted")
    return convergence.negative_hypothesis_ids.every((id) => synthesis.exhausted_hypothesis_ids?.includes(id))
  const negativeTimes = convergence.negative_hypothesis_ids.map((id) =>
    transitionTime(phaseHypothesis(registry, workflow, phase, id, "convergence hypothesis"), "DISPROVED"),
  )
  const negativeRevisions = convergence.negative_hypothesis_ids.map((id) =>
    transitionRevision(phaseHypothesis(registry, workflow, phase, id, "convergence hypothesis"), "DISPROVED"),
  )
  const detectedAt = Math.max(...negativeTimes.filter((time): time is number => time !== undefined))
  const detectedRevision = Math.max(
    ...negativeRevisions.filter((revision): revision is number => revision !== undefined),
  )
  return Boolean(
    synthesis.pivots?.some((pivot) => {
      if (!convergence.negative_hypothesis_ids.every((id) => pivot.compared_to_hypothesis_ids.includes(id)))
        return false
      const hypothesis = phaseHypothesis(registry, workflow, phase, pivot.hypothesis_id, "pivot hypothesis")
      const claimedAt = transitionTime(hypothesis, "TESTING")
      const claimedRevision = transitionRevision(hypothesis, "TESTING")
      const claimedLater =
        Number.isFinite(detectedRevision) && claimedRevision !== undefined
          ? claimedRevision > detectedRevision
          : claimedAt !== undefined && claimedAt > detectedAt
      return claimedLater
    }),
  )
}

function blockerReason(value: unknown): BlockerReason | undefined {
  if (value === undefined) return
  if (typeof value !== "string" || !BLOCKER_REASONS.some((candidate) => candidate === value))
    throw new Error(`hypothesis blocker_reason must be one of ${BLOCKER_REASONS.join(", ")}`)
  return value as BlockerReason
}

function omittedTools(value: unknown): Hypothesis["omitted_tools"] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 30)
    throw new Error("hypothesis omitted_tools must be an array of at most 30 entries")
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`hypothesis omitted_tools[${index}] must be an object`)
    const reason = boundedText(item.reason, `hypothesis omitted_tools[${index}].reason`, 80)
    if (!OMISSION_REASONS.some((candidate) => candidate === reason))
      throw new Error(`hypothesis omitted_tools[${index}].reason is invalid`)
    return {
      tool: boundedText(item.tool, `hypothesis omitted_tools[${index}].tool`, 160),
      reason: reason as OmissionReason,
    }
  })
}

function scopeResolution(value: unknown): ScopeResolution | undefined {
  if (value === undefined) return
  if (!isRecord(value)) throw new Error("hypothesis scope_resolution must be an object")
  return {
    exact_action: boundedText(value.exact_action, "hypothesis scope_resolution.exact_action", 500),
    asset: boundedText(value.asset, "hypothesis scope_resolution.asset", 500),
    required_rule: boundedText(value.required_rule, "hypothesis scope_resolution.required_rule", 500),
    sources_checked: textArray(value.sources_checked, "hypothesis scope_resolution.sources_checked", 20),
    ambiguity: boundedText(value.ambiguity, "hypothesis scope_resolution.ambiguity", 1_000),
    resolution_attempt: boundedText(
      value.resolution_attempt,
      "hypothesis scope_resolution.resolution_attempt",
      1_000,
    ),
    next_step: boundedText(value.next_step, "hypothesis scope_resolution.next_step", 1_000),
  }
}

function fingerprint(input: {
  readonly workflow: string
  readonly description: string
  readonly rootCause: string
  readonly surface: string
  readonly discriminator: string
}) {
  return createHash("sha256")
    .update(
      [input.workflow, input.description, input.rootCause, input.surface, input.discriminator]
        .map((value) => value.toLowerCase())
        .join("\n"),
    )
    .digest("hex")
}

function parseRegistry(value: unknown): Registry {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.hypotheses) || !Array.isArray(value.syntheses))
    throw new Error("hypothesis registry is invalid")
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0)
    throw new Error("hypothesis registry revision is invalid")
  if (typeof value.updated_at !== "string") throw new Error("hypothesis registry timestamp is invalid")
  return value as unknown as Registry
}

async function readRegistry(workarea: string): Promise<Registry> {
  const content = await readFile(path.join(workarea, HYPOTHESIS_REGISTRY_PATH), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  return content === undefined ? emptyRegistry() : parseRegistry(JSON.parse(content))
}

export async function readHypothesisRegistryView(
  workarea: string,
  workflow: string,
): Promise<HypothesisRegistryView> {
  const registry = await readRegistry(workarea)
  const countsByState = Object.fromEntries(STATES.map((candidate) => [candidate, 0])) as Record<
    HypothesisState,
    number
  >
  for (const hypothesis of registry.hypotheses) {
    if (hypothesis.workflow !== workflow) continue
    countsByState[hypothesis.state]++
  }
  return {
    revision: registry.revision,
    workflow,
    activeCount: ACTIVE_HYPOTHESIS_STATES.reduce(
      (total, candidate) => total + countsByState[candidate],
      0,
    ),
    countsByState,
    activeHypotheses: registry.hypotheses
      .filter((hypothesis) => hypothesis.workflow === workflow && isActiveHypothesisState(hypothesis.state))
      .map((hypothesis) => ({
        id: hypothesis.id,
        phase: hypothesis.phase,
        owner: hypothesis.owner,
        ...(hypothesis.ownerDisplayName ? { ownerDisplayName: hypothesis.ownerDisplayName } : {}),
        description: hypothesis.description,
        rootCause: hypothesis.root_cause,
        surface: hypothesis.surface,
        discriminator: hypothesis.discriminator,
        ...(hypothesis.oracle ? { oracle: hypothesis.oracle } : {}),
        ...(latestTestResult(hypothesis) ? { latestTestResult: latestTestResult(hypothesis) } : {}),
        candidateTools: hypothesis.candidate_tools ?? [],
        omittedTools: hypothesis.omitted_tools ?? [],
        state: hypothesis.state,
        evidence: hypothesis.evidence ?? [],
        evidenceRefs: hypothesis.evidence_refs ?? [],
        ...(hypothesis.blocker ? { blocker: hypothesis.blocker } : {}),
        ...(hypothesis.blocker_reason ? { blockerReason: hypothesis.blocker_reason } : {}),
        ...(hypothesis.next_step ? { nextStep: hypothesis.next_step } : {}),
        ...(hypothesis.next_phase ? { nextPhase: hypothesis.next_phase } : {}),
        ...(hypothesis.finding_id ? { findingID: hypothesis.finding_id } : {}),
        graphRefs: hypothesis.graph_refs ?? [],
        transitions: (hypothesis.transitions ?? []).map((transition) => ({
          time: transition.time_iso,
          phase: transition.phase,
          owner: transition.owner,
          ...(transition.from ? { from: transition.from } : {}),
          to: transition.to,
          evidence: transition.evidence,
          ...(transition.reason ? { reason: transition.reason } : {}),
          ...(transition.test_result ? { testResult: transition.test_result } : {}),
        })),
      })),
  }
}

function validateDisposition(input: {
  readonly state: HypothesisState
  readonly evidence: readonly string[]
  readonly blocker?: string
  readonly blockerReason?: BlockerReason
  readonly nextStep?: string
  readonly nextPhase?: string
  readonly findingID?: string
  readonly reason?: string
  readonly scopeResolution?: ScopeResolution
}) {
  if (input.state === "QUEUED" && (!input.nextPhase || !input.nextStep))
    throw new Error("QUEUED hypothesis requires next_phase and next_step")
  if ((input.state === "SUSPECTED" || input.state === "CONFIRMED") && !input.findingID)
    throw new Error(`${input.state} hypothesis requires finding_id`)
  if (["SUSPECTED", "CONFIRMED", "DISPROVED", "INCONCLUSIVE"].includes(input.state) && input.evidence.length === 0)
    throw new Error(`${input.state} hypothesis requires evidence`)
  if (input.state === "INCONCLUSIVE" && (!input.blocker || !input.nextStep))
    throw new Error("INCONCLUSIVE hypothesis requires blocker and next_step")
  if (input.state === "UNTESTABLE" && (!input.blocker || !input.blockerReason || !input.nextStep))
    throw new Error("UNTESTABLE hypothesis requires blocker, blocker_reason, and next_step")
  if (
    input.state === "UNTESTABLE" &&
    (input.blockerReason === "AUTHORITY_REQUIRED" || input.blockerReason === "OUT_OF_SCOPE_DEPENDENCY") &&
    !input.scopeResolution
  )
    throw new Error("scope-related UNTESTABLE hypothesis requires scope_resolution")
  if (
    ["SUSPECTED", "CONFIRMED", "DISPROVED", "INCONCLUSIVE", "UNTESTABLE"].includes(input.state) &&
    !input.reason
  )
    throw new Error(`${input.state} hypothesis requires a closure reason`)
}

// ── Phase Boundaries Carry Work Instead Of Dropping It ──────────
// OPEN and TESTING mean the current phase still owns unfinished work and must
// therefore block handoff. QUEUED is the explicit exception: it identifies the
// exact successor and next discriminating action. Terminal dispositions retain
// evidence, while positive states also link the separate finding authority. An
// executed disposition must first enter TESTING; OPEN may only skip execution
// when work is carried or proven untestable. This gives every phase one
// close-or-carry rule without workflow-specific logs.
//
// @docs/user-guide/workflows.md
// ─────────────────────────────────────────────────────────────────
export class HypothesisRegistry {
  readonly #workarea: string
  readonly #workflow: string
  readonly #phase: string
  readonly #readOnly: boolean
  readonly #synthesisRequired: boolean
  readonly #bountyPortfolio: boolean
  #queue: Promise<void> = Promise.resolve()

  constructor(input: {
    readonly workarea: string
    readonly workflow: string
    readonly phase: string
    readonly readOnly?: boolean
    readonly synthesisRequired?: boolean
    readonly noveltyContract?: NoveltyContract
  }) {
    if (!path.isAbsolute(input.workarea)) throw new Error("hypothesis registry requires an absolute workarea root")
    this.#workarea = input.workarea
    this.#workflow = boundedText(input.workflow, "hypothesis workflow", 80)
    this.#phase = boundedText(input.phase, "hypothesis phase", 80)
    this.#readOnly = input.readOnly === true
    this.#synthesisRequired = input.synthesisRequired === true || input.noveltyContract?.required === true
    this.#bountyPortfolio = input.noveltyContract?.mode === "bounty-portfolio"
  }

  handle(args: Record<string, unknown>) {
    if (args.action === "get") return this.get(args.id)
    if (args.action === "list") return this.list(args)
    if (args.action === "recover_ownership") {
      if (args._cyberful_host !== true) throw new Error("hypothesis ownership recovery is host-only")
      return this.#recoverOwnership(args)
    }
    if (this.#readOnly) throw new Error("hypothesis registry is read-only in this phase")
    if (args.action === "record") return this.#record(args)
    if (args.action === "set_bounty_context") return this.#setBountyContext(args)
    if (args.action === "update" && args.state === "TESTING") return this.#claim(args)
    if (args.action === "update") return this.#update(args)
    if (args.action === "claim" || args.action === "reopen") return this.#claim(args)
    if (args.action === "synthesize") return this.#synthesize(args)
    throw new Error(
      "hypothesis action must be record, set_bounty_context, claim, update, reopen, get, list, or synthesize",
    )
  }

  async get(value: unknown) {
    const id = identifier(value, "hypothesis id")
    const registry = await this.#read()
    const hypothesis = registry.hypotheses.find((candidate) => candidate.id === id)
    if (!hypothesis) throw missingHypothesis(registry, id)
    return hypothesis
  }

  async list(args: Record<string, unknown> = {}) {
    const registry = await this.#read()
    const requestedState = args.state === undefined ? undefined : state(args.state)
    const hypotheses = registry.hypotheses.filter(
      (hypothesis) => requestedState === undefined || hypothesis.state === requestedState,
    )
    return {
      revision: registry.revision,
      workflow: this.#workflow,
      phase: this.#phase,
      hypotheses,
      synthesis: registry.syntheses.findLast((item) => item.phase === this.#phase),
    }
  }

  async handoffError(successor?: string) {
    const registry = await this.#read()
    const owned = registry.hypotheses.filter(
      (hypothesis) => hypothesis.workflow === this.#workflow && hypothesis.phase === this.#phase,
    )
    const open = owned.filter((hypothesis) => hypothesis.state === "OPEN" || hypothesis.state === "TESTING")
    if (open.length > 0) return `hypothesis registry has unfinished entries: ${open.map((item) => item.id).join(", ")}`
    const invalidQueue = owned.filter(
      (hypothesis) => hypothesis.state === "QUEUED" && (!successor || hypothesis.next_phase !== successor),
    )
    if (invalidQueue.length > 0)
      return `hypothesis registry has entries queued to the wrong successor: ${invalidQueue.map((item) => item.id).join(", ")}`
    if (this.#bountyPortfolio) {
      const missingContext = owned.filter((hypothesis) => !hypothesis.bounty_context)
      if (missingContext.length > 0)
        return `Bug Bounty hypotheses require bounty_context before handoff: ${missingContext.map((item) => item.id).join(", ")}`
      const synthesis = registry.syntheses.findLast((item) => item.phase === this.#phase)
      if (
        synthesis &&
        ((synthesis.outcome === "diversified" && !synthesis.pivots?.length) ||
          (synthesis.outcome === "exhausted" &&
            !synthesis.exhausted_hypothesis_ids?.length &&
            !synthesis.no_candidate_evidence_refs?.length))
      )
        return "Bug Bounty handoff requires a structured portfolio synthesis with real hypothesis references"
      if (synthesis && !synthesis.opportunity_closeout)
        return "Bug Bounty handoff requires a qualitative closeout of remaining reward opportunities"
      const unresolved = synthesis
        ? convergences(registry, this.#workflow, this.#phase).filter(
            (convergence) =>
              !synthesisResolvesConvergence(synthesis, convergence, registry, this.#workflow, this.#phase),
          )
        : []
      if (unresolved.length > 0)
        return `Bug Bounty convergence requires a later structural pivot or evidenced exhaustion before handoff: ${unresolved
          .map((item) => `${item.cluster} (${item.negative_hypothesis_ids.join(", ")})`)
          .join("; ")}`
    }
    if (this.#synthesisRequired && !registry.syntheses.some((item) => item.phase === this.#phase))
      return "hypothesis registry requires phase synthesis before handoff"
  }

  async snapshot() {
    const registry = await this.#read()
    return {
      revision: registry.revision,
      hypotheses: registry.hypotheses.filter(
        (hypothesis) => hypothesis.workflow === this.#workflow && hypothesis.phase === this.#phase,
      ),
    }
  }

  attachEvidenceReference(hypothesisId: unknown, evidenceReference: unknown) {
    if (this.#readOnly) throw new Error("hypothesis registry is read-only in this phase")
    const id = identifier(hypothesisId, "hypothesis id")
    const reference = boundedText(evidenceReference, "hypothesis evidence reference", 8_192)
    return this.#mutate((registry) => {
      const index = registry.hypotheses.findIndex((hypothesis) => hypothesis.id === id)
      if (index < 0) throw missingHypothesis(registry, id)
      const previous = registry.hypotheses[index]!
      if (previous.evidence_refs.includes(reference)) return { registry, result: previous, changed: false }
      if (previous.evidence_refs.length >= 50)
        throw new Error(`hypothesis '${id}' already contains the maximum of 50 evidence references`)
      const hypotheses = [...registry.hypotheses]
      const updated = { ...previous, evidence_refs: [...previous.evidence_refs, reference] }
      hypotheses[index] = updated
      return { registry: { ...registry, hypotheses }, result: updated }
    })
  }

  close() {
    return this.#queue
  }

  async #record(args: Record<string, unknown>) {
    if (!this.#bountyPortfolio && args.bounty_context !== undefined)
      throw new Error("bounty_context is available only under the Bug Bounty portfolio contract")
    const context = this.#bountyPortfolio ? await bountyContext(args.bounty_context, this.#workarea) : undefined
    return this.#mutate((registry) => {
      const description = boundedText(args.description ?? args.objective ?? args.title, "hypothesis description", 1_000)
      const rootCause = boundedText(args.root_cause, "hypothesis root_cause", 500)
      const surface = boundedText(args.surface, "hypothesis surface", 500)
      const discriminator = boundedText(args.discriminator, "hypothesis discriminator", 1_000)
      const oracle = hypothesisOracle(args.oracle)
      const id = identifier(args.id, "hypothesis id")
      const fingerprintSha256 = fingerprint({
        workflow: this.#workflow,
        description,
        rootCause,
        surface,
        discriminator,
      })
      const owner = boundedText(args.owner, "hypothesis owner", 160)
      const candidateTools = textArray(args.candidate_tools, "hypothesis candidate_tools", 30)
      const omitted = omittedTools(args.omitted_tools)
      const evidence = textArray(args.evidence, "hypothesis evidence", 50)
      const evidenceRefs = textArray(args.evidence_refs, "hypothesis evidence_refs", 50)
      const graphRefs = textArray(args.graph_refs, "hypothesis graph_refs", 50)
      const existing = registry.hypotheses.find((item) => item.id === id)
      if (existing) {
        const repeated =
          existing.fingerprint_sha256 === fingerprintSha256 &&
          existing.workflow === this.#workflow &&
          existing.phase === this.#phase &&
          existing.owner === owner &&
          existing.state === "OPEN" &&
          JSON.stringify(existing.candidate_tools) === JSON.stringify(candidateTools) &&
          JSON.stringify(existing.omitted_tools) === JSON.stringify(omitted) &&
          JSON.stringify(existing.evidence) === JSON.stringify(evidence) &&
          JSON.stringify(existing.evidence_refs) === JSON.stringify(evidenceRefs) &&
          JSON.stringify(existing.graph_refs) === JSON.stringify(graphRefs) &&
          JSON.stringify(existing.oracle) === JSON.stringify(oracle) &&
          JSON.stringify(existing.bounty_context) === JSON.stringify(context)
        if (repeated) return { registry, result: existing, changed: false }
        throw new Error(`hypothesis '${id}' already exists with different content`)
      }
      const duplicate = registry.hypotheses.find((item) => item.fingerprint_sha256 === fingerprintSha256)
      if (duplicate) throw new Error(`hypothesis duplicates '${duplicate.id}'`)
      const actor = hostActor(args._cyberful_actor)
      const now = new Date().toISOString()
      const hypothesis: Hypothesis = {
        id,
        fingerprint_sha256: fingerprintSha256,
        workflow: this.#workflow,
        phase: this.#phase,
        owner,
        ...(actor
          ? {
              ownerRunID: actor.runID,
              ownerDisplayName: actor.displayName,
              ownerKind: actor.kind,
            }
          : {}),
        description,
        root_cause: rootCause,
        surface,
        discriminator,
        oracle,
        candidate_tools: candidateTools,
        omitted_tools: omitted,
        state: "OPEN",
        evidence,
        evidence_refs: evidenceRefs,
        graph_refs: graphRefs,
        transitions: [
          { time_iso: now, revision: registry.revision + 1, phase: this.#phase, owner, to: "OPEN", evidence: [] },
        ],
        ...(context
          ? {
              bounty_context: context,
              bounty_context_history: [{ time_iso: now, phase: this.#phase, reason: "recorded", context }],
            }
          : {}),
        ...(actor
          ? {
              ownershipTransitions: [
                {
                  time_iso: now,
                  toRunID: actor.runID,
                  toDisplayName: actor.displayName,
                  toKind: actor.kind,
                  reason: "recorded" as const,
                },
              ],
            }
          : {}),
      }
      return { registry: { ...registry, hypotheses: [...registry.hypotheses, hypothesis] }, result: hypothesis }
    })
  }

  async #setBountyContext(args: Record<string, unknown>) {
    if (!this.#bountyPortfolio)
      throw new Error("set_bounty_context is available only under the Bug Bounty portfolio contract")
    const context = await bountyContext(args.bounty_context, this.#workarea)
    const reason = boundedText(args.reason, "hypothesis bounty_context change reason", 1_000)
    return this.#mutate((registry) => {
      const id = identifier(args.id, "hypothesis id")
      const index = registry.hypotheses.findIndex((hypothesis) => hypothesis.id === id)
      if (index < 0) throw missingHypothesis(registry, id)
      const previous = registry.hypotheses[index]!
      if (previous.workflow !== this.#workflow)
        throw new Error(`hypothesis '${id}' belongs to workflow '${previous.workflow}'`)
      if (JSON.stringify(previous.bounty_context) === JSON.stringify(context))
        return { registry, result: previous, changed: false }
      const now = new Date().toISOString()
      const updated: Hypothesis = {
        ...previous,
        bounty_context: context,
        bounty_context_history: [
          ...(previous.bounty_context_history ?? []),
          { time_iso: now, phase: this.#phase, reason, context },
        ],
      }
      const hypotheses = [...registry.hypotheses]
      hypotheses[index] = updated
      return { registry: { ...registry, hypotheses }, result: updated }
    })
  }

  #update(args: Record<string, unknown>) {
    return this.#mutate((registry) => {
      const id = identifier(args.id, "hypothesis id")
      const index = registry.hypotheses.findIndex((item) => item.id === id)
      if (index < 0) throw missingHypothesis(registry, id)
      const previous = registry.hypotheses[index]!
      if (this.#bountyPortfolio && !previous.bounty_context)
        throw new Error(`hypothesis '${id}' requires set_bounty_context before a Bug Bounty state transition`)
      const actor = hostActor(args._cyberful_actor)
      const nextState = state(args.state)
      if (
        EXECUTED_DISPOSITIONS.some((candidate) => candidate === nextState) &&
        previous.state !== "TESTING" &&
        nextState !== previous.state
      )
        throw invalidHypothesisTransition(
          registry,
          previous,
          nextState,
          ["TESTING"],
          `hypothesis '${id}' must enter TESTING before an executed ${nextState} disposition`,
        )
      const testResult = EXECUTED_DISPOSITIONS.some((candidate) => candidate === nextState)
        ? hypothesisTestResult(args.test_result)
        : undefined
      validateTestResult(nextState, testResult)
      const suppliedEvidence = textArray(args.evidence, "hypothesis evidence", 50)
      const evidence = testResult ? mergeUnique(suppliedEvidence, [testResult.observation], "hypothesis evidence") : suppliedEvidence
      const evidenceRefs = testResult
        ? mergeUnique(
            textArray(args.evidence_refs, "hypothesis evidence_refs", 50),
            [...testResult.primary_evidence_paths, ...testResult.derived_evidence_paths],
            "hypothesis evidence_refs",
          )
        : textArray(args.evidence_refs, "hypothesis evidence_refs", 50)
      const graphRefs = textArray(args.graph_refs, "hypothesis graph_refs", 50)
      const omissions = omittedTools(args.omitted_tools)
      const owner = optionalText(args.owner, "hypothesis owner", 160) ?? previous.owner
      const blocker = optionalText(args.blocker, "hypothesis blocker", 1_000)
      const nextStep = optionalText(args.next_step, "hypothesis next_step", 1_000)
      const nextPhase = optionalText(args.next_phase, "hypothesis next_phase", 80)
      const findingID = args.finding_id === undefined ? undefined : identifier(args.finding_id, "hypothesis finding_id")
      const reason = optionalText(args.reason, "hypothesis reason", 1_000)
      const typedBlockerReason = blockerReason(args.blocker_reason)
      const typedScopeResolution = scopeResolution(args.scope_resolution)
      const mergedEvidence = mergeUnique(previous.evidence, evidence, "hypothesis evidence")
      const mergedEvidenceRefs = mergeUnique(previous.evidence_refs ?? [], evidenceRefs, "hypothesis evidence_refs")
      const mergedGraphRefs = mergeUnique(previous.graph_refs, graphRefs, "hypothesis graph_refs")
      const mergedOmissions = mergeOmissions(previous.omitted_tools ?? [], omissions)

      if (nextState === previous.state) {
        if (
          testResult &&
          JSON.stringify(previous.transitions.findLast((transition) => transition.test_result)?.test_result) !==
            JSON.stringify(testResult)
        )
          throw new Error(`hypothesis '${id}' must re-enter TESTING before recording a different test_result`)
        const updated: Hypothesis = {
          ...previous,
          phase: this.#phase,
          owner,
          ...reassignedOwnership(previous, actor, new Date().toISOString(), "claimed"),
          evidence: mergedEvidence,
          evidence_refs: mergedEvidenceRefs,
          graph_refs: args.graph_refs === undefined ? previous.graph_refs : mergedGraphRefs,
          omitted_tools: mergedOmissions,
          ...(blocker ? { blocker } : {}),
          ...(typedBlockerReason ? { blocker_reason: typedBlockerReason } : {}),
          ...(nextStep ? { next_step: nextStep } : {}),
          ...(nextPhase ? { next_phase: nextPhase } : {}),
          ...(findingID ? { finding_id: findingID } : {}),
          ...(typedScopeResolution ? { scope_resolution: typedScopeResolution } : {}),
        }
        validateDisposition({
          state: nextState,
          evidence: updated.evidence,
          blocker: updated.blocker,
          blockerReason: updated.blocker_reason,
          nextStep: updated.next_step,
          nextPhase: updated.next_phase,
          findingID: updated.finding_id,
          reason: reason ?? previous.transitions.at(-1)?.reason,
          scopeResolution: updated.scope_resolution,
        })
        if (JSON.stringify(updated) === JSON.stringify(previous)) return { registry, result: previous, changed: false }
        const hypotheses = [...registry.hypotheses]
        hypotheses[index] = updated
        return { registry: { ...registry, hypotheses }, result: updated }
      }
      if (
        nextState === "TESTING" &&
        previous.state !== "OPEN" &&
        previous.state !== "SUSPECTED" &&
        previous.state !== "CONFIRMED"
      )
        throw invalidHypothesisTransition(
          registry,
          previous,
          nextState,
          ["OPEN", "SUSPECTED", "CONFIRMED"],
          `hypothesis '${id}' cannot enter TESTING from ${previous.state}; queued work must use reopen`,
        )
      validateDisposition({
        state: nextState,
        evidence,
        blocker,
        blockerReason: typedBlockerReason,
        nextStep,
        nextPhase,
        findingID,
        reason,
        scopeResolution: typedScopeResolution,
      })
      const now = new Date().toISOString()
      const updated: Hypothesis = {
        ...previous,
        phase: this.#phase,
        owner,
        ...reassignedOwnership(previous, actor, now, "claimed"),
        state: nextState,
        evidence: mergedEvidence,
        evidence_refs: mergedEvidenceRefs,
        omitted_tools: mergedOmissions,
        ...(blocker ? { blocker } : {}),
        ...(typedBlockerReason ? { blocker_reason: typedBlockerReason } : {}),
        ...(nextStep ? { next_step: nextStep } : {}),
        ...(nextPhase ? { next_phase: nextPhase } : {}),
        ...(findingID ? { finding_id: findingID } : {}),
        ...(typedScopeResolution ? { scope_resolution: typedScopeResolution } : {}),
        ...(nextState === "TESTING"
          ? {
              blocker: undefined,
              blocker_reason: undefined,
              next_step: undefined,
              next_phase: undefined,
              finding_id: undefined,
              scope_resolution: undefined,
            }
          : {}),
        ...(args.graph_refs === undefined ? {} : { graph_refs: mergedGraphRefs }),
        transitions: [
          ...previous.transitions,
          {
            time_iso: now,
            revision: registry.revision + 1,
            phase: this.#phase,
            owner,
            from: previous.state,
            to: nextState,
            evidence,
            ...(reason ? { reason } : {}),
            ...(testResult ? { test_result: testResult } : {}),
          },
        ],
      }
      const hypotheses = [...registry.hypotheses]
      hypotheses[index] = updated
      const nextRegistry = { ...registry, hypotheses }
      const convergence =
        this.#bountyPortfolio && nextState === "DISPROVED"
          ? newlyDetectedConvergence(registry, nextRegistry, this.#workflow, this.#phase)
          : undefined
      return {
        registry: nextRegistry,
        result: convergence ? { ...updated, convergence } : updated,
      }
    })
  }

  // ── Claim Is The Sole Admission Into Active Testing ────────────
  // Execution ownership and lifecycle state must change atomically or a live
  // test can remain labelled UNTESTABLE, QUEUED, or owned by a finished actor.
  // One serialized command therefore validates phase eligibility, rejects a
  // competing owner, clears stale disposition metadata, and enters TESTING.
  // Exact repeated claims by the same actor are semantic no-ops; `reopen` and
  // historical `update(state=TESTING)` calls route through this same table.
  // ────────────────────────────────────────────────────────────────
  #claim(args: Record<string, unknown>) {
    return this.#mutate((registry) => {
      const id = identifier(args.id, "hypothesis id")
      const index = registry.hypotheses.findIndex((item) => item.id === id)
      if (index < 0) throw missingHypothesis(registry, id)
      const previous = registry.hypotheses[index]!
      if (this.#bountyPortfolio && !previous.bounty_context)
        throw new Error(`hypothesis '${id}' requires set_bounty_context before a Bug Bounty claim`)
      const suppliedOracle = args.oracle === undefined ? undefined : hypothesisOracle(args.oracle)
      if (!previous.oracle && !suppliedOracle)
        throw new Error(`hypothesis '${id}' requires oracle when it first enters TESTING`)
      if (previous.oracle && suppliedOracle && JSON.stringify(previous.oracle) !== JSON.stringify(suppliedOracle))
        throw new Error(`hypothesis '${id}' oracle is immutable once recorded`)
      const actor = hostActor(args._cyberful_actor)
      if (
        previous.state === "TESTING" &&
        actor &&
        previous.ownerRunID &&
        previous.ownerRunID !== actor.runID
      )
        throw ownedHypothesis(registry, previous, actor)
      if (previous.state === "TESTING" && (!actor || previous.ownerRunID === actor.runID)) {
        if (previous.oracle) return { registry, result: previous, changed: false }
        const updated = { ...previous, oracle: suppliedOracle }
        const hypotheses = [...registry.hypotheses]
        hypotheses[index] = updated
        return { registry: { ...registry, hypotheses }, result: updated }
      }
      if (previous.state === "QUEUED" && previous.next_phase !== this.#phase)
        throw invalidHypothesisTransition(
          registry,
          previous,
          "TESTING",
          ["QUEUED for the active phase"],
          `hypothesis '${id}' cannot be claimed in '${this.#phase}'; it is queued for '${previous.next_phase}'`,
        )
      const revisit = previous.state !== "OPEN" && previous.state !== "QUEUED"
      const reason = optionalText(args.reason, "hypothesis claim reason", 1_000)
      if (revisit && !reason)
        throw invalidHypothesisTransition(
          registry,
          previous,
          "TESTING",
          ["OPEN", "QUEUED for the active phase", "explicit revisit with reason"],
          `hypothesis '${id}' requires a non-empty claim reason when revisiting ${previous.state}`,
        )
      const owner = optionalText(args.owner, "hypothesis owner", 160) ?? previous.owner
      const now = new Date().toISOString()
      const updated: Hypothesis = {
        ...previous,
        ...(previous.oracle ? {} : { oracle: suppliedOracle }),
        phase: this.#phase,
        owner,
        ...reassignedOwnership(previous, actor, now, "claimed"),
        state: "TESTING",
        blocker: undefined,
        blocker_reason: undefined,
        next_step: undefined,
        next_phase: undefined,
        finding_id: undefined,
        scope_resolution: undefined,
        transitions: [
          ...previous.transitions,
          {
            time_iso: now,
            revision: registry.revision + 1,
            phase: this.#phase,
            owner,
            from: previous.state,
            to: "TESTING",
            evidence: [],
            ...(reason ? { reason } : {}),
          },
        ],
      }
      const hypotheses = [...registry.hypotheses]
      hypotheses[index] = updated
      return { registry: { ...registry, hypotheses }, result: updated }
    })
  }

  #synthesize(args: Record<string, unknown>) {
    return this.#mutate((registry) => {
      if (args.outcome !== "diversified" && args.outcome !== "exhausted")
        throw new Error("hypothesis synthesis outcome must be diversified or exhausted")
      const evidence = textArray(args.evidence, "hypothesis synthesis evidence", 30)
      const evidenceRefs = textArray(args.evidence_refs, "hypothesis synthesis evidence_refs", 30)
      if (evidence.length === 0) throw new Error("hypothesis synthesis requires evidence")
      const phaseHypotheses = registry.hypotheses.filter(
        (hypothesis) => hypothesis.workflow === this.#workflow && hypothesis.phase === this.#phase,
      )
      const activeBlockingHypotheses = phaseHypotheses.filter(
        (hypothesis) => hypothesis.state === "OPEN" || hypothesis.state === "TESTING",
      ).length
      if (this.#bountyPortfolio) {
        const missingContext = phaseHypotheses.filter((hypothesis) => !hypothesis.bounty_context)
        if (missingContext.length > 0)
          throw new Error(
            `Bug Bounty synthesis requires bounty_context on ${missingContext.map((item) => item.id).join(", ")}`,
          )
      }
      const opportunityCloseout = this.#bountyPortfolio
        ? boundedText(args.opportunity_closeout, "hypothesis synthesis opportunity_closeout", 3_000)
        : optionalText(args.opportunity_closeout, "hypothesis synthesis opportunity_closeout", 3_000)
      const pivots =
        this.#bountyPortfolio && args.outcome === "diversified"
          ? parseSynthesisPivots(args.pivots, registry, this.#workflow, this.#phase)
          : undefined
      let exhaustedHypothesisIDs: readonly string[] | undefined
      let exhaustionRationale: string | undefined
      let noCandidateEvidenceRefs: readonly string[] | undefined
      if (this.#bountyPortfolio && args.outcome === "exhausted") {
        if (activeBlockingHypotheses > 0)
          throw new Error("exhausted Bug Bounty synthesis requires no OPEN or TESTING hypotheses")
        exhaustedHypothesisIDs = textArray(
          args.exhausted_hypothesis_ids,
          "hypothesis synthesis exhausted_hypothesis_ids",
          50,
        ).map((id) => identifier(id, "hypothesis synthesis exhausted_hypothesis_ids"))
        noCandidateEvidenceRefs = textArray(
          args.no_candidate_evidence_refs,
          "hypothesis synthesis no_candidate_evidence_refs",
          30,
        )
        if (exhaustedHypothesisIDs.length === 0 && noCandidateEvidenceRefs.length === 0)
          throw new Error(
            "exhausted Bug Bounty synthesis requires terminal hypothesis IDs or no-candidate evidence references",
          )
        if (exhaustedHypothesisIDs.length === 0 && phaseHypotheses.length > 0)
          throw new Error("no_candidate_evidence_refs is valid only when the phase contains no hypotheses")
        const citedEvidenceRefs = new Set<string>()
        for (const id of exhaustedHypothesisIDs) {
          const hypothesis = phaseHypothesis(
            registry,
            this.#workflow,
            this.#phase,
            id,
            "hypothesis synthesis exhausted_hypothesis_ids",
          )
          if (!isTerminalPortfolioState(hypothesis.state))
            throw new Error(`exhaustion hypothesis '${id}' must have a terminal tested or untestable disposition`)
          if (hypothesis.evidence_refs.length === 0)
            throw new Error(`exhaustion hypothesis '${id}' requires target-specific evidence_refs`)
          for (const reference of hypothesis.evidence_refs) citedEvidenceRefs.add(reference)
        }
        if (evidenceRefs.length === 0)
          throw new Error("exhausted Bug Bounty synthesis requires target-specific evidence_refs")
        if (
          exhaustedHypothesisIDs.length > 0 &&
          evidenceRefs.some((reference) => !citedEvidenceRefs.has(reference))
        )
          throw new Error("exhausted Bug Bounty synthesis evidence_refs must be linked by its cited hypotheses")
        if (
          noCandidateEvidenceRefs.length > 0 &&
          noCandidateEvidenceRefs.some((reference) => !evidenceRefs.includes(reference))
        )
          throw new Error("no_candidate_evidence_refs must also appear in synthesis evidence_refs")
        exhaustionRationale = boundedText(args.exhaustion_rationale, "hypothesis synthesis exhaustion_rationale", 2_000)
      }
      const synthesis: Synthesis = {
        time_iso: new Date().toISOString(),
        phase: this.#phase,
        outcome: args.outcome,
        summary: boundedText(args.summary ?? args.contrarian_summary, "hypothesis synthesis summary", 4_000),
        evidence,
        remaining_unknowns: textArray(args.remaining_unknowns, "hypothesis remaining_unknowns", 30),
        ...(opportunityCloseout ? { opportunity_closeout: opportunityCloseout } : {}),
        ...(evidenceRefs.length > 0 ? { evidence_refs: evidenceRefs } : {}),
        ...(pivots ? { pivots } : {}),
        ...(exhaustedHypothesisIDs && exhaustedHypothesisIDs.length > 0
          ? { exhausted_hypothesis_ids: exhaustedHypothesisIDs }
          : {}),
        ...(exhaustionRationale ? { exhaustion_rationale: exhaustionRationale } : {}),
        ...(noCandidateEvidenceRefs && noCandidateEvidenceRefs.length > 0
          ? { no_candidate_evidence_refs: noCandidateEvidenceRefs }
          : {}),
      }
      return {
        registry: {
          ...registry,
          syntheses: [...registry.syntheses.filter((item) => item.phase !== this.#phase), synthesis],
        },
        result: { ...synthesis, activeBlockingHypotheses },
      }
    })
  }

  #recoverOwnership(args: Record<string, unknown>) {
    const target = hostActor(args._cyberful_actor)
    if (!target) throw new Error("hypothesis ownership recovery requires a host actor")
    const fromRunID =
      args.fromRunID === "*"
        ? "*"
        : identifier(args.fromRunID, "hypothesis ownership source runID")
    if (args.reason !== "phase_recovery" && args.reason !== "child_finished")
      throw new Error("hypothesis ownership recovery reason is invalid")
    const reason = args.reason
    return this.#mutate((registry) => {
      const recovered: Array<{ readonly id: string; readonly nextStep?: string }> = []
      const now = new Date().toISOString()
      const hypotheses = registry.hypotheses.map((hypothesis) => {
        if (
          hypothesis.workflow !== this.#workflow ||
          hypothesis.phase !== this.#phase ||
          !isActiveHypothesisState(hypothesis.state) ||
          (fromRunID !== "*" && hypothesis.ownerRunID !== fromRunID) ||
          hypothesis.ownerRunID === target.runID
        )
          return hypothesis
        recovered.push({
          id: hypothesis.id,
          ...(hypothesis.next_step ? { nextStep: hypothesis.next_step } : {}),
        })
        return {
          ...hypothesis,
          ...reassignedOwnership(hypothesis, target, now, reason),
        }
      })
      return {
        registry: { ...registry, hypotheses },
        result: recovered,
        changed: recovered.length > 0,
      }
    })
  }

  async #read(): Promise<Registry> {
    await this.#queue
    return readRegistry(this.#workarea)
  }

  #mutate<T>(
    operation: (registry: Registry) => {
      readonly registry: Registry
      readonly result: T
      readonly changed?: boolean
    },
  ): Promise<T> {
    const pending = this.#queue.then(async () => {
      const current = await readRegistry(this.#workarea)
      const mutation = operation(current)
      if (mutation.changed === false) return mutation.result
      const next: Registry = {
        ...mutation.registry,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
      }
      await replaceWorkareaFile(this.#workarea, HYPOTHESIS_REGISTRY_PATH, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
      })
      return mutation.result
    })
    this.#queue = pending.then(() => undefined, () => undefined)
    return pending
  }
}

const hypothesisEvidenceProperties = {
  evidence: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
  evidence_refs: { type: "array", maxItems: 50, items: { type: "string" } },
  graph_refs: { type: "array", maxItems: 50, items: { type: "string" } },
  omitted_tools: {
    type: "array",
    maxItems: 30,
    items: {
      type: "object",
      additionalProperties: false,
      properties: { tool: { type: "string" }, reason: { type: "string", enum: OMISSION_REASONS } },
      required: ["tool", "reason"],
    },
  },
}
const scopeResolutionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    exact_action: { type: "string" },
    asset: { type: "string" },
    required_rule: { type: "string" },
    sources_checked: { type: "array", items: { type: "string" } },
    ambiguity: { type: "string" },
    resolution_attempt: { type: "string" },
    next_step: { type: "string" },
  },
  required: [
    "exact_action",
    "asset",
    "required_rule",
    "sources_checked",
    "ambiguity",
    "resolution_attempt",
    "next_step",
  ],
}

const hypothesisOracleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    primary_observation: { type: "string" },
    positive_condition: { type: "string" },
    negative_condition: { type: "string" },
    invalid_condition: { type: "string" },
    controls: { type: "array", maxItems: 20, items: { type: "string" } },
  },
  required: [
    "primary_observation",
    "positive_condition",
    "negative_condition",
    "invalid_condition",
    "controls",
  ],
}

const hypothesisTestResultSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    match: { type: "string", enum: ORACLE_MATCHES },
    observation: { type: "string" },
    primary_evidence_paths: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
    derived_evidence_paths: { type: "array", maxItems: 50, items: { type: "string" } },
    conflicts: { type: "array", maxItems: 20, items: { type: "string" } },
    interpretation: { type: "string" },
  },
  required: [
    "match",
    "observation",
    "primary_evidence_paths",
    "derived_evidence_paths",
    "conflicts",
    "interpretation",
  ],
}

const positiveHypothesisTestResultSchema = {
  ...hypothesisTestResultSchema,
  properties: {
    ...hypothesisTestResultSchema.properties,
    match: { type: "string", enum: ["POSITIVE"] },
  },
}

const bountyContextSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    cluster: { type: "string" },
    impact_class: { type: "string" },
    boundary: { type: "string" },
    enforcement_owner: { type: "string" },
    principals: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
    objects: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
    oracle: {
      type: "object",
      additionalProperties: false,
      properties: { vulnerable: { type: "string" }, secure: { type: "string" } },
      required: ["vulnerable", "secure"],
    },
    test_cost: { type: "string", enum: TEST_COSTS },
    reward: {
      type: "object",
      additionalProperties: false,
      properties: {
        target_severity: { type: "string", enum: REWARD_SEVERITIES },
        group_status: { type: "string", enum: REWARD_GROUP_STATUSES },
        group_id: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["target_severity", "group_status", "rationale"],
    },
  },
  required: [
    "cluster",
    "impact_class",
    "boundary",
    "enforcement_owner",
    "principals",
    "objects",
    "oracle",
    "test_cost",
    "reward",
  ],
}

const synthesisPivotSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    hypothesis_id: { type: "string" },
    compared_to_hypothesis_ids: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: { type: "string" },
    },
    changed_dimensions: {
      type: "array",
      minItems: 1,
      maxItems: PIVOT_DIMENSIONS.length,
      items: { type: "string", enum: PIVOT_DIMENSIONS },
    },
    distance_rationale: { type: "string" },
  },
  required: ["hypothesis_id", "compared_to_hypothesis_ids", "changed_dimensions", "distance_rationale"],
}

function hypothesisActionSchema(
  action: string,
  properties: Record<string, unknown> = {},
  required: readonly string[] = [],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", enum: [action] },
      ...properties,
    },
    required: ["action", ...required],
  }
}

export const HYPOTHESIS_TOOL_DEF = {
  name: "hypothesis",
  description:
    "Record, contextualize, claim, carry, and close durable hypotheses against a declared oracle while preserving primary and derived evidence. Bug Bounty portfolio phases require reward-aware bounty_context and structurally referenced pivots; no numeric ranking is performed.",
  inputSchema: {
    type: "object" as const,
    oneOf: [
      hypothesisActionSchema(
        "record",
        {
          id: { type: "string" },
          owner: { type: "string" },
          description: { type: "string" },
          root_cause: { type: "string" },
          surface: { type: "string" },
          discriminator: { type: "string" },
          oracle: hypothesisOracleSchema,
          candidate_tools: { type: "array", maxItems: 30, items: { type: "string" } },
          bounty_context: bountyContextSchema,
          ...hypothesisEvidenceProperties,
        },
        ["id", "owner", "description", "root_cause", "surface", "discriminator", "oracle"],
      ),
      hypothesisActionSchema(
        "set_bounty_context",
        { id: { type: "string" }, bounty_context: bountyContextSchema, reason: { type: "string" } },
        ["id", "bounty_context", "reason"],
      ),
      hypothesisActionSchema(
        "update",
        {
          id: { type: "string" },
          state: { type: "string", enum: ["TESTING"] },
          owner: { type: "string" },
          reason: { type: "string" },
          oracle: hypothesisOracleSchema,
        },
        ["id", "state"],
      ),
      hypothesisActionSchema(
        "update",
        {
          id: { type: "string" },
          state: { type: "string", enum: ["QUEUED"] },
          owner: { type: "string" },
          next_phase: { type: "string" },
          next_step: { type: "string" },
          ...hypothesisEvidenceProperties,
        },
        ["id", "state", "next_phase", "next_step"],
      ),
      ...(["SUSPECTED", "CONFIRMED"] as const).map((state) =>
        hypothesisActionSchema(
          "update",
          {
            id: { type: "string" },
            state: { type: "string", enum: [state] },
            owner: { type: "string" },
            finding_id: { type: "string" },
            reason: { type: "string" },
            test_result: hypothesisTestResultSchema,
            ...hypothesisEvidenceProperties,
          },
          ["id", "state", "finding_id", "test_result", "reason"],
        ),
      ),
      hypothesisActionSchema(
        "update",
        {
          id: { type: "string" },
          state: { type: "string", enum: ["DISPROVED"] },
          owner: { type: "string" },
          reason: { type: "string" },
          test_result: hypothesisTestResultSchema,
          ...hypothesisEvidenceProperties,
        },
        ["id", "state", "test_result", "reason"],
      ),
      hypothesisActionSchema(
        "update",
        {
          id: { type: "string" },
          state: { type: "string", enum: ["INCONCLUSIVE"] },
          owner: { type: "string" },
          blocker: { type: "string" },
          next_step: { type: "string" },
          reason: { type: "string" },
          test_result: hypothesisTestResultSchema,
          ...hypothesisEvidenceProperties,
        },
        ["id", "state", "test_result", "blocker", "next_step", "reason"],
      ),
      hypothesisActionSchema(
        "update",
        {
          id: { type: "string" },
          state: { type: "string", enum: ["UNTESTABLE"] },
          owner: { type: "string" },
          blocker: { type: "string" },
          blocker_reason: { type: "string", enum: BLOCKER_REASONS },
          next_step: { type: "string" },
          reason: { type: "string" },
          scope_resolution: scopeResolutionSchema,
          ...hypothesisEvidenceProperties,
        },
        ["id", "state", "blocker", "blocker_reason", "next_step", "reason"],
      ),
      hypothesisActionSchema(
        "claim",
        {
          id: { type: "string" },
          owner: { type: "string" },
          reason: { type: "string" },
          oracle: hypothesisOracleSchema,
        },
        ["id"],
      ),
      hypothesisActionSchema(
        "promote",
        {
          id: { type: "string", description: "TESTING hypothesis to link." },
          disposition: { type: "string", enum: ["SUSPECTED", "CONFIRMED"] },
          finding_key: { type: "string", description: "Stable finding alias; defaults to the hypothesis id." },
          title: { type: "string" },
          severity: { type: "string", enum: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          summary: { type: "string" },
          positive_evidence: {
            oneOf: [
              { type: "string" },
              { type: "array", minItems: 1, maxItems: 32, items: { type: "string" } },
            ],
          },
          evidence_paths: { type: "array", maxItems: 64, items: { type: "string" } },
          test_result: positiveHypothesisTestResultSchema,
          next_step: { type: "string" },
          reason: { type: "string" },
        },
        [
          "id",
          "disposition",
          "title",
          "severity",
          "summary",
          "positive_evidence",
          "evidence_paths",
          "test_result",
          "reason",
        ],
      ),
      hypothesisActionSchema(
        "reopen",
        {
          id: { type: "string" },
          owner: { type: "string" },
          reason: { type: "string" },
          oracle: hypothesisOracleSchema,
        },
        ["id"],
      ),
      hypothesisActionSchema("get", { id: { type: "string" } }, ["id"]),
      hypothesisActionSchema("list", {
        state: { type: "string", enum: STATES },
      }),
      hypothesisActionSchema(
        "synthesize",
        {
          outcome: { type: "string", enum: ["diversified", "exhausted"] },
          summary: { type: "string" },
          evidence: { type: "array", minItems: 1, maxItems: 30, items: { type: "string" } },
          evidence_refs: { type: "array", maxItems: 30, items: { type: "string" } },
          remaining_unknowns: { type: "array", maxItems: 30, items: { type: "string" } },
          opportunity_closeout: {
            type: "string",
            description:
              "Required in Bug Bounty portfolio mode: explain why untested authorized discriminators cannot improve the finding or reward portfolio, or name the exact authority/prerequisite that blocks them.",
          },
          pivots: { type: "array", maxItems: 20, items: synthesisPivotSchema },
          exhausted_hypothesis_ids: { type: "array", maxItems: 50, items: { type: "string" } },
          exhaustion_rationale: { type: "string" },
          no_candidate_evidence_refs: { type: "array", maxItems: 30, items: { type: "string" } },
        },
        ["outcome", "summary", "evidence"],
      ),
    ],
  },
}

export * as GatewayHypothesisRegistry from "./hypothesis-registry"
