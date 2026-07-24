// ── Session Prompt Inputs ────────────────────────────────────────
// Defines the wire-visible schemas accepted by prompt, command, loop, and
//   user-shell entry points independently from the orchestration runtime.
// ─────────────────────────────────────────────────────────────────

import { Schema } from "effect"
import { MessageV2 } from "./message-v2"
import { MessageID, SessionID } from "./schema"

export const Delivery = Schema.Literals(["immediate", "deferred"]).annotate({ identifier: "Session.Delivery" })
export type Delivery = Schema.Schema.Type<typeof Delivery>

export const PromptInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.optional(Schema.String),
  delivery: Schema.optional(Delivery),
  noReply: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.String),
  workarea: Schema.optional(Schema.String),
  parts: Schema.Array(
    Schema.Union([MessageV2.TextPartInput, MessageV2.FilePartInput]).annotate({ discriminator: "type" }),
  ),
})
export type PromptInput = Schema.Schema.Type<typeof PromptInput>

export class LoopInput extends Schema.Class<LoopInput>("SessionPrompt.LoopInput")({ sessionID: SessionID }) {}

export const ShellInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
  agent: Schema.String,
  command: Schema.String,
})
export type ShellInput = Schema.Schema.Type<typeof ShellInput>

export const CommandInput = Schema.Struct({
  messageID: Schema.optional(MessageID),
  sessionID: SessionID,
  agent: Schema.optional(Schema.String),
  delivery: Schema.optional(Delivery),
  arguments: Schema.String,
  command: Schema.String,
  system: Schema.optional(Schema.String),
  workarea: Schema.optional(Schema.String),
  parts: Schema.optional(Schema.Array(MessageV2.FilePartInput)),
})
export type CommandInput = Schema.Schema.Type<typeof CommandInput>
