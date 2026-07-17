// ── TUI Feature Runtime ──────────────────────────────────────────
// Loads built-in feature modules, allocates scoped APIs and slot registrations,
//   applies preference-based enablement, and disposes every owned contribution.
// ─────────────────────────────────────────────────────────────────

import { runtimeModules as keymapRuntimeModules } from "@opentui/keymap/runtime-modules"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import {
  type TuiDispose,
  type TuiFeature,
  type TuiFeatureApi,
  type TuiFeatureModule,
  type TuiFeatureMeta,
  type TuiSlotFeature,
} from "@/cli/cmd/tui/api-types"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import * as Log from "@/util/log"
import { errorData, errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { internalTuiFeatures, type InternalTuiFeature } from "./internal"
import { setupSlots, Slot as View } from "./slots"
import type { HostFeatureApi, HostSlots } from "./slots"
import { createCommandShim } from "./command-shim"
import { observePromise } from "@/util/promise"

ensureRuntimePluginSupport({ additional: keymapRuntimeModules })

type FeatureLoad = {
  spec: string
  target: string
  source: "internal"
  id: string
  module: TuiFeatureModule
  root: string
}

type Api = HostFeatureApi

type FeatureScope = {
  lifecycle: TuiFeatureApi["lifecycle"]
  track: (fn: (() => void) | undefined) => () => void
  dispose: () => Promise<void>
}

type FeatureEntry = {
  id: string
  load: FeatureLoad
  meta: TuiFeatureMeta
  plugin: TuiFeature
  enabled: boolean
  scope?: FeatureScope
}

const ScopedKeymapMethods = new Set<PropertyKey>([
  "acquireResource",
  "registerLayer",
  "registerLayerFields",
  "prependLayerBindingsTransformer",
  "appendLayerBindingsTransformer",
  "prependBindingTransformer",
  "appendBindingTransformer",
  "prependBindingParser",
  "appendBindingParser",
  "registerToken",
  "registerSequencePattern",
  "prependBindingExpander",
  "appendBindingExpander",
  "registerBindingFields",
  "registerCommandFields",
  "prependCommandTransformer",
  "appendCommandTransformer",
  "prependCommandResolver",
  "appendCommandResolver",
  "prependLayerAnalyzer",
  "appendLayerAnalyzer",
  "intercept",
  "on",
  "prependEventMatchResolver",
  "appendEventMatchResolver",
  "prependDisambiguationResolver",
  "appendDisambiguationResolver",
])

type RuntimeState = {
  directory: string
  api: Api
  dispose?: () => void
  slots: HostSlots
  features: FeatureEntry[]
  features_by_id: Map<string, FeatureEntry>
  dispose_timeout_ms: number
}

const log = Log.create({ service: "tui.feature" })
const DISPOSE_TIMEOUT_MS = 5000
const KV_KEY = "feature_enabled"

function fail(message: string, data: Record<string, unknown>) {
  if (!("error" in data)) {
    log.error(message, data)
    console.error(`[tui.feature] ${message}`, data)
    return
  }

  const text = `${message}: ${errorMessage(data.error)}`
  const next = { ...data, error: errorData(data.error) }
  log.error(text, next)
  console.error(`[tui.feature] ${text}`, next)
}

function createScopedKeymap(keymap: TuiFeatureApi["keymap"], scope: FeatureScope): TuiFeatureApi["keymap"] {
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy(keymap, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== "function") return value
      if (cache.has(prop)) return cache.get(prop)
      const fn = ScopedKeymapMethods.has(prop)
        ? (...args: unknown[]) => {
            const dispose = Reflect.apply(value, target, args)
            return scope.track(
              typeof dispose === "function"
                ? () => {
                    Reflect.apply(dispose, undefined, [])
                  }
                : undefined,
            )
          }
        : (...args: unknown[]) => Reflect.apply(value, target, args)
      cache.set(prop, fn)
      return fn
    },
  })
}

function createScopedMode(mode: TuiFeatureApi["mode"], scope: FeatureScope): TuiFeatureApi["mode"] {
  return {
    current() {
      return mode.current()
    },
    push(value) {
      return scope.track(mode.push(value))
    },
  }
}

type CleanupResult = { type: "ok" } | { type: "error"; error: unknown } | { type: "timeout" }

function runCleanup(fn: () => unknown, ms: number): Promise<CleanupResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ type: "timeout" })
    }, ms)

    observePromise(Promise.resolve().then(fn), {
      fulfilled: () => resolve({ type: "ok" }),
      rejected: (error) => resolve({ type: "error", error }),
      settled: () => clearTimeout(timer),
    })
  })
}

function createMeta(source: FeatureLoad["source"], spec: string, target: string, id?: string): TuiFeatureMeta {
  const now = Date.now()
  return {
    state: "same",
    id: id ?? spec,
    source,
    spec,
    target,
    first_time: now,
    last_time: now,
    time_changed: now,
    load_count: 1,
    fingerprint: target,
  }
}

function loadInternalFeature(item: InternalTuiFeature): FeatureLoad {
  const spec = item.id
  return {
    spec,
    target: spec,
    source: "internal",
    id: item.id,
    module: item,
    root: process.cwd(),
  }
}

function createFeatureScope(load: FeatureLoad, id: string, disposeTimeoutMs: number) {
  const ctrl = new AbortController()
  let list: { key: symbol; fn: TuiDispose }[] = []
  let done = false

  const onDispose = (fn: TuiDispose) => {
    if (done) return () => {}
    const key = Symbol()
    list.push({ key, fn })
    let drop = false
    return () => {
      if (drop) return
      drop = true
      list = list.filter((x) => x.key !== key)
    }
  }

  const track = (fn: (() => void) | undefined) => {
    if (!fn) return () => {}
    let drop = false
    let off = () => {}
    const wrapped = () => {
      if (drop) return
      drop = true
      off()
      fn()
    }
    off = onDispose(wrapped)
    return wrapped
  }

  const lifecycle: TuiFeatureApi["lifecycle"] = {
    signal: ctrl.signal,
    onDispose,
  }

  const dispose = async () => {
    if (done) return
    done = true
    ctrl.abort()
    const queue = [...list].reverse()
    list = []
    const until = Date.now() + disposeTimeoutMs
    for (const item of queue) {
      const left = until - Date.now()
      if (left <= 0) {
        fail("timed out cleaning up tui feature", {
          path: load.spec,
          id,
          timeout: disposeTimeoutMs,
        })
        break
      }

      const out = await runCleanup(item.fn, left)
      if (out.type === "ok") continue
      if (out.type === "timeout") {
        fail("timed out cleaning up tui feature", {
          path: load.spec,
          id,
          timeout: disposeTimeoutMs,
        })
        break
      }

      if (out.type === "error") {
        fail("failed to clean up tui feature", {
          path: load.spec,
          id,
          error: out.error,
        })
      }
    }
  }

  return {
    lifecycle,
    track,
    dispose,
  }
}

function readFeatureEnabledMap(value: unknown) {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((item): item is [string, boolean] => typeof item[1] === "boolean"),
  )
}

function featureEnabledState(state: RuntimeState, config: TuiConfig.Resolved) {
  return {
    ...readFeatureEnabledMap(config.feature_enabled),
    ...readFeatureEnabledMap(state.api.kv.get(KV_KEY, {})),
  }
}

function writeFeatureEnabledState(api: Api, id: string, enabled: boolean) {
  api.kv.set(KV_KEY, {
    ...readFeatureEnabledMap(api.kv.get(KV_KEY, {})),
    [id]: enabled,
  })
}

async function deactivateFeatureEntry(state: RuntimeState, plugin: FeatureEntry, persist: boolean) {
  plugin.enabled = false
  if (persist) writeFeatureEnabledState(state.api, plugin.id, false)
  if (!plugin.scope) return true
  const scope = plugin.scope
  plugin.scope = undefined
  await scope.dispose()
  return true
}

async function activateFeatureEntry(state: RuntimeState, plugin: FeatureEntry, persist: boolean) {
  plugin.enabled = true
  if (persist) writeFeatureEnabledState(state.api, plugin.id, true)
  if (plugin.scope) return true

  const scope = createFeatureScope(plugin.load, plugin.id, state.dispose_timeout_ms)
  const api = featureApi(state, scope, plugin.id)
  const ok = await Promise.resolve()
    .then(async () => {
      await plugin.plugin(api, undefined, plugin.meta)
      return true
    })
    .catch((error) => {
      fail("failed to initialize tui feature", {
        path: plugin.load.spec,
        id: plugin.id,
        error,
      })
      return false
    })

  if (!ok) {
    await scope.dispose()
    return false
  }

  if (!plugin.enabled) {
    await scope.dispose()
    return true
  }

  plugin.scope = scope
  return true
}

function featureApi(runtime: RuntimeState, scope: FeatureScope, base: string): TuiFeatureApi {
  const api = runtime.api
  const host = runtime.slots
  const route: TuiFeatureApi["route"] = {
    register(list) {
      return scope.track(api.route.register(list))
    },
    navigate(name, params) {
      api.route.navigate(name, params)
    },
    get current() {
      return api.route.current
    },
  }

  const event: TuiFeatureApi["event"] = {
    on(type, handler) {
      return scope.track(api.event.on(type, handler))
    },
  }

  const keymap = createScopedKeymap(api.keymap, scope)

  let count = 0

  const slots: TuiFeatureApi["slots"] = {
    register(plugin: TuiSlotFeature) {
      const id = count ? `${base}:${count}` : base
      count += 1
      scope.track(host.register({ ...plugin, id }))
      return id
    },
  }

  return {
    app: api.app,
    attention: api.attention,
    command: createCommandShim(keymap, api.ui.dialog, api.tuiConfig.keybinds),
    keys: api.keys,
    keymap,
    mode: createScopedMode(api.mode, scope),
    route,
    ui: api.ui,
    tuiConfig: api.tuiConfig,
    kv: api.kv,
    state: api.state,
    theme: api.theme,
    get client() {
      return api.client
    },
    event,
    renderer: api.renderer,
    slots,
    lifecycle: scope.lifecycle,
  }
}

function addFeatureEntry(state: RuntimeState, plugin: FeatureEntry) {
  if (state.features_by_id.has(plugin.id)) {
    fail("duplicate tui feature id", {
      id: plugin.id,
      path: plugin.load.spec,
    })
    return false
  }

  state.features_by_id.set(plugin.id, plugin)
  state.features.push(plugin)
  return true
}

function applyInitialFeatureEnabledState(state: RuntimeState, config: TuiConfig.Resolved) {
  const map = featureEnabledState(state, config)
  for (const plugin of state.features) {
    const enabled = map[plugin.id]
    if (enabled === undefined) continue
    plugin.enabled = enabled
  }
}

let dir = ""
let loaded: Promise<void> | undefined
let runtime: RuntimeState | undefined
export const Slot = View

export async function init(input: {
  api: HostFeatureApi
  config: TuiConfig.Resolved
  dispose?: () => void
  disposeTimeoutMs?: number
}) {
  const cwd = process.cwd()
  if (loaded) {
    if (dir !== cwd) {
      throw new Error(`TuiFeatureRuntime.init() called with a different working directory. expected=${dir} got=${cwd}`)
    }
    return loaded
  }

  dir = cwd
  loaded = load(input)
  return loaded
}

export async function dispose() {
  const task = loaded
  loaded = undefined
  dir = ""
  if (task) await task
  const state = runtime
  runtime = undefined
  if (!state) return
  const queue = [...state.features].reverse()
  for (const plugin of queue) {
    await deactivateFeatureEntry(state, plugin, false)
  }
  state.dispose?.()
}

async function load(input: { api: Api; config: TuiConfig.Resolved; dispose?: () => void; disposeTimeoutMs?: number }) {
  const { api, config } = input
  const cwd = process.cwd()
  const slots = setupSlots(api)
  const next: RuntimeState = {
    directory: cwd,
    api,
    dispose: input.dispose,
    slots,
    features: [],
    features_by_id: new Map(),
    dispose_timeout_ms: input.disposeTimeoutMs ?? DISPOSE_TIMEOUT_MS,
  }
  runtime = next
  try {
    for (const item of internalTuiFeatures()) {
      log.info("loading internal tui feature", { id: item.id })
      const entry = loadInternalFeature(item)
      const meta = createMeta(entry.source, entry.spec, entry.target, entry.id)
      addFeatureEntry(next, {
        id: entry.id,
        load: entry,
        meta,
        plugin: entry.module.tui,
        enabled: item.enabled ?? true,
      })
    }

    applyInitialFeatureEnabledState(next, config)
    for (const plugin of next.features) {
      if (!plugin.enabled) continue
      // ── Feature Activation Order Is Observable Policy ───────────
      // Commands and keybindings use registration order for precedence, routes
      // with the same identity are last-wins, and hook chains preserve insertion
      // order. Activation therefore remains sequential even though module loading
      // could run concurrently; changing it would make user actions nondeterministic.
      // ─────────────────────────────────────────────────────────────────
      await activateFeatureEntry(next, plugin, false)
    }
  } catch (error) {
    fail("failed to load tui features", { directory: cwd, error })
  }
}

export * as TuiFeatureRuntime from "./runtime"
