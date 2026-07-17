// ── Persistent Prompt Stash ──────────────────────────────────────
// Saves bounded draft text and attachment parts in JSON Lines and exposes
//   restore or removal operations that survive terminal restarts.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { Global } from "@/global"
import { onCleanup } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../../context/helper"
import { isPromptInfo, type PromptInfo } from "./history"
import { isRecord } from "@/util/record"
import * as Log from "@/util/log"
import { appendJsonLine, createSerializedWrites, readJsonLines, writeJsonLines } from "./storage"
import { useExit } from "../../context/exit"

const log = Log.create({ service: "tui.prompt.stash" })

export type StashEntry = {
  input: string
  parts: PromptInfo["parts"]
  timestamp: number
}

const MAX_STASH_ENTRIES = 50

function isStashEntry(value: unknown): value is StashEntry {
  return (
    isRecord(value) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    isPromptInfo({ input: value.input, parts: value.parts })
  )
}

export const { use: usePromptStash, provider: PromptStashProvider } = createSimpleContext({
  name: "PromptStash",
  init: () => {
    const stashPath = path.join(Global.Path.state, "prompt-stash.jsonl")
    const [store, setStore] = createStore<{ entries: StashEntry[] }>({
      entries: [],
    })
    const exit = useExit()
    const writes = createSerializedWrites((error) => {
      log.warn("failed to persist prompt stash", { stashPath, error })
    })
    const removeFinalizer = exit.finalizer.add(writes.drain)
    onCleanup(() => {
      removeFinalizer()
      writes.close()
    })

    writes.enqueue(async () => {
      const lines = await readJsonLines(stashPath, MAX_STASH_ENTRIES, isStashEntry)
      setStore("entries", lines)
      if (lines.length > 0) await writeJsonLines(stashPath, lines)
    })

    return {
      list() {
        return store.entries
      },
      push(entry: Omit<StashEntry, "timestamp">) {
        const stash = structuredClone(unwrap({ ...entry, timestamp: Date.now() }))
        writes.enqueue(async () => {
          let trimmed = false
          setStore(
            produce((draft) => {
              draft.entries.push(stash)
              if (draft.entries.length > MAX_STASH_ENTRIES) {
                draft.entries = draft.entries.slice(-MAX_STASH_ENTRIES)
                trimmed = true
              }
            }),
          )

          if (trimmed) {
            await writeJsonLines(stashPath, structuredClone(unwrap(store.entries)))
            return
          }
          await appendJsonLine(stashPath, stash)
        })
      },
      pop() {
        if (store.entries.length === 0) return undefined
        const entry = store.entries[store.entries.length - 1]
        setStore(
          produce((draft) => {
            draft.entries.pop()
          }),
        )
        const snapshot = structuredClone(unwrap(store.entries))
        writes.enqueue(() => writeJsonLines(stashPath, snapshot))
        return entry
      },
      remove(index: number) {
        if (index < 0 || index >= store.entries.length) return
        setStore(
          produce((draft) => {
            draft.entries.splice(index, 1)
          }),
        )
        const snapshot = structuredClone(unwrap(store.entries))
        writes.enqueue(() => writeJsonLines(stashPath, snapshot))
      },
    }
  },
})
