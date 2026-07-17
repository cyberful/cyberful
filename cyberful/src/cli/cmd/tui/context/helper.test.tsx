// ── Reactive Context Readiness Tests ─────────────────────────────
// Protects delayed context mounting so asynchronous initialization can reveal
//   the application tree without exposing an unready provider value.
// → cyberful/src/cli/cmd/tui/context/helper.tsx — owns the readiness gate.
// ─────────────────────────────────────────────────────────────────

import { expect, test } from "bun:test"
import { createComponent, createRoot, createSignal } from "solid-js"
import { createSimpleContext } from "./helper"

test("mounts context children after asynchronous initialization becomes ready", () => {
  let setReady = (_value: boolean) => false
  let mounted = 0

  const context = createSimpleContext({
    name: "Test",
    init: () => {
      const [ready, updateReady] = createSignal(false)
      setReady = updateReady
      return {
        get ready() {
          return ready()
        },
        value: "loaded",
      }
    },
  })

  createRoot((dispose) => {
    const Child = () => {
      expect(context.use().value).toBe("loaded")
      mounted++
      return null
    }

    createComponent(context.provider, {
      get children() {
        return createComponent(Child, {})
      },
    })

    expect(mounted).toBe(0)
    setReady(true)
    expect(mounted).toBe(1)
    dispose()
  })
})
