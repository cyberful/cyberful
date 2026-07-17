// ── Versioned Session Event Contract ──────────────────────────────────────
// Defines runtime-validated session events for prompts, phases, tools, errors, and completion.
// → cyberful/src/session/projectors.ts — projects aggregate events into session state.
// → cyberful/src/event-v2-bridge.ts — delivers these contracts to legacy consumers.
// ──────────────────────────────────────────────────────────────────────────

import { DateTime, Schema, SchemaGetter } from "effect"
import { EventV2 } from "@/event-v2"
import { NonNegativeInt } from "@/schema"
import { SessionID } from "./schema"
import { FileAttachment, Prompt } from "./prompt-v2"
import { ToolOutput } from "@/tool/output"

const DateTimeUtcFromMillis = Schema.Finite.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.transform((value) => DateTime.makeUnsafe(value)),
    encode: SchemaGetter.transform((value) => DateTime.toEpochMillis(value)),
  }),
)

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export type Source = typeof Source.Type

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}

// A phase event carries the executor identity that produced it. Consumers render `label` directly; they
// do not infer product names or versions from the event type, backend telemetry, or local configuration.
export const SubsystemDescriptor = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  label: Schema.String,
}).annotate({
  identifier: "Session.SubsystemDescriptor",
})
export type SubsystemDescriptor = typeof SubsystemDescriptor.Type

export const PhaseActivityActor = Schema.Struct({
  id: Schema.String,
  label: Schema.String.pipe(Schema.optional),
  parentID: Schema.String.pipe(Schema.optional),
}).annotate({
  identifier: "Session.PhaseActivityActor",
})
export type PhaseActivityActor = typeof PhaseActivityActor.Type

export const PhaseActivityActorState = Schema.Literals([
  "started",
  "active",
  "interacted",
  "completed",
  "interrupted",
  "failed",
])
export type PhaseActivityActorState = typeof PhaseActivityActorState.Type

const options = {
  aggregate: "sessionID",
  version: 1,
} as const

// ── Notifications Must Bypass Aggregate Reconciliation ──────────
// These events describe transient activity rather than durable aggregate state.
// Omitting `aggregate` routes them through the discrete bus and SSE channel;
// assigning one would send them through sync reconciliation instead. Live UI
// consumers subscribe only to discrete events and intentionally discard sync payloads.
// ─────────────────────────────────────────────────────────────────
const notifyOptions = {
  version: 1,
} as const

export const UnknownError = Schema.Struct({
  type: Schema.Literal("unknown"),
  message: Schema.String,
}).annotate({
  identifier: "Session.Error.Unknown",
})
export type UnknownError = typeof UnknownError.Type

export const AgentSwitched = EventV2.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const Prompted = EventV2.define({
  type: "session.next.prompted",
  ...options,
  schema: {
    ...Base,
    prompt: Prompt,
  },
})
export type Prompted = typeof Prompted.Type

export const Synthetic = EventV2.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    text: Schema.String,
  },
})
export type Synthetic = typeof Synthetic.Type

export const SkillLearned = EventV2.define({
  type: "session.next.skill.learned",
  ...notifyOptions,
  schema: {
    ...Base,
    skills: Schema.Array(Schema.String),
  },
})
export type SkillLearned = typeof SkillLearned.Type

// ── Phase Activity Uses One Stable Streaming Envelope ───────────
// Every live activity item travels through the discrete event path so the TUI
// can render it before the phase completes. Start and end delimit an excursion;
// text, progress, status, tool, and delegated-actor items reuse the same schema
// with unused fields left empty. The phase and subsystem fields carry
// authoritative host identity, avoiding product or runtime inference from
// presentation text while allowing concurrent subsystem sources.
// ─────────────────────────────────────────────────────────────────
export const SubsystemPhaseActivity = EventV2.define({
  type: "session.next.subsystem.phase_activity",
  ...notifyOptions,
  version: 3,
  schema: {
    ...Base,
    phase: Schema.String,
    subsystem: SubsystemDescriptor,
    kind: Schema.String,
    text: Schema.String,
    tool: Schema.String,
    actor: PhaseActivityActor.pipe(Schema.optional),
    actorState: PhaseActivityActorState.pipe(Schema.optional),
    actorTransitionID: Schema.String.pipe(Schema.optional),
  },
})
export type SubsystemPhaseActivity = typeof SubsystemPhaseActivity.Type

export namespace Shell {
  export const Started = EventV2.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = EventV2.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Text {
  export const Started = EventV2.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
    },
  })
  export type Started = typeof Started.Type

  export const Delta = EventV2.define({
    type: "session.next.text.delta",
    ...options,
    schema: {
      ...Base,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = EventV2.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = EventV2.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      reasoningID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Delta = EventV2.define({
    type: "session.next.reasoning.delta",
    ...options,
    schema: {
      ...Base,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = EventV2.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      reasoningID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  export namespace Input {
    export const Started = EventV2.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...Base,
        callID: Schema.String,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    export const Delta = EventV2.define({
      type: "session.next.tool.input.delta",
      ...options,
      schema: {
        ...Base,
        callID: Schema.String,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = EventV2.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...Base,
        callID: Schema.String,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = EventV2.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  export const Progress = EventV2.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      structured: ToolOutput.Structured,
      content: Schema.Array(ToolOutput.Content),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = EventV2.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      structured: ToolOutput.Structured,
      content: Schema.Array(ToolOutput.Content),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = EventV2.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      error: UnknownError,
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(Schema.optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  responseBody: Schema.String.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export type RetryError = typeof RetryError.Type

export const Retried = EventV2.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    error: RetryError,
  },
})
export type Retried = typeof Retried.Type

export namespace Compaction {
  export const Started = EventV2.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = EventV2.define({
    type: "session.next.compaction.delta",
    ...options,
    schema: {
      ...Base,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = EventV2.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      text: Schema.String,
      include: Schema.String.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export const All = Schema.Union(
  [
    AgentSwitched,
    Prompted,
    Synthetic,
    SkillLearned,
    SubsystemPhaseActivity,
    Shell.Started,
    Shell.Ended,
    Text.Started,
    Text.Delta,
    Text.Ended,
    Tool.Input.Started,
    Tool.Input.Delta,
    Tool.Input.Ended,
    Tool.Called,
    Tool.Progress,
    Tool.Success,
    Tool.Failed,
    Reasoning.Started,
    Reasoning.Delta,
    Reasoning.Ended,
    Retried,
    Compaction.Started,
    Compaction.Delta,
    Compaction.Ended,
  ],
  {
    mode: "oneOf",
  },
).pipe(Schema.toTaggedUnion("type"))

export type Event = typeof All.Type
export type Type = Event["type"]

export * as SessionEvent from "./event-v2"
