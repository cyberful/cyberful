// ── Process Log Routing ──────────────────────────────────────────
// Formats structured service logs, routes them to stderr or the active run file,
// owns replacement and closure of that process sink, and prunes old development
// log files without retaining caller-selected logger names.
// → cyberful/src/global.ts — supplies the repository-owned log directory.
// ─────────────────────────────────────────────────────────────────

export * as Log from "./log"

import path from "node:path"
import fs from "node:fs/promises"
import { createWriteStream, type WriteStream } from "node:fs"
import { finished } from "node:stream/promises"
import * as Global from "../global"
import { Schema } from "effect"
import { Glob } from "./glob"

export const Level = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
const initializedRunID = "CYBERFUL_LOG_INITIALIZED_RUN_ID"

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: unknown, extra?: object): void
  info(message?: unknown, extra?: object): void
  error(message?: unknown, extra?: object): void
  warn(message?: unknown, extra?: object): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: object,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
}

let logpath = ""
export function file() {
  return logpath
}

type Sink = {
  write(message: string): void
  close(): Promise<void>
}

const stderrSink: Sink = {
  write(message) {
    process.stderr.write(message)
  },
  async close() {},
}
let sink = stderrSink

function write(message: string) {
  sink.write(message)
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function reportLogFailure(operation: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Unable to ${operation}: ${detail}\n`)
}

export async function init(options: Options) {
  if (options.level) level = options.level
  await cleanup(Global.Path.log)
  await dispose()
  if (options.print) return
  logpath = path.join(
    Global.Path.log,
    options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
  )
  const runID = process.env.CYBERFUL_RUN_ID
  const shouldTruncate = !options.dev || !runID || process.env[initializedRunID] !== runID
  if (shouldTruncate) {
    await fs.truncate(logpath).catch((error: unknown) => {
      if (!isMissing(error)) throw error
    })
  }
  if (options.dev && runID) process.env[initializedRunID] = runID
  const stream = createWriteStream(logpath, { flags: "a" })
  stream.on("error", (error) => reportLogFailure("write Cyberful log", error))
  sink = fileSink(stream)
}

function fileSink(stream: WriteStream): Sink {
  return {
    write(message) {
      stream.write(message, (error) => {
        if (error) reportLogFailure("write Cyberful log", error)
      })
    },
    async close() {
      if (stream.closed) return
      stream.end()
      await finished(stream).catch((error: unknown) => {
        reportLogFailure("close Cyberful log", error)
      })
    },
  }
}

export async function dispose() {
  const previous = sink
  sink = stderrSink
  logpath = ""
  await previous.close()
}

async function cleanup(dir: string) {
  const files = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch((error: unknown) => {
      reportLogFailure("scan old Cyberful logs", error)
      return []
    })
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  if (files.length <= keep) return

  const doomed = files.slice(0, -keep)
  const removed = await Promise.allSettled(doomed.map((file) => fs.unlink(path.join(dir, file))))
  removed.forEach((result, index) => {
    if (result.status === "rejected" && !isMissing(result.reason)) {
      reportLogFailure(`remove old Cyberful log ${doomed[index]}`, result.reason)
    }
  })
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

let last = Date.now()

function formatValue(value: object) {
  if (value instanceof Error) return formatError(value)
  try {
    return JSON.stringify(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

export function create(tags?: Record<string, unknown>) {
  const loggerTags = { ...tags }

  function build(message: unknown, extra?: object) {
    const prefix = Object.entries({
      ...loggerTags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (typeof value === "object" && value !== null) return prefix + formatValue(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: unknown, extra?: object) {
      if (shouldLog("DEBUG")) {
        write("DEBUG " + build(message, extra))
      }
    },
    info(message?: unknown, extra?: object) {
      if (shouldLog("INFO")) {
        write("INFO  " + build(message, extra))
      }
    },
    error(message?: unknown, extra?: object) {
      if (shouldLog("ERROR")) {
        write("ERROR " + build(message, extra))
      }
    },
    warn(message?: unknown, extra?: object) {
      if (shouldLog("WARN")) {
        write("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      loggerTags[key] = value
      return result
    },
    clone() {
      return create(loggerTags)
    },
    time(message: string, extra?: object) {
      const now = Date.now()
      let stopped = false
      result.info(message, { status: "started", ...extra })
      function stop() {
        if (stopped) return
        stopped = true
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  return result
}
