// ── Interactive Session Event Reducer ────────────────────────────
// Reduces control-plane events into append-only scrollback commits and footer
//   changes. It buffers text until assistant ownership is known, strips a
//   completed shell echo once, and queues blocking questions without doing I/O.
// → cyberful/src/cli/cmd/run/stream.transport.ts — supplies ordered session events.
// ─────────────────────────────────────────────────────────────────

import type { Event, QuestionRequest, ToolPart } from "@/server/client"
import * as Locale from "@/util/locale"
import {
  assistantDisplayTimeLine,
  formatAssistantTimestamp,
  splitAssistantTimeLine,
} from "@/session/assistant-timestamp"
import { toolView } from "./tool"
import type { FooterOutput, FooterPatch, FooterView, StreamCommit, StreamMode } from "./types"
import { toolDisplaySummary } from "../tool-display"
import { isRecord } from "@/util/record"

type Tokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

type PartKind = "assistant" | "reasoning" | "user"
type MessageRole = "assistant" | "user"
type SessionCommit = StreamCommit

// ── Reducer State Makes Streaming Idempotent ─────────────────────
// Control-plane deltas may precede role metadata or be delivered again. The
// accumulator therefore owns committed identities, part-to-message roles, full
// text plus sent offsets, completion markers, and pending tool starts. Separate
// shell-source and one-use echo state prevent duplicate command output. No state
// escapes the reducer, so replay and live delivery apply the same transitions.
// ─────────────────────────────────────────────────────────────────
type ShellCall = {
  source: "shell" | "tool"
  command?: string
}

export type SessionData = {
  includeUserText: boolean
  announced: boolean
  ids: Set<string>
  tools: Set<string>
  shell: Map<string, ShellCall>
  questions: QuestionRequest[]
  role: Map<string, MessageRole>
  msg: Map<string, string>
  part: Map<string, PartKind>
  text: Map<string, string>
  sent: Map<string, number>
  end: Set<string>
  assistantText: Set<string>
  echo: Map<string, Set<string>>
}

export type SessionDataInput = {
  data: SessionData
  event: Event
  sessionID: string
  thinking: boolean
  limits: Record<string, number>
}

export type SessionDataOutput = {
  data: SessionData
  commits: SessionCommit[]
  footer?: FooterOutput
}

export function createSessionData(
  input: {
    includeUserText?: boolean
  } = {},
): SessionData {
  return {
    includeUserText: input.includeUserText ?? false,
    announced: false,
    ids: new Set(),
    tools: new Set(),
    shell: new Map(),
    questions: [],
    role: new Map(),
    msg: new Map(),
    part: new Map(),
    text: new Map(),
    sent: new Map(),
    end: new Set(),
    assistantText: new Set(),
    echo: new Map(),
  }
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

function formatUsage(tokens: Tokens | undefined, limit: number | undefined): string | undefined {
  const total =
    (tokens?.input ?? 0) +
    (tokens?.output ?? 0) +
    (tokens?.reasoning ?? 0) +
    (tokens?.cache?.read ?? 0) +
    (tokens?.cache?.write ?? 0)

  if (total <= 0) {
    return undefined
  }

  return limit && limit > 0 ? `${Locale.number(total)} (${Math.round((total / limit) * 100)}%)` : Locale.number(total)
}

export function formatError(error: {
  name?: string
  message?: string
  data?: {
    message?: string
  }
}): string {
  if (error.data?.message) {
    return error.data.message
  }

  if (error.message) {
    return error.message
  }

  if (error.name) {
    return error.name
  }

  return "unknown error"
}

function isAbort(error: { name?: string } | undefined): boolean {
  return error?.name === "MessageAbortedError"
}

function msgErr(id: string): string {
  return `msg:${id}:error`
}

function msgTimestamp(id: string): string {
  return `msg:${id}:timestamp`
}

function isFinalAssistant(info: Extract<Event, { type: "message.updated" }>["properties"]["info"]): boolean {
  return (
    info.role === "assistant" &&
    !info.error &&
    info.time.completed !== undefined &&
    info.finish !== undefined &&
    !["tool-calls", "unknown"].includes(info.finish)
  )
}

function timestampCommit(messageID: string, timestamp: number | string): SessionCommit {
  return {
    kind: "assistant",
    text: assistantDisplayTimeLine(typeof timestamp === "number" ? formatAssistantTimestamp(timestamp) : timestamp),
    phase: "final",
    source: "assistant",
    messageID,
    timestamp: true,
  }
}

function patch(patch?: FooterPatch, view?: FooterView): FooterOutput | undefined {
  if (!patch && !view) {
    return undefined
  }

  return {
    patch,
    view,
  }
}

function out(data: SessionData, commits: SessionCommit[], footer?: FooterOutput): SessionDataOutput {
  if (!footer) {
    return {
      data,
      commits,
    }
  }

  return {
    data,
    commits,
    footer,
  }
}

export function pickBlockerView(input: { question?: QuestionRequest }): FooterView {
  if (input.question) {
    return { type: "question", request: input.question }
  }

  return { type: "prompt" }
}

export function blockerStatus(view: FooterView) {
  if (view.type === "question") {
    return "awaiting answer"
  }

  return ""
}

function pickSessionView(data: SessionData): FooterView {
  return pickBlockerView({
    question: data.questions[0],
  })
}

function queueFooter(data: SessionData): FooterOutput {
  const view = pickSessionView(data)

  return {
    view,
    patch: { status: blockerStatus(view) },
  }
}

function queueOut(data: SessionData, commits: SessionCommit[]): SessionDataOutput {
  return out(data, commits, queueFooter(data))
}

function upsert<T extends { id: string }>(list: T[], item: T) {
  const idx = list.findIndex((entry) => entry.id === item.id)
  if (idx === -1) {
    list.push(item)
    return
  }

  list[idx] = item
}

function remove(list: Array<{ id: string }>, id: string): boolean {
  const idx = list.findIndex((entry) => entry.id === id)
  if (idx === -1) {
    return false
  }

  list.splice(idx, 1)
  return true
}

export function bootstrapSessionData(input: { data: SessionData; questions: QuestionRequest[] }) {
  for (const request of input.questions.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    upsert(input.data.questions, request)
  }
}

// Question tool replies can complete without a matching question.replied event.
// When that happens, drop the recovered pending request tied to this tool call so
// the footer can return to the next blocker or to the prompt.
function syncQuestion(data: SessionData, part: ToolPart): FooterOutput | undefined {
  if (part.tool !== "question") {
    return undefined
  }

  if (part.state.status !== "completed" && part.state.status !== "error") {
    return undefined
  }

  const next = data.questions.filter(
    (request) => request.tool?.messageID !== part.messageID || request.tool?.callID !== part.callID,
  )
  if (next.length === data.questions.length) {
    return undefined
  }

  data.questions = next
  return queueFooter(data)
}

function toolStatus(part: ToolPart): string {
  if (part.tool !== "task") {
    return `Executing ${toolDisplaySummary(part.tool, part.state.input)}`
  }

  const input = part.state.input
  if (!isRecord(input)) return "Sub-agent running"
  const desc = input.description
  if (typeof desc === "string" && desc.trim()) {
    return `Sub-agent running: ${desc.trim()}`
  }

  const type = input.subagent_type
  if (typeof type === "string" && type.trim()) {
    return `Sub-agent running: ${Locale.titlecase(type.trim())}`
  }

  return "Sub-agent running"
}

// ── Unknown Message Roles Keep Text Buffered ─────────────────────
// User and assistant messages share text-part events, and deltas can arrive
// before their `message.updated` role. Flushing an unknown role would echo user
// input into assistant output. The reducer therefore retains those bytes until
// role metadata arrives; confirmed user text is dropped unless replay requested it.
// ─────────────────────────────────────────────────────────────────
function ready(data: SessionData, partID: string): boolean {
  const msg = data.msg.get(partID)
  if (!msg) {
    return true
  }

  const role = data.role.get(msg)
  if (!role) {
    return false
  }

  if (role === "assistant") {
    return true
  }

  return data.includeUserText && role === "user"
}

function syncText(data: SessionData, partID: string, next: string) {
  const prev = data.text.get(partID) ?? ""
  if (!next) {
    return prev
  }

  if (!prev || next.length >= prev.length) {
    data.text.set(partID, next)
    return next
  }

  return prev
}

// Records bash tool output for echo stripping. Some models echo bash output
// verbatim at the start of their next text part. We save both the raw and
// trimmed forms so stripEcho() can match either.
function stashEcho(data: SessionData, part: ToolPart) {
  if (part.tool !== "bash") {
    return
  }

  if (typeof part.messageID !== "string" || !part.messageID) {
    return
  }

  const output = "output" in part.state ? part.state.output : undefined
  if (typeof output !== "string") {
    return
  }

  const text = output.replace(/^\n+/, "")
  if (!text.trim()) {
    return
  }

  const set = data.echo.get(part.messageID) ?? new Set<string>()
  set.add(text)
  const trim = text.replace(/\n+$/, "")
  if (trim && trim !== text) {
    set.add(trim)
  }
  data.echo.set(part.messageID, set)
}

function stripEcho(data: SessionData, msg: string | undefined, chunk: string): string {
  if (!msg) {
    return chunk
  }

  const set = data.echo.get(msg)
  if (!set || set.size === 0) {
    return chunk
  }

  data.echo.delete(msg)
  const list = [...set].sort((a, b) => b.length - a.length)
  for (const item of list) {
    if (!item || !chunk.startsWith(item)) {
      continue
    }

    return chunk.slice(item.length).replace(/^\n+/, "")
  }

  return chunk
}

function flushPart(
  data: SessionData,
  commits: SessionCommit[],
  partID: string,
  interrupted = false,
  mode: StreamMode = "append",
) {
  const kind = data.part.get(partID)
  if (!kind) {
    return
  }

  const text = data.text.get(partID) ?? ""
  const sent = data.sent.get(partID) ?? 0
  let chunk = mode === "replace" ? text : text.slice(sent)
  const msg = data.msg.get(partID)

  if (mode === "replace" || sent === 0) {
    chunk = chunk.replace(/^\n+/, "")
    // Some models emit a standalone whitespace token before real content.
    // Keep buffering until we have visible text so scrollback doesn't get a blank row.
    if (!chunk.trim()) {
      return
    }
    if (kind === "reasoning" && chunk) {
      chunk = `Thinking: ${chunk.replace(/\[REDACTED\]/g, "")}`
    }
    if (kind === "assistant" && chunk) {
      chunk = stripEcho(data, msg, chunk)
      if (!chunk.trim()) {
        return
      }
    }
  }

  if (chunk) {
    data.sent.set(partID, text.length)
    if (kind === "assistant" && msg) {
      const timed = splitAssistantTimeLine(chunk)
      data.assistantText.add(msg)
      if (timed.timestamp) {
        if (timed.text.trim()) {
          commits.push({
            kind,
            text: timed.text,
            phase: "progress",
            ...(mode === "replace" ? { mode } : {}),
            source: "assistant",
            messageID: msg,
            partID,
          })
        }
        if (!data.ids.has(msgTimestamp(msg))) {
          data.ids.add(msgTimestamp(msg))
          commits.push(timestampCommit(msg, timed.timestamp))
        }
        return
      }
    }
    commits.push({
      kind,
      text: chunk,
      phase: "progress",
      ...(mode === "replace" ? { mode } : {}),
      source: kind === "user" ? "system" : kind,
      messageID: msg,
      partID,
    })
  }

  if (!interrupted) {
    return
  }

  commits.push({
    kind,
    text: "",
    phase: "final",
    source: kind === "user" ? "system" : kind,
    messageID: msg,
    partID,
    interrupted: true,
  })
}

function drop(data: SessionData, partID: string) {
  data.part.delete(partID)
  data.text.delete(partID)
  data.sent.delete(partID)
  data.msg.delete(partID)
  data.end.delete(partID)
}

// Called when we learn a message's role (from message.updated). Flushes any
// buffered text parts that were waiting on role confirmation. User-role
// parts are silently dropped.
function replay(data: SessionData, commits: SessionCommit[], messageID: string, role: MessageRole, thinking: boolean) {
  for (const [partID, msg] of data.msg.entries()) {
    if (msg !== messageID || data.ids.has(partID)) {
      continue
    }

    if (role === "user" && !data.includeUserText) {
      data.ids.add(partID)
      drop(data, partID)
      continue
    }

    const kind = data.part.get(partID)
    if (!kind) {
      continue
    }

    if (role === "user" && kind === "assistant") {
      data.part.set(partID, "user")
    }

    if (kind === "reasoning" && !thinking) {
      if (data.end.has(partID)) {
        data.ids.add(partID)
      }
      drop(data, partID)
      continue
    }

    flushPart(data, commits, partID)

    if (!data.end.has(partID)) {
      continue
    }

    data.ids.add(partID)
    drop(data, partID)
  }
}

function toolCommit(
  part: ToolPart,
  next: Pick<SessionCommit, "text" | "phase" | "toolState"> & { toolError?: string },
): SessionCommit {
  return {
    kind: "tool",
    source: "tool",
    messageID: part.messageID,
    partID: part.id,
    tool: part.tool,
    part,
    ...next,
  }
}

function shellPartID(callID: string): string {
  return `shell:${callID}`
}

function claimShell(data: SessionData, callID: string, source: ShellCall["source"], command?: string): ShellCall {
  const current = data.shell.get(callID)
  if (current) {
    if (command && !current.command) {
      current.command = command
    }

    return current
  }

  const next = {
    source,
    ...(command ? { command } : {}),
  } satisfies ShellCall
  data.shell.set(callID, next)
  return next
}

function bashCommand(part: ToolPart): string | undefined {
  if (part.tool !== "bash") {
    return undefined
  }

  const input = part.state.input
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined
  }

  const command = Reflect.get(input, "command")
  return typeof command === "string" ? command : undefined
}

function shellCommit(
  input: {
    callID: string
    command: string
  },
  next: Pick<SessionCommit, "text" | "phase" | "toolState">,
): SessionCommit {
  return {
    kind: "tool",
    source: "tool",
    partID: shellPartID(input.callID),
    tool: "bash",
    shell: input,
    ...next,
  }
}

function startShell(callID: string, command: string): SessionCommit {
  return shellCommit(
    {
      callID,
      command,
    },
    {
      text: "Executing shell",
      phase: "start",
      toolState: "running",
    },
  )
}

function doneShell(callID: string, command: string, output: string): SessionCommit {
  return shellCommit(
    {
      callID,
      command,
    },
    {
      text: output,
      phase: "progress",
      toolState: "completed",
    },
  )
}

function startTool(part: ToolPart): SessionCommit {
  return toolCommit(part, {
    text: toolStatus(part),
    phase: "start",
    toolState: "running",
  })
}

function doneTool(part: ToolPart): SessionCommit {
  return toolCommit(part, {
    text: "",
    phase: "final",
    toolState: "completed",
  })
}

function failTool(part: ToolPart, text: string): SessionCommit {
  return toolCommit(part, {
    text,
    phase: "final",
    toolState: "error",
    toolError: text,
  })
}

// Emits "interrupted" final entries for all in-flight parts. Called when a turn is aborted.
export function flushInterrupted(data: SessionData, commits: SessionCommit[]) {
  for (const partID of data.part.keys()) {
    if (data.ids.has(partID)) {
      continue
    }

    const msg = data.msg.get(partID)
    if (msg && data.role.get(msg) === "user" && !data.includeUserText) {
      data.ids.add(partID)
      drop(data, partID)
      continue
    }

    flushPart(data, commits, partID, true)
    data.ids.add(partID)
    drop(data, partID)
  }
}

// ── Every Event Produces A Pure Projection Delta ─────────────────
// The transport calls this reducer once for each ordered control-plane event.
// Message metadata unlocks buffered parts; part deltas and updates advance text,
// reasoning, or tools; question events replace the active footer blocker; and
// session failures append visible errors. The result contains only commits and
// footer changes, leaving rendering and I/O to the caller.
// ─────────────────────────────────────────────────────────────────
export function reduceSessionData(input: SessionDataInput): SessionDataOutput {
  const commits: SessionCommit[] = []
  const data = input.data
  const event = input.event

  if (event.type === "session.next.skill.learned") {
    if (event.properties.sessionID !== input.sessionID || data.ids.has(event.id)) {
      return out(data, commits)
    }

    data.ids.add(event.id)
    commits.push({
      kind: "system",
      text: `✦ Skill learned: ${event.properties.skills.join(", ")}`,
      phase: "final",
      source: "system",
    })
    return out(data, commits)
  }

  if (event.type === "session.next.shell.started") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const shell = claimShell(data, event.properties.callID, "shell", event.properties.command)
    if (shell.source !== "shell") {
      return out(data, commits)
    }

    const partID = shellPartID(event.properties.callID)
    if (data.ids.has(partID) || data.tools.has(partID)) {
      return out(data, commits, patch({ status: "Executing shell" }))
    }

    data.tools.add(partID)
    commits.push(startShell(event.properties.callID, shell.command ?? event.properties.command))
    return out(data, commits, patch({ status: "Executing shell" }))
  }

  if (event.type === "session.next.shell.ended") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const shell = claimShell(data, event.properties.callID, "shell")
    if (shell.source !== "shell") {
      return out(data, commits)
    }

    const partID = shellPartID(event.properties.callID)
    const seen = data.tools.has(partID)
    const command = shell.command ?? ""
    data.tools.delete(partID)
    if (data.ids.has(partID)) {
      return out(data, commits)
    }

    if (!seen && command) {
      commits.push(startShell(event.properties.callID, command))
    }

    data.ids.add(partID)
    commits.push(doneShell(event.properties.callID, command, event.properties.output))
    return out(data, commits)
  }

  if (event.type === "message.updated") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    const info = event.properties.info
    if (typeof info.id === "string") {
      data.role.set(info.id, info.role)
      replay(data, commits, info.id, info.role, input.thinking)
    }

    if (info.role !== "assistant") {
      return out(data, commits)
    }

    let next: FooterPatch | undefined
    if (!data.announced) {
      data.announced = true
      next = { status: "assistant responding" }
    }

    const usage = formatUsage(info.tokens, input.limits[modelKey(info.providerID, info.modelID)])
    if (usage) {
      next = {
        ...next,
        usage,
      }
    }

    if (typeof info.id === "string" && info.error && !isAbort(info.error) && !data.ids.has(msgErr(info.id))) {
      data.ids.add(msgErr(info.id))
      commits.push({
        kind: "error",
        text: formatError(info.error),
        phase: "start",
        source: "system",
        messageID: info.id,
      })
    }

    const completed = isFinalAssistant(info) ? info.time.completed : undefined
    if (
      typeof info.id === "string" &&
      completed !== undefined &&
      data.assistantText.has(info.id) &&
      !data.ids.has(msgTimestamp(info.id))
    ) {
      data.ids.add(msgTimestamp(info.id))
      commits.push(timestampCommit(info.id, completed))
    }

    return out(data, commits, patch(next))
  }

  if (event.type === "message.part.delta") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (
      typeof event.properties.partID !== "string" ||
      typeof event.properties.field !== "string" ||
      typeof event.properties.delta !== "string"
    ) {
      return out(data, commits)
    }

    if (event.properties.field !== "text") {
      return out(data, commits)
    }

    const partID = event.properties.partID
    if (data.ids.has(partID)) {
      return out(data, commits)
    }

    if (typeof event.properties.messageID === "string") {
      data.msg.set(partID, event.properties.messageID)
    }

    const text = data.text.get(partID) ?? ""
    data.text.set(partID, event.properties.mode === "replace" ? event.properties.delta : text + event.properties.delta)

    const kind = data.part.get(partID)
    if (!kind) {
      return out(data, commits)
    }

    if (kind === "reasoning" && !input.thinking) {
      return out(data, commits)
    }

    if (!ready(data, partID)) {
      return out(data, commits)
    }

    flushPart(data, commits, partID, false, event.properties.mode === "replace" ? "replace" : "append")
    return out(data, commits)
  }

  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (part.type === "tool") {
      const view = syncQuestion(data, part)
      if (part.tool === "bash" && part.callID) {
        if (claimShell(data, part.callID, "tool", bashCommand(part)).source === "shell") {
          return out(data, commits, view)
        }
      }

      if (part.state.status === "pending") {
        return out(
          data,
          commits,
          view ?? patch({ status: `Queued ${toolDisplaySummary(part.tool, part.state.input)}` }),
        )
      }

      if (part.state.status === "running") {
        if (data.ids.has(part.id)) {
          return out(data, commits, view)
        }

        if (!data.tools.has(part.id)) {
          data.tools.add(part.id)
          commits.push(startTool(part))
        }

        return out(data, commits, view ?? patch({ status: toolStatus(part) }))
      }

      if (part.state.status === "completed") {
        const seen = data.tools.has(part.id)
        const mode = toolView(part.tool)
        data.tools.delete(part.id)
        if (data.ids.has(part.id)) {
          return out(data, commits, view)
        }

        if (!seen) {
          commits.push(startTool(part))
        }

        data.ids.add(part.id)
        stashEcho(data, part)

        const output = part.state.output
        if (mode.output && typeof output === "string" && output.trim()) {
          commits.push({
            kind: "tool",
            text: output,
            phase: "progress",
            source: "tool",
            messageID: part.messageID,
            partID: part.id,
            tool: part.tool,
            part,
            toolState: "completed",
          })
        }

        if (mode.final) {
          commits.push(doneTool(part))
        }

        return out(data, commits, view)
      }

      if (part.state.status === "error") {
        const seen = data.tools.has(part.id)
        data.tools.delete(part.id)
        if (data.ids.has(part.id)) {
          return out(data, commits, view)
        }

        if (!seen) {
          commits.push(startTool(part))
        }

        data.ids.add(part.id)
        const text =
          typeof part.state.error === "string" && part.state.error.trim() ? part.state.error : "unknown error"
        commits.push(failTool(part, text))
        return out(data, commits, view)
      }
    }

    if (part.type !== "text" && part.type !== "reasoning") {
      return out(data, commits)
    }

    if (data.ids.has(part.id)) {
      return out(data, commits)
    }

    const kind = part.type === "text" ? "assistant" : "reasoning"
    if (typeof part.messageID === "string") {
      data.msg.set(part.id, part.messageID)
    }

    const msg = part.messageID
    const role = msg ? data.role.get(msg) : undefined
    if (role === "user" && part.type === "text" && !data.includeUserText) {
      data.ids.add(part.id)
      drop(data, part.id)
      return out(data, commits)
    }

    if (kind === "reasoning" && !input.thinking) {
      if (part.time?.end) {
        data.ids.add(part.id)
      }
      drop(data, part.id)
      return out(data, commits)
    }

    data.part.set(part.id, role === "user" && kind === "assistant" ? "user" : kind)
    syncText(data, part.id, part.text)

    if (part.time?.end) {
      data.end.add(part.id)
    }

    if (msg && !role) {
      return out(data, commits)
    }

    if (!ready(data, part.id)) {
      return out(data, commits)
    }

    flushPart(data, commits, part.id)

    if (!part.time?.end) {
      return out(data, commits)
    }

    data.ids.add(part.id)
    drop(data, part.id)
    return out(data, commits)
  }

  if (event.type === "question.asked") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    upsert(data.questions, event.properties)
    return queueOut(data, commits)
  }

  if (event.type === "question.replied" || event.type === "question.rejected") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (!remove(data.questions, event.properties.requestID)) {
      return out(data, commits)
    }

    return queueOut(data, commits)
  }

  if (event.type === "session.status") {
    if (event.properties.sessionID !== input.sessionID) {
      return out(data, commits)
    }

    if (event.properties.status.type !== "busy") {
      return out(data, commits)
    }

    const message = event.properties.status.message?.trim()
    return out(data, commits, message ? patch({ status: message }) : undefined)
  }

  if (event.type === "session.error") {
    if (event.properties.sessionID !== input.sessionID || !event.properties.error) {
      return out(data, commits)
    }

    commits.push({
      kind: "error",
      text: formatError(event.properties.error),
      phase: "start",
      source: "system",
    })
    return out(data, commits)
  }

  return out(data, commits)
}
