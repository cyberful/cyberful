// ── Instance Bootstrap Contract ───────────────────────────────────────────
// Defines the lightweight service boundary used to bootstrap one project instance.
// → cyberful/src/project/bootstrap.ts — implements the bootstrap operation.
// → cyberful/src/project/instance-store.ts — invokes it for each new instance.
// ─────────────────────────────────────────────────────────────────────────

import { Context, Effect } from "effect"

export interface Interface {
  readonly run: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/InstanceBootstrap") {}

export * as InstanceBootstrap from "./bootstrap-service"
