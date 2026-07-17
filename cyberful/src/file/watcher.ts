// ── Workspace File Watcher ───────────────────────────────────────
// Loads the platform watcher binding, publishes normalized file changes, and
//   scopes subscriptions and VCS metadata watching to the active instance.
// ─────────────────────────────────────────────────────────────────

import { Cause, Effect, Layer, Context, Schema } from "effect"
import { createWrapper } from "@parcel/watcher/wrapper"
import type ParcelWatcher from "@parcel/watcher"
import { readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@/flag/flag"
import { Git } from "@/git"
import { lazy } from "@/util/lazy"
import { observePromise } from "@/util/promise"
import { Config } from "@/config/config"
import { FileIgnore } from "./ignore"
import { Protected } from "./protected"
import * as Log from "@/util/log"

declare const CYBERFUL_LIBC: string | undefined

const log = Log.create({ service: "file.watcher" })
const SUBSCRIBE_TIMEOUT_MS = 10_000

export const Event = {
  Updated: BusEvent.define(
    "file.watcher.updated",
    Schema.Struct({
      file: Schema.String,
      event: Schema.Literals(["add", "change", "unlink"]),
    }),
  ),
}

const watcher = lazy((): typeof import("@parcel/watcher") | undefined => {
  try {
    const binding = require(
      `@parcel/watcher-${process.platform}-${process.arch}${process.platform === "linux" ? `-${CYBERFUL_LIBC || "glibc"}` : ""}`,
    )
    return createWrapper(binding)
  } catch (error) {
    log.error("failed to load watcher binding", { error })
    return
  }
})

function getBackend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

function protecteds(dir: string) {
  return Protected.paths().filter((item) => {
    const rel = path.relative(dir, item)
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
  })
}

export const hasNativeBinding = () => !!watcher()

export interface Interface {
  readonly init: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/FileWatcher") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const git = yield* Git.Service

    const state = yield* InstanceState.make(
      Effect.fn("FileWatcher.state")(
        function* () {
          if (yield* Flag.CYBERFUL_EXPERIMENTAL_DISABLE_FILEWATCHER) return

          const ctx = yield* InstanceState.context

          log.info("init", { directory: ctx.directory })

          const backend = getBackend()
          if (!backend) {
            log.error("watcher backend not supported", { directory: ctx.directory, platform: process.platform })
            return
          }

          const w = watcher()
          if (!w) return

          log.info("watcher backend", { directory: ctx.directory, platform: process.platform, backend })
          const bridge = yield* EffectBridge.make()
          const subs: ParcelWatcher.AsyncSubscription[] = []
          let closing = false
          let publishQueue = Promise.resolve()
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              closing = true
              for (const sub of subs) {
                try {
                  await sub.unsubscribe()
                } catch (error) {
                  log.warn("failed to unsubscribe file watcher", { error })
                }
              }
              await publishQueue
            }),
          )

          // ── Native Watch Events Cross One Ordered Boundary ────────
          // Platform callbacks can deliver a large burst in a single invocation.
          // Starting one publication per item would create unbounded concurrent work.
          // A shared promise tail serializes delivery while retaining callback order.
          // Every failure is logged and absorbed so later events can still publish.
          // Finalization stops new work and drains the tail after unsubscribing.
          // ─────────────────────────────────────────────────────────────────
          const cb: ParcelWatcher.SubscribeCallback = bridge.bind((error, evts) => {
            if (error) {
              log.warn("file watcher callback failed", { error, directory: ctx.directory })
              return
            }
            if (closing) return
            for (const evt of evts) {
              const event = evt.type === "create" ? "add" : evt.type === "update" ? "change" : "unlink"
              publishQueue = publishQueue
                .then(() => Bus.publish(ctx, Event.Updated, { file: evt.path, event }))
                .catch((publishError) => {
                  log.warn("failed to publish file watcher event", { error: publishError, file: evt.path, event })
                })
            }
          })

          const subscribe = (dir: string, ignore: string[]) => {
            const pending = w.subscribe(dir, cb, { ignore, backend })
            return Effect.gen(function* () {
              const sub = yield* Effect.promise(() => pending)
              subs.push(sub)
            }).pipe(
              Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
              Effect.catchCause((cause) => {
                log.error("failed to subscribe", { dir, cause: Cause.pretty(cause) })
                observePromise(
                  pending.then((subscription) => subscription.unsubscribe()),
                  {
                    rejected: (error) => log.warn("failed to clean up late file watcher subscription", { dir, error }),
                  },
                )
                return Effect.void
              }),
            )
          }

          const cfg = yield* config.get()
          const cfgIgnores = cfg.watcher?.ignore ?? []

          if (yield* Flag.CYBERFUL_EXPERIMENTAL_FILEWATCHER) {
            yield* Effect.forkScoped(
              subscribe(ctx.directory, [...FileIgnore.PATTERNS, ...cfgIgnores, ...protecteds(ctx.directory)]),
            )
          }

          if (ctx.project.vcs === "git") {
            const result = yield* git.run(["rev-parse", "--git-dir"], {
              cwd: ctx.worktree,
            })
            const resolved = result.exitCode === 0 ? path.resolve(ctx.worktree, result.text().trim()) : undefined
            const vcsDir = resolved
              ? yield* Effect.promise(() =>
                  realpath(resolved).catch((error) => {
                    log.debug("failed to resolve VCS metadata directory", { error, directory: resolved })
                    return resolved
                  }),
                )
              : undefined
            if (
              vcsDir &&
              !cfgIgnores.includes(".git") &&
              !cfgIgnores.includes(vcsDir) &&
              (!resolved || !cfgIgnores.includes(resolved))
            ) {
              const ignore = (yield* Effect.promise(() =>
                readdir(vcsDir).catch((error) => {
                  log.debug("failed to enumerate VCS metadata directory", { error, directory: vcsDir })
                  return []
                }),
              )).filter((entry) => entry !== "HEAD")
              yield* Effect.forkScoped(subscribe(vcsDir, ignore))
            }
          }
        },
        Effect.catchCause((cause) => {
          log.error("failed to init watcher service", { cause: Cause.pretty(cause) })
          return Effect.void
        }),
      ),
    )

    return Service.of({
      init: Effect.fn("FileWatcher.init")(function* () {
        yield* InstanceState.get(state)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Git.defaultLayer))

export * as FileWatcher from "./watcher"
