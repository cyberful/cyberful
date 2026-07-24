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
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: options.readonly ? ["list", "get"] : ["record", "revisit", "update", "alias", "list", "get"],
          },
          id: { type: "string" },
          key: { type: "string" },
          alias: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          positive_evidence: { type: "string" },
          proof: { type: "string" },
          disproof: { type: "string" },
          ambiguity: { type: "string" },
          blocker_kind: { type: "string" },
          blocker_reason: { type: "string" },
          next_step: { type: "string" },
          plan: { type: "string" },
          state: {
            type: "string",
            enum: ["SUSPECTED", "INCONCLUSIVE", "UNTESTABLE", "CONFIRMED", "DISPROVED"],
          },
          verification: { type: "string", enum: ["NOT_REVIEWED", "SURVIVES", "REVISE", "DEMOTE"] },
          verification_rationale: { type: "string" },
          submission: {
            type: "string",
            enum: ["NOT_ASSESSED", "SUBMISSION_READY", "NEEDS_MORE_EVIDENCE", "NOT_REPORTABLE"],
          },
          submission_rationale: { type: "string" },
          severity: {
            type: "string",
            enum: ["UNRATED", "INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
            description:
              "Required for record and for updating legacy UNRATED findings. New assessments must use INFO, LOW, MEDIUM, HIGH, or CRITICAL; omit on update to preserve an existing concrete rating.",
          },
          evidence_paths: { type: "array", items: { type: "string" }, maxItems: 100 },
        },
        required: ["action"],
      },
    },
    execute: async (input, context) => {
      const action = actionOf(input)
      if (options.readonly && action && mutationActions.has(action))
        return { success: false, text: "The finding registry is read-only in Report; use list or get." }
      try {
        const result = await store.execute(input, run, context.signal)
        return { success: true, text: JSON.stringify(result) }
      } catch (error) {
        return { success: false, text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

export * as SessionFinding from "./finding"
