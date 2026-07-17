// ── Project-Scoped TUI Events ────────────────────────────────────
// Filters the shared event stream to global or current-project events and
//   exposes type-narrowed subscriptions to terminal consumers.
// ─────────────────────────────────────────────────────────────────

import type { Event } from "@/server/client"
import { useProject } from "./project"
import { useSDK } from "./sdk"

export function useEvent() {
  const project = useProject()
  const sdk = useSDK()

  function subscribe(handler: (event: Event) => void) {
    return sdk.event.on("event", (event) => {
      if (event.payload.type === "sync") {
        return
      }

      if (event.directory === "global" || event.project === project.project()) {
        handler(event.payload)
      }
    })
  }

  function on<T extends Event["type"]>(type: T, handler: (event: Extract<Event, { type: T }>) => void) {
    return subscribe((event: Event) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>)
    })
  }

  return {
    subscribe,
    on,
  }
}
