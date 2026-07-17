// ── Split-Footer Control Surface ─────────────────────────────────
// Owns the append-only scrollback queue and the only repaintable terminal
//   region. It serializes commits, applies footer state, interrupts active turns,
//   and closes idempotently when either the session or renderer is destroyed.
// → cyberful/src/cli/cmd/run/scrollback.surface.ts — retains streaming entries.
// ─────────────────────────────────────────────────────────────────

import { CliRenderEvents, type CliRenderer, type TreeSitterClient } from "@opentui/core"
import { render } from "@opentui/solid"
import { createComponent, createSignal, type Accessor, type Setter } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import * as Log from "@/util/log"
import { RUN_COMMAND_PANEL_ROWS, RUN_SUBAGENT_PANEL_ROWS } from "./footer.command"
import { SUBAGENT_INSPECTOR_ROWS } from "./footer.subagent"
import { PROMPT_MAX_ROWS, TEXTAREA_MIN_ROWS } from "./footer.prompt"
import { RunFooterView } from "./footer.view"
import { RunScrollbackStream } from "./scrollback.surface"
import type { RunTheme } from "./theme"
import type {
  FooterApi,
  FooterEvent,
  FooterKeybinds,
  FooterPatch,
  FooterPromptRoute,
  FooterState,
  FooterSubagentState,
  FooterView,
  QuestionReject,
  QuestionReply,
  RunAgent,
  RunCommand,
  RunDiffStyle,
  RunPrompt,
  StreamCommit,
} from "./types"

type RunFooterOptions = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  commands?: RunCommand[]
  wrote?: boolean
  sessionID: () => string | undefined
  agentLabel: string
  first: boolean
  history?: RunPrompt[]
  theme: RunTheme
  keybinds: FooterKeybinds
  diffStyle: RunDiffStyle
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onInterrupt?: () => void
  onExit?: () => void
  onSubagentSelect?: (sessionID: string | undefined) => void
  treeSitterClient?: TreeSitterClient
}

const QUESTION_ROWS = 14
const COMMAND_ROWS = RUN_COMMAND_PANEL_ROWS
const SUBAGENT_ROWS = RUN_SUBAGENT_PANEL_ROWS
const AUTOCOMPLETE_COMPACT_ROWS = 2
const log = Log.create({ service: "run.footer" })

export function coalesceFooterCommitQueue(queue: StreamCommit[], commit: StreamCommit): void {
  const last = queue.at(-1)
  if (
    !last ||
    last.phase !== "progress" ||
    commit.phase !== "progress" ||
    last.kind !== commit.kind ||
    last.source !== commit.source ||
    last.partID !== commit.partID ||
    last.tool !== commit.tool
  ) {
    queue.push(commit)
    return
  }

  if (commit.mode === "replace") {
    queue[queue.length - 1] = commit
    return
  }

  if (last.mode === "replace") {
    last.text += commit.text
    return
  }

  last.text += commit.text
}

function createEmptySubagentState(): FooterSubagentState {
  return {
    tabs: [],
    details: {},
    questions: [],
  }
}

function eventPatch(next: FooterEvent): FooterPatch | undefined {
  if (next.type === "queue") {
    return { queue: next.queue }
  }

  if (next.type === "first") {
    return { first: next.first }
  }

  if (next.type === "turn.send") {
    return {
      phase: "running",
      status: "sending prompt",
      queue: next.queue,
      duration: "00:00:00",
      startedAt: next.startedAt,
    }
  }

  if (next.type === "turn.wait") {
    return {
      phase: "running",
      status: "waiting for assistant",
    }
  }

  if (next.type === "turn.idle") {
    return {
      phase: "idle",
      status: "",
      queue: next.queue,
    }
  }

  if (next.type === "turn.duration") {
    return { duration: next.duration }
  }

  if (next.type === "stream.patch") {
    return next.patch
  }

  return undefined
}

export class RunFooter implements FooterApi {
  private closed = false
  private destroyed = false
  private prompts = new Set<(input: RunPrompt) => void>()
  private closes = new Set<() => void>()
  // Microtask-coalesced commit queue. Flushed on next microtask or on close/destroy.
  private queue: StreamCommit[] = []
  private pending = false
  private mounting: Promise<void>
  private flushing: Promise<void> = Promise.resolve()
  // Fixed portion of footer height above the textarea.
  private base: number
  private rows = TEXTAREA_MIN_ROWS
  private agents: Accessor<RunAgent[]>
  private setAgents: Setter<RunAgent[]>
  private commands: Accessor<RunCommand[] | undefined>
  private setCommands: Setter<RunCommand[] | undefined>
  private state: Accessor<FooterState>
  private setState: Setter<FooterState>
  private view: Accessor<FooterView>
  private setView: Setter<FooterView>
  private subagent: Accessor<FooterSubagentState>
  private setSubagent: (next: FooterSubagentState) => void
  private promptRoute: FooterPromptRoute = { type: "composer" }
  private subagentMenuRows = SUBAGENT_ROWS
  private autocomplete = false
  private exitTimeout: NodeJS.Timeout | undefined
  private requestExitHandler: (() => boolean) | undefined
  private scrollback: RunScrollbackStream

  constructor(
    private renderer: CliRenderer,
    private options: RunFooterOptions,
  ) {
    const [state, setState] = createSignal<FooterState>({
      phase: "idle",
      status: "",
      queue: 0,
      duration: "",
      startedAt: undefined,
      usage: "",
      first: options.first,
      interrupt: 0,
      exit: 0,
    })
    this.state = state
    this.setState = setState
    const [view, setView] = createSignal<FooterView>({ type: "prompt" })
    this.view = view
    this.setView = setView
    const [agents, setAgents] = createSignal(options.agents)
    this.agents = agents
    this.setAgents = setAgents
    const [commands, setCommands] = createSignal<RunCommand[] | undefined>(options.commands)
    this.commands = commands
    this.setCommands = setCommands
    const [subagent, setSubagent] = createStore<FooterSubagentState>(createEmptySubagentState())
    this.subagent = () => subagent
    this.setSubagent = (next) => {
      setSubagent("tabs", reconcile(next.tabs, { key: "sessionID" }))
      setSubagent("details", reconcile(next.details))
      setSubagent("questions", reconcile(next.questions, { key: "id" }))
    }
    this.base = Math.max(1, renderer.footerHeight - TEXTAREA_MIN_ROWS)
    this.scrollback = new RunScrollbackStream(renderer, options.theme, {
      diffStyle: options.diffStyle,
      wrote: options.wrote,
      treeSitterClient: options.treeSitterClient,
    })

    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy)

    this.mounting = render(
      () =>
        createComponent(RunFooterView, {
          directory: options.directory,
          state: this.state,
          view: this.view,
          subagent: this.subagent,
          findFiles: options.findFiles,
          agents: this.agents,
          commands: this.commands,
          theme: options.theme,
          diffStyle: options.diffStyle,
          keybinds: options.keybinds,
          history: options.history,
          agent: options.agentLabel,
          onSubmit: this.handlePrompt,
          onQuestionReply: this.handleQuestionReply,
          onQuestionReject: this.handleQuestionReject,
          onInterrupt: this.handleInterrupt,
          onInputClear: this.handleInputClear,
          onExitRequest: this.handleExit,
          onRequestExit: this.setRequestExitHandler,
          onExit: () => this.close(),
          onRows: this.syncRows,
          onLayout: this.syncLayout,
          onStatus: this.setStatus,
          onSubagentSelect: options.onSubagentSelect,
        }),
      this.renderer,
    ).catch((error) => {
      log.warn("run footer render failed", { error })
      if (!this.isGone) {
        this.close()
      }
    })
  }

  public get isClosed(): boolean {
    return this.closed || this.isGone
  }

  private get isGone(): boolean {
    return this.destroyed || this.renderer.isDestroyed
  }

  public onPrompt(fn: (input: RunPrompt) => void): () => void {
    this.prompts.add(fn)
    return () => {
      this.prompts.delete(fn)
    }
  }

  public onClose(fn: () => void): () => void {
    if (this.isClosed) {
      fn()
      return () => {}
    }

    this.closes.add(fn)
    return () => {
      this.closes.delete(fn)
    }
  }

  public event(next: FooterEvent): void {
    if (next.type === "catalog") {
      if (this.isGone) {
        return
      }

      this.setAgents(next.agents)
      if (next.commands !== undefined) {
        this.setCommands(next.commands)
      }
      return
    }

    const patch = eventPatch(next)
    if (patch) {
      this.patch(patch)
      return
    }

    if (next.type === "stream.subagent") {
      if (this.isGone) {
        return
      }

      this.setSubagent(next.state)
      this.applyHeight()
      return
    }

    if (next.type === "stream.view") {
      this.present(next.view)
    }
  }

  private patch(next: FooterPatch): void {
    if (this.isGone) {
      return
    }

    const prev = this.state()
    const state = {
      phase: next.phase ?? prev.phase,
      status: typeof next.status === "string" ? next.status : prev.status,
      queue: typeof next.queue === "number" ? Math.max(0, next.queue) : prev.queue,
      duration: typeof next.duration === "string" ? next.duration : prev.duration,
      startedAt:
        "startedAt" in next
          ? typeof next.startedAt === "number" && Number.isFinite(next.startedAt)
            ? next.startedAt
            : undefined
          : prev.startedAt,
      usage: typeof next.usage === "string" ? next.usage : prev.usage,
      first: typeof next.first === "boolean" ? next.first : prev.first,
      interrupt:
        typeof next.interrupt === "number" && Number.isFinite(next.interrupt)
          ? Math.max(0, Math.floor(next.interrupt))
          : prev.interrupt,
      exit:
        typeof next.exit === "number" && Number.isFinite(next.exit) ? Math.max(0, Math.floor(next.exit)) : prev.exit,
    }

    if (state.phase === "idle") {
      state.interrupt = 0
    }

    this.setState(state)

    if (prev.phase === "running" && state.phase === "idle") {
      this.flush()
      this.completeScrollback()
    }
  }

  private completeScrollback(): void {
    this.flushing = this.flushing
      .then(() => this.scrollback.complete())
      .catch((error) => log.warn("failed to complete run scrollback", { error }))
  }

  private present(view: FooterView): void {
    if (this.isGone) {
      return
    }

    this.setView(view)
    this.applyHeight()
  }

  // ── One Reducer Burst Produces One Ordered Drain ────────────────
  // Reducers may emit several progress chunks for the same part in one turn.
  // Adjacent chunks coalesce before touching retained render surfaces, avoiding
  // redundant layout without reordering distinct entries. The first append owns
  // one microtask; every later append joins its queue until that drain begins.
  // ─────────────────────────────────────────────────────────────────
  public append(commit: StreamCommit): void {
    if (this.isGone) {
      return
    }

    coalesceFooterCommitQueue(this.queue, commit)

    if (this.pending) {
      return
    }

    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      this.flush()
    })
  }

  public idle(): Promise<void> {
    if (this.isGone) {
      return Promise.resolve()
    }

    this.flush()
    if (this.state().phase === "idle") {
      this.completeScrollback()
    }

    return this.mounting
      .then(() => this.flushing)
      .then(async () => {
        if (this.isGone) {
          return
        }

        if (this.queue.length > 0) {
          return this.idle()
        }

        await this.renderer.idle().catch((error) => log.debug("renderer did not settle while footer idled", { error }))
      })
  }

  public close(): void {
    if (this.closed) {
      return
    }

    this.flush()
    this.notifyClose()
  }

  public requestExit(): boolean {
    return this.requestExitHandler?.() ?? this.handleExit()
  }

  public destroy(): void {
    this.handleDestroy()
  }

  private notifyClose(): void {
    if (this.closed) {
      return
    }

    this.closed = true
    for (const fn of [...this.closes]) {
      fn()
    }
  }

  private setStatus = (status: string): void => {
    this.patch({ status })
  }

  private setRequestExitHandler = (fn?: () => boolean): void => {
    this.requestExitHandler = fn
  }

  private handleInputClear = (): void => {
    this.clearExitTimer()
    if (this.state().interrupt === 0 && this.state().exit === 0) {
      return
    }

    this.patch({ interrupt: 0, exit: 0 })
  }

  // Resizes the footer to fit the question view or the current prompt layout.
  private applyHeight(): void {
    const type = this.view().type
    const compact = this.promptRoute.type === "composer" && this.autocomplete ? AUTOCOMPLETE_COMPACT_ROWS : 0
    const base = this.base - compact
    const height =
      type === "question"
        ? this.base + QUESTION_ROWS
        : this.promptRoute.type === "command"
          ? 1 + COMMAND_ROWS
          : this.promptRoute.type === "skill"
            ? 1 + COMMAND_ROWS
            : this.promptRoute.type === "subagent-menu"
              ? 1 + this.subagentMenuRows
              : this.promptRoute.type === "subagent"
                ? this.base + SUBAGENT_INSPECTOR_ROWS
                : Math.max(base + TEXTAREA_MIN_ROWS, Math.min(base + PROMPT_MAX_ROWS, base + this.rows))

    if (height !== this.renderer.footerHeight) {
      this.renderer.footerHeight = height
    }
  }

  private syncRows = (value: number): void => {
    if (this.isGone) {
      return
    }

    const rows = Math.max(TEXTAREA_MIN_ROWS, Math.min(PROMPT_MAX_ROWS, value))
    if (rows === this.rows) {
      return
    }

    this.rows = rows
    if (this.view().type === "prompt") {
      this.applyHeight()
    }
  }

  private syncLayout = (next: { route: FooterPromptRoute; autocomplete: boolean; subagentRows: number }): void => {
    this.promptRoute = next.route
    this.autocomplete = next.autocomplete
    this.subagentMenuRows = next.subagentRows
    if (this.view().type === "prompt") {
      this.applyHeight()
    }
  }

  private handlePrompt = (input: RunPrompt): boolean => {
    if (this.isClosed) {
      return false
    }

    if (this.state().first) {
      this.patch({ first: false })
    }

    if (this.prompts.size === 0) {
      this.patch({ status: "input queue unavailable" })
      return false
    }

    for (const fn of [...this.prompts]) {
      fn(input)
    }

    return true
  }

  private handleQuestionReply = async (input: QuestionReply): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onQuestionReply(input)
  }

  private handleQuestionReject = async (input: QuestionReject): Promise<void> => {
    if (this.isClosed) {
      return
    }

    await this.options.onQuestionReject(input)
  }

  private clearExitTimer(): void {
    if (!this.exitTimeout) {
      return
    }

    clearTimeout(this.exitTimeout)
    this.exitTimeout = undefined
  }

  private armExitTimer(): void {
    this.clearExitTimer()
    this.exitTimeout = setTimeout(() => {
      this.exitTimeout = undefined
      if (this.isGone || this.isClosed) {
        return
      }

      this.patch({ exit: 0 })
    }, 5000)
  }

  // Interrupt is intentionally single-press: the control-plane abort owns the
  // complete Codex/gateway process-tree cancellation, not only the UI state.
  private handleInterrupt = (): boolean => {
    if (this.isClosed || this.state().phase !== "running") {
      return false
    }

    this.patch({ interrupt: 0, status: "cancelling" })
    this.options.onInterrupt?.()
    return true
  }

  private handleExit = (): boolean => {
    if (this.isClosed) {
      return true
    }

    const next = this.state().exit + 1
    this.patch({ exit: next, interrupt: 0 })

    if (next < 2) {
      this.armExitTimer()
      this.patch({ status: "Press Ctrl-c again to exit" })
      return true
    }

    this.clearExitTimer()
    this.patch({ exit: 0, status: "exiting" })
    this.close()
    this.options.onExit?.()
    return true
  }

  private handleDestroy = (): void => {
    if (this.destroyed) {
      return
    }

    this.flush()
    this.destroyed = true
    this.notifyClose()
    this.clearExitTimer()
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy)
    this.prompts.clear()
    this.closes.clear()
    this.scrollback.destroy()
  }

  // Drains the commit queue to scrollback. The surface manager owns grouping,
  // spacing, and progressive markdown/code settling so direct mode can append
  // immutable transcript rows without rewriting history.
  private flush(): void {
    if (this.isGone || this.queue.length === 0) {
      this.queue.length = 0
      return
    }

    const batch = this.queue.splice(0)
    this.flushing = this.flushing
      .then(async () => {
        for (const item of batch) {
          await this.scrollback.append(item)
        }
      })
      .catch((error) => log.warn("failed to flush run scrollback", { error, commits: batch.length }))
  }
}
