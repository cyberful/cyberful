// ── Shared Persistence Timestamps ───────────────────────────────────────────
// Defines the created and updated columns shared by persisted domain tables.
// → cyberful/src/project/project.sql.ts — embeds these project timestamps.
// → cyberful/src/session/session.sql.ts — embeds these session timestamps.
// ─────────────────────────────────────────────────────────────────────────

import { integer } from "drizzle-orm/sqlite-core"

export const Timestamps = {
  time_created: integer()
    .notNull()
    .$default(() => Date.now()),
  time_updated: integer()
    .notNull()
    .$onUpdate(() => Date.now()),
}
