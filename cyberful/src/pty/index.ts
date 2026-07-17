// ── PTY Session Service ──────────────────────────────────────────
// Owns pseudo-terminal processes, bounded replay buffers, websocket subscribers,
//   resize and input forwarding, lifecycle events, and instance-scoped cleanup.
// → cyberful/src/pty/pty.bun.ts — adapts the native Bun PTY implementation.
// ─────────────────────────────────────────────────────────────────

import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { lazy } from "@/util/lazy"
import { Shell } from "@/shell/shell"
import type { Disp, Proc } from "./pty"
import * as Log from "@/util/log"
import { PtyID } from "./schema"
import { Effect, Layer, Context, Schema, Types } from "effect"
import { NonNegativeInt, PositiveInt } from "@/schema"

const log = Log.create({ service: "pty" })

const BUFFER_LIMIT = 1024 * 1024 * 2
const BUFFER_CHUNK = 64 * 1024
const encoder = new TextEncoder()

type Socket = {
  readyState: number
  send: (data: string | Uint8Array) => void
  close: (code?: number, reason?: string) => void
}

type Active = {
  info: Info
  process: Proc
  buffer: string
  bufferCursor: number
  cursor: number
  subscribers: Set<Socket>
  disposables: Disp[]
  closed: boolean
}

type State = {
  dir: string
  sessions: Map<PtyID, Active>
}

// WebSocket control frame: 0x00 + UTF-8 JSON.
const meta = (cursor: number) => {
  const json = JSON.stringify({ cursor })
  const bytes = encoder.encode(json)
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return out
}

const pty = lazy(() => import("./pty.bun"))

export const Info = Schema.Struct({
  id: PtyID,
  title: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  status: Schema.Literals(["running", "exited"]),
  pid: PositiveInt,
}).annotate({ identifier: "Pty" })

export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const CreateInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  size: Schema.optional(
    Schema.Struct({
      rows: PositiveInt,
      cols: PositiveInt,
    }),
  ),
})

export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export const Event = {
  Created: BusEvent.define("pty.created", Schema.Struct({ info: Info })),
  Updated: BusEvent.define("pty.updated", Schema.Struct({ info: Info })),
  Exited: BusEvent.define("pty.exited", Schema.Struct({ id: PtyID, exitCode: NonNegativeInt })),
  Deleted: BusEvent.define("pty.deleted", Schema.Struct({ id: PtyID })),
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: PtyID) => Effect.Effect<void, NotFoundError>
  readonly connect: (
    id: PtyID,
    ws: Socket,
    cursor?: number,
  ) => Effect.Effect<{ onMessage: (message: string) => void; onClose: () => void } | undefined, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@cyberful/Pty") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bus = yield* Bus.Service

    function closeSubscriber(ws: Socket, id: PtyID, code?: number, reason?: string) {
      try {
        ws.close(code, reason)
      } catch (error) {
        log.debug("failed to close PTY subscriber", { error, id })
      }
    }

    function teardown(session: Active, processExited = false) {
      if (session.closed) return
      session.closed = true
      session.info.status = "exited"
      for (const disposable of session.disposables.splice(0)) {
        try {
          disposable.dispose()
        } catch (error) {
          log.warn("failed to dispose PTY event listener", { error, id: session.info.id })
        }
      }
      if (!processExited) {
        try {
          session.process.kill()
        } catch (error) {
          log.warn("failed to terminate PTY process", { error, id: session.info.id })
        }
      }
      for (const ws of session.subscribers) {
        closeSubscriber(ws, session.info.id, 1001, "PTY session closed")
      }
      session.subscribers.clear()
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Pty.state")(function* (ctx) {
        const state = {
          dir: ctx.directory,
          sessions: new Map<PtyID, Active>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const session of state.sessions.values()) {
              teardown(session)
            }
            state.sessions.clear()
          }),
        )

        return state
      }),
    )

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = (yield* InstanceState.get(state)).sessions.get(id)
      if (!session) return yield* new NotFoundError({ ptyID: id })
      return session
    })

    const removeSession = Effect.fn("Pty.removeSession")(function* (id: PtyID, processExited = false) {
      const s = yield* InstanceState.get(state)
      const session = yield* requireSession(id)
      s.sessions.delete(id)
      if (session.closed) return
      log.info("removing session", { id })
      teardown(session, processExited)
      yield* bus.publish(Event.Deleted, { id: session.info.id })
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      yield* removeSession(id)
    })

    const list = Effect.fn("Pty.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Array.from(s.sessions.values()).map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      return (yield* requireSession(id)).info
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      const s = yield* InstanceState.get(state)
      const bridge = yield* EffectBridge.make()
      const cfg = yield* config.get()
      const id = PtyID.ascending()
      const command = input.command || Shell.preferred(cfg.shell)
      const args = [...(input.args ?? [])]
      if (Shell.login(command)) {
        args.push("-l")
      }

      const cwd = input.cwd || s.dir
      const inheritedEnv = {
        ...process.env,
        ...input.env,
        TERM: "xterm-256color",
        CYBERFUL_TERMINAL: "1",
      }
      const env: Record<string, string> = {}
      for (const [name, value] of Object.entries(inheritedEnv)) {
        if (typeof value === "string") env[name] = value
      }

      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      log.info("creating session", { id, cmd: command, args, cwd })

      const { spawn } = yield* Effect.promise(() => pty())
      const proc = yield* Effect.sync(() =>
        spawn(command, args, {
          name: "xterm-256color",
          cwd,
          env,
        }),
      )

      if (!Number.isSafeInteger(proc.pid) || proc.pid <= 0) {
        try {
          proc.kill()
        } catch (error) {
          log.warn("failed to terminate PTY with invalid process id", { error, pid: proc.pid })
        }
        throw new Error(`PTY returned an invalid process id: ${proc.pid}`)
      }

      const info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid: proc.pid,
      } as const
      const session: Active = {
        info,
        process: proc,
        buffer: "",
        bufferCursor: 0,
        cursor: 0,
        subscribers: new Set(),
        disposables: [],
        closed: false,
      }
      s.sessions.set(id, session)

      // ── Cursor Tracks The Complete Bounded Replay Window ────────
      // Every emitted character advances the absolute cursor before live delivery.
      // The retained suffix is capped independently, and bufferCursor advances by
      // exactly the discarded prefix. Reconnecting clients can therefore request
      // any still-retained position without mistaking truncation for new output.
      // Closed or failed subscribers are removed before the next process chunk.
      // ─────────────────────────────────────────────────────────────────
      session.disposables.push(
        proc.onData((chunk) => {
          session.cursor += chunk.length

          for (const ws of session.subscribers) {
            if (ws.readyState !== 1) {
              session.subscribers.delete(ws)
              continue
            }
            try {
              ws.send(chunk)
            } catch (error) {
              log.debug("failed to send PTY output", { error, id })
              session.subscribers.delete(ws)
            }
          }

          session.buffer += chunk
          if (session.buffer.length <= BUFFER_LIMIT) return
          const excess = session.buffer.length - BUFFER_LIMIT
          session.buffer = session.buffer.slice(excess)
          session.bufferCursor += excess
        }),
      )
      session.disposables.push(
        proc.onExit(({ exitCode }) => {
          if (session.closed || session.info.status === "exited") return
          const normalizedExitCode = Number.isSafeInteger(exitCode) && exitCode >= 0 ? exitCode : 1
          log.info("session exited", { id, exitCode: normalizedExitCode })
          session.info.status = "exited"
          bridge.fork(bus.publish(Event.Exited, { id, exitCode: normalizedExitCode }))
          bridge.fork(removeSession(id, true))
        }),
      )
      yield* bus.publish(Event.Created, { info })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireSession(id)
      if (input.title) {
        session.info.title = input.title
      }
      if (input.size) {
        session.process.resize(input.size.cols, input.size.rows)
      }
      yield* bus.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const connect = Effect.fn("Pty.connect")(function* (id: PtyID, ws: Socket, cursor?: number) {
      const session = yield* requireSession(id).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            closeSubscriber(ws, id)
          }),
        ),
      )
      log.info("client connected to session", { id })

      session.subscribers.add(ws)

      const cleanup = () => {
        session.subscribers.delete(ws)
      }

      const start = session.bufferCursor
      const end = session.cursor
      const from =
        cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

      const data = (() => {
        if (!session.buffer) return ""
        if (from >= end) return ""
        const offset = Math.max(0, from - start)
        if (offset >= session.buffer.length) return ""
        return session.buffer.slice(offset)
      })()

      if (data) {
        try {
          for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
            ws.send(data.slice(i, i + BUFFER_CHUNK))
          }
        } catch (error) {
          log.debug("failed to replay PTY output", { error, id })
          cleanup()
          closeSubscriber(ws, id)
          return
        }
      }

      try {
        ws.send(meta(end))
      } catch (error) {
        log.debug("failed to send PTY cursor metadata", { error, id })
        cleanup()
        closeSubscriber(ws, id)
        return
      }

      return {
        onMessage: (message: string) => {
          if (session.closed) return
          try {
            session.process.write(message)
          } catch (error) {
            log.debug("failed to write PTY input", { error, id })
          }
        },
        onClose: () => {
          log.info("client disconnected from session", { id })
          cleanup()
        },
      }
    })

    return Service.of({ list, get, create, update, remove, connect })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer), Layer.provide(Config.defaultLayer))

export * as Pty from "."
