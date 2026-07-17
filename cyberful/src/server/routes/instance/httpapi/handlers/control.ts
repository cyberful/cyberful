// ── Process Control Endpoint Handlers ───────────────────────────
// Routes a validated control-plane log request to the named server logger at
// the requested severity and acknowledges successful delivery.
// → cyberful/src/server/routes/instance/httpapi/groups/control.ts — validates the log payload.
// ─────────────────────────────────────────────────────────────────

import * as Log from "@/util/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const logger = Log.create({ service: ctx.payload.service })
      logger[ctx.payload.level](ctx.payload.message, ctx.payload.extra)
      return true
    })

    return handlers.handle("log", log)
  }),
)
