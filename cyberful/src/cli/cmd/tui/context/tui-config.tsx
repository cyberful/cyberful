// ── Resolved TUI Config Context ──────────────────────────────────
// Makes already validated terminal configuration available to components without
//   allowing views to reload or mutate its source files.
// ─────────────────────────────────────────────────────────────────

import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { createSimpleContext } from "./helper"

export const { use: useTuiConfig, provider: TuiConfigProvider } = createSimpleContext({
  name: "TuiConfig",
  init: (props: { config: TuiConfig.Resolved }) => {
    return props.config
  },
})
