// ── Local Directory Routing Context ─────────────────────────────
// Normalizes a query or header directory into request-local context and supplies
// it to both typed API handlers and router-level WebSocket operations.
// → cyberful/src/server/routes/instance/httpapi/middleware/instance-context.ts — loads the routed instance.
// ─────────────────────────────────────────────────────────────────

import { Context, Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

// Instance APIs may target another local directory when a CLI attaches to the
// loopback server. No workspace selection or remote proxying is involved.
export const DirectoryRoutingQueryFields = {
  directory: Schema.optional(Schema.String),
}

export const DirectoryRoutingQuery = Schema.Struct(DirectoryRoutingQueryFields)

export class DirectoryRouteContext extends Context.Service<
  DirectoryRouteContext,
  {
    readonly directory: string
  }
>()("@cyberful/HttpApiDirectoryRouteContext") {}

export class DirectoryRoutingMiddleware extends HttpApiMiddleware.Service<
  DirectoryRoutingMiddleware,
  {
    provides: DirectoryRouteContext
  }
>()("@cyberful/HttpApiDirectoryRouting") {}

function directory(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  return url.searchParams.get("directory") || request.headers["x-cyberful-directory"] || process.cwd()
}

function route<E>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, DirectoryRouteContext>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, E, HttpServerRequest.HttpServerRequest> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    return yield* effect.pipe(
      Effect.provideService(DirectoryRouteContext, DirectoryRouteContext.of({ directory: directory(request) })),
    )
  })
}

export const directoryRoutingLayer = Layer.succeed(DirectoryRoutingMiddleware)(
  DirectoryRoutingMiddleware.of((effect) => route(effect)),
)

export const directoryRouterMiddleware = HttpRouter.middleware<{ provides: DirectoryRouteContext }>()(
  Effect.succeed((effect) => route(effect)),
)
