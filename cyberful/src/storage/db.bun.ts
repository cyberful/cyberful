// ── Bun SQLite Driver ────────────────────────────────────────────────────
// Opens the Bun-native SQLite connection and wraps it with Drizzle.
// → cyberful/src/storage/db.ts — owns the process-wide database lifecycle.
// ─────────────────────────────────────────────────────────────────────────

import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"

export function init(path: string) {
  const sqlite = new Database(path, { create: true })
  const db = drizzle({ client: sqlite })
  return db
}
