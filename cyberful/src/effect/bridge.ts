// ── Effect Callback Context Bridge ─────────────────────────────────
// Carries the active project instance and Effect context across synchronous,
// Promise-returning, forked, and Effect-native callback boundaries.
// → cyberful/src/effect/instance-ref.ts — identifies the captured project instance.
// ────────────────────────────────────────────────────────────────────

import { Context, Effect, Fiber } from "effect"
import { InstanceRef } from "./instance-ref"
import { attachWith } from "./run-service"

export interface Shape {
  readonly promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>
  readonly bind: <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result
}

function captureSync() {
  const fiber = Fiber.getCurrent()
  const instance = fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined
  return { instance }
}

export const bind = <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) => {
  const captured = captureSync()
  return (...args: Args) =>
    Effect.runSync(
      attachWith(
        Effect.sync(() => fn(...args)),
        captured,
      ),
    )
}

// ── Captured Runtime Context Satisfies Deferred Callbacks ───────────
// Callback registration runs inside a fully provisioned runtime, although the
// helper itself has no statically declared service requirements. The captured
// service map is widened only at this boundary so later callback Effects can be
// fully provided without assertions or a second service lookup after handoff.
// ─────────────────────────────────────────────────────────────────────

export function make(): Effect.Effect<Shape> {
  return Effect.gen(function* () {
    const inherited = yield* Effect.context()
    const ctx = Context.makeUnsafe<unknown>(inherited.mapUnsafe)
    const captured = captureSync()
    const instance = (yield* InstanceRef) ?? captured.instance
    const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) => attachWith(effect.pipe(Effect.provide(ctx)), { instance })

    return {
      promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(wrap(effect)),
      fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runFork(wrap(effect)),
      run: <A, E, R>(effect: Effect.Effect<A, E, R>) => wrap(effect),
      bind:
        <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) =>
        (...args: Args) =>
          Effect.runSync(wrap(Effect.sync(() => fn(...args)))),
    } satisfies Shape
  })
}

export * as EffectBridge from "./bridge"
