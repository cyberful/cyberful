// ── Terminal UI Control Handlers ────────────────────────────────
// Dispatches validated TUI events and command aliases, updates the active
// prompt composer, and selects sessions through the instance-scoped API.
// → cyberful/src/bus/index.ts — delivers commands to the active terminal UI.
// ─────────────────────────────────────────────────────────────────

import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { CommandPayload, TuiPublishPayload } from "../groups/tui"
import * as SessionError from "./session-errors"

const commandAliases = {
  session_new: "session.new",
  session_interrupt: "session.interrupt",
  messages_page_up: "session.page.up",
  messages_page_down: "session.page.down",
  messages_line_up: "session.line.up",
  messages_line_down: "session.line.down",
  messages_half_page_up: "session.half.page.up",
  messages_half_page_down: "session.half.page.down",
  messages_first: "session.first",
  messages_last: "session.last",
  agent_cycle: "agent.cycle",
} as const

function isCommandAlias(command: string): command is keyof typeof commandAliases {
  return Object.hasOwn(commandAliases, command)
}

export const tuiHandlers = HttpApiBuilder.group(InstanceHttpApi, "tui", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const session = yield* Session.Service
    const publishCommand = (command: typeof TuiEvent.CommandExecute.properties.Type.command) => {
      const properties: typeof TuiEvent.CommandExecute.properties.Type = { command }
      return bus.publish(TuiEvent.CommandExecute, properties)
    }

    const appendPrompt = Effect.fn("TuiHttpApi.appendPrompt")(function* (ctx: {
      payload: typeof TuiEvent.PromptAppend.properties.Type
    }) {
      yield* bus.publish(TuiEvent.PromptAppend, ctx.payload)
      return true
    })

    const openHelp = Effect.fn("TuiHttpApi.openHelp")(function* () {
      yield* publishCommand("help.show")
      return true
    })

    const openSessions = Effect.fn("TuiHttpApi.openSessions")(function* () {
      yield* publishCommand("session.list")
      return true
    })

    const submitPrompt = Effect.fn("TuiHttpApi.submitPrompt")(function* () {
      yield* publishCommand("prompt.submit")
      return true
    })

    const clearPrompt = Effect.fn("TuiHttpApi.clearPrompt")(function* () {
      yield* publishCommand("prompt.clear")
      return true
    })

    const executeCommand = Effect.fn("TuiHttpApi.executeCommand")(function* (ctx: {
      payload: typeof CommandPayload.Type
    }) {
      // ── Legacy Commands Remain Allowlisted And Best-Effort ────────
      // Older clients submit stable underscore aliases rather than current
      // keymap command names. Only the explicit table above may cross onto the
      // TUI bus; arbitrary input never becomes a command. Unknown aliases keep
      // the legacy successful no-op response so client compatibility does not
      // expand the executable command surface.
      // ────────────────────────────────────────────────────────────────
      if (isCommandAlias(ctx.payload.command)) yield* publishCommand(commandAliases[ctx.payload.command])
      return true
    })

    const showToast = Effect.fn("TuiHttpApi.showToast")(function* (ctx: {
      payload: typeof TuiEvent.ToastShow.properties.Type
    }) {
      yield* bus.publish(TuiEvent.ToastShow, ctx.payload)
      return true
    })

    const publish = Effect.fn("TuiHttpApi.publish")(function* (ctx: { payload: typeof TuiPublishPayload.Type }) {
      if (ctx.payload.type === TuiEvent.PromptAppend.type)
        yield* bus.publish(TuiEvent.PromptAppend, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.CommandExecute.type)
        yield* bus.publish(TuiEvent.CommandExecute, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.ToastShow.type) yield* bus.publish(TuiEvent.ToastShow, ctx.payload.properties)
      if (ctx.payload.type === TuiEvent.SessionSelect.type)
        yield* bus.publish(TuiEvent.SessionSelect, ctx.payload.properties)
      return true
    })

    const selectSession = Effect.fn("TuiHttpApi.selectSession")(function* (ctx: {
      payload: typeof TuiEvent.SessionSelect.properties.Type
    }) {
      if (!ctx.payload.sessionID.startsWith("ses")) return yield* new HttpApiError.BadRequest({})
      yield* SessionError.mapStorageNotFound(session.get(ctx.payload.sessionID))
      yield* bus.publish(TuiEvent.SessionSelect, ctx.payload)
      return true
    })

    return handlers
      .handle("appendPrompt", appendPrompt)
      .handle("openHelp", openHelp)
      .handle("openSessions", openSessions)
      .handle("submitPrompt", submitPrompt)
      .handle("clearPrompt", clearPrompt)
      .handle("executeCommand", executeCommand)
      .handle("showToast", showToast)
      .handle("publish", publish)
      .handle("selectSession", selectSession)
  }),
)
