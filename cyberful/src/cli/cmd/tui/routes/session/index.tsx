// ── Interactive Session Route ────────────────────────────────────
// Renders the persisted and live session feed, tool and phase activity, prompt,
//   navigation commands, transcript actions, blockers, and scoped feature slots.
// ─────────────────────────────────────────────────────────────────

import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js"
import path from "node:path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync, type SkillFeedEntry, type ExpertPhaseEntry } from "@tui/context/sync"
import { SubsystemPhase } from "@/subsystem/phase"
import {
  continuesExpertPhaseTurn,
  expertActorCardLabel,
  expertActorStateText,
  expertActorTextLabel,
  expertPhaseDuration,
  expertPhaseLabel,
  isExpertSemanticProgress,
} from "@tui/context/expert-feed"
import type { PhaseActivityActorState } from "@/session/event-v2"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { SHELL_TOOL_ICON, ToolDisplayLabel, toolDisplayDetails, toolDisplayText } from "@tui/component/tool-label"
import { generateSubtleSyntax, selectedForeground, tint, useTheme } from "@tui/context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  TextAttributes,
  RGBA,
  type KeyEvent,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type {
  AssistantMessage,
  CompletionPart as CompletionPartData,
  Message,
  Part,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@/server/client"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import type * as Tool from "@/tool/display"
import type { ApplyPatchTool, QuestionTool, ShellTool, SkillTool, TodoWriteTool, WebFetchTool } from "@/tool/display"
import { ShellID } from "@/tool/shell/id"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { SubagentFooter } from "./subagent-footer.tsx"
import { LANGUAGE_EXTENSIONS } from "@/cli/syntax-language"
import parsers from "../../../../../../parsers-config.ts"
import * as Clipboard from "../../util/clipboard"
import { errorMessage } from "@/util/error"
import { observePromise } from "@/util/promise"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import * as Editor from "../../util/editor"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util/filesystem"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscript } from "../../util/transcript"
import { UI } from "@/cli/ui.ts"
import { useTuiConfig } from "../../context/tui-config"
import {
  nextThinkingMode,
  reasoningPreview,
  reasoningSummary,
  useThinkingMode,
  type ThinkingMode,
} from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { IdleScrollFollow } from "../../util/scroll-follow"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { TuiFeatureRuntime } from "@/cli/cmd/tui/feature/runtime"
import { assistantDisplayTimeLine, splitAssistantTimeLine } from "@/session/assistant-timestamp"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { CYBERFUL_BASE_MODE, useBindings, useCommandShortcut, useCyberfulKeymap } from "../../keymap"
import { PathFormatterProvider, usePathFormatter } from "../../context/path-format"
import { DetectedToolOutput } from "../../component/detected-tool-output"
import { cleanToolOutputText } from "@/cli/cmd/tool-output-language"
import { OpenArtifact } from "../../util/open-artifact"
import { CompletionCard } from "../../util/completion-card"
import { workareaAbsolutePath } from "@/workarea"
import { isRecord } from "@/util/record"

addDefaultParsers(parsers.parsers)

const sessionBindingCommands = [
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.undo",
  "session.redo",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.todo",
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  diffWrapMode: () => "word" | "none"
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

function userMessageValue(message: Message): UserMessage | undefined {
  return message.role === "user" ? message : undefined
}

function assistantMessageValue(message: Message): AssistantMessage | undefined {
  return message.role === "assistant" ? message : undefined
}

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const project = useProject()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const directChildren = createMemo(() =>
    sync.data.session
      .filter((x) => x.parentID === route.sessionID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  )
  const childRootID = createMemo(() => {
    const s = session()
    if (!s) return
    if (!s.parentID || directChildren().length > 0) return s.id
    return s.parentID
  })
  const children = createMemo(() => {
    const parentID = childRootID()
    if (!parentID) return []
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const childSessions = createMemo(() => {
    const parentID = childRootID()
    if (!parentID) return []
    return children().filter((x) => x.parentID === parentID)
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const workarea = createMemo(() => {
    const message = messages().findLast(
      (message) => message.role === "user" && typeof message.metadata?.workarea === "string",
    )
    const value = message?.role === "user" ? message.metadata?.workarea : undefined
    return typeof value === "string" ? value : undefined
  })
  const skills = createMemo(() => sync.data.skill[route.sessionID] ?? [])
  // Codex phase-excursion activity joins the main transcript so feedItems can interleave it by timestamp
  // with messages and skills.
  const expertPhase = createMemo(() => sync.data.expert_phase[route.sessionID] ?? [])
  const feedItems = createMemo(() =>
    [
      ...messages().map((message) => ({
        type: "message" as const,
        id: message.id,
        timestamp: message.time.created,
        message,
      })),
      ...skills().map((skill) => ({
        type: "skill" as const,
        id: skill.id,
        timestamp: skill.timestamp,
        skill,
      })),
      ...expertPhase().map((entry) => ({
        type: "expert_phase" as const,
        id: entry.id,
        timestamp: entry.timestamp,
        expertPhase: entry,
      })),
    ].toSorted((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)),
  )
  const questions = createMemo(() => {
    if (session()?.parentID && directChildren().length === 0) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const visible = createMemo(() => !session()?.parentID && questions().length === 0)
  const disabled = createMemo(() => questions().length > 0)

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })
  const dimensions = useTerminalDimensions()
  const [conceal, setConceal] = createSignal(true)
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_visible", false)
  const [diffWrapMode] = kv.signal("diff_wrap_mode", "word")
  const showTimestamps = createMemo(() => timestamps() === "show")
  const contentWidth = createMemo(() => dimensions().width - 4)
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const toast = useToast()
  const sdk = useSDK()

  createEffect(() => {
    const sessionID = route.sessionID
    const controller = new AbortController()
    onCleanup(() => controller.abort(new Error(`session route changed from ${sessionID}`)))
    observePromise(
      (async () => {
        const result = await sdk.client.session.get({ sessionID }, { throwOnError: true, signal: controller.signal })
        if (!result.data) {
          toast.show({
            message: `Session not found: ${sessionID}`,
            variant: "error",
            duration: 5000,
          })
          navigate({ type: "home" })
          return
        }

        await sync.session.sync(sessionID, { signal: controller.signal })
        if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
      })(),
      {
        rejected: (error) => {
          if (controller.signal.aborted) return
          if (route.sessionID !== sessionID) return
          toast.show({
            message: errorMessage(error),
            variant: "error",
            duration: 5000,
          })
          navigate({ type: "home" })
        },
      },
    )
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const jumpToBottomShortcut = useCommandShortcut("session.last")
  const [jumpToBottomVisible, setJumpToBottomVisible] = createSignal(false)
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keymap = useCyberfulKeymap()
  const dialog = useDialog()
  // Tracks whether the todo overlay is the current dialog, so `session.toggle.todo` can toggle it.
  const [todoDialogOpen, setTodoDialogOpen] = createSignal(false)
  const renderer = useRenderer()

  const exit = useExit()

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    const pad = (text: string) => text.padEnd(10, " ")
    const weak = (text: string) => UI.Style.TEXT_DIM + pad(text) + UI.Style.TEXT_NORMAL
    const logo = UI.logo("  ").split(/\r?\n/)
    return exit.message.set(
      [
        `${logo[0] ?? ""}`,
        `${logo[1] ?? ""}`,
        `${logo[2] ?? ""}`,
        `${logo[3] ?? ""}`,
        ``,
        `  ${weak("Session")}${UI.Style.TEXT_NORMAL_BOLD}${title}${UI.Style.TEXT_NORMAL}`,
        `  ${weak("Continue")}${UI.Style.TEXT_NORMAL_BOLD}cyberful -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        ``,
      ].join("\n"),
    )
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  // ── Explicit Bottom Navigation Restores Stream Following ───────
  // ScrollBox marks manual movement so new streamed rows do not steal the viewport.
  // Landing exactly on `scrollHeight` clears that internal state and resumes sticky
  // following. A click or keypress targets content already laid out, so the command
  // acts synchronously rather than racing another delayed scroll.
  // ─────────────────────────────────────────────────────────────────
  function scrollToBottom() {
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollTo(scroll.scrollHeight)
  }

  // ── Detached Live Views Resume After Reader Inactivity ─────────
  // ScrollBox exposes no scroll event, so one cleanup-owned poll both maintains
  // the jump affordance and observes position changes as reader activity. While
  // work is live, a detached position that remains unchanged for sixty seconds
  // returns to the bottom and restores sticky following. Idle sessions never move
  // on their own, preserving deliberate review of completed transcripts.
  // ─────────────────────────────────────────────────────────────────
  onMount(() => {
    const idleScrollFollow = new IdleScrollFollow()
    const update = () => {
      if (!scroll || scroll.isDestroyed) {
        setJumpToBottomVisible(false)
        return
      }
      const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
      const detached = maxScrollTop > 1 && scroll.scrollTop < maxScrollTop - 1
      setJumpToBottomVisible(detached)
      const active =
        sync.data.session_status[route.sessionID]?.type === "busy" ||
        Boolean(sync.data.expert_phase_running[route.sessionID])
      if (!idleScrollFollow.observe({ active, detached, now: performance.now(), scrollTop: scroll.scrollTop })) return
      scrollToBottom()
      setJumpToBottomVisible(false)
    }
    update()
    const timer = setInterval(update, 120)
    onCleanup(() => clearInterval(timer))
  })

  function moveFirstChild() {
    const next = childSessions()[0]
    if (next) {
      navigate({
        type: "session",
        sessionID: next.id,
      })
    }
  }

  function moveChild(direction: number) {
    const sessions = childSessions()
    if (sessions.length === 0) return

    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) {
      navigate({
        type: "session",
        sessionID: sessions[next].id,
      })
    }
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: "Rename session",
      value: "session.rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      run: () => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      run: () => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      run: () => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      run: async () => {
        try {
          const status = sync.data.session_status?.[route.sessionID]
          if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID })
          const revert = session()?.revert?.messageID
          const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
          if (!message) return
          await sdk.client.session.revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          toBottom()
          const parts = sync.data.part[message.id]
          prompt?.set(
            parts.reduce<PromptInfo>(
              (agg, part) => {
                if (part.type === "text") {
                  if (!part.synthetic) agg.input += part.text
                }
                if (part.type === "file") agg.parts.push(part)
                return agg
              },
              { input: "", parts: [] },
            ),
          )
          dialog.clear()
        } catch (error) {
          toast.show({ message: errorMessage(error), variant: "error" })
        }
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      run: async () => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
        try {
          if (!message) {
            await sdk.client.session.unrevert({
              sessionID: route.sessionID,
            })
            prompt?.set({ input: "", parts: [] })
            return
          }
          await sdk.client.session.revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
        } catch (error) {
          toast.show({ message: errorMessage(error), variant: "error" })
        }
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      category: "Session",
      run: () => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      run: () => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      run: () => {
        thinking.set(nextThinkingMode(thinkingMode()))
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      category: "Session",
      run: () => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      category: "Session",
      run: () => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle todo list",
      value: "session.toggle.todo",
      category: "Session",
      slash: { name: "todo" },
      // Toggle: the footer pill and this command share one target. `todoDialogOpen` is kept in sync by
      // the onClose passed to `dialog.replace` below, so escape/backdrop-dismiss also flip it back —
      // pressing the key again always mirrors the visible state rather than stacking a second dialog.
      run: () => {
        if (todoDialogOpen()) {
          dialog.clear()
          return
        }
        setTodoDialogOpen(true)
        dialog.replace(
          () => <DialogTodo sessionID={route.sessionID} />,
          () => setTodoDialogOpen(false),
        )
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      category: "Session",
      hidden: true,
      run: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        observePromise(Clipboard.copy(text), {
          fulfilled: () => toast.show({ message: "Message copied to clipboard!", variant: "success" }),
          rejected: () => toast.show({ message: "Failed to copy to clipboard", variant: "error" }),
        })
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
            },
          )
          await Clipboard.copy(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()

          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({
              value: transcript,
              renderer,
              cwd: project.instance.path().worktree || project.instance.directory() || process.cwd(),
            })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Filesystem.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({
              value: transcript,
              renderer,
              cwd: project.instance.path().worktree || project.instance.directory() || process.cwd(),
            })
            if (result !== undefined) {
              await Filesystem.write(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        moveFirstChild()
        dialog.clear()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        moveChild(1)
        dialog.clear()
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        moveChild(-1)
        dialog.clear()
      }),
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      namespace: "palette",
      name: command.value,
      desc: "description" in command ? command.description : undefined,
      slashName: "slash" in command ? command.slash?.name : undefined,
      slashAliases: "slash" in command ? command.slash?.aliases : undefined,
      ...command,
    })),
  )

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  useBindings(() => ({
    mode: CYBERFUL_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <PathFormatterProvider path={session()?.directory}>
      <context.Provider
        value={{
          get width() {
            return contentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          thinkingMode,
          showThinking,
          showTimestamps,
          showDetails,
          diffWrapMode,
          sync,
          tui: tuiConfig,
        }}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
            <Show when={session()}>
              {/* Relative parent so the floating Jump-to-bottom button anchors to the
                  bottom of the feed (just above the prompt), not the whole column. */}
              <box position="relative" flexGrow={1} flexShrink={1} minHeight={0}>
                <scrollbox
                  ref={(r) => (scroll = r)}
                  viewportOptions={{
                    paddingRight: showScrollbar() ? 1 : 0,
                  }}
                  verticalScrollbarOptions={{
                    paddingLeft: 1,
                    visible: showScrollbar(),
                    trackOptions: {
                      backgroundColor: theme.backgroundElement,
                      foregroundColor: theme.border,
                    },
                  }}
                  stickyScroll={true}
                  stickyStart="bottom"
                  flexGrow={1}
                  scrollAcceleration={scrollAcceleration()}
                >
                  <box height={1} />
                  <For each={feedItems()}>
                    {(entry, index) => (
                      <Switch>
                        <Match when={entry.type === "skill" ? entry.skill : undefined}>
                          {(skill) => <SkillLearnedMessage entry={skill()} />}
                        </Match>
                        <Match when={entry.type === "expert_phase" ? entry.expertPhase : undefined}>
                          {(phase) => {
                            // Public prose starts a fresh Agent-style turn inside a long Codex phase. Its
                            // following tools stay under that header until the next public update.
                            const items = feedItems()
                            const phaseEntry = (o: (typeof items)[number] | undefined) =>
                              o?.type === "expert_phase" ? o.expertPhase : undefined
                            return (
                              <ExpertPhaseRow
                                entry={phase()}
                                workflow={session()?.workflow}
                                showHeader={!continuesExpertPhaseTurn(phaseEntry(items[index() - 1]), phase())}
                                showFooter={!continuesExpertPhaseTurn(phase(), phaseEntry(items[index() + 1]))}
                              />
                            )
                          }}
                        </Match>
                        <Match when={entry.type === "message" ? entry.message : undefined}>
                          {(message) => (
                            <Switch>
                              <Match when={message().id === revert()?.messageID ? revert() : undefined}>
                                {(currentRevert) => {
                                  const redoShortcut = useCommandShortcut("session.redo")
                                  const [hover, setHover] = createSignal(false)
                                  const dialog = useDialog()

                                  const handleUnrevert = async () => {
                                    const confirmed = await DialogConfirm.show(
                                      dialog,
                                      "Confirm Redo",
                                      "Are you sure you want to restore the reverted messages?",
                                    )
                                    if (confirmed) {
                                      keymap.dispatchCommand("session.redo")
                                    }
                                  }

                                  return (
                                    <box
                                      onMouseOver={() => setHover(true)}
                                      onMouseOut={() => setHover(false)}
                                      onMouseUp={handleUnrevert}
                                      marginTop={1}
                                      flexShrink={0}
                                      border={["left"]}
                                      customBorderChars={SplitBorder.customBorderChars}
                                      borderColor={theme.backgroundPanel}
                                    >
                                      <box
                                        paddingTop={1}
                                        paddingBottom={1}
                                        paddingLeft={2}
                                        backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                                      >
                                        <text fg={theme.textMuted}>
                                          {currentRevert().reverted.length} message reverted
                                        </text>
                                        <text fg={theme.textMuted}>
                                          <span style={{ fg: theme.text }}>{redoShortcut()}</span> or /redo to restore
                                        </text>
                                        <Show when={currentRevert().diffFiles.length}>
                                          <box marginTop={1}>
                                            <For each={currentRevert().diffFiles}>
                                              {(file) => (
                                                <text fg={theme.text}>
                                                  {file.filename}
                                                  <Show when={file.additions > 0}>
                                                    <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                                  </Show>
                                                  <Show when={file.deletions > 0}>
                                                    <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                                  </Show>
                                                </text>
                                              )}
                                            </For>
                                          </box>
                                        </Show>
                                      </box>
                                    </box>
                                  )
                                }}
                              </Match>
                              <Match
                                when={revertMessageID() !== undefined && message().id >= (revertMessageID() ?? "")}
                              >
                                <></>
                              </Match>
                              <Match when={userMessageValue(message())}>
                                {(current) => (
                                  <UserMessage
                                    index={index()}
                                    onMouseUp={() => {
                                      if (renderer.getSelection()?.getSelectedText()) return
                                      dialog.replace(() => (
                                        <DialogMessage
                                          messageID={current().id}
                                          sessionID={route.sessionID}
                                          setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                                        />
                                      ))
                                    }}
                                    message={current()}
                                    parts={sync.data.part[current().id] ?? []}
                                  />
                                )}
                              </Match>
                              <Match when={assistantMessageValue(message())}>
                                {(current) => (
                                  <AssistantMessage
                                    last={lastAssistant()?.id === current().id}
                                    message={current()}
                                    parts={sync.data.part[current().id] ?? []}
                                  />
                                )}
                              </Match>
                            </Switch>
                          )}
                        </Match>
                      </Switch>
                    )}
                  </For>
                </scrollbox>
              </box>
              <box flexShrink={0}>
                <Show when={questions().length > 0}>
                  <QuestionPrompt request={questions()[0]} />
                </Show>
                <Show when={session()?.parentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <TuiFeatureRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID}
                    visible={visible()}
                    disabled={disabled()}
                    on_submit={toBottom}
                    ref={bind}
                  >
                    <Prompt
                      visible={visible()}
                      ref={bind}
                      disabled={disabled()}
                      onSubmit={() => {
                        toBottom()
                      }}
                      sessionID={route.sessionID}
                      workarea={workarea()}
                      jumpToBottom={{
                        visible: jumpToBottomVisible,
                        shortcut: jumpToBottomShortcut,
                        onJump: scrollToBottom,
                      }}
                      right={<TuiFeatureRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                    />
                  </TuiFeatureRuntime.Slot>
                </Show>
              </box>
            </Show>
            <Toast />
          </box>
        </box>
      </context.Provider>
    </PathFormatterProvider>
  )
}

// ── Expert Phase Activity Row ─────────────────────────────────────
// While Codex runs a pentest phase it streams what it is doing — each
// tool it calls and short prose snippets. These used to scroll inside the panel; merged into the
// feed they arrive as a burst of cheap single-line rows the reader can watch in place. A "tool" item
// names the tool it called; a "text" item is a flattened snippet. The colored ◇ phase label identifies
// the active owner, while the muted suffix names the subsystem that emitted this group. Delegated actors
// retain a stable label on every row and publish explicit lifecycle transitions.
// ─────────────────────────────────────────────────────────────────
function ExpertPhaseRow(props: {
  entry: ExpertPhaseEntry
  workflow?: string
  showHeader: boolean
  showFooter: boolean
}) {
  const { theme } = useTheme()
  // The emitting subsystem supplies its own descriptor; phase ownership controls only the marker tone.
  // Unknown workflow labels remain neutral instead of implying another inference owner.
  const isExpert = () =>
    props.workflow ? SubsystemPhase.phaseOwner(props.workflow, props.entry.phase) === "expert" : false
  const markerColor = () => (isExpert() ? theme.info : theme.textMuted)
  const actorLabel = () => props.entry.actor?.label
  const actorLabelColor = () => tint(theme.textMuted, theme.text, 0.12)
  const actorStateColor = (state: PhaseActivityActorState) => {
    if (state === "completed") return theme.success
    if (state === "interrupted") return theme.warning
    if (state === "failed") return theme.error
    return theme.info
  }
  const actorStateIcon = (state: PhaseActivityActorState) => {
    if (state === "started") return "◇"
    if (state === "active") return "◆"
    if (state === "interacted") return "↔"
    if (state === "completed") return "✓"
    if (state === "interrupted") return "!"
    return "✕"
  }
  // A standalone "output" (a call whose tool frame was dropped) collapses to the first few lines and
  // expands on click. The paired-tool case never reaches this — its output is merged into the card below.
  const renderer = useRenderer()
  const [outputOpen, setOutputOpen] = createSignal(false)
  const outputPreview = createMemo(() => expertPreview(props.entry.text, EXPERT_OUTPUT_PREVIEW_LINES))
  // Synthetic ToolPart props let a phase-feed tool render through the same GenericTool as session tools.
  const toolPart = createMemo<ToolPart>(() => {
    const e = props.entry
    const input = isRecord(e.input) ? e.input : {}
    return {
      id: e.id,
      sessionID: e.sessionID,
      messageID: `expert-${e.id}`,
      type: "tool",
      callID: e.callID || e.id,
      tool: e.tool,
      state:
        e.output !== undefined
          ? {
              status: "completed",
              input,
              output: e.output,
              title: e.tool,
              metadata: {},
              time: { start: e.timestamp, end: e.timestamp },
            }
          : { status: "running", input, time: { start: e.timestamp } },
    }
  })
  const toolProps = {
    get input() {
      return isRecord(props.entry.input) ? props.entry.input : {}
    },
    get metadata() {
      return {}
    },
    get tool() {
      return props.entry.tool
    },
    get output() {
      return props.entry.output
    },
    get part() {
      return toolPart()
    },
    get blockMarginTop() {
      return actorLabel() ? 0 : undefined
    },
  }
  return (
    <>
      {/* One `◇ phase · codex v<version>` header per public progress turn — the same shape AssistantMessage gives an
          Agent turn, so long sequential phases stay readable without repeating the marker on every tool. */}
      <Show when={props.showHeader}>
        <box marginTop={1} paddingLeft={3} flexShrink={0}>
          <text wrapMode="none" truncate>
            <span style={{ fg: markerColor() }}>{`◇ ${props.entry.phase}`}</span>
            <span style={{ fg: theme.textMuted }}>{` · ${props.entry.subsystem.label}`}</span>
          </text>
        </box>
      </Show>
      <Switch>
        <Match when={props.entry.kind === "agent" ? props.entry.actorState : undefined}>
          {(state) => (
            <box marginTop={1} paddingLeft={3} flexShrink={0}>
              <text wrapMode="none" truncate>
                <span style={{ fg: actorStateColor(state()) }}>{`${actorStateIcon(state())} `}</span>
                <span style={{ fg: actorLabelColor() }}>{actorLabel()}</span>
                <span style={{ fg: theme.textMuted }}>{` · ${expertActorStateText(state())}`}</span>
              </text>
            </box>
          )}
        </Match>
        <Match when={props.entry.kind === "tool"}>
          {/* The Expert's tool through the SAME GenericTool the Agent gets for a cyberful-os/browser tool
              (nuclei/httpx/browser_*): a terminal-style card with bounded output that expands on click.
              Identical card = identical read across an Expert phase and an Agent turn. */}
          <box paddingLeft={3} flexDirection="column" flexShrink={0}>
            <Show when={actorLabel()}>
              {(label) => (
                <text marginTop={2} wrapMode="none" truncate>
                  <span style={{ fg: actorLabelColor() }}>{expertActorCardLabel(label())}</span>
                </text>
              )}
            </Show>
            <Show
              when={props.entry.tool === "shell" || props.entry.tool === ShellID.ToolID}
              fallback={<GenericTool {...toolProps} />}
            >
              <Shell {...toolProps} />
            </Show>
          </box>
        </Match>
        <Match when={props.entry.kind === "output"}>
          {/* A result whose tool call never streamed (a dropped frame) — keep the old dimmed, collapsible
              block so the output is still reachable even though it could not become a card. */}
          <box
            paddingLeft={9}
            flexDirection="column"
            onMouseUp={() => {
              if (renderer.getSelection()?.getSelectedText()) return
              setOutputOpen((v) => !v)
            }}
          >
            <Show when={actorLabel()}>
              {(label) => (
                <text marginTop={2} wrapMode="none" truncate>
                  <span style={{ fg: actorLabelColor() }}>{expertActorCardLabel(label())}</span>
                </text>
              )}
            </Show>
            <Show
              when={outputOpen()}
              fallback={
                <For each={outputPreview().body.split("\n")}>
                  {(line) => (
                    <text wrapMode="none" truncate>
                      <span style={{ fg: theme.textMuted }}>{line}</span>
                    </text>
                  )}
                </For>
              }
            >
              <text wrapMode="word">
                <span style={{ fg: theme.textMuted }}>{props.entry.text}</span>
              </text>
            </Show>
            <Show when={outputOpen() || outputPreview().hidden > 0}>
              <text>
                <span style={{ fg: theme.textMuted }}>
                  {outputOpen() ? "click to collapse" : `…  ＋${outputPreview().hidden} more lines · click to expand`}
                </span>
              </text>
            </Show>
          </box>
        </Match>
        <Match when={props.entry.kind === "status"}>
          {/* Host-authored terminal telemetry remains raw when it is not the final phase status. Vertical
              spacing keeps transport JSON distinct from the neighboring tool card and actor attribution. */}
          <Show
            when={props.entry.phaseStatus?.ok ? props.entry.phaseStatus : undefined}
            fallback={
              <box marginTop={2} marginBottom={2} paddingLeft={3} flexShrink={0}>
                <text wrapMode="word">
                  <span style={{ fg: isExpertSemanticProgress(props.entry.text) ? theme.info : theme.warning }}>
                    {props.entry.text}
                  </span>
                </text>
              </box>
            }
          >
            {(status) => (
              <box flexDirection="column" flexShrink={0}>
                <box paddingLeft={3}>
                  <text wrapMode="none" truncate>
                    <span style={{ fg: theme.textMuted }}>✓ </span>
                    <span style={{ fg: markerColor() }}>{expertPhaseLabel(props.entry.phase)}</span>
                    <span style={{ fg: theme.textMuted }}> · </span>
                    <span style={{ fg: theme.success }}>Phase completed</span>
                    <span style={{ fg: theme.textMuted }}>{` · ${expertPhaseDuration(status().durationMs)}`}</span>
                  </text>
                </box>
                <Show when={status().warnings[0]}>
                  {(warning) => (
                    <box paddingLeft={5}>
                      <text wrapMode="word">
                        <span style={{ fg: theme.textMuted }}>
                          {`⚠ ${warning()}${status().warnings.length > 1 ? ` (+${status().warnings.length - 1})` : ""}`}
                        </span>
                      </text>
                    </box>
                  )}
                </Show>
                <Show when={status().handoff?.successor}>
                  {(successor) => (
                    <box marginTop={1} paddingLeft={3}>
                      <text wrapMode="none" truncate>
                        <span style={{ fg: theme.textMuted }}>
                          {`─────────────────────────  ${expertPhaseLabel(successor())}  ─────────────────────────`}
                        </span>
                      </text>
                    </box>
                  )}
                </Show>
              </box>
            )}
          </Show>
        </Match>
        <Match when={true}>
          {/* Root prose stays plain; delegated prose carries the same actor label as its tool rows. */}
          <box marginTop={actorLabel() ? 1 : 0} paddingLeft={3} flexShrink={0}>
            <text wrapMode="word">
              <Show when={actorLabel()}>
                {(label) => <span style={{ fg: actorLabelColor() }}>{expertActorTextLabel(label())}</span>}
              </Show>
              <span style={{ fg: theme.text }}>{props.entry.text}</span>
            </text>
          </box>
        </Match>
      </Switch>
      {/* Close the phase run with the Agent's `▣ Titlecase(phase)` footer on the last row. */}
      <Show when={props.showFooter && props.entry.kind !== "status"}>
        <box paddingLeft={3} flexShrink={0}>
          <text marginTop={1} wrapMode="none" truncate>
            <span style={{ fg: markerColor() }}>▣ </span>
            <span style={{ fg: theme.text }}>{Locale.titlecase(props.entry.phase)}</span>
          </text>
        </box>
      </Show>
    </>
  )
}

// ── Phase Prose Uses A Stable Expandable Preview ─────────────────
// Public phase replies can be long enough to dominate the session feed. The card
// keeps the first newline-delimited rows and reports exactly how many remain so
// expansion never loses content. Source lines, rather than terminal wraps, keep
// the preview deterministic across viewport widths.
// ─────────────────────────────────────────────────────────────────
function expertPreview(text: string, maxLines: number): { body: string; hidden: number } {
  const lines = text.replace(/\s+$/, "").split("\n")
  if (lines.length <= maxLines) return { body: text.trimEnd(), hidden: 0 }
  return { body: lines.slice(0, maxLines).join("\n"), hidden: lines.length - maxLines }
}

// A standalone phase-tool output collapses to this many lines and expands on click.
const EXPERT_OUTPUT_PREVIEW_LINES = 5

// ── Todo Details Do Not Steal Feed Width ─────────────────────────
// Todos open on demand instead of reserving a permanent side column, leaving the
// activity feed at full width. The dialog limits itself to sixty percent of the
// terminal and scrolls internally, so a long task list cannot push controls beyond
// the viewport while remaining fully inspectable.
// ─────────────────────────────────────────────────────────────────
function DialogTodo(props: { sessionID: string }) {
  const sync = useSync()
  const tuiConfig = useTuiConfig()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const todos = createMemo(() => sync.data.todo[props.sessionID] ?? [])

  return (
    <box
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="column"
      minHeight={0}
      maxHeight={Math.floor(dimensions().height * 0.6)}
    >
      <scrollbox
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        stickyScroll={false}
        scrollAcceleration={scrollAcceleration()}
        verticalScrollbarOptions={{ visible: false }}
      >
        <box width="100%" flexShrink={0} gap={1} paddingRight={1}>
          <text fg={theme.text}>
            <b>Todo</b>
          </text>
          <For each={todos()}>{(item) => <TodoItem status={item.status} content={item.content} />}</For>
        </box>
      </scrollbox>
    </box>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

function SkillLearnedMessage(props: { entry: SkillFeedEntry }) {
  const { theme } = useTheme()
  const skills = createMemo(() => props.entry.skills.join(", "))
  return (
    <box id={props.entry.id} marginTop={1} paddingLeft={3} paddingTop={1} paddingBottom={1} flexShrink={0}>
      <text fg={theme.success} wrapMode="none">
        <span style={{ fg: theme.success }}>✦ </span>
        <span style={{ fg: theme.success, italic: true }}>Skill learned</span>
        <span style={{ fg: theme.textMuted }}>: {skills()}</span>
      </text>
    </box>
  )
}

function UserMessage(props: { message: UserMessage; parts: Part[]; onMouseUp: () => void; index: number }) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.message.metadata?.delivery === "deferred")
  const color = createMemo(() => local.agent.color(props.message.agent))
  const badgeLabel = createMemo(() => (queued() ? "QUEUED" : undefined))
  const badgeColor = createMemo(() => theme.warning)
  const badgeFg = createMemo(() => selectedForeground(theme, badgeColor()))
  const metadataVisible = createMemo(() => badgeLabel() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={text()}>
        <box
          id={props.message.id}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()}</text>
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={badgeLabel()}
              fallback={
                <Show when={ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              {(label) => (
                <text fg={theme.textMuted}>
                  <span style={{ bg: badgeColor(), fg: badgeFg(), bold: true }}> {label()} </span>
                </text>
              )}
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          marginTop={1}
          border={["top"]}
          title=" Compaction "
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean }) {
  const local = useLocal()
  const { theme } = useTheme()
  const visibleParts = createMemo(() => props.parts.filter((part) => !isLiveTailPart(part)))

  const childShortcut = useCommandShortcut("session.child.first", " then ")

  return (
    <>
      <For each={visibleParts()}>
        {(part, index) => {
          return (
            <Switch>
              <Match when={part.type === "text" ? part : undefined}>
                {(textPart) => (
                  <TextPart last={index() === visibleParts().length - 1} part={textPart()} message={props.message} />
                )}
              </Match>
              <Match when={part.type === "completion" ? part : undefined}>
                {(completionPart) => <CompletionPart part={completionPart()} message={props.message} />}
              </Match>
              <Match when={part.type === "tool" ? part : undefined}>
                {(toolPart) => (
                  <ToolPart last={index() === visibleParts().length - 1} part={toolPart()} message={props.message} />
                )}
              </Match>
              <Match when={part.type === "reasoning" ? part : undefined}>
                {(reasoningPart) => (
                  <ReasoningPart
                    last={index() === visibleParts().length - 1}
                    part={reasoningPart()}
                    message={props.message}
                  />
                )}
              </Match>
            </Switch>
          )
        }}
      </For>
      <Show when={visibleParts().some((x) => x.type === "tool" && x.tool === "task")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {childShortcut()}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
        </box>
      </Show>
      <Switch>
        <Match when={props.last && !visibleParts().some((part) => part.type === "completion")}>
          <box paddingLeft={3}>
            <text marginTop={1} wrapMode="none" truncate>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
            </text>
          </box>
        </Match>
      </Switch>
    </>
  )
}

function isLiveTailPart(part: Part): boolean {
  return part.type === "text" && part.metadata?.liveTail === true
}

function CompletionPart(props: { part: CompletionPartData; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const toast = useToast()
  const [hovered, setHovered] = createSignal<string>()
  const [focused, setFocused] = createSignal<string>()
  const color = createMemo(() => {
    const tone = CompletionCard.tone(props.part.outcome)
    return tone === "success" ? theme.success : tone === "error" ? theme.error : theme.warning
  })
  const label = createMemo(() => CompletionCard.statusLabel(props.part.outcome))
  const root = createMemo(() =>
    props.part.workarea ? workareaAbsolutePath(props.message.path.cwd, props.part.workarea) : props.message.path.cwd,
  )
  const open = (artifact: CompletionPartData["artifacts"][number]) => {
    observePromise(OpenArtifact.openArtifact(root(), artifact.path), {
      fulfilled: () => toast.show({ message: `Opened ${artifact.label}`, variant: "success", duration: 2500 }),
      rejected: (error) => toast.show({ message: errorMessage(error), variant: "error", duration: 6000 }),
    })
  }

  return (
    <box
      id={`completion-${props.part.id}`}
      marginTop={1}
      marginLeft={3}
      marginRight={1}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      border={true}
      borderStyle="rounded"
      borderColor={color()}
      backgroundColor={theme.backgroundPanel}
      flexDirection="column"
      flexShrink={0}
    >
      <text wrapMode="none" truncate>
        <span style={{ fg: color(), attributes: TextAttributes.BOLD }}>{label()} </span>
        <span style={{ fg: theme.text, attributes: TextAttributes.BOLD }}>{props.part.title}</span>
      </text>
      <box marginTop={1}>
        <markdown
          syntaxStyle={syntax()}
          streaming={false}
          internalBlockMode="top-level"
          content={props.part.summaryMarkdown}
          conceal={ctx.conceal()}
          fg={theme.markdownText}
          bg={theme.backgroundPanel}
        />
      </box>
      <Show when={props.part.artifacts.length > 0}>
        <box marginTop={1} flexDirection="column">
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            Artifacts
          </text>
          <For each={props.part.artifacts}>
            {(artifact) => (
              <box
                marginTop={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  hovered() === artifact.path || focused() === artifact.path
                    ? theme.backgroundElement
                    : theme.backgroundPanel
                }
                focusable={true}
                on:focused={() => setFocused(artifact.path)}
                on:blurred={() => setFocused(undefined)}
                onMouseOver={() => setHovered(artifact.path)}
                onMouseOut={() => setHovered(undefined)}
                onMouseDown={(event) => event.target?.focus()}
                onMouseUp={() => open(artifact)}
                onKeyDown={(event: KeyEvent) => {
                  if (event.name !== "return") return
                  event.preventDefault()
                  open(artifact)
                }}
              >
                <text wrapMode="none" truncate>
                  <span style={{ fg: color() }}>{artifact.mime === "application/pdf" ? "PDF" : "FILE"} </span>
                  <span style={{ fg: theme.text, attributes: TextAttributes.UNDERLINE }}>{artifact.label}</span>
                  <span style={{ fg: theme.textMuted }}> {artifact.path}</span>
                </text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function ReasoningPart(props: { last: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme } = useTheme()
  const ctx = use()
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => {
    // Some providers redact encrypted reasoning blocks; drop the placeholder.
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  // Reasoning is finalized when the server sets `time.end` (see processor.ts).
  // Flips independently of the parent message completing.
  const isDone = createMemo(() => props.part.time.end !== undefined)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const summary = createMemo(() => reasoningSummary(content()))
  const open = createMemo(() => !inMinimal() || expanded())
  const body = createMemo(() => {
    if (!summary().body) return ""
    if (open()) return summary().body
    return reasoningPreview(summary().body)
  })
  const syntax = createMemo(() => generateSubtleSyntax(theme))

  const toggle = () => {
    if (!inMinimal()) return
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={content()}>
      <box
        id={"text-" + props.part.id}
        paddingLeft={3}
        marginTop={1}
        flexDirection="column"
        flexShrink={0}
        onMouseUp={toggle}
      >
        <box>
          <ReasoningHeader
            toggleable={inMinimal()}
            open={open()}
            done={isDone()}
            title={summary().title}
            duration={isDone() ? Locale.duration(duration()) : undefined}
          />
        </box>
        <Show when={body()}>
          <box paddingLeft={inMinimal() ? 2 : 0} marginTop={1}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={body()}
              conceal={ctx.conceal()}
              fg={theme.textMuted}
            />
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  duration?: string
}) {
  const { theme } = useTheme()
  const fg = () =>
    props.open
      ? RGBA.fromValues(theme.warning.r, theme.warning.g, theme.warning.b, theme.thinkingOpacity)
      : theme.warning

  return (
    <text fg={fg()} wrapMode="none">
      <Show when={props.toggleable}>
        <span>{props.open ? "- " : "+ "}</span>
      </Show>
      <span>{props.done ? "Thought" : "Thinking"}</span>
      <Show when={props.title || props.duration}>
        <span>: </span>
      </Show>
      <Show when={props.title}>
        <span>{props.title}</span>
      </Show>
      <Show when={props.duration}>
        <span>
          {props.title ? " · " : ""}
          {props.duration}
        </span>
      </Show>
    </text>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const content = createMemo(() => splitAssistantTimeLine(props.part.text))
  const text = createMemo(() => content().text.trim())
  const timestamp = createMemo(() => content().timestamp)
  return (
    <Show when={text() || timestamp()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Show when={text()}>
          <markdown
            syntaxStyle={syntax()}
            streaming={true}
            internalBlockMode="top-level"
            content={text()}
            tableOptions={{ style: "grid" }}
            conceal={ctx.conceal()}
            fg={theme.markdownText}
            bg={theme.background}
          />
        </Show>
        <Show when={timestamp()}>
          {(value) => (
            <text marginTop={text() ? 1 : 0} fg={theme.textMuted}>
              {assistantDisplayTimeLine(value())}
            </text>
          )}
        </Show>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      <Switch>
        <Match when={props.part.tool === ShellID.ToolID || props.part.tool === "shell"}>
          <Shell {...toolprops} />
        </Match>
        <Match when={props.part.tool === "webfetch"}>
          <WebFetch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "apply_patch"}>
          <ApplyPatch {...toolprops} />
        </Match>
        <Match when={props.part.tool === "todowrite"}>
          <TodoWrite {...toolprops} />
        </Match>
        <Match when={props.part.tool === "question"}>
          <Question {...toolprops} />
        </Match>
        <Match when={props.part.tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
    </Show>
  )
}

type ToolProps<T> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  tool: string
  output?: string
  part: ToolPart
  blockMarginTop?: number
}
function GenericTool(props: ToolProps<Tool.Info>) {
  const ctx = use()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const inputText = createMemo(() => toolDisplayDetails(props.tool, props.input))
  const display = createMemo(() => toolDisplayText(props.tool, inputText()))
  const output = createMemo(() => props.output?.trim() ?? "")
  const liveOutput = createMemo(() => stringValue(props.metadata.output)?.trim() || "")
  const visibleOutput = createMemo(() => output() || liveOutput())
  const inputRecord = createMemo(() => (isRecord(props.input) ? props.input : {}))
  const filePath = createMemo(() => stringValue(inputRecord().filePath) ?? stringValue(inputRecord().path))
  const { theme } = useTheme()
  // Generic/MCP tools always use the terminal-style block card. Their output shows at most
  // OUTPUT_MAX_LINES lines and expands to the rest on click, so a single HTTP dump or scan cannot flood
  // the transcript while the card remains visually consistent for short and long results.
  const OUTPUT_MAX_LINES = 10
  const [expanded, setExpanded] = createSignal(false)
  const maxChars = createMemo(() => OUTPUT_MAX_LINES * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(visibleOutput(), OUTPUT_MAX_LINES, maxChars()))
  const limited = createMemo(() => (expanded() || !collapsed().overflow ? visibleOutput() : collapsed().output))

  return (
    <BlockTool
      title={`${SHELL_TOOL_ICON} ${display()}`}
      titleView={<ToolDisplayLabel prefix={`${SHELL_TOOL_ICON} `} name={props.tool} input={inputText()} />}
      part={props.part}
      spinner={isRunning()}
      marginTop={props.blockMarginTop}
      onClick={collapsed().overflow ? () => setExpanded((value) => !value) : undefined}
    >
      <box gap={1}>
        <Show when={visibleOutput()}>
          <DetectedToolOutput
            content={limited()}
            detectContent={visibleOutput()}
            filePath={filePath()}
            tool={props.tool}
          />
        </Show>
        <Show when={collapsed().overflow}>
          <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
        </Show>
      </box>
    </BlockTool>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: string | number | boolean | undefined
  pending: string
  spinner?: boolean
  children: JSX.Element
  part: ToolPart
}) {
  let element: BoxRenderable | undefined
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const fg = createMemo(() => (props.complete ? theme.textMuted : theme.text))

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(() => error()?.includes("QuestionRejectedError") || error()?.includes("user dismissed"))

  return (
    <box
      ref={(value) => {
        element = value
      }}
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={() => {
        const el = element
        if (!el) return
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={fg()} children={props.children} />
        </Match>
        <Match when={true}>
          <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
            <Show fallback={<>~ {props.pending}</>} when={props.complete}>
              <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
            </Show>
          </text>
        </Match>
      </Switch>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function BlockTool(props: {
  title: string
  titleView?: JSX.Element
  children: JSX.Element
  onClick?: () => void
  part?: ToolPart
  spinner?: boolean
  marginTop?: number
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={props.marginTop ?? 1}
      gap={1}
      backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.background}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <text paddingLeft={3} fg={theme.textMuted}>
            {props.titleView ?? props.title}
          </text>
        }
      >
        <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      {props.children}
      <Show when={error()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function Shell(props: ToolProps<ShellTool>) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const rawOutput = createMemo(() => props.metadata.output ?? props.output)
  const output = createMemo(() => cleanToolOutputText(rawOutput()?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined
    return pathFormatter.format(workdir)
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  return (
    <Switch>
      <Match when={rawOutput() !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          spinner={isRunning()}
          marginTop={props.blockMarginTop}
          onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <DetectedToolOutput
              command={props.input.command}
              content={`$ ${props.input.command}`}
              forceFiletype="bash"
              wrapMode="none"
            />
            <Show when={output()}>
              <DetectedToolOutput
                command={props.input.command}
                content={limited()}
                detectContent={output()}
                tool="bash"
              />
            </Show>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function WebFetch(props: ToolProps<WebFetchTool>) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={props.input.url} part={props.part}>
      WebFetch {props.input.url}
    </InlineTool>
  )
}

function ApplyPatch(props: ToolProps<ApplyPatchTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.patch} filePath={file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<QuestionTool>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<SkillTool>) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={props.input.name} part={props.part}>
      Skill "{props.input.name}"
    </InlineTool>
  )
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
