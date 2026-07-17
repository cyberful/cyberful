// ── Prompt Component Reference ───────────────────────────────────
// Shares the currently mounted prompt control with commands that need to append,
//   submit, clear, or focus composer input without owning the component.
// ─────────────────────────────────────────────────────────────────

import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
    }
  },
})
