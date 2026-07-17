// ── Built-In TUI Feature Registry ────────────────────────────────
// Returns the host-owned home footer, notifications, key guide, and diff viewer
//   as feature modules consumed by the same runtime as extensions.
// ─────────────────────────────────────────────────────────────────

import HomeFooter from "../features/home/footer"
import Notifications from "../features/system/notifications"
import WhichKey from "../features/system/which-key"
import DiffViewer from "../features/system/diff-viewer"
import type { TuiFeature, TuiFeatureModule } from "@/cli/cmd/tui/api-types"

export type InternalTuiFeature = Omit<TuiFeatureModule, "id"> & {
  id: string
  tui: TuiFeature
  enabled?: boolean
}

export function internalTuiFeatures(): InternalTuiFeature[] {
  return [HomeFooter, Notifications, WhichKey, DiffViewer]
}
