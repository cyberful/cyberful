// ── Per-Instance Scoped State Cache ────────────────────────────────
// Lazily creates one scoped value per project directory and connects cache
// invalidation to the central instance-disposal lifecycle.
// → cyberful/src/effect/instance-registry.ts — dispatches project retirement.
// → cyberful/src/effect/instance-ref.ts — selects the active project directory.
// ────────────────────────────────────────────────────────────────────

import { Effect, ScopedCache, Scope } from "effect"
import * as EffectLogger from "@/effect/logger"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceRef } from "./instance-ref"
import { InstanceDisposalRegistry } from "./instance-registry"

const TypeId = "~cyberful/InstanceState"

export interface InstanceState<A, E = never, R = never> {
  readonly [TypeId]: typeof TypeId
  readonly cache: ScopedCache.ScopedCache<string, A, E, R>
}

export const context = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  return ctx
})

export const directory = Effect.map(context, (ctx) => ctx.directory)

export const make = <A, E = never, R = never>(
  init: (ctx: InstanceContext) => Effect.Effect<A, E, R | Scope.Scope>,
): Effect.Effect<
  InstanceState<A, E, Exclude<R, Scope.Scope | InstanceDisposalRegistry.Service>>,
  never,
  R | Scope.Scope | InstanceDisposalRegistry.Service
> =>
  Effect.gen(function* () {
    // ── Cache Scope And Registry Lifetime Stay Coupled ───────────────
    // Each directory lookup owns the scoped value returned by init. A process-wide
    // registry can invalidate that entry when the project retires, while this
    // constructor's finalizer unregisters the callback before the cache disappears.
    // Disposal therefore cannot call into a cache whose owning scope has closed.
    // ─────────────────────────────────────────────────────────────────────

    const cache = yield* ScopedCache.make<string, A, E, R>({
      capacity: Number.POSITIVE_INFINITY,
      lookup: () =>
        Effect.gen(function* () {
          return yield* init(yield* context)
        }),
    })

    const registry = yield* InstanceDisposalRegistry.Service
    const off = registry.register((directory) =>
      Effect.runPromise(ScopedCache.invalidate(cache, directory).pipe(Effect.provide(EffectLogger.layer))),
    )
    yield* Effect.addFinalizer(() => Effect.sync(off))

    return {
      [TypeId]: TypeId,
      cache,
    }
  })

export const get = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.get(self.cache, yield* directory)
  })

export const use = <A, E, R, B>(self: InstanceState<A, E, R>, select: (value: A) => B) => Effect.map(get(self), select)

export const useEffect = <A, E, R, B, E2, R2>(
  self: InstanceState<A, E, R>,
  select: (value: A) => Effect.Effect<B, E2, R2>,
) => Effect.flatMap(get(self), select)

export const has = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.has(self.cache, yield* directory)
  })

export const invalidate = <A, E, R>(self: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    return yield* ScopedCache.invalidate(self.cache, yield* directory)
  })

export * as InstanceState from "./instance-state"
