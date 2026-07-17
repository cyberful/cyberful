// ── Safe Schema Rejection Responses ─────────────────────────────
// Converts decoder failures into bounded public 400 responses so rejected input,
// including possible secrets, cannot be mirrored wholesale into responses or logs.
// → cyberful/src/server/routes/instance/httpapi/errors.ts — defines the typed invalid-request error.
// ─────────────────────────────────────────────────────────────────

import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import * as Log from "@/util/log"
import { InvalidRequestError } from "../errors"

const log = Log.create({ service: "server" })

// ── Schema Errors Never Reflect Complete Input ──────────────────
// Effect's issue formatter recursively includes the rejected actual value and
// can amplify a small invalid payload into a much larger diagnostic. That value
// may also contain credentials or request bodies. The HTTP boundary therefore
// caps the rendered reason before it enters either the public 400 response or
// local logs, while retaining the decoder's failure kind.
// ─────────────────────────────────────────────────────────────────
const REASON_LIMIT = 1024
function truncateReason(reason: string) {
  if (reason.length <= REASON_LIMIT) return reason
  return reason.slice(0, REASON_LIMIT) + `… (${reason.length - REASON_LIMIT} more chars)`
}

// Default Respondable returns an empty 400 body. Match the NamedError shape
// used by other 4xx/5xx so the control-plane client extracts `.data.message`.
export class SchemaErrorMiddleware extends HttpApiMiddleware.Service<SchemaErrorMiddleware>()(
  "@cyberful/HttpApiSchemaError",
  {
    error: InvalidRequestError,
  },
) {}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error, context) => {
  const reason = truncateReason(error.cause.message)
  log.warn("schema rejection", { kind: error.kind, reason })
  if (context.endpoint.path.startsWith("/api/")) {
    return Effect.fail(
      new InvalidRequestError({
        message: reason,
        kind: error.kind,
      }),
    )
  }
  return Effect.succeed(
    HttpServerResponse.jsonUnsafe({ name: "BadRequest", data: { message: reason, kind: error.kind } }, { status: 400 }),
  )
})
