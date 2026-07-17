// ── Public Event Schema Catalog ──────────────────────────────────
// Loads every repository-owned event definition, seals all three registries,
// and returns the complete legacy and transactional payload schemas used by
// HTTP and generated-client contracts.
// → cyberful/src/server/routes/instance/httpapi/api.ts — publishes project event schemas.
// → cyberful/src/server/routes/instance/httpapi/groups/global.ts — publishes global event schemas.
// ─────────────────────────────────────────────────────────────────

import "@/bus"
import "@/cli/cmd/tui/event"
import "@/command"
import "@/file"
import "@/file/watcher"
import "@/project/project"
import "@/project/vcs"
import "@/pty"
import "@/question"
import "@/server/event"
import "@/session/event-v2"
import "@/session/message-v2"
import "@/session/session"
import "@/session/status"
import "@/session/todo"
import "@/session/variable"
import { BusEvent } from "@/bus/bus-event"
import { EventV2 } from "@/event-v2"
import { SyncEvent } from "@/sync"

export function payloadSchemas() {
  BusEvent.freezeDefinitions()
  EventV2.freezeDefinitions()
  SyncEvent.freezeDefinitions()
  return {
    events: [...BusEvent.effectPayloads(), ...SyncEvent.busPayloads()],
    sync: SyncEvent.effectPayloads(),
  }
}
