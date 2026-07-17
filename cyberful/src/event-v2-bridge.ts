// ── Event V2 Compatibility Bridge ────────────────────────────────
// Projects typed Event V2 publications onto the transactional persistence and
// global bus surfaces still required by current consumers.
// → cyberful/src/event-v2.ts — owns the canonical typed publication stream.
// → cyberful/src/sync/index.ts — persists versioned aggregate projections.
// ─────────────────────────────────────────────────────────────────
import { Bus as ProjectBus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { InstanceRef } from "@/effect/instance-ref"
import { SyncEvent } from "@/sync"
import { EventV2 } from "@/event-v2"
import "@/session/event-v2"
import { Context, Effect, Layer } from "effect"
import { isRecord } from "@/util/record"

export function toSyncDefinition<D extends EventV2.Definition>(definition: D) {
  const result = {
    type: definition.type,
    version: definition.version,
    aggregate: definition.aggregate,
    schema: definition.data,
    properties: definition.data,
  }
  // ── The Bridge Preserves One Definition At Type Erasure ─────────
  // Event V2 and SyncEvent describe the same runtime schema with differently
  // named fields. This adapter copies the exact definition object references;
  // it does not decode or transform event data. The assertion restores the
  // generic association TypeScript loses while assembling the intermediate
  // object, and the downstream SyncEvent schema remains the runtime validator.
  // ─────────────────────────────────────────────────────────────────
  return result as SyncEvent.Definition<D["type"], D["data"], D["data"]>
}

export class Service extends Context.Service<Service, EventV2.Interface>()("@cyberful/EventV2Bridge") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const bus = yield* ProjectBus.Service
    const sync = yield* SyncEvent.Service

    const publishGlobal = (event: EventV2.Payload) =>
      Effect.sync(() => {
        GlobalBus.emit("event", {
          payload: {
            id: event.id,
            type: event.type,
            properties: event.data,
          },
        })
      })

    const provideEventLocation = <E, R>(event: EventV2.Payload, effect: Effect.Effect<void, E, R>) => {
      return Effect.gen(function* () {
        const ctx = yield* InstanceRef
        if (ctx) return yield* effect
        return yield* publishGlobal(event)
      })
    }

    const unsubscribe = yield* events.sync((event) => {
      const definition = EventV2.definition(event.type)
      if (!definition) return Effect.void
      const aggregateID = definition.aggregate && isRecord(event.data) ? event.data[definition.aggregate] : undefined

      if (definition.version !== undefined && typeof aggregateID === "string") {
        return provideEventLocation(event, sync.run(toSyncDefinition(definition), event.data))
      }

      return provideEventLocation(
        event,
        bus.publish({ type: definition.type, properties: definition.data }, event.data, { id: event.id }),
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    return Service.of(events)
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventV2.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
  Layer.provide(ProjectBus.defaultLayer),
)

export * as EventV2Bridge from "./event-v2-bridge"
