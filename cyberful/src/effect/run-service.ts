// ── Instance-Aware Managed Service Runtime ─────────────────────────
// Lazily creates a managed runtime for one service and carries the current
// project instance across synchronous, asynchronous, forked, and callback runs.
// → cyberful/src/effect/instance-ref.ts — supplies the propagated project context.
// ────────────────────────────────────────────────────────────────────

import { Effect, Fiber, Layer, ManagedRuntime } from "effect"
import * as Context from "effect/Context"
import { InstanceRef } from "./instance-ref"
import * as Observability from "@/effect/observability"
import type { InstanceContext } from "@/project/instance-context"
import { memoMap } from "@/effect/memo-map"

type Refs = {
  instance?: InstanceContext
}

export function attachWith<A, E, R>(effect: Effect.Effect<A, E, R>, refs: Refs): Effect.Effect<A, E, R> {
  if (!refs.instance) return effect
  return effect.pipe(Effect.provideService(InstanceRef, refs.instance))
}

export function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const fiber = Fiber.getCurrent()
  return attachWith(effect, {
    instance: fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined,
  })
}

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined

  // ── Runtime Acquisition Is Lazy But Disposal Is Explicit ──────────
  // Module-level services can retain one memoized runtime for process lifetime,
  // while shorter-lived owners may call dispose after their final operation.
  // Disposal is harmless before first use and ManagedRuntime serializes its own
  // layer finalizers. No background initialization starts during module import.
  // ─────────────────────────────────────────────────────────────────────

  const getRuntime = () => (rt ??= ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer), { memoMap }))
  const dispose = () => {
    const current = rt
    rt = undefined
    return current?.dispose() ?? Promise.resolve()
  }

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(attach(service.use(fn))),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(attach(service.use(fn)), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(attach(service.use(fn)), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(attach(service.use(fn))),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) =>
      getRuntime().runCallback(attach(service.use(fn))),
    dispose,
  }
}
