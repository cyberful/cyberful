// ── Terminal Application Shell ───────────────────────────────────
// Assembles the TUI providers, routes, global commands, renderer lifecycle,
// and application-wide keyboard behavior.
// → cyberful/src/cli/cmd/tui/keymap.tsx — registers command and slash dispatch.
// ─────────────────────────────────────────────────────────────────

import { render, TimeToFirstDraw, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import * as Clipboard from "@tui/util/clipboard"
import * as Selection from "@tui/util/selection"
import { createCliRenderer, MouseButton, type CliRendererConfig } from "@opentui/core"
import { RouteProvider, useRoute } from "@tui/context/route"
import {
  Switch,
  Match,
  createEffect,
  createMemo,
  ErrorBoundary,
  createSignal,
  onMount,
  onCleanup,
  batch,
  Show,
} from "solid-js"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { Flag } from "@/flag/flag"
import { DialogProvider, useDialog } from "@tui/ui/dialog"
import { ErrorComponent } from "@tui/component/error-component"
import { FeatureRouteMissing } from "@tui/component/feature-route-missing"
import { ProjectProvider } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { SDKProvider, useSDK } from "@tui/context/sdk"
import { StartupLoading } from "@tui/component/startup-loading"
import { SyncProvider, useSync } from "@tui/context/sync"
import { LocalProvider, useLocal } from "@tui/context/local"
import { DialogStatus } from "@tui/component/dialog-status"
import { DialogHelp } from "./ui/dialog-help"
import { DialogAgent } from "@tui/component/dialog-agent"
import { DialogWorkflow } from "@tui/component/dialog-workflow"
import { DialogSessionList } from "@tui/component/dialog-session-list"
import { ThemeProvider, useTheme } from "@tui/context/theme"
import { Home } from "@tui/routes/home"
import { Session } from "@tui/routes/session"
import { PromptHistoryProvider } from "./component/prompt/history"
import { FrecencyProvider } from "./component/prompt/frecency"
import { PromptStashProvider } from "./component/prompt/stash"
import { ToastProvider, useToast } from "./ui/toast"
import { ExitProvider, useExit } from "./context/exit"
import { Session as SessionApi } from "@/session/session"
import { TuiEvent } from "./event"
import { KVProvider, useKV } from "./context/kv"
import { ArgsProvider, useArgs, type Args } from "./context/args"
import open from "open"
import { PromptRefProvider, usePromptRef } from "./context/prompt"
import { TuiConfigProvider, useTuiConfig } from "./context/tui-config"
import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { TuiFeatureRuntime } from "@/cli/cmd/tui/feature/runtime"
import { createTuiApi } from "@/cli/cmd/tui/feature/api"
import type { RouteMap } from "@/cli/cmd/tui/feature/api"
import { createTuiAttention } from "@/cli/cmd/tui/attention"
import { FormatError, FormatUnknownError } from "@/cli/error"
import { observePromise } from "@/util/promise"
import { CommandPaletteDialog } from "./component/command-palette"
import * as Log from "@/util/log"
import {
  COMMAND_PALETTE_COMMAND,
  CYBERFUL_BASE_MODE,
  CyberfulKeymapProvider,
  registerCyberfulKeymap,
  useBindings,
  useCyberfulKeymap,
} from "./keymap"
import { detectThemeMode } from "./theme-mode"

import type { EventSource } from "./context/sdk"

const log = Log.create({ service: "tui.app" })

const appBindingCommands = [
  "command.palette.show",
  "session.list",
  "session.new",
  "session.quick_switch.1",
  "session.quick_switch.2",
  "session.quick_switch.3",
  "session.quick_switch.4",
  "session.quick_switch.5",
  "session.quick_switch.6",
  "session.quick_switch.7",
  "session.quick_switch.8",
  "session.quick_switch.9",
  "workflow.list",
  "agent.list",
  "agent.cycle",
  "agent.cycle.reverse",
  "cyberful.status",
  "theme.switch_mode",
  "help.show",
  "docs.open",
  "app.debug",
  "app.console",
  "app.heap_snapshot",
  "terminal.suspend",
  "terminal.title.toggle",
  "app.toggle.animations",
  "app.toggle.diffwrap",
  "app.toggle.paste_summary",
  "app.toggle.session_directory_filter",
] as const

function rendererConfig(_config: TuiConfig.Resolved): CliRendererConfig {
  const mouseEnabled = !Flag.CYBERFUL_DISABLE_MOUSE && (_config.mouse ?? true)

  return {
    externalOutputMode: "passthrough",
    targetFps: 45,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: mouseEnabled,
    consoleOptions: {
      keyBindings: [{ name: "y", ctrl: true, action: "copy-selection" }],
      onCopySelection: (text) => {
        observePromise(Clipboard.copy(text), {
          rejected: (error) => console.error(`Failed to copy console selection to clipboard: ${error}`),
        })
      },
    },
  }
}

function errorMessage(error: unknown) {
  const formatted = FormatError(error)
  if (formatted !== undefined) return formatted
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return FormatUnknownError(error)
}

export function tui(input: {
  url: string
  args: Args
  config: TuiConfig.Resolved
  onSnapshot?: () => Promise<string[]>
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
  events?: EventSource
}) {
  // promise to prevent immediate exit
  // oxlint-disable-next-line no-async-promise-executor -- intentional: async executor used for sequential setup before resolve
  return new Promise<void>(async (resolve) => {
    const unguard = win32InstallCtrlCGuard()
    win32DisableProcessedInput()

    const onExit = async () => {
      unguard?.()
      resolve()
    }
    const onBeforeExit = async () => {
      offKeymap()
      await TuiFeatureRuntime.dispose()
    }

    const renderer = await createCliRenderer(rendererConfig(input.config))
    // Resolve the palette alongside the terminal event so light terminals that do
    // not implement theme notifications still receive the correct first paint.
    const [reportedMode, palette] = await Promise.all([
      renderer.waitForThemeMode(1000),
      renderer.getPalette({ size: 16 }).catch((error) => {
        log.debug("palette prewarm failed", { error })
        return undefined
      }),
    ])
    const mode = detectThemeMode(reportedMode, palette)

    const keymap = createDefaultOpenTuiKeymap(renderer)
    const offKeymap = registerCyberfulKeymap(keymap, renderer, input.config)

    await render(() => {
      return (
        <ErrorBoundary
          fallback={(error, reset) => (
            <ErrorComponent error={error} reset={reset} onBeforeExit={onBeforeExit} onExit={onExit} mode={mode} />
          )}
        >
          <CyberfulKeymapProvider keymap={keymap}>
            <ArgsProvider {...input.args}>
              <ExitProvider onBeforeExit={onBeforeExit} onExit={onExit}>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider
                      initialRoute={
                        input.args.continue
                          ? {
                              type: "session",
                              sessionID: "dummy",
                            }
                          : undefined
                      }
                    >
                      <TuiConfigProvider config={input.config}>
                        <SDKProvider
                          url={input.url}
                          directory={input.directory}
                          fetch={input.fetch}
                          headers={input.headers}
                          events={input.events}
                        >
                          <ProjectProvider>
                            <SyncProvider>
                              <ThemeProvider mode={mode}>
                                <LocalProvider>
                                  <PromptStashProvider>
                                    <DialogProvider>
                                      <FrecencyProvider>
                                        <PromptHistoryProvider>
                                          <PromptRefProvider>
                                            <App onSnapshot={input.onSnapshot} />
                                          </PromptRefProvider>
                                        </PromptHistoryProvider>
                                      </FrecencyProvider>
                                    </DialogProvider>
                                  </PromptStashProvider>
                                </LocalProvider>
                              </ThemeProvider>
                            </SyncProvider>
                          </ProjectProvider>
                        </SDKProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ExitProvider>
            </ArgsProvider>
          </CyberfulKeymapProvider>
        </ErrorBoundary>
      )
    }, renderer)
  })
}

function App(props: { onSnapshot?: () => Promise<string[]> }) {
  const tuiConfig = useTuiConfig()
  const route = useRoute()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const dialog = useDialog()
  const local = useLocal()
  const kv = useKV()
  const keymap = useCyberfulKeymap()
  const event = useEvent()
  const sdk = useSDK()
  const toast = useToast()
  const themeState = useTheme()
  const { theme, mode, setMode } = themeState
  const sync = useSync()
  const exit = useExit()
  const promptRef = usePromptRef()
  const routes: RouteMap = new Map()
  const [routeRev, setRouteRev] = createSignal(0)
  const routeView = (name: string) => {
    routeRev()
    return routes.get(name)?.at(-1)?.render
  }
  const attention = createTuiAttention({ renderer, config: tuiConfig })

  const api = createTuiApi({
    tuiConfig,
    dialog,
    keymap,
    kv,
    route,
    routes,
    bump: () => setRouteRev((x) => x + 1),
    event,
    sdk,
    sync,
    theme: themeState,
    toast,
    renderer,
    attention,
  })
  const [ready, setReady] = createSignal(false)
  observePromise(
    TuiFeatureRuntime.init({
      api,
      config: tuiConfig,
      dispose: () => attention.dispose(),
    }),
    {
      rejected: (error) => console.error("Failed to load TUI features", error),
      settled: () => setReady(true),
    },
  )

  // Let selection copy/dismiss win ahead of normal bindings when the feature flag is on.
  const offSelectionKeys = keymap.intercept(
    "key",
    ({ event }) => {
      if (!Flag.CYBERFUL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      Selection.handleSelectionKey(renderer, toast, event)
    },
    { priority: 1 },
  )
  onCleanup(() => {
    offSelectionKeys()
    attention.dispose()
  })

  // Wire up console copy-to-clipboard via opentui's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
  const [terminalTitleEnabled, setTerminalTitleEnabled] = createSignal(kv.get("terminal_title_enabled", true))
  const [pasteSummaryEnabled, setPasteSummaryEnabled] = createSignal(
    kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary),
  )

  // Update terminal window title based on current route and session
  createEffect(() => {
    if (!terminalTitleEnabled() || Flag.CYBERFUL_DISABLE_TERMINAL_TITLE) return

    if (route.data.type === "home") {
      renderer.setTerminalTitle("Cyberful")
      return
    }

    if (route.data.type === "session") {
      const session = sync.session.get(route.data.sessionID)
      if (!session || SessionApi.isDefaultTitle(session.title)) {
        renderer.setTerminalTitle("Cyberful")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      renderer.setTerminalTitle(`OC | ${title}`)
      return
    }

    if (route.data.type === "feature") {
      renderer.setTerminalTitle(`OC | ${route.data.id}`)
    }
  })

  const args = useArgs()
  onMount(() => {
    batch(() => {
      if (args.agent) local.agent.set(args.agent)
      if (args.sessionID && !args.fork) {
        route.navigate({
          type: "session",
          sessionID: args.sessionID,
        })
      }
    })
  })

  let continued = false
  createEffect(() => {
    // When using -c, session list is loaded in blocking phase, so we can navigate at "partial"
    if (continued || sync.status === "loading" || !args.continue) return
    const match = sync.data.session
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .find((x) => x.parentID === undefined)?.id
    if (match) {
      continued = true
      if (args.fork) {
        observePromise(sdk.client.session.fork({ sessionID: match }, { signal: AbortSignal.timeout(15_000) }), {
          fulfilled: (result) => {
            if (result.data?.id) {
              route.navigate({ type: "session", sessionID: result.data.id })
            } else {
              toast.show({ message: "Failed to fork session", variant: "error" })
            }
          },
          rejected: (error) => {
            log.warn("failed to fork continued session", { error, sessionID: match })
            toast.show({ message: "Failed to fork session", variant: "error" })
          },
        })
      } else {
        route.navigate({ type: "session", sessionID: match })
      }
    }
  })

  // Handle --session with --fork: wait for sync to be fully complete before forking
  // (session list loads in non-blocking phase for --session, so we must wait for "complete"
  // to avoid a race where reconcile overwrites the newly forked session)
  let forked = false
  createEffect(() => {
    if (forked || sync.status !== "complete" || !args.sessionID || !args.fork) return
    forked = true
    observePromise(sdk.client.session.fork({ sessionID: args.sessionID }, { signal: AbortSignal.timeout(15_000) }), {
      fulfilled: (result) => {
        if (result.data?.id) {
          route.navigate({ type: "session", sessionID: result.data.id })
        } else {
          toast.show({ message: "Failed to fork session", variant: "error" })
        }
      },
      rejected: (error) => {
        log.warn("failed to fork requested session", { error, sessionID: args.sessionID })
        toast.show({ message: "Failed to fork session", variant: "error" })
      },
    })
  })

  const appCommands = createMemo(() =>
    [
      {
        name: COMMAND_PALETTE_COMMAND,
        title: "Show command palette",
        category: "System",
        hidden: true,
        run: () => {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
      {
        name: "session.list",
        title: "Switch session",
        category: "Session",
        suggested: sync.data.session.length > 0,
        slashName: "sessions",
        slashAliases: ["resume", "continue"],
        run: () => {
          dialog.replace(() => <DialogSessionList />)
        },
      },
      {
        name: "session.new",
        title: "New session",
        suggested: route.data.type === "session",
        category: "Session",
        slashName: "new",
        slashAliases: ["clear"],
        run: () => {
          route.navigate({
            type: "home",
          })
          dialog.clear()
        },
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        name: `session.quick_switch.${i + 1}`,
        title: `Switch to session in quick slot ${i + 1}`,
        category: "Session",
        hidden: true,
        run: () => {
          local.session.quickSwitch(i + 1)
        },
      })),
      {
        name: "workflow.list",
        title: "Switch workflow",
        category: "Workflow",
        slashName: "workflows",
        slashAliases: ["workflow"],
        run: () => {
          if (route.data.type !== "home") {
            toast.show({
              variant: "warning",
              message: "Workflow can only be changed from the home screen.",
              duration: 3000,
            })
            return
          }
          dialog.replace(() => <DialogWorkflow />)
        },
      },
      {
        name: "agent.list",
        title: "Switch agent",
        category: "Agent",
        slashName: "agents",
        run: () => {
          dialog.replace(() => <DialogAgent />)
        },
      },
      {
        name: "agent.cycle",
        title: "Workflow cycle",
        category: "Agent",
        hidden: true,
        run: () => {
          // ── Workflow Cycling Stops When A Session Starts ────────
          // Tab retains the historical `agent.cycle` command identity, but it now
          // selects the engagement workflow whose runtime advances phase personas.
          // A started session has already persisted that workflow owner, so only
          // the home route may change it and later keypresses deliberately do nothing.
          // ─────────────────────────────────────────────────────────────────
          if (route.data.type !== "home") return
          local.workflow.move(1)
        },
      },
      {
        name: "agent.cycle.reverse",
        title: "Workflow cycle reverse",
        category: "Agent",
        hidden: true,
        run: () => {
          // Mirror of agent.cycle: the workflow is switchable only on the welcome screen.
          if (route.data.type !== "home") return
          local.workflow.move(-1)
        },
      },
      {
        name: "cyberful.status",
        title: "View status",
        slashName: "status",
        run: () => {
          dialog.replace(() => <DialogStatus />)
        },
        category: "System",
      },
      {
        name: "theme.switch_mode",
        title: mode() === "dark" ? "Switch to light mode" : "Switch to dark mode",
        run: () => {
          setMode(mode() === "dark" ? "light" : "dark")
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "help.show",
        title: "Help",
        slashName: "help",
        run: () => {
          dialog.replace(() => <DialogHelp />)
        },
        category: "System",
      },
      {
        name: "docs.open",
        title: "Open docs",
        run: () => {
          observePromise(open("https://cyberful.ai/docs"), {
            rejected: (error) => {
              log.warn("failed to open documentation", { error })
              toast.show({ message: "Failed to open documentation", variant: "error" })
            },
          })
          dialog.clear()
        },
        category: "System",
      },
      {
        name: "app.exit",
        title: "Exit the app",
        slashName: "exit",
        slashAliases: ["quit", "q"],
        run: () => exit(),
        category: "System",
      },
      {
        name: "app.debug",
        title: "Toggle debug panel",
        category: "System",
        run: () => {
          renderer.toggleDebugOverlay()
          dialog.clear()
        },
      },
      {
        name: "app.console",
        title: "Toggle console",
        category: "System",
        run: () => {
          renderer.console.toggle()
          dialog.clear()
        },
      },
      {
        name: "app.heap_snapshot",
        title: "Write heap snapshot",
        category: "System",
        run: async () => {
          const files = await props.onSnapshot?.()
          toast.show({
            variant: "info",
            message: `Heap snapshot written to ${files?.join(", ")}`,
            duration: 5000,
          })
          dialog.clear()
        },
      },
      {
        name: "terminal.suspend",
        title: "Suspend terminal",
        category: "System",
        hidden: true,
        enabled: process.platform !== "win32",
        run: () => {
          process.once("SIGCONT", () => {
            renderer.resume()
          })

          renderer.suspend()
          process.kill(0, "SIGTSTP")
        },
      },
      {
        name: "terminal.title.toggle",
        title: terminalTitleEnabled() ? "Disable terminal title" : "Enable terminal title",
        category: "System",
        run: () => {
          setTerminalTitleEnabled((prev) => {
            const next = !prev
            kv.set("terminal_title_enabled", next)
            if (!next) renderer.setTerminalTitle("")
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.animations",
        title: kv.get("animations_enabled", true) ? "Disable animations" : "Enable animations",
        category: "System",
        run: () => {
          kv.set("animations_enabled", !kv.get("animations_enabled", true))
          dialog.clear()
        },
      },
      {
        name: "app.toggle.diffwrap",
        title: kv.get("diff_wrap_mode", "word") === "word" ? "Disable diff wrapping" : "Enable diff wrapping",
        category: "System",
        run: () => {
          const current = kv.get("diff_wrap_mode", "word")
          kv.set("diff_wrap_mode", current === "word" ? "none" : "word")
          dialog.clear()
        },
      },
      {
        name: "app.toggle.paste_summary",
        title: pasteSummaryEnabled() ? "Disable paste summary" : "Enable paste summary",
        category: "System",
        run: () => {
          setPasteSummaryEnabled((prev) => {
            const next = !prev
            kv.set("paste_summary_enabled", next)
            return next
          })
          dialog.clear()
        },
      },
      {
        name: "app.toggle.session_directory_filter",
        title: kv.get("session_directory_filter_enabled", true)
          ? "Disable session directory filtering"
          : "Enable session directory filtering",
        category: "System",
        run: async () => {
          kv.set("session_directory_filter_enabled", !kv.get("session_directory_filter_enabled", true))
          await sync.session.refresh()
          dialog.clear()
        },
      },
    ].map((command) => ({
      namespace: "palette",
      ...command,
    })),
  )

  useBindings(() => ({
    commands: appCommands(),
  }))

  useBindings(() => ({
    mode: CYBERFUL_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("app", appBindingCommands),
  }))

  useBindings(() => ({
    mode: CYBERFUL_BASE_MODE,
    enabled: () => {
      const current = promptRef.current
      if (!current?.focused) return true
      return current.current.input === ""
    },
    bindings: tuiConfig.keybinds.gather("app_exit", ["app.exit"]),
  }))

  event.on(TuiEvent.CommandExecute.type, (evt) => {
    keymap.dispatchCommand(evt.properties.command)
  })

  event.on(TuiEvent.ToastShow.type, (evt) => {
    toast.show({
      title: evt.properties.title,
      message: evt.properties.message,
      variant: evt.properties.variant,
      duration: evt.properties.duration,
    })
  })

  event.on(TuiEvent.SessionSelect.type, (evt) => {
    route.navigate({
      type: "session",
      sessionID: evt.properties.sessionID,
    })
  })

  event.on("session.deleted", (evt) => {
    if (route.data.type === "session" && route.data.sessionID === evt.properties.info.id) {
      route.navigate({ type: "home" })
      toast.show({
        variant: "info",
        message: "The current session was deleted",
      })
    }
  })

  event.on("session.error", (evt) => {
    const error = evt.properties.error
    if (error && typeof error === "object" && error.name === "MessageAbortedError") return
    const message = errorMessage(error)

    toast.show({
      variant: "error",
      message,
      duration: 5000,
    })
  })

  const plugin = createMemo(() => {
    if (!ready()) return
    if (route.data.type !== "feature") return
    const render = routeView(route.data.id)
    if (!render) return <FeatureRouteMissing id={route.data.id} onHome={() => route.navigate({ type: "home" })} />
    return render({ params: route.data.data })
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={theme.background}
      onMouseDown={(evt) => {
        if (!Flag.CYBERFUL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
        if (evt.button !== MouseButton.RIGHT) return

        if (!Selection.copy(renderer, toast)) return
        evt.preventDefault()
        evt.stopPropagation()
      }}
      onMouseUp={Flag.CYBERFUL_EXPERIMENTAL_DISABLE_COPY_ON_SELECT ? undefined : () => Selection.copy(renderer, toast)}
    >
      <Show when={Flag.CYBERFUL_SHOW_TTFD}>
        <TimeToFirstDraw />
      </Show>
      <Show when={ready()}>
        <box flexGrow={1} minHeight={0} flexDirection="column">
          <Switch>
            <Match when={route.data.type === "home"}>
              <Home />
            </Match>
            <Match when={route.data.type === "session"}>
              <Session />
            </Match>
          </Switch>
          {plugin()}
        </box>
        <box flexShrink={0}>
          <TuiFeatureRuntime.Slot name="app_bottom" />
        </box>
        <TuiFeatureRuntime.Slot name="app" />
      </Show>
      <StartupLoading ready={ready} />
    </box>
  )
}
