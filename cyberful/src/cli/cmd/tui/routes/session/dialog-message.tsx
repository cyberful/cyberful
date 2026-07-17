// ── Session Message Actions ──────────────────────────────────────
// Offers user-visible revert, copy, and fork operations for one message and
//   carries its prompt parts into the resulting session state when needed.
// ─────────────────────────────────────────────────────────────────

import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import * as Clipboard from "@tui/util/clipboard"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"
import { useToast } from "@tui/ui/toast"
import { errorMessage } from "@/util/error"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()
  const toast = useToast()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            try {
              await sdk.client.session.revert({
                sessionID: props.sessionID,
                messageID: msg.id,
              })
            } catch (error) {
              toast.show({ message: errorMessage(error), variant: "error" })
              return
            }

            if (props.setPrompt) {
              const parts = sync.data.part[msg.id]
              const promptInfo = parts.reduce<PromptInfo>(
                (agg, part) => {
                  if (part.type === "text") {
                    if (!part.synthetic) agg.input += part.text
                  }
                  if (part.type === "file") agg.parts.push(strip(part))
                  return agg
                },
                { input: "", parts: [] },
              )
              props.setPrompt(promptInfo)
            }

            dialog.clear()
          },
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            try {
              await Clipboard.copy(text)
              dialog.clear()
            } catch (error) {
              toast.show({ message: errorMessage(error), variant: "error" })
            }
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog) => {
            const result = await sdk.client.session
              .fork({
                sessionID: props.sessionID,
                messageID: props.messageID,
              })
              .catch((error) => {
                toast.show({ message: errorMessage(error), variant: "error" })
                return undefined
              })
            if (!result) return
            if (!result.data) {
              toast.show({ message: "Failed to fork session", variant: "error" })
              return
            }
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce<PromptInfo>(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] },
                )
              : undefined
            route.navigate({
              sessionID: result.data.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
