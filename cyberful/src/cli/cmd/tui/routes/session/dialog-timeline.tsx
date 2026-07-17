// ── Session Timeline Dialog ──────────────────────────────────────
// Builds a chronological list of visible user and assistant turns with readable
//   timestamps and opens per-message actions without mutating feed order.
// ─────────────────────────────────────────────────────────────────

import { createMemo, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { TextPart } from "@/server/client"
import { Locale } from "@/util/locale"
import {
  assistantDisplayTimeLine,
  formatAssistantTimestamp,
  splitAssistantTimeLine,
} from "@/session/assistant-timestamp"
import { DialogMessage } from "./dialog-message"
import { useDialog } from "../../ui/dialog"
import type { PromptInfo } from "../../component/prompt/history"
import { isRecord } from "@/util/record"

export function DialogTimeline(props: {
  sessionID: string
  onMove: (messageID: string) => void
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const dialog = useDialog()
  const { theme } = useTheme()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    return messages
      .flatMap((message): DialogSelectOption<string>[] => {
        const parts = sync.data.part[message.id] ?? []
        if (message.role === "user") {
          const part = parts.find(isVisibleTextPart)
          if (!part) return []
          return [
            {
              title: timelineTitle(part.text),
              value: message.id,
              footer: Locale.time(message.time.created),
              onSelect: (dialog) => {
                dialog.replace(() => (
                  <DialogMessage messageID={message.id} sessionID={props.sessionID} setPrompt={props.setPrompt} />
                ))
              },
            },
          ]
        }

        const text = parts
          .filter(isVisibleTextPart)
          .map((part) => splitAssistantTimeLine(part.text).text.trim())
          .filter((item): item is string => item.length > 0)
          .join("\n\n")
        const timestamp =
          parts
            .filter(isVisibleTextPart)
            .map((part) => splitAssistantTimeLine(part.text).timestamp)
            .findLast((item): item is string => item !== undefined) ??
          (message.time.completed ? formatAssistantTimestamp(message.time.completed) : undefined)
        if (!text && !timestamp) return []
        return [
          {
            title: timelineTitle(text) || `${Locale.titlecase(message.mode)} response`,
            value: message.id,
            footer: timestamp ? assistantDisplayTimeLine(timestamp) : undefined,
            footerFg: theme.textMuted,
            onSelect: (dialog) => {
              dialog.replace(() => (
                <DialogMessage messageID={message.id} sessionID={props.sessionID} setPrompt={props.setPrompt} />
              ))
            },
          },
        ]
      })
      .reverse()
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Timeline" options={options()} />
}

function isVisibleTextPart(part: unknown): part is TextPart {
  return isRecord(part) && part.type === "text" && part.synthetic !== true && part.ignored !== true
}

function timelineTitle(text: string) {
  return text.replace(/\s+/g, " ").trim()
}
