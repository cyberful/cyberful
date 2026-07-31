// ── Session Hypothesis Registry Projection ──────────────────────
// Publishes revision hints and exposes one small host-owned view for the TUI.
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

export const View = Schema.Struct({
  revision: Schema.Number,
  workflow: Schema.String,
  activeCount: Schema.Number,
  countsByState: Schema.Record(State, Schema.Number),
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
