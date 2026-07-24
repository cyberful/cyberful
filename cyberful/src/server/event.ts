// ── Server Lifecycle Event Registry ─────────────────────────────
// Declares the process-wide bus events emitted when the server connects and
// after all instance state has been disposed during shutdown.
// → cyberful/src/server/global-lifecycle.ts — emits the disposal event.
// ─────────────────────────────────────────────────────────────────

import { Event as EventDefinition } from "@/event"
import { Schema } from "effect"

export const Event = {
  Connected: EventDefinition.define("server.connected", Schema.Struct({})),
  Disposed: EventDefinition.define("global.disposed", Schema.Struct({})),
}
