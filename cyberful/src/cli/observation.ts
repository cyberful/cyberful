// ── Public Coding-Agent Observation Wire ────────────────────────
// Normalizes live control-plane events into versioned, session-scoped JSONL.
// The projection deliberately excludes reasoning, transcripts, raw tool I/O,
// provider response bodies, headers, and opaque metadata.
// → cyberful/src/cli/cmd/run.ts — emits wire v1 for headless runs.
// → cyberful/src/cli/cmd/session.ts — emits the same wire while watching.
// @docs/user-guide/cyberful-skill.md
// ─────────────────────────────────────────────────────────────────

import { EOL } from "node:os"
import { Schema } from "effect"
import type { Event, SessionInspectionV1 as Inspection, ToolPart } from "@/server/client"
import { SessionInspection } from "@/session/inspection"

const SessionOpenedData = Schema.Struct({
  workflow: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
})
const SessionSnapshotData = Schema.Struct({
  reason: Schema.Literals(["initial", "heartbeat", "reconnected", "terminal"]),
  inspection: SessionInspection.SessionInspectionV1,
})
const SessionStatusData = Schema.Struct({
  status: Schema.Union([
    Schema.Struct({ type: Schema.Literal("idle") }),
    Schema.Struct({ type: Schema.Literal("busy"), message: Schema.optional(Schema.String) }),
  ]),
})
const PhaseActivityData = Schema.Struct({
  phase: Schema.String,
  subsystem: Schema.Struct({ name: Schema.String, version: Schema.String, label: Schema.String }),
  kind: Schema.String,
  text: Schema.String,
  tool: Schema.String,
  actor: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      label: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.String),
      role: Schema.optional(Schema.Literals(["root", "subagent", "fallback"])),
      parentID: Schema.optional(Schema.String),
      provider: Schema.optional(Schema.String),
      model: Schema.optional(Schema.String),
      toolCalls: Schema.optional(Schema.Number),
    }),
  ),
  actorState: Schema.optional(
    Schema.Literals(["started", "active", "interacted", "completed", "interrupted", "failed"]),
  ),
  artifact: Schema.optional(
    Schema.Struct({ path: Schema.String, sha256: Schema.String, bytes: Schema.Number }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      scopeID: Schema.String,
      inputTokens: Schema.Number,
      generatedTokens: Schema.Number,
      reasoningTokens: Schema.Number,
      cacheReadTokens: Schema.Number,
      cacheWriteTokens: Schema.Number,
    }),
  ),
})
const AssistantTextData = Schema.Struct({ messageID: Schema.String, partID: Schema.String, text: Schema.String })
const ToolFinishedData = Schema.Struct({
  messageID: Schema.String,
  partID: Schema.String,
  callID: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["completed", "error"]),
  title: Schema.optional(Schema.String),
  startedAt: Schema.String,
  finishedAt: Schema.String,
})
const RegistryChangedData = Schema.Struct({ revision: Schema.Number })
const ApprovalRequestedData = Schema.Struct({
  requestID: Schema.String,
  presentation: Schema.Literals(["pending", "presented"]),
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.String,
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
      multiple: Schema.optional(Schema.Boolean),
      custom: Schema.optional(Schema.Boolean),
    }),
  ),
})
const ApprovalResolvedData = Schema.Struct({
  requestID: Schema.String,
  status: Schema.Literals(["answered", "rejected"]),
})
const RetryUpdatedData = Schema.Struct({
  attempt: Schema.Number,
  retryable: Schema.Boolean,
  statusCode: Schema.optional(Schema.Number),
})
const SessionErrorData = Schema.Struct({ name: Schema.String, message: Schema.optional(Schema.String) })

const envelope = <T extends string, S extends Schema.Top>(type: T, data: S) =>
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    sequence: Schema.Number,
    timestamp: Schema.String,
    sessionID: Schema.String,
    type: Schema.Literal(type),
    data,
  })

export const CyberfulObservationV1 = Schema.Union([
  envelope("session.opened", SessionOpenedData),
  envelope("session.snapshot", SessionSnapshotData),
  envelope("session.status", SessionStatusData),
  envelope("phase.activity", PhaseActivityData),
  envelope("assistant.text", AssistantTextData),
  envelope("tool.finished", ToolFinishedData),
  envelope("findings.changed", RegistryChangedData),
  envelope("hypotheses.changed", RegistryChangedData),
  envelope("approval.requested", ApprovalRequestedData),
  envelope("approval.resolved", ApprovalResolvedData),
  envelope("retry.updated", RetryUpdatedData),
  envelope("session.error", SessionErrorData),
]).annotate({ discriminator: "type", identifier: "CyberfulObservationV1" })

export type CyberfulObservationV1 = typeof CyberfulObservationV1.Type
export type ObservationType = CyberfulObservationV1["type"]
type ObservationData<T extends ObservationType> = Extract<CyberfulObservationV1, { type: T }>["data"]

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function timestamp(value: unknown, fallback: () => Date): string {
  const milliseconds = finiteNumber(value)
  if (milliseconds === undefined) return fallback().toISOString()
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback().toISOString()
}

function defined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T
}

function boundedMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return
  const normalized = value.trim()
  if (!normalized) return
  return normalized.slice(0, 2_000)
}

function errorProjection(event: Extract<Event, { type: "session.error" }>): typeof SessionErrorData.Type {
  const error = event.properties.error
  if (!error) return { name: "SessionError" }
  return { name: boundedMessage(String(error.name)) ?? "SessionError" }
}

function toolProjection(part: ToolPart): typeof ToolFinishedData.Type | undefined {
  if (part.state.status !== "completed" && part.state.status !== "error") return
  const startedAt = timestamp(part.state.time.start, () => new Date(0))
  const finishedAt = timestamp(part.state.time.end, () => new Date(0))
  return defined({
    messageID: part.messageID,
    partID: part.id,
    callID: part.callID,
    tool: part.tool,
    status: part.state.status,
    title: part.state.status === "completed" ? boundedMessage(part.state.title) : undefined,
    startedAt,
    finishedAt,
  })
}

function phaseActivityProjection(event: Extract<Event, { type: "session.next.subsystem.phase_activity" }>) {
  const kind = event.properties.kind
  if (kind === "reasoning") return

  // Internal phase tool/output text can contain raw I/O; expose only reviewed lifecycle facts.
  if (kind === "tool") {
    const tool = boundedMessage(event.properties.tool) ?? "tool"
    return { text: `${tool} started.`, tool }
  }
  if (kind === "output") return { text: "Tool activity completed.", tool: "" }
  if (kind === "progress") return { text: "Usage updated.", tool: "" }
  if (kind === "agent") return { text: "Agent state changed.", tool: "" }
  return { text: boundedMessage(event.properties.text) ?? kind, tool: "" }
}

export interface ObservationCandidate<T extends ObservationType = ObservationType> {
  readonly type: T
  readonly timestamp: string
  readonly data: ObservationData<T>
}

// ── One Projection Owns Every Agent-Facing Stream ───────────────
// `run --format json` and `session watch` must not drift into different public
// meanings. This mapper accepts the complete generated event union, filters one
// session, and returns only deliberately reviewed fields. Unknown/new events are
// ignored until their redacted representation is added here and tested.
// ─────────────────────────────────────────────────────────────────
export function normalizeEventV1(
  event: Event,
  sessionID: string,
  now: () => Date = () => new Date(),
): ObservationCandidate | undefined {
  if (event.type === "session.status" && event.properties.sessionID === sessionID) {
    return { type: "session.status", timestamp: now().toISOString(), data: { status: event.properties.status } }
  }
  if (event.type === "session.next.subsystem.phase_activity" && event.properties.sessionID === sessionID) {
    const projection = phaseActivityProjection(event)
    if (!projection) return
    const actor = event.properties.actor
    return {
      type: "phase.activity",
      timestamp: timestamp(event.properties.timestamp, now),
      data: defined({
        phase: event.properties.phase,
        subsystem: { ...event.properties.subsystem },
        kind: event.properties.kind,
        text: projection.text,
        tool: projection.tool,
        actor: actor
          ? defined({
              id: actor.id,
              label: actor.label,
              displayName: actor.displayName,
              role: actor.role,
              parentID: actor.parentID,
              provider: actor.provider,
              model: actor.model,
              toolCalls: finiteNumber(actor.toolCalls),
            })
          : undefined,
        actorState: event.properties.actorState,
        artifact: event.properties.artifact
          ? {
              path: event.properties.artifact.path,
              sha256: event.properties.artifact.sha256,
              bytes: finiteNumber(event.properties.artifact.bytes) ?? 0,
            }
          : undefined,
        usage: event.properties.usage
          ? {
              scopeID: event.properties.usage.scopeID,
              inputTokens: finiteNumber(event.properties.usage.inputTokens) ?? 0,
              generatedTokens: finiteNumber(event.properties.usage.generatedTokens) ?? 0,
              reasoningTokens: finiteNumber(event.properties.usage.reasoningTokens) ?? 0,
              cacheReadTokens: finiteNumber(event.properties.usage.cacheReadTokens) ?? 0,
              cacheWriteTokens: finiteNumber(event.properties.usage.cacheWriteTokens) ?? 0,
            }
          : undefined,
      }),
    }
  }
  if (event.type === "message.part.updated") {
    const part = event.properties.part
    if (part.sessionID !== sessionID) return
    if (part.type === "text" && part.time?.end !== undefined && part.text.trim()) {
      return {
        type: "assistant.text",
        timestamp: timestamp(part.time.end, now),
        data: { messageID: part.messageID, partID: part.id, text: part.text.trim() },
      }
    }
    if (part.type === "tool") {
      const data = toolProjection(part)
      if (data) return { type: "tool.finished", timestamp: data.finishedAt, data }
    }
    return
  }
  if (event.type === "finding.registry.updated" && event.properties.sessionID === sessionID) {
    return {
      type: "findings.changed",
      timestamp: now().toISOString(),
      data: { revision: finiteNumber(event.properties.revision) ?? 0 },
    }
  }
  if (event.type === "hypothesis.registry.updated" && event.properties.sessionID === sessionID) {
    return {
      type: "hypotheses.changed",
      timestamp: now().toISOString(),
      data: { revision: finiteNumber(event.properties.revision) ?? 0 },
    }
  }
  if (event.type === "question.asked" && event.properties.sessionID === sessionID) {
    return {
      type: "approval.requested",
      timestamp: timestamp(event.properties.presentedAt, now),
      data: {
        requestID: event.properties.id,
        presentation: event.properties.presentation,
        questions: event.properties.questions.map((question) => ({
          question: question.question,
          header: question.header,
          options: question.options.map((option) => ({ ...option })),
          ...(question.multiple === undefined ? {} : { multiple: question.multiple }),
          ...(question.custom === undefined ? {} : { custom: question.custom }),
        })),
      },
    }
  }
  // `question.asked` and inspection own complete approvals; the presented event carries only an ID.
  if (event.type === "question.replied" && event.properties.sessionID === sessionID) {
    return {
      type: "approval.resolved",
      timestamp: now().toISOString(),
      data: { requestID: event.properties.requestID, status: "answered" },
    }
  }
  if (event.type === "question.rejected" && event.properties.sessionID === sessionID) {
    return {
      type: "approval.resolved",
      timestamp: now().toISOString(),
      data: { requestID: event.properties.requestID, status: "rejected" },
    }
  }
  if (event.type === "session.next.retried" && event.properties.sessionID === sessionID) {
    return {
      type: "retry.updated",
      timestamp: timestamp(event.properties.timestamp, now),
      data: defined({
        attempt: event.properties.attempt,
        retryable: event.properties.error.isRetryable,
        statusCode: finiteNumber(event.properties.error.statusCode),
      }),
    }
  }
  if (event.type === "session.error" && event.properties.sessionID === sessionID) {
    return { type: "session.error", timestamp: now().toISOString(), data: errorProjection(event) }
  }
}

export interface ObservationEmitter {
  readonly emit: <T extends ObservationType>(type: T, data: ObservationData<T>, timestamp?: string) => CyberfulObservationV1
  readonly candidate: <T extends ObservationType>(candidate: ObservationCandidate<T>) => CyberfulObservationV1
}

export function createObservationEmitter(input: {
  readonly sessionID: string
  readonly write: (observation: CyberfulObservationV1) => void
  readonly now?: () => Date
}): ObservationEmitter {
  let sequence = 0
  const now = input.now ?? (() => new Date())
  const emit = <T extends ObservationType>(type: T, data: ObservationData<T>, at = now().toISOString()) => {
    const observation = Schema.decodeUnknownSync(CyberfulObservationV1)({
      schemaVersion: 1,
      sequence: ++sequence,
      timestamp: at,
      sessionID: input.sessionID,
      type,
      data,
    })
    input.write(observation)
    return observation
  }
  return {
    emit,
    candidate: <T extends ObservationType>(candidate: ObservationCandidate<T>) =>
      emit(candidate.type, candidate.data, candidate.timestamp),
  }
}

export function writeObservationJson(observation: CyberfulObservationV1): void {
  process.stdout.write(`${JSON.stringify(observation)}${EOL}`)
}

export function formatObservationText(observation: CyberfulObservationV1): string {
  const prefix = `[${observation.timestamp}]`
  switch (observation.type) {
    case "session.opened":
      return `${prefix} Session ${observation.sessionID} opened${observation.data.workflow ? ` (${observation.data.workflow})` : ""}.`
    case "session.snapshot": {
      const phase = observation.data.inspection.lifecycle?.phase ?? "not available"
      const status =
        observation.data.inspection.completion?.outcome ??
        observation.data.inspection.lifecycle?.status ??
        "unknown"
      return `${prefix} Snapshot ${observation.data.reason}: phase ${phase}, status ${status}.`
    }
    case "session.status":
      return `${prefix} Session ${observation.data.status.type}${observation.data.status.type === "busy" && observation.data.status.message ? `: ${observation.data.status.message}` : "."}`
    case "phase.activity":
      return `${prefix} ${observation.data.phase}: ${observation.data.text || observation.data.kind}`
    case "assistant.text":
      return `${prefix} Assistant: ${observation.data.text}`
    case "tool.finished":
      return `${prefix} Tool ${observation.data.tool} ${observation.data.status}${observation.data.title ? `: ${observation.data.title}` : "."}`
    case "findings.changed":
      return `${prefix} Findings registry revision ${observation.data.revision}.`
    case "hypotheses.changed":
      return `${prefix} Hypotheses registry revision ${observation.data.revision}.`
    case "approval.requested":
      return `${prefix} Human approval ${observation.data.requestID} is ${observation.data.presentation}.`
    case "approval.resolved":
      return `${prefix} Human approval ${observation.data.requestID} was ${observation.data.status}.`
    case "retry.updated":
      return `${prefix} Provider retry attempt ${observation.data.attempt}${observation.data.retryable ? " is retryable" : " is not retryable"}.`
    case "session.error":
      return `${prefix} ${observation.data.name}${observation.data.message ? `: ${observation.data.message}` : "."}`
  }
}

export function inspectionCandidate(
  inspection: Inspection,
  reason: "initial" | "heartbeat" | "reconnected" | "terminal",
): ObservationCandidate<"session.snapshot"> {
  const validated = Schema.decodeUnknownSync(SessionInspection.SessionInspectionV1)(inspection)
  return { type: "session.snapshot", timestamp: validated.generatedAt, data: { reason, inspection: validated } }
}
