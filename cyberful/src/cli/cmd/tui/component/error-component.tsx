// ── Fatal TUI Error Screen ───────────────────────────────────────
// Replaces the application view after an uncaught render failure, supports
//   scrolling and copying diagnostics, and performs ordered renderer exit.
// ─────────────────────────────────────────────────────────────────

import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { createSignal } from "solid-js"
import { InstallationVersion } from "@/installation/version"
import { win32FlushInputBuffer } from "../win32"
import { getScrollAcceleration } from "../util/scroll"
import { observePromise } from "@/util/promise"
import * as Log from "@/util/log"

const log = Log.create({ service: "tui.error-screen" })

export function ErrorComponent(props: {
  error: Error
  reset: () => void
  onBeforeExit?: () => Promise<void>
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()

  let exitTask: Promise<void> | undefined
  const handleExit = () => {
    exitTask ??= (async () => {
      await props.onBeforeExit?.()
      renderer.setTerminalTitle("")
      renderer.destroy()
      win32FlushInputBuffer()
      await props.onExit()
    })()
    return exitTask
  }
  const requestExit = () => {
    observePromise(handleExit(), {
      rejected: (error) => log.error("fatal screen exit failed", { error }),
    })
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      requestExit()
    }
  })
  const [copied, setCopied] = createSignal(false)

  const issueURL = new URL("https://github.com/anomalyco/cyberful/issues/new?template=bug-report.yml")

  // Choose safe fallback colors per mode since theme context may not be available
  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#ffffff" : "#0a0a0a",
    text: isLight ? "#24292f" : "#eeeeee",
    muted: isLight ? "#57606a" : "#808080",
    primary: isLight ? "#0969da" : "#fab283",
  }

  if (props.error.message) {
    issueURL.searchParams.set("title", `opentui: fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```",
    )
  }

  issueURL.searchParams.set("cyberful-version", InstallationVersion)

  const copyIssueURL = () => {
    observePromise(Clipboard.copy(issueURL.toString()), {
      fulfilled: () => {
        setCopied(true)
      },
      rejected: (error) => log.warn("failed to copy issue URL", { error }),
    })
  }

  return (
    <box flexDirection="column" gap={1} backgroundColor={colors.bg}>
      <box flexDirection="row" gap={1} alignItems="center">
        <text attributes={TextAttributes.BOLD} fg={colors.text}>
          Please report an issue.
        </text>
        <box onMouseUp={copyIssueURL} backgroundColor={colors.primary} padding={1}>
          <text attributes={TextAttributes.BOLD} fg={colors.bg}>
            Copy issue URL (exception info pre-filled)
          </text>
        </box>
        {copied() && <text fg={colors.muted}>Successfully copied</text>}
      </box>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={colors.text}>A fatal error occurred!</text>
        <box onMouseUp={props.reset} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Reset TUI</text>
        </box>
        <box onMouseUp={requestExit} backgroundColor={colors.primary} padding={1}>
          <text fg={colors.bg}>Exit</text>
        </box>
      </box>
      <scrollbox height={Math.floor(term().height * 0.7)} scrollAcceleration={getScrollAcceleration()}>
        <text fg={colors.muted}>{props.error.stack}</text>
      </scrollbox>
      <text fg={colors.text}>{props.error.message}</text>
    </box>
  )
}
