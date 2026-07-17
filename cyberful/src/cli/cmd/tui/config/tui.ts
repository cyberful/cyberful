// ── Resolved TUI Configuration ───────────────────────────────────
// Loads layered terminal configuration, performs legacy migration and variable
//   expansion, validates unknown input, and supplies normalized defaults by Effect.
// @docs/user-guide/interface.md
// ─────────────────────────────────────────────────────────────────

export * as TuiConfig from "./tui"

import { createBindingLookup } from "@opentui/keymap/extras"
import { mergeDeep, unique } from "remeda"
import { Cause, Context, Effect, Layer, Schema } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { migrateTuiConfig } from "./tui-migrate"
import { KeymapLeaderTimeoutDefault, TuiInfo } from "./tui-schema"
import { Flag } from "@/flag/flag"
import { isRecord } from "@/util/record"
import { Global } from "@/global"
import { AppFileSystem } from "@/effect/filesystem"
import { CurrentWorkingDirectory } from "./cwd"
import { TuiKeybind } from "./keybind"
import { makeRuntime } from "@/effect/runtime"
import * as Log from "@/util/log"
import { ConfigVariable } from "@/config/variable"
import type { DeepMutable } from "@/schema"
import { FormatError, FormatUnknownError } from "@/cli/error"

const log = Log.create({ service: "tui.config" })

export const Info = TuiInfo
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

type Acc = {
  result: Info
}

function emptyInfo(): Info {
  return {}
}

export type Resolved = Omit<Info, "attention" | "keybinds" | "leader_timeout"> & {
  attention: {
    enabled: boolean
    notifications: boolean
  }
  keybinds: TuiKeybind.BindingLookupView
  leader_timeout: number
}

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/TuiConfig") {}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) {
    delete data.theme
    return data
  }
  if (!isRecord(data.tui)) {
    delete data.tui
    delete data.theme
    return data
  }

  const tui = data.tui
  delete data.tui
  const result = {
    ...tui,
    ...data,
  }
  delete result.theme
  return result
}

function dropUnknownKeybinds(input: Record<string, unknown>, configFilepath: string) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  log.warn("ignored unknown tui keybinds", {
    path: configFilepath,
    keybinds: invalid,
    hint: "Remove these entries or rename them to keys from the tui.json schema.",
  })
  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* AppFileSystem.Service
  let appliedOrder = 0

  const load = (text: string, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty" }),
      )
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return emptyInfo()
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old cyberful.json shape) still get their settings applied.
      const normalized = dropUnknownKeybinds(normalize(data), configFilepath)
      return ConfigParse.schema(Info, normalized, configFilepath)
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause)
          const reason = FormatError(error) ?? FormatUnknownError(error)
          log.warn("skipping invalid tui config", {
            path: configFilepath,
            reason,
          })
          return emptyInfo()
        }),
      ),
    )

  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema failures in load() are handled — every broken-config
      // path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause)
            const reason = FormatError(error) ?? FormatUnknownError(error)
            log.warn("failed to read tui config", {
              path: filepath,
              reason,
            })
            return undefined
          }),
        ),
      )
      if (!text) return emptyInfo()
      log.info("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  const mergeFile = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)
      if (Object.keys(data).length) {
        appliedOrder += 1
        log.info("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
    })

  // Shared resource directories are limited to global config and an explicit CYBERFUL_CONFIG_DIR.
  const directories = yield* ConfigPaths.directories(ctx.directory)
  yield* Effect.promise(() => migrateTuiConfig({ directories, cwd: ctx.directory }))

  const projectFiles = Flag.CYBERFUL_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", ctx.directory)

  const acc: Acc = {
    result: {},
  }

  // 1. Global tui config (lowest precedence).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file)
  }

  // 2. Explicit CYBERFUL_TUI_CONFIG override, if set.
  if (Flag.CYBERFUL_TUI_CONFIG) {
    const configFile = Flag.CYBERFUL_TUI_CONFIG
    yield* mergeFile(acc, configFile)
    log.debug("loaded custom tui config", { path: configFile })
  }

  // 3. Project tui files, applied root-first so the closest file wins.
  for (const file of projectFiles) {
    yield* mergeFile(acc, file)
  }

  // 4. Explicit config directory (the checked-in or materialized built-ins in production).
  for (const dir of directories.filter((dir) => dir === Flag.CYBERFUL_CONFIG_DIR)) {
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      yield* mergeFile(acc, file)
    }
  }

  const keybinds = { ...acc.result.keybinds }
  if (process.platform === "win32") {
    // Native Windows terminals do not support POSIX suspend, so prefer prompt undo.
    keybinds.terminal_suspend = "none"
    const inputUndo = TuiKeybind.defaultValue("input_undo")
    keybinds.input_undo ??= unique(["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]).join(",")
  }
  const parsedKeybinds = TuiKeybind.parse(keybinds)
  const result: Resolved = {
    ...acc.result,
    attention: {
      enabled: acc.result.attention?.enabled ?? false,
      notifications: acc.result.attention?.notifications ?? true,
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(parsedKeybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: acc.result.leader_timeout ?? KeymapLeaderTimeoutDefault,
  }

  return { config: result }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* CurrentWorkingDirectory
    const data = yield* loadState({ directory })
    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))
    return Service.of({ get })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function get() {
  return runPromise((svc) => svc.get())
}
