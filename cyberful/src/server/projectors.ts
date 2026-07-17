// ── Session Sync Projector Registration ─────────────────────────
// Registers persisted session event projectors and enriches session updates
// from the current database row before synchronized events are published.
// → cyberful/src/server/init-projectors.ts — invokes registration at server startup.
// ─────────────────────────────────────────────────────────────────

import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { Schema } from "effect"

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = Schema.decodeUnknownSync(Session.Event.Updated.schema)(data).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}
