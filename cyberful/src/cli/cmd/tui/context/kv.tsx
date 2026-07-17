// ── Persistent TUI Preferences ───────────────────────────────────
// Loads and stores dynamic terminal preferences under a cross-process lock,
//   serializing same-process writes and atomically replacing the JSON snapshot.
// ─────────────────────────────────────────────────────────────────

import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@/util/flock"
import { rename, rm } from "node:fs/promises"
import { createSignal, onCleanup } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createSimpleContext } from "./helper"
import path from "node:path"
import { isRecord } from "@/util/record"
import type { TuiStoredValue } from "../api-types"
import { useExit } from "./exit"
import * as Log from "@/util/log"

const log = Log.create({ service: "tui.kv" })

type StoredRecord = Record<string, TuiStoredValue>
type SignalPreferences = {
  animations_enabled: boolean
  assistant_metadata_visibility: boolean
  diff_wrap_mode: "word" | "none"
  scrollbar_visible: boolean
  thinking_mode: "show" | "hide"
  timestamps: "show" | "hide"
  tool_details_visibility: boolean
}
type SignalKey = keyof SignalPreferences
type PreferenceSignal<Value extends TuiStoredValue> = readonly [
  () => Value,
  (next: Value | ((previous: Value) => Value)) => void,
]

function isStoredValue(value: unknown): value is TuiStoredValue {
  if (value === null) return true
  if (["string", "number", "boolean"].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isStoredValue)
  return isRecord(value) && Object.values(value).every(isStoredValue)
}

function isStoredRecord(value: unknown): value is StoredRecord {
  return isRecord(value) && Object.values(value).every(isStoredValue)
}

function storedOrFallback(value: TuiStoredValue | undefined, fallback: TuiStoredValue): TuiStoredValue {
  if (value === undefined) return fallback
  if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback
  if (fallback !== null && typeof fallback === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : fallback
  }
  return typeof value === typeof fallback ? value : fallback
}

function validSignalValue<Key extends SignalKey>(
  name: Key,
  value: TuiStoredValue | undefined,
): value is SignalPreferences[Key] {
  if (name === "thinking_mode") return value === "show" || value === "hide"
  if (name === "timestamps") return value === "show" || value === "hide"
  if (name === "diff_wrap_mode") return value === "word" || value === "none"
  return typeof value === "boolean"
}

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const exit = useExit()
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, TuiStoredValue | undefined>>({})
    const filePath = path.join(Global.Path.state, "kv.json")
    const lock = `tui-kv:${filePath}`
    // Queue same-process writes so rapid updates persist in order.
    let write = Promise.resolve()

    // ── Preference Writes Are Serialized And Atomic ──────────────
    // Multiple terminal actions can update preferences in one event-loop turn,
    // while another Cyberful process may share the same state file. Local writes
    // are queued first and then take the cross-process lock. Each snapshot reaches
    // a unique temporary path and replaces `kv.json` only after complete encoding;
    // failed writes remove their temporary file without corrupting prior state.
    // Exit joins both the initial load and write tail before providers unmount.
    // ─────────────────────────────────────────────────────────────────
    function writeSnapshot(snapshot: Record<string, TuiStoredValue | undefined>) {
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
      return Filesystem.writeJson(tempPath, snapshot)
        .then(() => rename(tempPath, filePath))
        .catch(async (error) => {
          await rm(tempPath, { force: true }).catch((cleanupError) => {
            log.warn("failed to remove temporary preference snapshot", { cleanupError, tempPath })
          })
          throw error
        })
    }

    const load = Flock.withLock(lock, () => Filesystem.readJson(filePath))
      .then((value) => {
        if (!isStoredRecord(value)) throw new Error("TUI preference state must be a JSON object")
        setStore(value)
      })
      .catch((error) => {
        log.warn("failed to read TUI preferences", { filePath, error })
      })
      .finally(() => {
        setReady(true)
      })

    const removeExitFinalizer = exit.finalizer.add(async () => {
      await load
      await write
    })
    onCleanup(removeExitFinalizer)

    function get(key: string): TuiStoredValue | undefined
    function get(key: string, defaultValue: boolean): boolean
    function get(key: string, defaultValue: string): string
    function get(key: string, defaultValue: number): number
    function get(key: string, defaultValue: TuiStoredValue[]): TuiStoredValue[]
    function get(key: string, defaultValue: StoredRecord): StoredRecord
    function get(key: string, defaultValue?: TuiStoredValue): TuiStoredValue | undefined {
      if (defaultValue === undefined) return store[key]
      return storedOrFallback(store[key], defaultValue)
    }

    function set(key: string, value: TuiStoredValue | undefined) {
      if (value !== undefined && !isStoredValue(value)) throw new Error(`Invalid TUI preference value for ${key}`)
      setStore(key, value)
      const snapshot = structuredClone(unwrap(store))
      write = write
        .then(() => Flock.withLock(lock, () => writeSnapshot(snapshot)))
        .catch((error) => {
          log.warn("failed to write TUI preferences", { filePath, error })
        })
    }

    function signal<Key extends SignalKey>(
      name: Key,
      defaultValue: SignalPreferences[Key],
    ): PreferenceSignal<SignalPreferences[Key]> {
      if (store[name] === undefined) setStore(name, defaultValue)
      function value(): SignalPreferences[Key] {
        const candidate = store[name]
        if (!validSignalValue(name, candidate)) return defaultValue
        return candidate
      }
      return [
        value,
        function setter(next: SignalPreferences[Key] | ((previous: SignalPreferences[Key]) => SignalPreferences[Key])) {
          set(name, typeof next === "function" ? next(value()) : next)
        },
      ] as const
    }

    const result = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal,
      get,
      set,
    }
    return result
  },
})
