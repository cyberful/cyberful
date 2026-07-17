// ── Post-Response Instance Lifecycle ────────────────────────────
// Lets endpoint handlers request reload or disposal while deferring the action
// until the outer middleware has completed the response through the owning runtime.
// → cyberful/src/server/routes/instance/httpapi/handlers/config.ts — requests disposal after updates.
// ─────────────────────────────────────────────────────────────────

import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { InstanceStore } from "@/project/instance-store"
import * as Log from "@/util/log"
import { Effect } from "effect"
import { HttpEffect, HttpMiddleware, HttpServerRequest } from "effect/unstable/http"

const log = Log.create({ service: "server" })

type MarkedInstance = {
  ctx: InstanceContext
  store: InstanceStore.Interface
  bridge: EffectBridge.Shape
}

// ── Disposal Runs After Response Production ─────────────────────
// An endpoint may invalidate the instance that is currently producing its response,
// so teardown cannot run inside that handler. The pre-response hook records intent
// under the original Request object, which remains the stable identity visible to
// outer middleware. After the response exists, middleware consumes the marker once
// and performs uninterruptible disposal through the owning Effect bridge.
// ─────────────────────────────────────────────────────────────────
const disposeAfterResponse = new WeakMap<object, MarkedInstance>()

const mark = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    return { ctx, store: yield* InstanceStore.Service, bridge: yield* EffectBridge.make() }
  })

export const markInstanceForDisposal = (ctx: InstanceContext) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((request, response) =>
      Effect.sync(() => {
        // The response is sent before disposeMiddleware performs the teardown.
        disposeAfterResponse.set(request.source, marked)
        return response
      }),
    )
  })

export const markInstanceForReload = (ctx: InstanceContext, next: InstanceStore.LoadInput) =>
  Effect.gen(function* () {
    const marked = yield* mark(ctx)
    return yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.as(Effect.uninterruptible(marked.bridge.run(marked.store.reload(next))), response),
    )
  })

export const disposeMiddleware: HttpMiddleware.HttpMiddleware = (effect) =>
  Effect.gen(function* () {
    const response = yield* effect
    const request = yield* HttpServerRequest.HttpServerRequest
    const marked = disposeAfterResponse.get(request.source)
    if (!marked) return response
    disposeAfterResponse.delete(request.source)
    yield* Effect.uninterruptible(marked.bridge.run(marked.store.dispose(marked.ctx))).pipe(
      Effect.catchCause((cause) => Effect.sync(() => log.warn("instance disposal failed", { cause }))),
    )
    return response
  })
