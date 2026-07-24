// ── Built-In TUI Wiring ─────────────────────────────────────────
// Installs the four host-owned TUI capabilities explicitly and disposes their
// registrations in reverse order when the terminal exits.
// ─────────────────────────────────────────────────────────────────

import type { TuiFeatureApi } from "@/cli/cmd/tui/api-types"
import { installHomeFooter } from "../features/home/footer"
import { installNotifications } from "../features/system/notifications"
import { installWhichKey } from "../features/system/which-key"
import { installDiffViewer } from "../features/system/diff-viewer"
import { setupSlots } from "./slots"

export const builtinTuiCapabilityIDs = ["home-footer", "notifications", "which-key", "diff-viewer"] as const

export function installBuiltinTui(api: TuiFeatureApi) {
  const slots = setupSlots(api)
  api.slots = slots

  const dispose = [
    installHomeFooter(api),
    installNotifications(api),
    installWhichKey(api),
    installDiffViewer(api),
  ]

  return () => {
    for (const off of dispose.reverse()) off()
    slots.dispose()
  }
}
