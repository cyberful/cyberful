// ── Runtime Configuration Service ────────────────────────────────
// Validates and merges managed, global, project, environment, agent, command, and
// skill configuration, caches instance views, and owns safe global updates.
// → cyberful/src/config/parse.ts — parses and validates every JSONC source.
// → cyberful/src/config/paths.ts — defines global and project lookup order.
// ─────────────────────────────────────────────────────────────────

import * as Log from "@/util/log"
import { serviceUse } from "@/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@/global"
import fsNode from "fs/promises"
import { NamedError } from "@/util/error"
import { Flag } from "@/flag/flag"
import { applyEdits, modify } from "jsonc-parser"
import { existsSync } from "fs"
import { isRecord } from "@/util/record"
import { AppFileSystem } from "@/effect/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { EffectFlock } from "@/util/effect-flock"
import { type InstanceContext } from "../project/instance-context"
import { PositiveInt, type DeepMutable } from "@/schema"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigFormatter } from "./formatter"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigReference } from "./reference"
import { ConfigSkills } from "./skills"
import { ConfigVariable } from "./variable"

const log = Log.create({ service: "config" })

// ── Validated Configuration Retains Its Public Shape ─────────────
// Every source is schema-validated before merging, so the result remains Config.Info.
// Remeda performs the structural merge while its recursive conditional type stays
// outside hot loading call sites. Later sources retain the established precedence,
// and no field receives a hidden merge mode outside the published configuration
// schema.
// ─────────────────────────────────────────────────────────────────
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function normalizeLoadedConfig(data: unknown, source: string) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  log.warn("theme selection is unsupported; move remaining terminal settings to tui.json", { path: source })
  return copy
}

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  shell: Schema.optional(Schema.String).annotate({
    description: "Default shell to use for terminal and bash tool",
  }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommand.Info)).annotate({
    description: "Command configuration, see https://cyberful.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkills.Info).annotate({ description: "Additional skill folder paths" }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "Named git or local directory references that can be mentioned as @alias or @alias/path",
  }),
  watcher: Schema.optional(
    Schema.Struct({
      ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    }),
  ),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Default phase persona to use when none is specified. Cyberful projects use 'brief' as the chain entry.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  agent: Schema.optional(Schema.Record(Schema.String, ConfigAgent.Info)).annotate({
    description: "Phase personas discovered from the configured agents directory",
  }),
  formatter: Schema.optional(ConfigFormatter.Info).annotate({
    description:
      "Enable or configure formatters. Omit or set to false to disable, true to enable built-ins, or an object to enable built-ins with overrides.",
  }),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 1000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 25600)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
    }),
  ),
}).annotate({ identifier: "Config" })

// ── Decoded Config Remains Mutable Without Narrowing Unknown ──────
// Effect schemas expose readonly output, while config merge and compatibility steps
// update a private in-memory copy. The shared DeepMutable removes that readonly layer
// without changing unknown-valued fields into empty objects, which the upstream
// utility type does. Runtime values still originate from the schema above before any
// mutation or persistence occurs.
// ─────────────────────────────────────────────────────────────────
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

type State = {
  config: Info
  directories: string[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = ["cyberful.jsonc", "cyberful.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  return { ...info }
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

export const ConfigDirectoryTypoError = NamedError.create("ConfigDirectoryTypoError", {
  path: Schema.String,
  dir: Schema.String,
  suggestion: Schema.String,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options ? { text, type: "path", path: options.path } : { text, type: "virtual", ...options },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(Info, normalizeLoadedConfig(parsed, source), source)
      if (!("path" in options)) return data

      if (!data.$schema) {
        data.$schema = "https://cyberful.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://cyberful.ai/config.json",')
        yield* fs
          .writeFileString(options.path, updated)
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() => log.warn("could not add schema to config", { path: options.path, error })),
            ),
          )
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string) {
      log.info("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {}
      return yield* loadConfig(text, { path: filepath })
    })

    const loadGlobal = Effect.fnUntraced(function* () {
      let result: Info = {}
      // ── Default Config Creation Respects Explicit Routing ────────
      // A fresh default install receives a schema-only global file for editor support.
      // Environment-provided content, files, or directories are deliberate alternate
      // owners, so creating the default file in those modes would produce an unused
      // and misleading second source. Existing files are never overwritten here.
      // ─────────────────────────────────────────────────────────────────
      if (!Flag.CYBERFUL_CONFIG && !Flag.CYBERFUL_CONFIG_DIR && !Flag.CYBERFUL_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://cyberful.ai/config.json" }, null, 2))
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() => log.warn("could not create default config", { path: file, error })),
              ),
            )
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json")))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "cyberful.json")))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "cyberful.jsonc")))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider: _provider, model: _model, ...rest } = mod.default
              result["$schema"] = "https://cyberful.ai/config.json"
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch((error) => {
              log.warn("failed to migrate legacy config", { error })
            }),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.sync(() => log.error("failed to load global config, using defaults", { error: String(error) })),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              (error) => Effect.sync(() => log.warn("could not create project gitignore", { path: gitignore, error })),
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        let result: Info = {}

        const merge = Effect.fnUntraced(function* (_source: string, next: Info, _kind?: "global" | "local") {
          result = mergeConfig(result, next)
        })

        yield* merge(Global.Path.config, yield* getGlobal(), "global")

        if (Flag.CYBERFUL_CONFIG) {
          yield* merge(Flag.CYBERFUL_CONFIG, yield* loadFile(Flag.CYBERFUL_CONFIG))
          log.debug("loaded custom config", { path: Flag.CYBERFUL_CONFIG })
        }

        if (!Flag.CYBERFUL_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("cyberful", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file), "local")
          }
        }

        result.agent = result.agent || {}

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.CYBERFUL_CONFIG_DIR) {
          log.debug("loading config from CYBERFUL_CONFIG_DIR", { path: Flag.CYBERFUL_CONFIG_DIR })
        }

        for (const dir of directories) {
          if (dir === Flag.CYBERFUL_CONFIG_DIR) {
            for (const file of ["cyberful.json", "cyberful.jsonc"]) {
              const source = path.join(dir, file)
              log.debug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source))
              result.agent ??= {}
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
        }

        if (process.env.CYBERFUL_CONFIG_CONTENT) {
          const source = "CYBERFUL_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.CYBERFUL_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          log.debug("loaded custom config from CYBERFUL_CONFIG_CONTENT")
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["cyberful.json", "cyberful.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfig(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        if (!result.username) result.username = os.userInfo().username

        return {
          config: result,
          directories,
        }
      },
      Effect.provideService(AppFileSystem.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      if (!file.endsWith(".jsonc")) {
        const existing = ConfigParse.schema(Info, ConfigParse.jsonc(before, file), file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = ConfigParse.schema(Info, ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      update,
      updateGlobal,
      invalidate,
      directories,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as Config from "./config"
