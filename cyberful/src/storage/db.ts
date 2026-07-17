// ── Process Database Lifecycle ────────────────────────────────────────────────
// Selects, secures, migrates, and owns the process-wide SQLite connection.
// It also serializes synchronous transactions and their post-commit effects.
// → cyberful/src/storage/db.bun.ts — creates the Bun SQLite driver.
// ───────────────────────────────────────────────────────────────────────────

import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LocalContext } from "@/util/local-context"
import { Global } from "@/global"
import * as Log from "@/util/log"
import { NamedError, errorMessage } from "@/util/error"
import path from "path"
import { chmodSync, closeSync, existsSync, openSync, readFileSync, readdirSync } from "fs"
import { Flag } from "@/flag/flag"
import { InstallationChannel } from "@/installation/version"
import { EffectBridge } from "@/effect/bridge"
import { init } from "./db.bun"
import { Effect, Schema } from "effect"

declare const CYBERFUL_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create("NotFoundError", {
  message: Schema.String,
})

const log = Log.create({ service: "db" })

type DatabaseFlags = Pick<RuntimeFlags.Info, "disableChannelDb" | "skipMigrations">

const readRuntimeFlags = () =>
  Effect.runSync(RuntimeFlags.Service.useSync((flags) => flags).pipe(Effect.provide(RuntimeFlags.defaultLayer)))

export function getChannelPath(flags: Pick<DatabaseFlags, "disableChannelDb"> = readRuntimeFlags()) {
  if (["latest", "beta", "prod"].includes(InstallationChannel) || flags.disableChannelDb)
    return path.join(Global.Path.data, "cyberful.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(Global.Path.data, `cyberful-${safe}.db`)
}

export const getPath = (flags?: Pick<DatabaseFlags, "disableChannelDb">) => {
  if (Flag.CYBERFUL_DB) {
    if (Flag.CYBERFUL_DB === ":memory:" || path.isAbsolute(Flag.CYBERFUL_DB)) return Flag.CYBERFUL_DB
    return path.join(Global.Path.data, Flag.CYBERFUL_DB)
  }
  return getChannelPath(flags)
}

export type Transaction = SQLiteTransaction<"sync", void>

type Client = ReturnType<typeof init>

type Journal = { sql: string; timestamp: number; name: string }[]

// ── Migration Dispatch Retains The Journal Overload ──────────────
// Drizzle publishes several highly variant migrate overloads, while this module
// constructs only its ordered in-memory journal form. The adapter receives the
// exact SQLite client and journal types required by that overload. Its assertion
// removes library overload ambiguity without changing either runtime argument.
// ─────────────────────────────────────────────────────────────────
const migrateFromJournal = migrate as unknown as (db: SQLiteBunDatabase, entries: Journal) => void

function applyMigrations(db: SQLiteBunDatabase, entries: Journal) {
  migrateFromJournal(db, entries)
}

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter((entry): entry is Journal[number] => entry !== undefined)

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

function restrictFilePermissions(dbPath: string) {
  if (dbPath === ":memory:" || process.platform === "win32") return
  ;[dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync).forEach((file) => chmodSync(file, 0o600))
}

function prepareDatabaseFile(dbPath: string) {
  if (dbPath === ":memory:" || process.platform === "win32") return
  closeSync(openSync(dbPath, "a", 0o600))
  restrictFilePermissions(dbPath)
}

let client: Client | undefined
let clientPath: string | undefined

export const Client = Object.assign(
  (flags: DatabaseFlags = readRuntimeFlags()): Client => {
    const dbPath = getPath(flags)
    if (client) {
      if (clientPath !== dbPath) {
        throw new Error(`Database is already open at ${clientPath}; cannot switch to ${dbPath} in the same process`)
      }
      return client
    }

    log.info("opening database", { path: dbPath })

    prepareDatabaseFile(dbPath)
    const db = init(dbPath)
    try {
      db.run("PRAGMA journal_mode = WAL")
      db.run("PRAGMA synchronous = NORMAL")
      db.run("PRAGMA busy_timeout = 5000")
      db.run("PRAGMA cache_size = -64000")
      db.run("PRAGMA foreign_keys = ON")
      try {
        db.run("PRAGMA wal_checkpoint(PASSIVE)")
      } catch (error) {
        log.warn("wal checkpoint failed", { error: errorMessage(error) })
      }

      // ── Schema Changes Precede Runtime Access ───────────────────────────────────
      // The singleton is not published until every selected migration succeeds.
      // Development reads migrations from disk while release binaries use the
      // embedded journal, but both routes feed the same ordered migration call.
      // A failure closes the unpublished handle, preventing a partial database
      // from leaking while leaving a later initialization free to retry cleanly.
      //
      // ────────────────────────────────────────────────────────────────────────────
      const sourceEntries =
        typeof CYBERFUL_MIGRATIONS !== "undefined"
          ? CYBERFUL_MIGRATIONS
          : migrations(path.join(import.meta.dirname, "../../migration"))
      if (sourceEntries.length > 0) {
        log.info("applying migrations", {
          count: sourceEntries.length,
          mode: typeof CYBERFUL_MIGRATIONS !== "undefined" ? "bundled" : "dev",
        })
        const entries = flags.skipMigrations
          ? sourceEntries.map((entry) => ({ ...entry, sql: "select 1;" }))
          : sourceEntries
        applyMigrations(db, entries)
      }
      restrictFilePermissions(dbPath)

      client = db
      clientPath = dbPath
      return db
    } catch (error) {
      try {
        db.$client.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], `Database initialization and cleanup failed for ${dbPath}`)
      }
      throw error
    }
  },
  {
    loaded: () => client !== undefined,
  },
)

export function close() {
  if (!client) return
  client.$client.close()
  client = undefined
  clientPath = undefined
}

export type TxOrDb = Transaction | Client

const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void)[]
}>("database")

export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export function effect(fn: () => void) {
  const bound = EffectBridge.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch {
    bound()
  }
}

type NotPromise<T> = T extends Promise<unknown> ? never : T

type SynchronousTransaction = <T>(
  callback: (tx: Transaction) => NotPromise<T>,
  options?: { behavior?: "deferred" | "immediate" | "exclusive" },
) => NotPromise<T>

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void)[] = []
      const txCallback = EffectBridge.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
      const database = Client()
      // ── Transactions Remain Synchronous Through The Wrapper ─────
      // The public callback type maps every Promise result to never, preserving
      // Drizzle's synchronous transaction contract before this point. Binding the
      // concrete client loses only that overload relationship, so the assertion
      // restores the already-proven signature and never accepts async callbacks.
      // ─────────────────────────────────────────────────────────────────
      const transact = database.transaction.bind(database) as unknown as SynchronousTransaction
      const result = transact(txCallback, { behavior: options?.behavior })
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export * as Database from "./db"
