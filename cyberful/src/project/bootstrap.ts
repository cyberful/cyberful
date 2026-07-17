// ── Project Instance Bootstrap ───────────────────────────────────────────────
// Materializes the services required by one project and starts their scoped initialization.
// → cyberful/src/project/instance-store.ts — owns the instance scope and lifetime.
// ────────────────────────────────────────────────────────────────────

import { Format } from "../format"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { InstanceState } from "@/effect/instance-state"
import { InstanceDisposalRegistry } from "@/effect/instance-registry"
import { FileWatcher } from "@/file/watcher"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Reference } from "@/reference/reference"
import { DependencyStartup } from "@/dependency/startup"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // ── Bootstrap Dependencies Stay Outside The Store Graph ────────────────────────
    // Dependencies are captured when this layer materializes, leaving `run`
    // with no remaining environment requirement. InstanceStore imports only
    // the lightweight service tag, so its cache and disposal code do not pull
    // this implementation graph back into themselves. That direction keeps
    // instance construction free of a bootstrap/store module cycle.
    // ───────────────────────────────────────────────────────────────────────────
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const file = yield* File.Service
    const fileWatcher = yield* FileWatcher.Service
    const format = yield* Format.Service
    const reference = yield* Reference.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping").pipe(Effect.annotateLogs("directory", ctx.directory))
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      yield* DependencyStartup.runCyberfulOs.pipe(Effect.provideService(Bus.Service, bus))
      // Each service owns its scoped background work; bootstrap only waits for materialization.
      yield* Effect.forEach(
        [reference, format, file, fileWatcher, vcs, snapshot],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: 7, discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Bus.layer,
    Config.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Format.defaultLayer,
    Reference.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
  ]),
  Layer.provide(InstanceDisposalRegistry.layer),
)

export * as InstanceBootstrap from "./bootstrap"
