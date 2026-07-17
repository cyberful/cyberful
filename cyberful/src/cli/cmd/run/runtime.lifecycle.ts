// ── Interactive Renderer Lifecycle ───────────────────────────────
// Creates the split-footer renderer, theme, splash, and footer; closing writes
//   the exit snapshot before destroying footer and renderer in ownership order.
//   SIGINT delegates to the footer so prompt clearing and protected exit agree.
// ─────────────────────────────────────────────────────────────────

import { createCliRenderer, type CliRenderer, type ScrollbackWriter } from "@opentui/core"
import { Session as SessionApi } from "@/session/session"
import * as Locale from "@/util/locale"
import * as Log from "@/util/log"
import { resolveInteractiveStdin } from "./runtime.stdin"
import { entrySplash, exitSplash, splashMeta } from "./splash"
import { resolveRunTheme } from "./theme"
import type {
  FooterApi,
  FooterKeybinds,
  QuestionReject,
  QuestionReply,
  RunAgent,
  RunDiffStyle,
  RunInput,
  RunPrompt,
} from "./types"

const FOOTER_HEIGHT = 7
const log = Log.create({ service: "run.lifecycle" })

type SplashState = {
  entry: boolean
  exit: boolean
}

type FooterLabels = {
  agentLabel: string
}

export type LifecycleInput = {
  directory: string
  findFiles: (query: string) => Promise<string[]>
  agents: RunAgent[]
  sessionID: string
  sessionTitle?: string
  getSessionID?: () => string | undefined
  first: boolean
  history: RunPrompt[]
  agent: string | undefined
  keybinds: FooterKeybinds
  diffStyle: RunDiffStyle
  onQuestionReply: (input: QuestionReply) => void | Promise<void>
  onQuestionReject: (input: QuestionReject) => void | Promise<void>
  onInterrupt?: () => void
  onSubagentSelect?: (sessionID: string | undefined) => void
}

export type Lifecycle = {
  footer: FooterApi
  close(input: { showExit: boolean; sessionTitle?: string; sessionID?: string; history?: RunPrompt[] }): Promise<void>
}

// Gracefully tears down the renderer. Order matters: switch external output
// back to passthrough before leaving split-footer mode, so pending stdout
// doesn't get captured into the now-dead scrollback pipeline.
function shutdown(renderer: CliRenderer): void {
  if (renderer.isDestroyed) {
    return
  }

  if (renderer.externalOutputMode === "capture-stdout") {
    renderer.externalOutputMode = "passthrough"
  }

  if (renderer.screenMode === "split-footer") {
    renderer.screenMode = "main-screen"
  }

  if (!renderer.isDestroyed) {
    renderer.destroy()
  }
}

function splashInfo(title: string | undefined, history: RunPrompt[]) {
  if (title && !SessionApi.isDefaultTitle(title)) {
    return {
      title,
      showSession: true,
    }
  }

  const next = history.find((item) => item.text.trim().length > 0)
  return {
    title: next?.text ?? title,
    showSession: !!next,
  }
}

function footerLabels(input: Pick<RunInput, "agent">): FooterLabels {
  const agentLabel = Locale.titlecase(input.agent ?? "build")
  return { agentLabel }
}

function queueSplash(
  renderer: Pick<CliRenderer, "writeToScrollback" | "requestRender">,
  state: SplashState,
  phase: keyof SplashState,
  write: ScrollbackWriter | undefined,
): boolean {
  if (state[phase]) {
    return false
  }

  if (!write) {
    return false
  }

  state[phase] = true
  renderer.writeToScrollback(write)
  renderer.requestRender()
  return true
}

// ── Footer Ownership Starts After The Entry Snapshot ─────────────
// The renderer begins with captured output and a split footer so scrollback and
// footer changes share one frame. The entry splash is committed before mutable
// controls mount, preventing it from being repainted as footer state changes.
// RunFooter then owns the footer until close writes the matching exit snapshot.
// ─────────────────────────────────────────────────────────────────
export async function createRuntimeLifecycle(input: LifecycleInput): Promise<Lifecycle> {
  const source = resolveInteractiveStdin()

  try {
    const renderer = await createCliRenderer({
      stdin: source.stdin,
      targetFps: 30,
      maxFps: 60,
      useMouse: false,
      autoFocus: false,
      openConsoleOnError: false,
      exitOnCtrlC: false,
      useKittyKeyboard: { events: process.platform === "win32" },
      screenMode: "split-footer",
      footerHeight: FOOTER_HEIGHT,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
      clearOnShutdown: false,
    })
    const theme = await resolveRunTheme(renderer)
    renderer.setBackgroundColor(theme.background)
    const state: SplashState = {
      entry: false,
      exit: false,
    }
    const splash = splashInfo(input.sessionTitle, input.history)
    const meta = splashMeta({
      title: splash.title,
      session_id: input.sessionID,
    })
    const footerTask = import("./footer")
    const wrote = queueSplash(
      renderer,
      state,
      "entry",
      entrySplash({
        ...meta,
        theme: theme.splash,
        showSession: splash.showSession,
      }),
    )
    await renderer.idle().catch((error) => log.warn("renderer failed to settle after entry splash", { error }))

    const { RunFooter } = await footerTask

    const labels = footerLabels({
      agent: input.agent,
    })
    const footer = new RunFooter(renderer, {
      directory: input.directory,
      findFiles: input.findFiles,
      agents: input.agents,
      sessionID: input.getSessionID ?? (() => input.sessionID),
      ...labels,
      first: input.first,
      history: input.history,
      theme,
      wrote,
      keybinds: input.keybinds,
      diffStyle: input.diffStyle,
      onQuestionReply: input.onQuestionReply,
      onQuestionReject: input.onQuestionReject,
      onInterrupt: input.onInterrupt,
      onSubagentSelect: input.onSubagentSelect,
    })

    const sigint = () => {
      footer.requestExit()
    }
    process.on("SIGINT", sigint)

    let closed = false
    const close = async (next: {
      showExit: boolean
      sessionTitle?: string
      sessionID?: string
      history?: RunPrompt[]
    }) => {
      if (closed) {
        return
      }

      closed = true
      process.off("SIGINT", sigint)

      try {
        await footer.idle().catch((error) => log.debug("footer did not settle before close", { error }))

        const show = renderer.isDestroyed ? false : next.showExit
        if (!renderer.isDestroyed && show) {
          const sessionID = next.sessionID || input.getSessionID?.() || input.sessionID
          const splash = splashInfo(next.sessionTitle ?? input.sessionTitle, next.history ?? input.history)
          queueSplash(
            renderer,
            state,
            "exit",
            exitSplash({
              ...splashMeta({
                title: splash.title,
                session_id: sessionID,
              }),
              theme: theme.splash,
            }),
          )
          await renderer.idle().catch((error) => log.debug("renderer did not settle after exit splash", { error }))
        }
      } finally {
        footer.close()
        await footer.idle().catch((error) => log.debug("footer did not settle during teardown", { error }))
        footer.destroy()
        shutdown(renderer)
        source.cleanup?.()
      }
    }

    return {
      footer,
      close,
    }
  } catch (error) {
    source.cleanup?.()
    throw error
  }
}
