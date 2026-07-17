// ── Timeline Fork Dialog ─────────────────────────────────────────
// Lists user turns, forks the full session or a selected historical point, and
//   rehydrates the chosen prompt before navigating to the new session.
// ─────────────────────────────────────────────────────────────────

import { createMemo, onMount } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { TextPart } from "@/server/client"
import { Locale } from "@/util/locale"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useDialog, type DialogContext } from "../../ui/dialog"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"
import { useToast } from "@tui/ui/toast"

export function DialogForkFromTimeline(props: { sessionID: string; onMove: (messageID?: string) => void }) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()

  onMount(() => {
    dialog.setSize("large")
  })

  const options = createMemo((): DialogSelectOption<string | undefined>[] => {
    const messages = sync.data.message[props.sessionID] ?? []
    const fullSession = {
      title: "Full session",
      value: undefined,
      onSelect: async (dialog: DialogContext) => {
        const forked = await sdk.client.session.fork({ sessionID: props.sessionID })
        if (!forked.data) {
          toast.show({ message: "Failed to fork session", variant: "error" })
          return
        }
        route.navigate({
          sessionID: forked.data.id,
          type: "session",
        })
        dialog.clear()
      },
    } satisfies DialogSelectOption<string | undefined>
    const result: DialogSelectOption<string | undefined>[] = []
    for (const message of messages) {
      if (message.role !== "user") continue
      const part = (sync.data.part[message.id] ?? []).find(
        (candidate): candidate is TextPart => candidate.type === "text" && !candidate.synthetic && !candidate.ignored,
      )
      if (!part) continue
      result.push({
        title: part.text.replace(/\n/g, " "),
        value: message.id,
        footer: Locale.time(message.time.created),
        onSelect: async (dialog) => {
          const forked = await sdk.client.session.fork({
            sessionID: props.sessionID,
            messageID: message.id,
          })
          if (!forked.data) {
            toast.show({ message: "Failed to fork session", variant: "error" })
            return
          }
          const parts = sync.data.part[message.id] ?? []
          const prompt = parts.reduce<PromptInfo>(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(strip(part))
              return agg
            },
            { input: "", parts: [] },
          )
          route.navigate({
            sessionID: forked.data.id,
            type: "session",
            prompt,
          })
          dialog.clear()
        },
      })
    }
    return [fullSession, ...result.reverse()]
  })

  return <DialogSelect onMove={(option) => props.onMove(option.value)} title="Fork session" options={options()} />
}
