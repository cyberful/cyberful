// ── Typed Lazy Service Accessors ───────────────────────────────────
// Projects Effect-returning service methods through a cached Proxy while
// validating runtime property names before dispatching into the typed service.
// → cyberful/src/effect/filesystem.ts — exposes its service through this adapter.
// ────────────────────────────────────────────────────────────────────

import { Context, Effect } from "effect"

type EffectMethod = (...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, unknown>

type ServiceUse<Identifier, Shape> = {
  readonly [Key in keyof Shape as Shape[Key] extends EffectMethod ? Key : never]: Shape[Key] extends (
    ...args: infer Args
  ) => infer Return
    ? Args extends ReadonlyArray<unknown>
      ? Return extends Effect.Effect<infer A, infer E, infer R>
        ? (...args: Args) => Effect.Effect<A, E, R | Identifier>
        : never
      : never
    : never
}

export const serviceUse = <Identifier, Shape>(tag: Context.Service<Identifier, Shape>) => {
  const cache = new Map<string, (...args: unknown[]) => Effect.Effect<unknown, unknown, unknown>>()
  const access: ServiceUse<Identifier, Shape> = new Proxy(Object.create(null), {
    get: (_, key) => {
      if (typeof key !== "string") return undefined
      const cached = cache.get(key)
      if (cached) return cached
      const accessor = (...args: unknown[]) =>
        tag.use((service) => {
          if ((typeof service !== "object" && typeof service !== "function") || service === null) {
            return Effect.die(new Error(`Service is not an object: ${tag.key}`))
          }
          const method: unknown = Reflect.get(service, key)
          if (typeof method !== "function") return Effect.die(new Error(`Service method not found: ${key}`))
          const result: unknown = Reflect.apply(method, service, args)
          return Effect.isEffect(result)
            ? result
            : Effect.die(new Error(`Service method did not return an Effect: ${key}`))
        })
      cache.set(key, accessor)
      return accessor
    },
  })
  return access
}
