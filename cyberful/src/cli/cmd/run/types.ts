// ── Interactive Run Contracts ────────────────────────────────────
// Defines the prompts, commits, structured entries, footer states, callbacks,
//   and lifecycle boundaries shared by the immutable scrollback and mutable
//   footer lanes of direct interactive mode.
// ─────────────────────────────────────────────────────────────────

import type { KeyEvent, Renderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import type { ControlPlaneClient, QuestionRequest, ToolPart } from "@/server/client"

export type RunFilePart = {
  type: "file"
  url: string
  filename: string
  mime: string
}

type PromptInput = Parameters<ControlPlaneClient["session"]["prompt"]>[0]

export type RunPromptPart = NonNullable<PromptInput["parts"]>[number]

export type RunCommand = NonNullable<Awaited<ReturnType<ControlPlaneClient["command"]["list"]>>["data"]>[number]

export type RunPrompt = {
  text: string
  parts: RunPromptPart[]
  mode?: "shell"
  command?: {
    name: string
    arguments: string
  }
}

export type RunAgent = NonNullable<Awaited<ReturnType<ControlPlaneClient["app"]["agents"]>>["data"]>[number]

export type RunInput = {
  sdk: ControlPlaneClient
  directory: string
  sessionID: string
  sessionTitle?: string
  resume?: boolean
  replay?: boolean
  replayLimit?: number
  agent: string | undefined
  system?: string
  workarea?: string
  files: RunFilePart[]
  initialInput?: string
  thinking: boolean
  demo?: boolean
}

// The semantic role of a scrollback entry. Maps 1:1 to theme colors.
export type EntryKind = "system" | "user" | "assistant" | "reasoning" | "tool" | "error"

// Whether the assistant is actively processing a turn.
export type FooterPhase = "idle" | "running"

// Full snapshot of footer status bar state. Every update replaces the whole
// object in the SolidJS signal so the view re-renders atomically.
export type FooterState = {
  phase: FooterPhase
  status: string
  queue: number
  duration: string
  startedAt: number | undefined
  usage: string
  first: boolean
  interrupt: number
  exit: number
}

// A partial update to FooterState. The footer merges this onto the current state.
export type FooterPatch = Partial<FooterState>

export type RunDiffStyle = "auto" | "stacked"

export type ScrollbackOptions = {
  diffStyle?: RunDiffStyle
  suppressBackgrounds?: boolean
}

export type ToolCodeSnapshot = {
  kind: "code"
  title: string
  content: string
  file?: string
}

export type ToolDiffSnapshot = {
  kind: "diff"
  items: Array<{
    title: string
    diff: string
    file?: string
    deletions?: number
  }>
}

export type ToolTaskSnapshot = {
  kind: "task"
  title: string
  rows: string[]
  tail: string
}

export type ToolTodoSnapshot = {
  kind: "todo"
  items: Array<{
    status: string
    content: string
  }>
  tail: string
}

export type ToolQuestionSnapshot = {
  kind: "question"
  items: Array<{
    question: string
    answer: string
  }>
  tail: string
}

export type ToolSnapshot =
  | ToolCodeSnapshot
  | ToolDiffSnapshot
  | ToolTaskSnapshot
  | ToolTodoSnapshot
  | ToolQuestionSnapshot

export type EntryLayout = "inline" | "block"

export type RunEntryBody =
  | { type: "none" }
  | { type: "text"; content: string }
  | { type: "code"; content: string; filetype?: string }
  | { type: "markdown"; content: string }
  | { type: "structured"; snapshot: ToolSnapshot }

// Which interactive surface the footer is showing. Only one view is active at
// a time. The reducer drives transitions between the prompt and question view.
export type FooterView = { type: "prompt" } | { type: "question"; request: QuestionRequest }

export type FooterPromptRoute =
  | { type: "composer" }
  | { type: "subagent-menu" }
  | { type: "subagent"; sessionID: string }
  | { type: "command" }
  | { type: "skill" }

export type FooterSubagentTab = {
  sessionID: string
  partID: string
  callID: string
  label: string
  description: string
  status: "running" | "completed" | "error"
  title?: string
  toolCalls?: number
  lastUpdatedAt: number
}

export type FooterSubagentDetail = {
  sessionID: string
  commits: StreamCommit[]
}

export type FooterSubagentState = {
  tabs: FooterSubagentTab[]
  details: Record<string, FooterSubagentDetail>
  questions: QuestionRequest[]
}

// The reducer emits this alongside scrollback commits so the footer can update in the same frame.
export type FooterOutput = {
  patch?: FooterPatch
  view?: FooterView
  subagent?: FooterSubagentState
}

// Typed messages sent to RunFooter.event(). The prompt queue and stream
// transport both emit these to update footer state without reaching into
// internal signals directly.
export type FooterEvent =
  | {
      type: "catalog"
      agents: RunAgent[]
      commands?: RunCommand[]
    }
  | {
      type: "queue"
      queue: number
    }
  | {
      type: "first"
      first: boolean
    }
  | {
      type: "turn.send"
      queue: number
      startedAt: number
    }
  | {
      type: "turn.wait"
    }
  | {
      type: "turn.idle"
      queue: number
    }
  | {
      type: "turn.duration"
      duration: string
    }
  | {
      type: "stream.patch"
      patch: FooterPatch
    }
  | {
      type: "stream.view"
      view: FooterView
    }
  | {
      type: "stream.subagent"
      state: FooterSubagentState
    }

export type QuestionReply = Parameters<ControlPlaneClient["question"]["reply"]>[0]

export type QuestionReject = Parameters<ControlPlaneClient["question"]["reject"]>[0]

type FooterBinding = Binding<Renderable, KeyEvent>

export type FooterKeybinds = {
  leader: string
  leaderTimeout: number
  commandList: readonly FooterBinding[]
  interrupt: readonly FooterBinding[]
  historyPrevious: readonly FooterBinding[]
  historyNext: readonly FooterBinding[]
  inputClear: readonly FooterBinding[]
  inputSubmit: readonly FooterBinding[]
  inputNewline: readonly FooterBinding[]
}

// Lifecycle phase of a scrollback entry. "start" opens the entry, "progress"
// streams content (coalesced in the footer queue), "final" closes it.
export type StreamPhase = "start" | "progress" | "final"

export type StreamMode = "append" | "replace"

export type StreamSource = "assistant" | "reasoning" | "tool" | "system"

export type StreamToolState = "running" | "completed" | "error"

// ── Flushed Scrollback Commits Are Immutable ─────────────────────
// The session reducer describes each visible change as a commit without touching
// the renderer. RunFooter may coalesce adjacent progress before its microtask
// drain, but after a commit reaches terminal scrollback it cannot be rewritten.
// Replacement mode therefore applies only while an entry still owns a retained
// streaming surface.
// ─────────────────────────────────────────────────────────────────
export type StreamCommit = {
  kind: EntryKind
  text: string
  phase: StreamPhase
  mode?: StreamMode
  source: StreamSource
  messageID?: string
  partID?: string
  tool?: string
  part?: ToolPart
  interrupted?: boolean
  timestamp?: boolean
  toolState?: StreamToolState
  toolError?: string
  shell?: {
    callID: string
    command: string
  }
}

// The public contract between the stream transport / prompt queue and
// the footer. RunFooter implements this. The transport and queue never
// touch the renderer directly -- they go through this interface.
export type FooterApi = {
  readonly isClosed: boolean
  onPrompt(fn: (input: RunPrompt) => void): () => void
  onClose(fn: () => void): () => void
  event(next: FooterEvent): void
  append(commit: StreamCommit): void
  idle(): Promise<void>
  close(): void
  destroy(): void
}
