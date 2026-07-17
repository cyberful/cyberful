// ── Legacy Event Schema Registry ─────────────────────────────────
// Registers typed legacy event definitions and exposes their payload schemas for
// the HTTP API while EventV2 definitions share the same transport surface.
// → cyberful/src/event-v2.ts — supplies the newer event definitions included here.
// → cyberful/src/bus/index.ts — publishes instances of these registered schemas.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import { EventV2 } from "@/event-v2"

export type Definition<Type extends string = string, Properties extends Schema.Top = Schema.Top> = {
  type: Type
  properties: Properties
}

const registry = new Map<string, Definition>()
let frozen = false

export function define<Type extends string, Properties extends Schema.Top>(
  type: Type,
  properties: Properties,
): Definition<Type, Properties> {
  if (frozen) throw new Error(`Legacy event catalog is frozen; cannot define ${type}`)
  if (registry.has(type)) throw new Error(`Legacy event type is already defined: ${type}`)
  const result = { type, properties }
  registry.set(type, result)
  return result
}

export function freezeDefinitions() {
  frozen = true
}

export function effectPayloads() {
  return [
    ...registry
      .entries()
      .map(([type, def]) =>
        Schema.Struct({
          id: Schema.String,
          type: Schema.Literal(type),
          properties: def.properties,
        }).annotate({ identifier: `Event.${type}` }),
      )
      .toArray(),
    ...EventV2.definitions().map((definition) =>
      Schema.Struct({
        id: Schema.String,
        type: Schema.Literal(definition.type),
        properties: definition.data,
      }).annotate({ identifier: `Event.${definition.type}` }),
    ),
  ]
}

export * as BusEvent from "./bus-event"
