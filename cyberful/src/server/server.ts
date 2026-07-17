// ── Loopback Control-Plane Server Lifecycle ─────────────────────
// Builds the Effect HTTP application, opens loopback listeners, and closes
// active WebSockets, the listener, and its scope through one idempotent owner.
// → cyberful/src/server/routes/instance/httpapi/server.ts — assembles the route layers.
// ─────────────────────────────────────────────────────────────────

import "./init-projectors"

import { NodeHttpServer } from "@effect/platform-node"
import { Cause, ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { OpenApi } from "effect/unstable/httpapi"
import { createServer } from "node:http"
import { HttpApiApp } from "./routes/instance/httpapi/server"
import { disposeMiddleware } from "./routes/instance/httpapi/lifecycle"
import { WebSocketTracker } from "./routes/instance/httpapi/websocket-tracker"
import { PublicApi } from "./routes/instance/httpapi/public"
import { lazy } from "@/util/lazy"

const HOSTNAME = "127.0.0.1"

export type Listener = {
  hostname: string
  port: number
  url: URL
  stop: (close?: boolean) => Promise<void>
}

type ServerApp = {
  fetch(request: Request): Response | Promise<Response>
  request(input: string | URL | Request, init?: RequestInit): Response | Promise<Response>
}

type ListenOptions = {
  port: number
}
type ListenerState = {
  scope: Scope.Scope
  server: Context.Service.Shape<typeof HttpServer.HttpServer>
  http: ListenerServer
  websockets: WebSocketTracker.Interface
}
type EffectListener = Omit<Listener, "stop"> & {
  stop: (close?: boolean) => Effect.Effect<void>
}

interface ListenerServer {
  readonly closeAll: Effect.Effect<void>
}

class ListenerServerService extends Context.Service<ListenerServerService, ListenerServer>()(
  "@cyberful/ListenerServer",
) {}

export const Default = lazy(() => {
  const handler = HttpApiApp.webHandler().handler
  const app: ServerApp = {
    fetch: (request: Request) => handler(request, HttpApiApp.context),
    request(input, init) {
      return app.fetch(input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init))
    },
  }
  return { app }
})

export async function openapi() {
  return OpenApi.fromApi(PublicApi)
}

export async function listen(opts: ListenOptions): Promise<Listener> {
  const listener = await Effect.runPromise(listenEffect(opts))
  return {
    hostname: listener.hostname,
    port: listener.port,
    url: listener.url,
    stop: (close?: boolean) => Effect.runPromise(listener.stop(close)),
  }
}

const listenEffect: (opts: ListenOptions) => Effect.Effect<EffectListener, unknown> = Effect.fn("Server.listen")(
  function* (opts: ListenOptions) {
    const state = yield* startWithPortFallback(opts)
    const address = yield* tcpAddress(state)
    const listenerUrl = makeURL(address.port)
    return {
      hostname: HOSTNAME,
      port: address.port,
      url: listenerUrl,
      stop: yield* makeStop(state),
    }
  },
)

function listenerLayer(port: number) {
  return HttpRouter.serve(HttpApiApp.createRoutes(), {
    middleware: disposeMiddleware,
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(WebSocketTracker.layer),
    Layer.provideMerge(serverLayer({ port })),
    // ── Each Listener Reads Current Process Configuration ────────
    // Effect's default ConfigProvider snapshots process.env on first access and
    // retains it in a module-level reference. Tests and embedded callers may open
    // more than one listener after changing explicit server configuration. A fresh
    // provider per listener makes those reads belong to that listener's creation
    // boundary instead of the first server ever opened in the process.
    // ─────────────────────────────────────────────────────────────
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv())),
  )
}

function startWithPortFallback(opts: ListenOptions) {
  if (opts.port !== 0) return startListener(opts.port)
  // Match the legacy listener port-resolution behavior: explicit `0` prefers
  // 4096 first, then any free port.
  return startListener(4096).pipe(Effect.catchIf(isAddressInUse, () => startListener(0)))
}

function isAddressInUse(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  if ("reason" in error && error.reason === "AddressInUse") return true
  return "cause" in error && isAddressInUse(error.cause)
}

function startListener(port: number) {
  const scope = Scope.makeUnsafe()
  return Layer.buildWithMemoMap(listenerLayer(port), Layer.makeMemoMapUnsafe(), scope).pipe(
    Effect.provide(HttpApiApp.context),
    Effect.onError(() => Scope.close(scope, Exit.void)),
    Effect.map(
      (ctx): ListenerState => ({
        scope,
        server: Context.get(ctx, HttpServer.HttpServer),
        http: Context.get(ctx, ListenerServerService),
        websockets: Context.get(ctx, WebSocketTracker.Service),
      }),
    ),
  )
}

function tcpAddress(state: ListenerState) {
  return Effect.gen(function* () {
    if (state.server.address._tag === "TcpAddress") return state.server.address
    const addressError = new Error(`Unexpected HttpServer address tag: ${state.server.address._tag}`)
    const cleanup = yield* Scope.close(state.scope, Exit.void).pipe(Effect.exit)
    if (Exit.isFailure(cleanup)) {
      return yield* Effect.failCause(Cause.combine(Cause.die(addressError), cleanup.cause))
    }
    return yield* Effect.die(addressError)
  })
}

function makeURL(port: number) {
  const result = new URL("http://localhost")
  result.hostname = HOSTNAME
  result.port = String(port)
  return result
}

function makeStop(state: ListenerState) {
  return Effect.gen(function* () {
    const forceCloseOnce = yield* Effect.cached(forceClose(state))
    const closeScopeOnce = yield* Effect.cached(Scope.close(state.scope, Exit.void))

    return (close?: boolean) =>
      Effect.gen(function* () {
        if (close) yield* forceCloseOnce
        yield* closeScopeOnce
      })
  })
}

function forceClose(state: ListenerState) {
  return Effect.all([state.http.closeAll, state.websockets.closeAll], { concurrency: 2, discard: true })
}

function serverLayer(opts: { port: number }) {
  const server = createServer()
  const serverRef = { closeStarted: false, forceStop: false }
  const close = server.close.bind(server)
  // Keep shutdown owned by NodeHttpServer, but honor listener.stop(true) by
  // force-closing active HTTP sockets when its finalizer calls server.close().
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Node's overloads don't preserve a monkey-patched method assignment.
  server.close = ((callback?: Parameters<typeof server.close>[0]) => {
    serverRef.closeStarted = true
    const result = close(callback)
    if (serverRef.forceStop) server.closeAllConnections()
    return result
  }) as typeof server.close

  return Layer.mergeAll(
    NodeHttpServer.layer(() => server, { port: opts.port, host: HOSTNAME, gracefulShutdownTimeout: "1 second" }),
    Layer.succeed(ListenerServerService)(
      ListenerServerService.of({
        closeAll: Effect.sync(() => {
          serverRef.forceStop = true
          if (serverRef.closeStarted) server.closeAllConnections()
        }),
      }),
    ),
  )
}

export * as Server from "./server"
