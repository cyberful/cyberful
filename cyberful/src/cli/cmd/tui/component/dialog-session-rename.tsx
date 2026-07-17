// ── Session Rename Dialog ────────────────────────────────────────
// Prompts for a title, updates the selected persisted session, and closes only
//   after the rename request has been submitted.
// ─────────────────────────────────────────────────────────────────

import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { useToast } from "@tui/ui/toast"
import { errorMessage } from "@/util/error"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      onConfirm={async (value) => {
        try {
          await sdk.client.session.update({
            sessionID: props.session,
            title: value,
          })
          dialog.clear()
        } catch (error) {
          toast.show({ message: errorMessage(error), variant: "error" })
        }
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
