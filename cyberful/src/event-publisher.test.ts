// ── Canonical Event Routing Contract ─────────────────────────────
// Proves one publication selects exactly one first-hop sink: aggregate events
//   enter transactional projection, while transient events enter the live bus.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { Bus } from "@/bus"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID } from "@/session/schema"
import { SessionEvent } from "@/session/event"
import { Event } from "@/event"
import { EventProjection } from "@/event-projection"
import { DateTime, Effect, Layer } from "effect"

test("routes aggregate persistence and transient fan-out exactly once", async () => {
  const projected: { type: string; data: unknown; publish: boolean | undefined }[] = []
  const delivered: { type: string; properties: unknown; id: string | undefined }[] = []
  const bus = Bus.Service.of({
    publish: (definition, properties, options) =>
      Effect.sync(() => delivered.push({ type: definition.type, properties, id: options?.id })),
    subscribe: () => Effect.die("not used"),
    subscribeAll: () => Effect.die("not used"),
    subscribeCallback: () => Effect.die("not used"),
    subscribeAllCallback: () => Effect.die("not used"),
  })
  const projection = EventProjection.Service.of({
    run: (definition, data, options) =>
      Effect.sync(() => projected.push({ type: definition.type, data, publish: options?.publish })),
  })
  const dependencies = Layer.merge(Layer.succeed(Bus.Service, bus), Layer.succeed(EventProjection.Service, projection))
  const eventLayer = Event.layer.pipe(Layer.provide(dependencies))
  const context = {
    directory: "/workspace",
    worktree: "/workspace",
    project: { id: "project_event_test" },
  } as InstanceContext
  const sessionID = SessionID.make("ses_event_test")
  const timestamp = DateTime.makeUnsafe(1)

  await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* Event.Service
      yield* events.publish(
        SessionEvent.Synthetic,
        { timestamp, sessionID, text: "persist once" },
        { id: Event.ID.make("event_projected") },
      )
      yield* events.emit(
        SessionEvent.Synthetic,
        { timestamp, sessionID, text: "emit only" },
        { id: Event.ID.make("event_emitted") },
      )
      yield* events.publish(
        SessionEvent.SubsystemPhaseActivity,
        {
          timestamp,
          sessionID,
          phase: "recon",
          subsystem: { name: "pi", version: "test", label: "Pi Agent" },
          kind: "start",
          text: "",
          tool: "",
        },
        { id: Event.ID.make("event_transient") },
      )
    }).pipe(Effect.provideService(InstanceRef, context), Effect.provide(eventLayer)),
  )

  expect(projected).toEqual([
    {
      type: "session.next.synthetic",
      data: { timestamp, sessionID, text: "persist once" },
      publish: undefined,
    },
  ])
  expect(delivered).toEqual([
    {
      type: "session.next.synthetic",
      properties: { timestamp, sessionID, text: "emit only" },
      id: "event_emitted",
    },
    {
      type: "session.next.subsystem.phase_activity",
      properties: {
        timestamp,
        sessionID,
        phase: "recon",
        subsystem: { name: "pi", version: "test", label: "Pi Agent" },
        kind: "start",
        text: "",
        tool: "",
      },
      id: "event_transient",
    },
  ])
})
