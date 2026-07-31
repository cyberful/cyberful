// ── Session Provider Usage Projection ────────────────────────────
// Defines the compact, restart-safe usage view rendered by the TUI footer.
// The append-only per-call ledger remains the authority for cost calculation.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"

export const Totals = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  generated: Schema.Number,
  reasoning: Schema.Number,
})

export const Scope = Schema.Struct({
  runID: Schema.String,
  parentRunID: Schema.optional(Schema.String),
  runKind: Schema.Literals(["root", "subagent", "fallback"]),
  group: Schema.Literals(["root", "subagents"]),
  totals: Totals,
})

export const View = Schema.Struct({
  root: Totals,
  subagents: Totals,
  scopes: Schema.Array(Scope),
}).annotate({ identifier: "Session.ProviderUsageView" })

export type View = typeof View.Type

export * as SessionProviderUsage from "./provider-usage"
