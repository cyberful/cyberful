// ── Interactive Runner Cancellation Contract ──────────────────────
// Verifies cancelling routine background work interrupts its owned fiber,
// releases the runner for another action, and resolves existing waiters explicitly.
// → cyberful/src/effect/runner.ts — owns serialized run and shell transitions.
// ────────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { make } from "./runner"

test("cancelling active work resolves its waiter and returns to idle", async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Effect.scope
        const started = yield* Deferred.make<void>()
        const runner = make<number>(scope, { onInterrupt: Effect.succeed(-1) })
        const waiter = yield* runner
          .ensureRunning(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.forkChild)

        yield* Deferred.await(started)
        expect(runner.busy).toBe(true)
        yield* runner.cancel

        return {
          value: yield* Fiber.join(waiter),
          busy: runner.busy,
        }
      }),
    ),
  )

  expect(result).toEqual({ value: -1, busy: false })
})
