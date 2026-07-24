// ── Canonical Event Definitions ──────────────────────────────────
// Defines the single event schema registry shared by transactional persistence,
// instance delivery, the global stream, and generated HTTP contracts.
// → cyberful/src/event-publisher.ts — projects events onto persistence and delivery surfaces.
// → cyberful/src/session/event.ts — registers session-domain event definitions.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import { withStatics } from "@/schema"
import { Identifier } from "@/id/id"

export const ID = Schema.String.pipe(
  Schema.brand("Event.ID"),
  withStatics((schema) => ({ create: () => schema.make(Identifier.ascending("event")) })),
)
export type ID = typeof ID.Type

export type Definition<
  Type extends string = string,
  DataSchema extends Schema.Top = Schema.Top,
  PropertiesSchema extends Schema.Top = DataSchema,
> = {
  readonly type: Type
  readonly version?: number
  readonly aggregate?: string
  readonly data: DataSchema
  readonly schema: DataSchema
  readonly properties: PropertiesSchema
}

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>
export type Properties<D extends Definition> = Schema.Schema.Type<D["properties"]>

export type Payload<D extends Definition = Definition> = {
  readonly id: ID
  readonly type: D["type"]
  readonly data: Data<D>
  readonly version?: number
  readonly metadata?: Record<string, unknown>
}

const registry = new Map<string, Definition>()
let frozen = false

// ── One Definition Is Both Schema And Routing Metadata ───────────
// Consumers need a runtime payload schema and the static event metadata from one
// registered value. Object.assign preserves the exact Schema object and attaches
// only literal type, version, aggregate, and data fields. TypeScript loses the
// generic relationship across that mutation, so the return assertion restores
// the association already established by the shared Data and Payload schemas.
// ─────────────────────────────────────────────────────────────────
export function define<
  const Type extends string,
  const Aggregate extends string,
  DataSchema extends Schema.Top,
  PropertiesSchema extends Schema.Top = DataSchema,
>(input: {
  readonly type: Type
  readonly version: number
  readonly aggregate: Aggregate
  readonly schema: DataSchema
  readonly busSchema?: PropertiesSchema
}): Schema.Schema<Payload<Definition<Type, DataSchema, PropertiesSchema>>> &
  Definition<Type, DataSchema, PropertiesSchema> & {
    readonly version: number
    readonly aggregate: Aggregate
  }
export function define<const Type extends string, Fields extends Schema.Struct.Fields>(input: {
  readonly type: Type
  readonly version?: number
  readonly aggregate?: string
  readonly schema: Fields
}): Schema.Schema<Payload<Definition<Type, Schema.Struct<Fields>>>> & Definition<Type, Schema.Struct<Fields>>
export function define<
  const Type extends string,
  DataSchema extends Schema.Top,
  PropertiesSchema extends Schema.Top = DataSchema,
>(input: {
  readonly type: Type
  readonly version?: number
  readonly aggregate?: string
  readonly schema: DataSchema
  readonly busSchema?: PropertiesSchema
}): Schema.Schema<Payload<Definition<Type, DataSchema, PropertiesSchema>>> &
  Definition<Type, DataSchema, PropertiesSchema>
export function define<const Type extends string, DataSchema extends Schema.Top>(
  type: Type,
  schema: DataSchema,
): Schema.Schema<Payload<Definition<Type, DataSchema>>> & Definition<Type, DataSchema>
export function define(
  inputOrType: string | {
    readonly type: string
    readonly version?: number
    readonly aggregate?: string
    readonly schema: Schema.Top | Schema.Struct.Fields
    readonly busSchema?: Schema.Top
  },
  schema?: Schema.Top,
): unknown {
  const input: {
    readonly type: string
    readonly version?: number
    readonly aggregate?: string
    readonly schema: Schema.Top | Schema.Struct.Fields
    readonly busSchema?: Schema.Top
  } =
    typeof inputOrType === "string"
      ? { type: inputOrType, schema: schema ?? Schema.Struct({}) }
      : inputOrType
  if (frozen) throw new Error(`Event catalog is frozen; cannot define ${input.type}`)
  if (registry.has(input.type)) throw new Error(`Event type is already defined: ${input.type}`)

  const Data = Schema.isSchema(input.schema) ? input.schema : Schema.Struct(input.schema)
  const Properties = input.busSchema ?? Data
  const Payload = Schema.Struct({
    id: ID,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    version: Schema.optional(Schema.Number),
    data: Data,
  }).annotate({ identifier: input.type })

  const definition = Object.assign(Payload, {
    type: input.type,
    ...(input.version === undefined ? {} : { version: input.version }),
    ...(input.aggregate === undefined ? {} : { aggregate: input.aggregate }),
    data: Data,
    schema: Data,
    properties: Properties,
  })
  registry.set(input.type, definition)
  return definition
}

export function definitions() {
  return registry.values().toArray()
}

export function definition(type: string) {
  return registry.get(type)
}

export function freezeDefinitions() {
  frozen = true
}

export function effectPayloads() {
  return definitions().map((definition) =>
    Schema.Struct({
      id: Schema.String,
      type: Schema.Literal(definition.type),
      properties: definition.properties,
    }).annotate({ identifier: `Event.${definition.type}` }),
  )
}
