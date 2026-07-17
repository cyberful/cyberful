// ── Control-Plane Route Layer Assembly ──────────────────────────
// Wires public endpoint contracts to instance services, middleware, SSE handlers,
// and ticketed PTY sockets as the HTTP application consumed by server listeners.
// → cyberful/src/server/server.ts — owns listener and scope lifetime.
// ─────────────────────────────────────────────────────────────────

import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import { HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import { HttpMiddleware, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { AppFileSystem } from "@/effect/filesystem"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Command } from "@/command"
import * as Observability from "@/effect/observability"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Ripgrep } from "@/file/ripgrep"
import { Format } from "@/format"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceLayer } from "@/project/instance-layer"
import { Project } from "@/project/project"
import { Pty } from "@/pty"
import { PtyTicket } from "@/pty/ticket"
import { Question } from "@/question"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { SessionVariable } from "@/session/variable"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Skill } from "@/skill"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "@/sync"
import { lazy } from "@/util/lazy"
import { Vcs } from "@/project/vcs"
import { isAllowedCorsOrigin } from "@/server/cors"
import { ServerAuth } from "@/server/auth"
import { InstanceHttpApi, RootHttpApi } from "./api"
import { PublicApi } from "./public"
import { authorizationLayer, authorizationRouterMiddleware } from "./middleware/authorization"
import { EventApi } from "./groups/event"
import { eventHandlers } from "./handlers/event"
import { configHandlers } from "./handlers/config"
import { controlHandlers } from "./handlers/control"
import { fileHandlers } from "./handlers/file"
import { globalHandlers } from "./handlers/global"
import { instanceHandlers } from "./handlers/instance"
import { projectHandlers } from "./handlers/project"
import { ptyConnectRoute, ptyHandlers } from "./handlers/pty"
import { questionHandlers } from "./handlers/question"
import { sessionHandlers } from "./handlers/session"
import { tuiHandlers } from "./handlers/tui"
import { instanceContextLayer, instanceRouterMiddleware } from "./middleware/instance-context"
import { directoryRouterMiddleware, directoryRoutingLayer } from "./middleware/directory-routing"
import { disposeMiddleware } from "./lifecycle"
import { memoMap } from "@/effect/memo-map"
import { compressionLayer } from "./middleware/compression"
import { corsVaryFix } from "./middleware/cors-vary"
import { errorLayer } from "./middleware/error"
import { schemaErrorLayer } from "./middleware/schema-error"

export const context = Context.makeUnsafe<unknown>(new Map())

const cors = HttpRouter.middleware(
  HttpMiddleware.cors({
    allowedOrigins: isAllowedCorsOrigin,
    maxAge: 86_400,
  }),
  { global: true },
)

// ── Route Families Own Distinct Middleware Boundaries ───────────
// Root schema routes declare authentication on RootHttpApi and need no instance.
// Raw event and PTY socket routes apply authentication and directory selection at
// router level because they bypass typed endpoint middleware. Instance schema
// routes declare authentication per group, then receive directory and instance
// services from the composed layer below.
// ─────────────────────────────────────────────────────────────────
const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const httpApiAuthLayer = authorizationLayer.pipe(Layer.provide(ServerAuth.Config.defaultLayer))
const rootApiRoutes = HttpApiBuilder.layer(RootHttpApi).pipe(
  Layer.provide([controlHandlers, globalHandlers]),
  Layer.provide(schemaErrorLayer),
  Layer.provide(httpApiAuthLayer),
)
const instanceRouterLayer = authorizationRouterMiddleware
  .combine(instanceRouterMiddleware)
  .combine(directoryRouterMiddleware)
  .layer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal), Layer.provide(ServerAuth.Config.defaultLayer))
const eventApiRoutes = HttpApiBuilder.layer(EventApi).pipe(
  Layer.provide(eventHandlers),
  Layer.provide(instanceRouterLayer),
)
const instanceApiRoutes = HttpApiBuilder.layer(InstanceHttpApi).pipe(
  Layer.provide([
    configHandlers,
    fileHandlers,
    instanceHandlers,
    projectHandlers,
    ptyHandlers,
    questionHandlers,
    sessionHandlers,
    tuiHandlers,
  ]),
)

const rawInstanceRoutes = Layer.mergeAll(ptyConnectRoute).pipe(Layer.provide(instanceRouterLayer))
const instanceRoutes = Layer.mergeAll(rawInstanceRoutes, instanceApiRoutes).pipe(
  Layer.provide([httpApiAuthLayer, directoryRoutingLayer, instanceContextLayer, schemaErrorLayer]),
)

// ── OpenAPI Serialization Is Lazy And Process-Stable ────────────
// Building the specification is non-trivial and most CLI processes never request
// it, so module loading must not pay that cost. The first /doc request constructs
// the public document and jsonUnsafe eagerly serializes it. Caching that response
// preserves one process-stable document and reuses its bytes for later requests
// instead of regenerating and re-stringifying the schema.
// ─────────────────────────────────────────────────────────────────
const docResponse = lazy(() => HttpServerResponse.jsonUnsafe(OpenApi.fromApi(PublicApi)))

const docRoute = HttpRouter.use((router) => router.add("GET", "/doc", () => Effect.succeed(docResponse()))).pipe(
  Layer.provide(authOnlyRouterLayer),
)

type RouteRequirements =
  | HttpRouter.HttpRouter
  | HttpRouter.Request<"Error", unknown>
  | HttpRouter.Request<"GlobalError", unknown>
  | HttpRouter.Request<"Requires", unknown>
  | HttpRouter.Request<"GlobalRequires", never>

export function createRoutes(): Layer.Layer<never, EffectConfig.ConfigError, RouteRequirements> {
  const routeCoreLayer = Layer.mergeAll(
    errorLayer,
    compressionLayer,
    corsVaryFix,
    cors,
    Agent.defaultLayer,
    Command.defaultLayer,
    Config.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Format.defaultLayer,
    Project.defaultLayer,
  )
  const routeSessionLayer = Layer.mergeAll(
    Pty.defaultLayer,
    PtyTicket.defaultLayer,
    Question.defaultLayer,
    Ripgrep.defaultLayer,
    RuntimeFlags.defaultLayer,
    Session.defaultLayer,
    SessionPrompt.defaultLayer,
    SessionRevert.defaultLayer,
    SessionRunState.defaultLayer,
    SessionStatus.defaultLayer,
    SessionSummary.defaultLayer,
    Snapshot.defaultLayer,
    SyncEvent.defaultLayer,
    EventV2Bridge.defaultLayer,
    Skill.defaultLayer,
  )
  const routePlatformLayer = Layer.mergeAll(
    Todo.defaultLayer,
    SessionVariable.defaultLayer,
    Vcs.defaultLayer,
    Bus.layer,
    AppFileSystem.defaultLayer,
    HttpServer.layerServices,
  )

  return Layer.mergeAll(rootApiRoutes, eventApiRoutes, instanceRoutes, docRoute).pipe(
    Layer.provide(Layer.mergeAll(routeCoreLayer, routeSessionLayer, routePlatformLayer)),
    Layer.provide(InstanceLayer.layer),
    Layer.provide(Observability.layer),
  )
}

export const routes = createRoutes()

export const webHandler = lazy(() =>
  HttpRouter.toWebHandler(routes, {
    disableLogger: true,
    memoMap,
    middleware: disposeMiddleware,
  }),
)

export * as HttpApiApp from "./server"
