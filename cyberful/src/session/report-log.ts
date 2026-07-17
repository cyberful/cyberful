// ── Session Report Event Log ───────────────────────────────────────────
// Appends de-duplicated message, tool, completion, and error records through a
// Session-layer owner whose state is released with its sessions and lifetime.
// → cyberful/src/session/session.ts — forwards persisted message changes into this log.
// ────────────────────────────────────────────────────────────────────────

import path from "path"
import { appendFile, mkdir } from "fs/promises"
import { Effect, Semaphore } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { MessageV2 } from "./message-v2"

type AttachmentLog = {
  mime: string
  filename?: string
  url?: string
}

type BaseLog = {
  timestamp: string
  time: number
  sessionID: string
  messageID: string
}

type LogEntry =
  | (BaseLog & {
      type: "user_message" | "assistant_message"
      partID: string
      text: string
      synthetic?: boolean
      ignored?: boolean
      metadata?: Record<string, unknown>
    })
  | (BaseLog & {
      type: "assistant_error"
      error: unknown
      modelID: string
      providerID: string
      agent: string
    })
  | (BaseLog & {
      type: "assistant_completed"
      finish?: string
      modelID: string
      providerID: string
      agent: string
      tokens: MessageV2.Assistant["tokens"]
    })
  | (BaseLog & {
      type: "assistant_step"
      partID: string
      finish: string
      tokens: MessageV2.StepFinishPart["tokens"]
    })
  | (BaseLog & {
      type: "run_completion"
      partID: string
      workflow: string
      outcome: MessageV2.CompletionPart["outcome"]
      title: string
      summaryMarkdown: string
      workarea?: string
      artifacts: MessageV2.CompletionArtifact[]
      nextWorkflow?: string
    })
  | (BaseLog & {
      type: "tool_call"
      partID: string
      callID: string
      tool: string
      input: Record<string, unknown>
      providerExecuted?: boolean
    })
  | (BaseLog & {
      type: "tool_response"
      partID: string
      callID: string
      tool: string
      input: Record<string, unknown>
      output: string
      title: string
      metadata: Record<string, unknown>
      attachments?: AttachmentLog[]
      providerExecuted?: boolean
    })
  | (BaseLog & {
      type: "tool_error"
      partID: string
      callID: string
      tool: string
      input: Record<string, unknown>
      error: string
      output?: string
      metadata?: Record<string, unknown>
      providerExecuted?: boolean
    })

type PendingEntry = {
  readonly key: string
  readonly entry: LogEntry
}

interface JournalState {
  readonly messageRoles: Map<string, MessageV2.Info["role"]>
  readonly messageCreated: Map<string, number>
  readonly seen: Set<string>
  readonly gate: Semaphore.Semaphore
}

export interface Journal {
  readonly message: (info: MessageV2.Info) => Effect.Effect<void>
  readonly part: (part: MessageV2.Part) => Effect.Effect<void>
  readonly forget: (sessionID: string) => void
}

function pending(state: JournalState, key: string, entry: LogEntry): PendingEntry | undefined {
  if (state.seen.has(key)) return
  return { key, entry }
}

function timestamp(time: number) {
  return new Date(time).toISOString()
}

function base(input: { sessionID: string; messageID: string; time: number }): BaseLog {
  return {
    timestamp: timestamp(input.time),
    time: input.time,
    sessionID: input.sessionID,
    messageID: input.messageID,
  }
}

function safeName(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]/g, "-")
}

function projectRoot(input: { directory: string; worktree: string }) {
  if (input.worktree === path.parse(input.worktree).root) return input.directory
  return input.worktree
}

// ── Journals And Transcripts Share One Evidence Directory ────────
// Each session owns a turn-by-turn JSONL journal and each of its Codex phases
// owns a separate raw stream transcript. Both resolve from the same project-root
// rule and live under the gitignored logs tree, keeping one run's evidence
// together without allowing later phases to overwrite earlier phase streams.
// ─────────────────────────────────────────────────────────────────
function sessionLogDir(root: string) {
  return path.join(root, "logs", "session-logs")
}

function reportFile(root: string, sessionID: string) {
  return path.join(sessionLogDir(root), `session-${safeName(sessionID)}.jsonl`)
}

export function expertTranscriptFile(
  location: { directory: string; worktree: string },
  sessionID: string,
  phase: string,
  workflow?: string,
) {
  const owner =
    workflow && workflow !== "pentest" && workflow !== "ask"
      ? `${safeName(workflow)}-${safeName(phase)}`
      : safeName(phase)
  return path.join(sessionLogDir(projectRoot(location)), `session-${safeName(sessionID)}.expert-${owner}.jsonl`)
}

function attachment(input: MessageV2.FilePart): AttachmentLog {
  return {
    mime: input.mime,
    filename: input.filename,
    url: input.url.startsWith("data:") ? `data:${input.mime};base64,...` : input.url,
  }
}

function toolProviderExecuted(part: MessageV2.ToolPart) {
  return part.metadata?.providerExecuted === true ? true : undefined
}

function toolOutputFromMetadata(metadata: Record<string, unknown> | undefined) {
  return typeof metadata?.output === "string" ? metadata.output : undefined
}

function messageEntries(state: JournalState, info: MessageV2.Info): PendingEntry[] {
  state.messageRoles.set(info.id, info.role)
  state.messageCreated.set(info.id, info.time.created)
  if (info.role === "user") return []

  const completed = info.time.completed
  const entries: PendingEntry[] = []
  if (info.error) {
    const item = pending(state, `assistant-error:${info.id}`, {
      ...base({ sessionID: info.sessionID, messageID: info.id, time: completed ?? Date.now() }),
      type: "assistant_error",
      error: info.error,
      modelID: info.modelID,
      providerID: info.providerID,
      agent: info.agent,
    })
    if (item) entries.push(item)
  }
  if (completed) {
    const item = pending(state, `assistant-completed:${info.id}`, {
      ...base({ sessionID: info.sessionID, messageID: info.id, time: completed }),
      type: "assistant_completed",
      finish: info.finish,
      modelID: info.modelID,
      providerID: info.providerID,
      agent: info.agent,
      tokens: info.tokens,
    })
    if (item) entries.push(item)
  }
  return entries
}

function textEntries(
  state: JournalState,
  part: MessageV2.TextPart,
  role: MessageV2.Info["role"] | undefined,
): PendingEntry[] {
  if (!role) return []
  if (role === "assistant" && !part.time?.end) return []
  if (part.text.length === 0) return []
  const item = pending(state, `text:${role}:${part.messageID}:${part.id}`, {
    ...base({
      sessionID: part.sessionID,
      messageID: part.messageID,
      time:
        role === "assistant"
          ? (part.time?.end ?? Date.now())
          : (state.messageCreated.get(part.messageID) ?? Date.now()),
    }),
    type: role === "assistant" ? "assistant_message" : "user_message",
    partID: part.id,
    text: part.text,
    synthetic: part.synthetic,
    ignored: part.ignored,
    metadata: part.metadata,
  })
  return item ? [item] : []
}

function stepEntries(state: JournalState, part: MessageV2.StepFinishPart): PendingEntry[] {
  const item = pending(state, `step:${part.messageID}:${part.id}`, {
    ...base({ sessionID: part.sessionID, messageID: part.messageID, time: Date.now() }),
    type: "assistant_step",
    partID: part.id,
    finish: part.reason,
    tokens: part.tokens,
  })
  return item ? [item] : []
}

function completionEntries(state: JournalState, part: MessageV2.CompletionPart): PendingEntry[] {
  const item = pending(state, `completion:${part.messageID}:${part.id}`, {
    ...base({ sessionID: part.sessionID, messageID: part.messageID, time: Date.now() }),
    type: "run_completion",
    partID: part.id,
    workflow: part.workflow,
    outcome: part.outcome,
    title: part.title,
    summaryMarkdown: part.summaryMarkdown,
    workarea: part.workarea,
    artifacts: part.artifacts,
    nextWorkflow: part.nextWorkflow,
  })
  return item ? [item] : []
}

function toolEntries(state: JournalState, part: MessageV2.ToolPart): PendingEntry[] {
  if (part.state.status === "pending") return []
  if (part.state.status === "running") {
    const item = pending(state, `tool:${part.messageID}:${part.id}:running`, {
      ...base({ sessionID: part.sessionID, messageID: part.messageID, time: part.state.time.start }),
      type: "tool_call",
      partID: part.id,
      callID: part.callID,
      tool: part.tool,
      input: part.state.input,
      providerExecuted: toolProviderExecuted(part),
    })
    return item ? [item] : []
  }
  if (part.state.status === "completed") {
    const item = pending(state, `tool:${part.messageID}:${part.id}:completed`, {
      ...base({ sessionID: part.sessionID, messageID: part.messageID, time: part.state.time.end }),
      type: "tool_response",
      partID: part.id,
      callID: part.callID,
      tool: part.tool,
      input: part.state.input,
      output: part.state.output,
      title: part.state.title,
      metadata: part.state.metadata,
      attachments: part.state.attachments?.map(attachment),
      providerExecuted: toolProviderExecuted(part),
    })
    return item ? [item] : []
  }
  const item = pending(state, `tool:${part.messageID}:${part.id}:error`, {
    ...base({ sessionID: part.sessionID, messageID: part.messageID, time: part.state.time.end }),
    type: "tool_error",
    partID: part.id,
    callID: part.callID,
    tool: part.tool,
    input: part.state.input,
    error: part.state.error,
    output: toolOutputFromMetadata(part.state.metadata),
    metadata: part.state.metadata,
    providerExecuted: toolProviderExecuted(part),
  })
  return item ? [item] : []
}

function partEntries(state: JournalState, part: MessageV2.Part): PendingEntry[] {
  if (part.type === "text") return textEntries(state, part, state.messageRoles.get(part.messageID))
  if (part.type === "completion") return completionEntries(state, part)
  if (part.type === "tool") return toolEntries(state, part)
  if (part.type === "step-finish") return stepEntries(state, part)
  return []
}

function append(state: JournalState, sessionID: string, entries: PendingEntry[]) {
  if (entries.length === 0) return Effect.void
  return Effect.gen(function* () {
    const ctx = yield* InstanceState.context
    const file = reportFile(projectRoot(ctx), sessionID)
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
        await appendFile(file, entries.map((item) => JSON.stringify(item.entry)).join("\n") + "\n", {
          encoding: "utf8",
          mode: 0o600,
        })
      },
      catch: (error) => new Error(`failed to append session report log ${file}`, { cause: error }),
    }).pipe(Effect.orDie)
    for (const item of entries) state.seen.add(item.key)
  })
}

// ── Journal State Belongs To One Session Service ─────────────────────
// A Session layer owns this journal and one serialized state record per session.
// Event keys become seen only after appendFile succeeds, so a failed persistence
// attempt remains retryable. Session removal drops its record; closing the layer
// releases the whole owner instead of retaining process-global message history.
// ────────────────────────────────────────────────────────────────
export function create(): Journal {
  const sessions = new Map<string, JournalState>()
  const stateFor = (sessionID: string) => {
    const current = sessions.get(sessionID)
    if (current) return current
    const state: JournalState = {
      messageRoles: new Map(),
      messageCreated: new Map(),
      seen: new Set(),
      gate: Semaphore.makeUnsafe(1),
    }
    sessions.set(sessionID, state)
    return state
  }
  const write = (sessionID: string, entries: (state: JournalState) => PendingEntry[]) => {
    const state = stateFor(sessionID)
    return state.gate.withPermits(1)(Effect.suspend(() => append(state, sessionID, entries(state))))
  }

  return {
    message: (info) => write(info.sessionID, (state) => messageEntries(state, info)),
    part: (part) => write(part.sessionID, (state) => partEntries(state, part)),
    forget: (sessionID) => {
      sessions.delete(sessionID)
    },
  }
}

export const pathForSession = Effect.fn("SessionReportLog.pathForSession")(function* (sessionID: string) {
  return reportFile(projectRoot(yield* InstanceState.context), sessionID)
})

export * as SessionReportLog from "./report-log"
