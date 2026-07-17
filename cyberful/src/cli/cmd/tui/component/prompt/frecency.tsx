// ── Prompt Selection Frecency ────────────────────────────────────
// Persists bounded selection frequency and recency records and exposes their
//   decayed scores for autocomplete ranking across TUI launches.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { Global } from "@/global"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "../../context/helper"
import { isRecord } from "@/util/record"
import * as Log from "@/util/log"
import { appendJsonLine, createSerializedWrites, readJsonLines, writeJsonLines } from "./storage"
import { useExit } from "../../context/exit"

type FrecencyEntry = { path: string; frequency: number; lastOpen: number }
type FrecencyValue = Omit<FrecencyEntry, "path">

const log = Log.create({ service: "tui.prompt.frecency" })

function calculateFrecency(entry?: { frequency: number; lastOpen: number }): number {
  if (!entry) return 0
  const daysSince = (Date.now() - entry.lastOpen) / 86400000 // ms per day
  const weight = 1 / (1 + daysSince)
  return entry.frequency * weight
}

const MAX_FRECENCY_ENTRIES = 1000

function isFrecencyEntry(value: unknown): value is FrecencyEntry {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.frequency === "number" &&
    Number.isFinite(value.frequency) &&
    value.frequency > 0 &&
    typeof value.lastOpen === "number" &&
    Number.isFinite(value.lastOpen) &&
    value.lastOpen >= 0
  )
}

export const { use: useFrecency, provider: FrecencyProvider } = createSimpleContext({
  name: "Frecency",
  init: () => {
    const frecencyPath = path.join(Global.Path.state, "frecency.jsonl")
    const [store, setStore] = createStore<{ data: Record<string, FrecencyValue> }>({
      data: {},
    })
    const exit = useExit()
    const writes = createSerializedWrites((error) => {
      log.warn("failed to persist prompt frecency", { frecencyPath, error })
    })
    const removeFinalizer = exit.finalizer.add(writes.drain)
    onCleanup(() => {
      removeFinalizer()
      writes.close()
    })

    writes.enqueue(async () => {
      const lines = await readJsonLines(frecencyPath, MAX_FRECENCY_ENTRIES, isFrecencyEntry)
      const latest = lines.reduce<Record<string, FrecencyEntry>>((acc, entry) => {
        acc[entry.path] = entry
        return acc
      }, {})
      const sorted = Object.values(latest)
        .sort((a, b) => b.lastOpen - a.lastOpen)
        .slice(0, MAX_FRECENCY_ENTRIES)
      setStore(
        "data",
        Object.fromEntries(
          sorted.map((entry) => [entry.path, { frequency: entry.frequency, lastOpen: entry.lastOpen }]),
        ),
      )
      if (sorted.length > 0) await writeJsonLines(frecencyPath, sorted)
    })

    function updateFrecency(filePath: string) {
      const absolutePath = path.resolve(process.cwd(), filePath)
      writes.enqueue(async () => {
        const newEntry = {
          frequency: (store.data[absolutePath]?.frequency || 0) + 1,
          lastOpen: Date.now(),
        }
        setStore("data", absolutePath, newEntry)
        await appendJsonLine(frecencyPath, { path: absolutePath, ...newEntry })

        if (Object.keys(store.data).length <= MAX_FRECENCY_ENTRIES) return
        const sorted = Object.entries(store.data)
          .sort(([, a], [, b]) => b.lastOpen - a.lastOpen)
          .slice(0, MAX_FRECENCY_ENTRIES)
        setStore("data", Object.fromEntries(sorted))
        await writeJsonLines(
          frecencyPath,
          sorted.map(([entryPath, entry]) => ({ path: entryPath, ...entry })),
        )
      })
    }

    return {
      getFrecency: (filePath: string) => calculateFrecency(store.data[path.resolve(process.cwd(), filePath)]),
      updateFrecency,
      data: () => store.data,
    }
  },
})
