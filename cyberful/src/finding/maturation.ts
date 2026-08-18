// ── Finding Maturation Checkpoints ──────────────────────────────
// Builds deterministic, phase-aware reflection bundles for supported findings
//   and derives reward deltas only from the persisted official program policy.
// → cyberful/src/finding/registry.ts — persists assessments and checkpoints.
// → cyberful/src/session/finding.ts — returns and streams the advisory.
// @docs/concepts/execution-model.md
// ─────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto"
import { Identifier } from "@/id/id"
import type { FindingRegistry } from "@/finding/registry"
import type { GatewayRewardPolicy } from "@/subsystem/gateway/reward-policy"
import { isRecord } from "@/util/record"

const ratedSeverities = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const
type RatedSeverity = (typeof ratedSeverities)[number]

export interface Advisory {
  readonly checkpoint: FindingRegistry.MaturationCheckpoint
  readonly currentSeverity: RatedSeverity
  readonly targetSeverity?: RatedSeverity
}

function severity(value: unknown): RatedSeverity | undefined {
  return ratedSeverities.find((candidate) => candidate === value)
}

function nextSeverity(value: RatedSeverity): RatedSeverity | undefined {
  const index = ratedSeverities.indexOf(value)
  return ratedSeverities[index + 1]
}

function higherSeverity(current: RatedSeverity, candidate: RatedSeverity | undefined) {
  if (!candidate) return
  return ratedSeverities.indexOf(candidate) > ratedSeverities.indexOf(current) ? candidate : undefined
}

function latestAssessed(finding: FindingRegistry.Finding | undefined) {
  return finding?.observations.findLast((observation) => observation.review === "ASSESSED")
}

function assessmentInput(input: Record<string, unknown>) {
  return isRecord(input.maturation) ? input.maturation : undefined
}

function rewardGroupID(input: Record<string, unknown>, finding: FindingRegistry.Finding | undefined) {
  const requested = assessmentInput(input)?.reward_group_id
  if (typeof requested === "string" && requested.trim()) return requested.trim()
  return latestAssessed(finding)?.maturation?.assessment?.rewardGroupID
}

function band(
  group: GatewayRewardPolicy.RewardGroup,
  severityValue: RatedSeverity,
  kind: GatewayRewardPolicy.RewardPolicyKind,
): FindingRegistry.RewardBand | undefined {
  if (kind !== "MONETARY" && kind !== "POINTS") return
  const tier = group.tiers.find((candidate) => candidate.severity === severityValue)
  if (tier?.minimum === undefined || tier.maximum === undefined) return
  return {
    severity: severityValue,
    minimum: tier.minimum,
    maximum: tier.maximum,
    unit: kind === "MONETARY" ? "MONEY" : "POINTS",
    ...(tier.currency ? { currency: tier.currency } : {}),
  }
}

function rewardSnapshot(input: {
  readonly policy?: GatewayRewardPolicy.RewardPolicy
  readonly groupID?: string
  readonly currentSeverity: RatedSeverity
  readonly targetSeverity?: RatedSeverity
}): FindingRegistry.RewardSnapshot | undefined {
  const policy = input.policy
  if (!policy) return
  const group =
    policy.groups.length === 1
      ? policy.groups[0]
      : input.groupID
        ? policy.groups.find((candidate) => candidate.id === input.groupID)
        : undefined
  const current = group ? band(group, input.currentSeverity, policy.kind) : undefined
  const target = group && input.targetSeverity ? band(group, input.targetSeverity, policy.kind) : undefined
  const sameUnit = current && target && current.unit === target.unit
  const sameCurrency = current?.unit !== "MONEY" || current.currency === target?.currency
  const upside =
    sameUnit && sameCurrency
      ? {
          minimum: Math.max(0, target.minimum - current.maximum),
          maximum: Math.max(0, target.maximum - current.minimum),
          unit: current.unit,
          ...(current.currency ? { currency: current.currency } : {}),
        }
      : undefined
  return {
    policyRevision: policy.revision,
    policyKind: policy.kind,
    ...(group ? { groupID: group.id, groupLabel: group.label } : {}),
    ...(current ? { current } : {}),
    ...(target ? { target } : {}),
    ...(upside ? { upside } : {}),
  }
}

export function formatRewardBand(value: FindingRegistry.RewardBand | undefined) {
  if (!value) return
  const amount = value.minimum === value.maximum ? `${value.minimum}` : `${value.minimum}–${value.maximum}`
  return value.unit === "MONEY" ? `${value.currency ?? "currency"} ${amount}` : `${amount} points`
}

export function formatRewardUpside(value: FindingRegistry.RewardSnapshot["upside"]) {
  if (!value) return
  const amount = value.minimum === value.maximum ? `${value.minimum}` : `${value.minimum}–${value.maximum}`
  return value.unit === "MONEY" ? `${value.currency ?? "currency"} ${amount}` : `${amount} points`
}

function questions(input: {
  readonly workflow: FindingRegistry.Workflow
  readonly phase: string
  readonly targetSeverity?: RatedSeverity
  readonly reward?: FindingRegistry.RewardSnapshot
  readonly rewardGroupRequired?: boolean
}) {
  const target = input.targetSeverity ?? "the strongest defensible tier"
  if (input.workflow === "pentest")
    return [
      "What is the strongest impact currently supported by the evidence?",
      `What exact evidence is missing to reach ${target}?`,
      input.phase === "hacker"
        ? "Can this finding be chained with another supported observation to increase impact?"
        : input.phase === "verify"
          ? "What would an independent reviewer challenge before accepting this impact?"
          : "Which authorized test would close that gap most efficiently?",
    ]

  const currentReward = formatRewardBand(input.reward?.current)
  const targetReward = formatRewardBand(input.reward?.target)
  const upside = formatRewardUpside(input.reward?.upside)
  const rewardContext =
    currentReward && targetReward
      ? ` The published schedule moves from ${currentReward} to ${targetReward}${upside ? `, an upside of ${upside}` : ""}.`
      : ""
  const rewardTarget = currentReward && targetReward ? " and its next reward tier" : ""
  const phaseQuestion =
    input.rewardGroupRequired
      ? "Which official reward group applies to this finding's affected asset? Record its reward_group_id before comparing tiers."
      : input.phase === "recon"
      ? "Which impact path should Recon carry forward for focused validation?"
      : input.phase === "hacker"
        ? "Can this finding be chained with another supported observation to increase impact?"
      : input.phase === "verify"
          ? "What security invariant is violated, what concrete unwanted attacker effect is proven, and why does the evidence defeat the cheapest benign explanation?"
          : "Which control or benign twin could disprove the claimed escalation?"
  return [
    "What is the strongest impact currently supported by the evidence?",
    `What exact evidence is missing to reach ${target}${rewardTarget}?${rewardContext}`,
    "Which authorized test would close that gap most efficiently?",
    phaseQuestion,
  ]
}

function workflowPhaseEligible(workflow: FindingRegistry.Workflow, phase: string) {
  if (workflow === "bug-bounty") return ["recon", "exploit", "hacker", "verify"].includes(phase)
  return workflow === "pentest" && ["exploit", "hacker", "verify"].includes(phase)
}

// ── Checkpoint Signatures Suppress Noise, Not New Frontiers ──────
// Tool retries and evidence-path merges can repeat a supported finding without
// changing the decision the agent must make. The signature deliberately ignores
// prose and evidence-path ordering, but includes phase, severity frontier,
// assessment gap, reward group, and policy revision. A phase transition or any
// material maturation change therefore produces one fresh visible checkpoint.
// ─────────────────────────────────────────────────────────────────
export function buildAdvisory(input: {
  readonly workflow: FindingRegistry.Workflow
  readonly phase: string
  readonly toolInput: Record<string, unknown>
  readonly finding?: FindingRegistry.Finding
  readonly policy?: GatewayRewardPolicy.RewardPolicy
  readonly now?: () => Date
}): Advisory | undefined {
  if (!workflowPhaseEligible(input.workflow, input.phase)) return
  const action = input.toolInput.action
  if (action !== "record" && action !== "update") return
  if (action === "update" && input.toolInput.state === "DISPROVED") return
  const previous = latestAssessed(input.finding)
  const currentSeverity = severity(input.toolInput.severity) ?? severity(previous?.severity)
  if (!currentSeverity) return
  const assessment = assessmentInput(input.toolInput)
  const requestedTarget = higherSeverity(currentSeverity, severity(assessment?.target_severity))
  const targetSeverity = requestedTarget ?? (assessment?.status === "MAXIMIZED" ? undefined : nextSeverity(currentSeverity))
  const groupID = rewardGroupID(input.toolInput, input.finding)
  const reward =
    input.workflow === "bug-bounty"
      ? rewardSnapshot({ policy: input.policy, groupID, currentSeverity, targetSeverity })
      : undefined
  const signature = createHash("sha256")
    .update(
      JSON.stringify({
        finding:
          input.toolInput.action === "record"
            ? input.toolInput.key
            : input.finding?.id ?? input.toolInput.id,
        phase: input.phase,
        currentSeverity,
        targetSeverity,
        status: assessment?.status,
        currentImpact: assessment?.current_impact,
        evidenceGap: assessment?.evidence_gap,
        nextTest: assessment?.next_test,
        conclusion: assessment?.conclusion,
        rewardGroupID: groupID,
        rewardRevision: reward?.policyRevision,
      }),
    )
    .digest("hex")
  if (previous?.maturation?.checkpoint?.signature === signature) return
  const checkpoint: FindingRegistry.MaturationCheckpoint = {
    id: Identifier.create("mat", "ascending"),
    signature,
    promptedAt: (input.now ?? (() => new Date()))().toISOString(),
    questions: questions({
      workflow: input.workflow,
      phase: input.phase,
      targetSeverity,
      reward,
      rewardGroupRequired: input.policy?.groups.length !== 1 && Boolean(input.policy?.groups.length) && !reward?.groupID,
    }),
    ...(reward ? { reward } : {}),
  }
  return { checkpoint, currentSeverity, ...(targetSeverity ? { targetSeverity } : {}) }
}

export * as FindingMaturation from "./maturation"
