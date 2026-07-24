// ── Canonical Event Publisher ────────────────────────────────────
// Projects typed Event publications onto the transactional persistence and
// instance delivery surfaces while preserving their public envelopes.
// → cyberful/src/event.ts — owns the canonical typed event catalog.
// → cyberful/src/event-projection.ts — persists versioned aggregate projections.
// ─────────────────────────────────────────────────────────────────
import { Bus as ProjectBus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import { InstanceRef } from "@/effect/instance-ref"
import { makeRuntime } from "@/effect/run-service"
import type { InstanceContext } from "@/project/instance-context"
import { EventProjection } from "@/event-projection"
import * as EventDefinition from "@/event-definition"
import { Context, Effect, Layer } from "effect"
import { isRecord } from "@/util/record"

export function toSyncDefinition<D extends EventDefinition.Definition>(definition: D) {
  const result = {
    type: definition.type,
    version: definition.version,
    aggregate: definition.aggregate,
    schema: definition.data,
    properties: definition.properties,
  }
  // ── The Bridge Preserves One Definition At Type Erasure ─────────
  // Event and EventProjection describe the same runtime schema with differently
  // named fields. This adapter copies the exact definition object references;
  // it does not decode or transform event data. The assertion restores the
  // generic association TypeScript loses while assembling the intermediate
  // object, and the downstream EventProjection schema remains the runtime validator.
  // ─────────────────────────────────────────────────────────────────
  return result as EventProjection.Definition<D["type"], D["data"], D["properties"]>
}

export interface PublishOptions {
  readonly id?: EventDefinition.ID
  readonly metadata?: Record<string, unknown>
  readonly publish?: boolean
}

export interface EmitOptions {
  readonly id?: EventDefinition.ID
}

export interface Interface {
  readonly publish: <D extends EventDefinition.Definition>(
    definition: D,
    data: EventDefinition.Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<EventDefinition.Payload<D>>
  readonly publishEvent: <D extends EventDefinition.Definition>(
    event: EventDefinition.Payload<D>,
  ) => Effect.Effect<EventDefinition.Payload<D>>
  readonly emit: <D extends EventDefinition.Definition>(
    definition: D,
    properties: EventDefinition.Properties<D>,
    options?: EmitOptions,
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/Event") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* ProjectBus.Service
    const sync = yield* EventProjection.Service

    const publishGlobal = (event: {
      id: EventDefinition.ID
      type: string
      properties: unknown
    }) =>
      Effect.sync(() => {
        GlobalBus.emit("event", {
          payload: {
            id: event.id,
            type: event.type,
            properties: event.properties,
          },
        })
      })

    const provideEventLocation = <E, R>(
      event: {
        id: EventDefinition.ID
        type: string
        properties: unknown
      },
      effect: Effect.Effect<void, E, R>,
    ) => {
      return Effect.gen(function* () {
        const ctx = yield* InstanceRef
        if (ctx) return yield* effect
        return yield* publishGlobal(event)
      })
    }

    function emit<D extends EventDefinition.Definition>(
      definition: D,
      properties: EventDefinition.Properties<D>,
      options?: EmitOptions,
    ) {
      const id = options?.id ?? EventDefinition.ID.create()
      return provideEventLocation(
        { id, type: definition.type, properties },
        bus.publish(definition, properties, { id }),
      )
    }

    function routeEvent<D extends EventDefinition.Definition>(
      event: EventDefinition.Payload<D>,
      shouldPublish: boolean,
    ) {
      return Effect.gen(function* () {
        const definition = EventDefinition.definition(event.type)
        if (!definition) throw new Error(`Event type is not registered: ${event.type}`)
        const aggregateID =
          definition.aggregate && isRecord(event.data) ? event.data[definition.aggregate] : undefined

        if (definition.version !== undefined && typeof aggregateID === "string") {
          if (!shouldPublish) {
            yield* sync.run(toSyncDefinition(definition), event.data, { publish: false })
            return event
          }
          yield* provideEventLocation(
            { id: event.id, type: event.type, properties: event.data },
            sync.run(toSyncDefinition(definition), event.data),
          )
          return event
        }

        if (!shouldPublish) return event
        yield* emit(
          definition,
          // Unversioned definitions use their data schema as their live schema.
          event.data as EventDefinition.Properties<D>,
          { id: event.id },
        )
        return event
      })
    }

    function publishEvent<D extends EventDefinition.Definition>(event: EventDefinition.Payload<D>) {
      return routeEvent(event, true)
    }

    function publish<D extends EventDefinition.Definition>(
      definition: D,
      data: EventDefinition.Data<D>,
      options?: PublishOptions,
    ) {
      return routeEvent(
        {
          id: options?.id ?? EventDefinition.ID.create(),
          ...(options?.metadata ? { metadata: options.metadata } : {}),
          type: definition.type,
          ...(definition.version === undefined ? {} : { version: definition.version }),
          data,
        } satisfies EventDefinition.Payload<D>,
        options?.publish !== false,
      )
    }

    return Service.of({ emit, publish, publishEvent })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EventProjection.defaultLayer),
  Layer.provide(ProjectBus.defaultLayer),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export function publish<D extends EventDefinition.Definition>(
  context: InstanceContext,
  definition: D,
  data: EventDefinition.Data<D>,
  options?: PublishOptions,
) {
  return runPromise((service) =>
    service.publish(definition, data, options).pipe(Effect.provideService(InstanceRef, context)),
  )
}
