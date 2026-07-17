// ── Process Session Write Coordination ───────────────────────────
// Owns the process-wide per-session permits that serialize message mutations
// across application runtimes, HTTP listeners, and independently built layers.
// → cyberful/src/session/session.ts — routes every message mutation through this service.
// → cyberful/src/effect/memo-map.ts — shares the layer identity across managed runtimes.
// ─────────────────────────────────────────────────────────────────

import { Context, Effect, Layer, Semaphore } from "effect"
import type { SessionID } from "./schema"

type Entry = {
  readonly gate: Semaphore.Semaphore
  users: number
  retired: boolean
}

export interface Interface {
  readonly run: <A, E, R>(sessionID: SessionID, operation: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly forget: (sessionID: SessionID) => void
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/SessionWriteCoordinator") {}

export function make(): Interface {
  const entries = new Map<SessionID, Entry>()

  function get(sessionID: SessionID) {
    const current = entries.get(sessionID)
    if (current) return current
    const created = { gate: Semaphore.makeUnsafe(1), users: 0, retired: false }
    entries.set(sessionID, created)
    return created
  }

  // ── Retirement Waits For Every Queued Writer ───────────────────
  // Effect construction does not claim a permit; acquisition starts only when
  // the returned operation runs. Each running or queued caller increments one
  // owner count before entering the semaphore and releases it in an ensuring
  // finalizer. Session removal marks the entry retired, but the map drops it only
  // after the last queued writer exits, so a second gate cannot overlap the first.
  // ─────────────────────────────────────────────────────────────────
  function run<A, E, R>(sessionID: SessionID, operation: Effect.Effect<A, E, R>) {
    return Effect.suspend(() => {
      const entry = get(sessionID)
      entry.users++
      return entry.gate
        .withPermits(1)(operation)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.users--
              if (entry.retired && entry.users === 0 && entries.get(sessionID) === entry) entries.delete(sessionID)
            }),
          ),
        )
    })
  }

  function forget(sessionID: SessionID) {
    const entry = entries.get(sessionID)
    if (!entry) return
    entry.retired = true
    if (entry.users === 0) entries.delete(sessionID)
  }

  return { run, forget }
}

// ── Layer Identity Owns Process Sharing ──────────────────────────
// Managed runtimes use the same explicit memo map and the same exported Layer
// value, so Effect constructs one coordinator for that process graph. Mutable
// entries remain inside the scoped service rather than at module level. Tests
// and isolated runtimes can call `make` to receive independent ownership.
// ─────────────────────────────────────────────────────────────────
export const processLayer = Layer.sync(Service, make)

export * as SessionWriteCoordinator from "./write-coordinator"
