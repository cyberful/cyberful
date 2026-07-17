// ── Agent Selector ────────────────────────────────────────────────
// Lists and selects the primary personas that belong to the current engagement
//   workflow while leaving runtime policy unchanged.
// → cyberful/src/config/agent.ts — records persona workflow ownership.
// ─────────────────────────────────────────────────────────────────

import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { Locale } from "@/util/locale"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.agent
      .list()
      .filter((item) => item.workflow === local.workflow.current()?.name)
      .map((item) => {
        return {
          value: item.name,
          title: Locale.titlecase(item.name),
          description: item.description,
        }
      }),
  )

  return (
    <DialogSelect
      title="Select agent"
      current={local.agent.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value, local.workflow.current()?.name)
        dialog.clear()
      }}
    />
  )
}
