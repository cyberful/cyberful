// ── Project Identifier Schema ───────────────────────────────────────────────
// Brands project identifiers and exposes the distinguished global-project value.
// → cyberful/src/project/project.ts — resolves and persists branded identifiers.
// ────────────────────────────────────────────────────────────────────────

import { Schema } from "effect"

import { withStatics } from "@/schema"

const projectIdSchema = Schema.String.pipe(Schema.brand("ProjectID"))

export type ProjectID = typeof projectIdSchema.Type

export const ProjectID = projectIdSchema.pipe(
  withStatics((schema: typeof projectIdSchema) => ({
    global: schema.make("global"),
  })),
)
