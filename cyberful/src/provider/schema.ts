// ── Provider And Model Identities ────────────────────────────────
// Brands provider and model strings so journal and configuration boundaries do
// not accidentally interchange distinct external identity fields.
// → cyberful/src/session/schema.ts — embeds these identities in session records.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"

import { withStatics } from "@/schema"

const providerIdSchema = Schema.String.pipe(Schema.brand("ProviderID"))

export type ProviderID = typeof providerIdSchema.Type

export const ProviderID = providerIdSchema.pipe(
  withStatics((schema: typeof providerIdSchema) => ({
    // Well-known providers
    anthropic: schema.make("anthropic"),
    openai: schema.make("openai"),
  })),
)

const modelIdSchema = Schema.String.pipe(Schema.brand("ModelID"))

export type ModelID = typeof modelIdSchema.Type

export const ModelID = modelIdSchema
