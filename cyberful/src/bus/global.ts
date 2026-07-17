// ── Process-Wide Event Bridge ────────────────────────────────────
// Carries normalized instance and lifecycle events to the global HTTP stream and
// TUI worker, assigning an event ID when a legacy producer omitted one.
// → cyberful/src/bus/index.ts — forwards project-scoped publications here.
// → cyberful/src/server/routes/instance/httpapi/handlers/global.ts — streams these events.
// ─────────────────────────────────────────────────────────────────

import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalPayload = {
  id?: string
  type: string
  properties?: unknown
  syncEvent?: { id?: string; [key: string]: unknown }
}

export type GlobalEvent = {
  directory?: string
  project?: string
  payload: GlobalPayload
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (!("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
