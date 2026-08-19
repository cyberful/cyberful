// ── Session Hypothesis Registry Projection ──────────────────────
// Publishes revision hints, state counts, and active hypothesis details for the TUI.
// Persistence and lifecycle mutations remain owned by the gateway registry.
// → cyberful/src/subsystem/gateway/hypothesis-registry.ts — canonical writer.
// → cyberful/src/server/routes/instance/httpapi/groups/session.ts — read endpoint.
// ─────────────────────────────────────────────────────────────────

import { Event as EventDefinition } from "@/event"
import { Schema } from "effect"
import { SessionID } from "./schema"

export const State = Schema.Literals([
  "OPEN",
  "QUEUED",
  "TESTING",
  "SUSPECTED",
  "CONFIRMED",
  "DISPROVED",
  "INCONCLUSIVE",
  "UNTESTABLE",
])

export const Oracle = Schema.Struct({
  primary_observation: Schema.String,
  positive_condition: Schema.String,
  negative_condition: Schema.String,
  invalid_condition: Schema.String,
  controls: Schema.Array(Schema.String),
})

export const OracleMatch = Schema.Literals(["POSITIVE", "NEGATIVE", "INVALID", "CONFLICT"])

export const TestResult = Schema.Struct({
  match: OracleMatch,
  observation: Schema.String,
  primary_evidence_paths: Schema.Array(Schema.String),
  derived_evidence_paths: Schema.Array(Schema.String),
  conflicts: Schema.Array(Schema.String),
  interpretation: Schema.String,
})

export const Item = Schema.Struct({
  id: Schema.String,
  phase: Schema.String,
  owner: Schema.String,
  ownerDisplayName: Schema.optional(Schema.String),
  description: Schema.String,
  rootCause: Schema.String,
  surface: Schema.String,
  discriminator: Schema.String,
  oracle: Schema.optional(Oracle),
  latestTestResult: Schema.optional(TestResult),
  candidateTools: Schema.Array(Schema.String),
  omittedTools: Schema.Array(
    Schema.Struct({
      tool: Schema.String,
      reason: Schema.String,
    }),
  ),
  state: State,
  evidence: Schema.Array(Schema.String),
  evidenceRefs: Schema.Array(Schema.String),
  blocker: Schema.optional(Schema.String),
  blockerReason: Schema.optional(Schema.String),
  nextStep: Schema.optional(Schema.String),
  nextPhase: Schema.optional(Schema.String),
  findingID: Schema.optional(Schema.String),
  graphRefs: Schema.Array(Schema.String),
  transitions: Schema.Array(
    Schema.Struct({
      time: Schema.String,
      phase: Schema.String,
      owner: Schema.String,
      from: Schema.optional(State),
      to: State,
      evidence: Schema.Array(Schema.String),
      reason: Schema.optional(Schema.String),
      testResult: Schema.optional(TestResult),
    }),
  ),
})

export type Item = typeof Item.Type

export const View = Schema.Struct({
  revision: Schema.Number,
  workflow: Schema.String,
  activeCount: Schema.Number,
  countsByState: Schema.Record(State, Schema.Number),
  activeHypotheses: Schema.Array(Item),
}).annotate({ identifier: "Session.HypothesisRegistryView" })

export type View = typeof View.Type

export const Event = {
  Updated: EventDefinition.define(
    "hypothesis.registry.updated",
    Schema.Struct({
      sessionID: SessionID,
      workarea: Schema.String,
      revision: Schema.Number,
    }),
  ),
}

export * as SessionHypothesis from "./hypothesis"
