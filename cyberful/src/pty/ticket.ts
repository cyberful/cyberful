// ── Single-Use PTY Connection Tickets ────────────────────────────
// Issues short-lived connection credentials bound to one terminal and instance,
//   then atomically consumes them to prevent replay across websocket sessions.
// ─────────────────────────────────────────────────────────────────

export * as PtyTicket from "./ticket"

import { InstanceRef } from "@/effect/instance-ref"
import { PtyID } from "@/pty/schema"
import { PositiveInt } from "@/schema"
import { Cache, Context, Duration, Effect, Layer, Schema } from "effect"

const DEFAULT_TTL = Duration.seconds(60)
const CAPACITY = 10_000

export const ConnectToken = Schema.Struct({
  ticket: Schema.String,
  expires_in: PositiveInt,
})

export type Scope = {
  readonly ptyID: PtyID
  readonly directory?: string
}

export interface Interface {
  issue(input: Scope): Effect.Effect<typeof ConnectToken.Type>
  consume(input: Scope & { readonly ticket: string }): Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/PtyTicket") {}

function matches(record: Scope, input: Scope) {
  return record.ptyID === input.ptyID && record.directory === input.directory
}

// ── Consumption Atomically Invalidates A Matching Ticket ─────────
// Issuance inserts the terminal and instance scope directly into the bounded
// cache. Consumption removes a record only when both scope fields match, making
// replay and cross-instance use fail without revealing which field differed.
// The cache lookup path is deliberately unreachable because a read followed by
// invalidation would reopen a race between simultaneous websocket handshakes.
// ─────────────────────────────────────────────────────────────────
const noLookup = () => Effect.die("PtyTicket cache must be used via set/invalidateWhen, never get")

export const make = (ttl: Duration.Input = DEFAULT_TTL) =>
  Effect.gen(function* () {
    const cache = yield* Cache.make<string, Scope>({ capacity: CAPACITY, lookup: noLookup, timeToLive: ttl })
    const expiresIn = Math.max(1, Math.round(Duration.toSeconds(Duration.fromInputUnsafe(ttl))))
    return Service.of({
      issue: Effect.fn("PtyTicket.issue")(function* (input) {
        const ticket = crypto.randomUUID()
        yield* Cache.set(cache, ticket, input)
        return { ticket, expires_in: expiresIn }
      }),
      consume: Effect.fn("PtyTicket.consume")(function* (input) {
        return yield* Cache.invalidateWhen(cache, input.ticket, (stored) => matches(stored, input))
      }),
    })
  })

export const layer = Layer.effect(Service, make())

export const defaultLayer = layer

export const scope = Effect.gen(function* () {
  const instance = yield* InstanceRef
  return {
    directory: instance?.directory,
  }
})
