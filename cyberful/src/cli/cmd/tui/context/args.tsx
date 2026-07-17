// ── TUI Launch Arguments Context ─────────────────────────────────
// Carries normalized agent, workarea, prompt, continuation, session, and fork
//   options from the command boundary to terminal providers.
// ─────────────────────────────────────────────────────────────────

import { createSimpleContext } from "./helper"

export interface Args {
  agent?: string
  workarea?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
