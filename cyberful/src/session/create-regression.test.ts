// ── Session Creation Event Regression ────────────────────────────
// Exercises the real session projector and live event path against a fresh
// database so optional fields cannot turn creation into a second invalid update.
// → cyberful/src/event-publisher.ts — separates persistence from live emission.
// → cyberful/src/session/session.ts — creates and announces the session.
// ─────────────────────────────────────────────────────────────────

import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"

const previousDatabase = process.env.CYBERFUL_DB
process.env.CYBERFUL_DB = ":memory:"

const { Database } = await import("@/storage/db")
const { GlobalBus } = await import("@/bus/global")
const { InstanceRef } = await import("@/effect/instance-ref")
const { ProjectID } = await import("@/project/schema")
const { ProjectTable } = await import("@/project/project.sql")
const { initProjectors } = await import("@/server/projectors")
const { Session } = await import("./session")

const projectID = ProjectID.make("project_session_create_regression")
const directory = "/tmp/cyberful-session-create-regression"
const now = Date.now()

initProjectors()
Database.use((db) => db.insert(ProjectTable).values({ id: projectID, worktree: directory }).run())

afterAll(() => {
  Database.close()
  if (previousDatabase === undefined) delete process.env.CYBERFUL_DB
  else process.env.CYBERFUL_DB = previousDatabase
})

test("creates and returns a session whose omitted optional fields do not become an update patch", async () => {
  const createdPublished = Promise.withResolvers<void>()
  const publishedTypes: string[] = []
  const onEvent = (event: { project?: string; payload: { type: string } }) => {
    if (event.project !== projectID) return
    publishedTypes.push(event.payload.type)
    if (event.payload.type === Session.Event.Created.type) createdPublished.resolve()
  }
  GlobalBus.on("event", onEvent)
  const context = {
    directory,
    worktree: directory,
    project: {
      id: projectID,
      worktree: directory,
      time: { created: now, updated: now },
    },
  }

  try {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.Service
        const created = yield* session.create()
        yield* Effect.promise(() => createdPublished.promise)
        const stored = yield* session.get(created.id)
        return { created, stored }
      }).pipe(Effect.provide(Session.defaultLayer), Effect.provideService(InstanceRef, context), Effect.scoped),
    )

    expect(result.created).toEqual(result.stored)
    expect(result.created.path).toBe("")
    expect(result.created.parentID).toBeUndefined()
    expect(result.created.workflow).toBeUndefined()
    expect(result.created.agent).toBeUndefined()
    expect(publishedTypes).toContain(Session.Event.Created.type)
    expect(publishedTypes).toContain(Session.Event.Updated.type)
  } finally {
    GlobalBus.off("event", onEvent)
  }
})
