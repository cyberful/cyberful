// ── Subsystem And Model Identities ───────────────────────────────
// Brands subsystem and model strings so journal and configuration boundaries do
// not accidentally interchange distinct external identity fields.
// → cyberful/src/session/schema.ts — embeds these identities in session records.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"

import { withStatics } from "@/schema"

const subsystemIdSchema = Schema.String.pipe(Schema.brand("SubsystemID"))

export type SubsystemID = typeof subsystemIdSchema.Type

export const SubsystemID = subsystemIdSchema.pipe(
  withStatics((schema: typeof subsystemIdSchema) => ({
    // Well-known subsystems
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
  })),
)

const modelIdSchema = Schema.String.pipe(Schema.brand("ModelID"))

export type ModelID = typeof modelIdSchema.Type

export const ModelID = modelIdSchema
