// ── Configuration Endpoint Handlers ─────────────────────────────
// Reads and updates the active instance configuration, marking the instance for
// disposal after a successful change so later requests rebuild consistent services.
// → cyberful/src/server/routes/instance/httpapi/groups/config.ts — defines the wire contracts.
// ─────────────────────────────────────────────────────────────────

import { Config } from "@/config/config"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { markInstanceForDisposal } from "../lifecycle"

export const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const configSvc = yield* Config.Service

    const get = Effect.fn("ConfigHttpApi.get")(function* () {
      return yield* configSvc.get()
    })

    const update = Effect.fn("ConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return ctx.payload
    })

    return handlers.handle("get", get).handle("update", update)
  }),
)
