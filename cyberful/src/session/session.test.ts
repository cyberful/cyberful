// ── Session Persistence Tests ─────────────────────────────────────
// Verifies session creation, storage, workflow identity, write serialization, and lifecycle events.
// → cyberful/src/session/session.ts — owns the tested session service.
// ─────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MessageID, SessionID } from "./schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "./message-v2"
import { SessionPhaseEpoch } from "./phase-epoch"
import { SessionWriteCoordinator } from "./write-coordinator"

describe("Session message write gate", () => {
  test("a phase boundary cannot interleave between a guarded check and its append", async () => {
    // Two independently captured clients model separate Session layers/memo maps in one worker.
    const coordinator = SessionWriteCoordinator.make()
    const writerA = coordinator.run
    const writerB = coordinator.run
    const sessionID = SessionID.make("ses_write_gate")
    const checked = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const order: string[] = []

    const steer = Effect.runPromise(
      writerA(
        sessionID,
        Effect.gen(function* () {
          order.push("epoch-checked")
          checked.resolve()
          yield* Effect.promise(() => release.promise)
          order.push("steer-appended")
        }),
      ),
    )
    await checked.promise
    const handoff = Effect.runPromise(
      writerB(
        sessionID,
        Effect.sync(() => {
          order.push("phase-boundary-or-removal")
        }),
      ),
    )
    await Promise.resolve()
    expect(order).toEqual(["epoch-checked"])

    release.resolve()
    await Promise.all([steer, handoff])
    expect(order).toEqual(["epoch-checked", "steer-appended", "phase-boundary-or-removal"])
  })

  test("a queued steer append is atomically discarded after a concurrent phase change", async () => {
    const coordinator = SessionWriteCoordinator.make()
    const writerA = coordinator.run
    const writerB = coordinator.run
    const sessionID = SessionID.make("ses_stale_steer")
    const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("model") }
    const user = (id: string, created: number): MessageV2.WithParts => ({
      info: {
        id: MessageID.make(id),
        sessionID,
        role: "user",
        time: { created },
        agent: "exploit",
        model,
      },
      parts: [],
    })
    const messages = [user("msg_01", 100)]
    const expected = SessionPhaseEpoch.derive(messages)
    if (!expected) throw new Error("expected the user fixture to define a phase epoch")
    const boundaryHeld = Promise.withResolvers<void>()
    const releaseBoundary = Promise.withResolvers<void>()

    const boundary = Effect.runPromise(
      writerA(
        sessionID,
        Effect.gen(function* () {
          boundaryHeld.resolve()
          yield* Effect.promise(() => releaseBoundary.promise)
          messages.push(user("msg_02", 200))
        }),
      ),
    )
    await boundaryHeld.promise

    let appended = false
    const steer = Effect.runPromise(
      writerB(
        sessionID,
        Effect.sync(() => {
          if (!SessionPhaseEpoch.matches(messages, expected)) return
          messages.push(user("msg_03", 300))
          appended = true
        }),
      ),
    )
    releaseBoundary.resolve()
    await Promise.all([boundary, steer])

    expect(appended).toBe(false)
    expect(messages.map((message) => message.info.id)).toEqual([MessageID.make("msg_01"), MessageID.make("msg_02")])
  })
})
