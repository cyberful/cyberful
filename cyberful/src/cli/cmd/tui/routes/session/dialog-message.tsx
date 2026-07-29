// ── Session Message Actions ──────────────────────────────────────
// Copies the visible text of one user or assistant message to the clipboard.
// @docs/user-guide/interface.md
// ─────────────────────────────────────────────────────────────────

import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import * as Clipboard from "@tui/util/clipboard"
import { useToast } from "@tui/ui/toast"
import { errorMessage } from "@/util/error"

export function DialogMessage(props: { messageID: string; sessionID: string }) {
  const sync = useSync()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const toast = useToast()

  return (
    <DialogSelect
      title="Message Actions"
      options={[
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
      ]}
    />
  )
}
