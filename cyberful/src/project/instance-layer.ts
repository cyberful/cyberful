// ── Lazy Project Instance Layer ──────────────────────────────────────────────
// Assembles the instance store and bootstrap graph only when the layer is requested.
// → cyberful/src/project/bootstrap.ts — provides project service initialization.
// → cyberful/src/project/instance-store.ts — provides scoped instance ownership.
// ─────────────────────────────────────────────────────────────────────────

import { Effect, Layer } from "effect"
import { InstanceDisposalRegistry } from "@/effect/instance-registry"
import { InstanceStore } from "./instance-store"

export const layer = Layer.unwrap(
  Effect.promise(async () => {
    const { InstanceBootstrap } = await import("./bootstrap")
    return InstanceStore.defaultLayer.pipe(
      Layer.provide(InstanceBootstrap.defaultLayer),
      Layer.provideMerge(InstanceDisposalRegistry.layer),
    )
  }),
)

export * as InstanceLayer from "./instance-layer"
