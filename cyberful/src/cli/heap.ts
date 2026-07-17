// ── Heap Snapshot Watchdog ───────────────────────────────────────
// Monitors resident memory when explicitly enabled and writes one diagnostic
//   heap snapshot per threshold crossing without overlapping snapshot work.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { writeHeapSnapshot } from "node:v8"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import * as Log from "@/util/log"

const log = Log.create({ service: "heap" })
const MINUTE = 60_000
const LIMIT = 2 * 1024 * 1024 * 1024

let timer: Timer | undefined
let snapshotTask: Promise<void> | undefined
let armed = true

export function start() {
  if (!Flag.CYBERFUL_AUTO_HEAP_SNAPSHOT) return
  if (timer) return

  // ── The Process Owns One Snapshot Task ──────────────────────────
  // The watchdog timer is unreferenced and lives for the process lifetime. A
  // retained promise owns the synchronous V8 snapshot request and its reporting,
  // preventing a later interval from overlapping the same expensive diagnostic.
  // Failure is observed before ownership clears; the threshold must fall below
  // the limit before another snapshot is armed, avoiding repeated failure noise.
  // ─────────────────────────────────────────────────────────────────
  const run = () => {
    if (snapshotTask) return

    const stat = process.memoryUsage()
    if (stat.rss <= LIMIT) {
      armed = true
      return
    }
    if (!armed) return

    armed = false
    const file = path.join(
      Global.Path.log,
      `heap-${process.pid}-${new Date().toISOString().replace(/[:.]/g, "")}.heapsnapshot`,
    )
    log.warn("heap usage exceeded limit", {
      rss: stat.rss,
      heap: stat.heapUsed,
      file,
    })

    snapshotTask = Promise.resolve()
      .then(() => {
        writeHeapSnapshot(file)
      })
      .catch((err) => {
        log.error("failed to write heap snapshot", {
          error: err instanceof Error ? err.message : String(err),
          file,
        })
      })
      .finally(() => {
        snapshotTask = undefined
      })
  }

  timer = setInterval(run, MINUTE)
  timer.unref?.()
}

export * as Heap from "./heap"
