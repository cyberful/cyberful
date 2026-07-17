// ── Skill Path Configuration Schema ──────────────────────────────
// Defines the optional additional skill directories accepted by runtime config.
// → cyberful/src/skill/index.ts — discovers skills from validated paths.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"

export const Info = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
})

export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigSkills from "./skills"
