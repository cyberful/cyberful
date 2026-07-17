// ── Transactional Projected Events ───────────────────────────────
// Applies versioned projectors inside the owning database transaction and emits
// validated live bus payloads only after that transaction commits.
// → cyberful/src/storage/db.ts — serializes transactions and post-commit effects.
// → cyberful/src/event-v2-bridge.ts — adapts typed events onto this projection surface.
// ─────────────────────────────────────────────────────────────────
import { Database } from "@/storage/db"
import { GlobalBus } from "@/bus/global"
import { Bus as ProjectBus } from "@/bus"
import { EventID } from "./schema"
import { Context, Effect, Layer, Schema as EffectSchema } from "effect"
import type { DeepMutable } from "@/schema"
import { EventV2 } from "@/event-v2"
import { serviceUse } from "@/effect/service-use"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { isRecord } from "@/util/record"

// ── Persisted Events Are Mutable Only Inside Their Projector ─────
// Projectors receive a mutable view because they translate an event into database
// writes and may normalize that transient persisted shape while doing so. Live bus
// properties retain the schema's readonly type because subscribers only observe
// committed output. Keeping these types distinct prevents projector mechanics from
// leaking mutation rights into the publication surface.
// ─────────────────────────────────────────────────────────────────

export type Definition<
  Type extends string = string,
  Schema extends EffectSchema.Top = EffectSchema.Top,
  BusSchema extends EffectSchema.Top = Schema,
> = {
  type: Type
  version: number
  aggregate: string
  schema: Schema
  // Bus event payload schema. Defaults to `schema` unless `busSchema` was
  // passed at definition time (see `session.updated`, whose projector
  // expands the persisted data to a `{ sessionID, info }` bus payload).
  properties: BusSchema
}

export type Event<Def extends Definition = Definition> = {
  id: string
  seq: number
  aggregateID: string
  data: DeepMutable<EffectSchema.Schema.Type<Def["schema"]>>
}

export type Properties<Def extends Definition = Definition> = EffectSchema.Schema.Type<Def["properties"]>

type ProjectorFunc = (db: Database.TxOrDb, data: unknown, event: Event) => void
type ConvertEvent = (type: string, data: Event["data"]) => unknown | Promise<unknown>

export interface Interface {
  readonly run: <Def extends Definition>(
    def: Def,
    data: Event<Def>["data"],
    options?: { publish?: boolean },
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/SyncEvent") {}

export const layer = Layer.effect(Service)(
  Effect.gen(function* () {
    const bus = yield* ProjectBus.Service

    const run: Interface["run"] = Effect.fn("SyncEvent.run")(function* (def, data, options) {
      const agg = isRecord(data) ? data[def.aggregate] : undefined
      if (typeof agg !== "string") {
        throw new Error(`SyncEvent.run: "${def.aggregate}" required but not found: ${JSON.stringify(data)}`)
      }

      if (def.version !== versions.get(def.type)) {
        throw new Error(`SyncEvent.run: running old versions of events is not allowed: ${def.type}`)
      }

      const { publish = true } = options || {}
      const bridge = yield* EffectBridge.make()
      process(def, { id: EventID.ascending(), seq: 0, aggregateID: agg, data }, { bus, bridge, publish })
    })

    return Service.of({ run })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(ProjectBus.defaultLayer))

export const use = serviceUse(Service)

export const registry = new Map<string, Definition>()
let projectors: Map<string, ProjectorFunc> | undefined
const versions = new Map<string, number>()
let initialized = false
let definitionsFrozen = false
let convertEvent: ConvertEvent

export function reset() {
  initialized = false
  projectors = undefined
  convertEvent = (_, data) => data
}

export function init(input: { projectors: Array<[Definition, ProjectorFunc]>; convertEvent?: ConvertEvent }) {
  projectors = new Map(input.projectors.map(([def, func]) => [versionedType(def.type, def.version), func]))
  for (const entry of EventV2.definitions()) {
    if (!entry.version || !entry.aggregate) continue
    register({
      type: entry.type,
      version: entry.version,
      aggregate: entry.aggregate,
      properties: entry.data,
      schema: entry.data,
    })
  }

  // ── Initialization Freezes The Projector Registry ───────────────
  // Projectors, versions, and live bus schemas must describe one coherent set.
  // Initialization derives the latest bus definitions and then closes mutation;
  // accepting a later event definition would allow persistence and publication
  // to disagree about its version or payload. Tests may call reset explicitly,
  // but production code treats this registry as immutable after startup.
  // ─────────────────────────────────────────────────────────────────
  initialized = true
  convertEvent = input.convertEvent ?? ((_, data) => data)
}

export function versionedType<A extends string>(type: A): A
export function versionedType<A extends string, B extends number>(type: A, version: B): `${A}/${B}`
export function versionedType(type: string, version?: number) {
  return version ? `${type}.${version}` : type
}

type DefinitionInput<Type extends string, Agg extends string, Schema extends EffectSchema.Top> = {
  type: Type
  version: number
  aggregate: Agg
  schema: Schema
}

export function define<Type extends string, Agg extends string, Schema extends EffectSchema.Top>(
  input: DefinitionInput<Type, Agg, Schema> & { busSchema?: never },
): Definition<Type, Schema, Schema>
export function define<
  Type extends string,
  Agg extends string,
  Schema extends EffectSchema.Top,
  BusSchema extends EffectSchema.Top,
>(input: DefinitionInput<Type, Agg, Schema> & { busSchema: BusSchema }): Definition<Type, Schema, BusSchema>
export function define(
  input: DefinitionInput<string, string, EffectSchema.Top> & { busSchema?: EffectSchema.Top },
): Definition {
  if (initialized || definitionsFrozen) {
    throw new Error("Error defining sync event: sync system has been frozen")
  }

  const def = {
    type: input.type,
    version: input.version,
    aggregate: input.aggregate,
    schema: input.schema,
    properties: input.busSchema ?? input.schema,
  }

  register(def)

  return def
}

export function project<Def extends Definition>(
  def: Def,
  func: (db: Database.TxOrDb, data: Event<Def>["data"], event: Event<Def>) => void,
): [Definition, ProjectorFunc] {
  // ── Projector Erasure Preserves Its Definition Pair ─────────────
  // Each projector enters the registry in the same tuple as its exact definition,
  // and initialization keys that pair by versioned event type. Processing performs
  // the inverse lookup before invocation, so erasure cannot select a projector from
  // another definition. The assertion removes only the generic parameter needed by
  // the heterogeneous map; the paired runtime function and schema are unchanged.
  // ─────────────────────────────────────────────────────────────────
  return [def, func as ProjectorFunc]
}

function register(def: Definition) {
  const key = versionedType(def.type, def.version)
  const existing = registry.get(key)
  if (existing) {
    if (
      existing.type === def.type &&
      existing.version === def.version &&
      existing.aggregate === def.aggregate &&
      existing.schema === def.schema &&
      existing.properties === def.properties
    ) {
      return
    }
    throw new Error(`Sync event type and version are already defined: ${key}`)
  }
  versions.set(def.type, Math.max(def.version, versions.get(def.type) || 0))
  registry.set(key, def)
}

export function freezeDefinitions() {
  definitionsFrozen = true
}

export function busPayloads() {
  return versions
    .entries()
    .flatMap(([type, version]) => {
      if (EventV2.definition(type)) return []
      const def = registry.get(versionedType(type, version))
      if (!def) throw new Error(`Latest SyncEvent definition is missing: ${versionedType(type, version)}`)
      return [
        EffectSchema.Struct({
          id: EffectSchema.String,
          type: EffectSchema.Literal(type),
          properties: def.properties,
        }).annotate({ identifier: `Event.${type}` }),
      ]
    })
    .toArray()
}

// ── Projected Payloads Cross The Schema Boundary Once ───────────
// Projectors and converters operate on Schema.Type values, including Option
// wrappers introduced by transformed optional properties. Encoding first proves
// that typed value is valid and restores its wire representation; decoding that
// representation then yields one canonical Type value for every live subscriber.
// Decoding an already-typed value would reject valid Option.Some properties.
//
// ─────────────────────────────────────────────────────────────────
export function canonicalProperties<S extends EffectSchema.Top>(schema: S, value: unknown) {
  return EffectSchema.encodeUnknownEffect(schema)(value).pipe(
    Effect.flatMap((encoded) => EffectSchema.decodeUnknownEffect(schema)(encoded)),
  )
}

function process<Def extends Definition>(
  def: Def,
  event: Event<Def>,
  options: {
    bus: ProjectBus.Interface
    bridge: EffectBridge.Shape
    publish: boolean
  },
) {
  if (projectors == null) {
    throw new Error("No projectors available. Call `SyncEvent.init` to install projectors")
  }

  const projector = projectors.get(versionedType(def.type, def.version))
  if (!projector) {
    if (!def.type.includes("next")) throw new Error(`Projector not found for event: ${def.type}`)
    return
  }

  Database.transaction((tx) => {
    projector(tx, event.data, event)

    // ── Publication Happens Only After A Successful Commit ────────
    // The projector mutates persisted state synchronously inside the transaction.
    // Database.effect defers all external observation until commit has succeeded,
    // while the captured Effect bridge retains the originating instance context.
    // Conversion may be asynchronous, so one explicitly forked fiber owns it and
    // validates the resulting live payload before either bus can observe it.
    // ─────────────────────────────────────────────────────────────────
    Database.effect(() => {
      if (!options.publish) return
      options.bridge.fork(
        Effect.tryPromise({
          try: () => Promise.resolve(convertEvent(def.type, event.data)),
          catch: (cause) => cause,
        }).pipe(
          Effect.flatMap((data) =>
            canonicalProperties(def.properties, data).pipe(
              // The schema has just decoded this definition's property type; the
              // generic association is lost only because Definition stores Schema.Top.
              Effect.map((properties) => properties as Properties<Def>),
            ),
          ),
          Effect.flatMap((properties) =>
            Effect.gen(function* () {
              yield* options.bus.publish(def, properties, { id: event.id })
              const instance = yield* InstanceState.context
              GlobalBus.emit("event", {
                directory: instance.directory,
                project: instance.project.id,
                payload: {
                  type: "sync",
                  syncEvent: {
                    type: versionedType(def.type, def.version),
                    ...event,
                  },
                },
              })
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logError("failed to publish projected event").pipe(
              Effect.annotateLogs({ type: def.type, eventID: event.id, cause }),
            ),
          ),
        ),
      )
    })
  })
}

export function effectPayloads() {
  return [
    ...registry
      .entries()
      .map(([type, def]) =>
        EffectSchema.Struct({
          type: EffectSchema.Literal("sync"),
          name: EffectSchema.Literal(type),
          id: EffectSchema.String,
          seq: EffectSchema.Finite,
          aggregateID: EffectSchema.Literal(def.aggregate),
          data: def.schema,
        }).annotate({ identifier: `SyncEvent.${type}` }),
      )
      .toArray(),
    ...EventV2.definitions().flatMap((definition) => {
      if (definition.version === undefined || definition.aggregate === undefined) return []
      if (registry.has(versionedType(definition.type, definition.version))) return []
      return [
        EffectSchema.Struct({
          type: EffectSchema.Literal("sync"),
          name: EffectSchema.Literal(versionedType(definition.type, definition.version)),
          id: EffectSchema.String,
          seq: EffectSchema.Finite,
          aggregateID: EffectSchema.Literal(definition.aggregate),
          data: definition.data,
        }).annotate({ identifier: `SyncEvent.${definition.type}` }),
      ]
    }),
  ]
}

export * as SyncEvent from "."
