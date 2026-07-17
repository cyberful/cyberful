// ── Legacy JSON Storage Import ───────────────────────────────────────────────
// Imports pre-SQLite projects, sessions, messages, parts, and todos into the
// current database without retaining fields absent from the runtime schema.
// → cyberful/src/storage/db.ts — supplies the migrated SQLite database.
// → cyberful/src/session/session.sql.ts — defines the destination session tables.
// ─────────────────────────────────────────────────────────────────────────────

import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite"
import { Global } from "@/global"
import * as Log from "@/util/log"
import { ProjectTable } from "../project/project.sql"
import { SessionTable, MessageTable, PartTable, TodoTable } from "../session/session.sql"
import path from "path"
import { existsSync } from "fs"
import { Filesystem } from "@/util/filesystem"
import { Glob } from "@/util/glob"
import { isRecord } from "@/util/record"

const log = Log.create({ service: "json-migration" })

export type Progress = {
  current: number
  total: number
  label: string
}

type Options = {
  progress?: (event: Progress) => void
}

export async function run(db: SQLiteBunDatabase | NodeSQLiteDatabase, options?: Options) {
  const storageDir = path.join(Global.Path.data, "storage")

  if (!existsSync(storageDir)) {
    log.info("storage directory does not exist, skipping migration")
    const errors: string[] = []
    return {
      projects: 0,
      sessions: 0,
      messages: 0,
      parts: 0,
      todos: 0,
      errors,
    }
  }

  log.info("starting json to sqlite migration", { storageDir })
  const start = performance.now()

  const stats: {
    projects: number
    sessions: number
    messages: number
    parts: number
    todos: number
    errors: string[]
  } = {
    projects: 0,
    sessions: 0,
    messages: 0,
    parts: 0,
    todos: 0,
    errors: [],
  }
  const orphans = {
    sessions: 0,
    todos: 0,
  }
  const errs = stats.errors

  const batchSize = 1000
  const now = Date.now()

  async function list(pattern: string) {
    return Glob.scan(pattern, { cwd: storageDir, absolute: true })
  }

  async function read(files: string[], start: number, end: number) {
    const count = end - start
    const tasks = Array.from({ length: count }, (_, offset) => Filesystem.readJson(files[start + offset]))
    const results = await Promise.allSettled(tasks)
    const items: Array<unknown | undefined> = Array(count).fill(undefined)
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === "fulfilled") {
        items[i] = result.value
        continue
      }
      errs.push(`failed to read ${files[start + i]}: ${result.reason}`)
    }
    return items
  }

  function insert(values: unknown[], table: Parameters<typeof db.insert>[0], label: string) {
    if (values.length === 0) return 0
    try {
      db.insert(table).values(values).onConflictDoNothing().run()
      return values.length
    } catch (e) {
      errs.push(`failed to migrate ${label} batch: ${e}`)
      return 0
    }
  }

  // Pre-scan all files upfront to avoid repeated glob operations
  log.info("scanning files...")
  const [projectFiles, sessionFiles, messageFiles, partFiles, todoFiles] = await Promise.all([
    list("project/*.json"),
    list("session/*/*.json"),
    list("message/*/*.json"),
    list("part/*/*.json"),
    list("todo/*.json"),
  ])

  log.info("file scan complete", {
    projects: projectFiles.length,
    sessions: sessionFiles.length,
    messages: messageFiles.length,
    parts: partFiles.length,
    todos: todoFiles.length,
  })

  const total = Math.max(
    1,
    projectFiles.length + sessionFiles.length + messageFiles.length + partFiles.length + todoFiles.length,
  )
  const progress = options?.progress
  let current = 0
  const step = (label: string, count: number) => {
    current = Math.min(total, current + count)
    progress?.({ current, total, label })
  }

  progress?.({ current, total, label: "starting" })

  // ── Recoverable Records Do Not Leave An Open Transaction ────────────────────
  // Malformed files and rejected insert batches are recorded so other legacy
  // records can still migrate. An unexpected scan, read, or database failure
  // aborts that tolerant path and rolls the transaction back before surfacing
  // the original cause. If rollback itself fails, both errors are retained so
  // startup cannot silently continue with an unknown transaction state.
  // ─────────────────────────────────────────────────────────────────────────────
  db.run("BEGIN TRANSACTION")
  try {
    // Migrate projects first (no FK deps)
    // Derive all IDs from file paths, not JSON content
    const projectIds = new Set<string>()
    const projectValues: unknown[] = []
    for (let i = 0; i < projectFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, projectFiles.length)
      const batch = await read(projectFiles, i, end)
      projectValues.length = 0
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        if (!isRecord(data)) {
          errs.push(`project is not an object: ${projectFiles[i + j]}`)
          continue
        }
        const id = path.basename(projectFiles[i + j], ".json")
        const icon = isRecord(data.icon) ? data.icon : undefined
        const time = isRecord(data.time) ? data.time : undefined
        projectIds.add(id)
        projectValues.push({
          id,
          worktree: typeof data.worktree === "string" ? data.worktree : "/",
          vcs: typeof data.vcs === "string" ? data.vcs : undefined,
          name: typeof data.name === "string" ? data.name : undefined,
          icon_url: typeof icon?.url === "string" ? icon.url : undefined,
          icon_url_override: typeof icon?.override === "string" ? icon.override : undefined,
          icon_color: typeof icon?.color === "string" ? icon.color : undefined,
          time_created: typeof time?.created === "number" ? time.created : now,
          time_updated: typeof time?.updated === "number" ? time.updated : now,
        })
      }
      stats.projects += insert(projectValues, ProjectTable, "project")
      step("projects", end - i)
    }
    log.info("migrated projects", { count: stats.projects, duration: Math.round(performance.now() - start) })

    // ── Storage Paths Remain The Migration Identity Source ────────
    // Project rows must exist before their sessions can satisfy foreign keys. Older
    // migrations may also have moved a session directory without rewriting its JSON
    // body, so directory and filename components remain authoritative for both IDs.
    // Deriving identity from stale embedded fields could attach a session to the wrong
    // project or manufacture an orphan that did not exist on disk.
    // ─────────────────────────────────────────────────────────────────
    const sessionProjects = sessionFiles.map((file) => path.basename(path.dirname(file)))
    const sessionIds = new Set<string>()
    const sessionValues: unknown[] = []
    for (let i = 0; i < sessionFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, sessionFiles.length)
      const batch = await read(sessionFiles, i, end)
      sessionValues.length = 0
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        if (!isRecord(data)) {
          errs.push(`session is not an object: ${sessionFiles[i + j]}`)
          continue
        }
        const id = path.basename(sessionFiles[i + j], ".json")
        const projectID = sessionProjects[i + j]
        if (!projectIds.has(projectID)) {
          orphans.sessions++
          continue
        }
        const summary = isRecord(data.summary) ? data.summary : undefined
        const time = isRecord(data.time) ? data.time : undefined
        sessionIds.add(id)
        sessionValues.push({
          id,
          project_id: projectID,
          parent_id: typeof data.parentID === "string" ? data.parentID : null,
          slug: typeof data.slug === "string" ? data.slug : "",
          directory: typeof data.directory === "string" ? data.directory : "",
          path: typeof data.path === "string" ? data.path : null,
          title: typeof data.title === "string" ? data.title : "",
          version: typeof data.version === "string" ? data.version : "",
          summary_additions: typeof summary?.additions === "number" ? summary.additions : null,
          summary_deletions: typeof summary?.deletions === "number" ? summary.deletions : null,
          summary_files: typeof summary?.files === "number" ? summary.files : null,
          summary_diffs: Array.isArray(summary?.diffs) ? summary.diffs : null,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          revert: isRecord(data.revert) ? data.revert : null,
          time_created: typeof time?.created === "number" ? time.created : now,
          time_updated: typeof time?.updated === "number" ? time.updated : now,
          time_compacting: typeof time?.compacting === "number" ? time.compacting : null,
          time_archived: typeof time?.archived === "number" ? time.archived : null,
        })
      }
      stats.sessions += insert(sessionValues, SessionTable, "session")
      step("sessions", end - i)
    }
    log.info("migrated sessions", { count: stats.sessions })
    if (orphans.sessions > 0) {
      log.warn("skipped orphaned sessions", { count: orphans.sessions })
    }

    // Migrate messages using pre-scanned file map
    const allMessageFiles: string[] = []
    const allMessageSessions: string[] = []
    const messageSessions = new Map<string, string>()
    for (const file of messageFiles) {
      const sessionID = path.basename(path.dirname(file))
      if (!sessionIds.has(sessionID)) continue
      allMessageFiles.push(file)
      allMessageSessions.push(sessionID)
    }

    for (let i = 0; i < allMessageFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, allMessageFiles.length)
      const batch = await read(allMessageFiles, i, end)
      // oxlint-disable-next-line unicorn/no-new-array -- pre-allocated for index-based batch fill
      const values = new Array(batch.length)
      let count = 0
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const file = allMessageFiles[i + j]
        if (!isRecord(data)) {
          errs.push(`message is not an object: ${file}`)
          continue
        }
        const id = path.basename(file, ".json")
        const sessionID = allMessageSessions[i + j]
        messageSessions.set(id, sessionID)
        const time = isRecord(data.time) ? data.time : undefined
        const rest = { ...data }
        delete rest.id
        delete rest.sessionID
        values[count++] = {
          id,
          session_id: sessionID,
          time_created: typeof time?.created === "number" ? time.created : now,
          data: rest,
        }
      }
      values.length = count
      stats.messages += insert(values, MessageTable, "message")
      step("messages", end - i)
    }
    log.info("migrated messages", { count: stats.messages })

    // Migrate parts using pre-scanned file map
    for (let i = 0; i < partFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, partFiles.length)
      const batch = await read(partFiles, i, end)
      // oxlint-disable-next-line unicorn/no-new-array -- pre-allocated for index-based batch fill
      const values = new Array(batch.length)
      let count = 0
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const file = partFiles[i + j]
        if (!isRecord(data)) {
          errs.push(`part is not an object: ${file}`)
          continue
        }
        const id = path.basename(file, ".json")
        const messageID = path.basename(path.dirname(file))
        const sessionID = messageSessions.get(messageID)
        if (!sessionID) {
          errs.push(`part missing message session: ${file}`)
          continue
        }
        if (!sessionIds.has(sessionID)) continue
        const rest = { ...data }
        delete rest.id
        delete rest.messageID
        delete rest.sessionID
        values[count++] = {
          id,
          message_id: messageID,
          session_id: sessionID,
          data: rest,
        }
      }
      values.length = count
      stats.parts += insert(values, PartTable, "part")
      step("parts", end - i)
    }
    log.info("migrated parts", { count: stats.parts })

    // Migrate todos
    const todoSessions = todoFiles.map((file) => path.basename(file, ".json"))
    for (let i = 0; i < todoFiles.length; i += batchSize) {
      const end = Math.min(i + batchSize, todoFiles.length)
      const batch = await read(todoFiles, i, end)
      const values: unknown[] = []
      for (let j = 0; j < batch.length; j++) {
        const data = batch[j]
        if (!data) continue
        const sessionID = todoSessions[i + j]
        if (!sessionIds.has(sessionID)) {
          orphans.todos++
          continue
        }
        if (!Array.isArray(data)) {
          errs.push(`todo not an array: ${todoFiles[i + j]}`)
          continue
        }
        for (let position = 0; position < data.length; position++) {
          const todo = data[position]
          if (
            !isRecord(todo) ||
            typeof todo.content !== "string" ||
            typeof todo.status !== "string" ||
            typeof todo.priority !== "string"
          ) {
            errs.push(`todo item is malformed: ${todoFiles[i + j]}#${position}`)
            continue
          }
          values.push({
            session_id: sessionID,
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
            position,
          })
        }
      }
      stats.todos += insert(values, TodoTable, "todo")
      step("todos", end - i)
    }
    log.info("migrated todos", { count: stats.todos })
    if (orphans.todos > 0) {
      log.warn("skipped orphaned todos", { count: orphans.todos })
    }

    db.run("COMMIT")
  } catch (error) {
    try {
      db.run("ROLLBACK")
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "legacy JSON migration and rollback failed")
    }
    throw new Error("legacy JSON migration failed", { cause: error })
  }

  log.info("json migration complete", {
    projects: stats.projects,
    sessions: stats.sessions,
    messages: stats.messages,
    parts: stats.parts,
    todos: stats.todos,
    errorCount: stats.errors.length,
    duration: Math.round(performance.now() - start),
  })

  if (stats.errors.length > 0) {
    log.warn("migration errors", { errors: stats.errors.slice(0, 20) })
  }

  progress?.({ current: total, total, label: "complete" })

  return stats
}

export * as JsonMigration from "./json-migration"
