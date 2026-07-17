// ── Workflow Selector ─────────────────────────────────────────────
// Lists the engagement workflows available before a session starts and commits
// the user's selection to home-screen state.
// → cyberful/src/subsystem/phase.ts — defines selectable workflow metadata.
// ─────────────────────────────────────────────────────────────────

import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"

export function DialogWorkflow() {
  const local = useLocal()
  const dialog = useDialog()
  const options = createMemo(() =>
    local.workflow.list().map((workflow) => ({
      value: workflow.name,
      title: workflow.title,
      description:
        workflow.kind === "workflow" ? `${workflow.phases.length}-phase workflow` : "Interactive workarea workflow",
    })),
  )

  return (
    <DialogSelect
      title="Select workflow"
      current={local.workflow.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.workflow.set(option.value)
        dialog.clear()
      }}
    />
  )
}
