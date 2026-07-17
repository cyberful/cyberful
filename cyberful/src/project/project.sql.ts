// ── Project Persistence Schema ───────────────────────────────────────────────
// Declares the SQLite table that persists project identity, roots, icons, and lifecycle times.
// → cyberful/src/project/project.ts — maps this table to the project domain model.
// ────────────────────────────────────────────────────────────────────────

import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { ProjectID } from "./schema"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectID>().primaryKey(),
  worktree: text().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
})
