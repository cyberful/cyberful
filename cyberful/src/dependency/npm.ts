// ── Cached npm Package Installation ──────────────────────────────
// Resolves and installs isolated npm packages under Cyberful's cache, serializes
// Arborist writes, and reconciles declared dependencies with the lockfile root.
// → cyberful/src/dependency/npm-config.ts — supplies sanitized npm policy and registry settings.
// → cyberful/src/effect/filesystem.ts — validates package manifests at the file boundary.
// ─────────────────────────────────────────────────────────────────

export * as Npm from "./npm"

import path from "node:path"
import npa from "npm-package-arg"
import { Effect, Schema, Context, Layer, Option, FileSystem } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@/effect/filesystem"
import { Global } from "@/global"
import { EffectFlock } from "@/util/effect-flock"
import { makeRuntime } from "@/effect/runtime"
import { NpmConfig } from "./npm-config"
import { isRecord } from "@/util/record"
import * as Log from "@/util/log"

const log = Log.create({ service: "npm" })

export class InstallFailedError extends Schema.TaggedErrorClass<InstallFailedError>()("NpmInstallFailedError", {
  add: Schema.Array(Schema.String).pipe(Schema.optional),
  dir: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface EntryPoint {
  readonly directory: string
  readonly entrypoint: Option.Option<string>
}

export interface Interface {
  readonly add: (pkg: string) => Effect.Effect<EntryPoint, InstallFailedError | EffectFlock.LockError>
  readonly install: (
    dir: string,
    input?: {
      add: {
        name: string
        version?: string
      }[]
    },
  ) => Effect.Effect<void, EffectFlock.LockError | InstallFailedError>
  readonly which: (pkg: string, bin?: string) => Effect.Effect<Option.Option<string>>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/Npm") {}

const illegal = process.platform === "win32" ? new Set(["<", ">", ":", '"', "|", "?", "*"]) : undefined

export function sanitize(pkg: string) {
  if (!illegal) return pkg
  return Array.from(pkg, (char) => (illegal.has(char) || char.charCodeAt(0) < 32 ? "_" : char)).join("")
}

const resolveEntryPoint = (name: string, dir: string): EntryPoint => {
  let entrypoint: Option.Option<string>
  try {
    const resolved = typeof Bun !== "undefined" ? import.meta.resolve(name, dir) : import.meta.resolve(dir)
    entrypoint = Option.some(resolved)
  } catch {
    entrypoint = Option.none()
  }
  return {
    directory: dir,
    entrypoint,
  }
}

interface ArboristNode {
  name: string
  path: string
}

interface ArboristTree {
  edgesOut: Map<string, { to?: ArboristNode }>
}

function isArboristTree(value: unknown): value is ArboristTree {
  if (typeof value !== "object" || value === null || !("edgesOut" in value) || !(value.edgesOut instanceof Map)) {
    return false
  }
  return [...value.edgesOut.values()].every((edge) => {
    if (typeof edge !== "object" || edge === null || !("to" in edge) || edge.to === undefined) return true
    return (
      typeof edge.to === "object" &&
      edge.to !== null &&
      "name" in edge.to &&
      "path" in edge.to &&
      typeof edge.to.name === "string" &&
      typeof edge.to.path === "string"
    )
  })
}

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function dependencyNames(value: unknown) {
  const record = asRecord(value)
  return dependencyFields.flatMap((field) => Object.keys(asRecord(record[field])))
}

function packageBins(value: unknown): string | Record<string, string> | undefined {
  const bin = asRecord(value).bin
  if (typeof bin === "string") return bin
  if (typeof bin !== "object" || bin === null || Array.isArray(bin)) return
  const entries = Object.entries(bin)
  if (!entries.every((entry): entry is [string, string] => typeof entry[1] === "string")) return
  return Object.fromEntries(entries)
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const afs = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const fs = yield* FileSystem.FileSystem
    const flock = yield* EffectFlock.Service
    const directory = (pkg: string) => path.join(global.cache, "packages", sanitize(pkg))
    const reify = (input: { dir: string; add?: string[] }) =>
      Effect.gen(function* () {
        yield* flock.acquire(`npm-install:${input.dir}`)
        const { Arborist } = yield* Effect.promise(() => import("@npmcli/arborist"))
        const add = input.add ?? []
        const npmOptions = yield* NpmConfig.load(input.dir).pipe(
          Effect.mapError(
            (cause) =>
              new InstallFailedError({
                cause,
                add,
                dir: input.dir,
              }),
          ),
        )
        const arborist = new Arborist({
          ...npmOptions,
          path: input.dir,
          binLinks: true,
          progress: false,
          savePrefix: "",
          ignoreScripts: true,
        })
        return yield* Effect.tryPromise({
          try: async () => {
            const tree: unknown = await arborist.reify({
              ...npmOptions,
              add,
              save: true,
              saveType: "prod",
            })
            if (!isArboristTree(tree)) throw new Error("Arborist returned an invalid dependency tree")
            return tree
          },
          catch: (cause) =>
            new InstallFailedError({
              cause,
              add,
              dir: input.dir,
            }),
        })
      }).pipe(
        Effect.withSpan("Npm.reify", {
          attributes: input,
        }),
      )

    const add = Effect.fn("Npm.add")(function* (pkg: string) {
      const dir = directory(pkg)
      const name = (() => {
        try {
          return npa(pkg).name ?? pkg
        } catch {
          return pkg
        }
      })()

      if (yield* afs.existsSafe(path.join(dir, "node_modules", name))) {
        return resolveEntryPoint(name, path.join(dir, "node_modules", name))
      }

      const tree = yield* reify({ dir, add: [pkg] })
      const first = tree.edgesOut.values().next().value?.to
      if (!first) {
        const result = resolveEntryPoint(name, path.join(dir, "node_modules", name))
        if (Option.isSome(result.entrypoint)) return result
        return yield* new InstallFailedError({ add: [pkg], dir })
      }
      return resolveEntryPoint(first.name, first.path)
    }, Effect.scoped)

    const install: Interface["install"] = Effect.fn("Npm.install")(function* (dir, input) {
      const add = input?.add.map((pkg) => [pkg.name, pkg.version].filter(Boolean).join("@")) ?? []
      const installFailure = (cause: unknown) => new InstallFailedError({ cause, add, dir })
      const canWrite = yield* afs.access(dir, { writable: true }).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
        Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.succeed(false)),
        Effect.mapError(installFailure),
      )
      if (!canWrite) return

      if (
        yield* Effect.gen(function* () {
          const nodeModulesExists = yield* afs.existsSafe(path.join(dir, "node_modules"))
          if (!nodeModulesExists) {
            yield* reify({ add, dir })
            return true
          }
          return false
        }).pipe(Effect.withSpan("Npm.checkNodeModules"))
      )
        return

      yield* Effect.gen(function* () {
        const pkg = yield* afs.readJson(path.join(dir, "package.json")).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({})),
          Effect.mapError(installFailure),
        )
        const lock = yield* afs.readJson(path.join(dir, "package-lock.json")).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed({})),
          Effect.mapError(installFailure),
        )

        // ── Lockfile Parity Decides Whether Arborist Runs ───────────
        // Existing node_modules is reusable only when every dependency declared by
        // package.json or requested by this call appears in the lockfile root. Both
        // JSON files are untrusted cache state, so non-object fields normalize to an
        // empty record before names are compared. A missing declaration triggers one
        // serialized reify rather than allowing a partially installed package tree.
        // ─────────────────────────────────────────────────────────────────
        const declared = new Set([...dependencyNames(pkg), ...(input?.add || []).map((pkg) => pkg.name)])

        const packages = asRecord(asRecord(lock).packages)
        const locked = new Set(dependencyNames(packages[""]))

        for (const name of declared) {
          if (!locked.has(name)) {
            yield* reify({ dir, add })
            return
          }
        }
      }).pipe(Effect.withSpan("Npm.checkDirty"))

      return
    }, Effect.scoped)

    const which = Effect.fn("Npm.which")(function* (pkg: string, bin?: string) {
      const dir = directory(pkg)
      const binDir = path.join(dir, "node_modules", ".bin")

      const pick = Effect.fnUntraced(function* () {
        const files = yield* fs
          .readDirectory(binDir)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<string[]>([])))

        if (files.length === 0) return Option.none<string>()
        // Caller picked a specific bin (e.g. pyright exposes both `pyright` and
        // `pyright-langserver`); trust the hint if the package provides it.
        if (bin) return files.includes(bin) ? Option.some(bin) : Option.none<string>()
        if (files.length === 1) return Option.some(files[0])

        const pkgJson = yield* afs.readJson(path.join(dir, "node_modules", pkg, "package.json")).pipe(
          Effect.map(Option.some),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none<unknown>())),
        )

        if (Option.isSome(pkgJson)) {
          const parsedBin = packageBins(pkgJson.value)
          if (parsedBin) {
            const unscoped = pkg.startsWith("@") ? pkg.split("/")[1] : pkg
            if (typeof parsedBin === "string") return Option.some(unscoped)
            const keys = Object.keys(parsedBin)
            if (keys.length === 1) return Option.some(keys[0])
            return parsedBin[unscoped] ? Option.some(unscoped) : Option.some(keys[0])
          }
        }

        return Option.some(files[0])
      })

      return yield* Effect.gen(function* () {
        const bin = yield* pick()
        if (Option.isSome(bin)) {
          return Option.some(path.join(binDir, bin.value))
        }

        yield* fs
          .remove(path.join(dir, "package-lock.json"))
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.void))

        yield* add(pkg)

        const resolved = yield* pick()
        if (Option.isNone(resolved)) return Option.none<string>()
        return Option.some(path.join(binDir, resolved.value))
      }).pipe(
        Effect.scoped,
        Effect.catch((error) =>
          Effect.sync(() => {
            log.warn("failed to resolve npm package executable", { package: pkg, error })
            return Option.none<string>()
          }),
        ),
      )
    })

    return Service.of({
      add,
      install,
      which,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.layer),
  Layer.provide(AppFileSystem.layer),
  Layer.provide(Global.layer),
  Layer.provide(NodeFileSystem.layer),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function install(...args: Parameters<Interface["install"]>) {
  return runPromise((svc) => svc.install(...args))
}

export async function add(...args: Parameters<Interface["add"]>) {
  const entry = await runPromise((svc) => svc.add(...args))
  return {
    directory: entry.directory,
    entrypoint: Option.getOrUndefined(entry.entrypoint),
  }
}

export async function which(...args: Parameters<Interface["which"]>) {
  const resolved = await runPromise((svc) => svc.which(...args))
  return Option.getOrUndefined(resolved)
}
