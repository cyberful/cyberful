// ── Solid Context Factory ────────────────────────────────────────
// Creates paired providers and guarded accessors, delaying child rendering when
//   an initialized context explicitly reports that it is not ready.
// ─────────────────────────────────────────────────────────────────

import { createContext, createMemo, Show, useContext, type ParentProps } from "solid-js"

export function createSimpleContext<T extends object, Props extends object>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  return {
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)

      // ── Readiness Remains A Live Context Boundary ────────────────
      // Async-backed contexts expose readiness through reactive getters that are
      // false during initialization and become true after their state has loaded.
      // Reading such a getter once would freeze the provider in its initial state,
      // leaving every descendant unmounted even after initialization completes.
      // The memo keeps Show subscribed while preserving immediate mounting for
      // contexts that do not define a readiness contract.
      // ───────────────────────────────────────────────────────────────
      const ready = createMemo(() => !("ready" in init) || init.ready === undefined || init.ready === true)
      return (
        <Show when={ready()}>
          <ctx.Provider value={init}>{props.children}</ctx.Provider>
        </Show>
      )
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
