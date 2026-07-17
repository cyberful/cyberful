// ── Instance Disposal Failure Contract ─────────────────────────────
// Verifies project retirement attempts every registered cache disposer and
// reports cleanup failures instead of silently treating partial disposal as success.
// → cyberful/src/effect/instance-registry.ts — coordinates registered disposers.
// ────────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { Effect } from "effect"
import { InstanceDisposalRegistry } from "./instance-registry"

test("instance disposal runs every owner and surfaces aggregate failure", async () => {
  const calls: string[] = []
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* InstanceDisposalRegistry.Service
      const unregisterFailure = registry.register(async (directory) => {
        calls.push(`failure:${directory}`)
        throw new Error("cache cleanup failed")
      })
      const unregisterSuccess = registry.register(async (directory) => {
        calls.push(`success:${directory}`)
      })

      try {
        const failure = yield* Effect.promise(() =>
          registry.dispose("/workspace/project").then(
            () => undefined,
            (error: unknown) => error,
          ),
        )
        expect(failure).toBeInstanceOf(AggregateError)
        expect(calls.sort()).toEqual(["failure:/workspace/project", "success:/workspace/project"])
      } finally {
        unregisterFailure()
        unregisterSuccess()
      }
    }).pipe(Effect.provide(InstanceDisposalRegistry.layer)),
  )
})

test("independent runtime scopes do not inherit another registry's disposers", async () => {
  let calls = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* InstanceDisposalRegistry.Service
      registry.register(async () => {
        calls++
      })
      yield* Effect.promise(() => registry.dispose("/workspace/first"))
    }).pipe(Effect.provide(InstanceDisposalRegistry.layer)),
  )

  await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* InstanceDisposalRegistry.Service
      yield* Effect.promise(() => registry.dispose("/workspace/second"))
    }).pipe(Effect.provide(InstanceDisposalRegistry.layer)),
  )

  expect(calls).toBe(1)
})
