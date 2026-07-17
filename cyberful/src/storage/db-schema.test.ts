// ── Database Schema Contract ─────────────────────────────────────────────────
// Verifies that one fresh-install migration creates exactly the tables, columns,
// and indexes consumed by the runtime.
// → cyberful/migration/ — contains the schema journal under test.
// → cyberful/src/session/session.sql.ts — declares the runtime-facing schema.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readdir } from "node:fs/promises"
import path from "node:path"

const migrationRoot = path.join(import.meta.dirname, "../../migration")

async function freshDatabase() {
  const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^\d{14}/.test(name))
    .toSorted()

  expect(migrations).toEqual(["20260623153000_baseline"])

  const database = new Database(":memory:")
  database.run("PRAGMA foreign_keys = ON")
  for (const migration of migrations) {
    const sql = await Bun.file(path.join(migrationRoot, migration, "migration.sql")).text()
    database.exec(sql.replaceAll("--> statement-breakpoint", ""))
  }
  return database
}

function names(database: Database, query: string) {
  return database
    .query<{ name: string }, []>(query)
    .all()
    .map((row) => row.name)
}

const expectedColumns = {
  data_migration: ["name"],
  message: ["id", "session_id", "time_created", "data"],
  part: ["id", "message_id", "session_id", "data"],
  project: [
    "id",
    "worktree",
    "vcs",
    "name",
    "icon_url",
    "icon_url_override",
    "icon_color",
    "time_created",
    "time_updated",
  ],
  session: [
    "id",
    "project_id",
    "parent_id",
    "slug",
    "directory",
    "path",
    "title",
    "version",
    "summary_additions",
    "summary_deletions",
    "summary_files",
    "summary_diffs",
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "tokens_cache_read",
    "tokens_cache_write",
    "revert",
    "workflow",
    "agent",
    "model",
    "time_created",
    "time_updated",
    "time_compacting",
    "time_archived",
  ],
  session_variable: ["session_id", "name", "source_message_id", "description", "value"],
  todo: ["session_id", "content", "status", "priority", "position"],
} satisfies Record<string, string[]>

describe("fresh database schema", () => {
  test("contains exactly the runtime-owned tables", async () => {
    using database = await freshDatabase()

    expect(
      names(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"),
    ).toEqual(["data_migration", "message", "part", "project", "session", "session_variable", "todo"])
  })

  test("creates every final table shape without legacy or unused columns", async () => {
    using database = await freshDatabase()

    for (const [table, columns] of Object.entries(expectedColumns)) {
      expect(names(database, `SELECT name FROM pragma_table_info('${table}') ORDER BY cid`)).toEqual(columns)
    }
  })

  test("keeps only indexes that support runtime query paths", async () => {
    using database = await freshDatabase()

    expect(
      names(database, "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"),
    ).toEqual([
      "message_session_time_created_id_idx",
      "part_message_id_id_idx",
      "part_session_idx",
      "session_parent_idx",
      "session_project_idx",
    ])
  })
})
