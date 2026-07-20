// ── Session Composer ─────────────────────────────────────────────
// Collects user input and renders the active workflow, phase, progress, and
//   submission controls for new and resumed sessions.
// → cyberful/src/subsystem/phase.ts — resolves workflow and phase identity.
// ─────────────────────────────────────────────────────────────────

import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  TextAttributes,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match } from "solid-js"
import "opentui-spinner/solid"
import path from "node:path"
import { stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Filesystem } from "@/util/filesystem"
import { useLocal } from "@tui/context/local"
import { selectedForeground, tint, useTheme } from "@tui/context/theme"
import { EmptyBorder, SplitBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { MessageID, PartID } from "@/session/schema"
import { createStore, produce, unwrap } from "solid-js/store"
import { usePromptHistory, type PromptInfo } from "./history"
import { computePromptTraits } from "./traits"
import { assign, expandPastedTextPlaceholders } from "./part"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, type JSX } from "@opentui/solid"
import { useExit } from "../../context/exit"
import * as Clipboard from "../../util/clipboard"
import type { AssistantMessage, FilePart, Part, UserMessage } from "@/server/client"
import { TuiEvent } from "../../event"
import { iife } from "@/util/iife"
import { SubsystemPhase } from "@/subsystem/phase"
import { Locale } from "@/util/locale"
import { BOUNCING_BAR_FRAMES, BOUNCING_BAR_INTERVAL, bouncingBarColors } from "../../ui/spinner.ts"
import { useDialog } from "@tui/ui/dialog"
import { GenerationProgress } from "@/dependency/generation-progress"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { useAnimationsEnabled } from "../../context/animation"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { useArgs } from "@tui/context/args"
import { CYBERFUL_BASE_MODE, useBindings, useCommandShortcut, useLeaderActive, useCyberfulKeymap } from "../../keymap"
import { useTuiConfig } from "../../context/tui-config"
import { ensureWorkarea, setLastWorkarea, workareaProjectRoot, workareaSystemPrompt } from "@/workarea"
import { DockerPreflight } from "@/dependency/docker-preflight"
import * as Log from "@/util/log"
import { ClearInput } from "@tui/component/clear-input"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  canSubmit?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showMetadata?: boolean
  metadata?: "full" | "agent" | false
  showPlaceholder?: boolean
  autoFocus?: boolean
  workarea?: string
  label?: string
  jumpToBottom?: {
    visible: () => boolean
    shortcut: () => string
    onJump: () => void
  }
  placeholders?: {
    normalPrefix?: string
    normal?: readonly string[]
    shell?: readonly string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

type PromptDelivery = "immediate" | "deferred"
type FollowUpInput = {
  id: string
  delivery: PromptDelivery
  text: string
}

const DRAFT_RETENTION_MIN_CHARS = 20
const log = Log.create({ service: "tui.prompt" })
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024

function assistantTokenTotal(message: AssistantMessage) {
  return (
    message.tokens.total ||
    message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write
  )
}

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

function deliveryFromMetadata(metadata: UserMessage["metadata"]): PromptDelivery | undefined {
  if (metadata?.delivery === "immediate" || metadata?.delivery === "deferred") return metadata.delivery
}

function promptPreview(parts: Part[]) {
  return compactPromptPreview(
    parts
      .flatMap((part) => {
        if (part.type === "text" && !part.synthetic) return [part.text]
        if (part.type === "subtask") return [part.description || part.prompt]
        if (part.type === "file") return [part.filename ?? part.url]
        return []
      })
      .join(" "),
  )
}

function compactPromptPreview(value: string) {
  const text = value.replace(/\s+/g, " ").trim()
  if (text.length <= 120) return text
  return text.slice(0, 117) + "..."
}

function FollowUpGroup(props: { title: string; badge?: string; color: RGBA; items: FollowUpInput[] }) {
  const { theme } = useTheme()
  const fg = createMemo(() => selectedForeground(theme, props.color))
  const visible = createMemo(() => props.items.slice(0, 3))
  const more = createMemo(() => Math.max(0, props.items.length - visible().length))

  return (
    <box flexDirection="column" gap={0}>
      <text fg={theme.textMuted} wrapMode="none">
        <Show when={props.badge} fallback={<span style={{ fg: props.color }}>↳</span>}>
          {(badge) => <span style={{ bg: props.color, fg: fg(), bold: true }}> {badge()} </span>}
        </Show>
        <span style={{ fg: theme.text }}> {props.title}</span>
        <span style={{ fg: theme.textMuted }}> ({props.items.length})</span>
      </text>
      <box flexDirection="column" paddingLeft={2}>
        {visible().map((item) => (
          <text fg={theme.textMuted} wrapMode="none" truncate>
            <span style={{ fg: props.color }}>↳</span> {item.text}
          </text>
        ))}
        <Show when={more() > 0}>
          <text fg={theme.textMuted} wrapMode="none">
            <span style={{ fg: props.color }}>+</span> {more()} more
          </text>
        </Show>
      </box>
    </box>
  )
}

function JumpToBottomHint(props: NonNullable<PromptProps["jumpToBottom"]>) {
  const { theme } = useTheme()
  return (
    <box flexShrink={0} onMouseUp={() => props.onJump()}>
      <text fg={theme.text} wrapMode="none">
        {props.shortcut()} <span style={{ fg: theme.info }}>jump to the bottom</span>
      </text>
    </box>
  )
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()
  const [inputFocused, setInputFocused] = createSignal(false)

  const leader = useLeaderActive()
  const local = useLocal()
  const args = useArgs()
  const sdk = useSDK()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const persistedWorkflow = createMemo(() =>
    props.sessionID ? sync.data.session.find((session) => session.id === props.sessionID)?.workflow : undefined,
  )
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const busyMessage = createMemo(() => {
    const current = status()
    if (current.type !== "busy") return
    return current.message
  })
  // The running Codex phase (if any) for this session. Its own feed drives live generation/tool status.
  const expertPhaseRunning = createMemo(() => sync.data.expert_phase_running?.[props.sessionID ?? ""])
  const latestExpertPhase = createMemo(() => sync.data.expert_phase[props.sessionID ?? ""]?.at(-1)?.phase)
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = useCyberfulKeymap()
  const agentShortcut = useCommandShortcut("agent.cycle")
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const animationsEnabled = useAnimationsEnabled()
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const queuedInputs = createMemo<FollowUpInput[]>(() => {
    const sessionID = props.sessionID
    if (!sessionID || status().type === "idle") return []
    return (sync.data.message[sessionID] ?? []).flatMap((message) => {
      if (message.role !== "user") return []
      const delivery = deliveryFromMetadata(message.metadata)
      if (delivery !== "deferred") return []
      const text = promptPreview(sync.data.part[message.id] ?? [])
      if (!text) return []
      return [{ id: message.id, delivery, text }]
    })
  })
  const [pendingSteers, setPendingSteers] = createSignal<FollowUpInput[]>([])
  const steeringInputs = createMemo(() => {
    const persisted = new Set((sync.data.message[props.sessionID ?? ""] ?? []).map((message) => message.id))
    return pendingSteers().filter((item) => !persisted.has(item.id))
  })
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const metadataMode = createMemo(() => props.metadata ?? (props.showMetadata === false ? false : "full"))
  const jumpToBottom = createMemo(() => (props.jumpToBottom?.visible() ? props.jumpToBottom : undefined))

  const styleId = (scope: string) => {
    const id = syntax().getStyleId(scope)
    if (id === undefined || id === null) throw new Error(`TUI syntax is missing required scope: ${scope}`)
    return id
  }
  const fileStyleId = styleId("extmark.file")
  const pasteStyleId = styleId("extmark.paste")
  let promptPartTypeId = 0
  const event = useEvent()

  event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // The widget applies inserted text after this handler; defer layout work so
      // the cursor and dirty region observe the updated buffer.
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })

  const sessionUsesCodexRuntime = createMemo(() => {
    if (!props.sessionID) return false
    const workflow = persistedWorkflow()
    return workflow ? SubsystemPhase.sessionUsesCodexRuntime(workflow, sync.data.message[props.sessionID] ?? []) : false
  })

  const usage = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []
    const last = msg.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && assistantTokenTotal(item) > 0,
    )
    if (!last) return

    const tokens = assistantTokenTotal(last)
    if (tokens <= 0) return

    return {
      tokens,
      percent: undefined,
      context: `${Locale.number(tokens)} tokens`,
    }
  })
  const steps = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant")
    return last?.steps
  })
  const contextUsageGlyph = createMemo(() => {
    const percent = usage()?.percent
    if (percent === undefined) return "○"
    if (percent >= 100) return "●"
    if (percent >= 75) return "◕"
    if (percent >= 50) return "◑"
    if (percent > 0) return "◔"
    return "○"
  })
  const contextUsageColor = createMemo(() => {
    const percent = usage()?.percent ?? 0
    if (percent >= 90) return theme.error
    if (percent >= 70) return theme.warning
    return theme.textMuted
  })

  // ── Session Elapsed Time Starts At The First User Prompt ────────
  // This clock represents the user's whole session rather than one assistant
  // turn, so idle time remains visible and later turns never reset it. The tick
  // is read only by the elapsed memo; home screens without a first message do no
  // derived work even though the cleanup-owned interval continues to advance.
  // ─────────────────────────────────────────────────────────────────
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const sessionStartedAt = createMemo(() => {
    if (!props.sessionID) return undefined
    return sync.data.message[props.sessionID]?.find((m): m is UserMessage => m.role === "user")?.time.created
  })
  const globalElapsed = createMemo(() => {
    const startedAt = sessionStartedAt()
    if (startedAt === undefined) return undefined
    return Locale.clockDuration(now() - startedAt)
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
  })
  // Todo footer affordance. It only exists while the session has an active todo list; it is the sole
  // way into the todo overlay now that the side panel is gone. Rendered as an underlined muted label
  // (see the right cluster below); clicking dispatches `session.toggle.todo`.
  const todos = createMemo(() => sync.data.todo[props.sessionID ?? ""] ?? [])
  const hasTodos = createMemo(() => todos().length > 0)

  const hasRightContent = createMemo(
    () => Boolean(props.right) || hasTodos() || Boolean(usage()) || Boolean(steps()) || Boolean(globalElapsed()),
  )

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Follow the latest host-written phase identity so resumed sessions display
  // the Codex process that currently owns the engagement.
  let syncedSessionID: string | undefined
  let syncedAgent: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()
    if (!sessionID || !msg) return

    const sessionChanged = sessionID !== syncedSessionID
    if (!sessionChanged && msg.agent === syncedAgent) return
    syncedSessionID = sessionID
    syncedAgent = msg.agent

    // Only a primary agent may become the input mode (never a subagent).
    if (!msg.agent) return
    const workflow = persistedWorkflow()
    if (!workflow) return
    const phase = SubsystemPhase.canonicalPhase(workflow, msg.agent)
    const isPrimaryAgent = local.agent.list().some((x) => x.workflow === workflow && x.name === phase)
    if (!isPrimaryAgent) return

    // The per-session seed keeps a command-line `--agent`; a handoff overrides it, because the
    // successor is a deliberate phase progression that ignores `--agent`.
    if (!(sessionChanged && args.agent)) local.agent.set(phase, workflow)
    // Codex's journal marker is not an AI SDK model. Keeping it out of local model state avoids a
    // spurious "model is not valid" warning in providerless sessions.
  })

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        hidden: true,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        hidden: true,
        run: async () => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Queue prompt",
        name: "prompt.queue",
        category: "Prompt",
        hidden: true,
        run: async (ctx: CommandContext<Renderable, KeyEvent>) => {
          ctx.event.preventDefault()
          ctx.event.stopPropagation()
          if (!input.focused) return
          const handled = await submit("deferred")
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        hidden: true,
        run: async (ctx: CommandContext<Renderable, KeyEvent>) => {
          ctx.event.preventDefault()
          ctx.event.stopPropagation()
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
            return
          }
          if (content?.mime === "text/plain") {
            await pasteInputText(content.data)
          }
        },
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        run: async () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // In shell composer mode the same key leaves that mode; no session turn exists to abort.
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          await sdk.client.session.abort({ sessionID: props.sessionID }).catch((error) => {
            log.warn("failed to interrupt session", { error, sessionID: props.sessionID })
            toast.show({ message: "Failed to interrupt session", variant: "error" })
          })
          dialog.clear()
        },
      },
      {
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slashName: "skill",
        slashAliases: ["skills"],
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: promptCommands(),
  }))

  useBindings(() => ({
    mode: CYBERFUL_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("prompt.palette", [
      "prompt.submit",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "session.interrupt",
    ]),
  }))

  let imperativeSubmission: Promise<boolean> | undefined
  const submitFromReference = () => {
    if (imperativeSubmission) return
    imperativeSubmission = submit()
      .catch((error) => {
        log.error("imperative prompt submission failed", { error })
        toast.show({ message: "The message could not be submitted", variant: "error" })
        return false
      })
      .finally(() => {
        imperativeSubmission = undefined
      })
  }

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      submitFromReference()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0 || props.autoFocus === false) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.input,
        run: () => {
          if (!store.prompt.input) return
          stash.push({
            input: store.prompt.input,
            parts: store.prompt.parts,
          })
          input.extmarks.clear()
          input.clear()
          setStore("prompt", { input: "", parts: [] })
          setStore("extmarkToPartIndex", new Map())
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.input)
            setStore("prompt", { input: entry.input, parts: entry.parts })
            restoreExtmarksFromParts(entry.parts)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.input)
                setStore("prompt", { input: entry.input, parts: entry.parts })
                restoreExtmarksFromParts(entry.parts)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: stashCommands(),
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled,
      bindings: tuiConfig.keybinds.get("prompt.paste"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled:
        inputTarget() !== undefined &&
        !props.disabled &&
        status().type !== "idle" &&
        store.prompt.input !== "" &&
        store.mode === "normal" &&
        !auto()?.visible,
      bindings: tuiConfig.keybinds.get("prompt.queue"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled && store.prompt.input !== "",
      bindings: tuiConfig.keybinds.get("prompt.clear"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !props.disabled &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      bindings: [
        {
          key: "!",
          desc: "Shell mode",
          group: "Prompt",
          cmd: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && store.mode === "shell",
      bindings: [{ key: "escape", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      bindings: [{ key: "backspace", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.previous",
          title: "Previous prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) input.cursorOffset = 0
              return false
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = 0
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.previous"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.next",
          title: "Next prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              )
                input.cursorOffset = input.plainText.length
              return false
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.next"),
    }
  })

  let submitting = false
  async function submit(delivery: PromptDelivery = "immediate") {
    // ── One Composer Submission Owns Session Creation ─────────────
    // Enter and native textarea submission can fire for the same draft before
    // either clears it. Without serialization both pass validation and create
    // independent sessions, after which the slower path reads an emptied store.
    // The local owner remains set through asynchronous delivery and releases in
    // `finally`, covering success, rejection, and cancellation.
    // ─────────────────────────────────────────────────────────────────
    if (submitting) return false
    submitting = true
    try {
      return await submitInner(delivery)
    } finally {
      submitting = false
    }
  }

  // ── Submitted Requests Remain Component-Owned Until Settled ─────
  // The composer clears after enqueueing, while the control-plane request may
  // still fail later. A retained set gives every request an owner, observes its
  // rejection, and keeps pending steering UI tied to that exact lifetime. Each
  // task removes itself in `finally`, covering success, rejection, and abort.
  // ─────────────────────────────────────────────────────────────────
  const submissionRequests = new Set<Promise<void>>()

  function trackSubmission<T extends { error?: unknown }>(request: Promise<T>, steer?: FollowUpInput) {
    const reportFailure = (error: unknown) => {
      log.error("prompt submission failed", { error })
      toast.show({
        message: steer
          ? "The active Codex turn did not accept the message. It is still available in prompt history."
          : "The message was not sent. It is still available in prompt history.",
        variant: "error",
      })
    }
    if (steer) setPendingSteers((items) => [...items, steer])
    let task: Promise<void>
    task = request
      .then((result) => {
        if (result.error) reportFailure(result.error)
      }, reportFailure)
      .catch((error) => {
        log.error("prompt submission failure handler failed", { error })
      })
      .finally(() => {
        if (steer) setPendingSteers((items) => items.filter((item) => item.id !== steer.id))
        submissionRequests.delete(task)
      })
    submissionRequests.add(task)
  }

  async function submitInner(delivery: PromptDelivery) {
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    if (props.canSubmit === false) {
      toast.show({
        message: "Set Workarea before sending.",
        variant: "warning",
      })
      return false
    }
    if (auto()?.visible) return false
    if (!store.prompt.input) return false
    const agent = local.agent.current()
    if (!agent) return false
    // ── Only A New Workflow Session Resolves A Kickoff Phase ──────
    // The selected engagement workflow chooses the first phase for a brand-new
    // ordinary prompt. Continued turns already have a phase owner, while shell
    // and slash submissions are host actions, so all three retain the current
    // agent instead of restarting the workflow chain.
    // ─────────────────────────────────────────────────────────────────
    const rawPrompt = store.prompt.input
    const isSlashCommand =
      rawPrompt.startsWith("/") &&
      sync.data.command.some((x) => x.name === rawPrompt.split("\n")[0].split(" ")[0].slice(1))
    const selectedWorkflow = local.workflow.current()
    const kickoffAgent =
      props.sessionID == null && store.mode !== "shell" && !isSlashCommand
        ? SubsystemPhase.workflowKickoffPhase(selectedWorkflow?.name ?? "")
        : undefined
    const agentName = kickoffAgent ?? agent.name
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      await exit()
      return true
    }
    // This build accepts only Codex engagement sessions; model selection is
    // owned by the Codex phase runtime and is not part of TUI submission.
    const usesCodexRuntime = Boolean(kickoffAgent) || sessionUsesCodexRuntime()
    if (!usesCodexRuntime) {
      toast.show({
        variant: "warning",
        message: "This build only runs Codex engagement sessions.",
        duration: 3000,
      })
      return false
    }
    let sessionID = props.sessionID
    if (sessionID == null) {
      // Anchor the workarea at the project directory, NOT the worktree: a non-git project sets worktree
      // to "/" (see instance-context.ts), so `worktree || directory` would create `work/<slug>` at the
      // filesystem root (EROFS). This matches the server-side engagement, which uses ctx.directory.
      const workareaProjectPath = workareaProjectRoot({
        directory: project.instance.directory(),
        worktree: project.instance.path().worktree,
        fallback: process.cwd(),
      })
      try {
        await DockerPreflight.requireDockerDaemon()
      } catch (error) {
        toast.show({
          message: error instanceof Error ? error.message : "Docker is unavailable; start it and retry.",
          variant: "error",
          duration: 8000,
        })
        return true
      }
      if (props.workarea) await ensureWorkarea(workareaProjectPath, props.workarea)

      const res = await sdk.client.session.create({
        workflow: selectedWorkflow?.name,
      })

      if (res.error) {
        log.error("session creation failed", { error: res.error })

        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return true
      }

      sessionID = res.data.id
      await setLastWorkarea(workareaProjectPath, props.workarea)
    }

    const messageID = MessageID.ascending()
    let inputText = store.prompt.input

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const pendingSteer =
      delivery === "immediate" &&
      currentMode !== "shell" &&
      props.sessionID &&
      (status().type !== "idle" || expertPhaseRunning())
        ? {
            id: messageID,
            delivery,
            text: compactPromptPreview(
              [
                inputText,
                ...nonTextParts.flatMap((part) => (part.type === "file" ? [part.filename ?? part.url] : [])),
              ].join(" "),
            ),
          }
        : undefined

    if (store.mode === "shell") {
      trackSubmission(
        sdk.client.session.shell({
          sessionID,
          agent: agentName,
          command: inputText,
        }),
      )
      setStore("mode", "normal")
    } else if (
      inputText.startsWith("/") &&
      iife(() => {
        const firstLine = inputText.split("\n")[0]
        const command = firstLine.split(" ")[0].slice(1)
        return sync.data.command.some((x) => x.name === command)
      })
    ) {
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      trackSubmission(
        sdk.client.session.command({
          sessionID,
          command: command.slice(1),
          arguments: args,
          agent: agentName,
          messageID,
          delivery,
          system: props.workarea ? workareaSystemPrompt(props.workarea) : undefined,
          workarea: props.workarea,
          parts: nonTextParts
            .filter((x) => x.type === "file")
            .map((x) => ({
              id: PartID.ascending(),
              ...x,
            })),
        }),
        pendingSteer,
      )
    } else {
      trackSubmission(
        sdk.client.session.prompt({
          sessionID,
          messageID,
          agent: agentName,
          delivery,
          system: props.workarea ? workareaSystemPrompt(props.workarea) : undefined,
          workarea: props.workarea,
          parts: [
            {
              id: PartID.ascending(),
              type: "text",
              text: inputText,
            },
            ...nonTextParts.filter((part) => part.type === "file").map(assign),
          ],
        }),
        pendingSteer,
      )
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // Defer the first route transition so the originating composer can dispatch its owned request before unmount.
    if (!props.sessionID) {
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    }
    input.clear()
    return true
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteInputText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const filepath = iife(() => {
      const raw = pastedContent.replace(/^['"]+|['"]+$/g, "")
      if (raw.startsWith("file://")) {
        try {
          return fileURLToPath(raw)
        } catch (error) {
          log.debug("pasted file URL is invalid", { error })
        }
      }
      if (process.platform === "win32") return raw
      return raw.replace(/\\(.)/g, "$1")
    })
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      try {
        const mime = await Filesystem.mimeType(filepath)
        const filename = path.basename(filepath)
        const info = await stat(filepath)
        if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`)
        if (mime === "image/svg+xml") {
          const content = await Filesystem.readText(filepath)
          if (content) {
            pasteText(content, `[SVG: ${filename ?? "image"}]`)
            return
          }
        }
        if (mime.startsWith("image/") || mime === "application/pdf") {
          const content = Buffer.from(await Filesystem.readArrayBuffer(filepath)).toString("base64")
          if (content) {
            await pasteAttachment({
              filename,
              filepath,
              mime,
              content,
            })
            return
          }
        }
      } catch (error) {
        log.debug("pasted text is not a readable attachment", { error, filepath })
      }
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if (
      (lineCount >= 3 || pastedContent.length > 150) &&
      kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary)
    ) {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    if (Buffer.byteLength(file.content, "base64") > MAX_ATTACHMENT_BYTES) {
      toast.show({ message: "Attachment is too large to paste.", variant: "error" })
      return
    }
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  function clearPrompt() {
    if (store.prompt.input.trim().length >= DRAFT_RETENTION_MIN_CHARS || store.prompt.parts.length > 0) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    input.clear()
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
  }

  const highlight = createMemo(() => {
    if (leader()) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = local.agent.current()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))
  const promptWorkflow = createMemo(() =>
    SubsystemPhase.workflow(persistedWorkflow() ?? local.workflow.current()?.name ?? ""),
  )
  const promptAgent = createMemo(() => {
    const workflow = promptWorkflow()
    if (!workflow) return local.agent.current()?.name
    if (workflow.kind === "interactive") return workflow.persona
    const running = expertPhaseRunning()?.phase
    if (running) return SubsystemPhase.canonicalPhase(workflow.name, running)
    const latest = latestExpertPhase()
    if (props.sessionID && status().type !== "idle" && latest)
      return SubsystemPhase.canonicalPhase(workflow.name, latest)
    const selected = local.agent.current()
    return selected?.workflow === workflow.name ? selected.name : SubsystemPhase.workflowKickoffPhase(workflow.name)
  })

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command... "${example}"`
    }
    if (!list().length) return undefined
    const prefix = props.placeholders?.normalPrefix?.trim() || "Ask anything"
    return `${prefix}... "${list()[store.placeholder % list().length]}"`
  })

  const spinnerColor = createMemo(() => bouncingBarColors(theme.textMuted, highlight()))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false}>
        <box
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
          >
            <box flexDirection="row" alignItems="flex-start" gap={1}>
              <Show when={props.label}>
                {(label) => (
                  <text fg={theme.textMuted} attributes={TextAttributes.BOLD} selectable={false} width={8}>
                    {label()}
                  </text>
                )}
              </Show>
              <textarea
                flexGrow={1}
                placeholder={placeholderText()}
                placeholderColor={theme.textMuted}
                textColor={leader() ? theme.textMuted : theme.text}
                focusedTextColor={leader() ? theme.textMuted : theme.text}
                minHeight={2}
                maxHeight={7}
                onContentChange={() => {
                  const value = input.plainText
                  setStore("prompt", "input", value)
                  auto()?.onInput(value)
                  syncExtmarksWithPromptParts()
                  setCursorVersion((value) => value + 1)
                }}
                onCursorChange={() => setCursorVersion((value) => value + 1)}
                onKeyDown={(e: { preventDefault(): void }) => {
                  if (props.disabled) {
                    e.preventDefault()
                    return
                  }
                }}
                onSubmit={() => {
                  // IME: double-defer so the last composed character (e.g. Korean
                  // hangul) is flushed to plainText before we read it for submission.
                  setTimeout(() => setTimeout(() => submit(), 0), 0)
                }}
                onPaste={async (event: PasteEvent) => {
                  if (props.disabled) {
                    event.preventDefault()
                    return
                  }

                  // Normalize line endings at the boundary
                  // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                  // Replace CRLF first, then any remaining CR
                  const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                  const pastedContent = normalizedText.trim()

                  // Windows Terminal <1.25 can surface image-only clipboard as an
                  // empty bracketed paste. Windows Terminal 1.25+ does not.
                  if (!pastedContent) {
                    keymap.dispatchCommand("prompt.paste")
                    return
                  }

                  // Once we cross an async boundary below, the terminal may perform its
                  // default paste unless we suppress it first and handle insertion ourselves.
                  event.preventDefault()

                  await pasteInputText(normalizedText)
                }}
                ref={(r: TextareaRenderable) => {
                  input = r
                  Object.assign(r, {
                    getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.parts),
                  })
                  setInputTarget(r)
                  if (promptPartTypeId === 0) {
                    promptPartTypeId = input.extmarks.registerType("prompt-part")
                  }
                  props.ref?.(ref)
                  setTimeout(() => {
                    // OpenTUI applies cursor state during attachment; restore the resolved theme on the next task.
                    if (!input || input.isDestroyed) return
                    input.cursorColor = theme.text
                  }, 0)
                }}
                onMouseDown={(r: MouseEvent) => r.target?.focus()}
                on:focused={() => setInputFocused(true)}
                on:blurred={() => setInputFocused(false)}
                focusedBackgroundColor={theme.backgroundElement}
                cursorColor={props.disabled ? theme.backgroundElement : theme.text}
                syntaxStyle={syntax()}
              />
              <ClearInput
                id="prompt-clear"
                visible={inputFocused()}
                onClear={() => {
                  clearPrompt()
                  input.focus()
                }}
              />
            </box>
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <Show when={metadataMode()}>
                  <Show when={promptWorkflow()} fallback={<box height={1} />}>
                    {(mode) => (
                      <>
                        <text fg={fadeColor(highlight(), agentMetaAlpha())}>
                          {store.mode === "shell" ? "Shell" : mode().title}
                        </text>
                        <Show when={store.mode !== "shell" && promptAgent()}>
                          {(agent) => (
                            <>
                              <text fg={tint(theme.textMuted, highlight(), 0.25)}> &gt; </text>
                              <text fg={fadeColor(highlight(), agentMetaAlpha())}>{Locale.titlecase(agent())}</text>
                            </>
                          )}
                        </Show>
                      </>
                    )}
                  </Show>
                </Show>
              </box>
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                  <Show when={globalElapsed()}>
                    {(value) => (
                      <text fg={theme.textMuted} wrapMode="none">
                        {value()}
                      </text>
                    )}
                  </Show>
                  <Show when={Boolean(globalElapsed()) && hasTodos()}>
                    <text fg={theme.textMuted}>·</text>
                  </Show>
                  <Show when={hasTodos()}>
                    <box onMouseUp={() => keymap.dispatchCommand("session.toggle.todo")}>
                      <text fg={theme.textMuted} attributes={TextAttributes.UNDERLINE} wrapMode="none">
                        Todo
                      </text>
                    </box>
                  </Show>
                  <Show when={(Boolean(globalElapsed()) || hasTodos()) && steps()}>
                    <text fg={theme.textMuted}>·</text>
                  </Show>
                  <Show when={steps()}>
                    {(item) => (
                      <text fg={theme.textMuted} wrapMode="none">
                        {item().current}/{item().budget} steps
                      </text>
                    )}
                  </Show>
                  <Show when={(Boolean(globalElapsed()) || hasTodos() || steps()) && usage()}>
                    <text fg={theme.textMuted}>·</text>
                  </Show>
                  <Show when={usage()}>
                    {(item) => (
                      <text fg={theme.textMuted} wrapMode="none">
                        <span style={{ fg: contextUsageColor(), bold: true }}>{contextUsageGlyph()}</span>{" "}
                        {item().context}
                      </text>
                    )}
                  </Show>
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <Show when={steeringInputs().length > 0 || queuedInputs().length > 0}>
          <box width="100%" flexDirection="column" gap={1} paddingLeft={1} paddingRight={1} paddingBottom={1}>
            <Show when={steeringInputs().length > 0}>
              <FollowUpGroup title="Sending to current turn" color={theme.primary} items={steeringInputs()} />
            </Show>
            <Show when={queuedInputs().length > 0}>
              <FollowUpGroup title="Queued follow-ups" badge="QUEUED" color={theme.warning} items={queuedInputs()} />
            </Show>
          </box>
        </Show>
        {/* gap guarantees a column between the left status (e.g. "esc cancel") and the right hints even
            when the busy Match's flexGrow box consumes all free space and space-between has none to give —
            without it the two groups render touching ("esc canceltab workflow"). */}
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <Switch>
            {/* A Codex phase still marks the host runLoop busy. This generic-busy Match would otherwise
                shadow the phase Match below and
                render a text-less spinner. Yield to it while a phase excursion owns the turn. */}
            <Match when={status().type !== "idle" && !expertPhaseRunning()}>
              <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
                <box flexShrink={0} flexDirection="row" gap={1}>
                  <box marginLeft={1}>
                    <Show when={animationsEnabled()} fallback={<text fg={theme.textMuted}>[ == ]</text>}>
                      <spinner color={spinnerColor()} frames={BOUNCING_BAR_FRAMES} interval={BOUNCING_BAR_INTERVAL} />
                    </Show>
                  </box>
                  <box flexDirection="row" gap={1} flexShrink={0}>
                    <Show when={busyMessage()}>{(message) => <GenerationStatusText message={message()} />}</Show>
                  </box>
                </box>
                <Show when={jumpToBottom()}>{(jump) => <JumpToBottomHint {...jump()} />}</Show>
                <text fg={theme.text}>
                  esc <span style={{ fg: theme.textMuted }}>cancel</span>
                </text>
              </box>
            </Match>
            <Match when={expertPhaseRunning()}>
              {(ep) => (
                <box flexDirection="row" gap={1} flexGrow={1} justifyContent="space-between">
                  <box flexShrink={0} flexDirection="row" gap={1}>
                    <box marginLeft={1}>
                      <Show when={animationsEnabled()} fallback={<text fg={theme.textMuted}>[ == ]</text>}>
                        <spinner color={spinnerColor()} frames={BOUNCING_BAR_FRAMES} interval={BOUNCING_BAR_INTERVAL} />
                      </Show>
                    </box>
                    {/* Show the Codex subsystem's session-wide live progress:
                        "executing job" while a tool runs, else the classic "generating… N" — the token
                        count with NO rate when the provider has reported one. */}
                    <Show
                      when={ep().lastKind === "tool"}
                      fallback={<GenerationStatusText message={GenerationProgress.formatStatus(ep().tokens)} />}
                    >
                      <text fg={theme.textMuted}>executing job</text>
                    </Show>
                  </box>
                  <box flexDirection="row" gap={2} flexShrink={0}>
                    <Show when={jumpToBottom()}>{(jump) => <JumpToBottomHint {...jump()} />}</Show>
                    <text fg={theme.text}>
                      esc <span style={{ fg: theme.textMuted }}>cancel</span>
                    </text>
                  </box>
                </box>
              )}
            </Match>
            <Match when={true}>
              <box flexDirection="row" gap={2}>
                <Show when={jumpToBottom()}>{(jump) => <JumpToBottomHint {...jump()} />}</Show>
                {props.hint ?? <text />}
              </box>
            </Match>
          </Switch>
          <box gap={2} flexDirection="row">
            <Switch>
              <Match when={store.mode === "normal"}>
                {/* The engagement workflow is an atomic chain the user locks before the run starts, so the
                    tab-to-cycle hint belongs only on the welcome screen (the prompt with no sessionID).
                    Once a session is underway the chain is fixed — the keybinding is a no-op there too. */}
                <Show when={!props.sessionID}>
                  <text fg={theme.text}>
                    {agentShortcut()} <span style={{ fg: theme.textMuted }}>workflow</span>
                  </text>
                </Show>
              </Match>
              <Match when={store.mode === "shell"}>
                <text fg={theme.text}>
                  esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                </text>
              </Match>
            </Switch>
          </box>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}

function GenerationStatusText(props: { message: string }) {
  const { theme } = useTheme()
  const status = createMemo(() => {
    const parsed = GenerationProgress.parseStatus(props.message)
    if (!parsed) return
    return {
      ...parsed,
      suffix: props.message.slice(`generating... ${parsed.leadingZeros}${parsed.tokenDigits}`.length),
    }
  })

  return (
    <text fg={theme.textMuted}>
      <Show when={status()} fallback={props.message}>
        {(value) => (
          <>
            generating...{" "}
            <span style={{ fg: tint(theme.backgroundElement, theme.textMuted, 0.22) }}>{value().leadingZeros}</span>
            <span style={{ fg: theme.text }}>{value().tokenDigits}</span>
            {value().suffix}
          </>
        )}
      </Show>
    </text>
  )
}
