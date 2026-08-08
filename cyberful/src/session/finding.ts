// ── Session Finding Registry Bridge ──────────────────────────────
// Publishes workarea-registry revisions and exposes the registry's structured
//   operations as one host-owned dynamic tool for eligible workflow phases.
// → cyberful/src/finding/registry.ts — owns persistence and validation.
// → cyberful/src/session/prompt.ts — binds a session/run/phase to the tool.
// → cyberful/src/server/routes/instance/httpapi/groups/session.ts — exposes reads.
// ─────────────────────────────────────────────────────────────────

import { Event as EventDefinition } from "@/event"
import { FindingRegistry } from "@/finding/registry"
import type { DynamicTool } from "@/subsystem/subsystem"
import { SessionID } from "./schema"
import { Schema } from "effect"

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

const mutationActions = new Set(["record", "revisit", "update", "alias"])
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
const decisionProperties = {
  verification: { type: "string", enum: ["NOT_REVIEWED", "SURVIVES", "REVISE", "DEMOTE"] },
  verification_rationale: { type: "string" },
  submission: {
    type: "string",
    enum: ["NOT_ASSESSED", "SUBMISSION_READY", "NEEDS_MORE_EVIDENCE", "NOT_REPORTABLE"],
  },
  submission_rationale: { type: "string" },
}

function actionSchema(
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

function findingInputSchema(readonly: boolean) {
  const reads = [
    actionSchema("list"),
    actionSchema("get", { id: { type: "string" } }, ["id"]),
  ]
  if (readonly) return { oneOf: reads }
  const updateCommon = {
    id: { type: "string" },
    title: { type: "string" },
    summary: { type: "string" },
    severity: severitySchema,
    evidence_paths: evidencePathsSchema,
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
  options: { readonly: boolean },
): DynamicTool {
  return {
    definition: {
      type: "function",
      name: "finding",
      description: options.readonly
        ? "Read the authoritative workarea finding registry. Report is read-only: use list or get."
        : "Record and maintain supported security findings in the authoritative workarea registry. Use record immediately after positive evidence and include a required provisional INFO/LOW/MEDIUM/HIGH/CRITICAL severity; revisit historical findings, update every technical/verification/submission decision, alias stable workflow IDs, and list/get before handoff.",
      deferLoading: false,
      inputSchema: findingInputSchema(options.readonly),
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
        const result = await store.execute(input, run, context.signal)
        return { success: true, text: JSON.stringify(result) }
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

export * as SessionFinding from "./finding"
