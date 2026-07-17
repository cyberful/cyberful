// ── TUI Home Route ───────────────────────────────────────────────
// Renders workarea selection, the initial composer, background, feature slots,
//   and startup prompt submission before a user enters a persisted session.
// ─────────────────────────────────────────────────────────────────

import { TextAttributes, type MouseEvent, type RGBA, type TextareaRenderable } from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import { Show, createEffect, createMemo, createSignal, onMount, type ParentProps } from "solid-js"
import { HomeSplashBackground } from "../component/home-splash-background"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "@tui/context/route"
import { usePromptRef } from "../context/prompt"
import { TuiFeatureRuntime } from "@/cli/cmd/tui/feature/runtime"
import { useProject } from "@tui/context/project"
import { useTheme } from "@tui/context/theme"
import { getLastWorkarea, normalizeWorkarea } from "@/workarea"
import { SubsystemCodex } from "@/subsystem/codex"
import { observePromise } from "@/util/promise"
import * as Log from "@/util/log"
import { PROMPT_OVERLAY_Z_INDEX } from "@tui/component/prompt/autocomplete"
import { useLocal } from "@tui/context/local"

const log = Log.create({ service: "tui.home" })

// ── Launch Prompts Are Consumed Once Per TUI Process ─────────────
// The home route may unmount when a session opens and mount again when the user
// returns. Command-line or route prompts belong only to the initial launch and
// must not overwrite a later draft on that remount. This module-level flag is
// owned by the single TUI application process and records that one-time transfer.
// ─────────────────────────────────────────────────────────────────
let initialPromptApplied = false
const SHELL_PLACEHOLDERS = ["ls -la", "git status", "pwd"]

const WORKAREA_PLACEHOLDER = "Type your workarea"
const WORKAREA_Z_INDEX = 1000

// A deliberately small, unobtrusive splash note when the installed Codex differs from the pinned version.
const codexVersionNote = SubsystemCodex.preflightNote()

function HomeCredit() {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" flexShrink={0} justifyContent="center">
      <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
        Cyber
      </text>
      <text fg={theme.text} attributes={TextAttributes.BOLD | TextAttributes.ITALIC} selectable={false}>
        ful
      </text>
    </box>
  )
}

export function HomePromptSurface(props: ParentProps<{ onMouseDown: () => void }>) {
  return (
    <box
      width="100%"
      maxWidth={75}
      zIndex={PROMPT_OVERLAY_Z_INDEX}
      paddingTop={1}
      flexShrink={0}
      onMouseDown={props.onMouseDown}
    >
      {props.children}
    </box>
  )
}

// ── Delayed Data Never Reorders The Workarea Layer ──────────────
// OpenTUI sorts sibling renderables together with Solid layout markers, whose
// missing z-index makes a Workarea box appended after an async restore capable
// of painting after the prompt. Keep the outer layer mounted from frame one and
// toggle its visibility instead; its inner input still waits for the restored
// value so textarea initialValue is never captured too early.
// ─────────────────────────────────────────────────────────────────
export function HomeWorkareaLayer(
  props: ParentProps<{
    visible: boolean
    borderColor: string | RGBA
    backgroundColor: string | RGBA
  }>,
) {
  return (
    <box
      visible={props.visible}
      width="100%"
      maxWidth={75}
      zIndex={WORKAREA_Z_INDEX}
      flexShrink={0}
      paddingTop={1}
      paddingBottom={1}
      border={["left"]}
      borderColor={props.borderColor}
      backgroundColor={props.backgroundColor}
    >
      {props.children}
    </box>
  )
}

export function Home() {
  const sync = useSync()
  const local = useLocal()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const project = useProject()
  const { theme } = useTheme()
  const [workarea, setWorkarea] = createSignal(safeWorkarea(args.workarea) ?? "")
  const [workareaReady, setWorkareaReady] = createSignal(Boolean(args.workarea))
  const [workareaFocused, setWorkareaFocused] = createSignal(false)
  const workareaLocked = createMemo(() => Boolean(safeWorkarea(args.workarea)))
  const activeWorkarea = createMemo(() => safeWorkarea(workarea()))
  const workareaValid = createMemo(() => {
    const value = activeWorkarea()
    return Boolean(value && value.toLowerCase() !== WORKAREA_PLACEHOLDER.toLowerCase())
  })
  const placeholders = createMemo(() => {
    const workflowPlaceholder = local.workflow.current()?.promptPlaceholder
    return {
      normalPrefix: workflowPlaceholder?.lead,
      normal: workflowPlaceholder?.examples ?? [],
      shell: SHELL_PLACEHOLDERS,
    }
  })
  let workareaInput: TextareaRenderable | undefined
  let sent = false

  onMount(() => {
    if (workareaLocked()) return
    const directory = project.instance.path().worktree || project.instance.directory() || process.cwd()
    observePromise(getLastWorkarea(directory), {
      fulfilled: (lastWorkarea) => setWorkarea(lastWorkarea ?? ""),
      rejected: (error) => log.warn("failed to load last workarea", { error, directory }),
      settled: () => setWorkareaReady(true),
    })
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (initialPromptApplied || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      initialPromptApplied = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    initialPromptApplied = true
  }

  // Wait for session state before auto-submitting --prompt. Codex phases do not need a provider model store.
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready) return
    if (!workareaValid()) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <box width="100%" height="100%" flexGrow={1} minHeight={0} flexDirection="column">
      <box position="absolute" top={0} left={0} right={0} bottom={0} zIndex={0}>
        <HomeSplashBackground />
      </box>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2} zIndex={1}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <TuiFeatureRuntime.Slot name="home_logo" mode="replace" />
        <HomeWorkareaLayer
          visible={workareaReady()}
          borderColor={workareaFocused() ? theme.primary : theme.border}
          backgroundColor={theme.backgroundElement}
        >
          <Show when={workareaReady()}>
            <box flexDirection="row" alignItems="center" gap={1} paddingLeft={2} paddingRight={2} height={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.BOLD} selectable={false}>
                Workarea
              </text>
              <Show
                when={workareaLocked()}
                fallback={
                  <textarea
                    flexGrow={1}
                    height={1}
                    minHeight={1}
                    maxHeight={1}
                    initialValue={workarea()}
                    placeholder={WORKAREA_PLACEHOLDER}
                    placeholderColor={theme.textMuted}
                    textColor={theme.text}
                    focusedTextColor={theme.text}
                    cursorColor={theme.primary}
                    ref={(val: TextareaRenderable) => {
                      workareaInput = val
                      val.traits = { status: "WORKAREA" }
                    }}
                    onContentChange={() => setWorkarea(workareaInput?.plainText ?? "")}
                    onMouseDown={(event: MouseEvent) => {
                      setWorkareaFocused(true)
                      event.target?.focus()
                    }}
                    onSubmit={() => {
                      setWorkareaFocused(false)
                      ref()?.focus()
                    }}
                  />
                }
              >
                <text fg={theme.textMuted} wrapMode="none" truncate>
                  {workarea()}
                </text>
              </Show>
            </box>
          </Show>
        </HomeWorkareaLayer>
        <HomePromptSurface onMouseDown={() => setWorkareaFocused(false)}>
          <TuiFeatureRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt
              ref={bind}
              autoFocus={!workareaFocused()}
              canSubmit={workareaValid()}
              workarea={workareaValid() ? activeWorkarea() : undefined}
              label="Prompt"
              right={<TuiFeatureRuntime.Slot name="home_prompt_right" />}
              metadata="agent"
              placeholders={placeholders()}
            />
          </TuiFeatureRuntime.Slot>
        </HomePromptSurface>
        <box width="100%" maxWidth={75} paddingTop={1} alignItems="center" flexShrink={0}>
          <HomeCredit />
        </box>
        <TuiFeatureRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <Show when={codexVersionNote}>
        <box width="100%" alignItems="center" flexShrink={0} zIndex={1}>
          <text fg={theme.textMuted} selectable={false}>
            {codexVersionNote}
          </text>
        </box>
      </Show>
      <box width="100%" flexShrink={0} zIndex={1}>
        <TuiFeatureRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </box>
  )
}

function safeWorkarea(input: string | undefined) {
  try {
    return normalizeWorkarea(input)
  } catch {
    return undefined
  }
}
