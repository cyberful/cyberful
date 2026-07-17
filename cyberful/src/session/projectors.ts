// ── Session Event Projectors ─────────────────────────────────────────────────
// Projects durable session, message, and part events into SQLite while
// preserving usage totals and foreign-key cleanup semantics.
// → cyberful/src/session/session.sql.ts — declares the projected tables.
// ─────────────────────────────────────────────────────────────────────────────

import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { sql } from "drizzle-orm"
import type { TxOrDb } from "@/storage/db"
import { SyncEvent } from "@/sync"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { Log } from "@/util/log"

const log = Log.create({ service: "session.projector" })

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof err.message === "string" && err.message.includes("FOREIGN KEY constraint failed")
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T

type Usage = Pick<MessageV2.StepFinishPart, "tokens">

function usage(part: MessageV2.Part | (typeof PartTable.$inferSelect)["data"]): Usage | undefined {
  if (part.type !== "step-finish") return undefined
  if (!("tokens" in part)) return undefined
  return { tokens: part.tokens }
}

function applyUsage(db: TxOrDb, sessionID: Session.Info["id"], value: Usage, sign = 1) {
  db.update(SessionTable)
    .set({
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
}

function grab<T extends object, Key extends keyof T>(obj: T, field: Key): T[Key] | undefined
function grab<T extends object, Key extends keyof T, Result>(
  obj: T,
  field: Key,
  transform: (value: NonNullable<T[Key]>) => Result,
): Result | undefined
function grab<T extends object, Key extends keyof T, Result>(
  obj: T,
  field: Key,
  transform?: (value: NonNullable<T[Key]>) => Result,
): T[Key] | Result | undefined {
  if (!(field in obj)) return undefined

  const value = obj[field]
  if (value && typeof value === "object" && transform) {
    return transform(value)
  }
  if (value === undefined) {
    throw new Error(
      "Session update failure: pass `null` to clear a field instead of `undefined`: " + JSON.stringify(obj),
    )
  }
  return value
}

export function toPartialRow(info: DeepPartial<Session.Info>) {
  const obj = {
    id: grab(info, "id"),
    project_id: grab(info, "projectID"),
    parent_id: grab(info, "parentID"),
    slug: grab(info, "slug"),
    directory: grab(info, "directory"),
    path: grab(info, "path"),
    title: grab(info, "title"),
    version: grab(info, "version"),
    summary_additions: grab(info, "summary", (v) => grab(v, "additions")),
    summary_deletions: grab(info, "summary", (v) => grab(v, "deletions")),
    summary_files: grab(info, "summary", (v) => grab(v, "files")),
    summary_diffs: grab(info, "summary", (v) => grab(v, "diffs")),
    tokens_input: grab(info, "tokens", (v) => grab(v, "input")),
    tokens_output: grab(info, "tokens", (v) => grab(v, "output")),
    tokens_reasoning: grab(info, "tokens", (v) => grab(v, "reasoning")),
    tokens_cache_read: grab(info, "tokens", (v) => grab(v, "cache", (cache) => grab(cache, "read"))),
    tokens_cache_write: grab(info, "tokens", (v) => grab(v, "cache", (cache) => grab(cache, "write"))),
    workflow: grab(info, "workflow"),
    revert: grab(info, "revert"),
    time_created: grab(info, "time", (v) => grab(v, "created")),
    time_updated: grab(info, "time", (v) => grab(v, "updated")),
    time_compacting: grab(info, "time", (v) => grab(v, "compacting")),
    time_archived: grab(info, "time", (v) => grab(v, "archived")),
  }

  return Object.fromEntries(Object.entries(obj).filter(([_, val]) => val !== undefined))
}

export default [
  SyncEvent.project(Session.Event.Created, (db, data) => {
    db.insert(SessionTable).values(Session.toRow(data.info)).run()
  }),

  SyncEvent.project(Session.Event.Updated, (db, data) => {
    const info = data.info
    const row = db
      .update(SessionTable)
      .set({ time_updated: sql`${SessionTable.time_updated}`, ...toPartialRow(info) })
      .where(eq(SessionTable.id, data.sessionID))
      .returning()
      .get()
    if (!row) throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
  }),

  SyncEvent.project(Session.Event.Deleted, (db, data) => {
    db.delete(SessionTable).where(eq(SessionTable.id, data.sessionID)).run()
  }),

  SyncEvent.project(MessageV2.Event.Updated, (db, data) => {
    const time_created = data.info.time.created
    const { id, sessionID, ...rest } = data.info

    try {
      db.insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          time_created,
          data: rest,
        })
        .onConflictDoUpdate({ target: MessageTable.id, set: { data: rest } })
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late message update", { messageID: id, sessionID })
    }
  }),

  SyncEvent.project(MessageV2.Event.Removed, (db, data) => {
    for (const row of db
      .select()
      .from(PartTable)
      .where(and(eq(PartTable.message_id, data.messageID), eq(PartTable.session_id, data.sessionID)))
      .all()) {
      const previous = usage(row.data)
      if (previous) applyUsage(db, data.sessionID, previous, -1)
    }
    db.delete(MessageTable)
      .where(and(eq(MessageTable.id, data.messageID), eq(MessageTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartRemoved, (db, data) => {
    const row = db
      .select()
      .from(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
      .get()
    const previous = row && usage(row.data)
    if (previous) applyUsage(db, data.sessionID, previous, -1)

    db.delete(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartUpdated, (db, data) => {
    const { id, messageID, sessionID, ...rest } = data.part
    const row = db.select().from(PartTable).where(eq(PartTable.id, id)).get()

    try {
      db.insert(PartTable)
        .values({
          id,
          message_id: messageID,
          session_id: sessionID,
          data: rest,
        })
        .onConflictDoUpdate({ target: PartTable.id, set: { data: rest } })
        .run()
      const previous = row && usage(row.data)
      const next = usage(data.part)
      if (previous) applyUsage(db, row.session_id, previous, -1)
      if (next) applyUsage(db, sessionID, next)
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late part update", { partID: id, messageID, sessionID })
    }
  }),
]
