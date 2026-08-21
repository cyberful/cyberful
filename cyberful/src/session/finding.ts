// ── Session Finding Registry Bridge ──────────────────────────────
// Publishes workarea-registry revisions and exposes the registry's structured
//   operations as one host-owned dynamic tool for eligible workflow phases.
// → cyberful/src/finding/registry.ts — owns persistence and validation.
// → cyberful/src/session/prompt.ts — binds a session/run/phase to the tool.
// → cyberful/src/server/routes/instance/httpapi/groups/session.ts — exposes reads.
// ─────────────────────────────────────────────────────────────────

import { Event as EventDefinition } from "@/event"
import { FindingRegistry } from "@/finding/registry"
import { FindingMaturation } from "@/finding/maturation"
import type { DynamicTool } from "@/subsystem/subsystem"
import type { GatewayRewardPolicy } from "@/subsystem/gateway/reward-policy"
import { isRecord } from "@/util/record"
import { SessionID } from "./schema"
import { Schema } from "effect"
import { attackAssessmentInputSchema } from "@/mitre-attack/assessment"

export const Event = {
  Updated: EventDefinition.define(
    "finding.registry.updated",
    Schema.Struct({
      sessionID: SessionID,
      workarea: Schema.String,
      revision: Schema.Number,
    }),
  ),
}

const mutationActions = new Set(["record", "revisit", "update", "set_attack_assessment", "alias"])
const positiveEvidenceSchema = {
  oneOf: [
    { type: "string", maxLength: 8_000 },
    {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: { type: "string", maxLength: 8_000 },
    },
  ],
}
const severitySchema = {
  type: "string",
  enum: ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
}
const evidencePathsSchema = { type: "array", items: { type: "string" }, maxItems: 100 }
const maturationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["PURSUE", "MAXIMIZED", "DEFERRED"] },
    current_impact: { type: "string" },
    target_severity: severitySchema,
    evidence_gap: { type: "string" },
    next_test: { type: "string" },
    conclusion: { type: "string" },
    reward_group_id: { type: "string" },
  },
  required: ["status", "current_impact"],
}
const decisionProperties = {
  verification: { type: "string", enum: ["NOT_REVIEWED", "SURVIVES", "REVISE", "DEMOTE"] },
  verification_rationale: { type: "string" },
  submission: {
    type: "string",
    enum: ["NOT_ASSESSED", "SUBMISSION_READY", "NEEDS_MORE_EVIDENCE", "NOT_REPORTABLE"],
  },
  submission_rationale: { type: "string" },
}

function actionSchema(action: string, properties: Record<string, unknown> = {}, required: readonly string[] = []) {
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

function findingInputSchema(readonly: boolean, allowAttackReview: boolean) {
  const attackAssessmentSchema = attackAssessmentInputSchema({ allowReview: allowAttackReview })
  const reads = [actionSchema("list"), actionSchema("get", { id: { type: "string" } }, ["id"])]
  if (readonly) return { oneOf: reads }
  const updateCommon = {
    id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    severity: severitySchema,
    evidence_paths: evidencePathsSchema,
    maturation: maturationSchema,
    attack_assessment: attackAssessmentSchema,
    ...decisionProperties,
  }
  return {
    oneOf: [
      actionSchema(
        "record",
        {
          key: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          positive_evidence: positiveEvidenceSchema,
          next_step: { type: "string" },
          severity: severitySchema,
          evidence_paths: evidencePathsSchema,
          maturation: maturationSchema,
          attack_assessment: attackAssessmentSchema,
        },
        ["key", "title", "positive_evidence", "severity"],
      ),
      actionSchema(
        "revisit",
        {
          id: { type: "string" },
          plan: { type: "string" },
          summary: { type: "string" },
          evidence_paths: evidencePathsSchema,
        },
        ["id", "plan"],
      ),
      actionSchema("alias", { id: { type: "string" }, alias: { type: "string" } }, ["id", "alias"]),
      actionSchema("set_attack_assessment", { id: { type: "string" }, assessment: attackAssessmentSchema }, [
        "id",
        "assessment",
      ]),
      actionSchema(
        "update",
        {
          ...updateCommon,
          state: { type: "string", enum: ["SUSPECTED"] },
          positive_evidence: positiveEvidenceSchema,
          next_step: { type: "string" },
        },
        ["id", "state", "positive_evidence", "summary"],
      ),
      actionSchema(
        "update",
        {
          ...updateCommon,
          state: { type: "string", enum: ["INCONCLUSIVE"] },
          ambiguity: { type: "string" },
          next_step: { type: "string" },
        },
        ["id", "state", "ambiguity", "next_step", "summary"],
      ),
      actionSchema(
        "update",
        {
          ...updateCommon,
          state: { type: "string", enum: ["UNTESTABLE"] },
          blocker_kind: { type: "string" },
          blocker_reason: { type: "string" },
          next_step: { type: "string" },
        },
        ["id", "state", "blocker_kind", "blocker_reason", "next_step", "summary"],
      ),
      actionSchema(
        "update",
        {
          ...updateCommon,
          state: { type: "string", enum: ["CONFIRMED"] },
          proof: { type: "string" },
        },
        ["id", "state", "proof", "summary"],
      ),
      actionSchema(
        "update",
        {
          ...updateCommon,
          state: { type: "string", enum: ["DISPROVED"] },
          disproof: { type: "string" },
        },
        ["id", "state", "disproof", "summary"],
      ),
      ...reads,
    ],
  }
}

function toolFailure(code: string, path: string, hint: string, input: unknown) {
  return JSON.stringify({
    error: {
      code,
      path,
      expected: "input matching the advertised tool schema",
      receivedType: Array.isArray(input) ? "array" : input === null ? "null" : typeof input,
      retryable: true,
      hint,
    },
  })
}

function actionOf(input: unknown) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return "action" in input && typeof input.action === "string" ? input.action : undefined
}

export function dynamicTool(
  store: FindingRegistry.Store,
  run: FindingRegistry.RunContext,
  options: {
    readonly: boolean
    rewardPolicy?: () => Promise<GatewayRewardPolicy.RewardPolicy | undefined>
    onMaturation?: (notice: MaturationNotice) => void
  },
): DynamicTool {
  return {
    definition: {
      type: "function",
      name: "finding",
      description: options.readonly
        ? "Read the authoritative workarea finding registry. Report is read-only: use list or get."
        : "Record and maintain supported security findings in the authoritative workarea registry. Use record immediately after positive evidence and include a required provisional INFO/LOW/MEDIUM/HIGH/CRITICAL severity; answer host-authored maturation checkpoints with PURSUE, MAXIMIZED, or DEFERRED; revisit historical findings, update every technical/verification/submission decision, alias stable workflow IDs, and list/get before handoff.",
      deferLoading: false,
      inputSchema: findingInputSchema(options.readonly, run.phase === "verify"),
    },
    execute: async (input, context) => {
      const action = actionOf(input)
      if (options.readonly && action && mutationActions.has(action))
        return {
          success: false,
          text: toolFailure(
            "FINDING_READ_ONLY",
            "finding.action",
            "The finding registry is read-only in Report; use list or get.",
            input,
          ),
        }
      try {
        const record = isRecord(input) ? input : {}
        const current = await currentFinding(store, record)
        let rewardPolicy: GatewayRewardPolicy.RewardPolicy | undefined
        let rewardPolicyWarning: string | undefined
        if (
          run.workflow === "bug-bounty" &&
          (record.action === "record" || record.action === "update") &&
          options.rewardPolicy
        )
          try {
            rewardPolicy = await options.rewardPolicy()
          } catch (error) {
            rewardPolicyWarning = `Reward policy could not be read; technical maturation continues without reward data: ${
              error instanceof Error ? error.message : String(error)
            }`
          }
        const advisory = FindingMaturation.buildAdvisory({
          workflow: run.workflow,
          phase: run.phase,
          toolInput: record,
          finding: current,
          policy: rewardPolicy,
        })
        const result = await store.execute(
          advisory ? { ...record, _maturation_checkpoint: advisory.checkpoint } : input,
          run,
          context.signal,
        )
        if (!advisory || !isRecord(result))
          return {
            success: true,
            text: JSON.stringify(
              rewardPolicyWarning && isRecord(result)
                ? { ...result, reward_policy_warning: rewardPolicyWarning }
                : result,
            ),
          }
        const notice: MaturationNotice = {
          workflow: run.workflow,
          phase: run.phase,
          findingID: typeof result.id === "string" ? result.id : String(record.id ?? record.key ?? "finding"),
          alias: Array.isArray(result.aliases) && typeof result.aliases[0] === "string" ? result.aliases[0] : undefined,
          title: typeof result.title === "string" ? result.title : "Supported finding",
          currentSeverity: advisory.currentSeverity,
          targetSeverity: advisory.targetSeverity,
          checkpoint: advisory.checkpoint,
        }
        options.onMaturation?.(notice)
        return {
          success: true,
          text: JSON.stringify({
            ...result,
            maturation_advisory: notice,
            ...(rewardPolicyWarning ? { reward_policy_warning: rewardPolicyWarning } : {}),
          }),
        }
      } catch (error) {
        return {
          success: false,
          text:
            error instanceof FindingRegistry.FindingRegistryError
              ? JSON.stringify({ error: error.toolError(input) })
              : toolFailure(
                  "FINDING_VALIDATION_FAILED",
                  "finding",
                  error instanceof Error ? error.message : String(error),
                  input,
                ),
        }
      }
    },
  }
}

export interface MaturationNotice {
  readonly workflow: FindingRegistry.Workflow
  readonly phase: string
  readonly findingID: string
  readonly alias?: string
  readonly title: string
  readonly currentSeverity: Exclude<FindingRegistry.Severity, "UNRATED">
  readonly targetSeverity?: Exclude<FindingRegistry.Severity, "UNRATED">
  readonly checkpoint: FindingRegistry.MaturationCheckpoint
}

async function currentFinding(store: FindingRegistry.Store, input: Record<string, unknown>) {
  const reference = input.action === "record" ? input.key : input.action === "update" ? input.id : undefined
  if (typeof reference !== "string" || !reference.trim()) return
  try {
    return await store.get(reference)
  } catch (error) {
    if (error instanceof FindingRegistry.FindingRegistryError && error.code === "FINDING_NOT_FOUND") return
    throw error
  }
}

export * as SessionFinding from "./finding"
