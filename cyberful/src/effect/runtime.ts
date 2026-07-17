// ── Managed Service Runtime ────────────────────────────────────────
// Lazily constructs one memoized Effect runtime for a service layer and exposes
// explicit run boundaries plus disposal for callers with shorter lifetimes.
// → cyberful/src/effect/memo-map.ts — shares layer acquisition process-wide.
// ────────────────────────────────────────────────────────────────────

import { Layer, type Context, ManagedRuntime, type Effect } from "effect"
import { memoMap } from "./memo-map"
import { Observability } from "./observability"

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined

  // ── Runtime Acquisition Is Lazy But Disposal Is Explicit ──────────
  // Module-level services can retain one memoized runtime for process lifetime,
  // while shorter-lived owners may call dispose after their final operation.
  // Disposal is harmless before first use and ManagedRuntime serializes its own
  // layer finalizers. No background initialization starts during module import.
  // ─────────────────────────────────────────────────────────────────────

  const getRuntime = () =>
    (rt ??= ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer), {
      memoMap,
    }))
  const dispose = () => {
    const current = rt
    rt = undefined
    return current?.dispose() ?? Promise.resolve()
  }

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(service.use(fn)),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(service.use(fn), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(service.use(fn), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(service.use(fn)),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runCallback(service.use(fn)),
    dispose,
  }
}
