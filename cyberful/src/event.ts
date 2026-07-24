// ── Canonical Event System ───────────────────────────────────────
// Exposes one public namespace for defining and publishing every Cyberful event.
// Persistence and delivery remain internal implementation details of its layer.
// → cyberful/src/event-definition.ts — owns the sealed schema catalog.
// → cyberful/src/event-publisher.ts — routes publications to their required sink.
// ─────────────────────────────────────────────────────────────────

export * from "./event-definition"
export { Service, defaultLayer, layer, publish } from "./event-publisher"
export type { EmitOptions, Interface, PublishOptions } from "./event-publisher"
export * as Event from "./event"
