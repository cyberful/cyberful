// ── Instance Cache Disposal Registry ───────────────────────────────
// Provides one scoped registry for project-cache invalidators and runs every
// disposer when an instance retires, surfacing aggregate cleanup failures.
// → cyberful/src/effect/instance-state.ts — registers scoped-cache invalidation.
// → cyberful/src/project/instance-layer.ts — owns the registry's process lifetime.
// ────────────────────────────────────────────────────────────────────

import { Context, Effect, Layer } from "effect"

type Disposer = (directory: string) => Promise<void>

export type Shape = {
  readonly register: (disposer: Disposer) => () => void
  readonly dispose: (directory: string) => Promise<void>
}

export class Service extends Context.Service<Service, Shape>()("@cyberful/InstanceDisposalRegistry") {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    const disposers = new Set<Disposer>()

    const register = (disposer: Disposer) => {
      disposers.add(disposer)
      return () => {
        disposers.delete(disposer)
      }
    }

    const dispose = async (directory: string) => {
      const results = await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to dispose instance state for ${directory}`)
      }
    }

    return Service.of({ register, dispose })
  }),
)

export * as InstanceDisposalRegistry from "./instance-registry"
