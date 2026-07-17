// ── Bounded Prompt State Storage ─────────────────────────────────
// Reads, validates, appends, and rewrites the JSON Lines files used by prompt
//   history, stash, and frecency while bounding startup reads and serializing
//   writes that could otherwise complete out of order.
// ─────────────────────────────────────────────────────────────────

import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"

const MAX_STATE_BYTES = 2 * 1024 * 1024

// ── One Queue Owns Each Prompt State File ────────────────────────
// Startup compaction, routine appends, and bounded rewrites all target the same
// file and can be requested in one render turn. One promise tail preserves their
// request order, observes every failure, and remains usable after a failed write.
// Providers drain the tail before terminal shutdown and close it on unmount so
// no late mutation can escape the lifetime of its state owner.
// ─────────────────────────────────────────────────────────────────
export function createSerializedWrites(report: (error: unknown) => void) {
  let tail = Promise.resolve()
  let closed = false

  function enqueue(task: () => Promise<void>) {
    if (closed) {
      report(new Error("prompt state write queue is closed"))
      return
    }
    tail = tail.then(task).catch((error) => {
      report(error)
    })
  }

  return {
    enqueue,
    drain: () => tail,
    close: () => {
      closed = true
    },
  }
}

export async function readJsonLines<Value>(
  filePath: string,
  limit: number,
  isValue: (value: unknown) => value is Value,
): Promise<Value[]> {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return []

  const start = Math.max(0, file.size - MAX_STATE_BYTES)
  const tail = await file.slice(start, file.size).text()
  const firstCompleteLine = tail.indexOf("\n")
  const text = start === 0 ? tail : firstCompleteLine === -1 ? "" : tail.slice(firstCompleteLine + 1)

  // ── One Damaged Record Does Not Erase Prompt History ────────────
  // JSON Lines writes can leave one torn trailing record if the process exits
  // during append, and older versions may contain shapes no longer accepted.
  // Each line crosses validation independently: malformed records are skipped,
  // while valid daily-use history around them remains available and bounded.
  // Rewrites later compact the surviving canonical records back to disk.
  // ─────────────────────────────────────────────────────────────────
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line)
        return isValue(value) ? [value] : []
      } catch {
        return []
      }
    })
    .slice(-limit)
}

export async function writeJsonLines(filePath: string, values: readonly unknown[]) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "")
}

export async function appendJsonLine(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8" })
}
