// ── Persistent Prompt History ────────────────────────────────────
// Stores bounded, deduplicated prompt text and attachment parts in JSON Lines
//   so routine submissions can be recalled across terminal launches.
// ─────────────────────────────────────────────────────────────────

import path from "node:path"
import { Global } from "@/global"
import { onCleanup } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import { createSimpleContext } from "../../context/helper"
import type { FilePart, TextPart } from "@/server/client"
import { isRecord } from "@/util/record"
import * as Log from "@/util/log"
import { appendJsonLine, createSerializedWrites, readJsonLines, writeJsonLines } from "./storage"
import { useExit } from "../../context/exit"

const log = Log.create({ service: "tui.prompt.history" })

export type PromptInfo = {
  input: string
  mode?: "normal" | "shell"
  parts: (
    | Omit<FilePart, "id" | "messageID" | "sessionID">
    | (Omit<TextPart, "id" | "messageID" | "sessionID"> & {
        source?: {
          text: {
            start: number
            end: number
            value: string
          }
        }
      })
  )[]
}

const MAX_HISTORY_ENTRIES = 50

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isSourceText(value: unknown) {
  return isRecord(value) && typeof value.value === "string" && isFiniteNumber(value.start) && isFiniteNumber(value.end)
}

function isFileSource(value: unknown) {
  if (!isRecord(value) || !isSourceText(value.text) || typeof value.path !== "string") return false
  if (value.type === "file") return true
  if (value.type !== "symbol" || typeof value.name !== "string" || !isFiniteNumber(value.kind)) return false
  if (!isRecord(value.range) || !isRecord(value.range.start) || !isRecord(value.range.end)) return false
  return (
    isFiniteNumber(value.range.start.line) &&
    isFiniteNumber(value.range.start.character) &&
    isFiniteNumber(value.range.end.line) &&
    isFiniteNumber(value.range.end.character)
  )
}

function isPromptPart(value: unknown): value is PromptInfo["parts"][number] {
  if (!isRecord(value)) return false
  if (value.type === "file") {
    if (typeof value.mime !== "string" || typeof value.url !== "string") return false
    if (value.filename !== undefined && typeof value.filename !== "string") return false
    return value.source === undefined || isFileSource(value.source)
  }
  if (value.type !== "text" || typeof value.text !== "string") return false
  if (value.synthetic !== undefined && typeof value.synthetic !== "boolean") return false
  if (value.ignored !== undefined && typeof value.ignored !== "boolean") return false
  if (value.metadata !== undefined && !isRecord(value.metadata)) return false
  if (value.time !== undefined) {
    if (!isRecord(value.time) || !isFiniteNumber(value.time.start)) return false
    if (value.time.end !== undefined && !isFiniteNumber(value.time.end)) return false
  }
  if (value.source === undefined) return true
  return isRecord(value.source) && isRecord(value.source.text) && isSourceText(value.source.text)
}

export function isPromptInfo(value: unknown): value is PromptInfo {
  if (!isRecord(value) || typeof value.input !== "string" || !Array.isArray(value.parts)) return false
  if (value.mode !== undefined && value.mode !== "normal" && value.mode !== "shell") return false
  return value.parts.every(isPromptPart)
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify(previous) === JSON.stringify(next)
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const historyPath = path.join(Global.Path.state, "prompt-history.jsonl")
    const [store, setStore] = createStore<{ index: number; history: PromptInfo[] }>({
      index: 0,
      history: [],
    })
    const exit = useExit()
    const writes = createSerializedWrites((error) => {
      log.warn("failed to persist prompt history", { historyPath, error })
    })
    const removeFinalizer = exit.finalizer.add(writes.drain)
    onCleanup(() => {
      removeFinalizer()
      writes.close()
    })

    writes.enqueue(async () => {
      const lines = await readJsonLines(historyPath, MAX_HISTORY_ENTRIES, isPromptInfo)
      setStore("history", lines)
      if (lines.length > 0) await writeJsonLines(historyPath, lines)
    })

    return {
      move(direction: 1 | -1, input: string) {
        if (!store.history.length) return undefined
        const current = store.history.at(store.index)
        if (!current) return undefined
        if (current.input !== input && input.length) return
        setStore(
          produce((draft) => {
            const next = store.index + direction
            if (Math.abs(next) > store.history.length) return
            if (next > 0) return
            draft.index = next
          }),
        )
        if (store.index === 0)
          return {
            input: "",
            parts: [],
          }
        return store.history.at(store.index)
      },
      append(item: PromptInfo) {
        const entry = structuredClone(unwrap(item))
        writes.enqueue(async () => {
          if (isDuplicateEntry(store.history.at(-1), entry)) {
            setStore("index", 0)
            return
          }
          let trimmed = false
          setStore(
            produce((draft) => {
              draft.history.push(entry)
              if (draft.history.length > MAX_HISTORY_ENTRIES) {
                draft.history = draft.history.slice(-MAX_HISTORY_ENTRIES)
                trimmed = true
              }
              draft.index = 0
            }),
          )

          if (trimmed) {
            await writeJsonLines(historyPath, structuredClone(unwrap(store.history)))
            return
          }
          await appendJsonLine(historyPath, entry)
        })
      },
    }
  },
})
