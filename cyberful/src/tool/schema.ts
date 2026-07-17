// ── Tool Identifier Schema ───────────────────────────────────────
// Defines and generates branded, time-ordered identifiers shared by tool calls,
//   session parts, truncation artifacts, and transport events.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { withStatics } from "@/schema"

const toolIdSchema = Schema.String.check(Schema.isStartsWith("tool")).pipe(Schema.brand("ToolID"))

export type ToolID = typeof toolIdSchema.Type

export const ToolID = toolIdSchema.pipe(
  withStatics((schema: typeof toolIdSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("tool", id)),
  })),
)
