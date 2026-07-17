// ── Data Migration Completion Schema ─────────────────────────────────────────
// Records which resumable data migrations have completed so startup never
// repeats a finished backfill.
// → cyberful/src/data-migration.ts — runs and records each named backfill.
// ─────────────────────────────────────────────────────────────────────────────

import { sqliteTable, text } from "drizzle-orm/sqlite-core"

export const DataMigrationTable = sqliteTable("data_migration", {
  name: text().primaryKey(),
})
