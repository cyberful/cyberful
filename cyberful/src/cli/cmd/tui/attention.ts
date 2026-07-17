// ── Terminal Attention Notifications ────────────────────────────
// Tracks renderer focus and applies configured notification policy, rate limits,
//   and text bounds before asking the host terminal for user attention.
// ─────────────────────────────────────────────────────────────────

import type {
  TuiAttention,
  TuiAttentionNotifyResult,
  TuiAttentionNotifySkipReason,
  TuiAttentionWhen,
} from "@/cli/cmd/tui/api-types"
import stripAnsi from "strip-ansi"
import type { TuiConfig } from "./config/tui"
import * as Log from "@/util/log"

type FocusState = "unknown" | "focused" | "blurred"

type AttentionRenderer = {
  readonly isDestroyed: boolean
  on(event: "focus" | "blur", listener: () => void): unknown
  off(event: "focus" | "blur", listener: () => void): unknown
  triggerNotification(message: string, title?: string): boolean
}

type TuiAttentionHost = TuiAttention & {
  dispose(): void
}

const log = Log.create({ service: "tui.attention" })

const DEFAULT_TITLE = "cyberful"
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240

function skipped(reason: TuiAttentionNotifySkipReason): TuiAttentionNotifyResult {
  return {
    ok: false,
    notification: false,
    skipped: reason,
  }
}

function normalizeText(input: string | undefined, fallback: string, limit: number) {
  const text = stripAnsi(input ?? "")
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
  const normalized = text.length ? text : fallback
  return Array.from(normalized).slice(0, limit).join("")
}

function focusSkip(when: TuiAttentionWhen, focus: FocusState) {
  if (when === "always") return
  if (focus === "unknown") return "focus_unknown"
  if (when === "blurred" && focus === "focused") return "focused"
  if (when === "focused" && focus === "blurred") return "blurred"
}

export function createTuiAttention(input: {
  renderer: AttentionRenderer
  config: Pick<TuiConfig.Resolved, "attention">
}): TuiAttentionHost {
  let focus: FocusState = "unknown"
  let disposed = false

  const onFocus = () => {
    focus = "focused"
  }
  const onBlur = () => {
    focus = "blurred"
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  return {
    async notify(request) {
      try {
        if (!input.config.attention.enabled) return skipped("attention_disabled")
        if (disposed || input.renderer.isDestroyed) return skipped("renderer_destroyed")

        const message = normalizeText(request.message, "", MESSAGE_LIMIT)
        if (!message) return skipped("empty_message")

        const requestedNotification = typeof request.notification === "object" ? request.notification : undefined
        const notificationSkip = focusSkip(requestedNotification?.when ?? "blurred", focus)
        const notificationRequested = input.config.attention.notifications && request.notification !== false
        const notification =
          notificationRequested && !notificationSkip
            ? (() => {
                try {
                  return input.renderer.triggerNotification(
                    message,
                    normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT),
                  )
                } catch (error) {
                  log.debug("failed to trigger attention notification", { error })
                  return false
                }
              })()
            : false
        if (!notification && notificationRequested && notificationSkip) return skipped(notificationSkip)

        return {
          ok: notification,
          notification,
        }
      } catch (error) {
        log.debug("failed to handle attention notification", { error })
        return {
          ok: false,
          notification: false,
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
    },
  }
}
